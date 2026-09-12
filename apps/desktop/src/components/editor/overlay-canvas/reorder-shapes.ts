import {
  normalizeOverlayGroups,
  type OverlayShape,
  type OverlayShapeId,
} from "@/features/document";
import { getShapeSelectionBounds } from "@/features/drawing";

export type OverlayArrangeAction =
  | "front"
  | "back"
  | "forward"
  | "backward";

export function reorderShapes(
  allShapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  action: OverlayArrangeAction,
): OverlayShape[] {
  const shapes = normalizeOverlayGroups(allShapes);
  const selected = new Set(selectedIds);
  const moving = new Set(
    shapes
      .filter(
        (shape) => selected.has(shape.id)
          && !hasSelectedAncestor(shape, shapes, selected),
      )
      .map((shape) => shape.id),
  );
  if (moving.size === 0) {
    return shapes;
  }

  const childrenByParent = getChildrenByParent(shapes);
  const reorderedChildren = new Map<string, OverlayShape[]>();
  for (const [parentKey, children] of childrenByParent) {
    const movingInParent = children.filter((shape) => moving.has(shape.id));
    if (movingInParent.length === 0) {
      reorderedChildren.set(parentKey, children);
      continue;
    }

    reorderedChildren.set(
      parentKey,
      reorderSiblingShapes(children, moving, action),
    );
  }

  return applyArrangeStackLayer(
    normalizeOverlayGroups(
      flattenByHierarchy(shapes, reorderedChildren),
    ),
    moving,
    action,
  );
}

function reorderSiblingShapes(
  children: OverlayShape[],
  moving: ReadonlySet<OverlayShapeId>,
  action: OverlayArrangeAction,
): OverlayShape[] {
  if (action === "front" || action === "back") {
    const movingShapes = children.filter((shape) => moving.has(shape.id));
    const otherShapes = children.filter((shape) => !moving.has(shape.id));
    return action === "front"
      ? [...otherShapes, ...movingShapes]
      : [...movingShapes, ...otherShapes];
  }

  const next = children.slice();
  if (action === "forward") {
    for (let index = next.length - 2; index >= 0; index -= 1) {
      const shape = next[index];
      if (moving.has(shape.id)) {
        const targetIndex = findForwardTargetIndex(
          next,
          index,
          moving,
        );
        if (targetIndex > index) {
          next.splice(index, 1);
          next.splice(targetIndex, 0, shape);
        }
      }
    }
    return next;
  }

  for (let index = 1; index < next.length; index += 1) {
    const shape = next[index];
    if (moving.has(shape.id)) {
      const targetIndex = findBackwardTargetIndex(
        next,
        index,
        moving,
      );
      if (targetIndex < index) {
        next.splice(index, 1);
        next.splice(targetIndex, 0, shape);
      }
    }
  }
  return next;
}

function applyArrangeStackLayer(
  shapes: OverlayShape[],
  moving: ReadonlySet<OverlayShapeId>,
  action: OverlayArrangeAction,
): OverlayShape[] {
  const targetIds = getMovingShapeTreeIds(shapes, moving);
  if (targetIds.size === 0) {
    return shapes;
  }

  const nextLayer = action === "back"
    ? "background"
    : undefined;
  let changed = false;
  const nextShapes = shapes.map((shape) => {
    if (!targetIds.has(shape.id)) {
      return shape;
    }

    if (nextLayer) {
      if (shape.stackLayer === nextLayer) {
        return shape;
      }
      changed = true;
      return { ...shape, stackLayer: nextLayer } as OverlayShape;
    }

    if (shape.stackLayer === undefined) {
      return shape;
    }
    const next = { ...shape } as OverlayShape;
    delete next.stackLayer;
    changed = true;
    return next;
  });

  return changed
    ? nextShapes
    : shapes;
}

function getMovingShapeTreeIds(
  shapes: OverlayShape[],
  moving: ReadonlySet<OverlayShapeId>,
): Set<OverlayShapeId> {
  const targetIds = new Set<OverlayShapeId>();
  const visit = (shape: OverlayShape) => {
    if (targetIds.has(shape.id)) {
      return;
    }
    targetIds.add(shape.id);
    for (const child of shapes.filter(
      (item) => item.parentId === shape.id,
    )) {
      visit(child);
    }
  };

  for (const shape of shapes) {
    if (moving.has(shape.id)) {
      visit(shape);
    }
  }
  return targetIds;
}

function findForwardTargetIndex(
  children: OverlayShape[],
  index: number,
  moving: ReadonlySet<OverlayShapeId>,
): number {
  const shape = children[index];
  for (
    let candidateIndex = index + 1;
    candidateIndex < children.length;
    candidateIndex += 1
  ) {
    const candidate = children[candidateIndex];
    if (
      !moving.has(candidate.id)
      && shapeBoundsIntersect(shape, candidate)
    ) {
      return candidateIndex;
    }
  }
  for (
    let candidateIndex = index + 1;
    candidateIndex < children.length;
    candidateIndex += 1
  ) {
    if (!moving.has(children[candidateIndex].id)) {
      return candidateIndex;
    }
  }
  return index;
}

function findBackwardTargetIndex(
  children: OverlayShape[],
  index: number,
  moving: ReadonlySet<OverlayShapeId>,
): number {
  const shape = children[index];
  for (
    let candidateIndex = index - 1;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    const candidate = children[candidateIndex];
    if (
      !moving.has(candidate.id)
      && shapeBoundsIntersect(shape, candidate)
    ) {
      return candidateIndex;
    }
  }
  for (
    let candidateIndex = index - 1;
    candidateIndex >= 0;
    candidateIndex -= 1
  ) {
    if (!moving.has(children[candidateIndex].id)) {
      return candidateIndex;
    }
  }
  return index;
}

function shapeBoundsIntersect(
  a: OverlayShape,
  b: OverlayShape,
): boolean {
  const aBounds = getShapeSelectionBounds(a);
  const bBounds = getShapeSelectionBounds(b);
  return aBounds.x <= bBounds.x + bBounds.w
    && aBounds.x + aBounds.w >= bBounds.x
    && aBounds.y <= bBounds.y + bBounds.h
    && aBounds.y + aBounds.h >= bBounds.y;
}

function getChildrenByParent(
  shapes: OverlayShape[],
): Map<string, OverlayShape[]> {
  const childrenByParent = new Map<string, OverlayShape[]>();
  for (const shape of shapes) {
    const key = shape.parentId ?? "";
    childrenByParent.set(
      key,
      [...(childrenByParent.get(key) ?? []), shape],
    );
  }
  return childrenByParent;
}

function flattenByHierarchy(
  shapes: OverlayShape[],
  childrenByParent: Map<string, OverlayShape[]>,
): OverlayShape[] {
  const ordered: OverlayShape[] = [];
  const emitted = new Set<OverlayShapeId>();
  const visit = (shape: OverlayShape) => {
    if (emitted.has(shape.id)) {
      return;
    }
    emitted.add(shape.id);
    ordered.push(shape);
    if (shape.type === "group") {
      for (const child of childrenByParent.get(shape.id) ?? []) {
        visit(child);
      }
    }
  };

  for (const shape of childrenByParent.get("") ?? []) {
    visit(shape);
  }
  for (const shape of shapes) {
    visit(shape);
  }
  return ordered;
}

function hasSelectedAncestor(
  shape: OverlayShape,
  shapes: OverlayShape[],
  selected: ReadonlySet<OverlayShapeId>,
): boolean {
  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (parentId) {
    if (selected.has(parentId)) {
      return true;
    }
    if (seen.has(parentId)) {
      return false;
    }
    seen.add(parentId);
    parentId = shapes.find((item) => item.id === parentId)?.parentId;
  }
  return false;
}
