import { expect, test, type Locator, type Page } from "@playwright/test";

// 数式の入力欄 (本文・図形内テキスト共通の MathLive) のキー入力:
// - 分数は分母から入れる (Ctrl+/・本文から押した Ctrl+/・数式パレット)
// - 上付きと下付きの両方を持つ原子 (∫・Σ・x_1^2) では ↓/↑ で上下の枠を行き来する
// - 全角で確定した英数・記号は半角にして入れる

async function openEditor(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
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

function editingField(page: Page) {
  return page.locator(".text-flow-editor .inline-math-node.editing math-field.inline-math-field").first();
}

async function enterMath(page: Page) {
  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");
  const field = editingField(page);
  await expect(field).toBeFocused();
  return field;
}

async function value(field: Locator) {
  return field.evaluate((element) => (element as unknown as { value: string }).value);
}

async function selectedLatex(field: Locator) {
  return field.evaluate((element) => {
    const input = element as unknown as { getValue: (selection: unknown) => string; selection: unknown };
    return input.getValue(input.selection);
  });
}

test.describe("fractions start in the denominator", () => {
  test("Ctrl+/ inside math types into the denominator, and ArrowUp reaches the numerator", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.press("Control+/");
    await expect.poll(() => selectedLatex(field)).toBe(String.raw`\placeholder{}`);
    await page.keyboard.type("2");
    await expect.poll(() => value(field)).toBe(String.raw`\frac{\placeholder{}}{2}`);

    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("1");
    await expect.poll(() => value(field)).toBe(String.raw`\frac12`);
  });

  test("Ctrl+/ pressed in body text gives exactly the result of pressing it inside math", async ({ page }) => {
    await openEditor(page);
    await focusFirstFlowEditor(page);

    // 本文から押して、待たずに打つ (入力欄が焦点を取るまでの打鍵は預かって流す)。
    await page.keyboard.press("Control+/");
    await page.keyboard.type("2");
    const field = editingField(page);
    await expect.poll(() => value(field)).toBe(String.raw`\frac{\placeholder{}}{2}`);
    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("1");
    await expect.poll(() => value(field)).toBe(String.raw`\frac12`);
    await page.keyboard.press("Enter");
    await expect(page.locator(".text-flow-editor .inline-math-node").first()).toHaveAttribute("data-tex", String.raw`\frac12`);
  });

  test("the math palette's fraction starts in the denominator as well", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);
    await page.keyboard.type("a");

    await page.getByRole("button", { name: "数式", exact: true }).first().hover();
    const fraction = page.locator('.inline-math-template-button[aria-label*="fraction"]').first();
    await fraction.click();
    await expect(field).toBeFocused();
    await page.keyboard.type("x");
    await expect.poll(() => value(field)).toBe(String.raw`a\frac{\placeholder{}}{x}`);
  });

  test("other templates still start in their first blank", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.press("Control+Alt+r");
    await page.keyboard.type("3");
    await expect.poll(() => value(field)).toBe(String.raw`\sqrt[3]{\placeholder{}}`);
  });
});

test.describe("ArrowDown and ArrowUp between the limits", () => {
  test("a definite integral: ArrowUp/ArrowDown go to the other limit, at its end", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.press("Control+Alt+i");
    await page.keyboard.type("0");
    await page.keyboard.press("ArrowUp");
    await expect.poll(() => selectedLatex(field)).toBe(String.raw`\placeholder{}`);
    await page.keyboard.type("1");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("2");
    await expect.poll(() => value(field)).toBe(String.raw`\int_{02}^1\placeholder{}`);

    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("3");
    await expect.poll(() => value(field)).toBe(String.raw`\int_{02}^{13}\placeholder{}`);
  });

  test("a sum, and a selection inside the upper limit", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.press("Control+g");
    await page.keyboard.type("k=1");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("nm");
    await expect.poll(() => value(field)).toBe(String.raw`\sum_{k=1}^{nm}\placeholder{}`);

    // 範囲を選んだまま ↓: 右端を基準に下端の末尾へ。
    await page.keyboard.press("Shift+ArrowLeft");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.type("0");
    await expect.poll(() => value(field)).toBe(String.raw`\sum_{k=10}^{nm}\placeholder{}`);
  });

  test("a single script and the fractions keep MathLive's own behaviour", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.type("x^2");
    await expect.poll(() => value(field)).toBe("x^2");
    await page.keyboard.press("ArrowDown");
    // 下付きは無いので、キャレットは上付きの中のまま。
    await page.keyboard.type("3");
    await expect.poll(() => value(field)).toBe("x^{23}");

    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Control+/");
    await page.keyboard.type("b");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.type("a");
    await expect.poll(() => value(field)).toBe(String.raw`x^{23}\frac{a}{b}`);
  });
});

test.describe("full-width characters are committed as half-width", () => {
  test("a direct full-width input becomes x+1 and is saved as x+1", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);

    await page.keyboard.insertText("ｘ＋１");
    await expect.poll(() => value(field)).toBe("x+1");
    await page.keyboard.insertText("　ｙ");
    await expect.poll(() => value(field)).toMatch(/^x\+1\\ ?y$/);

    await page.keyboard.press("Enter");
    await expect(page.locator(".text-flow-editor .inline-math-node").first()).toHaveAttribute("data-tex", /^x\+1\\ ?y$/);
  });

  test("a committed IME composition becomes half-width, and kana/kanji stay as they are", async ({ page }) => {
    await openEditor(page);
    const field = await enterMath(page);
    const ime = await page.context().newCDPSession(page);

    // 変換中の文字はそのまま (IME のもの)。確定した文字だけが半角になる。
    await ime.send("Input.imeSetComposition", { text: "ｘ＝２", selectionStart: 3, selectionEnd: 3 });
    await ime.send("Input.insertText", { text: "ｘ＝２" });
    await expect.poll(() => value(field)).toBe("x=2");

    await ime.send("Input.imeSetComposition", { text: "かん", selectionStart: 2, selectionEnd: 2 });
    await ime.send("Input.insertText", { text: "漢" });
    await expect.poll(() => value(field)).toMatch(/^x=2.*\\text\{漢\}/);
  });
});
