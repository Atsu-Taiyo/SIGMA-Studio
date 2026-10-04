import {
  computeUpdatedOverlayShapes,
  createAiEditSessionDocumentDraft,
  EditableBlockSchema,
  resolveAiEditSessionOperationOrder,
  type AiEditDraft,
  type AiEditSessionDraft,
  type SigmaDocMutationOp,
} from "@/lib/ai/sigma-doc-edit-schema";
import { deriveAppliedDocumentDiff, isOverlayAnchorSupportDraft } from "@/lib/ai/applied-document-diff";
import { findBlock, resolveTextFlowBlockRangeIds, type EditableBlock } from "@/lib/document-tree";
import { areStructurallyEqual } from "@/lib/structural-equality";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import {
  isOverlayShape,
  mergeEntity3,
  normalizeOverlaySnapshot,
  type OverlayShape,
  type ProblemNode,
  type SigmaBlock,
  type SigmaDocument,
  type ThreeWayMergeReport,
} from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  blockContainsId,
  createEmptyProposalMergeReport,
  findBlockContainer,
  findBlockWithin,
  replaceDescendant,
  type ProposalMergeBasis,
  type ProposalMergeReport,
} from "./proposal-merge-basis";

const te = createCurrentLocaleTranslator("error");

const PROBLEM_OVERLAY_ANCHOR_AREAS = ["lead", "prompt", "solution", "hints"] as const;

/**
 * Older overlay proposals may contain a whole-Problem replacement whose only
 * purpose was to create an empty body paragraph to anchor a shape. Rebase that
 * compatibility operation semantically: preserve the current Problem, merge
 * only the synthetic anchor when the area is still empty, or use the area's
 * existing first block when a human/another proposal has populated it.
 */
function normalizeLegacyOverlayAnchorSupportDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): AiEditSessionDraft {
  const insertionTargetIds = new Set(draft.operations.flatMap((operation) => (
    operation.operation === "insertOverlayShape" || operation.operation === "insertTableShape"
      ? [operation.targetId]
      : []
  )));
  const retargetById = new Map<string, string>();

  const withCurrentProblems = draft.operations.map((operation): AiEditDraft => {
    if (!isReplaceOperation(operation)
      || !isOverlayAnchorSupportDraft(operation, draft.operations)
      || operation.replacementBlock.type !== "problem") {
      return operation;
    }
    const currentProblem = findBlock(document, operation.targetId);
    if (currentProblem?.type !== "problem") {
      return operation;
    }
    const area = PROBLEM_OVERLAY_ANCHOR_AREAS.find((candidate) => (
      operation.replacementBlock.type === "problem"
      && operation.replacementBlock[candidate].some((block) => insertionTargetIds.has(block.id))
    ));
    if (!area) {
      return operation;
    }
    const supportBlocks = operation.replacementBlock[area].filter((block) => insertionTargetIds.has(block.id));
    if (supportBlocks.length === 0) {
      return operation;
    }
    const currentAnchor = currentProblem[area][0];
    if (currentAnchor) {
      supportBlocks.forEach((block) => retargetById.set(block.id, currentAnchor.id));
      return {
        operation: "replace",
        summary: operation.summary,
        targetId: operation.targetId,
        replacementBlock: currentProblem,
      };
    }
    const replacementBlock: ProblemNode = { ...currentProblem, [area]: supportBlocks };
    return {
      operation: "replace",
      summary: operation.summary,
      targetId: operation.targetId,
      replacementBlock,
    };
  });

  if (retargetById.size === 0) {
    return withCurrentProblems.every((operation, index) => operation === draft.operations[index])
      ? draft
      : { ...draft, operations: withCurrentProblems };
  }

  const operations = withCurrentProblems.map((operation): AiEditDraft => {
    if (operation.operation !== "insertOverlayShape" && operation.operation !== "insertTableShape") {
      return operation;
    }
    const targetId = retargetById.get(operation.targetId) ?? operation.targetId;
    if (operation.operation === "insertTableShape") {
      const anchor = operation.tableShape.anchor;
      return {
        ...operation,
        targetId,
        tableShape: anchor?.type === "block" && retargetById.has(anchor.blockId)
          ? { ...operation.tableShape, anchor: { ...anchor, blockId: retargetById.get(anchor.blockId)! } }
          : operation.tableShape,
      };
    }
    const anchor = operation.overlayShape.anchor;
    return {
      ...operation,
      targetId,
      overlayShape: anchor?.type === "block" && retargetById.has(anchor.blockId)
        ? { ...operation.overlayShape, anchor: { ...anchor, blockId: retargetById.get(anchor.blockId)! } }
        : operation.overlayShape,
    };
  });
  return { ...draft, operations };
}

/**
 * Replays a persisted proposal draft onto `document` (the canonical replay of approval, rebase and
 * restore). Pure and renderer-safe: the main process and the renderer run the same function.
 */
export function replayProposalDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): { draft: AiEditSessionDraft; nextDocument: SigmaDocument } {
  // A persisted proposal is immutable input. Clone before range/order normalization so replay can
  // never mutate the stored replacementBlock objects in-place, then retain the normalized draft
  // returned by the canonical apply function instead of discarding it.
  const compatibilityDraft = normalizeLegacyOverlayAnchorSupportDraft(document, structuredClone(draft));
  const rangeResolvedDraft = resolveLocalColumnRangesForReplay(document, compatibilityDraft);
  const replayDraft = orderDraftOperationsForReplay(document, rangeResolvedDraft);
  const replay = createAiEditSessionDocumentDraft(document, null, replayDraft);
  return {
    draft: replay.draft,
    nextDocument: replay.nextDocument,
  };
}

/**
 * A merging replay that cannot be resolved for a reason the caller reports as its usual conflict
 * (the other failures surface as the plain replay's errors and are classified by the caller).
 */
export class ProposalMergeReplayError extends Error {
  constructor(
    message: string,
    readonly reason: "anchor-missing" | "replay-failed",
    readonly ids: string[],
  ) {
    super(message);
    this.name = "ProposalMergeReplayError";
  }
}

export interface ProposalMergeReplayResult {
  /**
   * The draft that was actually replayed: it carries the merged contents, so it must never be
   * persisted as the proposal's draft (the proposal keeps the AI's own draft and its base).
   */
  draft: AiEditSessionDraft;
  nextDocument: SigmaDocument;
  report: ProposalMergeReport;
}

/**
 * Replays a proposal onto the current document while keeping the edits made to it since the
 * proposal's base (`mergeBasis`), instead of overwriting them with the AI's snapshots.
 *
 * - Each outermost replaced block is three-way merged (`mergeEntity3`): base = its snapshot in the
 *   basis, ours = the block in `document` (the human's side), theirs = the base with the draft's
 *   replacements applied. The merged block then becomes the replacement for the plain replay.
 *   Updated overlay shapes are merged the same way and replayed as a patch from the current shape.
 * - A block or shape the AI deletes is kept when the human edited it (`editBeatsDelete`).
 * - A block or shape the human deleted is not revived: its replacement fails as before, so the
 *   caller reports the usual conflict (`anchor-missing`).
 * - An `insertAfter` whose anchor the human deleted moves after the nearest preceding sibling the
 *   basis remembers in the same container; without one it fails as before.
 * - An inserted image asset whose id is now taken by a different image is renamed (`<id>-<n>`) and
 *   the inserted shape (and the draft's later updates of it) point to the new id.
 * - A merged unit that fails validation (schema, type, an id the merge repeats or that collides
 *   with the rest of the document) is replaced by the AI's version (`invalidAfterMerge`); when the
 *   replay itself fails with merged units, it is retried with the AI's versions. When even that
 *   fails the error is thrown: the conflict cannot be resolved.
 * - Moves, layout changes and the legacy normalizations stay the plain replay's.
 *
 * When nothing deviates from the plain replay (no unit was edited by the human, nothing had to be
 * re-anchored or renamed), the result is exactly `replayProposalDraft` and the report is empty.
 */
export function replayProposalDraftMerging(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
): ProposalMergeReplayResult {
  // Only insertAfter anchors can move; a shape inserted against a block or shape the human deleted
  // keeps the legacy contract: the external anchor must still exist.
  const missingAnchors = findMissingShapeInsertAnchors(document, draft);
  if (missingAnchors.length > 0) {
    throw new ProposalMergeReplayError(te("electron.proposal.regenerateMissingTarget"), "anchor-missing", missingAnchors);
  }
  const report = createEmptyProposalMergeReport();
  const plan = planMergingReplay(document, draft, mergeBasis, report);
  if (!plan.rewrites) {
    const replay = replayProposalDraft(document, draft);
    return { draft: replay.draft, nextDocument: replay.nextDocument, report };
  }
  try {
    return { ...replayRewrittenDraft(document, buildRewrittenDraft(document, draft, plan, "merged")), report };
  } catch (error) {
    const mergedUnits = [...plan.blockUnits.values(), ...plan.shapeUnits.values()].filter((unit) => unit.usesMerged);
    if (mergedUnits.length === 0) {
      throw error;
    }
    let fallback: { draft: AiEditSessionDraft; nextDocument: SigmaDocument };
    try {
      fallback = replayRewrittenDraft(document, buildRewrittenDraft(document, draft, plan, "theirs"));
    } catch {
      throw error;
    }
    report.invalidAfterMerge += mergedUnits.length;
    return { ...fallback, report };
  }
}

/** The whiteboard insertion target (`createAiEditDocumentDraft` validates it itself). */
const WHITEBOARD_CANVAS_TARGET_ID = "CANVAS";

/** Block or shape anchors of inserted shapes/tables that exist neither now nor in the draft. */
function findMissingShapeInsertAnchors(document: SigmaDocument, draft: AiEditSessionDraft): string[] {
  const shapeIds = new Set(normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes.map((shape) => shape.id));
  const createdIds = new Set<string>();
  const missing: string[] = [];
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    if (entry.kind !== "operation") {
      continue;
    }
    const operation = draft.operations[entry.index]!;
    if (isReplaceOperation(operation)) {
      countContentIds(operation.replacementBlock).forEach((_, id) => createdIds.add(id));
      continue;
    }
    if (operation.operation === "insertAfter") {
      createdIds.add(operation.insertedBlock.id);
      continue;
    }
    const shape = operation.operation === "insertOverlayShape" ? operation.overlayShape : operation.tableShape;
    const anchor = shape.anchor;
    const anchorId = anchor?.type === "block" ? anchor.blockId : anchor?.type === "shape" ? anchor.shapeId : null;
    for (const id of [operation.targetId, anchorId]) {
      if (
        id
        && id !== WHITEBOARD_CANVAS_TARGET_ID
        && !createdIds.has(id)
        && !shapeIds.has(id)
        && findBlock(document, id) === null
        && !missing.includes(id)
      ) {
        missing.push(id);
      }
    }
    createdIds.add(shape.id);
  }
  return missing;
}

interface MergeUnitPlan<T> {
  id: string;
  /** The value to replay: the merged unit, or the AI's version when the merge was invalid. */
  value: T;
  /** The AI's version (base + the draft's own edits of this unit). */
  theirs: T;
  /** Whether `value` is a merge that differs from `theirs` (what a retry falls back from). */
  usesMerged: boolean;
}

/** An outermost replaced block the human edited, with the indexes of the replace ops inside it. */
type BlockUnitPlan = MergeUnitPlan<EditableBlock> & { operationIndexes: number[] };

/** An updated shape the human edited, with the current shape its patch is computed from. */
type ShapeUnitPlan = MergeUnitPlan<OverlayShape> & { ours: OverlayShape };

interface MergingReplayPlan {
  rewrites: boolean;
  blockUnits: Map<string, BlockUnitPlan>;
  shapeUnits: Map<string, ShapeUnitPlan>;
  /** Mutation index → ids a delete op still deletes (the others were edited by the human). */
  deleteRewrites: Map<number, string[]>;
  /** Operation index → new insertAfter anchor. */
  anchorRewrites: Map<number, string>;
  /** Shape id → (old asset id → new asset id) for inserted images whose asset id was taken. */
  assetRenames: Map<string, Map<string, string>>;
}

function planMergingReplay(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  report: ProposalMergeReport,
): MergingReplayPlan {
  const plan: MergingReplayPlan = {
    rewrites: false,
    blockUnits: new Map(),
    shapeUnits: new Map(),
    deleteRewrites: new Map(),
    anchorRewrites: new Map(),
    assetRenames: new Map(),
  };
  const documentIds = countContentIds(document.content);
  planBlockUnits(document, draft, mergeBasis, report, plan, documentIds);
  planShapeUnits(document, draft, mergeBasis, report, plan);
  planDeletions(document, draft, mergeBasis, report, plan);
  planAnchorRelocations(document, draft, mergeBasis, report, plan);
  planAssetRenames(document, draft, report, plan);
  plan.rewrites = plan.blockUnits.size > 0
    || plan.shapeUnits.size > 0
    || plan.deleteRewrites.size > 0
    || plan.anchorRewrites.size > 0
    || plan.assetRenames.size > 0;
  return plan;
}

function planBlockUnits(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  report: ProposalMergeReport,
  plan: MergingReplayPlan,
  documentIds: Map<string, number>,
): void {
  for (const [unitId, operationIndexes] of groupReplaceOperationsByUnit(document, draft, mergeBasis)) {
    const entity = mergeBasis.entities[unitId];
    const ours = findBlock(document, unitId);
    if (entity?.kind !== "block" || !ours) {
      // The human deleted the unit: leave the replacement as it is so the replay reports it.
      continue;
    }
    const base = structuredClone(entity.value);
    if (isSameContent(base, ours)) {
      continue;
    }
    const theirs = applyReplacementsToBlock(
      document,
      base,
      operationIndexes.map((index) => draft.operations[index] as ReplaceOperation),
    );
    report.humanEditedUnits.push(unitId);
    const merge = mergeEntity3(base, structuredClone(ours), structuredClone(theirs));
    const valid = merge.report.duplicateIds.length === 0
      && isValidMergedBlock(merge.value, ours, unitId, documentIds);
    if (!valid) {
      report.invalidAfterMerge += 1;
      appendUnique(report.duplicateIds, merge.report.duplicateIds);
      plan.blockUnits.set(unitId, { id: unitId, value: theirs, theirs, usesMerged: false, operationIndexes });
      continue;
    }
    addKernelReport(report, merge.report, unitId);
    plan.blockUnits.set(unitId, {
      id: unitId,
      value: merge.value,
      theirs,
      usesMerged: !isSameContent(merge.value, theirs),
      operationIndexes,
    });
  }
}

type ReplaceOperation = AiEditDraft & { replacementBlock: EditableBlock };

/**
 * Groups the draft's replace operations (legacy overlay-anchor support excluded) by the outermost
 * basis block containing their target. Targets outside every basis block (blocks the draft itself
 * created) are left to the plain replay.
 */
function groupReplaceOperationsByUnit(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
): Map<string, number[]> {
  const blockEntities = Object.entries(mergeBasis.entities).flatMap(([id, entity]) => (
    entity.kind === "block" ? [[id, entity.value] as const] : []
  ));
  const groups = new Map<string, number[]>();
  draft.operations.forEach((operation, index) => {
    if (!isReplaceOperation(operation) || isOverlayAnchorSupportDraft(operation, draft.operations)) {
      return;
    }
    const owners = blockEntities.filter(([id, value]) => (
      id === operation.targetId || blockContainsId(document, value, operation.targetId)
    ));
    const outermost = owners.find(([id]) => !owners.some(([otherId, other]) => (
      otherId !== id && blockContainsId(document, other, id)
    )));
    if (outermost) {
      groups.set(outermost[0], [...(groups.get(outermost[0]) ?? []), index]);
    }
  });
  return groups;
}

/** The AI's version of a unit: its base with the draft's replacements of it (ancestors first). */
function applyReplacementsToBlock(
  template: SigmaDocument,
  base: EditableBlock,
  operations: ReplaceOperation[],
): EditableBlock {
  const ordered = orderItemsByReplacementAncestry(
    { ...template, content: [base as SigmaBlock] },
    operations,
    (operation) => [operation.targetId],
  );
  let unit = base;
  for (const operation of ordered) {
    if (operation.targetId === unit.id) {
      unit = structuredClone(operation.replacementBlock);
    } else if (blockContainsId(template, unit, operation.targetId)) {
      unit = replaceDescendant(template, unit, operation.targetId, structuredClone(operation.replacementBlock));
    }
  }
  return unit;
}

function isValidMergedBlock(
  value: EditableBlock,
  ours: EditableBlock,
  unitId: string,
  documentIds: Map<string, number>,
): boolean {
  if (!isPlainRecord(value) || value.id !== unitId || value.type !== ours.type) {
    return false;
  }
  if (!EditableBlockSchema.safeParse(value).success) {
    return false;
  }
  // The merge must not make an id appear more often in the document than it already does (an
  // element the human moved out of the unit while the AI edited it in place would be kept twice).
  const oursIds = countContentIds(ours);
  for (const [id, count] of countContentIds(value)) {
    const before = documentIds.get(id) ?? 0;
    const outside = before - (oursIds.get(id) ?? 0);
    if (outside + count > Math.max(1, before)) {
      return false;
    }
  }
  return true;
}

function planShapeUnits(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  report: ProposalMergeReport,
  plan: MergingReplayPlan,
): void {
  const updatesByShape = new Map<string, Extract<SigmaDocMutationOp, { operation: "updateOverlayShape" }>[]>();
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    const mutation = entry.kind === "mutation" ? draft.mutationOperations?.[entry.index] : undefined;
    if (mutation?.operation === "updateOverlayShape") {
      updatesByShape.set(mutation.shapeId, [...(updatesByShape.get(mutation.shapeId) ?? []), mutation]);
    }
  }
  const currentShapes = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes;
  for (const [shapeId, updates] of updatesByShape) {
    const entity = mergeBasis.entities[shapeId];
    const ours = currentShapes.find((shape) => shape.id === shapeId);
    if (entity?.kind !== "shape" || !ours) {
      continue;
    }
    const base = structuredClone(entity.value);
    if (isSameContent(base, ours)) {
      continue;
    }
    let theirs: OverlayShape;
    try {
      theirs = updates.reduce((shape, update) => computeUpdatedOverlayShapes([shape], update)[0]!, base);
    } catch {
      continue;
    }
    report.humanEditedUnits.push(shapeId);
    const merge = mergeEntity3(base, structuredClone(ours), structuredClone(theirs));
    const valid = merge.report.duplicateIds.length === 0
      && isPlainRecord(merge.value)
      && merge.value.id === shapeId
      && merge.value.type === ours.type
      && isOverlayShape(merge.value);
    if (!valid) {
      report.invalidAfterMerge += 1;
      appendUnique(report.duplicateIds, merge.report.duplicateIds);
      plan.shapeUnits.set(shapeId, { id: shapeId, value: theirs, theirs, ours, usesMerged: false });
      continue;
    }
    addKernelReport(report, merge.report, shapeId);
    plan.shapeUnits.set(shapeId, {
      id: shapeId,
      value: merge.value,
      theirs,
      ours,
      usesMerged: !isSameContent(merge.value, theirs),
    });
  }
}

function planDeletions(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  report: ProposalMergeReport,
  plan: MergingReplayPlan,
): void {
  const currentShapes = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes;
  const editedSinceBase = (id: string): boolean => {
    const entity = mergeBasis.entities[id];
    if (!entity) {
      return false;
    }
    const current = entity.kind === "block"
      ? findBlock(document, id)
      : currentShapes.find((shape) => shape.id === id);
    // A target the human deleted too is left to the replay (it reports the missing target).
    return current !== null && current !== undefined && !isSameContent(entity.value, current);
  };
  (draft.mutationOperations ?? []).forEach((mutation, index) => {
    const ids = mutation.operation === "deleteBlocks"
      ? mutation.blockIds
      : mutation.operation === "deleteOverlayShapes" ? mutation.shapeIds : null;
    if (!ids) {
      return;
    }
    const kept = ids.filter(editedSinceBase);
    if (kept.length === 0) {
      return;
    }
    plan.deleteRewrites.set(index, ids.filter((id) => !kept.includes(id)));
    appendUnique(report.editBeatsDelete, kept.map((id) => `#${id}`));
    appendUnique(report.humanEditedUnits, kept);
  });
}

function planAnchorRelocations(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  report: ProposalMergeReport,
  plan: MergingReplayPlan,
): void {
  const createdIds = new Set<string>();
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    if (entry.kind !== "operation") {
      continue;
    }
    const operation = draft.operations[entry.index]!;
    if (isReplaceOperation(operation)) {
      countContentIds(operation.replacementBlock).forEach((_, id) => createdIds.add(id));
      continue;
    }
    if (operation.operation !== "insertAfter") {
      continue;
    }
    const anchorId = operation.targetId;
    const anchor = mergeBasis.anchors?.[anchorId];
    if (anchor && !createdIds.has(anchorId) && !findBlock(document, anchorId)) {
      const relocated = anchor.precedingIds.find((id) => (
        findBlock(document, id) !== null && findBlockContainer(document, id) === anchor.container
      ));
      if (relocated) {
        plan.anchorRewrites.set(entry.index, relocated);
        report.anchorRelocated += 1;
      }
    }
    createdIds.add(operation.insertedBlock.id);
  }
}

/** Same walk as the legacy asset-collision check, so exactly its collisions are renamed. */
function planAssetRenames(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  report: ProposalMergeReport,
  plan: MergingReplayPlan,
): void {
  const assets: Record<string, unknown> = {
    ...normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).assets,
  };
  const declared = new Set(draft.operations.flatMap((operation) => (
    operation.operation === "insertOverlayShape" ? Object.keys(operation.assets ?? {}) : []
  )));
  for (const operation of draft.operations) {
    if (operation.operation !== "insertOverlayShape") {
      continue;
    }
    for (const [assetId, asset] of Object.entries(operation.assets ?? {})) {
      const existing = assets[assetId];
      if (existing === undefined || areStructurallyEqual(existing, asset)) {
        assets[assetId] = asset;
        continue;
      }
      let suffix = 2;
      while (assets[`${assetId}-${suffix}`] !== undefined || declared.has(`${assetId}-${suffix}`)) {
        suffix += 1;
      }
      const renamedId = `${assetId}-${suffix}`;
      assets[renamedId] = { ...asset, id: renamedId };
      const renames = plan.assetRenames.get(operation.overlayShape.id) ?? new Map<string, string>();
      renames.set(assetId, renamedId);
      plan.assetRenames.set(operation.overlayShape.id, renames);
      report.reidentified += 1;
    }
  }
}

function buildRewrittenDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  plan: MergingReplayPlan,
  choice: "merged" | "theirs",
): AiEditSessionDraft {
  const unitByOperation = new Map<number, BlockUnitPlan>();
  for (const unit of plan.blockUnits.values()) {
    unit.operationIndexes.forEach((index) => unitByOperation.set(index, unit));
  }
  const removedOperations = new Set<number>();
  const removedMutations = new Set<number>();

  const operations = draft.operations.map((operation, index): AiEditDraft => {
    const unit = unitByOperation.get(index);
    if (unit && isReplaceOperation(operation)) {
      const value = choice === "merged" ? unit.value : unit.theirs;
      const replacement = operation.targetId === unit.id
        ? value
        : findBlockWithin(document, value, operation.targetId);
      if (!replacement) {
        // The merged unit no longer holds this target: the AI's edit of it was a no-op on a block
        // the human removed, so there is nothing left to replace.
        removedOperations.add(index);
        return operation;
      }
      const replace: Extract<AiEditDraft, { replacementBlock: EditableBlock }> = {
        ...(operation as Extract<AiEditDraft, { replacementBlock: EditableBlock }>),
        replacementBlock: structuredClone(replacement),
      };
      return replace;
    }
    const anchorId = plan.anchorRewrites.get(index);
    if (anchorId && operation.operation === "insertAfter") {
      return { ...operation, targetId: anchorId };
    }
    if (operation.operation === "insertOverlayShape") {
      const renames = plan.assetRenames.get(operation.overlayShape.id);
      if (renames) {
        return {
          ...operation,
          overlayShape: { ...operation.overlayShape, props: renameAssetReferences(operation.overlayShape.props, renames) } as OverlayShape,
          assets: renameAssets(operation.assets, renames),
        };
      }
    }
    return operation;
  });

  const mutationOperations = draft.mutationOperations?.map((mutation, index): SigmaDocMutationOp => {
    if (mutation.operation === "updateOverlayShape") {
      const unit = plan.shapeUnits.get(mutation.shapeId);
      if (unit) {
        return { ...mutation, patch: shapePatch(unit.ours, choice === "merged" ? unit.value : unit.theirs) };
      }
      const renames = plan.assetRenames.get(mutation.shapeId);
      if (renames) {
        const patchProps = isPlainRecord(mutation.patch.props) ? mutation.patch.props : undefined;
        return {
          ...mutation,
          patch: patchProps ? { ...mutation.patch, props: renameAssetReferences(patchProps, renames) } : mutation.patch,
          ...(mutation.assets ? { assets: renameAssets(mutation.assets, renames) } : {}),
        };
      }
      return mutation;
    }
    const remaining = plan.deleteRewrites.get(index);
    if (remaining && mutation.operation === "deleteBlocks") {
      if (remaining.length === 0) {
        removedMutations.add(index);
        return mutation;
      }
      return { ...mutation, blockIds: remaining };
    }
    if (remaining && mutation.operation === "deleteOverlayShapes") {
      if (remaining.length === 0) {
        removedMutations.add(index);
        return mutation;
      }
      return { ...mutation, shapeIds: remaining };
    }
    return mutation;
  });

  return removeDraftEntries(
    { ...draft, operations, ...(mutationOperations ? { mutationOperations } : {}) },
    removedOperations,
    removedMutations,
  );
}

/** Drops operations and re-indexes the recorded cross-array order accordingly. */
function removeDraftEntries(
  draft: AiEditSessionDraft,
  removedOperations: ReadonlySet<number>,
  removedMutations: ReadonlySet<number>,
): AiEditSessionDraft {
  if (removedOperations.size === 0 && removedMutations.size === 0) {
    return draft;
  }
  const reindex = (length: number, removed: ReadonlySet<number>) => {
    const map = new Map<number, number>();
    let next = 0;
    for (let index = 0; index < length; index += 1) {
      if (!removed.has(index)) {
        map.set(index, next);
        next += 1;
      }
    }
    return map;
  };
  const operationIndex = reindex(draft.operations.length, removedOperations);
  const mutationIndex = reindex(draft.mutationOperations?.length ?? 0, removedMutations);
  return {
    ...draft,
    operations: draft.operations.filter((_, index) => !removedOperations.has(index)),
    ...(draft.mutationOperations
      ? { mutationOperations: draft.mutationOperations.filter((_, index) => !removedMutations.has(index)) }
      : {}),
    ...(draft.operationOrder
      ? {
          operationOrder: draft.operationOrder.flatMap((entry) => {
            const index = (entry.kind === "operation" ? operationIndex : mutationIndex).get(entry.index);
            return index === undefined ? [] : [{ kind: entry.kind, index }];
          }),
        }
      : {}),
  };
}

/**
 * The plain replay of a rewritten draft, plus the check a plain replay never needed: the rewrite
 * must not leave an id more often in the document than before.
 */
function replayRewrittenDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): { draft: AiEditSessionDraft; nextDocument: SigmaDocument } {
  if (draft.operations.length === 0 && (draft.mutationOperations?.length ?? 0) === 0) {
    // Every operation was superseded by the human's edits (e.g. edited blocks the AI deleted).
    return { draft, nextDocument: parseSigmaDocument(document) };
  }
  const replay = replayProposalDraft(document, draft);
  const before = countContentIds(document.content);
  for (const [id, count] of countContentIds(replay.nextDocument.content)) {
    if (count > Math.max(1, before.get(id) ?? 0)) {
      throw new Error(te("electron.proposal.regenerateReplayFailed"));
    }
  }
  return replay;
}

/** The fields to patch onto `from` (the current shape) so it becomes `to`. */
function shapePatch(from: OverlayShape, to: OverlayShape): Record<string, unknown> {
  const fromRecord = from as unknown as Record<string, unknown>;
  const toRecord = to as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(fromRecord), ...Object.keys(toRecord)])) {
    if (key !== "id" && key !== "type" && key !== "props" && !isSameContent(fromRecord[key], toRecord[key])) {
      patch[key] = toRecord[key];
    }
  }
  const fromProps = isPlainRecord(fromRecord.props) ? fromRecord.props : {};
  const toProps = isPlainRecord(toRecord.props) ? toRecord.props : {};
  const props: Record<string, unknown> = {};
  for (const key of new Set([...Object.keys(fromProps), ...Object.keys(toProps)])) {
    if (!isSameContent(fromProps[key], toProps[key])) {
      props[key] = toProps[key];
    }
  }
  return Object.keys(props).length > 0 ? { ...patch, props } : patch;
}

const ASSET_REFERENCE_PROPS = ["assetId", "previewAssetId"] as const;

function renameAssetReferences<T extends Record<string, unknown>>(props: T, renames: ReadonlyMap<string, string>): T {
  let next = props;
  for (const key of ASSET_REFERENCE_PROPS) {
    const value = props[key];
    if (typeof value === "string" && renames.has(value)) {
      next = { ...next, [key]: renames.get(value) };
    }
  }
  return next;
}

function renameAssets<T extends { id: string }>(
  assets: Record<string, T> | undefined,
  renames: ReadonlyMap<string, string>,
): Record<string, T> {
  return Object.fromEntries(Object.entries(assets ?? {}).map(([assetId, asset]) => {
    const renamed = renames.get(assetId);
    return renamed ? [renamed, { ...asset, id: renamed }] : [assetId, asset];
  }));
}

function addKernelReport(report: ProposalMergeReport, kernel: ThreeWayMergeReport, unitId: string): void {
  const prefix = (path: string) => `#${unitId}${path.slice(1)}`;
  appendUnique(report.overlaps, kernel.overlaps.map(prefix));
  report.capped ||= kernel.capped;
  appendUnique(report.cappedPaths, kernel.cappedPaths.map(prefix));
  report.reidentified += kernel.reidentified;
  appendUnique(report.editBeatsDelete, kernel.editBeatsDelete.map(prefix));
}

function appendUnique(target: string[], values: readonly string[]): void {
  for (const value of values) {
    if (!target.includes(value)) {
      target.push(value);
    }
  }
}

/** How often each node id (blocks, list items, formulas...) appears in a value. */
function countContentIds(value: unknown): Map<string, number> {
  const counts = new Map<string, number>();
  const visit = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(visit);
      return;
    }
    if (!isPlainRecord(current)) {
      return;
    }
    if (typeof current.id === "string" && typeof current.type === "string") {
      counts.set(current.id, (counts.get(current.id) ?? 0) + 1);
    }
    Object.values(current).forEach(visit);
  };
  visit(value);
  return counts;
}

/** Structural equality that ignores `updatedAt` at any depth (MISS R1) and explicit undefined. */
function isSameContent(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left)
      && Array.isArray(right)
      && left.length === right.length
      && left.every((value, index) => isSameContent(value, right[index]));
  }
  if (!isPlainRecord(left) || !isPlainRecord(right)) {
    return false;
  }
  const keys = (record: Record<string, unknown>) => Object.keys(record)
    .filter((key) => key !== "updatedAt" && record[key] !== undefined);
  const leftKeys = keys(left);
  const rightKeys = keys(right);
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key) => (
      Object.prototype.hasOwnProperty.call(right, key) && isSameContent(left[key], right[key])
    ));
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function orderDraftOperationsForReplay(document: SigmaDocument, draft: AiEditSessionDraft): AiEditSessionDraft {
  const operations = orderItemsByReplacementAncestry(document, draft.operations, (operation) => (
    isReplaceOperation(operation) ? [operation.targetId] : []
  ));
  return operations.every((operation, index) => operation === draft.operations[index])
    ? draft
    : { ...draft, operations };
}

/**
 * Stable topological ordering for overlapping whole-block replacements. The only added dependency
 * is ancestor -> descendant; unrelated edits retain their original order. Applying the ancestor's
 * whole-block snapshot first lets the descendant's edit land inside it afterwards, so neither
 * intent is silently lost regardless of which proposal is newer.
 */
export function orderItemsByReplacementAncestry<T>(
  document: SigmaDocument,
  items: T[],
  targetIdsOf: (item: T) => string[],
): T[] {
  if (items.length < 2) {
    return items;
  }

  const targetIds = items.map(targetIdsOf);
  const outgoing = items.map(() => new Set<number>());
  const indegree = items.map(() => 0);
  const addDependency = (before: number, after: number) => {
    if (!outgoing[before].has(after)) {
      outgoing[before].add(after);
      indegree[after] += 1;
    }
  };

  for (let left = 0; left < items.length; left += 1) {
    for (let right = left + 1; right < items.length; right += 1) {
      const leftContainsRight = hasAncestorTarget(document, targetIds[left], targetIds[right]);
      const rightContainsLeft = hasAncestorTarget(document, targetIds[right], targetIds[left]);
      if (leftContainsRight && !rightContainsLeft) {
        // Left is ancestor of right: always ensure ancestor is applied before descendant
        // to prevent the descendant's stale snapshot (based on old ancestor state) from being lost
        addDependency(left, right);
      } else if (rightContainsLeft && !leftContainsRight) {
        // Right is ancestor of left: always ensure ancestor is applied before descendant
        // to prevent the descendant's stale snapshot (based on old ancestor state) from being lost
        addDependency(right, left);
      }
    }
  }

  const remaining = new Set(items.map((_, index) => index));
  const ordered: T[] = [];
  while (remaining.size > 0) {
    const nextIndex = [...remaining].find((index) => indegree[index] === 0);
    if (nextIndex === undefined) {
      return items;
    }
    remaining.delete(nextIndex);
    ordered.push(items[nextIndex]);
    for (const dependent of outgoing[nextIndex]) {
      indegree[dependent] -= 1;
    }
  }
  return ordered;
}

function hasAncestorTarget(document: SigmaDocument, possibleAncestors: string[], possibleDescendants: string[]): boolean {
  return possibleAncestors.some((ancestorId) => possibleDescendants.some((descendantId) => {
    if (ancestorId === descendantId) {
      return false;
    }
    const ancestor = findBlock(document, ancestorId);
    return ancestor ? editableBlockContainsId(ancestor, descendantId) : false;
  }));
}

function editableBlockContainsId(block: EditableBlock, targetId: string): boolean {
  if (block.id === targetId) {
    return true;
  }
  if (block.type === "problem") {
    return [...block.lead, ...block.prompt, ...block.solution, ...block.hints]
      .some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "layoutSection") {
    return block.children.some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "boxBlock") {
    return block.blocks.some((child) => editableBlockContainsId(child, targetId));
  }
  if (block.type === "list") {
    return block.items.some((item) => editableBlockContainsId(item, targetId));
  }
  if (block.type === "listItem") {
    return block.nested?.some((nested) => editableBlockContainsId(nested, targetId)) ?? false;
  }
  return false;
}

export function isReplaceOperation(
  operation: AiEditDraft,
): operation is AiEditDraft & { replacementBlock: EditableBlock } {
  return operation.operation === undefined || operation.operation === "replace";
}

export function collectReplaceTargetIds(draft: AiEditSessionDraft): string[] {
  return Array.from(new Set(
    draft.operations.filter(isReplaceOperation).map((operation) => operation.targetId),
  ));
}

/**
 * Rejects an approval whose replacements no longer change anything. Without a merge basis the
 * judgement is "did replaying change the current document"; with one it is "did the AI change the
 * base", so a change the human already made by hand does not fail the approval.
 */
export function assertAppliedProposalHasRealChanges(
  before: SigmaDocument,
  after: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis?: ProposalMergeBasis,
): void {
  const mutationOperations = draft.mutationOperations ?? [];
  if (
    draft.operations.length === 0
    || mutationOperations.length > 0
    || !draft.operations.every(isReplaceOperation)
  ) {
    return;
  }

  if (mergeBasis) {
    const units = groupReplaceOperationsByUnit(before, draft, mergeBasis);
    const covered = [...units.values()].reduce((count, indexes) => count + indexes.length, 0);
    const replaceCount = draft.operations.filter((operation) => (
      !isOverlayAnchorSupportDraft(operation, draft.operations)
    )).length;
    if (units.size > 0 && covered === replaceCount) {
      const unchanged = [...units].filter(([unitId, indexes]) => {
        const entity = mergeBasis.entities[unitId];
        if (entity?.kind !== "block") {
          return false;
        }
        const theirs = applyReplacementsToBlock(
          before,
          structuredClone(entity.value),
          indexes.map((index) => draft.operations[index] as ReplaceOperation),
        );
        return isSameContent(entity.value, theirs);
      });
      if (unchanged.length === units.size) {
        throw new Error(te("electron.proposalStore.diffLost", { ids: unchanged.map(([unitId]) => unitId).join(", ") }));
      }
      return;
    }
  }

  const diff = deriveAppliedDocumentDiff(before, after, [draft]);
  if (diff.shapes.length > 0 || diff.body.length === 0) {
    return;
  }
  const removed = new Map(
    diff.body.filter((entry) => entry.change === "removed").map((entry) => [entry.block.id, entry.block]),
  );
  const added = new Map(
    diff.body.filter((entry) => entry.change === "added").map((entry) => [entry.block.id, entry.block]),
  );
  if (
    removed.size > 0
    && removed.size === added.size
    && [...removed].every(([id, block]) => added.has(id) && areStructurallyEqual(block, added.get(id)))
  ) {
    throw new Error(
      te("electron.proposalStore.diffLost", { ids: [...removed.keys()].join(", ") }),
    );
  }
}

/**
 * 部分段組みは内容を上書きする操作ではないため、古いblockIds列をそのまま再生せず、
 * 提案時の先頭・末尾IDを範囲アンカーとして現在の兄弟ブロック列を取り直す。
 * これにより範囲外の編集はもちろん、範囲内へ追加された段落も現在内容のまま段組みに含まれる。
 */
function resolveLocalColumnRangesForReplay(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
): AiEditSessionDraft {
  const mutationOperations = draft.mutationOperations;
  if (!mutationOperations?.some((operation) => operation.operation === "wrapBlocksInColumns")) {
    return draft;
  }

  const resolvedOperations = mutationOperations.map((operation) => {
    if (operation.operation !== "wrapBlocksInColumns") {
      return operation;
    }
    const startBlockId = operation.blockIds[0];
    const endBlockId = operation.blockIds.at(-1);
    if (!startBlockId || !endBlockId) {
      throw new Error(te("electron.proposalStore.columnsRangeMissing"));
    }
    const blockIds = resolveTextFlowBlockRangeIds(document, startBlockId, endBlockId);
    if (!blockIds) {
      throw new Error(te("electron.proposalStore.columnsRangeNotFound", { startBlockId, endBlockId }));
    }
    return { ...operation, blockIds };
  });

  return { ...draft, mutationOperations: resolvedOperations };
}
