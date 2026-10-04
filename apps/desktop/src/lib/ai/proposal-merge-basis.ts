import { normalizeOverlaySnapshot, type OverlayShape, type SigmaBlock, type SigmaDocument } from "@/features/document";
import { findBlock, updateBlockInDocument, type EditableBlock } from "@/lib/document-tree";
import { isOverlayAnchorSupportDraft } from "@/lib/ai/applied-document-diff";
import { resolveAiEditSessionOperationOrder, type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";

/**
 * What a proposal overwrites, as it was when the AI first touched it. The merging replay compares
 * this base with the current document (the human's side) and with the AI's result, so a human edit
 * made after the proposal was written is kept instead of being overwritten.
 *
 * Only the units the draft overwrites are stored (the outermost replaced blocks with their nested
 * blocks, deleted blocks, updated or deleted overlay shapes), never the whole document.
 */
export type ProposalMergeBasisEntity =
  | { kind: "block"; value: EditableBlock }
  | { kind: "shape"; value: OverlayShape };

/**
 * Where an `insertAfter` anchor sat in the base: its container (`<parentId>.<slot>`, or null for
 * the top-level body) and the siblings before it, nearest first. When the human deletes the anchor,
 * the insertion moves after the nearest preceding sibling still in the same container.
 */
export interface ProposalMergeBasisAnchor {
  container: string | null;
  precedingIds: string[];
}

export interface ProposalMergeBasis {
  version: 1;
  entities: Record<string, ProposalMergeBasisEntity>;
  anchors?: Record<string, ProposalMergeBasisAnchor>;
}

/**
 * What a merging replay had to decide (MISS R3: fallbacks must be countable). All counters are
 * zero and all lists empty when nobody else edited what the proposal overwrites.
 */
export interface ProposalMergeReport {
  /** Places both sides changed (`#<unitId>.<path>`): both insertions kept, or the AI's value taken. */
  overlaps: string[];
  /** Some text run was merged coarsely because of a size bound. */
  capped: boolean;
  cappedPaths: string[];
  /** Formula ids rewritten by the merge, plus image assets renamed because their id was taken. */
  reidentified: number;
  /** Values one side deleted and the other edited, kept with the edit (`#<id>...`). */
  editBeatsDelete: string[];
  /** Ids a merge repeated; that unit was replaced by the AI's version instead. */
  duplicateIds: string[];
  /** Units whose merged result failed validation and that were replaced by the AI's version. */
  invalidAfterMerge: number;
  /** Insertions moved after a preceding block because their anchor had been deleted. */
  anchorRelocated: number;
  /** Proposals approved through the legacy path because they have no merge basis. */
  legacyNoBase: number;
  /** Units the human had edited since the base: the result contains the human's change too. */
  humanEditedUnits: string[];
}

/** How many preceding siblings an insert anchor remembers. */
const MAX_ANCHOR_PRECEDING_IDS = 16;

export function createEmptyProposalMergeReport(): ProposalMergeReport {
  return {
    overlaps: [],
    capped: false,
    cappedPaths: [],
    reidentified: 0,
    editBeatsDelete: [],
    duplicateIds: [],
    invalidAfterMerge: 0,
    anchorRelocated: 0,
    legacyNoBase: 0,
    humanEditedUnits: [],
  };
}

/** True when the merging replay did nothing a plain replay would not have done. */
export function isProposalMergeQuiet(report: ProposalMergeReport): boolean {
  return report.overlaps.length === 0
    && !report.capped
    && report.cappedPaths.length === 0
    && report.reidentified === 0
    && report.editBeatsDelete.length === 0
    && report.duplicateIds.length === 0
    && report.invalidAfterMerge === 0
    && report.anchorRelocated === 0
    && report.legacyNoBase === 0
    && report.humanEditedUnits.length === 0;
}

export function combineProposalMergeReports(reports: readonly ProposalMergeReport[]): ProposalMergeReport {
  const combined = createEmptyProposalMergeReport();
  const appendUnique = (target: string[], values: readonly string[]) => {
    for (const value of values) {
      if (!target.includes(value)) {
        target.push(value);
      }
    }
  };
  for (const report of reports) {
    appendUnique(combined.overlaps, report.overlaps);
    combined.capped ||= report.capped;
    appendUnique(combined.cappedPaths, report.cappedPaths);
    combined.reidentified += report.reidentified;
    appendUnique(combined.editBeatsDelete, report.editBeatsDelete);
    appendUnique(combined.duplicateIds, report.duplicateIds);
    combined.invalidAfterMerge += report.invalidAfterMerge;
    combined.anchorRelocated += report.anchorRelocated;
    combined.legacyNoBase += report.legacyNoBase;
    appendUnique(combined.humanEditedUnits, report.humanEditedUnits);
  }
  return combined;
}

export interface ProposalMergeUnits {
  /** Whole-block replacements (legacy overlay-anchor support replacements are normalized instead). */
  replaceTargetIds: string[];
  deletedBlockIds: string[];
  updatedShapeIds: string[];
  deletedShapeIds: string[];
  /** `insertAfter` anchors that exist before the draft runs (not created by the draft itself). */
  insertAnchorIds: string[];
}

export function collectProposalMergeUnits(draft: AiEditSessionDraft): ProposalMergeUnits {
  const units: ProposalMergeUnits = {
    replaceTargetIds: [],
    deletedBlockIds: [],
    updatedShapeIds: [],
    deletedShapeIds: [],
    insertAnchorIds: [],
  };
  const push = (ids: string[], id: string) => {
    if (id.length > 0 && !ids.includes(id)) {
      ids.push(id);
    }
  };
  const createdIds = new Set<string>();
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    if (entry.kind === "operation") {
      const operation = draft.operations[entry.index]!;
      if (operation.operation === undefined || operation.operation === "replace") {
        if (!isOverlayAnchorSupportDraft(operation, draft.operations)) {
          push(units.replaceTargetIds, operation.targetId);
        }
      } else if (operation.operation === "insertAfter") {
        if (!createdIds.has(operation.targetId)) {
          push(units.insertAnchorIds, operation.targetId);
        }
        createdIds.add(operation.insertedBlock.id);
      }
      continue;
    }
    const mutation = draft.mutationOperations?.[entry.index];
    if (mutation?.operation === "deleteBlocks") {
      mutation.blockIds.forEach((id) => push(units.deletedBlockIds, id));
    } else if (mutation?.operation === "updateOverlayShape") {
      push(units.updatedShapeIds, mutation.shapeId);
    } else if (mutation?.operation === "deleteOverlayShapes") {
      mutation.shapeIds.forEach((id) => push(units.deletedShapeIds, id));
    }
  }
  return units;
}

/**
 * Computes the merge basis of `draft` from `baseDocument` (the document the AI's tools ran on).
 *
 * With `previous` (the basis already stored for the same room's proposal), the snapshot of an
 * entity the draft already touched is kept as it was when it was first touched — its replacement
 * in the draft was derived from that version, not from the latest saved document — and only newly
 * touched entities are read from `baseDocument`. A newly touched block that contains an entity
 * touched earlier carries that earlier snapshot inside it.
 */
export function computeProposalMergeBasis(
  draft: AiEditSessionDraft,
  baseDocument: SigmaDocument,
  previous?: ProposalMergeBasis,
): ProposalMergeBasis {
  const units = collectProposalMergeUnits(draft);
  const previousEntities = previous?.entities ?? {};
  const previousBlocks = Object.entries(previousEntities).flatMap(([id, entity]) => (
    entity.kind === "block" ? [[id, entity.value] as const] : []
  ));
  const blockSnapshot = (id: string): EditableBlock | null => {
    const kept = previousEntities[id];
    if (kept?.kind === "block") {
      return kept.value;
    }
    const block = findBlock(baseDocument, id);
    if (!block) {
      return null;
    }
    let snapshot = block;
    for (const [previousId, previousValue] of previousBlocks) {
      if (previousId !== id && blockContainsId(baseDocument, snapshot, previousId)) {
        snapshot = replaceDescendant(baseDocument, snapshot, previousId, previousValue);
      }
    }
    return structuredClone(snapshot);
  };

  const entities: Record<string, ProposalMergeBasisEntity> = {};
  const replaceSnapshots = new Map<string, EditableBlock>();
  for (const id of units.replaceTargetIds) {
    const snapshot = blockSnapshot(id);
    if (snapshot) {
      replaceSnapshots.set(id, snapshot);
    }
  }
  for (const [id, snapshot] of replaceSnapshots) {
    const nested = [...replaceSnapshots].some(([otherId, other]) => (
      otherId !== id && blockContainsId(baseDocument, other, id)
    ));
    if (!nested) {
      entities[id] = { kind: "block", value: snapshot };
    }
  }
  for (const id of units.deletedBlockIds) {
    if (!entities[id]) {
      const snapshot = blockSnapshot(id);
      if (snapshot) {
        entities[id] = { kind: "block", value: snapshot };
      }
    }
  }

  const baseShapes = normalizeOverlaySnapshot(baseDocument.pageLayout?.overlay?.overlaySnapshot).shapes;
  for (const id of [...units.updatedShapeIds, ...units.deletedShapeIds]) {
    if (entities[id]) {
      continue;
    }
    const kept = previousEntities[id];
    const shape = kept?.kind === "shape" ? kept.value : baseShapes.find((candidate) => candidate.id === id);
    if (shape) {
      entities[id] = { kind: "shape", value: structuredClone(shape) };
    }
  }

  const anchors: Record<string, ProposalMergeBasisAnchor> = {};
  for (const id of units.insertAnchorIds) {
    const anchor = previous?.anchors?.[id] ?? describeAnchor(baseDocument, id);
    if (anchor) {
      anchors[id] = anchor;
    }
  }

  return {
    version: 1,
    entities,
    ...(Object.keys(anchors).length > 0 ? { anchors } : {}),
  };
}

/** Whether `id` is `block` itself or anywhere inside it (same walk as `findBlock`). */
export function blockContainsId(template: SigmaDocument, block: EditableBlock, id: string): boolean {
  return findBlock(scratchDocument(template, block), id) !== null;
}

/** Finds `id` inside `block` (or `block` itself). */
export function findBlockWithin(template: SigmaDocument, block: EditableBlock, id: string): EditableBlock | null {
  return findBlock(scratchDocument(template, block), id);
}

/** Returns `block` with the subtree `id` replaced by `replacement`. */
export function replaceDescendant(
  template: SigmaDocument,
  block: EditableBlock,
  id: string,
  replacement: EditableBlock,
): EditableBlock {
  return updateBlockInDocument(scratchDocument(template, block), id, () => replacement).content[0] as EditableBlock;
}

/** A document holding only `block`, so the canonical tree walks can run inside one unit. */
function scratchDocument(template: SigmaDocument, block: EditableBlock): SigmaDocument {
  return { ...template, content: [block as SigmaBlock] };
}

type BlockRecord = Record<string, unknown> & { id: string; type: string };

/** Child slots of each container block, in the order `findBlock` walks them. */
const CONTAINER_SLOTS: Record<string, readonly string[]> = {
  problem: ["lead", "prompt", "solution", "hints"],
  layoutSection: ["children"],
  boxBlock: ["blocks"],
  quote: ["blocks"],
  list: ["items"],
  listItem: ["continuations", "nested"],
};

/**
 * Visits every sibling list of the document (the top-level body first). Returns the first value
 * `visit` returns, so callers can stop early.
 */
function findInSiblingLists<T>(
  document: SigmaDocument,
  visit: (siblings: readonly BlockRecord[], container: string | null) => T | undefined,
): T | undefined {
  const walk = (siblings: readonly BlockRecord[], container: string | null): T | undefined => {
    const found = visit(siblings, container);
    if (found !== undefined) {
      return found;
    }
    for (const block of siblings) {
      for (const slot of CONTAINER_SLOTS[block.type] ?? []) {
        const children = block[slot];
        if (Array.isArray(children)) {
          const nested = walk(children as BlockRecord[], `${block.id}.${slot}`);
          if (nested !== undefined) {
            return nested;
          }
        }
      }
    }
    return undefined;
  };
  return walk(document.content as unknown as BlockRecord[], null);
}

/** The container of block `id`, or undefined when the document does not hold it. */
export function findBlockContainer(document: SigmaDocument, id: string): string | null | undefined {
  const found = findInSiblingLists(document, (siblings, container) => (
    siblings.some((block) => block.id === id) ? { container } : undefined
  ));
  return found?.container;
}

function describeAnchor(document: SigmaDocument, id: string): ProposalMergeBasisAnchor | null {
  return findInSiblingLists(document, (siblings, container) => {
    const index = siblings.findIndex((block) => block.id === id);
    if (index < 0) {
      return undefined;
    }
    return {
      container,
      precedingIds: siblings
        .slice(Math.max(0, index - MAX_ANCHOR_PRECEDING_IDS), index)
        .map((block) => block.id)
        .reverse(),
    };
  }) ?? null;
}
