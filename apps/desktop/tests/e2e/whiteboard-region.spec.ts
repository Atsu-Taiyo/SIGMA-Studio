import { expect, test, type Page } from "@playwright/test";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const document: SigmaDocument = {
  version: "2.0", docId: "whiteboard_region", metadata: { title: "空領域の参照" }, content: [],
  pageLayout: { ...getDefaultPageLayout("whiteboard"), overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } } },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};
const retained = '[data-retained-region="true"]';
async function selectRegion(page: Page) {
  const box = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
  await page.mouse.move(box.x + 520, box.y + 360);
  await page.mouse.down();
  await page.mouse.move(box.x + 280, box.y + 220, { steps: 12 });
  await page.mouse.up();
  await expect(page.locator(retained)).toBeVisible();
  return page.locator(retained).evaluate((el: HTMLElement) => ({
    x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 950 });
  await installDesktopRuntimeMock(page, document, { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
});

test("keeps an empty range through zoom/pan, then clears on Escape, outside click and document switch", async ({ page }) => {
  const bounds = await selectRegion(page);
  const region = page.locator(retained);
  await region.click({ force: true });
  await expect(region).toBeVisible();
  await page.locator(".whiteboard-zoom-controls").getByRole("button", { name: "拡大", exact: true }).click();
  await expect(page.locator(".whiteboard-zoom-controls output")).toHaveText("110%");
  await expect(region).toBeVisible();
  const before = (await region.boundingBox())!;
  await page.mouse.move(before.x + 40, before.y + 40);
  await page.mouse.wheel(-80, -50);
  await expect.poll(async () => (await region.boundingBox())!.x).not.toBe(before.x);
  expect(await region.evaluate((el: HTMLElement) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) }))).toEqual(bounds);
  await expect(page.locator('.selection-action-popover button[aria-label="AIに追加"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(region).toHaveCount(0);
  await expect(page.locator(".selection-action-popover")).toHaveCount(0);
  await selectRegion(page);
  const viewport = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
  await page.mouse.click(viewport.x + 700, viewport.y + 500);
  await expect(region).toHaveCount(0);
  await selectRegion(page);
  await page.getByRole("button", { name: "新規教材" }).hover();
  await page.getByRole("menuitem", { name: "ホワイトボード", exact: true }).click();
  await expect(region).toHaveCount(0);
  await expect(page.locator(".selection-action-popover")).toHaveCount(0);
});

test("saves a coordinate comment without creating a shape and restores its marker", async ({ page }) => {
  const bounds = await selectRegion(page);
  await page.locator('.selection-action-popover button[aria-label="コメントを追加"]').click();
  const dock = page.locator(".comment-dock");
  await expect(dock.locator(".comment-compose-card.pending")).toBeVisible();
  await dock.locator(".comment-rich-text-editor").fill("この領域に図を入れる");
  await dock.getByRole("button", { name: "追加", exact: true }).click();
  await expect(dock.locator(".comment-thread-card")).toContainText("この領域に図を入れる");
  await expect.poll(async () => (await saved(page))?.comments?.length).toBe(1);
  const stored = (await saved(page))!;
  expect(stored.comments![0].anchor).toEqual({ type: "canvasRegion", bounds, quote: "選択した領域" });
  expect(stored.pageLayout?.overlay?.overlaySnapshot?.shapes).toEqual([]);
  expect(await page.evaluate(() => window.desktopAPI!.storage.loadDocument("file_e2e_document"))).toEqual(stored);
  const restored = await page.context().newPage();
  try {
    await installDesktopRuntimeMock(restored, stored);
    await restored.goto("/");
    await expect(restored.locator(".startup-splash")).toBeHidden();
    await restored.locator(".comment-dock-toggle").click();
    const card = restored.locator(".comment-thread-card");
    await expect(card).toContainText("この領域に図を入れる");
    await card.locator(".comment-anchor-label").click();
    await expect(restored.locator(`[data-comment-thread-id="${stored.comments![0].id}"].overlay-comment-marker`)).toBeVisible();
    await expect(restored.locator(retained)).toHaveCount(0);
  } finally { await restored.close(); }
});

test("passes CANVAS and the selected bounds to the AI bridge and cleans up after cancellation", async ({ page }) => {
  const bounds = await selectRegion(page);
  await page.locator('.selection-action-popover button[aria-label="AIに追加"]').click();
  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".ai-chat-chip")).toContainText("選択した領域");
  await composer.locator("textarea").fill("SLOW この範囲に図を描いて");
  await composer.locator(".ai-chat-send-button").click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __aiEditRunPayloads: unknown[] }).__aiEditRunPayloads.length)).toBe(1);
  const payload = await page.evaluate(() => (window as unknown as { __aiEditRunPayloads: { references: unknown[] }[] }).__aiEditRunPayloads[0]);
  expect(payload.references).toContainEqual(expect.objectContaining({ targetId: "CANVAS", targetType: "canvasRegion", overlaySelection: { region: bounds, shapes: [], selectedShapeIds: [], assets: {} } }));
  await page.locator(".ai-chat-stop-button").first().click();
  await expect(page.locator(".ai-chat-stop-button")).toHaveCount(0);
  await expect(page.locator(retained)).toHaveCount(0);
  expect((await saved(page))?.pageLayout?.overlay?.overlaySnapshot?.shapes).toEqual([]);
});
async function saved(page: Page): Promise<SigmaDocument | null> {
  return page.evaluate(() => window.desktopAPI!.storage.loadDocument("file_e2e_document"));
}
