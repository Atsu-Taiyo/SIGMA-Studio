import { describe, expect, it, vi } from "vitest";

import { createBlankDocument } from "@/lib/blank-document";
import type { DocumentLoadResult, StorageResult } from "@/lib/runtime/types";

import { closeWorkspaceDocumentTab, deleteWorkspaceDocument } from "./document-tab-commands";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}

function harness(openFileIds = ["a", "b", "c"], activeFileId = "b") {
  const document = createBlankDocument();
  const events: string[] = [];
  const view = { tabs: [...openFileIds], active: activeFileId, status: "", error: false, locale: "ja" };
  const state: Parameters<typeof closeWorkspaceDocumentTab>[1] = {
    openFileIds, activeFileId,
    untouchedNewDocumentsRef: { current: new Map() },
    mcpPreviewBusyRef: { current: false },
    activeFileIdRef: { current: activeFileId },
    openFileIdsRef: { current: [...openFileIds] },
    documentRef: { current: document },
  };
  const loaded: DocumentLoadResult = { ok: true, document, revision: 7, recoveryIssues: [] };
  type Ports = Parameters<typeof closeWorkspaceDocumentTab>[2];
  const ports = {
    flushOverlayChanges: vi.fn(() => { events.push("flush"); }),
    saveCurrentDocumentBeforeReplacement: vi.fn<Ports["saveCurrentDocumentBeforeReplacement"]>(async () => {
      events.push("save"); return true;
    }),
    loadDocumentByFileIdWithRecovery: vi.fn<Ports["loadDocumentByFileIdWithRecovery"]>(async () => {
      events.push("load"); return loaded;
    }),
    deleteDocument: vi.fn<Ports["deleteDocument"]>(async () => { events.push("delete"); return { ok: true }; }),
    forgetTabView: vi.fn(() => { events.push("forget"); }),
    cancelPendingAutosave: vi.fn(() => { events.push("cancel-autosave"); }),
    markWorkspaceNotReady: vi.fn(() => { events.push("workspace-not-ready"); }),
    navigateToWorkspace: vi.fn(() => { events.push("navigate"); }),
    openDocumentInWorkspace: vi.fn<Ports["openDocumentInWorkspace"]>(async (fileId, options) => {
      events.push("open"); view.active = fileId; view.tabs = options?.nextOpenFileIds ?? view.tabs;
    }),
    setOpenFileIds: vi.fn<Ports["setOpenFileIds"]>((fileIds) => { events.push("tabs"); view.tabs = fileIds; }),
    saveWorkspaceState: vi.fn<Ports["saveWorkspaceState"]>(async () => { events.push("workspace-save"); }),
    refreshDocumentMetadatas: vi.fn<Ports["refreshDocumentMetadatas"]>(async () => { events.push("refresh"); }),
    setSaveState: vi.fn<Ports["setSaveState"]>(() => { events.push("error"); view.error = true; }),
    setStatusMessage: vi.fn<Ports["setStatusMessage"]>((message) => { events.push("status"); view.status = message; }),
    tEditor: (key: string) => `${view.locale}:${key}`,
  } satisfies Ports;
  const close = (id = activeFileId) => closeWorkspaceDocumentTab(id, state, ports);
  const remove = (id = activeFileId, library = ["a", "b", "c"]) => deleteWorkspaceDocument(id, {
    ...state, documentMetadatas: library.map((fileId) => ({ fileId })),
  }, ports);
  const draft = (id = activeFileId) => { state.untouchedNewDocumentsRef.current.set(id, document); };
  return { state, view, events, ports, loaded, close, remove, draft };
}

describe("document tab close", () => {
  it.each([
    { closing: "a", active: "a", next: "b" },
    { closing: "b", active: "b", next: "a" },
    { closing: "c", active: "c", next: "b" },
  ])("opens the adjacent tab when closing active $closing without deleting its file", async ({ closing, active, next }) => {
    const h = harness(["a", "b", "c"], active);
    await h.close(closing);
    expect(h.view).toMatchObject({ active: next, tabs: ["a", "b", "c"].filter((id) => id !== closing) });
    expect(h.ports.openDocumentInWorkspace).toHaveBeenCalledWith(next, {
      nextOpenFileIds: h.view.tabs, status: "ja:status.tabClosed",
    });
    expect(h.events).toEqual(["flush", "forget", "open"]);
  });

  it("persists an inactive close before reporting it, using the captured workspace", async () => {
    const h = harness();
    const pending = deferred<void>();
    h.ports.saveWorkspaceState.mockReturnValue(pending.promise);
    h.state.activeFileIdRef.current = "c";
    h.state.openFileIdsRef.current = ["a", "b", "c", "d"];
    const closing = h.close("a");
    expect(h.view).toMatchObject({ active: "b", tabs: ["b", "c"], status: "" });
    expect(h.ports.saveWorkspaceState).toHaveBeenCalledWith({ openFileIds: ["b", "c"], activeFileId: "b" });
    h.view.locale = "en";
    pending.resolve();
    await closing;
    expect(h.view.status).toBe("en:status.tabClosed");
    expect(h.ports.deleteDocument).not.toHaveBeenCalled();
  });

  it("retains the last ordinary tab", async () => {
    const h = harness(["a"], "a");
    await h.close();
    expect(h.view).toMatchObject({ active: "a", tabs: ["a"], status: "ja:status.lastTabStays" });
    expect(h.events).toEqual(["flush", "status"]);
  });

  it("saves an active untouched draft, deletes only its loaded revision and opens a remaining tab", async () => {
    const h = harness();
    h.draft();
    await h.close();
    expect(h.ports.deleteDocument).toHaveBeenCalledWith("b", { expectedRevision: 7 });
    expect(h.ports.openDocumentInWorkspace).toHaveBeenCalledWith("a", {
      nextOpenFileIds: ["a", "c"], saveCurrent: false, status: "ja:status.tabClosed",
    });
    expect(h.state.untouchedNewDocumentsRef.current.has("b")).toBe(false);
    expect(h.events).toEqual(["flush", "save", "load", "delete", "forget", "open", "refresh"]);
  });

  it("cancels pending writes before leaving the last deleted draft and refreshing the library", async () => {
    const h = harness(["a"], "a");
    h.draft();
    await h.close();
    expect(h.events).toEqual([
      "flush", "save", "load", "delete", "forget", "cancel-autosave", "workspace-not-ready", "navigate", "refresh",
    ]);
    expect(h.ports.saveWorkspaceState).not.toHaveBeenCalled();
    expect(h.ports.openDocumentInWorkspace).not.toHaveBeenCalled();
  });

  it("uses the latest tabs and active document after an inactive draft deletion completes", async () => {
    const h = harness();
    h.draft("a");
    const pending = deferred<StorageResult>();
    h.ports.deleteDocument.mockReturnValue(pending.promise);
    const closing = h.close("a");
    await vi.waitFor(() => expect(h.ports.deleteDocument).toHaveBeenCalled());
    expect(h.ports.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
    h.state.openFileIdsRef.current = ["a", "c", "d"];
    h.state.activeFileIdRef.current = "d";
    pending.resolve({ ok: true });
    await closing;
    expect(h.ports.saveWorkspaceState).toHaveBeenCalledWith({ openFileIds: ["c", "d"], activeFileId: "d" });
    expect(h.view.tabs).toEqual(["c", "d"]);
    expect(h.ports.openDocumentInWorkspace).not.toHaveBeenCalled();
    expect(h.events.at(-1)).toBe("refresh");
  });

  it("retains both file and tabs if the active draft cannot be saved", async () => {
    const h = harness();
    h.draft();
    h.ports.saveCurrentDocumentBeforeReplacement.mockResolvedValue(false);
    await h.close();
    expect(h.view.tabs).toEqual(["a", "b", "c"]);
    expect(h.events).toEqual(["flush"]);
    expect(h.ports.loadDocumentByFileIdWithRecovery).not.toHaveBeenCalled();
    expect(h.ports.deleteDocument).not.toHaveBeenCalled();
  });

  it("keeps draft files during MCP preview activity while permitting an ordinary tab close", async () => {
    const h = harness();
    h.draft();
    h.state.mcpPreviewBusyRef.current = true;
    await h.close();
    expect(h.view.tabs).toEqual(["a", "c"]);
    expect(h.ports.loadDocumentByFileIdWithRecovery).not.toHaveBeenCalled();
    expect(h.ports.deleteDocument).not.toHaveBeenCalled();
    expect(h.state.untouchedNewDocumentsRef.current.has("b")).toBe(true);
  });

  it.each(["read failure", "saved edit", "live edit", "eligibility removed"])(
    "keeps a draft file after %s during the read and applies normal close behavior",
    async (change) => {
      const h = harness();
      h.draft();
      const pending = deferred<DocumentLoadResult>();
      h.ports.loadDocumentByFileIdWithRecovery.mockReturnValue(pending.promise);
      const closing = h.close();
      await vi.waitFor(() => expect(h.ports.loadDocumentByFileIdWithRecovery).toHaveBeenCalled());
      const edited = { ...h.loaded.document, metadata: { ...h.loaded.document.metadata, title: "Keep this" } };
      if (change === "live edit") h.state.documentRef.current = edited;
      if (change === "eligibility removed") h.state.untouchedNewDocumentsRef.current.delete("b");
      pending.resolve(change === "read failure" ? { ok: false, error: "read failed" }
        : change === "saved edit" ? { ...h.loaded, document: edited } : h.loaded);
      await closing;
      expect(h.ports.deleteDocument).not.toHaveBeenCalled();
      expect(h.ports.openDocumentInWorkspace).toHaveBeenCalledWith("a", {
        nextOpenFileIds: ["a", "c"], status: "ja:status.tabClosed",
      });
    },
  );

  it.each(["revision changed", undefined])("leaves tabs and draft eligibility intact after a deletion failure (%s)", async (error) => {
    const h = harness();
    h.draft();
    h.ports.deleteDocument.mockResolvedValue({ ok: false, error });
    await h.close();
    expect(h.view).toMatchObject({ tabs: ["a", "b", "c"], error: true, status: error ?? "ja:status.deleteFailed" });
    expect(h.state.untouchedNewDocumentsRef.current.has("b")).toBe(true);
    expect(h.ports.forgetTabView).not.toHaveBeenCalled();
    expect(h.ports.refreshDocumentMetadatas).not.toHaveBeenCalled();
  });
});

describe("library document deletion", () => {
  it("retains the last library file", async () => {
    const h = harness(["a"], "a");
    await h.remove("a", ["a"]);
    expect(h.view.status).toBe("ja:status.lastDocumentStays");
    expect(h.ports.deleteDocument).not.toHaveBeenCalled();
  });

  it("refuses deletion when the metadata has no surviving document", async () => {
    const h = harness(["a"], "a");
    await h.remove("a", ["a", "a"]);
    expect(h.view).toMatchObject({ error: true, status: "ja:status.noDocumentToSwitchTo" });
    expect(h.ports.deleteDocument).not.toHaveBeenCalled();
  });

  it.each(["disk failure", undefined])("keeps the library and tabs on storage failure (%s)", async (error) => {
    const h = harness();
    h.ports.deleteDocument.mockResolvedValue({ ok: false, error });
    await h.remove();
    expect(h.view).toMatchObject({ tabs: ["a", "b", "c"], error: true, status: error ?? "ja:status.deleteFailed" });
    expect(h.ports.refreshDocumentMetadatas).not.toHaveBeenCalled();
    expect(h.ports.openDocumentInWorkspace).not.toHaveBeenCalled();
  });

  it.each([["a", "b", "c"], ["b"]])("refreshes the library before switching away from a deleted active file with tabs %j", async (...tabs) => {
    const h = harness(tabs, "b");
    const pending = deferred<void>();
    h.ports.refreshDocumentMetadatas.mockReturnValue(pending.promise);
    const deleting = h.remove();
    await vi.waitFor(() => expect(h.ports.refreshDocumentMetadatas).toHaveBeenCalled());
    expect(h.ports.openDocumentInWorkspace).not.toHaveBeenCalled();
    expect(h.ports.deleteDocument).toHaveBeenCalledWith("b");
    h.view.locale = "en";
    pending.resolve();
    await deleting;
    expect(h.ports.openDocumentInWorkspace).toHaveBeenCalledWith("a", {
      nextOpenFileIds: tabs.length > 1 ? ["a", "c"] : ["a"], saveCurrent: false, status: "en:status.deleted",
    });
  });

  it("persists tabs for an inactive deletion without replacing or saving the active document", async () => {
    const h = harness();
    await h.remove("c");
    expect(h.view).toMatchObject({ active: "b", tabs: ["a", "b"], status: "ja:status.deleted" });
    expect(h.ports.saveWorkspaceState).toHaveBeenCalledWith({ openFileIds: ["a", "b"], activeFileId: "b" });
    expect(h.events).toEqual(["delete", "refresh", "tabs", "workspace-save", "status"]);
    expect(h.ports.openDocumentInWorkspace).not.toHaveBeenCalled();
  });
});
