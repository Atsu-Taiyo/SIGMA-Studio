import { findBlock } from "@/lib/document-tree";
import { type SigmaDocument } from "@/features/document";
import {
  assertAppliedProposalHasRealChanges,
  collectReplaceTargetIds,
  replayProposalDraft,
  replayProposalForApproval,
} from "@/lib/ai/proposal-replay";
import { mergeProposalDraftsIntoDocument, type MergeProposalDraftsResult } from "@/lib/ai/proposal-batch-replay";
import { type LocalMcpEditProposal } from "./contracts";

// The pure replay lives in `lib/ai/proposal-replay.ts` so the renderer can run the same function;
// these re-exports keep the Electron and MCP entry points (and their identity) unchanged.
export {
  assertAppliedProposalHasRealChanges,
  collectReplaceTargetIds,
  mergeProposalDraftsIntoDocument,
  replayProposalDraft,
  replayProposalForApproval,
};
export type { MergeProposalDraftsResult };

export function findMissingUpdateRichContentTargetIds(
  proposal: Pick<LocalMcpEditProposal, "source" | "draft">,
  document: SigmaDocument,
): string[] {
  if (proposal.source.toolName !== "update_rich_content" && proposal.source.toolName !== "draft_update_rich_content") {
    return [];
  }
  return collectReplaceTargetIds(proposal.draft).filter((targetId) => !findBlock(document, targetId));
}
