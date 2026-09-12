import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";

import {
  normalizeAngle,
  snapRotationDeltaToAbsoluteStep,
} from "./angle";
import { angleFromCenter } from "./math";
import type { OverlayTool } from "./overlay-tool";

export type ResizeHandle = "nw" | "n" | "ne" | "e" | "se" | "s" | "sw" | "w";
export type PointHandle =
  | { type: "line"; index: number }
  | { type: "arrow"; endpoint: "start" | "end" }
  | { type: "arc"; endpoint: "start" | "end" }
  | { type: "arcRadius" }
  | { type: "triangleApex" }
  | { type: "blockArrowHead" }
  | { type: "blockArrowShaft" }
  | { type: "calloutTailTip" }
  | { type: "calloutTailBase"; endpoint: "start" | "end" }
  | { type: "calloutCornerRadius" };

export type InsertTool = Extract<OverlayTool, { kind: "insert" }>;

export type OverlayInteractionMode =
  | { id: "overlay.select"; tool: OverlayTool }
  | {
      id: "overlay.move";
      tool: OverlayTool;
      shapes: OverlayShape[];
      start: OverlayPoint;
      offset: OverlayPoint | null;
      editOnPointerUp?: "text" | "table";
    }
  | {
      id: "overlay.resize";
      tool: OverlayTool;
      shapes: OverlayShape[];
      handle: ResizeHandle;
      start: OverlayPoint;
      bounds: OverlayBounds;
      rotation: number;
    }
  | { id: "overlay.rotate"; tool: OverlayTool; shapes: OverlayShape[]; center: OverlayPoint; startAngle: number }
  | { id: "overlay.anchor"; tool: OverlayTool; shape: OverlayShape; start: OverlayPoint; current: OverlayPoint; origin: OverlayPoint }
  | { id: "overlay.marquee"; tool: OverlayTool; start: OverlayPoint; current: OverlayPoint; additive: boolean; selectOnClick?: boolean }
  | { id: "overlay.point"; tool: OverlayTool; shape: OverlayShape; handle: PointHandle; pivot: OverlayPoint; rotation: number }
  | { id: "overlay.textEditing"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.imageCropping"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.imageCropResize"; tool: OverlayTool; shape: Extract<OverlayShape, { type: "image" }>; handle: ResizeHandle; start: OverlayPoint }
  | { id: "overlay.imageCropPan"; tool: OverlayTool; shape: Extract<OverlayShape, { type: "image" }>; start: OverlayPoint }
  | { id: "overlay.graphEditing"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.graph3dEditing"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.tableEditing"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.originPicking"; tool: OverlayTool; shapeId: OverlayShapeId; initial: boolean }
  | { id: "overlay.graphFillPicking"; tool: OverlayTool; shapeId: OverlayShapeId }
  | { id: "overlay.curveDrawing"; tool: InsertTool; points: OverlayPoint[]; current: OverlayPoint }
  | { id: "overlay.insertDrag"; tool: InsertTool; start: OverlayPoint; current: OverlayPoint; points?: OverlayPoint[] };

export type OverlayInteractionAction =
  | { type: "select" }
  | { type: "setTool"; tool: OverlayTool }
  | { type: "startMove"; shapes: OverlayShape[]; start: OverlayPoint; editOnPointerUp?: "text" | "table" }
  | { type: "updateMove"; offset: OverlayPoint }
  | { type: "startResize"; shapes: OverlayShape[]; handle: ResizeHandle; start: OverlayPoint; bounds: OverlayBounds }
  | { type: "startRotate"; shapes: OverlayShape[]; center: OverlayPoint; startAngle: number }
  | { type: "startAnchorDrag"; shape: OverlayShape; start: OverlayPoint; origin: OverlayPoint }
  | { type: "updateAnchorDrag"; current: OverlayPoint }
  | { type: "startMarquee"; start: OverlayPoint; additive: boolean; selectOnClick?: boolean }
  | { type: "updateMarquee"; current: OverlayPoint }
  | { type: "startPoint"; shape: OverlayShape; handle: PointHandle; pivot: OverlayPoint; rotation: number }
  | { type: "editText"; shapeId: OverlayShapeId }
  | { type: "editImageCrop"; shapeId: OverlayShapeId }
  | { type: "startImageCropResize"; shape: Extract<OverlayShape, { type: "image" }>; handle: ResizeHandle; start: OverlayPoint }
  | { type: "startImageCropPan"; shape: Extract<OverlayShape, { type: "image" }>; start: OverlayPoint }
  | { type: "editGraph"; shapeId: OverlayShapeId }
  | { type: "editGraph3D"; shapeId: OverlayShapeId }
  | { type: "editTable"; shapeId: OverlayShapeId }
  | { type: "pickOrigin"; shapeId: OverlayShapeId; initial?: boolean }
  | { type: "pickGraphFill"; shapeId: OverlayShapeId }
  | { type: "startCurveDrawing"; tool: InsertTool; point: OverlayPoint }
  | { type: "addCurvePoint"; point: OverlayPoint }
  | { type: "removeLastCurvePoint" }
  | { type: "updateCurveDrawing"; current: OverlayPoint }
  | { type: "startInsertDrag"; tool: InsertTool; start: OverlayPoint; points?: OverlayPoint[] }
  | { type: "updateInsertDrag"; current: OverlayPoint; point?: OverlayPoint };

const SELECT_TOOL: OverlayTool = { kind: "select" };

export function overlayInteractionModeReducer(
  mode: OverlayInteractionMode,
  action: OverlayInteractionAction,
): OverlayInteractionMode {
  const currentTool = mode.tool;

  switch (action.type) {
    case "select":
      if (mode.id === "overlay.select") {
        return mode;
      }
      return { id: "overlay.select", tool: currentTool };
    case "setTool":
      return { id: "overlay.select", tool: action.tool };
    case "startMove":
      return {
        id: "overlay.move",
        tool: currentTool,
        shapes: action.shapes,
        start: action.start,
        offset: null,
        editOnPointerUp: action.editOnPointerUp,
      };
    case "updateMove":
      if (mode.id !== "overlay.move" || arePointsEqual(mode.offset, action.offset)) {
        return mode;
      }
      return {
        ...mode,
        offset: action.offset,
      };
    case "startResize":
      return {
        id: "overlay.resize",
        tool: currentTool,
        shapes: action.shapes,
        handle: action.handle,
        start: action.start,
        bounds: action.bounds,
        rotation: action.shapes.length === 1
          ? getInteractionShapeRotation(action.shapes[0])
          : 0,
      };
    case "startRotate":
      return {
        id: "overlay.rotate",
        tool: currentTool,
        shapes: action.shapes,
        center: action.center,
        startAngle: action.startAngle,
      };
    case "startAnchorDrag":
      return {
        id: "overlay.anchor",
        tool: currentTool,
        shape: action.shape,
        start: action.start,
        current: action.start,
        origin: action.origin,
      };
    case "updateAnchorDrag":
      return mode.id === "overlay.anchor" ? { ...mode, current: action.current } : mode;
    case "startMarquee":
      return {
        id: "overlay.marquee",
        tool: currentTool,
        start: action.start,
        current: action.start,
        additive: action.additive,
        selectOnClick: action.selectOnClick,
      };
    case "updateMarquee":
      return mode.id === "overlay.marquee" ? { ...mode, current: action.current } : mode;
    case "startPoint":
      return {
        id: "overlay.point",
        tool: currentTool,
        shape: action.shape,
        handle: action.handle,
        pivot: action.pivot,
        rotation: action.rotation,
      };
    case "editText":
      return { id: "overlay.textEditing", tool: currentTool, shapeId: action.shapeId };
    case "editImageCrop":
      return { id: "overlay.imageCropping", tool: currentTool, shapeId: action.shapeId };
    case "startImageCropResize":
      return { id: "overlay.imageCropResize", tool: currentTool, shape: action.shape, handle: action.handle, start: action.start };
    case "startImageCropPan":
      return { id: "overlay.imageCropPan", tool: currentTool, shape: action.shape, start: action.start };
    case "editGraph":
      return { id: "overlay.graphEditing", tool: currentTool, shapeId: action.shapeId };
    case "editGraph3D":
      return { id: "overlay.graph3dEditing", tool: currentTool, shapeId: action.shapeId };
    case "editTable":
      return { id: "overlay.tableEditing", tool: currentTool, shapeId: action.shapeId };
    case "pickOrigin":
      return { id: "overlay.originPicking", tool: currentTool, shapeId: action.shapeId, initial: action.initial === true };
    case "pickGraphFill":
      return { id: "overlay.graphFillPicking", tool: currentTool, shapeId: action.shapeId };
    case "startCurveDrawing":
      return {
        id: "overlay.curveDrawing",
        tool: action.tool,
        points: [action.point],
        current: action.point,
      };
    case "addCurvePoint":
      return mode.id === "overlay.curveDrawing"
        ? { ...mode, points: appendDistinctPoint(mode.points, action.point), current: action.point }
        : mode;
    case "removeLastCurvePoint":
      if (mode.id !== "overlay.curveDrawing") {
        return mode;
      }
      if (mode.points.length <= 1) {
        return { id: "overlay.select", tool: SELECT_TOOL };
      }
      return {
        ...mode,
        points: mode.points.slice(0, -1),
        current: mode.points[mode.points.length - 2],
      };
    case "updateCurveDrawing":
      return mode.id === "overlay.curveDrawing" ? { ...mode, current: action.current } : mode;
    case "startInsertDrag":
      return {
        id: "overlay.insertDrag",
        tool: action.tool,
        start: action.start,
        current: action.start,
        points: action.points,
      };
    case "updateInsertDrag":
      if (mode.id !== "overlay.insertDrag") {
        return mode;
      }
      return {
        ...mode,
        current: action.current,
        points: action.point ? appendDistinctPoint(mode.points, action.point) : mode.points,
      };
  }
}

export function createInitialOverlayInteractionMode(): OverlayInteractionMode {
  return { id: "overlay.select", tool: SELECT_TOOL };
}

export function getOverlayTool(mode: OverlayInteractionMode): OverlayTool {
  return mode.tool;
}

export function getMoveOffset(mode: OverlayInteractionMode): OverlayPoint | null {
  return mode.id === "overlay.move" ? mode.offset : null;
}

/**
 * Resolves one pointer position against the immutable rotate-session snapshot.
 * Shift snaps the final page rotation for a single shape to an absolute angle;
 * multi-shape rotation keeps the existing neutral selection-rotation baseline.
 */
export function resolveRotatePointerDelta(
  mode: Extract<OverlayInteractionMode, { id: "overlay.rotate" }>,
  point: OverlayPoint,
  snapToAbsoluteStep: boolean,
): number {
  const nextAngle = angleFromCenter(mode.center, point);
  const delta = normalizeAngle(nextAngle - mode.startAngle);
  if (!snapToAbsoluteStep) {
    return delta;
  }

  const startRotation = mode.shapes.length === 1
    ? getInteractionShapeRotation(mode.shapes[0])
    : 0;
  return snapRotationDeltaToAbsoluteStep(startRotation, delta);
}

export type OverlayMovePointerUpResolution =
  | { kind: "edit"; editor: "text" | "table"; shapeId: OverlayShapeId }
  | { kind: "commit"; offset: OverlayPoint }
  | { kind: "noop" };

/**
 * Resolves the semantic end of a move session.
 *
 * The edit threshold intentionally uses the unsnapped release point while a
 * committed move uses the snapped preview offset stored in the mode. Keeping
 * those two values separate preserves click-to-edit near snap targets.
 */
export function resolveMovePointerUp(
  mode: Extract<OverlayInteractionMode, { id: "overlay.move" }>,
  releasePoint: OverlayPoint,
  editThreshold = 3,
): OverlayMovePointerUpResolution {
  if (
    mode.editOnPointerUp &&
    Math.hypot(releasePoint.x - mode.start.x, releasePoint.y - mode.start.y) < editThreshold
  ) {
    const targetShape = mode.shapes[0];
    if (targetShape) {
      return {
        kind: "edit",
        editor: mode.editOnPointerUp,
        shapeId: targetShape.id,
      };
    }
  }

  if (mode.offset && (mode.offset.x !== 0 || mode.offset.y !== 0)) {
    return { kind: "commit", offset: mode.offset };
  }

  return { kind: "noop" };
}

export function getEditingShapeId(mode: OverlayInteractionMode): OverlayShapeId | null {
  if (
    mode.id === "overlay.textEditing" ||
    mode.id === "overlay.imageCropping" ||
    mode.id === "overlay.graphEditing" ||
    mode.id === "overlay.graph3dEditing" ||
    mode.id === "overlay.tableEditing"
  ) {
    return mode.shapeId;
  }

  if (mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") {
    return mode.shape.id;
  }

  return null;
}

export function getOriginPickShapeId(mode: OverlayInteractionMode): OverlayShapeId | null {
  return mode.id === "overlay.originPicking" ? mode.shapeId : null;
}

export function isInitialOriginPickMode(mode: OverlayInteractionMode): boolean {
  return mode.id === "overlay.originPicking" && mode.initial;
}

export function getGraphFillPickShapeId(mode: OverlayInteractionMode): OverlayShapeId | null {
  return mode.id === "overlay.graphFillPicking" ? mode.shapeId : null;
}

export function isInteractionMode(mode: OverlayInteractionMode): mode is Extract<
  OverlayInteractionMode,
  | { id: "overlay.move" }
  | { id: "overlay.resize" }
  | { id: "overlay.rotate" }
  | { id: "overlay.anchor" }
  | { id: "overlay.marquee" }
  | { id: "overlay.point" }
  | { id: "overlay.imageCropResize" }
  | { id: "overlay.imageCropPan" }
  | { id: "overlay.curveDrawing" }
  | { id: "overlay.insertDrag" }
> {
  return mode.id === "overlay.move" ||
    mode.id === "overlay.resize" ||
    mode.id === "overlay.rotate" ||
    mode.id === "overlay.anchor" ||
    mode.id === "overlay.marquee" ||
    mode.id === "overlay.point" ||
    mode.id === "overlay.imageCropResize" ||
    mode.id === "overlay.imageCropPan" ||
    mode.id === "overlay.curveDrawing" ||
    mode.id === "overlay.insertDrag";
}

function appendDistinctPoint(points: OverlayPoint[] | undefined, point: OverlayPoint): OverlayPoint[] {
  if (!points || points.length === 0) {
    return [point];
  }

  const previous = points[points.length - 1];
  if (Math.hypot(point.x - previous.x, point.y - previous.y) < 1.5) {
    return points;
  }

  return [...points, point];
}

function arePointsEqual(left: OverlayPoint | null, right: OverlayPoint): boolean {
  return left !== null && left.x === right.x && left.y === right.y;
}

function getInteractionShapeRotation(shape: OverlayShape): number {
  if (shape.type === "tableShape" || shape.type === "group") {
    return 0;
  }
  return typeof shape.rotation === "number" && Number.isFinite(shape.rotation)
    ? shape.rotation
    : 0;
}
