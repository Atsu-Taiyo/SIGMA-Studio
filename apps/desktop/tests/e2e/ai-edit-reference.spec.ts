import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const REFERENCE_TEXT = "一次関数のグラフは直線で、傾きと切片で形が決まります。";
const AI_REFERENCE_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "ai_edit_reference_e2e",
  metadata: { title: "AI参照 E2E" },
  content: [{
    id: "reference_paragraph",
    type: "paragraph",
    children: [{ type: "text", text: REFERENCE_TEXT }],
  }],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, AI_REFERENCE_DOCUMENT, { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
});

test("opens the inline AI composer with the selected body-text reference", async ({ page }) => {
  await selectParagraphText(page, "reference_paragraph", 0, 12);
  const selectedText = REFERENCE_TEXT.slice(0, 12);

  const addToAiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(addToAiButton).toBeVisible();
  await expect(addToAiButton).toHaveAttribute("data-reference-kind", "textSelection");
  await addToAiButton.click();

  const composer = page.locator(".ai-chat-composer--inline");
  await expect(composer).toBeVisible();
  const referenceChip = composer.locator('.ai-chat-chip[data-reference-kind="textSelection"]');
  await expect(referenceChip).toBeVisible();
  await expect(referenceChip).toContainText("一次関...直線で");

  const pinnedHighlight = page.locator(".external-text-range-highlight");
  await expect(pinnedHighlight).toHaveCount(1);
  await expect(pinnedHighlight).toHaveText(selectedText);
});

test("keeps the inline draft and reference while dragging, then reanchors a fresh session", async ({ page }) => {
  await selectParagraphText(page, "reference_paragraph", 0, 12);
  const addToAiButton = page.locator('.selection-action-popover button[aria-label="AIに追加"]');
  await expect(addToAiButton).toBeVisible();
  await expect(addToAiButton).toHaveAttribute("data-reference-kind", "textSelection");
  await addToAiButton.click();

  const host = page.locator(".ai-chat-host--inline");
  const composer = host.locator(".ai-chat-composer--inline");
  const instruction = composer.locator("textarea");
  const referenceChip = composer.locator('.ai-chat-chip[data-reference-kind="textSelection"]');
  const draft = "傾きと切片を中学生向けに説明してください";
  await expect(composer).toBeVisible();
  await expect(referenceChip).toContainText("一次関...直線で");
  await expect(page.locator(".external-text-range-highlight")).toHaveText(REFERENCE_TEXT.slice(0, 12));
  await instruction.fill(draft);
  // The shell's top padding is a draggable surface even when the input has text.
  await host.hover({ position: { x: 20, y: 6 } });
  const originalBounds = await host.boundingBox();
  expect(originalBounds).not.toBeNull();
  if (!originalBounds) throw new Error("inline AI host has no bounds");
  const deltaX = originalBounds.x + originalBounds.width + 180 < 1388 ? 180 : -180;
  const deltaY = 110;

  await page.mouse.down();
  await page.mouse.move(
    originalBounds.x + 20 + deltaX,
    originalBounds.y + 6 + deltaY,
    { steps: 12 },
  );
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).toBe("grabbing");
  await page.mouse.up();

  await expect.poll(async () => {
    const moved = await host.boundingBox();
    return moved ? Math.abs(moved.x - originalBounds.x) : 0;
  }).toBeGreaterThan(150);
  await expect.poll(async () => {
    const moved = await host.boundingBox();
    return moved ? moved.y - originalBounds.y : 0;
  }).toBeGreaterThan(90);
  await expect.poll(() => page.evaluate(() => document.body.style.cursor)).not.toBe("grabbing");
  await expect(instruction).toHaveValue(draft);
  await expect(referenceChip).toContainText("一次関...直線で");
  await expect(page.locator(".external-text-range-highlight")).toHaveText(REFERENCE_TEXT.slice(0, 12));

  await page.locator(".ai-inline-catcher").click({ position: { x: 4, y: 450 } });
  await expect(composer).toBeHidden();
  await expect(page.locator(".external-text-range-highlight")).toHaveCount(0);
  await selectParagraphText(page, "reference_paragraph", 0, 12);
  await expect(addToAiButton).toBeVisible();
  await expect(addToAiButton).toHaveAttribute("data-reference-kind", "textSelection");
  await addToAiButton.click();
  await expect(composer).toBeVisible();
  await host.hover({ position: { x: 20, y: 6 } });
  await expect.poll(async () => {
    const reopened = await host.boundingBox();
    return reopened ? Math.hypot(reopened.x - originalBounds.x, reopened.y - originalBounds.y) : Infinity;
  }).toBeLessThan(3);
  await expect(referenceChip).toContainText("一次関...直線で");
});

test("opens the sidebar composer from the AI menu and shows current context actions", async ({ page }) => {
  await page.getByRole("button", { name: "AI", exact: true }).click();
  await page.getByRole("menuitem", { name: "AIチャットを開く", exact: true }).click();

  const composer = page.locator(".ai-chat-composer:not(.ai-chat-composer--inline)");
  await expect(composer).toBeVisible();
  await expect(composer.locator(".ai-chat-input-shell")).toBeVisible();

  await composer.getByRole("button", { name: "コンテキストを追加" }).click();
  const menu = page.locator('.ai-chat-context-menu[aria-label="コンテキストを追加"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("textbox", { name: "コンテキストを検索" })).toBeVisible();
  await expect(menu).toContainText("ドキュメント");
  await expect(menu).toContainText("スキル");
  await expect(menu).toContainText("Actions");
  await expect(menu.getByRole("menuitem", { name: "ファイルを追加", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "問題作成", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "画像から教材化", exact: true })).toBeVisible();
});

async function selectParagraphText(page: Page, blockId: string, from: number, to: number): Promise<void> {
  await page.evaluate(({ targetBlockId, startOffset, endOffset }) => {
    const target = document.querySelector<HTMLElement>(
      `.text-flow-editor [data-sigma-doc-id="${targetBlockId}"]`,
    );
    const textNode = target?.firstChild;
    if (!target || !textNode || textNode.nodeType !== Node.TEXT_NODE) {
      throw new Error(`text selection target not found: ${targetBlockId}`);
    }
    target.scrollIntoView({ block: "center", inline: "nearest" });
    target.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(textNode, startOffset);
    range.setEnd(textNode, endOffset);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { targetBlockId: blockId, startOffset: from, endOffset: to });
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? ""))
    .toBe(REFERENCE_TEXT.slice(from, to));
}
