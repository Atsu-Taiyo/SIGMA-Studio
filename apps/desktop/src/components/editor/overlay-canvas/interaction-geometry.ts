import {
  type Graph2DSpec
} from "@/features/document";
import {
  getShapeBounds,
  getShapeRotation,
  getShapeRotationPivot,
  getSnappedArcInsertDragPoint,
  getSolidPoints,
  isSolidShape
} from "@/features/drawing";
import type {
  PointerEvent as ReactPointerEvent
} from "react";
import {
  buildBlockAnchorAtBoundary,
  pickAnchorBoundaryAtPoint
} from "./anchor";
import { snapPointAround } from "./angle";
import { getImageCoverCrop } from "./image-crop";
import {
  type InsertTool,
  type OverlayInteractionMode,
  type PointHandle
} from "./interaction-mode";
import {
  constrainPointToAspectFromStart,
  pagePointToUnrotatedShapePoint
} from "./math";
import {
  AnchorMeasurements
} from "./selection-handles";
import type { OriginPickPreview } from "./shape-editors";
import {
  getRegularInsertAspect,
  isAngleSnappedInsertTool,
  isArcInsertTool
} from "./shapes/create-shape";
import {
  getGraphRenderLayout
} from "./shapes/graph";
import type {
  OverlayAnchor,
  OverlayAsset,
  OverlayGraphShape,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export function isDragAutoScrollInteraction(mode: OverlayInteractionMode): boolean {
  return mode.id === "overlay.move" ||
    mode.id === "overlay.resize" ||
    mode.id === "overlay.point" ||
    mode.id === "overlay.marquee" ||
    mode.id === "overlay.insertDrag" ||
    mode.id === "overlay.anchor";
}

export function getAnchorDragPosition(mode: Extract<OverlayInteractionMode, { id: "overlay.anchor" }>): OverlayPoint {
  return {
    x: mode.origin.x + mode.current.x - mode.start.x,
    y: mode.origin.y + mode.current.y - mode.start.y,
  };
}

/** Anchor a dropped rule snaps to; null when there is no measurable body text. */
export function pickAnchorForHandleDrop(
  shape: OverlayShape,
  dropPoint: OverlayPoint,
  measurements: AnchorMeasurements,
): OverlayAnchor | null {
  const boundary = pickAnchorBoundaryAtPoint(dropPoint, measurements.ordered, getShapeBounds(shape).y);
  const block = boundary ? measurements.rects.get(boundary.blockId) : undefined;
  if (!boundary || !block) {
    return null;
  }

  const anchor = buildBlockAnchorAtBoundary(boundary, block, shape.y, shape.x);
  return shape.anchor?.type === "block" && shape.anchor.reserveSpace !== undefined
    ? { ...anchor, reserveSpace: shape.anchor.reserveSpace }
    : anchor;
}

export function graphSvgPointFromClient(
  shape: OverlayGraphShape,
  clientX: number,
  clientY: number,
  pagePointFromClient: (clientX: number, clientY: number) => OverlayPoint,
): OverlayPoint | null {
  const pagePoint = pagePointFromClient(clientX, clientY);
  const unrotatedPoint = pagePointToUnrotatedShapePoint(
    pagePoint,
    getShapeRotationPivot(shape),
    getShapeRotation(shape),
    shape.flipX,
    shape.flipY,
  );
  const plotPoint = {
    x: unrotatedPoint.x - shape.x,
    y: unrotatedPoint.y - shape.y,
  };

  if (
    plotPoint.x < 0 ||
    plotPoint.x > shape.props.w ||
    plotPoint.y < 0 ||
    plotPoint.y > shape.props.h
  ) {
    return null;
  }

  const layout = getGraphRenderLayout(shape);
  return {
    x: layout.plotBox.left + plotPoint.x / layout.scaleX,
    y: layout.plotBox.top + plotPoint.y / layout.scaleY,
  };
}

export function areOriginPickPreviewsEqual(a: OriginPickPreview | null, b: OriginPickPreview | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  return a.shapeId === b.shapeId &&
    a.point.x === b.point.x &&
    a.point.y === b.point.y &&
    areGraphViewBoxesEqual(a.spec.viewBox, b.spec.viewBox);
}

export function areGraphViewBoxesEqual(a: Graph2DSpec["viewBox"], b: Graph2DSpec["viewBox"]): boolean {
  return a.xMin === b.xMin &&
    a.xMax === b.xMax &&
    a.yMin === b.yMin &&
    a.yMax === b.yMax;
}

export function getSnappablePointHandlePagePoint(shape: OverlayShape, handle: PointHandle): OverlayPoint | null {
  if (shape.type === "geo" && isSolidShape(shape) && handle.type === "solidVertex") {
    const point = getSolidPoints(shape)[handle.index];
    return point ? { x: shape.x + point.x, y: shape.y + point.y } : null;
  }

  if (shape.type === "line" && handle.type === "line") {
    const point = shape.props.points[handle.index];
    return point ? { x: shape.x + point.x, y: shape.y + point.y } : null;
  }

  if (shape.type === "arrow" && handle.type === "arrow") {
    const point = shape.props[handle.endpoint];
    return { x: shape.x + point.x, y: shape.y + point.y };
  }

  return null;
}

export function getConstrainedInsertDragPoint(
  tool: InsertTool,
  start: OverlayPoint,
  point: OverlayPoint,
  modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
): OverlayPoint {
  const regularAspect = modifiers.ctrlKey ? getRegularInsertAspect(tool) : null;
  if (regularAspect !== null) {
    return constrainPointToAspectFromStart(start, point, regularAspect);
  }

  if (modifiers.shiftKey && isAngleSnappedInsertTool(tool)) {
    return snapPointAround(start, point);
  }

  // arc/sector も、Shiftを押している間だけドラッグ方向を15°刻みにスナップする。
  if (isArcInsertTool(tool)) {
    return getSnappedArcInsertDragPoint(start, point, modifiers.shiftKey);
  }

  return point;
}

export function areImageCropStatesEqual(
  left: Extract<OverlayShape, { type: "image" }>,
  right: Extract<OverlayShape, { type: "image" }>,
  asset: OverlayAsset | undefined,
): boolean {
  if (
    left.x !== right.x ||
    left.y !== right.y ||
    left.props.w !== right.props.w ||
    left.props.h !== right.props.h
  ) {
    return false;
  }

  const leftCrop = getImageCoverCrop(left, asset);
  const rightCrop = getImageCoverCrop(right, asset);
  return leftCrop.topLeft.x === rightCrop.topLeft.x &&
    leftCrop.topLeft.y === rightCrop.topLeft.y &&
    leftCrop.bottomRight.x === rightCrop.bottomRight.x &&
    leftCrop.bottomRight.y === rightCrop.bottomRight.y;
}

export function getImageCropModeShapeId(mode: OverlayInteractionMode): OverlayShapeId | null {
  if (mode.id === "overlay.imageCropping") {
    return mode.shapeId;
  }
  if (mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") {
    return mode.shape.id;
  }
  return null;
}