import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { paragraphDocument, replaceParagraphDraft } from "../tests/fixtures/proposal-document";
import { LocalMcpEditProposalStore } from "./local-sigma-doc-proposal-store";
import { LocalSigmaDocStore } from "./local-sigma-doc-store";
import { createProposalApprovalCoordinator, type ProposalApprovalPorts } from "./proposal-approval";
import type { LocalMcpEditProposal } from "./proposals/contracts";
import { replayProposalDraft } from "./proposals/replay";

type ApprovalMode = "single" | "batch";
const modes: ApprovalMode[] = ["single", "batch"];

describe("proposal approval application", () => {
  let userDataDir: string;
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-proposal-approval-"));
    fixture = await createFixture(userDataDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it.each(modes)("%s keeps claim, document CAS, resolution and notification order", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({ ok: true });

    expect(fixture.trace).toEqual([
      "proposal:load", "proposal:lock", "proposal:claimed", "proposal:load",
      "document:lock", "document:claimed", "document:list", "document:load",
      "document:save", "document:saved", "notify:documentVersion", "document:list",
      "proposal:resolve", "proposal:resolved",
      ...(mode === "single" ? ["hooks", "notify:mcpProposal"] : ["notify:mcpProposal", "hooks"]),
      "notify:document", "document:release", "proposal:release",
    ]);
    expect(fixture.saveDocument).toHaveBeenCalledWith(fixture.file.fileId, expect.anything(), {
      expectedRevision: fixture.file.revision, origin: "ai",
    });
    const savedFile = (await fixture.documents.listFiles())[0];
    const resolved = await fixture.proposals.loadProposal(proposal.proposalId);
    expect(resolved).toMatchObject({ status: "approved", appliedRevision: savedFile.revision });
    expect(resolved?.revertDocument).toEqual(parseSigmaDocument(fixture.baseDocument));
    expect(await fixture.readTexts()).toEqual(["AI", "p_2"]);
    expect(fixture.runPostSaveHooks).toHaveBeenCalledWith(fixture.file.fileId, expect.anything(), savedFile.revision);
    expect(fixture.broadcastLocalStoreChange.mock.calls.map(([event]) => event)).toEqual([
      { type: "documentVersion", fileId: fixture.file.fileId, change: "captured", timestamp: expect.any(Number) },
      { type: "mcpProposal", ...(mode === "single" ? { proposalId: proposal.proposalId } : {}), change: "changed", timestamp: expect.any(Number) },
      { type: "document", fileId: fixture.file.fileId, change: "changed", timestamp: expect.any(Number) },
    ]);
  });

  it("preserves automatic-approval attribution only on the single entry point", async () => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "automatic"));
    await expect(fixture.coordinator.approveSingleProposal(proposal.proposalId, { autoApplied: true })).resolves.toMatchObject({ ok: true });

    expect(await fixture.proposals.loadProposal(proposal.proposalId)).toMatchObject({ status: "approved", autoApplied: true });
    expect(fixture.broadcastLocalStoreChange).toHaveBeenNthCalledWith(2, {
      type: "mcpProposal", proposalId: proposal.proposalId, change: "changed", timestamp: expect.any(Number), autoApplied: true,
    });
    expect(fixture.broadcastLocalStoreChange).toHaveBeenNthCalledWith(3, {
      type: "document", fileId: fixture.file.fileId, change: "changed", timestamp: expect.any(Number),
      autoAppliedProposalIds: [proposal.proposalId],
    });
  });

  it.each(modes)("%s stops after a document save rejection without resolving or notifying", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    fixture.saveDocument.mockResolvedValueOnce({ ok: false, error: "save rejected", code: "revision-mismatch" });

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toEqual({ ok: false, error: "save rejected" });

    expect(await fixture.readTexts()).toEqual(["p_1", "p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("pending");
    expect(fixture.resolveProposal).not.toHaveBeenCalled();
    expect(fixture.runPostSaveHooks).not.toHaveBeenCalled();
    expect(fixture.broadcastLocalStoreChange).not.toHaveBeenCalled();
    expect(fixture.trace.slice(-2)).toEqual(["document:release", "proposal:release"]);
  });

  it.each(modes)("%s releases both locks and propagates a thrown save error", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const failure = new Error("document write failed");
    fixture.saveDocument.mockRejectedValueOnce(failure);

    await expect(fixture.approve(mode, proposal.proposalId)).rejects.toBe(failure);
    expect(fixture.trace.slice(-2)).toEqual(["document:release", "proposal:release"]);
    expect(fixture.resolveProposal).not.toHaveBeenCalled();
    expect(fixture.broadcastLocalStoreChange).not.toHaveBeenCalled();

    // A later attempt uses the same real store locks, so this also catches a lock left held on error.
    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({ ok: true });
  });

  it.each(modes)("%s leaves a saved document and pending proposal when proposal resolution throws", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const failure = new Error("proposal write failed");
    fixture.resolveProposal.mockRejectedValueOnce(failure);

    await expect(fixture.approve(mode, proposal.proposalId)).rejects.toBe(failure);

    expect(await fixture.readTexts()).toEqual(["AI", "p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("pending");
    expect(fixture.broadcastLocalStoreChange.mock.calls.map(([event]) => event.type)).toEqual(["documentVersion"]);
    expect(fixture.runPostSaveHooks).not.toHaveBeenCalled();
    expect(fixture.trace.slice(-2)).toEqual(["document:release", "proposal:release"]);
  });

  it("preserves a batch's already-resolved prefix when a later proposal write fails", async () => {
    const first = await fixture.createProposal(replaceParagraphDraft("p_1", "first"));
    const second = await fixture.createProposal(replaceParagraphDraft("p_2", "second"));
    const failure = new Error("second proposal write failed");
    fixture.resolveProposal.mockImplementationOnce((...args) => fixture.proposals.resolveProposal(...args));
    fixture.resolveProposal.mockRejectedValueOnce(failure);

    await expect(fixture.coordinator.approveProposals([first.proposalId, second.proposalId])).rejects.toBe(failure);

    expect(await fixture.readTexts()).toEqual(["first", "second"]);
    expect((await fixture.proposals.loadProposal(first.proposalId))?.status).toBe("approved");
    expect((await fixture.proposals.loadProposal(second.proposalId))?.status).toBe("pending");
    expect(fixture.broadcastLocalStoreChange.mock.calls.map(([event]) => event.type)).toEqual(["documentVersion"]);
    expect(fixture.runPostSaveHooks).not.toHaveBeenCalled();
  });

  it.each(modes)("%s preserves its notification prefix when post-save hooks fail", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const failure = new Error("post-save hook failed");
    fixture.runPostSaveHooks.mockRejectedValueOnce(failure);

    await expect(fixture.approve(mode, proposal.proposalId)).rejects.toBe(failure);

    expect(await fixture.readTexts()).toEqual(["AI", "p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("approved");
    expect(fixture.broadcastLocalStoreChange.mock.calls.map(([event]) => event.type)).toEqual(
      mode === "single" ? ["documentVersion"] : ["documentVersion", "mcpProposal"],
    );
  });

  for (const mode of modes) {
    it.each(["missing", "status", "fileId", "updatedAt", "draft"] as const)(`${mode} rejects a changed %s claim before taking the document lock`, async (change) => {
      const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
      const changed = structuredClone(proposal);
      if (change === "status") changed.status = "rejected";
      if (change === "fileId") changed.fileId = "another_file";
      if (change === "updatedAt") changed.updatedAt = "changed";
      if (change === "draft") changed.draft = replaceParagraphDraft("p_1", "new draft");
      fixture.loadProposal.mockResolvedValueOnce(proposal).mockResolvedValueOnce(change === "missing" ? null : changed);

      await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({ ok: false });

      expect(fixture.trace).not.toContain("document:lock");
      expect(fixture.saveDocument).not.toHaveBeenCalled();
      expect(fixture.resolveProposal).not.toHaveBeenCalled();
      expect(fixture.broadcastLocalStoreChange).not.toHaveBeenCalled();
    });
  }

  it.each(modes)("%s rechecks a proposal rejected while waiting for the real proposal lock", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const holding = deferred();
    const release = deferred();
    const clicked = deferred();
    const rejecting = fixture.proposals.runExclusive(fixture.file.fileId, async () => {
      holding.resolve();
      await release.promise;
      await fixture.proposals.rejectSingleProposal(proposal.proposalId);
    });
    await holding.promise;
    fixture.loadProposal.mockImplementationOnce(async (id) => {
      const snapshot = await fixture.proposals.loadProposal(id);
      clicked.resolve();
      return snapshot;
    });
    const approving = fixture.approve(mode, proposal.proposalId);
    await clicked.promise;
    release.resolve();
    await rejecting;

    await expect(approving).resolves.toMatchObject({ ok: false, error: expect.stringContaining("更新または処理") });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("rejected");
  });

  it.each<[ApprovalMode, ApprovalMode]>([["single", "single"], ["single", "batch"], ["batch", "single"]])(
    "serializes simultaneous %s and %s approvals and preserves both changes",
    async (firstMode, secondMode) => {
      const first = await fixture.createProposal(replaceParagraphDraft("p_1", "first"));
      const second = await fixture.createProposal(replaceParagraphDraft("p_2", "second"));

      const results = await Promise.all([
        fixture.approve(firstMode, first.proposalId),
        fixture.approve(secondMode, second.proposalId),
      ]);

      expect(results.map((result) => result.ok)).toEqual([true, true]);
      expect(await fixture.readTexts()).toEqual(["first", "second"]);
      expect(fixture.saveDocument.mock.calls.map(([, , options]) => options?.expectedRevision)).toEqual([
        fixture.file.revision, fixture.file.revision + 1,
      ]);
      expect(fixture.trace.filter((phase) => /^(?:proposal|document):(?:claimed|release)$/.test(phase))).toEqual([
        "proposal:claimed", "document:claimed", "document:release", "proposal:release",
        "proposal:claimed", "document:claimed", "document:release", "proposal:release",
      ]);
    },
  );

  it.each(modes)("%s holds the document lock through approval and rejects a queued stale renderer save", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const read = deferred();
    const release = deferred();
    fixture.loadDocument.mockImplementationOnce(async (fileId) => {
      const document = await fixture.documents.loadDocument(fileId);
      read.resolve();
      await release.promise;
      return document;
    });
    const approving = fixture.approve(mode, proposal.proposalId);
    await read.promise;
    const humanDocument = replayProposalDraft(fixture.baseDocument, replaceParagraphDraft("p_2", "human")).nextDocument;
    let rendererSettled = false;
    const rendererSave = fixture.documents.saveDocument(fixture.file.fileId, humanDocument, {
      expectedRevision: fixture.file.revision,
    }).then((result) => {
      rendererSettled = true;
      return result;
    });
    await Promise.resolve();
    expect(rendererSettled).toBe(false);
    release.resolve();

    await expect(approving).resolves.toMatchObject({ ok: true });
    await expect(rendererSave).resolves.toMatchObject({ ok: false, code: "revision-mismatch" });
    expect(await fixture.readTexts()).toEqual(["AI", "p_2"]);
  });

  it.each(modes)("%s records content conflicts and force applies against the latest revert document", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const humanDocument = replayProposalDraft(fixture.baseDocument, replaceParagraphDraft("p_1", "human")).nextDocument;
    await fixture.documents.saveDocument(fixture.file.fileId, humanDocument, { expectedRevision: fixture.file.revision });
    const latestDocument = await fixture.documents.loadDocument(fixture.file.fileId);

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({
      ok: false, code: "conflict", conflictReason: "content-stale", conflictBlockIds: ["p_1"],
    });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.conflict).toMatchObject({
      reason: "content-stale", blockIds: ["p_1"], detectedAtRevision: fixture.file.revision + 1,
    });

    await expect(fixture.approve(mode, proposal.proposalId, { force: true })).resolves.toMatchObject({ ok: true });
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.revertDocument).toEqual(parseSigmaDocument(latestDocument));
    expect(await fixture.readTexts()).toEqual(["AI", "p_2"]);
  });

  it.each(modes)("%s preserves a human append around an AI target instead of applying a stale block replacement", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    const humanDocument = replayProposalDraft(fixture.baseDocument, replaceParagraphDraft("p_1", "p_1 — human append")).nextDocument;
    await fixture.documents.saveDocument(fixture.file.fileId, humanDocument, { expectedRevision: fixture.file.revision });

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({
      ok: false, code: "conflict", conflictReason: "content-stale", conflictBlockIds: ["p_1"],
    });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect(await fixture.readTexts()).toEqual(["p_1 — human append", "p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("pending");
  });

  it("saves a batch's applicable proposals while returning and retaining its conflicts", async () => {
    const stale = await fixture.createProposal(replaceParagraphDraft("p_1", "stale"));
    const applicable = await fixture.createProposal(replaceParagraphDraft("p_2", "applicable"));
    const humanDocument = replayProposalDraft(fixture.baseDocument, replaceParagraphDraft("p_1", "human")).nextDocument;
    await fixture.documents.saveDocument(fixture.file.fileId, humanDocument, { expectedRevision: fixture.file.revision });

    await expect(fixture.coordinator.approveProposals([stale.proposalId, applicable.proposalId])).resolves.toMatchObject({
      ok: true, failed: [{ proposalId: stale.proposalId, conflictReason: "content-stale", conflictBlockIds: ["p_1"] }],
    });

    expect(await fixture.readTexts()).toEqual(["human", "applicable"]);
    expect((await fixture.proposals.loadProposal(stale.proposalId))?.status).toBe("pending");
    expect((await fixture.proposals.loadProposal(applicable.proposalId))?.status).toBe("approved");
    expect(fixture.saveDocument).toHaveBeenCalledTimes(1);
  });

  it.each(modes)("%s resolves all members of the real proposal group with the same saved revision", async (mode) => {
    const firstInput = fixture.proposalInput(replaceParagraphDraft("p_1", "first"));
    const secondInput = fixture.proposalInput(replaceParagraphDraft("p_2", "second"));
    const first = await fixture.proposals.upsertCurrentProposal({ ...firstInput, roomId: "room_group", runId: "run_group" });
    const representative = await fixture.proposals.upsertCurrentProposal({ ...secondInput, roomId: "room_group", runId: "run_group" });

    await expect(fixture.approve(mode, representative.proposalId)).resolves.toMatchObject({ ok: true });

    expect(await fixture.readTexts()).toEqual(["first", "second"]);
    const members = await Promise.all([first.proposalId, representative.proposalId].map((id) => fixture.proposals.loadProposal(id)));
    for (const member of members) {
      expect(member).toMatchObject({ status: "approved", appliedRevision: fixture.file.revision + 1 });
      expect(member?.revertDocument).toEqual(parseSigmaDocument(fixture.baseDocument));
    }
    expect(fixture.saveDocument).toHaveBeenCalledTimes(1);
  });
});

async function createFixture(userDataDir: string) {
  const documents = new LocalSigmaDocStore(userDataDir);
  const proposals = new LocalMcpEditProposalStore(userDataDir);
  await documents.initializeWorkspace({ initialDocument: paragraphDocument(["p_1", "p_2"]) });
  const file = (await documents.listFiles())[0];
  const baseDocument = parseSigmaDocument(await documents.loadDocument(file.fileId));
  const trace: string[] = [];
  const loadProposal = vi.fn<ProposalApprovalPorts["localMcpProposalStore"]["loadProposal"]>(async (...args) => {
    trace.push("proposal:load");
    return proposals.loadProposal(...args);
  });
  const resolveProposal = vi.fn<ProposalApprovalPorts["localMcpProposalStore"]["resolveProposal"]>(async (...args) => {
    trace.push("proposal:resolve");
    const result = await proposals.resolveProposal(...args);
    trace.push("proposal:resolved");
    return result;
  });
  const loadDocument = vi.fn<ProposalApprovalPorts["localSigmaDocStore"]["loadDocument"]>(async (...args) => {
    trace.push("document:load");
    return documents.loadDocument(...args);
  });
  const saveDocument = vi.fn<ProposalApprovalPorts["localSigmaDocStore"]["saveDocument"]>(async (...args) => {
    trace.push("document:save");
    const result = await documents.saveDocument(...args);
    trace.push("document:saved");
    return result;
  });
  const runPostSaveHooks = vi.fn<ProposalApprovalPorts["runPostSaveHooks"]>(async () => { trace.push("hooks"); });
  const broadcastLocalStoreChange = vi.fn<ProposalApprovalPorts["broadcastLocalStoreChange"]>(() => {});
  broadcastLocalStoreChange.mockImplementation((event) => { trace.push(`notify:${event.type}`); });
  const ports: ProposalApprovalPorts = {
    localSigmaDocStore: {
      runExclusive: (fileId, work) => {
        trace.push("document:lock");
        return documents.runExclusive(fileId, async () => {
          trace.push("document:claimed");
          try { return await work(); } finally { trace.push("document:release"); }
        });
      },
      listFiles: async () => { trace.push("document:list"); return documents.listFiles(); },
      loadDocument,
      saveDocument,
    },
    localMcpProposalStore: {
      runExclusive: (fileId, work) => {
        trace.push("proposal:lock");
        return proposals.runExclusive(fileId, async () => {
          trace.push("proposal:claimed");
          try { return await work(); } finally { trace.push("proposal:release"); }
        });
      },
      loadProposal,
      recordProposalConflict: (...args) => proposals.recordProposalConflict(...args),
      resolveProposal,
    },
    runPostSaveHooks,
    broadcastLocalStoreChange,
    translate: createCurrentLocaleTranslator("error"),
  };
  const coordinator = createProposalApprovalCoordinator(ports);
  const proposalInput = (draft: AiEditSessionDraft) => ({
    fileId: file.fileId,
    baseRevision: file.revision,
    baseDocument,
    summary: draft.summary,
    plan: draft.plan,
    provider: null,
    source: { toolName: "draft_update_rich_content", toolArgs: {} },
    draft,
    nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
  });
  return {
    documents, proposals, file, baseDocument, trace, coordinator, ports,
    loadProposal, resolveProposal, loadDocument, saveDocument, runPostSaveHooks, broadcastLocalStoreChange,
    proposalInput,
    createProposal: (draft: AiEditSessionDraft): Promise<LocalMcpEditProposal> => proposals.createProposal(proposalInput(draft)),
    approve: (mode: ApprovalMode, proposalId: string, options: { force?: boolean } = {}) => (
      mode === "single" ? coordinator.approveSingleProposal(proposalId, options) : coordinator.approveProposals([proposalId], options)
    ),
    readTexts: async () => documentTexts(parseSigmaDocument(await documents.loadDocument(file.fileId))),
  };
}

function documentTexts(document: SigmaDocument): string[] {
  return document.content.flatMap((block) => block.type === "paragraph"
    ? [block.children.flatMap((node) => node.type === "text" ? [node.text] : []).join("")]
    : []);
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
