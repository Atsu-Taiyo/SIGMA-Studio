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
  collectReinsertedDeletionIds,
  combineProposalMergeReports,
  createEmptyProposalMergeReport,
  findBlockContainer,
  insertedIdOf,
  findBlockWithin,
  replaceDescendant,
  usableProposalMergeBasis,
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
  /** The normalized draft the replay applied (merged contents written in). Never persist it. */
  draft: AiEditSessionDraft;
  /**
   * The given draft with the merged contents written in, before the replay's normalization (the
   * same operations, minus those the merge superseded). Persisting it together with a basis taken
   * from `document` rebases the proposal onto `document`: what the human had changed becomes part
   * of the base, and the replacements hold what the AI was shown on top of it.
   */
  rebasedDraft: AiEditSessionDraft;
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
 * - A block or shape the AI deletes is kept when the human edited it (`editBeatsDelete`), and
 *   deleting one the human already deleted is done. When the draft deletes an id and inserts it
 *   again (a replacement under the same id), the deletion runs and the inserted value is merged
 *   with the human's edits of the old one (base = its snapshot). A replacement under a temporary
 *   id (the batch approval's delete + insert pairs) is two separate operations: the edited old one
 *   is kept and the new one added.
 * - A block or shape the human deleted is not revived: its replacement fails as before, so the
 *   caller reports the usual conflict (`anchor-missing`).
 * - An `insertAfter` whose anchor the human deleted moves after the nearest preceding sibling the
 *   basis remembers in the same container; without one it fails as before.
 * - An inserted image asset whose id is now taken by a different image is renamed (`<id>-<n>`) and
 *   the inserted shape (and the draft's later updates of it) point to the new id.
 * - A merged unit that fails validation (schema, an id the merge repeats or that collides with the
 *   rest of the document) is replaced by the AI's version (`invalidAfterMerge`). When the replay
 *   fails with the merged units, only the units whose merged contents cannot be applied fall back
 *   to the AI's version. When even that fails the error is thrown: the conflict cannot be resolved.
 * - Moves, layout changes and the legacy normalizations stay the plain replay's.
 *
 * When nothing deviates from the plain replay (no unit was edited by the human, nothing had to be
 * re-anchored or renamed), the result is exactly `replayProposalDraft` and the report is empty.
 *
 * `onMergeFailure` is `rewriteProposalDraftMerging`'s: "throw" replays nothing on the AI's side.
 */
export function replayProposalDraftMerging(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  onMergeFailure: ProposalMergeFailureRule = "ai-side",
): ProposalMergeReplayResult {
  // Only insertAfter anchors can move; a shape inserted against a block or shape the human deleted
  // keeps the legacy contract: the external anchor must still exist.
  const missingAnchors = findMissingShapeInsertAnchors(document, draft);
  if (missingAnchors.length > 0) {
    throw new ProposalMergeReplayError(te("electron.proposal.regenerateMissingTarget"), "anchor-missing", missingAnchors);
  }
  // Without anything to merge the rewrite hands the draft itself, which is replayed as it is.
  const merged = rewriteProposalDraftMerging(document, draft, mergeBasis, (rewrite) => (
    rewrite.draft === draft ? replayProposalDraft(document, draft) : replayRewrittenDraft(document, rewrite.draft)
  ), onMergeFailure);
  return { ...merged.result, rebasedDraft: merged.rewrite.draft, report: merged.report };
}

/** What a merge that fails validation or cannot be replayed does (`rewriteProposalDraftMerging`). */
export type ProposalMergeFailureRule = "ai-side" | "throw";

/**
 * A draft rewritten by the merge: the given draft with the merged contents written in, minus the
 * operations the merge superseded (a deletion of blocks or shapes the human edited or deleted too, a
 * nested replacement whose target the merged unit no longer holds). The maps give, for each operation
 * and mutation index of the given draft, its index in `draft`; a superseded one is absent.
 */
export interface ProposalDraftRewrite {
  draft: AiEditSessionDraft;
  operationIndexes: ReadonlyMap<number, number>;
  mutationIndexes: ReadonlyMap<number, number>;
}

/**
 * The merge of `replayProposalDraftMerging` without its replay, for an owner that replays drafts with
 * its own procedure (WebMCP keeps its insertion tracking, move checks and the ids it generates
 * implicitly): writes the merged contents of every unit the human edited since `mergeBasis` into the
 * draft (the same plan as the approval: replaced blocks, deleted blocks and shapes, updated shapes,
 * reinsertions, the insertAfter anchors the basis remembers, renamed image assets) and replays the
 * rewritten draft with `replay`. Without anything to merge, `replay` gets the draft unchanged and the
 * report is empty.
 *
 * `onMergeFailure` decides what a failed merge does.
 * - "ai-side", the approval's rule (MISS R2): a unit whose merged contents fail validation is replayed
 *   in the AI's version, and when `replay` throws with the merged units, only the units whose merged
 *   contents cannot be applied fall back to the AI's version; when even that fails, `replay`'s first
 *   error is thrown. Each fallback is counted (`invalidAfterMerge`) and the person is told.
 * - "throw", for an owner whose person gets no such notice but whose agent re-reads and retries a
 *   stale draft (WebMCP), or whose document other people edit too (a shared document's approval):
 *   nothing falls back to the AI's version, so no human edit is dropped. A unit whose merged contents
 *   fail validation throws `ProposalMergeValidationError` with its id, and `replay`'s error is thrown
 *   as it is.
 */
export function rewriteProposalDraftMerging<T>(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  replay: (rewrite: ProposalDraftRewrite) => T,
  onMergeFailure: ProposalMergeFailureRule = "ai-side",
): { rewrite: ProposalDraftRewrite; result: T; report: ProposalMergeReport } {
  const plan = planMergingReplay(document, draft, mergeBasis);
  if (onMergeFailure === "throw") {
    const invalidIds = allUnits(plan).filter((unit) => unit.outcome === "invalid").map((unit) => unit.id);
    if (invalidIds.length > 0) {
      throw new ProposalMergeValidationError(te("electron.proposal.regenerateReplayFailed"), invalidIds);
    }
  }
  const attempt = (fallBack: ReadonlySet<string>) => {
    const rewrite = plan.rewrites ? rewriteDraft(document, draft, plan, fallBack) : removeDraftEntries(draft, new Set(), new Set());
    return { rewrite, result: replay(rewrite) };
  };
  try {
    return { ...attempt(new Set()), report: assembleReport(plan, new Set()) };
  } catch (error) {
    if (onMergeFailure === "throw") {
      throw error;
    }
    // Without merged units (nothing to rewrite) this rethrows `replay`'s error at once.
    const { replay: merged, fallBack } = retryWithFailingUnitsOnTheAiSide(plan, attempt, error);
    return { ...merged, report: assembleReport(plan, fallBack) };
  }
}

/**
 * A merged result that fails validation (a unit whose merge is not a valid block or shape, an id the
 * merge repeats), with the units or ids concerned. A plain replay error is never one of these.
 */
export class ProposalMergeValidationError extends Error {
  constructor(message: string, readonly ids: string[]) {
    super(message);
    this.name = "ProposalMergeValidationError";
  }
}

/** The replay left ids more often in the document than before (a merged unit repeated them). */
export class ProposalReplayRepeatedIdError extends ProposalMergeValidationError {
  constructor(ids: string[]) {
    super(te("electron.proposal.regenerateReplayFailed"), ids);
    this.name = "ProposalReplayRepeatedIdError";
  }
}

/**
 * The check a plain replay never needed: replaying a rewritten (merged) draft must not leave an id
 * more often in the document than before (a unit the merge could not keep apart, replayed on the AI's
 * side next to the human's copy). The approval (`replayRewrittenDraft`) and WebMCP's replay share it.
 */
export function assertNoRepeatedContentIds(before: SigmaDocument, after: SigmaDocument): void {
  const counts = countContentIds(before.content);
  const repeated = [...countContentIds(after.content)]
    .filter(([id, count]) => count > Math.max(1, counts.get(id) ?? 0))
    .map(([id]) => id);
  if (repeated.length > 0) {
    throw new ProposalReplayRepeatedIdError(repeated);
  }
}

/**
 * Replays one proposal the way its approval does: with a usable merge basis through the merging
 * replay (the human's edits since the base are kept), otherwise through the legacy replay, counted
 * as `legacyNoBase`. The report includes what the room's earlier turns merged (`mergeCarry`).
 *
 * The approval (main) and the renderer's preview of a pending proposal both call this, so the
 * preview shows exactly what an approval would save.
 *
 * `draft` is what to replay plainly (`replayProposalDraft`) onto `document` for `nextDocument`: the
 * merged contents written in (`rebasedDraft`), or the proposal's own draft without a merge basis. It
 * has no operations when the human's edits made every one of them unnecessary; `nextDocument` is then
 * `document`. A shared document's approval sends it to the server, which replays it plainly.
 */
export function replayProposalForApproval(
  document: SigmaDocument,
  proposal: { draft: AiEditSessionDraft; mergeBasis?: ProposalMergeBasis; mergeCarry?: ProposalMergeReport },
  onMergeFailure: ProposalMergeFailureRule = "ai-side",
): { nextDocument: SigmaDocument; report: ProposalMergeReport; draft: AiEditSessionDraft } {
  const mergeBasis = usableProposalMergeBasis(proposal.mergeBasis);
  if (mergeBasis) {
    const merged = replayProposalDraftMerging(document, proposal.draft, mergeBasis, onMergeFailure);
    return {
      nextDocument: merged.nextDocument,
      report: proposal.mergeCarry ? combineProposalMergeReports([proposal.mergeCarry, merged.report]) : merged.report,
      draft: merged.rebasedDraft,
    };
  }
  return {
    nextDocument: replayProposalDraft(document, proposal.draft).nextDocument,
    report: { ...createEmptyProposalMergeReport(), legacyNoBase: 1 },
    draft: proposal.draft,
  };
}

/**
 * The replay failed with the merged units. Each merged unit is tried alone (the others on the AI's
 * side) to find the ones whose merged contents cannot be applied, and only those fall back to the
 * AI's version, so the other units keep the human's edits. If that combination still fails, every
 * merged unit falls back; if even that fails, the original error is rethrown.
 */
function retryWithFailingUnitsOnTheAiSide<R extends object>(
  plan: MergingReplayPlan,
  attempt: (fallBack: ReadonlySet<string>) => R,
  error: unknown,
): { replay: R; fallBack: ReadonlySet<string> } {
  const mergedIds = allUnits(plan)
    .filter((unit) => unit.usesMerged)
    .map((unit) => unit.id);
  const tryAttempt = (fallBack: ReadonlySet<string>): R | null => {
    try {
      return attempt(fallBack);
    } catch {
      return null;
    }
  };
  const failing = mergedIds.filter((id) => tryAttempt(new Set(mergedIds.filter((other) => other !== id))) === null);
  for (const fallBack of [new Set(failing), new Set(mergedIds)]) {
    if (fallBack.size === 0) {
      continue;
    }
    const replay = tryAttempt(fallBack);
    if (replay) {
      return { replay, fallBack };
    }
  }
  throw error;
}

/** The report of what was actually replayed, given the units that fell back to the AI's side. */
function assembleReport(plan: MergingReplayPlan, fallBack: ReadonlySet<string>): ProposalMergeReport {
  const report = createEmptyProposalMergeReport();
  for (const unit of allUnits(plan)) {
    if (unit.outcome === "invalid" || fallBack.has(unit.id)) {
      report.invalidAfterMerge += 1;
      appendUnique(report.duplicateIds, unit.kernel.duplicateIds);
      continue;
    }
    addKernelReport(report, unit.kernel, unit.id);
    if (unit.outcome === "merged") {
      report.humanEditedUnits.push(unit.id);
    }
  }
  appendUnique(report.editBeatsDelete, plan.keptDeletions.map((id) => `#${id}`));
  appendUnique(report.humanEditedUnits, plan.keptDeletions);
  report.anchorRelocated = plan.anchorRewrites.size;
  report.reidentified += plan.renamedAssetCount;
  return report;
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
      // The inserted block's nested blocks (a problem's paragraphs...) are created too.
      countContentIds(operation.insertedBlock).forEach((_, id) => createdIds.add(id));
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
  /**
   * merged: the merged unit is replayed. invalid: the merge failed validation, so the AI's version
   * is replayed. typeAdopted: the sides disagree on the unit's node type and the kernel took the
   * AI's node whole; the human's edits of it are lost, which the kernel reports as an overlap.
   */
  outcome: "merged" | "invalid" | "typeAdopted";
  /** The value to replay unless the unit falls back to the AI's version. */
  value: T;
  /** The AI's version (base + the draft's own edits of this unit). */
  theirs: T;
  /** Whether `value` differs from `theirs` (a fallback would change the result). */
  usesMerged: boolean;
  /** What the kernel decided; it counts only when the merged value is what gets replayed. */
  kernel: ThreeWayMergeReport;
}

/** An outermost replaced block the human edited, with the indexes of the replace ops inside it. */
type BlockUnitPlan = MergeUnitPlan<EditableBlock> & { operationIndexes: number[] };

/** An updated shape the human edited. */
type ShapeUnitPlan = MergeUnitPlan<OverlayShape>;

/** A block or shape the draft deletes and inserts again under the same id, edited by the human. */
type ReinsertUnitPlan = MergeUnitPlan<EditableBlock | OverlayShape> & { operationIndex: number };

function allUnits(plan: MergingReplayPlan): Array<MergeUnitPlan<unknown> & { id: string }> {
  return [...plan.blockUnits.values(), ...plan.shapeUnits.values(), ...plan.reinsertUnits.values()];
}

interface MergingReplayPlan {
  rewrites: boolean;
  blockUnits: Map<string, BlockUnitPlan>;
  shapeUnits: Map<string, ShapeUnitPlan>;
  reinsertUnits: Map<string, ReinsertUnitPlan>;
  /** Mutation index → ids a delete op still deletes (the others were edited by the human). */
  deleteRewrites: Map<number, string[]>;
  /** Blocks and shapes the AI deletes that are kept because the human edited them. */
  keptDeletions: string[];
  /** Operation index → new insertAfter anchor. */
  anchorRewrites: Map<number, string>;
  /** Shape id → (old asset id → new asset id) for inserted images whose asset id was taken. */
  assetRenames: Map<string, Map<string, string>>;
  renamedAssetCount: number;
}

function planMergingReplay(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
): MergingReplayPlan {
  const plan: MergingReplayPlan = {
    rewrites: false,
    blockUnits: new Map(),
    shapeUnits: new Map(),
    reinsertUnits: new Map(),
    deleteRewrites: new Map(),
    keptDeletions: [],
    anchorRewrites: new Map(),
    assetRenames: new Map(),
    renamedAssetCount: 0,
  };
  const documentIds = countContentIds(document.content);
  planBlockUnits(document, draft, mergeBasis, plan, documentIds);
  planShapeUnits(document, draft, mergeBasis, plan);
  planDeletions(document, draft, mergeBasis, plan);
  planReinsertions(document, draft, mergeBasis, plan, documentIds);
  planAnchorRelocations(document, draft, mergeBasis, plan);
  planAssetRenames(document, draft, plan);
  plan.rewrites = plan.blockUnits.size > 0
    || plan.shapeUnits.size > 0
    || plan.reinsertUnits.size > 0
    || plan.deleteRewrites.size > 0
    || plan.anchorRewrites.size > 0
    || plan.assetRenames.size > 0;
  return plan;
}

function planBlockUnits(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
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
    const merge = mergeEntity3(base, structuredClone(ours), structuredClone(theirs));
    if (merge.value.type !== ours.type) {
      // The kernel's type rule took the AI's node whole (the human's type would have kept ours).
      plan.blockUnits.set(unitId, {
        id: unitId, outcome: "typeAdopted", value: merge.value, theirs, usesMerged: false, kernel: merge.report, operationIndexes,
      });
      continue;
    }
    const valid = merge.report.duplicateIds.length === 0
      && isValidMergedBlock(merge.value, ours, documentIds);
    plan.blockUnits.set(unitId, {
      id: unitId,
      outcome: valid ? "merged" : "invalid",
      value: valid ? merge.value : theirs,
      theirs,
      usesMerged: valid && !isSameContent(merge.value, theirs),
      kernel: merge.report,
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
  documentIds: Map<string, number>,
): boolean {
  if (!isPlainRecord(value) || value.id !== ours.id) {
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
    const merge = mergeEntity3(base, structuredClone(ours), structuredClone(theirs));
    const valid = merge.report.duplicateIds.length === 0
      && isPlainRecord(merge.value)
      && merge.value.id === shapeId
      && merge.value.type === ours.type
      && isOverlayShape(merge.value);
    plan.shapeUnits.set(shapeId, {
      id: shapeId,
      outcome: valid ? "merged" : "invalid",
      value: valid ? merge.value : theirs,
      theirs,
      usesMerged: valid && !isSameContent(merge.value, theirs),
      kernel: merge.report,
    });
  }
}

function planDeletions(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  plan: MergingReplayPlan,
): void {
  const currentShapes = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes;
  // A deletion followed by an insertion of the same id is a replacement (planReinsertions): it runs
  // as written. If the human deleted the target, the replay then fails as for any replaced target.
  const reinserted = collectReinsertedDeletionIds(draft);
  const stateSinceBase = (id: string): "edited" | "gone" | "unchanged" => {
    const entity = mergeBasis.entities[id];
    if (!entity || reinserted.has(id)) {
      return "unchanged";
    }
    const current = entity.kind === "block"
      ? findBlock(document, id)
      : currentShapes.find((shape) => shape.id === id);
    if (current === null || current === undefined) {
      // The human deleted it too: both sides want it gone, so this part of the deletion is done.
      return "gone";
    }
    return isSameContent(entity.value, current) ? "unchanged" : "edited";
  };
  (draft.mutationOperations ?? []).forEach((mutation, index) => {
    const ids = mutation.operation === "deleteBlocks"
      ? mutation.blockIds
      : mutation.operation === "deleteOverlayShapes" ? mutation.shapeIds : null;
    if (!ids) {
      return;
    }
    const states = new Map(ids.map((id) => [id, stateSinceBase(id)]));
    const kept = ids.filter((id) => states.get(id) === "edited");
    if (ids.every((id) => states.get(id) === "unchanged")) {
      return;
    }
    plan.deleteRewrites.set(index, ids.filter((id) => states.get(id) === "unchanged"));
    appendUnique(plan.keptDeletions, kept);
  });
}

function planReinsertions(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
  plan: MergingReplayPlan,
  documentIds: Map<string, number>,
): void {
  const reinserted = collectReinsertedDeletionIds(draft);
  if (reinserted.size === 0) {
    return;
  }
  const currentShapes = normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot).shapes;
  draft.operations.forEach((operation, operationIndex) => {
    const id = insertedIdOf(operation);
    const entity = id ? mergeBasis.entities[id] : undefined;
    if (!id || !entity || !reinserted.has(id) || plan.reinsertUnits.has(id)) {
      return;
    }
    const insertsBlock = operation.operation === "insertAfter";
    if ((entity.kind === "block") !== insertsBlock) {
      return;
    }
    const ours = entity.kind === "block" ? findBlock(document, id) : currentShapes.find((shape) => shape.id === id);
    if (!ours || isSameContent(entity.value, ours)) {
      return;
    }
    const theirs: EditableBlock | OverlayShape = operation.operation === "insertAfter"
      ? operation.insertedBlock
      : operation.operation === "insertOverlayShape" ? operation.overlayShape : (operation as { tableShape: OverlayShape }).tableShape;
    const merge = mergeEntity3<EditableBlock | OverlayShape>(
      structuredClone(entity.value),
      structuredClone(ours),
      structuredClone(theirs),
    );
    if (merge.value.type !== theirs.type) {
      // The sides disagree on the node type and the kernel kept the human's: the AI's node wins.
      plan.reinsertUnits.set(id, {
        id, outcome: "typeAdopted", value: theirs, theirs, usesMerged: false, kernel: merge.report, operationIndex,
      });
      return;
    }
    const valid = merge.report.duplicateIds.length === 0 && (insertsBlock
      ? isValidMergedBlock(merge.value as EditableBlock, ours as EditableBlock, documentIds)
      : isPlainRecord(merge.value) && merge.value.id === id && isOverlayShape(merge.value));
    plan.reinsertUnits.set(id, {
      id,
      outcome: valid ? "merged" : "invalid",
      value: valid ? merge.value : theirs,
      theirs,
      usesMerged: valid && !isSameContent(merge.value, theirs),
      kernel: merge.report,
      operationIndex,
    });
  });
}

function planAnchorRelocations(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  mergeBasis: ProposalMergeBasis,
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
      }
    }
    countContentIds(operation.insertedBlock).forEach((_, id) => createdIds.add(id));
  }
}

/** Same walk as the legacy asset-collision check, so exactly its collisions are renamed. */
function planAssetRenames(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
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
      plan.renamedAssetCount += 1;
    }
  }
}

function rewriteDraft(
  document: SigmaDocument,
  draft: AiEditSessionDraft,
  plan: MergingReplayPlan,
  fallBack: ReadonlySet<string>,
): ProposalDraftRewrite {
  const unitByOperation = new Map<number, BlockUnitPlan>();
  for (const unit of plan.blockUnits.values()) {
    unit.operationIndexes.forEach((index) => unitByOperation.set(index, unit));
  }
  const removedOperations = new Set<number>();
  const removedMutations = new Set<number>();

  const reinsertByOperation = new Map([...plan.reinsertUnits.values()].map((unit) => [unit.operationIndex, unit]));
  const operations = draft.operations.map((operation, index): AiEditDraft => {
    const reinsert = reinsertByOperation.get(index);
    if (reinsert) {
      const value = structuredClone(fallBack.has(reinsert.id) ? reinsert.theirs : reinsert.value);
      if (operation.operation === "insertAfter") {
        return { ...operation, insertedBlock: value as EditableBlock };
      }
      if (operation.operation === "insertOverlayShape") {
        return { ...operation, overlayShape: value as OverlayShape };
      }
      if (operation.operation === "insertTableShape") {
        return { ...operation, tableShape: value as typeof operation.tableShape };
      }
    }
    const unit = unitByOperation.get(index);
    if (unit && isReplaceOperation(operation)) {
      const value = fallBack.has(unit.id) ? unit.theirs : unit.value;
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

  const lastWriters = lastShapePatchWriters(draft, plan);
  const mutationOperations = draft.mutationOperations?.map((mutation, index): SigmaDocMutationOp => {
    if (mutation.operation === "updateOverlayShape") {
      const unit = plan.shapeUnits.get(mutation.shapeId);
      if (unit) {
        const value = fallBack.has(unit.id) ? unit.theirs : unit.value;
        return { ...mutation, patch: mergedShapePatch(mutation.patch, value, index, lastWriters) };
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
): ProposalDraftRewrite {
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
  const operationIndexes = reindex(draft.operations.length, removedOperations);
  const mutationIndexes = reindex(draft.mutationOperations?.length ?? 0, removedMutations);
  if (removedOperations.size === 0 && removedMutations.size === 0) {
    return { draft, operationIndexes, mutationIndexes };
  }
  return {
    draft: {
      ...draft,
      operations: draft.operations.filter((_, index) => !removedOperations.has(index)),
      ...(draft.mutationOperations
        ? { mutationOperations: draft.mutationOperations.filter((_, index) => !removedMutations.has(index)) }
        : {}),
      ...(draft.operationOrder
        ? {
            operationOrder: draft.operationOrder.flatMap((entry) => {
              const index = (entry.kind === "operation" ? operationIndexes : mutationIndexes).get(entry.index);
              return index === undefined ? [] : [{ kind: entry.kind, index }];
            }),
          }
        : {}),
    },
    operationIndexes,
    mutationIndexes,
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
  assertNoRepeatedContentIds(document, replay.nextDocument);
  return replay;
}

/**
 * For each merged shape, which update operation (mutation index) writes each field last
 * (`x`, `props.color`...), in the order the draft runs.
 */
function lastShapePatchWriters(draft: AiEditSessionDraft, plan: MergingReplayPlan): Map<string, number> {
  const writers = new Map<string, number>();
  for (const entry of resolveAiEditSessionOperationOrder(draft)) {
    const mutation = entry.kind === "mutation" ? draft.mutationOperations?.[entry.index] : undefined;
    if (mutation?.operation !== "updateOverlayShape" || !plan.shapeUnits.has(mutation.shapeId)) {
      continue;
    }
    for (const key of shapePatchKeys(mutation.patch)) {
      writers.set(`${mutation.shapeId}\0${key}`, entry.index);
    }
  }
  return writers;
}

function shapePatchKeys(patch: Record<string, unknown>): string[] {
  const keys = Object.keys(patch).filter((key) => key !== "id" && key !== "type" && key !== "props");
  const props = isPlainRecord(patch.props) ? Object.keys(patch.props).map((key) => `props.${key}`) : [];
  return [...keys, ...props];
}

/**
 * An update of a merged shape keeps the fields it writes, and the operation that writes a field
 * last carries the merged value of that field. Earlier writes stay as the AI made them, so an
 * alignment between two updates still sees (and keeps) the positions the AI meant; fields the AI
 * never writes stay the human's.
 */
function mergedShapePatch(
  patch: Record<string, unknown>,
  merged: OverlayShape,
  mutationIndex: number,
  lastWriters: ReadonlyMap<string, number>,
): Record<string, unknown> {
  const mergedRecord = merged as unknown as Record<string, unknown>;
  const mergedProps = isPlainRecord(mergedRecord.props) ? mergedRecord.props : {};
  const shapeId = mergedRecord.id as string;
  const isLastWrite = (key: string) => lastWriters.get(`${shapeId}\0${key}`) === mutationIndex;
  const next: Record<string, unknown> = {};
  for (const key of Object.keys(patch)) {
    if (key === "props" && isPlainRecord(patch.props)) {
      next.props = Object.fromEntries(Object.entries(patch.props).map(([propKey, value]) => (
        [propKey, isLastWrite(`props.${propKey}`) ? mergedProps[propKey] : value]
      )));
    } else {
      next[key] = key !== "id" && key !== "type" && isLastWrite(key) ? mergedRecord[key] : patch[key];
    }
  }
  return next;
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

/**
 * Content equality of two units (blocks, overlay shapes). This is `areStructurallyEqual`, the
 * equality `areSigmaDocumentsEquivalent` uses (MISS R1); `comparableDocumentValue` itself is not
 * needed because it only removes document-level write timestamps (`updatedAt` of the document and
 * the overlay), and block and shape values carry none.
 */
function isSameContent(left: unknown, right: unknown): boolean {
  return areStructurallyEqual(left, right);
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
