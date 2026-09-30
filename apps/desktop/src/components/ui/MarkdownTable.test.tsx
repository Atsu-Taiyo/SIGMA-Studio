import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MarkdownTable } from "./MarkdownTable";

describe("MarkdownTable", () => {
  it("renders a header row and body rows, aligned per column", () => {
    const html = renderToStaticMarkup(
      <MarkdownTable
        header={["項目", "値"]}
        rows={[["a", "1"], ["b", "2"]]}
        alignments={["left", "right"]}
      />,
    );

    expect(html).toContain("data-markdown-table");
    expect(html.match(/<th[ >]/g)).toHaveLength(2);
    expect(html.match(/<td[ >]/g)).toHaveLength(4);
    expect(html).toContain("text-align:right");
    expect(html).not.toContain("text-align:left;text-align");
  });

  it("pads short rows and drops extra cells so every row matches the header", () => {
    const html = renderToStaticMarkup(
      <MarkdownTable header={["a", "b"]} rows={[["1"], ["1", "2", "3"]]} />,
    );

    expect(html.match(/<td[ >]/g)).toHaveLength(4);
    expect(html).not.toContain(">3<");
  });
});
