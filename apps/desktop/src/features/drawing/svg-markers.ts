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
  /** Reads the same from both sides, so it needs no `auto-start-reverse` at a start endpoint. */
  symmetric: boolean;
}

/** Where a normal head stops being the nearer match than the small one (the small one is 0.55 of it). */
const SMALL_HEAD_THRESHOLD = 0.775;
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

/** An isosceles outline whose apex points along +x: the only shape an arrow head is drawn in. */
function pointingOutline(points: readonly OverlayPoint[], marker: SvgMarkerDefinition) {
  const [, , width, height] = marker.viewBox;
  const apex = points.reduce((best, p) => p.x > best.x ? p : best);
  const base = points.filter((p) => p !== apex);
  const tolerance = 1e-3 * Math.max(width, height);
  if (base.length !== 2 || Math.abs(base[0].x - base[1].x) > tolerance || apex.x - base[0].x <= tolerance ||
    Math.abs(apex.y - (base[0].y + base[1].y) / 2) > 0.02 * height) return null;
  return { apexX: apex.x, length: apex.x - base[0].x, halfHeight: Math.abs(base[0].y - base[1].y) / 2 };
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
      return { head: "dot", tip: cx, length: 2 * r, symmetric: true };
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
    if (closed && filled) return { head: "triangle", tip: outline.apexX, length: outline.length, symmetric: false };
    if (!closed && open) {
      const angle = Math.atan2(outline.halfHeight, outline.length);
      const head = OPEN_HEADS.reduce((best, candidate) =>
        Math.abs(openHeadHalfAngle(candidate) - angle) < Math.abs(openHeadHalfAngle(best) - angle) ? candidate : best);
      return { head, tip: outline.apexX, length: outline.length, symmetric: false };
    }
    return null;
  } catch { return null; }
}

/**
 * The editor head that stands for a marker at one end of a line, and how far past the line's last vertex its tip sits.
 * `pxPerUserUnit` converts the line's user space to the page; `strokeWidth` is the line's, in user units.
 */
export function svgMarkerArrowhead(
  marker: SvgMarkerDefinition,
  endpoint: "start" | "end",
  line: { color: string; strokeWidth: number; pxPerUserUnit: number; size: OverlayTextSize },
): { head: OverlayArrowhead; overshoot: number } | null {
  const found = classifySvgMarker(marker, line.color);
  if (!found) return null;
  // `auto` follows the path, so at a start endpoint it points into the line: only a symmetric head reads the same.
  const orientation = marker.orient.trim();
  if (!(orientation === "auto-start-reverse" || (orientation === "auto" && (endpoint === "end" || found.symmetric)))) return null;
  const [, , width, height] = marker.viewBox;
  const scale = Math.min(marker.markerWidth / width, marker.markerHeight / height);
  const pxPerUnit = scale * (marker.userSpace ? 1 : line.strokeWidth) * line.pxPerUserUnit;
  const normalLength = inkLengthInStrokes(found.head) * overlayStrokeWidth(line.size);
  const head = found.length * pxPerUnit < normalLength * SMALL_HEAD_THRESHOLD ? `${found.head}Small` as OverlayArrowhead : found.head;
  return { head, overshoot: (found.tip - marker.refX) * pxPerUnit };
}
