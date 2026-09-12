import { describe, expect, it } from "vitest";
import { readStylesheet as readFileSync } from "../../tests/helpers/read-stylesheet";

import  {
  getPrintProblemFrameChromePaddingMm,
  getPrintProblemFrameFragmentChromeHeightMm,
  getProblemFrameChromePaddingPx,
  PROBLEM_FRAME_STYLE_OPTIONS,
  problemFrameClassName,
} from "./problem-frame";

/**
 * `getProblemFrameChromePaddingPx` / `getPrintProblemFrameChromePaddingMm` hand-mirror the
 * `padding` the stylesheets give each frame variant, because a frame split by a manual break is
 * drawn without a content box of its own (editor: decorative overlay pieces; print: fragment
 * chrome reserved during pagination). Read the real CSS here so they cannot drift apart
 * silently. Note the editor declares px and print declares mm — they are NOT the same numbers.
 *
 * The editor frame lives in `globals.css`; the print frame is part of the document surface, so
 * it lives in the shared `document-surface.css` that the embedded viewer imports too.
 */
const FRAME_STYLESHEETS = ["../app/globals.css", "../app/document-surface.css"] as const;

function readFramePadding(selector: string, unit: "px" | "mm"): { x: number; y: number } {
  const sources = FRAME_STYLESHEETS.map((relativePath) => ({
    relativePath,
    css: readFileSync(new URL(relativePath, import.meta.url), "utf8"),
  }));
  const source = sources.find(({ css }) => css.includes(`${selector} {`));
  expect(
    source,
    `no rule for "${selector}" in ${FRAME_STYLESHEETS.join(" / ")}`,
  ).toBeDefined();

  const css = source!.css;
  const ruleStart = css.indexOf(`${selector} {`);
  const rule = css.slice(ruleStart, css.indexOf("}", ruleStart));
  const padding = new RegExp(`\\n\\s*padding:\\s*([\\d.]+)${unit}\\s+([\\d.]+)${unit};`).exec(rule);
  expect(padding, `"${selector}" declares no two-value ${unit} padding`).not.toBeNull();

  return { y: Number(padding![1]), x: Number(padding![2]) };
}

/**
 * The variant selector for a frame style, derived from `problemFrameClassName` so the
 * id→class mapping is not hardcoded a second time here.
 */
function frameVariantSelector(baseSelector: string, styleId: string): string {
  const variantClass = problemFrameClassName("", styleId)
    .split(" ")
    .find((className) => className.startsWith("box-frame--"));
  return variantClass ? `${baseSelector}.${variantClass}` : baseSelector;
}

const EDITOR_FRAME_SELECTOR = ".problem-area-flow-unit.with-frame";
const PRINT_FRAME_SELECTOR = ".print-problem-area.with-frame";

describe("problem frame chrome padding", () => {
  it("matches the editor frame padding declared in globals.css for every selectable style", () => {
    for (const option of PROBLEM_FRAME_STYLE_OPTIONS) {
      const selector = frameVariantSelector(EDITOR_FRAME_SELECTOR, option.id);
      expect(getProblemFrameChromePaddingPx(option.id), selector)
        .toEqual(readFramePadding(selector, "px"));
    }
  });

  it("matches the print frame padding declared in globals.css for every selectable style", () => {
    for (const option of PROBLEM_FRAME_STYLE_OPTIONS) {
      const selector = frameVariantSelector(PRINT_FRAME_SELECTOR, option.id);
      expect(getPrintProblemFrameChromePaddingMm(option.id), selector)
        .toEqual(readFramePadding(selector, "mm"));
    }
  });

  it("falls back to the default frame padding for an unknown style id", () => {
    expect(getProblemFrameChromePaddingPx("no-such-style"))
      .toEqual(getProblemFrameChromePaddingPx(undefined));
    expect(getPrintProblemFrameChromePaddingMm("no-such-style"))
      .toEqual(getPrintProblemFrameChromePaddingMm(undefined));
  });

  it("reserves print chrome according to fragment role and frame border width", () => {
    expect(getPrintProblemFrameFragmentChromeHeightMm("fancybox", "first")).toBeCloseTo(5.3);
    expect(getPrintProblemFrameFragmentChromeHeightMm("fancybox", "middle")).toBeCloseTo(2.5);
    expect(getPrintProblemFrameFragmentChromeHeightMm("fancybox", "last")).toBeCloseTo(2.8);
    expect(getPrintProblemFrameFragmentChromeHeightMm("fancybox", "single")).toBeCloseTo(5.6);
    expect(getPrintProblemFrameFragmentChromeHeightMm("doublebox", "single")).toBeCloseTo(7.6);
    expect(getPrintProblemFrameFragmentChromeHeightMm("cornerbox", "single")).toBeCloseTo(12.8);
  });
});
