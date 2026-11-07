import { describe, expect, it } from "vitest";

import { measureTexBoxEm } from "@/features/rendering/adapters/math-metrics";
import { renderMathHtml } from "@/features/rendering/adapters/math-html";
import { createMathRenderEnvironment, DEFAULT_MATH_RENDER_ENVIRONMENT as env, type MathRenderEnvironment } from "@/lib/math-environment";
import { convertLatexToMarkupCached, toDrawnMathTex } from "@/lib/math-tex";
import { seatVectorAbsoluteBars, type MathBoxEm } from "@/lib/vector-absolute-bars";

const L = String.raw;
const em = (value: number) => `${Number(value.toFixed(3))}em`;
/**
 * A bar of ordinary ∣ glyphs (0.75em up, 0.25em down) stacked from `bottom` below the baseline to
 * `top`: one at each end, more in between when they would leave a gap, the raised ones smashed and the
 * extent carried by a zero-width strut.
 */
function bar(side: "l" | "r", bottom: number, top: number) {
  const glyph = side === "l" ? L`\lvert` : L`\rvert`;
  const pieces = Math.max(2, Math.ceil((top + bottom) - 1e-9));
  const raises = Array.from({ length: pieces }, (_, i) => (0.25 - bottom) + ((top - 0.75) - (0.25 - bottom)) * i / (pieces - 1));
  const piece = (raise: number) => `\\smash{\\raisebox{${em(raise)}}{$${glyph}$}}`;
  const stack = raises.slice(0, -1).map((raise) => `\\mathrlap{${piece(raise)}}`).join("") + piece(raises.at(-1)!);
  return `\\math${side === "l" ? "open" : "close"}{${stack}\\rule[${em(-bottom)}]{0em}{${em(top + bottom)}}}`;
}
const bars = (body: string, top: number, bottom = 0.25) => `{${bar("l", bottom, top)}${body}${bar("r", bottom, top)}}`;
/** The static MathLive box of `tex`, as the transform measures it. */
function box(tex: string, environment: MathRenderEnvironment = env): MathBoxEm {
  const markup = convertLatexToMarkupCached(tex, environment);
  return {
    height: Number(/class="ML__strut" style="height:(-?[0-9.]+)em"/.exec(markup)![1]),
    depth: Number(/class="ML__strut--bottom" style="height:[0-9.]+em;vertical-align:-([0-9.]+)em"/.exec(markup)?.[1] ?? 0),
  };
}

describe("absolute value bars around a vector", () => {
  it("run from where an ordinary | ends up to the top of the vector, exactly", () => {
    const tex = L`\left|\vv{AB}\right|^{2}`;
    expect(box(L`\vv{AB}`)).toEqual({ height: 1.04, depth: 0 });
    expect(toDrawnMathTex(tex, env)).toBe(`${bars(L`\vv{AB}`, 1.04)}^{2}`);
    // Every spelling of the bars.
    expect(toDrawnMathTex(L`\left\lvert\vv{AB}\right\rvert`, env)).toBe(bars(L`\vv{AB}`, 1.04));
    expect(toDrawnMathTex(L`\left \vert\vv{AB}\right \vert`, env)).toBe(bars(L`\vv{AB}`, 1.04));
    // Several in a row, and sums or multiples of vectors: each fits its own operand.
    expect(toDrawnMathTex(L`\left|\vv{AB}\right|\left|\vv{AC}\right|\cos\theta`, env))
      .toBe(L`${bars(L`\vv{AB}`, 1.04)}${bars(L`\vv{AC}`, 1.04)}\cos\theta`);
    expect(toDrawnMathTex(L`\left|2\vv{a}+\vv{b}\right|`, env)).toBe(bars(L`2\vv{a}+\vv{b}`, box(L`2\vv{a}+\vv{b}`).height));

    // The line no longer hangs a full em below the baseline: the bars end where | does.
    const metrics = measureTexBoxEm(tex, env);
    expect(metrics.descentEm).toBeLessThanOrEqual(measureTexBoxEm("|x|", env).descentEm + 1e-9);
    expect(metrics.ascentEm).toBeGreaterThanOrEqual(measureTexBoxEm(L`\vv{AB}`, env).ascentEm);
    // Drawn by MathLive, through the sanitizer.
    const html = renderMathHtml(tex, env);
    expect(html).not.toContain("data-math-unrendered");
    expect(convertLatexToMarkupCached(tex, env)).not.toMatch(/class="[^"]*\bML__error\b/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("AB");
    expect(html).toMatch(/class="ML__rule" style="[^"]*border-top-width:1\.29em;vertical-align:-0\.25em/);
  });

  it("fit a vector raised by a script or lowered by a subscript, where fixed sizes would overshoot", () => {
    // |OA²→|: the superscript lifts the arrow to 1.22em; \Big bars would reach 1.55em.
    for (const body of [L`\vv{OA^2}`, L`\vv{OA}^{2}`]) {
      expect(box(body).height).toBe(1.22);
      expect(toDrawnMathTex(L`\left|${body}\right|`, env)).toBe(bars(body, 1.22));
    }
    // |a₁→|: a subscript above the ordinary bottom keeps the ordinary bottom.
    expect(toDrawnMathTex(L`\left|\vv{a_{1}}\right|`, env)).toBe(bars(L`\vv{a_{1}}`, 0.79));
    // An operand reaching lower than | takes its own bottom.
    expect(box(L`\vv{q}_{j}`)).toEqual({ height: 0.79, depth: 0.36 });
    expect(toDrawnMathTex(L`\left|\vv{q}_{j}\right|`, env)).toBe(bars(L`\vv{q}_{j}`, 0.79, 0.36));
  });

  it("give every vector bars of its own height, lowercase ones included", () => {
    // An ordinary | would leave the arrow of |a→| sticking out, and |a→| = |b→| = 1 would carry bars of two heights.
    expect(toDrawnMathTex(L`\left|\vv{a}\right|=\left|\vv{b}\right|=1`, env)).toBe(`${bars(L`\vv{a}`, 0.79)}=${bars(L`\vv{b}`, 1.05)}=1`);
    for (const letter of ["x", "p"]) {
      const body = `\\vv{${letter}}`;
      const { height, depth } = box(body);
      expect(toDrawnMathTex(`\\left|${body}\\right|`, env)).toBe(bars(body, height, Math.max(depth, 0.25)));
    }
    // The import writes |a→| as \left\lvert…\right\rvert; it is drawn the same way.
    expect(toDrawnMathTex(L`{\left\lvert {\vv{a}}\right\rvert }`, env)).toBe(`{${bars(L` {\vv{a}}`, 0.79)} }`);
    // The legacy long arrow and a document's own \vv are measured as they draw.
    expect(toDrawnMathTex(L`\left|\overrightarrow{AB}\right|`, env)).toBe(bars(L`\overrightarrow{AB}`, box(L`\overrightarrow{AB}`).height));
    const own = createMathRenderEnvironment(L`\newcommand{\vv}[1]{\overrightarrow{#1}}`);
    expect(toDrawnMathTex(L`\left|\vv{AB}\right|`, own)).toBe(bars(L`\vv{AB}`, box(L`\vv{AB}`, own).height));
  });

  it("keeps automatic bars elsewhere", () => {
    for (const tex of [
      L`\left|x\right|`, // no vector
      L`\left|\vec{a}\right|`, // an ordinary | already reaches the short arrow
      L`\left(\vv{AB}\right)`, // not absolute-value bars
      L`\left|\frac{\vv{a}}{2}\right|`, // stacked operands stay centred on the axis
      L`\left|\sum_{k}\vv{a_k}\right|`,
      L`e^{\left|\vv{AB}\right|}`, // inside a script
      L`\left|\vv{AB}\right| % note`, // a comment could hide a delimiter
      L`\left|\vv{AB}`, // unfinished
    ]) expect(toDrawnMathTex(tex, env), tex).toBe(tex);
  });
});

describe("seatVectorAbsoluteBars", () => {
  // A ruler: an ordinary | spans 0.75 + 0.25; the vectors stand 1em, 0.79em and 0.75em tall.
  const boxes: Record<string, MathBoxEm> = {
    [L`\lvert`]: { height: 0.75, depth: 0.25 },
    [L`\vv{s}`]: { height: 0.79, depth: 0 }, [L`\vec{s}`]: { height: 0.75, depth: 0 },
  };
  const measure = (tex: string) => boxes[tex] ?? { height: 1, depth: 0 };

  it("reads delimiters as tokens and finds only top-level pairs outside scripts", () => {
    const seated = bars(L`\vv{a}`, 1);
    expect(seatVectorAbsoluteBars(L`\vv{a}\leftarrow\left|\vv{a}\right|`, measure)).toBe(L`\vv{a}\leftarrow` + seated);
    expect(seatVectorAbsoluteBars(L`\tfrac{\left|\vv{a}\right|}{2}`, measure)).toBe(L`\tfrac{\left|\vv{a}\right|}{2}`);
    expect(seatVectorAbsoluteBars(L`{\scriptstyle\left|\vv{a}\right|}`, measure)).toBe(L`{\scriptstyle\left|\vv{a}\right|}`);
    expect(seatVectorAbsoluteBars(L`x_{\left|\vv{a}\right|}+\left|\vv{a}\right|`, measure)).toBe(L`x_{\left|\vv{a}\right|}+` + seated);
    // Fitted as soon as the operand stands taller than an ordinary |.
    expect(seatVectorAbsoluteBars(L`\left|\vv{s}\right|`, measure)).toBe(bars(L`\vv{s}`, 0.79));
    expect(seatVectorAbsoluteBars(L`\left|\vec{s}\right|`, measure)).toBe(L`\left|\vec{s}\right|`);
    // An outer pair holding another \left…\right keeps automatic bars; the inner one is fitted.
    expect(seatVectorAbsoluteBars(L`\left|\left|\vv{a}\right|\vv{b}\right|`, measure)).toBe(L`\left|` + seated + L`\vv{b}\right|`);
    // Unbalanced braces or pairs: unchanged.
    expect(seatVectorAbsoluteBars(L`\left|\vv{a}}\right|`, measure)).toBe(L`\left|\vv{a}}\right|`);
    expect(seatVectorAbsoluteBars(L`\vv{a}\right|`, measure)).toBe(L`\vv{a}\right|`);
  });
});
