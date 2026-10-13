import { describe, expect, it } from "vitest";
import { readStylesheet as readFileSync } from "../../tests/helpers/read-stylesheet";

import type { CustomFrame, SigmaBlock } from "@/features/document";
import  {
  getPrintProblemFrameChromePaddingMm,
  getPrintProblemFrameFragmentChromeHeightMm,
  getProblemCustomFrame,
  getProblemFrameChromePaddingPx,
  getProblemFrameStyleId,
  normalizeProblemFrameInput,
  PROBLEM_FRAME_STYLE_OPTIONS,
  problemFrameClassName,
  setProblemCustomFrame,
  setProblemFrameStyle,
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
    .find((className) => className.startsWith("box-frame--") || className.startsWith("problem-frame--"));
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
    expect(getPrintProblemFrameFragmentChromeHeightMm("cornerbox", "single")).toBeCloseTo(7);
  });
});

const CUSTOM: CustomFrame = {
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40" viewBox="0 0 60 40"><rect width="60" height="40" fill="none" stroke="#000"/></svg>',
  width: 60,
  height: 40,
  slice: 10,
  borderPx: 18,
  paddingPx: 12,
};

describe("custom problem frame", () => {
  it("is only selected while the drawing is present", () => {
    const withDrawing = { frame: { enabled: true, styleId: "custom", custom: CUSTOM } };
    expect(getProblemFrameStyleId(withDrawing)).toBe("custom");
    expect(getProblemCustomFrame(withDrawing)).toBe(CUSTOM);
    const lostDrawing = { frame: { enabled: true, styleId: "custom" } };
    expect(getProblemFrameStyleId(lostDrawing)).toBe("fancybox");
    expect(getProblemCustomFrame(lostDrawing)).toBeUndefined();
  });

  it("keeps the drawing when a built-in style is chosen and again when the drawing is reselected", () => {
    const problem = { type: "problem", frame: { enabled: true, styleId: "custom", custom: CUSTOM } } as unknown as SigmaBlock;
    const builtIn = setProblemFrameStyle(problem, "doublebox") as { frame: { styleId: string; custom?: unknown } };
    expect(builtIn.frame).toMatchObject({ styleId: "doublebox", custom: CUSTOM });
    const again = setProblemCustomFrame(builtIn as unknown as SigmaBlock, CUSTOM) as { frame: { styleId: string } };
    expect(again.frame.styleId).toBe("custom");
  });

  it("measures an untrusted drawing's chrome from validated numbers, however the document was made", () => {
    const hostile = {
      ...CUSTOM,
      borderPx: "1px;position:fixed;inset:0" as unknown as number,
      paddingPx: Number.NaN,
      slice: 1e9,
    };
    expect(getProblemFrameChromePaddingPx("custom", hostile)).toEqual({ x: 28, y: 28 });
  });

  it("measures the chrome of a custom frame from its own border and padding", () => {
    expect(getProblemFrameChromePaddingPx("custom", CUSTOM)).toEqual({ x: 30, y: 30 });
    const paddingMm = 12 * 25.4 / 96;
    const borderMm = 18 * 25.4 / 96;
    expect(getPrintProblemFrameChromePaddingMm("custom", CUSTOM).y).toBeCloseTo(paddingMm);
    expect(getPrintProblemFrameFragmentChromeHeightMm("custom", "single", CUSTOM))
      .toBeCloseTo(paddingMm * 2 + borderMm * 2);
    expect(getPrintProblemFrameFragmentChromeHeightMm("custom", "middle", CUSTOM)).toBeCloseTo(paddingMm);
  });
});

describe("normalizeProblemFrameInput", () => {
  const loose = '<svg viewBox="0 0 100 60"><rect x="2" y="2" width="96" height="56" fill="none" stroke="#c2410c" stroke-width="4"/></svg>';

  it("stores a loosely written drawing in the canonical form the schema accepts", () => {
    const frame = normalizeProblemFrameInput({ custom: { svg: loose, borderPx: 20 } });
    expect(frame).toMatchObject({ enabled: true, styleId: "custom", custom: { width: 100, height: 60, slice: 15, borderPx: 20, paddingPx: 12 } });
    expect(frame.custom?.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("passes the built-in styles through and never invents a drawing for them", () => {
    expect(normalizeProblemFrameInput({ enabled: true, styleId: "doublebox", custom: "nope" }))
      .toEqual({ enabled: true, styleId: "doublebox" });
  });

  it("refuses a drawing that cannot be used instead of saving something the file would reject", () => {
    expect(() => normalizeProblemFrameInput({ custom: { svg: "<svg><rect/></svg>" } })).toThrow(/noViewBox/);
  });
});
