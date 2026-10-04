import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ParagraphNode, SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { deleteBlocksFromDocument, updateBlockInDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

// Count every entry into the (whole-document) replay without changing what it does.
const replayCalls = vi.hoisted(() => ({ count: 0 }));
vi.mock("@/lib/ai/proposal-replay", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/proposal-replay")>();
  return {
    ...actual,
    replayProposalDraft: (...args: Parameters<typeof actual.replayProposalDraft>) => {
      replayCalls.count += 1;
      return actual.replayProposalDraft(...args);
    },
    replayProposalDraftMerging: (...args: Parameters<typeof actual.replayProposalDraftMerging>) => {
      replayCalls.count += 1;
      return actual.replayProposalDraftMerging(...args);
    },
  };
});

const { LocalMcpEditProposalStore } = await import("./local-sigma-doc-proposal-store");
const { EditableBlockSchema } = await import("@/lib/ai/sigma-doc-edit-schema");

const PARAGRAPH_COUNT = 2000;
const PENDING_PROPOSALS = 5;

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function largeDocument(): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_post_save_cost",
    metadata: { title: "Post-save cost" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: Array.from({ length: PARAGRAPH_COUNT }, (_, index) => paragraph(`p_${index}`, `段落${index}の本文です。`)),
  });
}

describe("post-save follow-up of merge-capable proposals", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-post-save-cost-"));
    replayCalls.count = 0;
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("does not replay any proposal when the human types inside what the pending proposals overwrite", async () => {
    const store = new LocalMcpEditProposalStore(userDataDir);
    const base = largeDocument();
    const targets = Array.from({ length: PENDING_PROPOSALS }, (_, index) => `p_${index * 400}`);
    for (const targetId of targets) {
      const draft: AiEditSessionDraft = {
        summary: "書き換え",
        plan: ["書き換え"],
        operations: [{ operation: "replace", summary: "書き換え", targetId, replacementBlock: paragraph(targetId, "AIの本文") }],
        warnings: [],
      };
      await store.createProposal({
        fileId: "file_1", baseRevision: 1, baseDocument: base, summary: draft.summary, plan: draft.plan,
        provider: null, source: { toolName: "draft_update_rich_content", toolArgs: {} }, draft, nextDocument: base,
      });
    }
    let current = base;
    for (const targetId of targets) {
      current = parseSigmaDocument(updateBlockInDocument(current, targetId, (block) => ({
        ...(block as ParagraphNode),
        children: [{ type: "text", text: "人間が打鍵中の本文" }],
      })));
    }
    replayCalls.count = 0;

    const result = await store.autoRebaseProposalsForFile("file_1", current, 2);

    expect(result.rebased).toHaveLength(PENDING_PROPOSALS);
    expect(result.conflicted).toEqual([]);
    expect(replayCalls.count).toBe(0);
  });

  it("does not re-evaluate a recorded conflict on a save that does not touch what it depends on", async () => {
    const store = new LocalMcpEditProposalStore(userDataDir);
    const base = largeDocument();
    const draft: AiEditSessionDraft = {
      summary: "書き換え",
      plan: ["書き換え"],
      operations: [{ operation: "replace", summary: "書き換え", targetId: "p_10", replacementBlock: paragraph("p_10", "AIの本文") }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1", baseRevision: 1, baseDocument: base, summary: draft.summary, plan: draft.plan,
      provider: null, source: { toolName: "draft_update_rich_content", toolArgs: {} }, draft, nextDocument: base,
    });
    await store.recordProposalConflict(proposal.proposalId, ["p_10"], 1, "replay-failed");
    // The human deleted the target: the conflict stays. The first save evaluates it and signs it.
    const firstSave = parseSigmaDocument(deleteBlocksFromDocument(base, ["p_10"]));
    await store.autoRebaseProposalsForFile("file_1", firstSave, 2);
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toMatchObject({ reason: "anchor-missing" });
    replayCalls.count = 0;

    const secondSave = parseSigmaDocument(updateBlockInDocument(firstSave, "p_1998", (block) => ({
      ...(block as ParagraphNode), children: [{ type: "text", text: "無関係な編集2" }],
    })));
    await store.autoRebaseProposalsForFile("file_1", secondSave, 3);

    expect(replayCalls.count).toBe(0);
  });

  it("lists proposals with large merge bases without validating the bases in full", async () => {
    const store = new LocalMcpEditProposalStore(userDataDir);
    const base = largeDocument();
    for (let index = 0; index < PENDING_PROPOSALS; index += 1) {
      const targetId = `p_${index}`;
      const draft: AiEditSessionDraft = {
        summary: "書き換え",
        plan: ["書き換え"],
        operations: [{ operation: "replace", summary: "書き換え", targetId, replacementBlock: paragraph(targetId, "AIの本文") }],
        warnings: [],
      };
      await store.createProposal({
        fileId: "file_1", baseRevision: 1, baseDocument: base, summary: draft.summary, plan: draft.plan,
        provider: null, source: { toolName: "draft_update_rich_content", toolArgs: {} }, draft, nextDocument: base,
      });
    }
    const fullChecks = vi.spyOn(EditableBlockSchema, "safeParse");

    const listed = await new LocalMcpEditProposalStore(userDataDir).listProposals({ status: "pending" });

    expect(listed).toHaveLength(PENDING_PROPOSALS);
    expect(listed.every((proposal) => proposal.mergeBasis)).toBe(true);
    expect(fullChecks).not.toHaveBeenCalled();
    fullChecks.mockRestore();
  });
});
