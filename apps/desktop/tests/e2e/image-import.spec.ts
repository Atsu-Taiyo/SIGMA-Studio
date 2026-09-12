import { expect, test, type Page } from "@playwright/test";

import type { OverlayShape, OverlaySnapshot, SigmaDocument } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

type ImageShape = Extract<OverlayShape, { type: "image" }>;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await installDesktopRuntimeMock(page, createBlankDocument("画像取込E2E"));
  await page.goto("/");
  await expect(page.locator('[data-editor-toolbar="quick"]').first()).toBeVisible();
  await expect(page.locator(".overlay-shape-image")).toHaveCount(0);
});

test("imports two images into a blank document in file order with both persisted assets", async ({ page }) => {
  const first = await createImageFile(page, "first.png", 160, 100, "#dc2626");
  const second = await createImageFile(page, "second.png", 100, 160, "#2563eb");
  await page.locator('header input[type="file"][multiple][accept*="image/"]').setInputFiles([first.payload, second.payload]);

  const images = page.locator(".overlay-shape-image");
  await expect(images).toHaveCount(2);
  await expect(images.nth(0)).toBeVisible();
  await expect(images.nth(1)).toBeVisible();
  await expect(images.nth(0)).toHaveClass(/selected/);
  await expect(images.nth(1)).toHaveClass(/selected/);
  await expect.poll(async () => {
    const snapshot = await savedOverlay(page);
    return imageShapes(snapshot).map((shape) => snapshot.assets[shape.props.assetId]?.props.name);
  }).toEqual(["first.png", "second.png"]);

  const snapshot = await savedOverlay(page);
  const [left, right] = imageShapes(snapshot);
  expect(new Set([left.id, right.id]).size).toBe(2);
  expect(left.props.assetId).not.toBe(right.props.assetId);
  expect(right.x - left.x - left.props.w).toBeCloseTo(16, 4);
  expect(right.y).toBe(left.y);
  expect(snapshot.assets[left.props.assetId].props).toMatchObject({ w: 160, h: 100, name: "first.png", src: first.dataUrl });
  expect(snapshot.assets[right.props.assetId].props).toMatchObject({ w: 100, h: 160, name: "second.png", src: second.dataUrl });
  await expect(images.nth(0)).toHaveAttribute("data-overlay-shape-id", left.id);
  await expect(images.nth(1)).toHaveAttribute("data-overlay-shape-id", right.id);
  await expect(images.nth(0).locator("img.overlay-image-shape")).toHaveAttribute("src", first.dataUrl);
  await expect(images.nth(1).locator("img.overlay-image-shape")).toHaveAttribute("src", second.dataUrl);
});

test("replaces an image file without changing its frame and restores its saved contents in a fresh renderer", async ({ page }) => {
  const original = await createImageFile(page, "original.png", 160, 100, "#2563eb");
  await page.locator('header input[type="file"][multiple][accept*="image/"]').setInputFiles(original.payload);
  const image = page.locator(".overlay-shape-image");
  await expect(image).toBeVisible();
  await expect.poll(async () => imageShapes(await savedOverlay(page)).length).toBe(1);
  const before = imageShapes(await savedOverlay(page))[0];
  const replacement = await createImageFile(page, "replacement.png", 90, 180, "#16a34a");

  await image.click({ button: "right" });
  const chooser = page.waitForEvent("filechooser");
  await page.locator(".overlay-shape-context-menu").getByRole("menuitem", { name: "画像を置き換え…", exact: true }).click();
  await (await chooser).setFiles(replacement.payload);
  await expect(image).toHaveAttribute("data-overlay-shape-id", before.id);
  await expect(image.locator("img.overlay-image-shape")).toHaveAttribute("src", replacement.dataUrl);
  await expect.poll(async () => {
    const snapshot = await savedOverlay(page);
    const shape = imageShapes(snapshot)[0];
    return shape ? snapshot.assets[shape.props.assetId]?.props.src : null;
  }).toBe(replacement.dataUrl);

  const saved = await savedDocument(page);
  expect(saved).not.toBeNull();
  const snapshot = saved!.pageLayout!.overlay!.overlaySnapshot!;
  const after = imageShapes(snapshot)[0];
  expect(frame(after)).toEqual(frame(before));
  expect(after.props.assetId).not.toBe(before.props.assetId);
  expect(snapshot.assets[before.props.assetId]).toBeUndefined();
  expect(snapshot.assets[after.props.assetId].props).toMatchObject({
    w: 90, h: 180, name: "replacement.png", mimeType: "image/png", src: replacement.dataUrl, fileSize: replacement.payload.buffer.length,
  });

  // The desktop mock resets on navigation. Rehydrate its actual saved SigmaDoc
  // result in a fresh renderer so this checks restore independently of local editor state.
  const restoredPage = await page.context().newPage();
  await restoredPage.setViewportSize({ width: 1440, height: 1100 });
  await installDesktopRuntimeMock(restoredPage, saved!);
  await restoredPage.goto("/");
  const restoredImage = restoredPage.locator(`.overlay-shape-image[data-overlay-shape-id="${before.id}"]`);
  await expect(restoredImage).toBeVisible();
  await expect(restoredImage.locator("img.overlay-image-shape")).toHaveAttribute("src", replacement.dataUrl);
  await expect(restoredImage).toHaveCSS("width", `${before.props.w}px`);
  await expect(restoredImage).toHaveCSS("height", `${before.props.h}px`);
  await expect.poll(async () => imageShapes(await savedOverlay(restoredPage)).map(frame)).toEqual([frame(before)]);
  await restoredPage.close();
});

async function createImageFile(page: Page, name: string, width: number, height: number, color: string) {
  const dataUrl = await page.evaluate(({ width, height, color }) => {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d")!;
    context.fillStyle = color;
    context.fillRect(0, 0, width, height);
    return canvas.toDataURL("image/png");
  }, { width, height, color });
  return { dataUrl, payload: { name, mimeType: "image/png", buffer: Buffer.from(dataUrl.split(",")[1], "base64") } };
}

function frame(shape: ImageShape) {
  return { id: shape.id, x: shape.x, y: shape.y, rotation: shape.rotation, w: shape.props.w, h: shape.props.h };
}

function imageShapes(snapshot: OverlaySnapshot): ImageShape[] {
  return snapshot.shapes.filter((shape): shape is ImageShape => shape.type === "image");
}

async function savedDocument(page: Page): Promise<SigmaDocument | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw) as SigmaDocument : null;
  });
}

async function savedOverlay(page: Page): Promise<OverlaySnapshot> {
  return (await savedDocument(page))?.pageLayout?.overlay?.overlaySnapshot ?? { version: 1, shapes: [], assets: {} };
}
