import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

async function openMaterial() {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-running-insertion-layout-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await page.evaluate(async () => {
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
  });
  const document = createBlankDocument("とても長い教材名".repeat(20));
  for (const kind of ["header", "footer"] as const) {
    document.pageLayout![kind] = { ...document.pageLayout![kind]!, enabled: true, heightMm: 10 };
  }
  const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), document);
  await page.reload();
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), created.file.fileId);
  return { app, page, saved, cleanup: async () => {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  } };
}

test("running-region settings fit the viewport and long titles stay inside the card", async ({}, testInfo) => {
  const { app, page, cleanup } = await openMaterial();
  try {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1024, 800));
    const band = page.locator(".page-running-editor-band.header");
    await band.scrollIntoViewIfNeeded();
    await band.dblclick({ position: { x: 120, y: 14 } });
    await expect(band).toHaveClass(/editing/);
    await band.getByRole("button", { name: "ヘッダーの設定", exact: true }).click();
    const card = page.getByRole("group", { name: "ヘッダーの設定", exact: true });
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("header-settings.png") });
    await expect.poll(() => card.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight
        && element.scrollWidth <= element.clientWidth;
    })).toBe(true);
    // Keep the open card positioned when the window narrows or the canvas scrolls.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(900, 700));
    await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().right <= window.innerWidth)).toBe(true);
    await card.getByRole("radio", { name: "先頭ページのみ", exact: true }).click();
    await expect(card.getByRole("radio", { name: "先頭ページのみ", exact: true })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await expect(band).toHaveClass(/editing/);
    const footer = page.locator(".page-running-editor-band.footer");
    await footer.scrollIntoViewIfNeeded();
    await footer.dblclick({ position: { x: 120, y: 14 } });
    await footer.getByRole("button", { name: "フッターの設定", exact: true }).click();
    const footerCard = page.getByRole("group", { name: "フッターの設定", exact: true });
    await expect(footerCard).toBeVisible();
    await expect.poll(() => footerCard.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= window.innerWidth && rect.top >= 0 && rect.bottom <= window.innerHeight;
    })).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("footer-settings.png") });
    await page.mouse.click(30, 150);
    await expect(footerCard).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test("running drawings start outside the band and retain their coordinates after reload", async ({}, testInfo) => {
  const { page, saved, cleanup } = await openMaterial();
  try {
    for (const kind of ["header", "footer"] as const) {
      const band = page.locator(`.page-running-editor-band.${kind}`);
      await band.scrollIntoViewIfNeeded();
      await band.dblclick({ position: { x: 120, y: 14 } });
      await expect(band).toHaveClass(/editing/);
      await chooseShape(page, "四角形", "rectangle");
      const rect = await box(band);
      const scale = rect.width / await band.evaluate((element) => parseFloat((element as HTMLElement).style.width));
      const x = rect.x - 24 * scale;
      const y = kind === "header" ? rect.y + rect.height + 40 * scale : rect.y - 70 * scale;
      await page.mouse.move(x, y);
      await page.mouse.down();
      await page.mouse.move(x + 80 * scale, y + 24 * scale, { steps: 6 });
      await page.mouse.up();
      const shape = band.locator(".overlay-shape.selected");
      await expect(shape).toHaveCount(1);
      await expect(page.locator(".overlay-insertion-surface")).toHaveCount(0);
      await expect.poll(async () => (await saved())?.pageLayout?.[kind]?.overlay?.overlaySnapshot?.shapes.length).toBe(1);
      const inserted = (await saved())!.pageLayout![kind]!.overlay!.overlaySnapshot!.shapes[0];
      expect(inserted.x).toBeCloseTo(-24, 0);
      expect(inserted.y).toBeCloseTo(kind === "header" ? rect.height / scale + 40 : -70, 0);
      await page.screenshot({ path: testInfo.outputPath(`${kind}-outside-insertion.png`) });
      // Canceling the next insertion removes its extended input area as well.
      await chooseShape(page, "四角形", "rectangle");
      await page.keyboard.press("Escape");
      await expect(page.locator(".overlay-insertion-surface")).toHaveCount(0);
      await page.reload();
      await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
      await page.locator(".startup-splash").waitFor({ state: "hidden" });
      const reloaded = page.locator(`.page-running-region.${kind} [data-overlay-shape-id="${inserted.id}"]`).first();
      await expect(reloaded).toBeAttached();
      expect((await saved())!.pageLayout![kind]!.overlay!.overlaySnapshot!.shapes[0]).toEqual(inserted);
      if (kind === "header") {
        // A click-based tool also accepts its very first point outside the band.
        await band.scrollIntoViewIfNeeded();
        await band.dblclick({ position: { x: 120, y: 14 } });
        await chooseShape(page, "折れ線", "polyline");
        const current = await box(band);
        const startX = current.x + current.width + 20 * scale;
        const startY = current.y + current.height + 50 * scale;
        await page.mouse.click(startX, startY);
        await expect(band.locator(".overlay-drawing-vertex-marker").first()).toBeVisible();
        await page.mouse.click(startX - 50 * scale, startY + 30 * scale);
        await page.keyboard.press("Enter");
        await expect.poll(async () => (await saved())?.pageLayout?.header?.overlay?.overlaySnapshot?.shapes.length).toBe(2);
        const line = (await saved())!.pageLayout!.header!.overlay!.overlaySnapshot!.shapes[1];
        expect(line.type).toBe("line");
        await expect(page.locator(".overlay-insertion-surface")).toHaveCount(0);
        await page.reload();
        await expect(page.locator(`.page-running-region.header [data-overlay-shape-id="${line.id}"]`)).toBeAttached();
        expect((await saved())!.pageLayout!.header!.overlay!.overlaySnapshot!.shapes[1]).toEqual(line);
      }
    }
  } finally {
    await cleanup();
  }
});

test("keyboard users enter the portaled settings and return to the toggle on Escape", async () => {
  const { page, cleanup } = await openMaterial();
  try {
    for (const [kind, label, key] of [["header", "ヘッダー", "Enter"], ["footer", "フッター", "Space"]] as const) {
      const band = page.locator(`.page-running-editor-band.${kind}`);
      await band.scrollIntoViewIfNeeded();
      await band.dblclick({ position: { x: 120, y: 14 } });
      const toggle = band.getByRole("button", { name: `${label}の設定`, exact: true });
      await toggle.focus();
      await page.keyboard.press(key);
      const card = page.getByRole("group", { name: `${label}の設定`, exact: true });
      await expect(card).toBeVisible();
      await expect(card.getByRole("button").first()).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(card.getByRole("button").nth(1)).toBeFocused();
      await page.keyboard.press("Shift+Tab");
      await expect(card.getByRole("button").first()).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(card).toHaveCount(0);
      await expect(toggle).toBeFocused();
      await expect(band).toHaveClass(/editing/);
    }
  } finally {
    await cleanup();
  }
});

async function chooseShape(page: Page, name: string, command: string) {
  await page.getByRole("button", { name: command === "polyline" ? "線" : "図形", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name, exact: true }).click();
  await expect(page.locator(".page-running-direct-overlay .overlay-canvas-editor")).toHaveAttribute("data-overlay-insert-command", command);
}

async function box(locator: Locator) {
  const result = await locator.boundingBox();
  expect(result).not.toBeNull();
  return result!;
}
