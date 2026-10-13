import { describe, expect, it } from "vitest";

import { toMathFontFamilyValue, unwrapMathFontStyles, wrapMathWithFont } from "./math-font-style";

const SERIF = '"Noto Serif JP", "Noto Sans Symbols", "STIX Two Math", serif';

describe("math font style", () => {
  it("writes the toolbar font as a TeX-safe font-family list (single quotes, no delimiters)", () => {
    expect(toMathFontFamilyValue(SERIF)).toBe("'Noto Serif JP', 'Noto Sans Symbols', 'STIX Two Math', serif");
    expect(toMathFontFamilyValue('"A{b}\\c;", serif')).toBe("'Abc', serif");
  });

  it("wraps the selected TeX and replaces any font already chosen inside it", () => {
    expect(wrapMathWithFont("x^2", SERIF))
      .toBe("\\htmlStyle{font-family:'Noto Serif JP', 'Noto Sans Symbols', 'STIX Two Math', serif}{x^2}");
    const once = wrapMathWithFont("a", '"M PLUS 1p", sans-serif');
    expect(wrapMathWithFont(`${once}+b`, SERIF))
      .toBe("\\htmlStyle{font-family:'Noto Serif JP', 'Noto Sans Symbols', 'STIX Two Math', serif}{a+b}");
  });

  it("unwraps nested font styles but keeps other commands and unfinished ones", () => {
    expect(unwrapMathFontStyles("\\htmlStyle{font-family:'A'}{\\frac{1}{\\htmlStyle{font-family:'B'}{2}}}")).toBe("\\frac{1}{2}");
    expect(unwrapMathFontStyles("\\htmlStyle{color:red}{x}")).toBe("\\htmlStyle{color:red}{x}");
    expect(unwrapMathFontStyles("\\htmlStyle{font-family:'A'}{x")).toBe("\\htmlStyle{font-family:'A'}{x");
  });
});
