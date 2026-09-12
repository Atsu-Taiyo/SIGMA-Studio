import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createPlainTableSpec } from "./shapes/table";
import { OverlayTableRenderedLines } from "./table-rendered-lines";

describe("OverlayTableRenderedLines", () => {
  it("renders only dedicated double borders, in vertical-horizontal-connector order", () => {
    const table = createPlainTableSpec(1, 1);
    table.grid.borderStyle = "double";
    table.grid.borderWidth = 3;

    const markup = renderToStaticMarkup(
      <OverlayTableRenderedLines
        table={table}
        columnOffsets={[0, 80]}
        rowOffsets={[0, 40]}
      />,
    );
    const verticalIndex = markup.indexOf("overlay-table-rendered-line vertical");
    const horizontalIndex = markup.indexOf("overlay-table-rendered-line horizontal");
    const connectorIndex = markup.indexOf("overlay-table-line-connector");

    expect(verticalIndex).toBeGreaterThan(-1);
    expect(horizontalIndex).toBeGreaterThan(verticalIndex);
    expect(connectorIndex).toBeGreaterThan(horizontalIndex);
    expect(markup).toContain("3px double #111827");
  });

  it("does not create a dedicated overlay for ordinary solid borders", () => {
    const table = createPlainTableSpec(1, 1);

    const markup = renderToStaticMarkup(
      <OverlayTableRenderedLines
        table={table}
        columnOffsets={[0, 80]}
        rowOffsets={[0, 40]}
      />,
    );

    expect(markup).toBe('<div class="overlay-table-rendered-lines" aria-hidden="true"></div>');
  });
});
