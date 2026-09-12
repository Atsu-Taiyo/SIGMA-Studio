import { describe, expect, it } from "vitest";

import type { SigmaTableSpec } from "@/features/document";

import {
  CHART_CREATE_GAP_PX,
  MIN_CHART_HEIGHT,
  MIN_CHART_WIDTH,
  createChartShapeProps,
  createChartSpecForTable,
  getChartBoundsForTable,
} from "./chart";
import { buildInsertShape } from "./create-shape";

function textTable(matrix: string[][]): SigmaTableSpec {
  const rowIds = matrix.map((_, index) => `r${index + 1}`);
  const columnIds = (matrix[0] ?? []).map((_, index) => `c${index + 1}`);
  return {
    version: 1,
    kind: "plain",
    columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
    rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
    cells: matrix.flatMap((row, rowIndex) => row.map((text, columnIndex) => ({
      id: `${rowIds[rowIndex]}-${columnIds[columnIndex]}`,
      rowId: rowIds[rowIndex],
      columnId: columnIds[columnIndex],
      content: [{
        type: "paragraph" as const,
        id: `${rowIds[rowIndex]}-${columnIds[columnIndex]}-p`,
        children: [{ type: "text" as const, text }],
      }],
    }))),
    grid: { borderColor: "#111827", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

const SCORES = textTable([
  ["", "Math", "Science"],
  ["A", "10", "70"],
  ["B", "50", "20"],
]);

describe("createChartSpecForTable", () => {
  it("starts as a bar chart reading the table the way a person writes one", () => {
    const spec = createChartSpecForTable(SCORES);

    expect({ kind: spec.kind, orientation: spec.orientation, headerRow: spec.headerRow, labelColumn: spec.labelColumn })
      .toEqual({ kind: "bar", orientation: "columns", headerRow: true, labelColumn: true });
  });

  it("pins a colour for every series at creation", () => {
    // Left empty, a later column insert would re-index the fallback and repaint existing series.
    expect(Object.keys(createChartSpecForTable(SCORES).seriesColors)).toEqual(["c2", "c3"]);
  });

  it("gives two series two different colours", () => {
    const colors = Object.values(createChartSpecForTable(SCORES).seriesColors);

    expect(new Set(colors).size).toBe(2);
  });
});

describe("createChartShapeProps", () => {
  it("writes a snapshot at creation", () => {
    // A chart without `dataSnapshot` fails the overlay guard, which makes the whole document
    // refuse to open.
    expect(createChartShapeProps(SCORES, "table-1", 300, 200).dataSnapshot.labels).toEqual(["A", "B"]);
  });

  it("records the table it reads", () => {
    expect(createChartShapeProps(SCORES, "table-1", 300, 200).sourceTableShapeId).toBe("table-1");
  });

  it("keeps a minimum size for a tiny table", () => {
    const props = createChartShapeProps(SCORES, "table-1", 10, 10);

    expect({ w: props.w, h: props.h }).toEqual({ w: MIN_CHART_WIDTH, h: MIN_CHART_HEIGHT });
  });

  it("accepts a localized series-name fallback", () => {
    const props = createChartShapeProps(SCORES, "table-1", 300, 200, {
      seriesNameFallback: (index) => `S${index + 1}`,
    });
    const headerless = createChartShapeProps(
      textTable([["A", "10", "70"], ["B", "50", "20"]]),
      "table-1",
      300,
      200,
      { seriesNameFallback: (index) => `S${index + 1}` },
    );

    expect(props.dataSnapshot.series[0].name).toBe("Math");
    expect(headerless.dataSnapshot.series.length).toBeGreaterThan(0);
  });
});

describe("getChartBoundsForTable", () => {
  it("sits directly beneath the table", () => {
    const bounds = getChartBoundsForTable({ x: 40, y: 60, w: 300, h: 120 });

    expect({ x: bounds.x, y: bounds.y }).toEqual({ x: 40, y: 60 + 120 + CHART_CREATE_GAP_PX });
  });

  it("matches the table's width", () => {
    expect(getChartBoundsForTable({ x: 0, y: 0, w: 300, h: 120 }).w).toBe(300);
  });

  it("is shorter than it is wide", () => {
    const bounds = getChartBoundsForTable({ x: 0, y: 0, w: 300, h: 120 });

    expect(bounds.h).toBeLessThan(bounds.w);
  });
});

describe("buildInsertShape: chart", () => {
  const seed = {
    sourceTableShapeId: "table-1",
    spec: createChartSpecForTable(SCORES),
    dataSnapshot: createChartShapeProps(SCORES, "table-1", 300, 200).dataSnapshot,
  };

  function insert() {
    return buildInsertShape(
      { kind: "insert", command: "chart", chart: seed },
      { x: 10, y: 20 },
      { x: 310, y: 220 },
      "chart-1",
    );
  }

  it("creates a chart shape", () => {
    expect(insert()?.type).toBe("chartShape");
  });

  it("is exactly the size the drag asked for", () => {
    // The drag spans 300x200 from a corner. Reading it as a centre drag would double both.
    const shape = insert();
    if (shape?.type !== "chartShape") throw new Error("not a chart");

    expect({ w: shape.props.w, h: shape.props.h }).toEqual({ w: 300, h: 200 });
  });

  it("starts at the drag origin", () => {
    const shape = insert();

    expect({ x: shape?.x, y: shape?.y }).toEqual({ x: 10, y: 20 });
  });

  it("deep-clones the spec so later edits cannot reach the seed", () => {
    const shape = insert();
    if (shape?.type !== "chartShape") throw new Error("not a chart");
    shape.props.spec.seriesColors.c2 = "#000000";

    expect(seed.spec.seriesColors.c2).not.toBe("#000000");
  });

  it("deep-clones the snapshot too", () => {
    const shape = insert();
    if (shape?.type !== "chartShape") throw new Error("not a chart");

    expect(shape.props.dataSnapshot).not.toBe(seed.dataSnapshot);
  });

  it("writes no anchor of its own", () => {
    // `emitOverlayChange` re-anchors against the canvas; writing one here as well is the
    // "x/y and anchor offset held twice" trap.
    expect(insert()?.anchor).toBeUndefined();
  });

  it("returns nothing without a seed, rather than an unopenable chart", () => {
    expect(buildInsertShape(
      { kind: "insert", command: "chart" },
      { x: 10, y: 20 },
      { x: 310, y: 220 },
      "chart-1",
    )).toBeNull();
  });
});
