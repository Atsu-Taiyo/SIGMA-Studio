import { appendBlockHashRevision } from "./block-hash-sidecar";
import fs from "node:fs/promises";
import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertAppliedProposalHasRealChanges,
  findProposalFreshnessConflict,
  findProposalFreshnessConflictIds,
  LocalMcpEditProposalStore,
  MAX_MCP_PROPOSAL_FILE_BYTES,
  replayProposalDraft,
  type AiSourceReference,
  type LocalMcpEditProposal,
} from "./local-sigma-doc-proposal-store";
import { sampleDocument } from "@/lib/sample-document";
import { deleteBlocksFromDocument, updateBlockInDocument } from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { ensurePageLayout } from "@/lib/page-layout";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { createAiEditSessionDocumentDraft, type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { ParagraphNode, SigmaDocument } from "@/features/document";
import {
  SOLE_BLOCK_ID,
  deleteBlockDraft,
  wrapBlocksInColumnsDraft,
  paragraphDocument,
  P_YOTTE_ID,
  P_SOURCE_NOTE_ID,
  replaceParagraphDraft,
} from "../tests/fixtures/proposal-document";

function inlineFractionDocument(tex: string, title = "Fraction test"): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_fraction_rebase_test",
    metadata: { title },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [{
      type: "paragraph",
      id: "p_fraction",
      children: [
        { type: "text", text: "値は " },
        { type: "mathInline", id: "m_fraction", tex, display: "inline" },
        { type: "text", text: " です。" },
      ],
    }],
  };
}

function fractionTex(document: SigmaDocument): string | undefined {
  const block = document.content[0];
  return block?.type === "paragraph"
    ? block.children.find((child) => child.type === "mathInline")?.tex
    : undefined;
}

function withParagraphText(document: SigmaDocument, blockId: string, text: string): SigmaDocument {
  return parseSigmaDocument(updateBlockInDocument(document, blockId, (block) => ({
    ...(block as ParagraphNode),
    children: [{ type: "text", text }],
  })));
}

describe("LocalMcpEditProposalStore", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createStoredProposal(fileId: string, summary: string) {
    return store.createProposal({
      fileId,
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary,
      plan: [summary],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary, plan: [summary], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
  }

  async function setProposalCreatedAt(proposalId: string, createdAt: string): Promise<void> {
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposalId)}.proposal.json`);
    const proposal = JSON.parse(await fs.readFile(filePath, "utf8")) as LocalMcpEditProposal;
    proposal.createdAt = createdAt;
    await fs.writeFile(filePath, JSON.stringify(proposal, null, 2), "utf8");
  }

  it("creates pending proposals and lists summaries newest first", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 3,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: {
        toolName: "delete_blocks",
        toolArgs: { blockIds: [SOLE_BLOCK_ID] },
      },
      draft: {
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    const proposals = await store.listProposals();

    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      proposalId: proposal.proposalId,
      fileId: "file_1",
      baseRevision: 3,
      status: "pending",
      summary: "本文を追加しました。",
    });
    expect(proposals[0].groupId).toBeUndefined();
    expect(proposals[0].groupMemberIds).toBeUndefined();
    expect(proposals[0].groupPosition).toBeUndefined();
  });

  it("does not attach a stale preview verification after the proposal was revised", async () => {
    const initialDraft = {
      ...deleteBlockDraft(),
      summary: "initial",
      plan: ["initial"],
    };
    const input = {
      fileId: "file_verification_cas",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "initial",
      plan: ["initial"],
      provider: null,
      source: {
        toolName: "draft_insert_body_content",
        toolArgs: { blocks: ["追加本文"] },
      },
      draft: initialDraft,
      nextDocument: deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]),
      changedIds: [SOLE_BLOCK_ID],
      runId: "run_verification_cas",
      roomId: "room_verification_cas",
    };
    const created = await store.createProposal(input);
    const revised = await store.upsertCurrentProposal({
      ...input,
      runId: "run_verification_cas_revised",
      summary: "revised",
      draft: { ...initialDraft, summary: "revised", plan: ["revised"] },
    });

    const staleResult = await store.updateProposalVerification(
      created.proposalId,
      created,
      { validationOk: true, previewSource: "app-bridge" },
    );

    expect(staleResult).toBeNull();
    expect((await store.loadProposal(revised.proposalId))?.verification).not.toEqual({
      validationOk: true,
      previewSource: "app-bridge",
    });
  });

  it("exposes only the requested shape id needed to pair a delete and insertion", async () => {
    await store.createProposal({
      fileId: "file_1",
      baseRevision: 3,
      baseDocument: sampleDocument,
      summary: "表を挿入しました。",
      plan: [],
      provider: "chatgpt",
      source: {
        toolName: "draft_insert_table",
        toolArgs: { id: "existing_table", cells: [{ large: "payload" }] },
      },
      draft: { summary: "表を挿入しました。", plan: [], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    const [summary] = await store.listProposals();
    expect(summary.requestedShapeId).toBe("existing_table");
    expect(summary).not.toHaveProperty("source");
  });

  it("stores the provider that created the proposal", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: "claude",
      source: {
        toolName: "draft_insert_body_content",
        toolArgs: {},
      },
      draft: {
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    expect(proposal.provider).toBe("claude");
    const [summary] = await store.listProposals();
    expect(summary.provider).toBe("claude");
  });

  it("stores null provider when none is given", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: {
        toolName: "draft_insert_body_content",
        toolArgs: {},
      },
      draft: {
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    expect(proposal.provider).toBeNull();
  });

  it("parses a stored proposal missing the provider field as null (pre-WI-5 files)", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: "chatgpt",
      source: {
        toolName: "draft_insert_body_content",
        toolArgs: {},
      },
      draft: {
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as LocalMcpEditProposal;
    delete (raw as Partial<LocalMcpEditProposal>).provider;
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const [summary] = await store.listProposals();
    expect(summary.provider).toBeNull();
  });

  it("parses a stored proposal with a garbage provider value as null", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: "antigravity",
      source: {
        toolName: "draft_insert_body_content",
        toolArgs: {},
      },
      draft: {
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    raw.provider = "not-a-provider";
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const [summary] = await store.listProposals();
    expect(summary.provider).toBeNull();
  });

  it("resolves pending proposals", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "問題を作成しました。",
      plan: ["問題を作成しました。"],
      provider: null,
      source: {
        toolName: "draft_create_problem_content",
        toolArgs: {},
      },
      draft: {
        summary: "問題を作成しました。",
        plan: ["問題を作成しました。"],
        operations: [],
        warnings: [],
      },
      nextDocument: sampleDocument,
    });

    const resolved = await store.resolveProposal(proposal.proposalId, "approved", "承認しました。");

    expect(resolved.status).toBe("approved");
    expect(resolved.resolutionMessage).toBe("承認しました。");
    expect(await store.listProposals()).toHaveLength(0);
    expect(await store.listProposals({ status: "approved" })).toHaveLength(1);
  });

  it("lists approved proposals with appliedRevision when all statuses are requested", async () => {
    const proposal = await createStoredProposal("file_1", "承認済み提案");
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 7,
    });

    expect(await store.listProposals({ status: "all" })).toEqual([
      expect.objectContaining({
        proposalId: proposal.proposalId,
        status: "approved",
        appliedRevision: 7,
      }),
    ]);
  });

  it("filters resolved proposals by fileId while keeping pending proposals global", async () => {
    const pendingOtherFile = await createStoredProposal("file_other", "別教材の未処理提案");
    const approvedActiveFile = await createStoredProposal("file_active", "現在教材の承認済み提案");
    const approvedOtherFile = await createStoredProposal("file_other", "別教材の承認済み提案");
    await store.resolveProposal(approvedActiveFile.proposalId, "approved", "承認しました。");
    await store.resolveProposal(approvedOtherFile.proposalId, "approved", "承認しました。");

    const proposals = await store.listProposals({
      status: "all",
      fileId: "file_active",
    });

    expect(proposals.map((proposal) => proposal.proposalId).sort()).toEqual([
      approvedActiveFile.proposalId,
      pendingOtherFile.proposalId,
    ].sort());
  });

  it("keeps only the newest resolved proposals within resolvedLimit", async () => {
    const oldest = await createStoredProposal("file_1", "最古");
    const newest = await createStoredProposal("file_1", "最新");
    const middle = await createStoredProposal("file_1", "中間");
    await store.resolveProposal(oldest.proposalId, "approved", "承認しました。");
    await store.resolveProposal(newest.proposalId, "approved", "承認しました。");
    await store.resolveProposal(middle.proposalId, "approved", "承認しました。");
    await setProposalCreatedAt(oldest.proposalId, "2026-07-01T00:00:00.000Z");
    await setProposalCreatedAt(newest.proposalId, "2026-07-03T00:00:00.000Z");
    await setProposalCreatedAt(middle.proposalId, "2026-07-02T00:00:00.000Z");

    const proposals = await store.listProposals({
      status: "all",
      resolvedLimit: 2,
    });

    expect(proposals.map((proposal) => proposal.proposalId)).toEqual([
      newest.proposalId,
      middle.proposalId,
    ]);
  });

  it("persists requestSelection through a save/reload round trip and exposes it on summaries", async () => {
    const requestSelection = {
      blockIds: ["block_sel"],
      hashes: { block_sel: "hash_sel" },
      capturedRevision: 4,
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 4,
      baseDocument: sampleDocument,
      summary: "選択スナップショット付きの提案。",
      plan: [],
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft: { summary: "選択スナップショット付きの提案。", plan: [], operations: [], warnings: [] },
      nextDocument: sampleDocument,
      requestSelection,
    });

    // 別インスタンス経由の読み直しでも requestSelection が保持される (正本はディスク)。
    const reloadedStore = new LocalMcpEditProposalStore(userDataDir);
    expect((await reloadedStore.loadProposal(proposal.proposalId))?.requestSelection).toEqual(requestSelection);
    const [summary] = await reloadedStore.listProposals();
    expect(summary.requestSelection).toEqual(requestSelection);
  });

  it("rejects a persisted legacy draft with a loopback image source on load, preview, approval, and rebase paths", async () => {
    const baseDocument = paragraphDocument(["anchor"]);
    const draft: AiEditSessionDraft = {
      summary: "画像を挿入しました。",
      plan: ["画像を挿入しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像を挿入しました。",
        targetId: "anchor",
        overlayShape: {
          id: "shape_legacy_image",
          type: "image",
          x: 10,
          y: 10,
          props: { assetId: "asset_legacy", w: 120, h: 80 },
        },
        assets: {
          asset_legacy: {
            id: "asset_legacy",
            type: "image",
            props: {
              w: 120,
              h: 80,
              name: "legacy.png",
              isAnimated: false,
              mimeType: "image/png",
              src: "sigma-doc-storage://asset_legacy",
              fileSize: 10,
            },
          },
        },
      }],
      warnings: [],
    };
    const invalidAtCreation = structuredClone(draft);
    const invalidOperation = invalidAtCreation.operations[0];
    if (invalidOperation?.operation !== "insertOverlayShape") throw new Error("unexpected test draft");
    invalidOperation.assets.asset_legacy!.props.src = "http://127.0.0.1/private.png";
    await expect(store.createProposal({
      fileId: "file_invalid_creation",
      baseRevision: 1,
      baseDocument,
      summary: invalidAtCreation.summary,
      plan: invalidAtCreation.plan,
      provider: null,
      source: { toolName: "draft_attach_image_asset", toolArgs: {} },
      draft: invalidAtCreation,
      nextDocument: baseDocument,
    })).rejects.toThrow("asset.src");

    const created = await store.createProposal({
      fileId: "file_legacy",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      roomId: "room_legacy",
      runId: "run_legacy",
      source: { toolName: "draft_attach_image_asset", toolArgs: {} },
      draft,
      nextDocument: baseDocument,
    });
    const recordPath = path.join(store.getProposalsDir(), `${encodeURIComponent(created.proposalId)}.proposal.json`);
    const persisted = JSON.parse(await fs.readFile(recordPath, "utf8")) as LocalMcpEditProposal;
    const operation = persisted.draft.operations[0];
    if (operation?.operation !== "insertOverlayShape") throw new Error("unexpected test draft");
    operation.assets.asset_legacy!.props.src = "http://127.0.0.1/private.png";
    await fs.writeFile(recordPath, JSON.stringify(persisted), "utf8");

    const reloadedStore = new LocalMcpEditProposalStore(userDataDir);
    const [summary] = await reloadedStore.listProposals({ status: "pending" });
    expect(summary.invalidReason).toContain("安全な形式に適合しない");
    expect(summary.conflict).toMatchObject({ reason: "replay-failed", blockIds: [] });
    expect(summary.draft.operations).toEqual([]);

    const loaded = await reloadedStore.loadProposal(created.proposalId);
    expect(loaded?.invalidReason).toContain("asset.src");
    expect(findProposalFreshnessConflict(
      loaded!,
      computeDocumentBlockHashes(baseDocument),
      1,
      baseDocument,
    )).toEqual({ blockIds: [], reason: "replay-failed" });
    await expect(reloadedStore.rebaseProposal(created.proposalId, baseDocument, 1)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("安全な形式に適合しない"),
    });

    const replacement = await reloadedStore.upsertCurrentProposal({
      fileId: "file_legacy",
      baseRevision: 1,
      baseDocument,
      summary: "安全な新しい作業案",
      plan: ["安全な新しい作業案"],
      provider: null,
      roomId: "room_legacy",
      runId: "run_legacy",
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: {
        summary: "安全な新しい作業案",
        plan: ["安全な新しい作業案"],
        operations: [{
          operation: "insertAfter",
          summary: "追記",
          targetId: "anchor",
          insertedBlock: { type: "paragraph", id: "safe_new", children: [{ type: "text", text: "safe" }] },
        }],
        warnings: [],
      },
      nextDocument: baseDocument,
    });
    expect(replacement.proposalId).not.toBe(created.proposalId);
    expect((await reloadedStore.loadProposal(created.proposalId))?.invalidReason).toContain("asset.src");
    expect((await reloadedStore.loadProposal(created.proposalId))?.draft.operations).toEqual([]);

    persisted.status = "rejected";
    await fs.writeFile(recordPath, JSON.stringify(persisted), "utf8");
    const restoreStore = new LocalMcpEditProposalStore(userDataDir);
    await expect(restoreStore.restoreResolvedProposal(created.proposalId, baseDocument, 1)).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("安全な形式に適合しない"),
    });
  });

  it("rescans and emits a synthetic proposal change after a watcher restart", async () => {
    type FakeWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };
    const fakeWatchers: FakeWatcher[] = [];
    const watchFactory = vi.fn(() => {
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.close = vi.fn();
      fakeWatchers.push(watcher);
      return watcher as unknown as FSWatcher;
    });
    const retryingStore = new LocalMcpEditProposalStore(userDataDir, {
      watchFactory,
      watchRetryBaseMs: 10,
      watchMaxRetries: 2,
    });
    const events: Array<{ type: string; change: string }> = [];
    const unwatch = retryingStore.watch((event) => events.push(event));
    fakeWatchers[0]!.emit("error", new Error("proposal watcher failed"));

    const externalStore = new LocalMcpEditProposalStore(userDataDir);
    const createdDuringBackoff = await externalStore.createProposal({
      fileId: "file_during_backoff",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "watch停止中に作成",
      plan: ["watch停止中に作成"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "watch停止中に作成", plan: ["watch停止中に作成"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    await vi.waitFor(() => expect(watchFactory).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "mcpProposal",
      change: "changed",
    })));
    expect((await retryingStore.listProposals({ status: "pending" })).map((proposal) => proposal.proposalId))
      .toContain(createdDuringBackoff.proposalId);
    unwatch();
  });

  it("quarantines a safe draft when nextDocument contains an unsafe image source", async () => {
    const baseDocument = paragraphDocument(["anchor"]);
    const created = await store.createProposal({
      fileId: "file_unsafe_next",
      baseRevision: 1,
      baseDocument,
      summary: "安全な本文更新",
      plan: ["安全な本文更新"],
      provider: null,
      roomId: "room_unsafe_next",
      runId: "run_unsafe_next",
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft: {
        summary: "安全な本文更新",
        plan: ["安全な本文更新"],
        operations: [{
          operation: "replace",
          summary: "本文更新",
          targetId: "anchor",
          replacementBlock: { type: "paragraph", id: "anchor", children: [{ type: "text", text: "safe" }] },
        }],
        warnings: [],
      },
      nextDocument: baseDocument,
    });
    const recordPath = path.join(store.getProposalsDir(), `${encodeURIComponent(created.proposalId)}.proposal.json`);
    const persisted = JSON.parse(await fs.readFile(recordPath, "utf8")) as Record<string, unknown>;
    const unsafeNext = ensurePageLayout(baseDocument);
    unsafeNext.pageLayout!.overlay = {
      overlaySnapshot: {
        version: 1,
        shapes: [],
        assets: {
          malicious: {
            id: "malicious",
            type: "image",
            props: { w: 10, h: 10, name: "x", isAnimated: false, mimeType: "image/png", src: "http://127.0.0.1/private.png", fileSize: 10 },
          },
        },
      },
    };
    persisted.nextDocument = unsafeNext;
    await fs.writeFile(recordPath, JSON.stringify(persisted), "utf8");

    const reloaded = new LocalMcpEditProposalStore(userDataDir);
    const [summary] = await reloaded.listProposals({ status: "pending" });
    expect(summary.invalidReason).toContain("nextDocument");
    expect(await reloaded.findCurrentPendingProposal({
      fileId: "file_unsafe_next",
      roomId: "room_unsafe_next",
      runId: "run_unsafe_next",
    })).toBeNull();
  });

  it("recreates a failed proposal watcher with bounded backoff and reports permanent degradation", async () => {
    type FakeWatcher = EventEmitter & { close: ReturnType<typeof vi.fn> };
    const fakeWatchers: FakeWatcher[] = [];
    const watchFactory = vi.fn(() => {
      const watcher = new EventEmitter() as FakeWatcher;
      watcher.close = vi.fn();
      fakeWatchers.push(watcher);
      return watcher as unknown as FSWatcher;
    });
    const retryingStore = new LocalMcpEditProposalStore(userDataDir, {
      watchFactory,
      watchRetryBaseMs: 1,
      watchMaxRetries: 1,
    });
    const events: Array<{ type: string; scope?: string }> = [];
    const unwatch = retryingStore.watch((event) => events.push(event));

    expect(watchFactory).toHaveBeenCalledTimes(1);
    fakeWatchers[0]!.emit("error", new Error("proposal watcher failed"));
    await vi.waitFor(() => expect(watchFactory).toHaveBeenCalledTimes(2));
    expect(fakeWatchers[0]!.close).toHaveBeenCalledOnce();

    fakeWatchers[1]!.emit("error", new Error("proposal watcher failed again"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({
      type: "watcher",
      scope: "mcpProposal",
    })));
    expect(watchFactory).toHaveBeenCalledTimes(2);
    unwatch();
  });

  it("keeps a resolved proposal out of the pending list after a store reload (status is persisted)", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "確定後に亡霊化しないことの確認。",
      plan: [],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "確定後に亡霊化しないことの確認。", plan: [], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。");

    // リロード相当: 新しいストアインスタンスから読み直しても pending に戻らない。
    const reloadedStore = new LocalMcpEditProposalStore(userDataDir);
    expect(await reloadedStore.listProposals({ status: "pending" })).toHaveLength(0);
    expect((await reloadedStore.loadProposal(proposal.proposalId))?.status).toBe("approved");
  });

  it("transitions approved→reverted on editor undo and reverted→approved on redo, skipping other statuses", async () => {
    const create = () => store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "undo/redo整合の確認。",
      plan: [],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "undo/redo整合の確認。", plan: [], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    const approved = await create();
    await store.resolveProposal(approved.proposalId, "approved", "承認しました。");
    const stillPending = await create();

    const undone = await store.markProposalsRevertedByUndo([approved.proposalId, stillPending.proposalId, "missing_id"]);
    expect(undone.transitioned).toEqual([approved.proposalId]);
    expect(undone.skipped).toEqual([stillPending.proposalId, "missing_id"]);
    expect((await store.loadProposal(approved.proposalId))?.status).toBe("reverted");

    const redone = await store.markProposalsReappliedByRedo([approved.proposalId, stillPending.proposalId]);
    expect(redone.transitioned).toEqual([approved.proposalId]);
    expect(redone.skipped).toEqual([stillPending.proposalId]);
    expect((await store.loadProposal(approved.proposalId))?.status).toBe("approved");
  });

  it("atomically revises one pending proposal across turns in the same room", async () => {
    const first = await store.upsertCurrentProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "初回案",
      plan: ["初回"],
      provider: "chatgpt",
      roomId: "room_1",
      runId: "run_1",
      turnId: "turn_1",
      source: { toolName: "insert_body_content", toolArgs: {} },
      draft: { summary: "初回案", plan: ["初回"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    const revised = await store.upsertCurrentProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "修正案",
      plan: ["修正"],
      provider: "chatgpt",
      roomId: "room_1",
      runId: "run_2",
      turnId: "turn_2",
      source: { toolName: "update_rich_content", toolArgs: {} },
      draft: { summary: "修正案", plan: ["修正"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    expect(revised.proposalId).toBe(first.proposalId);
    expect(revised.summary).toBe("修正案");
    expect(revised.runId).toBe("run_2");
    expect(revised.history).toEqual([expect.objectContaining({ action: "revised", runId: "run_2", turnId: "turn_2" })]);
    expect(await store.listProposals({ status: "pending" })).toHaveLength(1);
  });

  it("accumulates same-run upserts into an ordered proposal group", async () => {
    const baseDocument = paragraphDocument(["p_1"]);
    const firstDraft: AiEditSessionDraft = {
      summary: "p_2を追加",
      plan: ["p_2を追加"],
      warnings: [],
      operations: [{
        operation: "insertAfter",
        summary: "p_2を追加",
        targetId: "p_1",
        insertedBlock: { type: "paragraph", id: "p_2", children: [{ type: "text", text: "p_2" }] },
      }],
    };
    const firstNextDocument = replayProposalDraft(baseDocument, firstDraft).nextDocument;
    const first = await store.upsertCurrentProposal({
      fileId: "file_group", baseRevision: 1, baseDocument,
      summary: firstDraft.summary, plan: firstDraft.plan, provider: null,
      roomId: "room_group", runId: "run_group",
      source: { toolName: "insert_body_content", toolArgs: {} }, draft: firstDraft,
      nextDocument: firstNextDocument,
    });
    const secondDraft: AiEditSessionDraft = {
      summary: "p_3を追加",
      plan: ["p_3を追加"],
      warnings: [],
      operations: [{
        operation: "insertAfter",
        summary: "p_3を追加",
        targetId: "p_2",
        insertedBlock: { type: "paragraph", id: "p_3", children: [{ type: "text", text: "p_3" }] },
      }],
    };

    // p_2は保存済みbaseDocumentには無い。old draft→new draftの順でreplayできることが回帰条件。
    const second = await store.upsertCurrentProposal({
      fileId: "file_group", baseRevision: 1, baseDocument,
      summary: secondDraft.summary, plan: secondDraft.plan, provider: null,
      roomId: "room_group", runId: "run_group",
      source: { toolName: "insert_body_content", toolArgs: {} }, draft: secondDraft,
      nextDocument: firstNextDocument,
    });

    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second.groupId).toBeTruthy();
    expect(second.groupMemberIds).toEqual([first.proposalId, second.proposalId]);
    expect(second.groupPosition).toBe(1);
    expect(second.draft.operations.map((operation) => operation.targetId)).toEqual(["p_1", "p_2"]);
    expect(second.nextDocument.content.map((block) => block.id)).toEqual(["p_1", "p_2", "p_3"]);
    expect(await store.loadProposal(first.proposalId)).toMatchObject({
      groupId: second.groupId,
      groupMemberIds: [first.proposalId, second.proposalId],
      groupPosition: 0,
    });
    expect((await store.listProposals({ status: "pending" }))[0]).toMatchObject({
      groupId: second.groupId,
      groupMemberIds: [first.proposalId, second.proposalId],
    });
  });

  it("keeps a far-off overlay anchor untouched on approval (提案位置=適用後位置)", async () => {
    // 承認時にだけ anchor.dy を書き換えると、プレビューは blockTop+dy・適用後は
    // blockTop+8 になり「提案した位置と違うところに図形が出る」。承認は座標に触らない。
    const baseDocument = paragraphDocument(["p_1"]);
    const shape = {
      id: "shape_far_anchor",
      type: "geo" as const,
      x: 120,
      y: 2100,
      rotation: 0,
      anchor: { type: "block" as const, blockId: "p_1", dx: 40, dy: 2000 },
      props: {
        w: 240,
        h: 120,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "black",
        fillColor: "#ffffff",
        labelColor: "black",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
    const nextDocument: SigmaDocument = {
      ...baseDocument,
      pageLayout: {
        ...ensurePageLayout(baseDocument).pageLayout!,
        overlay: {
          overlaySnapshot: { version: 1, shapes: [shape], assets: {} },
          updatedAt: "2026-07-26T00:00:00.000Z",
        },
      },
    };

    const proposal = await store.createProposal({
      fileId: "file_anchor",
      baseRevision: 1,
      baseDocument,
      summary: "表を挿入しました。",
      plan: [],
      provider: null,
      source: { toolName: "insert_table", toolArgs: {} },
      draft: { summary: "表を挿入しました。", plan: [], operations: [], warnings: [] },
      nextDocument,
    });

    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 2,
      appliedDocument: nextDocument,
    });

    const approved = await store.loadProposal(proposal.proposalId);
    const appliedShape = approved?.nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
    expect(appliedShape?.anchor).toEqual({ type: "block", blockId: "p_1", dx: 40, dy: 2000 });
    expect(appliedShape).toMatchObject({ x: 120, y: 2100 });
  });

  it("resolves every same-run group member atomically with one applied revision", async () => {
    const baseDocument = paragraphDocument(["p_1"]);
    const firstDraft: AiEditSessionDraft = {
      summary: "p_2を追加", plan: [], warnings: [],
      operations: [{ operation: "insertAfter", summary: "p_2", targetId: "p_1", insertedBlock: {
        type: "paragraph", id: "p_2", children: [{ type: "text", text: "p_2" }],
      } }],
    };
    const first = await store.upsertCurrentProposal({
      fileId: "file_group", baseRevision: 1, baseDocument, summary: "first", plan: [], provider: null,
      roomId: "room_group", runId: "run_group", source: { toolName: "insert", toolArgs: {} },
      draft: firstDraft, nextDocument: replayProposalDraft(baseDocument, firstDraft).nextDocument,
    });
    const secondDraft: AiEditSessionDraft = {
      summary: "p_3を追加", plan: [], warnings: [],
      operations: [{ operation: "insertAfter", summary: "p_3", targetId: "p_2", insertedBlock: {
        type: "paragraph", id: "p_3", children: [{ type: "text", text: "p_3" }],
      } }],
    };
    const second = await store.upsertCurrentProposal({
      fileId: "file_group", baseRevision: 1, baseDocument, summary: "second", plan: [], provider: null,
      roomId: "room_group", runId: "run_group", source: { toolName: "insert", toolArgs: {} },
      draft: secondDraft, nextDocument: baseDocument,
    });

    await store.resolveProposal(first.proposalId, "approved", "グループ承認", {
      appliedRevision: 2,
      revertDocument: baseDocument,
    });

    for (const proposalId of [first.proposalId, second.proposalId]) {
      const member = await store.loadProposal(proposalId);
      expect(member).toMatchObject({ status: "approved", appliedRevision: 2 });
      expect(member?.nextDocument.content.map((block) => block.id)).toEqual(["p_1", "p_2", "p_3"]);
    }
  });

  it("withdraws the room's current proposal and keeps a durable history entry", async () => {
    const proposal = await store.upsertCurrentProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "取り下げ前",
      plan: [],
      provider: null,
      roomId: "room_1",
      runId: "run_1",
      source: { toolName: "insert_body_content", toolArgs: {} },
      draft: { summary: "取り下げ前", plan: [], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    const withdrawn = await store.withdrawCurrentProposal({ fileId: "file_1", roomId: "room_1", reason: "不要になった" });
    expect(withdrawn?.proposalId).toBe(proposal.proposalId);
    expect(withdrawn?.status).toBe("rejected");
    expect(withdrawn?.history).toEqual([expect.objectContaining({ action: "withdrawn", reason: "不要になった" })]);
  });

  it("restores a rejected draft only when it still reapplies without a freshness conflict", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "復活対象",
      plan: [],
      provider: null,
      source: { toolName: "delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]),
      requestSelection: { blockIds: [], hashes: {}, capturedRevision: 1 },
    });
    await store.resolveProposal(proposal.proposalId, "rejected", "却下", { rejectedReason: "要再検討" });

    const restored = await store.restoreResolvedProposal(proposal.proposalId, sampleDocument, 2);
    expect(restored.ok).toBe(true);
    expect((await store.loadProposal(proposal.proposalId))?.history).toEqual([
      expect.objectContaining({ action: "rejected", reason: "要再検討" }),
      expect.objectContaining({ action: "reproposed" }),
    ]);

    await store.resolveProposal(proposal.proposalId, "rejected", "再却下");
    const conflicted = await store.restoreResolvedProposal(
      proposal.proposalId,
      deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]),
      3,
    );
    expect(conflicted).toEqual({ ok: false, reason: expect.stringContaining(SOLE_BLOCK_ID) });
    expect((await store.loadProposal(proposal.proposalId))?.status).toBe("rejected");
  });

  it("restores a reverted draft the same way, and clears stale approval bookkeeping so it doesn't leak into the next approval", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "差し戻し復活対象",
      plan: [],
      provider: null,
      source: { toolName: "delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]),
      requestSelection: { blockIds: [], hashes: {}, capturedRevision: 1 },
    });
    // 承認 (自動適用) → undoでreverted、という一連の遷移を再現する。
    await store.resolveProposal(proposal.proposalId, "approved", "自動承認しました。", {
      appliedRevision: 1,
      revertDocument: sampleDocument,
      autoApplied: true,
    });
    await store.markProposalsRevertedByUndo([proposal.proposalId]);
    expect((await store.loadProposal(proposal.proposalId))?.status).toBe("reverted");

    const restored = await store.restoreResolvedProposal(proposal.proposalId, sampleDocument, 2);
    expect(restored.ok).toBe(true);
    const raw = await store.loadProposal(proposal.proposalId);
    expect(raw?.status).toBe("pending");
    expect(raw?.history).toEqual([expect.objectContaining({ action: "reproposed" })]);
    // 差し戻し前の承認 (自動適用) の残骸が残っていると、次に手動承認したときに
    // 自動適用ラベルが誤って復活してしまう。
    expect(raw?.autoApplied).toBeUndefined();
    expect(raw?.appliedRevision).toBeUndefined();
    expect(raw?.revertDocument).toBeUndefined();
  });

  it("refuses to restore a proposal that is still pending or approved", async () => {
    const pending = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "pending",
      plan: [],
      provider: null,
      source: { toolName: "delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]),
    });
    const pendingResult = await store.restoreResolvedProposal(pending.proposalId, sampleDocument, 1);
    expect(pendingResult).toEqual({ ok: false, reason: expect.stringContaining("却下または差し戻し済み") });

    await store.resolveProposal(pending.proposalId, "approved", "承認しました。", {
      appliedRevision: 1,
      revertDocument: sampleDocument,
    });
    const approvedResult = await store.restoreResolvedProposal(pending.proposalId, sampleDocument, 1);
    expect(approvedResult).toEqual({ ok: false, reason: expect.stringContaining("却下または差し戻し済み") });
  });

  it("rolls a failed run back to the room proposal captured before the first tool call", async () => {
    const original = await store.upsertCurrentProposal({
      fileId: "file_1", baseRevision: 1, baseDocument: sampleDocument,
      summary: "run前", plan: [], provider: null, roomId: "room_1", runId: "run_old",
      source: { toolName: "insert_body_content", toolArgs: {} },
      draft: { summary: "run前", plan: [], operations: [], warnings: [] }, nextDocument: sampleDocument,
    });
    const snapshotId = await store.beginProposalRunSnapshot("room_1", "file_1");
    await store.upsertCurrentProposal({
      fileId: "file_1", baseRevision: 1, baseDocument: sampleDocument,
      summary: "run途中", plan: [], provider: null, roomId: "room_1", runId: "run_new",
      source: { toolName: "update_rich_content", toolArgs: {} },
      draft: { summary: "run途中", plan: [], operations: [], warnings: [] }, nextDocument: sampleDocument,
    });

    expect(await store.rollbackProposalRunSnapshot(snapshotId)).toBe(true);
    expect(await store.loadProposal(original.proposalId)).toMatchObject({ summary: "run前", runId: "run_old" });
  });

  it("removes a proposal created during a failed run when the room had no prior pending proposal", async () => {
    const snapshotId = await store.beginProposalRunSnapshot("room_1", "file_1");
    const created = await store.upsertCurrentProposal({
      fileId: "file_1", baseRevision: 1, baseDocument: sampleDocument,
      summary: "run途中", plan: [], provider: null, roomId: "room_1", runId: "run_new",
      source: { toolName: "insert_body_content", toolArgs: {} },
      draft: { summary: "run途中", plan: [], operations: [], warnings: [] }, nextDocument: sampleDocument,
    });

    expect(await store.rollbackProposalRunSnapshot(snapshotId)).toBe(true);
    expect(await store.loadProposal(created.proposalId)).toBeNull();
  });
});

describe("LocalMcpEditProposalStore attribution (runId/roomId/turnId/sessionLabel)", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-attrib-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createBaseProposal(extra: Partial<Parameters<LocalMcpEditProposalStore["createProposal"]>[0]> = {}) {
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
      ...extra,
    });
  }

  it("round-trips runId/roomId/turnId/sessionLabel through createProposal and listProposals", async () => {
    const proposal = await createBaseProposal({
      runId: "run_1",
      roomId: "room_1",
      turnId: "turn_1",
      sessionLabel: "第1回授業",
      verification: { validationOk: true, previewSource: "katex" },
    });

    expect(proposal.runId).toBe("run_1");
    expect(proposal.roomId).toBe("room_1");
    expect(proposal.turnId).toBe("turn_1");
    expect(proposal.sessionLabel).toBe("第1回授業");
    expect(proposal.verification).toEqual({ validationOk: true, previewSource: "katex" });

    const [summary] = await store.listProposals();
    expect(summary.runId).toBe("run_1");
    expect(summary.roomId).toBe("room_1");
    expect(summary.turnId).toBe("turn_1");
    expect(summary.sessionLabel).toBe("第1回授業");
    expect(summary.verification).toEqual({ validationOk: true, previewSource: "katex" });
  });

  it("tolerates old proposal records that predate the attribution fields", async () => {
    const proposal = await createBaseProposal();
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete raw.runId;
    delete raw.roomId;
    delete raw.turnId;
    delete raw.sessionLabel;
    delete raw.verification;
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const [summary] = await store.listProposals();
    expect(summary.runId).toBeUndefined();
    expect(summary.roomId).toBeUndefined();
    expect(summary.turnId).toBeUndefined();
    expect(summary.sessionLabel).toBeUndefined();
    expect(summary.verification).toBeUndefined();
  });

  it("ignores garbage-typed attribution/verification fields on a corrupted record instead of throwing", async () => {
    const proposal = await createBaseProposal();
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    raw.runId = 12345;
    raw.verification = { validationOk: "not-a-boolean" };
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const [summary] = await store.listProposals();
    expect(summary.runId).toBeUndefined();
    expect(summary.verification).toBeUndefined();
  });
});

describe("LocalMcpEditProposalStore#rejectProposals (reject with reason)", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-reject-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createPending() {
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
  }

  it("rejects multiple pending proposals with a shared reason, recording rejectedReason/rejectedAt", async () => {
    const a = await createPending();
    const b = await createPending();

    const { rejected, failed } = await store.rejectProposals([a.proposalId, b.proposalId], "対象がもう不要になったため。");

    expect(failed).toHaveLength(0);
    expect(rejected).toHaveLength(2);
    for (const proposal of rejected) {
      expect(proposal.status).toBe("rejected");
      expect(proposal.rejectedReason).toBe("対象がもう不要になったため。");
      expect(proposal.rejectedAt).toBeTruthy();
    }
  });

  it("rejects without a reason, leaving rejectedReason unset", async () => {
    const a = await createPending();

    const { rejected } = await store.rejectProposals([a.proposalId]);

    expect(rejected[0].status).toBe("rejected");
    expect(rejected[0].rejectedReason).toBeUndefined();
    expect(rejected[0].rejectedAt).toBeTruthy();
  });

  it("continues past a proposal that fails, reporting it under `failed` without aborting the batch", async () => {
    const a = await createPending();
    const b = await createPending();
    await store.resolveProposal(b.proposalId, "approved", "先に承認済み。");

    const { rejected, failed } = await store.rejectProposals([a.proposalId, b.proposalId], "理由。");

    expect(rejected.map((p) => p.proposalId)).toEqual([a.proposalId]);
    expect(failed).toEqual([{ proposalId: b.proposalId, error: "このMCP編集提案はすでに処理済みです。" }]);
  });
});

describe("LocalMcpEditProposalStore#rebaseProposal", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-rebase-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("rebases every member of a same-run group with the combined operation list", async () => {
    const baseDocument = paragraphDocument(["p_1"]);
    const firstDraft: AiEditSessionDraft = {
      summary: "p_2", plan: [], warnings: [], operations: [{
        operation: "insertAfter", summary: "p_2", targetId: "p_1",
        insertedBlock: { type: "paragraph", id: "p_2", children: [{ type: "text", text: "p_2" }] },
      }],
    };
    const first = await store.upsertCurrentProposal({
      fileId: "file_group_rebase", baseRevision: 1, baseDocument, summary: "p_2", plan: [], provider: null,
      roomId: "room_group", runId: "run_group", source: { toolName: "insert", toolArgs: {} },
      draft: firstDraft, nextDocument: replayProposalDraft(baseDocument, firstDraft).nextDocument,
    });
    const secondDraft: AiEditSessionDraft = {
      summary: "p_3", plan: [], warnings: [], operations: [{
        operation: "insertAfter", summary: "p_3", targetId: "p_2",
        insertedBlock: { type: "paragraph", id: "p_3", children: [{ type: "text", text: "p_3" }] },
      }],
    };
    const second = await store.upsertCurrentProposal({
      fileId: "file_group_rebase", baseRevision: 1, baseDocument, summary: "p_3", plan: [], provider: null,
      roomId: "room_group", runId: "run_group", source: { toolName: "insert", toolArgs: {} },
      draft: secondDraft, nextDocument: baseDocument,
    });
    const currentDocument = paragraphDocument(["unrelated", "p_1"]);

    const result = await store.rebaseProposal(second.proposalId, currentDocument, 7);

    expect(result.ok).toBe(true);
    for (const proposalId of [first.proposalId, second.proposalId]) {
      const member = await store.loadProposal(proposalId);
      expect(member).toMatchObject({ baseRevision: 7, baseDocId: currentDocument.docId, rebasedFrom: 1 });
      expect(member?.draft.operations).toHaveLength(2);
      expect(member?.nextDocument.content.map((block) => block.id)).toEqual(["unrelated", "p_1", "p_2", "p_3"]);
      expect(member?.touchedBlocks?.map((block) => block.id)).toEqual(["p_1", "p_2", "p_3"]);
    }
  });

  it("preserves an update_rich_content fraction edit through rebase and approval", async () => {
    const originalTex = String.raw`\tfrac{1}{2}`;
    const replacementTex = String.raw`\dfrac{1}{2}`;
    const baseDocument = inlineFractionDocument(originalTex);
    const replacementBlock = {
      ...baseDocument.content[0],
      children: [
        { type: "text" as const, text: "値は " },
        { type: "mathInline" as const, id: "m_fraction", tex: replacementTex, display: "inline" as const },
        { type: "text" as const, text: " です。" },
      ],
    } as ParagraphNode;
    const draft: AiEditSessionDraft = {
      summary: "行内数式の分数表示を変更しました。",
      plan: ["行内数式の分数表示を変更しました。"],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "段落本文を更新しました。",
        targetId: "p_fraction",
        replacementBlock,
      }],
    };
    const proposedDocument = updateBlockInDocument(baseDocument, "p_fraction", () => replacementBlock);
    const proposal = await store.createProposal({
      fileId: "file_fraction",
      baseRevision: 342,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "update_rich_content", toolArgs: {} },
      draft,
      nextDocument: proposedDocument,
    });
    const currentDocument: SigmaDocument = {
      ...baseDocument,
      content: [
        ...baseDocument.content,
        {
          type: "paragraph",
          id: "p_unrelated",
          children: [{ type: "text", text: "無関係な追記" }],
        },
      ],
    };

    const result = await store.rebaseProposal(proposal.proposalId, currentDocument, 343);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.rebasedFrom).toBe(342);
    expect(result.proposal.draft.operations[0]).toMatchObject({
      operation: "replace",
      replacementBlock: { children: [
        { type: "text", text: "値は " },
        { type: "mathInline", tex: replacementTex },
        { type: "text", text: " です。" },
      ] },
    });

    const rebased = await store.loadProposal(proposal.proposalId);
    expect(rebased).not.toBeNull();
    expect(fractionTex(rebased!.nextDocument)).toBe(replacementTex);
    expect(JSON.stringify(rebased!.nextDocument)).not.toContain(originalTex);
    expect(rebased!.nextDocument.content).toContainEqual(currentDocument.content[1]);

    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 344,
      revertDocument: currentDocument,
      appliedDocument: rebased!.nextDocument,
    });
    const [approved] = await store.listProposals({ status: "approved" });
    expect(approved.appliedDiff?.body.map((entry) => ({
      change: entry.change,
      tex: entry.block.type === "paragraph"
        ? entry.block.children.find((child) => child.type === "mathInline")?.tex
        : undefined,
    }))).toEqual([
      { change: "removed", tex: originalTex },
      { change: "added", tex: replacementTex },
    ]);
  });

  it("records a conflict when an update_rich_content target was deleted before rebase", async () => {
    const baseDocument = inlineFractionDocument(String.raw`\tfrac{1}{2}`);
    const replacementBlock = {
      ...baseDocument.content[0],
      children: [{ type: "mathInline", id: "m_fraction", tex: String.raw`\dfrac{1}{2}`, display: "inline" }],
    } as ParagraphNode;
    const draft: AiEditSessionDraft = {
      summary: "分数表示を更新しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "段落本文を更新しました。",
        targetId: "p_fraction",
        replacementBlock,
      }],
    };
    const proposal = await store.createProposal({
      fileId: "file_fraction",
      baseRevision: 342,
      baseDocument,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "update_rich_content", toolArgs: {} },
      draft,
      nextDocument: updateBlockInDocument(baseDocument, "p_fraction", () => replacementBlock),
    });
    const deletedTargetDocument = { ...baseDocument, content: [] };

    const result = await store.rebaseProposal(proposal.proposalId, deletedTargetDocument, 343);

    expect(result.ok).toBe(false);
    expect(await store.loadProposal(proposal.proposalId)).toMatchObject({
      status: "pending",
      baseRevision: 342,
      conflict: { blockIds: ["p_fraction"], detectedAtRevision: 343 },
    });
  });

  it("rejects a replace proposal's silent no-op during pre-resolution validation", async () => {
    const originalTex = String.raw`\tfrac{1}{2}`;
    const replacementTex = String.raw`\dfrac{1}{2}`;
    const baseDocument = inlineFractionDocument(originalTex);
    const replacementBlock = {
      ...baseDocument.content[0],
      children: [{ type: "mathInline", id: "m_fraction", tex: replacementTex, display: "inline" }],
    } as ParagraphNode;
    const draft: AiEditSessionDraft = {
      summary: "分数表示を更新しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "段落本文を更新しました。",
        targetId: "p_fraction",
        replacementBlock,
      }],
    };
    const proposal = await store.createProposal({
      fileId: "file_fraction",
      baseRevision: 342,
      baseDocument,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "update_rich_content", toolArgs: {} },
      draft,
      nextDocument: updateBlockInDocument(baseDocument, "p_fraction", () => replacementBlock),
    });

    expect(() => assertAppliedProposalHasRealChanges(
      parseSigmaDocument(baseDocument),
      baseDocument,
      proposal.draft,
    )).toThrow("変更差分が失われた");
    expect((await store.loadProposal(proposal.proposalId))?.status).toBe("pending");
  });

  it("re-applies a pending proposal's draft to the current document and updates baseRevision/nextDocument/rebasedFrom", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "対象ブロックを削除しました。",
      plan: ["対象ブロックを削除しました。"],
      provider: null,
      source: { toolName: "draft_delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: parseSigmaDocument(deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID])),
    });

    const result = await store.rebaseProposal(proposal.proposalId, sampleDocument, 7);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.proposal.baseRevision).toBe(7);
      expect(result.proposal.rebasedFrom).toBe(1);
      expect(result.proposal.baseDocId).toBe(sampleDocument.docId);
    }

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(7);
    expect(reloaded?.rebasedFrom).toBe(1);
    expect(reloaded?.nextDocument.content).toHaveLength(0);
  });

  it("fails without modifying the record when the target block is no longer present in the current document", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "対象ブロックを削除しました。",
      plan: ["対象ブロックを削除しました。"],
      provider: null,
      source: { toolName: "draft_delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: sampleDocument,
    });

    const alreadyEmptied = parseSigmaDocument(deleteBlocksFromDocument(sampleDocument, [SOLE_BLOCK_ID]));
    const result = await store.rebaseProposal(proposal.proposalId, alreadyEmptied, 9);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("対象ブロックが見つかりません");
    }

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(1);
    expect(reloaded?.rebasedFrom).toBeUndefined();
  });

  it("refuses to rebase a proposal that is not pending", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "対象ブロックを削除しました。",
      plan: ["対象ブロックを削除しました。"],
      provider: null,
      source: { toolName: "draft_delete_blocks", toolArgs: {} },
      draft: deleteBlockDraft(),
      nextDocument: sampleDocument,
    });
    await store.resolveProposal(proposal.proposalId, "approved", "承認済み。");

    const result = await store.rebaseProposal(proposal.proposalId, sampleDocument, 2);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("処理済みの提案は再適用(rebase)できません。");
    }
  });

  it("returns a Japanese not-found reason for an unknown proposalId", async () => {
    const result = await store.rebaseProposal("mcp_proposal_missing", sampleDocument, 1);
    expect(result).toEqual({ ok: false, reason: "MCP編集提案が見つかりません。" });
  });
});

describe("LocalMcpEditProposalStore approve extras (appliedRevision/revertDocument/autoApplied) and revert", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-revert-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createPending() {
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
  }

  it("stores appliedRevision/revertDocument/autoApplied when approving, and keeps revertDocument out of the summary", async () => {
    const proposal = await createPending();

    const resolved = await store.resolveProposal(proposal.proposalId, "approved", "自動承認しました。", {
      appliedRevision: 5,
      revertDocument: sampleDocument,
      autoApplied: true,
    });

    expect(resolved.appliedRevision).toBe(5);
    expect(resolved.revertDocument?.docId).toBe(sampleDocument.docId);
    expect(resolved.autoApplied).toBe(true);

    const [summary] = await store.listProposals({ status: "approved" });
    expect(summary.appliedRevision).toBe(5);
    expect(summary.autoApplied).toBe(true);
    expect((summary as unknown as { revertDocument?: unknown }).revertDocument).toBeUndefined();
  });

  it("returns only the real before/after nodes needed by the applied chat diff", async () => {
    const before = paragraphDocument(["p1"]);
    const after = updateBlockInDocument(before, "p1", (block) => ({
      ...block,
      children: [{ type: "text", text: "適用後の本文" }],
    } as ParagraphNode));
    const draft: AiEditSessionDraft = {
      summary: "この説明文は差分カードに表示しない",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "本文を置換",
        targetId: "p1",
        replacementBlock: after.content[0],
      }],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: before,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "draft_replace_body_content", toolArgs: {} },
      draft,
      nextDocument: after,
    });

    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 2,
      revertDocument: before,
      appliedDocument: after,
    });

    const [summary] = await store.listProposals({ status: "approved" });
    expect(summary.appliedDiff?.body.map((entry) => ({
      change: entry.change,
      text: entry.block.type === "paragraph" ? entry.block.children[0] : null,
    }))).toEqual([
      { change: "removed", text: { type: "text", text: "p1" } },
      { change: "added", text: { type: "text", text: "適用後の本文" } },
    ]);
    expect((summary as unknown as { revertDocument?: unknown }).revertDocument).toBeUndefined();
  });

  it("never double-applies: resolving an already-approved proposal again throws", async () => {
    const proposal = await createPending();
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", { appliedRevision: 2, revertDocument: sampleDocument });

    await expect(
      store.resolveProposal(proposal.proposalId, "approved", "二重承認しようとした。", { appliedRevision: 2, revertDocument: sampleDocument }),
    ).rejects.toThrow("このMCP編集提案はすでに処理済みです。");
  });

  it("getRevertPlan/markReverted: happy path (mode: full) when revisions still match", async () => {
    const proposal = await createPending();
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 5,
      revertDocument: sampleDocument,
    });

    const plan = await store.getRevertPlan(proposal.proposalId, 5, sampleDocument);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("full");
    expect(plan.document.docId).toBe(sampleDocument.docId);
    expect(plan.proposalIds).toEqual([proposal.proposalId]);

    const reverted = await store.markReverted(proposal.proposalId);
    expect(reverted.status).toBe("reverted");
    expect(await store.listProposals({ status: "reverted" })).toHaveLength(1);
  });

  it("getRevertPlan (Phase 2): falls back to a selective plan when the document moved on, and refuses when the touched block itself was re-edited", async () => {
    const before = paragraphDocument(["p1", "p2"]);
    const after = updateBlockInDocument(before, "p2", (block) => ({
      ...block,
      children: [{ type: "text", text: "ai-changed" }],
    } as ParagraphNode));
    const draft: AiEditSessionDraft = {
      summary: "p2を書き換えました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p2を書き換えました。",
        targetId: "p2",
        replacementBlock: after.content[1],
      }],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: before,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "draft_replace_body_content", toolArgs: {} },
      draft,
      nextDocument: after,
    });
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 2,
      revertDocument: before,
      appliedDocument: after,
    });

    // Someone edited an unrelated block (p1) after the AI applied its change to p2, so the
    // document is no longer at appliedRevision. Selective revert should still restore p2.
    const currentAfterUnrelatedEdit = updateBlockInDocument(after, "p1", (block) => ({
      ...block,
      children: [{ type: "text", text: "user-edited-unrelated" }],
    } as ParagraphNode));
    const selectivePlan = await store.getRevertPlan(proposal.proposalId, 3, currentAfterUnrelatedEdit);
    expect(selectivePlan.ok).toBe(true);
    if (!selectivePlan.ok) return;
    expect(selectivePlan.mode).toBe("selective");
    expect(selectivePlan.proposalIds).toEqual([proposal.proposalId]);
    const restoredP2 = selectivePlan.document.content.find((block) => block.id === "p2") as ParagraphNode;
    expect(restoredP2.children[0]).toEqual({ type: "text", text: "p2" });
    const untouchedP1 = selectivePlan.document.content.find((block) => block.id === "p1") as ParagraphNode;
    expect(untouchedP1.children[0]).toEqual({ type: "text", text: "user-edited-unrelated" });

    // But if the touched block (p2, the one the AI itself changed) was edited again on top of
    // that, it's no longer safe to silently overwrite the user's follow-up edit.
    const currentWithConflict = updateBlockInDocument(after, "p2", (block) => ({
      ...block,
      children: [{ type: "text", text: "user-overwrote-ai-change" }],
    } as ParagraphNode));
    const conflictPlan = await store.getRevertPlan(proposal.proposalId, 3, currentWithConflict);
    expect(conflictPlan).toEqual({
      ok: false,
      reason: "適用後にAIが変更した箇所へ編集が加えられているため取り消せません。",
    });
  });

  it("getRevertPlan refuses for a proposal that was never approved", async () => {
    const proposal = await createPending();
    const plan = await store.getRevertPlan(proposal.proposalId, 1, sampleDocument);
    expect(plan).toEqual({ ok: false, reason: "承認済みの提案のみ取り消せます。" });
  });

  it("getRevertPlan refuses for a legacy proposal approved without recording appliedRevision", async () => {
    const proposal = await createPending();
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。");

    const plan = await store.getRevertPlan(proposal.proposalId, 1, sampleDocument);
    expect(plan).toEqual({ ok: false, reason: "この適用には取り消しに必要な情報が記録されていません。" });
  });

  it("getRevertPlan groups the whole approval batch (same fileId + appliedRevision) and reverts all of it in one call", async () => {
    const proposalA = await createPending();
    const proposalB = await createPending();
    await store.resolveProposal(proposalA.proposalId, "approved", "一括承認しました。", {
      appliedRevision: 9,
      revertDocument: sampleDocument,
    });
    await store.resolveProposal(proposalB.proposalId, "approved", "一括承認しました。", {
      appliedRevision: 9,
      revertDocument: sampleDocument,
    });

    const plan = await store.getRevertPlan(proposalA.proposalId, 9, sampleDocument);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("full");
    expect(new Set(plan.proposalIds)).toEqual(new Set([proposalA.proposalId, proposalB.proposalId]));

    for (const proposalId of plan.proposalIds) {
      await store.markReverted(proposalId);
    }
    const reverted = await store.listProposals({ status: "reverted" });
    expect(reverted.map((item) => item.proposalId).sort()).toEqual(
      [proposalA.proposalId, proposalB.proposalId].sort(),
    );
  });

  it("getRevertPlan still allows mode: full (CAS-exact) revert even when the batch contains an op selective revert can't handle", async () => {
    // updatePageLayout changes page settings, not any block/shape id — buildSelectiveRevertDocument
    // refuses batches containing it (see selective-revert.test.ts), but that must never block the
    // simple case where the document hasn't moved on at all: full mode just restores revertDocument
    // wholesale and doesn't need to understand the draft's mutation ops at all.
    const draft: AiEditSessionDraft = {
      summary: "用紙の向きを変更しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{
        operation: "updatePageLayout",
        summary: "用紙の向きを変更しました。",
        patch: { orientation: "landscape" },
      }],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "draft_update_page_layout", toolArgs: {} },
      draft,
      nextDocument: sampleDocument,
    });
    await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
      appliedRevision: 6,
      revertDocument: sampleDocument,
    });

    const plan = await store.getRevertPlan(proposal.proposalId, 6, sampleDocument);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.mode).toBe("full");
    expect(plan.proposalIds).toEqual([proposal.proposalId]);
  });
});

describe("LocalMcpEditProposalStore sourceReferences (Phase 1: Agentic RAG)", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  const sourceReferences: AiSourceReference[] = [
    { type: "document", fileId: "file_other", title: "過去教材", blockId: "block_1", note: "類題を参考にした" },
    { type: "web", url: "https://example.com/article", title: "参考記事" },
    { type: "material", materialId: "material_1", name: "座標平面テンプレート" },
  ];

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-source-refs-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createPendingWithRefs(refs?: AiSourceReference[]) {
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
      ...(refs ? { sourceReferences: refs } : {}),
    });
  }

  it("round-trips all 3 sourceReference variants through createProposal, listProposals, and reload", async () => {
    const proposal = await createPendingWithRefs(sourceReferences);
    expect(proposal.sourceReferences).toEqual(sourceReferences);

    const [summary] = await store.listProposals();
    expect(summary.sourceReferences).toEqual(sourceReferences);

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.sourceReferences).toEqual(sourceReferences);
  });

  it("omits sourceReferences entirely when none were given", async () => {
    const proposal = await createPendingWithRefs();
    expect(proposal.sourceReferences).toBeUndefined();

    const [summary] = await store.listProposals();
    expect(summary.sourceReferences).toBeUndefined();
  });

  it("round-trips a webSearch reference (Codex reports no URL, only the query)", async () => {
    const refs: AiSourceReference[] = [{ type: "webSearch", query: "三角関数 増減表" }];
    const proposal = await createPendingWithRefs(refs);

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.sourceReferences).toEqual(refs);
  });

  describe("appendSourceReferencesForRun", () => {
    async function createPendingForRun(runId: string) {
      return store.createProposal({
        fileId: "file_1",
        baseRevision: 1,
        baseDocument: sampleDocument,
        summary: "本文を追加しました。",
        plan: ["本文を追加しました。"],
        provider: null,
        runId,
        source: { toolName: "draft_insert_body_content", toolArgs: {} },
        draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
        nextDocument: sampleDocument,
      });
    }

    it("appends to every proposal produced by the same run", async () => {
      const first = await createPendingForRun("run_a");
      const second = await createPendingForRun("run_a");

      const updated = await store.appendSourceReferencesForRun("run_a", [{ type: "webSearch", query: "増減表" }]);

      expect(updated).toBe(2);
      expect((await store.loadProposal(first.proposalId))?.sourceReferences)
        .toEqual([{ type: "webSearch", query: "増減表" }]);
      expect((await store.loadProposal(second.proposalId))?.sourceReferences)
        .toEqual([{ type: "webSearch", query: "増減表" }]);
    });

    it("leaves proposals from other runs untouched", async () => {
      const mine = await createPendingForRun("run_a");
      const theirs = await createPendingForRun("run_b");

      await store.appendSourceReferencesForRun("run_a", [{ type: "webSearch", query: "増減表" }]);

      expect((await store.loadProposal(mine.proposalId))?.sourceReferences).toHaveLength(1);
      expect((await store.loadProposal(theirs.proposalId))?.sourceReferences).toBeUndefined();
    });

    it("does not duplicate a reference that is already recorded", async () => {
      const proposal = await createPendingForRun("run_a");
      await store.appendSourceReferencesForRun("run_a", [{ type: "webSearch", query: "増減表" }]);

      const secondPass = await store.appendSourceReferencesForRun("run_a", [{ type: "webSearch", query: "増減表" }]);

      expect(secondPass).toBe(0);
      expect((await store.loadProposal(proposal.proposalId))?.sourceReferences).toHaveLength(1);
    });

    it("caps the stored references so a search-heavy run cannot grow the record without bound", async () => {
      const proposal = await createPendingForRun("run_a");
      const many: AiSourceReference[] = Array.from({ length: 25 }, (_, index) => ({
        type: "webSearch",
        query: `検索${index}`,
      }));

      await store.appendSourceReferencesForRun("run_a", many);

      expect((await store.loadProposal(proposal.proposalId))?.sourceReferences).toHaveLength(10);
    });

    it("still appends after the proposal was approved so chips survive apply", async () => {
      const proposal = await createPendingForRun("run_a");
      await store.resolveProposal(proposal.proposalId, "approved");

      await store.appendSourceReferencesForRun("run_a", [{ type: "webSearch", query: "増減表" }]);

      const reloaded = await store.loadProposal(proposal.proposalId);
      expect(reloaded?.status).toBe("approved");
      expect(reloaded?.sourceReferences).toEqual([{ type: "webSearch", query: "増減表" }]);
    });
  });

  it("tolerates legacy proposal records with no sourceReferences key at all", async () => {
    const proposal = await createPendingWithRefs(sourceReferences);
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete raw.sourceReferences;
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.sourceReferences).toBeUndefined();

    const [summary] = await store.listProposals();
    expect(summary.sourceReferences).toBeUndefined();
  });

  it("drops only the malformed entries (without failing the parse) and keeps the valid ones", async () => {
    const proposal = await createPendingWithRefs(sourceReferences);
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    raw.sourceReferences = [{ type: "document" /* missing fileId */ }, { type: "web", url: "https://example.com" }];
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.sourceReferences).toEqual([{ type: "web", url: "https://example.com" }]);
  });

  it("drops the sourceReferences field entirely when every entry is malformed", async () => {
    const proposal = await createPendingWithRefs(sourceReferences);
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    raw.sourceReferences = [{ type: "document" /* missing fileId */ }, { type: "unknown-kind" }];
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded).not.toBeNull();
    expect(reloaded?.sourceReferences).toBeUndefined();
  });
});

describe("LocalMcpEditProposalStore touchedBlocks (createProposal)", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-touched-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("records the real baseHash for a replace target that exists in baseDocument", async () => {
    const draft = replaceParagraphDraft(P_YOTTE_ID, "新しい本文");
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: parseSigmaDocument(withParagraphText(sampleDocument, P_YOTTE_ID, "新しい本文")),
    });

    // createProposal は baseDocument を parseSigmaDocument で正規化してからハッシュ化するため、
    // 期待値も同じ正規化を通してから比較する (生のsampleDocumentのJSONと直接比較するとキーの
    // 正規化差分でハッシュが一致しない)。
    const expectedHash = computeDocumentBlockHashes(parseSigmaDocument(sampleDocument))[P_YOTTE_ID];
    expect(proposal.touchedBlocks).toEqual([{ id: P_YOTTE_ID, baseHash: expectedHash }]);

    const [summary] = await store.listProposals();
    expect(summary.touchedBlocks).toEqual([{ id: P_YOTTE_ID, baseHash: expectedHash }]);
  });

  it("records baseHash: null for a newly inserted block while keeping the anchor's real hash", async () => {
    const insertedBlock: ParagraphNode = { type: "paragraph", id: "p_new_inserted", children: [{ type: "text", text: "追加" }] };
    const draft: AiEditSessionDraft = {
      summary: "段落を追加しました。",
      plan: ["段落を追加しました。"],
      operations: [{ operation: "insertAfter", summary: "段落を追加しました。", targetId: P_YOTTE_ID, insertedBlock }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft,
      nextDocument: sampleDocument,
    });

    // createProposal は baseDocument を parseSigmaDocument で正規化してからハッシュ化するため、
    // 期待値も同じ正規化を通してから比較する (生のsampleDocumentのJSONと直接比較するとキーの
    // 正規化差分でハッシュが一致しない)。
    const expectedHash = computeDocumentBlockHashes(parseSigmaDocument(sampleDocument))[P_YOTTE_ID];
    expect(proposal.touchedBlocks).toEqual([
      { id: P_YOTTE_ID, baseHash: expectedHash },
      { id: "p_new_inserted", baseHash: null },
    ]);
  });

  it("omits touchedBlocks entirely when the draft touches no identifiable ids", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "本文を追加しました。", plan: ["本文を追加しました。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    expect(proposal.touchedBlocks).toBeUndefined();
  });
});

describe("LocalMcpEditProposalStore#autoRebaseProposalsForFile", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-autorebase-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createTouchingProposal() {
    const draft = replaceParagraphDraft(P_YOTTE_ID, "AIによる新しい本文");
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: parseSigmaDocument(withParagraphText(sampleDocument, P_YOTTE_ID, "AIによる新しい本文")),
    });
  }

  it("auto-rebases a stale pending proposal onto the current document when its touched blocks are unchanged", async () => {
    const proposal = await createTouchingProposal();
    // 人間が無関係なブロック(p_source_note)だけを編集した状態を再現する。
    const currentDocument = withParagraphText(sampleDocument, P_SOURCE_NOTE_ID, "人間が書き換えた注記");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.rebased).toEqual([proposal.proposalId]);
    expect(result.conflicted).toEqual([]);

    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(2);
    expect(reloaded?.rebasedFrom).toBe(1);
    expect(reloaded?.conflict).toBeUndefined();
    // touchedBlocksのbaseHashは新しいbase(currentDocument)に対して取り直されている。
    const currentHashes = computeDocumentBlockHashes(currentDocument);
    expect(reloaded?.touchedBlocks).toEqual([{ id: P_YOTTE_ID, baseHash: currentHashes[P_YOTTE_ID] }]);
  });

  it("autoRebaseProposalsForFile: human edit disjoint from proposal sensitive blocks → not conflicted", async () => {
    const baseDocument = paragraphDocument(["blockA", "blockB", "blockC"]);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    const blockHashDir = path.join(userDataDir, "data", "doc-block-hashes");
    await fs.mkdir(blockHashDir, { recursive: true });
    // 実際の書き手 (`LocalSigmaDocStore`) と同じ関数で用意する。手書きの固定文字列に
    // すると、保存側が形式を変えたときにこのテストだけ古い前提のまま緑になり、
    // 「履歴が読めず毎回 blind replay」という退行を通してしまう。
    await appendBlockHashRevision(blockHashDir, "file_1", 1, previousHashes, new Map());
    const draft: AiEditSessionDraft = {
      summary: "blockAとblockBを書き換えました。",
      plan: ["blockAとblockBを書き換えました。"],
      operations: [
        {
          operation: "replace",
          summary: "blockAを書き換えました。",
          targetId: "blockA",
          replacementBlock: {
            type: "paragraph",
            id: "blockA",
            children: [{ type: "text", text: "AI A" }],
          },
        },
        {
          operation: "replace",
          summary: "blockBを書き換えました。",
          targetId: "blockB",
          replacementBlock: {
            type: "paragraph",
            id: "blockB",
            children: [{ type: "text", text: "AI B" }],
          },
        },
      ],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument = withParagraphText(baseDocument, "blockC", "human C");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result).toEqual({ rebased: [proposal.proposalId], conflicted: [] });
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded).toMatchObject({ status: "pending", baseRevision: 2 });
    expect(reloaded?.conflict).toBeUndefined();
    expect(findProposalFreshnessConflictIds(
      reloaded!,
      computeDocumentBlockHashes(currentDocument),
      2,
    )).toEqual([]);
    expect(() => replayProposalDraft(currentDocument, reloaded!.draft)).not.toThrow();
    // Disjoint saveではblind replayせず、保存済みpreview文書はそのままにする。
    expect((reloaded?.nextDocument.content[2] as ParagraphNode).children).toEqual([
      { type: "text", text: "blockC" },
    ]);
  });

  it("blocks auto-rebase when a newly occupied asset ID would overwrite the proposal asset", async () => {
    const baseDocument = ensurePageLayout(sampleDocument);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const proposedAsset = {
      id: "asset_shared",
      type: "image" as const,
      props: {
        w: 120,
        h: 80,
        name: "proposed.png",
        isAnimated: false as const,
        mimeType: "image/png",
        src: "sigma-doc-storage://proposed",
        fileSize: 8,
      },
    };
    const draft: AiEditSessionDraft = {
      summary: "画像を挿入しました。",
      plan: ["画像を挿入しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像を挿入しました。",
        targetId: SOLE_BLOCK_ID,
        overlayShape: {
          id: "shape_proposed",
          type: "image",
          x: 10,
          y: 10,
          props: { assetId: proposedAsset.id, w: 120, h: 80 },
        },
        assets: { [proposedAsset.id]: proposedAsset },
      }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_attach_image_asset", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument: SigmaDocument = {
      ...baseDocument,
      pageLayout: {
        ...baseDocument.pageLayout!,
        overlay: {
          ...baseDocument.pageLayout?.overlay,
          overlaySnapshot: {
            version: 1,
            shapes: [],
            assets: {
              asset_shared: {
                ...proposedAsset,
                props: { ...proposedAsset.props, src: "sigma-doc-storage://human" },
              },
            },
          },
        },
      },
    };

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result).toEqual({ rebased: [], conflicted: [proposal.proposalId] });
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toEqual({
      blockIds: ["asset_shared"],
      detectedAtRevision: 2,
      reason: "asset-collision",
    });
  });

  it("autoRebaseProposalsForFile: baseRevisionが直前revisionより古いときは早道に乗せない", async () => {
    // changedBlockIds は「直前revision→現在」の差分しか表さない。AI run開始後・提案の
    // 書き込み前に人手保存が挟まると baseRevision がそれより古くなり、その間の変更は
    // 差分に現れない。早道 (無変更とみなして baseRevision だけ進める) に乗せると
    // conflictの提示が承認時まで遅れるため、従来のreplay判定へ倒す。
    const baseDocument = paragraphDocument(["blockA", "blockB", "blockC"]);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const draft = replaceParagraphDraft("blockA", "AI A");
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    // blockA (競合対象) には触らず、blockC だけを変えた現在ドキュメント。
    const currentDocument = withParagraphText(baseDocument, "blockC", "human C");

    // baseRevision=1 に対して currentRevision=5 なので、差分窓 (4→5) は
    // rev1〜4 の変更を含まない。
    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 5);

    expect(result).toEqual({ rebased: [proposal.proposalId], conflicted: [] });
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded).toMatchObject({ status: "pending", baseRevision: 5 });
    // 早道ではなく replay を通ったので、preview文書は現在ドキュメントから作り直されて
    // 人手のblockC変更を含む (早道なら旧preview "blockC" のまま)。
    expect((reloaded?.nextDocument.content[2] as ParagraphNode).children).toEqual([
      { type: "text", text: "human C" },
    ]);
  });

  it("autoRebaseProposalsForFile: human edit overlaps proposal sensitive blocks → conflicted", async () => {
    const baseDocument = paragraphDocument(["blockA", "blockB"]);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const draft = replaceParagraphDraft("blockA", "AI A");
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument = withParagraphText(baseDocument, "blockA", "human A");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result).toEqual({ rebased: [], conflicted: [proposal.proposalId] });
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toEqual({
      blockIds: ["blockA"],
      detectedAtRevision: 2,
      reason: "content-stale",
    });
  });

  it("autoRebaseProposalsForFile: human deletes an insert-anchor block → conflicted", async () => {
    const baseDocument = paragraphDocument(["blockA", "blockX", "blockC"]);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const draft: AiEditSessionDraft = {
      summary: "blockXの後へ追記しました。",
      plan: ["blockXの後へ追記しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "追記しました。",
        targetId: "blockX",
        insertedBlock: {
          type: "paragraph",
          id: "blockInserted",
          children: [{ type: "text", text: "AI insert" }],
        },
      }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument = parseSigmaDocument(deleteBlocksFromDocument(baseDocument, ["blockX"]));

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result).toEqual({ rebased: [], conflicted: [proposal.proposalId] });
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toEqual({
      blockIds: ["blockX"],
      detectedAtRevision: 2,
      reason: "anchor-missing",
    });
  });

  it("autoRebaseProposalsForFile: an occupied inserted ID is recorded as replay-failed", async () => {
    const baseDocument = paragraphDocument(["block_anchor"]);
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const draft: AiEditSessionDraft = {
      summary: "本文を追記しました。",
      plan: ["本文を追記しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "本文を追記しました。",
        targetId: "block_anchor",
        insertedBlock: {
          type: "paragraph",
          id: "block_inserted",
          children: [{ type: "text", text: "AI insert" }],
        },
      }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument = paragraphDocument(["block_anchor", "block_inserted"]);

    expect(await store.autoRebaseProposalsForFile("file_1", currentDocument, 2)).toEqual({
      rebased: [],
      conflicted: [proposal.proposalId],
    });
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toEqual({
      blockIds: ["block_inserted"],
      detectedAtRevision: 2,
      reason: "replay-failed",
    });
  });

  it("autoRebaseProposalsForFile: deleting an external shape anchor marks the child insertion conflicted", async () => {
    const body = ensurePageLayout(paragraphDocument(["block_anchor"]));
    const parentShape = {
      id: "shape_parent",
      type: "geo" as const,
      x: 10,
      y: 10,
      props: {
        w: 100,
        h: 60,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "black",
        labelColor: "black",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
    const baseDocument: SigmaDocument = {
      ...body,
      pageLayout: {
        ...body.pageLayout!,
        overlay: { overlaySnapshot: { version: 1, shapes: [parentShape], assets: {} } },
      },
    };
    const previousHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    store = new LocalMcpEditProposalStore(userDataDir, {
      readDocumentBlockHashes: async () => previousHashes,
    });
    const draft: AiEditSessionDraft = {
      summary: "親図形にラベルを追加しました。",
      plan: ["親図形にラベルを追加しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "ラベルを追加しました。",
        targetId: "block_anchor",
        overlayShape: {
          id: "shape_child",
          type: "geo",
          x: 30,
          y: 20,
          anchor: { type: "shape", shapeId: parentShape.id, dx: 20, dy: 10 },
          props: {
            w: 80,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_insert_shape", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument: SigmaDocument = {
      ...baseDocument,
      pageLayout: {
        ...baseDocument.pageLayout!,
        overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
      },
    };

    expect(await store.autoRebaseProposalsForFile("file_1", currentDocument, 2)).toEqual({
      rebased: [],
      conflicted: [proposal.proposalId],
    });
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toEqual({
      blockIds: [parentShape.id],
      detectedAtRevision: 2,
      reason: "anchor-missing",
    });
  });

  it("autoRebaseProposalsForFile: missing previous-revision hashes → falls back to replay", async () => {
    const readDocumentBlockHashes = vi.fn(async () => undefined);
    store = new LocalMcpEditProposalStore(userDataDir, { readDocumentBlockHashes });
    const baseDocument = paragraphDocument(["blockA", "blockB", "blockC"]);
    const draft = replaceParagraphDraft("blockA", "AI A");
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: replayProposalDraft(baseDocument, draft).nextDocument,
    });
    const currentDocument = withParagraphText(baseDocument, "blockC", "human C");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(readDocumentBlockHashes).toHaveBeenCalledWith("file_1", 1);
    expect(result).toEqual({ rebased: [proposal.proposalId], conflicted: [] });
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect((reloaded?.nextDocument.content[2] as ParagraphNode).children).toEqual([
      { type: "text", text: "human C" },
    ]);
  });

  it("rebases a partial-column proposal from its current anchors despite edits inside and outside the range", async () => {
    const baseDocument = paragraphDocument(["outside_before", "range_start", "range_end", "outside_after"]);
    const draft = wrapBlocksInColumnsDraft(["range_start", "range_end"]);
    const baseHashes = computeDocumentBlockHashes(parseSigmaDocument(baseDocument));
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument,
      summary: draft.summary,
      plan: [],
      provider: null,
      source: { toolName: "update_column_layout", toolArgs: { scope: "blocks" } },
      draft,
      nextDocument: baseDocument,
      requestSelection: {
        blockIds: ["range_start"],
        hashes: { range_start: baseHashes.range_start! },
        capturedRevision: 1,
      },
    });
    const currentDocument = paragraphDocument([
      "outside_before",
      "range_start",
      "inserted_after_proposal",
      "range_end",
      "outside_after",
    ]);
    currentDocument.content[1] = {
      type: "paragraph",
      id: "range_start",
      children: [{ type: "text", text: "人間が変更した現在の文章" }],
    };
    currentDocument.content[4] = {
      type: "paragraph",
      id: "outside_after",
      children: [{ type: "text", text: "範囲外の変更" }],
    };

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result).toEqual({ rebased: [proposal.proposalId], conflicted: [] });
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(2);
    expect(reloaded?.conflict).toBeUndefined();
    expect(reloaded?.draft.mutationOperations?.[0]).toMatchObject({
      operation: "wrapBlocksInColumns",
      blockIds: ["range_start", "inserted_after_proposal", "range_end"],
    });
    expect(reloaded?.nextDocument.content[1]).toMatchObject({
      type: "layoutSection",
      children: [
        { id: "range_start", children: [{ text: "人間が変更した現在の文章" }] },
        { id: "inserted_after_proposal" },
        { id: "range_end" },
      ],
    });
    expect(reloaded?.nextDocument.content[2]).toMatchObject({
      id: "outside_after",
      children: [{ text: "範囲外の変更" }],
    });
  });

  it("flags a conflict instead of rebasing when a touched block was itself edited by a human", async () => {
    const proposal = await createTouchingProposal();
    // 人間が提案の対象ブロック(p_yotte)そのものを編集した状態を再現する。
    const currentDocument = withParagraphText(sampleDocument, P_YOTTE_ID, "人間が書き換えた本文");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.rebased).toEqual([]);
    expect(result.conflicted).toEqual([proposal.proposalId]);

    const reloaded = await store.loadProposal(proposal.proposalId);
    // conflict時はbaseRevisionを進めない (黙って古い内容をreplayしないため)。
    expect(reloaded?.baseRevision).toBe(1);
    expect(reloaded?.status).toBe("pending");
    expect(reloaded?.conflict).toEqual({
      blockIds: [P_YOTTE_ID],
      detectedAtRevision: 2,
      reason: "content-stale",
    });
  });

  it("clears a previously detected conflict once the touched block matches again on a later rebase attempt", async () => {
    const proposal = await createTouchingProposal();
    const conflictingDocument = withParagraphText(sampleDocument, P_YOTTE_ID, "人間が書き換えた本文");
    await store.autoRebaseProposalsForFile("file_1", conflictingDocument, 2);
    expect((await store.loadProposal(proposal.proposalId))?.conflict).toBeDefined();

    // 人間が p_yotte を元の内容に戻した(以後は変更なし)状態を再現する。
    const revertedDocument = sampleDocument;
    const result = await store.autoRebaseProposalsForFile("file_1", revertedDocument, 3);

    expect(result.rebased).toEqual([proposal.proposalId]);
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(3);
    expect(reloaded?.conflict).toBeUndefined();
  });

  it("leaves a legacy proposal without touchedBlocks untouched (falls back to manual rebase)", async () => {
    const proposal = await createTouchingProposal();
    const filePath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    const raw = JSON.parse(await fs.readFile(filePath, "utf8")) as Record<string, unknown>;
    delete raw.touchedBlocks;
    await fs.writeFile(filePath, JSON.stringify(raw, null, 2), "utf8");

    const currentDocument = withParagraphText(sampleDocument, P_SOURCE_NOTE_ID, "無関係な変更");
    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.rebased).toEqual([]);
    expect(result.conflicted).toEqual([]);
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.baseRevision).toBe(1);
  });

  async function createSelectionProposal(selectedBlockId: string) {
    const draft = replaceParagraphDraft(P_YOTTE_ID, "AIによる新しい本文");
    const hashes = computeDocumentBlockHashes(parseSigmaDocument(sampleDocument));
    return store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: parseSigmaDocument(withParagraphText(sampleDocument, P_YOTTE_ID, "AIによる新しい本文")),
      requestSelection: {
        blockIds: [selectedBlockId],
        hashes: { [selectedBlockId]: hashes[selectedBlockId]! },
        capturedRevision: 1,
      },
    });
  }

  it("flags a conflict when the actual overwrite target changed, even if the request selection did not", async () => {
    const proposal = await createSelectionProposal(P_SOURCE_NOTE_ID);
    const currentDocument = withParagraphText(sampleDocument, P_YOTTE_ID, "人間が書き換えた本文");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.rebased).toEqual([]);
    expect(result.conflicted).toEqual([proposal.proposalId]);
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.conflict).toEqual({
      blockIds: [P_YOTTE_ID],
      detectedAtRevision: 2,
      reason: "content-stale",
    });
  });

  it("flags a conflict when the requested selection itself changed", async () => {
    const proposal = await createSelectionProposal(P_YOTTE_ID);
    const currentDocument = withParagraphText(sampleDocument, P_YOTTE_ID, "人間が書き換えた本文");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.rebased).toEqual([]);
    expect(result.conflicted).toEqual([proposal.proposalId]);
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(reloaded?.status).toBe("pending");
    expect(reloaded?.conflict).toEqual({
      blockIds: [P_YOTTE_ID],
      detectedAtRevision: 2,
      reason: "content-stale",
    });
  });

  it("rebases an unselected (empty selection) proposal regardless of what changed elsewhere", async () => {
    const draft = replaceParagraphDraft(P_YOTTE_ID, "AIによる新しい本文");
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_update_rich_content", toolArgs: {} },
      draft,
      nextDocument: parseSigmaDocument(withParagraphText(sampleDocument, P_YOTTE_ID, "AIによる新しい本文")),
      requestSelection: { blockIds: [], hashes: {}, capturedRevision: 1 },
    });
    const currentDocument = withParagraphText(sampleDocument, P_SOURCE_NOTE_ID, "人間が書き換えた注記");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.conflicted).toEqual([]);
    expect(result.rebased).toEqual([proposal.proposalId]);
  });

  it("rebases an insertion when the selected source and insertion anchor text changed", async () => {
    const draft: AiEditSessionDraft = {
      summary: "補足を追加しました。",
      plan: ["補足を追加しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "補足を追加しました。",
        targetId: P_YOTTE_ID,
        insertedBlock: { type: "paragraph", id: "p_ai_note", children: [{ type: "text", text: "AIの補足" }] },
      }],
      warnings: [],
    };
    const hashes = computeDocumentBlockHashes(sampleDocument);
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: draft.summary,
      plan: draft.plan,
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft,
      nextDocument: createAiEditSessionDocumentDraft(sampleDocument, null, draft).nextDocument,
      requestSelection: {
        blockIds: [P_YOTTE_ID],
        hashes: { [P_YOTTE_ID]: hashes[P_YOTTE_ID]! },
        capturedRevision: 1,
      },
    });
    const currentDocument = withParagraphText(sampleDocument, P_YOTTE_ID, "人間が整えた本文");

    const result = await store.autoRebaseProposalsForFile("file_1", currentDocument, 2);

    expect(result.conflicted).toEqual([]);
    expect(result.rebased).toEqual([proposal.proposalId]);
    const reloaded = await store.loadProposal(proposal.proposalId);
    expect(computeDocumentBlockHashes(reloaded!.nextDocument).p_ai_note).toBeTypeOf("string");
  });

  it("ignores proposals for other files and proposals that are not stale", async () => {
    const stale = await createTouchingProposal();
    const other = await store.createProposal({
      fileId: "file_other",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "他の教材の提案。",
      plan: ["他の教材の提案。"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "他の教材の提案。", plan: ["他の教材の提案。"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    const result = await store.autoRebaseProposalsForFile("file_1", sampleDocument, 1);
    expect(result.rebased).toEqual([]);
    expect(result.conflicted).toEqual([]);
    expect((await store.loadProposal(other.proposalId))?.baseRevision).toBe(1);
    expect((await store.loadProposal(stale.proposalId))?.baseRevision).toBe(1);
  });
});

// (a) I/O budget regression guard
describe("LocalMcpEditProposalStore I/O budget (regression guard)", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-io-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createStoredProposal(
    fileId: string,
    summary: string,
    extra: Partial<Parameters<LocalMcpEditProposalStore["createProposal"]>[0]> = {},
  ) {
    return store.createProposal({
      fileId,
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary,
      plan: [summary],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary, plan: [summary], operations: [], warnings: [] },
      nextDocument: sampleDocument,
      ...extra,
    });
  }

  it("avoids re-reading metadata after warmIndex", async () => {
    // 約40個の提案を3つのfileIdにまたがって作成し、複数のstatusを混在させる。
    const proposalCounts = { file_a: 15, file_b: 13, file_c: 12 };

    for (const [fileId, count] of Object.entries(proposalCounts)) {
      for (let i = 0; i < count; i++) {
        const proposal = await createStoredProposal(fileId, `proposal_${fileId}_${i}`);
        // 一部を承認状態にして複数のstatusを混在させる
        if (i % 5 === 0) {
          await store.resolveProposal(proposal.proposalId, "approved", "承認しました。", {
            appliedRevision: 1,
          });
        }
      }
    }
    // Case 4 で findCurrentPendingProposal が実際に1件引き当てるよう、帰属付きの
    // pending を1つ足す。帰属が無いと roomId/runId 判定の手前で null になり、
    // 「index経由で候補を絞って1件だけディスクから読み直す」経路を通らない。
    const attributed = await createStoredProposal("file_a", "帰属付き", {
      roomId: "room_io",
      runId: "run_io",
    });

    // warmIndexでmeta indexを事前読み込み
    await store.warmIndex();

    // ここからがI/O予算測定の対象
    store.__resetIndexStatsForTests();

    // Case 1: listProposals({ status: "pending", fileId })
    {
      const proposals = await store.listProposals({ status: "pending", fileId: "file_a" });
      const stats = store.__getIndexStatsForTests();
      expect(proposals.length).toBeGreaterThan(0);
      expect(stats.metaReads).toBe(0);
      expect(stats.fullLoads).toBe(0);
      expect(stats.sweeps).toBe(1);
    }

    store.__resetIndexStatsForTests();

    // Case 2: 人手保存ごとに走る autoRebaseProposalsForFile。ここのpendingは
    // touchedBlocks も requestSelection も持たないため rebase 対象にならず、
    // 判定材料の読み込みだけで終わる = 文書を1本もパースしない。
    {
      const result = await store.autoRebaseProposalsForFile("file_b", sampleDocument, 2);
      const stats = store.__getIndexStatsForTests();
      expect(result).toEqual({ rebased: [], conflicted: [] });
      expect(stats.metaReads).toBe(0);
      expect(stats.fullLoads).toBe(0);
      expect(stats.sweeps).toBe(1);
    }

    store.__resetIndexStatsForTests();

    // Case 3: countPendingProposalsForFile
    {
      const count = await store.countPendingProposalsForFile("file_c");
      const stats = store.__getIndexStatsForTests();
      expect(count).toBeGreaterThan(0);
      expect(stats.metaReads).toBe(0);
      expect(stats.fullLoads).toBe(0);
      expect(stats.sweeps).toBe(1);
    }

    store.__resetIndexStatsForTests();

    // Case 4: findCurrentPendingProposal。indexで候補を絞ったうえで、権威ある
    // ファイルを1件だけ読み直してstatusを再確認する (別プロセスが直前に解決した
    // 古いpendingを返さないため)。437件を走査していた頃との差はここに出る。
    {
      const proposal = await store.findCurrentPendingProposal({
        fileId: "file_a",
        roomId: "room_io",
      });
      const stats = store.__getIndexStatsForTests();
      expect(proposal?.proposalId).toBe(attributed.proposalId);
      expect(stats.metaReads).toBe(0);
      expect(stats.fullLoads).toBe(1);
      expect(stats.sweeps).toBe(1);
    }
  });
});

// (b) Listings never parse documents
describe("LocalMcpEditProposalStore document parsing budget", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-parse-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function createStoredProposal(fileId: string, summary: string) {
    return store.createProposal({
      fileId,
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary,
      plan: [summary],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary, plan: [summary], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
  }

  it("never calls parseSigmaDocument during listProposals", async () => {
    const proposal = await createStoredProposal("file_1", "test");

    // fullLoads = 埋め込みSigmaDocumentをzod検証した回数。listing で 0 であることが
    // 「statusを見るために文書全文を読んでいない」の直接の証拠になる。
    store.__resetIndexStatsForTests();
    const summaries = await store.listProposals({ status: "pending" });

    const stats = store.__getIndexStatsForTests();
    expect(summaries).toHaveLength(1);
    expect(summaries[0].proposalId).toBe(proposal.proposalId);
    expect(stats.fullLoads).toBe(0);
  });

  it("calls parseSigmaDocument once during loadProposal", async () => {
    const proposal = await createStoredProposal("file_1", "test");

    store.__resetIndexStatsForTests();
    const loaded = await store.loadProposal(proposal.proposalId);

    const stats = store.__getIndexStatsForTests();
    expect(loaded?.nextDocument).toBeDefined();
    expect(stats.fullLoads).toBe(1);
  });
});

// (c) Cross-instance correctness
describe("LocalMcpEditProposalStore cross-instance consistency", () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-cross-"));
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("instance B's changes are visible to instance A on next listing, without TTL trust window", async () => {
    // インスタンスAとB: 両方ともwatch()を呼ばない、任意のタイミング
    const storeA = new LocalMcpEditProposalStore(userDataDir);
    const storeB = new LocalMcpEditProposalStore(userDataDir);

    // A: index warmup
    await storeA.warmIndex();
    let aProposals = await storeA.listProposals({ status: "pending" });
    expect(aProposals).toHaveLength(0);

    // B: create proposal。withdrawCurrentProposal / findCurrentPendingProposal は
    // roomId か runId が無いと必ず null を返すため、帰属を付けて作る。
    const bProposal = await storeB.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "B作成",
      plan: ["B作成"],
      provider: null,
      roomId: "room_cross",
      runId: "run_cross",
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "B作成", plan: ["B作成"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    // A: すぐに再度listProposalsを呼ぶ（A→B→A で、1秒の黙示的TTLは存在しない）
    aProposals = await storeA.listProposals({ status: "pending" });
    expect(aProposals).toHaveLength(1);
    expect(aProposals[0].proposalId).toBe(bProposal.proposalId);

    // A: 別インスタンスが作った直後のpendingを、権威あるファイルから引き当てられる。
    expect(
      (await storeA.findCurrentPendingProposal({ fileId: "file_1", roomId: "room_cross" }))?.proposalId,
    ).toBe(bProposal.proposalId);

    // B: withdraw/reject proposal
    const withdrawn = await storeB.withdrawCurrentProposal({
      fileId: "file_1",
      roomId: "room_cross",
      reason: "テスト取り下げ",
    });
    expect(withdrawn?.status).toBe("rejected");

    // A: listProposalsは空になるべき
    aProposals = await storeA.listProposals({ status: "pending" });
    expect(aProposals).toHaveLength(0);

    // A: findCurrentPendingProposalもnullを返す。indexに残っていた候補を返すのではなく、
    // 権威あるファイルを読み直してstatusを再確認するため。
    const aPending = await storeA.findCurrentPendingProposal({ fileId: "file_1", roomId: "room_cross" });
    expect(aPending).toBeNull();

    // B: create and approve new proposal
    const bProposal2 = await storeB.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "B作成2",
      plan: ["B作成2"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "B作成2", plan: ["B作成2"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    await storeB.resolveProposal(bProposal2.proposalId, "approved", "承認", {
      appliedRevision: 2,
    });

    // A: 承認済み提案をlistProposals({ status: "pending" })で返さない
    aProposals = await storeA.listProposals({ status: "pending" });
    expect(aProposals).toHaveLength(0);
  });
});

// (d) Atomic writes
describe("LocalMcpEditProposalStore atomic writes", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-atomic-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("leaves no .tmp files after normal writes", async () => {
    await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "test",
      plan: ["test"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "test", plan: ["test"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    const proposalsDir = store.getProposalsDir();
    const entries = await fs.readdir(proposalsDir);
    const tmpFiles = entries.filter((name) => name.endsWith(".tmp"));
    expect(tmpFiles).toHaveLength(0);
  });

  it("ignores stray .tmp files in listings", async () => {
    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "first",
      plan: ["first"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "first", plan: ["first"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    // 意図的にstrayed .tmpファイルを配置
    const proposalsDir = store.getProposalsDir();
    const strayTmp = path.join(proposalsDir, "some_random.tmp");
    await fs.writeFile(strayTmp, "garbage", "utf8");

    // listingはproposal.proposal.jsonファイルのみを数え、.tmpは無視する
    const proposals = await store.listProposals({ status: "pending" });
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposalId).toBe(proposal.proposalId);
  });

  it("never yields a torn record while 20 concurrent writes race listProposals", async () => {
    // 非原子的な writeFile だと、書き込み途中のファイルを読んだ listing が
    // JSON.parse に失敗してそのレコードを黙って落とす (実データに破損2件が
    // 残っていた原因)。tmp+rename なら読み手は常に旧版か新版のどちらかを見る。
    // private メソッドを叩かず、公開APIの書き込み経路だけで再現する。
    const WRITES = 20;
    const writes = Array.from({ length: WRITES }).map((_, i) => store.createProposal({
      fileId: `file_${i % 3}`,
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: `concurrent_${i}`,
      plan: [`concurrent_${i}`],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: `concurrent_${i}`, plan: [`concurrent_${i}`], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    }));
    const listings = Array.from({ length: 5 }).map(() => store.listProposals({ status: "pending" }));

    const [created, listed] = await Promise.all([
      Promise.all(writes),
      Promise.all(listings),
    ]);

    // 書き込みと並走した listing は、部分的な集合を返すのは許されるが
    // 壊れたレコードを返してはならない。
    for (const proposals of listed) {
      for (const proposal of proposals) {
        expect(proposal.proposalId).toBeTruthy();
        expect(proposal.status).toBe("pending");
      }
    }

    // 収束後は全件そろっており、tmpの残骸も無い。
    const settled = await store.listProposals({ status: "pending" });
    expect(settled).toHaveLength(WRITES);
    expect(new Set(settled.map((proposal) => proposal.proposalId)))
      .toEqual(new Set(created.map((proposal) => proposal.proposalId)));
    expect((await fs.readdir(store.getProposalsDir())).filter((name) => name.endsWith(".tmp")))
      .toHaveLength(0);
  });
});

// (e) Corrupt file quarantine
describe("LocalMcpEditProposalStore corrupt file quarantine", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-corrupt-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("quarantines corrupt proposal files and continues listing valid ones", async () => {
    // 有効な提案を2個作成
    const valid1 = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "valid_1",
      plan: ["valid_1"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "valid_1", plan: ["valid_1"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    const valid2 = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "valid_2",
      plan: ["valid_2"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "valid_2", plan: ["valid_2"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });

    // 不正なJSON proposalファイルを手動で作成
    const proposalsDir = store.getProposalsDir();
    const corruptPath = path.join(proposalsDir, "corrupt_proposal.proposal.json");
    await fs.writeFile(corruptPath, "{ invalid json }", "utf8");

    // console.warnをmockして期待されたwarningをキャプチャ
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      // listProposalsを呼ぶと、corruptファイルは隔離され、有効な提案のみが返る
      const proposals = await store.listProposals({ status: "pending" });

      expect(proposals).toHaveLength(2);
      expect(proposals.some((p) => p.proposalId === valid1.proposalId)).toBe(true);
      expect(proposals.some((p) => p.proposalId === valid2.proposalId)).toBe(true);

      // console.warnが呼ばれたはず (quarantineメッセージ)
      expect(warnSpy).toHaveBeenCalled();
      const warnCalls = warnSpy.mock.calls.map((call) => call[0]?.toString() || "");
      expect(warnCalls.some((msg) => msg.includes("Corrupt proposal file"))).toBe(true);

      // corruptファイルがproposals/corrupt/に移動されているはず
      const corruptDir = path.join(proposalsDir, "corrupt");
      let corruptFiles: string[] = [];
      try {
        corruptFiles = await fs.readdir(corruptDir);
      } catch {
        // corruptディレクトリが存在しないことは許す
      }
      expect(corruptFiles.some((f) => f.includes("corrupt_proposal.proposal.json"))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("checks proposal file size before readFile and quarantines an oversized record", async () => {
    const proposal = await store.createProposal({
      fileId: "file_oversized",
      baseRevision: 1,
      baseDocument: sampleDocument,
      summary: "oversized",
      plan: ["oversized"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "oversized", plan: ["oversized"], operations: [], warnings: [] },
      nextDocument: sampleDocument,
    });
    const recordPath = path.join(store.getProposalsDir(), `${encodeURIComponent(proposal.proposalId)}.proposal.json`);
    await fs.truncate(recordPath, MAX_MCP_PROPOSAL_FILE_BYTES + 1);
    const readFileSpy = vi.spyOn(fs, "readFile");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const reloaded = new LocalMcpEditProposalStore(userDataDir);
      expect(await reloaded.listProposals({ status: "pending" })).toEqual([]);
      expect(readFileSpy.mock.calls.some(([file]) => file === recordPath)).toBe(false);
      expect((await fs.readdir(path.join(store.getProposalsDir(), "corrupt")))
        .some((name) => name.includes(proposal.proposalId))).toBe(true);
    } finally {
      readFileSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

// (f) appliedDiff persistence
describe("LocalMcpEditProposalStore appliedDiff persistence", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-diff-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("persists appliedDiff when approving with revertDocument and appliedDocument", async () => {
    const baseDoc = paragraphDocument(["p_1"]);
    const nextDoc = paragraphDocument(["p_1", "p_2"]);

    const proposal = await store.createProposal({
      fileId: "file_1",
      baseRevision: 1,
      baseDocument: baseDoc,
      summary: "段落を追加",
      plan: ["段落を追加"],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: {
        summary: "段落を追加",
        plan: ["段落を追加"],
        operations: [{
          operation: "insertAfter",
          summary: "段落を追加",
          targetId: "p_1",
          insertedBlock: { type: "paragraph", id: "p_2", children: [{ type: "text", text: "新規段落" }] },
        }],
        warnings: [],
      },
      nextDocument: nextDoc,
    });

    // approveし、revertDocument と appliedDocumentを指定
    const resolved = await store.resolveProposal(proposal.proposalId, "approved", "承認", {
      appliedRevision: 2,
      revertDocument: baseDoc,
      appliedDocument: nextDoc,
    });

    expect(resolved.appliedDiff).toBeDefined();
    expect(resolved.appliedDiff?.body).toBeDefined();
    expect(resolved.appliedDiff?.shapes).toBeDefined();

    // ディスクから読み直してappliedDiffが保持されているか確認
    const loaded = await store.loadProposal(proposal.proposalId);
    expect(loaded?.appliedDiff).toEqual(resolved.appliedDiff);
  });

  it("lists proposals with appliedDiff = undefined when legacy record has no appliedDiff field", async () => {
    const baseDoc = paragraphDocument(["p_1"]);

    // 旧形式(appliedDiffなし)のproposalを手動で作成
    const proposalsDir = store.getProposalsDir();
    await fs.mkdir(proposalsDir, { recursive: true });

    const legacyRecord = {
      version: 1,
      proposalId: "legacy_proposal_123",
      fileId: "file_legacy",
      baseRevision: 1,
      baseDocId: "doc_legacy",
      title: "Legacy proposal",
      summary: "旧形式提案",
      plan: ["旧形式提案"],
      warnings: [],
      changedIds: [],
      provider: null,
      source: { toolName: "draft_insert_body_content", toolArgs: {} },
      draft: { summary: "旧形式提案", plan: ["旧形式提案"], operations: [], warnings: [] },
      nextDocument: baseDoc,
      status: "approved",
      createdAt: "2026-07-26T00:00:00Z",
      updatedAt: "2026-07-26T00:00:00Z",
      appliedRevision: 1,
      // 注意: appliedDiffフィールドを意図的に省略(旧形式)
    };

    const recordPath = path.join(proposalsDir, "legacy_proposal_123.proposal.json");
    await fs.writeFile(recordPath, JSON.stringify(legacyRecord, null, 2), "utf8");

    // listで読み直すと、appliedDiff === undefinedのまま
    const proposals = await store.listProposals({ status: "all" });
    const legacy = proposals.find((p) => p.proposalId === "legacy_proposal_123");
    expect(legacy).toBeDefined();
    expect(legacy?.appliedDiff).toBeUndefined();
  });
});

// (g) getRevertPlan batch consistency
describe("LocalMcpEditProposalStore getRevertPlan batch resolution", () => {
  let userDataDir: string;
  let store: LocalMcpEditProposalStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-doc-proposal-store-revert-"));
    store = new LocalMcpEditProposalStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("returns the whole fileId + appliedRevision batch", async () => {
    // 3個の提案を作成し、同じappliedRevisionで承認
    const proposals = await Promise.all(
      Array.from({ length: 3 }).map((_, i) =>
        store.createProposal({
          fileId: "file_1",
          baseRevision: 1,
          baseDocument: sampleDocument,
          summary: `proposal_${i}`,
          plan: [`proposal_${i}`],
          provider: null,
          source: { toolName: "draft_insert_body_content", toolArgs: {} },
          draft: { summary: `proposal_${i}`, plan: [`proposal_${i}`], operations: [], warnings: [] },
          nextDocument: sampleDocument,
        })
      )
    );

    // 全て同じappliedRevision (2) で承認
    const approvalRevision = 2;
    await Promise.all(
      proposals.map((proposal) =>
        store.resolveProposal(proposal.proposalId, "approved", "承認", {
          appliedRevision: approvalRevision,
          revertDocument: sampleDocument,
        })
      )
    );

    // 1番目の提案に対してgetRevertPlanを呼ぶ
    const result = await store.getRevertPlan(proposals[0].proposalId, approvalRevision, sampleDocument);

    expect(result.ok).toBe(true);
    if (result.ok) {
      // proposalIds配列に3個の提案IDが全て含まれているはず
      expect(result.proposalIds).toHaveLength(3);
      expect(result.proposalIds).toContain(proposals[0].proposalId);
      expect(result.proposalIds).toContain(proposals[1].proposalId);
      expect(result.proposalIds).toContain(proposals[2].proposalId);
    }
  });
});
