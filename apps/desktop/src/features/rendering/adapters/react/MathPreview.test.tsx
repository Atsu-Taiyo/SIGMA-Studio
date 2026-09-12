import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InlineMathPreview, renderMathHtml } from "./MathPreview";
import { DEFAULT_MATH_RENDER_ENVIRONMENT } from "@/lib/math-environment";

describe("InlineMathPreview", () => {
  it("exposes the static math markup used by non-editor render adapters", () => {
    expect(renderMathHtml("x\\iff y", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("⟺");
    expect(renderMathHtml("x^2", DEFAULT_MATH_RENDER_ENVIRONMENT)).toContain("ML__latex");
  });

  it("keeps inline math selection classes on custom frames", () => {
    const html = renderToStaticMarkup(
      <InlineMathPreview
        tex="x^2"
        selected
        textSelected
        editing
        renderFrame={({ className, dataAttributes }) => (
          <span className={className} {...dataAttributes}>
            x
          </span>
        )}
      />,
    );

    expect(html).toContain("inline-math-node");
    expect(html).toContain("selected");
    expect(html).toContain("text-selected");
    expect(html).toContain("editing");
  });
});
