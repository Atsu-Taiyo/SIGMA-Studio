import { expect, test, type Locator, type Page } from "@playwright/test";
import { PerspectiveCamera, Vector3 } from "three";

import type { Graph3DObject, OverlayGraph3DShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOption } from "./ui-select";

const GRAPH3D_E2E_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_graph3d_blank",
  metadata: { title: "3D教材 e2e" },
  content: [
    {
      type: "paragraph",
      id: "p_e2e_graph3d_intro",
      children: [{ type: "text", text: "3D教材の編集確認" }],
    },
  ],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, GRAPH3D_E2E_DOCUMENT);
  await page.setViewportSize({ width: 1440, height: 960 });
});

test("deleting a 3D figure also removes its preview and undo restores both", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.previewAssetId ?? null).not.toBeNull();
  const assetId = (await readSavedGraph3D(page))!.props.previewAssetId!;
  await closeGraph3DSettings(page);
  await exitGraph3DDirectMode(page, graph);
  await graph.click({ button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "削除", exact: true }).click();
  await expect(page.getByTestId("overlay-graph3d")).toHaveCount(0);
  await expect.poll(async () => readSavedGraph3D(page)).toBeNull();
  const assetPresent = () => page.evaluate((id) => {
    const document = JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "{}");
    return Boolean(document.pageLayout?.overlay?.overlaySnapshot?.assets?.[id]);
  }, assetId);
  await expect.poll(assetPresent).toBe(false);
  await pressUndo(page);
  await expect(page.getByTestId("overlay-graph3d")).toHaveCount(1);
  await expect.poll(assetPresent).toBe(true);
  await pressRedo(page);
  await expect.poll(async () => readSavedGraph3D(page)).toBeNull();
  await expect.poll(assetPresent).toBe(false);
});

test("inserts a 3D teaching object and reopens its floating editor", async ({ page }) => {
  await openEditor(page);

  const graph = await insertGraph3D(page);
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId("graph3d-preview")).toHaveCount(0);
  await expect(graph.getByTestId("graph3d-preview")).toBeVisible();
  await expect(graph.locator("canvas.graph3d-preview-canvas")).toBeVisible();
  await expect(graph.getByText("円弧: 回転（Shiftで15°）")).toBeVisible();
  await expect(panel.getByLabel("オブジェクト名").first()).toHaveCSS("font-size", "12px");
  await expect(panel.getByRole("img", { name: "回転体の概形" })).toBeVisible();
  // ひな形の名前は「回転体と動く断面」。断面は回転体と平面の共通部分として最初から入っている。
  await expect(panel.getByLabel("オブジェクト名")).toHaveCount(2);
  await expect(panel.getByRole("img", { name: "切断面 z = sの概形" })).toBeVisible();
  await expect(panel.getByRole("img", { name: "共通部分の概形" })).toBeVisible();

  await expectPanelNotToCoverShape(panel, graph);
  await closeGraph3DSettings(page);
  await exitGraph3DDirectMode(page, graph);

  const graphBox = await graph.boundingBox();
  expect(graphBox).not.toBeNull();
  await graph.dblclick({
    position: { x: graphBox!.width * 0.5, y: graphBox!.height * 0.5 },
  });
  await expect(panel).toBeVisible();

  await closeGraph3DSettings(page);
  await graph.click({ button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu.getByRole("menuitem", { name: "3D教材の設定…" })).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "3D教材の設定…" }).click();
  await expect(panel).toBeVisible();
});

test("persists camera interaction and a quadratic inequality solid", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const graph = page.getByTestId("overlay-graph3d").first();
  const preview = graph.getByTestId("graph3d-preview");
  await expect(preview.locator("canvas.graph3d-preview-canvas")).toBeVisible();

  await addGraph3DObject(page, panel, "不等式で囲む立体");
  const details = await openGraph3DItemDetails(page, panel, "不等式で囲む立体 の詳細設定");
  await expect(details.getByTestId("graph3d-inequality-brace")).toBeVisible();
  await setGraph3DMathFieldValue(details.getByTestId("graph3d-inequality-1"), "z \\geqq 0, x^2 \\leqq y, x^2+y^2 \\leqq 4");

  await selectUiOption(panel.getByLabel("投影方法"), "orthographic");

  const canvas = preview.locator("canvas.graph3d-preview-canvas");
  await expect(canvas).toBeVisible();
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + canvasBox!.width * 0.65, canvasBox!.y + canvasBox!.height * 0.48);
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + canvasBox!.width * 0.3, canvasBox!.y + canvasBox!.height * 0.3, { steps: 12 });
  await page.mouse.up();
  await canvas.hover();
  await page.mouse.wheel(0, -420);

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const shape = await readSavedGraph3D(page);
    const spec = shape?.props.spec;
    const object = spec?.objects.find((candidate) => candidate.kind === "boundedSolid");
    const position = spec?.camera.position;
    return {
      inequalities: object?.kind === "boundedSolid" ? object.inequalities : null,
      projection: spec?.camera.projection ?? null,
      cameraChanged: position
        ? position.x !== 5.5
          || position.y !== -6.5
          || position.z !== 4.5
          || (spec?.camera.zoom ?? 1) !== 1
        : false,
    };
  }).toEqual({
    inequalities: ["z >= 0", "x^2 <= y", "x^2+y^2 <= 4", "y >= 0", "z >= 0", "x+y+z <= 3"],
    projection: "orthographic",
    cameraChanged: true,
  });
});

test("keeps formulas on the first surface and moves compact colors into whole-card hover details", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const objectCard = panel.getByLabel("オブジェクト名").first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await expect(objectCard.getByLabel("断面の方程式")).toBeVisible();
  await expect(objectCard.getByLabel("表示")).toBeVisible();
  await expect(objectCard.getByLabel("色を選ぶ")).toHaveCount(0);
  await expect(panel.locator('input[type="color"]')).toHaveCount(0);

  await objectCard.hover();
  const details = page.getByRole("dialog", { name: "回転体 の詳細設定" });
  await expect(details).toBeVisible();
  await details.hover();
  await page.waitForTimeout(400);
  await expect(details).toBeVisible();
  const compactColor = details.getByRole("button", { name: "色を選ぶ", exact: true });
  expect(await compactColor.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(64);
  await compactColor.click();
  const palette = page.getByRole("group", { name: "色を選択" });
  await expect(palette).toBeVisible();
  await palette.getByTitle("#3b6ef7").click({ force: true });

  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.objects[0]?.style?.color ?? null)
    .toBe("#3b6ef7");
});

test("undo inside the 3D dialog rolls back its current edit without closing the dialog", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const visible = panel.getByLabel("表示").first();
  // 表示の切り替えは checkbox ではなく aria-pressed のトグルボタン (uncheck() は落ちる)。
  await visible.click();
  await expect(visible).toHaveAttribute("aria-pressed", "false");
  await visible.press("Control+z");
  await expect(visible).toHaveAttribute("aria-pressed", "true");
  await expect(panel).toBeVisible();
});

test("puts camera moves and the derived preview on the document's one undo timeline", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const canvas = graph.locator("canvas.graph3d-preview-canvas");
  await expect(canvas).toBeVisible();

  // 派生PNGが一度書き込まれるまで待つ。ここを待たずに戻すと、取り消されたのが
  // 「視点の変更」なのか「PNGの書き出し」なのか区別できない。
  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.previewAssetId ?? null).not.toBeNull();
  const beforeCamera = (await readSavedGraph3D(page))!.props.spec.camera;

  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  await page.mouse.move(canvasBox!.x + canvasBox!.width * 0.6, canvasBox!.y + canvasBox!.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(canvasBox!.x + canvasBox!.width * 0.25, canvasBox!.y + canvasBox!.height * 0.3, { steps: 12 });
  await page.mouse.up();
  await flushOverlayChanges(page);
  await expect.poll(async () => graph3DCameraMoved(await readSavedGraph3D(page), beforeCamera)).toBe(true);
  // 視点に追いついた派生PNGが書き出されるまで (アイドル600ms) 待ってから戻す。
  await page.waitForTimeout(1_500);

  await pressUndo(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.camera.position ?? null)
    .toEqual(beforeCamera.position);
  // 戻したあとも 3D は生きたまま見えている (プレビューが消えない)。
  await expect(panel).toBeVisible();
  await expect(canvas).toBeVisible();
  await expect(graph.locator(".overlay-graph3d-placeholder")).toHaveCount(0);

  await pressRedo(page);
  await expect.poll(async () => graph3DCameraMoved(await readSavedGraph3D(page), beforeCamera)).toBe(true);
});

test("undoes back to a still preview instead of dropping the 3D material to a placeholder", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });

  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.previewAssetId ?? null).not.toBeNull();

  const visible = panel.getByLabel("表示").first();
  // 表示の切り替えは checkbox ではなく aria-pressed のトグルボタン (uncheck() は落ちる)。
  await visible.click();
  await expect(visible).toHaveAttribute("aria-pressed", "false");
  // 派生PNGが「非表示」に追いつくまで待ってから、選択を外して静止画に戻す。
  await page.waitForTimeout(1_500);
  await closeGraph3DSettings(page);
  await exitGraph3DDirectMode(page, graph);
  await expect(graph.locator("img")).toBeVisible();

  await pressUndo(page);
  // 戻した先は「式と派生PNGが揃った状態」なので、静止画のまま。ライブのWebGL窓へ落ちたり
  // (= 一瞬の空白と、撮り直しがもう1手の履歴になる) プレースホルダーになったりしない。
  await expect(graph.locator("img")).toBeVisible();
  await expect(graph.locator(".overlay-graph3d-placeholder")).toHaveCount(0);
  await expect(graph.locator("canvas.graph3d-preview-canvas")).toHaveCount(0);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.objects[0]?.visible ?? null).not.toBe(false);
});

test("configures plot counts and a rotation axis from two intersecting planes", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const objectDetails = await openGraph3DItemDetails(page, panel, "回転体 の詳細設定");
  await selectUiOption(objectDetails.getByLabel("回転軸"), "planeIntersection");
  await expect(objectDetails).toContainText("x=y と z=0 の共通部分は、(t,t,0) と表せる直線です");
  await objectDetails.getByLabel("軸方向のplot数").fill("18");
  await objectDetails.getByLabel("軸方向のplot数").press("Enter");
  await objectDetails.getByLabel("回転方向のplot数").fill("30");
  await objectDetails.getByLabel("回転方向のplot数").press("Enter");

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => candidate.kind === "solidOfRevolution");
    return object?.kind === "solidOfRevolution" ? {
      axis: object.axis,
      axialPlots: object.axisRange.samples,
      angularPlots: object.angleRange?.samples,
    } : null;
  }).toEqual({
    axis: { kind: "planeIntersection", equations: ["x = y", "z = 0"], parameter: "t" },
    axialPlots: 18,
    angularPlots: 30,
  });
});

test("paints the part two solids share, without cutting anything away", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await useBlankGraph3DTemplate(panel);
  await addGraph3DObject(page, panel, "回転体");
  await addGraph3DObject(page, panel, "不等式で囲む立体");
  await panel.getByRole("button", { name: "共通部分を追加" }).click();

  // 共通部分は切断面ではない。何も切り落とさず、共有している体積だけを塗る。
  await expect(panel.getByRole("img", { name: "共通部分の概形" })).toBeVisible();
  await expect(panel.getByText("立体どうしの共通部分")).toBeVisible();

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const spec = (await readSavedGraph3D(page))?.props.spec;
    const region = spec?.regions.find((candidate) => candidate.kind === "objectIntersection");
    return region?.kind === "objectIntersection"
      ? { members: region.objectIds.length, fill: region.fill.mode, cuts: spec?.cuts.length }
      : null;
  }).toEqual({ members: 2, fill: "solid", cuts: 0 });
});

test("shows the line two planes share and lifts the common part out as its own 3D", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await useBlankGraph3DTemplate(panel);
  await addGraph3DObject(page, panel, "回転体");
  await addGraph3DObject(page, panel, "平面");
  await addGraph3DObject(page, panel, "平面");
  // 同じ名前のカードが2枚あると、共通部分のメンバー選択で区別が付かない。片方に名前を付ける。
  await panel.getByLabel("オブジェクト名").nth(2).fill("平面2");
  const planeCard = panel.getByLabel("オブジェクト名").nth(2)
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await setGraph3DMathFieldValue(planeCard.getByLabel("平面の式"), "x = 0");

  await panel.getByRole("button", { name: "共通部分を追加" }).click();
  const regionDetails = await openGraph3DItemDetails(page, panel, "共通部分 の詳細設定");
  // click + 状態待ちで進める。カードは変更のたびに作り直されるので、check() は
  // 押した直後の古いノードを読んで「変わらなかった」と誤判定する。
  await regionDetails.getByLabel("回転体").click();
  await expect(regionDetails.getByLabel("回転体")).not.toBeChecked();
  await regionDetails.getByLabel("平面2").click();
  await expect(regionDetails.getByLabel("平面2")).toBeChecked();

  // 立体どうしではないので体積はない。z=0 と x=0 が共有しているのは1本の直線。
  await expect(panel.getByText("共有する線")).toBeVisible();
  // 線に「その形のままの平面図」はないので、画像ボタンは押せない。
  await expect(regionDetails.getByRole("button", { name: "平面を画像として挿入" })).toBeDisabled();

  await regionDetails.getByRole("button", { name: "共通部分だけの3Dを挿入" }).click();
  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const shapes = await readSavedOverlayShapes(page);
    const extracted = shapes.filter((shape) => shape.type === "graph3dShape").at(-1);
    const spec = extracted?.props?.spec;
    return spec
      ? {
          graphs: shapes.filter((shape) => shape.type === "graph3dShape").length,
          objects: spec.objects.map((object: { name?: string; visible?: boolean }) => (
            [object.name, object.visible] as const
          )),
          regions: spec.regions.length,
        }
      : null;
  }).toEqual({
    graphs: 2,
    // 取り出した教材では、元の平面は隠したまま共通部分だけが見える。
    objects: [["平面", false], ["平面2", false]],
    regions: 1,
  });
});

test("puts a flat common part into the body as a plane figure", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await useBlankGraph3DTemplate(panel);
  await addGraph3DObject(page, panel, "回転体");
  await addGraph3DObject(page, panel, "平面");
  // 共通部分は先頭2つ (回転体・平面) を選ぶ。回転体を平面で切った形は平面図になる。
  await panel.getByRole("button", { name: "共通部分を追加" }).click();
  await expect(panel.getByText("共有する平面")).toBeVisible();

  const regionDetails = await openGraph3DItemDetails(page, panel, "共通部分 の詳細設定");
  await regionDetails.getByRole("button", { name: "平面を画像として挿入" }).click();

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const shapes = await readSavedOverlayShapes(page);
    const image = shapes.find((shape) => shape.type === "image");
    if (!image) return null;
    const graph = shapes.find((shape) => shape.type === "graph3dShape");
    return {
      // 元の3D教材と同じ段落にぶら下がる。位置と anchor が食い違うと保存のたびに戻ってしまう。
      sameAnchorBlock: image.anchor?.blockId === graph?.anchor?.blockId,
      anchoredBelowOrBeside: (image.anchor?.dy ?? 0) >= (graph?.anchor?.dy ?? 0),
      hasSize: image.props.w > 0 && image.props.h > 0,
    };
  }).toEqual({ sameAnchorBlock: true, anchoredBelowOrBeside: true, hasSize: true });

  const assets = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    return Object.values(parsed?.pageLayout?.overlay?.overlaySnapshot?.assets ?? {}) as Array<{
      props: { src: string; name: string };
    }>;
  });
  // 3D教材そのものの派生プレビューPNGも資産に入っている。差し込んだ平面図はSVGのほう。
  const figure = assets.find((asset) => asset.props.src.startsWith("data:image/svg+xml"));
  expect(figure).toBeDefined();
  expect(decodeURIComponent(figure!.props.src)).toContain("<svg");
});

test("gives a dimension line its own stroke, thickness, and ends", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  // 寸法線と座標軸は同じ線種メニューを共有し、既定値も同じでラベルが一致する。寸法線のカードへ絞る。
  const dimensionCard = panel.getByLabel("表示する数式").first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await dimensionCard.getByLabel("線種（現在: 実線）").click();
  await page.getByRole("menu", { name: "線種" }).getByRole("menuitemradio", { name: "破線" }).click();
  // `tick` は `bar` の旧名 (resolveGraph3DDimensionEndStyle)。保存済み文書からは今も読むが、
  // UI が書けるのは `bar` だけなので、端が既定の矢印でないことは同じだけ言えている。
  await dimensionCard.getByLabel("線の右端（現在: 矢印）").click();
  await page.getByRole("menu", { name: "線の右端" })
    .getByRole("menuitemradio", { name: "バー", exact: true }).click();
  const thickness = dimensionCard.getByLabel("線の太さ");
  await thickness.fill("4");
  await thickness.press("Enter");

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const annotation = (await readSavedGraph3D(page))?.props.spec.annotations[0];
    return annotation?.kind === "dimension"
      ? { lineStyle: annotation.lineStyle, lineWidth: annotation.lineWidth, endStyle: annotation.endStyle }
      : null;
  }).toEqual({ lineStyle: "dashed", lineWidth: 4, endStyle: "bar" });
});

test("uses the toolbar-style menus for coordinate-axis lines and endpoints", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  // 同じ線種メニューは寸法線側にも並ぶ。軸の設定は <fieldset><legend>軸</legend> の中だけを指す。
  const axis = panel.getByRole("group", { name: "軸" });
  await axis.getByLabel("線種（現在: 実線）").click();
  await page.getByRole("menu", { name: "線種" }).getByRole("menuitemradio", { name: "破線" }).click();
  await axis.getByLabel("線の右端（現在: 矢印）").click();
  await page.getByRole("menu", { name: "線の右端" })
    .getByRole("menuitemradio", { name: "ひし形", exact: true }).click();

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const view = (await readSavedGraph3D(page))?.props.spec.view;
    return { line: view?.axisLineStyle, end: view?.axisEndStyle };
  }).toEqual({ line: "dashed", end: "diamond" });

  // 軸の矢印は同じかたちのまま小さくもできる。教科書の図では軸の先が図の中で
  // 一番目立つものになってしまうことがある。
  await axis.getByLabel("線の右端（現在: ひし形）").click();
  await page.getByRole("menu", { name: "線の右端" })
    .getByRole("menuitemradio", { name: "矢印（小）", exact: true }).click();

  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.view.axisEndStyle)
    .toBe("arrowSmall");
});

test("keeps the implicit surface's own default editable in its own field", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await useBlankGraph3DTemplate(panel);
  await addGraph3DObject(page, panel, "F(x,y,z)=0 の曲面");
  const card = panel.getByLabel("オブジェクト名").first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await expect(card.getByRole("img", { name: "タングルキューブの概形" })).toBeVisible();

  // 既定値をそのまま確定し直せる。以前は `F(x,y,z) = 0` の欄に `x^2+y^2+z^2=1` が入っていて、
  // 触ると「「=」を外し、式だけを入力してください。」で拒まれた。
  const field = card.getByLabel("曲面の方程式");
  await setGraph3DMathFieldValue(field, "x^2+y^2-z^2=1");
  await expect(card).not.toContainText("外し");

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => (
      candidate.kind === "implicitSurface"
    ));
    return object?.kind === "implicitSurface" ? object.expression : null;
  }).toBe("x^2+y^2-z^2=1");
});

test("takes a plot count for a solid cut out by curved inequalities", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await addGraph3DObject(page, panel, "不等式で囲む立体");
  const details = await openGraph3DItemDetails(page, panel, "不等式で囲む立体 の詳細設定");
  const plots = details.getByLabel("plot数");
  // 既定でも「見て分かる」粗さでは困る。上限は marchGraph3DScalarField の刻みの上限に合わせる。
  await expect(plots).toHaveValue("44");
  await expect(plots).toHaveAttribute("max", "128");
  await plots.fill("96");
  await plots.press("Enter");

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => (
      candidate.kind === "boundedSolid"
    ));
    return object?.kind === "boundedSolid" ? object.resolution : null;
  }).toBe(96);
});

test("takes a whole inequality in one small math field", async ({ page }) => {
  await openEditor(page);
  await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await addGraph3DObject(page, panel, "不等式で囲む立体");
  const details = await openGraph3DItemDetails(page, panel, "不等式で囲む立体 の詳細設定");
  // 左辺・不等号・右辺に割らず、教材と同じ形のまま1つの欄に書く。
  await setGraph3DMathFieldValue(details.getByTestId("graph3d-inequality-1"), "x \\geqq 1");

  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => (
      candidate.kind === "boundedSolid"
    ));
    return object?.kind === "boundedSolid" ? object.inequalities[0] : null;
  }).toBe("x >= 1");
});

test("animates a parameter without rebuilding the WebGL context every frame", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  const canvas = graph.locator("canvas.graph3d-preview-canvas");
  await expect(canvas).toBeVisible();
  const initialCanvas = await canvas.elementHandle();
  expect(initialCanvas).not.toBeNull();
  // 保存はデバウンスされる。flush の直後に読むと「まだ書かれていない」を「保存されない」と
  // 取り違える (このファイルの他のテストが待っているのと同じ理由)。
  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.parameters[0]?.value)
    .toBeDefined();
  const initialSpec = (await readSavedGraph3D(page))?.props.spec;
  const initialValue = initialSpec?.parameters[0]?.value;
  const initialCamera = initialSpec?.camera;
  expect(initialValue).toBeDefined();
  expect(initialCamera).toBeDefined();

  const parameterDetails = await openGraph3DItemDetails(page, panel, "断面の高さ の詳細設定");
  // 範囲は `min ≦ s ≦ max` の1行。再生はこの範囲を端から端まで動くので、開始・終了の欄は無い。
  await expect(parameterDetails.getByLabel("範囲の最小値")).toBeVisible();
  await expect(parameterDetails.getByLabel("範囲の最大値")).toBeVisible();
  await expect(parameterDetails.getByLabel("秒")).toHaveValue("5");
  await expect(parameterDetails.getByRole("button", { name: "再生", exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(parameterDetails).toHaveCount(0);

  const parameterCard = panel.getByRole("button", { name: "断面の高さ の詳細設定" })
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await parameterCard.getByRole("button", { name: "再生", exact: true }).click();
  await expect(parameterCard.getByRole("button", { name: "停止", exact: true })).toBeVisible();
  await page.waitForTimeout(260);

  expect(await canvas.evaluate((current, initial) => current === initial, initialCanvas)).toBe(true);
  // 再生値は派生表示だけに流し、SigmaDoc と保存デバウンスは毎フレーム動かさない。
  expect((await readSavedGraph3D(page))?.props.spec.parameters[0]?.value).toBe(initialValue);

  // 再生中の追加・削除は scene 内だけを差分更新し、canvas とカメラを作り直さない。
  await addGraph3DObject(page, panel, "不等式で囲む立体");
  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.objects.length).toBe(3);
  expect(await canvas.evaluate((current, initial) => current === initial, initialCanvas)).toBe(true);
  expect((await readSavedGraph3D(page))?.props.spec.camera).toEqual(initialCamera);

  const addedObjectCard = panel.getByLabel("オブジェクト名").last()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await addedObjectCard.hover();
  const addedObjectDetails = page.getByRole("dialog", { name: "不等式で囲む立体 の詳細設定" });
  await expect(addedObjectDetails).toBeVisible();
  await addedObjectDetails.getByRole("button", { name: "オブジェクトを削除" }).click();
  await flushOverlayChanges(page);
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.objects.length).toBe(2);
  expect(await canvas.evaluate((current, initial) => current === initial, initialCanvas)).toBe(true);
  expect((await readSavedGraph3D(page))?.props.spec.camera).toEqual(initialCamera);

  const samples = await parameterCard.evaluate(async (card) => {
    const values: { slider: number; output: number }[] = [];
    for (let i = 0; i < 20; i += 1) {
      await new Promise(requestAnimationFrame);
      values.push({ slider: Number(card.querySelector<HTMLInputElement>('input[type="range"]')!.value), output: Number(card.querySelector("output")!.textContent) });
    }
    return values;
  });
  expect(samples.every((sample) => Math.abs(sample.slider - sample.output) <= 0.011)).toBe(true);
  expect((await panel.getByRole("button", { name: "立体・図形を追加" }).boundingBox())!.height).toBeLessThanOrEqual(48);
  await page.screenshot({ path: "test-results/graph-parameters-3d.png" });
  await parameterCard.getByRole("button", { name: "停止", exact: true }).click();
  await expect.poll(async () => (await readSavedGraph3D(page))?.props.spec.parameters[0]?.value)
    .not.toBe(initialValue);
});

test("keeps a material moving on the page once its parameter is set to play there", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });

  const parameterDetails = await openGraph3DItemDetails(page, panel, "断面の高さ の詳細設定");
  // 詳細ダイアログはホバーで開いた直後に位置を決め直す。その最中のクリックは届いても
  // 状態が変わらないことがあるので、チェックが入るまで押し直す。
  const playOnPage = parameterDetails.getByRole("checkbox", { name: "ページ上でも動かす" });
  await expect(async () => {
    if (!(await playOnPage.isChecked())) await playOnPage.click();
    await expect(playOnPage).toBeChecked();
  }).toPass({ timeout: 10_000 });
  // ホバーで開くダイアログなので、閉じるにはポインタも外に出す。
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await expect(parameterDetails).toHaveCount(0);
  await closeGraph3DSettings(page);
  // ページ上で動かす設定にした直後は派生画像が古い。撮り直し (24コマぶんの再構築・描画・符号化)
  // が終わるまでライブの WebGL 窓が残るので、canvas が消えるのを待つのではなく静止画に切り替わる
  // のを待つ。単体なら数秒だが、他のスイートと dev サーバーを共有していると桁が変わる。
  await page.keyboard.press("Escape");
  const image = graph.locator("img");
  await expect(image).toBeVisible({ timeout: 60_000 });
  await expect(graph.locator("canvas.graph3d-preview-canvas")).toHaveCount(0);
  await flushOverlayChanges(page);
  // 動きは PNG のまま持つ (acTL を足した APNG)。印刷・SVG 書き出し・APNG を知らないデコーダは
  // 同じ 1 枚目を静止画として読むので、保存経路も安全側の許可リストも増えない。
  await expect.poll(async () => readSavedGraph3DPreviewAsset(page).then((asset) => asset?.chunks))
    .toContain("acTL");

  // 「動きが見える」ことそのものを見る: 置かれた図の見た目が、触らなくても変わる。
  const first = await image.screenshot();
  await expect.poll(async () => (await image.screenshot()).equals(first), { timeout: 8_000 })
    .toBe(false);

  // 動く教材の大きさは「どれだけ動くか」で決まる。ここで守るのは絶対値ではなく、保存した
  // 画素あたりの重さ — フレーム間差分と圧縮が効いていること。
  // 以前の 600KB は、ひな形のパラメータが何も動かしていなかった頃 (全フレームが同じ絵) の
  // 値で、静止画しか通らない基準だった。断面が実際に動く今の既定で 2.4MB・0.38/画素。
  const asset = await readSavedGraph3DPreviewAsset(page);
  expect(asset).not.toBeNull();
  const storedPixels = (asset?.width ?? 0) * (asset?.height ?? 0) * (asset?.frames ?? 0);
  expect(storedPixels).toBeGreaterThan(0);
  expect((asset?.bytes ?? Number.POSITIVE_INFINITY) / storedPixels).toBeLessThan(0.55);
  expect(asset?.bytes ?? Number.POSITIVE_INFINITY).toBeLessThan(4_000_000);
});

test("keeps unfinished formulas editable and exports a cached static preview", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });

  // 保存はデバウンスされる。フラッシュしてから基準を読まないと「まだ保存されていない」を
  // 「読み取れない式で消えた」と取り違える (どちらも null に見える)。
  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => (
      candidate.kind === "solidOfRevolution"
    ));
    return object?.kind === "solidOfRevolution" ? object.radius : null;
  }).toBe("sqrt(2*z^2 + 1)");
  const initialRadius = "sqrt(2*z^2 + 1)";

  const objectCard = panel.getByLabel("オブジェクト名").first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await setGraph3DMathFieldValue(objectCard.getByLabel("断面の方程式"), "x+");
  await expect(objectCard).toContainText(/式を読み取れません|演算記号|等号/);
  await flushOverlayChanges(page);
  await expect.poll(async () => {
    const object = (await readSavedGraph3D(page))?.props.spec.objects.find((candidate) => (
      candidate.kind === "solidOfRevolution"
    ));
    return object?.kind === "solidOfRevolution" ? object.radius : null;
  }).toBe(initialRadius);

  await setGraph3DMathFieldValue(objectCard.getByLabel("断面の方程式"), "\\sqrt{z^2+1}");
  await expect.poll(async () => {
    const shape = await readSavedGraph3D(page);
    return shape?.props?.previewAssetId ?? null;
  }).not.toBeNull();

  await closeGraph3DSettings(page);
  await exitGraph3DDirectMode(page, graph);
  await expect(graph.locator("img")).toBeVisible();
  await graph.dblclick();
  const reopenedPanel = page.getByRole("dialog", { name: "3D教材の設定" });
  await expect(reopenedPanel).toBeVisible();
  const reopenedObjectCard = reopenedPanel.getByLabel("オブジェクト名").first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  const reopenedField = await openGraph3DMathField(
    reopenedObjectCard.getByLabel("断面の方程式"),
  );
  await expect.poll(() => reopenedField.evaluate((element) => (
    element as HTMLElement & { value?: string }
  ).value)).toBe("\\sqrt{z^{2} + 1}");
});

test("turns a solid past half a turn in one drag", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  await closeGraph3DSettings(page);
  const project = await selectGraph3DSolid(page, graph);

  // 弧を掴んだまま、その点が実際に通る円周をなぞって 3/4 回転させる。
  const grip = graph3DRotationGripPoint();
  const pathPoint = (turn: number) => {
    const angle = turn * Math.PI * 2;
    return project({
      x: grip.x,
      y: grip.y * Math.cos(angle) - grip.z * Math.sin(angle),
      z: grip.y * Math.sin(angle) + grip.z * Math.cos(angle),
    });
  };
  const start = pathPoint(0);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let step = 1; step <= 60; step += 1) {
    const point = pathPoint((step / 60) * 0.75);
    await page.mouse.move(point.x, point.y);
  }
  await page.mouse.up();

  // 半回転で折り返す実装なら 0 か ±π にしかならない。3/4 回転は -π/2 として残る。
  const rotation = (await readSavedGraph3DObject(page))?.rotation;
  expect(rotation).toBeDefined();
  expect(Number(rotation!.x)).toBeCloseTo(-Math.PI / 2, 1);
  expect(Number(rotation!.y)).toBeCloseTo(0, 3);
  expect(Number(rotation!.z)).toBeCloseTo(0, 3);
});

test("moves a solid from anywhere on its axis and scales from the knob", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  await closeGraph3DSettings(page);
  const project = await selectGraph3DSolid(page, graph);

  // 軸の中央ではなく、負の側の端に近いところを掴む。
  await dragGraph3DAlongX(page, project, -GRAPH3D_GIZMO_LENGTH * 0.9, 1);
  const moved = await readSavedGraph3DObject(page);
  expect(Number(moved?.translation?.x)).toBeCloseTo(1, 1);
  expect(moved?.scale).toBeUndefined();

  // ◆ は移動ではなく拡大縮小。立体が動いた分だけギズモの原点もずれている。
  await dragGraph3DAlongX(page, project, 1 + GRAPH3D_GIZMO_LENGTH * 0.78, 1);
  const scaled = await readSavedGraph3DObject(page);
  expect(Number(scaled?.scale?.x)).toBeGreaterThan(1.2);
  expect(Number(scaled?.translation?.x)).toBeCloseTo(1, 1);
});

test("resizes the placed viewport like a window without stretching its canvas", async ({ page }) => {
  await openEditor(page);
  const graph = await insertGraph3D(page);
  await closeGraph3DSettings(page);
  await exitGraph3DDirectMode(page, graph);

  await graph.click();
  const eastHandle = page.locator(".overlay-resize-handle.e");
  await expect(eastHandle).toBeVisible();
  const handleBox = await eastHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 140, handleBox!.y + handleBox!.height / 2, { steps: 10 });
  await page.mouse.up();

  await graph.dblclick();
  const canvas = graph.locator("canvas.graph3d-preview-canvas");
  await expect(canvas).toBeVisible();
  const frameBox = await graph.boundingBox();
  const canvasBox = await canvas.boundingBox();
  expect(frameBox).not.toBeNull();
  expect(canvasBox).not.toBeNull();
  expect(Math.abs(canvasBox!.width - frameBox!.width)).toBeLessThanOrEqual(2);
  expect(Math.abs(canvasBox!.height - frameBox!.height)).toBeLessThanOrEqual(2);
  const aspects = await canvas.evaluate((element) => {
    const canvasElement = element as HTMLCanvasElement;
    return {
      css: canvasElement.clientWidth / canvasElement.clientHeight,
      drawingBuffer: canvasElement.width / canvasElement.height,
    };
  });
  expect(Math.abs(aspects.css - aspects.drawingBuffer)).toBeLessThan(0.02);
});

async function openEditor(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
}

async function insertGraph3D(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  const insertMenu = page.getByRole("menu", { name: "挿入", exact: true });
  await expect(insertMenu).toBeVisible();
  await insertMenu.getByRole("menuitem", { name: "3D教材" }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + 120;
  const startY = surfaceBox!.y + 150;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 320, startY + 210, { steps: 10 });
  await page.mouse.up();

  const graph = page.getByTestId("overlay-graph3d").first();
  await expect(graph).toBeVisible();
  await expect(page.getByRole("dialog", { name: "3D教材の設定" })).toBeVisible();
  return graph;
}

async function closeGraph3DSettings(page: Page): Promise<void> {
  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await panel.getByRole("button", { name: "閉じる" }).click();
  await expect(panel).toHaveCount(0);
}

async function exitGraph3DDirectMode(page: Page, graph: Locator): Promise<void> {
  await page.keyboard.press("Escape");
  await expect(graph.locator("canvas.graph3d-preview-canvas")).toHaveCount(0);
}

async function openGraph3DMathField(trigger: Locator): Promise<Locator> {
  const testId = await trigger.getAttribute("data-testid");
  expect(testId).not.toBeNull();
  await trigger.click();
  const field = trigger.page().getByTestId(`${testId}-field`).last();
  await expect(field).toBeVisible();
  await field.evaluate(async () => customElements.whenDefined("math-field"));
  return field;
}

async function setGraph3DMathFieldValue(trigger: Locator, tex: string): Promise<void> {
  const field = await openGraph3DMathField(trigger);
  await field.evaluate((element, value) => {
    const mathField = element as HTMLElement & { value: string };
    mathField.value = value;
    mathField.dispatchEvent(new Event("input", { bubbles: true }));
  }, tex);
  await field.press("Enter");
  await expect(field).toHaveCount(0);
}

/**
 * 立体の種類はドロップダウンではなくカードのギャラリー。名前だけでは
 * 「媒介変数曲面」と「F(x,y,z)=0 の曲面」の違いが分からないので、形そのものを並べている。
 */
/**
 * Empties the figure before the test builds the one it is about.
 *
 * The template a fresh 3D material opens with is content, not a fixture: it already holds a solid,
 * a cutting plane and the common part between them. A test about what two objects share has to
 * state its own two objects, or it is really testing whatever the template last shipped.
 */
async function useBlankGraph3DTemplate(panel: Locator): Promise<void> {
  await selectUiOption(panel.getByLabel("ひな形"), "blank");
  await expect(panel.getByLabel("オブジェクト名")).toHaveCount(0);
}

async function addGraph3DObject(page: Page, panel: Locator, label: string): Promise<void> {
  await panel.getByRole("button", { name: "立体・図形を追加" }).click();
  const picker = page.getByRole("dialog", { name: "追加する立体" });
  await expect(picker).toBeVisible();
  await picker.getByRole("button", { name: label, exact: true }).click();
  await expect(picker).toHaveCount(0);
}

async function openGraph3DItemDetails(page: Page, panel: Locator, label: string): Promise<Locator> {
  const details = page.getByRole("dialog", { name: label });
  if (await details.isVisible().catch(() => false)) return details;
  const trigger = panel.getByRole("button", { name: label });
  const card = trigger.locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' graph-curve-editor ')][1]");
  await card.hover();
  if (await details.isVisible().catch(() => false)) return details;
  await trigger.click();
  await expect(details).toBeVisible();
  return details;
}

async function expectPanelNotToCoverShape(panel: Locator, shape: Locator): Promise<void> {
  const panelBox = await panel.boundingBox();
  const shapeBox = await shape.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(shapeBox).not.toBeNull();
  // 3D は要素が多いぶん2Dより広い。ただし「グラフを覆わない」ほうが優先で、
  // 横に入らなければ狭い側へ縮む (graph-settings-panel-placement)。
  expect(panelBox!.width).toBeGreaterThanOrEqual(300);
  expect(panelBox!.width).toBeLessThanOrEqual(620);
  const intersects = panelBox!.x < shapeBox!.x + shapeBox!.width
    && shapeBox!.x < panelBox!.x + panelBox!.width
    && panelBox!.y < shapeBox!.y + shapeBox!.height
    && shapeBox!.y < panelBox!.y + panelBox!.height;
  expect(intersects).toBe(false);
}

async function pressUndo(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
}

async function pressRedo(page: Page): Promise<void> {
  await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+z" : "Control+Shift+z");
}

function graph3DCameraMoved(
  shape: OverlayGraph3DShape | null,
  before: OverlayGraph3DShape["props"]["spec"]["camera"],
): boolean {
  const position = shape?.props.spec.camera.position;
  if (!position) return false;
  return position.x !== before.position.x
    || position.y !== before.position.y
    || position.z !== before.position.z;
}


/**
 * 立体の広がりから決まる操作軸の長さ。既定の回転体は原点から最も遠い頂点が
 * `sqrt(7 + 3)` にあり、ギズモはその 0.55 倍（上限 3.2）を軸の長さにする。
 */
const GRAPH3D_GIZMO_LENGTH = Math.min(3.2, Math.max(0.8, Math.sqrt(10) * 0.55));

/** 回転の弧を掴む点。x 軸まわりの弧は yz 平面上、軸から離した角度から始まる。 */
function graph3DRotationGripPoint(): { x: number; y: number; z: number } {
  const angle = Math.PI * 0.26;
  const radius = GRAPH3D_GIZMO_LENGTH * 0.46;
  return { x: 0, y: Math.cos(angle) * radius, z: Math.sin(angle) * radius };
}

/**
 * 立体を選び、ワールド座標を画面座標へ写す関数を返す。
 *
 * プレビューは spec のカメラをそのまま three.js に渡すので、同じカメラをテスト側で組めば
 * ギズモのどこを掴んでいるかを誤差なく指定できる。
 */
async function selectGraph3DSolid(
  page: Page,
  graph: Locator,
): Promise<(point: { x: number; y: number; z: number }) => { x: number; y: number }> {
  const canvas = graph.locator("canvas.graph3d-preview-canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(box!.x + box!.width * 0.5, box!.y + box!.height * 0.55);
  await page.waitForTimeout(300);
  const camera = new PerspectiveCamera(42, box!.width / box!.height, 0.01, 10_000);
  camera.up.set(0, 0, 1);
  camera.position.set(5.5, -6.5, 4.5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return (point) => {
    const projected = new Vector3(point.x, point.y, point.z).project(camera);
    return {
      x: box!.x + ((projected.x + 1) / 2) * box!.width,
      y: box!.y + ((1 - projected.y) / 2) * box!.height,
    };
  };
}

/** x 軸上の `from` を掴んで、ワールド座標で `distance` だけ +x へ引く。 */
async function dragGraph3DAlongX(
  page: Page,
  project: (point: { x: number; y: number; z: number }) => { x: number; y: number },
  from: number,
  distance: number,
): Promise<void> {
  const grip = project({ x: from, y: 0, z: 0 });
  const target = project({ x: from + distance, y: 0, z: 0 });
  await page.mouse.move(grip.x, grip.y);
  await page.mouse.down();
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(
      grip.x + ((target.x - grip.x) / 12) * step,
      grip.y + ((target.y - grip.y) / 12) * step,
    );
  }
  await page.mouse.up();
}

async function readSavedGraph3DObject(page: Page): Promise<Graph3DObject | null> {
  await flushOverlayChanges(page);
  // 保存はデバウンスされるので、書き戻りを待ってから読む。
  await page.waitForTimeout(1500);
  const shape = await readSavedGraph3D(page);
  return shape?.props.spec.objects[0] ?? null;
}

async function flushOverlayChanges(page: Page): Promise<void> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
}

async function readSavedGraph3D(page: Page): Promise<OverlayGraph3DShape | null> {
  return page.evaluate<OverlayGraph3DShape | null>(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    return document?.pageLayout?.overlay?.overlaySnapshot?.shapes?.find(
      (shape: { type?: string }) => shape.type === "graph3dShape",
    ) ?? null;
  });
}

/**
 * The material's derived picture: its PNG chunk types and how much of the document it takes.
 * `acTL` is the chunk that makes a PNG an animation.
 */
async function readSavedGraph3DPreviewAsset(
  page: Page,
): Promise<{ chunks: string[]; bytes: number; width: number; height: number; frames: number } | null> {
  const shape = await readSavedGraph3D(page);
  const assetId = shape?.props.previewAssetId;
  if (!assetId) return null;
  return page.evaluate<
    { chunks: string[]; bytes: number; width: number; height: number; frames: number } | null,
    string
  >((id) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    const source: string | undefined = parsed?.pageLayout?.overlay?.overlaySnapshot?.assets?.[id]?.props?.src;
    const prefix = "data:image/png;base64,";
    if (!source || !source.startsWith(prefix)) return null;
    const binary = atob(source.slice(prefix.length));
    const chunks: string[] = [];
    const uint32 = (at: number) => ((binary.charCodeAt(at) << 24)
      | (binary.charCodeAt(at + 1) << 16)
      | (binary.charCodeAt(at + 2) << 8)
      | binary.charCodeAt(at + 3)) >>> 0;
    let width = 0;
    let height = 0;
    let frames = 0;
    let offset = 8;
    while (offset + 8 <= binary.length) {
      const length = uint32(offset);
      const type = binary.slice(offset + 4, offset + 8);
      chunks.push(type);
      // IHDR は width/height、acTL は num_frames を先頭に持つ。どちらも保存された画素数を
      // 数えるためだけに読む。
      if (type === "IHDR") {
        width = uint32(offset + 8);
        height = uint32(offset + 12);
      }
      if (type === "acTL") frames = uint32(offset + 8);
      offset += 12 + length;
    }
    return { chunks, bytes: source.length, width, height, frames };
  }, assetId);
}

async function readSavedOverlayShapes(page: Page): Promise<Array<{
  type: string;
  anchor?: { blockId?: string; dy?: number };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  props: any;
}>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  });
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL
    ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString()
    : path;
}
