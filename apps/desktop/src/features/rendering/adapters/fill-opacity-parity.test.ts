import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { OverlayShapeReadOnlyView } from "@/components/editor/overlay-canvas/shape-renderer";
import type { OverlayShape, OverlaySnapshot } from "@/features/document";
import { getOverlayPreviewSvg } from "@/features/rendering/adapters/svg";
import { normalizeFillOpacity } from "@/lib/fill-opacity";

/**
 * A fill's transparency is drawn by two independent implementations: the React canvas (which is
 * also the print/PDF path) and the SVG string exporter (viewer, thumbnails, gallery). They express
 * "fully opaque" differently — React writes `fill-opacity="1"`, the exporter omits the attribute —
 * so the comparison is on the *effective* value, which is what a reader actually sees.
 */

const FILL_COLOR = "#3366cc";

function geo(fillOpacity: number | undefined, fill: "solid" | "none" = "solid"): OverlayShape {
  return {
    id: "shape_fill_geo",
    type: "geo",
    x: 0,
    y: 0,
    props: {
      geo: "rectangle",
      w: 120,
      h: 80,
      fill,
      fillColor: FILL_COLOR,
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...(fillOpacity === undefined ? {} : { fillOpacity }),
    },
  } as OverlayShape;
}

function sector(fillOpacity: number | undefined): OverlayShape {
  return {
    id: "shape_fill_sector",
    type: "arc",
    x: 0,
    y: 0,
    props: {
      kind: "sector",
      r: 50,
      startAngle: 0,
      endAngle: Math.PI / 2,
      fill: "solid",
      fillColor: FILL_COLOR,
      color: "#111827",
      dash: "solid",
      size: "m",
      ...(fillOpacity === undefined ? {} : { fillOpacity }),
    },
  } as OverlayShape;
}

function closedLine(fillOpacity: number | undefined): OverlayShape {
  return {
    id: "shape_fill_line",
    type: "line",
    x: 0,
    y: 0,
    props: {
      kind: "polyline",
      points: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 30, y: 40 }],
      closed: true,
      fill: "solid",
      fillColor: FILL_COLOR,
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...(fillOpacity === undefined ? {} : { fillOpacity }),
    },
  } as OverlayShape;
}

/** The painted fill opacity: an absent attribute means fully opaque on both sides. */
function effectiveFillOpacity(markup: string): number {
  const match = markup.match(/fill-opacity="([^"]*)"/);
  return match ? normalizeFillOpacity(Number(match[1])) : 1;
}

function canvasMarkup(shape: OverlayShape): string {
  return renderToStaticMarkup(createElement(OverlayShapeReadOnlyView, { shape, assets: {} }));
}

function exportedMarkup(shape: OverlayShape): string {
  const overlaySnapshot: OverlaySnapshot = { version: 1, shapes: [shape], assets: {} };
  return getOverlayPreviewSvg({ overlaySnapshot }) ?? "";
}

const SHAPES: ReadonlyArray<[string, (fillOpacity: number | undefined) => OverlayShape]> = [
  ["rectangle", geo],
  ["sector", sector],
  ["closed line", closedLine],
];

describe("fill opacity parity between the canvas and the SVG exporter", () => {
  for (const [label, make] of SHAPES) {
    it.each([0, 0.35, 1, undefined])(`draws a ${label} at %s the same on both sides`, (fillOpacity) => {
      const shape = make(fillOpacity);

      expect(effectiveFillOpacity(canvasMarkup(shape)))
        .toBe(effectiveFillOpacity(exportedMarkup(shape)));
      expect(effectiveFillOpacity(canvasMarkup(shape))).toBe(normalizeFillOpacity(fillOpacity));
    });
  }

  it("keeps a fully transparent fill apart from no fill at all", () => {
    // Both are invisible; only one keeps a colour to come back to. If the two collapsed, reopening
    // the palette on a 0% figure would offer no colour to restore.
    const transparent = geo(0);
    const unfilled = geo(undefined, "none");

    expect(canvasMarkup(transparent)).toContain(FILL_COLOR);
    expect(exportedMarkup(transparent)).toContain(FILL_COLOR);
    expect(canvasMarkup(unfilled)).not.toContain(FILL_COLOR);
    expect(exportedMarkup(unfilled)).not.toContain(FILL_COLOR);
  });

  it("does not emit a fill opacity for an unfilled shape on either side", () => {
    const unfilled = geo(undefined, "none");

    expect(effectiveFillOpacity(canvasMarkup(unfilled))).toBe(1);
    expect(effectiveFillOpacity(exportedMarkup(unfilled))).toBe(1);
  });
});
