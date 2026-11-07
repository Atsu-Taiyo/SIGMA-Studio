import katex from "katex";
import { convertLatexToMarkup } from "mathlive";
import { describe, expect, it } from "vitest";

import { measureTexBoxEm } from "@/features/rendering/adapters/math-metrics";
import { renderMathHtml } from "@/features/rendering/adapters/math-html";
import { sanitizeMathMarkup } from "@/features/rendering/adapters/math-markup";
import {
  VV_ARROW_CLASS,
  VV_CLASS,
  VV_EDITOR_DEF,
  VV_ARROW_RISE_EM,
  VV_KATEX_DEF,
  VV_MATHLIVE_DEF,
  VV_MIN_WIDTH_EM,
  VV_SLOT_STYLE,
  VV_ARROW_SLICE_MARGIN,
  vvArrowMarkup,
  vvArrowTopEm,
  normalizeVvMarkup,
} from "@/lib/vv-vector";
import {
  VV_ARROW_DESIGN,
  VV_ARROW_HEIGHT,
  VV_ARROW_LEFT_SLICE_PATHS,
  VV_ARROW_RIGHT_SLICE_PATHS,
} from "@/lib/vv-arrow-outline";
import { createMathRenderEnvironment, DEFAULT_MATH_RENDER_ENVIRONMENT as env } from "@/lib/math-environment";
import {
  createMathMacroSet,
  DEFAULT_MATH_MACRO_SET,
  SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO,
  trustSigmaKatexMacro,
} from "@/lib/math-macros";
import { convertLatexToMarkupCached, validateMathTex } from "@/lib/math-tex";

const L = String.raw;
/** MathLive's own layout box (struts), as the shared metrics read it. */
function box(tex: string) {
  const markup = convertLatexToMarkupCached(tex, env);
  const height = Number(/class="ML__strut" style="height:([0-9.]+)em"/.exec(markup)?.[1]);
  const depth = Number(/class="ML__strut--bottom" style="height:[0-9.]+em;vertical-align:-([0-9.]+)em"/.exec(markup)?.[1] ?? 0);
  return { height, depth };
}
const count = (text: string, pattern: RegExp) => text.match(pattern)?.length ?? 0;
const arrowTops = (html: string) => [...html.matchAll(new RegExp(`class="${VV_ARROW_CLASS}" style="[^"]*top:([\\d.]+)em`, "g"))].map((m) => Number(m[1]));
const katexHtml = (tex: string) => katex.renderToString(tex, {
  macros: { ...DEFAULT_MATH_MACRO_SET.katexMacros }, output: "html", trust: trustSigmaKatexMacro, strict: "ignore",
});
/** KaTeX's own box height (its DOM-free tree, as the shared metrics read it). */
const katexTree = (katex as unknown as {
  __renderToHTMLTree: (tex: string, options: object) => { height: number };
}).__renderToHTMLTree;
const katexHeight = (tex: string) => katexTree(`\\displaystyle ${tex}`, {
  macros: { ...DEFAULT_MATH_MACRO_SET.katexMacros }, trust: trustSigmaKatexMacro, strict: "ignore",
}).height;

describe("\\vv vectors", () => {
  it("is a built-in command for MathLive, KaTeX and validation, with an editor box equal to the static one", () => {
    expect(DEFAULT_MATH_MACRO_SET.mathLiveMacros.vv).toEqual({ def: VV_MATHLIVE_DEF, args: 1 });
    expect(DEFAULT_MATH_MACRO_SET.katexMacros[L`\vv`]).toBe(VV_KATEX_DEF);
    expect(validateMathTex(L`\vv{AB}+\vv{a}^{2}`)).toEqual([]);
    expect(trustSigmaKatexMacro({ command: L`\htmlClass`, class: VV_CLASS })).toBe(true);
    // Editing keeps the operand editable inside exactly the static box (only the marker class differs).
    expect(SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO).toEqual({ def: VV_EDITOR_DEF, args: 1, captureSelection: false });
    // The editor box is the text-style branch of the static definition (one editable operand).
    expect(VV_MATHLIVE_DEF.startsWith(L`\class{${VV_CLASS}}{\mathchoice{`)).toBe(true);
    expect(VV_MATHLIVE_DEF).toContain(`{${VV_EDITOR_DEF}}{${VV_EDITOR_DEF}}`);
    expect(VV_EDITOR_DEF.match(/#1/g)).toHaveLength(1);
  });

  it("lets a document's own \\vv override the built-in one", () => {
    const preamble = L`\newcommand{\vv}[1]{\overrightarrow{#1}}`;
    const own = createMathMacroSet(preamble);
    expect(own.mathLiveMacros.vv).toEqual({ args: 1, def: L`\overrightarrow{#1}` });
    expect(own.katexMacros[L`\vv`]).toBe(L`\overrightarrow{#1}`);
    const html = renderMathHtml(L`\vv{AB}`, createMathRenderEnvironment(preamble));
    expect(html).not.toContain(VV_ARROW_CLASS);
  });

  it("draws Sigma's own arrow (round start, stretching shaft, head) and survives sanitizing", () => {
    const html = renderMathHtml(L`\vv{AB}`, env);
    expect(html).not.toContain("data-math-unrendered");
    expect(count(html, new RegExp(VV_ARROW_CLASS, "g"))).toBe(1);
    for (const d of [...VV_ARROW_LEFT_SLICE_PATHS, ...VV_ARROW_RIGHT_SLICE_PATHS]) expect(html).toContain(`d="${d}"`);
    expect(html).toContain('preserveAspectRatio="xMinYMin slice"');
    expect(html).toContain('preserveAspectRatio="xMaxYMin slice"');
    expect(sanitizeMathMarkup(convertLatexToMarkupCached(L`\vv{AB}`, env)).safe).toBe(true);
    // The operand glyphs stay real text; the slot rule is invisible.
    expect(html.replace(/<[^>]+>/g, "")).toBe("AB");
    expect(html).toMatch(/class="ML__rule" style="[^"]*opacity:0/);
  });

  it("keeps the ink clear of each half's edges, so pixel snapping cannot cut the barbs' ends or the tip", () => {
    const markup = vvArrowMarkup(0.1);
    // The arrow's own box is the ink box: rise and width are measured from it.
    expect(markup).toMatch(new RegExp(`^<span class="${VV_ARROW_CLASS}" style="[^"]*top:0.1em;width:100%;height:${VV_ARROW_HEIGHT / 1000}em"`));
    const slices = [...markup.matchAll(/<span style="([^"]*)"><svg [^>]*viewBox="([^"]*)"/g)].map(([, style, viewBox]) => ({
      style, viewBox: viewBox.split(" ").map(Number),
      top: Number(/top:(-?[\d.]+)em/.exec(style)?.[1]), height: Number(/height:([\d.]+)em/.exec(style)?.[1]),
    }));
    expect(slices).toHaveLength(2);
    const margin = VV_ARROW_SLICE_MARGIN;
    expect(margin).toBeGreaterThanOrEqual(15); // more than half a device pixel at 16px on a 2x display (~31 units)
    for (const { viewBox: [, y, , h], top, height } of slices) {
      // The ink (0..VV_ARROW_HEIGHT, vv-arrow-outline.test.ts) sits `margin` inside the top and bottom...
      expect(y).toBe(-margin);
      expect(y + h).toBe(VV_ARROW_HEIGHT + margin);
      // ...at the same scale and place as the arrow's box (1 unit = 0.001em).
      expect(height * 1000).toBeCloseTo(h, 6);
      expect(top * 1000).toBeCloseTo(y, 6);
    }
    // The head's half reaches `margin` right of the box; the tip (x = slice width) stays at its right edge.
    const [left, right] = slices;
    expect(left.style).toContain("left:0;width:50.2%");
    expect(right.style).toContain(`right:-${margin / 1000}em`);
    expect(right.viewBox[2]).toBe(left.viewBox[2] + margin);
    // The sanitizer keeps all of it.
    const html = renderMathHtml(L`\vv{AB}`, env);
    expect(html).toContain(`viewBox="0 ${-margin} ${right.viewBox[2]} ${VV_ARROW_HEIGHT + 2 * margin}"`);
    expect(html).toContain(`right:-${margin / 1000}em;top:-${margin / 1000}em`);
  });

  it("reserves the arrow's geometry: its rise over the operand, the operand's depth, and the minimum width", () => {
    // The shaft's centre is the design's clearance above the operand; the ink is symmetric around it.
    expect(VV_ARROW_RISE_EM).toBeCloseTo((VV_ARROW_DESIGN.clearance + VV_ARROW_HEIGHT / 2) / 1000, 6);
    expect(VV_MIN_WIDTH_EM).toBe(VV_ARROW_DESIGN.minWidth / 1000);
    for (const operand of ["AB", "a", "E", L`\mathrm{A}\mathrm{B}`, L`\mathrm{OA}`, "x^{2}", "g", "a_{1}"]) {
      const plain = box(operand), vector = box(L`\vv{${operand}}`);
      expect(Math.abs(vector.height - plain.height - VV_ARROW_RISE_EM), operand).toBeLessThanOrEqual(0.011); // struts are 0.01em
      expect(vector.depth, operand).toBeCloseTo(plain.depth, 2);
    }
    const width = (tex: string) => measureTexBoxEm(tex, env).widthEm;
    expect(width(L`\vv{a}`)).toBeCloseTo(VV_MIN_WIDTH_EM * 1.05, 2);
    expect(width(L`\vv{ABCDEF}`)).toBeCloseTo(width("ABCDEF"), 3);
    // Far more compact than \overrightarrow, whose slot is 0.72em above the operand.
    expect(measureTexBoxEm(L`\vv{AB}`, env).ascentEm).toBeLessThan(measureTexBoxEm(L`\overrightarrow{AB}`, env).ascentEm - 0.3);
  });

  it("reserves the box per style in every engine: script ×0.7, scriptscript ×0.5", () => {
    // Superscripts: their shift does not depend on their own height, so the box shows in the formula.
    const styles = [
      { name: "text", scale: 1, wrap: (b: string) => b },
      { name: "script", scale: 0.7, wrap: (b: string) => L`x^{${b}}` },
      { name: "scriptscript", scale: 0.5, wrap: (b: string) => L`x^{y^{${b}}}` },
    ];
    const width = (tex: string) => measureTexBoxEm(tex, env).widthEm;
    for (const { name, scale, wrap } of styles) {
      for (const operand of ["u", "AB"]) {
        const rise = VV_ARROW_RISE_EM * scale;
        const plain = wrap(operand), vector = wrap(L`\vv{${operand}}`);
        expect(Math.abs(box(vector).height - box(plain).height - rise), `MathLive ${name} ${operand}`).toBeLessThanOrEqual(0.011);
        expect(katexHeight(vector) - katexHeight(plain), `KaTeX ${name} ${operand}`).toBeCloseTo(rise, 2);
      }
      // The shared width walker: a narrow operand widens to the minimum width, a wide one does not.
      const uWidth = 0.572 * scale; // KaTeX's italic u
      expect(width(wrap(L`\vv{u}`)) - width(wrap("u")), `width ${name}`).toBeCloseTo((VV_MIN_WIDTH_EM * scale - uWidth) * 1.05, 2);
      expect(width(wrap(L`\vv{AB}`)), `width ${name}`).toBeCloseTo(width(wrap("AB")), 3);
      // Each engine draws only the branch for the vector's style: one operand, one arrow.
      const html = renderMathHtml(wrap(L`\vv{AB}`), env);
      expect(html.replace(/<[^>]+>/g, ""), name).toBe(name === "text" ? "AB" : name === "script" ? "xAB" : "xyAB");
      expect(count(html, new RegExp(VV_ARROW_CLASS, "g")), name).toBe(1);
      // The box is exact, so the arrow is drawn at its top.
      expect(arrowTops(html)[0], name).toBeLessThan(0.02);
    }
  });

  it("measures the arrow from the operand where a box is taller (the editor's single variant)", () => {
    expect(vvArrowTopEm(0.69 + VV_ARROW_RISE_EM + 0.002, 0.69)).toBeCloseTo(0.002, 6);
    expect(vvArrowTopEm(0.44 + VV_ARROW_RISE_EM + 0.152, 0.44)).toBeCloseTo(0.152, 6);
    expect(vvArrowTopEm(0.44 + VV_ARROW_RISE_EM - 0.1, 0.44)).toBe(0);
    expect(vvArrowTopEm(Number.NaN, 0.44)).toBe(0);
    // The style restored on a scripted editor slot is the one MathLive writes at text size.
    expect(VV_SLOT_STYLE).toContain("font-size: 70%");
    expect(convertLatexToMarkup(VV_EDITOR_DEF.replace("#1", "x"))).toContain(`style="${VV_SLOT_STYLE}"`);
  });

  it("draws \\vv{\\mathrm{OA}} like any operand: upright letters under one arrow as wide as they are", () => {
    const tex = L`\vv{\mathrm{OA}}`;
    expect(validateMathTex(tex)).toEqual([]);
    const html = renderMathHtml(tex, env);
    expect(html).not.toContain("data-math-unrendered");
    expect(html.replace(/<[^>]+>/g, "")).toBe("OA");
    expect(count(html, new RegExp(VV_ARROW_CLASS, "g"))).toBe(1);
    expect(arrowTops(html)[0]).toBeLessThan(0.02);
    const width = (source: string) => measureTexBoxEm(source, env).widthEm;
    expect(width(tex)).toBeCloseTo(width(L`\mathrm{OA}`), 3);
    expect(width(L`\vv{\mathrm{OA}}+\vv{\mathrm{OB}}`)).toBeCloseTo(width(L`\mathrm{OA}+\mathrm{OB}`), 3);
    // In a fraction and under a power the box keeps the same rise.
    expect(Math.abs(box(tex).height - box(L`\mathrm{OA}`).height - VV_ARROW_RISE_EM)).toBeLessThanOrEqual(0.011);
    expect(count(renderMathHtml(L`\frac{\vv{\mathrm{OA}}+\vv{\mathrm{OB}}}{2}`, env), new RegExp(VV_ARROW_CLASS, "g"))).toBe(2);
    expect(katexHeight(tex) - katexHeight(L`\mathrm{OA}`)).toBeCloseTo(VV_ARROW_RISE_EM, 2);
  });

  it("keeps the operand's own overline and nested vectors", () => {
    const html = renderMathHtml(L`\vv{\overline{AB}}+\vv{\vv{a}}+\vv{E}_{\vv{u}_{\vv{u}}}`, env);
    expect(count(html, /class="overline-line"/g)).toBe(1);
    expect(count(html, new RegExp(VV_ARROW_CLASS, "g"))).toBe(6);
  });

  it("draws the KaTeX fallback the same way without cramping the operand", () => {
    // KaTeX's \overline would cramp: x^2 inside the vector keeps its normal superscript.
    expect(katexHeight(L`\vv{x^{2}}`) - katexHeight("x^{2}")).toBeCloseTo(VV_ARROW_RISE_EM, 2);
    expect(katexHeight(L`\vv{AB}`) - katexHeight("AB")).toBeCloseTo(VV_ARROW_RISE_EM, 2);
    const html = normalizeVvMarkup(katexHtml(L`\vv{AB}+\overline{c}`));
    expect(count(html, new RegExp(VV_ARROW_CLASS, "g"))).toBe(1);
    expect(count(html, /overline-line/g)).toBe(1);
    expect(normalizeVvMarkup(html)).toBe(html);
    // Inside a script KaTeX draws only the script variant: one operand, one arrow at the box top.
    const scripted = normalizeVvMarkup(katexHtml(L`x_{\vv{u}}`));
    expect(count(scripted, new RegExp(VV_ARROW_CLASS, "g"))).toBe(1);
    expect(count(scripted, />u</g)).toBe(1);
  });

  it("leaves unrelated or malformed markup untouched and is idempotent", () => {
    const markup = convertLatexToMarkupCached(L`\overline{AB}`, env);
    expect(normalizeVvMarkup(markup)).toBe(markup);
    expect(normalizeVvMarkup(`<span class="${VV_CLASS}"><span>`)).toBe(`<span class="${VV_CLASS}"><span>`);
    const drawn = convertLatexToMarkupCached(L`\vv{AB}`, env);
    expect(normalizeVvMarkup(drawn)).toBe(drawn);
  });
});
