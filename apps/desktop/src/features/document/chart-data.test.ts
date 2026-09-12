import { describe, expect, it } from "vitest";

import {
  assignChartSeriesColors,
  deriveChartData,
  deriveChartSnapshotData,
  parseChartNumber,
  resolveChartData,
  resolveChartSeriesColor,
  syncChartDataSnapshots,
  chartDataEquals,
} from "./chart-data";
import { CHART_SERIES_FALLBACK_COLOR, CHART_SERIES_PALETTE } from "./model/chart";
import type { SigmaChartData, SigmaChartSpec } from "./model/chart";
import type { OverlayShape, SigmaTableCell, SigmaTableSpec } from "./overlay-model";

function paragraphCell(
  rowId: string,
  columnId: string,
  text: string,
  span: { rowSpan?: number; colSpan?: number } = {},
): SigmaTableCell {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    ...span,
    content: [{
      type: "paragraph",
      id: `${rowId}-${columnId}-p`,
      children: [{ type: "text", text }],
    }],
  };
}

function trendCell(rowId: string, columnId: string): SigmaTableCell {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    content: [{ type: "trend", id: `${rowId}-${columnId}-t`, direction: "up" }],
  };
}

function tableOf(rowIds: string[], columnIds: string[], cells: SigmaTableCell[]): SigmaTableSpec {
  return {
    version: 1,
    kind: "plain",
    columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
    rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
    cells,
    grid: { borderColor: "#000000", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

/** Builds a table from a text matrix; `null` means the table declares no cell at that position. */
function textTable(matrix: (string | null)[][]): SigmaTableSpec {
  const rowIds = matrix.map((_, index) => `r${index + 1}`);
  const columnIds = (matrix[0] ?? []).map((_, index) => `c${index + 1}`);
  const cells = matrix.flatMap((row, rowIndex) => (
    row.flatMap((text, columnIndex) => (
      text === null ? [] : [paragraphCell(rowIds[rowIndex], columnIds[columnIndex], text)]
    ))
  ));
  return tableOf(rowIds, columnIds, cells);
}

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

const SCORES = textTable([
  ["", "Math", "Science"],
  ["Class A", "80", "70"],
  ["Class B", "60", "90"],
]);

describe("deriveChartData: default column orientation", () => {
  it("labels the rows from the first column", () => {
    expect(deriveChartData(SCORES, chartSpec()).labels).toEqual(["Class A", "Class B"]);
  });

  it("names each series after its header cell", () => {
    expect(deriveChartData(SCORES, chartSpec()).series.map((series) => series.name))
      .toEqual(["Math", "Science"]);
  });

  it("identifies each series by the column it was read from", () => {
    expect(deriveChartData(SCORES, chartSpec()).series.map((series) => series.id))
      .toEqual(["c2", "c3"]);
  });

  it("reads the values of a series down its column", () => {
    expect(deriveChartData(SCORES, chartSpec()).series.map((series) => series.values))
      .toEqual([[80, 60], [70, 90]]);
  });

  it("numbers the labels when the table has no label column", () => {
    expect(deriveChartData(SCORES, chartSpec({ labelColumn: false })).labels).toEqual(["1", "2"]);
  });
});

describe("deriveChartData: transposed orientation", () => {
  it("labels the categories from the header row", () => {
    expect(deriveChartData(SCORES, chartSpec({ orientation: "rows" })).labels)
      .toEqual(["Math", "Science"]);
  });

  it("turns each row into a series named by the label column", () => {
    expect(deriveChartData(SCORES, chartSpec({ orientation: "rows" })).series)
      .toEqual([
        { id: "r2", name: "Class A", values: [80, 70] },
        { id: "r3", name: "Class B", values: [60, 90] },
      ]);
  });
});

describe("deriveChartData: header handling", () => {
  it("falls back to the series ordinal when there is no header row", () => {
    expect(deriveChartData(SCORES, chartSpec({ headerRow: false })).series.map((series) => series.name))
      .toEqual(["1", "2"]);
  });

  it("treats the first row as data when there is no header row", () => {
    expect(deriveChartData(SCORES, chartSpec({ headerRow: false })).series[0].values)
      .toEqual([null, 80, 60]);
  });

  it("lets the caller supply a localized fallback name", () => {
    const data = deriveChartData(SCORES, chartSpec({ headerRow: false }), {
      seriesNameFallback: (index) => `Series ${index + 1}`,
    });

    expect(data.series.map((series) => series.name)).toEqual(["Series 1", "Series 2"]);
  });

  it("falls back when the header cell is blank", () => {
    const table = textTable([["", "", "Science"], ["A", "1", "2"]]);

    expect(deriveChartData(table, chartSpec()).series.map((series) => series.name))
      .toEqual(["1", "Science"]);
  });
});

describe("deriveChartData: cells that hold no number", () => {
  it("gaps a value rather than dropping the row", () => {
    const table = textTable([
      ["", "Value"],
      ["a", ""],
      ["b", "—"],
      ["c", "abc"],
      ["d", "5"],
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([null, null, null, 5]);
  });

  it("keeps a label for every gapped row", () => {
    const table = textTable([["", "Value"], ["a", ""], ["b", "5"]]);

    expect(deriveChartData(table, chartSpec()).labels).toEqual(["a", "b"]);
  });

  it("gaps a position the table declares no cell for", () => {
    const table = textTable([["", "Value"], ["a", null], ["b", "5"]]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([null, 5]);
  });

  it("gaps a trend cell", () => {
    const table = tableOf(["r1", "r2", "r3"], ["c1", "c2"], [
      paragraphCell("r1", "c2", "Value"),
      paragraphCell("r2", "c1", "a"),
      trendCell("r2", "c2"),
      paragraphCell("r3", "c1", "b"),
      paragraphCell("r3", "c2", "5"),
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([null, 5]);
  });

  it("gaps a cell holding two paragraphs, which is not one number", () => {
    const ambiguous: SigmaTableCell = {
      id: "r2-c2",
      rowId: "r2",
      columnId: "c2",
      content: [
        { type: "paragraph", id: "p1", children: [{ type: "text", text: "1" }] },
        { type: "paragraph", id: "p2", children: [{ type: "text", text: "2" }] },
      ],
    };
    const table = tableOf(["r1", "r2", "r3"], ["c1", "c2"], [
      paragraphCell("r1", "c2", "Value"),
      paragraphCell("r2", "c1", "a"),
      ambiguous,
      paragraphCell("r3", "c1", "b"),
      paragraphCell("r3", "c2", "5"),
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([null, 5]);
  });

  it("drops a column that holds no number at all", () => {
    const table = textTable([["", "Note"], ["a", "x"], ["b", "y"]]);

    expect(deriveChartData(table, chartSpec()).series).toEqual([]);
  });
});

describe("parseChartNumber", () => {
  it("reads full-width digits", () => {
    expect(parseChartNumber("１２３")).toBe(123);
  });

  it("reads a thousands separator", () => {
    expect(parseChartNumber("1,234")).toBe(1234);
  });

  it("reads a typographic minus sign", () => {
    expect(parseChartNumber("−5")).toBe(-5);
  });

  it("reads a decimal", () => {
    expect(parseChartNumber("-3.5")).toBe(-3.5);
  });

  it("reads a number written as inline math", () => {
    expect(parseChartNumber("$42$")).toBe(42);
  });

  it("reads exponential notation", () => {
    expect(parseChartNumber("1e3")).toBe(1000);
  });

  it("reads a leading decimal point", () => {
    expect(parseChartNumber(".5")).toBe(0.5);
  });

  it("rejects an empty string", () => {
    expect(parseChartNumber("")).toBeNull();
  });

  it("rejects an em dash", () => {
    expect(parseChartNumber("—")).toBeNull();
  });

  it("rejects a hex literal", () => {
    expect(parseChartNumber("0x10")).toBeNull();
  });

  it("rejects Infinity", () => {
    expect(parseChartNumber("Infinity")).toBeNull();
  });

  it("rejects a number with a unit", () => {
    expect(parseChartNumber("5kg")).toBeNull();
  });

  it("reads a full thousands grouping", () => {
    expect(parseChartNumber("1,234,567")).toBe(1234567);
  });

  it("rejects two numbers separated by a space rather than splicing them", () => {
    expect(parseChartNumber("1 2")).toBeNull();
  });

  it("rejects two multi-digit numbers separated by a space", () => {
    expect(parseChartNumber("10 20")).toBeNull();
  });

  it("rejects a comma-and-space separated pair", () => {
    expect(parseChartNumber("2026, 8")).toBeNull();
  });

  it("rejects an ambiguous European decimal comma", () => {
    expect(parseChartNumber("1,2")).toBeNull();
  });

  it("rejects a comma that does not group digits in threes", () => {
    expect(parseChartNumber("12,34")).toBeNull();
  });
});

describe("deriveChartData: merged cells", () => {
  it("gives every column a merged header covers the same series name", () => {
    const table = tableOf(["r1", "r2"], ["c1", "c2", "c3"], [
      paragraphCell("r1", "c2", "Scores", { colSpan: 2 }),
      paragraphCell("r2", "c1", "a"),
      paragraphCell("r2", "c2", "1"),
      paragraphCell("r2", "c3", "2"),
    ]);

    expect(deriveChartData(table, chartSpec()).series.map((series) => series.name))
      .toEqual(["Scores", "Scores"]);
  });

  it("gives every row a merged value covers the same value", () => {
    const table = tableOf(["r1", "r2", "r3"], ["c1", "c2"], [
      paragraphCell("r1", "c2", "Value"),
      paragraphCell("r2", "c1", "a"),
      paragraphCell("r2", "c2", "5", { rowSpan: 2 }),
      paragraphCell("r3", "c1", "b"),
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([5, 5]);
  });
});

describe("deriveChartData: pie", () => {
  it("draws the first series only", () => {
    const table = textTable([["", "A", "B"], ["x", "1", "9"], ["y", "2", "8"]]);

    expect(deriveChartData(table, chartSpec({ kind: "pie" })).series.map((series) => series.id))
      .toEqual(["c2"]);
  });

  it("drops the slices that cannot be part of a whole", () => {
    const table = textTable([["", "A"], ["w", "10"], ["x", "-5"], ["y", ""], ["z", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "pie" })).series[0].values).toEqual([10, 20]);
  });

  it("keeps the labels aligned with the slices it kept", () => {
    const table = textTable([["", "A"], ["w", "10"], ["x", "-5"], ["y", ""], ["z", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "pie" })).labels).toEqual(["w", "z"]);
  });

  it("has nothing to draw when no column holds a number", () => {
    const table = textTable([["", "A"], ["w", "x"]]);

    expect(deriveChartData(table, chartSpec({ kind: "pie" }))).toEqual({ labels: [], series: [] });
  });
});

describe("deriveChartData: scatter", () => {
  it("takes x from the label column when the labels are numeric", () => {
    const table = textTable([["", "y"], ["1", "10"], ["2", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "scatter" })).xValues).toEqual([1, 2]);
  });

  it("keeps every series to plot when the labels supply x", () => {
    const table = textTable([["", "y"], ["1", "10"], ["2", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "scatter" })).series.map((series) => series.id))
      .toEqual(["c2"]);
  });

  it("takes x from the first numeric series when the labels are prose", () => {
    const table = textTable([["", "x", "y"], ["a", "1", "10"], ["b", "2", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "scatter" })).xValues).toEqual([1, 2]);
  });

  it("stops plotting the series it spent on x", () => {
    const table = textTable([["", "x", "y"], ["a", "1", "10"], ["b", "2", "20"]]);

    expect(deriveChartData(table, chartSpec({ kind: "scatter" })).series.map((series) => series.id))
      .toEqual(["c3"]);
  });

  it("has no x when there is no numeric column either", () => {
    const table = textTable([["", "note"], ["a", "x"]]);

    expect(deriveChartData(table, chartSpec({ kind: "scatter" })).xValues).toBeUndefined();
  });
});

describe("assignChartSeriesColors", () => {
  it("assigns the palette in order", () => {
    expect(assignChartSeriesColors(["c2", "c3"])).toEqual({
      c2: CHART_SERIES_PALETTE[0],
      c3: CHART_SERIES_PALETTE[1],
    });
  });

  it("leaves an existing series its colour when a column is inserted before it", () => {
    const before = assignChartSeriesColors(["c2", "c3"]);
    const after = assignChartSeriesColors(["c2", "c4", "c3"], before);

    expect({ c2: after.c2, c3: after.c3 }).toEqual({ c2: before.c2, c3: before.c3 });
  });

  it("gives the inserted column a colour nobody is using", () => {
    const before = assignChartSeriesColors(["c2", "c3"]);
    const after = assignChartSeriesColors(["c2", "c4", "c3"], before);

    expect(after.c4).toBe(CHART_SERIES_PALETTE[2]);
  });

  it("forgets a series the table no longer has", () => {
    const before = assignChartSeriesColors(["c2", "c3"]);

    expect(Object.keys(assignChartSeriesColors(["c2"], before))).toEqual(["c2"]);
  });

  it("greys out the series past the palette rather than repeating a colour", () => {
    const ids = Array.from({ length: CHART_SERIES_PALETTE.length + 2 }, (_, index) => `c${index}`);
    const colors = assignChartSeriesColors(ids);

    expect(Object.values(colors).slice(CHART_SERIES_PALETTE.length))
      .toEqual([CHART_SERIES_FALLBACK_COLOR, CHART_SERIES_FALLBACK_COLOR]);
  });
});

describe("resolveChartData", () => {
  const props = {
    spec: chartSpec(),
    dataSnapshot: { labels: ["stale"], series: [{ id: "c2", name: "Old", values: [1] }] },
  };

  it("derives from the live table when the reference resolves", () => {
    expect(resolveChartData(props, SCORES).labels).toEqual(["Class A", "Class B"]);
  });

  it("falls back to the snapshot when the table is gone", () => {
    expect(resolveChartData(props, null)).toEqual(props.dataSnapshot);
  });

  it("falls back to the snapshot when the reference was never set", () => {
    expect(resolveChartData(props, undefined)).toEqual(props.dataSnapshot);
  });

  it("follows an edit to the live table", () => {
    const edited = textTable([
      ["", "Math", "Science"],
      ["Class A", "11", "70"],
      ["Class B", "60", "90"],
    ]);

    expect(resolveChartData(props, edited).series[0].values).toEqual([11, 60]);
  });
});

describe("resolveChartSeriesColor", () => {
  it("uses the author's colour when there is one", () => {
    expect(resolveChartSeriesColor(chartSpec({ seriesColors: { c2: "#123456" } }), "c2", 0))
      .toBe("#123456");
  });

  it("falls back to the palette by position", () => {
    expect(resolveChartSeriesColor(chartSpec(), "c9", 2)).toBe(CHART_SERIES_PALETTE[2]);
  });

  it("greys out a series past the palette rather than repeating a hue", () => {
    expect(resolveChartSeriesColor(chartSpec(), "c99", CHART_SERIES_PALETTE.length))
      .toBe(CHART_SERIES_FALLBACK_COLOR);
  });

  it("ignores an empty colour string rather than painting with it", () => {
    expect(resolveChartSeriesColor(chartSpec({ seriesColors: { c2: "" } }), "c2", 0))
      .toBe(CHART_SERIES_PALETTE[0]);
  });
});

describe("resolveChartData memoization", () => {
  const props = {
    spec: chartSpec(),
    dataSnapshot: { labels: ["stale"], series: [{ id: "c2", name: "Old", values: [1] }] },
  };

  it("returns the same object for the same table and spec, so downstream memos can hit", () => {
    // The SVG export keys its markup cache on this object's identity; a fresh object per call made
    // that cache miss every time for exactly the live-table case it exists for.
    expect(resolveChartData(props, SCORES)).toBe(resolveChartData(props, SCORES));
  });

  it("re-derives when the table is a different object", () => {
    const edited = textTable([
      ["", "Math", "Science"],
      ["Class A", "11", "70"],
      ["Class B", "60", "90"],
    ]);

    expect(resolveChartData(props, edited)).not.toBe(resolveChartData(props, SCORES));
  });

  it("re-derives when the spec changes", () => {
    const transposed = { ...props, spec: chartSpec({ orientation: "rows" }) };

    expect(resolveChartData(transposed, SCORES)).not.toBe(resolveChartData(props, SCORES));
  });

  it("still reflects the table's values through the memo", () => {
    expect(resolveChartData(props, SCORES).series[0].values).toEqual([80, 60]);
  });

  it("honours a caller-supplied name fallback rather than serving the cached default", () => {
    const headerless = { ...props, spec: chartSpec({ headerRow: false }) };
    resolveChartData(headerless, SCORES);

    const named = resolveChartData(headerless, SCORES, {
      seriesNameFallback: (index) => `S${index + 1}`,
    });

    expect(named.series[0].name).toBe("S1");
  });
});

describe("syncChartDataSnapshots", () => {
  function tableShape(id: string, table: SigmaTableSpec): OverlayShape {
    return { id, type: "tableShape", x: 0, y: 0, props: { w: 200, h: 100, table } } as OverlayShape;
  }

  function chartShape(id: string, sourceTableShapeId: string | undefined, snapshot: SigmaChartData): OverlayShape {
    return {
      id,
      type: "chartShape",
      x: 0,
      y: 200,
      props: {
        w: 200,
        h: 130,
        spec: chartSpec(),
        ...(sourceTableShapeId ? { sourceTableShapeId } : {}),
        dataSnapshot: snapshot,
      },
    } as OverlayShape;
  }

  const STALE: SigmaChartData = { labels: ["old"], series: [{ id: "c2", name: "Old", values: [1] }] };

  it("refreshes a stale snapshot from the table", () => {
    const shapes = [tableShape("t", SCORES), chartShape("c", "t", STALE)];
    const synced = syncChartDataSnapshots(shapes);
    const chart = synced[1];

    expect(chart.type === "chartShape" && chart.props.dataSnapshot.labels).toEqual(["Class A", "Class B"]);
  });

  it("returns the very same array when nothing changed", () => {
    const shapes = [tableShape("t", SCORES), chartShape("c", "t", STALE)];
    const once = syncChartDataSnapshots(shapes);

    // The derivation is memoized per table, so a second pass must compare by value and bail.
    expect(syncChartDataSnapshots(once)).toBe(once);
  });

  it("leaves an untouched document byte-identical", () => {
    const shapes = [tableShape("t", SCORES)];

    expect(syncChartDataSnapshots(shapes)).toBe(shapes);
  });

  it("keeps the stale snapshot when the table is gone", () => {
    const shapes = [chartShape("c", "t", STALE)];

    expect(syncChartDataSnapshots(shapes)).toBe(shapes);
  });

  it("leaves a snapshot-only chart alone", () => {
    const shapes = [tableShape("t", SCORES), chartShape("c", undefined, STALE)];

    expect(syncChartDataSnapshots(shapes)).toBe(shapes);
  });

  it("does not mutate the shape it replaces", () => {
    const shapes = [tableShape("t", SCORES), chartShape("c", "t", STALE)];
    syncChartDataSnapshots(shapes);
    const original = shapes[1];

    expect(original.type === "chartShape" && original.props.dataSnapshot).toBe(STALE);
  });

  it("follows a later edit to the table", () => {
    const shapes = [tableShape("t", SCORES), chartShape("c", "t", STALE)];
    const synced = syncChartDataSnapshots(shapes);
    const edited = [
      tableShape("t", textTable([["", "Math", "Science"], ["Class A", "11", "70"], ["Class B", "60", "90"]])),
      synced[1],
    ];
    const again = syncChartDataSnapshots(edited);
    const chart = again[1];

    expect(chart.type === "chartShape" && chart.props.dataSnapshot.series[0].values).toEqual([11, 60]);
  });
});

describe("chartDataEquals", () => {
  const base: SigmaChartData = { labels: ["a"], series: [{ id: "c2", name: "M", values: [1, null] }] };

  it("accepts a structurally identical copy", () => {
    expect(chartDataEquals(base, structuredClone(base))).toBe(true);
  });

  it("rejects a changed value", () => {
    expect(chartDataEquals(base, { ...base, series: [{ id: "c2", name: "M", values: [2, null] }] })).toBe(false);
  });

  it("rejects a changed label", () => {
    expect(chartDataEquals(base, { ...base, labels: ["b"] })).toBe(false);
  });

  it("rejects a renamed series", () => {
    expect(chartDataEquals(base, { ...base, series: [{ id: "c2", name: "N", values: [1, null] }] })).toBe(false);
  });

  it("distinguishes a gap from a zero", () => {
    expect(chartDataEquals(base, { ...base, series: [{ id: "c2", name: "M", values: [1, 0] }] })).toBe(false);
  });

  it("compares the scatter x coordinates", () => {
    expect(chartDataEquals({ ...base, xValues: [1] }, { ...base, xValues: [2] })).toBe(false);
  });

  it("treats a missing xValues as different from an empty one", () => {
    expect(chartDataEquals(base, { ...base, xValues: [] })).toBe(false);
  });
});

describe("resolveChartSeriesColor: unsafe values", () => {
  it("refuses a colour that is not a safe CSS colour", () => {
    // Pasting reaches live editor state without passing the normalization boundary, so the
    // renderer's own read has to check too.
    expect(resolveChartSeriesColor(chartSpec({ seriesColors: { c2: "url(https://x/p.svg#g)" } }), "c2", 0))
      .toBe(CHART_SERIES_PALETTE[0]);
  });

  it("refuses a colour carrying an extra declaration", () => {
    expect(resolveChartSeriesColor(chartSpec({ seriesColors: { c2: "red;position:fixed" } }), "c2", 1))
      .toBe(CHART_SERIES_PALETTE[1]);
  });

  it("still accepts an ordinary hex colour", () => {
    expect(resolveChartSeriesColor(chartSpec({ seriesColors: { c2: "#123456" } }), "c2", 0)).toBe("#123456");
  });
});

describe("deriveChartSnapshotData", () => {
  it("keeps every series for a pie, so a later kind change is not lossy", () => {
    // `deriveChartData` for a pie keeps only the first filtered series; storing that would throw
    // the rest away the moment the table went missing.
    const snapshot = deriveChartSnapshotData(SCORES, chartSpec({ kind: "pie" }));

    expect(snapshot.series.map((series) => series.id)).toEqual(["c2", "c3"]);
  });

  it("keeps the series a scatter would have spent on its x axis", () => {
    const snapshot = deriveChartSnapshotData(SCORES, chartSpec({ kind: "scatter" }));

    expect(snapshot.series.map((series) => series.id)).toEqual(["c2", "c3"]);
  });

  it("matches the plain derivation for a bar chart", () => {
    expect(deriveChartSnapshotData(SCORES, chartSpec()))
      .toEqual(deriveChartData(SCORES, chartSpec()));
  });

  it("is what the snapshot sync stores", () => {
    const table = { id: "t", type: "tableShape", x: 0, y: 0, props: { w: 1, h: 1, table: SCORES } } as OverlayShape;
    const chart = {
      id: "c",
      type: "chartShape",
      x: 0,
      y: 0,
      props: {
        w: 1,
        h: 1,
        spec: chartSpec({ kind: "pie" }),
        sourceTableShapeId: "t",
        dataSnapshot: { labels: [], series: [] },
      },
    } as OverlayShape;
    const synced = syncChartDataSnapshots([table, chart])[1];

    expect(synced.type === "chartShape" && synced.props.dataSnapshot.series.map((s) => s.id))
      .toEqual(["c2", "c3"]);
  });
});

describe("deriveChartData: formula cells", () => {
  it("plots what a formula evaluates to, not the text it was typed as", () => {
    const table = textTable([
      ["月", "点数"],
      ["1月", "10"],
      ["2月", "20"],
      ["合計", "=SUM(B2:B3)"],
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([10, 20, 30]);
  });

  it("leaves a gap where a formula ends in an error", () => {
    const table = textTable([
      ["月", "点数"],
      ["1月", "10"],
      ["2月", "=1/0"],
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([10, null]);
  });

  it("names a series from a header its formula produced", () => {
    const table = textTable([
      ["月", "=A2"],
      ["合計", "10"],
      ["2月", "20"],
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].name).toBe("合計");
  });

  it("labels a row from a formula in the label column", () => {
    const table = textTable([
      ["月", "点数"],
      ["=B2", "10"],
      ["2月", "20"],
    ]);

    expect(deriveChartData(table, chartSpec()).labels[0]).toBe("10");
  });

  it("leaves a formula it cannot parse as the text it was typed as", () => {
    const table = textTable([
      ["月", "点数"],
      ["=SUM(B2", "10"],
      ["2月", "20"],
    ]);

    expect(deriveChartData(table, chartSpec()).labels[0]).toBe("=SUM(B2");
  });

  it("reads a formula that refers to a merged cell once", () => {
    const table = tableOf(["r1", "r2", "r3"], ["c1", "c2"], [
      paragraphCell("r1", "c1", "月"),
      paragraphCell("r1", "c2", "点数"),
      paragraphCell("r2", "c1", "1月", { colSpan: 2 }),
      paragraphCell("r3", "c1", "合計"),
      paragraphCell("r3", "c2", "=SUM(A2:B2)"),
    ]);

    expect(deriveChartData(table, chartSpec()).series[0].values).toEqual([null, 0]);
  });
});

describe("syncChartDataSnapshots: formula cells", () => {
  function chartOf(table: SigmaTableSpec): OverlayShape[] {
    return [
      { id: "table_1", type: "tableShape", x: 0, y: 0, props: { w: 200, h: 100, table } },
      {
        id: "chart_1",
        type: "chartShape",
        x: 0,
        y: 0,
        props: {
          w: 200,
          h: 100,
          spec: chartSpec(),
          sourceTableShapeId: "table_1",
          dataSnapshot: { labels: [], series: [] },
        },
      },
    ];
  }

  it("stores the evaluated value in the snapshot", () => {
    const shapes = chartOf(textTable([["月", "点数"], ["1月", "=2*5"]]));

    const next = syncChartDataSnapshots(shapes);

    const chart = next[1];
    expect(chart.type === "chartShape" ? chart.props.dataSnapshot.series[0].values : null).toEqual([10]);
  });

  it("refreshes the snapshot when a referenced cell changes the evaluated value", () => {
    const before = syncChartDataSnapshots(chartOf(textTable([["月", "点数"], ["1月", "=2*5"]])));
    const after = syncChartDataSnapshots(chartOf(textTable([["月", "点数"], ["1月", "=2*6"]])));

    const first = before[1];
    const second = after[1];
    expect([
      first.type === "chartShape" ? first.props.dataSnapshot.series[0].values : null,
      second.type === "chartShape" ? second.props.dataSnapshot.series[0].values : null,
    ]).toEqual([[10], [12]]);
  });
});
