import type { CSSProperties } from "react";

import type { SigmaTableSpec } from "@/features/document";
import {
  getTableRenderedLineConnectorModels,
  getTableRenderedLineModels,
  type OverlayTableStyleModel,
} from "@/features/rendering/core";

/**
 * The `double` boundary lines of a table, drawn on top of the cell edges.
 *
 * Which lines exist and where they sit comes from `features/rendering/core`, the same model the
 * static view the SVG export renders reads — the editor only adds its own class names on top. The
 * offsets are that model's, not a measurement of the rendered rows: the editor used to hand this
 * component the `<tr>` rects it had read back out of the DOM, which drew the line in a different
 * place than the static twin (and than the PDF) whenever the browser had stretched a row.
 */
export function OverlayTableRenderedLines({
  table,
  columnOffsets,
  rowOffsets,
}: {
  table: SigmaTableSpec;
  columnOffsets: number[];
  rowOffsets: number[];
}) {
  return (
    <div className="overlay-table-rendered-lines" aria-hidden="true">
      {getTableRenderedLineModels(table, columnOffsets, rowOffsets).map((line) => (
        <div
          key={`rendered-${line.axis}-${line.domKey}`}
          className={`overlay-table-rendered-line ${line.axis}`}
          style={toReactStyle(line.style)}
        />
      ))}
      {getTableRenderedLineConnectorModels(table, columnOffsets, rowOffsets).map((connector) => (
        <div
          key={connector.id}
          className={`overlay-table-line-connector ${connector.axis}`}
          style={toReactStyle(connector.style)}
        />
      ))}
    </div>
  );
}

function toReactStyle(style: OverlayTableStyleModel): CSSProperties {
  return style as CSSProperties;
}
