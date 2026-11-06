import { describe, expect, it } from "vitest";

import { measureTexBoxEm } from "@/features/rendering/adapters/math-metrics";
import { renderMathHtml } from "@/features/rendering/adapters/math-html";
import { createMathRenderEnvironment, DEFAULT_MATH_RENDER_ENVIRONMENT as env } from "@/lib/math-environment";
import { convertLatexToMarkupCached, toDrawnMathTex } from "@/lib/math-tex";
import { seatVectorAbsoluteBars, type MathBoxEm } from "@/lib/vector-absolute-bars";

const L = String.raw;
/** A bar seated on the baseline: `size` glyph raised by `raise`, carried by an exact strut. */
const bar = (side: "l" | "r", size: string, raise: string, total: string) =>
  L`\math` + (side === "l" ? "open" : "close")
  + `{\\smash{\\raisebox{${raise}em}{$\\${size}${side}\\${side}vert$}}\\rule[-0.25em]{0em}{${total}em}}`;
/** |AB→| as Sigma Studio draws it, the same bars the import writes for \vv. */
const VV_BARS = (body: string) => `{${bar("l", "big", "0.1", "1.19")}${body}${bar("r", "big", "0.1", "1.19")}}`;

describe("absolute value bars around a vector", () => {
  it("sit on the baseline like an ordinary | and reach up to the arrow", () => {
    const tex = L`\left|\vv{AB}\right|^{2}`;
    expect(toDrawnMathTex(tex, env)).toBe(`${VV_BARS(L`\vv{AB}`)}^{2}`);
    // Every spelling of the bars.
    expect(toDrawnMathTex(L`\left\lvert\vv{AB}\right\rvert`, env)).toBe(VV_BARS(L`\vv{AB}`));
    expect(toDrawnMathTex(L`\left \vert\vv{AB}\right \vert`, env)).toBe(VV_BARS(L`\vv{AB}`));
    // Several in a row, and sums or multiples of vectors.
    expect(toDrawnMathTex(L`\left|\vv{AB}\right|\left|\vv{AC}\right|\cos\theta`, env))
      .toBe(L`${VV_BARS(L`\vv{AB}`)}${VV_BARS(L`\vv{AC}`)}\cos\theta`);
    expect(toDrawnMathTex(L`\left|2\vv{a}+\vv{b}\right|`, env)).toBe(VV_BARS(L`2\vv{a}+\vv{b}`));
    // A lowercase vector gets the same bars: an ordinary | would leave its arrow sticking out,
    // and |a→| = |b→| = 1 would carry bars of two heights.
    expect(toDrawnMathTex(L`\left|\vv{a}\right|=\left|\vv{b}\right|=1`, env)).toBe(`${VV_BARS(L`\vv{a}`)}=${VV_BARS(L`\vv{b}`)}=1`);
    for (const letter of ["x", "p"]) expect(toDrawnMathTex(`\\left|\\vv{${letter}}\\right|`, env)).toBe(VV_BARS(`\\vv{${letter}}`));
    // The import writes |a→| as \left\lvert…\right\rvert; it is drawn the same way.
    expect(toDrawnMathTex(L`{\left\lvert {\vv{a}}\right\rvert }`, env)).toBe(`{${VV_BARS(L` {\vv{a}}`)} }`);

    // The line no longer hangs a full em below the baseline: the bars end where | does.
    const bars = measureTexBoxEm(tex, env);
    expect(bars.descentEm).toBeLessThanOrEqual(measureTexBoxEm("|x|", env).descentEm + 1e-9);
    expect(bars.ascentEm).toBeGreaterThanOrEqual(measureTexBoxEm(L`\vv{AB}`, env).ascentEm);
    // Drawn by MathLive, through the sanitizer.
    const html = renderMathHtml(tex, env);
    expect(html).not.toContain("data-math-unrendered");
    expect(convertLatexToMarkupCached(tex, env)).not.toMatch(/class="[^"]*\bML__error\b/);
    expect(html.replace(/<[^>]+>/g, "")).toContain("AB");
  });

  it("fit the arrow each vector command draws", () => {
    // The legacy long arrow is taller: \Big bars, as the import writes for it.
    expect(toDrawnMathTex(L`\left|\overrightarrow{AB}\right|`, env))
      .toBe(`{${bar("l", "Big", "0.4", "1.79")}\\overrightarrow{AB}${bar("r", "Big", "0.4", "1.79")}}`);
    // A document's own \vv is measured with its own definition.
    const own = createMathRenderEnvironment(L`\newcommand{\vv}[1]{\overrightarrow{#1}}`);
    expect(toDrawnMathTex(L`\left|\vv{AB}\right|`, own))
      .toBe(`{${bar("l", "Big", "0.4", "1.79")}\\vv{AB}${bar("r", "Big", "0.4", "1.79")}}`);
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
  // A ruler: an ordinary | spans 0.75 + 0.25; \big 0.85 + 0.35; the vector stands 1em tall.
  const boxes: Record<string, MathBoxEm> = {
    [L`\lvert`]: { height: 0.75, depth: 0.25 },
    [L`\bigl\lvert`]: { height: 0.85, depth: 0.35 }, [L`\bigr\rvert`]: { height: 0.85, depth: 0.35 },
    [L`\vv{s}`]: { height: 0.79, depth: 0 }, [L`\vec{s}`]: { height: 0.75, depth: 0 },
  };
  const measure = (tex: string) => boxes[tex] ?? { height: 1, depth: 0 };

  it("reads delimiters as tokens and finds only top-level pairs outside scripts", () => {
    const seated = VV_LIKE(L`\vv{a}`);
    expect(seatVectorAbsoluteBars(L`\vv{a}\leftarrow\left|\vv{a}\right|`, measure)).toBe(L`\vv{a}\leftarrow` + seated);
    expect(seatVectorAbsoluteBars(L`\tfrac{\left|\vv{a}\right|}{2}`, measure)).toBe(L`\tfrac{\left|\vv{a}\right|}{2}`);
    expect(seatVectorAbsoluteBars(L`{\scriptstyle\left|\vv{a}\right|}`, measure)).toBe(L`{\scriptstyle\left|\vv{a}\right|}`);
    expect(seatVectorAbsoluteBars(L`x_{\left|\vv{a}\right|}+\left|\vv{a}\right|`, measure)).toBe(L`x_{\left|\vv{a}\right|}+` + seated);
    // Seated as soon as the operand stands taller than an ordinary |, even within 90.1% of it.
    expect(seatVectorAbsoluteBars(L`\left|\vv{s}\right|`, measure)).toBe(VV_LIKE(L`\vv{s}`));
    expect(seatVectorAbsoluteBars(L`\left|\vec{s}\right|`, measure)).toBe(L`\left|\vec{s}\right|`);
    // An outer pair holding another \left…\right keeps automatic bars; the inner one is seated.
    expect(seatVectorAbsoluteBars(L`\left|\left|\vv{a}\right|\vv{b}\right|`, measure)).toBe(L`\left|` + seated + L`\vv{b}\right|`);
    // Unbalanced braces or pairs: unchanged.
    expect(seatVectorAbsoluteBars(L`\left|\vv{a}}\right|`, measure)).toBe(L`\left|\vv{a}}\right|`);
    expect(seatVectorAbsoluteBars(L`\vv{a}\right|`, measure)).toBe(L`\vv{a}\right|`);
  });

  /** With the ruler above: \big glyph raised 0.1em, strut 1.2em from 0.25em below the baseline. */
  function VV_LIKE(body: string) {
    return `{${bar("l", "big", "0.1", "1.2")}${body}${bar("r", "big", "0.1", "1.2")}}`;
  }
});
