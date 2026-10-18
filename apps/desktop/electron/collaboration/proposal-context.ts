import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { normalizeOverlaySnapshot, type SigmaDocument } from "@/features/document";
import { collectNonMergeableTargets } from "@/lib/ai/proposal-merge-basis";
import {
  computeDocumentBlockHashes,
  hashSigmaNode,
} from "@/lib/sigma-doc-block-hash";
import type { LocalMcpEditProposal } from "../proposals/contracts";
import { hasSharedBinding } from "./local-bridge";
import { durableWrite } from "./journal";
import type {
  ReadPrecondition,
  SharedApproval,
} from "../../src/features/collaboration/model/approval";
import {
  PAGE_LAYOUT_TARGET,
  pageLayoutPrecondition,
} from "../../src/features/collaboration/model/approval";
import type { ObjectValue } from "../../src/features/collaboration/model/value";

const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function approvalFile(userData: string, proposalId: string): string {
  return path.join(
    userData,
    "collaboration-v1",
    "proposals",
    `${digest(proposalId)}.json`,
  );
}
export async function captureSharedProposal(
  userData: string,
  proposal: LocalMcpEditProposal,
  baseDocument?: SigmaDocument,
): Promise<void> {
  if (
    proposal.status !== "pending" ||
    !(await hasSharedBinding(userData, proposal.fileId))
  )
    return;
  const file = approvalFile(userData, proposal.proposalId);
  const draftHash = digest(JSON.stringify(proposal.draft));
  let previous: { draftHash: string; approval: SharedApproval } | undefined;
  try {
    previous = JSON.parse(await fs.readFile(file, "utf8")) as typeof previous;
  } catch (error) {
    if (!(
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ))
      throw error;
  }
  if (previous?.draftHash === draftHash) return;
  // What the AI only read (reference material, the request's selection) is not a precondition: a
  // change of it since the AI read it is no reason to refuse the proposal (issue #249, MISS R24). The
  // AI's writes were merged from what it read (`electron/ai-read-state.ts`), and the approval
  // merges the edits made since. Only what the approval overwrites is recorded here: the touched
  // targets and the targets it cannot merge, with their base hashes.
  const conditions = new Map<string, ReadPrecondition>();
  if (
    baseDocument &&
    proposal.draft.mutationOperations?.some((operation) =>
      ["updatePageLayout", "setDocumentColumns"].includes(operation.operation),
    )
  ) {
    conditions.set(PAGE_LAYOUT_TARGET, {
      id: PAGE_LAYOUT_TARGET,
      hash: hashSigmaNode(
        pageLayoutPrecondition(baseDocument as unknown as ObjectValue),
      ),
    });
  }
  for (const item of proposal.touchedBlocks ?? [])
    if (item.baseHash && !conditions.has(item.id))
      conditions.set(item.id, { id: item.id, hash: item.baseHash });
  if (baseDocument) {
    // The targets the approval cannot merge an edit of (`collectNonMergeableTargets`) keep their base
    // hash at approval, including the shapes a deletion reaches that the draft does not name (a
    // group's members, shapes anchored to a deleted one, a graph's labels). A shared document has no
    // locks, so these hashes are what stops another participant's edit of one from being dropped.
    const hashes = computeDocumentBlockHashes(baseDocument);
    const shapes = normalizeOverlaySnapshot(baseDocument.pageLayout?.overlay?.overlaySnapshot).shapes;
    const targets = collectNonMergeableTargets([proposal], [], shapes);
    for (const id of [...targets.blockIds, ...targets.shapeIds])
      if (hashes[id] && !conditions.has(id)) conditions.set(id, { id, hash: hashes[id] });
  }
  const approval: SharedApproval = {
    operationId: randomUUID(),
    draft: proposal.draft,
    preconditions: [...conditions.values()],
  };
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await durableWrite(file, JSON.stringify({ draftHash, approval }));
}
/** A proposal's shared approval record as stored, or null when it has none (not a shared document). */
export async function readSharedApprovalRecord(
  userData: string,
  proposalId: string,
): Promise<string | null> {
  try {
    return await fs.readFile(approvalFile(userData, proposalId), "utf8");
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    )
      return null;
    throw error;
  }
}
/** Puts back a record read with `readSharedApprovalRecord` (a rolled-back proposal's, unchanged). */
export async function restoreSharedApprovalRecord(
  userData: string,
  proposalId: string,
  record: string,
): Promise<void> {
  const file = approvalFile(userData, proposalId);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await durableWrite(file, record);
}
export async function readSharedProposal(
  userData: string,
  proposalId: string,
): Promise<SharedApproval> {
  const value = JSON.parse(
    await fs.readFile(approvalFile(userData, proposalId), "utf8"),
  ) as { approval: SharedApproval };
  return value.approval;
}
