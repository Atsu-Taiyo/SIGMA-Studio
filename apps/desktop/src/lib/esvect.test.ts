import katex from "katex";
import { describe, expect, it } from "vitest";

import { measureTexBoxEm } from "@/features/rendering/adapters/math-metrics";
import { renderMathHtml } from "@/features/rendering/adapters/math-html";
import { sanitizeMathMarkup } from "@/features/rendering/adapters/math-markup";
import {
  ESVECT_D_ARROW_CLASS,
  ESVECT_D_CLASS,
  ESVECT_D_EDITOR_DEF,
  ESVECT_D_HEAD_RISE_EM,
  ESVECT_D_KATEX_DEF,
  ESVECT_D_MATHLIVE_DEF,
  ESVECT_D_MIN_WIDTH_EM,
  ESVECT_D_SLOT_STYLE,
  esvectArrowTopEm,
  esvectCaretTarget,
  normalizeEsvectMarkup,
  serializeEditorVector,
} from "@/lib/esvect";
import {
  ESVECT_D_HEAD_TOP,
  ESVECT_D_LEFT_SLICE_PATHS,
  ESVECT_D_NATURAL_WIDTH,
  ESVECT_D_RIGHT_SLICE_PATHS,
} from "@/lib/esvect-d-outlines";
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
const arrowTops = (html: string) => [...html.matchAll(new RegExp(`class="${ESVECT_D_ARROW_CLASS}" style="[^"]*top:([\\d.]+)em`, "g"))].map((m) => Number(m[1]));
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

describe("esvect option d \\vv", () => {
  it("is a built-in command for MathLive, KaTeX and validation, with an editor box equal to the static one", () => {
    expect(DEFAULT_MATH_MACRO_SET.mathLiveMacros.vv).toEqual({ def: ESVECT_D_MATHLIVE_DEF, args: 1 });
    expect(DEFAULT_MATH_MACRO_SET.katexMacros[L`\vv`]).toBe(ESVECT_D_KATEX_DEF);
    expect(validateMathTex(L`\vv{AB}+\vv{a}^{2}`)).toEqual([]);
    expect(trustSigmaKatexMacro({ command: L`\htmlClass`, class: ESVECT_D_CLASS })).toBe(true);
    // Editing keeps the operand editable inside exactly the static box (only the marker class differs).
    expect(SIGMA_MATHLIVE_EDITOR_VECTOR_MACRO).toEqual({ def: ESVECT_D_EDITOR_DEF, args: 1, captureSelection: false });
    // The editor box is the text-style branch of the static definition (one editable operand).
    expect(ESVECT_D_MATHLIVE_DEF.startsWith(L`\class{${ESVECT_D_CLASS}}{\mathchoice{`)).toBe(true);
    expect(ESVECT_D_MATHLIVE_DEF).toContain(`{${ESVECT_D_EDITOR_DEF}}{${ESVECT_D_EDITOR_DEF}}`);
    expect(ESVECT_D_EDITOR_DEF.match(/#1/g)).toHaveLength(1);
  });

  it("lets a document's own \\vv override the built-in one", () => {
    const preamble = L`\newcommand{\vv}[1]{\overrightarrow{#1}}`;
    const own = createMathMacroSet(preamble);
    expect(own.mathLiveMacros.vv).toEqual({ args: 1, def: L`\overrightarrow{#1}` });
    expect(own.katexMacros[L`\vv`]).toBe(L`\overrightarrow{#1}`);
    const html = renderMathHtml(L`\vv{AB}`, createMathRenderEnvironment(preamble));
    expect(html).not.toContain(ESVECT_D_ARROW_CLASS);
  });

  it("draws the esvect-d outlines (start rule, stretching line, head) and survives sanitizing", () => {
    const html = renderMathHtml(L`\vv{AB}`, env);
    expect(html).not.toContain("data-math-unrendered");
    expect(count(html, new RegExp(ESVECT_D_ARROW_CLASS, "g"))).toBe(1);
    for (const d of [...ESVECT_D_LEFT_SLICE_PATHS, ...ESVECT_D_RIGHT_SLICE_PATHS]) expect(html).toContain(`d="${d}"`);
    expect(html).toContain('preserveAspectRatio="xMinYMin slice"');
    expect(html).toContain('preserveAspectRatio="xMaxYMin slice"');
    expect(sanitizeMathMarkup(convertLatexToMarkupCached(L`\vv{AB}`, env)).safe).toBe(true);
    // The operand glyphs stay real text; the slot rule is invisible.
    expect(html.replace(/<[^>]+>/g, "")).toBe("AB");
    expect(html).toMatch(/class="ML__rule" style="[^"]*opacity:0/);
  });

  it("reserves esvect's geometry: operand height + 0.368em, the operand's depth, and a 0.8334em minimum width", () => {
    // esvect.dtx: the head (vect10 '024) rises 0.398em over its row, which sits 0.3pt into the operand.
    expect(ESVECT_D_HEAD_TOP / 1000 - 0.03).toBeCloseTo(ESVECT_D_HEAD_RISE_EM, 3);
    expect(ESVECT_D_NATURAL_WIDTH / 1000).toBeCloseTo(ESVECT_D_MIN_WIDTH_EM, 4);
    for (const operand of ["AB", "a", "E", L`\mathrm{A}\mathrm{B}`, "x^{2}", "g", "a_{1}"]) {
      const plain = box(operand), vector = box(L`\vv{${operand}}`);
      expect(Math.abs(vector.height - plain.height - ESVECT_D_HEAD_RISE_EM), operand).toBeLessThanOrEqual(0.011); // struts are 0.01em
      expect(vector.depth, operand).toBeCloseTo(plain.depth, 2);
    }
    const width = (tex: string) => measureTexBoxEm(tex, env).widthEm;
    expect(width(L`\vv{a}`)).toBeCloseTo(ESVECT_D_MIN_WIDTH_EM * 1.05, 2);
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
        const rise = ESVECT_D_HEAD_RISE_EM * scale;
        const plain = wrap(operand), vector = wrap(L`\vv{${operand}}`);
        expect(Math.abs(box(vector).height - box(plain).height - rise), `MathLive ${name} ${operand}`).toBeLessThanOrEqual(0.011);
        expect(katexHeight(vector) - katexHeight(plain), `KaTeX ${name} ${operand}`).toBeCloseTo(rise, 2);
      }
      // The shared width walker: a narrow operand widens to the minimum width, a wide one does not.
      const uWidth = 0.572 * scale; // KaTeX's italic u
      expect(width(wrap(L`\vv{u}`)) - width(wrap("u")), `width ${name}`).toBeCloseTo((ESVECT_D_MIN_WIDTH_EM * scale - uWidth) * 1.05, 2);
      expect(width(wrap(L`\vv{AB}`)), `width ${name}`).toBeCloseTo(width(wrap("AB")), 3);
      // Each engine draws only the branch for the vector's style: one operand, one arrow.
      const html = renderMathHtml(wrap(L`\vv{AB}`), env);
      expect(html.replace(/<[^>]+>/g, ""), name).toBe(name === "text" ? "AB" : name === "script" ? "xAB" : "xyAB");
      expect(count(html, new RegExp(ESVECT_D_ARROW_CLASS, "g")), name).toBe(1);
      // The box is exact, so the arrow is drawn at its top.
      expect(arrowTops(html)[0], name).toBeLessThan(0.02);
    }
  });

  it("measures the arrow from the operand where a box is taller (the editor's single variant)", () => {
    expect(esvectArrowTopEm(1.06, 0.69)).toBeCloseTo(0.002, 6);
    expect(esvectArrowTopEm(0.96, 0.44)).toBeCloseTo(0.152, 6);
    expect(esvectArrowTopEm(Number.NaN, 0.44)).toBe(0);
    expect(ESVECT_D_SLOT_STYLE).toContain("font-size: 70%");
  });

  it("keeps the operand's own overline and nested vectors", () => {
    const html = renderMathHtml(L`\vv{\overline{AB}}+\vv{\vv{a}}+\vv{E}_{\vv{u}_{\vv{u}}}`, env);
    expect(count(html, /class="overline-line"/g)).toBe(1);
    expect(count(html, new RegExp(ESVECT_D_ARROW_CLASS, "g"))).toBe(6);
  });

  it("draws the KaTeX fallback the same way without cramping the operand", () => {
    // KaTeX's \overline would cramp: x^2 inside the vector keeps its normal superscript.
    expect(katexHeight(L`\vv{x^{2}}`) - katexHeight("x^{2}")).toBeCloseTo(ESVECT_D_HEAD_RISE_EM, 2);
    expect(katexHeight(L`\vv{AB}`) - katexHeight("AB")).toBeCloseTo(ESVECT_D_HEAD_RISE_EM, 2);
    const html = normalizeEsvectMarkup(katexHtml(L`\vv{AB}+\overline{c}`));
    expect(count(html, new RegExp(ESVECT_D_ARROW_CLASS, "g"))).toBe(1);
    expect(count(html, /overline-line/g)).toBe(1);
    expect(normalizeEsvectMarkup(html)).toBe(html);
    // Inside a script KaTeX draws only the script variant: one operand, one arrow at the box top.
    const scripted = normalizeEsvectMarkup(katexHtml(L`x_{\vv{u}}`));
    expect(count(scripted, new RegExp(ESVECT_D_ARROW_CLASS, "g"))).toBe(1);
    expect(count(scripted, />u</g)).toBe(1);
  });

  it("leaves unrelated or malformed markup untouched and is idempotent", () => {
    const markup = convertLatexToMarkupCached(L`\overline{AB}`, env);
    expect(normalizeEsvectMarkup(markup)).toBe(markup);
    expect(normalizeEsvectMarkup(`<span class="${ESVECT_D_CLASS}"><span>`)).toBe(`<span class="${ESVECT_D_CLASS}"><span>`);
    const drawn = convertLatexToMarkupCached(L`\vv{AB}`, env);
    expect(normalizeEsvectMarkup(drawn)).toBe(drawn);
  });
});

describe("editor serialization of \\vv", () => {
  type Atom = Parameters<typeof serializeEditorVector>[0];
  interface Fields { type?: string; command?: string; body?: Atom[]; latex?: string }
  const atom = ({ latex = "", ...fields }: Fields): Atom => {
    const result = { ...fields, bodyToLatex: () => latex };
    // MathLive's Atom.serialize(list), reached through the instance's class.
    Object.defineProperty(result, "constructor", { value: { serialize: (list: Atom[]) => list.map((a) => a.bodyToLatex?.({}) ?? "").join("") } });
    return result as unknown as Atom;
  };
  it("writes the CURRENT operand of the box, not MathLive's parse-time macro arguments", () => {
    const vectorBox = atom({ command: L`\overset`, latex: "ACB" });
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ type: "first" }), vectorBox] }), {})).toBe(L`\vv{ACB}`);
  });
  it("keeps editor-inserted neighbours outside the vector and ignores other macros", () => {
    const vectorBox = atom({ command: L`\overset`, latex: "AB" });
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ latex: "2" }), vectorBox, atom({ latex: "x" })] }), {})).toBe(L`2\vv{AB}x`);
    expect(serializeEditorVector(atom({ command: L`\kyoutsuuchoice`, body: [vectorBox] }), {})).toBeNull();
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [atom({ latex: "z" })] }), {})).toBeNull();
    expect(serializeEditorVector(atom({ command: L`\vv`, body: [vectorBox] }), { expandMacro: true })).toBe(L`\vv{AB}`);
  });
});

describe("editor caret inside \\vv", () => {
  // Offsets as MathLive numbers them for `x\vv{AB}+1`: 0 root start, 1 x, 2 macro start,
  // 3 box operand start, 4 A, 5 B, 6 slot start, 7 phantom, 8 after box, 9 after macro.
  type Atom = { command?: string; type?: string; parentBranch?: string; parent?: Atom; leftSibling?: Atom; body?: Atom[]; branch?: (n: string) => Atom[] };
  const x: Atom = { command: "x" };
  const macro: Atom = { command: L`\vv`, type: "macro", leftSibling: x };
  const box: Atom = { command: L`\overset`, parent: macro };
  const operand: Atom[] = [{ type: "first" }, { command: "A" }, { command: "B" }].map((a) => ({ ...a, parent: box, parentBranch: "body" }));
  const slot: Atom[] = [{ type: "first" }, { command: L`\phantom` }].map((a) => ({ ...a, parent: box, parentBranch: "above" }));
  const macroFirst: Atom = { type: "first", parent: macro, parentBranch: "body" };
  macro.body = [macroFirst, box];
  box.branch = (name) => (name === "body" ? operand : slot);
  const atoms: Atom[] = [{ type: "first" }, x, macroFirst, operand[0], operand[1], operand[2], slot[0], slot[1], box, macro];
  const model = { at: (offset: number) => atoms[offset], offsetOf: (atom: Atom) => atoms.indexOf(atom) } as unknown as Parameters<typeof esvectCaretTarget>[0];

  it("keeps the caret on the operand and skips the macro edges and the invisible slot", () => {
    expect(esvectCaretTarget(model, 2, true)).toBe(3); // entering: operand start
    expect(esvectCaretTarget(model, 2, false)).toBe(1); // leaving backwards: before the vector
    expect(esvectCaretTarget(model, 6, true)).toBe(9); // past the operand: after the vector
    expect(esvectCaretTarget(model, 7, false)).toBe(5); // back from the slot: operand end
    expect(esvectCaretTarget(model, 8, false)).toBe(5);
    for (const offset of [0, 1, 3, 4, 5, 9]) expect(esvectCaretTarget(model, offset, true)).toBeNull();
  });
});
