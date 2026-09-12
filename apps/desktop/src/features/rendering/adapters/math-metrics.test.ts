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
