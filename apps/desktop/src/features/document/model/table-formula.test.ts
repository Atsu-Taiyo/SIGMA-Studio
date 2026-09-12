import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  evaluateTableFormulas,
  getTableCellDisplayNodes,
  getTableCellFormulaResult,
  getTableCellFormulaSource,
  TABLE_FORMULA_ERROR_COLOR,
} from "./table-formula";
import type { SigmaTableFormulaResult } from "./table-formula";
import type { InlineNode } from "./rich-text";
import type {
  SigmaTableCell,
  SigmaTableCellParagraph,
  SigmaTableSpec,
} from "../overlay-model";

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
function gridTable(matrix: (string | null)[][]): SigmaTableSpec {
  const rowIds = matrix.map((_, index) => `r${index + 1}`);
  const columnIds = (matrix[0] ?? []).map((_, index) => `c${index + 1}`);
  const cells = matrix.flatMap((row, rowIndex) => (
    row.flatMap((text, columnIndex) => (
      text === null ? [] : [paragraphCell(rowIds[rowIndex], columnIds[columnIndex], text)]
    ))
  ));
  return tableOf(rowIds, columnIds, cells);
}

/** `"B3"` -> the cell id `gridTable` gives that position. */
function cellIdAt(address: string): string {
  const match = /^([A-Z]+)(\d+)$/u.exec(address);
  if (!match) {
    throw new Error(`Not an address: ${address}`);
  }
  let column = 0;
  for (const letter of match[1]) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return `r${match[2]}-c${column}`;
}

function resultAt(matrix: (string | null)[][], address: string): SigmaTableFormulaResult | undefined {
  return evaluateTableFormulas(gridTable(matrix)).byCellId.get(cellIdAt(address));
}

/** The evaluated display text of one formula cell. Throws when the cell holds no usable formula. */
function displayAt(matrix: (string | null)[][], address: string): string {
  const result = resultAt(matrix, address);
  if (!result) {
    throw new Error(`No formula result at ${address}`);
  }
  return result.display;
}

/** The one-cell shorthand: a formula alone in `A1`. */
function display(formula: string): string {
  return displayAt([[formula]], "A1");
}

/** A grid of the same text, for the cases that need more cells than a literal can carry. */
function filledGrid(rowCount: number, columnCount: number, text: string): string[][] {
  return Array.from({ length: rowCount }, () => new Array<string>(columnCount).fill(text));
}

/** A column of numbers with one formula under it, evaluated. */
function overColumn(numbers: readonly string[], formula: string): string {
  const grid = [...numbers.map((text) => [text]), [formula]];
  return displayAt(grid, `A${grid.length}`);
}

describe("evaluateTableFormulas operators", () => {
  it("gives multiplication precedence over addition", () => {
    expect(display("=1+2*3")).toBe("7");
  });

  it("lets parentheses override precedence", () => {
    expect(display("=(1+2)*3")).toBe("9");
  });

  it("applies a leading unary minus", () => {
    expect(display("=-2+1")).toBe("-1");
  });

  it("accepts a leading unary plus", () => {
    expect(display("=+3")).toBe("3");
  });

  it("reads a postfix percent as a hundredth", () => {
    expect(display("=50%")).toBe("0.5");
  });

  it("binds postfix percent tighter than multiplication", () => {
    expect(display("=10%*200")).toBe("20");
  });

  it("binds postfix percent tighter than a unary minus", () => {
    expect(display("=-50%")).toBe("-0.5");
  });

  it("subtracts left to right", () => {
    expect(display("=10-3-2")).toBe("5");
  });

  it("divides left to right", () => {
    expect(display("=8/2/2")).toBe("2");
  });

  it("reports division by zero instead of infinity", () => {
    expect(display("=1/0")).toBe("#DIV/0!");
  });

  it("ignores whitespace between tokens", () => {
    expect(display("=  1 +  2 ")).toBe("3");
  });
});

describe("evaluateTableFormulas parse failures", () => {
  it("leaves an unclosed call out of the evaluation", () => {
    expect(resultAt([["=SUM(A1"]], "A1")).toBeUndefined();
  });

  it("leaves an empty argument out of the evaluation", () => {
    expect(resultAt([["=SUM(1,,2)"]], "A1")).toBeUndefined();
  });

  it("leaves a trailing operator out of the evaluation", () => {
    expect(resultAt([["=1+"]], "A1")).toBeUndefined();
  });

  it("leaves a bare equals sign out of the evaluation", () => {
    expect(resultAt([["="]], "A1")).toBeUndefined();
  });

  it("leaves a cell that does not start with equals out of the evaluation", () => {
    expect(resultAt([["1+2"]], "A1")).toBeUndefined();
  });

  it("refuses a source longer than the length limit", () => {
    expect(resultAt([[`=${"1+".repeat(2_100)}1`]], "A1")).toBeUndefined();
  });

  it("refuses a nesting deeper than the depth limit", () => {
    const deep = `=${"(".repeat(300)}1${")".repeat(300)}`;
    expect(resultAt([[deep]], "A1")).toBeUndefined();
  });

  it("rejects a semicolon as an argument separator", () => {
    expect(resultAt([["=SUM(1;2)"]], "A1")).toBeUndefined();
  });
});

describe("evaluateTableFormulas references", () => {
  it("reads the cell one column to its left", () => {
    expect(displayAt([["4", "=A1+10"]], "B1")).toBe("14");
  });

  it("reads a cell in another row", () => {
    expect(displayAt([["4"], ["=A1*2"]], "A2")).toBe("8");
  });

  it("ignores the case of a reference", () => {
    expect(displayAt([["4", "=a1+1"]], "B1")).toBe("5");
  });

  it("treats an absolute reference as the same cell", () => {
    expect(displayAt([["4", "=$A$1+1"]], "B1")).toBe("5");
  });

  it("treats a mixed reference as the same cell", () => {
    expect(displayAt([["4", "=A$1+$A1"]], "B1")).toBe("8");
  });

  it("carries a column letter past Z", () => {
    const row = Array.from({ length: 28 }, (_, index) => String(index + 1));
    row[27] = "=AA1";
    expect(displayAt([row], "AB1")).toBe("27");
  });

  it("reports a reference past the last column", () => {
    expect(displayAt([["1", "=Z1"]], "B1")).toBe("#REF!");
  });

  it("reports a reference past the last row", () => {
    expect(displayAt([["1", "=A99"]], "B1")).toBe("#REF!");
  });

  it("reads an empty cell as zero", () => {
    expect(displayAt([[null, "=A1"]], "B1")).toBe("0");
  });

  it("reads a cell the table declares with no text as zero", () => {
    expect(displayAt([["", "=A1"]], "B1")).toBe("0");
  });

  it("passes a text cell through unchanged", () => {
    expect(displayAt([["あ", "=A1"]], "B1")).toBe("あ");
  });

  it("refuses arithmetic on a text cell", () => {
    expect(displayAt([["あ", "=A1+1"]], "B1")).toBe("#VALUE!");
  });

  it("refuses a range where a single value is expected", () => {
    expect(displayAt([["1"], ["2"], ["=A1:A2+1"]], "A3")).toBe("#VALUE!");
  });

  it("reads a number written with full-width digits", () => {
    expect(displayAt([["１２"], ["=A1+1"]], "A2")).toBe("13");
  });

  it("reads a number written as inline math source", () => {
    expect(displayAt([["$42$"], ["=A1+1"]], "A2")).toBe("43");
  });
});

describe("evaluateTableFormulas merged cells", () => {
  it("leaves the covered position of a merged cell empty", () => {
    const table = tableOf(["r1"], ["c1", "c2", "c3"], [
      paragraphCell("r1", "c1", "5", { colSpan: 2 }),
      paragraphCell("r1", "c3", "=B1"),
    ]);

    expect(evaluateTableFormulas(table).byCellId.get("r1-c3")?.display).toBe("0");
  });

  it("counts a merged cell once across the range it covers", () => {
    const table = tableOf(["r1"], ["c1", "c2", "c3"], [
      paragraphCell("r1", "c1", "5", { colSpan: 2 }),
      paragraphCell("r1", "c3", "=SUM(A1:B1)"),
    ]);

    expect(evaluateTableFormulas(table).byCellId.get("r1-c3")?.display).toBe("5");
  });

  it("leaves the covered position of a row-spanning cell empty", () => {
    const table = tableOf(["r1", "r2"], ["c1", "c2"], [
      paragraphCell("r1", "c1", "5", { rowSpan: 2 }),
      paragraphCell("r1", "c2", "=SUM(A1:A2)"),
    ]);

    expect(evaluateTableFormulas(table).byCellId.get("r1-c2")?.display).toBe("5");
  });
});

describe("evaluateTableFormulas ranges", () => {
  it("sums a column range", () => {
    expect(displayAt([["1"], ["2"], ["3"], ["=SUM(A1:A3)"]], "A4")).toBe("6");
  });

  it("sums a range written from its far corner", () => {
    expect(displayAt([["1"], ["2"], ["3"], ["=SUM(A3:A1)"]], "A4")).toBe("6");
  });

  it("sums a rectangular range", () => {
    expect(displayAt([["1", "2"], ["3", "4"], ["=SUM(A1:B2)", null]], "A3")).toBe("10");
  });

  it("sums the scalar arguments of a call", () => {
    expect(display("=SUM(1,2,3)")).toBe("6");
  });

  it("averages a range the same way whatever the case of the source", () => {
    const lower = displayAt([["2"], ["4"], ["6"], ["=average(a1:a3)"]], "A4");
    const upper = displayAt([["2"], ["4"], ["6"], ["=AVERAGE($A$1:$A$3)"]], "A4");

    expect([lower, upper]).toEqual(["4", "4"]);
  });

  it("ignores text inside a summed range", () => {
    expect(displayAt([["1"], ["あ"], ["3"], ["=SUM(A1:A3)"]], "A4")).toBe("4");
  });

  it("ignores an empty cell inside a summed range", () => {
    expect(displayAt([["1"], [null], ["3"], ["=SUM(A1:A3)"]], "A4")).toBe("4");
  });

  it("reports a range that reaches past the last column", () => {
    expect(displayAt([["1", "=SUM(A1:ZZ1)"]], "B1")).toBe("#REF!");
  });

  it("refuses a range covering more cells than the limit", () => {
    const grid = filledGrid(70, 70, "1");
    grid[0][69] = "=SUM(A1:BR70)";

    expect(displayAt(grid, "BR1")).toBe("#NUM!");
  });
});

describe("evaluateTableFormulas snapshot", () => {
  it("returns the same evaluation object for the same table", () => {
    const table = gridTable([["1"], ["=A1+1"]]);

    expect(evaluateTableFormulas(table)).toBe(evaluateTableFormulas(table));
  });

  it("keeps a cell that holds no formula out of the map", () => {
    expect(evaluateTableFormulas(gridTable([["1"], ["=A1"]])).byCellId.has("r1-c1")).toBe(false);
  });

  it("keys a result by the id of the cell holding the formula", () => {
    expect(evaluateTableFormulas(gridTable([["1"], ["=A1"]])).byCellId.has("r2-c1")).toBe(true);
  });

  it("keeps the formula source on the result", () => {
    expect(resultAt([["1"], ["=A1+1"]], "A2")?.source).toBe("=A1+1");
  });

  it("reports no error for a formula that evaluates", () => {
    expect(resultAt([["1"], ["=A1+1"]], "A2")?.error).toBeNull();
  });

  it("reports the error code of a formula that fails", () => {
    expect(resultAt([["=1/0"]], "A1")?.error).toBe("#DIV/0!");
  });

  it("evaluates a formula that reads another formula cell", () => {
    expect(displayAt([["2"], ["=A1*3"], ["=A2+1"]], "A3")).toBe("7");
  });
});

describe("getTableCellFormulaSource", () => {
  it("returns the source of a single-paragraph cell that starts with equals", () => {
    expect(getTableCellFormulaSource(paragraphCell("r1", "c1", "=SUM(A1:A2)"))).toBe("=SUM(A1:A2)");
  });

  it("trims the surrounding whitespace of a source", () => {
    expect(getTableCellFormulaSource(paragraphCell("r1", "c1", "  =1+1  "))).toBe("=1+1");
  });

  it("returns null for a cell that does not start with equals", () => {
    expect(getTableCellFormulaSource(paragraphCell("r1", "c1", "1+1"))).toBeNull();
  });

  it("returns null for a cell holding an inline math node", () => {
    expect(getTableCellFormulaSource({
      id: "r1-c1",
      rowId: "r1",
      columnId: "c1",
      content: [{
        type: "paragraph",
        id: "p",
        children: [
          { type: "text", text: "=" },
          { type: "mathInline", id: "m", tex: "x", display: "inline" },
        ],
      }],
    })).toBeNull();
  });

  it("returns null for a cell holding two paragraphs", () => {
    expect(getTableCellFormulaSource({
      id: "r1-c1",
      rowId: "r1",
      columnId: "c1",
      content: [
        { type: "paragraph", id: "p1", children: [{ type: "text", text: "=1+1" }] },
        { type: "paragraph", id: "p2", children: [{ type: "text", text: "x" }] },
      ],
    })).toBeNull();
  });

  it("returns null for a trend cell", () => {
    expect(getTableCellFormulaSource({
      id: "r1-c1",
      rowId: "r1",
      columnId: "c1",
      content: [{ type: "trend", id: "t", direction: "up" }],
    })).toBeNull();
  });

  it("returns null for a source longer than the length limit", () => {
    expect(getTableCellFormulaSource(paragraphCell("r1", "c1", `=${"1".repeat(5_000)}`))).toBeNull();
  });

  it("returns null for an undefined cell", () => {
    expect(getTableCellFormulaSource(undefined)).toBeNull();
  });
});

describe("evaluateTableFormulas counting functions", () => {
  it("counts only the numeric cells of a range", () => {
    expect(overColumn(["1", "あ", "3"], "=COUNT(A1:A3)")).toBe("2");
  });

  it("does not count an empty cell", () => {
    expect(displayAt([["1"], [null], ["3"], ["=COUNT(A1:A3)"]], "A4")).toBe("2");
  });

  it("counts every non-empty cell of a range", () => {
    expect(overColumn(["1", "あ", "3"], "=COUNTA(A1:A3)")).toBe("3");
  });

  it("does not count an empty cell as present", () => {
    expect(displayAt([["1"], [null], ["3"], ["=COUNTA(A1:A3)"]], "A4")).toBe("2");
  });

  it("does not count a trend cell as present", () => {
    const table = tableOf(["r1", "r2"], ["c1"], [
      { id: "r1-c1", rowId: "r1", columnId: "c1", content: [{ type: "trend", id: "t", direction: "up" }] },
      paragraphCell("r2", "c1", "=COUNTA(A1:A1)"),
    ]);

    expect(evaluateTableFormulas(table).byCellId.get("r2-c1")?.display).toBe("0");
  });

  it("counts nothing in an empty range", () => {
    expect(displayAt([[null], [null], ["=COUNT(A1:A2)"]], "A3")).toBe("0");
  });
});

describe("evaluateTableFormulas aggregate functions", () => {
  it("averages only the numeric cells", () => {
    expect(overColumn(["2", "あ", "6"], "=AVERAGE(A1:A3)")).toBe("4");
  });

  it("reports division by zero when an average has no numbers", () => {
    expect(overColumn(["あ", "い"], "=AVERAGE(A1:A2)")).toBe("#DIV/0!");
  });

  it("takes the largest number of a range", () => {
    expect(overColumn(["2", "9", "6"], "=MAX(A1:A3)")).toBe("9");
  });

  it("takes the smallest number of a range", () => {
    expect(overColumn(["2", "9", "6"], "=MIN(A1:A3)")).toBe("2");
  });

  it("answers zero when a maximum has no numbers", () => {
    expect(overColumn(["あ", "い"], "=MAX(A1:A2)")).toBe("0");
  });

  it("answers zero when a minimum has no numbers", () => {
    expect(overColumn(["あ", "い"], "=MIN(A1:A2)")).toBe("0");
  });

  it("takes the middle value of an odd population", () => {
    expect(overColumn(["5", "1", "3"], "=MEDIAN(A1:A3)")).toBe("3");
  });

  it("averages the two middle values of an even population", () => {
    expect(overColumn(["1", "2", "3", "4"], "=MEDIAN(A1:A4)")).toBe("2.5");
  });

  it("refuses a median with no numbers", () => {
    expect(overColumn(["あ", "い"], "=MEDIAN(A1:A2)")).toBe("#NUM!");
  });
});

describe("evaluateTableFormulas dispersion functions", () => {
  const population = ["2", "4", "4", "4", "5", "5", "7", "9"];

  it("computes the population standard deviation", () => {
    expect(overColumn(population, "=STDEV.P(A1:A8)")).toBe("2");
  });

  it("computes the sample standard deviation", () => {
    expect(overColumn(population, "=STDEV.S(A1:A8)")).toBe("2.138089935");
  });

  it("computes the population variance", () => {
    expect(overColumn(population, "=VAR.P(A1:A8)")).toBe("4");
  });

  it("computes the sample variance", () => {
    expect(overColumn(population, "=VAR.S(A1:A8)")).toBe("4.571428571");
  });

  it("refuses a sample deviation of one value", () => {
    expect(overColumn(["3"], "=STDEV.S(A1:A1)")).toBe("#DIV/0!");
  });

  it("refuses a sample variance of one value", () => {
    expect(overColumn(["3"], "=VAR.S(A1:A1)")).toBe("#DIV/0!");
  });

  it("refuses a population deviation of no values", () => {
    expect(overColumn(["あ"], "=STDEV.P(A1:A1)")).toBe("#DIV/0!");
  });

  it("refuses a population variance of no values", () => {
    expect(overColumn(["あ"], "=VAR.P(A1:A1)")).toBe("#DIV/0!");
  });

  it("accepts a population deviation of one value", () => {
    expect(overColumn(["3"], "=STDEV.P(A1:A1)")).toBe("0");
  });
});

describe("evaluateTableFormulas regression functions", () => {
  /** Three points on `y = 2x + 1`, laid out as two columns with the formula beneath. */
  function regressionGrid(formula: string): (string | null)[][] {
    return [["1", "3"], ["2", "5"], ["3", "7"], [formula, null]];
  }

  it("correlates two rising columns perfectly", () => {
    expect(displayAt(regressionGrid("=CORREL(A1:A3,B1:B3)"), "A4")).toBe("1");
  });

  it("correlates a rising and a falling column perfectly negatively", () => {
    expect(displayAt([["1", "7"], ["2", "5"], ["3", "3"], ["=CORREL(A1:A3,B1:B3)", null]], "A4"))
      .toBe("-1");
  });

  it("refuses a correlation of ranges of different lengths", () => {
    expect(displayAt([["1", "7"], ["2", "5"], ["3", "3"], ["=CORREL(A1:A3,B1:B2)", null]], "A4"))
      .toBe("#N/A");
  });

  it("refuses a correlation where one column never varies", () => {
    expect(displayAt([["1", "4"], ["2", "4"], ["3", "4"], ["=CORREL(A1:A3,B1:B3)", null]], "A4"))
      .toBe("#DIV/0!");
  });

  it("refuses a correlation of a single pair", () => {
    expect(displayAt([["1", "4"], ["=CORREL(A1:A1,B1:B1)", null]], "A2")).toBe("#DIV/0!");
  });

  it("takes the slope of the fitted line", () => {
    expect(displayAt(regressionGrid("=SLOPE(B1:B3,A1:A3)"), "A4")).toBe("2");
  });

  it("takes the intercept of the fitted line", () => {
    expect(displayAt(regressionGrid("=INTERCEPT(B1:B3,A1:A3)"), "A4")).toBe("1");
  });

  it("refuses a slope of ranges of different lengths", () => {
    expect(displayAt([["1", "3"], ["2", "5"], ["3", "7"], ["=SLOPE(B1:B3,A1:A2)", null]], "A4"))
      .toBe("#N/A");
  });

  it("refuses a slope where x never varies", () => {
    expect(displayAt([["4", "3"], ["4", "5"], ["4", "7"], ["=SLOPE(B1:B3,A1:A3)", null]], "A4"))
      .toBe("#DIV/0!");
  });

  it("refuses an intercept where x never varies", () => {
    expect(displayAt([["4", "3"], ["4", "5"], ["4", "7"], ["=INTERCEPT(B1:B3,A1:A3)", null]], "A4"))
      .toBe("#DIV/0!");
  });

  it("refuses a slope of a single pair", () => {
    expect(displayAt([["1", "4"], ["=SLOPE(B1:B1,A1:A1)", null]], "A2")).toBe("#DIV/0!");
  });

  it("refuses a correlation given only one range", () => {
    expect(displayAt([["1"], ["=CORREL(A1:A1)"]], "A2")).toBe("#VALUE!");
  });
});

describe("evaluateTableFormulas scalar functions", () => {
  it("rounds a half up and away from zero", () => {
    expect(display("=ROUND(2.345,2)")).toBe("2.35");
  });

  it("rounds a negative half away from zero", () => {
    expect(display("=ROUND(-2.5,0)")).toBe("-3");
  });

  it("rounds a positive half away from zero", () => {
    expect(display("=ROUND(2.5,0)")).toBe("3");
  });

  it("rounds to the left of the decimal point for negative digits", () => {
    expect(display("=ROUND(1234,-2)")).toBe("1200");
  });

  it("truncates a fractional digit count", () => {
    expect(display("=ROUND(2.345,2.9)")).toBe("2.35");
  });

  it("refuses a digit count past the shifting limit", () => {
    expect(display("=ROUND(1,500)")).toBe("#NUM!");
  });

  it("takes an absolute value", () => {
    expect(display("=ABS(-3)")).toBe("3");
  });

  it("takes a square root", () => {
    expect(display("=SQRT(9)")).toBe("3");
  });

  it("refuses the square root of a negative number", () => {
    expect(display("=SQRT(-1)")).toBe("#NUM!");
  });

  it("raises a number to a power", () => {
    expect(display("=POWER(2,3)")).toBe("8");
  });

  it("reports division by zero for a negative power of zero", () => {
    expect(display("=POWER(0,-1)")).toBe("#DIV/0!");
  });

  it("refuses a fractional power of a negative base", () => {
    expect(display("=POWER(-1,0.5)")).toBe("#NUM!");
  });

  it("refuses a call with too few arguments", () => {
    expect(display("=ROUND(1)")).toBe("#VALUE!");
  });

  it("refuses a call with too many arguments", () => {
    expect(display("=SQRT(1,2)")).toBe("#VALUE!");
  });

  it("refuses an aggregate with no arguments", () => {
    expect(display("=SUM()")).toBe("#VALUE!");
  });

  it("refuses a presence count with no arguments", () => {
    expect(display("=COUNTA()")).toBe("#VALUE!");
  });

  it("refuses a range where a scalar function expects one number", () => {
    expect(displayAt([["1"], ["2"], ["=SQRT(A1:A2)"]], "A3")).toBe("#VALUE!");
  });
});

describe("evaluateTableFormulas unknown names", () => {
  it("reports an unknown function name", () => {
    expect(display("=FOO(1)")).toBe("#NAME?");
  });

  it("reports a bare name that is not a reference", () => {
    expect(display("=FOO")).toBe("#NAME?");
  });

  it("reports a name mixing letters and digits that is not a reference", () => {
    expect(display("=A1B2")).toBe("#NAME?");
  });

  it("does not resolve an inherited object property as a function", () => {
    expect(display("=constructor(1)")).toBe("#NAME?");
  });

  it("does not resolve a prototype method as a function", () => {
    expect(display("=toString(1)")).toBe("#NAME?");
  });

  it("does not resolve hasOwnProperty as a function", () => {
    expect(display("=hasOwnProperty(1)")).toBe("#NAME?");
  });

  it("does not resolve __proto__ as a function", () => {
    expect(display("=__proto__(1)")).toBe("#NAME?");
  });
});

describe("evaluateTableFormulas error propagation", () => {
  it("carries an error from a referenced cell into the sum", () => {
    expect(displayAt([["=1/0", "5", "=SUM(A1,B1)"]], "C1")).toBe("#DIV/0!");
  });

  it("carries an error out of a range", () => {
    expect(displayAt([["=1/0"], ["5"], ["=SUM(A1:A2)"]], "A3")).toBe("#DIV/0!");
  });

  it("carries an error through arithmetic", () => {
    expect(displayAt([["=1/0", "=A1+1"]], "B1")).toBe("#DIV/0!");
  });

  it("lets the leftmost error win", () => {
    expect(displayAt([["=1/0", "=SQRT(-1)", "=SUM(A1,B1)"]], "C1")).toBe("#DIV/0!");
  });

  it("does not let an error erase a count of the cells beside it", () => {
    expect(displayAt([["=1/0"], ["5"], ["=COUNT(A1:A2)"]], "A3")).toBe("1");
  });

  it("counts an error cell as present", () => {
    expect(displayAt([["=1/0"], ["5"], ["=COUNTA(A1:A2)"]], "A3")).toBe("2");
  });
});

describe("evaluateTableFormulas cycles", () => {
  it("reports a cycle on both cells of a mutual reference", () => {
    const evaluation = evaluateTableFormulas(gridTable([["=B1", "=A1"]]));

    expect([
      evaluation.byCellId.get("r1-c1")?.display,
      evaluation.byCellId.get("r1-c2")?.display,
    ]).toEqual(["#CYCLE!", "#CYCLE!"]);
  });

  it("reports a cycle on a self reference", () => {
    expect(display("=A1+1")).toBe("#CYCLE!");
  });

  it("reports a cycle around a longer chain", () => {
    expect(displayAt([["=B1", "=C1", "=A1"]], "A1")).toBe("#CYCLE!");
  });

  it("leaves a cell outside the cycle at its own value", () => {
    expect(displayAt([["=B1", "=A1", "=1+1"]], "C1")).toBe("2");
  });

  it("still evaluates the rest of a table that contains a cycle", () => {
    const evaluation = evaluateTableFormulas(gridTable([["=B1", "=A1"], ["4", "=A2*2"]]));

    expect(evaluation.byCellId.get("r2-c2")?.display).toBe("8");
  });

  it("reports the cycle as the error code of the result", () => {
    expect(resultAt([["=B1", "=A1"]], "A1")?.error).toBe("#CYCLE!");
  });
});

describe("evaluateTableFormulas display", () => {
  it("keeps a repeating fraction to a fixed number of decimals", () => {
    expect(display("=1/3")).toBe("0.333333333");
  });

  it("hides the binary tail of a decimal sum", () => {
    expect(display("=0.1+0.2")).toBe("0.3");
  });

  it("writes a whole number without a decimal point", () => {
    expect(display("=6/2")).toBe("3");
  });

  it("writes a large number without a thousands separator", () => {
    expect(display("=1000*1000")).toBe("1000000");
  });

  it("keeps the exponent form of a very large number", () => {
    expect(display("=POWER(10,21)")).toBe("1e+21");
  });

  it("keeps the exponent form of a very small number", () => {
    expect(display("=1/POWER(10,10)")).toBe("1e-10");
  });

  it("writes a negative fraction with its sign", () => {
    expect(display("=-1/4")).toBe("-0.25");
  });
});

describe("evaluateTableFormulas budgets", () => {
  it("refuses a chain of references deeper than the limit", () => {
    const grid = Array.from({ length: 1_200 }, (_, index) => [`=A${index + 2}`]);
    grid[1_199] = ["1"];

    expect(displayAt(grid, "A1")).toBe("#NUM!");
  });

  it("does not let a too-deep walk poison the cells it passed through", () => {
    // Every cell here is well inside `MAX_REFERENCE_DEPTH` measured from itself; only the head of
    // the chain is not. Reaching a cell from a deep walk must not decide its displayed value.
    const grid = Array.from({ length: 1_200 }, (_, index) => [`=A${index + 2}`]);
    grid[1_199] = ["1"];
    const evaluation = evaluateTableFormulas(gridTable(grid));

    expect([200, 600, 1_000, 1_199].map((row) => (
      evaluation.byCellId.get(`r${row}-c1`)?.display
    ))).toEqual(["1", "1", "1", "1"]);
  });

  it("reports #NUM! for the cells left after the evaluation budget is spent", () => {
    const rowCount = 1_500;
    const grid = Array.from({ length: rowCount }, () => ["1", `=SUM($A$1:$A$${rowCount})`]);

    const evaluation = evaluateTableFormulas(gridTable(grid));

    expect([
      evaluation.byCellId.get("r1-c2")?.display,
      evaluation.byCellId.get(`r${rowCount}-c2`)?.display,
    ]).toEqual([String(rowCount), "#NUM!"]);
  });
});

describe("table-formula module constraints", () => {
  const source = readFileSync(fileURLToPath(new URL("./table-formula.ts", import.meta.url)), "utf8");
  /** The comments say what the module refuses to do, so the scan has to look past them. */
  const code = source.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");

  it("never reaches for a dynamic code path", () => {
    expect(code).not.toMatch(/\beval\s*\(|new\s+Function\s*\(|\bimport\s*\(/u);
  });

  it("never formats a number through a locale", () => {
    expect(code).not.toMatch(/toLocaleString|Intl\./u);
  });

  it("resolves function names behind an own-property guard", () => {
    expect(source).toMatch(/Object\.prototype\.hasOwnProperty\.call\(FORMULA_FUNCTIONS/u);
  });
});

describe("evaluateTableFormulas review regressions", () => {
  it("keeps a long circular chain reported as a cycle, not a budget failure", () => {
    // A ring longer than a stack-tight depth cap would be: the cap must not fire before `visiting`
    // notices the re-entry, or a circular reference silently becomes "#NUM!".
    const size = 300;
    const grid = Array.from({ length: size }, (_, index) => [`=A${(index + 1) % size + 1}`]);
    const evaluation = evaluateTableFormulas(gridTable(grid));

    expect([
      evaluation.byCellId.get("r1-c1")?.display,
      evaluation.byCellId.get("r150-c1")?.display,
      evaluation.byCellId.get(`r${size}-c1`)?.display,
    ]).toEqual(["#CYCLE!", "#CYCLE!", "#CYCLE!"]);
  });

  it("refuses a formula whose call nesting and reference depth multiply out of the stack", () => {
    // Both factors are individually legal; only their product is not. This must be a deterministic
    // error value, never a swallowed stack overflow.
    const depth = 40;
    const nest = `${"SUM(".repeat(60)}A%d${")".repeat(60)}`;
    const grid = Array.from({ length: depth }, (_, index) => [`=${nest.replace("%d", String(index + 2))}`]);
    grid[depth - 1] = ["7"];

    expect(displayAt(grid, "A1")).toBe("#NUM!");
  });

  it("does not let a stack-deep table poison the same formula text in another table", () => {
    // The compiled-formula cache is process-global and keyed on the source text alone, so a
    // non-parse failure recorded there would follow the string into unrelated documents.
    const depth = 40;
    const nest = `${"SUM(".repeat(60)}A%d${")".repeat(60)}`;
    const deep = Array.from({ length: depth }, (_, index) => [`=${nest.replace("%d", String(index + 2))}`]);
    deep[depth - 1] = ["7"];
    evaluateTableFormulas(gridTable(deep));

    const shallow = [["7"], [`=${nest.replace("%d", "1")}`]];
    expect(displayAt(shallow, "A2")).toBe("7");
  });

  it("takes a maximum over a population too large to spread into an argument list", () => {
    // The formula sits on a row of its own: a range covering its own cell would be a cycle, and
    // the cycle would be detected before the population ever got large.
    const grid = filledGrid(65, 64, "1");
    grid[0][0] = "9";
    const ranges = Array.from({ length: 50 }, () => "A1:BL64").join(",");
    grid[64][0] = `=MAX(${ranges})`;

    expect(displayAt(grid, "A65")).toBe("9");
  });

  it("takes a minimum over a population too large to spread into an argument list", () => {
    // The formula sits on a row of its own: a range covering its own cell would be a cycle, and
    // the cycle would be detected before the population ever got large.
    const grid = filledGrid(65, 64, "5");
    grid[0][0] = "2";
    const ranges = Array.from({ length: 50 }, () => "A1:BL64").join(",");
    grid[64][0] = `=MIN(${ranges})`;

    expect(displayAt(grid, "A65")).toBe("2");
  });

  it("does not invent digits past a large number's precision", () => {
    expect(display("=1000000000000+0.1")).toBe("1000000000000.1");
  });

  it("keeps the shortest round-trip form of a large quotient", () => {
    expect(display("=10000000000/7")).toBe("1428571428.5714285");
  });

  it("reads a one-cell range as the cell it names", () => {
    expect(displayAt([["5"], ["=A1:A1"]], "A2")).toBe("5");
  });

  it("passes a one-cell range to a scalar function", () => {
    expect(displayAt([["9"], ["=SQRT(A1:A1)"]], "A2")).toBe("3");
  });

  it("treats a call whose name is shaped like a reference as a function name", () => {
    expect(display("=ABS1(2)")).toBe("#NAME?");
  });

  it("still reads a reference that a function name could be confused with", () => {
    expect(displayAt([["4", "=ABS(A1)"]], "B1")).toBe("4");
  });
});

describe("getTableCellDisplayNodes", () => {
  /** The single paragraph of the cell at `address`, with the table it belongs to. */
  function projectionAt(matrix: (string | null)[][], address: string): readonly InlineNode[] {
    const table = gridTable(matrix);
    const id = cellIdAt(address);
    const cell = table.cells.find((candidate) => candidate.id === id);
    if (!cell) {
      throw new Error(`No cell at ${address}`);
    }
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error(`Not a paragraph at ${address}`);
    }
    return getTableCellDisplayNodes(table, cell, content);
  }

  it("projects a formula cell to its evaluated value", () => {
    expect(projectionAt([["2"], ["4"], ["=SUM(A1:A2)"]], "A3")).toEqual([
      { type: "text", text: "6" },
    ]);
  });

  it("keeps the formatting of the run the formula was typed into", () => {
    const table = gridTable([["2"], ["=A1*3"]]);
    const cell = table.cells[1];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    content.children = [{ type: "text", text: "=A1*3", marks: ["bold"], fontSize: 18 }];

    expect(getTableCellDisplayNodes(table, cell, content)).toEqual([
      { type: "text", text: "6", marks: ["bold"], fontSize: 18 },
    ]);
  });

  it("colours an error value", () => {
    expect(projectionAt([["=1/0"]], "A1")).toEqual([
      { type: "text", text: "#DIV/0!", color: TABLE_FORMULA_ERROR_COLOR },
    ]);
  });

  it("overrides the author's colour on an error value", () => {
    const table = gridTable([["=1/0"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    content.children = [{ type: "text", text: "=1/0", color: "#123456" }];

    expect(getTableCellDisplayNodes(table, cell, content)).toEqual([
      { type: "text", text: "#DIV/0!", color: TABLE_FORMULA_ERROR_COLOR },
    ]);
  });

  it("uses the danger colour the app already defines", () => {
    expect(TABLE_FORMULA_ERROR_COLOR).toBe("#b42318");
  });

  it("returns the cell's own nodes for a formula it cannot parse", () => {
    const table = gridTable([["=SUM(A1"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellDisplayNodes(table, cell, content)).toBe(content.children);
  });

  it("returns the cell's own nodes for a cell holding no formula", () => {
    const table = gridTable([["12"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellDisplayNodes(table, cell, content)).toBe(content.children);
  });

  it("returns the cell's own nodes when the cell holds inline math", () => {
    const table = gridTable([["=A1"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    content.children = [
      { type: "text", text: "=" },
      { type: "mathInline", id: "m", tex: "x", display: "inline" },
    ];

    expect(getTableCellDisplayNodes(table, cell, content)).toBe(content.children);
  });

  it("returns the cell's own nodes for an undefined cell", () => {
    const table = gridTable([["=1+1"]]);
    const content = table.cells[0].content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellDisplayNodes(table, undefined, content)).toBe(content.children);
  });

  it("returns the cell's own nodes for a paragraph that is not the formula's", () => {
    // A second paragraph would already disqualify the cell, but the projection must not assume it.
    const table = gridTable([["=1+1"]]);
    const cell = table.cells[0];
    const other: SigmaTableCellParagraph = {
      type: "paragraph",
      id: "other",
      children: [{ type: "text", text: "x" }],
    };

    expect(getTableCellDisplayNodes(table, cell, other)).toBe(other.children);
  });

  it("gives the same projection array identity for the same table", () => {
    const table = gridTable([["2"], ["=A1+1"]]);
    const cell = table.cells[1];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellDisplayNodes(table, cell, content))
      .toBe(getTableCellDisplayNodes(table, cell, content));
  });
});

describe("getTableCellFormulaResult", () => {
  it("reports the error code of a formula cell", () => {
    const table = gridTable([["=1/0"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellFormulaResult(table, cell, content)?.error).toBe("#DIV/0!");
  });

  it("returns null for a cell holding no formula", () => {
    const table = gridTable([["12"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellFormulaResult(table, cell, content)).toBeNull();
  });

  it("returns null for a formula it cannot parse", () => {
    const table = gridTable([["=SUM(A1"]]);
    const cell = table.cells[0];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }

    expect(getTableCellFormulaResult(table, cell, content)).toBeNull();
  });
});

describe("getTableCellDisplayNodes resolves cells by identity", () => {
  /**
   * Nothing validates that `cells[].id` is unique — the schema checks row and column ids and stops
   * there — so a document can hand two cells the same id. Resolving the projection by id would let
   * an ordinary cell display a formula's value on every surface while its stored text stayed as it
   * was: the printed page would disagree with the document, and the author would see the real text
   * again the moment they clicked into the cell.
   */
  const table = tableOf(["r1", "r2"], ["c1"], [
    { ...paragraphCell("r1", "c1", "支払額 10,000 円"), id: "duplicate" },
    { ...paragraphCell("r2", "c1", "=1+1"), id: "duplicate" },
  ]);

  function nodesOf(cell: SigmaTableCell): readonly InlineNode[] {
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    return getTableCellDisplayNodes(table, cell, content);
  }

  it("leaves a plain cell that shares an id with a formula cell alone", () => {
    expect(nodesOf(table.cells[0])).toBe(table.cells[0].content[0].type === "paragraph"
      ? table.cells[0].content[0].children
      : null);
  });

  it("still evaluates the formula cell itself", () => {
    expect(nodesOf(table.cells[1])).toEqual([{ type: "text", text: "2" }]);
  });
});

describe("projected nodes do not alias the stored document", () => {
  it("copies the marks array rather than sharing it", () => {
    const table = gridTable([["2"], ["=A1+1"]]);
    const cell = table.cells[1];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    content.children = [{ type: "text", text: "=A1+1", marks: ["bold"] }];

    const projected = getTableCellDisplayNodes(table, cell, content)[0];
    const stored = content.children[0];

    expect(projected.type === "text" && stored.type === "text" && projected.marks === stored.marks)
      .toBe(false);
  });
});

describe("the projection takes its formatting from the run carrying the formula", () => {
  function projectWith(children: InlineNode[]): readonly InlineNode[] {
    const table = gridTable([["2"], ["=A1+1"]]);
    const cell = table.cells[1];
    const content = cell.content[0];
    if (content.type !== "paragraph") {
      throw new Error("expected a paragraph");
    }
    content.children = children;
    return getTableCellDisplayNodes(table, cell, content);
  }

  it("does not paint the value with the formatting of a lone bold equals sign", () => {
    // Bolding just the `=` is easy to do by accident, and by pasting. The value is not the `=`.
    expect(projectWith([
      { type: "text", text: "=", marks: ["bold"] },
      { type: "text", text: "A1+1" },
    ])).toEqual([{ type: "text", text: "3" }]);
  });

  it("keeps the formatting when it is the body of the formula that carries it", () => {
    expect(projectWith([
      { type: "text", text: "=" },
      { type: "text", text: "A1+1", marks: ["bold"] },
    ])).toEqual([{ type: "text", text: "3", marks: ["bold"] }]);
  });

  it("keeps the formatting of a formula written as one run", () => {
    expect(projectWith([{ type: "text", text: "=A1+1", marks: ["italic"] }]))
      .toEqual([{ type: "text", text: "3", marks: ["italic"] }]);
  });
});
