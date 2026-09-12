import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { SigmaTableCellContent, SigmaTableSpec } from "@/features/document";

import { OverlayTableCellContentEditor } from "./table-cell-content-editor";

/** A table with no cells: these tests render one cell in isolation, never a whole grid. */
const emptyTable: SigmaTableSpec = {
  version: 1,
  kind: "plain",
  columns: [],
  rows: [],
  cells: [],
  grid: { borderColor: "#000000", borderWidth: 1 },
  defaultCellStyle: {},
};


const callbacks = {
  onFocus: () => undefined,
  onChange: () => undefined,
  onNavigate: () => false,
  onRegisterEditor: () => () => undefined,
};

describe("OverlayTableCellContentEditor", () => {
  it("preserves static paragraph alignment and inline content order", () => {
    const content: SigmaTableCellContent = {
      type: "paragraph",
      id: "paragraph",
      align: "right",
      children: [
        { type: "text", text: "左" },
        {
          type: "mathInline",
          id: "math",
          tex: "x",
          display: "inline",
        },
        { type: "text", text: "右" },
      ],
    };

    const markup = renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cellId="cell"
        content={content}
        editing={false}
        showFormulaSource={false}
        cell={undefined}
        table={emptyTable}
        rowIndex={0}
        columnIndex={0}
        colSpan={1}
      />,
    );

    expect(markup).toContain('class="overlay-table-shape-content ProseMirror"');
    // The cell editor is a one-paragraph Tiptap document, so the alignment belongs on a `<p>` and
    // `.overlay-table-shape-content p { flex: 0 0 auto; margin: 0 }` has to apply to it. Putting the
    // run straight into the flex container instead (and the alignment on the container) made the
    // cell's line box a differently sized flex item, so its text moved when the cell took focus.
    expect(markup).toContain('<div class="overlay-table-shape-content ProseMirror"><p style="text-align:right">');
    expect(markup.indexOf("左")).toBeLessThan(markup.indexOf('data-tex="x"'));
    expect(markup.indexOf('data-tex="x"')).toBeLessThan(markup.indexOf("右"));
  });

  it("leaves the static paragraph unstyled when the cell has no alignment", () => {
    const content: SigmaTableCellContent = {
      type: "paragraph",
      id: "paragraph",
      children: [{ type: "text", text: "既定" }],
    };

    const markup = renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cellId="cell"
        content={content}
        editing={false}
        showFormulaSource={false}
        cell={undefined}
        table={emptyTable}
        rowIndex={0}
        columnIndex={0}
        colSpan={1}
      />,
    );

    // `inlineNodesToTiptapDoc` omits `textAlign` when there is none, so the editor's `<p>` carries
    // no style either.
    expect(markup).toContain('<div class="overlay-table-shape-content ProseMirror"><p>');
    expect(markup).not.toContain("text-align");
  });

  // A trend cell is drawn by `OverlayTableTrendCell` here, the same component the static view, the
  // SVG export and the settings preview mount. It used to be a KaTeX `\nearrow` (`\searrow`,
  // `\rightarrow`) scaled up by `.overlay-table-trend`, which was a different arrow from the one the
  // PDF drew and did not widen across a merged cell. `features/rendering/adapters/table-parity.test.tsx`
  // compares the three outputs; these cases pin what this surface passes in.
  it.each([
    ["up", 18, 6],
    ["down", 6, 18],
    ["flat", 12, 12],
  ] as const)("renders the %s trend arrow and label", (direction, y1, y2) => {
    const content: SigmaTableCellContent = {
      type: "trend",
      id: `trend_${direction}`,
      direction,
      label: [{ type: "text", text: "傾向" }],
    };

    const markup = renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cellId="cell"
        content={content}
        editing={false}
        showFormulaSource={false}
        cell={undefined}
        table={emptyTable}
        rowIndex={0}
        columnIndex={0}
        colSpan={1}
      />,
    );

    expect(markup).toContain('class="overlay-table-trend"');
    expect(markup).toContain(`y1="${y1}"`);
    expect(markup).toContain(`y2="${y2}"`);
    expect(markup).toContain("<polygon");
    expect(markup).toContain("傾向");
    expect(markup).not.toContain("katex");
  });

  it("widens the trend arrow across the columns the cell spans", () => {
    const content: SigmaTableCellContent = {
      type: "trend",
      id: "trend_merged",
      direction: "up",
    };

    const markup = renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cellId="cell"
        content={content}
        editing={false}
        showFormulaSource={false}
        cell={undefined}
        table={emptyTable}
        rowIndex={0}
        columnIndex={0}
        colSpan={2}
      />,
    );

    expect(markup).toContain('width="76"');
    // No label, no `<span>` for one.
    expect(markup).not.toContain("<span");
  });
});

describe("a formula cell swaps between its value and its source", () => {
  /** Two cells in one column: a number, and a formula reading it. */
  const formulaTable: SigmaTableSpec = {
    version: 1,
    kind: "plain",
    columns: [{ id: "c1", width: { mode: "auto" } }],
    rows: [{ id: "r1", height: { mode: "auto" } }, { id: "r2", height: { mode: "auto" } }],
    cells: [
      {
        id: "r1-c1",
        rowId: "r1",
        columnId: "c1",
        content: [{ type: "paragraph", id: "p1", children: [{ type: "text", text: "7" }] }],
      },
      {
        id: "r2-c1",
        rowId: "r2",
        columnId: "c1",
        content: [{ type: "paragraph", id: "p2", children: [{ type: "text", text: "=A1*3" }] }],
      },
    ],
    grid: { borderColor: "#000000", borderWidth: 1 },
    defaultCellStyle: {},
  };

  const formulaCell = formulaTable.cells[1];
  const formulaContent = formulaCell.content[0] as SigmaTableCellContent;

  function render(editing: boolean, showFormulaSource: boolean): string {
    return renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cell={formulaCell}
        cellId={formulaCell.id}
        content={formulaContent}
        editing={editing}
        showFormulaSource={showFormulaSource}
        table={formulaTable}
        rowIndex={1}
        columnIndex={0}
        colSpan={1}
      />,
    );
  }

  it("shows the value when the table is not being edited", () => {
    expect(render(false, false)).toContain("21");
  });

  it("shows the value while another cell is being edited", () => {
    expect(render(true, false)).toContain("21");
  });

  it("does not leak the source text while showing the value", () => {
    expect(render(true, false)).not.toContain("=A1*3");
  });

  it("hands the cell to the editor once the caret is in it", () => {
    // The Tiptap editor renders empty in `renderToStaticMarkup`, so what is asserted is that the
    // static value paragraph is gone — the switch happened.
    expect(render(true, true)).not.toContain("21");
  });

  it("still mounts the editor for a cell holding no formula", () => {
    const plainCell = formulaTable.cells[0];
    const markup = renderToStaticMarkup(
      <OverlayTableCellContentEditor
        {...callbacks}
        shapeId="shape"
        cell={plainCell}
        cellId={plainCell.id}
        content={plainCell.content[0] as SigmaTableCellContent}
        editing={true}
        showFormulaSource={false}
        table={formulaTable}
        rowIndex={0}
        columnIndex={0}
        colSpan={1}
      />,
    );

    // A cell holding no formula must still mount its editor when the table is being edited —
    // otherwise turning on formulas would have made every ordinary cell read-only. The static path
    // renders the text inside `.rich-inline-content`; the editor path renders an empty Tiptap
    // container under `renderToStaticMarkup`, so the text's absence is the proof.
    expect(markup).not.toContain("rich-inline-content");
  });
});
