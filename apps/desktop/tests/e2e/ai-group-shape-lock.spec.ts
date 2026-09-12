import { expect, test, type Locator, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

// A group is never drawn: it is filtered out of every render pass, and only its members reach the
// canvas. An AI run anchored on a group therefore has to veil the members -- reserving the group
// id alone refuses the human's edit with nothing on screen to explain why.

test.describe.configure({ timeout: 120_000 });

function paragraph(id: string, text: string): SigmaBlock {
  return {
    id,
    type: "paragraph",
    children: [{ type: "text", text }],
  } as SigmaBlock;
}

function createDocument(): SigmaDocument {
  const content: SigmaBlock[] = [paragraph("para_a", "グループ図形とAI編集ロックの確認。")];
  // The runtime mock anchors its own `e2e_shape_1` rectangle to the LAST paragraph; the filler
  // keeps it clear of the two shapes this spec inserts and groups.
  for (let index = 0; index < 6; index += 1) {
    content.push(paragraph(`para_pad_${index}`, `本文を縦に伸ばすための段落 ${index + 1} です。`));
  }
  return {
    version: "2.0",
    docId: "ai_group_shape_lock_e2e_doc",
    metadata: { title: "AIグループロックE2E" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  } as unknown as SigmaDocument;
}

async function setup(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createDocument(), { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** Inserts a rectangle by dragging it out, and returns the shape it created. */
async function insertRectangle(page: Page, offsetX: number, offsetY: number): Promise<Locator> {
  await page.getByRole("button", { name: "図形", exact: true }).click();
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "四角形", exact: true }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  const startX = surfaceBox!.x + offsetX;
  const startY = surfaceBox!.y + offsetY;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX + 140, startY + 90, { steps: 8 });
  await page.mouse.up();

  const inserted = page.locator(".overlay-shape-geo.selected").first();
  await expect(inserted).toBeVisible();
  const shapeId = await inserted.getAttribute("data-overlay-shape-id");
  expect(shapeId).not.toBeNull();
  return page.locator(`.overlay-shape[data-overlay-shape-id="${shapeId}"]`);
}

async function startShapeRun(page: Page, shape: Locator, instruction: string): Promise<void> {
  await shape.click();
  const aiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(aiButton).toBeVisible();
  await aiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await composer.locator("textarea").fill(instruction);
  await composer.locator(".ai-chat-send-button").click();

  // The composer's click-away catcher would swallow the first canvas click.
  await page.evaluate(() => {
    document.querySelector<HTMLElement>(".ai-inline-catcher")?.click();
  });
  await expect(page.locator(".ai-inline-catcher")).toHaveCount(0);
}

async function dragBy(page: Page, shape: Locator, dx: number, dy: number): Promise<number> {
  const box = await shape.boundingBox();
  expect(box).not.toBeNull();
  const centerX = box!.x + box!.width / 2;
  const centerY = box!.y + box!.height / 2;
  await page.mouse.move(centerX, centerY);
  await page.mouse.down();
  await page.mouse.move(centerX + dx / 2, centerY + dy / 2, { steps: 4 });
  await page.mouse.move(centerX + dx, centerY + dy, { steps: 4 });
  await page.mouse.up();
  const next = await shape.boundingBox();
  expect(next).not.toBeNull();
  return Math.abs(next!.x - box!.x) + Math.abs(next!.y - box!.y);
}

test("an AI run on a group shows the working veil on the members it owns", async ({ page }) => {
  await setup(page);

  const first = await insertRectangle(page, 120, 130);
  const second = await insertRectangle(page, 320, 130);
  const firstBox = await first.boundingBox();
  expect(firstBox).not.toBeNull();
  await page.keyboard.down("Shift");
  await page.mouse.click(firstBox!.x + firstBox!.width / 2, firstBox!.y + firstBox!.height / 2);
  await page.keyboard.up("Shift");
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(2);
  await page.keyboard.press("ControlOrMeta+G");
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);

  // Clicking a member now selects the group, and that is what the run is anchored on.
  await startShapeRun(page, first, "SLOW このグループを整えてください");

  await expect(first).toHaveClass(/ai-edit-locked-shape/);
  await expect(second).toHaveClass(/ai-edit-locked-shape/);
  await expect(first.locator(".ai-edit-lock-shape-veil")).toHaveCount(1);
  await expect(second.locator(".ai-edit-lock-shape-veil")).toHaveCount(1);
  // One stop button for the whole group, on the member with room for it.
  await expect(page.locator(".ai-edit-lock-shape-stop-button")).toHaveCount(1);

  expect(await dragBy(page, second, 80, 50)).toBeLessThan(1);
  await expect(page.locator(".overlay-ai-lock-notice")).toBeVisible();

  // An unrelated shape is still the human's: per-target locking, unchanged.
  const unrelated = page.locator('.overlay-shape[data-overlay-shape-id="e2e_shape_1"]').first();
  expect(await dragBy(page, unrelated, 60, 0)).toBeGreaterThan(20);
});
