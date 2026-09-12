import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";

import type { ResizeHandle } from "./interaction-mode";
import { boundsFromPoints } from "./math";
import { getShapeSnapPoints } from "./shape-snap-points";
import { getShapeSelectionBounds } from "./shape-bounds";

export const DEFAULT_OVERLAY_SNAP_THRESHOLD = 8;

export type OverlaySnapAxis = "x" | "y";

export type OverlaySnapGuide =
  | {
      type: "line";
      axis: OverlaySnapAxis;
      value: number;
      start: number;
      end: number;
      points: OverlayPoint[];
    }
  | {
      type: "point";
      point: OverlayPoint;
    };

export interface OverlaySnapResult {
  snapped: boolean;
  nudge: OverlayPoint;
  guides: OverlaySnapGuide[];
}

export interface OverlayBoundsSnapResult extends OverlaySnapResult {
  bounds: OverlayBounds;
}

export interface OverlayPointSnapResult extends OverlaySnapResult {
  point: OverlayPoint;
}

interface OverlaySnapRange {
  start: number;
  end: number;
}

interface OverlayAxisSnapTarget {
  id: string;
  axis: OverlaySnapAxis;
  value: number;
  range: OverlaySnapRange;
}

interface OverlayPointSnapTarget {
  id: string;
  point: OverlayPoint;
}

export interface OverlaySnapGeometry {
  axes: OverlayAxisSnapTarget[];
  points: OverlayPointSnapTarget[];
}

interface OverlaySnapOptions {
  threshold?: number;
  disabled?: boolean;
}

interface CreateOverlaySnapGeometryOptions {
  excludedShapeIds?: Iterable<OverlayShapeId>;
  canvasWidth?: number;
  canvasHeight?: number;
  includePage?: boolean;
  verticalGuideValues?: Iterable<number>;
}

interface BoundsAxisSnap {
  id: string;
  axis: OverlaySnapAxis;
  value: number;
  range: OverlaySnapRange;
}

interface NearestAxisSnap {
  target: OverlayAxisSnapTarget;
  source: BoundsAxisSnap;
  distance: number;
  nudge: number;
}

const ZERO_NUDGE: OverlayPoint = { x: 0, y: 0 };

export function createOverlaySnapGeometry(
  shapes: OverlayShape[],
  options: CreateOverlaySnapGeometryOptions = {},
): OverlaySnapGeometry {
  const excluded = new Set(options.excludedShapeIds ?? []);
  const geometry: OverlaySnapGeometry = { axes: [], points: [] };

  if (options.includePage !== false && isPositiveNumber(options.canvasWidth) && isPositiveNumber(options.canvasHeight)) {
    addBoundsTargets(geometry, "page", {
      x: 0,
      y: 0,
      w: options.canvasWidth,
      h: options.canvasHeight,
    });
  }

  if (isPositiveNumber(options.canvasHeight)) {
    addVerticalGuideTargets(geometry, "page-guide", options.verticalGuideValues ?? [], options.canvasHeight);
  }

  for (const shape of shapes) {
    if (excluded.has(shape.id) || shape.hidden) {
      continue;
    }

    const snapPoints = getShapeSnapPoints(shape);
    if (snapPoints) {
      addPointShapeTargets(geometry, shape.id, snapPoints);
      continue;
    }

    addBoundsTargets(geometry, shape.id, getShapeSelectionBounds(shape));
  }

  return geometry;
}

export function snapBoundsToGeometry(
  bounds: OverlayBounds,
  geometry: OverlaySnapGeometry,
  options: OverlaySnapOptions = {},
): OverlayBoundsSnapResult {
  const threshold = options.threshold ?? DEFAULT_OVERLAY_SNAP_THRESHOLD;
  if (options.disabled || threshold <= 0) {
    return { snapped: false, nudge: ZERO_NUDGE, guides: [], bounds };
  }

  const xSnap = findNearestAxisSnap(createBoundsAxisSnaps(bounds, "x"), geometry.axes, threshold);
  const ySnap = findNearestAxisSnap(createBoundsAxisSnaps(bounds, "y"), geometry.axes, threshold);
  const nudge = {
    x: xSnap?.nudge ?? 0,
    y: ySnap?.nudge ?? 0,
  };
  const snapped = nudge.x !== 0 || nudge.y !== 0;

  return {
    snapped,
    nudge,
    guides: [
      ...(xSnap ? [createAxisGuide(xSnap)] : []),
      ...(ySnap ? [createAxisGuide(ySnap)] : []),
    ],
    bounds: {
      ...bounds,
      x: bounds.x + nudge.x,
      y: bounds.y + nudge.y,
    },
  };
}

export function snapResizeBoundsToGeometry(
  bounds: OverlayBounds,
  handle: ResizeHandle,
  geometry: OverlaySnapGeometry,
  options: OverlaySnapOptions & { preserveAspect?: boolean; targetAspect?: number | null } = {},
): OverlayBoundsSnapResult {
  const threshold = options.threshold ?? DEFAULT_OVERLAY_SNAP_THRESHOLD;
  if (options.disabled || threshold <= 0) {
    return { snapped: false, nudge: ZERO_NUDGE, guides: [], bounds };
  }

  const xSnap = resizeHandleMovesX(handle)
    ? findNearestAxisSnap(createResizeAxisSnaps(bounds, handle, "x"), geometry.axes, threshold)
    : null;
  const ySnap = resizeHandleMovesY(handle)
    ? findNearestAxisSnap(createResizeAxisSnaps(bounds, handle, "y"), geometry.axes, threshold)
    : null;
  const aspect = options.targetAspect ?? (options.preserveAspect ? Math.abs(bounds.h / bounds.w) : null);
  const rawNudge = { x: xSnap?.nudge ?? 0, y: ySnap?.nudge ?? 0 };
  const nudge = aspect && aspect > 0 && isCornerResizeHandle(handle)
    ? constrainCornerResizeNudgeToAspect(handle, rawNudge, xSnap, ySnap, aspect)
    : rawNudge;
  const snapped = nudge.x !== 0 || nudge.y !== 0;
  const guides = aspect && aspect > 0 && isCornerResizeHandle(handle)
    ? primaryAspectGuide(rawNudge, xSnap, ySnap)
    : [
        ...(xSnap ? [createAxisGuide(xSnap)] : []),
        ...(ySnap ? [createAxisGuide(ySnap)] : []),
      ];

  return {
    snapped,
    nudge,
    guides,
    bounds: applyResizeNudge(bounds, handle, nudge),
  };
}

export function snapPointToGeometry(
  point: OverlayPoint,
  geometry: OverlaySnapGeometry,
  options: OverlaySnapOptions = {},
): OverlayPointSnapResult {
  const threshold = options.threshold ?? DEFAULT_OVERLAY_SNAP_THRESHOLD;
  if (options.disabled || threshold <= 0) {
    return { snapped: false, nudge: ZERO_NUDGE, guides: [], point };
  }

  let nearest: { target: OverlayPointSnapTarget; distance: number } | null = null;
  for (const target of geometry.points) {
    const distance = Math.hypot(target.point.x - point.x, target.point.y - point.y);
    if (distance <= threshold && (!nearest || distance < nearest.distance)) {
      nearest = { target, distance };
    }
  }

  if (!nearest) {
    return { snapped: false, nudge: ZERO_NUDGE, guides: [], point };
  }

  const snappedPoint = nearest.target.point;
  return {
    snapped: true,
    nudge: {
      x: snappedPoint.x - point.x,
      y: snappedPoint.y - point.y,
    },
    guides: [{ type: "point", point: snappedPoint }],
    point: snappedPoint,
  };
}

function addPointShapeTargets(
  geometry: OverlaySnapGeometry,
  sourceId: string,
  points: OverlayPoint[],
): void {
  if (points.length === 0) {
    return;
  }

  const bounds = boundsFromPoints(points);
  addAxisTargets(geometry, sourceId, bounds);

  points.forEach((point, index) => {
    geometry.points.push({ id: `${sourceId}:point:${index}`, point });
  });

}

function addBoundsTargets(geometry: OverlaySnapGeometry, sourceId: string, bounds: OverlayBounds): void {
  const normalized = normalizeBounds(bounds);
  addAxisTargets(geometry, sourceId, normalized);

  for (const point of getBoundsPointTargets(normalized)) {
    geometry.points.push({
      id: `${sourceId}:point:${point.id}`,
      point: point.point,
    });
  }
}

function addAxisTargets(geometry: OverlaySnapGeometry, sourceId: string, bounds: OverlayBounds): void {
  const normalized = normalizeBounds(bounds);
  const xRange = { start: normalized.y, end: normalized.y + normalized.h };
  const yRange = { start: normalized.x, end: normalized.x + normalized.w };

  geometry.axes.push(
    { id: `${sourceId}:left`, axis: "x", value: normalized.x, range: xRange },
    { id: `${sourceId}:center-x`, axis: "x", value: normalized.x + normalized.w / 2, range: xRange },
    { id: `${sourceId}:right`, axis: "x", value: normalized.x + normalized.w, range: xRange },
    { id: `${sourceId}:top`, axis: "y", value: normalized.y, range: yRange },
    { id: `${sourceId}:middle-y`, axis: "y", value: normalized.y + normalized.h / 2, range: yRange },
    { id: `${sourceId}:bottom`, axis: "y", value: normalized.y + normalized.h, range: yRange },
  );
}

function addVerticalGuideTargets(
  geometry: OverlaySnapGeometry,
  sourceId: string,
  values: Iterable<number>,
  canvasHeight: number,
): void {
  const seen = new Set<string>();

  for (const value of values) {
    if (!Number.isFinite(value)) {
      continue;
    }

    const normalized = roundSnapValue(value);
    const key = normalized.toFixed(3);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    geometry.axes.push({
      id: `${sourceId}:x:${key}`,
      axis: "x",
      value: normalized,
      range: { start: 0, end: canvasHeight },
    });
  }
}

function getBoundsPointTargets(bounds: OverlayBounds): Array<{ id: string; point: OverlayPoint }> {
  const left = bounds.x;
  const centerX = bounds.x + bounds.w / 2;
  const right = bounds.x + bounds.w;
  const top = bounds.y;
  const middleY = bounds.y + bounds.h / 2;
  const bottom = bounds.y + bounds.h;

  return [
    { id: "top-left", point: { x: left, y: top } },
    { id: "top-center", point: { x: centerX, y: top } },
    { id: "top-right", point: { x: right, y: top } },
    { id: "middle-left", point: { x: left, y: middleY } },
    { id: "center", point: { x: centerX, y: middleY } },
    { id: "middle-right", point: { x: right, y: middleY } },
    { id: "bottom-left", point: { x: left, y: bottom } },
    { id: "bottom-center", point: { x: centerX, y: bottom } },
    { id: "bottom-right", point: { x: right, y: bottom } },
  ];
}

function createBoundsAxisSnaps(bounds: OverlayBounds, axis: OverlaySnapAxis): BoundsAxisSnap[] {
  const normalized = normalizeBounds(bounds);
  if (axis === "x") {
    const range = { start: normalized.y, end: normalized.y + normalized.h };
    return [
      { id: "left", axis, value: normalized.x, range },
      { id: "center-x", axis, value: normalized.x + normalized.w / 2, range },
      { id: "right", axis, value: normalized.x + normalized.w, range },
    ];
  }

  const range = { start: normalized.x, end: normalized.x + normalized.w };
  return [
    { id: "top", axis, value: normalized.y, range },
    { id: "middle-y", axis, value: normalized.y + normalized.h / 2, range },
    { id: "bottom", axis, value: normalized.y + normalized.h, range },
  ];
}

function roundSnapValue(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function createResizeAxisSnaps(bounds: OverlayBounds, handle: ResizeHandle, axis: OverlaySnapAxis): BoundsAxisSnap[] {
  const normalized = normalizeBounds(bounds);
  if (axis === "x") {
    const range = { start: normalized.y, end: normalized.y + normalized.h };
    const value = handle.includes("w") ? normalized.x : normalized.x + normalized.w;
    return [{ id: handle.includes("w") ? "left" : "right", axis, value, range }];
  }

  const range = { start: normalized.x, end: normalized.x + normalized.w };
  const value = handle.includes("n") ? normalized.y : normalized.y + normalized.h;
  return [{ id: handle.includes("n") ? "top" : "bottom", axis, value, range }];
}

function findNearestAxisSnap(
  sources: BoundsAxisSnap[],
  targets: OverlayAxisSnapTarget[],
  threshold: number,
): NearestAxisSnap | null {
  let nearest: NearestAxisSnap | null = null;
  for (const source of sources) {
    for (const target of targets) {
      if (target.axis !== source.axis) {
        continue;
      }

      const nudge = target.value - source.value;
      const distance = Math.abs(nudge);
      if (distance <= threshold && (!nearest || distance < nearest.distance)) {
        nearest = { source, target, distance, nudge };
      }
    }
  }

  return nearest;
}

function createAxisGuide(snap: NearestAxisSnap): OverlaySnapGuide {
  const start = Math.min(snap.source.range.start, snap.target.range.start);
  const end = Math.max(snap.source.range.end, snap.target.range.end);

  if (snap.source.axis === "x") {
    return {
      type: "line",
      axis: "x",
      value: snap.target.value,
      start,
      end,
      points: [
        { x: snap.target.value, y: snap.source.range.start },
        { x: snap.target.value, y: snap.source.range.end },
        { x: snap.target.value, y: snap.target.range.start },
        { x: snap.target.value, y: snap.target.range.end },
      ],
    };
  }

  return {
    type: "line",
    axis: "y",
    value: snap.target.value,
    start,
    end,
    points: [
      { x: snap.source.range.start, y: snap.target.value },
      { x: snap.source.range.end, y: snap.target.value },
      { x: snap.target.range.start, y: snap.target.value },
      { x: snap.target.range.end, y: snap.target.value },
    ],
  };
}

function applyResizeNudge(bounds: OverlayBounds, handle: ResizeHandle, nudge: OverlayPoint): OverlayBounds {
  let { x, y, w, h } = bounds;

  if (handle.includes("w")) {
    x += nudge.x;
    w -= nudge.x;
  } else if (handle.includes("e")) {
    w += nudge.x;
  }

  if (handle.includes("n")) {
    y += nudge.y;
    h -= nudge.y;
  } else if (handle.includes("s")) {
    h += nudge.y;
  }

  return { x, y, w, h };
}

function constrainCornerResizeNudgeToAspect(
  handle: ResizeHandle,
  nudge: OverlayPoint,
  xSnap: NearestAxisSnap | null,
  ySnap: NearestAxisSnap | null,
  aspect: number,
): OverlayPoint {
  if (!xSnap && !ySnap) {
    return ZERO_NUDGE;
  }

  const useX = xSnap && ySnap
    ? xSnap.distance <= ySnap.distance
    : Boolean(xSnap);
  const sign = handle === "ne" || handle === "sw" ? -1 : 1;

  if (useX) {
    return {
      x: nudge.x,
      y: nudge.x * aspect * sign,
    };
  }

  return {
    x: (nudge.y / aspect) * sign,
    y: nudge.y,
  };
}

function primaryAspectGuide(
  nudge: OverlayPoint,
  xSnap: NearestAxisSnap | null,
  ySnap: NearestAxisSnap | null,
): OverlaySnapGuide[] {
  if (!xSnap && !ySnap) {
    return [];
  }

  if (xSnap && ySnap) {
    return [Math.abs(nudge.x) <= Math.abs(nudge.y) ? createAxisGuide(xSnap) : createAxisGuide(ySnap)];
  }

  return [createAxisGuide((xSnap ?? ySnap) as NearestAxisSnap)];
}

function resizeHandleMovesX(handle: ResizeHandle): boolean {
  return handle.includes("e") || handle.includes("w");
}

function resizeHandleMovesY(handle: ResizeHandle): boolean {
  return handle.includes("n") || handle.includes("s");
}

function isCornerResizeHandle(handle: ResizeHandle): boolean {
  return resizeHandleMovesX(handle) && resizeHandleMovesY(handle);
}

function normalizeBounds(bounds: OverlayBounds): OverlayBounds {
  const x = Math.min(bounds.x, bounds.x + bounds.w);
  const y = Math.min(bounds.y, bounds.y + bounds.h);
  return {
    x,
    y,
    w: Math.abs(bounds.w),
    h: Math.abs(bounds.h),
  };
}

function isPositiveNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}
