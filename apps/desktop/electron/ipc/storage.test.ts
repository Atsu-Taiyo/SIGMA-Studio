import { beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listProposals: vi.fn(),
  saveDocument: vi.fn(),
  captureDocumentVersion: vi.fn(),
  runPostSaveHooks: vi.fn(),
  recordRendererSave: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    }),
  },
}));

import { registerStorageIpc, type RegisterStorageIpcDeps } from "./storage";
import { LedgerSchemaError } from "../ledger-schema-error";
import { LocalMcpEditProposalStore } from "../local-sigma-doc-proposal-store";
import type { SigmaDocument } from "@/features/document";
import { ensurePageLayout } from "@/features/document";

function registerListHandler(): (...args: unknown[]) => unknown {
  registerStorageIpc({
    localSigmaDocStore: {},
    localMcpProposalStore: {
      listProposals: mocks.listProposals,
    },
    approveSingleProposal: vi.fn(),
    broadcastLocalStoreChange: vi.fn(),
    runPostSaveHooks: vi.fn(),
    recordRendererSave: vi.fn(),
  } as unknown as RegisterStorageIpcDeps);

  const handler = mocks.handlers.get("storage:list-mcp-edit-proposals");
  expect(handler).toBeDefined();
  return handler!;
}

function registerSaveHandler(): (...args: unknown[]) => unknown {
  registerStorageIpc({
    localSigmaDocStore: {
      saveDocument: mocks.saveDocument,
    },
    localMcpProposalStore: {
      listProposals: mocks.listProposals,
    },
    approveSingleProposal: vi.fn(),
    broadcastLocalStoreChange: vi.fn(),
    runPostSaveHooks: mocks.runPostSaveHooks,
    recordRendererSave: mocks.recordRendererSave,
  } as unknown as RegisterStorageIpcDeps);

  const handler = mocks.handlers.get("storage:save-document");
  expect(handler).toBeDefined();
  return handler!;
}

function registerCaptureHandler(): (...args: unknown[]) => unknown {
  registerStorageIpc({
    localSigmaDocStore: {
      captureDocumentVersion: mocks.captureDocumentVersion,
    },
    localMcpProposalStore: {},
    approveSingleProposal: vi.fn(),
    broadcastLocalStoreChange: vi.fn(),
    runPostSaveHooks: vi.fn(),
    recordRendererSave: vi.fn(),
  } as unknown as RegisterStorageIpcDeps);
  const handler = mocks.handlers.get("storage:capture-document-version");
  expect(handler).toBeDefined();
  return handler!;
}

describe("storage:initialize-workspace", () => {
  it("returns a structured ledger failure when initialization rejects with LedgerSchemaError", async () => {
    mocks.handlers.clear();
    const failure = {
      libraryPath: "/tmp/sigma/library.json",
      expectedVersion: 4,
      actualVersion: 3,
      violations: [{
        path: "workspaces[0].kind",
        reason: { kind: "forbiddenField" as const, field: "kind" },
        expected: null,
        received: "\"cloud\"",
      }],
    };
    registerStorageIpc({
      localSigmaDocStore: {
        initializeWorkspace: vi.fn().mockRejectedValue(new LedgerSchemaError(failure)),
      },
      localMcpProposalStore: {},
      approveSingleProposal: vi.fn(),
      broadcastLocalStoreChange: vi.fn(),
      runPostSaveHooks: vi.fn(),
      recordRendererSave: vi.fn(),
    } as unknown as RegisterStorageIpcDeps);

    const handler = mocks.handlers.get("storage:initialize-workspace");

    await expect(handler?.({}, { initialDocument: {} })).resolves.toEqual({
      ok: false,
      ledgerError: failure,
    });
  });
});

describe("storage:list-mcp-edit-proposals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.listProposals.mockResolvedValue([]);
    mocks.saveDocument.mockReset();
    mocks.runPostSaveHooks.mockReset();
    mocks.recordRendererSave.mockReset();
    mocks.captureDocumentVersion.mockReset();
  });

  it("forwards the all status from the renderer options", async () => {
    const handler = registerListHandler();

    await handler({}, { status: "all" });

    expect(mocks.listProposals).toHaveBeenCalledWith({
      status: "all",
      fileId: undefined,
      resolvedLimit: undefined,
    });
  });

  it("forwards status, fileId, and resolvedLimit", async () => {
    const handler = registerListHandler();

    await handler({}, {
      status: "approved",
      fileId: "file_1",
      resolvedLimit: 12,
    });

    expect(mocks.listProposals).toHaveBeenCalledWith({
      status: "approved",
      fileId: "file_1",
      resolvedLimit: 12,
    });
  });

  it("falls back to pending for garbage input", async () => {
    const handler = registerListHandler();

    await handler({}, "all");

    expect(mocks.listProposals).toHaveBeenCalledWith({
      status: "pending",
      fileId: undefined,
      resolvedLimit: undefined,
    });
  });
});

describe("storage:save-document", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.saveDocument.mockReset();
    mocks.runPostSaveHooks.mockReset();
    mocks.recordRendererSave.mockReset();
  });

  it.each([undefined, {}, { expectedRevision: Number.NaN }, { expectedRevision: Number.POSITIVE_INFINITY }])(
    "rejects a missing or non-finite expectedRevision: %o",
    async (options) => {
      const handler = registerSaveHandler();

      await expect(handler({}, "file_1", { docId: "doc_1" }, options)).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("revision"),
      });
      expect(mocks.saveDocument).not.toHaveBeenCalled();
      expect(mocks.runPostSaveHooks).not.toHaveBeenCalled();
      expect(mocks.recordRendererSave).not.toHaveBeenCalled();
    },
  );

  it("forwards expectedRevision and runs post-save hooks only after a successful save", async () => {
    const handler = registerSaveHandler();
    const document = { docId: "doc_1" };
    mocks.saveDocument.mockResolvedValueOnce({ ok: true, revision: 8 });

    await expect(handler({}, "file_1", document, { expectedRevision: 7 })).resolves.toEqual({
      ok: true,
      revision: 8,
    });

    expect(mocks.saveDocument).toHaveBeenCalledWith(
      "file_1",
      document,
      { expectedRevision: 7, origin: "user" },
    );
    expect(mocks.recordRendererSave).toHaveBeenCalledWith("file_1");
    expect(mocks.runPostSaveHooks).toHaveBeenCalledWith("file_1", document, 8);
  });

  it.each(["ai", "tab-switch", "app-close"] as const)("forwards the %s save origin", async (origin) => {
    const handler = registerSaveHandler();
    mocks.saveDocument.mockResolvedValueOnce({ ok: true, revision: 8 });
    await handler({}, "file_1", { docId: "doc_1" }, { expectedRevision: 7, origin });
    expect(mocks.saveDocument).toHaveBeenCalledWith(
      "file_1",
      { docId: "doc_1" },
      { expectedRevision: 7, origin },
    );
  });

  it("returns a failed save without running post-save hooks", async () => {
    const handler = registerSaveHandler();
    const mismatch = {
      ok: false,
      code: "revision-mismatch",
      currentRevision: 8,
      error: "stale",
    };
    mocks.saveDocument.mockResolvedValueOnce(mismatch);

    await expect(handler({}, "file_1", { docId: "doc_1" }, { expectedRevision: 7 }))
      .resolves.toEqual(mismatch);

    expect(mocks.recordRendererSave).not.toHaveBeenCalled();
    expect(mocks.runPostSaveHooks).not.toHaveBeenCalled();
  });
});

describe("storage:capture-document-version", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.handlers.clear();
    mocks.captureDocumentVersion.mockReset();
  });

  it.each(["restore-backup", "ai", "tab-switch", "app-close"] as const)("forwards the %s capture origin", async (origin) => {
    const handler = registerCaptureHandler();
    mocks.captureDocumentVersion.mockResolvedValueOnce({ ok: true });
    await handler({}, "file_1", { docId: "doc_1" }, { expectedRevision: 7, origin });
    expect(mocks.captureDocumentVersion).toHaveBeenCalledWith(
      "file_1",
      { docId: "doc_1" },
      { expectedRevision: 7, origin },
    );
  });
});

describe("storage:approve-mcp-edit-proposals conflict persistence", () => {
  it("persists the first approval-time typed conflict to every proposal group member for refresh", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-conflict-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const baseDocument = paragraphDocument("base");
      const first = await proposalStore.upsertCurrentProposal({
        fileId: "file_1",
        baseRevision: 1,
        baseDocument,
        summary: "本文を更新しました。",
        plan: ["本文を更新しました。"],
        provider: null,
        roomId: "room_1",
        runId: "run_1",
        source: { toolName: "draft_update_rich_content", toolArgs: {} },
        draft: {
          summary: "本文を更新しました。",
          plan: ["本文を更新しました。"],
          operations: [{
            operation: "replace",
            summary: "本文を更新しました。",
            targetId: "p_1",
            replacementBlock: {
              type: "paragraph",
              id: "p_1",
              children: [{ type: "text", text: "AI" }],
            },
          }],
          warnings: [],
        },
        nextDocument: paragraphDocument("AI"),
      });
      const second = await proposalStore.upsertCurrentProposal({
        fileId: "file_1",
        baseRevision: 1,
        baseDocument,
        summary: "追記しました。",
        plan: ["追記しました。"],
        provider: null,
        roomId: "room_1",
        runId: "run_1",
        source: { toolName: "draft_insert_body_content", toolArgs: {} },
        draft: {
          summary: "追記しました。",
          plan: ["追記しました。"],
          operations: [{
            operation: "insertAfter",
            summary: "追記しました。",
            targetId: "p_1",
            insertedBlock: {
              type: "paragraph",
              id: "p_2",
              children: [{ type: "text", text: "追記" }],
            },
          }],
          warnings: [],
        },
        nextDocument: baseDocument,
      });
      const currentDocument = paragraphDocument("human edit");
      const localSigmaDocStore = {
        runExclusive: async (_fileId: string, task: () => Promise<unknown>) => task(),
        listFiles: vi.fn(async () => [{ fileId: "file_1", revision: 2 }]),
        loadDocument: vi.fn(async () => currentDocument),
        saveDocument: vi.fn(),
      };
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);
      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;

      await expect(handler({}, [second.proposalId], {})).resolves.toMatchObject({
        ok: false,
        code: "conflict",
        conflictReason: "content-stale",
        conflictBlockIds: ["p_1"],
      });
      expect(localSigmaDocStore.saveDocument).not.toHaveBeenCalled();

      const refreshedStore = new LocalMcpEditProposalStore(userDataDir);
      expect((await refreshedStore.loadProposal(first.proposalId))?.conflict).toEqual({
        blockIds: ["p_1"],
        detectedAtRevision: 2,
        reason: "content-stale",
      });
      expect((await refreshedStore.loadProposal(second.proposalId))?.conflict).toEqual({
        blockIds: ["p_1"],
        detectedAtRevision: 2,
        reason: "content-stale",
      });
      expect((await refreshedStore.listProposals({ status: "pending" }))[0]?.conflict?.reason).toBe("content-stale");
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("fails the approval claim when the proposal is rejected after the click-time load", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-reject-race-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const baseDocument = paragraphDocument("base");
      const proposal = await createReplaceProposal(proposalStore, baseDocument, "AI");
      const originalLoad = proposalStore.loadProposal.bind(proposalStore);
      let interposed = false;
      vi.spyOn(proposalStore, "loadProposal").mockImplementation(async (proposalId) => {
        const snapshot = await originalLoad(proposalId);
        if (!interposed) {
          interposed = true;
          await proposalStore.rejectSingleProposal(proposalId, "並行して却下");
        }
        return snapshot;
      });
      const localSigmaDocStore = approvalDocumentStore(baseDocument);
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);

      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;
      await expect(handler({}, [proposal.proposalId], {})).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("更新または処理"),
      });
      expect(localSigmaDocStore.saveDocument).not.toHaveBeenCalled();
      expect((await originalLoad(proposal.proposalId))?.status).toBe("rejected");
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("fails the approval claim when a same-run upsert revises the draft after the click-time load", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-upsert-race-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const baseDocument = paragraphDocument("base");
      const proposal = await createReplaceProposal(proposalStore, baseDocument, "AI");
      const originalLoad = proposalStore.loadProposal.bind(proposalStore);
      let interposed = false;
      vi.spyOn(proposalStore, "loadProposal").mockImplementation(async (proposalId) => {
        const snapshot = await originalLoad(proposalId);
        if (!interposed) {
          interposed = true;
          await proposalStore.upsertCurrentProposal(insertProposalInput(baseDocument));
        }
        return snapshot;
      });
      const localSigmaDocStore = approvalDocumentStore(baseDocument);
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);

      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;
      await expect(handler({}, [proposal.proposalId], {})).resolves.toMatchObject({
        ok: false,
        error: expect.stringContaining("更新または処理"),
      });
      expect(localSigmaDocStore.saveDocument).not.toHaveBeenCalled();
      expect((await originalLoad(proposal.proposalId))?.draft.operations).toHaveLength(2);
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("persists replay-failed when every proposal fails aggregate replay validation", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-replay-failed-all-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const baseDocument = paragraphDocument("base");
      const proposal = await createSelfInvalidatingReplayProposal(proposalStore, baseDocument);
      const localSigmaDocStore = approvalDocumentStore(baseDocument);
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);

      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;
      await expect(handler({}, [proposal.proposalId], {})).resolves.toMatchObject({ ok: false });
      expect((await proposalStore.loadProposal(proposal.proposalId))?.conflict).toMatchObject({
        reason: "replay-failed",
        detectedAtRevision: 1,
      });
      expect(localSigmaDocStore.saveDocument).not.toHaveBeenCalled();
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("persists a partial replay failure while saving the proposals that applied", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-replay-failed-partial-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const baseDocument = paragraphDocument("base");
      const valid = await createDeleteProposal(proposalStore, baseDocument);
      const invalid = await proposalStore.createProposal(insertProposalInput(baseDocument, { roomId: "room_invalid", runId: "run_invalid" }));
      const localSigmaDocStore = approvalDocumentStore(baseDocument, {
        saveRevision: 2,
        versionCaptureError: "history unavailable",
      });
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);

      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;
      await expect(handler({}, [valid.proposalId, invalid.proposalId], {})).resolves.toMatchObject({
        ok: true,
        versionCaptureError: "history unavailable",
        failed: [{ proposalId: invalid.proposalId }],
      });
      expect((await proposalStore.loadProposal(valid.proposalId))?.status).toBe("approved");
      expect((await proposalStore.loadProposal(invalid.proposalId))?.conflict).toMatchObject({
        reason: "anchor-missing",
        blockIds: ["p_1"],
      });
      expect((await proposalStore.loadProposal(invalid.proposalId))?.status).toBe("pending");
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });

  it("rejects approval when an external shape anchor disappeared", async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-storage-ipc-shape-anchor-"));
    try {
      const proposalStore = new LocalMcpEditProposalStore(userDataDir);
      const body = ensurePageLayout(paragraphDocument("base"));
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
      const proposal = await proposalStore.createProposal({
        fileId: "file_1",
        baseRevision: 1,
        baseDocument,
        summary: "子図形を追加しました。",
        plan: ["子図形を追加しました。"],
        provider: null,
        source: { toolName: "draft_insert_shape", toolArgs: {} },
        draft: {
          summary: "子図形を追加しました。",
          plan: ["子図形を追加しました。"],
          operations: [{
            operation: "insertOverlayShape",
            summary: "子図形を追加しました。",
            targetId: "p_1",
            overlayShape: {
              id: "shape_child",
              type: "geo",
              x: 20,
              y: 20,
              anchor: { type: "shape", shapeId: parentShape.id, dx: 10, dy: 10 },
              props: {
                w: 40,
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
        },
        nextDocument: baseDocument,
      });
      const currentDocument: SigmaDocument = {
        ...baseDocument,
        pageLayout: {
          ...baseDocument.pageLayout!,
          overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
        },
      };
      const localSigmaDocStore = {
        runExclusive: async (_fileId: string, task: () => Promise<unknown>) => task(),
        listFiles: vi.fn(async () => [{ fileId: "file_1", revision: 2 }]),
        loadDocument: vi.fn(async () => currentDocument),
        saveDocument: vi.fn(),
      };
      registerStorageIpc({
        localSigmaDocStore,
        localMcpProposalStore: proposalStore,
        approveSingleProposal: vi.fn(),
        broadcastLocalStoreChange: vi.fn(),
        runPostSaveHooks: vi.fn(),
        recordRendererSave: vi.fn(),
      } as unknown as RegisterStorageIpcDeps);

      const handler = mocks.handlers.get("storage:approve-mcp-edit-proposals")!;
      await expect(handler({}, [proposal.proposalId], {})).resolves.toMatchObject({
        ok: false,
        code: "conflict",
        conflictReason: "anchor-missing",
        conflictBlockIds: [parentShape.id],
      });
      expect(localSigmaDocStore.saveDocument).not.toHaveBeenCalled();
    } finally {
      await fs.rm(userDataDir, { recursive: true, force: true });
    }
  });
});

function paragraphDocument(text: string): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_1",
    metadata: { title: "教材" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [{ type: "paragraph", id: "p_1", children: [{ type: "text", text }] }],
  };
}

async function createSelfInvalidatingReplayProposal(
  store: LocalMcpEditProposalStore,
  baseDocument: SigmaDocument,
) {
  return store.createProposal({
    fileId: "file_1",
    baseRevision: 1,
    baseDocument,
    summary: "削除後のアンカーへ追記",
    plan: ["削除後のアンカーへ追記"],
    provider: null,
    roomId: "room_invalid",
    runId: "run_invalid",
    source: { toolName: "draft_insert_body_content", toolArgs: {} },
    draft: {
      summary: "削除後のアンカーへ追記",
      plan: ["削除後のアンカーへ追記"],
      operations: [{
        operation: "insertAfter",
        summary: "削除後に追記",
        targetId: "p_1",
        insertedBlock: { type: "paragraph", id: "p_2", children: [{ type: "text", text: "追加" }] },
      }],
      mutationOperations: [{ operation: "deleteBlocks", summary: "先に削除", blockIds: ["p_1"] }],
      operationOrder: [{ kind: "mutation", index: 0 }, { kind: "operation", index: 0 }],
      warnings: [],
    },
    nextDocument: baseDocument,
  });
}

async function createDeleteProposal(store: LocalMcpEditProposalStore, baseDocument: SigmaDocument) {
  return store.createProposal({
    fileId: "file_1",
    baseRevision: 1,
    baseDocument,
    summary: "本文を削除",
    plan: ["本文を削除"],
    provider: null,
    roomId: "room_valid",
    runId: "run_valid",
    source: { toolName: "draft_delete_blocks", toolArgs: {} },
    draft: {
      summary: "本文を削除",
      plan: ["本文を削除"],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "本文を削除", blockIds: ["p_1"] }],
      warnings: [],
    },
    nextDocument: baseDocument,
  });
}

async function createReplaceProposal(
  store: LocalMcpEditProposalStore,
  baseDocument: SigmaDocument,
  text: string,
  attribution: { roomId?: string; runId?: string } = { roomId: "room_1", runId: "run_1" },
) {
  return store.createProposal({
    fileId: "file_1",
    baseRevision: 1,
    baseDocument,
    summary: "本文を更新しました。",
    plan: ["本文を更新しました。"],
    provider: null,
    ...attribution,
    source: { toolName: "draft_update_rich_content", toolArgs: {} },
    draft: {
      summary: "本文を更新しました。",
      plan: ["本文を更新しました。"],
      operations: [{
        operation: "replace",
        summary: "本文を更新しました。",
        targetId: "p_1",
        replacementBlock: { type: "paragraph", id: "p_1", children: [{ type: "text", text }] },
      }],
      warnings: [],
    },
    nextDocument: paragraphDocument(text),
  });
}

function insertProposalInput(
  baseDocument: SigmaDocument,
  attribution: { roomId?: string; runId?: string } = { roomId: "room_1", runId: "run_1" },
) {
  return {
    fileId: "file_1",
    baseRevision: 1,
    baseDocument,
    summary: "本文を追加しました。",
    plan: ["本文を追加しました。"],
    provider: null,
    ...attribution,
    source: { toolName: "draft_insert_body_content", toolArgs: {} },
    draft: {
      summary: "本文を追加しました。",
      plan: ["本文を追加しました。"],
      operations: [{
        operation: "insertAfter" as const,
        summary: "本文を追加しました。",
        targetId: "p_1",
        insertedBlock: { type: "paragraph" as const, id: "p_2", children: [{ type: "text" as const, text: "追加" }] },
      }],
      warnings: [],
    },
    nextDocument: baseDocument,
  };
}

function approvalDocumentStore(
  document: SigmaDocument,
  options: { saveRevision?: number; versionCaptureError?: string } = {},
) {
  const saveRevision = options.saveRevision ?? 1;
  return {
    runExclusive: async (_fileId: string, task: () => Promise<unknown>) => task(),
    listFiles: vi.fn(async () => [{ fileId: "file_1", revision: saveRevision }]),
    loadDocument: vi.fn(async () => document),
    saveDocument: vi.fn(async () => ({
      ok: true,
      revision: saveRevision,
      versionCaptureError: options.versionCaptureError,
    })),
  };
}
