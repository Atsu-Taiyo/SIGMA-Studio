import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type { OverlayGeoShape, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = existsSync(path.join(APP_ROOT, "dist-electron/main.cjs"))
  && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));

function solids(document: SigmaDocument): OverlayGeoShape[] {
  return (document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
    .filter((shape): shape is OverlayGeoShape => shape.type === "geo" && ["pyramid", "prism", "sphere"].includes(shape.props.geo));
}

test("solids are inserted from the shape gallery, their vertices dragged and their edges restyled, and it all survives a restart", async ({}, testInfo) => {
  test.skip(!PREPARED, "Build Electron and supply SIGMA_STUDIO_E2E_BASE_URL, or prepare the static renderer.");
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-solid-shapes-"));
  let app: ElectronApplication | undefined;
  const errors: string[] = [];

  const launch = async (): Promise<Page> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    env.SIGMA_STUDIO_USER_DATA_DIR = path.join(profile, "sigma");
    if (DEV_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = DEV_URL;
    app = await electron.launch({
      args: [APP_ROOT, `--user-data-dir=${path.join(profile, "chromium")}`],
      cwd: APP_ROOT,
      env,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    // 起動直後の window は about:blank のことがあり、そのまま localStorage を触ると SecurityError になる。
    await page.waitForURL(/^(https?|file):/, { timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.setItem("sigma-studio:ui-locale", "ja"));
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    const onboarding = page.locator('[data-ui-layout-choice="docs"]');
    if (await onboarding.isVisible()) await onboarding.click();
    await expect(page.getByRole("button", { name: "図形", exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.desktopAPI?.isDesktop)).toBe(true);
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    return page;
  };

  const readSaved = async (page: Page): Promise<SigmaDocument> => {
    const file = await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles())[0]);
    if (!file?.documentPath) throw new Error("Desktop storage did not return a file path");
    const documentPath = path.resolve(profile, "sigma", "data", file.documentPath);
    expect(path.relative(realpathSync(profile), realpathSync(documentPath)).startsWith("..")).toBe(false);
    return JSON.parse(readFileSync(documentPath, "utf8")) as SigmaDocument;
  };

  const vertexHandles = (page: Page) => page.evaluate(() => (
    [...document.querySelectorAll(".overlay-solid-vertex-handle")].map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })
  ));
  const edgeDashes = (page: Page) => page.evaluate(() => (
    [...document.querySelectorAll(".overlay-shape svg path[data-solid-edge]")].map((element) => element.getAttribute("stroke-dasharray"))
  ));

  /** 図形ギャラリーから選んで、用紙の左上から (offset) の位置へドラッグで置く。編集面はツールを選ぶと現れる。 */
  const edgeWidths = (page: Page) => page.evaluate(() => (
    [...document.querySelectorAll(".overlay-shape svg path[data-solid-edge]")].map((element) => element.getAttribute("stroke-width"))
  ));

  const insertSolid = async (page: Page, name: string, offset: { x: number; y: number }, size: { w: number; h: number }) => {
    await page.getByRole("button", { name: "図形", exact: true }).first().click();
    await page.getByRole("menuitem", { name, exact: true }).click();
    const canvas = await page.locator(".overlay-canvas-editor").first().boundingBox();
    if (!canvas) throw new Error("Canvas is missing");
    const from = { x: canvas.x + offset.x, y: canvas.y + offset.y };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + size.w / 2, from.y + size.h / 2, { steps: 5 });
    await page.mouse.move(from.x + size.w, from.y + size.h, { steps: 5 });
    await page.mouse.up();
    return canvas;
  };

  try {
    let page = await launch();

    // ギャラリーには角錐・角柱・球が並び、どれも見えない辺を破線にしたアイコンを持つ。
    await page.getByRole("button", { name: "図形", exact: true }).first().click();
    for (const name of ["球", "三角錐", "四角錐", "十二角錐", "三角柱", "五角柱", "十二角柱"]) {
      await expect(page.getByRole("menuitem", { name, exact: true })).toBeVisible();
    }
    await testInfo.attach("gallery", { body: await page.screenshot({ path: testInfo.outputPath("gallery.png") }), contentType: "image/png" });
    await page.keyboard.press("Escape");

    // 三角錐を挿入すると、見えない辺だけが破線で描かれ、頂点ごとにつまむハンドルが出る。
    const canvas = await insertSolid(page, "三角錐", { x: 120, y: 150 }, { w: 200, h: 260 });
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(4);
    const initialDashes = await edgeDashes(page);
    expect(initialDashes).toHaveLength(6);
    expect(initialDashes.filter((dash) => dash === "8 6")).toHaveLength(3);
    expect(initialDashes.filter((dash) => dash === "none")).toHaveLength(3);

    // 頂点 (頂点 = 4 つめ) をつまんで枠の外へ引き出す。ほかの頂点は動かない。
    let handles = await vertexHandles(page);
    const apex = handles[3];
    await page.mouse.move(apex.x, apex.y);
    await page.mouse.down();
    await page.mouse.move(apex.x + 100, apex.y - 60, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const moved = await vertexHandles(page);
    expect(Math.hypot(moved[3].x - (apex.x + 100), moved[3].y - (apex.y - 60))).toBeLessThan(4);
    for (const index of [0, 1, 2]) {
      expect(Math.hypot(moved[index].x - handles[index].x, moved[index].y - handles[index].y)).toBeLessThan(0.5);
    }
    handles = moved;

    // 立体を選んだまま、線をもう一度押すとその辺が選ばれ、線種はその辺だけに効く。
    await expect(page.locator("[data-solid-edge-highlight]")).toHaveCount(0);
    const hiddenMidpoint = { x: (handles[1].x + handles[2].x) / 2, y: (handles[1].y + handles[2].y) / 2 };
    await page.mouse.move(hiddenMidpoint.x, hiddenMidpoint.y);
    await expect(page.locator("[data-solid-edge-hover]")).toHaveCount(1);
    await page.mouse.click(hiddenMidpoint.x, hiddenMidpoint.y);
    await expect(page.locator("[data-solid-edge-highlight]")).toHaveCount(1);
    await expect(page.locator(".editor-menubar").locator('button[aria-label^="線種"]').first()).toHaveAttribute("aria-label", "線種（現在: 破線）");
    await page.locator(".editor-menubar").locator('button[aria-label^="線種"]').first().click();
    await page.getByRole("menuitemradio", { name: "点線" }).click();
    await expect.poll(() => edgeDashes(page)).toEqual(initialDashes.map((dash, index) => (index === 1 ? "1 6" : dash)));
    // 線の太さも、選んだ辺だけに効く (線幅ボタンにもその辺の値が出る)。
    const initialWidths = await edgeWidths(page);
    expect(new Set(initialWidths).size).toBe(1);
    const widthButton = page.locator(".editor-menubar").locator('button[aria-label^="線幅"]').first();
    await expect(widthButton).toHaveAttribute("aria-label", "線幅（現在: 中）");
    await widthButton.click();
    await page.getByRole("menuitemradio", { name: "極太" }).click();
    await expect.poll(() => edgeWidths(page)).toEqual(initialWidths.map((width, index) => (index === 1 ? "5" : width)));
    await expect(widthButton).toHaveAttribute("aria-label", "線幅（現在: 極太）");
    // 線種は変わらず、太さだけが変わる。
    expect(await edgeDashes(page)).toEqual(initialDashes.map((dash, index) => (index === 1 ? "1 6" : dash)));
    await testInfo.attach("edge-restyled", { body: await page.screenshot({ path: testInfo.outputPath("edge-restyled.png"), caret: "initial" }), contentType: "image/png" });

    // 図形の外をクリックして選択を外し、もう一度選ぶと辺の選択は残らず、線種は全体の値 (ばらばら) に戻る。
    await page.mouse.click(canvas.x + 600, canvas.y + 700);
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(0);
    // 掴めるのは描かれた線の上だけ。線の間の空白は本文の空白として扱われ、押しても選ばれない。
    await page.mouse.click((handles[0].x + handles[1].x) / 2 + 40, (handles[0].y + handles[1].y) / 2 - 60);
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(0);
    await page.mouse.click((handles[0].x + handles[1].x) / 2, (handles[0].y + handles[1].y) / 2);
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(4);
    await expect(page.locator("[data-solid-edge-highlight]")).toHaveCount(0);

    // 球と五角柱も挿入できる。
    await insertSolid(page, "球", { x: 500, y: 150 }, { w: 160, h: 160 });
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(0);
    expect(await page.locator(".overlay-shape svg path[data-solid-edge]").count()).toBe(6 + 3);
    // 球の曲線 (輪郭) も 1 本ずつ太さを変えられる。球を選んだ直後は全体、もう一度輪郭を押すとその曲線。
    const sphereBox = await page.locator(".overlay-shape").nth(1).boundingBox();
    if (!sphereBox) throw new Error("Sphere is missing");
    // 枠の辺の中央にはリサイズの持ち手があるので、輪郭のうち右上 45° の点を押す。
    const radius = sphereBox.width / 2;
    await page.mouse.click(
      sphereBox.x + radius + radius * Math.SQRT1_2,
      sphereBox.y + radius - radius * Math.SQRT1_2,
    );
    await expect(page.locator("[data-solid-edge-highlight]")).toHaveCount(1);
    await expect(page.locator("[data-solid-edge-highlight]")).toHaveAttribute("data-solid-edge-highlight", "0");
    // 選択した直後のスタイル要求は描画に出ないことがある (実ユーザーには届かない速さ)。少し待つ。
    await page.waitForTimeout(600);
    await page.locator(".editor-menubar").locator('button[aria-label^="線幅"]').first().click();
    await page.getByRole("menuitemradio", { name: "太", exact: true }).click();
    // 球の 3 本 (輪郭・赤道の手前・赤道の奥) だけを見る。図形の並びに依らないよう、辺が 3 本の図形を選ぶ。
    const sphereWidths = () => page.evaluate(() => (
      [...document.querySelectorAll(".overlay-shape")]
        .map((shape) => [...shape.querySelectorAll("path[data-solid-edge]")].map((path) => path.getAttribute("stroke-width")))
        .find((widths) => widths.length === 3) ?? []
    ));
    await expect.poll(sphereWidths).toEqual(["3", "2", "2"]);
    await insertSolid(page, "五角柱", { x: 500, y: 400 }, { w: 200, h: 220 });
    await expect(page.locator(".overlay-solid-vertex-handle")).toHaveCount(10);

    // ディスクの SigmaDoc: 頂点を動かした立体だけが solidPoints を持ち、辺の線種は保存される。
    await expect.poll(async () => solids(await readSaved(page)).length, { timeout: 30_000 }).toBe(3);
    const saved = await readSaved(page);
    const [pyramid, sphere, prism] = solids(saved);
    expect(pyramid.props).toMatchObject({ geo: "pyramid", baseSides: 3 });
    expect(pyramid.props.solidPoints).toHaveLength(4);
    expect(pyramid.props.solidEdgeDash).toHaveLength(6);
    expect(pyramid.props.solidEdgeDash![1]).toBe("dotted");
    expect(pyramid.props.solidEdgeSize).toEqual(["m", "xl", "m", "m", "m", "m"]);
    expect(sphere.props).toMatchObject({ geo: "sphere", solidEdgeDash: ["solid", "solid", "dashed"], solidEdgeSize: ["l", "m", "m"] });
    expect(sphere.props.solidPoints).toBeUndefined();
    expect(prism.props).toMatchObject({ geo: "prism", baseSides: 5 });
    expect(prism.props.solidPoints).toBeUndefined();
    expect(prism.props.solidEdgeSize).toBeUndefined();
    await testInfo.attach("saved-sigmadoc", { body: JSON.stringify(saved, null, 2), contentType: "application/json" });
    await testInfo.attach("three-solids", { body: await page.screenshot({ path: testInfo.outputPath("three-solids.png"), caret: "initial" }), contentType: "image/png" });

    // 再起動しても同じ図が同じ線種で描かれる。
    await app!.close();
    app = undefined;
    page = await launch();
    const reloaded = await page.evaluate(async () => {
      const file = (await window.desktopAPI!.storage.listFiles())[0];
      return window.desktopAPI!.storage.loadDocument(file.fileId);
    });
    expect(reloaded!.pageLayout?.overlay?.overlaySnapshot).toEqual(saved.pageLayout?.overlay?.overlaySnapshot);
    await expect.poll(() => page.locator(".page-overlay-preview svg path[data-solid-edge]").count()).toBe(6 + 3 + 15);
    const restoredDashes = await page.evaluate(() => (
      [...document.querySelectorAll(".page-overlay-preview .overlay-shape")].map((shape) => (
        [...shape.querySelectorAll("path[data-solid-edge]")].map((path) => path.getAttribute("stroke-dasharray"))
      ))
    ));
    expect(restoredDashes.find((dashes) => dashes.length === 6)).toEqual(initialDashes.map((dash, index) => (index === 1 ? "1 6" : dash)));
    const restoredWidths = await page.evaluate(() => (
      [...document.querySelectorAll(".page-overlay-preview .overlay-shape")].map((shape) => (
        [...shape.querySelectorAll("path[data-solid-edge]")].map((path) => path.getAttribute("stroke-width"))
      ))
    ));
    expect(restoredWidths.find((widths) => widths.length === 6)).toEqual(initialWidths.map((width, index) => (index === 1 ? "5" : width)));
    expect(restoredWidths.find((widths) => widths.length === 3)).toEqual(["3", "2", "2"]);
    await testInfo.attach("restored", { body: await page.screenshot({ path: testInfo.outputPath("restored.png"), caret: "initial" }), contentType: "image/png" });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
