import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { AiSourceReferenceChips } from "./AiSourceReferenceChips";

describe("AiSourceReferenceChips", () => {
  it("renders document, material, and web references with their compact labels", () => {
    const html = renderToStaticMarkup(
      <AiSourceReferenceChips
        sourceReferences={[
          { type: "document", fileId: "doc-1", title: "一次関数", blockId: "p-1" },
          { type: "material", materialId: "material-1", name: "座標平面" },
          { type: "web", url: "https://example.com/reference", title: "参考資料" },
        ]}
      />,
    );

    expect(html).toContain("参照元");
    expect(html).toContain("一次関数");
    expect(html).toContain("座標平面");
    expect(html).toContain("example.com");
    expect(html).toContain('title="doc-1 (p-1)"');
  });

  it("renders an actionable document chip when navigation is available", () => {
    const html = renderToStaticMarkup(
      <AiSourceReferenceChips
        sourceReferences={[{ type: "document", fileId: "doc-1" }]}
        onOpenDocument={() => undefined}
      />,
    );

    expect(html).toContain("<button");
    expect(html).toContain("doc-1");
    expect(html).toContain("ai-source-ref-chip--document");
  });
});
