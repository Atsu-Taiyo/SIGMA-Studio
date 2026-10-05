import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { assertReadPreconditions, PAGE_LAYOUT_TARGET, type SharedApproval } from "@/features/collaboration/model/approval";
import { collectIds } from "@/features/collaboration/model/shared-document";
import type { ObjectValue } from "@/features/collaboration/model/value";
import type { SigmaDocument } from "@/features/document";
import { isProposalMergeQuiet } from "@/lib/ai/proposal-merge-basis";
import { createAiEditSessionDocumentDraft, type AiEditSessionDraft, type SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { areSigmaDocumentsEquivalent } from "@/lib/document-equivalence";
import { deleteBlocksFromDocument, findBlock, updateBlockInDocument } from "@/lib/document-tree";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { LocalMcpEditProposalStore } from "../local-sigma-doc-proposal-store";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import type { LocalMcpEditProposal } from "../proposals/contracts";
import { collectOccupiedInsertIds } from "../proposals/freshness";
import { replayProposalDraft } from "../proposals/replay";
import { createSharedProposalApprover } from "./proposal-approval";
import { approvalFile, observeSharedRead, readSharedProposal, withSharedReadScope } from "./proposal-context";

const te = createCurrentLocaleTranslator("error");

const paragraph = (id: string, text = `段落 ${id}`) => ({ id, type: "paragraph" as const, children: [{ type: "text" as const, text }] });
const geo = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
  id, type: "geo", x, y: 0, rotation: 0,
  props: { w: 40, h: 20, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
  ...extra,
});
const labelShape = (id: string, x = 320) => ({
  id, type: "text", x, y: 400, rotation: 0,
  props: { w: 40, h: 16, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text: "x" }] }] },
});
const graphShape = {
  id: "graph_1", type: "graph2dShape", x: 0, y: 300, rotation: 0,
  props: {
    boundsMode: "plot", w: 300, h: 180, axisLabelTextShapeIds: { x: "label_x" },
    spec: { kind: "cartesian", title: "", width: 364, height: 232, viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" }, axes: { grid: false, showX: true, showY: true, xLabel: "x" }, curves: [], points: [] },
  },
};
const shapes = [
  geo("s_1", 0), geo("s_2", 100),
  { id: "g", type: "group", x: 10, y: 0, rotation: 0, props: { w: 90, h: 20 } }, geo("m_1", 10, { parentId: "g" }), geo("m_2", 60, { parentId: "g" }),
  geo("h", 200), geo("d", 200, { anchor: { type: "shape", shapeId: "h", dx: 0, dy: 30 } }),
  graphShape, labelShape("label_x"),
];

function sharedDocument(): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_shared_approval",
    metadata: { title: "共有教材の承認" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [
      paragraph("p_1", "The cat sat."),
      paragraph("p_2"),
      paragraph("p_3"),
      { id: "box_1", type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "要点" }], blocks: [paragraph("box_p")] },
      { id: "sec_1", type: "layoutSection", layout: { columnCount: 2, columnGapMm: 8 }, children: [paragraph("sec_p")] },
      { id: "problem", type: "problem", tags: [], lead: [], prompt: [paragraph("x", "x"), paragraph("y", "y")], solution: [paragraph("s", "s")], hints: [] },
    ],
    pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: structuredClone(shapes), assets: {} } } },
  });
}

function draftOf(operations: AiEditSessionDraft["operations"], mutationOperations: SigmaDocMutationOp[] = []): AiEditSessionDraft {
  return { summary: "提案", plan: ["提案"], warnings: [], operations, ...(mutationOperations.length > 0 ? { mutationOperations } : {}) };
}
const replace = (targetId: string, text: string): AiEditSessionDraft["operations"][number] => ({
  operation: "replace", summary: "置換", targetId, replacementBlock: paragraph(targetId, text),
});

const shapesOf = (document: SigmaDocument) => document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
const shapeIn = (document: SigmaDocument, id: string) => shapesOf(document).find((shape) => shape.id === id) as Record<string, unknown> | undefined;
const withShapes = (document: SigmaDocument, next: (current: Record<string, unknown>[]) => unknown[]): SigmaDocument => ({
  ...document,
  pageLayout: {
    ...document.pageLayout,
    overlay: {
      ...document.pageLayout?.overlay,
      overlaySnapshot: { ...document.pageLayout!.overlay!.overlaySnapshot!, shapes: next(shapesOf(document) as unknown as Record<string, unknown>[]) },
    },
  },
} as unknown as SigmaDocument);
const editShape = (id: string, patch: Record<string, unknown>) => (document: SigmaDocument) => withShapes(
  document,
  (current) => current.map((shape) => (shape.id === id ? { ...shape, ...patch } : shape)),
);
const editText = (id: string, text: string) => (document: SigmaDocument): SigmaDocument => (
  updateBlockInDocument(document, id, (block) => ({ ...block, children: [{ type: "text", text }] } as never))
);
const textOf = (document: SigmaDocument, id: string) => {
  const block = findBlock(document, id) as { children?: Array<{ text?: string }> } | null;
  return block?.children?.map((child) => child.text ?? "").join("") ?? null;
};

/**
 * What the sync server requires a precondition on, per draft, enumerated here from its approval's rule
 * and not with the functions the approval uses (so a drift between the two is caught): every replaced
 * target, deleted block, updated / aligned / deleted shape and reconfigured section, and every anchor
 * an insertion names (its target and its shape's block or shape anchor) unless an earlier operation of
 * the draft created it (a replacement's whole tree, an inserted block, table or shape).
 */
function serverRequiredTargets(draft: AiEditSessionDraft): string[] {
  const required = new Set<string>();
  const created = new Set<string>();
  const treeIds = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.flatMap(treeIds);
    if (!value || typeof value !== "object") return [];
    const record = value as Record<string, unknown>;
    return [...(typeof record.id === "string" && typeof record.type === "string" ? [record.id] : []), ...Object.values(record).flatMap(treeIds)];
  };
  for (const operation of draft.operations) {
    if (operation.operation === undefined || operation.operation === "replace") {
      required.add(operation.targetId);
      treeIds(operation.replacementBlock).forEach((id) => created.add(id));
      continue;
    }
    const shape = operation.operation === "insertOverlayShape" ? operation.overlayShape : operation.operation === "insertTableShape" ? operation.tableShape : null;
    const anchor = shape?.anchor;
    for (const id of [operation.targetId, anchor?.type === "block" ? anchor.blockId : anchor?.type === "shape" ? anchor.shapeId : null]) {
      if (id && !created.has(id)) required.add(id);
    }
    created.add(operation.operation === "insertAfter" ? operation.insertedBlock.id : shape!.id);
  }
  for (const mutation of draft.mutationOperations ?? []) {
    if (mutation.operation === "deleteBlocks") mutation.blockIds.forEach((id) => required.add(id));
    else if (mutation.operation === "updateOverlayShape") required.add(mutation.shapeId);
    else if (mutation.operation === "alignOverlayShapes" || mutation.operation === "deleteOverlayShapes") mutation.shapeIds.forEach((id) => required.add(id));
    else if (mutation.operation === "updateLayoutSection") required.add(mutation.sectionId);
  }
  return [...required];
}

/**
 * The shared session as the approval reaches it (MISS R5: as strict as the real one). The server holds
 * the shared document; this window's projection only catches up on an online flush (`approve` flushes
 * first, as the real one does). The server's approval does what the sync server's does: an operation id
 * it already applied answers the same request again and refuses a different one (`OPERATION_REUSED`);
 * every precondition is checked (`assertReadPreconditions`); each draft needs a precondition on every
 * target it overwrites or anchors to that exists (`MISSING_PRECONDITION`, `serverRequiredTargets`) and
 * must not insert a taken id; the drafts are applied in order (`createAiEditSessionDocumentDraft`)
 * before the document moves on.
 */
function createSharedSession(userData: string, fileId: string, document: SigmaDocument) {
  let server = parseSigmaDocument(document);
  let local = server;
  let seq = 0;
  const receipts = new Map<string, { body: string; seq: number }>();
  const requests: SharedApproval[] = [];
  let failBeforeServer: Error | null = null;
  const sessions = {
    directory: path.join(userData, "collaboration-v1"),
    has: (id: string) => id === fileId,
    flush: vi.fn(async (_id: string, online = false) => {
      if (online) local = server;
    }),
    project: (): SigmaDocument | undefined => parseSigmaDocument(structuredClone(local)),
    approve: vi.fn(async (id: string, approval: SharedApproval) => {
      await sessions.flush(id, true);
      requests.push(structuredClone(approval));
      if (failBeforeServer) {
        const error = failBeforeServer;
        failBeforeServer = null;
        throw error;
      }
      const body = JSON.stringify(approval);
      const receipt = receipts.get(approval.operationId);
      if (receipt) {
        if (receipt.body !== body) throw new Error("OPERATION_REUSED");
        return { seq: receipt.seq };
      }
      const before = server as unknown as ObjectValue;
      const checked = await assertReadPreconditions(before, approval.preconditions);
      const existing = collectIds(before);
      let next = parseSigmaDocument(server);
      for (const draft of (approval.drafts ?? [approval.draft]) as AiEditSessionDraft[]) {
        if (serverRequiredTargets(draft).some((target) => existing.has(target) && !checked.has(target))) throw new Error("MISSING_PRECONDITION");
        if (
          draft.mutationOperations?.some((operation) => ["updatePageLayout", "setDocumentColumns"].includes(operation.operation))
          && !checked.has(PAGE_LAYOUT_TARGET)
        ) throw new Error("MISSING_PRECONDITION");
        const taken = Object.fromEntries([...collectIds(next as unknown as ObjectValue).keys()].map((key) => [key, "existing"]));
        if (collectOccupiedInsertIds(draft, taken).length > 0) throw new Error("PROPOSAL_CONFLICT");
        next = createAiEditSessionDocumentDraft(next, null, draft).nextDocument;
      }
      server = parseSigmaDocument(next);
      seq += 1;
      receipts.set(approval.operationId, { body, seq });
      local = server;
      return { seq };
    }),
  };
  return {
    sessions,
    requests,
    server: () => server,
    /** Another participant's edit: it reaches the server, this window sees it after a flush. */
    editByAnotherParticipant: (edit: (document: SigmaDocument) => SigmaDocument) => {
      server = parseSigmaDocument(edit(server));
    },
    failNextApprovalBeforeTheServer: (error: Error) => {
      failBeforeServer = error;
    },
  };
}

async function createFixture(userData: string) {
  const documents = new LocalSigmaDocStore(userData);
  await documents.initializeWorkspace({ initialDocument: sharedDocument() });
  const file = (await documents.listFiles())[0];
  await fs.mkdir(path.join(userData, "collaboration-v1"), { recursive: true });
  await fs.writeFile(path.join(userData, "collaboration-v1", "registry.json"), JSON.stringify({ version: 1, files: { [file.fileId]: {} } }));
  const proposals = new LocalMcpEditProposalStore(userData);
  const shared = createSharedSession(userData, file.fileId, sharedDocument());
  const broadcastLocalStoreChange = vi.fn();
  const approver = createSharedProposalApprover(shared.sessions, proposals, {
    localSigmaDocStore: documents,
    broadcastLocalStoreChange,
    translate: te,
  });
  const proposalInput = (draft: AiEditSessionDraft) => {
    const baseDocument = shared.server();
    return {
      fileId: file.fileId,
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    };
  };
  const readLedger = () => fs.readFile(path.join(userData, "data", "logs", "ledger.log"), "utf8").catch(() => "");
  return {
    ...shared,
    fileId: file.fileId,
    proposals,
    approve: async (...records: LocalMcpEditProposal[]) => (await approver(records))!,
    /** A proposal the AI made from the shared document as it is now (its envelope is captured too). */
    createProposal: (draft: AiEditSessionDraft) => proposals.createProposal(proposalInput(draft)),
    /**
     * A proposal the AI made after reading `readId` with a tool (the run's reads are recorded as the MCP
     * server records them), with the request's selection when given.
     */
    createProposalAfterReading: async (draft: AiEditSessionDraft, readId: string, selectedIds: string[] = []) => {
      const runId = `run_${Math.random().toString(36).slice(2)}`;
      await withSharedReadScope(runId, true, async () => {
        observeSharedRead(userData, file.fileId, shared.server());
        return { read: findBlock(shared.server(), readId) ?? shapesOf(shared.server()).find((shape) => shape.id === readId) };
      });
      const hashes = computeDocumentBlockHashes(shared.server());
      return proposals.createProposal({
        ...proposalInput(draft),
        runId,
        ...(selectedIds.length > 0
          ? { requestSelection: { blockIds: selectedIds, hashes: Object.fromEntries(selectedIds.map((id) => [id, hashes[id]])), capturedRevision: 1 } }
          : {}),
      });
    },
    /** A turn of a room's run: the first creates the proposal, the next ones revise it. */
    upsertProposal: (draft: AiEditSessionDraft) => proposals.upsertCurrentProposal({ ...proposalInput(draft), runId: "run_shared", roomId: "room_shared" }),
    /** A record written before merge bases existed: the same proposal and envelope, without `mergeBasis`. */
    createLegacyProposal: async (draft: AiEditSessionDraft) => {
      const created = await proposals.createProposal(proposalInput(draft));
      const recordPath = path.join(proposals.getProposalsDir(), `${encodeURIComponent(created.proposalId)}.proposal.json`);
      const legacy: Partial<LocalMcpEditProposal> = JSON.parse(await fs.readFile(recordPath, "utf8"));
      delete legacy.mergeBasis;
      await fs.writeFile(recordPath, JSON.stringify(legacy), "utf8");
      return (await proposals.loadProposal(created.proposalId))!;
    },
    envelopeOf: (proposal: LocalMcpEditProposal) => readSharedProposal(userData, proposal.proposalId),
    statusOf: async (proposal: LocalMcpEditProposal) => (await proposals.loadProposal(proposal.proposalId))?.status,
    readLedger,
  };
}

describe("shared proposal approval", () => {
  let userData: string;
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-shared-approval-"));
    fixture = await createFixture(userData);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(userData, { recursive: true, force: true });
  });

  it("keeps another participant's edit of the target together with the AI's change", async () => {
    const proposal = await fixture.createProposal(draftOf([replace("p_1", "The dog sat.")]));
    fixture.editByAnotherParticipant(editText("p_1", "The big cat sat."));

    const result = await fixture.approve(proposal);

    expect(result).toMatchObject({ ok: true });
    expect(textOf(fixture.server(), "p_1")).toBe("The big dog sat.");
    expect(await fixture.statusOf(proposal)).toBe("approved");
    // The merge is reported for the renderer's counters: the participant's unit, and no fallback.
    expect(result.ok && result.mergeReport).toMatchObject({ humanEditedUnits: ["p_1"], overlaps: [], invalidAfterMerge: 0, legacyNoBase: 0 });
    expect((await fixture.proposals.loadProposal(proposal.proposalId))?.mergeReport?.humanEditedUnits).toEqual(["p_1"]);
    expect(await fixture.readLedger()).not.toContain("proposal-merge-fallback");
  });

  it("merges a batch in the batch approval's order and sends it as one approval", async () => {
    const first = await fixture.createProposal(draftOf([replace("p_1", "The dog sat.")]));
    const second = await fixture.createProposal(draftOf([replace("p_2", "段落 p_2 by AI")]));
    fixture.editByAnotherParticipant(editText("p_1", "The big cat sat."));

    const result = await fixture.approve(first, second);

    expect(result).toMatchObject({ ok: true });
    expect(textOf(fixture.server(), "p_1")).toBe("The big dog sat.");
    expect(textOf(fixture.server(), "p_2")).toBe("段落 p_2 by AI");
    expect(fixture.requests).toHaveLength(1);
    expect(fixture.requests[0].drafts).toHaveLength(2);
    expect([await fixture.statusOf(first), await fixture.statusOf(second)]).toEqual(["approved", "approved"]);
  });

  it("keeps an edit inside a container the AI rewrites, checking the nested targets as merged", async () => {
    const proposal = await fixture.createProposal(draftOf([
      { operation: "replace", summary: "箱", targetId: "box_1", replacementBlock: { id: "box_1", type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "要点 by AI" }], blocks: [paragraph("box_p")] } as never },
      replace("box_p", "段落 box_p by AI"),
    ]));
    fixture.editByAnotherParticipant(editText("box_p", "人の追記つき 段落 box_p"));

    await expect(fixture.approve(proposal)).resolves.toMatchObject({ ok: true });

    const box = findBlock(fixture.server(), "box_1") as unknown as { title: Array<{ text: string }> };
    expect(box.title[0].text).toBe("要点 by AI");
    expect(textOf(fixture.server(), "box_p")).toBe("人の追記つき 段落 box_p by AI");
  });

  it("re-anchors an insertion whose anchor another participant deleted, with a precondition on the new anchor", async () => {
    const proposal = await fixture.createProposal(draftOf([{ operation: "insertAfter", summary: "挿入", targetId: "p_2", insertedBlock: paragraph("p_new", "AI が足した段落") }]));
    fixture.editByAnotherParticipant((document) => deleteBlocksFromDocument(document, ["p_2"]));

    const result = await fixture.approve(proposal);

    expect(result).toMatchObject({ ok: true, mergeReport: { anchorRelocated: 1 } });
    expect(fixture.server().content.map((block) => block.id).slice(0, 3)).toEqual(["p_1", "p_new", "p_3"]);
    expect(fixture.requests[0].preconditions.map((condition) => condition.id)).toContain("p_1");
  });

  it("stays a PROPOSAL_CONFLICT when another participant deleted the target", async () => {
    const proposal = await fixture.createProposal(draftOf([replace("p_2", "段落 p_2 by AI")]));
    fixture.editByAnotherParticipant((document) => deleteBlocksFromDocument(document, ["p_2"]));

    const result = await fixture.approve(proposal);

    expect(result).toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
    expect(findBlock(fixture.server(), "p_2")).toBeNull();
    expect(fixture.requests).toHaveLength(0);
    expect(await fixture.statusOf(proposal)).toBe("pending");
  });

  it("stops with PROPOSAL_CONFLICT instead of replaying the AI's version of a unit whose merge fails validation", async () => {
    // The AI moves x from the prompt into the solution; another participant edits x where it was. The
    // merge would repeat x; the desktop's local approval replays the AI's problem instead (dropping the
    // edit and counting it), but a shared document has other people whose edit must not vanish.
    const problem = findBlock(fixture.server(), "problem") as unknown as Record<string, unknown>;
    const moved = { ...problem, prompt: [paragraph("y", "y")], solution: [paragraph("s", "s"), paragraph("x", "x")] };
    const proposal = await fixture.createProposal(draftOf([{ operation: "replace", summary: "移動", targetId: "problem", replacementBlock: moved as never }]));
    fixture.editByAnotherParticipant(editText("x", "x by another participant"));

    const result = await fixture.approve(proposal);

    expect(result).toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
    expect(textOf(fixture.server(), "x")).toBe("x by another participant");
    expect(fixture.requests).toHaveLength(0);
  });

  it("checks the targets it cannot merge before sending anything (not only on the server)", async () => {
    const proposal = await fixture.createProposal(draftOf([], [{ operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_2"], mode: "left" }]));
    fixture.editByAnotherParticipant(editShape("s_2", { x: 150 }));

    await expect(fixture.approve(proposal)).resolves.toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
    expect(fixture.requests).toHaveLength(0);
    expect(shapeIn(fixture.server(), "s_2")?.x).toBe(150);
  });

  it("sends a legacy record's recorded approval unchanged, logs it, and keeps its conflict", async () => {
    const legacy = await fixture.createLegacyProposal(draftOf([replace("p_2", "段落 p_2 by AI")]));
    const envelope = await fixture.envelopeOf(legacy);

    const result = await fixture.approve(legacy);

    expect(result).toMatchObject({ ok: true, mergeReport: { legacyNoBase: 1 } });
    expect(fixture.requests).toEqual([{ operationId: envelope.operationId, preconditions: envelope.preconditions, drafts: [envelope.draft] }]);
    const ledger = await fixture.readLedger();
    expect(ledger).toContain("proposal-merge-fallback");
    expect(ledger).toContain('"legacyNoBase":1');

    const changed = await fixture.createLegacyProposal(draftOf([replace("p_3", "段落 p_3 by AI")]));
    fixture.editByAnotherParticipant(editText("p_3", "段落 p_3 by another participant"));
    await expect(fixture.approve(changed)).resolves.toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
    expect(textOf(fixture.server(), "p_3")).toBe("段落 p_3 by another participant");
  });

  it("sends the recorded approval when nobody else edited what the proposal overwrites", async () => {
    const proposal = await fixture.createProposal(draftOf([replace("p_1", "The dog sat.")]));
    const envelope = await fixture.envelopeOf(proposal);
    fixture.editByAnotherParticipant(editText("p_3", "段落 p_3 by another participant"));

    const result = await fixture.approve(proposal);

    expect(result).toMatchObject({ ok: true });
    expect(result.ok && isProposalMergeQuiet(result.mergeReport!)).toBe(true);
    expect(fixture.requests).toEqual([{ operationId: envelope.operationId, preconditions: envelope.preconditions, drafts: [envelope.draft] }]);
    expect(await fixture.readLedger()).not.toContain("proposal-merge-fallback");
  });

  it("retries a merged approval from the same document with the same operation id", async () => {
    const proposal = await fixture.createProposal(draftOf([replace("p_1", "The dog sat.")]));
    const envelope = await fixture.envelopeOf(proposal);
    fixture.editByAnotherParticipant(editText("p_1", "The big cat sat."));
    fixture.failNextApprovalBeforeTheServer(new Error("network"));

    await expect(fixture.approve(proposal)).resolves.toEqual({ ok: false, code: "conflict", error: te("electron.proposal.applyFailed") });
    expect(await fixture.statusOf(proposal)).toBe("pending");
    await expect(fixture.approve(proposal)).resolves.toMatchObject({ ok: true });

    expect(fixture.requests).toHaveLength(2);
    expect(fixture.requests[1]).toEqual(fixture.requests[0]);
    expect(fixture.requests[0].operationId).not.toBe(envelope.operationId);
    expect(fixture.requests[0].operationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-8[0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(textOf(fixture.server(), "p_1")).toBe("The big dog sat.");
  });

  it("keeps checking what a room's later turn cannot merge without stopping it when nobody edited it", async () => {
    await fixture.upsertProposal(draftOf([replace("p_1", "The dog sat.")]));
    const latest = await fixture.upsertProposal(draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]));
    const envelope = await fixture.envelopeOf(latest);

    // The group's members go with it: their base hashes are recorded for the revised draft too.
    expect(envelope.preconditions.map((condition) => condition.id)).toEqual(expect.arrayContaining(["g", "m_1", "m_2"]));
    await expect(fixture.approve(latest)).resolves.toMatchObject({ ok: true });
    expect(textOf(fixture.server(), "p_1")).toBe("The dog sat.");
    expect(shapeIn(fixture.server(), "m_1")).toBeUndefined();
  });

  describe("after the AI read what it rewrites", () => {
    const problemWith = (prompt: ReturnType<typeof paragraph>[]) => ({
      ...(findBlock(fixture.server(), "problem") as unknown as Record<string, unknown>), prompt,
    });

    it("keeps an edit of the paragraph it rewrote, though the problem it read holds that paragraph", async () => {
      const proposal = await fixture.createProposalAfterReading(draftOf([replace("x", "x by AI")]), "problem");
      const envelope = await fixture.envelopeOf(proposal);
      fixture.editByAnotherParticipant(editText("x", "edited x"));

      expect(envelope.preconditions.map((condition) => condition.id)).toEqual(expect.arrayContaining(["problem", "x", "y", "s"]));
      await expect(fixture.approve(proposal)).resolves.toMatchObject({ ok: true });
      expect(textOf(fixture.server(), "x")).toContain("edited");
      expect(textOf(fixture.server(), "x")).toContain("by AI");
    });

    it("keeps an edit inside the problem it read, selected and rewrote", async () => {
      const proposal = await fixture.createProposalAfterReading(
        draftOf([{ operation: "replace", summary: "問題", targetId: "problem", replacementBlock: problemWith([paragraph("x", "x"), paragraph("y", "y by AI")]) as never }]),
        "problem",
        ["problem"],
      );
      fixture.editByAnotherParticipant(editText("x", "x by another participant"));

      await expect(fixture.approve(proposal)).resolves.toMatchObject({ ok: true });
      expect(textOf(fixture.server(), "x")).toBe("x by another participant");
      expect(textOf(fixture.server(), "y")).toBe("y by AI");
    });

    it("still stops when what it only read changed", async () => {
      const proposal = await fixture.createProposalAfterReading(draftOf([replace("x", "x by AI")]), "problem");
      fixture.editByAnotherParticipant(editText("y", "y by another participant"));

      await expect(fixture.approve(proposal)).resolves.toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
      expect(textOf(fixture.server(), "y")).toBe("y by another participant");
    });
  });

  it("keeps the recorded base hashes when a room's run is rolled back", async () => {
    const first = await fixture.upsertProposal(draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]));
    const snapshotId = await fixture.proposals.beginProposalRunSnapshot("room_shared", fixture.fileId);
    await fixture.upsertProposal(draftOf([replace("p_1", "The dog sat.")]));
    await fixture.proposals.rollbackProposalRunSnapshot(snapshotId);
    const restored = (await fixture.proposals.loadProposal(first.proposalId))!;

    expect((await fixture.envelopeOf(restored)).preconditions.map((condition) => condition.id)).toEqual(expect.arrayContaining(["g", "m_1", "m_2"]));
    await expect(fixture.approve(restored)).resolves.toMatchObject({ ok: true });
    expect(shapeIn(fixture.server(), "m_1")).toBeUndefined();
    expect(textOf(fixture.server(), "p_1")).toBe("The cat sat.");
  });

  it("records the base hashes of a legacy record proposed again, approved together with a merged one", async () => {
    // Proposing again replays a legacy draft and keeps the replay's normalized draft (here the box is
    // put before its paragraph), so its approval record is taken again.
    const legacy = await fixture.createLegacyProposal(draftOf([
      replace("box_p", "段落 box_p by AI"),
      { operation: "replace", summary: "箱", targetId: "box_1", replacementBlock: { id: "box_1", type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "要点 by AI" }], blocks: [paragraph("box_p")] } as never },
    ], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]));
    await fixture.proposals.rejectSingleProposal(legacy.proposalId);
    await expect(fixture.proposals.restoreResolvedProposal(legacy.proposalId, fixture.server(), 1)).resolves.toMatchObject({ ok: true });
    const merged = await fixture.createProposal(draftOf([replace("p_1", "The dog sat.")]));
    const reproposed = (await fixture.proposals.loadProposal(legacy.proposalId))!;

    expect((await fixture.envelopeOf(reproposed)).preconditions.map((condition) => condition.id)).toEqual(expect.arrayContaining(["g", "m_1", "m_2"]));
    await expect(fixture.approve(reproposed, merged)).resolves.toMatchObject({ ok: true });
  });

  it("resolves the proposal without sending anything when the participant's edits made every operation unnecessary", async () => {
    const proposal = await fixture.createProposal(draftOf([], [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_3"] }]));
    fixture.editByAnotherParticipant(editText("p_3", "段落 p_3 by another participant"));

    const result = await fixture.approve(proposal);

    expect(result).toMatchObject({ ok: true, mergeReport: { editBeatsDelete: ["#p_3"] } });
    expect(fixture.requests).toHaveLength(0);
    expect(await fixture.statusOf(proposal)).toBe("approved");
    expect(textOf(fixture.server(), "p_3")).toBe("段落 p_3 by another participant");
  });
});

describe("a local document's AI run", () => {
  it("starts without reading shared approval records (an unreadable one does not stop it)", async () => {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-local-run-snapshot-"));
    try {
      const proposals = new LocalMcpEditProposalStore(userData);
      const baseDocument = sharedDocument();
      const draft = draftOf([replace("p_1", "The dog sat.")]);
      const proposal = await proposals.upsertCurrentProposal({
        fileId: "file_local", baseRevision: 1, baseDocument, summary: draft.summary, plan: draft.plan, provider: null,
        source: { toolName: "draft_update_rich_content", toolArgs: {} }, draft, nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
        runId: "run_local", roomId: "room_local",
      });
      // Not a shared document: no binding, and whatever sits where a shared record would be is not read.
      await fs.mkdir(approvalFile(userData, proposal.proposalId), { recursive: true });

      const snapshotId = await proposals.beginProposalRunSnapshot("room_local", "file_local");

      await expect(proposals.rollbackProposalRunSnapshot(snapshotId)).resolves.toBe(true);
    } finally {
      await fs.rm(userData, { recursive: true, force: true });
    }
  });
});

/**
 * 契約 (R4): 共有教材には保留中の対象のロックが無い (別の参加者の窓は提案を知らない)。どの操作でも、
 * 別の参加者が対象を直してから承認すると、その編集が残るか PROPOSAL_CONFLICT で止まるかのどちらか。
 * 合成した単位の事前条件を今のハッシュに差し替えても、合成できない対象 (`collectNonMergeableTargets`) を
 * 元のハッシュで確かめ続けないと、この表のどれかが黙って消える。
 */
describe("contract: another participant's edit of a target survives a shared approval or stops it", () => {
  let userData: string;
  let fixture: Awaited<ReturnType<typeof createFixture>>;

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-shared-approval-contract-"));
    fixture = await createFixture(userData);
  });

  afterEach(async () => {
    await fs.rm(userData, { recursive: true, force: true });
  });

  const relabel: AiEditSessionDraft = {
    summary: "軸名", plan: ["軸名"], warnings: [],
    operations: [{ operation: "insertOverlayShape", summary: "新ラベル", targetId: "p_1", overlayShape: labelShape("label_x2") as never, assets: {} }],
    mutationOperations: [
      { operation: "deleteOverlayShapes", summary: "旧ラベル", shapeIds: ["label_x"] },
      { operation: "updateOverlayShape", summary: "持ち主", shapeId: "graph_1", patch: { props: { axisLabelTextShapeIds: { x: "label_x2" } } } as never },
    ],
    operationOrder: [{ kind: "mutation", index: 0 }, { kind: "operation", index: 0 }, { kind: "mutation", index: 1 }],
  };
  const colorOf = (document: SigmaDocument, id: string) => (shapeIn(document, id)?.props as { color?: string } | undefined)?.color;
  const recolor = (id: string) => editShape(id, { props: { ...(shapes.find((shape) => shape.id === id)!.props as object), color: "#00aa00" } });

  const cases: Array<{
    name: string;
    draft: AiEditSessionDraft;
    edit: (document: SigmaDocument) => SigmaDocument;
    kept: (result: SigmaDocument) => boolean;
  }> = [
    {
      name: "a replaced block",
      draft: draftOf([replace("p_2", "段落 p_2 by AI")]),
      edit: editText("p_2", "人の追記つき 段落 p_2"), kept: (result) => textOf(result, "p_2")!.includes("人の追記"),
    },
    {
      name: "a replaced block inside a replaced box",
      draft: draftOf([
        { operation: "replace", summary: "箱", targetId: "box_1", replacementBlock: { id: "box_1", type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "要点 by AI" }], blocks: [paragraph("box_p")] } as never },
        replace("box_p", "段落 box_p by AI"),
      ]),
      edit: editText("box_p", "人の追記つき 段落 box_p"), kept: (result) => textOf(result, "box_p")!.includes("人の追記"),
    },
    {
      name: "an insertion anchor",
      draft: draftOf([{ operation: "insertAfter", summary: "挿入", targetId: "p_1", insertedBlock: paragraph("p_new", "AI が足した段落") }]),
      edit: editText("p_1", "The cat sat. 人の追記"), kept: (result) => textOf(result, "p_1") === "The cat sat. 人の追記",
    },
    {
      name: "a deleted block",
      draft: draftOf([], [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_2"] }]),
      edit: editText("p_2", "人が直した p_2"), kept: (result) => textOf(result, "p_2") === "人が直した p_2",
    },
    {
      name: "a moved block",
      draft: draftOf([], [{ operation: "moveBlocks", summary: "移動", blockIds: ["p_3"], targetId: "p_1", position: "after" }]),
      edit: editText("p_3", "人が直した p_3"), kept: (result) => textOf(result, "p_3") === "人が直した p_3",
    },
    {
      name: "a reconfigured column section",
      draft: draftOf([replace("sec_p", "段 by AI")], [{ operation: "updateLayoutSection", summary: "間隔", sectionId: "sec_1", columnGapMm: 12 }]),
      edit: (document) => updateBlockInDocument(document, "sec_1", (block) => ({ ...block, layout: { columnCount: 2, columnGapMm: 4 } } as never)),
      kept: (result) => (findBlock(result, "sec_1") as { layout?: { columnGapMm?: number } } | null)?.layout?.columnGapMm === 4,
    },
    {
      name: "an updated shape",
      draft: draftOf([], [{ operation: "updateOverlayShape", summary: "色", shapeId: "s_1", patch: { props: { color: "#ff0000" } } as never }]),
      edit: editShape("s_1", { x: 77 }), kept: (result) => shapeIn(result, "s_1")?.x === 77,
    },
    {
      name: "a deleted shape",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s_2"] }]),
      edit: editShape("s_2", { x: 177 }), kept: (result) => shapeIn(result, "s_2")?.x === 177,
    },
    {
      name: "an aligned shape",
      draft: draftOf([], [{ operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_2"], mode: "left" }]),
      edit: editShape("s_2", { x: 150 }), kept: (result) => shapeIn(result, "s_2")?.x === 150,
    },
    {
      name: "an aligned shape the draft also updates",
      draft: draftOf([], [
        { operation: "updateOverlayShape", summary: "色", shapeId: "s_2", patch: { props: { color: "#ff0000" } } as never },
        { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_2"], mode: "left" },
      ]),
      edit: editShape("s_2", { x: 150 }), kept: (result) => shapeIn(result, "s_2")?.x === 150,
    },
    {
      // A group's position and size follow its members; its name is its own.
      name: "a group the AI deletes",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]),
      edit: editShape("g", { props: { w: 90, h: 20, name: "人が付けた名前" } }),
      kept: (result) => (shapeIn(result, "g")?.props as { name?: string } | undefined)?.name === "人が付けた名前",
    },
    {
      name: "a member of a group the AI deletes (the deletion cascades to the members)",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]),
      edit: recolor("m_1"), kept: (result) => colorOf(result, "m_1") === "#00aa00",
    },
    {
      name: "a shape anchored to a shape the AI deletes",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["h"] }]),
      edit: recolor("d"), kept: (result) => colorOf(result, "d") === "#00aa00",
    },
    {
      name: "a shape anchored after the proposal to a shape the AI deletes",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["h"] }]),
      edit: (document) => withShapes(document, (current) => [...current, geo("late", 260, { anchor: { type: "shape", shapeId: "h", dx: 0, dy: 60 } })]),
      kept: (result) => shapeIn(result, "late") !== undefined,
    },
    {
      name: "a graph the AI updates",
      draft: draftOf([], [{ operation: "updateOverlayShape", summary: "大きさ", shapeId: "graph_1", patch: { props: { w: 320 } } as never }]),
      edit: editShape("graph_1", { x: 40 }), kept: (result) => shapeIn(result, "graph_1")?.x === 40,
    },
    {
      name: "an owned label of a graph the AI relabels",
      draft: relabel,
      edit: editShape("label_x", { x: 399 }),
      kept: (result) => shapeIn(result, "label_x")?.x === 399
        && Object.values((shapeIn(result, "graph_1")?.props as { axisLabelTextShapeIds?: Record<string, string> }).axisLabelTextShapeIds ?? {}).includes("label_x"),
    },
  ];

  /**
   * The kinds the merge keeps both sides of: another participant's edit of the target must not stop
   * them (a conflict here is a regression, not the safe side). The others may stop with a conflict.
   */
  const mergedKinds = new Set([
    "a replaced block", "a replaced block inside a replaced box", "an insertion anchor", "a deleted block",
    "an updated shape", "a deleted shape",
  ]);
  /** What the AI reads with a tool before it proposes (the target, or the container holding it). */
  const readFirst: Record<string, string> = {
    "a replaced block": "p_2", "a replaced block inside a replaced box": "box_1", "an insertion anchor": "p_1", "a deleted block": "p_2",
    "a moved block": "p_3", "a reconfigured column section": "sec_1", "an updated shape": "s_1", "a deleted shape": "s_2",
    "an aligned shape": "s_2", "an aligned shape the draft also updates": "s_2", "a group the AI deletes": "g",
    "a member of a group the AI deletes (the deletion cascades to the members)": "m_1", "a shape anchored to a shape the AI deletes": "d",
    "a shape anchored after the proposal to a shape the AI deletes": "h", "a graph the AI updates": "graph_1",
    "an owned label of a graph the AI relabels": "label_x",
  };

  it("names a read for every case", () => {
    expect(cases.filter(({ name }) => !readFirst[name]).map(({ name }) => name)).toEqual([]);
  });

  it.each(cases.flatMap((entry) => [{ ...entry, read: false }, { ...entry, read: true }]))("$name (read first: $read)", async ({ name, draft, edit, kept, read }) => {
    const proposal = read ? await fixture.createProposalAfterReading(draft, readFirst[name]) : await fixture.createProposal(draft);
    fixture.editByAnotherParticipant(edit);

    const result = await fixture.approve(proposal);

    expect(kept(fixture.server())).toBe(true);
    if (mergedKinds.has(name)) {
      expect(result).toMatchObject({ ok: true });
    } else if (!result.ok) {
      expect(result).toEqual({ ok: false, code: "conflict", error: te("electron.proposal.changedBeforeApproval") });
    }
  });

  // The other side of the contract: what is checked does not stop a proposal nobody else touched.
  it.each(cases)("$name: approved as the AI proposed when nobody else edited", async ({ draft }) => {
    const proposal = await fixture.createProposal(draft);

    await expect(fixture.approve(proposal)).resolves.toMatchObject({ ok: true });
    // The overlay's write time moves with every replay (it is not content, MISS R1).
    const withoutOverlayTime = (document: SigmaDocument) => ({
      ...document,
      pageLayout: { ...document.pageLayout, overlay: { ...document.pageLayout?.overlay, updatedAt: undefined } },
    } as SigmaDocument);
    expect(areSigmaDocumentsEquivalent(withoutOverlayTime(fixture.server()), withoutOverlayTime(proposal.nextDocument))).toBe(true);
  });
});
