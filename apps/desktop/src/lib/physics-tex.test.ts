import { describe, expect, it } from "vitest";
import { convertLatexToMarkup } from "mathlive";
import katex from "katex";
import { normalizePhysicsTex, isPhysicsTexCommand, physicsFenceInputTemplate } from "./physics-tex";
import { createMathMacroSet } from "./math-macros";
import { installMathLivePhysics } from "./mathlive-physics";
import { convertLatexToMarkupCached, validateMathTex, toMathLivePreviewTex, toKatexPreviewTex } from "./math-tex";
import { createMathRenderEnvironment } from "./math-environment";

describe("built-in physics delimiters", () => {
  it.each([
    [String.raw`\qty(\frac{1}{2})`, String.raw`\left( \frac{1}{2} \right)`],
    [String.raw`\qty[\frac{1}{2}]`, String.raw`\left[ \frac{1}{2} \right]`],
    [String.raw`\qty{\frac{1}{2}}`, String.raw`\left\{ \frac{1}{2} \right\}`],
    [String.raw`\qty|\frac{1}{2}|`, String.raw`\left| \frac{1}{2} \right|`],
    [String.raw`\quantity(x)`, String.raw`\left( x \right)`],
    [String.raw`\pqty{x}`, String.raw`\left( x \right)`],
    [String.raw`\bqty{x}`, String.raw`\left[ x \right]`],
    [String.raw`\Bqty{x}`, String.raw`\left\{ x \right\}`],
    [String.raw`\vqty{x}`, String.raw`\left| x \right|`],
    [String.raw`\abs{x}`, String.raw`\left\lvert x \right\rvert`],
    [String.raw`\absolutevalue{x}`, String.raw`\left\lvert x \right\rvert`],
    [String.raw`\norm{x}`, String.raw`\left\lVert x \right\rVert`],
    [String.raw`\qty\Big{\frac{1}{2}}`, String.raw`\Bigl\{ \frac{1}{2} \Bigr\}`],
    [String.raw`\abs*{x}`, String.raw`\lvert x \rvert`],
  ])("normalizes %s consistently for both renderers", (source, expanded) => {
    expect(normalizePhysicsTex(source)).toBe(expanded);
    expect(normalizePhysicsTex(expanded)).toBe(expanded);
    expect(convertLatexToMarkup(expanded)).not.toMatch(/class="[^"]*\bML__error\b/);
    expect(() => katex.renderToString(expanded, { throwOnError: true })).not.toThrow();
  });

  it("creates an editable pair when a typed command receives its opening delimiter", () => {
    expect(physicsFenceInputTemplate("qty", "(")).toBe(String.raw`\left(\placeholder{}\right)`);
    expect(physicsFenceInputTemplate("quantity", "[")).toBe(String.raw`\left[\placeholder{}\right]`);
    expect(physicsFenceInputTemplate("qty", "{")).toBe(String.raw`\left\{\placeholder{}\right\}`);
    expect(physicsFenceInputTemplate("qty", "|")).toBe(String.raw`\left|\placeholder{}\right|`);
    expect(physicsFenceInputTemplate("norm", "{")).toBe(String.raw`\left\lVert\placeholder{}\right\rVert`);
    expect(physicsFenceInputTemplate("qty", "(", new Set(["qty"]))).toBeNull();
    expect(physicsFenceInputTemplate("pqty", "(")).toBeNull();
    expect(physicsFenceInputTemplate("qty", "a")).toBeNull();
    expect(physicsFenceInputTemplate("frac", "{")).toBeNull();
  });

  it("uses the same expansion for validation, static output and fallback with no preamble", () => {
    const environment = createMathRenderEnvironment();
    const tex = String.raw`\qty(\frac{1}{2})+\norm{x}`;
    expect(validateMathTex(tex)).toEqual([]);
    expect(toMathLivePreviewTex(tex)).toBe(toKatexPreviewTex(tex));
    const html = convertLatexToMarkupCached(tex, environment);
    expect(html).not.toMatch(/class="[^"]*\bML__error\b|katex-error/);
    expect(html).not.toContain("qty");
    const fallback = convertLatexToMarkupCached(tex + String.raw`+\dots`, environment);
    expect(fallback).toContain("katex");
    expect(fallback).not.toContain("katex-error");
  });

  it("handles nested delimiters, escaped braces, fractions and nested vertical quantities", () => {
    const source = String.raw`\qty|\qty|x|+\qty(\frac{a_{(1)}}{b}+\{c\})|`;
    expect(normalizePhysicsTex(source)).toBe(String.raw`\left| \left| x \right|+\left( \frac{a_{(1)}}{b}+\{c\} \right) \right|`);
  });

  it.each([
    [String.raw`\qty(\text{(}+x)`, String.raw`\left( \text{(}+x \right)`],
    [String.raw`\qty{\text{[}}`, String.raw`\left\{ \text{[} \right\}`],
    [String.raw`\qty(\frac{(}{x}+a_{[})`, String.raw`\left( \frac{(}{x}+a_{[} \right)`],
    [String.raw`\qty({\qty[x]}+y)`, String.raw`\left( {\left[ x \right]}+y \right)`],
  ])("respects opaque TeX groups in %s", (source, expected) => {
    expect(normalizePhysicsTex(source)).toBe(expected);
  });

  it.each([String.raw`\qty(`, String.raw`\qty[\frac{a}{b}`, String.raw`\qty|x`, String.raw`\qtyfoo(x)`, String.raw`\qty{1}{m}`, String.raw`\text{\qty(x)}`, String.raw`\operatorname{\qty(x)}`, String.raw`% \qty(x)`])(
    "does not guess at incomplete, literal, unrelated or siunitx input: %s", (source) => {
      expect(normalizePhysicsTex(source)).toBe(source);
    },
  );

  it.each([
    "text", "mbox", "textrm", "textbf", "textit", "texttt", "textsf", "textup",
    "textnormal", "textmd", "textsl", "textsc", "operatorname",
  ])("preserves physics-looking literal text in %s", (command) => {
    const source = `\\${command}{\\qty(x) and \\norm{y}}+\\qty(z)`;
    expect(normalizePhysicsTex(source)).toBe(`\\${command}{\\qty(x) and \\norm{y}}+\\left( z \\right)`);
  });

  it("keeps document overrides and expands physics inside other custom definitions", () => {
    const builtins = createMathMacroSet(String.raw`\newcommand{\around}[1]{\qty(#1)}`);
    expect(builtins.mathLiveMacros.around?.def).toBe(String.raw`\left( #1 \right)`);
    expect(builtins.katexMacros[String.raw`\around`]).toBe(String.raw`\left( #1 \right)`);
    const custom = createMathMacroSet(String.raw`\newcommand{\qty}[2]{#1\,\mathrm{#2}}\newcommand{\measure}{\qty{2}{m}}`);
    expect(custom.mathLiveMacros.measure?.def).toBe(String.raw`\qty{2}{m}`);
    expect(normalizePhysicsTex(String.raw`\qty{2}{m}`, custom.physicsOverrides)).toBe(String.raw`\qty{2}{m}`);
    expect(isPhysicsTexCommand(String.raw`\qty`)).toBe(true);
    expect(isPhysicsTexCommand(String.raw`\dv`)).toBe(false);
  });

  it("bounds deeply nested or malformed input", () => {
    const nested = String.raw`\qty(`.repeat(1000) + "x" + ")".repeat(1000);
    expect(() => normalizePhysicsTex(nested)).not.toThrow();
    expect(normalizePhysicsTex(String.raw`\qty(`.repeat(1000))).toBe(String.raw`\qty(`.repeat(1000));
    // Braces use their own scanner. A missing close at every command used to
    // rescan the complete remaining suffix and block the UI on pasted TeX.
    const unclosedGroups = String.raw`\qty{`.repeat(20_000);
    expect(normalizePhysicsTex(unclosedGroups)).toBe(unclosedGroups);
  });

  it("normalizes field value, setValue and insert without changing options or stacking wrappers", () => {
    class Field {
      raw = "";
      option: unknown;
      get value() { return this.raw; }
      set value(value: string) { this.setValue(value); }
      setValue(value: string, option?: unknown) { this.raw = value; this.option = option; return true; }
      insert(value: string, option?: unknown) { this.raw += value; this.option = option; return false; }
    }
    const field = new Field();
    installMathLivePhysics(field);
    field.value = String.raw`\qty(x)`;
    expect(field.value).toBe(String.raw`\left( x \right)`);
    const options = { selectionMode: "after" };
    expect(field.setValue(String.raw`\qty[x]`, options)).toBe(true);
    expect(field.value).toBe(String.raw`\left[ x \right]`);
    expect(field.option).toBe(options);
    expect(field.insert(String.raw`\qty{y}`, options)).toBe(false);
    expect(field.value).toContain(String.raw`\left\{ y \right\}`);
    const wrapped = field.insert;
    installMathLivePhysics(field, new Set(["qty"]));
    expect(field.insert).toBe(wrapped);
    field.value = String.raw`\qty(x)`;
    expect(field.value).toBe(String.raw`\qty(x)`);
    field.value = String.raw`\qty(`;
    expect(field.value).toBe(String.raw`\qty(`);
  });
});
