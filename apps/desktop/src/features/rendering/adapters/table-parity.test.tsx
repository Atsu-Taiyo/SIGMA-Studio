import path from "node:path";
import { readStylesheet as readFileSync } from "../../../../tests/helpers/read-stylesheet";

import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { OverlayTableCellContentEditor } from "@/components/editor/overlay-canvas/table-cell-content-editor";
import type { OverlayShape, SigmaTableSpec } from "@/features/document";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";
import  {
  getTableCellStyleModel,
  getTableGridModel,
  getTableRenderedLineConnectorModels,
  getTableRenderedLineModels,
  getTableTrendGlyphModel,
  resolveTableColumnWidths,
  resolveTableRowHeights,
} from "@/features/rendering/core";

import { OverlayTableStaticView } from "./react";

/** A table with no cells: these tests render one cell in isolation, never a whole grid. */
const emptyTrendTable: SigmaTableSpec = {
  version: 1,
  kind: "plain",
  columns: [],
  rows: [],
  cells: [],
  grid: { borderColor: "#000000", borderWidth: 1 },
  defaultCellStyle: {},
};


/**
 * The table used to be drawn by two independent implementations: the React editor surface, and an
 * HTML string serializer inside `overlay-svg.ts`. They shared the border resolution but each
 * rebuilt the grid, the cell styles and the `double`-line overlay, so a change to one silently
 * left the other behind.
 *
 * There is now one renderer. `OverlayTableStaticView` is what the SVG export mounts through the
 * `OverlaySvgRenderers` port, and the editor reads its geometry from the same core model. These
 * tests pin the contract the deleted serializer used to hold up: the grid the export draws is the
 * grid the model computes, and the properties the exported markup has to keep carrying.
 */

interface Cell {
  tag: string;
  style: Record<string, string>;
  text: string;
  rowSpan: string | null;
  colSpan: string | null;
}

function renderTable(table: SigmaTableSpec, width: number, height: number, overflow = 0): string {
  return renderToStaticMarkup(
    <OverlayTableStaticView
      height={height}
      overflow={overflow}
      selfContained
      table={table}
      width={width}
      xmlns="http://www.w3.org/1999/xhtml"
    />,
  );
}

function parse(html: string) {
  const window = new Window();
  const container = window.document.createElement("div");
  container.innerHTML = html;
  return { container, window };
}

function parseStyle(value: null | string): Record<string, string> {
  const declarations: Record<string, string> = {};
  for (const declaration of (value ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator > 0) {
      declarations[declaration.slice(0, separator).trim()] = declaration.slice(separator + 1).trim();
    }
  }
  return declarations;
}

function readCells(html: string): Cell[] {
  const { container, window } = parse(html);
  const cells = Array.from(container.querySelectorAll("td")).map((element) => ({
    tag: element.tagName.toLowerCase(),
    style: parseStyle(element.getAttribute("style")),
    text: element.textContent ?? "",
    rowSpan: element.getAttribute("rowspan"),
    colSpan: element.getAttribute("colspan"),
  }));
  window.close();
  return cells;
}

function column(id: string, mode: "auto" | "fixed" | "fr", value: number) {
  return { id, width: { mode, value } } as SigmaTableSpec["columns"][number];
}

function row(id: string, value: number) {
  return { id, height: { mode: "fixed" as const, value } } as SigmaTableSpec["rows"][number];
}

function paragraphCell(id: string, rowId: string, columnId: string, text: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    rowId,
    columnId,
    content: [{ id: `${id}_p`, type: "paragraph" as const, children: [{ type: "text" as const, text }] }],
    ...extra,
  } as SigmaTableSpec["cells"][number];
}

function baseTable(overrides: Partial<SigmaTableSpec> = {}): SigmaTableSpec {
  return {
    kind: "plain",
    columns: [column("c1", "fixed", 80), column("c2", "fr", 1), column("c3", "auto", 40)],
    rows: [row("r1", 34), row("r2", 32)],
    cells: [
      paragraphCell("cell_1", "r1", "c1", "A"),
      paragraphCell("cell_2", "r1", "c2", "B"),
      paragraphCell("cell_3", "r2", "c1", "C"),
    ],
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: { align: "center", verticalAlign: "middle" },
    ...overrides,
  } as SigmaTableSpec;
}

describe("the exported table is drawn from the shared grid model", () => {
  it("emits one column per track at the resolved width", () => {
    const table = baseTable();
    const html = renderTable(table, 240, 120);
    const { container, window } = parse(html);
    const widths = Array.from(container.querySelectorAll("col"))
      .map((element) => parseStyle(element.getAttribute("style")).width);
    window.close();

    expect(widths).toEqual(resolveTableColumnWidths(table, 240).map((value) => `${value}px`));
  });

  it("emits one row per track at the resolved height", () => {
    const table = baseTable();
    const html = renderTable(table, 240, 120);
    const { container, window } = parse(html);
    const heights = Array.from(container.querySelectorAll("tr"))
      .map((element) => parseStyle(element.getAttribute("style")).height);
    window.close();

    expect(heights).toEqual(resolveTableRowHeights(table, 120).map((value) => `${value}px`));
  });

  it("skips the positions a span covers, exactly like the grid model", () => {
    const table = baseTable({
      cells: [
        paragraphCell("cell_span", "r1", "c1", "merged", { colSpan: 2, rowSpan: 2 }),
        paragraphCell("cell_side", "r1", "c3", "side"),
      ],
    });
    const grid = getTableGridModel(table, 240, 120);
    const cells = readCells(renderTable(table, 240, 120));

    expect(cells).toHaveLength(grid.rows.reduce((total, gridRow) => total + gridRow.cells.length, 0));
    expect(cells[0].rowSpan).toBe("2");
    expect(cells[0].colSpan).toBe("2");
    expect(cells[0].text).toBe("merged");
    // Row 1 keeps the span plus the third column; row 2 only has the third column left.
    expect(cells.map((cell) => cell.text)).toEqual(["merged", "side", ""]);
  });

  it("gives every cell the style the model computes", () => {
    const table = baseTable({
      defaultCellStyle: {
        align: "left",
        verticalAlign: "top",
        color: "#333333",
        backgroundColor: "#eeeeee",
        fontFamily: '"Yu Mincho", serif',
        fontSize: 12.5,
        fontWeight: "bold",
        paddingX: 3,
        paddingY: 7,
      },
    } as Partial<SigmaTableSpec>);
    const grid = getTableGridModel(table, 240, 120);
    const cells = readCells(renderTable(table, 240, 120));

    const expected = grid.rows.flatMap((gridRow) => gridRow.cells.map((gridCell) => (
      getTableCellStyleModel(
        table,
        gridCell.cell,
        gridCell.rowIndex,
        gridCell.columnIndex,
        gridCell.rowSpan,
        gridCell.colSpan,
      )
    )));

    expect(cells.map((cell) => cell.style["font-size"])).toEqual(expected.map(() => "12.5pt"));
    expect(cells.map((cell) => cell.style["text-align"])).toEqual(expected.map((style) => style.textAlign));
    expect(cells.map((cell) => cell.style["border-right"])).toEqual(expected.map((style) => style.borderRight));
    expect(cells.map((cell) => cell.style["border-top"])).toEqual(expected.map((style) => style.borderTop));
  });

  // SigmaDoc font sizes are points. Dropping to a plain number would let React write `px` and the
  // exported table would no longer match the editor.
  it("keeps the cell font size in pt", () => {
    const html = renderTable(baseTable({ defaultCellStyle: { fontSize: 9 } } as Partial<SigmaTableSpec>), 240, 120);

    expect(html).toContain("font-size:9pt");
    expect(html).not.toContain("font-size:9px");
  });

  it("pads the outer wrapper by the overflow so an edge border is not clipped", () => {
    const html = renderTable(baseTable(), 240, 120, 3);

    expect(html).toContain("width:246px");
    expect(html).toContain("height:126px");
    expect(html).toContain("padding:3px");
  });

  it("declares the XHTML namespace for foreignObject embedding", () => {
    expect(renderTable(baseTable(), 240, 120)).toContain('xmlns="http://www.w3.org/1999/xhtml"');
  });
});

describe("the double-border overlay", () => {
  const doubleTable = () => baseTable({
    grid: {
      borderColor: "#111827",
      borderWidth: 3,
      borderStyle: "double",
      showOuterBorder: true,
      showInnerBorders: true,
    },
  } as Partial<SigmaTableSpec>);

  // `double` is the only style drawn by the overlay; the cell edge is zeroed so it is not drawn
  // twice. Breaking either half makes the border vanish or doubles it.
  it("is the only case that produces overlay lines, and zeroes the cell edge", () => {
    const table = doubleTable();
    const lines = getTableRenderedLineModels(table, [0, 80, 160, 240], [0, 34, 66]);

    expect(lines.length).toBeGreaterThan(0);
    expect(readCells(renderTable(table, 240, 120))[0].style["border-top"]).toBe("0");
    expect(getTableRenderedLineModels(baseTable(), [0, 80, 160, 240], [0, 34, 66])).toEqual([]);
  });

  it("renders after </table> so it paints over the cell edges", () => {
    const html = renderTable(doubleTable(), 240, 120);

    expect(html.indexOf("</table>")).toBeLessThan(html.indexOf("z-index:2"));
  });

  it("emits every horizontal connector before every vertical one", () => {
    const table = doubleTable();
    const grid = getTableGridModel(table, 240, 120);
    const connectors = getTableRenderedLineConnectorModels(table, grid.columnOffsets, grid.rowOffsets);
    const axes = connectors.map((connector) => connector.axis);

    expect(axes.lastIndexOf("horizontal")).toBeLessThan(axes.indexOf("vertical"));

    const html = renderTable(table, 240, 120);
    const positions = connectors.map((connector) => html.indexOf(`top:${connector.style.top}`));
    expect(positions.every((position) => position >= 0)).toBe(true);
  });

  it("omits the overlay layer entirely when no line needs it", () => {
    expect(renderTable(baseTable(), 240, 120)).not.toContain("z-index:2");
  });
});

describe("cell content", () => {
  it("renders inline math through the shared inline renderer", () => {
    const table = baseTable({
      cells: [{
        id: "cell_math",
        rowId: "r1",
        columnId: "c1",
        content: [{
          id: "cell_math_p",
          type: "paragraph",
          children: [{ type: "mathInline", id: "m1", tex: "x^2", display: "inline" }],
        }],
      }],
    } as Partial<SigmaTableSpec>);
    const html = renderTable(table, 240, 120);

    expect(html).toContain('class="inline-math-node"');
    expect(html).toContain('data-sigma-doc-math-inline=""');
    expect(html).toContain("ML__latex");
  });

  it("inlines the boxed styling so a standalone SVG keeps the frame", () => {
    const table = baseTable({
      cells: [{
        id: "cell_boxed",
        rowId: "r1",
        columnId: "c1",
        content: [{
          id: "cell_boxed_p",
          type: "paragraph",
          children: [{ type: "text", text: "枠", marks: ["boxed"], boxedPaddingY: 2 }],
        }],
      }],
    } as Partial<SigmaTableSpec>);
    const html = renderTable(table, 240, 120);

    expect(html).toContain('class="boxed-text"');
    expect(html).toContain("border:var(--boxed-text-border-width, 1px)");
  });

  it("honours the paragraph alignment", () => {
    const table = baseTable({
      cells: [{
        id: "cell_align",
        rowId: "r1",
        columnId: "c1",
        content: [{
          id: "cell_align_p",
          type: "paragraph",
          align: "right",
          children: [{ type: "text", text: "右" }],
        }],
      }],
    } as Partial<SigmaTableSpec>);

    expect(renderTable(table, 240, 120)).toContain("text-align:right");
  });

  it("draws a trend cell with its arrow and label", () => {
    const table = baseTable({
      cells: [{
        id: "cell_trend",
        rowId: "r1",
        columnId: "c1",
        colSpan: 2,
        content: [{
          id: "cell_trend_t",
          type: "trend",
          direction: "up",
          label: [{ type: "text", text: "増加" }],
        }],
      }],
    } as Partial<SigmaTableSpec>);
    const html = renderTable(table, 240, 120);

    expect(html).toContain('width="76"');
    expect(html).toContain("<polygon");
    expect(html).toContain("増加");
  });
});

/**
 * A trend cell's arrow used to be drawn three times over: this SVG in the static view, and a KaTeX
 * arrow in both the cell editor and the settings preview — a different glyph, at a different size,
 * that did not stretch across a merged cell. All three now mount `OverlayTableTrendCell`, so the
 * three outputs are compared literally rather than pinned separately.
 *
 * The labels in these fixtures are plain text on purpose. `selfContained` is a legitimate difference
 * between the export and the two on-screen surfaces (the exported SVG is viewed without a
 * stylesheet, so inline math carries its styling), and it is covered by
 * `rich-text-self-contained.test.ts`; a math label here would only re-test that through a comparison
 * that has to be exact. What this suite fixes is that the three surfaces pass the same content
 * through the same component, which the source scan below completes.
 */
describe("every surface draws a trend cell the same way", () => {
  /** Declarations of the first rule whose selector list contains `selector`. */
  function ruleDeclarationsFor(cssPath: string, selector: string): string[] {
    const css = readFileSync(path.resolve(import.meta.dirname, cssPath), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const rule = new RegExp(`(?:^|[,;}])[^{}]*${escaped}\\s*\\{([^}]*)\\}`).exec(css);
    if (!rule) {
      throw new Error(`no rule for "${selector}" in ${cssPath}`);
    }
    return rule[1].split(";").map((declaration) => declaration.trim()).filter(Boolean);
  }

  function trendTable(direction: "down" | "flat" | "up", label: boolean, colSpan: number): SigmaTableSpec {
    return baseTable({
      // The SVG export runs the snapshot through `normalizeOverlaySnapshot`, which drops a table
      // spec without it.
      version: 1,
      cells: [{
        id: "cell_trend",
        rowId: "r1",
        columnId: "c1",
        colSpan,
        content: [{
          id: "cell_trend_t",
          type: "trend",
          direction,
          ...(label ? { label: [{ type: "text", text: "増加" }] } : {}),
        }],
      }],
    } as Partial<SigmaTableSpec>);
  }

  /** The trend cell's own subtree, so the surrounding cell chrome does not enter the comparison. */
  function extractTrendCell(html: string): string {
    const start = html.indexOf('<div class="overlay-table-trend"');
    if (start < 0) {
      throw new Error("no trend cell in the markup");
    }
    let depth = 0;
    for (let index = start; index < html.length; index += 1) {
      if (html.startsWith("<div", index)) {
        depth += 1;
      } else if (html.startsWith("</div>", index)) {
        depth -= 1;
        if (depth === 0) {
          return html.slice(start, index + "</div>".length);
        }
      }
    }
    throw new Error("unterminated trend cell");
  }

  function editorTrendCell(direction: "down" | "flat" | "up", label: boolean, colSpan: number): string {
    return extractTrendCell(renderToStaticMarkup(
      <OverlayTableCellContentEditor
        cell={undefined}
        cellId="cell_trend"
        colSpan={colSpan}
        columnIndex={0}
        content={{
          id: "cell_trend_t",
          type: "trend",
          direction,
          ...(label ? { label: [{ type: "text", text: "増加" }] } : {}),
        }}
        editing={false}
        showFormulaSource={false}
        table={emptyTrendTable}
        onChange={() => undefined}
        onFocus={() => undefined}
        onNavigate={() => false}
        onRegisterEditor={() => () => undefined}
        rowIndex={0}
        shapeId="shape_trend"
      />,
    ));
  }

  /** The SVG-string path, `<foreignObject>` and attribute fixups included. */
  function exportedTrendCell(table: SigmaTableSpec): string {
    const svg = exportOverlaySvg([{
      id: "shape_trend",
      type: "tableShape",
      x: 0,
      y: 0,
      props: { w: 240, h: 120, table },
    }] as unknown as OverlayShape[], {}, { width: 400, height: 300 });

    return extractTrendCell(svg ?? "");
  }

  it.each([
    ["up", true, 1],
    ["up", false, 1],
    ["down", true, 1],
    ["down", false, 1],
    ["flat", true, 1],
    ["flat", false, 1],
    ["up", true, 2],
    ["flat", false, 3],
  ] as const)("agrees on %s (label: %s, colSpan: %i)", (direction, label, colSpan) => {
    const staticCell = extractTrendCell(renderTable(trendTable(direction, label, colSpan), 240, 120));

    expect(editorTrendCell(direction, label, colSpan)).toBe(staticCell);
    expect(exportedTrendCell(trendTable(direction, label, colSpan))).toBe(staticCell);
  });

  it("draws the arrow from the shared geometry model", () => {
    const glyph = getTableTrendGlyphModel("up", 2);
    const cell = extractTrendCell(renderTable(trendTable("up", true, 2), 240, 120));

    expect(cell).toContain(`width="${glyph.width}" height="${glyph.height}"`);
    expect(cell).toContain(`viewBox="0 0 ${glyph.width} ${glyph.height}"`);
    expect(cell).toContain(`x1="${glyph.line.x1}" y1="${glyph.line.y1}" x2="${glyph.line.x2}" y2="${glyph.line.y2}"`);
    expect(cell).toContain(`points="${glyph.arrowPoints}"`);
    // The KaTeX arrows the editing surfaces used to draw are gone from all three outputs.
    expect(cell).not.toContain("katex");
    expect(cell).not.toContain("nearrow");
  });

  /**
   * Three stylesheets size every nested `svg` to its container, and they only reach some of the
   * surfaces: the idle canvas (`.page-overlay-preview svg`), the paper side
   * (`.print-page-overlay-layer svg`) and the embedded viewer get it, while the interactive layer and
   * a standalone exported SVG do not. Measured before the component carried it: 116x29 idle against
   * 44x24 while the same table was interactive.
   *
   * So the component declares it, and the values are read back out of the CSS rather than trusted to
   * a comment. Fixed pixels were the wrong answer in the other direction: an imported compact
   * and `.overlay-table-cell-content-layer` clips, so a 44px arrow lost its head.
   */
  it("carries the container sizing the overlay stylesheets supply", () => {
    const cell = extractTrendCell(renderTable(trendTable("up", false, 1), 240, 120));
    const sheets: Array<[string, string, string]> = [
      ["canvas", "../../../app/globals.css", ".page-overlay-preview svg"],
      ["paper", "../../../app/document-surface.css", ".print-page-overlay-layer svg"],
      ["viewer", "../../../../../../packages/viewer/src/styles.css", ".sigma-viewer .page-running-overlay-preview svg"],
    ];

    for (const [surface, cssPath, selector] of sheets) {
      const declarations = ruleDeclarationsFor(cssPath, selector);

      expect(declarations, surface).toContain("width: 100%");
      expect(declarations, surface).toContain("height: 100%");
      expect(declarations, surface).toContain("display: block");
    }

    expect(cell).toContain("display:block;overflow:visible;width:100%;height:100%");
  });

  /**
   * The settings preview is the one surface these tests cannot mount (it lives inside a dialog that
   * needs a DOM and portals, and the suite runs in `environment: "node"`), so its delegation is
   * pinned at the source level. The scan is deliberately narrow — the three files that render a
   * trend cell — because `\nearrow` is legitimate content elsewhere (the variation table factory,
   * the TeX reference, the AI tools that turn a trend into inline math).
   */
  it("leaves no surface drawing an arrow of its own", () => {
    const sites = {
      "static view": "../../rendering/adapters/react/OverlayTableStaticView.tsx",
      "cell editor": "../../../components/editor/overlay-canvas/table-cell-content-editor.tsx",
      "settings preview": "../../../components/editor/TableSettingsDialog.tsx",
    };

    for (const [name, relativePath] of Object.entries(sites)) {
      const source = readFileSync(path.resolve(import.meta.dirname, relativePath), "utf8")
        .replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

      expect(source, name).toContain("OverlayTableTrendCell");
      // Any TeX arrow command, not just the three that were here: `\uparrow` / `\longrightarrow`
      // would have slipped through a literal list.
      expect(source, name).not.toMatch(/\\\\(?:[a-zA-Z]*arrow[a-zA-Z]*|to)\b/);
    }
  });

  /**
   * The trend container's own layout is inline (the exported SVG is viewed without a stylesheet), so
   * an `.overlay-table-trend` rule could only reach the editing surface — which is exactly the
   * divergence that was removed: the rule used to set `font-size: 1.25em` (`1.55em` for up/down),
   * enlarging both the arrow and its label in the editor and nowhere else.
   */
  it("leaves no stylesheet rule that only the editing surface would see", () => {
    const globalsCss = readFileSync(
      path.resolve(import.meta.dirname, "../../../app/globals.css"),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");

    expect(globalsCss).not.toMatch(/\.overlay-table-trend[^-\w]/);
  });
});

/**
 * WI-1 replaces the running region's SVG-string figures with this React rendering, and the running
 * region reaches `packages/viewer` through `components/print/PrintPreview.tsx`. The viewer bundle
 * forbids Tiptap (`packages/viewer/src/package-boundary.test.ts`), so the static view has to stay
 * clear of it — including transitively, which the import-name checks in `architecture.test.ts`
 * cannot see.
 */
describe("the static table view stays mountable by the viewer", () => {
  it("pulls no editor runtime into its bundle", async () => {
    const { build } = await import("esbuild");
    const result = await build({
      entryPoints: [path.resolve(import.meta.dirname, "react/OverlayTableStaticView.tsx")],
      alias: { "@": path.resolve(import.meta.dirname, "../../..") },
      bundle: true,
      define: {
        "process.env.NODE_ENV": '"production"',
        "process.env.NEXT_PUBLIC_SIGMA_PERF": '"0"',
      },
      external: ["react", "react/*", "react-dom", "react-dom/*", "katex", "katex/*", "mathlive", "zod"],
      format: "esm",
      jsx: "automatic",
      logLevel: "silent",
      metafile: true,
      platform: "browser",
      target: ["es2021"],
      write: false,
    });

    const forbidden = [
      { label: "Tiptap", pattern: /(?:^|\/)node_modules\/@tiptap\// },
      { label: "ProseMirror", pattern: /(?:^|\/)node_modules\/prosemirror-/ },
      { label: "Next.js", pattern: /(?:^|\/)node_modules\/next\// },
      { label: "Electron", pattern: /(?:^|\/)node_modules\/electron/ },
    ];
    const inputs = Object.keys(result.metafile.inputs).map((input) => input.replace(/\\/g, "/"));

    expect(forbidden.flatMap(({ label, pattern }) => (
      inputs.filter((input) => pattern.test(input)).map((input) => `${label}: ${input}`)
    ))).toEqual([]);
  });
});

/**
 * Empirical constraint. `getOverlayPreviewSvg` runs `renderToStaticMarkup` on this component from
 * inside the editor's own render pass (page previews, material thumbnails). With a `useMemo` here,
 * `overlay-canvas.spec.ts`'s caret navigation case dropped to 2/10 (baseline 9/13); removing the
 * hook — the only change, against the same running dev server — took it to 5/5 and it has passed
 * every run since.
 *
 * The mechanism is not confirmed: a reviewer could not reproduce hook breakage from a nested
 * server render on React 19.2.6, and `Graph2DPreview` uses hooks through the same port. Treat that
 * asymmetry as unexplained rather than as a refutation, and keep the constraint — it costs nothing
 * because memoization belongs in the port (`react-static-renderers.tsx`), which caches the whole
 * markup per table snapshot anyway.
 */
describe("the static table view renders without hooks", () => {
  it("calls no React hook", () => {
    const source = readFileSync(
      path.resolve(import.meta.dirname, "react/OverlayTableStaticView.tsx"),
      "utf8",
    ).replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "");

    expect(source.match(/\buse[A-Z]\w*\s*\(/g) ?? []).toEqual([]);
  });
});

/**
 * A camelCase attribute name is silently ignored when the SVG is parsed as XML — the `rowSpan`
 * regression this scan was written for. `viewBox` is the one legitimate camelCase attribute in
 * SVG.
 */
describe("the exported markup uses XML-safe attribute names", () => {
  /** A merged cell (for `rowSpan`/`colSpan`) whose content is a trend arrow (for the SVG glyph). */
  function spanningTrendTable(): SigmaTableSpec {
    return baseTable({
      version: 1,
      cells: [{
        id: "cell_span",
        rowId: "r1",
        columnId: "c1",
        colSpan: 2,
        rowSpan: 2,
        content: [{ id: "cell_span_t", type: "trend", direction: "up" }],
      }],
    } as Partial<SigmaTableSpec>);
  }

  function camelCaseAttributes(markup: string): string[] {
    return [...new Set([...markup.matchAll(/\s([a-z]+[A-Z][A-Za-z]*)=/g)]
      .map((match) => match[1])
      .filter((name) => name !== "viewBox"))].sort();
  }

  it("emits no camelCase attribute other than viewBox", () => {
    // React writes `rowSpan`/`colSpan` in DOM-property casing, and nothing else in this tree does —
    // the arrow's `strokeWidth` prop already comes out as `stroke-width`.
    expect(camelCaseAttributes(renderTable(spanningTrendTable(), 240, 120, 1)))
      .toEqual(["colSpan", "rowSpan"]);
  });

  it("lowercases them on the way through the SVG port", () => {
    const svg = exportOverlaySvg([{
      id: "shape_span",
      type: "tableShape",
      x: 0,
      y: 0,
      props: { w: 240, h: 120, table: spanningTrendTable() },
    }] as unknown as OverlayShape[], {}, { width: 400, height: 300 }) ?? "";

    expect(svg).toContain('colspan="2"');
    expect(svg).toContain('rowspan="2"');
    expect(camelCaseAttributes(svg)).toEqual([]);
  });
});
