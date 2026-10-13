// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";

import {
  APPLY_INLINE_MATH_FONT_EVENT,
  applyFontToInlineMathSelection,
  applyFontToMathFieldSelection,
  captureInlineMathFontTarget,
  isInlineMathFontMenuElement,
  notifyInlineMathFontMenuClosed,
  tightenMathFieldRange,
  watchInlineMathFontMenuFocus,
} from "./inline-math-font";
import { INLINE_MATH_FONT_MENU_ATTRIBUTE } from "@/lib/math-font-style";

/** `\frac{1}{3}` を MathLive が見せる範囲 → TeX。範囲 [2,5] / [3,5] はどちらも分母の 3。 */
const FRACTION_LATEX: Record<string, string> = { "2,5": "3", "3,5": "3", "4,5": "", "3,4": "" };

describe("tightenMathFieldRange", () => {
  it("narrows a range that starts in the numerator to the denominator it shows", () => {
    expect(tightenMathFieldRange([2, 5], (start, end) => FRACTION_LATEX[`${start},${end}`] ?? "?"))
      .toEqual({ start: 3, end: 5, latex: "3" });
  });

  it("gives up on an empty range", () => {
    expect(tightenMathFieldRange([4, 5], (start, end) => FRACTION_LATEX[`${start},${end}`] ?? "?")).toBeNull();
    expect(tightenMathFieldRange(null, () => "x")).toBeNull();
  });
});

describe("applyFontToMathFieldSelection", () => {
  it("replaces the narrowed selection with the font-wrapped TeX and keeps it selected", () => {
    const inserted: Array<[string, unknown]> = [];
    const field = {
      selection: { ranges: [[2, 5]] } as unknown,
      selectionIsCollapsed: false,
      getValue: (start: number, end: number) => FRACTION_LATEX[`${start},${end}`] ?? "?",
      insert: (latex: string, options: unknown) => { inserted.push([latex, options]); },
    };
    expect(applyFontToMathFieldSelection(field as never, '"Noto Serif JP", serif')).toBe(true);
    expect(field.selection).toEqual({ ranges: [[3, 5]], direction: "forward" });
    expect(inserted).toEqual([[
      "\\htmlStyle{font-family:'Noto Serif JP', serif}{3}",
      { format: "latex", insertionMode: "replaceSelection", selectionMode: "item", focus: true },
    ]]);
  });

  it("leaves a collapsed caret to the body formatting", () => {
    const field = { selectionIsCollapsed: true, getValue: () => "x", insert: () => { throw new Error("unexpected"); } };
    expect(applyFontToMathFieldSelection(field as never, "serif")).toBe(false);
  });
});

describe("applyFontToInlineMathSelection", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  /** 範囲を選んだ数式の入力欄の代わり。フォントの知らせを受けたら付けたことにする。 */
  function mountMathField() {
    const field = document.createElement("div");
    field.tabIndex = 0;
    const received: string[] = [];
    field.addEventListener(APPLY_INLINE_MATH_FONT_EVENT, (event) => {
      received.push((event as CustomEvent<{ fontFamily: string }>).detail.fontFamily);
      event.preventDefault();
    });
    document.body.append(field);
    return { field, received };
  }

  it("reaches the math field remembered at menu open after the font search takes focus", () => {
    const { field, received } = mountMathField();
    field.focus();
    const remembered = captureInlineMathFontTarget();
    const search = document.createElement("input");
    document.body.append(search);
    search.focus();

    expect(applyFontToInlineMathSelection("serif", remembered)).toBe(true);
    expect(received).toEqual(["serif"]);
  });

  it("leaves the font to the body once the remembered math field has closed", () => {
    const { field, received } = mountMathField();
    field.focus();
    const remembered = captureInlineMathFontTarget();
    field.remove();

    expect(applyFontToInlineMathSelection("serif", remembered)).toBe(false);
    expect(received).toEqual([]);
  });
});

describe("watchInlineMathFontMenuFocus", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  function mount() {
    const field = document.createElement("div");
    field.tabIndex = 0;
    const menu = document.createElement("div");
    menu.setAttribute(INLINE_MATH_FONT_MENU_ATTRIBUTE, "");
    const search = document.createElement("input");
    menu.append(search);
    const body = document.createElement("div");
    body.tabIndex = 0;
    document.body.append(field, menu, body);
    return { field, menu, search, body };
  }

  it("marks only elements inside the font menu", () => {
    const { search, body } = mount();
    expect(isInlineMathFontMenuElement(search)).toBe(true);
    expect(isInlineMathFontMenuElement(body)).toBe(false);
    expect(isInlineMathFontMenuElement(null)).toBe(false);
  });

  it("keeps the math field open while focus stays in the menu and stops once the field takes focus back", () => {
    const { field, search } = mount();
    let left = 0;
    watchInlineMathFontMenuFocus(field, () => { left += 1; });
    search.focus();
    field.focus();
    notifyInlineMathFontMenuClosed();
    expect(left).toBe(0);
  });

  it("closes the math field when focus leaves for the body", () => {
    const { field, search, body } = mount();
    let left = 0;
    watchInlineMathFontMenuFocus(field, () => { left += 1; });
    search.focus();
    body.focus();
    notifyInlineMathFontMenuClosed();
    expect(left).toBe(1);
  });

  it("closes the math field when the menu closes without giving focus back", () => {
    const { field, search } = mount();
    let left = 0;
    watchInlineMathFontMenuFocus(field, () => { left += 1; });
    search.focus();
    search.blur();
    notifyInlineMathFontMenuClosed();
    expect(left).toBe(1);
  });
});
