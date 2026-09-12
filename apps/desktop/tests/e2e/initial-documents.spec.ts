import { expect, test } from "@playwright/test";

const SELECTABLE_SHAPE_ID = "overlay_shape_63a75dba-ce35-4bfc-927b-a055e3aa2533";

test("Sigma Studio basics keeps every shape in place when overlay editing starts", async ({ page }) => {
  await page.goto("/");

  const previewShapes = page.locator(".page-overlay-preview div[data-overlay-shape-id]");
  await expect(previewShapes).toHaveCount(18);

  const before = await readShapePositions(previewShapes);
  const target = before.get(SELECTABLE_SHAPE_ID);
  expect(target).toBeDefined();

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await page.keyboard.down(modifier);
  await page.mouse.click(target!.x + 10, target!.y + target!.height / 2);
  await page.keyboard.up(modifier);

  const editorShapes = page.locator(".overlay-canvas-editor div[data-overlay-shape-id]");
  await expect(page.locator(".page-overlay-layer.editing")).toBeVisible();
  await expect.poll(async () => (await readShapePositions(editorShapes)).size).toBe(18);

  const after = await readShapePositions(editorShapes);
  expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
  for (const [id, initial] of before) {
    const selected = after.get(id);
    expect(selected, `${id} disappeared when overlay editing started`).toBeDefined();
    expect(selected!.x, `${id} moved horizontally`).toBeCloseTo(initial.x, 1);
    expect(selected!.y, `${id} moved vertically`).toBeCloseTo(initial.y, 1);
  }
});

async function readShapePositions(locator: import("@playwright/test").Locator) {
  const positions = await locator.evaluateAll((elements) => elements.map((element) => {
    const rect = element.getBoundingClientRect();
    return {
      height: rect.height,
      id: element.getAttribute("data-overlay-shape-id") ?? "",
      x: rect.x,
      y: rect.y,
    };
  }));
  return new Map(positions.map((position) => [position.id, position]));
}
