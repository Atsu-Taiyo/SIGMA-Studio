import { describe, expect, it } from "vitest";

import {
  applyMathTypesetStyle,
  displayStyleTabularCells,
  growEvaluationBrackets,
  resolveMathTypesetStyle,
} from "./math-typeset-style";

const D = String.raw`\displaystyle`;

describe("applyMathTypesetStyle", () => {
  it("prefixes the whole formula with the document typeset style", () => {
    expect(applyMathTypesetStyle("x^2", "displaystyle")).toBe(`${D} x^2`);
    expect(applyMathTypesetStyle("x^2", "textstyle")).toBe(String.raw`\textstyle x^2`);
  });

  it("leaves textstyle documents alone inside table environments", () => {
    const tex = String.raw`\begin{array}{c}\sum_{k=0}^{n} k\end{array}`;
    expect(applyMathTypesetStyle(tex, "textstyle")).toBe(String.raw`\textstyle ${tex}`);
  });

  it("is idempotent", () => {
    const tex = String.raw`\begin{cases}\sum_{k} k & a\\ b & c\end{cases}`;
    const once = displayStyleTabularCells(tex);
    expect(displayStyleTabularCells(once)).toBe(once);
  });

  it("ignores legacy fraction sizing metadata", () => {
    expect(resolveMathTypesetStyle(undefined)).toBe("displaystyle");
    expect(resolveMathTypesetStyle("uniform")).toBe("displaystyle");
    expect(resolveMathTypesetStyle("texDefault")).toBe("displaystyle");
  });
});

describe("displayStyleTabularCells", () => {
  it("returns formulas without a table environment untouched", () => {
    expect(displayStyleTabularCells(String.raw`\sum_{k=0}^{\infty} x^k`)).toBe(String.raw`\sum_{k=0}^{\infty} x^k`);
    expect(displayStyleTabularCells(String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`))
      .toBe(String.raw`\begin{aligned}a&=b\\c&=d\end{aligned}`);
  });

  it("puts displaystyle in front of every cell of array, matrix and cases", () => {
    expect(displayStyleTabularCells(String.raw`\begin{array}{ll}a & b\\ c & d\end{array}`))
      .toBe(String.raw`\begin{array}{ll}${D} a & ${D} b\\ ${D} c & ${D} d\end{array}`);
    expect(displayStyleTabularCells(String.raw`\begin{pmatrix}1&2\\3&4\end{pmatrix}`))
      .toBe(String.raw`\begin{pmatrix}${D} 1&${D} 2\\${D} 3&${D} 4\end{pmatrix}`);
    expect(displayStyleTabularCells(String.raw`\begin{cases}x & (x>0)\\ 0 & \text{else}\end{cases}`))
      .toBe(String.raw`\begin{cases}${D} x & ${D} (x>0)\\ ${D} 0 & ${D} \text{else}\end{cases}`);
  });

  it("keeps the column spec, rules, row spacing and empty cells in place", () => {
    expect(displayStyleTabularCells(String.raw`\begin{array}[t]{|c@{}c|}\hline a & \\[2pt] \hline & b \\ \hline\end{array}`))
      .toBe(String.raw`\begin{array}[t]{|c@{}c|}\hline ${D} a & \\[2pt] \hline & ${D} b \\ \hline\end{array}`);
    expect(displayStyleTabularCells(String.raw`\begin{bmatrix*}[r] 1 & 2 \end{bmatrix*}`))
      .toBe(String.raw`\begin{bmatrix*}[r] ${D} 1 & ${D} 2 \end{bmatrix*}`);
  });

  it("does not take a leading bracket in the body for a column spec", () => {
    expect(displayStyleTabularCells(String.raw`\begin{pmatrix}[1,2] & 3\end{pmatrix}`))
      .toBe(String.raw`\begin{pmatrix}${D} [1,2] & ${D} 3\end{pmatrix}`);
  });

  it("does not split cells on escaped separators or inside braces and nested environments", () => {
    expect(displayStyleTabularCells(String.raw`\begin{array}{c}a \& b\\ {c & d}\end{array}`))
      .toBe(String.raw`\begin{array}{c}${D} a \& b\\ ${D} {c & d}\end{array}`);
    expect(displayStyleTabularCells(String.raw`\begin{array}{c}\begin{aligned}a&=b\\c&=d\end{aligned}\end{array}`))
      .toBe(String.raw`\begin{array}{c}${D} \begin{aligned}a&=b\\c&=d\end{aligned}\end{array}`);
  });

  it("styles nested table environments cell by cell", () => {
    expect(displayStyleTabularCells(String.raw`\begin{array}{c}\begin{pmatrix}a&b\end{pmatrix}\end{array}`))
      .toBe(String.raw`\begin{array}{c}${D} \begin{pmatrix}${D} a&${D} b\end{pmatrix}\end{array}`);
  });

  it("respects an explicit style the author wrote at the start of a cell", () => {
    expect(displayStyleTabularCells(String.raw`\begin{array}{cc}\textstyle a & \scriptstyle b\end{array}`))
      .toBe(String.raw`\begin{array}{cc}\textstyle a & \scriptstyle b\end{array}`);
  });

  it("respects explicit small style around a table without leaking out of a group", () => {
    const table = String.raw`\begin{pmatrix}\sum_k k\end{pmatrix}`;
    expect(displayStyleTabularCells(String.raw`\textstyle ${table}`)).toBe(String.raw`\textstyle ${table}`);
    expect(displayStyleTabularCells(String.raw`{\textstyle ${table}} ${table}`))
      .toBe(String.raw`{\textstyle ${table}} \begin{pmatrix}${D} \sum_k k\end{pmatrix}`);
  });

  it("handles table environments embedded in a larger formula", () => {
    expect(displayStyleTabularCells(String.raw`\left\{\begin{array}{l}x+y=1\\x-y=0\end{array}\right.\ \text{and}\ \begin{vmatrix}a&b\end{vmatrix}`))
      .toBe(String.raw`\left\{\begin{array}{l}${D} x+y=1\\${D} x-y=0\end{array}\right.\ \text{and}\ \begin{vmatrix}${D} a&${D} b\end{vmatrix}`);
  });

  it("does not touch smallmatrix, whose cells are deliberately small", () => {
    const tex = String.raw`\begin{smallmatrix}a&b\end{smallmatrix}`;
    expect(displayStyleTabularCells(tex)).toBe(tex);
  });

  it("leaves unfinished or mismatched input exactly as typed", () => {
    for (const tex of [
      String.raw`\begin{array}{ll}a & b`,
      String.raw`\begin{pmatrix}a & b\end{bmatrix}`,
      String.raw`\begin{cases}`,
      String.raw`\begin{array}`,
    ]) {
      expect(displayStyleTabularCells(tex)).toBe(tex);
    }
  });
});

describe("growEvaluationBrackets", () => {
  const S = String.raw`\vphantom{\int}`;

  it.each(["\n", "\r\n"])("preserves comment tokens instead of pairing their brackets (%j)", newline => {
    const tex = String.raw`[x % ]_0^1` + newline + String.raw`]_0^1`;
    expect(growEvaluationBrackets(tex)).toBe(tex);
  });

  it("preserves comments after escaped backslashes", () => {
    const tex = String.raw`[x\\% ]_0^1` + "\n" + String.raw`]_0^1`;
    expect(growEvaluationBrackets(tex)).toBe(tex);
  });

  it("still stretches brackets containing an escaped percent sign", () => {
    expect(growEvaluationBrackets(String.raw`[x+20\%]_0^1`))
      .toBe(String.raw`\left[ ${S}x+20\%\right]_0^1`);
  });

  it("grows the [F(x)]_a^b bracket of a definite integral to the integral sign's height", () => {
    expect(growEvaluationBrackets(String.raw`\int_0^1 (3x^2+1)\,dx = \left[ x^3+x \right]_0^1`))
      .toBe(String.raw`\int_0^1 (3x^2+1)\,dx = \left[ ${S} x^3+x \right]_0^1`);
  });

  it("handles the \\lbrack spelling MathLive writes and limits in either order", () => {
    expect(growEvaluationBrackets(String.raw`=\left\lbrack x^3+x\right\rbrack_0^1`))
      .toBe(String.raw`=\left\lbrack ${S} x^3+x\right\rbrack_0^1`);
    expect(growEvaluationBrackets(String.raw`\left[ F(x) \right]^{b}_{a}`))
      .toBe(String.raw`\left[ ${S} F(x) \right]^{b}_{a}`);
  });

  it("leaves brackets without limits, other delimiters and plain intervals alone", () => {
    for (const tex of [
      String.raw`x \in \left[ 0, 1 \right]`,
      String.raw`\left( x \right)_0^1`,
      String.raw`\left\lbrace x \right\rbrace^2`,
      String.raw`\left[ x \right)^2`,
    ]) {
      expect(growEvaluationBrackets(tex)).toBe(tex);
    }
  });

  it("turns a plain [F(x)]_a^b without \\left into a stretchy bracket of the same height", () => {
    expect(growEvaluationBrackets(String.raw`\int_0^1 (3x^2+1)\,dx = [x^3+x]_0^1`))
      .toBe(String.raw`\int_0^1 (3x^2+1)\,dx = \left[ ${S}x^3+x\right]_0^1`);
    expect(growEvaluationBrackets(String.raw`[\frac{1}{3}x^3]_{1}^{2}`))
      .toBe(String.raw`\left[ ${S}\frac{1}{3}x^3\right]_{1}^{2}`);
    expect(growEvaluationBrackets(String.raw`= \quad [x]_0^1`)).toBe(String.raw`= \quad \left[ ${S}x\right]_0^1`);
    expect(growEvaluationBrackets(String.raw`[\sqrt[3]{x} + \left( x \right)]_0^1`))
      .toBe(String.raw`\left[ ${S}\sqrt[3]{x} + \left( x \right)\right]_0^1`);
  });

  it("leaves plain brackets that are intervals, optional arguments or sized delimiters alone", () => {
    for (const tex of [
      String.raw`x \in [0, 1]`,
      String.raw`[0, 1)^2`,
      String.raw`\sqrt[3]{x}^2`,
      String.raw`\begin{aligned}a\\[2pt]_b\end{aligned}`,
      String.raw`\bigl[ x \bigr]_0^1`,
      String.raw`\Big[ x \Big]^1_0`,
      String.raw`{[x}]_0^1`,
      String.raw`[\left( x ]_0^1`,
    ]) {
      expect(growEvaluationBrackets(tex)).toBe(tex);
    }
  });

  it("grows nested and repeated evaluation brackets independently", () => {
    expect(growEvaluationBrackets(String.raw`\left[ \left( x \right) \right]_0^1 + \left[ y \right]_1^2`))
      .toBe(String.raw`\left[ ${S} \left( x \right) \right]_0^1 + \left[ ${S} y \right]_1^2`);
  });

  it("is idempotent and leaves unfinished input untouched", () => {
    const once = growEvaluationBrackets(String.raw`\left[ x \right]_0^1`);
    expect(growEvaluationBrackets(once)).toBe(once);
    expect(growEvaluationBrackets(String.raw`\left[ x \right]_0^1 + \left[ y`)).toBe(String.raw`\left[ x \right]_0^1 + \left[ y`);
    expect(growEvaluationBrackets(String.raw`x \right]_0^1`)).toBe(String.raw`x \right]_0^1`);
  });

  it("is applied only for displaystyle documents", () => {
    const tex = String.raw`\left[ x \right]_0^1`;
    expect(applyMathTypesetStyle(tex, "displaystyle")).toBe(String.raw`${D} \left[ ${S} x \right]_0^1`);
    expect(applyMathTypesetStyle(tex, "textstyle")).toBe(String.raw`\textstyle ${tex}`);
  });
});
