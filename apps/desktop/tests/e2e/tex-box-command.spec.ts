import { expect, test, type Locator, type Page } from "@playwright/test";

const INLINE_MATH_INPUT_MODE_STORAGE_KEY = "sigma-studio:inline-math-input-mode";

// Typing a backslash box command (e.g. \tcolorbox{...}) in body text and pressing
// Ctrl+Enter should typeset a shaded box rather than leaving an inline math node.
test("typesets a shaded \\tcolorbox from a backslash command", async ({ page }) => {
  await openEditor(page);
  await focusFirstFlowEditor(page);

  const texField = await startBackslashCommand(page);
  await texField.pressSequentially("tcolorbox[blue]{kpt}", { delay: 30 });
  await expect(texField).toHaveValue("\\tcolorbox[blue]{kpt}");
  await page.keyboard.press("Control+Enter");

  const box = page.locator('.text-flow-editor .boxed-text[data-sigma-doc-boxed-variant="shade"]');
  await expect(box).toHaveText("kpt");
  await expect(box).toHaveAttribute("data-sigma-doc-boxed-tone", "blue");
});

// \itembox keeps its title as a bold lead inside the box.
test("typesets an \\itembox with a bold title lead", async ({ page }) => {
  await openEditor(page);
  await focusFirstFlowEditor(page);

  const texField = await startBackslashCommand(page);
  await texField.pressSequentially("itembox{point}{body}", { delay: 30 });
  await expect(texField).toHaveValue("\\itembox{point}{body}");
  await page.keyboard.press("Control+Enter");

  const box = page.locator('.text-flow-editor .boxed-text[data-sigma-doc-boxed-variant="shade"]').first();
  await expect(box).toContainText("【point】");
  // The title is bold; the bold mark nests around the boxed run.
  await expect(page.locator(".text-flow-editor strong").filter({ hasText: "【point】" })).toHaveCount(1);
});

// A non-box backslash command stays an inline math node (no regression).
test("leaves a non-box backslash command as inline math", async ({ page }) => {
  await openEditor(page);
  await focusFirstFlowEditor(page);

  const texField = await startBackslashCommand(page);
  await texField.pressSequentially("sum_{i=1}^n", { delay: 30 });
  await expect(texField).toHaveValue("\\sum_{i=1}^n");
  await page.keyboard.press("Control+Enter");

  const committed = page.locator(".inline-math-node").filter({ has: page.locator('[data-tex="\\sum_{i=1}^n"]') });
  await expect(page.locator('.text-flow-editor .boxed-text').filter({ hasText: "sum" })).toHaveCount(0);
  await expect(page.locator(".inline-math-node.editing")).toHaveCount(0);
  await expect(committed.or(page.locator(".inline-math-node"))).not.toHaveCount(0);
});

async function startBackslashCommand(page: Page): Promise<Locator> {
  await page.keyboard.press("Backslash");
  const texField = page.getByRole("dialog", { name: "TeX数式を編集" }).getByRole("textbox", { name: "TeX" });
  await expect(texField).toBeVisible();
  await texField.focus();
  await expect(texField).toBeFocused();
  await expect(texField).toHaveValue("\\");
  await texField.evaluate((element) => {
    const input = element as HTMLTextAreaElement;
    input.setSelectionRange(input.value.length, input.value.length);
  });
  return texField;
}

async function openEditor(page: Page) {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.clear();
    window.localStorage.setItem(key, value);
  }, { key: INLINE_MATH_INPUT_MODE_STORAGE_KEY, value: "tex" });
  await page.goto("/");
}

async function focusFirstFlowEditor(page: Page) {
  const flowEditor = page.locator(".text-flow-editor").first();
  await expect(flowEditor).toBeVisible();
  await flowEditor.click({ position: { x: 100, y: 20 } });
  await flowEditor.focus();
  await expect(flowEditor).toBeFocused();
  return flowEditor;
}
