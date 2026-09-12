import { describe, expect, it } from "vitest";

import {
  ANGLE_SNAP_STEP_RADIANS,
  snapAngleToStep,
  snapLocalAngleToAbsoluteStep,
  snapPointAround,
  snapRotationDeltaToAbsoluteStep,
} from "./angle";

describe("overlay angle snapping", () => {
  it("snaps angles to 15 degree steps", () => {
    expect(snapAngleToStep(13 * Math.PI / 180)).toBeCloseTo(ANGLE_SNAP_STEP_RADIANS);
    expect(snapAngleToStep(23 * Math.PI / 180)).toBeCloseTo(2 * ANGLE_SNAP_STEP_RADIANS);
  });

  it("snaps a point around an anchor while preserving distance", () => {
    const anchor = { x: 10, y: 20 };
    const point = { x: 110, y: 39 };
    const snapped = snapPointAround(anchor, point);
    const angle = Math.atan2(snapped.y - anchor.y, snapped.x - anchor.x);

    expect(Math.hypot(snapped.x - anchor.x, snapped.y - anchor.y)).toBeCloseTo(Math.hypot(point.x - anchor.x, point.y - anchor.y));
    expect(angle).toBeCloseTo(ANGLE_SNAP_STEP_RADIANS);
  });

  it("snaps rotation deltas to absolute final rotation", () => {
    const startRotation = 7 * Math.PI / 180;
    const rawDelta = 10 * Math.PI / 180;
    const snappedDelta = snapRotationDeltaToAbsoluteStep(startRotation, rawDelta);

    expect(startRotation + snappedDelta).toBeCloseTo(ANGLE_SNAP_STEP_RADIANS);
  });

  it("snaps a rotated shape's local angle to absolute page angle steps", () => {
    const rotation = 7 * Math.PI / 180;
    const localAngle = 21 * Math.PI / 180;
    const snappedLocalAngle = snapLocalAngleToAbsoluteStep(localAngle, rotation);

    expect(snappedLocalAngle).toBeCloseTo(23 * Math.PI / 180);
    expect(snappedLocalAngle + rotation).toBeCloseTo(30 * Math.PI / 180);
  });
});
