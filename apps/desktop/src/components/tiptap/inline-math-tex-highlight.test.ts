import { describe, expect, it } from "vitest";

import { getInlineMathTexHighlightSegments } from "./inline-math-tex-highlight";

describe("getInlineMathTexHighlightSegments", () => {
  it("marks commands recognized by MathLive", () => {
    expect(getInlineMathTexHighlightSegments("E=mc^2\\sum k=\\frac12")).toEqual([
      { text: "E=mc^2", recognizedCommand: false },
      { text: "\\sum", recognizedCommand: true },
      { text: " k=", recognizedCommand: false },
      { text: "\\frac", recognizedCommand: true },
      { text: "12", recognizedCommand: false },
    ]);
  });

  it("does not mark unknown commands", () => {
    expect(getInlineMathTexHighlightSegments("\\sqrt{x}+\\unknown{x}")).toEqual([
      { text: "\\sqrt", recognizedCommand: true },
      { text: "{x}+", recognizedCommand: false },
      { text: "\\unknown", recognizedCommand: false },
      { text: "{x}", recognizedCommand: false },
    ]);
  });

  it("keeps recognized commands marked while their arguments are incomplete", () => {
    expect(getInlineMathTexHighlightSegments("\\frac")).toEqual([
      { text: "\\frac", recognizedCommand: true },
    ]);
  });

  it("marks commands supported by the KaTeX preview fallback", () => {
    expect(getInlineMathTexHighlightSegments(String.raw`\begin{array}{c}a\\\hline b\end{array}+\dots`))
      .toEqual([
        { text: "\\begin", recognizedCommand: true },
        { text: "{array}{c}a", recognizedCommand: false },
        { text: "\\\\", recognizedCommand: true },
        { text: "\\hline", recognizedCommand: true },
        { text: " b", recognizedCommand: false },
        { text: "\\end", recognizedCommand: true },
        { text: "{array}+", recognizedCommand: false },
        { text: "\\dots", recognizedCommand: true },
      ]);
  });

  it("preserves multiline text and leaves a trailing backslash unmarked", () => {
    expect(getInlineMathTexHighlightSegments("x\n\\sqrt{y}\\")).toEqual([
      { text: "x\n", recognizedCommand: false },
      { text: "\\sqrt", recognizedCommand: true },
      { text: "{y}\\", recognizedCommand: false },
    ]);
  });
});
