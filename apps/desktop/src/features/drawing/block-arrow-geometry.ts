import type { OverlayGeoShape, OverlayPoint } from "@/features/document";

export const BLOCK_ARROW_MIN_HEAD_LENGTH_RATIO = 0.18;
export const BLOCK_ARROW_MAX_HEAD_LENGTH_RATIO = 0.75;
export const BLOCK_ARROW_DEFAULT_HEAD_LENGTH_RATIO = 0.32;
export const BLOCK_ARROW_MIN_SHAFT_RATIO = 0.12;
export const BLOCK_ARROW_MAX_SHAFT_RATIO = 0.9;
export const BLOCK_ARROW_DEFAULT_SHAFT_RATIO = 0.42;

type BlockArrowShape = Extract<OverlayGeoShape, { type: "geo" }>;

export function getBlockArrowPolygonPoints(
  width: number,
  height: number,
  headLengthRatio?: number,
  shaftRatio?: number,
  inset = 0,
): OverlayPoint[] {
  const left = inset;
  const right = Math.max(left + 1, width - inset);
  const top = inset;
  const bottom = Math.max(top + 1, height - inset);
  const innerWidth = Math.max(1, right - left);
  const innerHeight = Math.max(1, bottom - top);
  const centerY = top + innerHeight / 2;
  const headLength = innerWidth * normalizeBlockArrowHeadLengthRatio(headLengthRatio);
  const headBaseX = clamp(right - headLength, left + Math.min(8, innerWidth * 0.25), right - 1);
  const shaftHalfHeight = (innerHeight * normalizeBlockArrowShaftRatio(shaftRatio)) / 2;
  const shaftTop = clamp(centerY - shaftHalfHeight, top, centerY);
  const shaftBottom = clamp(centerY + shaftHalfHeight, centerY, bottom);

  return [
    { x: left, y: shaftTop },
    { x: headBaseX, y: shaftTop },
    { x: headBaseX, y: top },
    { x: right, y: centerY },
    { x: headBaseX, y: bottom },
    { x: headBaseX, y: shaftBottom },
    { x: left, y: shaftBottom },
  ];
}

export function getBlockArrowHeadHandlePoint(shape: BlockArrowShape): OverlayPoint {
  const headBaseX = shape.props.w * (1 - normalizeBlockArrowHeadLengthRatio(shape.props.headLengthRatio));
  return {
    x: clamp(headBaseX, 0, shape.props.w),
    y: shape.props.h / 2,
  };
}

export function getBlockArrowShaftHandlePoint(shape: BlockArrowShape): OverlayPoint {
  const headPoint = getBlockArrowHeadHandlePoint(shape);
  const shaftTop = (shape.props.h * (1 - normalizeBlockArrowShaftRatio(shape.props.shaftRatio))) / 2;
  return {
    x: Math.max(0, headPoint.x / 2),
    y: clamp(shaftTop, 0, shape.props.h / 2),
  };
}

export function normalizeBlockArrowHeadLengthRatio(value: unknown): number {
  return clampFiniteNumber(
    value,
    BLOCK_ARROW_DEFAULT_HEAD_LENGTH_RATIO,
    BLOCK_ARROW_MIN_HEAD_LENGTH_RATIO,
    BLOCK_ARROW_MAX_HEAD_LENGTH_RATIO,
  );
}

export function normalizeBlockArrowShaftRatio(value: unknown): number {
  return clampFiniteNumber(
    value,
    BLOCK_ARROW_DEFAULT_SHAFT_RATIO,
    BLOCK_ARROW_MIN_SHAFT_RATIO,
    BLOCK_ARROW_MAX_SHAFT_RATIO,
  );
}

function clampFiniteNumber(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === "number" ? value : Number.parseFloat(String(value));
  return clamp(Number.isFinite(number) ? number : fallback, min, max);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
