import { describe, expect, it } from "vitest";

import { splitDelimitedInlineMathText } from "./inline-math-delimiters";

describe("splitDelimitedInlineMathText", () => {
  it("returns the whole string as text when there is no delimiter", () => {
    expect(splitDelimitedInlineMathText("ただの文章")).toEqual([
      { type: "text", text: "ただの文章" },
    ]);
  });

  it("splits \\(...\\) delimited math out of surrounding text", () => {
    expect(splitDelimitedInlineMathText("前\\(x^2+1\\)後")).toEqual([
      { type: "text", text: "前" },
      { type: "math", tex: "x^2+1" },
      { type: "text", text: "後" },
    ]);
  });

  it("splits \\[...\\] delimited math", () => {
    expect(splitDelimitedInlineMathText("前\\[x^2\\]後")).toEqual([
      { type: "text", text: "前" },
      { type: "math", tex: "x^2" },
      { type: "text", text: "後" },
    ]);
  });

  it("splits single $...$ delimited math", () => {
    expect(splitDelimitedInlineMathText("前$x^2$後")).toEqual([
      { type: "text", text: "前" },
      { type: "math", tex: "x^2" },
      { type: "text", text: "後" },
    ]);
  });

  it("splits $$...$$ delimited (display) math into a single math segment", () => {
    expect(splitDelimitedInlineMathText("前$$x^2+1$$後")).toEqual([
      { type: "text", text: "前" },
      { type: "math", tex: "x^2+1" },
      { type: "text", text: "後" },
    ]);
  });

  it("does not leave a stray $ when splitting $$...$$ at the start/end of the string", () => {
    expect(splitDelimitedInlineMathText("$$x^2$$")).toEqual([
      { type: "math", tex: "x^2" },
    ]);
  });

  it("handles multiple $$...$$ segments in the same string", () => {
    expect(splitDelimitedInlineMathText("$$a$$と$$b$$")).toEqual([
      { type: "math", tex: "a" },
      { type: "text", text: "と" },
      { type: "math", tex: "b" },
    ]);
  });

  it("handles a mix of $$...$$ and single $...$ in the same string", () => {
    expect(splitDelimitedInlineMathText("$$a$$と$b$")).toEqual([
      { type: "math", tex: "a" },
      { type: "text", text: "と" },
      { type: "math", tex: "b" },
    ]);
  });

  it("does not treat an escaped \\$ as an opening delimiter", () => {
    expect(splitDelimitedInlineMathText("値段は\\$5です")).toEqual([
      { type: "text", text: "値段は\\$5です" },
    ]);
  });

  it("leaves unmatched $$ (no closing pair) as plain text", () => {
    expect(splitDelimitedInlineMathText("$$x^2")).toEqual([
      { type: "text", text: "$$x^2" },
    ]);
  });
});
