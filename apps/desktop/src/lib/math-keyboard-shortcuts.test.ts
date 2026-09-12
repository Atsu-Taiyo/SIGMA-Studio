import { validateLatex } from "mathlive";
import { describe, expect, it, vi } from "vitest";

import {
  MATH_KEYBOARD_SHORTCUTS,
  getMathKeyboardMathShortcut,
  handleMathKeyboardMathShortcut,
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
