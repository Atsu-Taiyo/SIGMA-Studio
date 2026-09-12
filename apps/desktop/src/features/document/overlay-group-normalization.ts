import type {
  OverlayBounds,
  OverlayGroupShape,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
} from "./overlay-model";
import { migrateLegacyGraphShapeToPlotBounds } from "./overlay-graph-migration";
import { getOverlayTextBlocksLineCount } from "./overlay-rich-text-format";
import { getTextShapeRenderedLineHeightPx } from "./overlay-text-font";

const MIN_ARC_RADIUS = 0.5;
const MIN_TEXT_SHAPE_WIDTH = 8;
const POINT_SHAPE_PADDING = 10;

/**
 * Canonicalizes persisted group markers, parent links, hierarchy order, and
 * derived group bounds without depending on the editor canvas.
 */
export function normalizeOverlayGroups(inputShapes: OverlayShape[]): OverlayShape[] {
  let shapes = normalizeGroupIdMarkers(inputShapes);
  for (let index = 0; index < 4; index += 1) {
    const next = orderShapesByHierarchy(updateGroupBounds(dissolveDegenerateGroups(repairGroupParents(shapes))));
    if (sameShapeList(shapes, next)) {
      return next;
    }
    shapes = next;
  }
  return shapes;
}

function normalizeGroupIdMarkers(shapes: OverlayShape[]): OverlayShape[] {
  const groups = new Map<string, OverlayShape[]>();
  for (const shape of shapes) {
    if (shape.type === "group" || !shape.groupId) {
      continue;
    }
    groups.set(shape.groupId, [...(groups.get(shape.groupId) ?? []), shape]);
  }

  if (groups.size === 0) {
    return shapes.map(stripGroupIdMarker);
  }

  const usedIds = new Set(shapes.map((shape) => shape.id));
  const groupIdMap = new Map<string, OverlayShapeId>();
  const groupShapesByInsertIndex = new Map<number, OverlayGroupShape[]>();
  for (const [groupIdMarker, members] of groups) {
    if (members.length < 2) {
      continue;
    }
    const bounds = getShapesSelectionBounds(members);
    if (!bounds) {
      continue;
    }
    const id = createUniqueShapeId(() => groupIdMarker, usedIds);
    groupIdMap.set(groupIdMarker, id);
    const firstIndex = Math.max(0, shapes.findIndex((shape) => shape.groupId === groupIdMarker));
    const groupShape: OverlayGroupShape = {
      id,
      type: "group",
      x: bounds.x,
      y: bounds.y,
      props: {
        w: bounds.w,
        h: bounds.h,
      },
    };
    groupShapesByInsertIndex.set(firstIndex, [...(groupShapesByInsertIndex.get(firstIndex) ?? []), groupShape]);
  }

  const migrated: OverlayShape[] = [];
  shapes.forEach((shape, index) => {
    const groupShapes = groupShapesByInsertIndex.get(index);
    if (groupShapes) {
      migrated.push(...groupShapes);
    }
    const groupIdMarker = shape.groupId;
    const next = stripGroupIdMarker(shape);
    const parentId = groupIdMarker ? groupIdMap.get(groupIdMarker) : undefined;
    migrated.push(parentId ? ({ ...next, parentId } as OverlayShape) : next);
  });

  return migrated;
}

function repairGroupParents(shapes: OverlayShape[]): OverlayShape[] {
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  let changed = false;
  const repaired = shapes.map((shape) => {
    if (!shape.parentId) {
      return shape;
    }

    const parent = byId.get(shape.parentId);
    if (!parent || parent.type !== "group" || parent.id === shape.id || hasParentCycle(shape, byId)) {
      const next = { ...shape } as OverlayShape;
      delete next.parentId;
      changed = true;
      return next;
    }

    return shape;
  });

  return changed ? repaired : shapes;
}

function dissolveDegenerateGroups(shapes: OverlayShape[]): OverlayShape[] {
  const childrenByParent = getChildrenByParent(shapes);
  const groupIdsToRemove = new Set(
    shapes
      .filter((shape): shape is OverlayGroupShape => shape.type === "group")
      .filter((group) => (childrenByParent.get(group.id)?.length ?? 0) <= 1)
      .map((group) => group.id),
  );
  if (groupIdsToRemove.size === 0) {
    return shapes;
  }

  const parentByGroupId = new Map(
    shapes
      .filter((shape): shape is OverlayGroupShape => shape.type === "group" && groupIdsToRemove.has(shape.id))
      .map((group) => [group.id, group.parentId]),
  );

  return shapes.flatMap((shape): OverlayShape[] => {
    if (groupIdsToRemove.has(shape.id)) {
      return [];
    }
    if (shape.parentId && groupIdsToRemove.has(shape.parentId)) {
      const parentId = parentByGroupId.get(shape.parentId);
      const next = { ...shape } as OverlayShape;
      if (parentId) {
        next.parentId = parentId;
      } else {
        delete next.parentId;
      }
      return [next];
    }
    return [shape];
  });
}

function updateGroupBounds(shapes: OverlayShape[]): OverlayShape[] {
  const childrenByParent = getChildrenByParent(shapes);
  const depthById = new Map(shapes.map((shape) => [shape.id, getShapeDepth(shape, shapes)]));
  const groups = shapes
    .filter((shape): shape is OverlayGroupShape => shape.type === "group")
    .sort((a, b) => (depthById.get(b.id) ?? 0) - (depthById.get(a.id) ?? 0));
  if (groups.length === 0) {
    return shapes;
  }

  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  let changed = false;
  for (const group of groups) {
    const children = (childrenByParent.get(group.id) ?? []).map((child) => byId.get(child.id) ?? child);
    const bounds = getShapesSelectionBounds(children);
    if (!bounds) {
      continue;
    }
    if (!sameBounds(bounds, { x: group.x, y: group.y, w: group.props.w, h: group.props.h })) {
      byId.set(group.id, {
        ...group,
        x: bounds.x,
        y: bounds.y,
        props: {
          ...group.props,
          w: bounds.w,
          h: bounds.h,
        },
      });
      changed = true;
    }
  }

  return changed ? shapes.map((shape) => byId.get(shape.id) ?? shape) : shapes;
}

function orderShapesByHierarchy(shapes: OverlayShape[]): OverlayShape[] {
  const childrenByParent = getChildrenByParent(shapes);
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

  for (const shape of shapes) {
    if (!shape.parentId) {
      visit(shape);
    }
  }
  for (const shape of shapes) {
    visit(shape);
  }
  return ordered;
}

function getChildrenByParent(shapes: OverlayShape[]): Map<OverlayShapeId, OverlayShape[]> {
  const childrenByParent = new Map<OverlayShapeId, OverlayShape[]>();
  for (const shape of shapes) {
    if (!shape.parentId) {
      continue;
    }
    childrenByParent.set(shape.parentId, [...(childrenByParent.get(shape.parentId) ?? []), shape]);
  }
  return childrenByParent;
}

function getShapeDepth(shape: OverlayShape, shapes: OverlayShape[]): number {
  let depth = 0;
  let parentId = shape.parentId;
  const seen = new Set<OverlayShapeId>([shape.id]);
  while (parentId) {
    const parent = shapes.find((candidate) => candidate.id === parentId);
    if (!parent || seen.has(parent.id)) {
      break;
    }
    seen.add(parent.id);
    depth += 1;
    parentId = parent.parentId;
  }
  return depth;
}

function hasParentCycle(shape: OverlayShape, byId: Map<OverlayShapeId, OverlayShape>): boolean {
  const seen = new Set<OverlayShapeId>([shape.id]);
  let parentId = shape.parentId;
  while (parentId) {
    if (seen.has(parentId)) {
      return true;
    }
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

function stripGroupIdMarker<T extends OverlayShape>(shape: T): T {
  if (!shape.groupId) {
    return shape;
  }
  const next = { ...shape } as T;
  delete next.groupId;
  return next;
}

function createUniqueShapeId(
  createId: () => OverlayShapeId,
  existingIds: Set<OverlayShapeId>,
): OverlayShapeId {
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

function getShapeSelectionBounds(shape: OverlayShape): OverlayBounds {
  if (shape.type === "graph2dShape") {
    const graph = migrateLegacyGraphShapeToPlotBounds(shape);
    return { x: graph.x, y: graph.y, w: graph.props.w, h: graph.props.h };
  }

  if (
    shape.type === "group" ||
    shape.type === "geo" ||
    shape.type === "image" ||
    shape.type === "callout" ||
    shape.type === "tableShape" ||
    shape.type === "chartShape"
  ) {
    return { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h };
  }

  if (shape.type === "arc") {
    const fallback = Math.max(MIN_ARC_RADIUS, shape.props.r);
    const rx = typeof shape.props.rx === "number" && Number.isFinite(shape.props.rx)
      ? Math.max(MIN_ARC_RADIUS, shape.props.rx)
      : fallback;
    const ry = typeof shape.props.ry === "number" && Number.isFinite(shape.props.ry)
      ? Math.max(MIN_ARC_RADIUS, shape.props.ry)
      : fallback;
    return { x: shape.x, y: shape.y, w: rx * 2, h: ry * 2 };
  }

  if (shape.type === "text") {
    const fallbackHeight = getTextShapeContentFallbackHeight(shape);
    const height = typeof shape.props.h === "number" && Number.isFinite(shape.props.h)
      ? Math.max(fallbackHeight, shape.props.h)
      : fallbackHeight;
    return {
      x: shape.x,
      y: shape.y,
      w: Math.max(MIN_TEXT_SHAPE_WIDTH, shape.props.w),
      h: height,
    };
  }

  if (shape.type === "arrow") {
    return getPointBounds(shape.x, shape.y, [shape.props.start, shape.props.end]);
  }

  if (shape.type === "line") {
    return getPointBounds(shape.x, shape.y, shape.props.points);
  }

  return { x: 0, y: 0, w: 1, h: 1 };
}

/**
 * Height a text shape needs from its explicit line breaks alone, mirroring
 * `features/drawing`'s `getTextShapeContentFallbackHeight`. The line height comes from
 * `overlay-text-font.ts` so the *stored* geometry of a text shape cannot drift from what the
 * renderers draw (this used to re-implement the pt→px conversion and disagreed with the drawing
 * feature by a pixel wherever the two multiplication orders straddled an integer).
 */
function getTextShapeContentFallbackHeight(
  shape: Extract<OverlayShape, { type: "text" }>,
): number {
  const lineHeight = getTextShapeRenderedLineHeightPx(shape);
  return Math.max(
    lineHeight,
    getOverlayTextBlocksLineCount(shape.props.blocks) * lineHeight,
  );
}


function getPointBounds(
  x: number,
  y: number,
  points: OverlayPoint[],
): OverlayBounds {
  if (points.length === 0) {
    return { x, y, w: 1, h: 1 };
  }

  const xs = points.map((point) => x + point.x);
  const ys = points.map((point) => y + point.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);

  return {
    x: minX - POINT_SHAPE_PADDING,
    y: minY - POINT_SHAPE_PADDING,
    w: Math.max(1, maxX - minX + POINT_SHAPE_PADDING * 2),
    h: Math.max(1, maxY - minY + POINT_SHAPE_PADDING * 2),
  };
}

function unionBounds(a: OverlayBounds, b: OverlayBounds): OverlayBounds {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.w, b.x + b.w);
  const bottom = Math.max(a.y + a.h, b.y + b.h);
  return { x: left, y: top, w: right - left, h: bottom - top };
}

function sameBounds(a: OverlayBounds, b: OverlayBounds): boolean {
  return Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.w - b.w) < 0.01 &&
    Math.abs(a.h - b.h) < 0.01;
}

function sameShapeList(a: OverlayShape[], b: OverlayShape[]): boolean {
  return a.length === b.length && a.every((shape, index) => shape === b[index]);
}
