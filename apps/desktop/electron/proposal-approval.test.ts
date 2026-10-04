import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { createEmptyProposalMergeReport } from "@/lib/ai/proposal-merge-basis";
import { deleteBlocksFromDocument, updateBlockInDocument } from "@/lib/document-tree";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import type { ParagraphNode } from "@/features/document";
import { deleteBlockDraft, paragraphDocument, replaceParagraphDraft } from "../tests/fixtures/proposal-document";
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

  it.each(modes)("%s records content conflicts of a legacy record and force applies against the latest revert document", async (mode) => {
    const proposal = await fixture.createLegacyProposal(replaceParagraphDraft("p_1", "AI"));
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

  it.each(modes)("%s preserves a human append around a legacy record's target instead of applying a stale block replacement", async (mode) => {
    const proposal = await fixture.createLegacyProposal(replaceParagraphDraft("p_1", "AI"));
    const humanDocument = replayProposalDraft(fixture.baseDocument, replaceParagraphDraft("p_1", "p_1 — human append")).nextDocument;
    await fixture.documents.saveDocument(fixture.file.fileId, humanDocument, { expectedRevision: fixture.file.revision });

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({
      ok: false, code: "conflict", conflictReason: "content-stale", conflictBlockIds: ["p_1"],
    });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect(await fixture.readTexts()).toEqual(["p_1 — human append", "p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("pending");
  });

  it("saves a batch's applicable proposals while returning and retaining a legacy record's conflicts", async () => {
    const stale = await fixture.createLegacyProposal(replaceParagraphDraft("p_1", "stale"));
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

  it.each(modes)("%s keeps a human edit of another paragraph, saves both, and counts no fallback", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_2", "p_2 human"));

    const result = await fixture.approve(mode, proposal.proposalId);

    expect(result).toMatchObject({ ok: true, mergeReport: createEmptyProposalMergeReport() });
    expect(await fixture.readTexts()).toEqual(["AI", "p_2 human"]);
    expect(await fixture.readTextsFromFreshStore()).toEqual(["AI", "p_2 human"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.mergeReport).toEqual(createEmptyProposalMergeReport());
  });

  it.each(modes)("%s merges a human edit of the AI's own target instead of reporting a conflict", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "The dog sat."));
    // The base paragraph text is "p_1"; the human rewrites it before the AI's proposal is approved.
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 — human append"));

    const result = await fixture.approve(mode, proposal.proposalId);

    expect(result).toMatchObject({ ok: true, mergeReport: { humanEditedUnits: ["p_1"] } });
    const [merged] = await fixture.readTextsFromFreshStore();
    expect(merged).toContain("The dog sat.");
    expect(merged).toContain(" — human append");
    expect((await fixture.proposals.loadProposal(proposal.proposalId))).toMatchObject({
      status: "approved",
      mergeReport: { humanEditedUnits: ["p_1"] },
    });
  });

  it.each(modes)("%s keeps a block the AI deletes when the human edited it, and counts editBeatsDelete", async (mode) => {
    const proposal = await fixture.createProposal(deleteBlockDraft("p_1"));
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 edited"));

    const result = await fixture.approve(mode, proposal.proposalId);

    expect(result).toMatchObject({ ok: true, mergeReport: { editBeatsDelete: ["#p_1"] } });
    expect(await fixture.readTextsFromFreshStore()).toEqual(["p_1 edited", "p_2"]);
  });

  it.each(modes)("%s reports the usual conflict instead of reviving a target the human deleted", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    await fixture.saveHumanEdit((document) => parseSigmaDocument(deleteBlocksFromDocument(document, ["p_1"])));

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({
      ok: false, code: "conflict", conflictReason: "anchor-missing", conflictBlockIds: ["p_1"],
    });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect(await fixture.readTexts()).toEqual(["p_2"]);
    expect((await fixture.proposals.loadProposal(proposal.proposalId))).toMatchObject({
      status: "pending", conflict: { reason: "anchor-missing", blockIds: ["p_1"] },
    });
  });

  it.each(modes)("%s counts a legacy record without a merge basis as legacyNoBase", async (mode) => {
    const proposal = await fixture.createLegacyProposal(replaceParagraphDraft("p_1", "AI"));

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({
      ok: true, mergeReport: { legacyNoBase: 1 },
    });
  });

  it.each(modes)("%s keeps a human edit made between two turns of the same room", async (mode) => {
    const room = { roomId: "room_turns", runId: "run_turns" };
    await fixture.proposals.upsertCurrentProposal({ ...fixture.proposalInput(replaceParagraphDraft("p_1", "AI first")), ...room });
    const humanFile = await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 human"));
    const humanDocument = parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId));
    // The MCP server aggregates the room's draft and passes the latest saved document as the base.
    const aggregate: AiEditSessionDraft = {
      ...replaceParagraphDraft("p_2", "AI second"),
      operations: [
        ...replaceParagraphDraft("p_1", "AI first").operations,
        ...replaceParagraphDraft("p_2", "AI second").operations,
      ],
    };
    const second = await fixture.proposals.upsertCurrentProposal({
      ...fixture.proposalInput(aggregate),
      baseRevision: humanFile.revision,
      baseDocument: humanDocument,
      nextDocument: replayProposalDraft(humanDocument, aggregate).nextDocument,
      ...room,
    });

    await expect(fixture.approve(mode, second.proposalId)).resolves.toMatchObject({ ok: true });

    const [first, secondText] = await fixture.readTextsFromFreshStore();
    expect(first).toContain("AI first");
    expect(first).toContain(" human");
    expect(secondText).toBe("AI second");
  });

  it.each(modes)("%s keeps a human edit made before a later run of the same room adds to the draft", async (mode) => {
    await fixture.proposals.upsertCurrentProposal({
      ...fixture.proposalInput(replaceParagraphDraft("p_1", "AI first")),
      roomId: "room_runs", runId: "run_first",
    });
    const humanFile = await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 human"));
    const humanDocument = parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId));
    const aggregate: AiEditSessionDraft = {
      ...replaceParagraphDraft("p_2", "AI second"),
      operations: [
        ...replaceParagraphDraft("p_1", "AI first").operations,
        ...replaceParagraphDraft("p_2", "AI second").operations,
      ],
    };
    const second = await fixture.proposals.upsertCurrentProposal({
      ...fixture.proposalInput(aggregate),
      baseRevision: humanFile.revision,
      baseDocument: humanDocument,
      nextDocument: replayProposalDraft(humanDocument, aggregate).nextDocument,
      roomId: "room_runs",
      runId: "run_second",
    });
    expect(second.mergeBasis?.entities.p_1?.value).toMatchObject({ children: [{ text: "p_1" }] });

    await expect(fixture.approve(mode, second.proposalId)).resolves.toMatchObject({ ok: true });

    const [first, secondText] = await fixture.readTextsFromFreshStore();
    expect(first).toContain("AI first");
    expect(first).toContain(" human");
    expect(secondText).toBe("AI second");
  });

  it.each(modes)("%s undoes a merged approval selectively after a later unrelated edit", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "The dog sat."));
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 — human append"));
    const beforeApproval = parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId));
    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({ ok: true });
    const later = await fixture.saveHumanEdit((document) => withParagraph(document, "p_2", "p_2 later"));

    const plan = await fixture.proposals.getRevertPlan(
      proposal.proposalId,
      later.revision,
      parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId)),
    );

    expect(plan).toMatchObject({ ok: true, mode: "selective" });
    expect(plan.ok && documentTexts(plan.document)).toEqual([documentTexts(beforeApproval)[0], "p_2 later"]);
  });

  it.each(modes)("%s can be undone back to the document before a merged approval", async (mode) => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "The dog sat."));
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 — human append"));
    const beforeApproval = parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId));

    await expect(fixture.approve(mode, proposal.proposalId)).resolves.toMatchObject({ ok: true });

    const resolved = await fixture.proposals.loadProposal(proposal.proposalId);
    expect(areSigmaDocumentsEquivalent(resolved!.revertDocument!, beforeApproval)).toBe(true);
    const savedFile = (await fixture.documents.listFiles())[0];
    const plan = await fixture.proposals.getRevertPlan(
      proposal.proposalId,
      savedFile.revision,
      parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId)),
    );
    expect(plan).toMatchObject({ ok: true, mode: "full" });
    expect(plan.ok && areSigmaDocumentsEquivalent(plan.document, beforeApproval)).toBe(true);
  });

  it("does not auto-apply a proposal whose replay merged the human's edits", async () => {
    const proposal = await fixture.createProposal(replaceParagraphDraft("p_1", "AI"));
    await fixture.saveHumanEdit((document) => withParagraph(document, "p_1", "p_1 human"));
    await fixture.proposals.rebaseProposal(
      proposal.proposalId,
      parseSigmaDocument(await fixture.documents.loadDocument(fixture.file.fileId)),
      fixture.file.revision + 1,
    );

    await expect(fixture.coordinator.approveSingleProposal(proposal.proposalId, { autoApplied: true }))
      .resolves.toMatchObject({ ok: false, code: "merge-review" });
    expect(fixture.saveDocument).not.toHaveBeenCalled();
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.status).toBe("pending");
    expect(await fixture.readTexts()).toEqual(["p_1 human", "p_2"]);
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
    /** A record written before merge bases existed: same proposal, without `mergeBasis`. */
    createLegacyProposal: async (draft: AiEditSessionDraft): Promise<LocalMcpEditProposal> => {
      const created = await proposals.createProposal(proposalInput(draft));
      const recordPath = path.join(proposals.getProposalsDir(), `${encodeURIComponent(created.proposalId)}.proposal.json`);
      const legacy: Partial<LocalMcpEditProposal> = JSON.parse(await fs.readFile(recordPath, "utf8"));
      delete legacy.mergeBasis;
      await fs.writeFile(recordPath, JSON.stringify(legacy), "utf8");
      return (await proposals.loadProposal(created.proposalId))!;
    },
    /** Saves a human edit as the renderer would (CAS on the current revision). */
    saveHumanEdit: async (edit: (document: SigmaDocument) => SigmaDocument) => {
      const current = (await documents.listFiles())[0];
      const document = parseSigmaDocument(await documents.loadDocument(current.fileId));
      const saved = await documents.saveDocument(current.fileId, edit(document), { expectedRevision: current.revision });
      if (!saved.ok) throw new Error(saved.error);
      return (await documents.listFiles())[0];
    },
    readTextsFromFreshStore: async () => {
      const reopened = new LocalSigmaDocStore(userDataDir);
      return documentTexts(parseSigmaDocument(await reopened.loadDocument(file.fileId)));
    },
    approve: (mode: ApprovalMode, proposalId: string, options: { force?: boolean } = {}) => (
      mode === "single" ? coordinator.approveSingleProposal(proposalId, options) : coordinator.approveProposals([proposalId], options)
    ),
    readTexts: async () => documentTexts(parseSigmaDocument(await documents.loadDocument(file.fileId))),
  };
}

function withParagraph(document: SigmaDocument, blockId: string, text: string): SigmaDocument {
  return parseSigmaDocument(updateBlockInDocument(document, blockId, (block) => ({
    ...(block as ParagraphNode),
    children: [{ type: "text", text }],
  })));
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
