import { inlineNodesToPlainText, type InlineNode, type OverlayShape, type SigmaDocument } from "@/features/document";
import { rebaseProtectedTextRanges, type ProtectedTextRange, type TextContentReservation } from "@/features/text-editing";
import { findBlock } from "@/lib/document-tree";

import type { AiLockedTargets } from "./locked-targets";

/**
 * SigmaDoc-level counterpart to the ProseMirror `filterTransaction` guard in
 * edit-guard-extension.ts: given a proposed whole-document replacement, report
 * which AI-locked targets it would alter.
 *
 * This exists so the single mutation choke point (`commitDocumentChange`) can
 * refuse exactly the changes that collide with a live run or a pending
 * proposal, instead of refusing every change while AI is busy. It is the
 * backstop for every surface the PM guard cannot see -- overlay drags/resizes,
 * block moves and deletions, table and graph edits, undo/redo -- so a missing
 * `disabled` prop somewhere can never silently overwrite AI's target.
 *
 * Deliberately NOT flagged as touched:
 * - A locked block that only moved. Approval replays operations by targetId, so
 *   a relocated block with identical content still applies correctly. Reorders
 *   inside the body editor are already refused by the PM guard, which owns the
 *   neighbour comparison for the surface where block dragging happens.
 * - A locked id absent from `before`. There is nothing to protect yet, matching
 *   `findTouchedGuardedBlockIds`'s `if (!oldNode) continue`.
 */
export interface AiLockedTargetsTouched {
  blockIds: string[];
  shapeIds: string[];
}

export const NO_AI_LOCKED_TARGETS_TOUCHED: AiLockedTargetsTouched = { blockIds: [], shapeIds: [] };

export function findAiLockedTargetsTouched(
  before: SigmaDocument,
  after: SigmaDocument,
  locked: AiLockedTargets,
): AiLockedTargetsTouched {
  if (before === after || (locked.blockIds.size === 0 && locked.shapeIds.size === 0)) {
    return NO_AI_LOCKED_TARGETS_TOUCHED;
  }

  const blockIds: string[] = [];
  for (const blockId of locked.blockIds) {
    const previous = findBlock(before, blockId);
    if (!previous) {
      continue;
    }
    const next = findBlock(after, blockId);
    const reservations = locked.contentReservations?.get(blockId);
    if (reservations
      ? hasReservedContentChanged(previous, next, reservations)
      : hasChanged(previous, next)) {
      blockIds.push(blockId);
    }
  }

  const shapeIds: string[] = [];
  if (locked.shapeIds.size > 0) {
    const previousShapes = indexShapesById(before);
    const nextShapes = indexShapesById(after);
    for (const shapeId of locked.shapeIds) {
      const previous = previousShapes.get(shapeId);
      if (!previous) {
        continue;
      }
      if (hasChanged(previous, nextShapes.get(shapeId))) {
        shapeIds.push(shapeId);
      }
    }
  }

  return { blockIds, shapeIds };
}

/** Content + formatting of just the reserved fragments, at the canonical commit boundary. */
function hasReservedContentChanged(
  before: NonNullable<ReturnType<typeof findBlock>>,
  after: ReturnType<typeof findBlock>,
  reservations: readonly TextContentReservation[],
): boolean {
  if (before === after) return false;
  if (!after || !("children" in before) || !("children" in after)
    || !before.children.every(isInlineNode) || !after.children.every(isInlineNode)) {
    return hasChanged(before, after);
  }
  const { children: oldChildren, ...oldAttributes } = before;
  const { children: newChildren, ...newAttributes } = after;
  if (!deepEquals(oldAttributes, newAttributes)) return true;
  const oldText = inlineNodesToPlainText(oldChildren);
  const newText = inlineNodesToPlainText(newChildren);
  for (const reservation of reservations) {
    const oldRanges = rebaseProtectedTextRanges(reservation.baselineText, oldText, reservation.ranges);
    const newRanges = oldRanges && rebaseProtectedTextRanges(oldText, newText, oldRanges);
    if (!oldRanges || !newRanges) return true;
    for (let i = 0; i < oldRanges.length; i++) {
      if (!deepEquals(protectedInlineSlice(oldChildren, oldRanges[i]), protectedInlineSlice(newChildren, newRanges[i]))) return true;
    }
    for (const id of reservation.inlineMathIds) {
      const previous = oldChildren.find((node) => node.type === "mathInline" && node.id === id);
      if (previous && hasChanged(previous, newChildren.find((node) => node.type === "mathInline" && node.id === id))) return true;
    }
  }
  return false;
}

function isInlineNode(node: { type: string }): node is InlineNode {
  return node.type === "text" || node.type === "mathInline";
}

function protectedInlineSlice(nodes: readonly InlineNode[], range: ProtectedTextRange): unknown[] {
  const result: unknown[] = [];
  let offset = 0;
  for (const node of nodes) {
    const length = node.type === "text" ? node.text.length : node.tex.length + 2;
    const start = Math.max(0, range.from - offset);
    const end = Math.min(length, range.to - offset);
    if (start < end) {
      if (node.type === "mathInline") result.push(node);
      else {
        // Character projection ignores incidental splitting of equal-format text runs.
        for (let i = start; i < end; i++) result.push({ ...node, text: node.text[i] });
      }
    }
    offset += length;
  }
  return result;
}

export function hasAiLockedTargetsTouched(touched: AiLockedTargetsTouched): boolean {
  return touched.blockIds.length > 0 || touched.shapeIds.length > 0;
}

/**
 * Deletion, or a real content difference. The reference check short-circuits the
 * common case: SigmaDoc updates are immutable, so an untouched block or shape is
 * usually still the very same object even when its parent array was rebuilt.
 * Only when references differ do we pay for a structural compare -- and the
 * locked set is a handful of ids, never the whole document.
 */
function hasChanged(previous: unknown, next: unknown): boolean {
  if (next === undefined || next === null) {
    return true;
  }
  return !deepEquals(previous, next);
}

/**
 * Order-insensitive for object keys, order-sensitive for arrays.
 *
 * Key order matters here: a body edit commits blocks that were round-tripped
 * through Tiptap (textFlowToTiptap → tiptapToTextFlow), which rebuilds every
 * block in the edited flow and can emit the same fields in a different order
 * (`{id, type, children}` becoming `{type, id, children}`). A JSON.stringify
 * comparison would read that as a change and refuse an edit to an entirely
 * different block, so the equality must look at structure rather than encoding.
 * Array order, by contrast, is real content -- the sequence of inline children.
 */
function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, index) => deepEquals(item, b[index]));
  }
  const previous = a as Record<string, unknown>;
  const next = b as Record<string, unknown>;
  // Ignore keys explicitly set to undefined so an absent field and an
  // undefined field compare equal, the way JSON persistence already treats them.
  const previousKeys = Object.keys(previous).filter((key) => previous[key] !== undefined);
  const nextKeys = Object.keys(next).filter((key) => next[key] !== undefined);
  if (previousKeys.length !== nextKeys.length) {
    return false;
  }
  return previousKeys.every((key) => (
    Object.prototype.hasOwnProperty.call(next, key) && deepEquals(previous[key], next[key])
  ));
}

function indexShapesById(document: SigmaDocument): Map<string, OverlayShape> {
  const shapes = document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  return new Map(shapes.map((shape) => [shape.id, shape]));
}
