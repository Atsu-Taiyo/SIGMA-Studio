import type {
  OverlayGroupShape,
  OverlayShape,
  OverlayShapeId,
  OverlayStackLayer,
} from "@/features/document";

export function isOverlayGroupShape(shape: OverlayShape): shape is OverlayGroupShape {
  return shape.type === "group";
}

export function getRenderableShapes(shapes: OverlayShape[]): OverlayShape[] {
  return shapes.filter(
    (shape) => !isOverlayGroupShape(shape) && !isShapeHiddenInTree(shapes, shape),
  );
}

export function getShapesInVisualStackOrder(shapes: OverlayShape[]): OverlayShape[] {
  const backgroundShapes: OverlayShape[] = [];
  const foregroundShapes: OverlayShape[] = [];
  for (const shape of shapes) {
    if (isShapeInBackgroundStack(shapes, shape)) {
      backgroundShapes.push(shape);
    } else {
      foregroundShapes.push(shape);
    }
  }
  return [...backgroundShapes, ...foregroundShapes];
}

export function getRenderableShapesInVisualStackOrder(shapes: OverlayShape[]): OverlayShape[] {
  return getShapesInVisualStackOrder(shapes).filter(
    (shape) => !isOverlayGroupShape(shape) && !isShapeHiddenInTree(shapes, shape),
  );
}

export function getRenderableShapesInReverseVisualStackOrder(shapes: OverlayShape[]): OverlayShape[] {
  return getRenderableShapesInVisualStackOrder(shapes).reverse();
}

export function orderShapeIdsByVisualStackOrder(
  shapes: OverlayShape[],
  ids: OverlayShapeId[],
): OverlayShapeId[] {
  const remainingIds = new Set(ids);
  const orderedIds: OverlayShapeId[] = [];
  for (const shape of getShapesInVisualStackOrder(shapes)) {
    if (remainingIds.delete(shape.id)) {
      orderedIds.push(shape.id);
    }
  }
  for (const id of ids) {
    if (remainingIds.delete(id)) {
      orderedIds.push(id);
    }
  }
  return orderedIds;
}

export function isShapeInBackgroundStack(
  shapes: OverlayShape[],
  shape: OverlayShape,
): boolean {
  return shape.stackLayer === "background"
    || getShapeAncestors(shapes, shape).some(
      (ancestor) => ancestor.stackLayer === "background",
    );
}

export function getShapesForStackLayer(
  shapes: OverlayShape[],
  stackLayer: OverlayStackLayer,
): OverlayShape[] {
  if (stackLayer === "foreground") {
    return shapes.filter((shape) => !isShapeInBackgroundStack(shapes, shape));
  }

  const backgroundIds = new Set<OverlayShapeId>();
  for (const shape of shapes) {
    if (!isShapeInBackgroundStack(shapes, shape)) {
      continue;
    }
    backgroundIds.add(shape.id);
    for (const ancestor of getShapeAncestors(shapes, shape)) {
      backgroundIds.add(ancestor.id);
    }
  }
  return shapes.filter((shape) => backgroundIds.has(shape.id));
}

export function getEffectiveShapeOpacity(
  shapes: OverlayShape[],
  shape: OverlayShape,
): number | undefined {
  let opacity = shape.opacity ?? 1;
  for (const ancestor of getShapeAncestors(shapes, shape)) {
    opacity *= ancestor.opacity ?? 1;
  }
  return opacity === 1 ? undefined : opacity;
}

function isShapeHiddenInTree(shapes: OverlayShape[], shape: OverlayShape): boolean {
  if (shape.hidden) {
    return true;
  }
  return getShapeAncestors(shapes, shape).some((ancestor) => ancestor.hidden);
}

/**
 * `shapes` 配列 1 本につき id → shape の索引を 1 つだけ作る。
 *
 * 祖先解決は「図形ごとに」呼ばれる (`getEffectiveShapeOpacity` の呼び出し元 overlay-svg.ts:152 /
 * PageRunningRegionOverlay.tsx:55 / OverlayCanvasEditorClient.tsx:4412 はいずれもループの中)。
 * 呼び出しのたびに索引を作り直すと結局 O(S^2) なので、配列の identity で覚える。
 *
 * 前提: projection へ渡した配列は破壊的に変更されない (overlay の shapes は state として
 * 毎回作り直される)。壊すと索引が古い shape を返すので、配列を作り替える形で更新すること。
 */
const shapeIndexByArray = new WeakMap<readonly OverlayShape[], Map<OverlayShapeId, OverlayShape>>();

function getShapeIndex(shapes: OverlayShape[]): Map<OverlayShapeId, OverlayShape> {
  const cached = shapeIndexByArray.get(shapes);
  if (cached) {
    return cached;
  }
  const index = new Map<OverlayShapeId, OverlayShape>();
  for (const shape of shapes) {
    // 同じ id が 2 つあるときは先頭を採る = 置き換え前の `shapes.find` と同じ意味。
    if (!index.has(shape.id)) {
      index.set(shape.id, shape);
    }
  }
  shapeIndexByArray.set(shapes, index);
  return index;
}

function getShapeAncestors(shapes: OverlayShape[], shape: OverlayShape): OverlayShape[] {
  const ancestors: OverlayShape[] = [];
  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  const index = getShapeIndex(shapes);
  while (parentId) {
    const parent = index.get(parentId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    ancestors.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return ancestors;
}
