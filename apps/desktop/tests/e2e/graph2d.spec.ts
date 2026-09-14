import { expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { exerciseFormulaLabels, expectFormulaOnCanvas, savedFormula } from "../helpers/graph-formula-labels";

const GRAPH_E2E_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_graph2d_blank",
  metadata: { title: "グラフ e2e" },
  content: [
    {
      type: "paragraph",
      id: "p_e2e_graph_intro",
      children: [{ type: "text", text: "グラフ編集の確認" }],
    },
  ],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, GRAPH_E2E_DOCUMENT);
});

test("keeps formula labels consistent with display math through toggles and reload", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  const readDocument = () => page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null") as SigmaDocument | null);
  const path = await exerciseFormulaLabels(page, readDocument);
  const saved = (await readDocument())!;
  const restored = await page.context().newPage();
  await installDesktopRuntimeMock(restored, saved);
  await restored.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expectFormulaOnCanvas(restored, "y = sx");
  await expect(restored.getByTestId("graph2d-curve").first()).toHaveAttribute("d", path);
  expect(savedFormula(saved)?.curve.expr).toBe("s*x");
  await restored.close();
});

test("shares compact parameter cards, animates 2D curves, and reloads the saved expression", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  const box = (await graph.boundingBox())!;
  await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await openGraphSettingsFromContextMenu(page, graph);
  const panel = page.getByRole("dialog", { name: "グラフの設定" });
  await panel.getByRole("button", { name: "パラメータを追加" }).click();
  await panel.getByRole("button", { name: "関数を追加" }).click();
  await setMathFieldValue(page, "overlay-graph-expr-input", "s*x");
  const slider = panel.getByRole("slider", { name: "s", exact: true });
  await slider.fill("0.5");
  await expect.poll(async () => (await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.value).toBe(0.5);
  const curve = graph.getByTestId("graph2d-curve").first();
  const initialPath = await curve.getAttribute("d");
  expect(initialPath).toBeTruthy();
  await panel.getByRole("button", { name: "再生", exact: true }).click();
  await expect.poll(() => curve.getAttribute("d")).not.toBe(initialPath);
  expect((await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.value).toBe(0.5);
  // An unrelated edit must not restore the slider's saved value while it is moving.
  await panel.getByRole("button", { name: "点を追加", exact: true }).click();
  const samples = await slider.evaluate(async (input) => {
    const card = input.closest(".graph-curve-editor")!;
    const result: { slider: number; output: number }[] = [];
    for (let i = 0; i < 12; i += 1) {
      await new Promise(requestAnimationFrame);
      result.push({ slider: Number((input as HTMLInputElement).value), output: Number(card.querySelector("output")!.textContent) });
    }
    return result;
  });
  expect(samples.every((sample) => Math.abs(sample.slider - sample.output) <= 0.011)).toBe(true);
  await panel.getByRole("button", { name: "停止", exact: true }).click();
  const stopped = Number(await slider.inputValue());
  await expect.poll(async () => (await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.value).not.toBe(0.5);
  await expect.poll(async () => (await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.value).toBeCloseTo(stopped, 2);
  const stoppedPath = await curve.getAttribute("d");
  const saved = (await page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document")))!;
  expect(JSON.parse(saved).pageLayout.overlay.overlaySnapshot.shapes.find((shape: { type: string }) => shape.type === "graph2dShape").props.spec.curves[0].expr).toContain("s");
  await page.screenshot({ path: "test-results/graph-parameters-2d.png" });
  const restored = await page.context().newPage();
  await installDesktopRuntimeMock(restored, JSON.parse(saved) as SigmaDocument);
  await restored.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(restored.getByText("準備完了")).toBeVisible();
  await expect(restored.getByTestId("graph2d-curve").first()).toHaveAttribute("d", stoppedPath!);
  await restored.close();
  // Close during playback: cleanup persists the last displayed value and removes the RAF loop.
  await panel.getByRole("button", { name: "再生", exact: true }).click();
  await expect.poll(() => slider.inputValue()).not.toBe(String(stopped));
  await closeGraphSettingsPanel(page);
  await expect.poll(async () => (await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.value).not.toBe(stopped);
  const afterClose = await curve.getAttribute("d");
  await page.waitForTimeout(200);
  expect(await curve.getAttribute("d")).toBe(afterClose);
  await openGraphSettingsFromContextMenu(page, graph);
  const addTile = panel.getByRole("button", { name: "パラメータを追加" });
  expect((await addTile.boundingBox())!.height).toBeLessThanOrEqual(48);
  await panel.getByRole("button", { name: "s の詳細設定" }).click();
  const details = page.getByRole("dialog", { name: "s の詳細設定" });
  await details.getByRole("checkbox", { name: "ページ上でも動かす" }).check();
  await page.mouse.move(0, 0);
  await page.keyboard.press("Escape");
  await closeGraphSettingsPanel(page);
  const firstPageFrame = await curve.getAttribute("d");
  await expect.poll(() => curve.getAttribute("d")).not.toBe(firstPageFrame);
  await expect.poll(async () => (await getSavedFirstGraph(page))?.props.spec.parameters?.[0]?.animation?.playOnPage).toBe(true);
  const animatedDocument = (await page.evaluate(() => localStorage.getItem("sigma-studio:e2e-document")))!;
  const animatedPage = await page.context().newPage();
  await installDesktopRuntimeMock(animatedPage, JSON.parse(animatedDocument) as SigmaDocument);
  await animatedPage.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  const restoredCurve = animatedPage.getByTestId("graph2d-curve").first();
  await expect(restoredCurve).toBeVisible();
  const firstRestoredFrame = await restoredCurve.getAttribute("d");
  await expect.poll(() => restoredCurve.getAttribute("d")).not.toBe(firstRestoredFrame);
  await animatedPage.close();
});

test("hides graph chrome while choosing the initial origin", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");

  const overlayGraphs = page.locator(".graph-shape");
  await expect(overlayGraphs).toHaveCount(1);
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toHaveCount(0);
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(0);
  await expect(page.locator(".overlay-shape-dimension-label")).toHaveCount(0);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(0);
  await expect(page.locator(".overlay-anchor-handle")).toHaveCount(0);
  await expect(overlayGraphs.first()).toHaveCSS("outline-style", "none");

  const originBox = await overlayGraphs.first().boundingBox();
  expect(originBox).not.toBeNull();
  const originPickX = originBox!.x + originBox!.width * 0.42;
  const originPickY = originBox!.y + originBox!.height * 0.48;
  await page.mouse.move(originPickX, originPickY);
  await expect(page.getByTestId("overlay-graph-origin-preview")).toBeVisible();
  await expect(page.getByTestId("overlay-graph-origin-preview-target")).toBeVisible();
  await expect(page.locator(".overlay-shape-dimension-label")).toHaveCount(0);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(0);
  await expect(page.locator(".overlay-anchor-handle")).toHaveCount(0);
  await expect(overlayGraphs.first()).toHaveCSS("outline-style", "none");

  await page.mouse.click(originPickX, originPickY);
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(2);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(1);
  await expect(page.locator(".overlay-shape-dimension-label")).toHaveCount(1);
  await openGraphSettingsFromContextMenu(page, overlayGraphs.first());
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();
});

test("keeps an axis label attached while its graph moves and resizes", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  const initial = await graph.boundingBox();
  expect(initial).not.toBeNull();
  await page.mouse.click(initial!.x + initial!.width * 0.3, initial!.y + initial!.height * 0.38);

  await openGraphSettingsFromContextMenu(page, graph);
  await expandGraphDisclosure(page, "軸名");
  await page.getByTestId("overlay-graph-axis-label-x").check();
  const label = page.locator(".overlay-shape-text").first();
  await expect(label).toBeVisible();
  await closeGraphSettingsPanel(page);

  const graphBeforeMove = await graph.boundingBox();
  const labelBeforeMove = await label.boundingBox();
  expect(graphBeforeMove).not.toBeNull();
  expect(labelBeforeMove).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.up("Shift");

  await expect.poll(async () => (await graph.boundingBox())?.x ?? 0)
    .toBeGreaterThan(graphBeforeMove!.x + 10);
  const graphAfterMove = await graph.boundingBox();
  const labelAfterMove = await label.boundingBox();
  expect(graphAfterMove).not.toBeNull();
  expect(labelAfterMove).not.toBeNull();
  expect(labelAfterMove!.x - labelBeforeMove!.x)
    .toBeCloseTo(graphAfterMove!.x - graphBeforeMove!.x, 1);
  expect(labelAfterMove!.y - labelBeforeMove!.y)
    .toBeCloseTo(graphAfterMove!.y - graphBeforeMove!.y, 1);

  const eastHandle = page.locator(".overlay-resize-handle.e");
  await expect(eastHandle).toBeVisible();
  const handleBox = await eastHandle.boundingBox();
  expect(handleBox).not.toBeNull();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 80, handleBox!.y + handleBox!.height / 2, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await graph.boundingBox())?.width ?? 0)
    .toBeGreaterThan(graphAfterMove!.width + 40);
  const graphAfterResize = await graph.boundingBox();
  const labelAfterResize = await label.boundingBox();
  expect(graphAfterResize).not.toBeNull();
  expect(labelAfterResize).not.toBeNull();
  const relativeLabelXBefore = (labelAfterMove!.x - graphAfterMove!.x) / graphAfterMove!.width;
  const relativeLabelXAfter = (labelAfterResize!.x - graphAfterResize!.x) / graphAfterResize!.width;
  expect(relativeLabelXAfter).toBeCloseTo(relativeLabelXBefore, 1);
});

test("toggles graph point fill between solid and open styles", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const overlayGraph = page.locator(".graph-shape").first();
  await expect(overlayGraph).toBeVisible();

  const originBox = await overlayGraph.boundingBox();
  expect(originBox).not.toBeNull();
  const originPickX = originBox!.x + originBox!.width * 0.3;
  const originPickY = originBox!.y + originBox!.height * 0.38;
  await page.mouse.click(originPickX, originPickY);
  await openGraphSettingsFromContextMenu(page, overlayGraph);
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();

  await page.getByRole("button", { name: "点を追加", exact: true }).click();
  const graphPoint = page.locator(".overlay-shape.selected .graph2d-point").first();
  // 白黒基調の既定: 新規点は黒。
  await expect(graphPoint).toHaveAttribute("fill", "#0d0d0d");

  const pointCard = page.locator('.graph-curve-editor:has([data-testid="overlay-graph-point-x-input"])');
  const pointActions = pointCard.getByRole("button", { name: "点 1 の操作" });
  await page.mouse.move(0, 0);
  await expect(pointActions).toHaveCSS("opacity", "0");
  await pointCard.hover();
  await expect(pointActions).toHaveCSS("opacity", "1");
  await openGraphItemActions(page, "overlay-graph-point-actions", "点 1 の操作");
  const fillSegment = page.getByTestId("overlay-graph-point-fill");
  await fillSegment.getByRole("button", { name: "白丸" }).click();
  await expect(graphPoint).toHaveAttribute("fill", "#ffffff");
  // 白丸の輪郭は点の指定色(既定の黒)を使う。
  await expect(graphPoint).toHaveAttribute("stroke", "#0d0d0d");
  await expect(graphPoint).toHaveAttribute("stroke-width", "2.4");

  await fillSegment.getByRole("button", { name: "黒丸" }).click();
  await expect(graphPoint).toHaveAttribute("fill", "#0d0d0d");
  await expect(graphPoint).toHaveAttribute("stroke-width", "0");
});

test("edits point coordinates with math input", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const overlayGraph = page.locator(".graph-shape").first();
  await expect(overlayGraph).toBeVisible();

  const originBox = await overlayGraph.boundingBox();
  expect(originBox).not.toBeNull();
  await page.mouse.click(originBox!.x + originBox!.width * 0.3, originBox!.y + originBox!.height * 0.38);
  await openGraphSettingsFromContextMenu(page, overlayGraph);
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();

  await page.getByRole("button", { name: "点を追加", exact: true }).click();
  const graphPoint = page.locator(".overlay-shape.selected .graph2d-point").first();
  await expect(graphPoint).toBeVisible();
  const initialCx = Number(await graphPoint.getAttribute("cx"));

  // 分数・平方根を含む座標を数式で入力すると点が移動する。
  await setMathFieldValue(page, "overlay-graph-point-x-input", "\\frac{3}{2}");
  await setMathFieldValue(page, "overlay-graph-point-y-input", "\\sqrt{2}");
  await expect
    .poll(async () => Number(await graphPoint.getAttribute("cx")))
    .not.toBe(initialCx);

  // 保存される座標は評価用の正規化式 + 入力 TeX。
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  // 座標は1つずつ確定するので、x だけを待って y を読むと「x は入ったが y はまだ」の
  // 途中の保存を読んでしまう。4つまとめて待つ。
  await expect
    .poll(async () => {
      const point = await getSavedFirstGraphPoint(page);
      return point ? { x: point.x, y: point.y, xTex: point.xTex, yTex: point.yTex } : null;
    })
    .toEqual({ x: "3/2", y: "sqrt(2)", xTex: "\\frac{3}{2}", yTex: "\\sqrt{2}" });
});

test("shows the shared TeX editor above graph settings without a graph-local mode switch", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.setItem("sigma-studio:inline-math-input-mode", "tex");
  });
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  const graphBox = await graph.boundingBox();
  expect(graphBox).not.toBeNull();
  await page.mouse.click(graphBox!.x + graphBox!.width * 0.3, graphBox!.y + graphBox!.height * 0.38);
  await openGraphSettingsFromContextMenu(page, graph);

  const graphDialog = page.getByRole("dialog", { name: "グラフの設定" });
  await expect(graphDialog.getByRole("group", { name: "数式入力モード" })).toHaveCount(0);
  await graphDialog.getByRole("button", { name: "関数を追加" }).click();
  await page.getByTestId("overlay-graph-expr-input").click();

  const texEditor = page.getByRole("dialog", { name: "TeX数式を編集" });
  await expect(texEditor.getByRole("textbox", { name: "関数 1 の式" })).toBeVisible();
  const [graphDialogZIndex, texEditorZIndex] = await Promise.all([
    graphDialog.evaluate((element) => Number(getComputedStyle(element).zIndex)),
    texEditor.evaluate((element) => Number(getComputedStyle(element).zIndex)),
  ]);
  expect(texEditorZIndex).toBeGreaterThan(graphDialogZIndex);
});

test("crops graphs on double click and opens settings from the context menu", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();

  const box = await graph.boundingBox();
  expect(box).not.toBeNull();
  const graphX = box!.x + box!.width * 0.42;
  const graphY = box!.y + box!.height * 0.48;
  // 挿入直後の原点指定を完了する。
  await page.mouse.click(graphX, graphY);
  const selectedShape = page.locator(".overlay-shape.selected").first();
  await expect(selectedShape).toBeVisible();
  await expect(page.locator(".overlay-selection-box")).toHaveCount(1);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);
  await expect(page.locator('[aria-label="詳細"]')).toHaveCount(0);

  const selectedBox = await selectedShape.boundingBox();
  expect(selectedBox).not.toBeNull();
  const interactionPosition = { x: selectedBox!.width * 0.42, y: selectedBox!.height * 0.48 };
  await selectedShape.click({ position: interactionPosition });
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toHaveCount(0);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);

  await selectedShape.dblclick({ position: interactionPosition });
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);

  await selectedShape.click({ button: "right", position: interactionPosition });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "グラフの設定…" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "表示領域をトリミング" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "原点をクリックで指定" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "閉領域を塗りつぶす" })).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "グラフの設定…" }).click();
  const settingsDialog = page.getByRole("dialog", { name: "グラフの設定" });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole("button", { name: "関数を追加" })).toBeVisible();
});

test("keeps the graph visible while its settings panel is open", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const insertBox = await graph.boundingBox();
  expect(insertBox).not.toBeNull();
  await page.mouse.click(insertBox!.x + insertBox!.width * 0.42, insertBox!.y + insertBox!.height * 0.48);

  await openGraphSettingsFromContextMenu(page, graph);
  const panel = page.getByRole("dialog", { name: "グラフの設定" });

  // グリッドの既定幅でもパネルがグラフを覆わず、空き幅に応じて縮む。
  await expectGraphSettingsPanelClearOfGraph(page, graph);

  // 3. モード開始でパネルが閉じない (closeAndRun 廃止)
  const fillButton = page.getByTestId("overlay-graph-fill-button");
  await fillButton.click();
  await expect(panel).toBeVisible();
  await expect(fillButton).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("overlay-graph-mode-status")).toContainText("塗りつぶす閉領域をクリック");

  // 閉じた領域を解決できない場所 (両軸が交わる原点) をクリックしたら理由が出る。
  // WI-1 で null を返すケースが増えたが、従来は完全に無反応だった。
  const axes = page.locator(".overlay-shape.selected .graph2d-axes line");
  const horizontalAxis = await axes.nth(0).boundingBox();
  const verticalAxis = await axes.nth(1).boundingBox();
  expect(horizontalAxis).not.toBeNull();
  expect(verticalAxis).not.toBeNull();
  await page.mouse.click(
    verticalAxis!.x + verticalAxis!.width / 2,
    horizontalAxis!.y + horizontalAxis!.height / 2,
  );
  await expect(page.getByTestId("overlay-graph-mode-status")).toContainText("この領域は閉じていません");
  await expect(page.locator('[data-testid="graph2d-fill-region"]')).toHaveCount(0);
  await expect(panel).toBeVisible();

  await page.getByTestId("overlay-graph-crop-button").click();
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
  await expect(panel).toBeVisible();

  // Escape の行き先はフォーカスの位置で決まる (キャンバス側のハンドラは
  // 発生元がパネル内なら通さない)。開いた直後はパネルにフォーカスがあるので閉じる。
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  // キャンバスへフォーカスが移れば、同じ Escape がトリミングを解除する。
  await page.locator(".graph2d-container.cropping").first().click({ position: { x: 6, y: 6 } });
  await page.keyboard.press("Escape");
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);

  await openGraphSettingsFromContextMenu(page, graph);
  await expect(panel).toBeVisible();
  await page.setViewportSize({ width: 760, height: 720 });
  await expect.poll(() => panel.evaluate((element) => [...element.querySelectorAll<HTMLElement>("[data-graph-card-grid]")].every((grid) => grid.scrollWidth <= grid.clientWidth + 1))).toBe(true);
  await expectGraphSettingsPanelClearOfGraph(page, graph);
  await page.screenshot({ path: "test-results/graph-grid-narrow.png" });
});

test("runs editor shortcuts while the settings panel is open", async ({ page }) => {
  // モーダルだった頃は `graphSettingsShapeId !== null` が全ショートカットを封じていた。
  // 履歴の深さで Undo の対象が変わらないよう、最小の手順だけを踏む。
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const insertBox = await graph.boundingBox();
  expect(insertBox).not.toBeNull();
  await page.mouse.click(insertBox!.x + insertBox!.width * 0.42, insertBox!.y + insertBox!.height * 0.48);

  await openGraphSettingsFromContextMenu(page, graph);

  // backdrop が無くなったので、パネル内にフォーカスがあるまま Delete / 矢印キーが
  // キャンバスへ届いて図形を消す・動かすことがあってはならない。
  const beforeKeys = await graph.boundingBox();
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".graph-shape")).toHaveCount(1);
  const afterKeys = await graph.boundingBox();
  expect(afterKeys!.x).toBeCloseTo(beforeKeys!.x, 0);

  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(1);

  await page.keyboard.press(process.platform === "darwin" ? "Meta+z" : "Control+z");
  // Undo がエディタへ届いた証拠。戻るのは直前の「関数を追加」だけで、図形もパネルもそのまま残る
  // (デバウンス中の図形編集は Undo の前に確定させるので、挿入まで巻き戻ることはない)。
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(0);
  await expect(page.locator(".graph-shape")).toHaveCount(1);
  await expect(panel(page)).toBeVisible();
});

function panel(page: import("@playwright/test").Page) {
  return page.getByRole("dialog", { name: "グラフの設定" });
}

test("moves the settings panel by its header and closes it with Escape", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const insertBox = await graph.boundingBox();
  expect(insertBox).not.toBeNull();
  await page.mouse.click(insertBox!.x + insertBox!.width * 0.42, insertBox!.y + insertBox!.height * 0.48);

  await openGraphSettingsFromContextMenu(page, graph);
  const panel = page.getByRole("dialog", { name: "グラフの設定" });
  const before = await panel.boundingBox();
  expect(before).not.toBeNull();

  await page.mouse.move(before!.x + 40, before!.y + 14);
  await page.mouse.down();
  await page.mouse.move(before!.x + 40 - 120, before!.y + 14 + 40, { steps: 6 });
  await page.mouse.up();

  const after = await panel.boundingBox();
  expect(after).not.toBeNull();
  expect(Math.round(after!.x)).toBeLessThan(Math.round(before!.x));
  expect(after!.x).toBeGreaterThanOrEqual(0);
  expect(after!.y + after!.height).toBeLessThanOrEqual(page.viewportSize()!.height);

  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("edits a curve from its detail-card hover menu without showing actions on the graph", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const insertBox = await graph.boundingBox();
  expect(insertBox).not.toBeNull();
  await page.mouse.click(insertBox!.x + insertBox!.width * 0.42, insertBox!.y + insertBox!.height * 0.48);
  await page.locator(".overlay-shape.overlay-shape-graph2dShape").first().hover();
  await expect(page.getByRole("button", { name: "グラフ操作" })).toHaveCount(0);

  await openGraphSettingsFromContextMenu(page, graph);
  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(1);
  const curveCard = page.locator('.graph-curve-editor:has([data-testid="overlay-graph-expr-input"])').first();
  const actionButton = curveCard.getByRole("button", { name: "関数 1 の操作" });
  await page.mouse.move(0, 0);
  await expect(actionButton).toHaveCSS("opacity", "0");
  await curveCard.hover();
  await expect(actionButton).toHaveCSS("opacity", "1");
  await actionButton.hover();
  const curveActionsMenu = page.getByRole("dialog", { name: "関数 1 の操作" });
  await expect(curveActionsMenu).toBeVisible();
  // hover で開いた直後のクリックで閉じない。閉じると「乗せて押す」が空振りし、
  // 2 回目のクリックでしか操作できない。
  await actionButton.click();
  await expect(curveActionsMenu).toBeVisible();
  const actionButtonBox = await actionButton.boundingBox();
  const actionsMenuBox = await curveActionsMenu.boundingBox();
  expect(actionButtonBox).not.toBeNull();
  expect(actionsMenuBox).not.toBeNull();
  expect(
    actionsMenuBox!.x >= actionButtonBox!.x + actionButtonBox!.width
      || actionsMenuBox!.x + actionsMenuBox!.width <= actionButtonBox!.x,
  ).toBe(true);
  await chooseGraphMenuOption(page, "overlay-graph-stroke-width-select", "太");
  await expect(page.locator('[data-testid="graph2d-curve"]').first()).toHaveAttribute("stroke-width", "3.4");

  // 式ラベルはグラフが所有する兄弟 text 図形。曲線と一緒に消えないと所有者不明の図形が残る。
  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  await page.getByRole("button", { name: "グラフ上の式を表示" }).click();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(1);

  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  const graphBeforeDelete = await page.locator(".overlay-shape.selected").first().boundingBox();
  expect(graphBeforeDelete).not.toBeNull();
  await page.getByRole("button", { name: "関数 1 を削除" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(0);
  await expect(page.locator(".overlay-text-shape")).toHaveCount(0);
  await expect(page.getByText("関数", { exact: true }).first()).toBeVisible();

  // 削除項目は自分のアンカーごと消える。フォーカスが body へ落ちると、その後の
  // Delete / 矢印キーがキャンバスへ届いて選択中のグラフごと消える・動く。
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".graph-shape")).toHaveCount(1);
  const graphAfterDelete = await page.locator(".overlay-shape.selected").first().boundingBox();
  expect(graphAfterDelete!.x).toBeCloseTo(graphBeforeDelete!.x, 0);

  // パネル内の操作中は開いたまま、空白へ選択が移った時に閉じる。
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
  await page.locator(".overlay-canvas-editor").first().click({ position: { x: 8, y: 8 } });
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toHaveCount(0);
});

test("does not let the card action popovers leak keyboard input to the canvas", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  await expect(graph).toBeVisible();
  const insertBox = await graph.boundingBox();
  expect(insertBox).not.toBeNull();
  await page.mouse.click(insertBox!.x + insertBox!.width * 0.42, insertBox!.y + insertBox!.height * 0.48);
  await openGraphSettingsFromContextMenu(page, graph);
  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(1);

  const curveActions = page.getByRole("dialog", { name: "関数 1 の操作" });
  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  // 色・線種・太さの子ポップオーバーは body 直下へ portal される。DOM 上はパネルの
  // 外側なので、パネルの属性だけを見ると、ここでの Delete がキャンバスへ届いて
  // 選択中のグラフごと消える。線スタイル編集の唯一の経路がここになった。
  await page.getByTestId("overlay-graph-color-select").click();
  await expect(page.locator(".color-popover")).toBeVisible();
  const beforeKeys = await page.locator(".overlay-shape.selected").first().boundingBox();
  await page.keyboard.press("Delete");
  await page.keyboard.press("ArrowRight");
  await expect(page.locator(".graph-shape")).toHaveCount(1);
  const afterKeys = await page.locator(".overlay-shape.selected").first().boundingBox();
  expect(afterKeys!.x).toBeCloseTo(beforeKeys!.x, 0);

  // Escape は内側から順に畳む。パネルは残る。
  await page.keyboard.press("Escape");
  await expect(page.locator(".color-popover")).toHaveCount(0);
  await expect(curveActions).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(curveActions).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();

  // hover で開いた `⋯` はフォーカスを奪わない。それでも Escape で閉じるのは
  // `⋯` だけで、パネルごと畳まれてはいけない。
  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(2);
  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  await page.keyboard.press("Escape");
  await expect(curveActions).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
});

test("inserts movable graph shapes, edits one, and prints them", async ({ page }) => {
  test.slow();
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 20_000 });

  await expect(page.getByTestId("overlay-graph2d")).toHaveCount(0);

  await chooseInsert(page, "グラフ");

  const overlayGraphs = page.locator(".graph-shape");
  await expect(overlayGraphs).toHaveCount(1);
  await expect(page.getByTestId("overlay-graph-expr-input")).toHaveCount(0);
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toHaveCount(0);
  await expect(page.locator('[aria-label="詳細"]')).toHaveCount(0);
  await expect(page.locator(".graph2d-ticks")).toHaveCount(0);
  await expect(page.locator(".graph2d-grid")).toHaveCount(0);
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(0);
  await expect(page.locator(".overlay-shape-dimension-label")).toHaveCount(0);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(0);
  await expect(page.locator(".overlay-anchor-handle")).toHaveCount(0);
  await expect(overlayGraphs.first()).toHaveCSS("outline-style", "none");
  await expect(page.locator(".overlay-text-shape")).toHaveCount(0);
  await expect(page.locator(".graph-shape .graph2d-axis-label-tex")).toHaveCount(0);

  const originBox = await overlayGraphs.first().boundingBox();
  expect(originBox).not.toBeNull();
  const originPickX = originBox!.x + originBox!.width * 0.28;
  const originPickY = originBox!.y + originBox!.height * 0.35;
  await page.mouse.move(originPickX, originPickY);
  const originPreview = page.getByTestId("overlay-graph-origin-preview");
  await expect(originPreview).toBeVisible();
  await expect(page.getByTestId("overlay-graph-origin-preview-target")).toBeVisible();
  await expect(page.locator(".graph-origin-preview-graph .graph2d-axes line")).toHaveCount(2);
  await expect(page.locator(".graph-origin-preview-graph [data-testid='graph2d-curve']")).toHaveCount(0);
  await page.mouse.click(originPickX, originPickY);
  await expect(originPreview).toHaveCount(0);
  await openGraphSettingsFromContextMenu(page, overlayGraphs.first());
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();
  await expect(page.getByRole("button", { name: "関数を追加" })).toBeVisible();
  await expandGraphDisclosure(page, "表示範囲");
  await expect(page.getByLabel("目盛", { exact: true })).not.toBeChecked();
  await expect(page.getByLabel("グリッド", { exact: true })).not.toBeChecked();
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(2);
  await expectPlotSelectionToMatch(page);

  const originButton = page.getByRole("button", { name: "原点をクリックで指定" });
  await originButton.click();
  // 非モーダルパネルはモード開始で閉じない。押下状態と次の操作案内をその場で見せる。
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
  await expect(originButton).toHaveAttribute("aria-pressed", "true");
  await expect(overlayGraphs.first()).toHaveCSS("outline-style", "none");
  await expect(page.getByTestId("overlay-graph-mode-status")).toContainText("グラフ上をクリックして原点を指定");
  await expectGraphSettingsPanelClearOfGraph(page, overlayGraphs.first());
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(2);
  await page.mouse.move(originPickX + 24, originPickY + 18);
  await expect(page.locator(".graph-origin-preview-graph .graph2d-axes line")).toHaveCount(2);
  await page.mouse.click(originPickX + 24, originPickY + 18);
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
  await expect(originButton).toHaveAttribute("aria-pressed", "false");
  await closeGraphSettingsPanel(page);

  const beforeDrag = await overlayGraphs.first().boundingBox();
  expect(beforeDrag).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.up("Shift");
  await expect
    .poll(async () => {
      const afterMove = await overlayGraphs.first().boundingBox();
      return afterMove?.x ?? beforeDrag!.x;
    })
    .toBeGreaterThan(beforeDrag!.x + 20);

  await openGraphSettingsFromContextMenu(page, overlayGraphs.first());
  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.getByTestId("overlay-graph-expr-input")).toBeVisible();
  await setMathFieldValue(page, "overlay-graph-expr-input", "\\cos(x)");
  expect(await readMathFieldValue(page, "overlay-graph-expr-input")).toContain("\\cos");
  await expect(page.locator('[data-testid="graph2d-curve"]').last()).toBeVisible();

  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  const firstCurveLabelShowToggle = page.getByRole("button", { name: "グラフ上の式を表示" });
  await expect(firstCurveLabelShowToggle).toBeVisible();
  await firstCurveLabelShowToggle.click();
  await expect(page.getByRole("button", { name: "グラフ上の式を隠す" })).toBeVisible();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(1);
  await page.getByRole("button", { name: "グラフ上の式を隠す" }).click();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(0);

  await expandGraphDisclosure(page, "軸名");
  await page.getByTestId("overlay-graph-axis-label-x").check();
  await page.getByTestId("overlay-graph-axis-label-y").check();
  await page.getByTestId("overlay-graph-axis-label-origin").check();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(3);
  await expect(page.locator(".graph-shape .graph2d-axis-label-tex")).toHaveCount(0);
  await page.getByTestId("overlay-graph-axis-label-y").uncheck();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(2);
  await expect(page.locator(".graph-shape .graph2d-axis-label-tex")).toHaveCount(0);
  await expect(page.getByTestId("overlay-graph-axis-label-y")).not.toBeChecked();
  await page.getByTestId("overlay-graph-axis-label-y").check();
  await expect(page.locator(".overlay-text-shape")).toHaveCount(3);
  const xAxisLabelShape = page.locator(".overlay-shape-text").first();
  const xAxisLabelText = xAxisLabelShape.locator(".overlay-text-shape");
  const staticAxisLabelFontSize = await xAxisLabelText.evaluate((element) => getComputedStyle(element).fontSize);
  expect(Number.parseFloat(staticAxisLabelFontSize)).toBeCloseTo(10 * (96 / 72), 1);
  const xAxisLabelBox = await xAxisLabelShape.boundingBox();
  expect(xAxisLabelBox).not.toBeNull();
  await closeGraphSettingsPanel(page);
  await page.mouse.dblclick(xAxisLabelBox!.x + xAxisLabelBox!.width / 2, xAxisLabelBox!.y + xAxisLabelBox!.height / 2);
  const xAxisLabelEditor = xAxisLabelShape.locator(".overlay-text-shape-content");
  await expect(xAxisLabelEditor).toBeFocused();
  await expect(page.getByLabel("フォントサイズ")).toContainText("10pt");
  await expect.poll(async () => xAxisLabelText.evaluate((element) => getComputedStyle(element).fontSize)).toBe(staticAxisLabelFontSize);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("u");
  await expect(xAxisLabelEditor).toContainText("u");
  await openGraphSettingsFromContextMenu(page, overlayGraphs.first());
  await expandGraphDisclosure(page, "軸名");
  await expect(page.getByTestId("overlay-graph-axis-label-text-x")).toBeVisible();
  expect(await readMathFieldValue(page, "overlay-graph-axis-label-text-x")).toContain("u");

  await page.getByTestId("overlay-graph-crop-button").click();
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
  await expect(page.locator(".overlay-resize-handle")).toHaveCount(0);
  const cropExitBox = await overlayGraphs.first().boundingBox();
  expect(cropExitBox).not.toBeNull();
  await page.mouse.click(cropExitBox!.x + 4, cropExitBox!.y + 4);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);

  await openGraphSettingsFromContextMenu(page, overlayGraphs.first());
  await expandGraphDisclosure(page, "表示範囲");
  await expandGraphDisclosure(page, "関数 1 の詳細設定");
  await page.getByLabel("軸範囲と同じ").click();
  await setGraphRangeValue(page, "overlay-graph-display-x-range", "-1", "3");
  await setGraphRangeValue(page, "overlay-graph-display-y-range", "-1", "4");
  expect(await readGraphRangeValue(page, "overlay-graph-display-x-range")).toContain("-1");
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(2);
  await setGraphRangeValue(page, "overlay-graph-display-y-range", "1", "4");
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(1);
  await expect(page.locator(".overlay-text-shape")).toHaveCount(1);
  await setGraphRangeValue(page, "overlay-graph-display-y-range", "-1", "4");
  await expect(page.locator(".overlay-shape.selected .graph2d-axes line")).toHaveCount(2);
  await expect(page.locator(".overlay-text-shape")).toHaveCount(3);

  const firstCurveEditor = page.locator('.graph-curve-editor:has([data-testid="overlay-graph-expr-input"])').first();
  await firstCurveEditor.getByTestId("overlay-graph-mode-select").click();
  await page.getByRole("button", { name: "x=f(y)", exact: true }).click();
  await setMathFieldValue(page, "overlay-graph-expr-input", "y^{2}");
  await setGraphRangeValue(page, "overlay-graph-domain-input", "0", "2");
  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  await chooseGraphMenuOption(page, "overlay-graph-dash-select", "点線");
  await chooseGraphMenuOption(page, "overlay-graph-stroke-width-select", "太");
  expect(await readMathFieldValue(page, "overlay-graph-expr-input")).toContain("y^");
  expect(await readGraphRangeValue(page, "overlay-graph-domain-input")).toContain("2");
  await expect(page.locator('[data-testid="graph2d-curve"]').first()).toHaveAttribute("stroke-dasharray", /0 /);
  await expect(page.locator('[data-testid="graph2d-curve"]').first()).toHaveAttribute("stroke-width", "3.4");

  await page.getByRole("button", { name: "関数を追加" }).click();
  await expect(page.locator('[data-testid="graph2d-curve"]')).toHaveCount(2);
  await openGraphItemActions(page, "overlay-graph-curve-actions", "関数 1 の操作");
  await chooseGraphPaletteColor(page, "overlay-graph-color-select", "#dc2626");
  await expect(page.locator('[data-testid="graph2d-curve"]').first()).toHaveAttribute("stroke", "#dc2626");

  await page.getByTestId("overlay-graph-tick-font-size").fill("10.5");
  await page.getByLabel("目盛", { exact: true }).click();
  await expect(page.locator(".graph2d-ticks")).toHaveCount(1);
  await expect.poll(async () => page.locator(".graph2d-tex-label > div").first().evaluate((element) => (
    Number.parseFloat(getComputedStyle(element).fontSize)
  ))).toBeCloseTo(10.5 * (96 / 72), 1);
  await page.getByLabel("目盛", { exact: true }).click();
  await expect(page.locator(".graph2d-ticks")).toHaveCount(0);
  await setMathFieldValue(page, "overlay-graph-x-tick-step", "\\pi");
  await setMathFieldValue(page, "overlay-graph-y-tick-step", "1");
  expect(await readMathFieldValue(page, "overlay-graph-x-tick-step")).toContain("\\pi");
  expect(await readMathFieldValue(page, "overlay-graph-y-tick-step")).toContain("1");

  await page.getByRole("checkbox", { name: "x軸" }).click();
  await page.getByRole("checkbox", { name: "y軸" }).click();
  await expect(page.locator(".graph2d-axes line")).toHaveCount(0);
  await closeGraphSettingsPanel(page);

  await chooseInsert(page, "グラフ");
  await expect(overlayGraphs).toHaveCount(2);
  await overlayGraphs.nth(1).scrollIntoViewIfNeeded();
  const secondOriginBox = await overlayGraphs.nth(1).boundingBox();
  expect(secondOriginBox).not.toBeNull();
  const secondOriginPickX = secondOriginBox!.x + secondOriginBox!.width * 0.42;
  const secondOriginPickY = secondOriginBox!.y + secondOriginBox!.height * 0.48;
  await page.mouse.move(secondOriginPickX, secondOriginPickY);
  await expect(page.getByTestId("overlay-graph-origin-preview")).toBeVisible();
  await page.mouse.click(secondOriginPickX, secondOriginPickY);
  await openGraphSettingsFromContextMenu(page, overlayGraphs.nth(1));
  await expect(page.getByRole("button", { name: "原点をクリックで指定" })).toBeVisible();
  await page.getByRole("button", { name: "関数を追加" }).click();
  await closeGraphSettingsPanel(page);
  await rotateSelectedGraph(page, overlayGraphs.nth(1));
  const secondGraphContextPoint = await graphLocalPointToScreen(page, overlayGraphs.nth(1), 0.64, 0.34);
  await page.mouse.click(secondGraphContextPoint.x, secondGraphContextPoint.y, { button: "right" });
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "閉領域を塗りつぶす" }).click();
  await doubleClickSecondGraphPositiveSineRegion(page, overlayGraphs);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);
  await clickSecondGraphPositiveSineRegion(page, overlayGraphs);
  await expect(page.locator('[data-testid="graph2d-fill-region"]')).toHaveCount(1);
  await clickSecondGraphPositiveSineRegion(page, overlayGraphs);
  await expect(page.locator('[data-testid="graph2d-fill-region"]')).toHaveCount(0);
  await clickSecondGraphPositiveSineRegion(page, overlayGraphs);
  await expect(page.locator('[data-testid="graph2d-fill-region"]')).toHaveCount(1);
  await page.keyboard.press("Escape");
  await openGraphSettingsFromContextMenu(page, overlayGraphs.nth(1));
  await openGraphItemActions(page, "overlay-graph-fill-actions", "塗り 1 の操作");
  await page.getByTestId("overlay-graph-fill-pattern-select").click();
  await page.getByRole("menu", { name: "塗り方" }).getByRole("menuitemradio", { name: "点々" }).click();
  await expect(page.locator('[data-testid="graph2d-fill-region"]').first()).toHaveAttribute("fill", /^url\(#graph2d-fill-pattern/);
  await closeGraphSettingsPanel(page);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => getSavedGraphCount(page)).toBe(2);
  await expect.poll(async () => (await getSavedGraphFills(page, 1)).length).toBe(1);
  await expect.poll(async () => (await getSavedGraphFills(page, 1))[0]?.pattern).toBe("dots");
  const savedDocument = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document"));
  expect(savedDocument).not.toBeNull();

  const previewPage = await page.context().newPage();
  await installDesktopRuntimeMock(previewPage, JSON.parse(savedDocument!) as SigmaDocument);
  await previewPage.goto(appUrl("/"));
  await expect(previewPage.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("グラフ e2e");

  const previewGraphs = previewPage.locator(".page-overlay-preview .graph2d-svg");
  await expect(previewGraphs).toHaveCount(2);
  await expect(previewPage.locator(".page-overlay-preview .graph2d-axis-label-tex")).toHaveCount(0);
  await expect(previewPage.locator(".page-overlay-preview [data-testid='graph2d-fill-region']")).toHaveCount(1);

  const previewGraph = previewPage.locator(".page-overlay-preview .graph-shape").first();
  const previewGraphBox = await previewGraph.boundingBox();
  expect(previewGraphBox).not.toBeNull();
  await previewGraph.click({ position: { x: 84, y: 132 } });
  await expect(previewPage.locator(".overlay-selection-box")).toHaveCount(1);
  await previewPage.mouse.click(
    previewGraphBox!.x + previewGraphBox!.width * 0.42,
    previewGraphBox!.y + previewGraphBox!.height * 0.48,
    { button: "right" },
  );
  await previewPage.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "表示領域をトリミング" }).click();
  await expect(previewPage.locator(".graph2d-container.cropping")).toHaveCount(1);

  // PDFプレビューは ファイル → エクスポート → PDFを書き出し で開く。
  await previewPage.getByRole("button", { name: "ファイル", exact: true }).click();
  await previewPage.getByRole("menuitem", { name: "エクスポート" }).hover();
  await previewPage.getByRole("menuitem", { name: "PDFを書き出し" }).click();
  await expect(previewPage.getByRole("dialog", { name: "PDFプレビュー" })).toBeVisible();
  expect(await previewPage.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-export-pdf-calls"))).toBeNull();
  await expect(previewPage.locator(".paged-surface-page .graph2d-svg")).toHaveCount(2);
  await expect(previewPage.locator(".paged-surface-page [data-testid='graph2d-fill-region']")).toHaveCount(1);
});

test("crops graph shapes down to the displayed graph range", async ({ page }) => {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await chooseInsert(page, "グラフ");
  const graph = page.locator(".graph-shape").first();
  const initialBox = await graph.boundingBox();
  expect(initialBox).not.toBeNull();
  await page.mouse.click(
    initialBox!.x + initialBox!.width * 0.5,
    initialBox!.y + initialBox!.height * 0.5,
  );
  await openGraphSettingsFromContextMenu(page, graph);
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  await expect.poll(async () => getSavedFirstGraph(page)).not.toBeNull();
  const axisViewBoxBeforeCrop = (await getSavedFirstGraph(page))?.props.spec.viewBox;
  expect(axisViewBoxBeforeCrop).toBeDefined();
  const beforeBox = await graph.boundingBox();
  expect(beforeBox).not.toBeNull();

  await expandGraphDisclosure(page, "表示範囲");
  await page.getByLabel("軸範囲と同じ").click();
  await setGraphRangeValue(page, "overlay-graph-display-x-range", "-4", "4");
  await setGraphRangeValue(page, "overlay-graph-display-y-range", "-2", "2");
  // Each MathLive commit updates the selected graph through React and then
  // persists it asynchronously. Wait for the complete requested range before
  // cropping so the crop click cannot observe the previous aspect-adjusted
  // yMax while the final input is still being committed.
  await expect.poll(async () => {
    const viewBox = (await getSavedFirstGraph(page))?.props.spec.graphViewBox;
    return viewBox
      ? [viewBox.xMin, viewBox.xMax, viewBox.yMin, viewBox.yMax].map(Number)
      : null;
  }).toEqual([-4, 4, -2, 2]);

  await page.getByTestId("overlay-graph-crop-button").click();
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(1);
  await page.mouse.click(beforeBox!.x + 4, beforeBox!.y + 4);
  await expect(page.locator(".graph2d-container.cropping")).toHaveCount(0);

  await expect
    .poll(async () => {
      const afterBox = await graph.boundingBox();
      return afterBox?.width ?? beforeBox!.width;
    })
    .toBeLessThan(beforeBox!.width - 20);

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  // 途中の自動保存とレースしないよう、クロップ後の幅が保存されるまで待つ。
  await expect
    .poll(async () => {
      const graph = await getSavedFirstGraph(page);
      return graph?.props?.w ?? Number.MAX_SAFE_INTEGER;
    })
    .toBeLessThan(beforeBox!.width - 20);
  await expect
    .poll(async () => Number((await getSavedFirstGraph(page))?.props.spec.graphViewBox?.xMin))
    .toBeCloseTo(-4);
  const savedGraph = await getSavedFirstGraph(page);
  expect(savedGraph).not.toBeNull();
  expect(savedGraph!.props.w).toBeLessThan(beforeBox!.width);
  expect(savedGraph!.props.h).toBeLessThan(beforeBox!.height);
  // 表示領域のトリミングは軸範囲そのものを変更しない。
  expect(savedGraph!.props.spec.viewBox).toEqual(axisViewBoxBeforeCrop);
  expect(Number(savedGraph!.props.spec.graphViewBox?.xMin)).toBeCloseTo(-4);
  expect(Number(savedGraph!.props.spec.graphViewBox?.xMax)).toBeCloseTo(4);
  expect(Number(savedGraph!.props.spec.graphViewBox?.yMin)).toBeCloseTo(-2);
  expect(Number(savedGraph!.props.spec.graphViewBox?.yMax)).toBeCloseTo(2);
});

async function chooseInsert(page: import("@playwright/test").Page, label: string) {
  await expect(page.locator(".tiptap.ProseMirror").first()).toBeVisible();
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  const insertMenu = page.getByRole("menu", { name: "挿入", exact: true });
  await expect(insertMenu).toBeVisible();
  // メニュ項目のaccessible nameには右端のショートカット表示も含まれる。
  await insertMenu.getByRole("menuitem", { name: label }).click();
  if (label !== "グラフ") {
    return;
  }

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const graphIndex = await page.locator(".graph-shape").count();
  const startX = surfaceBox!.x + 120 + graphIndex * 36;
  const startY = surfaceBox!.y + 120 + graphIndex * 220;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 300, startY + 170, { steps: 8 });
  await expect(page.locator(".overlay-insert-preview-shape .graph2d-axes line")).toHaveCount(0);
  await page.mouse.up();
}

async function closeGraphSettingsPanel(page: import("@playwright/test").Page) {
  const panel = page.getByRole("dialog", { name: "グラフの設定" });
  await panel.getByRole("button", { name: "閉じる" }).click();
  await expect(panel).toHaveCount(0);
}

async function openGraphItemActions(
  page: import("@playwright/test").Page,
  testId: string,
  menuLabel: string,
) {
  // `⋯` は hover で開く。中身は色・線種・濃さのフォーム部品なので role は dialog。
  const menu = page.getByRole("dialog", { name: menuLabel });
  if (await menu.count() === 0) {
    const trigger = page.getByTestId(testId);
    await page.locator(`.graph-curve-editor:has([data-testid="${testId}"])`).hover();
    await trigger.hover();
  }
  await expect(menu).toBeVisible();
}

/** パネルがグラフを覆っていないこと。これが WI-2 の中心要件。 */
async function expectGraphSettingsPanelClearOfGraph(
  page: import("@playwright/test").Page,
  graph: import("@playwright/test").Locator,
) {
  const panelBox = await page.getByRole("dialog", { name: "グラフの設定" }).boundingBox();
  const graphBox = await graph.boundingBox();
  expect(panelBox).not.toBeNull();
  expect(graphBox).not.toBeNull();
  expect(panelBox!.width).toBeLessThanOrEqual(620);
  const intersects =
    panelBox!.x < graphBox!.x + graphBox!.width &&
    graphBox!.x < panelBox!.x + panelBox!.width &&
    panelBox!.y < graphBox!.y + graphBox!.height &&
    graphBox!.y < panelBox!.y + panelBox!.height;
  expect(intersects).toBe(false);
}

async function openGraphSettingsFromContextMenu(
  page: import("@playwright/test").Page,
  graph: import("@playwright/test").Locator,
) {
  const box = await graph.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.click(
    box!.x + box!.width * 0.42,
    box!.y + box!.height * 0.48,
    { button: "right" },
  );
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "グラフの設定…" }).click();
  await expect(page.getByRole("dialog", { name: "グラフの設定" })).toBeVisible();
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}

// 線種・線幅メニュー (ツールバーと同じ ToolbarPopover ベース)。トリガーは
// testid 付きのラッパー内、メニュー本体は body 直下へポータルされる。
async function chooseGraphMenuOption(
  page: import("@playwright/test").Page,
  testId: string,
  optionName: string,
) {
  await page.getByTestId(testId).locator("button").first().click();
  await page.getByRole("menuitemradio", { name: optionName, exact: true }).click();
}

// 色はツールバー共通の ColorPalette ポップオーバーから選ぶ。スウォッチは
// title 属性 (#rrggbb) がアクセシブルネームになる。
async function chooseGraphPaletteColor(
  page: import("@playwright/test").Page,
  testId: string,
  color: string,
) {
  await page.getByTestId(testId).click();
  await page.locator(`.color-popover [role="option"][title="${color}"]`).first().click();
}

// MathExpressionInput: 非編集時は静的プレビューのボタン、クリックで
// <math-field> (testid: `${testId}-field`) に切り替わる。カスタム要素の
// upgrade 前に .value を触るとアクセサが壊れるため、定義完了を待つ。
async function openMathField(
  page: import("@playwright/test").Page,
  testId: string,
) {
  await page.getByTestId(testId).click();
  const field = page.getByTestId(`${testId}-field`);
  await expect(field).toBeVisible();
  await field.evaluate(async () => {
    await customElements.whenDefined("math-field");
  });
  await expect
    .poll(() => field.evaluate((element) => (element as HTMLElement & { value?: string }).value !== undefined))
    .toBe(true);
  return field;
}

async function setMathFieldValue(
  page: import("@playwright/test").Page,
  testId: string,
  tex: string,
) {
  const field = await openMathField(page, testId);
  await field.evaluate((element, value) => {
    const mathField = element as HTMLElement & { value: string };
    mathField.value = value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }, tex);
  await field.press("Enter");
  await expect(page.getByTestId(`${testId}-field`)).toHaveCount(0);
}

async function setGraphRangeValue(
  page: import("@playwright/test").Page,
  testId: string,
  minTex: string,
  maxTex: string,
) {
  await setMathFieldValue(page, `${testId}-min`, minTex);
  await setMathFieldValue(page, `${testId}-max`, maxTex);
}

async function readMathFieldValue(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<string> {
  const field = await openMathField(page, testId);
  const value = await field.evaluate((element) => (element as HTMLElement & { value: string }).value);
  await field.press("Escape");
  await expect(page.getByTestId(`${testId}-field`)).toHaveCount(0);
  return value;
}

async function readGraphRangeValue(
  page: import("@playwright/test").Page,
  testId: string,
): Promise<string> {
  const min = await readMathFieldValue(page, `${testId}-min`);
  const max = await readMathFieldValue(page, `${testId}-max`);
  return `${min}..${max}`;
}

type SavedGraphShape = {
  props: {
    w: number;
    h: number;
    spec: {
      width: number;
      height: number;
      parameters?: Array<{ value: number; name: string; animation?: { playOnPage?: boolean } }>;
      viewBox: { xMin: string; xMax: string; yMin: string; yMax: string };
      graphViewBox?: { xMin: string; xMax: string; yMin: string; yMax: string };
      points?: Array<{ x?: string; y?: string; xTex?: string; yTex?: string }>;
      fills?: Array<{ pattern?: string }>;
    };
  };
};

async function getSavedFirstGraph(page: import("@playwright/test").Page): Promise<SavedGraphShape | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const document = JSON.parse(raw);
    const currentShapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const overlays = Object.values(document.pageLayout?.overlays ?? {}) as Array<{
      overlaySnapshot?: { shapes?: Array<{ type?: string }> };
    }>;
    const shapes = [...currentShapes, ...overlays.flatMap((overlay) => overlay.overlaySnapshot?.shapes ?? [])];
    return shapes.find((shape: { type?: string }) => shape.type === "graph2dShape") ?? null;
  }) as Promise<SavedGraphShape | null>;
}

async function getSavedFirstGraphPoint(page: import("@playwright/test").Page) {
  const graph = await getSavedFirstGraph(page);
  return graph?.props.spec.points?.[0] ?? null;
}

async function getSavedGraphFills(page: import("@playwright/test").Page, index: number) {
  return page.evaluate((graphIndex) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return [];
    const document = JSON.parse(raw);
    const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const graphs = shapes.filter((shape: { type?: string }) => shape.type === "graph2dShape");
    return graphs[graphIndex]?.props?.spec?.fills ?? [];
  }, index) as Promise<Array<{ pattern?: string }>>;
}

// The graph inspector groups settings behind accordion sections ("座標軸・表示範囲")
// and per-card "詳細" disclosures. Expand the matching trigger before interacting
// with controls that live inside them. Idempotent: only clicks when collapsed.
async function expandGraphDisclosure(page: import("@playwright/test").Page, name: string) {
  const trigger = page.getByRole("button", { name, exact: true });
  await expect(trigger).toBeVisible();
  if ((await trigger.getAttribute("aria-expanded")) !== "true") {
    await trigger.click();
  }
  await expect(trigger).toHaveAttribute("aria-expanded", "true");
}

async function clickSecondGraphPositiveSineRegion(
  page: import("@playwright/test").Page,
  overlayGraphs: import("@playwright/test").Locator,
) {
  const point = await graphLocalPointToScreen(page, overlayGraphs.nth(1), 0.64, 0.34);
  await page.mouse.click(point.x, point.y);
}

async function doubleClickSecondGraphPositiveSineRegion(
  page: import("@playwright/test").Page,
  overlayGraphs: import("@playwright/test").Locator,
) {
  const point = await graphLocalPointToScreen(page, overlayGraphs.nth(1), 0.64, 0.34);
  await page.mouse.dblclick(point.x, point.y);
}

async function rotateSelectedGraph(page: import("@playwright/test").Page, shape: import("@playwright/test").Locator) {
  const handle = page.locator(".overlay-rotate-handle").first();
  await expect(handle).toBeVisible();
  const handleBox = await handle.boundingBox();
  const shapeBox = await shape.boundingBox();
  expect(handleBox).not.toBeNull();
  expect(shapeBox).not.toBeNull();

  const centerX = shapeBox!.x + shapeBox!.width / 2;
  const centerY = shapeBox!.y + shapeBox!.height / 2;
  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(centerX + shapeBox!.width / 2 + 40, centerY, { steps: 8 });
  await page.mouse.up();
}

async function graphLocalPointToScreen(
  page: import("@playwright/test").Page,
  graph: import("@playwright/test").Locator,
  ratioX: number,
  ratioY: number,
) {
  return graph.evaluate((element, ratios) => {
    const graphElement = element as HTMLElement;
    const parent = graphElement.offsetParent as HTMLElement | null;
    if (!parent) {
      throw new Error("Could not find graph offset parent");
    }

    const parentRect = parent.getBoundingClientRect();
    const scaleX = parentRect.width / parent.offsetWidth;
    const scaleY = parentRect.height / parent.offsetHeight;
    const width = graphElement.offsetWidth * scaleX;
    const height = graphElement.offsetHeight * scaleY;
    const centerX = parentRect.left + (graphElement.offsetLeft * scaleX) + width / 2;
    const centerY = parentRect.top + (graphElement.offsetTop * scaleY) + height / 2;
    const transform = getComputedStyle(graphElement).transform;
    const matrix = transform === "none" ? null : new DOMMatrixReadOnly(transform);
    const rotation = matrix ? Math.atan2(matrix.b, matrix.a) : 0;
    const localX = (ratios.ratioX - 0.5) * width;
    const localY = (ratios.ratioY - 0.5) * height;
    const cos = Math.cos(rotation);
    const sin = Math.sin(rotation);

    return {
      x: centerX + localX * cos - localY * sin,
      y: centerY + localX * sin + localY * cos,
    };
  }, { ratioX, ratioY });
}

async function expectPlotSelectionToMatch(page: import("@playwright/test").Page) {
  const selectionBox = await page.locator(".overlay-selection-box").boundingBox();
  const plotBox = await page.locator(".graph2d-plot-bg").first().boundingBox();

  expect(selectionBox).not.toBeNull();
  expect(plotBox).not.toBeNull();
  expect(Math.abs(selectionBox!.x - plotBox!.x)).toBeLessThan(2);
  expect(Math.abs(selectionBox!.y - plotBox!.y)).toBeLessThan(2);
  expect(Math.abs(selectionBox!.width - plotBox!.width)).toBeLessThan(2);
  expect(Math.abs(selectionBox!.height - plotBox!.height)).toBeLessThan(2);
}

async function getSavedGraphCount(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return 0;
    const document = JSON.parse(raw);
    const currentShapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const overlays = Object.values(document.pageLayout?.overlays ?? {}) as Array<{
      overlaySnapshot?: { shapes?: Array<{ type?: string }> };
    }>;
    return [...currentShapes, ...overlays.flatMap((overlay) => overlay.overlaySnapshot?.shapes ?? [])]
      .filter((shape) => shape.type === "graph2dShape").length;
  });
}
