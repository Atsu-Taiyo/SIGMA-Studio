import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("reselects and drags header and footer overlay shapes from preview mode", async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installDesktopRuntimeMock(page, createRunningRegionOverlayDocument());

  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 20_000 });
  await enableRunningRegions(page);
  await expect(page.locator(".page-running-editor-band.header")).toBeVisible();

  await insertRunningRegionRectangle(page, "header");
  await exitRunningRegionOverlayMode(page);
  await reselectPreviewShapeAndDrag(page, "header", { dx: 34, dy: 4 });

  await insertRunningRegionRectangle(page, "footer");
  await exitRunningRegionOverlayMode(page);
  await reselectPreviewShapeAndDrag(page, "footer", { dx: -32, dy: -4 });
});

async function enableRunningRegions(page: Page): Promise<void> {
  await page.getByRole("button", { name: "設定" }).click();
  await page.getByRole("menuitem", { name: "ページ設定" }).click();

  const headerRegion = page.getByRole("region", { name: "ヘッダー" });
  const footerRegion = page.getByRole("region", { name: "フッター" });
  await headerRegion.getByLabel("表示", { exact: true }).check();
  await footerRegion.getByLabel("表示", { exact: true }).check();
  await page.getByRole("button", { name: "適用", exact: true }).click();
}

async function insertRunningRegionRectangle(page: Page, kind: "header" | "footer"): Promise<void> {
  const band = page.locator(`.page-running-editor-band.${kind}`);
  await band.scrollIntoViewIfNeeded();
  await band.dblclick({ position: { x: 120, y: 14 } });
  await expect(band).toHaveClass(/editing/);

  await chooseShapeTool(page, "四角形");
  const overlay = page.locator(".page-running-direct-overlay .overlay-canvas-editor");
  await expect(overlay).toBeVisible();
  await expect(overlay).toHaveAttribute("data-overlay-insert-command", "rectangle");
  await dragInOverlay(overlay, { startX: 52, startY: 8, endX: 156, endY: 34 });
  await expect(band.locator("[data-overlay-shape-id].selected")).toHaveCount(1);
}

async function exitRunningRegionOverlayMode(page: Page): Promise<void> {
  const overlay = page.locator(".page-running-direct-overlay .overlay-canvas-editor");
  const box = await requiredBox(overlay);
  await page.mouse.click(box.x + box.width - 8, box.y + box.height - 8);
  await expect(page.locator(".page-running-direct-overlay .overlay-canvas-editor")).toHaveCount(0);
  await expect(page.locator(".page-running-direct-overlay.preview.interactive")).toBeVisible();
}

async function reselectPreviewShapeAndDrag(
  page: Page,
  kind: "header" | "footer",
  delta: { dx: number; dy: number },
): Promise<void> {
  const band = page.locator(`.page-running-editor-band.${kind}`);
  await band.scrollIntoViewIfNeeded();
  // React shapes, not an injected SVG string: the overlay layer now renders the same components
  // the body and the PDF surface use.
  const previewRect = band.locator(".page-running-direct-overlay.preview [data-overlay-shape-id]");
  await expect(previewRect).toBeVisible();
  const previewBox = await requiredBox(previewRect);

  await page.mouse.click(previewBox.x + previewBox.width / 2, previewBox.y + previewBox.height / 2);

  const selectedShape = band.locator("[data-overlay-shape-id].selected");
  await expect(selectedShape).toHaveCount(1);
  const before = await requiredBox(selectedShape);
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + delta.dx, before.y + before.height / 2 + delta.dy, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => {
    const after = await requiredBox(selectedShape);
    return Math.round(after.x - before.x);
  }).toBe(Math.round(delta.dx));
}

async function chooseShapeTool(page: Page, label: string): Promise<void> {
  const menuButton = page.getByRole("button", { name: "図形", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: label, exact: true }).click();
}

async function dragInOverlay(
  overlay: Locator,
  points: { startX: number; startY: number; endX: number; endY: number },
): Promise<void> {
  const box = await requiredBox(overlay);
  await overlay.page().mouse.move(box.x + points.startX, box.y + points.startY);
  await overlay.page().mouse.down();
  await overlay.page().mouse.move(box.x + points.endX, box.y + points.endY, { steps: 6 });
  await overlay.page().mouse.up();
}

async function requiredBox(locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}

function createRunningRegionOverlayDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_running_region_overlay";
  document.metadata = {
    ...document.metadata,
    title: "ヘッダー・フッター図形 E2E",
  };
  return document;
}
