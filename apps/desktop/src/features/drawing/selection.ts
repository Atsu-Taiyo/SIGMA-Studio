import type {
  OverlayAsset,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";

/** Replaces changed shapes without changing canvas stack order or untouched references. */
export function mergeShapesById(
  allShapes: OverlayShape[],
  changedShapes: OverlayShape[],
): OverlayShape[] {
  const changedById = new Map(changedShapes.map((shape) => [shape.id, shape]));
  return allShapes.map((shape) => changedById.get(shape.id) ?? shape);
}

export function sameOverlayShapeIds(
  left: OverlayShapeId[],
  right: OverlayShapeId[],
): boolean {
  if (left === right) {
    return true;
  }

  if (left.length !== right.length) {
    return false;
  }

  return left.every((id, index) => id === right[index]);
}

/**
 * Applies the editor's all-or-add selection toggle without normalizing visual
 * stack order or duplicate ids. The UI boundary keeps owning that final
 * normalization after this deterministic transition.
 */
export function toggleOverlayShapeSelectionIds(
  currentIds: readonly OverlayShapeId[],
  targetIds: readonly OverlayShapeId[],
): OverlayShapeId[] {
  const targetIdSet = new Set(targetIds);
  const shouldRemove = targetIds.every((id) => currentIds.includes(id));
  return shouldRemove
    ? currentIds.filter((id) => !targetIdSet.has(id))
    : [...currentIds, ...targetIds.filter((id) => !currentIds.includes(id))];
}

/**
 * `ids` plus every shape inside the groups among them.
 *
 * A group draws nothing of its own and is filtered out of every render pass, so anything that
 * treats a group as one unit — AI edit locks and the veil that makes them visible above all —
 * has to reach its members itself. Naming only the group id reserves a shape that never reaches
 * the canvas: the edit is refused, but nothing on screen says why.
 */
export function expandShapeIdsWithGroupMembers(
  shapes: readonly OverlayShape[],
  ids: Iterable<OverlayShapeId>,
): OverlayShapeId[] {
  const expanded = new Set(ids);
  if (expanded.size === 0) {
    return [];
  }

  const membersByGroupId = new Map<OverlayShapeId, OverlayShape[]>();
  for (const shape of shapes) {
    if (!shape.parentId) {
      continue;
    }
    membersByGroupId.set(shape.parentId, [...(membersByGroupId.get(shape.parentId) ?? []), shape]);
  }

  const queue = [...expanded];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const member of membersByGroupId.get(id) ?? []) {
      if (expanded.has(member.id)) {
        continue;
      }
      expanded.add(member.id);
      queue.push(member.id);
    }
  }
  return [...expanded];
}

/**
 * Removes selected descendants whose selected ancestor already represents the
 * same transformation unit.
 */
export function getTopmostSelectedShapes(shapes: OverlayShape[]): OverlayShape[] {
  const selectedShapeById = new Map(shapes.map((shape) => [shape.id, shape]));
  return shapes.filter((shape) => {
    let parentId = shape.parentId;
    while (parentId) {
      if (selectedShapeById.has(parentId)) {
        return false;
      }
      parentId = selectedShapeById.get(parentId)?.parentId;
    }

    return true;
  });
}

export function getOnlySelectedTextShape(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  editingShapeId: OverlayShapeId | null,
): Extract<OverlayShape, { type: "text" | "callout" }> | null {
  const shapeId = editingShapeId ?? (selectedIds.length === 1 ? selectedIds[0] : null);
  const shape = shapeId ? shapes.find((item) => item.id === shapeId) : null;
  return shape && isOverlayRichTextShape(shape) ? shape : null;
}

export function isOverlayRichTextShape(
  shape: OverlayShape,
): shape is Extract<OverlayShape, { type: "text" | "callout" }> {
  return shape.type === "text" || shape.type === "callout";
}

export function collectSelectedOverlayAssets(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
): Record<string, OverlayAsset> {
  const selectedAssetIds = new Set(
    shapes.flatMap((shape) => {
      if (shape.type === "image") {
        return [shape.props.assetId];
      }
      if (shape.type === "graph3dShape" && shape.props.previewAssetId) {
        return [shape.props.previewAssetId];
      }
      return [];
    }),
  );

  return Object.fromEntries(
    Object.entries(assets).filter(([assetId]) => selectedAssetIds.has(assetId)),
  );
}

export function sameOverlayShapeReferences(
  left: OverlayShape[],
  right: OverlayShape[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  return left.every((shape, index) => shape === right[index]);
}
