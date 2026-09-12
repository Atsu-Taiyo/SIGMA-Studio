import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

type InlineMathTestInputMode = "mathlive" | "tex";

const INLINE_MATH_INPUT_MODE_STORAGE_KEY = "sigma-studio:inline-math-input-mode";

// Regression: the `\` + `\` row separator used to be spliced into the raw LaTeX using
// `mathField.position` (an atom offset) as a string index. For a field that contains a
// multi-atom node like a fraction, the atom offset and the string index diverge, so the
// `\\` landed at an unrelated spot and the caret jumped to the end. It must now insert the
// row separator exactly at the caret.
test("inserts a row separator at the caret even after a fraction atom", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, "\\frac{a}{b}");
  await editInlineMath(page, inlineMathId, "end");

  const inlineMathField = flowInlineMath(page, inlineMathId).locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();

  await page.keyboard.press("Backslash");
  await page.keyboard.press("Backslash");
  await page.keyboard.type("c");

  // The fraction stays intact and the row separator follows it (consistent with the
  // Shift+Enter line-break path, which MathLive represents as \displaylines{...}).
  // With the old splice bug, `\\` landed before the fraction instead.
  await expect.poll(() => texFieldValue(inlineMathField)).toMatch(/\\frac\{a\}\{b\}\\\\\s*c/);

  await page.keyboard.press("Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute(
    "data-tex",
    /\\frac\{a\}\{b\}\\\\\s*c/,
  );
});

// Regression: a non-letter terminator (e.g. a digit) used to neither flush nor clear a
// pending `\`-command. The command stayed pending while the digit inserted natively, so the
// stored startOffset desynced from the live caret and the eventual flush replaced the wrong
// range — swallowing the digit. The terminator must resolve the command first, then insert.
test("commits a pending backslash command before a following digit", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();

  await page.keyboard.press("Backslash");
  await page.keyboard.type("al"); // ambiguous prefix of \alpha — stays pending
  await page.keyboard.type("2"); // terminator: must resolve \alpha, then insert the digit

  await expect.poll(() => texFieldValue(inlineMathField)).toMatch(/\\alpha\s*2/);

  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.press("Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute(
    "data-tex",
    /\\alpha\s*2/,
  );
});

test("starts inline MathLive command editing when typing a backslash in body text", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Backslash");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();
  await expect(inlineMathField).toHaveAttribute("inputmode", "text");
  await expect(inlineMathField).toHaveAttribute("lang", "ja");

  await page.keyboard.type("sum");
  await expect.poll(() => texFieldValue(inlineMathField)).toMatch(/^\\sum\s*$/);

  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.press("Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute(
    "data-tex",
    /^\\sum\s*$/,
  );
  await expect(page.locator(".text-flow-editor").first()).toBeFocused();
});

test("interprets /dots as an ellipsis command", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();

  await page.keyboard.type("/dots");
  await expect.poll(() => texFieldValue(inlineMathField)).toMatch(/^\\ldots\s*$/);

  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.press("Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute("data-tex", /^\\ldots\s*$/);
});

test("keeps /x as division and commits it with the first Enter", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();
  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.type("/x");
  await page.keyboard.press("Enter");

  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute("data-tex", "/x");
  await expect(page.locator(".text-flow-editor").first()).toBeFocused();
});

test("removes an empty inline math node without deleting the previous body character", async ({ page }) => {
  await openEditor(page);

  const flowEditor = await focusFirstFlowEditor(page);
  await page.keyboard.type("A");
  const initialInlineMathCount = await page.locator(".text-flow-editor .inline-math-node").count();

  await page.keyboard.press("Control+M");
  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing");
  await expect(inlineMath).toHaveCount(1);
  const inlineMathId = await getInlineMathId(inlineMath);
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();

  await page.keyboard.press("Backspace");

  await expect(flowInlineMath(page, inlineMathId)).toHaveCount(0);
  await expect(page.locator(".text-flow-editor .inline-math-node")).toHaveCount(initialInlineMathCount);
  await expect(flowEditor).toContainText("A");
});

test("shows math input settings on toolbar hover and starts realtime editing on click", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);

  const mathButton = page.locator('[data-editor-toolbar="quick"]').first().getByRole("button", { name: "数式", exact: true });
  await expect(mathButton).toHaveAttribute("aria-expanded", "false");
  await mathButton.hover();

  const detailsDialog = page.getByRole("dialog", { name: "数式の詳細" });
  const inputModeRow = detailsDialog.locator(".inline-math-input-mode-row");
  await expect(detailsDialog).toBeVisible();
  await expect(mathButton).toHaveAttribute("aria-expanded", "true");
  await expect(inputModeRow).toBeVisible();
  await expect(inputModeRow.getByRole("button", { name: "リアルタイム表示" })).toHaveClass(/selected/);
  await expect(detailsDialog.getByLabel("数式テンプレート")).toBeVisible();

  await mathButton.click();

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const mathLiveField = inlineMath.locator("math-field.inline-math-field");
  await expect(mathLiveField).toBeFocused();
  await expect(detailsDialog).toHaveCount(0);
});

// 順列・組合せは教材で頻出だがTeXを書かないと出せなかった。ツールバーのパレットと
// `\`/`/` コマンドの両方から、TeXを一切打たずに入れられること。
test("inserts nCr from the 順列・組合せ palette without typing TeX", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  const initialIds = await inlineMathIds(page);

  const mathButton = page.locator('[data-editor-toolbar="quick"]').first().getByRole("button", { name: "数式", exact: true });
  await mathButton.hover();

  const detailsDialog = page.getByRole("dialog", { name: "数式の詳細" });
  await expect(detailsDialog).toBeVisible();
  const combinatoricsGroup = detailsDialog.locator(".inline-math-template-group").filter({ hasText: "順列・組合せ" });
  await expect(combinatoricsGroup).toHaveCount(1);
  for (const label of ["nCr", "nPr", "nHr"]) {
    await expect(combinatoricsGroup.getByRole("button", { name: new RegExp(`^${label}:`) })).toBeVisible();
  }

  await combinatoricsGroup.getByRole("button", { name: /^nCr:/ }).click();

  await expect(page.locator(".text-flow-editor .inline-math-node")).toHaveCount(initialIds.length + 1);
  const nextIds = await inlineMathIds(page);
  const inlineMathId = nextIds.find((candidate) => !initialIds.includes(candidate)) ?? "";
  expect(inlineMathId).toBeTruthy();
  const inlineMath = flowInlineMath(page, inlineMathId);
  await expect(inlineMath.locator("math-field.inline-math-field")).toBeFocused();

  // Regression: 左下の添字を `{}_{n}` と書くと、MathLiveが往復のたびに末尾へ `{}` を
  // 3個ずつ吐き足す。閉じて開くだけでTeXが伸び続けるので、`{}` は前置しない。
  await page.keyboard.press("Enter");
  await expect(inlineMath).not.toHaveClass(/editing/);
  const committedTex = String.raw`_{\placeholder{}}\mathrm{C}_{\placeholder{}}`;
  await expect(inlineMath).toHaveAttribute("data-tex", committedTex);
  await expect(inlineMath.locator(".katex-error")).toHaveCount(0);

  await editInlineMath(page, inlineMathId, "end");
  await page.keyboard.press("Enter");
  await expect(inlineMath).not.toHaveClass(/editing/);
  await expect(inlineMath).toHaveAttribute("data-tex", committedTex);
});

test("interprets /npr as a permutation command", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Control+M");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const inlineMathField = inlineMath.locator("math-field.inline-math-field");
  await expect(inlineMathField).toBeFocused();

  await page.keyboard.type("/npr");
  await expect.poll(() => texFieldValue(inlineMathField)).toMatch(/\\mathrm\{P\}/);

  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.press("Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute("data-tex", /\\mathrm\{P\}/);
});

test("focuses the placeholder square clicked in a realtime math preview", async ({ page }) => {
  await openEditor(page);

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(
    page,
    String.raw`\frac{\placeholder{}}{\placeholder{}}`,
  );
  const inlineMath = flowInlineMath(page, inlineMathId);
  const placeholderSquares = inlineMath.locator(".ML__prompt-atom");
  await expect(placeholderSquares).toHaveCount(2);
  const staticPromptAppearance = await placeholderSquares.nth(1).locator(".ML__prompt").evaluate((prompt) => {
    const style = getComputedStyle(prompt);
    return [style.outlineColor, style.outlineStyle, style.outlineWidth, style.borderRadius];
  });

  await placeholderSquares.nth(1).click();

  const mathLiveField = inlineMath.locator("math-field.inline-math-field");
  await expect(mathLiveField).toBeFocused();
  await expect.poll(() => mathLiveField.evaluate((field) => {
    const prompt = field.shadowRoot?.querySelector(".ML__focusedPromptBox");
    if (!(prompt instanceof HTMLElement)) {
      return null;
    }
    const style = getComputedStyle(prompt);
    return [style.outlineColor, style.outlineStyle, style.outlineWidth, style.borderRadius];
  })).toEqual(staticPromptAppearance);
  await page.keyboard.type("7");
  await expect.poll(() => texFieldValue(mathLiveField)).toBe(
    String.raw`\frac{\placeholder[sigma-click-0]{}}{\placeholder[sigma-click-1]{7}}`,
  );
  await page.keyboard.press("Enter");
  await expect(inlineMath).toHaveAttribute(
    "data-tex",
    String.raw`\frac{\placeholder{}}{\placeholder{7}}`,
  );
});

test("keeps TeX text runs in the surrounding body font while previewing and editing", async ({ page }) => {
  const inlineMathId = "font_math";
  await installDesktopRuntimeMock(page, styledMathDocument(inlineMathId));
  await page.goto("/");
  const inlineMath = flowInlineMath(page, inlineMathId);
  await expect(inlineMath).toBeVisible();

  const previewFontFamily = await inlineMath.evaluate((element) => getComputedStyle(element).fontFamily);
  await expect.poll(() => inlineMath.locator(".ML__text").evaluate((element) => (
    getComputedStyle(element).fontFamily
  ))).toBe(previewFontFamily);

  await editInlineMath(page, inlineMathId, "end");
  const mathLiveField = inlineMath.locator("math-field.inline-math-field");
  await expect(mathLiveField).toBeFocused();
  await expect.poll(() => mathLiveField.evaluate((field) => {
    const textRun = field.shadowRoot?.querySelector(".ML__text");
    return textRun ? getComputedStyle(textRun).fontFamily : null;
  })).toBe(previewFontFamily);
});

test("renders the Common Test choice as the same heavy vertical oval while previewing and editing", async ({ page }) => {
  const inlineMathId = "kyoutsuu_choice_math";
  await installDesktopRuntimeMock(page, kyoutsuuChoiceDocument(inlineMathId));
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const inlineMath = flowInlineMath(page, inlineMathId);
  await expect(inlineMath).toBeVisible();

  const previewChoice = inlineMath.locator(".sigma-kyoutsuu-choice");
  await expect(previewChoice).toHaveCount(1);
  const previewMetrics = await previewChoice.evaluate(choiceMarkerMetrics);
  expect(previewMetrics.aspectRatio).toBeGreaterThan(1.35);
  expect(previewMetrics.aspectRatio).toBeLessThan(1.5);
  expect(previewMetrics.borderWidth).toBeGreaterThanOrEqual(2);
  expect(previewMetrics.display).toBe("inline-flex");
  expect(previewMetrics.fontWeight).toBe("700");
  expect(previewMetrics.verticalAlignEm).toBeCloseTo(0.14, 2);

  const previewAlignment = await inlineMath.evaluate(kyoutsuuChoiceBodyAlignment);
  expect(previewAlignment.glyphHeight).toBeGreaterThan(0);
  expect(Math.abs(previewAlignment.deltaMid)).toBeLessThan(2);

  await editInlineMath(page, inlineMathId, "end");
  const mathLiveField = inlineMath.locator("math-field.inline-math-field");
  await expect(mathLiveField).toBeFocused();
  await expect.poll(() => mathLiveField.evaluate((field) => (
    Boolean(field.shadowRoot?.querySelector(".sigma-kyoutsuu-choice"))
  ))).toBe(true);

  const resolvedEditingMetrics = await mathLiveField.evaluate((field) => {
    const choice = field.shadowRoot?.querySelector<HTMLElement>(".sigma-kyoutsuu-choice");
    if (!choice) throw new Error("Common Test choice marker was not rendered in MathLive");
    const style = getComputedStyle(choice);
    const bounds = choice.getBoundingClientRect();
    const styleCount = field.shadowRoot?.querySelectorAll("style[data-sigma-math-macro-styles]").length ?? 0;
    return {
      aspectRatio: bounds.height / bounds.width,
      borderWidth: Number.parseFloat(style.borderTopWidth),
      display: style.display,
      fontWeight: style.fontWeight,
      styleCount,
    };
  });
  expect(resolvedEditingMetrics.aspectRatio).toBeGreaterThan(1.35);
  expect(resolvedEditingMetrics.aspectRatio).toBeLessThan(1.5);
  expect(resolvedEditingMetrics.borderWidth).toBeGreaterThanOrEqual(2);
  expect(resolvedEditingMetrics.display).toBe("inline-flex");
  expect(resolvedEditingMetrics.fontWeight).toBe("700");
  expect(resolvedEditingMetrics.styleCount).toBe(1);
});

test("focuses the TeX dialog when the toolbar button is clicked in TeX mode", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);

  const mathButton = page.locator('[data-editor-toolbar="quick"]').first().getByRole("button", { name: "数式", exact: true });
  await mathButton.hover();

  const detailsDialog = page.getByRole("dialog", { name: "数式の詳細" });
  const inputModeRow = detailsDialog.locator(".inline-math-input-mode-row");
  await expect(inputModeRow.getByRole("button", { name: "TeX", exact: true })).toHaveClass(/selected/);

  await mathButton.click();

  const texField = inlineMathTexField(page);
  await expect(texField).toBeVisible();
  await expect(texField).toBeFocused();
  await expect(texField).toHaveAttribute("autocomplete", "off");
  await page.keyboard.type(String.raw`A+\al`);
  await expect(texField).toHaveValue(String.raw`A+\al`);

  await page.keyboard.press("Control+Enter");
  const inlineMath = page.locator(".text-flow-editor .inline-math-node").first();
  await expect(inlineMath).toHaveAttribute("data-tex", String.raw`A+\al`);
});

test("copies only the selected TeX text without routing the click to the body", async ({ page }) => {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, String.raw`\frac{12}{34}`);
  await editInlineMath(page, inlineMathId, "end");
  const texField = inlineMathTexField(page);
  await expect(texField).toBeFocused();

  await page.evaluate(() => {
    (window as typeof window & { __texClickReachedWindow?: boolean }).__texClickReachedWindow = false;
    window.addEventListener("click", () => {
      (window as typeof window & { __texClickReachedWindow?: boolean }).__texClickReachedWindow = true;
    }, { once: true });
  });
  await texField.click();
  await expect.poll(() => page.evaluate(() => (
    (window as typeof window & { __texClickReachedWindow?: boolean }).__texClickReachedWindow
  ))).toBe(false);

  await texField.evaluate((element) => {
    (element as HTMLTextAreaElement).setSelectionRange(1, 5);
  });
  await texField.press(process.platform === "darwin" ? "Meta+C" : "Control+C");
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("frac");
});

test("shows a live preview with TeX code and closes from completion or an outside click", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, "x^2");
  await editInlineMath(page, inlineMathId, "end");

  const popover = inlineMathTexPopover(page);
  const texField = inlineMathTexField(page);
  const livePreview = flowInlineMath(page, inlineMathId).locator(".inline-math-tex-live-preview");
  await expect(popover).toBeVisible();
  await texField.focus();
  await expect(texField).toBeFocused();
  await expect.poll(() => texField.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px");
  await expect.poll(() => texField.evaluate((element) => element.tagName)).toBe("TEXTAREA");
  await expect(livePreview).toBeVisible();
  await expect(livePreview).toHaveAttribute("data-tex", "x^2");

  await texField.fill("\\frac{1}{2}");
  await texField.press("Enter");
  await texField.type("+x");
  await expect(texField).toHaveValue("\\frac{1}{2}\n+x");
  await expect(livePreview).toHaveAttribute("data-tex", "\\frac{1}{2}\n+x");
  const recognizedCommand = popover.locator(".inline-math-tex-command-recognized");
  await expect(recognizedCommand).toHaveText("\\frac");
  await expect.poll(() => recognizedCommand.evaluate((element) => (
    getComputedStyle(element).color !== getComputedStyle(element.parentElement!).color
  ))).toBe(true);
  await expect.poll(() => recognizedCommand.evaluate((element) => (
    getComputedStyle(element).fontWeight === getComputedStyle(element.parentElement!).fontWeight
  ))).toBe(true);
  await expect.poll(() => popover.evaluate((element) => {
    const textarea = element.querySelector<HTMLTextAreaElement>(".inline-math-tex-field");
    const highlight = element.querySelector<HTMLElement>(".inline-math-tex-highlight");
    if (!textarea || !highlight) {
      return false;
    }
    const textareaStyle = getComputedStyle(textarea);
    const highlightStyle = getComputedStyle(highlight);
    return textareaStyle.fontFamily === highlightStyle.fontFamily &&
      textareaStyle.fontSize === highlightStyle.fontSize &&
      textareaStyle.fontWeight === highlightStyle.fontWeight &&
      textareaStyle.letterSpacing === highlightStyle.letterSpacing &&
      textareaStyle.lineHeight === highlightStyle.lineHeight &&
      textareaStyle.paddingLeft === highlightStyle.paddingLeft &&
      textareaStyle.paddingTop === highlightStyle.paddingTop;
  })).toBe(true);
  const doneButton = popover.getByRole("button", { name: "完了" });
  await expect(doneButton).toHaveClass(/ai-proposal-decision-button--apply/);
  await expect.poll(() => doneButton.evaluate((element) => getComputedStyle(element).borderRadius)).toBe("50%");
  await expect.poll(() => doneButton.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return Math.abs(rect.width - rect.height);
  })).toBeLessThan(0.5);
  await doneButton.click();
  await expect(popover).toHaveCount(0);
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute("data-tex", "\\frac{1}{2}\n+x");

  await editInlineMath(page, inlineMathId, "end");
  await inlineMathTexField(page).fill("x^3");
  await page.locator(".editor-menubar").click({ position: { x: 4, y: 4 } });
  await expect(inlineMathTexPopover(page)).toHaveCount(0);
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute("data-tex", "x^3");
});

test("grows the TeX editor with long input before falling back to internal scrolling", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  const fittingTex = Array.from({ length: 12 }, (_, index) => `x_{${index}}`).join("\n");
  const inlineMathId = await insertInlineMathByEvent(page, fittingTex);
  await editInlineMath(page, inlineMathId, "end");

  const texField = inlineMathTexField(page);
  // 既存の長い数式を開いただけで高さが合い、1文字入力する必要がない。
  await expect.poll(() => texField.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return {
      grewOnOpen: textarea.getBoundingClientRect().height > 68,
      hasNoInternalOverflow: textarea.clientHeight >= textarea.scrollHeight,
      value: textarea.value,
    };
  })).toEqual({
    grewOnOpen: true,
    hasNoInternalOverflow: true,
    value: fittingTex,
  });

  const overflowingTex = Array.from({ length: 80 }, (_, index) => `x_{${index}}`).join("\n");
  await texField.fill(overflowingTex);
  await expect.poll(() => texField.evaluate((element) => {
    const textarea = element as HTMLTextAreaElement;
    return {
      cappedToViewport: textarea.getBoundingClientRect().height <= window.innerHeight - 47,
      internallyScrollable: textarea.scrollHeight > textarea.clientHeight,
      selectionAtEnd: textarea.selectionStart === textarea.value.length && textarea.selectionEnd === textarea.value.length,
    };
  })).toEqual({
    cappedToViewport: true,
    internallyScrollable: true,
    selectionAtEnd: true,
  });
});

test("renders KaTeX-only commands in the TeX editor and committed formula", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, "x^2");
  await editInlineMath(page, inlineMathId, "end");

  const tex = String.raw`\begin{array}{c}a\\\hline b\end{array}+\dots`;
  const texField = inlineMathTexField(page);
  const livePreview = flowInlineMath(page, inlineMathId).locator(".inline-math-tex-live-preview");
  await texField.fill(tex);

  await expect(livePreview.locator(".katex")).toHaveCount(1);
  await expect(livePreview.locator(".hline")).toHaveCount(1);
  await expect(livePreview.locator(".katex-error")).toHaveCount(0);
  await expect(livePreview).toContainText("…");

  await inlineMathTexPopover(page).getByRole("button", { name: "完了" }).click();
  const committed = flowInlineMath(page, inlineMathId);
  await expect(committed).toHaveAttribute(
    "data-tex",
    String.raw`\begin{array}{c}a\\\hline b\end{array}+\ldots`,
  );
  await expect(committed.locator(".katex .hline")).toHaveCount(1);
  await expect(committed).toContainText("…");
});

test("opens the math command dialog from the TeX editor three-dot button", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  const inlineMathId = await insertInlineMathByEvent(page, "x^2");
  await editInlineMath(page, inlineMathId, "end");

  const popover = inlineMathTexPopover(page);
  const texField = inlineMathTexField(page);
  const commandButton = popover.getByRole("button", { name: "数式コマンドを表示" });
  const doneButton = popover.getByRole("button", { name: "完了" });
  await expect(commandButton).toBeVisible();
  const [buttonBox, doneButtonBox, fieldBox] = await Promise.all([
    commandButton.boundingBox(),
    doneButton.boundingBox(),
    texField.boundingBox(),
  ]);
  expect(buttonBox).not.toBeNull();
  expect(doneButtonBox).not.toBeNull();
  expect(fieldBox).not.toBeNull();
  expect(buttonBox!.x).toBeGreaterThan(fieldBox!.x + fieldBox!.width);
  expect(Math.abs(buttonBox!.x - doneButtonBox!.x)).toBeLessThan(0.5);
  expect(Math.abs(buttonBox!.y - fieldBox!.y)).toBeLessThan(0.5);
  expect(doneButtonBox!.y).toBeGreaterThan(buttonBox!.y + buttonBox!.height);
  expect(Math.abs(doneButtonBox!.y + doneButtonBox!.height - fieldBox!.y - fieldBox!.height)).toBeLessThan(0.5);

  await commandButton.click();
  const commandDialog = page.getByRole("dialog", { name: "数式コマンド確認" });
  await expect(commandDialog).toBeVisible();
  await expect(commandDialog.getByRole("searchbox", { name: "TeXコマンドを検索" })).toBeFocused();

  await commandDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(commandDialog).toBeHidden();
  await expect(popover).toBeVisible();
  await expect(texField).toBeFocused();
});

test("starts inline TeX editing when typing a backslash in body text in TeX mode", async ({ page }) => {
  await openEditor(page, "tex");

  await focusFirstFlowEditor(page);
  await page.keyboard.press("Backslash");

  const inlineMath = page.locator(".text-flow-editor .inline-math-node.editing").first();
  const texField = inlineMathTexField(page);
  await expect(texField).toBeVisible();
  await expect(texField).toBeFocused();
  await expect(texField).toHaveAttribute("inputmode", "text");
  await expect(texField).toHaveAttribute("lang", "ja");
  await expect(texField).toHaveValue("\\");
  // The dialog must open with the caret *after* the seeded `\`. It used to sit at offset 0 (the
  // popover mounts its textarea a render late, and React's `autoFocus` on that fresh element puts
  // the caret at the start), so everything the author typed landed in front of the backslash and
  // `\` + `sum` produced `sum\`. This test used to hide that by repositioning the caret by hand.
  await expect.poll(() => texField.evaluate((element) => [
    (element as HTMLTextAreaElement).selectionStart,
    (element as HTMLTextAreaElement).selectionEnd,
  ])).toEqual([1, 1]);

  await page.keyboard.type("sum_{i=1}^n");
  await expect(texField).toHaveValue("\\sum_{i=1}^n");

  const inlineMathId = await getInlineMathId(inlineMath);
  await page.keyboard.press("Control+Enter");
  await expect(flowInlineMath(page, inlineMathId)).toHaveAttribute(
    "data-tex",
    "\\sum_{i=1}^n",
  );
  await expect(inlineMathTexPopover(page)).toHaveCount(0);
  await expect(flowInlineMath(page, inlineMathId).locator(".math-preview")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.activeElement?.tagName ?? null)).toBe("BODY");
});

async function openEditor(page: Page, mode: InlineMathTestInputMode = "mathlive") {
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
  return flowEditor;
}

async function texFieldValue(field: Locator) {
  return field.evaluate((element) => (element as unknown as { value: string }).value);
}

async function editInlineMath(page: Page, id: string | null, edge: "end" | "start") {
  expect(id).toBeTruthy();
  await page.evaluate(({ cursorPosition, inlineMathId }) => {
    window.dispatchEvent(new CustomEvent("sigma-studio:edit-inline-math", {
      detail: { cursorPosition, id: inlineMathId },
    }));
  }, { cursorPosition: edge, inlineMathId: id });
}

async function getInlineMathId(inlineMath: Locator) {
  const id = await inlineMath.getAttribute("data-id");
  expect(id).toBeTruthy();
  return id ?? "";
}

async function insertInlineMathByEvent(page: Page, tex: string) {
  const initialIds = await inlineMathIds(page);
  await page.evaluate((nextTex) => {
    window.dispatchEvent(new CustomEvent("sigma-studio:insert-inline-math", {
      detail: { edit: false, target: "document", tex: nextTex },
    }));
  }, tex);
  await expect(page.locator(".text-flow-editor .inline-math-node")).toHaveCount(initialIds.length + 1);

  const nextIds = await inlineMathIds(page);
  const id = nextIds.find((candidate) => !initialIds.includes(candidate));
  expect(id).toBeTruthy();

  const inlineMath = flowInlineMath(page, id ?? "");
  await expect(inlineMath).toHaveAttribute("data-tex", tex);
  return id ?? "";
}

async function inlineMathIds(page: Page) {
  return page.locator(".text-flow-editor .inline-math-node").evaluateAll((nodes) => (
    nodes
      .map((node) => node.getAttribute("data-id"))
      .filter((id): id is string => Boolean(id))
  ));
}

function flowInlineMath(page: Page, id: string) {
  return page.locator(`.text-flow-editor .inline-math-node[data-id="${id}"]`);
}

function inlineMathTexPopover(page: Page) {
  return page.getByRole("dialog", { name: "TeX数式を編集" });
}

function inlineMathTexField(page: Page) {
  return inlineMathTexPopover(page).getByRole("textbox", { name: "TeX" });
}

function styledMathDocument(inlineMathId: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "inline_math_text_font_e2e_doc",
    metadata: { title: "TeX text font E2E" },
    content: [{
      id: "font_paragraph",
      type: "paragraph",
      children: [{
        type: "mathInline",
        id: inlineMathId,
        tex: String.raw`x+\text{本文}`,
        display: "inline",
        fontFamily: '"Courier New", monospace',
      }],
    }],
    outputProfiles: {
      answerBook: {},
      student: {},
      teacher: {},
    },
  };
}

function kyoutsuuChoiceDocument(inlineMathId: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "kyoutsuu_choice_e2e_doc",
    metadata: { title: "共通テスト選択肢 E2E" },
    content: [{
      id: "kyoutsuu_choice_paragraph",
      type: "paragraph",
      children: [
        { type: "text", text: "次の" },
        {
          type: "mathInline",
          id: inlineMathId,
          tex: String.raw`\kyoutsuuchoice{0}`,
          display: "inline",
        },
        { type: "text", text: "に当てはまるものは" },
      ],
    }],
    outputProfiles: {
      answerBook: {},
      student: {},
      teacher: {},
    },
  };
}

function choiceMarkerMetrics(choice: HTMLElement) {
  const style = getComputedStyle(choice);
  const bounds = choice.getBoundingClientRect();
  const fontSize = Number.parseFloat(style.fontSize);
  return {
    aspectRatio: bounds.height / bounds.width,
    borderWidth: Number.parseFloat(style.borderTopWidth),
    display: style.display,
    fontWeight: style.fontWeight,
    verticalAlignEm: fontSize === 0 ? 0 : Number.parseFloat(style.verticalAlign) / fontSize,
  };
}

function kyoutsuuChoiceBodyAlignment(math: Element) {
  const root = math.closest("[data-sigma-doc-id]") ?? math.parentElement ?? math;
  const choice = root.querySelector(".sigma-kyoutsuu-choice");
  if (!choice) {
    throw new Error("Common Test choice marker was not rendered next to body text");
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let textNode: Text | null = null;
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (node.data.includes("次")) {
      textNode = node;
      break;
    }
  }
  if (!textNode) {
    throw new Error("Japanese body text next to the Common Test choice marker was not found");
  }
  const index = textNode.data.indexOf("次");
  const range = document.createRange();
  range.setStart(textNode, index);
  range.setEnd(textNode, index + 1);
  const glyph = range.getBoundingClientRect();
  const oval = choice.getBoundingClientRect();
  return {
    deltaMid: (oval.top + oval.bottom) / 2 - (glyph.top + glyph.bottom) / 2,
    glyphHeight: glyph.height,
  };
}
