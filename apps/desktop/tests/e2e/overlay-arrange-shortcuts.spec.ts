import { expect, test, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const screenshotDir = "/tmp/army-ux-overlay-arrange";

const overlayCanvasDocument = {
  ...sampleDocument,
  pageLayout: {
    ...sampleDocument.pageLayout,
    overlay: {
      ...sampleDocument.pageLayout?.overlay,
      overlaySnapshot: { version: 1, shapes: [], assets: {} },
    },
  },
} as SigmaDocument;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, overlayCanvasDocument);
});

test("Cmd+Shift+Arrow reorders selected overlay shapes like Google Slides", async ({ page }) => {
  await page.goto("/");

  await chooseShape(page, "四角形");
  const backShape = page.locator(".overlay-shape-geo").first();
  await expect(backShape).toBeVisible();
  const backShapeId = await backShape.getAttribute("data-overlay-shape-id");
  expect(backShapeId).not.toBeNull();

  await chooseShape(page, "円");
  const frontShape = page.locator(".overlay-shape-geo").last();
  await expect(frontShape).toBeVisible();
  const frontShapeId = await frontShape.getAttribute("data-overlay-shape-id");
  expect(frontShapeId).not.toBeNull();

  const backBox = await backShape.boundingBox();
  const frontBox = await frontShape.boundingBox();
  expect(backBox).not.toBeNull();
  expect(frontBox).not.toBeNull();
  const overlapPoint = {
    x: backBox!.x + backBox!.width / 2,
    y: backBox!.y + backBox!.height / 2,
  };
  await page.mouse.move(frontBox!.x + frontBox!.width / 2, frontBox!.y + frontBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(overlapPoint.x, overlapPoint.y, { steps: 8 });
  await page.mouse.up();

  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${frontShapeId}"]`)).toHaveCount(1);
  await page.screenshot({ path: `${screenshotDir}/army-1-overlapping-shapes.png` });

  await page.keyboard.press("Meta+Shift+ArrowDown");
  await expect.poll(() => readOverlayShapeIds(page)).toEqual([frontShapeId, backShapeId]);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${frontShapeId}"]`)).toHaveCount(1);

  await page.keyboard.press("Meta+Shift+ArrowUp");
  await expect.poll(() => readOverlayShapeIds(page)).toEqual([backShapeId, frontShapeId]);

  await page.keyboard.press("Meta+ArrowDown");
  await expect.poll(() => readOverlayShapeIds(page)).toEqual([frontShapeId, backShapeId]);

  await page.screenshot({ path: `${screenshotDir}/army-2-after-layer-shortcuts.png` });

  await page.mouse.click(overlapPoint.x, overlapPoint.y, { button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  await contextMenu.getByRole("menuitem", { name: "順序", exact: true }).hover();
  const orderSubmenu = page.getByRole("menu", { name: "順序", exact: true });
  await expect(orderSubmenu.getByRole("menuitem", { name: "最前面へ", exact: true })).toBeVisible();
  await expect(orderSubmenu.getByRole("menuitem", { name: "最背面へ", exact: true })).toBeVisible();
  await expect(orderSubmenu.getByRole("menuitem", { name: "最前面へ", exact: true }).locator("kbd")).toHaveText(/⇧↑/);
  await expect(orderSubmenu.getByRole("menuitem", { name: "前面へ", exact: true }).locator("kbd")).toHaveText(/↑/);
  await page.screenshot({ path: `${screenshotDir}/army-3-context-menu.png` });
});

async function readOverlayShapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const shapes = document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    return shapes
      .filter((shape: { parentId?: string }) => !shape.parentId)
      .map((shape: { id: string }) => shape.id);
  });
}

async function chooseShape(page: Page, label: string) {
  const menuButton = page.getByRole("button", { name: "図形", exact: true });
  await expect(menuButton).toBeVisible();
  await menuButton.click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: label, exact: true }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const shapeCount = await page.locator("[data-overlay-shape-id]").count();
  const startX = surfaceBox!.x + 96 + (shapeCount % 4) * 124;
  const menubarBox = await page.locator(".editor-menubar").boundingBox();
  const visibleCanvasTop = (menubarBox?.y ?? 0) + (menubarBox?.height ?? 0) + 24;
  const startY = Math.min(
    surfaceBox!.y + surfaceBox!.height - 112,
    Math.max(surfaceBox!.y + 120 + Math.floor(shapeCount / 4) * 96, visibleCanvasTop),
  );
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 132, startY + 88, { steps: 8 });
  await page.mouse.up();
}
