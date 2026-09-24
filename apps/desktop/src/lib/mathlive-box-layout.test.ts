import { describe, expect, it } from "vitest";
import { convertLatexToMarkup } from "mathlive";
import { normalizeMathLiveBoxMarkup, normalizeMathLiveBoxStyle } from "./mathlive-box-layout";

describe("MathLive framed box baseline compatibility", () => {
  it.each([String.raw`\sqrt{\boxed{\quad}}`, String.raw`\sqrt{\boxed{\mathstrut\quad}}`, String.raw`\boxed{\frac{x_1}{y}}`])("preserves measured dimensions and normalizes %s exactly once", (tex) => {
    const original = convertLatexToMarkup(tex);
    const normalized = normalizeMathLiveBoxMarkup(original);
    expect(normalized).toContain('class="sigma-math-box-layout"');
    expect(normalized.match(/height:[^;" ]+/g)).toEqual(original.match(/height:[^;" ]+/g));
    expect(normalizeMathLiveBoxMarkup(normalized)).toBe(normalized);
  });

  it("does not change unframed raisebox atoms or ordinary radicals", () => {
    for (const tex of [String.raw`\raisebox{0.2em}{x}`, String.raw`\sqrt{x}`]) {
      const markup = convertLatexToMarkup(tex);
      expect(normalizeMathLiveBoxMarkup(markup)).toBe(markup);
    }
  });

  it("uses the box's depth and padding, including custom bbox padding", () => {
    expect(normalizeMathLiveBoxStyle("position:relative;padding-left:0.5em;vertical-align:1.25em;top:0.8em;margin-top:-0.5em"))
      .toBe("position:relative;padding-left:0.5em;vertical-align:-0.75em;top:0;margin-top:0");
    expect(normalizeMathLiveBoxStyle("height:1em")).toBeNull();
  });
});
