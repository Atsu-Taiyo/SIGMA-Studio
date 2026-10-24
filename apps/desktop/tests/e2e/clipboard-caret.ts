import { expect, type Locator, type Page } from "@playwright/test";

/** Leave overlay mode, then place a real DOM caret after the destination's text. */
export async function placeClipboardCaret(page: Page, block: Locator): Promise<void> {
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) throw new Error("clipboard destination is not visible");
  // The right edge can be covered by the selection toolbar.
  await page.mouse.click(box.x + 6, box.y + box.height / 2);
  await expect.poll(() => block.evaluate(element =>
    element.closest(".ProseMirror") === document.activeElement,
  )).toBe(true);
  await block.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
}
