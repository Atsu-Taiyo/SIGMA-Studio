import { getIdsWithDescendants, isShapeEditPolicyLockedInTree } from "./grouping";
import type { OverlayInteractionAction } from "./interaction-mode";
import type { OverlayShape, OverlayShapeId } from "./types";

/** Shape ids an interaction-mode transition would begin modifying. */
export function getOverlayActionTargetShapeIds(action: OverlayInteractionAction): OverlayShapeId[] {
  switch (action.type) {
    case "startMove":
    case "startResize":
    case "startRotate":
      return action.shapes.map((shape) => shape.id);
    case "startAnchorDrag":
    case "startPoint":
    case "startImageCropResize":
    case "startImageCropPan":
      return [action.shape.id];
    case "editText":
    case "editImageCrop":
    case "editGraph":
    case "editGraph3D":
    case "editTable":
    case "pickOrigin":
    case "pickGraphFill":
      return [action.shapeId];
    default:
      return [];
  }
}

export function isOverlayActionBlockedByEditPolicy(
  action: OverlayInteractionAction,
  shapes: OverlayShape[],
  lockedShapeIds: ReadonlySet<OverlayShapeId>,
): boolean {
  if (lockedShapeIds.size === 0) {
    return false;
  }
  const targetIds = getOverlayActionTargetShapeIds(action);
  if (targetIds.length === 0) {
    return false;
  }
  const shapesById = new Map(shapes.map((shape) => [shape.id, shape]));
  return targetIds.some((id) => {
    const shape = shapesById.get(id);
    return shape ? isShapeEditPolicyLockedInTree(shapes, shape, lockedShapeIds) : false;
  });
}

export function isOverlaySelectionBlockedByEditPolicy(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  lockedShapeIds: ReadonlySet<OverlayShapeId>,
): boolean {
  if (lockedShapeIds.size === 0 || selectedIds.length === 0) {
    return false;
  }
  const involvedIds = getIdsWithDescendants(shapes, selectedIds, { includeGroups: true });
  const shapesById = new Map(shapes.map((shape) => [shape.id, shape]));
  return involvedIds.some((id) => {
    const shape = shapesById.get(id);
    return shape ? isShapeEditPolicyLockedInTree(shapes, shape, lockedShapeIds) : false;
  });
}
