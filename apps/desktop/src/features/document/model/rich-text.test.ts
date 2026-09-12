import { describe, expect, it } from "vitest";

import { inlineNodesToPlainText, type InlineNode } from "./rich-text";

describe("inlineNodesToPlainText", () => {
  it("preserves the existing text and inline-math projection", () => {
    const children: InlineNode[] = [
      { type: "text", text: "関数 " },
      { type: "mathInline", id: "math_1", tex: "y=x^2", display: "inline" },
      { type: "text", text: " を考える。" },
    ];

    expect(inlineNodesToPlainText(children))
      .toBe("関数 $y=x^2$ を考える。");
  });
});
