import type { OverlayPoint, OverlayShape } from "@/features/document";

import { scaleArcRadiusFromDrag } from "./arc-interaction";
import { snapLocalAngleToAbsoluteStep, snapPointAround } from "./angle";
import {
  BLOCK_ARROW_MAX_HEAD_LENGTH_RATIO,
  BLOCK_ARROW_MAX_SHAFT_RATIO,
  BLOCK_ARROW_MIN_HEAD_LENGTH_RATIO,
  BLOCK_ARROW_MIN_SHAFT_RATIO,
} from "./block-arrow-geometry";
import {
  getCalloutCornerRadiusFromHandlePoint,
  moveCalloutTailToTip,
  snapCalloutTailBasePoint,
  toStoredCalloutPoint,
} from "./callout-geometry";
import type { PointHandle } from "./interaction-mode";
import { clamp } from "./math";
import { getArcRadii } from "./shape-bounds";

export function updateShapePoint(shape: OverlayShape, handle: PointHandle, point: OverlayPoint, shiftKey = false): OverlayShape {
  if (shape.type === "geo" && shape.props.geo === "triangle" && handle.type === "triangleApex") {
    return {
      ...shape,
      props: {
        ...shape.props,
        apexX: clamp(point.x - shape.x, 0, shape.props.w),
      },
    };
  }

  if (shape.type === "geo" && shape.props.geo === "blockArrow" && handle.type === "blockArrowHead") {
    const localX = clamp(point.x - shape.x, 0, shape.props.w);
    const ratio = clamp((shape.props.w - localX) / Math.max(1, shape.props.w), BLOCK_ARROW_MIN_HEAD_LENGTH_RATIO, BLOCK_ARROW_MAX_HEAD_LENGTH_RATIO);
    return {
      ...shape,
      props: {
        ...shape.props,
        headLengthRatio: Math.round(ratio * 1000) / 1000,
      },
    };
  }

  if (shape.type === "geo" && shape.props.geo === "blockArrow" && handle.type === "blockArrowShaft") {
    const localY = clamp(point.y - shape.y, 0, shape.props.h);
    const ratio = clamp((Math.abs(localY - shape.props.h / 2) * 2) / Math.max(1, shape.props.h), BLOCK_ARROW_MIN_SHAFT_RATIO, BLOCK_ARROW_MAX_SHAFT_RATIO);
    return {
      ...shape,
      props: {
        ...shape.props,
        shaftRatio: Math.round(ratio * 1000) / 1000,
      },
    };
  }

  if (shape.type === "arc" && handle.type === "arc") {
    const { rx, ry } = getArcRadii(shape);
    const center = {
      x: shape.x + rx,
      y: shape.y + ry,
    };
    const rawAngle = Math.atan2((point.y - center.y) / ry, (point.x - center.x) / rx);
    // 通常は自由角度。Shift 中は図形の回転量に関係なく、キャンバス上の
    // 最終角度が 0°/15°/30°... になるよう絶対角度へスナップする。
    const rotation = typeof shape.rotation === "number" && Number.isFinite(shape.rotation) ? shape.rotation : 0;
    const angle = shiftKey ? snapLocalAngleToAbsoluteStep(rawAngle, rotation) : rawAngle;
    return {
      ...shape,
      props: {
        ...shape.props,
        [handle.endpoint === "start" ? "startAngle" : "endAngle"]: angle,
      },
    };
  }

  if (shape.type === "arc" && handle.type === "arcRadius") {
    return scaleArcRadiusFromDrag(shape, point);
  }

  if (shape.type === "line" && handle.type === "line") {
    const localPoint = { x: point.x - shape.x, y: point.y - shape.y };
    const snapReference = getLinePointSnapReference(shape.props.points, handle.index);
    const nextPoint = shiftKey && snapReference ? snapPointAround(snapReference, localPoint) : localPoint;
    return {
      ...shape,
      props: {
        ...shape.props,
        points: shape.props.points.map((item, index) => (
          index === handle.index
            ? nextPoint
            : item
        )),
      },
    };
  }

  if (shape.type === "arrow" && handle.type === "arrow") {
    const localPoint = { x: point.x - shape.x, y: point.y - shape.y };
    const snapReference = handle.endpoint === "start" ? shape.props.end : shape.props.start;
    const nextPoint = shiftKey ? snapPointAround(snapReference, localPoint) : localPoint;
    return {
      ...shape,
      props: {
        ...shape.props,
        [handle.endpoint]: nextPoint,
      },
    };
  }

  if (shape.type === "callout" && handle.type === "calloutTailTip") {
    // The pointer position is in the same (effective, content-grown) frame the handle was
    // drawn in — see `getCalloutGeometry` — so `moveCalloutTailToTip` computes entirely in that
    // frame. Its result must be mapped back to the stored (`props.w`/`props.h`) frame before
    // saving, or the next `getCalloutGeometry` call would double-apply the growth offset.
    const tip = { x: point.x - shape.x, y: point.y - shape.y };
    const nextTail = moveCalloutTailToTip(shape, tip);
    return {
      ...shape,
      props: {
        ...shape.props,
        tail: {
          baseStart: toStoredCalloutPoint(shape, nextTail.baseStart),
          baseEnd: toStoredCalloutPoint(shape, nextTail.baseEnd),
          tip: toStoredCalloutPoint(shape, nextTail.tip),
        },
      },
    };
  }

  if (shape.type === "callout" && handle.type === "calloutCornerRadius") {
    return {
      ...shape,
      props: {
        ...shape.props,
        radius: getCalloutCornerRadiusFromHandlePoint(shape, point.x - shape.x, point.y - shape.y),
      },
    };
  }

  if (shape.type === "callout" && handle.type === "calloutTailBase") {
    // Same effective-frame handoff as `calloutTailTip` above.
    const base = snapCalloutTailBasePoint(shape, point.x - shape.x, point.y - shape.y);
    const storedBase = toStoredCalloutPoint(shape, base);
    return {
      ...shape,
      props: {
        ...shape.props,
        tail: {
          ...shape.props.tail,
          [handle.endpoint === "start" ? "baseStart" : "baseEnd"]: storedBase,
        },
      },
    };
  }

  return shape;
}

function getLinePointSnapReference(points: OverlayPoint[], index: number): OverlayPoint | null {
  return points[index - 1] ?? points[index + 1] ?? null;
}
