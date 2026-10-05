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

/**
 * 機能が見えなくした図形 (`OverlayEditPolicy.unselectableShapeIds`) は、当たり判定でも
 * 囲み選択でも選ばない。見えない図形が選ばれて動かされると、利用者の知らないうちに文書が変わる。
 */
export function isOverlayShapeUnselectable(
  id: OverlayShapeId,
  unselectable: ReadonlySet<OverlayShapeId> | undefined,
): boolean {
  return unselectable?.has(id) ?? false;
}

/**
 * 選択の候補から、選べない図形を外す。グループは選べない図形を中に持てば選ばない (グループを
 * 選ぶと中の見えない図形も一緒に動き・消え・コピーされる)。⌘A・本文の全選択・本文に結び付いた
 * 図形・囲み選択・クリックのどれも、選択を立てる 1 か所 (`setSelectedShapeIds`) でここを通る。
 */
export function filterSelectableShapeIds(
  ids: OverlayShapeId[],
  unselectable: ReadonlySet<OverlayShapeId> | undefined,
  shapes: OverlayShape[] = [],
): OverlayShapeId[] {
  if (!unselectable || unselectable.size === 0) {
    return ids;
  }
  return ids.filter((id) => (
    !unselectable.has(id)
    && !getIdsWithDescendants(shapes, [id], { includeGroups: true }).some((descendantId) => unselectable.has(descendantId))
  ));
}

/** 選べなくなった図形を今の選択から外した選択。何も外れなければ null (選択を書き換えない)。 */
export function pruneUnselectableSelection(
  selectedIds: OverlayShapeId[],
  shapes: OverlayShape[],
  unselectable: ReadonlySet<OverlayShapeId> | undefined,
): OverlayShapeId[] | null {
  const kept = filterSelectableShapeIds(selectedIds, unselectable, shapes);
  return kept.length === selectedIds.length ? null : kept;
}

