import { expect, test, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const IMAGE_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwC9jMuNbwhQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXBGyYx39YZbIAAAAASUVORK5CYII=",
  "base64",
);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
});

test("inserts an image and preserves its aspect ratio from a corner drag", async ({ page }) => {
  const image = await insertImage(page);
  const before = await expectBoundingBox(image);

  await dragHandle(page, page.locator(".overlay-resize-handle.se"), { x: 80, y: 12 });

  const after = await expectBoundingBox(image);
  expect(after.width).toBeGreaterThan(before.width + 50);
  expect(after.width / after.height).toBeCloseTo(before.width / before.height, 2);
});

test("allows a Shift corner drag to distort an image", async ({ page }) => {
  const image = await insertImage(page);
  const before = await expectBoundingBox(image);

  await dragHandle(page, page.locator(".overlay-resize-handle.se"), { x: 80, y: 12 }, { shift: true });

  const after = await expectBoundingBox(image);
  expect(after.width).toBeGreaterThan(before.width + 50);
  expect(Math.abs(after.width / after.height - before.width / before.height)).toBeGreaterThan(0.25);
});

test("enters crop mode, undoes a crop in one step, and leaves no history on unchanged exits", async ({ page }) => {
  const image = await insertImage(page);
  const shapeId = await image.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();
  await page.waitForTimeout(350);

  await image.dblclick();
  await expect(page.locator(".overlay-selection-box.image-cropping")).toBeVisible();
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(8);
  await expect(page.locator(".overlay-resize-handle")).toHaveCount(0);
  await expect(page.locator(".overlay-rotate-handle")).toHaveCount(0);
  await expect(page.locator(".overlay-shape-dimension-label")).toHaveCount(0);
  await expect(page.locator(".selection-action-popover")).toHaveCount(0);
  await expect(page.locator(".overlay-image-crop-ghost")).toHaveCSS("opacity", "0.4");
  await expect(page.locator(".overlay-image-frame.cropping")).toHaveCSS("cursor", "move");

  const beforeCropDrag = await expectBoundingBox(image);
  await dragHandle(page, page.locator(".overlay-crop-handle.se"), { x: -32, y: -20 });
  const afterCropDrag = await expectBoundingBox(image);
  expect(Math.abs((beforeCropDrag.width - afterCropDrag.width) - 32)).toBeLessThan(4);
  expect(Math.abs((beforeCropDrag.height - afterCropDrag.height) - 20)).toBeLessThan(4);
  await page.waitForTimeout(350);

  await page.keyboard.press("Escape");
  await expect(page.locator(".overlay-selection-box.image-cropping")).toHaveCount(0);
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(0);
  const afterEscape = await expectBoundingBox(image);
  expect(afterEscape.width).toBeCloseTo(afterCropDrag.width, 1);
  expect(afterEscape.height).toBeCloseTo(afterCropDrag.height, 1);
  await page.waitForTimeout(350);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => {
    const restored = await image.boundingBox();
    if (!restored) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(
      Math.abs(restored.width - beforeCropDrag.width),
      Math.abs(restored.height - beforeCropDrag.height),
    );
  }).toBeLessThan(3);

  await image.dblclick();
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(8);
  await page.keyboard.press("Enter");
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(0);

  await image.dblclick();
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(8);
  const canvas = await expectBoundingBox(page.locator(".overlay-canvas-editor").first());
  await page.mouse.click(canvas.x + 8, canvas.y + 8);
  await expect(page.locator(".overlay-crop-handle")).toHaveCount(0);
  await page.waitForTimeout(350);

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => {
    const redone = await image.boundingBox();
    if (!redone) {
      return Number.POSITIVE_INFINITY;
    }
    return Math.max(
      Math.abs(redone.width - afterCropDrag.width),
      Math.abs(redone.height - afterCropDrag.height),
    );
  }).toBeLessThan(3);
});

test("keeps every image action in the context menu without opening details", async ({ page }) => {
  const image = await insertImage(page);
  const shapeId = await image.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();

  await expect(page.locator('[aria-label="詳細"]')).toHaveCount(0);

  const contextMenu = await openImageContextMenu(page, image);
  const imageActions = [
    "画像をトリミング",
    "画像を置き換え…",
    "トリミングをリセット",
    "元のサイズに戻す",
  ];
  for (const label of imageActions) {
    await expect(contextMenu.getByRole("menuitem", { name: label, exact: true })).toBeVisible();
  }
  await expect(contextMenu.getByRole("menuitem", { name: "トリミングをリセット", exact: true })).toBeDisabled();

  const opacitySlider = contextMenu.getByRole("slider", { name: "画像の透明度" });
  await expect(opacitySlider).toBeVisible();
  await opacitySlider.fill("0.35");
  await expect(contextMenu.locator(".overlay-shape-context-menu-opacity output")).toHaveText("35%");
  await expect.poll(async () => (await getSavedImageShape(page, shapeId!))?.opacity ?? null).toBe(0.35);
  await page.keyboard.press("Escape");
  await expect(contextMenu).toHaveCount(0);

  await image.dblclick();
  await dragHandle(page, page.locator(".overlay-crop-handle.se"), { x: -32, y: -20 });
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await getSavedImageShape(page, shapeId!))?.props.crop ?? null).not.toBeNull();

  await openImageContextMenu(page, image);

  await contextMenu.getByRole("menuitem", { name: "トリミングをリセット", exact: true }).click();
  await expect.poll(async () => (await getSavedImageShape(page, shapeId!))?.props.crop ?? null).toBeNull();

  await openImageContextMenu(page, image);
  await expect(
    page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "トリミングをリセット", exact: true }),
  ).toBeDisabled();
});

async function insertImage(page: Page): Promise<Locator> {
  const imageInput = page.locator('header input[type="file"][multiple][accept*="image/"]');
  await imageInput.setInputFiles({
    name: "image-shape.png",
    mimeType: "image/png",
    buffer: IMAGE_PNG,
  });

  const image = page.locator(".overlay-shape-image").first();
  await expect(image).toBeVisible();
  await expect(image).toHaveClass(/selected/);
  return image;
}

async function openImageContextMenu(page: Page, image: Locator): Promise<Locator> {
  await image.click({ button: "right" });
  const contextMenu = page.locator(".overlay-shape-context-menu");
  await expect(contextMenu).toBeVisible();
  return contextMenu;
}

async function dragHandle(
  page: Page,
  handle: Locator,
  delta: { x: number; y: number },
  options: { shift?: boolean } = {},
): Promise<void> {
  await expect(handle).toBeVisible();
  const box = await expectBoundingBox(handle);
  if (options.shift) {
    await page.keyboard.down("Shift");
  }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    box.x + box.width / 2 + delta.x,
    box.y + box.height / 2 + delta.y,
    { steps: 8 },
  );
  await page.mouse.up();
  if (options.shift) {
    await page.keyboard.up("Shift");
  }
}

async function expectBoundingBox(locator: Locator): Promise<NonNullable<Awaited<ReturnType<Locator["boundingBox"]>>>> {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

interface SavedImageShape {
  id: string;
  type: "image";
  opacity?: number;
  props: {
    w: number;
    h: number;
    crop?: {
      topLeft: { x: number; y: number };
      bottomRight: { x: number; y: number };
    };
  };
}

async function getSavedImageShape(page: Page, shapeId: string): Promise<SavedImageShape | null> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  return page.evaluate((id) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document") ??
      window.localStorage.getItem("sigma-studio:document");
    const documentValue = raw ? JSON.parse(raw) : null;
    const findShape = (value: unknown): SavedImageShape | null => {
      if (!value || typeof value !== "object") {
        return null;
      }
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findShape(item);
          if (found) {
            return found;
          }
        }
        return null;
      }
      const record = value as Record<string, unknown>;
      if (record.id === id && record.type === "image") {
        return record as unknown as SavedImageShape;
      }
      for (const child of Object.values(record)) {
        const found = findShape(child);
        if (found) {
          return found;
        }
      }
      return null;
    };
    return findShape(documentValue);
  }, shapeId);
}
