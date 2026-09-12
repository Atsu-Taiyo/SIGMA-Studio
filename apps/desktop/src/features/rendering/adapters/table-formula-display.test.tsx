import { readFileSync } from "node:fs";
import path from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TABLE_FORMULA_ERROR_COLOR } from "@/features/document";
import type { SigmaTableCell, SigmaTableSpec } from "@/features/document";

import { OverlayTableStaticView } from "./react";

/**
 * The formula engine is pure and tested on its own; what this file pins is that the *drawing*
 * surfaces show the evaluated value rather than the source text — starting with the static tree,
 * which is what print, the PDF, the SVG export, the embedded viewer, thumbnails, the AI preview
 * cards and the idle canvas all render through.
 */

function paragraphCell(rowId: string, columnId: string, text: string): SigmaTableCell {
  return {
    id: `${rowId}-${columnId}`,
    rowId,
    columnId,
    content: [{
      type: "paragraph",
      id: `${rowId}-${columnId}-p`,
      children: [{ type: "text", text }],
    }],
  };
}

function gridTable(matrix: (string | null)[][]): SigmaTableSpec {
  const rowIds = matrix.map((_, index) => `r${index + 1}`);
  const columnIds = (matrix[0] ?? []).map((_, index) => `c${index + 1}`);
  return {
    version: 1,
    kind: "plain",
    columns: columnIds.map((id) => ({ id, width: { mode: "auto" } })),
    rows: rowIds.map((id) => ({ id, height: { mode: "auto" } })),
    cells: matrix.flatMap((row, rowIndex) => (
      row.flatMap((text, columnIndex) => (
        text === null ? [] : [paragraphCell(rowIds[rowIndex], columnIds[columnIndex], text)]
      ))
    )),
    grid: { borderColor: "#000000", borderWidth: 1 },
    defaultCellStyle: {},
  };
}

function renderStatic(table: SigmaTableSpec): string {
  return renderToStaticMarkup(
    <OverlayTableStaticView
      height={120}
      selfContained
      table={table}
      width={240}
      xmlns="http://www.w3.org/1999/xhtml"
    />,
  );
}

describe("the static table shows evaluated formulas", () => {
  it("draws the value instead of the source text", () => {
    // The sum is a number that appears nowhere else in the table, so this cannot pass on a cell
    // that merely echoed one of its inputs.
    const markup = renderStatic(gridTable([["2"], ["4"], ["6"], ["=SUM(A1:A3)"]]));

    expect(markup).toContain(">12<");
  });

  it("does not leave the source text anywhere in the markup", () => {
    const markup = renderStatic(gridTable([["2"], ["4"], ["6"], ["=AVERAGE(A1:A3)"]]));

    expect(markup).not.toContain("AVERAGE");
  });

  it("draws an error value", () => {
    expect(renderStatic(gridTable([["=1/0"]]))).toContain("#DIV/0!");
  });

  it("colours an error value inline, so a stylesheet-free export still shows it", () => {
    const markup = renderStatic(gridTable([["=1/0"]]));

    expect(markup).toContain(TABLE_FORMULA_ERROR_COLOR);
  });

  it("leaves a formula it cannot parse as the text that was typed", () => {
    const markup = renderStatic(gridTable([["=SUM(A1"]]));

    expect(markup).toContain("=SUM(A1");
  });

  it("does not colour a formula it cannot parse", () => {
    const markup = renderStatic(gridTable([["=SUM(A1"]]));

    expect(markup).not.toContain(TABLE_FORMULA_ERROR_COLOR);
  });

  it("keeps a plain cell untouched", () => {
    expect(renderStatic(gridTable([["ふつうの文"]]))).toContain("ふつうの文");
  });

  it("reads a merged cell once, as the grid does", () => {
    const table: SigmaTableSpec = {
      ...gridTable([["5", "x", "=SUM(A1:B1)"]]),
      cells: [
        { ...paragraphCell("r1", "c1", "5"), colSpan: 2 },
        paragraphCell("r1", "c3", "=SUM(A1:B1)"),
      ],
    };

    expect(renderStatic(table)).toContain(">5<");
  });
});

describe("every table surface delegates the formula projection", () => {
  /**
   * The three files that draw a cell's inline content. The settings preview cannot be mounted here
   * (it lives inside a dialog needing portals), so delegation is pinned at the source level for all
   * three together — the same technique the trend-cell parity test uses for the same reason.
   */
  const sites = {
    "static view": "./react/OverlayTableStaticView.tsx",
    "cell editor": "../../../components/editor/overlay-canvas/table-cell-content-editor.tsx",
    "settings preview": "../../../components/editor/TableSettingsDialog.tsx",
  };

  function sourceOf(relativePath: string): string {
    return readFileSync(path.resolve(import.meta.dirname, relativePath), "utf8")
      .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");
  }

  it("routes every surface through the shared projection", () => {
    for (const [name, relativePath] of Object.entries(sites)) {
      expect(sourceOf(relativePath), name).toContain("getTableCellDisplayNodes");
    }
  });

  it("leaves no surface drawing a cell's stored nodes directly", () => {
    for (const [name, relativePath] of Object.entries(sites)) {
      const source = sourceOf(relativePath);
      // `content.children` may still be read to build the projection's argument, but never handed
      // straight to a renderer — that is exactly the path that would show `=SUM(A1:A3)` on one
      // surface while its three siblings show `6`.
      expect(source, name).not.toMatch(/renderInlineContent\(\s*content\.children/);
      expect(source, name).not.toMatch(/nodes=\{content\.children\}/);
      expect(source, name).not.toMatch(/renderInlineNodes\(\s*content\.children\s*\)/);
    }
  });
});
