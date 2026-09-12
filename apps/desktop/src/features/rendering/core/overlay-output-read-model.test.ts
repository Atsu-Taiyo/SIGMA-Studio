import { describe, expect, it } from "vitest";

import type { OverlayShape, SigmaTableSpec, SigmaTableTrackSize } from "@/features/document";

import {
  getEffectiveShapeOpacity,
  getRenderableShapes,
  getRenderableShapesInVisualStackOrder,
  getShapesForStackLayer,
  getTableCellBorderStyles,
  getTableGridModel,
  getTableTrendGlyphModel,
  getTableVerticalLineKey,
  overlayLabelFontSize,
  overlayStrokeWidth,
  resolveTableColumnWidths,
  resolveTableLineBorder,
  resolveTableRowHeights,
} from ".";

function rectangle(
  id: string,
  options: Partial<OverlayShape> = {},
): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 40,
      h: 20,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
    ...options,
  } as OverlayShape;
}

describe("overlay output read model", () => {
  it("keeps persisted stroke and label size presentation values", () => {
    const sizes = ["s", "m", "l", "xl"] as const;
    expect(sizes.map(overlayStrokeWidth)).toEqual([1.25, 2, 3, 5]);
    expect(sizes.map(overlayLabelFontSize)).toEqual([14, 18, 22, 28]);
  });

  it("omits groups and shapes hidden through their parent", () => {
    const shapes: OverlayShape[] = [
      {
        id: "group",
        type: "group",
        x: 0,
        y: 0,
        hidden: true,
        props: { w: 40, h: 20 },
      },
      rectangle("child", { parentId: "group" }),
      rectangle("visible"),
    ];

    expect(getRenderableShapes(shapes).map((shape) => shape.id)).toEqual(["visible"]);
  });

  it("inherits stack layer and opacity through nested groups", () => {
    const shapes: OverlayShape[] = [
      {
        id: "group",
        type: "group",
        x: 0,
        y: 0,
        stackLayer: "background",
        opacity: 0.5,
        props: { w: 40, h: 20 },
      },
      rectangle("child", { parentId: "group", opacity: 0.4 }),
      rectangle("foreground"),
    ];

    expect(getShapesForStackLayer(shapes, "background").map((shape) => shape.id))
      .toEqual(["group", "child"]);
    expect(getShapesForStackLayer(shapes, "foreground").map((shape) => shape.id))
      .toEqual(["foreground"]);
    expect(getEffectiveShapeOpacity(shapes, shapes[1])).toBeCloseTo(0.2);
    expect(getRenderableShapesInVisualStackOrder(shapes).map((shape) => shape.id))
      .toEqual(["child", "foreground"]);
  });

  it("resolves table tracks and border overrides as an output read model", () => {
    const table: SigmaTableSpec = {
      version: 1,
      kind: "plain",
      columns: [
        { id: "c1", width: { mode: "auto", min: 48 } },
        { id: "c2", width: { mode: "fr", value: 1, min: 52 } },
      ],
      rows: [
        { id: "r1", height: { mode: "auto", min: 24 } },
        { id: "r2", height: { mode: "fr", value: 1, min: 30 } },
      ],
      cells: [],
      grid: {
        borderColor: "#111827",
        borderWidth: 1,
        borderStyle: "solid",
        lineOverrides: [{
          axis: "vertical",
          beforeColumnId: "c2",
          style: {
            borderColor: "#dc2626",
            borderStyle: "dotted",
            borderWidth: 3,
          },
        }],
      },
      defaultCellStyle: {},
    };

    expect(resolveTableColumnWidths(table, 180)).toEqual([48, 132]);
    expect(resolveTableRowHeights(table, 100)).toEqual([24, 76]);
    const separator = getTableVerticalLineKey(table, 1);
    expect(separator).not.toBeNull();
    expect(resolveTableLineBorder(table, separator!)).toEqual({
      visible: true,
      borderColor: "#dc2626",
      borderWidth: 3,
      borderStyle: "dotted",
    });
    expect(getTableCellBorderStyles(table, 0, 0).borderRight)
      .toBe("3px dotted #dc2626");
  });
});

function tableWithTracks(
  columns: SigmaTableTrackSize[],
  rows: SigmaTableTrackSize[],
): SigmaTableSpec {
  return {
    version: 1,
    kind: "plain",
    columns: columns.map((width, index) => ({ id: `c${index + 1}`, width })),
    rows: rows.map((height, index) => ({ id: `r${index + 1}`, height })),
    cells: [],
    grid: { borderColor: "#111827", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/**
 * The resolved track sizes have to add up to the shape's box, and that total is the load-bearing
 * part rather than an incidental one.
 *
 * Every surface renders the table as `<table style="height: h"><tr style="height: rowHeight">`, so
 * when the declared rows added up to less than `h` the browser stretched them to fill it — while
 * the overlay that draws `double` boundaries stayed at the unstretched offsets. That is why the
 * editor used to re-measure its own rendered rows (a measure/render feedback loop) and why the PDF,
 * which cannot measure anything, drew those boundaries off the cell edges entirely.
 */
describe("table track sizes as the drawn geometry", () => {
  it("fills the shape when no track is flexible", () => {
    const table = tableWithTracks(
      [{ mode: "fixed", value: 100 }, { mode: "fixed", value: 100 }],
      [{ mode: "fixed", value: 30 }, { mode: "fixed", value: 30 }],
    );

    expect(resolveTableRowHeights(table, 132)).toEqual([66, 66]);
    expect(resolveTableColumnWidths(table, 460)).toEqual([230, 230]);
  });

  it("expands auto tracks in proportion, the way the browser distributes the leftover", () => {
    // The default plain table: three `auto` rows in a 124px shape. Chrome resolves the same
    // 43.02 / 40.49 / 40.49 out of `<tr height=34/32/32>` inside `<table height=124>`, which is why
    // matching it here does not move the drawn cell edges.
    const table = tableWithTracks(
      [{ mode: "fixed", value: 260 }],
      [{ mode: "auto", min: 34 }, { mode: "auto", min: 32 }, { mode: "auto", min: 32 }],
    );
    const heights = resolveTableRowHeights(table, 124);

    expect(sum(heights)).toBeCloseTo(124, 6);
    expect(heights[0]).toBeCloseTo(43.0204, 3);
    expect(heights[1]).toBeCloseTo(40.4898, 3);
    expect(heights[2]).toBeCloseTo(40.4898, 3);
  });

  it("keeps shrinking tracks proportionally when they do not fit", () => {
    const table = tableWithTracks(
      [{ mode: "fixed", value: 100 }, { mode: "fixed", value: 100 }],
      [{ mode: "auto", min: 40 }, { mode: "auto", min: 20 }],
    );

    expect(resolveTableColumnWidths(table, 30)).toEqual([15, 15]);
    expect(resolveTableRowHeights(table, 30)).toEqual([20, 10]);
  });

  it("pushes the residual a max clamp leaves over into the tracks that can still take it", () => {
    const table = tableWithTracks(
      [{ mode: "auto", min: 48 }, { mode: "fr", value: 1, min: 56, max: 60 }],
      [{ mode: "auto", min: 20, max: 30 }, { mode: "auto", min: 20 }],
    );

    expect(resolveTableColumnWidths(table, 400)).toEqual([340, 60]);
    expect(resolveTableRowHeights(table, 100)).toEqual([30, 70]);
  });

  it("scales past max rather than leave the total short", () => {
    // `max` is a preference; the total is not. The browser never sees `max` and would distribute the
    // difference itself, which is exactly the drift this function exists to remove.
    const table = tableWithTracks(
      [{ mode: "auto", min: 10, max: 20 }, { mode: "auto", min: 10, max: 20 }],
      [{ mode: "auto", min: 10, max: 20 }, { mode: "auto", min: 30, max: 20 }],
    );

    expect(resolveTableColumnWidths(table, 100)).toEqual([50, 50]);
    expect(sum(resolveTableRowHeights(table, 100))).toBeCloseTo(100, 6);
  });

  it("adds up to the requested total for every shape of track list", () => {
    const trackSets: SigmaTableTrackSize[][] = [
      [{ mode: "fixed", value: 30 }],
      [{ mode: "auto" }],
      [{ mode: "fr", value: 1 }],
      [{ mode: "fixed", value: 30 }, { mode: "auto", min: 32 }],
      [{ mode: "auto", min: 48, max: 96 }, { mode: "fr", value: 1, min: 56 }],
      [{ mode: "auto", min: 48, max: 96 }, { mode: "fr", value: 1, min: 56, max: 58 }],
      [{ mode: "fr", value: 0 }, { mode: "fr", value: 0 }],
      [{ mode: "auto", min: 0 }, { mode: "auto", min: 0 }],
      [{ mode: "fixed", value: 400 }, { mode: "auto", min: 200 }],
    ];
    const totals = [1, 12, 60, 124, 400];
    const offenders: string[] = [];

    for (const tracks of trackSets) {
      for (const total of totals) {
        const table = tableWithTracks(tracks, tracks);
        const widths = resolveTableColumnWidths(table, total);
        const heights = resolveTableRowHeights(table, total);
        for (const [axis, sizes] of [["columns", widths], ["rows", heights]] as const) {
          if (Math.abs(sum(sizes) - total) > 1e-6) {
            offenders.push(
              `${axis} ${JSON.stringify(tracks)} @${total} -> ${sum(sizes)}`,
            );
          }
        }
      }
    }

    expect(offenders, offenders.join("\n")).toEqual([]);
  });

  it("ends the offsets on the shape's own edge so the outer boundary is drawn there", () => {
    const table = tableWithTracks(
      [{ mode: "auto", min: 20 }, { mode: "auto", min: 20 }],
      [{ mode: "auto", min: 20 }, { mode: "auto", min: 20 }],
    );
    const grid = getTableGridModel(table, 300, 140);

    expect(grid.columnOffsets[grid.columnOffsets.length - 1]).toBeCloseTo(300, 6);
    expect(grid.rowOffsets[grid.rowOffsets.length - 1]).toBeCloseTo(140, 6);
    expect(grid.rows.map((row) => row.height)).toEqual(grid.rowHeights);
  });

  it("leaves an empty track list empty", () => {
    const table = tableWithTracks([], []);

    expect(resolveTableColumnWidths(table, 200)).toEqual([]);
    expect(resolveTableRowHeights(table, 200)).toEqual([]);
  });

  it("honours max even when every track asked for nothing", () => {
    const table = tableWithTracks(
      [{ mode: "auto", min: 0, max: 5 }, { mode: "auto", min: 0 }],
      [{ mode: "auto", min: 0 }, { mode: "auto", min: 0 }],
    );

    expect(resolveTableColumnWidths(table, 100)).toEqual([5, 95]);
    expect(resolveTableRowHeights(table, 100)).toEqual([50, 50]);
  });

  it("falls back to the declared sizes for a shape with no usable box", () => {
    // A broken document can carry `props.h: NaN`. Arithmetic against it used to reach the style
    // model and put `top: NaNpx` into the SVG export.
    const table = tableWithTracks(
      [{ mode: "fixed", value: 40 }, { mode: "fixed", value: 60 }],
      [{ mode: "fixed", value: 30 }, { mode: "fixed", value: 30 }],
    );

    expect(resolveTableColumnWidths(table, Number.NaN)).toEqual([40, 60]);
    expect(resolveTableRowHeights(table, Number.POSITIVE_INFINITY)).toEqual([30, 30]);
  });
});

/**
 * The trend arrow used to be drawn three times over: this SVG in the static view, and a KaTeX
 * `\nearrow` in both the cell editor and the table settings preview. The geometry lives here so all
 * three read it, and the numbers are written as literals rather than derived from the formula —
 * a derived expectation would follow a wrong edit instead of catching it.
 */
describe("the table trend glyph model", () => {
  it("keeps a single-column arrow 44px wide and 24px tall", () => {
    expect(getTableTrendGlyphModel("up", 1)).toEqual({
      width: 44,
      height: 24,
      line: { x1: 6, y1: 18, x2: 37, y2: 6 },
      arrowPoints: "38,6 32,4.5 35,10",
      color: "#111827",
      strokeWidth: 1,
    });
  });

  it("points a down arrow the other way around the same line", () => {
    const down = getTableTrendGlyphModel("down", 1);

    expect(down.line).toEqual({ x1: 6, y1: 6, x2: 37, y2: 18 });
    expect(down.arrowPoints).toBe("38,18 32,19.5 35,14");
  });

  it("draws a flat arrow along the vertical centre", () => {
    const flat = getTableTrendGlyphModel("flat", 1);

    expect(flat.line).toEqual({ x1: 6, y1: 12, x2: 37, y2: 12 });
    // A horizontal arrow head, not the slanted one the up/down glyphs use.
    expect(flat.arrowPoints).toBe("38,12 32,9 32,15");
  });

  it("stretches the arrow across a merged cell", () => {
    expect(getTableTrendGlyphModel("up", 2).width).toBe(76);
    expect(getTableTrendGlyphModel("up", 3).width).toBe(114);
    expect(getTableTrendGlyphModel("up", 2).line).toEqual({ x1: 6, y1: 18, x2: 69, y2: 6 });
    expect(getTableTrendGlyphModel("up", 2).arrowPoints).toBe("70,6 64,4.5 67,10");
    // The head stays 6px from the right edge whatever the span, so a wider cell only lengthens the
    // shaft.
    expect(getTableTrendGlyphModel("down", 3).arrowPoints).toBe("108,18 102,19.5 105,14");
  });

  it("never draws narrower than the 42px floor", () => {
    // Carried over verbatim from the static view. It cannot bind for a whole-numbered span (a span
    // of 1 is 44px and a span of 2 already 76px), and is kept because this change is not allowed to
    // move any of the drawn numbers.
    expect(getTableTrendGlyphModel("flat", 0).width).toBe(44);
    expect(getTableTrendGlyphModel("flat", 1.05).width).toBe(42);
  });
});
