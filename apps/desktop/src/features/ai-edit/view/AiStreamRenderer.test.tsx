import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiStreamRenderer } from "./AiStreamRenderer";

describe("AiStreamRenderer", () => {
  it("renders inline and multiline display math in AI chat text", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer
        text={[
          "二次関数は $y=x^2$ と表せます。",
          "",
          "$$",
          "\\frac{1}{2}x^2",
          "$$",
        ].join("\n")}
      />,
    );

    expect(html).toContain("math-preview-inline");
    expect(html).toContain("math-preview-display");
    expect(html).toContain("inline-math-node");
    expect(html).toContain("display-math-node");
    expect(html).not.toContain("$$");
  });

  it("preserves regular line breaks while parsing math across a paragraph", () => {
    const html = renderToStaticMarkup(
      <AiStreamRenderer text={"1行目\n2行目 \\(x+1\\)"} />,
    );

    expect(html).toContain("<br/>");
    expect(html).toContain("math-preview-inline");
  });
});
