import { generateText, getSchema } from "@tiptap/core";
import { EditorState, NodeSelection, TextSelection } from "@tiptap/pm/state";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  InlineMathExtension,
  createInlineMathTexFromMathKeyboardShortcut,
  createInlineMathSelectionDecorations,
  extractSingleInlineMathText,
  focusInlineMathPlaceholder,
  getInlineMathDragSelectionAnchor,
  getInlineMathKeyboardCursorPosition,
  getInlineMathLatexCommandTrigger,
  getInlineMathPlaceholderIndexAtPoint,
  getInlineMathShiftDigit7Text,
  hasInlineMathEditGuardDecoration,
  hasInlineMathLatexCommandCandidate,
  normalizeInlineMathLatexAliases,
  normalizeInlineMathLineBreakInput,
  normalizeInlineMathTexLiteralInput,
  insertInlineMathTexAtSelection,
  removeInlineMathClickPlaceholderIds,
  unwrapFilledInlineMathPlaceholders,
  restoreDesktopInputSource,
  requestDesktopAsciiInputSource,
  insertMathKeyboardShortcutInlineMathAtSelection,
  resolveInlineMathArrowEdgeAction,
  resolveInlineMathLatexCommand,
  shouldCommitInlineMathOnKeyDown,
  shouldCommitInlineMathTexOnKeyDown,
  renderMathHtml,
  shouldDeleteBeforeInlineMathOnBackspace,
  shouldExitInlineMathOnArrowLeft,
  shouldExitInlineMathOnArrowRight,
  shouldInsertInlineMathLineBreak,
  shouldStartInlineMathOnBackslash,
} from "@/components/tiptap/inline-math-extension";
import { MATH_KEYBOARD_SHORTCUTS, getMathKeyboardMathShortcut } from "@/lib/math-keyboard-shortcuts";
import { toInlineMathTypeAheadKey } from "@/components/tiptap/inline-math-type-ahead";
import type { TiptapDoc } from "@/lib/tiptap-adapter";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

const extensions = [StarterKit, InlineMathExtension];

describe("math tiptap extensions", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders inline math through MathLive markup", () => {
    expect(renderMathHtml("x^2", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__latex");
    expect(renderMathHtml("x\\iff y", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("⟺");
    expect(renderMathHtml("x=高さ", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__text");
    expect(renderMathHtml("\\placeholder{}", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__prompt");
    expect(renderMathHtml("x=1\\\\y=2", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__mtable");
    expect(renderMathHtml("\\displaylines{x=1\\\\y=2}", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__mtable");
    expect(renderMathHtml("\\begin{aligned}x&=1\\\\y&=2\\end{aligned}", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__mtable");
    expect(renderMathHtml("x\\iff y", DEFAULT_MATH_RENDER_ENVIRONMENT)).not.toContain("ML__error");
  });

  it("maps a click on a rendered square to its placeholder ordinal", () => {
    const placeholder = (left: number, top: number) => ({
      getBoundingClientRect: () => ({ bottom: top + 20, left, right: left + 20, top }),
    });
    const preview = {
      querySelectorAll: () => [placeholder(10, 10), placeholder(40, 30)],
    } as unknown as Element;

    expect(getInlineMathPlaceholderIndexAtPoint(preview, 50, 40)).toBe(1);
    expect(getInlineMathPlaceholderIndexAtPoint(preview, 35, 20)).toBeNull();
  });

  it("selects the clicked placeholder itself, without turning blanks into prompts", () => {
    // \frac{\placeholder{}}{x+\placeholder[answer]{}} を MathLive が原子ごとに返す値。
    const atoms = ["", "\\placeholder{}", "", "x", "+", "\\placeholder[answer]{}", "\\frac{\\placeholder{}}{x+\\placeholder[answer]{}}"];
    const mathField = {
      getPromptRange: (id: string) => id === "answer" ? [5, 5] : null,
      getValue: (start: number, end: number) => end === start + 1 ? atoms[end] : "",
      lastOffset: atoms.length - 1,
      selection: 0 as unknown,
    };

    expect(focusInlineMathPlaceholder(mathField as never, 0)).toBe(true);
    expect(mathField.selection).toEqual({ direction: "forward", ranges: [[0, 1]] });
    expect(focusInlineMathPlaceholder(mathField as never, 1)).toBe(true);
    expect(mathField.selection).toEqual([5, 5]);
    expect(focusInlineMathPlaceholder(mathField as never, 2)).toBe(false);
  });

  it("keeps a TeX-mode shortcut command separate from the next letter", () => {
    expect(insertInlineMathTexAtSelection("a", 1, 1, String.raw`\pi`)).toEqual({ cursor: 5, tex: String.raw`a\pi ` });
    expect(insertInlineMathTexAtSelection("", 0, 0, String.raw`\sin #?`)).toEqual({ cursor: 5, tex: String.raw`\sin ` });
    expect(insertInlineMathTexAtSelection("", 0, 0, String.raw`\frac{#?}{#?}`)).toEqual({ cursor: 6, tex: String.raw`\frac{}{}` });
    expect(insertInlineMathTexAtSelection("", 0, 0, String.raw`^{\circ}`)).toEqual({ cursor: 8, tex: String.raw`^{\circ}` });
  });

  it("turns blanks that 0.511.0 saved with typed content back into plain groups", () => {
    expect(unwrapFilledInlineMathPlaceholders(String.raw`\log\placeholder{x}`)).toBe(String.raw`\log{x}`);
    expect(unwrapFilledInlineMathPlaceholders(String.raw`\frac{\placeholder{12}}{\placeholder{}}`)).toBe(String.raw`\frac{{12}}{\placeholder{}}`);
    expect(unwrapFilledInlineMathPlaceholders(String.raw`\placeholder{\frac{a}{\placeholder{b}}}+\placeholder[answer]{c}`))
      .toBe(String.raw`{\frac{a}{{b}}}+\placeholder[answer]{c}`);
    expect(unwrapFilledInlineMathPlaceholders(String.raw`\sqrt{\placeholder{ }}`)).toBe(String.raw`\sqrt{\placeholder{}}`);
    expect(unwrapFilledInlineMathPlaceholders(String.raw`\placeholder{x`)).toBe(String.raw`\placeholder{x`);
  });

  it("drops temporary placeholder ids left by older builds on commit", () => {
    expect(removeInlineMathClickPlaceholderIds(String.raw`\frac{\placeholder[sigma-click-0]{}}{\placeholder[answer]{}}`)).toBe(
      String.raw`\frac{\placeholder{}}{\placeholder[answer]{}}`,
    );
  });

  it("keeps TeX delimiters in plain text output", () => {
    const doc: TiptapDoc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "mathInline", attrs: { id: "inline_1", tex: "x^2" } },
            { type: "mathInline", attrs: { id: "inline_2", tex: "x=1\\\\y=2" } },
          ],
        },
      ],
    };

    expect(generateText(doc, extensions)).toContain("$x^2$");
    expect(generateText(doc, extensions)).toContain("$x=1\\\\y=2$");
  });

  it("decorates inline math when it is included in a body text selection", () => {
    const schema = getSchema(extensions);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [
        schema.text("a"),
        schema.nodes.mathInline.create({ id: "inline_1", tex: "x^2" }),
        schema.text("b"),
      ]),
    ]);

    const textSelectionDecorations = createInlineMathSelectionDecorations(doc, TextSelection.create(doc, 1, 4)).find();
    expect(textSelectionDecorations).toHaveLength(1);
    expect(textSelectionDecorations[0].from).toBe(2);
    expect(textSelectionDecorations[0].to).toBe(3);

    expect(createInlineMathSelectionDecorations(doc, TextSelection.create(doc, 1, 2)).find()).toHaveLength(0);
    expect(createInlineMathSelectionDecorations(doc, NodeSelection.create(doc, 2)).find()).toHaveLength(1);
  });

  it("refuses inline-math edit entry when a generic edit guard decorates the atom", () => {
    expect(hasInlineMathEditGuardDecoration([
      { type: { attrs: { "data-edit-guard-atom": "true" } } },
    ])).toBe(true);
    expect(hasInlineMathEditGuardDecoration([
      { type: { attrs: {} } },
    ])).toBe(false);
  });

  it("anchors drag selection around the inline math node by drag direction", () => {
    expect(getInlineMathDragSelectionAnchor(12, 1, { x: 20, y: 20 }, { x: 60, y: 22 })).toBe(12);
    expect(getInlineMathDragSelectionAnchor(12, 1, { x: 20, y: 20 }, { x: 18, y: 60 })).toBe(12);
    expect(getInlineMathDragSelectionAnchor(12, 1, { x: 20, y: 20 }, { x: 4, y: 19 })).toBe(13);
    expect(getInlineMathDragSelectionAnchor(12, 1, { x: 20, y: 20 }, { x: 22, y: 4 })).toBe(13);
  });

  it("recognizes a single copied inline math expression", () => {
    expect(extractSingleInlineMathText("$x^2+1$")).toBe("x^2+1");
    expect(extractSingleInlineMathText(" $\\frac{1}{2}$ ")).toBe("\\frac{1}{2}");
    expect(extractSingleInlineMathText("before $x$")).toBeNull();
  });

  it("maps keyboard entry direction to the MathLive cursor edge", () => {
    expect(getInlineMathKeyboardCursorPosition(keyEvent("ArrowRight"))).toBe("start");
    expect(getInlineMathKeyboardCursorPosition(keyEvent("ArrowLeft"))).toBe("end");
    expect(getInlineMathKeyboardCursorPosition(keyEvent("ArrowRight", { shiftKey: true }))).toBeNull();
  });

  it("returns from inline MathLive editing only when ArrowRight starts at the right edge", () => {
    expect(shouldExitInlineMathOnArrowRight(keyEvent("ArrowRight"), {
      lastOffset: 3,
      position: 3,
      selectionIsCollapsed: true,
    })).toBe(true);
    expect(shouldExitInlineMathOnArrowRight(keyEvent("ArrowRight"), {
      lastOffset: 3,
      position: 2,
      selectionIsCollapsed: true,
    })).toBe(false);
    expect(shouldExitInlineMathOnArrowRight(keyEvent("ArrowRight", { shiftKey: true }), {
      lastOffset: 3,
      position: 3,
      selectionIsCollapsed: true,
    })).toBe(false);
    expect(shouldExitInlineMathOnArrowRight(keyEvent("ArrowRight"), {
      lastOffset: 3,
      position: 3,
      selectionIsCollapsed: false,
    })).toBe(false);
  });

  it("returns from inline MathLive editing only when ArrowLeft starts at the left edge", () => {
    expect(shouldExitInlineMathOnArrowLeft(keyEvent("ArrowLeft"), {
      position: 0,
      selectionIsCollapsed: true,
    })).toBe(true);
    expect(shouldExitInlineMathOnArrowLeft(keyEvent("ArrowLeft"), {
      position: 1,
      selectionIsCollapsed: true,
    })).toBe(false);
    expect(shouldExitInlineMathOnArrowLeft(keyEvent("ArrowLeft", { shiftKey: true }), {
      position: 0,
      selectionIsCollapsed: true,
    })).toBe(false);
    expect(shouldExitInlineMathOnArrowLeft(keyEvent("ArrowLeft"), {
      position: 0,
      selectionIsCollapsed: false,
    })).toBe(false);
  });

  it("arms once at the math edge before exiting on a second arrow press", () => {
    const rightEdge = { lastOffset: 3, position: 3, selectionIsCollapsed: true };
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight"), rightEdge, null)).toBe("arm");
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight"), rightEdge, "right")).toBe("exit");
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight"), rightEdge, "left")).toBe("arm");

    const leftEdge = { lastOffset: 3, position: 0, selectionIsCollapsed: true };
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowLeft"), leftEdge, null)).toBe("arm");
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowLeft"), leftEdge, "left")).toBe("exit");
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowLeft"), leftEdge, "right")).toBe("arm");

    const middle = { lastOffset: 3, position: 2, selectionIsCollapsed: true };
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight"), middle, "right")).toBe("none");
    expect(resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight", { shiftKey: true }), rightEdge, "right")).toBe("none");
    expect(
      resolveInlineMathArrowEdgeAction(keyEvent("ArrowRight"), { ...rightEdge, selectionIsCollapsed: false }, "right"),
    ).toBe("none");
  });

  it("delegates Backspace at the MathLive start boundary to the surrounding editor", () => {
    expect(shouldDeleteBeforeInlineMathOnBackspace(keyEvent("Backspace"), {
      position: 0,
      selectionIsCollapsed: true,
    })).toBe(true);
    expect(shouldDeleteBeforeInlineMathOnBackspace(keyEvent("Backspace"), {
      position: 1,
      selectionIsCollapsed: true,
    })).toBe(false);
    expect(shouldDeleteBeforeInlineMathOnBackspace(keyEvent("Backspace", { metaKey: true }), {
      position: 0,
      selectionIsCollapsed: true,
    })).toBe(false);
  });

  it("maps inline math newline gestures to TeX line breaks", () => {
    expect(shouldInsertInlineMathLineBreak(keyEvent("Enter", { shiftKey: true }))).toBe(true);
    expect(shouldInsertInlineMathLineBreak(keyEvent("Enter"))).toBe(false);
    expect(shouldInsertInlineMathLineBreak(keyEvent("Enter", { shiftKey: true, metaKey: true }))).toBe(false);
    expect(normalizeInlineMathLineBreakInput(String.raw`x=1\\y=2`)).toBe(String.raw`\begin{aligned}x&=1\\y&=2\end{aligned}`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\displaylines{x=1\\ y=2}`)).toBe(String.raw`\displaylines{x=1\\ y=2}`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\begin{cases}x>0\\x\le0\end{cases}`)).toBe(String.raw`\begin{cases}x>0\\x\leqq0\end{cases}`);
  });

  it("repairs MathLive's spaced backslash before known latex commands", () => {
    expect(normalizeInlineMathLineBreakInput(String.raw`\ leqq`)).toBe(String.raw`\leqq`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\ leq`)).toBe(String.raw`\ leq`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\ leq`, { forceLatexCommands: true })).toBe(String.raw`\leqq`);
    expect(normalizeInlineMathLineBreakInput(String.raw`x \ geq y`, { forceLatexCommands: true })).toBe(String.raw`x \geqq y`);
    expect(normalizeInlineMathLineBreakInput(String.raw`x \ geqq y`)).toBe(String.raw`x \geqq y`);
    expect(normalizeInlineMathLineBreakInput(String.raw`x=高さ`)).toBe(String.raw`x=\text{高さ}`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\displaylines{x=1\\ y=2}`)).toBe(String.raw`\displaylines{x=1\\ y=2}`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\ unknown`)).toBe(String.raw`\ unknown`);
  });

  it("resolves slash and backslash command input aliases", () => {
    expect(getInlineMathLatexCommandTrigger(keyEvent("/"))).toBe("/");
    expect(getInlineMathLatexCommandTrigger(keyEvent("\\", { code: "Backslash" }))).toBe("\\");
    expect(getInlineMathLatexCommandTrigger(keyEvent("¥", { code: "IntlYen" }))).toBe("\\");
    expect(getInlineMathLatexCommandTrigger(keyEvent("x", { code: "Backslash" }))).toBe("\\");
    expect(getInlineMathLatexCommandTrigger(keyEvent("\\", { altKey: true, code: "Backslash" }))).toBeNull();
    expect(getInlineMathLatexCommandTrigger(keyEvent("￥", { code: "IntlYen" }))).toBeNull();
    expect(getInlineMathLatexCommandTrigger(keyEvent("¥", { code: "IntlYen", keyCode: 229 }))).toBeNull();
    expect(getInlineMathShiftDigit7Text(keyEvent("'", { code: "Digit7", shiftKey: true }))).toBe("'");
    expect(getInlineMathShiftDigit7Text(keyEvent("’", { code: "Digit7", shiftKey: true }))).toBe("’");
    expect(getInlineMathShiftDigit7Text(keyEvent("&", { code: "Digit7", shiftKey: true }))).toBe("&");
    expect(getInlineMathShiftDigit7Text(keyEvent("/", { code: "Digit7", shiftKey: true }))).toBeNull();
    expect(getInlineMathShiftDigit7Text(keyEvent("'", { code: "Digit7", ctrlKey: true, shiftKey: true }))).toBeNull();
    expect(shouldStartInlineMathOnBackslash(keyEvent("\\", { code: "Backslash" }))).toBe(true);
    expect(shouldStartInlineMathOnBackslash(keyEvent("\\", { altKey: true, code: "Backslash" }))).toBe(false);
    expect(shouldStartInlineMathOnBackslash(keyEvent("￥", { code: "IntlYen" }))).toBe(false);
    expect(shouldStartInlineMathOnBackslash(keyEvent("¥", { code: "IntlYen", keyCode: 229 }))).toBe(false);

    expect(hasInlineMathLatexCommandCandidate("leq")).toBe(true);
    expect(hasInlineMathLatexCommandCandidate("hline")).toBe(true);
    expect(resolveInlineMathLatexCommand("leq")).toBeNull();
    expect(resolveInlineMathLatexCommand("leq", { force: true })).toBe("\\leqq");
    expect(resolveInlineMathLatexCommand("leqq")).toBe("\\leqq");
    expect(resolveInlineMathLatexCommand("geq", { force: true })).toBe("\\geqq");
    expect(resolveInlineMathLatexCommand("ga")).toBe("\\gamma");
    expect(resolveInlineMathLatexCommand("si", { allowImmediate: false })).toBeNull();
    expect(resolveInlineMathLatexCommand("sin", { allowImmediate: false })).toBe("\\sin");
    expect(resolveInlineMathLatexCommand("sum", { allowImmediate: false })).toBe("\\sum");
    expect(resolveInlineMathLatexCommand("dots", { force: true })).toBe("\\ldots");
    expect(resolveInlineMathLatexCommand("hline", { force: true })).toBe("\\hline");
    expect(resolveInlineMathLatexCommand("thickbox", { force: true })).toBe("\\thickbox");
    expect(resolveInlineMathLatexCommand("doublebox", { force: true })).toBe("\\doublebox");
    expect(resolveInlineMathLatexCommand("unknown", { force: true })).toBeNull();
    // 順列・組合せ。r 綴りと k 綴りのどちらでも同じテンプレートを出す。
    expect(resolveInlineMathLatexCommand("ncr")).toBe("_{#?}\\mathrm{C}_{#?}");
    expect(resolveInlineMathLatexCommand("nck")).toBe("_{#?}\\mathrm{C}_{#?}");
    expect(resolveInlineMathLatexCommand("npr")).toBe("_{#?}\\mathrm{P}_{#?}");
    expect(resolveInlineMathLatexCommand("npk")).toBe("_{#?}\\mathrm{P}_{#?}");
    expect(resolveInlineMathLatexCommand("nhr")).toBe("_{#?}\\mathrm{H}_{#?}");
    expect(resolveInlineMathLatexCommand("nhk")).toBe("_{#?}\\mathrm{H}_{#?}");
    expect(resolveInlineMathLatexCommand("NCR")).toBe("_{#?}\\mathrm{C}_{#?}");
    expect(resolveInlineMathLatexCommand("binom")).toBe("\\binom{#?}{#?}");
    // 既存の `\ne` / `\neq` は「より長い候補がある間は確定しない」ままであること。
    expect(resolveInlineMathLatexCommand("ne")).toBeNull();
    expect(normalizeInlineMathLatexAliases(String.raw`\al2`)).toBe(String.raw`\alpha2`);
    expect(normalizeInlineMathLatexAliases(String.raw`\al`)).toBe(String.raw`\al`);
    expect(normalizeInlineMathLatexAliases(String.raw`\al`, { includeEnd: true })).toBe(String.raw`\alpha`);
    expect(normalizeInlineMathLatexAliases(String.raw`A+\Gamma`, { includeEnd: true })).toBe(String.raw`A+\Gamma`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\al`, { forceLatexCommands: true })).toBe(String.raw`\alpha`);
    expect(normalizeInlineMathLineBreakInput(String.raw`A+\Gamma`, { forceLatexCommands: true })).toBe(String.raw`A+\Gamma`);
    expect(normalizeInlineMathLineBreakInput(String.raw`\frac{a}{b}`, { forceLatexCommands: true })).toBe(String.raw`\frac{a}{b}`);
    expect(normalizeInlineMathTexLiteralInput(String.raw`\al`)).toBe(String.raw`\al`);
  });

  it("opens empty inline math for keyboard shortcuts in body text and hands the shortcut to the field", () => {
    const schema = getSchema(extensions);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("abc")]),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 2),
    });
    const event = keyEvent("g", { code: "KeyG", ctrlKey: true });
    const shortcut = getMathKeyboardMathShortcut(event);
    let nextState = state;

    expect(shortcut?.tex).toBe("\\sum_{#?}^{#?} #?");
    expect(insertMathKeyboardShortcutInlineMathAtSelection(
      state,
      schema.nodes.mathInline,
      shortcut!,
      toInlineMathTypeAheadKey(event),
      (transaction) => {
        nextState = state.apply(transaction);
      },
    )).toBe(true);

    // テンプレートは、数式の中で押したときと同じ経路 (入力欄への打鍵) で入る。本文側で
    // `#?` を展開すると空欄が枠付きの prompt になり、数式の中で押した結果と食い違う。
    const inserted = nextState.doc.nodeAt(2);
    expect(inserted?.type.name).toBe("mathInline");
    expect(inserted?.attrs.tex).toBe("");
    expect(nextState.doc.textContent).toBe("abc");
  });

  it("wraps selected body text with the MathKeyboard square shortcut", () => {
    const schema = getSchema(extensions);
    const doc = schema.nodes.doc.create(null, [
      schema.nodes.paragraph.create(null, [schema.text("abc")]),
    ]);
    const state = EditorState.create({
      doc,
      schema,
      selection: TextSelection.create(doc, 2, 3),
    });
    const event = keyEvent("2", { altKey: true, code: "Digit2", ctrlKey: true });
    const shortcut = getMathKeyboardMathShortcut(event);
    let nextState = state;

    expect(createInlineMathTexFromMathKeyboardShortcut(shortcut!, "b")).toBe("{b}^{2}");
    expect(insertMathKeyboardShortcutInlineMathAtSelection(
      state,
      schema.nodes.mathInline,
      shortcut!,
      toInlineMathTypeAheadKey(event),
      (transaction) => {
        nextState = state.apply(transaction);
      },
    )).toBe(true);

    const inserted = nextState.doc.nodeAt(2);
    expect(inserted?.type.name).toBe("mathInline");
    expect(inserted?.attrs.tex).toBe("{b}^{2}");
    expect(nextState.doc.textContent).toBe("ac");
  });

  it("commits inline math on bare Enter or Escape before MathLive inserts text", () => {
    expect(shouldCommitInlineMathOnKeyDown(keyEvent("Enter"))).toBe(true);
    expect(shouldCommitInlineMathOnKeyDown(keyEvent("Escape"))).toBe(true);
    expect(shouldCommitInlineMathOnKeyDown(keyEvent("Enter", { shiftKey: true }))).toBe(false);
    expect(shouldCommitInlineMathOnKeyDown(keyEvent("Enter", { isComposing: true }))).toBe(false);
  });

  it("keeps bare Enter for TeX line breaks and commits TeX with a modifier or Escape", () => {
    expect(shouldCommitInlineMathTexOnKeyDown(keyEvent("Enter"))).toBe(false);
    expect(shouldCommitInlineMathTexOnKeyDown(keyEvent("Enter", { ctrlKey: true }))).toBe(true);
    expect(shouldCommitInlineMathTexOnKeyDown(keyEvent("Enter", { metaKey: true }))).toBe(true);
    expect(shouldCommitInlineMathTexOnKeyDown(keyEvent("Escape"))).toBe(true);
    expect(shouldCommitInlineMathTexOnKeyDown(keyEvent("Enter", { ctrlKey: true, isComposing: true }))).toBe(false);
  });

  it("asks the desktop bridge to switch to ascii input for inline math", () => {
    const restore = vi.fn().mockResolvedValue({ ok: true, platform: "darwin", restored: true });
    const switchToAscii = vi.fn().mockResolvedValue({
      ok: true,
      platform: "darwin",
      restoreToken: "restore_1",
    });
    vi.stubGlobal("window", {
      desktopAPI: {
        inputSource: {
          restore,
          switchToAscii,
        },
      },
    });

    const session = requestDesktopAsciiInputSource();
    restoreDesktopInputSource(session);

    expect(switchToAscii).toHaveBeenCalledTimes(1);
    return expect(vi.waitFor(() => {
      expect(restore).toHaveBeenCalledWith("restore_1");
    })).resolves.toBeUndefined();
  });

  it("logs a failed switch to ascii input in development without surfacing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const failure of [
        vi.fn().mockResolvedValue({ ok: false, platform: "darwin", error: "English input source was not found." }),
        vi.fn().mockRejectedValue(new Error("ipc failed")),
      ]) {
        vi.stubGlobal("window", { desktopAPI: { inputSource: { restore: vi.fn(), switchToAscii: failure } } });
        const session = requestDesktopAsciiInputSource();
        await expect(session?.restoreToken).resolves.toBeNull();
      }
      expect(warn).toHaveBeenCalledTimes(2);
      expect(warn.mock.calls[0]?.[0]).toBe("Failed to switch to the ASCII input source for math editing");
      expect(warn.mock.calls[0]?.[1]).toBe("English input source was not found.");
      expect(warn.mock.calls[1]?.[1]).toBeInstanceOf(Error);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when the switch is skipped on an unsupported OS or succeeds without a restore token", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const result of [
        { ok: false, platform: "linux", error: "unsupported", skipped: true },
        { ok: true, platform: "win32" },
      ]) {
        vi.stubGlobal("window", {
          desktopAPI: { inputSource: { restore: vi.fn(), switchToAscii: vi.fn().mockResolvedValue(result) } },
        });
        await expect(requestDesktopAsciiInputSource()?.restoreToken).resolves.toBeNull();
      }
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("renders MathKeyboard shortcut templates with MathLive placeholders", () => {
    const representativeIds = new Set(["fraction", "nth-root", "sin-power", "matrix-2x2", "cases-3", "less-than-or-equal"]);
    for (const shortcut of MATH_KEYBOARD_SHORTCUTS.filter((entry) => representativeIds.has(entry.id))) {
      expect(renderMathHtml(shortcut.tex, DEFAULT_MATH_RENDER_ENVIRONMENT), shortcut.id).toContain("ML__latex");
    }
  });
});

function keyEvent(key: string, overrides: Partial<globalThis.KeyboardEvent> = {}): globalThis.KeyboardEvent {
  return {
    altKey: false,
    ctrlKey: false,
    isComposing: false,
    key,
    keyCode: 0,
    metaKey: false,
    shiftKey: false,
    ...overrides,
  } as globalThis.KeyboardEvent;
}
