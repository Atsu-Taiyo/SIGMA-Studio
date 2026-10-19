import { normalizeOverlaySnapshot, type OverlayShape, type SigmaDocument } from "@/features/document";
import { findBlock, updateBlockInDocument } from "@/lib/document-tree";
import {
  collectProposalMergeUnits,
  computeProposalMergeBasis,
  type ProposalMergeBasis,
  type ProposalMergeReport,
} from "@/lib/ai/proposal-merge-basis";
import { replayProposalDraftMerging } from "@/lib/ai/proposal-replay";
import { type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { areStructurallyEqual } from "@/lib/structural-equality";
import { readRunReadState, type ReadUnit } from "../electron/ai-read-state";

/**
 * How a write tool's draft relates to what the AI read in this run (issue #249, MISS R24).
 * - `unchanged`: nothing the draft overwrites changed since the AI read it (or it was not read).
 * - `merged`: a unit the human edited after the AI read it is merged as "read → written" onto the
 *   current unit: `draft` carries the merged contents, `nextDocument` is the working document with it.
 * - `failed`: such a merge would not validate or apply; nothing is merged on the AI's side.
 * `readIds` are the overwritten units the AI read in this run (`unreadIds` the others): only the unread
 * ones are left to the revision check of a local document (it cannot tell what the AI saw of them).
 */
export type ReadStateMerge =
  | { kind: "unchanged"; readIds: string[]; unreadIds: string[] }
  | {
      kind: "merged";
      readIds: string[];
      unreadIds: string[];
      mergedIds: string[];
      draft: AiEditSessionDraft;
      nextDocument: SigmaDocument;
      report: ProposalMergeReport;
    }
  | { kind: "failed"; readIds: string[]; unreadIds: string[]; ids: string[] };

/**
 * Merges a write with what the AI read instead of refusing it because the human edited the target
 * since (the old `REVISION_MISMATCH` "対象ブロックが編集されているため") or, on a shared document,
 * overwriting that edit with what the AI wrote from its read.
 *
 * The draft ran on `workingDocument` (the saved document with the chat's pending proposal). For each
 * unit it overwrites (a replaced block, a deleted block or shape, an updated shape) whose saved
 * contents differ from what the AI read, the read value becomes the base of a three-way merge (base =
 * read, ours = the working document, theirs = the AI's result), with the approval's merging replay and
 * without ever replaying a unit on the AI's side ("throw"). Units the human did not change since the
 * read are left as the draft has them.
 */
export async function mergeWriteWithReadState(params: {
  userData: string;
  fileId: string;
  runId: string | undefined;
  savedDocument: SigmaDocument;
  workingDocument: SigmaDocument;
  draft: AiEditSessionDraft;
}): Promise<ReadStateMerge> {
  const { savedDocument, workingDocument, draft } = params;
  const units = collectProposalMergeUnits(draft);
  const overwritten = [...new Set([
    ...units.replaceTargetIds,
    ...units.deletedBlockIds,
    ...units.updatedShapeIds,
    ...units.deletedShapeIds,
  ])];
  if (overwritten.length === 0) {
    return { kind: "unchanged", readIds: [], unreadIds: [] };
  }
  const readState = await readRunReadState(params.userData, params.fileId, params.runId);
  const savedShapes = new Map(normalizeOverlaySnapshot(savedDocument.pageLayout?.overlay?.overlaySnapshot).shapes
    .map((shape) => [shape.id, shape]));
  const savedValue = (id: string, kind: ReadUnit["kind"]) => (kind === "block" ? findBlock(savedDocument, id) : savedShapes.get(id)) ?? undefined;
  const readIds: string[] = [];
  const unreadIds: string[] = [];
  const changed = new Map<string, ReadUnit>();
  for (const id of overwritten) {
    const read = readState.get(id);
    if (!read) {
      unreadIds.push(id);
      continue;
    }
    readIds.push(id);
    const saved = savedValue(id, read.kind);
    // A unit the human deleted since cannot be the target of the write (the tool would have failed).
    if (saved !== undefined && !isSameContent(read.value, saved)) {
      changed.set(id, read);
    }
  }
  if (changed.size === 0) {
    return { kind: "unchanged", readIds, unreadIds };
  }
  const readDocument = withReadUnits(savedDocument, changed);
  const basis = basisOfChangedUnits(computeProposalMergeBasis(draft, readDocument), savedDocument, savedShapes);
  if (Object.keys(basis.entities).length === 0) {
    return { kind: "unchanged", readIds, unreadIds };
  }
  try {
    const merged = replayProposalDraftMerging(workingDocument, draft, basis, "throw");
    return {
      kind: "merged",
      readIds,
      unreadIds,
      mergedIds: Object.keys(basis.entities),
      draft: merged.rebasedDraft,
      nextDocument: merged.nextDocument,
      report: merged.report,
    };
  } catch {
    return { kind: "failed", readIds, unreadIds, ids: [...changed.keys()] };
  }
}

/** `document` with the given units as the AI read them (blocks in place, shapes by id). */
function withReadUnits(document: SigmaDocument, units: ReadonlyMap<string, ReadUnit>): SigmaDocument {
  let next = document;
  const shapes = new Map<string, OverlayShape>();
  for (const [id, unit] of units) {
    if (unit.kind === "block") {
      next = updateBlockInDocument(next, id, () => structuredClone(unit.value));
    } else {
      shapes.set(id, structuredClone(unit.value));
    }
  }
  if (shapes.size === 0) {
    return next;
  }
  const snapshot = normalizeOverlaySnapshot(next.pageLayout?.overlay?.overlaySnapshot);
  return {
    ...next,
    pageLayout: {
      ...next.pageLayout,
      overlay: {
        ...next.pageLayout?.overlay,
        overlaySnapshot: { ...snapshot, shapes: snapshot.shapes.map((shape) => shapes.get(shape.id) ?? shape) },
      },
    },
  } as SigmaDocument;
}

/** Only the units whose read value differs from the saved one are merged; the rest stay as written. */
function basisOfChangedUnits(
  basis: ProposalMergeBasis,
  savedDocument: SigmaDocument,
  savedShapes: ReadonlyMap<string, OverlayShape>,
): ProposalMergeBasis {
  const entities = Object.fromEntries(Object.entries(basis.entities).filter(([id, entity]) => {
    const saved = entity.kind === "block" ? findBlock(savedDocument, id) : savedShapes.get(id);
    return saved !== null && saved !== undefined && !isSameContent(entity.value, saved);
  }));
  return { version: 1, entities };
}

function isSameContent(left: unknown, right: unknown): boolean {
  return areStructurallyEqual(withoutUpdatedAt(left), withoutUpdatedAt(right));
}

function withoutUpdatedAt(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutUpdatedAt);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== "updatedAt")
      .map(([key, child]) => [key, withoutUpdatedAt(child)]));
  }
  return value;
}
