import { describe, expect, it } from "vitest";

import {
  applyMathTypesetStyle,
  displayStyleTabularCells,
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

  it("maps the fraction sizing option onto the typeset style", () => {
    expect(resolveMathTypesetStyle(undefined)).toBe("displaystyle");
    expect(resolveMathTypesetStyle("uniform")).toBe("displaystyle");
    expect(resolveMathTypesetStyle("texDefault")).toBe("textstyle");
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
