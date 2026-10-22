import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { getPageMetrics, mmToPx, type OverlayGeoShape } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

test("running drawings overflow the band, show a live Ctrl marquee, and stay fixed through resize and reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-running-region-shapes-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    const document = createBlankDocument("ヘッダーの図形");
    const layout = document.pageLayout!;
    const width = getPageMetrics(layout).content.widthPx;
    for (const kind of ["header", "footer"] as const) {
      const rectangle = (id: string, x: number): OverlayGeoShape => ({
        id: `${kind}_${id}`, type: "geo", x, y: 10,
        props: { w: 60, h: 20, geo: "rectangle", fill: "solid", fillColor: "#2864dc", color: "#2864dc", labelColor: "black", dash: "solid", size: "m" },
      });
      layout[kind] = {
        ...layout[kind]!, enabled: true, heightMm: 18,
        overlay: { overlaySnapshot: { version: 1, shapes: [rectangle("inside", 80), rectangle("overflow", width - 20)], assets: {} } },
      };
    }
    layout.marginsMm.top = layout.marginsMm.bottom = 25;
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), document);
    const fileId = created.file.fileId;
    await page.reload();
    await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" });

    for (const kind of ["header", "footer"] as const) {
      const band = page.locator(`.page-running-editor-band.${kind}`);
      await band.scrollIntoViewIfNeeded();
      const entryBox = await box(band);
      const entryScale = entryBox.width / width;
      await page.keyboard.down("Control");
      await page.mouse.move(entryBox.x + 50 * entryScale, entryBox.y + 7 * entryScale);
      await page.mouse.down();
      await expect(band).toHaveClass(/editing/);
      await expect(band.locator(".overlay-canvas-editor")).toBeVisible();
      await page.mouse.move(entryBox.x + (width + 50) * entryScale, entryBox.y + 40 * entryScale, { steps: 10 });
      await expect(band.locator(".overlay-marquee-box")).toBeVisible();
      await page.mouse.up();
      await page.keyboard.up("Control");
      await expect(band.locator("[data-overlay-shape-id].selected")).toHaveCount(2);
      await page.mouse.click(entryBox.x + 250 * entryScale, entryBox.y + 50 * entryScale);
      const preview = band.locator(".page-running-direct-overlay.preview");
      await expect(preview).toBeVisible();
      const scale = (await box(band)).width / width;
      const overflow = band.locator(`.overlay-shape[data-overlay-shape-id="${kind}_overflow"]`);
      const initial = await shapePositionOnPage(page, overflow);

      // The portion beyond the text width is painted and receives pointer input.
      const outside = await box(overflow);
      const hitPoint = { x: outside.x + outside.width - 8 * scale, y: outside.y + outside.height / 2 };
      expect(hitPoint.x).toBeGreaterThan((await box(band)).x + (await box(band)).width);
      expect(await page.evaluate(({ x, y }) => window.document.elementFromPoint(x, y)?.closest("[data-overlay-shape-id]")?.getAttribute("data-overlay-shape-id"), hitPoint)).toBe(`${kind}_overflow`);
      await page.mouse.click(hitPoint.x, hitPoint.y);
      await expect(overflow).toHaveClass(/selected/);
      expectSamePosition(await shapePositionOnPage(page, overflow), initial);

      // Go back to text, then start the marquee there. It must be visible before pointerup.
      let bandBox = await box(band);
      await page.mouse.click(bandBox.x + 250 * scale, bandBox.y + 50 * scale);
      await expect(preview).toBeVisible();
      bandBox = await box(band);
      await page.keyboard.down("Control");
      await page.mouse.move(bandBox.x + 50 * scale, bandBox.y + 7 * scale);
      await page.mouse.down();
      await expect(band.locator(".overlay-canvas-editor")).toBeVisible();
      await page.mouse.move(bandBox.x + (width + 50) * scale, bandBox.y + 40 * scale, { steps: 10 });
      await expect(band.locator(".overlay-marquee-box")).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`${kind}-marquee.png`) });
      await page.mouse.up();
      await page.keyboard.up("Control");
      await expect(band.locator("[data-overlay-shape-id].selected")).toHaveCount(2);

      for (const edge of ["start", "end"] as const) {
        const handle = band.locator(`.page-running-edge.${edge}`);
        const handleBox = await box(handle);
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
        await page.mouse.down();
        await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2 + mmToPx(3) * scale, { steps: 8 });
        await expect.poll(async () => Math.abs((await shapePositionOnPage(page, overflow)).y - initial.y)).toBeLessThan(0.75);
        await page.mouse.up();
        await expect.poll(async () => Math.abs((await shapePositionOnPage(page, overflow)).y - initial.y)).toBeLessThan(0.75);
      }
      if (kind === "header") {
        // Even a collapsed band leaves its drawings visible and editable at their page positions.
        const end = await box(band.locator(".page-running-edge.end"));
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2);
        await page.mouse.down();
        await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2 - mmToPx(30) * scale, { steps: 8 });
        await page.mouse.up();
        await expect.poll(async () => (await box(band)).height).toBe(0);
        expectSamePosition(await shapePositionOnPage(page, overflow), initial);
        const shapeBox = await box(overflow);
        const x = shapeBox.x + shapeBox.width - 8 * scale;
        const y = shapeBox.y + shapeBox.height / 2;
        await page.mouse.click(x, y);
        await expect(overflow).toHaveClass(/selected/);
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x + 6 * scale, y, { steps: 5 });
        await page.mouse.up();
        initial.x += 6 * scale;
        await expect.poll(async () => Math.abs((await shapePositionOnPage(page, overflow)).x - initial.x)).toBeLessThan(0.75);
        expectSamePosition(await shapePositionOnPage(page, overflow), initial);
      }
      await expect.poll(async () => {
        const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
        const region = saved!.pageLayout![kind]!;
        const top = kind === "header" ? region.offsetMm : saved!.pageLayout!.pageSize.heightMm - region.offsetMm - region.heightMm;
        return mmToPx(top) + region.overlay!.overlaySnapshot!.shapes[1].y;
      }).toBeCloseTo(kind === "header" ? mmToPx(5) + 10 : mmToPx(297 - 5 - 18) + 10, 3);
      await expect.poll(async () => {
        const saved = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
        return saved!.pageLayout![kind]!.overlay!.overlaySnapshot!.shapes[1].x;
      }).toBeCloseTo(width - 20 + (kind === "header" ? 6 : 0), 3);

      await page.reload();
      await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
      await page.locator(".startup-splash").waitFor({ state: "hidden" });
      const reloaded = page.locator(`.page-running-region.${kind} [data-overlay-shape-id="${kind}_overflow"]`).first();
      await expect(reloaded).toBeAttached();
      expectSamePosition(await shapePositionOnPage(page, reloaded), initial, 2);
    }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}

async function shapePositionOnPage(page: Page, shape: Locator) {
  const shapeBox = await box(shape);
  const sheet = await box(page.locator(".a4-page-sheet").first());
  return { x: shapeBox.x - sheet.x, y: shapeBox.y - sheet.y };
}

function expectSamePosition(actual: { x: number; y: number }, expected: { x: number; y: number }, tolerance = 0.75) {
  expect(Math.abs(actual.x - expected.x)).toBeLessThan(tolerance);
  expect(Math.abs(actual.y - expected.y)).toBeLessThan(tolerance);
}
