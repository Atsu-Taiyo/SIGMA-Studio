// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@/features/document";
import type { TextFlowSelectionBookmark } from "@/features/text-editing";
import * as navigation from "@/lib/app-navigation";
import { createTranslator } from "@/lib/i18n";
import * as storage from "@/lib/storage";
import { useWorkspaceDocumentCommands, type WorkspaceDocumentCommandOptions } from "./use-workspace-document-commands";

let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useWorkspaceDocumentCommands>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

function Probe({ options }: { options: WorkspaceDocumentCommandOptions }) {
  const result = useWorkspaceDocumentCommands(options);
  useLayoutEffect(() => { actions = result; });
  return null;
}

function render(options: WorkspaceDocumentCommandOptions) {
  act(() => root.render(<Probe options={options} />));
}

function record(fileId: string): storage.DocumentFileRecord {
  const document: SigmaDocument = {
    version: "2.0", docId: `${fileId}-doc`, metadata: { title: fileId },
    content: [{ type: "paragraph", id: `${fileId}-paragraph`, children: [] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  return {
    fileId, document,
    metadata: {
      fileId, docId: document.docId, workspaceId: "workspace", folderId: null,
      title: fileId, revision: 7, createdAt: "2026-09-09T00:00:00.000Z", updatedAt: "2026-09-09T00:00:00.000Z",
    },
  };
}

function fixture() {
  const original = record("original");
  const events: string[] = [];
  const saveWorkspace = vi.spyOn(storage, "saveWorkspaceState").mockImplementation(async () => { events.push("workspace"); return { ok: true }; });
  const options: WorkspaceDocumentCommandOptions = {
    deleteAiDataForDocument: vi.fn(async () => undefined),
    openFileIds: [original.fileId], activeFileId: original.fileId,
    documentMetadatas: [original.metadata], workspaceReady: true,
    embeddedHostRef: { current: undefined }, documentRef: { current: original.document },
    activeFileIdRef: { current: original.fileId }, openFileIdsRef: { current: [original.fileId] },
    untouchedNewDocumentsRef: { current: new Map() }, mcpPreviewBusyRef: { current: false },
    workspaceReadyRef: { current: true }, editorTabViewStateByFileIdRef: { current: new Map() },
    textSelectionBookmarkRef: { current: null }, cancelPendingAutosaveRef: { current: vi.fn() },
    flushOverlayChanges: vi.fn(() => { events.push("flush"); }),
    saveCurrentDocumentBeforeReplacement: vi.fn(async () => { events.push("save"); return true; }),
    saveCurrentDocumentRecord: vi.fn(async () => ({ ok: true })),
    rememberLeavingEditorTabViewState: vi.fn(() => { events.push("remember"); }),
    prepareIncomingEditorTabViewState: vi.fn(() => ({ selectedId: "restored", textSelection: null, scrollTop: 9, scrollLeft: 0 })),
    resetEditorDocument: vi.fn(() => { events.push("reset"); }),
    openDocumentInWorkspace: vi.fn(async () => undefined),
    saveWorkspaceState: (state) => storage.saveWorkspaceState(state),
    refreshDocumentMetadatas: vi.fn(async () => { events.push("refresh"); }),
    setOpenFileIds: vi.fn(), setActiveFileId: vi.fn(), setWorkspaceReady: vi.fn(),
    setActiveMenu: vi.fn(), setDocumentListOpen: vi.fn(), setSaveState: vi.fn(), setStatusMessage: vi.fn(),
    t: createTranslator("ja", "chrome"), tEditor: createTranslator("ja", "editor"),
  };
  return { options, original, events, saveWorkspace };
}

describe("workspace document commands", () => {
  it("stops creation, duplication and navigation when the save boundary refuses replacement", async () => {
    const f = fixture();
    vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockResolvedValue(false);
    const create = vi.spyOn(storage, "createNewDocument");
    const createFromDocument = vi.spyOn(storage, "createDocumentFromSigmaDocument");
    const duplicate = vi.spyOn(storage, "duplicateDocument");
    const navigate = vi.spyOn(navigation, "navigateToAppRoute").mockImplementation(() => undefined);
    render(f.options);

    await actions.createDocumentTab();
    await actions.createWhiteboardDocumentTab();
    await actions.duplicateActiveDocument();
    await actions.openWorkspaceScreen();

    expect(f.options.saveCurrentDocumentBeforeReplacement).toHaveBeenCalledTimes(4);
    expect(create).not.toHaveBeenCalled();
    expect(createFromDocument).not.toHaveBeenCalled();
    expect(duplicate).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
  });

  it("keeps new material and whiteboard creation in the current parent when permission is denied", async () => {
    const f = fixture();
    f.options.documentMetadatas[0].workspaceId = "shared-items";
    f.options.documentMetadatas[0].folderId = "catalog-shared-folder";
    const create = vi.spyOn(storage, "createNewDocument").mockRejectedValue(new Error("FORBIDDEN"));
    const whiteboard = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockRejectedValue(new Error("FORBIDDEN"));
    render(f.options);
    await actions.createDocumentTab();
    await actions.createWhiteboardDocumentTab();
    const location = { workspaceId: "shared-items", folderId: "catalog-shared-folder" };
    expect(create).toHaveBeenCalledExactlyOnceWith(undefined, location);
    expect(whiteboard).toHaveBeenCalledExactlyOnceWith(expect.any(Object), location);
    expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
    expect(f.options.untouchedNewDocumentsRef.current.size).toBe(0);
    expect(f.saveWorkspace).not.toHaveBeenCalled();
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.creationNotAllowed"));
  });

  it("does not fall back to a local create when the current parent metadata is unavailable", async () => {
    const f = fixture(); f.options.documentMetadatas = [];
    const create = vi.spyOn(storage, "createNewDocument");
    const whiteboard = vi.spyOn(storage, "createDocumentFromSigmaDocument");
    render(f.options);
    await actions.createDocumentTab(); await actions.createWhiteboardDocumentTab();
    expect(create).not.toHaveBeenCalled(); expect(whiteboard).not.toHaveBeenCalled();
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith("TARGET_UNAVAILABLE");
  });

  it("observes a host attached after render before running host-owned document commands", async () => {
    const f = fixture();
    render(f.options);
    f.options.embeddedHostRef.current = { document: f.original.document, onChange: vi.fn() };

    await actions.createDocumentTab();
    await actions.createWhiteboardDocumentTab();
    await actions.duplicateActiveDocument();
    await actions.openDocumentListDialog();
    await actions.deleteActiveDocument();
    await actions.openWorkspaceScreen();

    expect(f.options.setStatusMessage).toHaveBeenCalledTimes(6);
    expect(f.options.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
    expect(f.options.saveCurrentDocumentRecord).not.toHaveBeenCalled();
    expect(f.options.refreshDocumentMetadatas).not.toHaveBeenCalled();
    expect(f.saveWorkspace).not.toHaveBeenCalled();
  });

  it("restores the incoming view and revision before persisting tabs, then refreshes metadata", async () => {
    const f = fixture();
    const next = record("next");
    const selection: TextFlowSelectionBookmark = {
      anchor: { blockId: "next-paragraph", offset: 0, affinity: "after", kind: "text" },
      head: { blockId: "next-paragraph", offset: 0, affinity: "after", kind: "text" },
      preferredX: null,
    };
    vi.mocked(f.options.prepareIncomingEditorTabViewState).mockReturnValue({ selectedId: "next-paragraph", textSelection: selection, scrollTop: 20, scrollLeft: 0 });
    let completeSave!: () => void;
    f.saveWorkspace.mockImplementation(() => {
      f.events.push("workspace");
      return new Promise<{ ok: boolean }>((resolve) => { completeSave = () => resolve({ ok: true }); });
    });
    render(f.options);
    f.options.activeFileIdRef.current = "live-active-file";

    const pending = actions.openDocumentAsTab(next, "opened");
    expect(f.options.rememberLeavingEditorTabViewState).toHaveBeenCalledWith("live-active-file", "next");
    expect(f.options.resetEditorDocument).toHaveBeenCalledWith(next.document, "next-paragraph", 7);
    expect(f.options.textSelectionBookmarkRef.current).toBe(selection);
    expect(f.options.setOpenFileIds).toHaveBeenCalledWith(["original", "next"]);
    expect(f.options.refreshDocumentMetadatas).not.toHaveBeenCalled();
    completeSave();
    await pending;
    expect(f.events).toEqual(["remember", "reset", "workspace", "refresh"]);
    expect(f.options.setSaveState).toHaveBeenLastCalledWith("saved");
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith("opened");
  });

  it("tracks created drafts and reads the active file again after a pending duplication save", async () => {
    const f = fixture();
    const created = record("new");
    vi.spyOn(storage, "createNewDocument").mockResolvedValue(created);
    const duplicate = vi.spyOn(storage, "duplicateDocument").mockResolvedValue(record("copy"));
    render(f.options);
    await actions.createDocumentTab();
    expect(f.options.untouchedNewDocumentsRef.current.get("new")).toBe(created.document);
    expect(f.events).toEqual(["save", "remember", "reset", "workspace", "refresh"]);

    let allowSave!: (ok: boolean) => void;
    vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockReturnValue(new Promise((resolve) => { allowSave = resolve; }));
    const pending = actions.duplicateActiveDocument();
    f.options.activeFileIdRef.current = "active-after-save";
    allowSave(true);
    await pending;
    expect(duplicate).toHaveBeenCalledWith("active-after-save");
    expect(f.options.untouchedNewDocumentsRef.current.has("copy")).toBe(false);
  });

  it("passes observed revisions and live tab refs to untouched-draft deletion", async () => {
    const f = fixture();
    const draft = f.original;
    vi.spyOn(storage, "listSavedDocuments").mockResolvedValue([draft.metadata]);
    f.options.untouchedNewDocumentsRef.current.set(draft.fileId, draft.document);
    vi.spyOn(storage, "loadDocumentByFileIdWithRecovery").mockResolvedValue({ ok: true, document: draft.document, revision: 13, recoveryIssues: [] });
    const remove = vi.spyOn(storage, "deleteDocument").mockImplementation(async () => {
      f.options.openFileIdsRef.current = [draft.fileId, "arrived-during-delete"];
      return { ok: true };
    });
    render(f.options);
    await actions.closeDocumentTab(draft.fileId);
    expect(remove).toHaveBeenCalledWith(draft.fileId, { expectedRevision: 13 });
    expect(f.options.deleteAiDataForDocument).toHaveBeenCalledWith(draft.fileId);
    expect(f.options.openDocumentInWorkspace).toHaveBeenCalledWith("arrived-during-delete", {
      nextOpenFileIds: ["arrived-during-delete"], saveCurrent: false, status: f.options.tEditor("status.tabClosed"),
    });
    expect(f.options.untouchedNewDocumentsRef.current.has(draft.fileId)).toBe(false);
    expect(f.options.cancelPendingAutosaveRef.current).not.toHaveBeenCalled();
  });
});
