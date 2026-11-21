import { expect, type Page } from "@playwright/test";
import type { MathfieldElement } from "mathlive";

/** Open the actual input owner through the UI, then set the edge used by the test. */
export async function openInlineMathAtEdge(page: Page, id: string, edge: "start" | "end" = "end") {
  await page.locator(`.inline-math-node[data-id="${id}"]`).first().click();
  const field = page.locator("math-field.inline-math-field, textarea.inline-math-tex-field");
  await expect(field).toBeFocused();
  await field.evaluate((element, edge) => {
    if (element instanceof HTMLTextAreaElement) {
      const position = edge === "start" ? 0 : element.value.length;
      element.setSelectionRange(position, position);
    } else {
      const math = element as MathfieldElement;
      math.position = edge === "start" ? 0 : math.lastOffset;
    }
  }, edge);
}
