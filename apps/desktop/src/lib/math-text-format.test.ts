import { describe, expect, it } from "vitest";
import { readMathTextFormat, writeMathTextFormat } from "./math-text-format";

describe("whole-formula text formatting", () => {
  it("reads nested bold and italic without treating partial formatting as a whole-formula mark", () => {
    expect(readMathTextFormat(String.raw`\boldsymbol{\mathit{\frac{x}{y}}}`))
      .toEqual({ tex: String.raw`\frac{x}{y}`, bold: true, italic: true });
    for (const tex of [String.raw`\boldsymbol{x}+y`, String.raw`\mathit{x`, String.raw`\boldsymbol{x} `]) {
      expect(readMathTextFormat(tex)).toEqual({ tex, bold: false, italic: false });
    }
    expect(readMathTextFormat(String.raw`\boldsymbol{\{x\}}`).tex).toBe(String.raw`\{x\}`);
  });

  it("writes canonical TeX for both JSON and ProseMirror marks", () => {
    expect(writeMathTextFormat("x", [{ type: "bold" }, { type: "italic" }]))
      .toBe(String.raw`\boldsymbol{\mathit{x}}`);
    expect(writeMathTextFormat("x", [{ type: { name: "bold" } }])).toBe(String.raw`\boldsymbol{x}`);
    expect(writeMathTextFormat(String.raw`\mathbf{x}`, [])).toBe(String.raw`\mathbf{x}`);
  });
});
