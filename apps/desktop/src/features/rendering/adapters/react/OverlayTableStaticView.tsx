"use client";

import type { CSSProperties, ReactNode } from "react";

import { getTableCellDisplayNodes } from "@/features/document";
import type {
  MathFractionSizing,
  SigmaTableCell,
  SigmaTableCellContent,
  SigmaTableSpec,
} from "@/features/document";
import { isSafeCssDeclarationValue } from "@/features/document/css-safety";
import {
  getTableCellContentLayerStyleModel,
  getTableCellStyleModel,
  getTableGridModel,
  getTableRenderedLineConnectorModels,
  getTableRenderedLineModels,
  getTableTrendGlyphModel,
  OVERLAY_TABLE_CELL_CONTENT_LAYER_STATIC_STYLE,
  OVERLAY_TABLE_CELL_STATIC_STYLE,
  OVERLAY_TABLE_TEXT_STATIC_STYLE,
  type OverlayTableStyleModel,
} from "@/features/rendering/core";

import { renderInlineContent } from "./InlineContent";

export interface OverlayTableStaticViewProps {
  table: SigmaTableSpec;
  width: number;
  height: number;
  /**
   * Padding around the table, in px, so a border drawn on the outer edge is not clipped by the
   * `<foreignObject>` it is embedded in. The SVG export passes the widest boundary border here;
   * on screen there is nothing to clip against, so it stays 0.
   */
  overflow?: number;
  mathFractionSizing?: MathFractionSizing | null;
  /**
   * Inline the styling the stylesheet would supply. Required for the SVG export, whose output is
   * also viewed standalone.
   */
  selfContained?: boolean;
  /** `<foreignObject>` content has to declare the XHTML namespace. */
  xmlns?: string;
}

/**
 * Read-only rendering of a SigmaDoc table.
 *
 * This is the single output for the table's static form: the SVG export renders it through the
 * `OverlaySvgRenderers` port instead of serializing its own HTML, and the editor reads the same
 * geometry out of `features/rendering/core`. It is deliberately Tiptap-free so the print surface —
 * and therefore `packages/viewer` — can mount it (`package-boundary.test.ts`).
 *
 * Everything is drawn with inline styles: the exported SVG ends up inside
 * `dangerouslySetInnerHTML` in places that do not carry the app stylesheet (material thumbnails,
 * AI preview cards).
 */
export function OverlayTableStaticView({
  table,
  width,
  height,
  overflow = 0,
  mathFractionSizing,
  selfContained,
  xmlns,
}: OverlayTableStaticViewProps) {
  // Deliberately hook-free: the SVG export renders this through `renderToStaticMarkup`, which can
  // run inside another React tree's render pass. Memoization lives in the port instead
  // (`react-static-renderers.tsx`), which caches the whole markup per table snapshot.
  const grid = getTableGridModel(table, width, height);

  return (
    <div
      // `<foreignObject>` children must declare the XHTML namespace; React has no typing for it
      // on an HTML element, so it is spread through.
      {...(xmlns ? ({ xmlns } as { xmlns: string }) : {})}
      style={{
        boxSizing: "border-box",
        width: `${width + overflow * 2}px`,
        height: `${height + overflow * 2}px`,
        overflow: "visible",
        padding: `${overflow}px`,
        // The interactive table inherits these from `.overlay-table-shape`; this tree has no such
        // wrapper, so it carries them itself or its cells lay out on different line boxes.
        ...toReactStyle(OVERLAY_TABLE_TEXT_STATIC_STYLE),
      }}
    >
      <div style={{ position: "relative", width: `${width}px`, height: `${height}px` }}>
        <table
          style={{
            boxSizing: "border-box",
            width: `${width}px`,
            height: `${height}px`,
            borderCollapse: "collapse",
            tableLayout: "fixed",
            background: "transparent",
            border: 0,
          }}
        >
          <colgroup>
            {table.columns.map((column, index) => (
              <col key={column.id} style={{ width: `${grid.columnWidths[index]}px` }} />
            ))}
          </colgroup>
          <tbody>
            {grid.rows.map((row) => (
              <tr key={row.rowId} style={{ height: `${row.height}px` }}>
                {row.cells.map((gridCell) => (
                  <td
                    key={gridCell.cell?.id ?? `${row.rowId}:${gridCell.columnIndex}`}
                    rowSpan={gridCell.rowSpan > 1 ? gridCell.rowSpan : undefined}
                    colSpan={gridCell.colSpan > 1 ? gridCell.colSpan : undefined}
                    style={toReactStyle({
                      ...OVERLAY_TABLE_CELL_STATIC_STYLE,
                      ...getTableCellStyleModel(
                        table,
                        gridCell.cell,
                        gridCell.rowIndex,
                        gridCell.columnIndex,
                        gridCell.rowSpan,
                        gridCell.colSpan,
                      ),
                    })}
                  >
                    <div
                      style={toReactStyle({
                        ...OVERLAY_TABLE_CELL_CONTENT_LAYER_STATIC_STYLE,
                        ...getTableCellContentLayerStyleModel(table, gridCell.cell),
                      })}
                    >
                      {gridCell.cell?.content.map((content) => (
                        <OverlayTableCellContentStaticView
                          key={content.id}
                          cell={gridCell.cell}
                          content={content}
                          mathFractionSizing={mathFractionSizing}
                          selfContained={selfContained}
                          table={table}
                        />
                      ))}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {/* After `</table>`: the overlay draws `double` boundaries on top of the cell edges.
            `shape-renderer-architecture.test.ts` pins this order for the editor too. */}
        <OverlayTableLineOverlay
          table={table}
          columnOffsets={grid.columnOffsets}
          rowOffsets={grid.rowOffsets}
        />
      </div>
    </div>
  );
}

function OverlayTableLineOverlay({
  table,
  columnOffsets,
  rowOffsets,
}: {
  table: SigmaTableSpec;
  columnOffsets: number[];
  rowOffsets: number[];
}) {
  const lines = getTableRenderedLineModels(table, columnOffsets, rowOffsets);
  const connectors = getTableRenderedLineConnectorModels(table, columnOffsets, rowOffsets);
  if (lines.length === 0 && connectors.length === 0) {
    return null;
  }

  return (
    <div style={{ position: "absolute", inset: 0, zIndex: 2, pointerEvents: "none" }}>
      {lines.map((line) => (
        <div
          key={`rendered-${line.axis}-${line.domKey}`}
          style={{
            position: "absolute",
            ...(line.axis === "vertical"
              ? { top: 0, bottom: 0, width: 0 }
              : { right: 0, left: 0, height: 0 }),
            ...toReactStyle(line.style),
            pointerEvents: "none",
          }}
        />
      ))}
      {connectors.map((connector) => (
        <div
          key={connector.id}
          style={{
            position: "absolute",
            zIndex: 3,
            boxSizing: "border-box",
            ...toReactStyle(connector.style),
            pointerEvents: "none",
          }}
        />
      ))}
    </div>
  );
}

function OverlayTableCellContentStaticView({
  cell,
  content,
  mathFractionSizing,
  selfContained,
  table,
}: {
  cell: SigmaTableCell | undefined;
  content: SigmaTableCellContent;
  mathFractionSizing?: MathFractionSizing | null;
  selfContained?: boolean;
  table: SigmaTableSpec;
}): ReactNode {
  if (content.type === "trend") {
    return (
      <OverlayTableTrendCell
        colSpan={cell?.colSpan ?? 1}
        content={content}
        mathFractionSizing={mathFractionSizing}
        selfContained={selfContained}
      />
    );
  }

  return (
    // `margin` is a literal and stays outside the funnel (React renders the number as `0px`, which
    // the parity tests pin); `align` is the one document-supplied value here, so it goes through.
    <p style={{ margin: 0, ...toReactStyle(content.align ? { textAlign: content.align } : {}) }}>
      {renderInlineContent(getTableCellDisplayNodes(table, cell, content), {
        keyPrefix: content.id,
        mathFractionSizing,
        selfContained,
      })}
    </p>
  );
}

export interface OverlayTableTrendCellProps {
  content: Extract<SigmaTableCellContent, { type: "trend" }>;
  /** Widens the arrow across a merged cell, from the owning cell's `colSpan`. */
  colSpan: number;
  mathFractionSizing?: MathFractionSizing | null;
  selfContained?: boolean;
}

/**
 * The one rendering of a `trend` cell.
 *
 * The cell editor (`table-cell-content-editor.tsx`) and the table settings preview
 * (`TableSettingsDialog.tsx`) mount this too, so the arrow an author edits is the arrow the PDF,
 * the SVG export and the embedded viewer draw. They each used to draw a KaTeX arrow of their own
 * (`\nearrow` / `\searrow` / `\rightarrow`, and `\to` in the settings preview), which was a
 * different glyph from this one, did not stretch across a merged cell, and put a `MathPreview` in
 * every trend cell of every table on the page.
 *
 * Everything it needs to look the same on every surface is declared here, because the exported SVG is
 * also viewed without a stylesheet: the flex container has no `.overlay-table-trend` rule left to
 * keep in step with (`table-parity.test.tsx` pins its absence, and the class name survives only as
 * the marker for a trend cell), and the arrow repeats the sizing the overlay stylesheets give a
 * nested `svg` — see the comment on it.
 */
export function OverlayTableTrendCell({
  content,
  colSpan,
  mathFractionSizing,
  selfContained,
}: OverlayTableTrendCellProps): ReactNode {
  const glyph = getTableTrendGlyphModel(content.direction, colSpan);

  return (
    <div
      className="overlay-table-trend"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "4px",
        width: "100%",
        minHeight: "1.75em",
      }}
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        width={glyph.width}
        height={glyph.height}
        viewBox={`0 0 ${glyph.width} ${glyph.height}`}
        // Sized to the cell, with `viewBox` scaling the drawing uniformly to fit: a narrow column
        // (an imported compact variation table gives its interval columns a 24px content box) shrinks
        // the arrow instead of clipping it.
        //
        // This is what the overlay stylesheets already say — `.page-overlay-preview svg`
        // (`globals.css`), `.print-page-overlay-layer svg` (`document-surface.css`) and the viewer's
        // copy all set `width/height: 100%` on a nested `svg`. Those reach the idle canvas, the PDF
        // and the thumbnails, but not the interactive layer and not a standalone export, so the same
        // cell drew a different arrow depending on the surface. Declaring it here makes the surface
        // stop mattering; the values are compared against the CSS in `table-parity.test.tsx`.
        style={{ display: "block", overflow: "visible", width: "100%", height: "100%" }}
      >
        <line
          x1={glyph.line.x1}
          y1={glyph.line.y1}
          x2={glyph.line.x2}
          y2={glyph.line.y2}
          stroke={glyph.color}
          strokeWidth={glyph.strokeWidth}
        />
        <polygon points={glyph.arrowPoints} fill={glyph.color} />
      </svg>
      {content.label?.length
        ? (
            <span>
              {renderInlineContent(content.label, {
                keyPrefix: `${content.id}-label`,
                mathFractionSizing,
                selfContained,
              })}
            </span>
          )
        : null}
    </div>
  );
}

/**
 * The single funnel every document-supplied static table style passes through. `renderToStaticMarkup` writes style
 * object values into the attribute without escaping `;`, so a document-supplied value reaches the
 * exported markup as extra declarations — invisible in the live DOM, where CSSOM discards the
 * malformed value, and very visible in the SVG/print output that re-injects this markup.
 *
 * The filter runs per value rather than per color because `getTableRenderedLineStyleModel` builds
 * composite values (`1px solid <color>`) that embed the document string, and it rejects non-strings
 * outright — the model is `Record<string, string>`, so anything else came from a document that
 * never passed a type guard, and React would stringify it into the markup as-is.
 */
function toReactStyle(style: OverlayTableStyleModel): CSSProperties {
  let safe: Record<string, unknown> | undefined;
  for (const [property, value] of Object.entries(style)) {
    if (!isSafeCssDeclarationValue(value)) {
      safe ??= { ...style };
      delete safe[property];
    }
  }
  return (safe ?? style) as CSSProperties;
}
