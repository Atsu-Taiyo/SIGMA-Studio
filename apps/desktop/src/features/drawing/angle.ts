import type { OverlayPoint } from "@/features/document";

export const ANGLE_SNAP_STEP_RADIANS = Math.PI / 12;

export function normalizeAngle(angle: number): number {
  const fullCircle = Math.PI * 2;
  const normalized = ((angle % fullCircle) + fullCircle) % fullCircle;
  return normalized > Math.PI ? normalized - fullCircle : normalized;
}

export function snapAngleToStep(angle: number, step = ANGLE_SNAP_STEP_RADIANS): number {
  return Math.round(angle / step) * step;
}

/**
 * Snap an angle expressed in a rotated shape's local coordinates so that the
 * resulting page-space angle lands on an absolute step (0°, 15°, 30°, ...).
 */
export function snapLocalAngleToAbsoluteStep(
  localAngle: number,
  rotation: number,
  step = ANGLE_SNAP_STEP_RADIANS,
): number {
  return normalizeAngle(snapAngleToStep(localAngle + rotation, step) - rotation);
}

export function snapRotationDeltaToAbsoluteStep(
  startRotation: number,
  delta: number,
  step = ANGLE_SNAP_STEP_RADIANS,
): number {
  return normalizeAngle(snapAngleToStep(startRotation + delta, step) - startRotation);
}

export function snapPointAround(
  anchor: OverlayPoint,
  point: OverlayPoint,
  step = ANGLE_SNAP_STEP_RADIANS,
): OverlayPoint {
  const dx = point.x - anchor.x;
  const dy = point.y - anchor.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) {
    return point;
  }

  const snappedAngle = snapAngleToStep(Math.atan2(dy, dx), step);
  return {
    x: anchor.x + Math.cos(snappedAngle) * length,
    y: anchor.y + Math.sin(snappedAngle) * length,
  };
}
