import { describe, expect, it, vi } from "vitest";

import { measureTexBoxEm } from "./math-metrics";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

// Real (ascent+depth) box heights read directly from MathLive's own `ML__strut`/`ML__strut--bottom`
// markup for `\displaystyle <tex>` (see the PR description's measured table). These are not golden
// values to freeze byte-for-byte -- they're a floor: `measureTexBoxEm` must never report a box
// shorter than what MathLive/KaTeX will actually render (that regression is exactly the clipping
// bug this feature exists to fix), and it should stay within a bounded safety margin above it so
// shapes don't balloon arbitrarily. If a future MathLive/KaTeX upgrade shifts true layout enough to
// break either bound, that's a signal to re-measure and update this table -- not to loosen it blindly.
const REAL_BOX_HEIGHT_EM: readonly (readonly [tex: string, realEm: number])[] = [
  ["x", 0.44],
  ["x^2", 0.87],
  ["\\frac{a}{b}", 1.62],
  ["\\dfrac{x+1}{y-1}", 2.03],
  ["\\sqrt{x}", 1.21],
  ["\\sqrt{\\frac{a}{b}}", 2.41],
  ["\\int_0^1 x\\,dx", 2.44],
  ["\\sum_{i=1}^{n}i", 2.93],
  ["\\lim_{x\\to0}\\frac{\\sin x}{x}", 1.89],
  ["\\begin{cases}a\\\\b\\end{cases}", 3.01],
  ["\\begin{pmatrix}a&b\\\\c&d\\end{pmatrix}", 2.41],
  ["\\overline{AB}", 0.89],
  ["\\text{三角形}", 1.11],
];

const MAX_OVERESTIMATE_FACTOR = 1.4;

describe("measureTexBoxEm", () => {
  it("measures single kana fallback glyphs in full-em cells, matching combined kana", () => {
    const one = measureTexBoxEm(String.raw`\text{ア}`, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const two = measureTexBoxEm(String.raw`\text{アイ}`, DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(one.widthEm).toBeCloseTo(1.05, 8);
    expect(two.widthEm).toBeCloseTo(2 * one.widthEm, 8);
    expect(measureTexBoxEm(String.raw`\boxed{\text{ア}}`, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm).toBeCloseTo(1.6 * 1.05, 8);
  });

  it("measures saved answer-frame dimensions rather than bbox option text", () => {
    const one = String.raw`\bbox[0.2em,border:0.04em solid black]{\hspace{0.8em}\text{ア}\hspace{0.8em}}`;
    const two = String.raw`\bbox[0.2em,border:0.04em solid black]{\hspace{0.3em}\text{アイ}\hspace{0.3em}}`;
    const first = measureTexBoxEm(one, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const second = measureTexBoxEm(two, DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(first.widthEm).toBeCloseTo(3 * 1.05, 8);
    expect(second.widthEm).toBeCloseTo(first.widthEm, 8);
    expect(first.ascentEm + first.descentEm).toBeLessThanOrEqual(1.65);
    expect(measureTexBoxEm(`${one}+${two}`, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm).toBeGreaterThan(first.widthEm * 2);
    expect(measureTexBoxEm(String.raw`\bbox[0.2em,border:0.04em solid black]{\text{ア}`, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm).toBeGreaterThan(0);
  });

  it("tolerates unfinished or other bbox forms without reinterpreting their options", () => {
    for (const tex of [String.raw`\bbox[red]{x}`, String.raw`\bbox[0.2em,red]{x}`, String.raw`\bbox[0.2em,border:0.04em solid black]{x`, String.raw`\bbox[200em]{x}`]) {
      const metrics = measureTexBoxEm(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);
      expect(Number.isFinite(metrics.widthEm)).toBe(true);
      expect(metrics.widthEm).toBeGreaterThan(0);
    }
    const nested = String.raw`\bbox[0.2em,border:0.04em solid black]{\bbox[0.2em,border:0.04em solid black]{\text{ア}}}`;
    expect(measureTexBoxEm(nested, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm).toBeCloseTo(1.8 * 1.05, 8);
  });

  it("counts custom-font hexadecimal char commands as glyphs rather than font names and hexadecimal digits", () => {
    const glyph = String.raw`\text{\fontfamily{Custom Symbol Face-12345678}\char"F03B}`;
    const single = measureTexBoxEm(glyph, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const longerName = measureTexBoxEm(String.raw`\text{\fontfamily{An Arbitrarily Longer Custom Font Family Name}\char"F03B}`, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const four = measureTexBoxEm(glyph.repeat(4), DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(single.widthEm).toBeCloseTo(1.05, 8);
    expect(longerName.widthEm).toBe(single.widthEm);
    expect(four.widthEm).toBeCloseTo(single.widthEm * 4, 8);
  });

  it("does not count text and font selectors when custom glyphs share a run with ordinary text", () => {
    const metrics = measureTexBoxEm(String.raw`\text{\fontfamily{Custom}\char"F03B A\char"F03C}`, DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(metrics.widthEm).toBeCloseTo((1 + 0.6 + 0.6 + 1) * 1.05, 8);
  });

  it("treats supplementary private-use characters as one custom glyph cell and tolerates invalid char codes", () => {
    expect(measureTexBoxEm(String.raw`\text{\fontfamily{Custom}\char"F0001}`, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm).toBeCloseTo(1.05, 8);
    expect(() => measureTexBoxEm(String.raw`\fontfamily{Custom}\char"FFFFFF`, DEFAULT_MATH_RENDER_ENVIRONMENT)).not.toThrow();
  });
  it.each(REAL_BOX_HEIGHT_EM)("never underestimates and stays within %s%s bound (%s em real)", (tex, realEm) => {
    const metrics = measureTexBoxEm(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);
    const estimatedEm = metrics.ascentEm + metrics.descentEm;

    expect(estimatedEm).toBeGreaterThanOrEqual(realEm);
    expect(estimatedEm).toBeLessThanOrEqual(realEm * MAX_OVERESTIMATE_FACTOR);
  });

  it("reports non-negative ascent/descent/width for every corpus entry", () => {
    for (const [tex] of REAL_BOX_HEIGHT_EM) {
      const metrics = measureTexBoxEm(tex, DEFAULT_MATH_RENDER_ENVIRONMENT);
      expect(metrics.ascentEm).toBeGreaterThan(0);
      expect(metrics.descentEm).toBeGreaterThanOrEqual(0);
      expect(metrics.widthEm).toBeGreaterThan(0);
    }
  });

  it("memoizes by tex string (repeated calls return an equal, stable result)", () => {
    const first = measureTexBoxEm("\\frac{a}{b}", DEFAULT_MATH_RENDER_ENVIRONMENT);
    const second = measureTexBoxEm("\\frac{a}{b}", DEFAULT_MATH_RENDER_ENVIRONMENT);
    expect(second).toEqual(first);
  });

  it("recovers from KaTeX's tryCombineChars width bug: width(ab) ~= width(a) + width(b)", () => {
    const widthA = measureTexBoxEm("a", DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm;
    const widthB = measureTexBoxEm("b", DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm;
    const widthAB = measureTexBoxEm("ab", DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm;

    expect(widthAB).toBeGreaterThan(Math.max(widthA, widthB));
    expect(widthAB).toBeGreaterThanOrEqual((widthA + widthB) * 0.9);
    expect(widthAB).toBeLessThanOrEqual((widthA + widthB) * 1.1);
  });

  it("recovers width across three combined characters (regression: KaTeX drops the middle glyph)", () => {
    const single = ["a", "b", "c"].map((char) => measureTexBoxEm(char, DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm);
    const combinedWidth = measureTexBoxEm("abc", DEFAULT_MATH_RENDER_ENVIRONMENT).widthEm;
    const singleSum = single.reduce((sum, w) => sum + w, 0);

    expect(combinedWidth).toBeGreaterThanOrEqual(singleSum * 0.85);
  });

  // MathLive's `convertLatexToMarkup` is very permissive in practice (it renders unknown commands
  // as literal/placeholder glyphs rather than throwing), so the heuristic branch is normally only
  // reached in the Electron-main/MCP MathLive stub (which emits no `ML__strut` markup at all) *and*
  // KaTeX also rejects the input (a genuinely undefined control sequence). We simulate the stub by
  // mocking `convertLatexToMarkupCached` to return strut-free markup, matching that real shape.
  describe("when MathLive produces no struts (stub environment) and KaTeX also fails", () => {
    it("falls back to the heuristic branch", async () => {
      vi.resetModules();
      vi.doMock("@/lib/math-tex", async () => {
        const actual = await vi.importActual<typeof import("@/lib/math-tex")>("@/lib/math-tex");
        return { ...actual, convertLatexToMarkupCached: (tex: string) => tex };
      });
      const { measureTexBoxEm: measureWithStub } = await import("./math-metrics");

      const plain = measureWithStub("\\thisIsNotARealCommand", DEFAULT_MATH_RENDER_ENVIRONMENT);
      expect(plain.source).toBe("heuristic");
      expect(plain.ascentEm).toBeGreaterThan(0);
      expect(plain.widthEm).toBeGreaterThan(0);

      const structural = measureWithStub("\\frac{\\thisIsNotARealCommand}{b}", DEFAULT_MATH_RENDER_ENVIRONMENT);
      expect(structural.source).toBe("heuristic");
      expect(structural.ascentEm).toBeGreaterThan(plain.ascentEm);

      vi.doUnmock("@/lib/math-tex");
      vi.resetModules();
    });
  });
});
