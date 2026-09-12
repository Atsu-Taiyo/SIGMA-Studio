import type { OverlayCalloutShape, OverlayPoint } from "@/features/document";

import { getCalloutBodySize } from "./overlay-text-box";

const MIN_SIDE_LENGTH = 1;
const MIN_TAIL_SPREAD = 12;
const DEFAULT_TAIL_SPREAD = 40;
/** 角丸の45°対角線上で、輪郭(半径r上)に一致する内側からの比率(1 - cos45°)。 */
const CORNER_HANDLE_ON_ARC_RATIO = 1 - Math.SQRT1_2;

// Leaf-module constant (see `text-shape-font.ts`); re-exported here so existing call sites
// (`@/features/drawing`'s barrel, `overlay-svg.ts`, `shape-renderer.tsx`, ...) don't have to
// change their import path.
export { CALLOUT_TEXT_PADDING } from "./text-shape-font";
export const DEFAULT_CALLOUT_CORNER_RADIUS = 18;

export type CalloutBodySide = "top" | "right" | "bottom" | "left";

export interface CalloutTailBasePoint extends OverlayPoint {
  side: CalloutBodySide;
}

export interface CalloutGeometry {
  body: {
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  radius: number;
  baseStart: CalloutTailBasePoint;
  baseEnd: CalloutTailBasePoint;
  tip: OverlayPoint;
  bounds: {
    x: number;
    y: number;
    w: number;
    h: number;
  };
}

export function getCalloutPath(shape: OverlayCalloutShape): string {
  const { w, h } = getCalloutBodySize(shape);
  const geometry = getCalloutGeometry(shape);
  const { baseStart, baseEnd, tip, radius } = geometry;
  const clockwiseEndToStart = clockwisePerimeterDistance(baseEnd, baseStart, w, h);
  const clockwiseStartToEnd = clockwisePerimeterDistance(baseStart, baseEnd, w, h);

  // 2つの麓の間では短い外周を口へ置き換え、本文を囲う長い外周を残す。
  // 麓が別々の辺に移動しても同じ規則なので、輪郭が裏返らず直感的に追従する。
  if (clockwiseEndToStart >= clockwiseStartToEnd) {
    return [
      `M ${formatPoint(baseStart)}`,
      `L ${formatPoint(tip)}`,
      `L ${formatPoint(baseEnd)}`,
      ...getClockwiseBodyPath(baseEnd, baseStart, w, h, radius),
      "Z",
    ].join(" ");
  }

  return [
    `M ${formatPoint(baseEnd)}`,
    `L ${formatPoint(tip)}`,
    `L ${formatPoint(baseStart)}`,
    ...getClockwiseBodyPath(baseStart, baseEnd, w, h, radius),
    "Z",
  ].join(" ");
}

/**
 * Maps one axis coordinate from a `from`-sized frame to a `to`-sized frame, used to translate
 * callout tail points between the stored body rect (`props.w`/`props.h`) and the effective,
 * content-grown body rect from `getCalloutBodySize`. Exactly invertible via
 * `mapAxis(mapAxis(v, from, to), to, from) === v` (up to floating point), which is what lets
 * `toStoredCalloutPoint(toEffectiveCalloutPoint(shape, p))` round-trip:
 * - `v <= 0` (at/beyond the near edge, e.g. the top/left side): left untouched. There's no
 *   "growth" on that side to account for.
 * - `v >= from` (on/beyond the far edge, e.g. a tail's base sitting exactly on the bottom edge,
 *   or a free tip below the box): translated by the same delta the frame grew by, so a point
 *   sitting exactly on the far edge stays exactly on the far edge instead of becoming interior
 *   (which would flip `getNearestBodySide`'s classification — see module docs) and a free point
 *   outside the box moves by a fixed offset rather than being rescaled (rescaling would send a
 *   nearby tip flying across the page the moment a small box grows a lot).
 * - otherwise (strictly interior, e.g. a tail base on the left/right edge partway down):
 *   scaled proportionally, so it keeps the same fractional position along the (now taller) edge.
 */
function mapAxis(v: number, from: number, to: number): number {
  if (from <= 0 || to === from) {
    return v;
  }
  if (v <= 0) {
    return v;
  }
  if (v >= from) {
    return v + (to - from);
  }
  return (v * to) / from;
}

/** Converts a callout tail point from stored (`props.w`/`props.h`) to effective-body coordinates. */
export function toEffectiveCalloutPoint(shape: OverlayCalloutShape, p: OverlayPoint): OverlayPoint {
  const storedW = shape.props.w;
  const storedH = shape.props.h;
  const { w: effW, h: effH } = getCalloutBodySize(shape);
  return {
    x: mapAxis(p.x, storedW, effW),
    y: mapAxis(p.y, storedH, effH),
  };
}

/** Inverse of `toEffectiveCalloutPoint`: effective-body coordinates back to stored coordinates. */
export function toStoredCalloutPoint(shape: OverlayCalloutShape, p: OverlayPoint): OverlayPoint {
  const storedW = shape.props.w;
  const storedH = shape.props.h;
  const { w: effW, h: effH } = getCalloutBodySize(shape);
  return {
    x: mapAxis(p.x, effW, storedW),
    y: mapAxis(p.y, effH, storedH),
  };
}

/** 頂点は自由移動、麓だけを本文矩形の最寄りの辺へ吸着する。 */
export function snapCalloutTailBasePoint(
  shape: OverlayCalloutShape,
  x: number,
  y: number,
): CalloutTailBasePoint {
  const { w, h } = getCalloutBodySize(shape);
  const side = getNearestBodySide(x, y, w, h);
  return clampCalloutTailBasePointToSide(shape, side, x, y);
}

/**
 * 指定した辺へ麓を吸着させる(辺を自前で判定し直さない版)。
 * 角の境界点は getNearestBodySide のタイブレークで別の辺に再分類されうるため、
 * 呼び出し側が既に辺を決めている場合はこちらを使い、意図した辺からズレないようにする。
 */
function clampCalloutTailBasePointToSide(
  shape: OverlayCalloutShape,
  side: CalloutBodySide,
  x: number,
  y: number,
): CalloutTailBasePoint {
  const { w, h } = getCalloutBodySize(shape);
  const radius = getCalloutCornerRadius(shape);

  if (side === "top") {
    return { x: clamp(x, radius, w - radius), y: 0, side };
  }
  if (side === "right") {
    return { x: w, y: clamp(y, radius, h - radius), side };
  }
  if (side === "bottom") {
    return { x: clamp(x, radius, w - radius), y: h, side };
  }
  return { x: 0, y: clamp(y, radius, h - radius), side };
}

export function getCalloutGeometry(shape: OverlayCalloutShape): CalloutGeometry {
  const { tail } = shape.props;
  const { w, h } = getCalloutBodySize(shape);
  const radius = getCalloutCornerRadius(shape);
  // Tail points are stored relative to `props.w`/`props.h`; the body rect they anchor to may
  // have grown since (see module docs on `mapAxis`), so map into the effective frame before
  // snapping/clamping — otherwise a base point saved exactly on the old bottom edge would land
  // strictly inside the taller box and get reclassified onto the wrong side.
  const effectiveBaseStart = toEffectiveCalloutPoint(shape, tail.baseStart);
  const effectiveBaseEnd = toEffectiveCalloutPoint(shape, tail.baseEnd);
  const effectiveTip = toEffectiveCalloutPoint(shape, tail.tip);
  const baseStart = snapCalloutTailBasePoint(shape, effectiveBaseStart.x, effectiveBaseStart.y);
  const baseEnd = snapCalloutTailBasePoint(shape, effectiveBaseEnd.x, effectiveBaseEnd.y);
  const tip = {
    x: finiteOr(effectiveTip.x, w * 0.14),
    y: finiteOr(effectiveTip.y, h + 28),
  };
  const minX = Math.min(0, baseStart.x, baseEnd.x, tip.x);
  const minY = Math.min(0, baseStart.y, baseEnd.y, tip.y);
  const maxX = Math.max(w, baseStart.x, baseEnd.x, tip.x);
  const maxY = Math.max(h, baseStart.y, baseEnd.y, tip.y);

  return {
    body: { left: 0, top: 0, right: w, bottom: h },
    radius,
    baseStart,
    baseEnd,
    tip,
    bounds: {
      x: minX,
      y: minY,
      w: Math.max(MIN_SIDE_LENGTH, maxX - minX),
      h: Math.max(MIN_SIDE_LENGTH, maxY - minY),
    },
  };
}

export function getCalloutCornerRadius(shape: OverlayCalloutShape): number {
  const { w, h } = getCalloutBodySize(shape);
  return normalizeCalloutCornerRadius(shape.props.radius, w, h);
}

export function normalizeCalloutCornerRadius(radius: number, width: number, height: number): number {
  // 口が最寄りの辺へ移動したときも麓2点が潰れないよう、最短辺に最低限の直線部を残す。
  const maxRadius = Math.max(0, (Math.min(width, height) - MIN_TAIL_SPREAD) / 2);
  return clamp(Number.isFinite(radius) ? radius : DEFAULT_CALLOUT_CORNER_RADIUS, 0, maxRadius);
}

/** 角丸ハンドルは左上の丸みの輪郭線上(対角45°)に置き、対角ドラッグで半径を決める。 */
export function getCalloutCornerRadiusHandlePoint(shape: OverlayCalloutShape): OverlayPoint {
  const { w, h } = getCalloutBodySize(shape);
  const offset = getCalloutCornerRadius(shape) * CORNER_HANDLE_ON_ARC_RATIO;
  return {
    x: Math.min(w, offset),
    y: Math.min(h, offset),
  };
}

export function getCalloutCornerRadiusFromHandlePoint(shape: OverlayCalloutShape, x: number, y: number): number {
  const { w, h } = getCalloutBodySize(shape);
  const projected = (x + y) / 2;
  return normalizeCalloutCornerRadius(projected / CORNER_HANDLE_ON_ARC_RATIO, w, h);
}

/**
 * 頂点を動かしたとき、現在の口幅を保ったまま最寄りの本文外周へ麓を移す。
 * 麓2点は中心が属する辺の範囲内にスパン全体を収めることで、必ず同じ辺にまとまる。
 */
export function moveCalloutTailToTip(shape: OverlayCalloutShape, tip: OverlayPoint): OverlayCalloutShape["props"]["tail"] {
  const { w, h } = getCalloutBodySize(shape);
  const perimeter = Math.max(MIN_SIDE_LENGTH, (w + h) * 2);
  const spread = getCalloutTailSpread(shape, perimeter);
  const center = nearestRectanglePerimeterPosition(tip, w, h);
  const { side, start: sideStart, end: sideEnd } = getPerimeterSideRange(center, w, h);
  const halfSpread = Math.min(spread, sideEnd - sideStart) / 2;
  const clampedCenter = clamp(center, sideStart + halfSpread, sideEnd - halfSpread);
  const baseStart = pointAtPositionOnSide(side, clampedCenter - halfSpread, w, h);
  const baseEnd = pointAtPositionOnSide(side, clampedCenter + halfSpread, w, h);
  const snappedStart = clampCalloutTailBasePointToSide(shape, side, baseStart.x, baseStart.y);
  const snappedEnd = clampCalloutTailBasePointToSide(shape, side, baseEnd.x, baseEnd.y);

  return {
    baseStart: { x: snappedStart.x, y: snappedStart.y },
    baseEnd: { x: snappedEnd.x, y: snappedEnd.y },
    tip,
  };
}

function getCalloutTailSpread(shape: OverlayCalloutShape, perimeter: number): number {
  const { w, h } = getCalloutBodySize(shape);
  // Reuse `getCalloutGeometry` rather than re-snapping the raw stored tail points here: it
  // already does the stored-to-effective conversion (see its module docs), so this stays
  // correct instead of re-deriving (and risking diverging from) that same conversion.
  const geometry = getCalloutGeometry(shape);
  const delta = Math.abs(perimeterPosition(geometry.baseEnd, w, h) - perimeterPosition(geometry.baseStart, w, h));
  const shorterDistance = Math.min(delta, perimeter - delta);
  const fallback = Math.min(DEFAULT_TAIL_SPREAD, Math.max(MIN_TAIL_SPREAD, Math.min(w, h) * 0.4));
  return clamp(shorterDistance > MIN_SIDE_LENGTH ? shorterDistance : fallback, MIN_TAIL_SPREAD, perimeter / 2);
}

function nearestRectanglePerimeterPosition(point: OverlayPoint, width: number, height: number): number {
  const x = clamp(point.x, 0, width);
  const y = clamp(point.y, 0, height);
  const outside = point.x < 0 || point.x > width || point.y < 0 || point.y > height;

  if (outside && (x === 0 || x === width || y === 0 || y === height)) {
    return boundaryPointToPerimeterPosition({ x, y }, width, height);
  }

  const distances = [
    { distance: y, position: x },
    { distance: width - x, position: width + y },
    { distance: height - y, position: width + height + (width - x) },
    { distance: x, position: width * 2 + height + (height - y) },
  ];
  return distances.reduce((nearest, current) => current.distance < nearest.distance ? current : nearest).position;
}

function boundaryPointToPerimeterPosition(point: OverlayPoint, width: number, height: number): number {
  if (point.y === 0) return point.x;
  if (point.x === width) return width + point.y;
  if (point.y === height) return width + height + (width - point.x);
  return width * 2 + height + (height - point.y);
}

function getPerimeterSideRange(position: number, width: number, height: number): { side: CalloutBodySide; start: number; end: number } {
  const perimeter = Math.max(MIN_SIDE_LENGTH, (width + height) * 2);
  const normalized = ((position % perimeter) + perimeter) % perimeter;
  if (normalized <= width) return { side: "top", start: 0, end: width };
  if (normalized <= width + height) return { side: "right", start: width, end: width + height };
  if (normalized <= width * 2 + height) return { side: "bottom", start: width + height, end: width * 2 + height };
  return { side: "left", start: width * 2 + height, end: perimeter };
}

function pointAtPositionOnSide(side: CalloutBodySide, position: number, width: number, height: number): OverlayPoint {
  if (side === "top") return { x: position, y: 0 };
  if (side === "right") return { x: width, y: position - width };
  if (side === "bottom") return { x: width - (position - width - height), y: height };
  return { x: 0, y: height - (position - (width * 2 + height)) };
}

function getNearestBodySide(x: number, y: number, width: number, height: number): CalloutBodySide {
  const distances: Array<[CalloutBodySide, number]> = [
    ["top", Math.abs(y)],
    ["right", Math.abs(width - x)],
    ["bottom", Math.abs(height - y)],
    ["left", Math.abs(x)],
  ];
  return distances.reduce((nearest, current) => current[1] < nearest[1] ? current : nearest)[0];
}

function getClockwiseBodyPath(
  from: CalloutTailBasePoint,
  to: CalloutTailBasePoint,
  width: number,
  height: number,
  radius: number,
): string[] {
  const sides: CalloutBodySide[] = ["top", "right", "bottom", "left"];
  let sideIndex = sides.indexOf(from.side);
  const commands: string[] = [];

  for (let iteration = 0; iteration < 5; iteration += 1) {
    const side = sides[sideIndex];
    const sameSideAhead = side === to.side && sideProgress(to, width, height) >= sideProgress(
      iteration === 0 ? from : sideStart(side, width, height, radius),
      width,
      height,
    );
    if (sameSideAhead) {
      commands.push(`L ${formatPoint(to)}`);
      return commands;
    }

    commands.push(...sideEndAndCorner(side, width, height, radius));
    sideIndex = (sideIndex + 1) % sides.length;
  }

  commands.push(`L ${formatPoint(to)}`);
  return commands;
}

function sideStart(side: CalloutBodySide, width: number, height: number, radius: number): CalloutTailBasePoint {
  if (side === "top") return { x: radius, y: 0, side };
  if (side === "right") return { x: width, y: radius, side };
  if (side === "bottom") return { x: width - radius, y: height, side };
  return { x: 0, y: height - radius, side };
}

function sideProgress(point: CalloutTailBasePoint, width: number, height: number): number {
  if (point.side === "top") return point.x;
  if (point.side === "right") return point.y;
  if (point.side === "bottom") return width - point.x;
  return height - point.y;
}

function sideEndAndCorner(side: CalloutBodySide, width: number, height: number, radius: number): string[] {
  if (side === "top") {
    return [`L ${width - radius} 0`, `Q ${width} 0 ${width} ${radius}`];
  }
  if (side === "right") {
    return [`L ${width} ${height - radius}`, `Q ${width} ${height} ${width - radius} ${height}`];
  }
  if (side === "bottom") {
    return [`L ${radius} ${height}`, `Q 0 ${height} 0 ${height - radius}`];
  }
  return [`L 0 ${radius}`, `Q 0 0 ${radius} 0`];
}

function clockwisePerimeterDistance(
  from: CalloutTailBasePoint,
  to: CalloutTailBasePoint,
  width: number,
  height: number,
): number {
  const perimeter = Math.max(MIN_SIDE_LENGTH, (width + height) * 2);
  const delta = perimeterPosition(to, width, height) - perimeterPosition(from, width, height);
  const normalized = ((delta % perimeter) + perimeter) % perimeter;
  return normalized === 0 ? perimeter : normalized;
}

function perimeterPosition(point: CalloutTailBasePoint, width: number, height: number): number {
  if (point.side === "top") return point.x;
  if (point.side === "right") return width + point.y;
  if (point.side === "bottom") return width + height + (width - point.x);
  return width * 2 + height + (height - point.y);
}

function formatPoint(point: OverlayPoint): string {
  return `${round(point.x)} ${round(point.y)}`;
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
  if (max < min) {
    return (min + max) / 2;
  }
  return Math.min(max, Math.max(min, value));
}
