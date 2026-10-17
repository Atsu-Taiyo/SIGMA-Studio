import { createHash } from "node:crypto";
import path from "node:path";
import { promises as fs } from "node:fs";
import { durableWrite } from "./journal";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { rewriteAiOverlayShapeReplacementDrafts } from "@/lib/ai/overlay-shape-replacement";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import {
  blockContainsId,
  collectNonMergeableTargets,
  createEmptyProposalMergeReport,
  usableProposalMergeBasis,
  type ProposalMergeReport,
} from "@/lib/ai/proposal-merge-basis";
import { findBlock } from "@/lib/document-tree";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import type { CollaborationSessions } from "./sessions";
import { readSharedProposal } from "./proposal-context";
import { isServerRejection } from "./transport";
import type { LocalMcpEditProposalStore } from "../local-sigma-doc-proposal-store";
import type {
  ProposalApprovalPorts,
  ApproveProposalResult,
} from "../proposal-approval";
import type { LocalMcpEditProposal } from "../proposals/contracts";
import { collectConflictSensitiveBlockIds, collectRequiredInsertAnchorBlockIds } from "../proposals/freshness";
import { mergeProposalDraftsIntoDocument } from "../proposals/replay";
import {
  assertReadPreconditions,
  type ReadPrecondition,
  type SharedApproval,
} from "../../src/features/collaboration/model/approval";
import { stableValue, type ObjectValue } from "../../src/features/collaboration/model/value";

/** What the approval uses of the shared session. */
export type SharedProposalSessions = Pick<
  CollaborationSessions,
  "directory" | "has" | "flush" | "project" | "approve"
>;

/**
 * Approves proposals of a shared document. A proposal that carries a merge basis is merged with the
 * edits made since it was written (by anyone: the shared document has no locks) exactly as the local
 * approval and the preview merge it (`mergeProposalDraftsIntoDocument`), and the server is sent the
 * rewritten drafts with preconditions rebuilt for them (`prepareMergedApproval`). The approval record
 * (`collaboration-v1/proposals/*.json`) is not changed; a legacy record without a basis sends it as
 * recorded.
 */
export function createSharedProposalApprover(
  sessions: SharedProposalSessions,
  proposalStore: LocalMcpEditProposalStore,
  ports: Pick<
    ProposalApprovalPorts,
    "localSigmaDocStore" | "broadcastLocalStoreChange" | "translate"
  >,
): NonNullable<ProposalApprovalPorts["sharedProposalApprover"]> {
  return async (proposals) => {
    const fileId = proposals[0]?.fileId;
    if (!fileId || !sessions.has(fileId)) return undefined;
    return proposalStore.runExclusive(
      fileId,
      async (): Promise<ApproveProposalResult> => {
        try {
          const records: LocalMcpEditProposal[] = [];
          for (const proposal of proposals) {
            const fresh = await proposalStore.loadProposal(proposal.proposalId);
            if (
              fresh?.status !== "pending" ||
              fresh.updatedAt !== proposal.updatedAt
            )
              throw new Error("PROPOSAL_CHANGED");
            records.push(fresh);
          }
          const envelopes = await Promise.all(
            records.map((proposal) =>
              readSharedProposal(
                path.dirname(sessions.directory),
                proposal.proposalId,
              ),
            ),
          );
          // This window's projection only catches up with the other participants on an online
          // flush; the merge and the rebuilt preconditions must read what the server holds now.
          await throughServer(() => sessions.flush(fileId, true));
          // Persist the exact attempted request before sending it. A sync after a lost
          // response already includes our edits; merging again would conflict on inserted IDs.
          const attemptFile = path.join(sessions.directory, "approval-attempts", `${sha256(stableValue({
            fileId,
            records: records.map(({ proposalId, updatedAt }) => ({ proposalId, updatedAt })),
            operationIds: envelopes.map(({ operationId }) => operationId),
          }))}.json`);
          let before = sessions.project(fileId)!;
          let prepared: PreparedApproval;
          try {
            const attempt = JSON.parse(await fs.readFile(attemptFile, "utf8")) as { before: SigmaDocument; prepared: PreparedApproval };
            before = attempt.before;
            prepared = attempt.prepared;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            prepared = records.some(hasMergeBasis)
              ? await prepareMergedApproval(before, records, envelopes)
              : prepareRecordedApproval(records, envelopes);
            if (prepared.approval) {
              await fs.mkdir(path.dirname(attemptFile), { recursive: true, mode: 0o700 });
              await durableWrite(attemptFile, JSON.stringify({ before, prepared }));
            }
          }
          let accepted: { seq: number } | undefined;
          let document = before;
          if (prepared.approval) {
            const approval = prepared.approval;
            accepted = await throughServer(async () => {
              try {
                return await sessions.approve(fileId, approval, records.map((proposal) => proposal.proposalId));
              } catch (error) {
                // A definitive rejection did not apply the request. The next approval may
                // merge against newer edits; ambiguous transport failures keep the intent.
                if (isServerRejection(error)) await fs.rm(attemptFile, { force: true });
                throw error;
              }
            });
            document = sessions.project(fileId)!;
          }
          // The merged proposals first, so a group is resolved with its replayed member's report.
          let resolved = proposals[0];
          for (const proposalId of new Set([
            ...prepared.resolutionOrder,
            ...records.map((proposal) => proposal.proposalId),
          ])) {
            const fresh = await proposalStore.loadProposal(proposalId);
            if (fresh?.status === "pending")
              resolved = await proposalStore.resolveProposal(
                proposalId,
                "approved",
                ports.translate("electron.proposal.desktopApproved"),
                {
                  ...(accepted && prepared.approval
                    ? {
                        appliedRevision: accepted.seq,
                        appliedOperationId: prepared.approval.operationId,
                      }
                    : {}),
                  revertDocument: before,
                  appliedDocument: document,
                  ...(prepared.reports[proposalId]
                    ? { mergeReport: prepared.reports[proposalId] }
                    : {}),
                },
              );
          }
          await fs.rm(attemptFile, { force: true });
          for (const proposal of records)
            if (!hasMergeBasis(proposal))
              proposalStore.recordMergeFallback("shared-approval", {
                proposalId: proposal.proposalId,
                legacyNoBase: 1,
              });
          const file = (await ports.localSigmaDocStore.listFiles()).find(
            (item) => item.fileId === fileId,
          )!;
          ports.broadcastLocalStoreChange({
            type: "mcpProposal",
            change: "changed",
            timestamp: Date.now(),
          });
          return {
            ok: true,
            proposal: resolved,
            file: { ...file, revision: 1 },
            document,
            mergeReport: prepared.report,
          };
        } catch (error) {
          return sharedApprovalFailure(error, ports.translate);
        }
      },
    );
  };
}

/** A failure while this window talked to the sync server (the pre-approval sync or the approval itself). */
class ServerStepError extends Error {
  constructor(readonly reason: unknown) {
    super(String(reason));
  }
}

function throughServer<T>(step: () => Promise<T>): Promise<T> {
  return step().catch((error: unknown) => {
    throw new ServerStepError(error);
  });
}

/**
 * Only an edit the merge cannot keep is a conflict. Before approving, the shared document is synced:
 * when that fails, nothing about the proposal's targets is known, and calling it a conflict ("the target
 * was changed or deleted") sent people looking for an edit that never happened while the real cause —
 * a server refusing the document's unsent edits, or no connection — went unnoticed (MISS.md R21).
 */
function sharedApprovalFailure(
  error: unknown,
  translate: ProposalApprovalPorts["translate"],
): ApproveProposalResult {
  if (String(error).includes("PROPOSAL_CONFLICT"))
    return { ok: false, code: "conflict", error: translate("electron.proposal.changedBeforeApproval") };
  if (error instanceof ServerStepError)
    return {
      ok: false,
      error: translate(isServerRejection(error.reason)
        ? "electron.proposal.sharedServerRejected"
        : "electron.proposal.sharedSyncUnavailable"),
    };
  return { ok: false, code: "conflict", error: translate("electron.proposal.applyFailed") };
}

interface PreparedApproval {
  /** What to send, or null when the edits since the proposals made every operation unnecessary. */
  approval: SharedApproval | null;
  report: ProposalMergeReport;
  reports: Record<string, ProposalMergeReport>;
  /** The proposals the drafts were taken from, in replay order (resolved first). */
  resolutionOrder: string[];
}

function hasMergeBasis(proposal: LocalMcpEditProposal): boolean {
  return !proposal.invalidReason && usableProposalMergeBasis(proposal.mergeBasis) !== undefined;
}

/** Records without a merge basis: their recorded approvals, sent as they always were. */
function prepareRecordedApproval(
  records: LocalMcpEditProposal[],
  envelopes: SharedApproval[],
): PreparedApproval {
  const recorded = recordedApproval(envelopes);
  if (!recorded.consistent) throw new Error("PROPOSAL_CONFLICT");
  const legacy = { ...createEmptyProposalMergeReport(), legacyNoBase: 1 };
  return {
    approval: recorded.approval,
    report: { ...createEmptyProposalMergeReport(), legacyNoBase: records.length },
    reports: Object.fromEntries(records.map((proposal) => [proposal.proposalId, legacy])),
    resolutionOrder: [],
  };
}

/**
 * Merges the proposals into `current` (the shared document as the server holds it) in the batch
 * approval's order, without ever replaying a unit on the AI's side ("throw": the other participants
 * get no notice of an edit dropped for them), and rebuilds what the server checks:
 * - the merged units and anchors (`mergeBasis` entities and anchors) and what the rewritten drafts
 *   overwrite or anchor to (the targets the server requires a precondition on) are checked against
 *   their hashes in `current`, the document the merge was computed on;
 * - the targets the merge cannot keep an edit of (`collectNonMergeableTargets`, the rule the local
 *   approval and the editor's locks read) keep their recorded hashes from the proposal's base, and one
 *   in `current` without a recorded hash (a member or an anchored shape added since) is a conflict;
 * - everything else recorded (the reference material the AI read, the request's selection, the page
 *   settings, moved blocks) keeps its recorded hash.
 * The same checks run on `current` before anything is sent, so an edit the merge cannot keep stops the
 * approval (PROPOSAL_CONFLICT) here as it would on the server.
 */
async function prepareMergedApproval(
  current: SigmaDocument,
  records: LocalMcpEditProposal[],
  envelopes: SharedApproval[],
): Promise<PreparedApproval> {
  const ordered = [...records]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
    .map((proposal) => (proposal.invalidReason ? { ...proposal, mergeBasis: undefined } : proposal));
  const merged = mergeProposalDraftsIntoDocument(current, ordered, { onMergeFailure: "throw" });
  if (merged.failed.length > 0) throw new Error("PROPOSAL_CONFLICT");
  const drafts = merged.drafts
    .map(({ draft }) => draft)
    .filter((draft) => draft.operations.length > 0 || (draft.mutationOperations?.length ?? 0) > 0);
  const preconditions = rebuildPreconditions(current, ordered, envelopes, drafts);
  await assertReadPreconditions(current as unknown as ObjectValue, preconditions);
  const recorded = recordedApproval(envelopes);
  const unchanged = recorded.consistent
    && stableValue(drafts) === stableValue(recorded.approval.drafts)
    && stableValue(sortById(preconditions)) === stableValue(sortById(recorded.approval.preconditions));
  return {
    // A new merge gets a deterministic identity. The caller durably retains this
    // request for an ambiguous failure, so retries do not merge onto their own result.
    approval: drafts.length === 0
      ? null
      : unchanged
        ? recorded.approval
        : {
            operationId: mergedOperationId(envelopes, drafts, preconditions),
            preconditions,
            drafts,
          },
    report: merged.report,
    reports: merged.reports,
    resolutionOrder: merged.drafts.map(({ proposalId }) => proposalId),
  };
}

function rebuildPreconditions(
  current: SigmaDocument,
  proposals: LocalMcpEditProposal[],
  envelopes: SharedApproval[],
  drafts: AiEditSessionDraft[],
): ReadPrecondition[] {
  const hashes = computeDocumentBlockHashes(current);
  const shapes = normalizeOverlaySnapshot(current.pageLayout?.overlay?.overlaySnapshot).shapes;
  const replacements = rewriteAiOverlayShapeReplacementDrafts(current, proposals).pairs;
  const nonMergeable = collectNonMergeableTargets(proposals, replacements, shapes);
  const keptIds = new Set([...nonMergeable.blockIds, ...nonMergeable.shapeIds]);
  // Checked as merged: the units and anchors the merge read in `current`, and what the rewritten
  // drafts overwrite or anchor to (the server requires a precondition on each, by the same rule):
  // the targets nested in a merged unit, an insertion's re-anchored target.
  const mergedIds = new Set([
    ...proposals.flatMap((proposal) => {
      const basis = usableProposalMergeBasis(proposal.mergeBasis);
      return basis ? [...Object.keys(basis.entities), ...Object.keys(basis.anchors ?? {})] : [];
    }),
    ...drafts.flatMap((draft) => [
      ...collectConflictSensitiveBlockIds(draft),
      ...collectRequiredInsertAnchorBlockIds(draft),
    ]),
  ].filter((id) => !keptIds.has(id)));
  const recorded = envelopes.flatMap((envelope) => envelope.preconditions);
  // A block's hash covers everything nested in it, so a recorded block that holds a merged block or
  // lies inside one (now or in the unit's base snapshot) is checked as merged too: the AI read the
  // problem holding the paragraph it rewrote, or the paragraphs of the problem it rewrote. Shapes do
  // not nest in hashes (a group's members and anchored shapes are shapes of their own, and a merged
  // shape is never one of those: `collectNonMergeableTargets` keeps them).
  const mergedBlocks = proposals.flatMap((proposal) => Object.entries(usableProposalMergeBasis(proposal.mergeBasis)?.entities ?? {}))
    .flatMap(([id, entity]) => (entity.kind === "block" && mergedIds.has(id) ? [entity.value] : []))
    .concat([...mergedIds].flatMap((id) => findBlock(current, id) ?? []));
  for (const { id } of recorded) {
    const block = keptIds.has(id) || mergedIds.has(id) ? null : findBlock(current, id);
    if (
      !keptIds.has(id)
      && mergedBlocks.some((merged) => blockContainsId(current, merged, id) || (block !== null && blockContainsId(current, block, merged.id)))
    )
      mergedIds.add(id);
  }
  const conditions = new Map<string, ReadPrecondition>();
  for (const condition of recorded) {
    if (mergedIds.has(condition.id)) continue;
    if ((conditions.get(condition.id)?.hash ?? condition.hash) !== condition.hash)
      throw new Error("PROPOSAL_CONFLICT");
    conditions.set(condition.id, condition);
  }
  for (const id of keptIds)
    if (hashes[id] !== undefined && !conditions.has(id))
      throw new Error("PROPOSAL_CONFLICT");
  // A merged unit or anchor gone from `current` was deleted on both sides or re-anchored by the merge:
  // the rewritten drafts no longer read it.
  for (const id of mergedIds)
    if (hashes[id] !== undefined) conditions.set(id, { id, hash: hashes[id] });
  return [...conditions.values()];
}

/** The group's recorded approvals as one, as they were always sent. */
function recordedApproval(envelopes: SharedApproval[]): {
  approval: SharedApproval;
  /** False when the envelopes record different hashes for one target (a conflict when sent as is). */
  consistent: boolean;
} {
  let consistent = true;
  const conditions = new Map<string, ReadPrecondition>();
  for (const condition of envelopes.flatMap((envelope) => envelope.preconditions)) {
    if ((conditions.get(condition.id)?.hash ?? condition.hash) !== condition.hash) consistent = false;
    conditions.set(condition.id, condition);
  }
  return {
    approval: {
      // The same group of approval envelopes always has the same durable operation id.
      operationId: envelopes.length === 1
        ? envelopes[0].operationId
        : uuidFromHash(sha256(envelopes.map((envelope) => envelope.operationId).join("\0"))),
      preconditions: [...conditions.values()],
      drafts: envelopes.flatMap((envelope) => envelope.drafts ?? [envelope.draft]),
    },
    consistent,
  };
}

/**
 * The operation id of a rewritten approval: a hash of the recorded operation ids and of what is sent.
 * Retrying from the same shared document rebuilds the same drafts and preconditions, so the server
 * sees the same operation again; once the document has changed, the merge is a different operation.
 *
 * The server must answer the same operation id and body with the original receipt, checking
 * idempotency before preconditions. The caller persists the request before sending, including
 * rewritten drafts, so a lost response is retried unchanged even after restart and sync.
 */
function mergedOperationId(
  envelopes: SharedApproval[],
  drafts: unknown[],
  preconditions: ReadPrecondition[],
): string {
  return uuidFromHash(sha256(stableValue({
    operationIds: envelopes.map((envelope) => envelope.operationId),
    drafts,
    preconditions: sortById(preconditions),
  })));
}

const sortById = (conditions: ReadPrecondition[]) =>
  [...conditions].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** UUID-shaped (version 4 layout): the session matches its own AI operations by this shape. */
const uuidFromHash = (hash: string) =>
  `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
