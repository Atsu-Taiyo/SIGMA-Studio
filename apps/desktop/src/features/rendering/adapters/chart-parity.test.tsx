import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverlayShapeReadOnlyView } from "@/components/editor/overlay-canvas/shape-renderer";
import type {
  OverlayShape,
  SigmaChartData,
  SigmaChartSpec,
  SigmaTableCell,
  SigmaTableSpec,
} from "@/features/document";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";

/**
 * A chart is drawn on three surfaces — the editor canvas, the static React tree and the SVG export.
 * All three mount `OverlayChartStaticView` over `getChartRenderLayout`, and these tests hold that
 * arrangement up: the same chart must come out of the editor and out of the export with identical
 * geometry and identical colours, and the live/snapshot choice must survive every narrowing the
 * export does before it draws.
 */

function paragraphCell(rowId: string, columnId: string, text: string): SigmaTableCell {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    content: [{ type: "paragraph", id: `${rowId}-${columnId}-p`, children: [{ type: "text", text }] }],
  };
}

function textTable(matrix: string[][]): SigmaTableSpec {
  const rowIds = matrix.map((_, index) => `r${index + 1}`);
  const columnIds = (matrix[0] ?? []).map((_, index) => `c${index + 1}`);
  return {
    version: 1,
    kind: "plain",
    columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
    rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
    cells: matrix.flatMap((row, rowIndex) => (
      row.map((text, columnIndex) => paragraphCell(rowIds[rowIndex], columnIds[columnIndex], text))
    )),
    grid: { borderColor: "#111827", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

const SCORES = textTable([
  ["", "Math", "Science"],
  ["A", "10", "70"],
  ["B", "50", "20"],
]);

const SNAPSHOT: SigmaChartData = {
  labels: ["frozen"],
  series: [{ id: "c2", name: "Math", values: [99] }],
};

function chartSpec(overrides: Partial<SigmaChartSpec> = {}): SigmaChartSpec {
  return {
    version: 1,
    kind: "bar",
    orientation: "columns",
    headerRow: true,
    labelColumn: true,
    legend: true,
    seriesColors: {},
    ...overrides,
  };
}

function tableShape(id: string, table: SigmaTableSpec, extra: Partial<OverlayShape> = {}): OverlayShape {
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    props: { w: 200, h: 120, table },
    ...extra,
  } as OverlayShape;
}

function chartShape(
  id: string,
  spec: SigmaChartSpec,
  sourceTableShapeId?: string,
  extra: Partial<OverlayShape> = {},
): OverlayShape {
  return {
    id,
    type: "chartShape",
    x: 40,
    y: 300,
    props: {
      w: 360,
      h: 240,
      spec,
      ...(sourceTableShapeId ? { sourceTableShapeId } : {}),
      dataSnapshot: SNAPSHOT,
    },
    ...extra,
  } as OverlayShape;
}

/** The chart's own `<svg>`, stripped of the wrapper each surface puts around it. */
function chartSvgFrom(markup: string): string {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = markup;
  const svg = container.querySelector(".chart-shape-svg");
  return svg ? svg.outerHTML : "";
}

function editorChartSvg(shape: OverlayShape, sourceTable: SigmaTableSpec | null): string {
  return chartSvgFrom(renderToStaticMarkup(
    <OverlayShapeReadOnlyView assets={{}} chartSourceTable={sourceTable} shape={shape} />,
  ));
}

function exportChartSvg(shapes: OverlayShape[]): string {
  return chartSvgFrom(exportOverlaySvg(shapes, {}, { width: 800, height: 1000 }) ?? "");
}

describe("chart parity: editor DOM and SVG export", () => {
  it("draws the same chart on both surfaces", () => {
    const chart = chartShape("chart", chartSpec(), "table");

    expect(exportChartSvg([tableShape("table", SCORES), chart]))
      .toBe(editorChartSvg(chart, SCORES));
  });

  it("agrees on a chart drawn from its snapshot", () => {
    const chart = chartShape("chart", chartSpec());

    expect(exportChartSvg([chart])).toBe(editorChartSvg(chart, null));
  });

  it.each(["bar", "line", "pie", "scatter"] as const)("agrees on a %s chart", (kind) => {
    const chart = chartShape("chart", chartSpec({ kind }), "table");
    const exported = exportChartSvg([tableShape("table", SCORES), chart]);

    // Both surfaces returning "" would satisfy the comparison without either having drawn anything.
    expect(exported.length).toBeGreaterThan(0);
    expect(exported).toBe(editorChartSvg(chart, SCORES));
  });

  it("agrees on the author's series colours", () => {
    const chart = chartShape("chart", chartSpec({ seriesColors: { c2: "#123456", c3: "#654321" } }), "table");
    const exported = exportChartSvg([tableShape("table", SCORES), chart]);

    expect(exported).toBe(editorChartSvg(chart, SCORES));
    expect(exported).toContain("#123456");
  });

  it("actually produced a chart rather than agreeing on emptiness", () => {
    const chart = chartShape("chart", chartSpec(), "table");

    expect(exportChartSvg([tableShape("table", SCORES), chart])).toContain("<rect");
  });
});

describe("chart live linkage", () => {
  it("follows an edit to the table it references", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const before = exportChartSvg([tableShape("table", SCORES), chart]);
    const edited = textTable([
      ["", "Math", "Science"],
      ["A", "70", "70"],
      ["B", "50", "20"],
    ]);

    expect(exportChartSvg([tableShape("table", edited), chart])).not.toBe(before);
  });

  it("keeps drawing from the snapshot once the table is gone", () => {
    const chart = chartShape("chart", chartSpec(), "table");

    expect(exportChartSvg([chart])).toBe(editorChartSvg(chart, null));
  });

  it("draws the snapshot's own values when the reference is broken", () => {
    const chart = chartShape("chart", chartSpec(), "missing-table");

    expect(exportChartSvg([chart])).toBe(editorChartSvg(chart, null));
  });
});

describe("chart reference resolution crosses the export's narrowing", () => {
  it("resolves a table that is hidden", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const hidden = tableShape("table", SCORES, { hidden: true });

    expect(exportChartSvg([hidden, chart])).toBe(editorChartSvg(chart, SCORES));
  });

  it("resolves a table on the background stack layer", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const background = tableShape("table", SCORES, { stackLayer: "background" });

    expect(exportChartSvg([background, chart])).toBe(editorChartSvg(chart, SCORES));
  });

  it("resolves a table that sits outside the exported viewport", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const faraway = tableShape("table", SCORES, { y: 90_000 } as Partial<OverlayShape>);

    expect(exportChartSvg([faraway, chart])).toBe(editorChartSvg(chart, SCORES));
  });

  it("does not fall back to the snapshot merely because the table was filtered out", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const hidden = tableShape("table", SCORES, { hidden: true });

    expect(exportChartSvg([hidden, chart])).not.toBe(editorChartSvg(chart, null));
  });
});

describe("chart export markup", () => {
  it("positions the chart with a transform rather than redrawing at an offset", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const svg = exportOverlaySvg([tableShape("table", SCORES), chart], {}, { width: 800, height: 1000 }) ?? "";

    expect(svg).toContain('<g transform="translate(40 300)">');
  });

  it("keeps the camelCase viewBox that XML re-parsing needs", () => {
    const chart = chartShape("chart", chartSpec(), "table");

    expect(exportChartSvg([tableShape("table", SCORES), chart])).toContain("viewBox=");
  });

  it("uses no foreignObject, so the figure needs no stylesheet", () => {
    const chart = chartShape("chart", chartSpec(), "table");
    const svg = exportOverlaySvg([chart], {}, { width: 800, height: 1000 }) ?? "";

    expect(svg).not.toContain("foreignObject");
  });

  it("carries its colours as attributes rather than classes", () => {
    const chart = chartShape("chart", chartSpec({ seriesColors: { c2: "#123456" } }), "table");

    expect(exportChartSvg([tableShape("table", SCORES), chart])).toContain('fill="#123456"');
  });
});
