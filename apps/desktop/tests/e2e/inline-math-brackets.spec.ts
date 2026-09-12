import { expect, test, type Locator, type Page } from "@playwright/test";

const INLINE_MATH_INPUT_MODE_STORAGE_KEY = "sigma-studio:inline-math-input-mode";

// 数式入力では開き括弧を打った時点で閉じ括弧も入る。MathLive 側 (WYSIWYG) はライブラリの
// smartFence が担い、TeX ソース欄 (textarea) は `lib/tex-bracket-pairs` が担う。両方の面で
// 同じ体験になっていることを固定する。

test("closes the fence as soon as an opening bracket is typed in the MathLive field", async ({ page }) => {
  await openEditor(page, "mathlive");
  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const field = editingMathLiveField(page);
  await expect(field).toBeFocused();

  await page.keyboard.type("2x(");
  await expect.poll(() => fieldValue(field)).toBe(String.raw`2x\left(\right)`);

  // 閉じ括弧は「仮」の薄い表示ではなく、打った文字と同じ濃さで出す。
  await expect.poll(() => field.evaluate((element) => {
    const close = element.shadowRoot?.querySelector(".ML__smart-fence__close");
    return close ? getComputedStyle(close).opacity : null;
  })).toBe("1");

  await page.keyboard.type("x+1");
  await expect.poll(() => fieldValue(field)).toBe(String.raw`2x\left(x+1\right)`);

  await page.keyboard.type("{");
  await expect.poll(() => fieldValue(field)).toBe(String.raw`2x\left(x+1\left\lbrace\right\rbrace\right)`);
});

test("pairs, skips and deletes brackets in the TeX source field", async ({ page }) => {
  await openEditor(page, "tex");
  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const texField = inlineMathTexField(page);
  await expect(texField).toBeFocused();

  // 開き括弧 → 対で入り、キャレットは間。
  await page.keyboard.type("(");
  await expect(texField).toHaveValue("()");
  await expect.poll(() => caret(texField)).toEqual([1, 1]);

  await page.keyboard.type("x+1");
  await expect(texField).toHaveValue("(x+1)");

  // 閉じ括弧は二重に入らず、既にある `)` を飛び越す。
  await page.keyboard.type(")");
  await expect(texField).toHaveValue("(x+1)");
  await expect.poll(() => caret(texField)).toEqual([5, 5]);

  // `{` も同じ。
  await page.keyboard.type("\\frac{");
  await expect(texField).toHaveValue("(x+1)\\frac{}");
  await expect.poll(() => caret(texField)).toEqual([11, 11]);

  // 空の対の中で Backspace → 両方消える。
  await page.keyboard.press("Backspace");
  await expect(texField).toHaveValue("(x+1)\\frac");

  // TeX上の表示用波括弧は、開閉ともバックスラッシュ付きで対にする。
  await page.keyboard.type("\\{");
  await expect(texField).toHaveValue(String.raw`(x+1)\frac\{\}`);
  await expect.poll(() => caret(texField)).toEqual([12, 12]);

  // 空の `\{\}` は Backspace 1回で対ごと削除できる。
  await page.keyboard.press("Backspace");
  await expect(texField).toHaveValue("(x+1)\\frac");

  await page.keyboard.type("\\{x}");
  await expect(texField).toHaveValue(String.raw`(x+1)\frac\{x\}`);
  await expect.poll(() => caret(texField)).toEqual([15, 15]);
});

test("wraps the selected TeX in brackets", async ({ page }) => {
  await openEditor(page, "tex");
  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, "x+1");
  await editInlineMath(page, inlineMathId, "end");

  const texField = inlineMathTexField(page);
  await expect(texField).toBeFocused();
  await texField.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(0, 3);
  });

  await page.keyboard.type("(");
  await expect(texField).toHaveValue("(x+1)");
  // 囲んだ中身は選択されたまま残る。
  await expect.poll(() => caret(texField)).toEqual([1, 4]);
});

async function openEditor(page: Page, mode: "mathlive" | "tex") {
  await page.addInitScript(({ key, value }) => {
    window.localStorage.clear();
    if (value !== "mathlive") {
      window.localStorage.setItem(key, value);
    }
  }, { key: INLINE_MATH_INPUT_MODE_STORAGE_KEY, value: mode });
  await page.goto("/");
}

async function focusFirstFlowEditor(page: Page) {
  const flowEditor = page.locator(".text-flow-editor").first();
  await expect(flowEditor).toBeVisible();
  await flowEditor.click({ position: { x: 100, y: 20 } });
  await flowEditor.focus();
  await expect(flowEditor).toBeFocused();
}

function editingMathLiveField(page: Page) {
  return page.locator(".text-flow-editor .inline-math-node.editing math-field.inline-math-field");
}

function inlineMathTexField(page: Page) {
  return page.locator("textarea.inline-math-tex-field");
}

async function fieldValue(field: Locator) {
  return field.evaluate((element) => (element as unknown as { value: string }).value);
}

async function caret(field: Locator) {
  return field.evaluate((element) => [
    (element as HTMLTextAreaElement).selectionStart,
    (element as HTMLTextAreaElement).selectionEnd,
  ]);
}

async function editInlineMath(page: Page, id: string, edge: "end" | "start") {
  await page.evaluate(({ cursorPosition, inlineMathId }) => {
    window.dispatchEvent(new CustomEvent("sigma-studio:edit-inline-math", {
      detail: { cursorPosition, id: inlineMathId },
    }));
  }, { cursorPosition: edge, inlineMathId: id });
}

async function insertInlineMathByEvent(page: Page, tex: string) {
  await page.evaluate((nextTex) => {
    window.dispatchEvent(new CustomEvent("sigma-studio:insert-inline-math", {
      detail: { edit: false, target: "document", tex: nextTex },
    }));
  }, tex);
  const inlineMath = page.locator(".text-flow-editor .inline-math-node").first();
  await expect(inlineMath).toHaveAttribute("data-tex", tex);
  const id = await inlineMath.getAttribute("data-id");
  expect(id).toBeTruthy();
  return id ?? "";
}
