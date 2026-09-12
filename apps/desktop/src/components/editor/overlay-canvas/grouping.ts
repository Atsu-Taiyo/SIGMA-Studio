import { normalizeOverlayGroups } from "@/features/document";
import { getShapeSelectionBounds } from "@/features/drawing";
import {
  getEffectiveShapeOpacity,
  getRenderableShapes,
  getRenderableShapesInReverseVisualStackOrder,
  getRenderableShapesInVisualStackOrder,
  getShapesForStackLayer,
  getShapesInVisualStackOrder,
  isOverlayGroupShape,
  isShapeInBackgroundStack,
  orderShapeIdsByVisualStackOrder,
} from "@/features/rendering/core";

import type { OverlayBounds, OverlayGroupShape, OverlayShape, OverlayShapeId } from "./types";

export {
  getEffectiveShapeOpacity,
  getRenderableShapes,
  getRenderableShapesInReverseVisualStackOrder,
  getRenderableShapesInVisualStackOrder,
  getShapesForStackLayer,
  getShapesInVisualStackOrder,
  isOverlayGroupShape,
  isShapeInBackgroundStack,
  normalizeOverlayGroups,
  orderShapeIdsByVisualStackOrder,
};

type GroupOperationResult = {
  shapes: OverlayShape[];
  selectedIds: OverlayShapeId[];
};

export function groupOverlayShapes(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  createGroupId: () => OverlayShapeId,
): GroupOperationResult {
  const normalized = normalizeOverlayGroups(shapes);
  const selectedUnits = getSelectedTopLevelUnits(normalized, selectedIds);
  if (selectedUnits.length < 2) {
    return { shapes: normalized, selectedIds };
  }

  const commonParent = getCommonParentId(selectedUnits);
  const bounds = getShapesSelectionBounds(selectedUnits);
  if (!bounds) {
    return { shapes: normalized, selectedIds };
  }

  const existingIds = new Set(normalized.map((shape) => shape.id));
  const groupId = createUniqueShapeId(createGroupId, existingIds);
  const groupShape: OverlayGroupShape = {
    id: groupId,
    type: "group",
    x: bounds.x,
    y: bounds.y,
    ...(commonParent ? { parentId: commonParent } : {}),
    props: {
      w: bounds.w,
      h: bounds.h,
    },
  };

  const selectedUnitIds = new Set(selectedUnits.map((shape) => shape.id));
  const firstSelectedIndex = normalized.findIndex((shape) => selectedUnitIds.has(shape.id));
  const reparented = normalized.map((shape) => {
    if (!selectedUnitIds.has(shape.id)) {
      return shape;
    }
    return stripGroupIdMarker({ ...shape, parentId: groupId } as OverlayShape);
  });
  const insertIndex = firstSelectedIndex < 0 ? reparented.length : firstSelectedIndex;
  const next = [
    ...reparented.slice(0, insertIndex),
    groupShape,
    ...reparented.slice(insertIndex),
  ];

  return {
    shapes: normalizeOverlayGroups(next),
    selectedIds: [groupId],
  };
}

export function ungroupOverlayShapes(shapes: OverlayShape[], selectedIds: OverlayShapeId[]): GroupOperationResult {
  const normalized = normalizeOverlayGroups(shapes);
  const selectedSet = new Set(selectedIds);
  const groups = normalized.filter((shape): shape is OverlayGroupShape => isOverlayGroupShape(shape) && selectedSet.has(shape.id));
  if (groups.length === 0) {
    return { shapes: normalized, selectedIds };
  }

  const groupIds = new Set(groups.map((group) => group.id));
  const parentByGroupId = new Map(groups.map((group) => [group.id, group.parentId]));
  const childIds: OverlayShapeId[] = [];
  const next = normalized.flatMap((shape): OverlayShape[] => {
    if (groupIds.has(shape.id)) {
      return [];
    }

    if (shape.parentId && groupIds.has(shape.parentId)) {
      childIds.push(shape.id);
      const nextParentId = parentByGroupId.get(shape.parentId);
      const reparented = { ...shape } as OverlayShape;
      if (nextParentId) {
        reparented.parentId = nextParentId;
      } else {
        delete reparented.parentId;
      }
      return [reparented];
    }

    return [shape];
  });

  const otherSelectedIds = selectedIds.filter((id) => !groupIds.has(id));
  return {
    shapes: normalizeOverlayGroups(next),
    selectedIds: [...otherSelectedIds, ...childIds],
  };
}

export function getSelectableShapeId(
  shapes: OverlayShape[],
  shapeId: OverlayShapeId,
  focusedGroupId: OverlayShapeId | null,
): OverlayShapeId {
  const shape = getShapeById(shapes, shapeId);
  if (!shape) {
    return shapeId;
  }

  if (focusedGroupId && isShapeDescendantOf(shapes, shape.id, focusedGroupId)) {
    return getHighestDescendantBelowParent(shapes, shape, focusedGroupId).id;
  }

  if (focusedGroupId && shape.id === focusedGroupId) {
    return shape.id;
  }

  return getOutermostAncestor(shapes, shape).id;
}

export function getShapeSelectionIds(
  shapes: OverlayShape[],
  shapeId: OverlayShapeId,
  focusedGroupId: OverlayShapeId | null,
): OverlayShapeId[] {
  return [getSelectableShapeId(shapes, shapeId, focusedGroupId)];
}

export function getShapeIdsForCurrentScope(
  shapes: OverlayShape[],
  focusedGroupId: OverlayShapeId | null,
): OverlayShapeId[] {
  return getShapesInVisualStackOrder(shapes)
    .filter((shape) => (shape.parentId ?? null) === focusedGroupId)
    .map((shape) => shape.id);
}

export function isShapeHiddenInTree(shapes: OverlayShape[], shape: OverlayShape): boolean {
  if (shape.hidden) {
    return true;
  }
  return getShapeAncestors(shapes, shape).some((ancestor) => ancestor.hidden);
}

export function isShapeLockedInTree(shapes: OverlayShape[], shape: OverlayShape): boolean {
  if (shape.locked) {
    return true;
  }
  return getShapeAncestors(shapes, shape).some((ancestor) => ancestor.locked);
}

const EMPTY_EDIT_POLICY_LOCKED_SHAPE_IDS: ReadonlySet<OverlayShapeId> = new Set();

/** True when `shape` or one of its ancestor groups is reserved by the host edit policy. */
export function isShapeEditPolicyLockedInTree(
  shapes: OverlayShape[],
  shape: OverlayShape,
  lockedShapeIds: ReadonlySet<OverlayShapeId>,
): boolean {
  if (lockedShapeIds.size === 0) {
    return false;
  }
  if (lockedShapeIds.has(shape.id)) {
    return true;
  }
  return getShapeAncestors(shapes, shape).some((ancestor) => lockedShapeIds.has(ancestor.id));
}

export function getSelectedShapesInStackOrder(shapes: OverlayShape[], selectedIds: OverlayShapeId[]): OverlayShape[] {
  const selectedIdSet = new Set(selectedIds);
  return getShapesInVisualStackOrder(shapes).filter((shape) => selectedIdSet.has(shape.id));
}

export function getSelectedShapesForClipboard(shapes: OverlayShape[], selectedIds: OverlayShapeId[]): OverlayShape[] {
  const expanded = expandShapeIdsToDescendants(shapes, selectedIds, { includeGroups: true });
  const selectedIdSet = new Set(expanded);
  return getShapesInVisualStackOrder(shapes).filter((shape) => selectedIdSet.has(shape.id));
}

export function getUnlockedTransformShapes(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  editPolicyLockedShapeIds: ReadonlySet<OverlayShapeId> = EMPTY_EDIT_POLICY_LOCKED_SHAPE_IDS,
): OverlayShape[] {
  const expanded = expandShapeIdsToDescendants(shapes, selectedIds, { includeGroups: false });
  const selectedIdSet = new Set(expanded);
  return getShapesInVisualStackOrder(shapes)
    .filter((shape) => selectedIdSet.has(shape.id)
      && !isShapeLockedInTree(shapes, shape)
      && !isShapeEditPolicyLockedInTree(shapes, shape, editPolicyLockedShapeIds));
}

export function getIdsWithDescendants(
  shapes: OverlayShape[],
  ids: OverlayShapeId[],
  options: { includeGroups?: boolean } = {},
): OverlayShapeId[] {
  return expandShapeIdsToDescendants(shapes, ids, { includeGroups: options.includeGroups ?? true });
}

export function getMovingShapeIdsWithFullyMovingGroups(
  shapes: OverlayShape[],
  movingShapeIds: ReadonlySet<OverlayShapeId>,
): Set<OverlayShapeId> {
  const ids = new Set(movingShapeIds);
  for (const shape of shapes) {
    if (!isOverlayGroupShape(shape)) {
      continue;
    }
    const descendantShapeIds = shapes
      .filter((candidate) => (
        !isOverlayGroupShape(candidate) &&
        isShapeDescendantOf(shapes, candidate.id, shape.id)
      ))
      .map((candidate) => candidate.id);
    if (descendantShapeIds.length > 0 && descendantShapeIds.every((id) => ids.has(id))) {
      ids.add(shape.id);
    }
  }
  return ids;
}

export function getGroupDescendantIds(shapes: OverlayShape[], groupId: OverlayShapeId): OverlayShapeId[] {
  return shapes
    .filter((shape) => shape.id !== groupId && isShapeDescendantOf(shapes, shape.id, groupId))
    .map((shape) => shape.id);
}

export function isShapeDescendantOf(
  shapes: OverlayShape[],
  shapeId: OverlayShapeId,
  ancestorId: OverlayShapeId,
): boolean {
  const shape = getShapeById(shapes, shapeId);
  if (!shape) {
    return false;
  }

  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (parentId) {
    if (parentId === ancestorId) {
      return true;
    }
    if (seen.has(parentId)) {
      return false;
    }
    seen.add(parentId);
    parentId = getShapeById(shapes, parentId)?.parentId;
  }
  return false;
}

/**
 * True when the shape sits inside a group. Anything a group owns for the whole unit — the body
 * anchor above all — belongs to the group, not to the member.
 */
export function isShapeGroupMember(shapes: OverlayShape[], shape: OverlayShape): boolean {
  return !!shape.parentId && getGroupShape(shapes, shape.parentId) !== null;
}

export function getGroupShape(shapes: OverlayShape[], id: OverlayShapeId | null): OverlayGroupShape | null {
  const shape = id ? getShapeById(shapes, id) : null;
  return shape && isOverlayGroupShape(shape) ? shape : null;
}

function getSelectedTopLevelUnits(shapes: OverlayShape[], selectedIds: OverlayShapeId[]): OverlayShape[] {
  const selectedSet = new Set(selectedIds);
  return shapes.filter((shape) => {
    if (!selectedSet.has(shape.id)) {
      return false;
    }
    return !getShapeAncestors(shapes, shape).some((ancestor) => selectedSet.has(ancestor.id));
  });
}

function expandShapeIdsToDescendants(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  options: { includeGroups: boolean },
): OverlayShapeId[] {
  const selectedUnits = getSelectedTopLevelUnits(shapes, selectedIds);
  const ids: OverlayShapeId[] = [];
  const add = (shape: OverlayShape) => {
    if (options.includeGroups || !isOverlayGroupShape(shape)) {
      ids.push(shape.id);
    }
    for (const child of getDirectChildren(shapes, shape.id)) {
      add(child);
    }
  };
  for (const shape of selectedUnits) {
    add(shape);
  }
  return [...new Set(ids)];
}

function getOutermostAncestor(shapes: OverlayShape[], shape: OverlayShape): OverlayShape {
  let current = shape;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (current.parentId) {
    const parent = getShapeById(shapes, current.parentId);
    if (!parent || seen.has(parent.id)) {
      return current;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function getHighestDescendantBelowParent(
  shapes: OverlayShape[],
  shape: OverlayShape,
  parentId: OverlayShapeId,
): OverlayShape {
  let current = shape;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (current.parentId && current.parentId !== parentId) {
    const parent = getShapeById(shapes, current.parentId);
    if (!parent || seen.has(parent.id)) {
      return current;
    }
    seen.add(parent.id);
    current = parent;
  }
  return current;
}

function getDirectChildren(shapes: OverlayShape[], parentId: OverlayShapeId): OverlayShape[] {
  return shapes.filter((shape) => shape.parentId === parentId);
}

function getShapeAncestors(shapes: OverlayShape[], shape: OverlayShape): OverlayShape[] {
  const ancestors: OverlayShape[] = [];
  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (parentId) {
    const parent = getShapeById(shapes, parentId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    ancestors.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors;
}

function getCommonParentId(shapes: OverlayShape[]): OverlayShapeId | undefined {
  if (shapes.length === 0) {
    return undefined;
  }
  const parentId = shapes[0].parentId;
  return shapes.every((shape) => shape.parentId === parentId) ? parentId : undefined;
}

function getShapeById(shapes: OverlayShape[], id: OverlayShapeId): OverlayShape | undefined {
  return shapes.find((shape) => shape.id === id);
}

function stripGroupIdMarker<T extends OverlayShape>(shape: T): T {
  if (!shape.groupId) {
    return shape;
  }
  const next = { ...shape } as T;
  delete next.groupId;
  return next;
}

function createUniqueShapeId(createId: () => OverlayShapeId, existingIds: Set<OverlayShapeId>): OverlayShapeId {
  let id = createId();
  let index = 1;
  while (existingIds.has(id)) {
    id = `${createId()}_${index}`;
    index += 1;
  }
  existingIds.add(id);
  return id;
}

function getShapesSelectionBounds(shapes: OverlayShape[]): OverlayBounds | null {
  if (shapes.length === 0) {
    return null;
  }
  return shapes
    .map(getShapeSelectionBounds)
    .reduce((bounds, next) => unionBounds(bounds, next));
}

function unionBounds(a: OverlayBounds, b: OverlayBounds): OverlayBounds {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}
