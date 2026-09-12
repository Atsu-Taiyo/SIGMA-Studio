import {
  ANCHOR_PAGE_STRIDE_PX,
  anchorLineExistsInBlock,
  pageIndexForY,
  pickBlockAnchor,
  pickShapeAnchor,
  resolveShapeAnchorPositions,
  type MeasuredBlock,
  type OverlayBlockGapMap,
} from "./anchor";
import {
  getRotatedShapeVisualBounds,
  getShapeVisualBounds,
  getShapesVisualBounds,
} from "@/features/drawing";
import type { OverlayAnchor, OverlayBounds, OverlayShape, OverlayShapeId } from "./types";

const MAX_AUTOMATICALLY_ANCHORED_SHAPES = 64;

/**
 * Which block a figure hangs from is decided by where its ink is, not by the box that transforms
 * it. A shallow arc stores `centre - r`, so its reference box can start a whole radius above
 * anything drawn, and its centre can sit in a column the arc never enters — both send the figure
 * to the wrong block, and the anchor rule then drags it there on the next reflow.
 *
 * Only the *choice* moves: `pickBlockAnchor` still stores `dy` against `shape.y`, so resolving the
 * new anchor puts the figure back on the exact coordinate it already had.
 *
 * Only a group has to look at the rest of the document (it draws nothing itself, so its ink is its
 * members'). Everything else answers from the shape alone: these callers run this once per shape
 * over the whole document on every overlay change and on every frame of a drag, and the union
 * helper indexes all shapes on each call.
 */
export function getAnchorProbeBounds(
  shape: OverlayShape,
  allShapes: readonly OverlayShape[],
): OverlayBounds {
  return shape.type === "group"
    ? getShapesVisualBounds([shape], allShapes) ?? getShapeVisualBounds(shape)
    : getRotatedShapeVisualBounds(shape);
}

/**
 * A group is the unit that hangs from body text. It draws nothing itself, so what the reader sees
 * following (or not following) a paragraph is its members — and each of them picking its own block
 * is what tears a grouped figure apart: a group spanning two paragraphs binds half its shapes to
 * one and half to the other, and the first reflow between them pulls the two halves apart. Members
 * therefore inherit the group's block *and* the line inside it, and store their own offsets
 * against it, which keeps the whole group rigid and moving together.
 *
 * The offsets are measured against the block, never derived from the group's own `dy`:
 * `updateGroupBounds` rewrites a group's x/y from its members, so its stored offset can be a pass
 * out of date, and deriving from it would shift every member. Nothing here moves a figure — each
 * inherited anchor resolves to the coordinate the member already has.
 */
export function inheritGroupAnchorsForMembers(
  shapes: OverlayShape[],
  blocks: readonly MeasuredBlock[] | ReadonlyMap<string, MeasuredBlock>,
  reserveSpaceGaps: OverlayBlockGapMap = {},
): OverlayShape[] {
  const groupIds = getGroupIds(shapes);
  if (groupIds.size === 0) {
    return shapes;
  }

  const blockById = blocks instanceof Map
    ? blocks
    : new Map((blocks as readonly MeasuredBlock[]).map((block) => [block.id, block]));
  const membersByGroupId = new Map<OverlayShapeId, OverlayShape[]>();
  for (const shape of shapes) {
    if (!shape.parentId || !groupIds.has(shape.parentId)) {
      continue;
    }
    membersByGroupId.set(shape.parentId, [...(membersByGroupId.get(shape.parentId) ?? []), shape]);
  }

  const inheritedById = new Map<OverlayShapeId, OverlayShape>();
  const visited = new Set<OverlayShapeId>();
  const visit = (group: OverlayShape) => {
    if (visited.has(group.id)) {
      return;
    }
    visited.add(group.id);

    for (const member of membersByGroupId.get(group.id) ?? []) {
      const anchor = getInheritedMemberAnchor(member, group.anchor, blockById, reserveSpaceGaps);
      const next = anchor && !areOverlayAnchorsEqual(member.anchor, anchor)
        ? { ...member, anchor } as OverlayShape
        : member;
      if (next !== member) {
        inheritedById.set(member.id, next);
      }
      if (groupIds.has(member.id)) {
        // A nested group inherits from its own parent first, so its members read the anchor it
        // just took rather than the one it is about to lose.
        visit(next);
      }
    }
  };

  for (const shape of shapes) {
    if (groupIds.has(shape.id) && !(shape.parentId && groupIds.has(shape.parentId))) {
      visit(shape);
    }
  }

  return inheritedById.size === 0
    ? shapes
    : shapes.map((shape) => inheritedById.get(shape.id) ?? shape);
}

function getInheritedMemberAnchor(
  member: OverlayShape,
  groupAnchor: OverlayAnchor | undefined,
  blockById: ReadonlyMap<string, MeasuredBlock>,
  reserveSpaceGaps: OverlayBlockGapMap,
): OverlayAnchor | null {
  if (!groupAnchor) {
    return null;
  }
  if (groupAnchor.type === "page") {
    return { type: "page" };
  }
  // A shape-anchored group is positioned by another figure, not by the body; its members keep
  // whatever relationship they already have.
  if (groupAnchor.type !== "block") {
    return null;
  }

  const block = blockById.get(groupAnchor.blockId);
  if (!block) {
    // Dangling group anchor: rewriting members against a block nobody measured would replace a
    // usable offset with a guess. The next pass repairs the group first.
    return null;
  }

  const gap = groupAnchor.reserveSpace === true
    ? Math.max(0, Number.isFinite(reserveSpaceGaps[groupAnchor.blockId]) ? reserveSpaceGaps[groupAnchor.blockId] : 0)
    : 0;
  const lineIndex = groupAnchor.line?.index;
  const lineTop = lineIndex === undefined
    ? undefined
    : block.lines?.find((line) => line.index === lineIndex)?.top;

  return {
    type: "block",
    blockId: groupAnchor.blockId,
    dy: member.y - (block.top - gap),
    ...(groupAnchor.dx !== undefined && block.left !== undefined ? { dx: member.x - block.left } : {}),
    ...(lineIndex !== undefined && lineTop !== undefined
      ? { line: { index: lineIndex, dy: member.y - (lineTop - gap) } }
      : {}),
    ...(groupAnchor.reserveSpace !== undefined ? { reserveSpace: groupAnchor.reserveSpace } : {}),
  };
}

/**
 * Ids of every group in the document, indexed once per pass: these functions run over the whole
 * document on every overlay change and on every frame of a drag, so asking per shape whether its
 * parent is a group would make each of them quadratic.
 */
function getGroupIds(shapes: readonly OverlayShape[]): Set<OverlayShapeId> {
  const ids = new Set<OverlayShapeId>();
  for (const shape of shapes) {
    if (shape.type === "group") {
      ids.add(shape.id);
    }
  }
  return ids;
}

/** True when the shape hangs from a group in the same document: the group owns its anchor. */
function isGroupMember(shape: OverlayShape, groupIds: ReadonlySet<OverlayShapeId>): boolean {
  return !!shape.parentId && groupIds.has(shape.parentId);
}

/**
 * `ids` plus every group they sit in. Moving a member moves the group's ink, so the group has to
 * re-pick the block it hangs from — otherwise it stays bound to whatever paragraph it was dropped
 * near originally, and hands that stale block to every member.
 */
function withAncestorGroupIds(
  shapes: readonly OverlayShape[],
  ids: ReadonlySet<OverlayShapeId>,
): Set<OverlayShapeId> {
  const expanded = new Set(ids);
  const byId = new Map(shapes.map((shape) => [shape.id, shape]));
  for (const id of ids) {
    let parentId = byId.get(id)?.parentId;
    const seen = new Set<OverlayShapeId>([id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      const parent = byId.get(parentId);
      if (!parent || parent.type !== "group") {
        break;
      }
      expanded.add(parent.id);
      parentId = parent.parentId;
    }
  }
  return expanded;
}

export function areOverlayAnchorsEqual(
  a: OverlayAnchor | undefined,
  b: OverlayAnchor | undefined,
): boolean {
  const left = a ?? { type: "page" as const };
  const right = b ?? { type: "page" as const };
  if (left.type !== right.type) {
    return false;
  }
  if (left.type === "page" || right.type === "page") {
    return true;
  }
  if (left.type === "shape" || right.type === "shape") {
    return left.type === "shape" &&
      right.type === "shape" &&
      left.shapeId === right.shapeId &&
      left.dx === right.dx &&
      left.dy === right.dy &&
      left.rx === right.rx &&
      left.ry === right.ry;
  }

  return left.blockId === right.blockId &&
    left.dy === right.dy &&
    left.dx === right.dx &&
    left.reserveSpace === right.reserveSpace &&
    left.line?.index === right.line?.index &&
    left.line?.dy === right.line?.dy;
}

export function reanchorShapesAgainstMeasuredBlocks(
  shapes: OverlayShape[],
  orderedBlocks: MeasuredBlock[],
  reserveSpaceGaps: OverlayBlockGapMap = {},
): OverlayShape[] {
  if (orderedBlocks.length === 0) {
    return shapes;
  }

  const groupIds = getGroupIds(shapes);
  let changed = false;
  const blockAnchored = shapes.map((shape) => {
    if (shape.anchor?.type === "page" || shape.anchor?.type === "shape") {
      return shape;
    }

    // The group picks for the whole unit; its members take that anchor below.
    if (isGroupMember(shape, groupIds)) {
      return shape;
    }

    const bounds = getAnchorProbeBounds(shape, shapes);
    const existingBlockAnchor = shape.anchor?.type === "block" ? shape.anchor : null;
    const existingBlockId = existingBlockAnchor?.blockId ?? null;
    const reserveGap = existingBlockAnchor?.reserveSpace === true && existingBlockId
      ? reserveSpaceGaps[existingBlockId] ?? 0
      : 0;
    const anchorBlocks = reserveGap > 0
      ? orderedBlocks.map((block) => block.id === existingBlockId
        ? {
            ...block,
            top: block.top - reserveGap,
            lines: block.lines?.map((line) => ({ ...line, top: line.top - reserveGap })),
          }
        : block)
      : orderedBlocks;
    const existingBlock = existingBlockId
      ? anchorBlocks.find((block) => block.id === existingBlockId)
      : undefined;
    // A block that exists only in the editor is not a target this pass may keep: re-picking from
    // every block is what migrates a document that already carries such an anchor onto a real one.
    const canKeepExistingBlockAnchor = existingBlock &&
      !existingBlock.derived &&
      (!existingBlockAnchor?.line || anchorLineExistsInBlock(existingBlockAnchor, existingBlock));
    const anchor = canKeepExistingBlockAnchor
      ? pickBlockAnchor(bounds.y, shape.y, [existingBlock], bounds.x + bounds.w / 2, shape.x)
      : pickBlockAnchor(bounds.y, shape.y, anchorBlocks, bounds.x + bounds.w / 2, shape.x);
    if (anchor.type !== "block") {
      return shape;
    }
    const nextAnchor = preserveBlockAnchorReserveSpace(existingBlockAnchor ?? undefined, anchor);

    if (areOverlayAnchorsEqual(shape.anchor, nextAnchor)) {
      return shape;
    }

    changed = true;
    return { ...shape, anchor: nextAnchor };
  });

  return resolveShapeAnchorPositions(inheritGroupAnchorsForMembers(
    changed ? blockAnchored : shapes,
    orderedBlocks,
    reserveSpaceGaps,
  ));
}

/**
 * Attach imported/AI-created shapes that omitted `anchor` to nearby body text.
 * Explicit block, shape, and page anchors are user intent and remain untouched.
 */
export function attachUnanchoredShapesToMeasuredBlocks(
  shapes: OverlayShape[],
  orderedBlocks: MeasuredBlock[],
  pageStridePx: number = ANCHOR_PAGE_STRIDE_PX,
): OverlayShape[] {
  const unanchoredShapeCount = shapes.reduce(
    (count, shape) => count + (shape.anchor === undefined ? 1 : 0),
    0,
  );
  if (
    orderedBlocks.length === 0 ||
    unanchoredShapeCount === 0 ||
    unanchoredShapeCount > MAX_AUTOMATICALLY_ANCHORED_SHAPES
  ) {
    // A large overlay import is normally an intentionally page-positioned
    // composition. Rewriting hundreds of coordinates into inferred body
    // relationships is both expensive and destructive; explicit anchors can
    // still be added through the drag UI or the import/MCP payload.
    return shapes;
  }

  const groupIds = getGroupIds(shapes);
  let changed = false;
  const next = shapes.map((shape) => {
    if (shape.anchor !== undefined || isGroupMember(shape, groupIds)) {
      return shape;
    }

    const bounds = getAnchorProbeBounds(shape, shapes);
    const anchor = pickBlockAnchor(bounds.y, shape.y, orderedBlocks, bounds.x + bounds.w / 2, shape.x);
    if (anchor.type !== "block") {
      return shape;
    }

    const anchorBlock = orderedBlocks.find((block) => block.id === anchor.blockId);
    if (
      !anchorBlock ||
      pageIndexForY(anchorBlock.top, pageStridePx).pageIndex !== pageIndexForY(bounds.y, pageStridePx).pageIndex
    ) {
      // A missing anchor means the stored x/y is still authoritative. Only
      // infer a relationship to nearby text on the same sheet; reaching across
      // pages can pull a large imported overlay onto the final measured block.
      return shape;
    }

    changed = true;
    return { ...shape, anchor } as OverlayShape;
  });

  return resolveShapeAnchorPositions(inheritGroupAnchorsForMembers(
    changed ? next : shapes,
    orderedBlocks,
  ));
}

export function reanchorShapesByPosition(
  shapes: OverlayShape[],
  shapeIds: ReadonlySet<OverlayShapeId>,
  orderedBlocks: MeasuredBlock[],
): OverlayShape[] {
  if (shapeIds.size === 0) {
    return shapes;
  }

  const groupIds = getGroupIds(shapes);
  const targetIds = withAncestorGroupIds(shapes, shapeIds);
  let changed = false;
  const next = shapes.map((shape) => {
    if (!targetIds.has(shape.id) || shape.anchor?.type === "page") {
      return shape;
    }

    // Members follow the group they moved with, so only the group re-picks a block.
    if (shape.anchor?.type !== "shape" && isGroupMember(shape, groupIds)) {
      return shape;
    }

    if (shape.anchor?.type === "shape") {
      const shapeAnchor = shape.anchor;
      const parent = shapes.find((item) => item.id === shapeAnchor.shapeId);
      if (!parent) {
        return shape;
      }

      const anchor = pickShapeAnchor(shape, parent);
      if (areOverlayAnchorsEqual(shape.anchor, anchor)) {
        return shape;
      }

      changed = true;
      return { ...shape, anchor } as OverlayShape;
    }

    if (orderedBlocks.length === 0) {
      return shape;
    }

    const bounds = getAnchorProbeBounds(shape, shapes);
    const anchor = pickBlockAnchor(bounds.y, shape.y, orderedBlocks, bounds.x + bounds.w / 2, shape.x);
    const nextAnchor = preserveBlockAnchorReserveSpace(shape.anchor, anchor);
    if (areOverlayAnchorsEqual(shape.anchor, nextAnchor)) {
      return shape;
    }

    changed = true;
    return { ...shape, anchor: nextAnchor } as OverlayShape;
  });

  return resolveShapeAnchorPositions(inheritGroupAnchorsForMembers(
    changed ? next : shapes,
    orderedBlocks,
  ));
}

export function syncMovedOverlayShapeAnchor<T extends OverlayShape>(
  nextShape: T,
  previousShape: T,
  shapes: readonly OverlayShape[],
  blockRects: ReadonlyMap<string, MeasuredBlock>,
): T {
  const anchor = previousShape.anchor;
  if (!anchor || anchor.type === "page") {
    return nextShape;
  }

  if (anchor.type === "shape") {
    const parent = shapes.find((shape) => shape.id === anchor.shapeId);
    if (!parent) {
      return nextShape;
    }

    return {
      ...nextShape,
      anchor: pickShapeAnchor(nextShape, parent),
    };
  }

  const block = blockRects.get(anchor.blockId);
  if (!block) {
    return nextShape;
  }

  const bounds = getAnchorProbeBounds(nextShape, shapes);
  const nextAnchor = pickBlockAnchor(bounds.y, nextShape.y, [block], bounds.x + bounds.w / 2, nextShape.x);
  return {
    ...nextShape,
    anchor: preserveBlockAnchorReserveSpace(anchor, nextAnchor),
  };
}

function preserveBlockAnchorReserveSpace(
  previousAnchor: OverlayAnchor | undefined,
  nextAnchor: OverlayAnchor,
): OverlayAnchor {
  return previousAnchor?.type === "block" &&
    previousAnchor.reserveSpace !== undefined &&
    nextAnchor.type === "block"
    ? { ...nextAnchor, reserveSpace: previousAnchor.reserveSpace }
    : nextAnchor;
}
