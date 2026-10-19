import type { OverlayArrowhead, OverlayPoint, OverlayTextSize } from "@/features/document";
import { getArrowheadInkBounds, getArrowheadMarkerSpec, overlayStrokeWidth } from "@/features/rendering/core";

import { parseSvgSubpaths, svgNumbers } from "./svg-path";

/** One painted child of a `<marker>`, with the paint it inherits already merged into `attrs`. */
export interface SvgMarkerPrimitive { tag: string; attrs: Readonly<Record<string, string>> }
export interface SvgMarkerDefinition {
  viewBox: readonly [number, number, number, number];
  markerWidth: number;
  markerHeight: number;
  refX: number;
  refY: number;
  orient: string;
  /** `markerUnits="userSpaceOnUse"`; otherwise one marker unit is one stroke width. */
  userSpace: boolean;
  primitives: readonly SvgMarkerPrimitive[];
}
export type SvgMarkerLookup = (id: string) => SvgMarkerDefinition | undefined;

export interface SvgMarkerHead {
  /** The head's normal-size name; `svgMarkerArrowhead` decides whether it is drawn small. */
  head: Exclude<OverlayArrowhead, "none" | `${string}Small`>;
  /** viewBox x the head points with (the centre of a dot). */
  tip: number;
  /** viewBox units the ink spans along the marker's x axis. */
  length: number;
  /** Which way along the marker's x axis the head points; 0 for a dot, which reads the same from both sides. */
  direction: 1 | -1 | 0;
}

/** Where a normal head stops being the nearer match than the small one (the small one is 0.55 of it). */
const SMALL_HEAD_THRESHOLD = 0.775;
/** A numeric `orient` has to lie along the line within this cosine (1 degree) for a head to follow it. */
const ALONG_THE_LINE = Math.cos(Math.PI / 180);
const OPEN_HEADS = ["thinArrow", "arrow", "openArrow"] as const;

function sameColor(a: string | undefined, b: string): boolean {
  return a !== undefined && (a === "context-stroke" || a.trim().toLowerCase() === b.trim().toLowerCase());
}

/** Half the opening angle of an open head, read from the table the editor draws it from. */
function openHeadHalfAngle(head: typeof OPEN_HEADS[number]): number {
  const geometry = getArrowheadMarkerSpec(head)?.geometry;
  if (geometry?.kind !== "polyline") throw new Error("Open heads are polylines");
  const [arm, apex, other] = geometry.points;
  return Math.atan2(Math.abs(arm.y - other.y) / 2, apex.x - arm.x);
}

function inkLengthInStrokes(head: Exclude<OverlayArrowhead, "none">): number {
  const bounds = getArrowheadInkBounds(getArrowheadMarkerSpec(head)!.geometry);
  return bounds.maxX - bounds.minX;
}

/**
 * An isosceles outline whose apex points along +x or -x: the only shape an arrow head is drawn in.
 * A head drawn pointing -x is how a start marker reads outward under `orient="auto"`.
 */
function pointingOutline(points: readonly OverlayPoint[], marker: SvgMarkerDefinition) {
  const [, , width, height] = marker.viewBox;
  const tolerance = 1e-3 * Math.max(width, height);
  for (const direction of [1, -1] as const) {
    const apex = points.reduce((best, p) => (p.x - best.x) * direction > 0 ? p : best);
    const base = points.filter((p) => p !== apex);
    const length = base.length === 2 ? (apex.x - base[0].x) * direction : 0;
    if (base.length === 2 && Math.abs(base[0].x - base[1].x) <= tolerance && length > tolerance &&
      Math.abs(apex.y - (base[0].y + base[1].y) / 2) <= 0.02 * height) {
      return { apexX: apex.x, length, halfHeight: Math.abs(base[0].y - base[1].y) / 2, direction };
    }
  }
  return null;
}

/**
 * Which way along the marker's x axis points out of the line at this endpoint, or null when it lies across the line.
 * `outward` is the line's direction out of the endpoint, in the line's own user space, which a numeric `orient` is measured in.
 */
function outwardAlongMarkerX(orient: string, endpoint: "start" | "end", outward: OverlayPoint): 1 | -1 | null {
  if (orient === "auto-start-reverse") return 1;
  // `auto` follows the path, so at a start endpoint the marker's +x points into the line.
  if (orient === "auto") return endpoint === "end" ? 1 : -1;
  const angle = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)(?:deg)?$/.exec(orient);
  const span = Math.hypot(outward.x, outward.y);
  if (!angle || !(span > 0)) return null;
  const radians = Number(angle[1]) * Math.PI / 180;
  const along = (Math.cos(radians) * outward.x + Math.sin(radians) * outward.y) / span;
  return along >= ALONG_THE_LINE ? 1 : along <= -ALONG_THE_LINE ? -1 : null;
}

/** Recognise the few marker drawings that the editor's own arrow heads reproduce. Anything else stays SVG. */
export function classifySvgMarker(marker: SvgMarkerDefinition, color: string): SvgMarkerHead | null {
  if (marker.primitives.length !== 1) return null;
  const { tag, attrs } = marker.primitives[0];
  if (attrs.transform || attrs.opacity || attrs["fill-opacity"] || attrs["stroke-opacity"] || attrs["clip-path"] || attrs.mask) return null;
  const fill = attrs.fill === "currentColor" ? attrs.color : attrs.fill ?? "black";
  const stroke = attrs.stroke === "currentColor" ? attrs.color : attrs.stroke ?? "none";
  const filled = fill !== undefined && fill !== "none" && sameColor(fill, color) && stroke === "none";
  const open = fill === "none" && stroke !== undefined && stroke !== "none" && sameColor(stroke, color);
  const [left, top, width, height] = marker.viewBox;
  const inside = (points: readonly OverlayPoint[]) => points.every((p) =>
    p.x >= left - 1e-6 && p.x <= left + width + 1e-6 && p.y >= top - 1e-6 && p.y <= top + height + 1e-6);
  try {
    if (tag === "circle") {
      const cx = svgNumbers(attrs.cx ?? "0")[0], cy = svgNumbers(attrs.cy ?? "0")[0], r = svgNumbers(attrs.r ?? "0")[0];
      if (!filled || !(r > 0) || !inside([{ x: cx - r, y: cy - r }, { x: cx + r, y: cy + r }])) return null;
      return { head: "dot", tip: cx, length: 2 * r, direction: 0 };
    }
    let points: OverlayPoint[], closed: boolean;
    if (tag === "polygon" || tag === "polyline") {
      const n = svgNumbers(attrs.points ?? "");
      if (n.length % 2) return null;
      points = Array.from({ length: n.length / 2 }, (_, i) => ({ x: n[2 * i], y: n[2 * i + 1] }));
      closed = tag === "polygon";
    } else if (tag === "path") {
      const paths = parseSvgSubpaths(attrs.d ?? "");
      if (paths?.length !== 1 || paths[0].curve) return null;
      ({ points, closed } = paths[0]);
    } else return null;
    if (points.length !== 3 || !inside(points)) return null;
    const outline = pointingOutline(points, marker);
    if (!outline) return null;
    if (closed && filled) return { head: "triangle", tip: outline.apexX, length: outline.length, direction: outline.direction };
    if (!closed && open) {
      const angle = Math.atan2(outline.halfHeight, outline.length);
      const head = OPEN_HEADS.reduce((best, candidate) =>
        Math.abs(openHeadHalfAngle(candidate) - angle) < Math.abs(openHeadHalfAngle(best) - angle) ? candidate : best);
      return { head, tip: outline.apexX, length: outline.length, direction: outline.direction };
    }
    return null;
  } catch { return null; }
}

/**
 * The editor head that stands for a marker at one end of a line, and how far past the line's last vertex its tip sits.
 * The editor's heads always point out of the line, so a marker drawn pointing into it stays SVG.
 * `pxPerUserUnit` converts the line's user space to the page; `strokeWidth` is the line's, in user units;
 * `outward` is the line's direction out of this endpoint, in the same user space.
 */
export function svgMarkerArrowhead(
  marker: SvgMarkerDefinition,
  endpoint: "start" | "end",
  line: { color: string; strokeWidth: number; pxPerUserUnit: number; size: OverlayTextSize; outward: OverlayPoint },
): { head: OverlayArrowhead; overshoot: number } | null {
  const found = classifySvgMarker(marker, line.color);
  if (!found) return null;
  const outwardX = outwardAlongMarkerX(marker.orient.trim(), endpoint, line.outward);
  if (outwardX === null || (found.direction !== 0 && found.direction !== outwardX)) return null;
  const [, , width, height] = marker.viewBox;
  const scale = Math.min(marker.markerWidth / width, marker.markerHeight / height);
  const pxPerUnit = scale * (marker.userSpace ? 1 : line.strokeWidth) * line.pxPerUserUnit;
  const normalLength = inkLengthInStrokes(found.head) * overlayStrokeWidth(line.size);
  const head = found.length * pxPerUnit < normalLength * SMALL_HEAD_THRESHOLD ? `${found.head}Small` as OverlayArrowhead : found.head;
  return { head, overshoot: (found.tip - marker.refX) * outwardX * pxPerUnit };
}
