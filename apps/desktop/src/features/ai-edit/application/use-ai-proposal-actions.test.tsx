// @vitest-environment happy-dom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SigmaDocument } from "@/features/document";
import { decideAiApprovedDocument } from "@/lib/ai-run-applier";
import { submitRejectionFeedback } from "@/lib/ai/ai-run-controller";
import { createBlankDocument } from "@/lib/blank-document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type {
  DesktopAPI,
  DesktopDocumentMetadata,
  DesktopMcpEditProposalsActionResult,
  DesktopMcpEditProposalSummary,
  DesktopStorageAPI,
} from "@/types/desktop";

import type { AiEditPreviewState } from "../model/preview";
import { AI_APPLY_ADD_FLASH_MS, AI_APPLY_REMOVE_ANIMATION_MS } from "./proposal-feedback";
import { useAiProposalActions, type AiProposalActionsDependencies } from "./use-ai-proposal-actions";

vi.mock("@/lib/desktop-bridge", () => ({ getDesktopBridge: vi.fn() }));
vi.mock("@/lib/ai/ai-run-controller", () => ({ submitRejectionFeedback: vi.fn() }));

const cleanups: Array<() => void | Promise<void>> = [];
const pendingOperations: Promise<unknown>[] = [];
const releasePending: Array<() => void> = [];

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
});

afterEach(async () => {
  await act(async () => {
    for (const release of releasePending.splice(0)) release();
    if (vi.isFakeTimers()) await vi.runAllTimersAsync();
    await Promise.allSettled(pendingOperations.splice(0));
  });
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

function deferred<T>(fallback: T) {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  releasePending.push(() => resolve(fallback));
  return { promise, resolve };
}

function track<T>(operation: Promise<T>): Promise<T> {
  pendingOperations.push(operation);
  return operation;
}

function documentWithText(text: string): SigmaDocument {
  return {
    ...createBlankDocument(),
    docId: "doc",
    metadata: { title: "教材", styleUnits: { fontSize: "pt" } },
    content: [{ id: "paragraph", type: "paragraph", children: [{ type: "text", text }] }],
  };
}

function metadata(revision = 2): DesktopDocumentMetadata {
  return {
    fileId: "file", workspaceId: "workspace", folderId: null, docId: "doc", title: "教材",
    revision, createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
  };
}

function preview(proposalIds = ["proposal"], roomId = "room"): AiEditPreviewState {
  return {
    targetId: "paragraph", proposalIds, roomId, turnId: `${roomId}-turn`, baseRevision: 1,
    providers: [], createdAt: 0, draft: { summary: "編集", plan: [], operations: [], warnings: [] },
  };
}

function citation(proposalId: string, appliedRevision?: number): DesktopMcpEditProposalSummary {
  return {
    proposalId, fileId: "file", baseRevision: 1, baseDocId: "doc", title: "教材", summary: "編集",
    plan: [], warnings: [], changedIds: ["paragraph"], provider: null,
    draft: preview().draft, status: appliedRevision === undefined ? "rejected" : "approved",
    createdAt: "2026-09-09T00:00:00Z", updatedAt: "2026-09-09T00:00:00Z",
    roomId: "history-room", turnId: "history-turn", appliedRevision,
  };
}

async function mount(overrides: Partial<AiProposalActionsDependencies> = {}) {
  const events: string[] = [];
  const originalDocument = documentWithText("変更前");
  const approvedDocument = documentWithText("AIの編集");
  const approvalResult: DesktopMcpEditProposalsActionResult = {
    ok: true, file: metadata(), document: approvedDocument,
  };
  const approve = vi.fn<DesktopStorageAPI["approveMcpEditProposals"]>(async () => {
    events.push("approve");
    return approvalResult;
  });
  const storage: Partial<DesktopStorageAPI> = { approveMcpEditProposals: approve };
  // Only the desktop boundary is replaced; proposal decisions, serialization, parsing, and React state are real.
  vi.mocked(getDesktopBridge).mockReturnValue({ storage } as DesktopAPI);
  const lastSyncedDocumentRef = { current: originalDocument };
  const busy = { current: false };
  const adopt = vi.fn<AiProposalActionsDependencies["applyAiApprovedDocument"]>((params) => {
    events.push("adopt");
    return decideAiApprovedDocument({ ...params, currentDocument: params.documentAtApprovalStart });
  });
  const reset = vi.fn<AiProposalActionsDependencies["resetEditorDocument"]>(() => { events.push("reset"); });
  const save = vi.fn<AiProposalActionsDependencies["saveCurrentDocumentRecord"]>(async () => {
    events.push("save");
    return { ok: true };
  });
  const status = vi.fn<AiProposalActionsDependencies["setStatusMessage"]>((message) => { events.push(`status:${String(message)}`); });
  const deps: AiProposalActionsDependencies = {
    document: originalDocument,
    activeFileId: "file", activeDocumentRevision: 1, activeFileIdRef: { current: "file" },
    selectedIdRef: { current: "paragraph" }, lastSyncedDocumentRef,
    metadataByFileId: new Map([["file", metadata(1)]]),
    aiEditPreviewGroups: [preview()], staleProposalGroups: [],
    aiProposalPresentation: { previewGroups: [preview()], allVisibleProposalIds: ["proposal"], hasActiveRunForDocument: false },
    mcpProposalCitations: [], locallyResolvedProposalIdsRef: { current: new Set() },
    mcpPreviewBusyRef: busy,
    setMcpPreviewBusy: (value) => { events.push(`busy:${value}`); },
    finishMcpPreviewBusy: () => { busy.current = false; events.push("finish"); },
    flushOverlayChanges: () => { events.push("flush"); },
    inFlightSavePromiseRef: { current: null }, isCurrentDocumentDirty: () => false,
    saveCurrentDocumentRecord: save,
    setSaveState: (state) => { events.push(`save-state:${String(state)}`); },
    setStatusMessage: status,
    refreshDocumentMetadatas: async () => { events.push("metadata"); },
    refreshMcpEditProposals: async () => { events.push("proposals"); },
    dispatchDocumentStorageChange: (event) => { events.push(`storage-change:${event.fileId}`); },
    updateVersionHistoryCaptureStatus: (fileId) => { events.push(`version:${fileId}`); },
    applyAiApprovedDocument: adopt, resetEditorDocument: reset,
    scheduleAutosaveRetry: () => { events.push("retry"); },
    announceRecovery: () => { events.push("recovery-warning"); },
    t: createCurrentLocaleTranslator("chrome"),
    ...overrides,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let mounted = true;
  let result!: ReturnType<typeof useAiProposalActions>;
  function Harness() {
    result = useAiProposalActions(deps);
    return null;
  }
  const rerender = async () => { await act(async () => root.render(<Harness />)); };
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(async () => root.unmount());
    container.remove();
  };
  cleanups.push(unmount);
  await rerender();
  return { read: () => result, deps, events, approve, storage, adopt, reset, save, status, originalDocument, approvedDocument, approvalResult, rerender, unmount };
}

describe("AI proposal action controller", () => {
  it("flushes, waits for the existing save, saves dirty changes, and adopts the approved document with the saved base", async () => {
    const inFlight = deferred<unknown>(undefined);
    const h = await mount({ inFlightSavePromiseRef: { current: inFlight.promise }, isCurrentDocumentDirty: () => true });
    const savedBase = documentWithText("承認前の打鍵");
    h.save.mockImplementation(async () => {
      h.events.push("save");
      h.deps.lastSyncedDocumentRef.current = savedBase;
      return { ok: true };
    });
    let operation!: Promise<unknown>;
    await act(async () => { operation = track(h.read().applyAiEditPreviewGroup(["proposal"])); });
    expect(h.events).toEqual(["busy:true", "flush"]);
    expect(h.deps.mcpPreviewBusyRef.current).toBe(true);
    expect(h.approve).not.toHaveBeenCalled();
    await act(async () => { inFlight.resolve(undefined); await operation; });
    expect(h.events.filter((event) => ["flush", "save", "approve", "adopt", "metadata", "proposals", "finish"].includes(event)))
      .toEqual(["flush", "save", "approve", "adopt", "metadata", "proposals", "finish"]);
    expect(h.adopt).toHaveBeenCalledWith(expect.objectContaining({
      diskDocument: h.approvedDocument, documentAtApprovalStart: savedBase, appliedProposalIds: ["proposal"], approvedRevision: 2,
    }));
    expect(h.reset).not.toHaveBeenCalled();
    expect(h.read().aiEditPreviewClearRequest).toMatchObject({ outcome: "applied", targets: [{ roomId: "room", turnId: "room-turn" }] });
    expect(h.deps.mcpPreviewBusyRef.current).toBe(false);
  });

  it("rejects overlapping decisions synchronously until the original action finishes", async () => {
    const h = await mount();
    const response = deferred(h.approvalResult);
    h.approve.mockReturnValue(response.promise);
    let first!: Promise<unknown>;
    await act(async () => { first = track(h.read().applyAiEditPreviewGroup(["proposal"])); });
    let second: unknown;
    await act(async () => { second = await h.read().forceApplyStaleProposals(["other"]); });
    expect(second).toMatchObject({ ok: false });
    expect(h.approve).toHaveBeenCalledTimes(1);
    expect(h.events).not.toContain("finish");
    await act(async () => { response.resolve(h.approvalResult); await first; });
    expect(h.events.filter((event) => event === "finish")).toHaveLength(1);
  });

  it("returns a save revision conflict before approval and dispatches recovery for the initiating file", async () => {
    const h = await mount({ isCurrentDocumentDirty: () => true });
    h.save.mockResolvedValue({ ok: false, code: "revision-mismatch" });
    let outcome: unknown;
    await act(async () => { outcome = await h.read().applyAiEditPreviewGroup(["proposal"]); });
    expect(outcome).toMatchObject({ ok: false });
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.events).toContain("storage-change:file");
    expect(h.events.at(-1)).toBe("finish");
  });

  it("keeps a completed approval out of the document selected while IPC was pending", async () => {
    const h = await mount();
    const response = deferred(h.approvalResult);
    h.approve.mockReturnValue(response.promise);
    let operation!: Promise<unknown>;
    await act(async () => { operation = track(h.read().applyAiEditPreviewGroup(["proposal"])); });
    h.deps.activeFileIdRef.current = "other-file";
    h.deps.activeFileId = "other-file";
    h.deps.document = documentWithText("切替先の教材");
    await h.rerender();
    await act(async () => { response.resolve(h.approvalResult); await operation; });
    expect(h.adopt).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
    expect(h.status).toHaveBeenLastCalledWith("別の教材『教材』にAI編集を適用しました");
    expect(h.deps.document.content).toEqual(documentWithText("切替先の教材").content);
  });

  it("takes missing approval document and revision from one recovery snapshot", async () => {
    const h = await mount();
    h.approve.mockResolvedValue({ ok: true });
    const recovered = documentWithText("復旧した正本");
    h.storage.loadDocumentWithRecovery = vi.fn<NonNullable<DesktopStorageAPI["loadDocumentWithRecovery"]>>(async () => ({ ok: true, document: recovered, revision: 7, recoveryIssues: [] }));
    await act(async () => { await h.read().applyAiEditPreviewGroup(["proposal"]); });
    expect(h.storage.loadDocumentWithRecovery).toHaveBeenCalledWith("file");
    expect(h.adopt).toHaveBeenCalledWith(expect.objectContaining({ diskDocument: recovered, approvedRevision: 7 }));
  });

  it("resolves only successful proposals and retains failed groups after partial approval", async () => {
    const h = await mount({ aiEditPreviewGroups: [preview(["a"], "a-room"), preview(["b"], "b-room")] });
    h.approve.mockResolvedValue({ ...h.approvalResult, ok: true, failed: [{ proposalId: "b", error: "競合" }] });
    await act(async () => { await h.read().applyAiEditPreviewGroup(["a", "b"]); });
    expect([...h.deps.locallyResolvedProposalIdsRef.current]).toEqual(["a"]);
    expect(h.adopt).toHaveBeenCalledWith(expect.objectContaining({ appliedProposalIds: ["a"] }));
    expect(h.read().aiEditPreviewClearRequest.targets).toEqual([{ roomId: "a-room", turnId: "a-room-turn" }]);
  });

  it("holds removal feedback until approval and cleans the added-content flash timer on unmount", async () => {
    vi.useFakeTimers();
    const group = preview();
    group.draft.operations = [{
      operation: "replace", targetId: "paragraph", summary: "置換",
      replacementBlock: { id: "paragraph", type: "paragraph", children: [{ type: "text", text: "新しい本文" }] },
    }];
    const h = await mount({ aiEditPreviewGroups: [group] });
    let operation!: Promise<unknown>;
    await act(async () => { operation = track(h.read().applyAiEditPreviewGroup(["proposal"])); });
    expect(h.read().aiApplyAnimation?.removingBlockIds).toEqual(["paragraph"]);
    expect(h.approve).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_APPLY_REMOVE_ANIMATION_MS); await operation; });
    expect(h.read().aiApplyAnimation?.addedBlockIds).toEqual(["paragraph"]);
    await act(async () => { await vi.advanceTimersByTimeAsync(AI_APPLY_ADD_FLASH_MS - 1); });
    expect(h.read().aiApplyAnimation).not.toBeNull();
    await h.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one busy interval across restore and immediate approval, with the original resolution targets", async () => {
    const h = await mount({ mcpProposalCitations: [citation("a"), citation("b")] });
    h.storage.restoreMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["restoreMcpEditProposal"]>>(async (id) => {
      expect(h.deps.mcpPreviewBusyRef.current).toBe(true);
      h.events.push(`restore:${id}`);
      return { ok: true, proposal: citation(id) };
    });
    let outcome: unknown;
    await act(async () => { outcome = await h.read().restoreProposalFromHistory(["a", "a", "b"]); });
    expect(outcome).toEqual({ ok: true });
    expect(h.events.filter((event) => event.startsWith("restore:") || event === "busy:true" || event === "finish"))
      .toEqual(["busy:true", "restore:a", "restore:b", "finish"]);
    expect(h.approve).toHaveBeenCalledWith(["a", "b"], undefined);
    expect(h.read().aiEditPreviewClearRequest).toMatchObject({ outcome: "applied", includeResolved: true, targets: [{ roomId: "history-room", turnId: "history-turn" }] });
  });

  it("rolls back an earlier restored proposal when a later restore fails, without approving either", async () => {
    const h = await mount();
    h.storage.restoreMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["restoreMcpEditProposal"]>>(async (id) => id === "a"
      ? { ok: true, proposal: citation(id) }
      : { ok: false, error: "復元できません" });
    h.storage.rejectMcpEditProposals = vi.fn<NonNullable<DesktopStorageAPI["rejectMcpEditProposals"]>>(async () => ({ ok: true, proposals: [], failed: [] }));
    let outcome: unknown;
    await act(async () => { outcome = await h.read().restoreProposalFromHistory(["a", "b"]); });
    expect(outcome).toEqual({ ok: false, reason: "復元できません" });
    expect(h.storage.rejectMcpEditProposals).toHaveBeenCalledWith(["a"]);
    expect(h.approve).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toBe("finish");
  });

  it.each([true, false])("routes shared proposal undo to the session without a JSON restore (%s)", async (restored) => {
    const revertSessionProposals = vi.fn(async () => restored);
    const h = await mount({ mcpProposalCitations: [citation("shared", 4)], revertSessionProposals });
    h.storage.revertMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["revertMcpEditProposal"]>>(async () => ({ ok: true, proposal: {} }));
    let outcome: { ok: boolean } | undefined;
    await act(async () => { outcome = await h.read().revertAppliedProposals(["shared"]); });
    expect(outcome?.ok).toBe(restored);
    expect(revertSessionProposals).toHaveBeenCalledWith(["shared"]);
    expect(h.storage.revertMcpEditProposal).not.toHaveBeenCalled();
    expect(h.reset).not.toHaveBeenCalled();
  });

  it("reverts each saved batch newest first and reloads the returned revision while retaining selection", async () => {
    const h = await mount({ mcpProposalCitations: [citation("old-a", 4), citation("old-b", 4), citation("new", 7)] });
    h.storage.revertMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["revertMcpEditProposal"]>>(async (id) => { h.events.push(`revert:${id}`); return { ok: true, proposal: {} }; });
    h.storage.markMcpEditProposalsReverted = vi.fn<NonNullable<DesktopStorageAPI["markMcpEditProposalsReverted"]>>(async () => ({ ok: true }));
    const recovered = documentWithText("取り消した本文");
    h.storage.loadDocumentWithRecovery = vi.fn<NonNullable<DesktopStorageAPI["loadDocumentWithRecovery"]>>(async () => ({ ok: true, document: recovered, revision: 9, recoveryIssues: [] }));
    await act(async () => { await h.read().revertAppliedProposals(["old-a", "old-b", "new"]); });
    expect(h.events.filter((event) => event.startsWith("revert:"))).toEqual(["revert:new", "revert:old-a"]);
    expect(h.storage.markMcpEditProposalsReverted).toHaveBeenCalledWith(["old-a", "old-b", "new"]);
    expect(h.reset).toHaveBeenCalledWith(expect.objectContaining({ content: recovered.content }), "paragraph", 9);
    expect(h.events.indexOf("reset")).toBeLessThan(h.events.indexOf("proposals"));
    expect(h.events.at(-1)).toBe("finish");
  });

  it("reloads a partially reverted document without marking the remaining proposals resolved, and announces recovery last", async () => {
    const h = await mount({ mcpProposalCitations: [citation("old", 4), citation("new", 7)] });
    h.storage.revertMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["revertMcpEditProposal"]>>(async (id) => id === "new"
      ? { ok: true, proposal: {} }
      : { ok: false, reason: "古い変更が競合" });
    h.storage.markMcpEditProposalsReverted = vi.fn<NonNullable<DesktopStorageAPI["markMcpEditProposalsReverted"]>>(async () => ({ ok: true }));
    h.storage.loadDocumentWithRecovery = vi.fn<NonNullable<DesktopStorageAPI["loadDocumentWithRecovery"]>>(async () => ({ ok: true, document: documentWithText("部分復元"), revision: 8, recoveryIssues: [], recoveryBackupPath: "/backup" }));
    let outcome: unknown;
    await act(async () => { outcome = await h.read().revertAppliedProposals(["old", "new"]); });
    expect(outcome).toMatchObject({ ok: false });
    expect(h.storage.markMcpEditProposalsReverted).not.toHaveBeenCalled();
    expect(h.reset).toHaveBeenCalledWith(expect.objectContaining({ content: documentWithText("部分復元").content }), "paragraph", 8);
    expect(h.events.slice(-3)).toEqual([expect.stringContaining("status:"), "recovery-warning", "finish"]);
  });

  it("uses bulk rejection with reasons and records only successful IDs", async () => {
    const h = await mount({ aiEditPreviewGroups: [preview(["a", "b"])] });
    h.storage.rejectMcpEditProposals = vi.fn<NonNullable<DesktopStorageAPI["rejectMcpEditProposals"]>>(async () => ({ ok: true, proposals: [{}], failed: [{ proposalId: "b", error: "失敗" }] }));
    await act(async () => { await h.read().dismissAiEditPreviewGroup(["a", "b"], "説明を短く"); });
    expect(h.storage.rejectMcpEditProposals).toHaveBeenCalledWith(["a", "b"], "説明を短く");
    expect([...h.deps.locallyResolvedProposalIdsRef.current]).toEqual(["a"]);
    expect(h.read().aiEditPreviewClearRequest.seq).toBe(0);
    expect(submitRejectionFeedback).not.toHaveBeenCalled();
  });

  it("supports legacy per-proposal rejection failures without losing successful IDs", async () => {
    const h = await mount({ aiEditPreviewGroups: [preview(["a", "b"])] });
    h.storage.rejectMcpEditProposal = vi.fn<NonNullable<DesktopStorageAPI["rejectMcpEditProposal"]>>(async (id) => {
      if (id === "b") throw new Error("失敗");
      return { ok: true, proposal: citation(id) };
    });
    await act(async () => { await h.read().dismissAiEditPreviewGroup(["a", "b"]); });
    expect(h.storage.rejectMcpEditProposal).toHaveBeenCalledTimes(2);
    expect([...h.deps.locallyResolvedProposalIdsRef.current]).toEqual(["a"]);
    expect(h.events).toContain("proposals");
    expect(h.events.at(-2)).toBe("finish");
  });

  it("keeps preview clearing stable and uses the current render's visible proposal list", async () => {
    const h = await mount();
    const clear = h.read().clearAiEditPreview;
    h.deps.aiProposalPresentation = { previewGroups: [], allVisibleProposalIds: ["new-proposal"], hasActiveRunForDocument: false };
    await h.rerender();
    expect(h.read().clearAiEditPreview).toBe(clear);
    await act(async () => { await h.read().applyAllAiEditPreviewGroups(); });
    expect(h.approve).toHaveBeenCalledWith(["new-proposal"], undefined);
    await act(async () => { clear("dismissed", [{ roomId: "other-room" }]); });
    expect(h.read().aiEditPreviewClearRequest).toMatchObject({ outcome: "dismissed", targets: [{ roomId: "other-room" }] });
  });
});
