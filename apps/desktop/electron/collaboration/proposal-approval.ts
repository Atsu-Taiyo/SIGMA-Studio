import { createHash } from "node:crypto";
import path from "node:path";
import type { CollaborationSessions } from "./sessions";
import { readSharedProposal } from "./proposal-context";
import type { LocalMcpEditProposalStore } from "../local-sigma-doc-proposal-store";
import type {
  ProposalApprovalPorts,
  ApproveProposalResult,
} from "../proposal-approval";
import type { ReadPrecondition } from "../../src/features/collaboration/model/approval";

export function createSharedProposalApprover(
  sessions: CollaborationSessions,
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
          for (const proposal of proposals) {
            const fresh = await proposalStore.loadProposal(proposal.proposalId);
            if (
              fresh?.status !== "pending" ||
              fresh.updatedAt !== proposal.updatedAt
            )
              throw new Error("PROPOSAL_CHANGED");
          }
          const envelopes = await Promise.all(
            proposals.map((proposal) =>
              readSharedProposal(
                path.dirname(sessions.directory),
                proposal.proposalId,
              ),
            ),
          );
          const conditions = new Map<string, ReadPrecondition>();
          for (const envelope of envelopes)
            for (const condition of envelope.preconditions) {
              if (
                conditions.has(condition.id) &&
                conditions.get(condition.id)!.hash !== condition.hash
              )
                throw new Error("PROPOSAL_CONFLICT");
              conditions.set(condition.id, condition);
            }
          // The same group of approval envelopes always has the same durable operation id.
          const hash = createHash("sha256")
            .update(
              envelopes.map((envelope) => envelope.operationId).join("\0"),
            )
            .digest("hex");
          const operationId =
            envelopes.length === 1
              ? envelopes[0].operationId
              : `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
          const before = sessions.project(fileId)!;
          const accepted = await sessions.approve(fileId, {
            operationId,
            preconditions: [...conditions.values()],
            drafts: envelopes.flatMap(
              (envelope) => envelope.drafts ?? [envelope.draft],
            ),
          }, proposals.map(proposal => proposal.proposalId));
          const document = sessions.project(fileId)!;
          let resolved = proposals[0];
          for (const proposal of proposals) {
            const fresh = await proposalStore.loadProposal(proposal.proposalId);
            if (fresh?.status === "pending")
              resolved = await proposalStore.resolveProposal(
                proposal.proposalId,
                "approved",
                ports.translate("electron.proposal.desktopApproved"),
                {
                  appliedRevision: accepted.seq,
                  appliedOperationId: operationId,
                  revertDocument: before,
                  appliedDocument: document,
                },
              );
          }
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
          };
        } catch (error) {
          return {
            ok: false,
            code: "conflict",
            error: ports.translate(
              String(error).includes("PROPOSAL_CONFLICT")
                ? "electron.proposal.changedBeforeApproval"
                : "electron.proposal.applyFailed",
            ),
          };
        }
      },
    );
  };
}
