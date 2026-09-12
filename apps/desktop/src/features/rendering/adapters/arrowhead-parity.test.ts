import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { describe, expect, it } from "vitest";

import { ArrowMarkerDefs, OverlayShapeReadOnlyView } from "@/components/editor/overlay-canvas/shape-renderer";
import { markerUrl } from "@/components/editor/overlay-canvas/render-attrs";
import { LINE_ENDPOINT_OPTIONS, SHORTCUT_ARROWHEAD_VALUES } from "@/components/editor/editor-shell/constants";
import { LineEndpointPreview } from "@/components/editor/editor-shell/formatting-icons";
import { OVERLAY_ARROWHEADS, type OverlayArrowhead, type OverlayShape, type OverlaySnapshot } from "@/features/document";
import { getShapeBounds } from "@/features/drawing";
import { getOverlayPreviewSvg } from "@/features/rendering/adapters/svg";
import {
  ARROWHEAD_MARKER_SPECS,
  arrowheadMarkerId,
  getArrowheadTrimInStrokes,
  overlayStrokeWidth,
  planArrowheadEndpoints,
} from "@/features/rendering/core";
import { EDITOR_COMMAND_SHORTCUTS } from "@/lib/editor-command-shortcuts";
import { createTranslator } from "@/lib/i18n";

/**
 * Arrow heads used to be described three times: once as JSX in the editor canvas (which is also
 * the print/PDF path), once as a string in the SVG exporter, and once again as a hand-drawn
 * toolbar preview. Nothing tied the three together, so a head could be selectable in the menu,
 * correct on screen and missing on paper.
 *
 * They all read `ARROWHEAD_MARKER_SPECS` now. These tests hold that seam shut: the two SVG
 * producers have to emit the same marker id, the same geometry and the same placement attributes
 * for every head the document model allows, and the menu has to offer exactly those heads.
 */

const SHAPE_ID = "overlay_shape_parity";
const SHAPE_LENGTH = 100;

/** The plan the exported shape below produces, so both renderers are asked for the same drawing. */
function planFor(head: OverlayArrowhead) {
  return planArrowheadEndpoints(head, head, overlayStrokeWidth("m"), SHAPE_LENGTH, {
    start: SHAPE_LENGTH,
    end: SHAPE_LENGTH,
  });
}

function reactMarkers(head: OverlayArrowhead, opacity?: number): string {
  return renderToStaticMarkup(createElement(ArrowMarkerDefs, {
    shapeId: SHAPE_ID,
    color: "#123456",
    opacity,
    plan: planFor(head),
  }));
}

function exportedMarkers(head: OverlayArrowhead, opacity?: number): string {
  const overlaySnapshot: OverlaySnapshot = {
    version: 1,
    shapes: [{
      id: SHAPE_ID,
      type: "arrow",
      x: 0,
      y: 0,
      props: {
        start: { x: 0, y: 0 },
        end: { x: SHAPE_LENGTH, y: 0 },
        arrowheadStart: head,
        arrowheadEnd: head,
        fill: "none",
        color: "#123456",
        labelColor: "#123456",
        strokeOpacity: opacity,
        dash: "solid",
        size: "m",
      },
    }],
    assets: {},
  };
  return getOverlayPreviewSvg({ overlaySnapshot }) ?? "";
}

/** Every `<marker>` element, normalised to `id → { attribute: value }` plus its child markup. */
function parseMarkers(svg: string): Map<string, Record<string, string>> {
  const markers = new Map<string, Record<string, string>>();
  for (const match of svg.matchAll(/<marker\s([^>]*?)>([\s\S]*?)<\/marker>/g)) {
    const attributes: Record<string, string> = {};
    for (const attribute of match[1].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attributes[attribute[1].toLowerCase().replace(/-/g, "")] = attribute[2];
    }
    const child = match[2];
    attributes.shape = child.includes("<circle")
      ? `circle ${attributeOf(child, "cx")},${attributeOf(child, "cy")} r${attributeOf(child, "r")}`
      : `path ${attributeOf(child, "d")}`;
    attributes.fill = attributeOf(child, "fill");
    attributes.stroke = attributeOf(child, "stroke") || "none";
    attributes.strokewidth = attributeOf(child, "stroke-width") || attributeOf(child, "strokeWidth") || "0";
    attributes.opacity = attributeOf(child, "opacity") || "1";
    markers.set(attributes.id, attributes);
  }
  return markers;
}

function attributeOf(markup: string, name: string): string {
  const match = markup.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`));
  return match ? match[1] : "";
}

const DRAWN_HEADS = OVERLAY_ARROWHEADS.filter((head) => head !== "none");

describe("arrow head parity between the canvas and the SVG exporter", () => {
  it.each(DRAWN_HEADS)("draws %s identically in both renderers", (head) => {
    const fromCanvas = parseMarkers(reactMarkers(head));
    const fromExport = parseMarkers(exportedMarkers(head));

    expect([...fromCanvas.keys()].sort()).toEqual([...fromExport.keys()].sort());
    expect(fromCanvas.size).toBe(2);
    for (const [id, canvasAttributes] of fromCanvas) {
      const exportAttributes = fromExport.get(id);
      expect(exportAttributes).toBeDefined();
      for (const attribute of ["markerwidth", "markerheight", "refx", "refy", "orient", "markerunits", "shape", "fill", "stroke", "strokewidth", "opacity"]) {
        expect(`${id}.${attribute}=${canvasAttributes[attribute]}`)
          .toBe(`${id}.${attribute}=${exportAttributes?.[attribute]}`);
      }
    }
  });

  it.each(DRAWN_HEADS)("references %s by the same id it declares", (head) => {
    const declared = [...parseMarkers(reactMarkers(head)).keys()].sort();
    const referenced = (["start", "end"] as const)
      .map((endpoint) => markerUrl(SHAPE_ID, endpoint, head))
      .map((url) => url?.slice("url(#".length, -1))
      .sort();

    expect(referenced).toEqual(declared);
    // The `arrow` head has been persisted under the id `arrowhead` since the first release, and
    // its small variant follows that name rather than its own.
    const prefix = head.replace(/^arrow(?=$|Small)/u, "arrowhead");
    expect(referenced.every((id) => id?.startsWith(prefix))).toBe(true);
    expect(exportedMarkers(head)).toContain(`marker-end="url(#${arrowheadMarkerId(head, SHAPE_ID, "end")})"`);
    expect(exportedMarkers(head)).toContain(`marker-start="url(#${arrowheadMarkerId(head, SHAPE_ID, "start")})"`);
  });

  it.each(DRAWN_HEADS)("carries the same transparency on %s in both renderers", (head) => {
    const fromCanvas = parseMarkers(reactMarkers(head, 0.4));
    const fromExport = parseMarkers(exportedMarkers(head, 0.4));

    for (const [id, canvasAttributes] of fromCanvas) {
      expect(canvasAttributes.opacity).toBe("0.4");
      expect(fromExport.get(id)?.opacity).toBe("0.4");
    }
  });

  it("declares nothing for a head of none", () => {
    expect(reactMarkers("none")).toBe("");
    expect(exportedMarkers("none")).not.toContain("<marker");
  });

  it("reverses only the heads that are not symmetric about their reference point", () => {
    const reversed = ARROWHEAD_MARKER_SPECS.filter((spec) => spec.reversibleOrient).map((spec) => spec.kind);

    // A bar and a dot sit on their own centre, so a half turn leaves them where they were; every
    // other head is anchored at its tip and has to be flipped to point away from the line.
    expect(reversed).toEqual([
      "arrow", "triangle", "openArrow", "thinArrow", "diamond",
      "arrowSmall", "triangleSmall", "openArrowSmall", "thinArrowSmall", "diamondSmall",
    ]);
    for (const spec of ARROWHEAD_MARKER_SPECS) {
      const markers = parseMarkers(reactMarkers(spec.kind));
      expect(markers.get(`${spec.idPrefix}-${SHAPE_ID}-start`)?.orient)
        .toBe(spec.reversibleOrient ? "auto-start-reverse" : "auto");
      expect(markers.get(`${spec.idPrefix}-${SHAPE_ID}-end`)?.orient).toBe("auto");
    }
  });

  it("measures every head in stroke widths so it follows the line", () => {
    for (const spec of ARROWHEAD_MARKER_SPECS) {
      const markers = parseMarkers(reactMarkers(spec.kind));
      for (const marker of markers.values()) {
        expect(marker.markerunits).toBe("strokeWidth");
      }
    }
  });
});

describe("arrow head coverage across the model, the menu and the shortcuts", () => {
  it("has a marker spec for every head a document may store", () => {
    expect([...ARROWHEAD_MARKER_SPECS.map((spec) => spec.kind)].sort())
      .toEqual([...DRAWN_HEADS].sort());
  });

  it("offers exactly the model's heads in the endpoint menu", () => {
    expect(LINE_ENDPOINT_OPTIONS.map((option) => option.value).sort())
      .toEqual([...OVERLAY_ARROWHEADS].sort());
    // 表示ラベルは chrome namespace が持つ (`format.lineEndpoint.<value>`)。
    // 「メニューに出る全ての head に文言がある」という不変条件はそのまま辞書側で確かめる。
    const t = createTranslator("ja", "chrome");
    expect(LINE_ENDPOINT_OPTIONS.every((option) => t(`format.lineEndpoint.${option.value}`).length > 0)).toBe(true);
  });

  it("registers a command for both endpoints of every head", () => {
    const registered = EDITOR_COMMAND_SHORTCUTS
      .map((command) => command.id)
      .filter((id) => id.startsWith("overlay.arrowhead."))
      .sort();

    expect(registered).toEqual(Object.keys(SHORTCUT_ARROWHEAD_VALUES).sort());
    expect(registered).toHaveLength(OVERLAY_ARROWHEADS.length * 2);
  });
});

/**
 * The head is only half of the drawing: the line has to stop short of it by exactly what the
 * marker's reference point moved back. Two renderers computing that independently is how "correct
 * on screen, wrong on paper" comes back, so they are compared on the drawn ink as well.
 */
describe("drawn path parity between the canvas and the SVG exporter", () => {
  function shapeAtOrigin(shape: OverlayShape): OverlayShape {
    // The canvas draws relative to the shape's box and the exporter in page coordinates. Moving
    // the shape until its box sits on the origin makes the two directly comparable — a line's box
    // carries padding, so this is not the same as placing the shape at 0,0.
    const bounds = getShapeBounds(shape);
    const shifted = { ...shape, x: shape.x - bounds.x, y: shape.y - bounds.y } as OverlayShape;
    const shiftedBounds = getShapeBounds(shifted);
    expect(`${shiftedBounds.x},${shiftedBounds.y}`).toBe("0,0");
    return shifted;
  }

  /** The drawn element, with the `<defs>` (which hold the heads' own paths) removed. */
  function drawnMarkup(svg: string): string {
    const withoutDefs = svg.replace(/<defs>[\s\S]*?<\/defs>/g, "");
    const match = withoutDefs.match(/<(?:line|polyline|path)\b[^>]*>/);
    expect(match).not.toBeNull();
    return match![0];
  }

  function geometryOf(markup: string): string {
    return (["d", "points", "x1", "y1", "x2", "y2"] as const)
      .map((name) => `${name}=${attributeOf(markup, name)}`)
      .join(" ");
  }

  function canvasGeometry(shape: OverlayShape): string {
    return geometryOf(drawnMarkup(renderToStaticMarkup(
      createElement(OverlayShapeReadOnlyView, { shape, assets: {} }),
    )));
  }

  function exportedGeometry(shape: OverlayShape): string {
    return geometryOf(drawnMarkup(getOverlayPreviewSvg({
      overlaySnapshot: { version: 1, shapes: [shape], assets: {} },
    }) ?? ""));
  }

  const CASES: ReadonlyArray<[string, OverlayShape]> = [
    ["a straight arrow", shapeAtOrigin({
      id: "shape_arrow", type: "arrow", x: 0, y: 0,
      props: {
        start: { x: 0, y: 0 }, end: { x: 120, y: 0 },
        arrowheadStart: "bar", arrowheadEnd: "diamond",
        fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "l",
      },
    } as OverlayShape)],
    ["a polyline", shapeAtOrigin({
      id: "shape_polyline", type: "line", x: 0, y: 0,
      props: {
        kind: "polyline", closed: false,
        points: [{ x: 0, y: 0 }, { x: 80, y: 40 }, { x: 160, y: 0 }],
        arrowheadStart: "triangle", arrowheadEnd: "arrow",
        fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m",
      },
    } as OverlayShape)],
    ["a curve", shapeAtOrigin({
      id: "shape_curve", type: "line", x: 0, y: 0,
      props: {
        kind: "curve", closed: false,
        points: [{ x: 0, y: 0 }, { x: 40, y: 30 }, { x: 92, y: 10 }],
        arrowheadStart: "none", arrowheadEnd: "thinArrow",
        fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "m",
      },
    } as OverlayShape)],
    ["an arc", shapeAtOrigin({
      id: "shape_arc", type: "arc", x: 0, y: 0,
      props: {
        r: 60, startAngle: 0, endAngle: Math.PI / 2, kind: "arc",
        arrowheadStart: "dot", arrowheadEnd: "triangle",
        fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "xl",
      },
    } as OverlayShape)],
    ["a sector, which draws no head at all", shapeAtOrigin({
      id: "shape_sector", type: "arc", x: 0, y: 0,
      props: {
        r: 60, startAngle: 0, endAngle: Math.PI / 2, kind: "sector",
        arrowheadStart: "triangle", arrowheadEnd: "triangle",
        fill: "none", color: "#111827", labelColor: "#111827", dash: "solid", size: "xl",
      },
    } as OverlayShape)],
  ];

  it.each(CASES)("draws %s the same way in both renderers", (_name, shape) => {
    expect(canvasGeometry(shape)).toBe(exportedGeometry(shape));
  });

  it("stops the ink short of the stored endpoint, and only the ink", () => {
    const arrowShape = CASES[0][1] as Extract<OverlayShape, { type: "arrow" }>;
    const drawn = drawnMarkup(renderToStaticMarkup(
      createElement(OverlayShapeReadOnlyView, { shape: arrowShape, assets: {} }),
    ));

    // `size: "l"` is a 3px stroke, so the ink ends the diamond's own trim × 3px before the stored
    // end point while the shape's own coordinates are untouched.
    expect(Number(attributeOf(drawn, "x2")))
      .toBeCloseTo(arrowShape.x + arrowShape.props.end.x - getArrowheadTrimInStrokes("diamond") * 3, 6);
    expect(arrowShape.props.end).toEqual({ x: 120, y: 0 });
  });

  it("keeps the sector's path exactly as it was before heads could trim a line", () => {
    const [, sector] = CASES[4];

    expect(attributeOf(drawnMarkup(renderToStaticMarkup(
      createElement(OverlayShapeReadOnlyView, { shape: sector, assets: {} }),
    // Character for character what it was before this feature existed, float artefact and all.
    )), "d")).toBe("M 60 60 L 120 60 A 60 60 0 0 1 60.00000000000001 120 Z");
  });
});

describe("the toolbar preview promises what the page draws", () => {
  it.each(LINE_ENDPOINT_OPTIONS.map((option) => option.value))(
    "ends the preview line behind the head for %s",
    (head) => {
      const markup = renderToStaticMarkup(createElement(LineEndpointPreview, {
        start: "none" as OverlayArrowhead,
        end: head,
        size: "menu" as const,
      }));
      const line = markup.match(/<line\b[^>]*>/)?.[0] ?? "";
      const trim = getArrowheadTrimInStrokes(head) * 1.5;

      // 55 is the preview's own end point, the place a real marker would put the head's tip.
      expect(Number(attributeOf(line, "x2"))).toBeCloseTo(55 - trim, 6);
      expect(Number(attributeOf(line, "x2"))).toBeLessThanOrEqual(55);
    },
  );
});
