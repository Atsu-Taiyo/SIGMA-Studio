import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type { OverlayTableShape } from "@/features/document";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = existsSync(path.join(APP_ROOT, "dist-electron/main.cjs"))
  && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));

function tableSizes(document: SigmaDocument) {
  return (document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
    .filter((shape): shape is OverlayTableShape => shape.type === "tableShape")
    .map((shape) => ({ rows: shape.props.table.rows.length, columns: shape.props.table.columns.length }));
}

test("click and drag table placement survive real Electron storage and an app restart", async ({}, testInfo) => {
  test.skip(!PREPARED, "Build Electron and supply SIGMA_STUDIO_E2E_BASE_URL, or prepare the static renderer.");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-table-insertion-"));
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
    await page.waitForLoadState("domcontentloaded");
    await page.evaluate(() => localStorage.setItem("sigma-studio:ui-locale", "ja"));
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    const onboarding = page.locator('[data-ui-layout-choice="docs"]');
    if (await onboarding.isVisible()) await onboarding.click();
    await expect(page.getByRole("button", { name: "表", exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.desktopAPI?.isDesktop)).toBe(true);
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    return page;
  };

  try {
    let page = await launch();
    await page.getByRole("button", { name: "表", exact: true }).first().click();
    await expect(page.getByRole("dialog", { name: "表を挿入" })).toHaveCount(0);
    const canvas = await page.locator(".overlay-canvas-editor").first().boundingBox();
    if (!canvas) throw new Error("Canvas is missing");
    const start = { x: canvas.x + 80, y: canvas.y + 180 };
    await page.mouse.move(start.x, start.y);
    const preview = page.locator("[data-table-placement-preview] .overlay-insert-preview-shape");
    await expect(preview).toHaveAttribute("data-table-preview-rows", "2");
    await expect(preview).toHaveAttribute("data-table-preview-columns", "2");
    await expect(preview.locator("svg")).toHaveCSS("stroke-dasharray", "3px, 3px");
    await expect(preview.locator(".table-placement-hint")).toHaveText("ドラッグで行・列を増やす");
    await testInfo.attach("table-preview", { body: await page.screenshot({ path: testInfo.outputPath("table-preview.png") }), contentType: "image/png" });
    const clickSize = await preview.boundingBox();
    await page.mouse.click(start.x, start.y);
    await expect(page.locator(".overlay-table-shape [contenteditable=true]").first()).toBeFocused();
    await page.keyboard.type("Click table");

    // Leaving editing destroys the cell editor; the next table command must not use it.
    await page.mouse.click(start.x + 450, start.y + 40);
    await expect(page.locator(".overlay-table-shape [contenteditable=true]")).toHaveCount(0);

    await page.getByRole("button", { name: "表", exact: true }).first().click();
    await page.mouse.move(start.x, start.y + 120);
    await page.mouse.down();
    await page.mouse.move(start.x + 300, start.y + 300, { steps: 8 });
    const dragPreview = page.locator(".overlay-insert-preview-shape");
    await expect(dragPreview).toHaveAttribute("data-table-preview-rows", "5");
    await expect(dragPreview).toHaveAttribute("data-table-preview-columns", "5");
    await testInfo.attach("table-drag-preview", { body: await page.screenshot({ path: testInfo.outputPath("table-drag-preview.png") }), contentType: "image/png" });
    const releaseStartedAt = await page.evaluate(() => performance.now());
    await page.mouse.up();
    const enlarged = page.locator(".overlay-table-shape.editing");
    await expect(enlarged.locator("[contenteditable=true]").first()).toBeFocused();
    await expect(enlarged.locator("[contenteditable=true]")).toHaveCount(1);
    const releaseToReadyMs = await page.evaluate((startedAt) => performance.now() - startedAt, releaseStartedAt);
    await testInfo.attach("table-placement-timing", {
      body: JSON.stringify({ rows: 5, columns: 5, activeEditors: 1, releaseToReadyMs }),
      contentType: "application/json",
    });
    const dragSize = await enlarged.boundingBox();
    expect(dragSize!.width).toBeGreaterThan(clickSize!.width);
    expect(dragSize!.height).toBeGreaterThan(clickSize!.height);
    await page.keyboard.type("Drag table");

    // Read the actual desktop storage API; no renderer or storage mocks participate here.
    await expect.poll(async () => page.evaluate(async () => {
      const file = (await window.desktopAPI!.storage.listFiles())[0];
      return file ? await window.desktopAPI!.storage.loadDocument(file.fileId) : null;
    }).then((document) => document ? tableSizes(document) : []), { timeout: 30_000 }).toEqual([
      { rows: 2, columns: 2 }, { rows: 5, columns: 5 },
    ]);
    const file = await page.evaluate(async () => (await window.desktopAPI!.storage.listFiles())[0]);
    if (!file.documentPath) throw new Error("Desktop storage did not return a file path");
    const documentPath = path.resolve(profile, "sigma", "data", file.documentPath);
    expect(path.relative(realpathSync(profile), realpathSync(documentPath)).startsWith("..")).toBe(false);
    await expect.poll(() => readFileSync(documentPath, "utf8")).toContain("Drag table");
    const saved = JSON.parse(readFileSync(documentPath, "utf8")) as SigmaDocument;
    expect(tableSizes(saved)).toEqual([{ rows: 2, columns: 2 }, { rows: 5, columns: 5 }]);
    expect(JSON.stringify(saved)).toContain("Click table");
    const savedTables = saved.pageLayout!.overlay!.overlaySnapshot!.shapes
      .filter((shape): shape is OverlayTableShape => shape.type === "tableShape");
    expect(savedTables[1].props.w).toBeGreaterThan(savedTables[0].props.w);
    expect(savedTables[1].props.h).toBeGreaterThan(savedTables[0].props.h);
    await testInfo.attach("saved-sigmadoc", { body: JSON.stringify(saved, null, 2), contentType: "application/json" });
    await testInfo.attach("inserted-tables", { body: await page.screenshot({ path: testInfo.outputPath("inserted-tables.png") }), contentType: "image/png" });

    await app!.close();
    app = undefined;
    page = await launch();
    const reloaded = await page.evaluate(async (fileId) => window.desktopAPI!.storage.loadDocument(fileId), file.fileId);
    expect(reloaded).not.toBeNull();
    expect(tableSizes(reloaded!)).toEqual(tableSizes(saved));
    expect(reloaded!.pageLayout?.overlay?.overlaySnapshot).toEqual(saved.pageLayout?.overlay?.overlaySnapshot);
    await expect(page.locator(".page-overlay-preview").getByText("Click table", { exact: true })).toBeVisible();
    await expect(page.locator(".page-overlay-preview").getByText("Drag table", { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
