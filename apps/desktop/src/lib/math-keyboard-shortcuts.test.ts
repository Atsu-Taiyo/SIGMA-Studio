import { validateLatex } from "mathlive";
import { describe, expect, it, vi } from "vitest";

import {
  MATH_KEYBOARD_SHORTCUTS,
  collidesWithMathKeyboardShortcut,
  getMathKeyboardMathShortcut,
  focusMathFractionDenominator,
  handleMathKeyboardMathShortcut,
  insertMathKeyboardMathTemplate,
  isMathFractionTemplate,
  isMathKeyboardMathModeShortcut,
  isMathKeyboardReturnToTextShortcut,
} from "@/lib/math-keyboard-shortcuts";

describe("math keyboard shortcuts", () => {
  it("maps keyboard combinations to MathLive templates", () => {
    expect(getMathKeyboardMathShortcut(eventFor("/"))?.tex).toBe("\\frac{#?}{#?}");
    expect(getMathKeyboardMathShortcut(eventFor("r", { altKey: true }))?.tex).toBe("\\sqrt[#?]{#?}");
    expect(getMathKeyboardMathShortcut(eventFor("h", { altKey: true }))?.tex).toBe("\\sin^{#?} #?");
    expect(getMathKeyboardMathShortcut(eventFor("d"))?.tex).toBe("\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}");
    expect(getMathKeyboardMathShortcut(eventFor("y", { altKey: true }))?.tex).toBe("\\begin{cases}#?\\\\#?\\\\#?\\end{cases}");
    expect(getMathKeyboardMathShortcut(eventFor("."))?.tex).toBe("\\geqq");
    expect(getMathKeyboardMathShortcut(eventFor("/", { altKey: true }))?.tex).toBe("\\div");
    expect(getMathKeyboardMathShortcut(eventFor("2", { altKey: true }))?.tex).toBe("{#?}^{2}");
    expect(getMathKeyboardMathShortcut(eventFor("2", { altKey: true }))?.wrapsSelection).toBe(true);
  });

  it("prefers the typed character over the physical key", () => {
    // JIS 配列の「[」は物理キーが US の「]」(BracketRight)、「]」は US の「\\」(Backslash)。
    expect(getMathKeyboardMathShortcut(eventFor("[", { code: "BracketRight" }))?.id).toBe("brackets-scripts");
    expect(getMathKeyboardMathShortcut(eventFor("]", { code: "Backslash" }))?.id).toBe("subscript");
  });

  it("uses physical key codes as a fallback for layout differences", () => {
    expect(getMathKeyboardMathShortcut(eventFor("x", { code: "KeyR" }))?.tex).toBe("\\sqrt{#?}");
    expect(getMathKeyboardMathShortcut(eventFor("\\", { code: "IntlYen" }))?.tex).toBe("\\left|#?\\right|");
    expect(getMathKeyboardMathShortcut(eventFor("x", { altKey: true, code: "Digit2" }))?.tex).toBe("{#?}^{2}");
  });

  it("keeps Ctrl+Alt+G available for the future f(x) selection screen", () => {
    expect(getMathKeyboardMathShortcut(eventFor("g", { altKey: true }))).toBeNull();
  });

  it("requires Ctrl without Meta for keyboard shortcuts", () => {
    expect(getMathKeyboardMathShortcut(eventFor("/", { ctrlKey: false }))).toBeNull();
    expect(getMathKeyboardMathShortcut(eventFor("/", { metaKey: true }))).toBeNull();
    expect(isMathKeyboardMathModeShortcut(eventFor("m"))).toBe(true);
    expect(isMathKeyboardMathModeShortcut(eventFor("m", { metaKey: true }))).toBe(false);
    expect(isMathKeyboardReturnToTextShortcut(eventFor("t"))).toBe(true);
  });

  it("finds the MathLive key bindings that would run before a shortcut", () => {
    // MathLive 0.111 の macOS 既定: ⌃H 削除・⌃D 後ろを削除・⌃B 左へ・⌃L 表示位置、英語配列の ⌃- 下付き・⌃; 行追加。
    for (const key of ["ctrl+h", "ctrl+d", "ctrl+b", "ctrl+l", "ctrl+[Minus]", "ctrl+;", "shift+ctrl+;"]) {
      expect(collidesWithMathKeyboardShortcut(key), key).toBe(true);
    }
    // US 配列の ⌃@ (π) は Shift+2、⌃^ (上付き) は Shift+6。MathLive の ⌃2 (√ の挿入)・⌃6 (上付きへ移動) が先に動く。
    for (const key of ["ctrl+[Digit2]", "ctrl+[Digit6]"]) {
      expect(collidesWithMathKeyboardShortcut(key), key).toBe(true);
    }
    // ショートカットの無いキー・⌘ 系・Ctrl の無いキーは残す。
    for (const key of ["ctrl+a", "ctrl+e", "ctrl+f", "ctrl+n", "ctrl+p", "ctrl+[Digit5]", "ctrl+[ArrowLeft]", "ctrl+[Backspace]", "cmd+;", "alt+[BracketLeft]"]) {
      expect(collidesWithMathKeyboardShortcut(key), key).toBe(false);
    }
  });

  it("inserts templates into MathLive with placeholder focus", () => {
    const preventDefault = vi.fn();
    const stopPropagation = vi.fn();
    const insert = vi.fn(() => true);

    expect(handleMathKeyboardMathShortcut({ ...eventFor("/"), preventDefault, stopPropagation }, { insert })).toBe(true);
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(insert).toHaveBeenCalledWith("\\frac{#?}{#?}", {
      focus: true,
      format: "latex",
      mode: "math",
      selectionMode: "placeholder",
    });
  });

  it("moves the caret from the numerator to the denominator after inserting a fraction", () => {
    const calls: string[] = [];
    const mathField = {
      executeCommand: vi.fn((command: string) => void calls.push(`command:${command}`)),
      insert: vi.fn((tex: string) => void calls.push(`insert:${tex}`)),
    };
    const preventDefault = vi.fn();

    expect(handleMathKeyboardMathShortcut({ ...eventFor("/"), preventDefault, stopPropagation: vi.fn() }, mathField)).toBe(true);

    // 挿入のあとで、選ばれた分子の空欄から次の空欄 (分母) へ。
    expect(calls).toEqual(["insert:\\frac{#?}{#?}", "command:moveToNextPlaceholder"]);
  });

  it("starts every fraction template in its denominator, whichever entry point inserts it", () => {
    for (const tex of ["\\frac{#?}{#?}", "\\dfrac{#?}{#?}", "\\tfrac{#?}{#?}", "\\cfrac{#?}{#?}", "\\frac {#?} {#?}"]) {
      const mathField = { executeCommand: vi.fn(), insert: vi.fn() };
      expect(insertMathKeyboardMathTemplate(mathField, tex), tex).toBe(true);
      expect(mathField.executeCommand, tex).toHaveBeenCalledExactlyOnceWith("moveToNextPlaceholder");
    }
  });

  it("keeps the first blank selected for every other template", () => {
    const others = [
      ...MATH_KEYBOARD_SHORTCUTS.filter((shortcut) => shortcut.id !== "fraction").map((shortcut) => shortcut.tex),
      "\\binom{#?}{#?}",
      "\\frac{1}{#?}",
      "\\frac{#?}{2}",
      "\\sqrt[#?]{#?}",
      "{#?}^{2}",
      "x\\frac{#?}{#?}",
    ];
    for (const tex of others) {
      const mathField = { executeCommand: vi.fn(), insert: vi.fn() };
      insertMathKeyboardMathTemplate(mathField, tex);
      expect(mathField.insert, tex).toHaveBeenCalledOnce();
      expect(mathField.executeCommand, tex).not.toHaveBeenCalled();
    }
    expect(isMathFractionTemplate("\\frac{#?}{#?}")).toBe(true);
    expect(isMathFractionTemplate("\\frac{1}{2}")).toBe(false);
    expect(focusMathFractionDenominator({ insert: vi.fn() }, "\\frac{#?}{#?}")).toBe(false);
  });

  it("keeps every configured template valid for MathLive validation", () => {
    for (const shortcut of MATH_KEYBOARD_SHORTCUTS) {
      expect(validateLatex(shortcut.tex), shortcut.id).toEqual([]);
    }
  });
});

function eventFor(key: string, overrides: Partial<Parameters<typeof getMathKeyboardMathShortcut>[0]> = {}) {
  return {
    altKey: false,
    code: "",
    ctrlKey: true,
    key,
    metaKey: false,
    ...overrides,
  };
}
