// Type only: the rendering core must not pull the document layer in at runtime
// (`features/document/architecture.test.ts` pins that edge).
import type { OverlayArrowhead } from "@/features/document";

import {
  findArrowheadLineStopX,
  getArrowheadInkBounds,
  ARROWHEAD_LINE_WIDTH,
  translateArrowheadGeometry,
  type ArrowheadGeometry,
  type ArrowheadPoint,
  type ArrowheadPolylineGeometry,
} from "./arrowhead-ink";

/**
 * The one description of what an arrow head looks like.
 *
 * Three renderers draw these: the editor canvas (which is also the print/PDF path), the SVG string
 * exporter (embedded viewer, thumbnails, template gallery) and the toolbar preview. They used to
 * carry three independent copies of the geometry, so every new head risked "selectable in the menu
 * but a different shape on paper". They all read this table now.
 *
 * Coordinates are in marker units. Every marker is declared `markerUnits="strokeWidth"`, so one
 * unit equals one pixel of the line's stroke width and a head grows with the line for free — and
 * the line the head terminates is exactly one unit wide, whatever size it is drawn at.
 */

export type ArrowheadKind = Exclude<OverlayArrowhead, "none">;

export interface ArrowheadMarkerSpec {
  readonly kind: ArrowheadKind;
  /**
   * The marker element id prefix.
   *
   * `arrow` has been persisted as the id `arrowhead` since the first release; the alias lives here
   * and nowhere else so the two renderers cannot disagree about it.
   */
  readonly idPrefix: string;
  readonly markerWidth: number;
  readonly markerHeight: number;
  /**
   * The marker-space x that has to land on the endpoint the document stores.
   *
   * For a head that points, this is its front-most ink — the miter of an open head, which sits well
   * ahead of the vertex listed in `points`. For a head that only marks the endpoint (a dot, a bar)
   * it is the centre, because a half turn has to leave the mark where it was.
   *
   * This is not the `<marker refX>`: the reference point moves back by whatever the line gave up at
   * this end, and only `planArrowheadEndpoints` knows that. See `ArrowheadPlacement`.
   */
  readonly tipX: number;
  /**
   * The marker-space x where the line's own stroke has to stop.
   *
   * Near a point the head is thinner than the line, and `stroke-linecap: butt` ends the line in a
   * square edge, so a line drawn all the way to the tip replaces the point with a rectangular stub
   * — the reported bug. Derived, never written down: it is the rear-most place the head's ink is
   * already at least as wide as the line, which is the one description that survives a head being
   * drawn small (see `arrowhead-ink.ts`).
   */
  readonly lineStopX: number;
  readonly refY: number;
  /**
   * Whether the start endpoint needs `orient="auto-start-reverse"`.
   *
   * True exactly when the head is not symmetric under a half turn about its reference point: an
   * arrow anchored at its tip has to be flipped to point away from the line, while a bar or a dot
   * anchored at its centre looks identical either way.
   */
  readonly reversibleOrient: boolean;
  /**
   * How big this head is meant to look next to a normal head of the same shape.
   *
   * A small head is the same outline with every number scaled, so a renderer working in marker
   * units gets the difference for free. A renderer that normalises a head to a fixed on-screen
   * size instead — the 3D coordinate axis, which sizes its end off the axis length — would draw
   * every size identically, and multiplies by this to get the size back.
   */
  readonly sizeRatio: number;
  readonly geometry: ArrowheadGeometry;
}

const OPEN_HEAD_STROKE = 1.2;

/**
 * How much smaller the small half of the picker draws.
 *
 * One shape, two sizes: a textbook axis or a leader line wants a head that marks the direction
 * without becoming the loudest thing in the figure, and the only way to get that with
 * `markerUnits="strokeWidth"` was to thin the line itself.
 */
const SMALL_HEAD_SCALE = 0.55;

/**
 * No head is drawn with a pen thinner than the line it ends.
 *
 * An open head is two strokes; scaling one down scales its pen down with it, and a pen narrower
 * than the line cannot cover the line's square end at any distance — the arms end up as two thin
 * whiskers on either side of a blunt stub, which is what a small head on a thick line looked like.
 * Marker units are stroke widths, so "as wide as the line" is the constant 1 at every size.
 */
const MIN_HEAD_STROKE = ARROWHEAD_LINE_WIDTH;

/** The clearance a box that had to grow keeps beyond the ink that made it grow. */
const MARKER_BOX_MARGIN = 0.05;

/** Every head name that is not a small variant of another. */
export type ArrowheadShapeKind = Exclude<ArrowheadKind, `${string}Small`>;

/**
 * How a head is authored: an outline, the box it is drawn in, and what its anchor means.
 *
 * Everything else about a head — where its point lands, where the line has to stop, how much of the
 * line it costs — is measured off the ink this produces rather than written down beside it, so a
 * head drawn at another size cannot keep a number that only held at its first one.
 */
interface ArrowheadOutlineSpec {
  readonly idPrefix: string;
  readonly markerWidth: number;
  readonly markerHeight: number;
  readonly refY: number;
  /**
   * `point` heads are anchored on their front-most ink and flip at a start endpoint; `centre` heads
   * mark the endpoint from both sides and are anchored on the middle of their own ink.
   */
  readonly anchor: "point" | "centre";
  readonly geometry: ArrowheadGeometry;
}

/**
 * One outline per shape, at its normal size.
 *
 * Keyed by shape so the compiler demands an entry for every non-small value in
 * `OVERLAY_ARROWHEADS`. A new head added to the document model breaks this table before it can
 * reach a renderer that silently draws nothing.
 */
const ARROWHEAD_SHAPE_SPEC_TABLE: Record<ArrowheadShapeKind, ArrowheadOutlineSpec> = {
  arrow: {
    idPrefix: "arrowhead",
    // Wide enough for the miter: the vertex is at 7 but the ink runs past it, and `<marker>` clips
    // whatever passes its own box.
    markerWidth: 9,
    markerHeight: 8,
    refY: 4,
    anchor: "point",
    geometry: {
      kind: "polyline",
      points: [{ x: 1.5, y: 1.5 }, { x: 7, y: 4 }, { x: 1.5, y: 6.5 }],
      closed: false,
      filled: false,
      strokeWidth: OPEN_HEAD_STROKE,
    },
  },
  triangle: {
    idPrefix: "triangle",
    markerWidth: 8,
    markerHeight: 8,
    refY: 4,
    anchor: "point",
    geometry: {
      kind: "polyline",
      points: [{ x: 1, y: 1 }, { x: 7, y: 4 }, { x: 1, y: 7 }],
      closed: true,
      filled: true,
      strokeWidth: 0,
    },
  },
  openArrow: {
    idPrefix: "openArrow",
    markerWidth: 9,
    markerHeight: 10,
    refY: 5,
    anchor: "point",
    geometry: {
      kind: "polyline",
      points: [{ x: 0.8, y: 0.8 }, { x: 7, y: 5 }, { x: 0.8, y: 9.2 }],
      closed: false,
      filled: false,
      strokeWidth: OPEN_HEAD_STROKE,
    },
  },
  thinArrow: {
    idPrefix: "thinArrow",
    // Two units wider than the vertex: a 15° point overshoots it by most of two units at the miter.
    markerWidth: 11,
    markerHeight: 8,
    refY: 4,
    anchor: "point",
    geometry: {
      kind: "polyline",
      points: [{ x: 1, y: 1.8 }, { x: 9, y: 4 }, { x: 1, y: 6.2 }],
      closed: false,
      filled: false,
      strokeWidth: MIN_HEAD_STROKE,
    },
  },
  diamond: {
    idPrefix: "diamond",
    markerWidth: 10,
    markerHeight: 8,
    refY: 4,
    anchor: "point",
    geometry: {
      kind: "polyline",
      points: [{ x: 1, y: 4 }, { x: 5, y: 1 }, { x: 9, y: 4 }, { x: 5, y: 7 }],
      closed: true,
      filled: true,
      strokeWidth: 0,
    },
  },
  dot: {
    idPrefix: "dot",
    markerWidth: 8,
    markerHeight: 8,
    refY: 4,
    // A dot marks the endpoint rather than pointing at it: its centre belongs on the endpoint, and
    // from there the circle already covers the line's end.
    anchor: "centre",
    geometry: { kind: "circle", cx: 4, cy: 4, r: 3, filled: true },
  },
  bar: {
    idPrefix: "bar",
    markerWidth: 8,
    markerHeight: 12,
    refY: 6,
    anchor: "centre",
    geometry: {
      kind: "polyline",
      points: [{ x: 4, y: 0 }, { x: 4, y: 12 }],
      closed: false,
      filled: false,
      strokeWidth: 2,
    },
  },
};

/**
 * One head, at one size, with every derived number measured off the ink it will actually draw.
 *
 * Scaling a head scales its outline, its box and its anchor together, but **not** its pen below the
 * width of the line it ends: a small head keeps its shape and gives up only its size, because a
 * head that ends up thinner than the line can never hide the line's square end. Everything the
 * renderers read then follows from the result — the box grows if the floored pen no longer fits in
 * it, the point sits on the head's front-most ink, and the line stops where that ink first covers
 * it.
 */
function buildSpec(outline: ArrowheadOutlineSpec, scale: number): Omit<ArrowheadMarkerSpec, "kind"> {
  const scaled = roundGeometry(scaleGeometry(outline.geometry, scale));
  const scaledBounds = getArrowheadInkBounds(scaled);

  // A `<marker>` clips at its own box, so ink the floored pen pushed out behind the origin moves the
  // whole head forward rather than being silently cut off.
  const shiftX = shiftIntoBox(scaledBounds.minX);
  const shiftY = shiftIntoBox(scaledBounds.minY);
  const geometry = roundGeometry(translateArrowheadGeometry(scaled, shiftX, shiftY));
  const ink = getArrowheadInkBounds(geometry);
  const refY = rounded(outline.refY * scale + shiftY);

  const tipX = outline.anchor === "point" ? ink.maxX : (ink.minX + ink.maxX) / 2;
  const lineStopX = outline.anchor === "point"
    ? findArrowheadLineStopX(geometry, refY, frontOutlineX(geometry))
    : tipX;

  return {
    // Its own marker id: a shape may carry the normal head at one end and the small one at the
    // other, and an id that named only the shape would describe two different outlines.
    idPrefix: scale === 1 ? outline.idPrefix : `${outline.idPrefix}Small`,
    markerWidth: roundedBox(fitBox(outline.markerWidth * scale, ink.maxX)),
    markerHeight: roundedBox(fitBox(outline.markerHeight * scale, ink.maxY)),
    tipX: rounded(tipX),
    lineStopX: rounded(lineStopX),
    refY,
    reversibleOrient: outline.anchor === "point",
    sizeRatio: scale,
    geometry,
  };
}

/**
 * Marker units, to a thousandth.
 *
 * These numbers are written straight into `markerWidth`/`refX` and into the exported SVG, and a
 * measured one carries the tail of the search that produced it. A thousandth of a stroke width is
 * five thousandths of a pixel on the thickest line the editor draws, and it keeps the markup — and
 * the tests that read it — legible.
 */
function rounded(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * The same precision for a marker box, but never rounded down onto the ink it has to contain.
 *
 * The epsilon absorbs the tail of `12 × 0.55`, which is a hair over 6.6 and would otherwise buy a
 * whole extra thousandth of box for nothing.
 */
function roundedBox(value: number): number {
  return Math.ceil(value * 1000 - 1e-6) / 1000;
}

/** The outline as the renderers will write it out, so every number below describes that drawing. */
function roundGeometry(geometry: ArrowheadGeometry): ArrowheadGeometry {
  if (geometry.kind === "circle") {
    return {
      ...geometry,
      cx: rounded(geometry.cx),
      cy: rounded(geometry.cy),
      r: rounded(geometry.r),
    };
  }
  return {
    ...geometry,
    points: geometry.points.map((point) => ({ x: rounded(point.x), y: rounded(point.y) })),
    strokeWidth: rounded(geometry.strokeWidth),
  };
}

/** How far the head has to move to bring ink that fell behind the box origin back inside it. */
function shiftIntoBox(inkMin: number): number {
  return inkMin < 0 ? -inkMin + MARKER_BOX_MARGIN : 0;
}

/**
 * The marker box, grown if the head no longer fits in the one it was authored with.
 *
 * The boxes below are hand-fitted to their outlines, so a head that still fits keeps exactly the
 * box it has always had — and with it the selection box the editor draws around a line carrying it.
 * A head whose floored pen now reaches past its box gets a bigger one instead of being cut off:
 * `<marker>` clips at its own box, silently.
 */
function fitBox(authored: number, ink: number): number {
  return ink > authored ? ink + MARKER_BOX_MARGIN : authored;
}

/**
 * The head's own front-most vertex, which is as far forward as the line may ever stop.
 *
 * Past it a pointing head is only its miter — the ink narrowing to the point — so a line allowed in
 * there would be wider than the point it is supposed to end at.
 */
function frontOutlineX(geometry: ArrowheadGeometry): number {
  return geometry.kind === "circle" ? geometry.cx : Math.max(...geometry.points.map((point) => point.x));
}

function scaleGeometry(geometry: ArrowheadGeometry, scale: number): ArrowheadGeometry {
  if (geometry.kind === "circle") {
    return { ...geometry, cx: geometry.cx * scale, cy: geometry.cy * scale, r: geometry.r * scale };
  }
  return {
    ...geometry,
    points: geometry.points.map((point) => ({ x: point.x * scale, y: point.y * scale })),
    strokeWidth: geometry.filled
      ? geometry.strokeWidth * scale
      : Math.max(geometry.strokeWidth * scale, MIN_HEAD_STROKE),
  };
}

/**
 * Every head the document may store, in menu order: the shapes first, then the same shapes small.
 *
 * Keyed by head so the compiler demands an entry for every value in `OVERLAY_ARROWHEADS`.
 */
const ARROWHEAD_MARKER_SPEC_TABLE: Record<ArrowheadKind, Omit<ArrowheadMarkerSpec, "kind">> = {
  arrow: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.arrow, 1),
  triangle: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.triangle, 1),
  openArrow: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.openArrow, 1),
  thinArrow: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.thinArrow, 1),
  diamond: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.diamond, 1),
  dot: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.dot, 1),
  bar: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.bar, 1),
  arrowSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.arrow, SMALL_HEAD_SCALE),
  triangleSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.triangle, SMALL_HEAD_SCALE),
  openArrowSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.openArrow, SMALL_HEAD_SCALE),
  thinArrowSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.thinArrow, SMALL_HEAD_SCALE),
  diamondSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.diamond, SMALL_HEAD_SCALE),
  dotSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.dot, SMALL_HEAD_SCALE),
  barSmall: buildSpec(ARROWHEAD_SHAPE_SPEC_TABLE.bar, SMALL_HEAD_SCALE),
};

/** The specs in menu order. */
export const ARROWHEAD_MARKER_SPECS: readonly ArrowheadMarkerSpec[] = (
  Object.keys(ARROWHEAD_MARKER_SPEC_TABLE) as ArrowheadKind[]
).map((kind) => ({ kind, ...ARROWHEAD_MARKER_SPEC_TABLE[kind] }));

/**
 * Lookup by head name.
 *
 * A `Map`, not an object literal: the key comes from document data, and a plain literal answers
 * `__proto__` with an inherited value that `?? fallback` never replaces.
 */
const SPECS_BY_KIND = new Map<string, ArrowheadMarkerSpec>(
  ARROWHEAD_MARKER_SPECS.map((spec) => [spec.kind, spec]),
);

export function getArrowheadMarkerSpec(head: OverlayArrowhead | string | undefined): ArrowheadMarkerSpec | null {
  if (typeof head !== "string") {
    return null;
  }
  return SPECS_BY_KIND.get(head) ?? null;
}

/**
 * The marker element id for one endpoint, or `null` when nothing should be drawn.
 *
 * Both renderers build their `<marker id>` and their `url(#…)` reference through this, so the
 * `arrow` → `arrowhead` alias can never apply on one side only.
 */
export function arrowheadMarkerId(
  head: OverlayArrowhead | string | undefined,
  shapeId: string,
  endpoint: "start" | "end",
): string | null {
  const spec = getArrowheadMarkerSpec(head);
  if (!spec) {
    return null;
  }
  return `${spec.idPrefix}-${shapeId}-${endpoint}`;
}

/**
 * How far the head is set back from the endpoint, in stroke widths.
 *
 * Marker units are stroke widths, so this is a ratio and not a pixel count: a `diamond` on an `xl`
 * line gives up 37.5px and on an `s` line 9.4px. A constant number of pixels would make a thick
 * short arrow disappear and a thin one still show its stub.
 */
export function getArrowheadTrimInStrokes(head: OverlayArrowhead | string | undefined): number {
  const spec = getArrowheadMarkerSpec(head);
  if (!spec) {
    return 0;
  }
  return Math.max(0, spec.tipX - spec.lineStopX);
}

/**
 * One endpoint's share of the drawing: how much the line gives up, and where the marker anchors.
 *
 * The two are only correct together — `refX + trimPx / strokeWidth === spec.tipX` is what puts the
 * head's point on the endpoint the document stores, and every clamp below preserves it.
 */
export interface ArrowheadPlacement {
  readonly spec: ArrowheadMarkerSpec | null;
  /** How much shorter the drawn path is at this end, in px. */
  readonly trimPx: number;
  /** The `<marker refX>` for this end. Meaningless when `spec` is null. */
  readonly refX: number;
}

export interface ArrowheadEndpointPlan {
  readonly start: ArrowheadPlacement;
  readonly end: ArrowheadPlacement;
}

/** An endpoint that draws nothing: no head chosen, or a shape that suppresses heads. */
export const NO_ARROWHEAD_PLACEMENT: ArrowheadPlacement = { spec: null, trimPx: 0, refX: 0 };

/**
 * Never take more than this share of the segment the head sits on.
 *
 * `orient="auto"` points a head along the last segment of the path. Trimming that segment away
 * entirely hands the head the direction of the segment before it, and the arrow swings to a
 * different angle while the author drags a vertex — a symptom with no obvious cause.
 */
const MAX_TERMINAL_SEGMENT_TRIM_RATIO = 0.9;

/** …and never more than this share of the whole path, so a short line keeps some line. */
const MAX_TOTAL_TRIM_RATIO = 0.8;

/**
 * Where to stop the line and where to anchor each head.
 *
 * Both clamps degrade towards "draw it the way it was drawn before": when the trim is clamped to
 * zero, `refX` becomes `tipX` and the result is exactly a head anchored at its own point, which is
 * what every renderer did before this existed.
 */
export function planArrowheadEndpoints(
  start: OverlayArrowhead | string | undefined,
  end: OverlayArrowhead | string | undefined,
  strokeWidth: number,
  pathLengthPx: number,
  terminalSegmentLengthPx: { readonly start: number; readonly end: number },
  /**
   * An extra ceiling the caller may impose, in px.
   *
   * A `<marker>` is a rigid straight stamp: `orient="auto"` aims it along the tangent at the point
   * the path ends, and it reaches forward from there in a straight line. On a curve that straight
   * reach leaves the curve, so a caller that draws one caps the trim at the point where the drift
   * stops being visible. Straight paths pass nothing.
   */
  maxTrimPx?: { readonly start: number; readonly end: number },
): ArrowheadEndpointPlan {
  const startSpec = getArrowheadMarkerSpec(start);
  const endSpec = getArrowheadMarkerSpec(end);
  const stroke = Number.isFinite(strokeWidth) && strokeWidth > 0 ? strokeWidth : 0;

  // Planned in marker units rather than pixels, because `refX` is a marker-unit number: taking the
  // trim to pixels and dividing it back out again lands `refX` a float tail away from the marker
  // coordinate it is supposed to name, and that tail is written into every page and every export.
  let startTrim = clampToSegment(
    clampToCeiling(idealTrim(startSpec, stroke), inStrokes(maxTrimPx?.start, stroke)),
    inStrokes(terminalSegmentLengthPx.start, stroke),
  );
  let endTrim = clampToSegment(
    clampToCeiling(idealTrim(endSpec, stroke), inStrokes(maxTrimPx?.end, stroke)),
    inStrokes(terminalSegmentLengthPx.end, stroke),
  );

  const budget = Number.isFinite(pathLengthPx) && pathLengthPx > 0 && stroke > 0
    ? (pathLengthPx * MAX_TOTAL_TRIM_RATIO) / stroke
    : 0;
  const total = startTrim + endTrim;
  if (total > budget) {
    const scale = total > 0 ? budget / total : 0;
    startTrim *= scale;
    endTrim *= scale;
  }

  return {
    start: toPlacement(startSpec, startTrim, stroke),
    end: toPlacement(endSpec, endTrim, stroke),
  };
}

/** A length in pixels as a count of stroke widths, which is what a marker measures in. */
function inStrokes(lengthPx: number | undefined, strokeWidth: number): number | undefined {
  if (lengthPx === undefined) {
    return undefined;
  }
  return strokeWidth > 0 ? lengthPx / strokeWidth : 0;
}

function idealTrim(spec: ArrowheadMarkerSpec | null, strokeWidth: number): number {
  if (!spec || strokeWidth <= 0) {
    return 0;
  }
  return Math.max(0, spec.tipX - spec.lineStopX);
}

function clampToCeiling(trim: number, ceiling: number | undefined): number {
  if (ceiling === undefined) {
    return trim;
  }
  return Number.isFinite(ceiling) && ceiling > 0 ? Math.min(trim, ceiling) : 0;
}

function clampToSegment(trim: number, segmentLength: number | undefined): number {
  if (segmentLength === undefined || !Number.isFinite(segmentLength) || segmentLength <= 0) {
    return 0;
  }
  return Math.min(trim, segmentLength * MAX_TERMINAL_SEGMENT_TRIM_RATIO);
}

function toPlacement(
  spec: ArrowheadMarkerSpec | null,
  trim: number,
  strokeWidth: number,
): ArrowheadPlacement {
  if (!spec) {
    return NO_ARROWHEAD_PLACEMENT;
  }
  const trimInStrokes = Number.isFinite(trim) && trim > 0 && strokeWidth > 0 ? trim : 0;
  // The pair the whole feature rests on: the line gives up `trimPx`, and the marker's reference
  // point moves back by the same length, so the head's point lands on the stored endpoint.
  return { spec, trimPx: trimInStrokes * strokeWidth, refX: spec.tipX - trimInStrokes };
}

export interface ArrowheadMarkerRequest {
  readonly spec: ArrowheadMarkerSpec;
  readonly endpoint: "start" | "end";
  readonly id: string;
  /** The reference point this endpoint's plan asked for, never `spec.tipX` directly. */
  readonly refX: number;
}

/**
 * The markers one shape has to declare, in a fixed order.
 *
 * Both renderers build their `<defs>` from this list, so the set of declared markers, the set of
 * referenced ids and the reference points can never diverge. Only the heads the shape actually
 * uses are declared; the endpoints a shape suppresses (a closed polyline, a sector) carry
 * `NO_ARROWHEAD_PLACEMENT` and declare nothing.
 */
export function getArrowheadMarkerRequests(
  shapeId: string,
  plan: ArrowheadEndpointPlan,
): readonly ArrowheadMarkerRequest[] {
  const requests: ArrowheadMarkerRequest[] = [];
  for (const [endpoint, placement] of [["start", plan.start], ["end", plan.end]] as const) {
    const spec = placement.spec;
    const id = spec ? arrowheadMarkerId(spec.kind, shapeId, endpoint) : null;
    if (spec && id) {
      requests.push({ spec, endpoint, id, refX: placement.refX });
    }
  }
  return requests;
}

/** `orient` for one endpoint. Symmetric heads never reverse. */
export function arrowheadOrient(spec: ArrowheadMarkerSpec, endpoint: "start" | "end"): string {
  return endpoint === "start" && spec.reversibleOrient ? "auto-start-reverse" : "auto";
}

/** The `d` attribute for a polyline head. */
export function arrowheadPathData(geometry: ArrowheadPolylineGeometry): string {
  const [first, ...rest] = geometry.points;
  const segments = [`M ${formatCoordinate(first.x)} ${formatCoordinate(first.y)}`];
  for (const point of rest) {
    segments.push(`L ${formatCoordinate(point.x)} ${formatCoordinate(point.y)}`);
  }
  if (geometry.closed) {
    segments.push("Z");
  }
  return segments.join(" ");
}

/**
 * How far the head reaches from the endpoint, in stroke widths.
 *
 * Used to size selection boxes: the head is the outermost ink on a line, and because markers are
 * measured in stroke widths a flat padding is wrong at every size but one.
 */
export function getArrowheadExtentInStrokes(head: OverlayArrowhead | string | undefined): number {
  const spec = getArrowheadMarkerSpec(head);
  if (!spec) {
    return 0;
  }
  return specExtentInStrokes(spec);
}

/** The reach of the largest head, for callers that must stay safe on an unrecognised value. */
export const WIDEST_ARROWHEAD_EXTENT_IN_STROKES = Math.max(
  ...ARROWHEAD_MARKER_SPECS.map(specExtentInStrokes),
);

function specExtentInStrokes(spec: ArrowheadMarkerSpec): number {
  return Math.max(spec.markerWidth, spec.markerHeight);
}

/**
 * The same geometry scaled around its anchor point, for previews that cannot use a real marker.
 *
 * The anchor is `tipX`, the same point a real marker puts on the endpoint, so a preview drawn at
 * the end of its line shows the head exactly where the page will put it. `flip` mirrors the head
 * the way `orient="auto-start-reverse"` does, so a start endpoint in the toolbar points the same
 * way it will on the page.
 */
export function scaleArrowheadGeometry(
  spec: ArrowheadMarkerSpec,
  scale: number,
  flip: boolean,
): ArrowheadGeometry {
  const direction = flip ? -1 : 1;
  const project = (point: ArrowheadPoint): ArrowheadPoint => ({
    x: (point.x - spec.tipX) * scale * direction,
    y: (point.y - spec.refY) * scale * direction,
  });
  if (spec.geometry.kind === "circle") {
    const centre = project({ x: spec.geometry.cx, y: spec.geometry.cy });
    return { ...spec.geometry, cx: centre.x, cy: centre.y, r: spec.geometry.r * scale };
  }
  return { ...spec.geometry, points: spec.geometry.points.map(project) };
}

function formatCoordinate(value: number): string {
  return String(Number(value.toFixed(4)));
}
