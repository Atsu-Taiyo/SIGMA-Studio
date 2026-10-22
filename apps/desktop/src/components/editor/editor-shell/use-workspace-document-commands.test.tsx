// @vitest-environment happy-dom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SigmaDocument } from "@/features/document";
import type { TextFlowSelectionBookmark } from "@/features/text-editing";
import * as navigation from "@/lib/app-navigation";
import { createTranslator } from "@/lib/i18n";
import * as storage from "@/lib/storage";
import * as workspaceRepository from "@/lib/workspace-repository";
import type { WorkspaceOverview } from "@/lib/workspace-repository";
import type { TemplateItem } from "@/types/template";
import { customPageSetupDocument } from "../../../../tests/helpers/template-fixtures";
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

const stamp = "2026-10-16T00:00:00.000Z";
const editorCapabilities = {
  read: true, editDocument: true, createChildren: true, rename: false, move: false, deleteDescendants: false,
  invite: false, manageEditorViewer: false, appointAdmin: false, stopRootShare: false, deleteRootShare: false,
  restoreDocument: false, startHierarchyShare: false,
};
function sharedFolderSharing(createChildren: boolean) {
  return {
    target: { kind: "folder" as const, catalogNodeId: "node" as never }, ownerId: "owner", createdBy: "owner",
    role: createChildren ? "editor" as const : "viewer" as const, capabilities: { ...editorCapabilities, editDocument: createChildren, createChildren },
    state: "active" as const, placement: "incoming" as const, isShareRoot: true,
  };
}

/** 作成先を決めるときと作成後に場所を説明するときに読む一覧。 */
function mockOverview(overview: Partial<WorkspaceOverview>) {
  return vi.spyOn(workspaceRepository, "listWorkspaceOverview").mockResolvedValue({
    state: "ready",
    overview: {
      activeWorkspaceId: "workspace", files: [], catalog: { state: "ready", actorId: "me", revision: 1 },
      workspaces: [{ id: "workspace", name: "マイ教材", createdAt: stamp, updatedAt: stamp }],
      folders: [],
      ...overview,
    },
  });
}

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
    showCreatedMaterialLocation: vi.fn(),
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
    // 一覧の上では編集できる共有フォルダ。作る瞬間に保存先が断ったら、別の場所 (このPC) へは作らない。
    mockOverview({
      activeWorkspaceId: "shared-items",
      workspaces: [{ id: "workspace", name: "マイ教材", createdAt: stamp, updatedAt: stamp }, { id: "shared-items", name: "共有アイテム", createdAt: stamp, updatedAt: stamp }],
      folders: [{ id: "catalog-shared-folder", workspaceId: "shared-items", parentFolderId: null, name: "共有フォルダ", fileCount: 0, createdAt: stamp, updatedAt: stamp, sharing: sharedFolderSharing(true) }],
    });
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
    expect(f.options.showCreatedMaterialLocation).not.toHaveBeenCalled();
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

  it("creates a new material in the previous material's workspace and folder, then shows the saved location", async () => {
    const f = fixture();
    f.options.documentMetadatas[0].folderId = "unit";
    const folders = [
      { id: "grade", workspaceId: "workspace", parentFolderId: null, name: "2年", fileCount: 0, createdAt: stamp, updatedAt: stamp },
      { id: "unit", workspaceId: "workspace", parentFolderId: "grade", name: "関数", fileCount: 1, createdAt: stamp, updatedAt: stamp },
    ];
    const overview = mockOverview({ folders });
    const created = record("new");
    created.metadata.folderId = "unit";
    const create = vi.spyOn(storage, "createNewDocument").mockResolvedValue(created);
    render(f.options);
    await actions.createDocumentTab();
    expect(create).toHaveBeenCalledExactlyOnceWith(undefined, { workspaceId: "workspace", folderId: "unit" });
    // 作成先を決めるときと、作った場所を説明するとき (作った教材のワークスペース) に読む。
    expect(overview.mock.calls).toEqual([["workspace"], ["workspace"]]);
    // このテストはブラウザ版の保存先で動く (desktopAPI が無い) ので、共有でない教材は「このブラウザ」。
    expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "material", title: "new", workspaceName: "マイ教材", folderPath: ["2年", "関数"], storage: "browser", origin: "previous",
    }));
  });

  it("creates in the default local workspace when the previous material's shared folder is read-only, and says so", async () => {
    const f = fixture();
    f.options.documentMetadatas[0].workspaceId = "shared-items";
    f.options.documentMetadatas[0].folderId = "catalog-shared-folder";
    mockOverview({
      workspaces: [{ id: "workspace", name: "マイ教材", createdAt: stamp, updatedAt: stamp }, { id: "shared-items", name: "共有アイテム", createdAt: stamp, updatedAt: stamp }],
      folders: [{ id: "catalog-shared-folder", workspaceId: "shared-items", parentFolderId: null, name: "閲覧だけ", fileCount: 0, createdAt: stamp, updatedAt: stamp, sharing: sharedFolderSharing(false) }],
    });
    const whiteboard = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockResolvedValue(record("board"));
    render(f.options);
    await actions.createWhiteboardDocumentTab();
    expect(whiteboard).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ content: [] }), { workspaceId: "workspace", folderId: null });
    expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "whiteboard", workspaceName: "マイ教材", folderPath: [], origin: "fallback",
    }));
  });

  it("creates in the workspace chosen from the menu at its root, and refuses one that no longer accepts materials", async () => {
    const f = fixture();
    f.options.documentMetadatas[0].folderId = "unit";
    mockOverview({
      workspaces: [
        { id: "workspace", name: "マイ教材", createdAt: stamp, updatedAt: stamp },
        { id: "other", name: "別のワークスペース", createdAt: stamp, updatedAt: stamp },
        { id: "viewer", name: "閲覧だけ", createdAt: stamp, updatedAt: stamp, sharing: sharedFolderSharing(false) },
      ],
      folders: [{ id: "unit", workspaceId: "workspace", parentFolderId: null, name: "関数", fileCount: 1, createdAt: stamp, updatedAt: stamp }],
    });
    const created = record("chosen");
    created.metadata.workspaceId = "other";
    const create = vi.spyOn(storage, "createNewDocument").mockResolvedValue(created);
    render(f.options);
    await actions.createDocumentTabInWorkspace("other");
    expect(create).toHaveBeenCalledExactlyOnceWith(undefined, { workspaceId: "other", folderId: null });
    expect(f.options.showCreatedMaterialLocation).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceName: "別のワークスペース", folderPath: [], origin: "chosen" }));

    await actions.createDocumentTabInWorkspace("viewer");
    expect(create).toHaveBeenCalledTimes(1);
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.creationNotAllowed"));
  });

  describe("new material from a template", () => {
    function savedTemplate(): TemplateItem {
      return { version: 1, id: "template", workspaceId: "template-source", name: "B5横プリント", document: customPageSetupDocument(), createdAt: stamp, updatedAt: stamp };
    }

    it("creates a file from the whole template in the previous material's folder and opens it as a tab", async () => {
      const f = fixture();
      f.options.documentMetadatas[0].folderId = "unit";
      const overview = mockOverview({
        folders: [{ id: "unit", workspaceId: "workspace", parentFolderId: null, name: "関数", fileCount: 1, createdAt: stamp, updatedAt: stamp }],
      });
      const template = savedTemplate();
      const created = record("from-template");
      created.metadata.folderId = "unit";
      const fromDocument = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockResolvedValue(created);
      const blank = vi.spyOn(storage, "createNewDocument");
      render(f.options);

      await actions.createDocumentTabFromTemplate(template);

      // 作成先はテンプレートを保存したワークスペース (template-source) ではなく、開いていた教材の場所。
      expect(fromDocument).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ pageLayout: template.document.pageLayout, content: template.document.content }),
        { workspaceId: "workspace", folderId: "unit" },
      );
      expect(fromDocument.mock.calls[0][0].docId).not.toBe(template.document.docId);
      expect(fromDocument.mock.calls[0][0].metadata.title).toBe("B5横プリント");
      expect(blank).not.toHaveBeenCalled();
      // 開いていた教材を保存してから新しいタブへ移り、ワークスペースの開いているタブに足す。
      expect(f.events).toEqual(["save", "remember", "reset", "workspace", "refresh"]);
      expect(f.options.resetEditorDocument).toHaveBeenCalledWith(created.document, "restored", 7);
      expect(f.options.setOpenFileIds).toHaveBeenCalledWith(["original", "from-template"]);
      expect(f.options.setActiveFileId).toHaveBeenCalledWith("from-template");
      expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.templateDocumentCreated"));
      // 中身のある教材なので、何も書かずに閉じても消さない。
      expect(f.options.untouchedNewDocumentsRef.current.size).toBe(0);
      expect(overview).toHaveBeenCalled();
      expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        kind: "material", title: "from-template", workspaceName: "マイ教材", origin: "previous",
      }));
    });

    it("falls back to the default local workspace like a blank material when the current folder is read-only", async () => {
      const f = fixture();
      f.options.documentMetadatas[0].workspaceId = "shared-items";
      f.options.documentMetadatas[0].folderId = "catalog-shared-folder";
      mockOverview({
        workspaces: [{ id: "workspace", name: "マイ教材", createdAt: stamp, updatedAt: stamp }, { id: "shared-items", name: "共有アイテム", createdAt: stamp, updatedAt: stamp }],
        folders: [{ id: "catalog-shared-folder", workspaceId: "shared-items", parentFolderId: null, name: "閲覧だけ", fileCount: 0, createdAt: stamp, updatedAt: stamp, sharing: sharedFolderSharing(false) }],
      });
      const fromDocument = vi.spyOn(storage, "createDocumentFromSigmaDocument").mockResolvedValue(record("from-template"));
      render(f.options);

      await actions.createDocumentTabFromTemplate(savedTemplate());

      expect(fromDocument).toHaveBeenCalledExactlyOnceWith(expect.any(Object), { workspaceId: "workspace", folderId: null });
      expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "material", origin: "fallback" }));
    });

    it("opens nothing when the save boundary refuses, the host owns documents, or the destination refuses", async () => {
      const f = fixture();
      const fromDocument = vi.spyOn(storage, "createDocumentFromSigmaDocument");
      mockOverview({});
      render(f.options);

      vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockResolvedValueOnce(false);
      await actions.createDocumentTabFromTemplate(savedTemplate());
      expect(fromDocument).not.toHaveBeenCalled();

      f.options.embeddedHostRef.current = { document: f.original.document, onChange: vi.fn() };
      await actions.createDocumentTabFromTemplate(savedTemplate());
      expect(fromDocument).not.toHaveBeenCalled();
      expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.embeddedHostOwnsCreate"));
      f.options.embeddedHostRef.current = undefined;

      fromDocument.mockRejectedValueOnce(new Error("FORBIDDEN"));
      await actions.createDocumentTabFromTemplate(savedTemplate());
      expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.creationNotAllowed"));
      expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
      expect(f.saveWorkspace).not.toHaveBeenCalled();
      expect(f.options.showCreatedMaterialLocation).not.toHaveBeenCalled();
    });
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
    mockOverview({});
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

  // Issue #250: a failed duplicate of a cloud material showed "Error invoking remote method ...".
  it("explains a failed duplicate in Japanese and stays on the original, from the menu and the list", async () => {
    const f = fixture();
    const duplicate = vi.spyOn(storage, "duplicateDocument")
      .mockRejectedValueOnce(new Error("Error invoking remote method 'storage:duplicate-file': Error: CATALOG_OFFLINE"))
      .mockRejectedValueOnce(new Error("Error invoking remote method 'storage:duplicate-file': Error: TARGET_UNAVAILABLE"));
    render(f.options);
    await actions.duplicateActiveDocument();
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.duplicateOffline"));
    await actions.duplicateDocumentFromList("original");
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.duplicateSourceUnavailable"));
    expect(duplicate).toHaveBeenCalledTimes(2);
    expect(f.options.setSaveState).toHaveBeenLastCalledWith("error");
    expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
    expect(f.options.setDocumentListOpen).not.toHaveBeenCalled();
    expect(f.options.showCreatedMaterialLocation).not.toHaveBeenCalled();
    expect(vi.mocked(f.options.setStatusMessage).mock.calls.flat().join("\n")).not.toContain("invoking");
  });

  it("shows where a shared material's copy went when it could not be placed next to the original", async () => {
    const f = fixture();
    // A material shared with me on its own: the copy becomes my own material on this PC.
    Object.assign(f.options.documentMetadatas[0], { workspaceId: "shared-items", folderId: null, sharing: { ...sharedFolderSharing(false), target: { kind: "document", catalogNodeId: "node" } } });
    mockOverview({});
    const copy = record("copy");
    vi.spyOn(storage, "duplicateDocument").mockResolvedValue(copy);
    render(f.options);
    await actions.duplicateDocumentFromList("original");
    expect(f.options.setDocumentListOpen).toHaveBeenCalledWith(false);
    expect(f.options.resetEditorDocument).toHaveBeenCalledWith(copy.document, "restored", 7);
    expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: "duplicate", title: "copy", workspaceName: "マイ教材", folderPath: [], origin: "fallback",
    }));
  });

  it("adds no notice for a copy beside a local original, and says a copy of my shared material is not shared", async () => {
    const f = fixture();
    mockOverview({});
    vi.spyOn(storage, "duplicateDocument").mockResolvedValue(record("copy"));
    render(f.options);
    await actions.duplicateActiveDocument();
    expect(f.options.showCreatedMaterialLocation).not.toHaveBeenCalled();
    expect(f.options.setStatusMessage).toHaveBeenLastCalledWith(f.options.tEditor("status.duplicated"));

    f.options.documentMetadatas[0].sharing = { ...sharedFolderSharing(true), target: { kind: "document", catalogNodeId: "node" as never }, placement: "owned" };
    render(f.options);
    await actions.duplicateActiveDocument();
    expect(f.options.showCreatedMaterialLocation).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ kind: "duplicate", origin: "previous" }));
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

it("external links flush through the existing save boundary and retain the editor on failed saves", async () => {
  const f = fixture();
  render(f.options);
  expect(await navigation.prepareAppNavigation()).toBe(true);
  expect(f.events).toEqual(["flush", "save"]);
  vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockResolvedValue(false);
  expect(await navigation.prepareAppNavigation()).toBe(false);
  expect(f.options.resetEditorDocument).not.toHaveBeenCalled();
  f.options.workspaceReadyRef.current = false;
  vi.mocked(f.options.saveCurrentDocumentBeforeReplacement).mockClear();
  expect(await navigation.prepareAppNavigation()).toBe(false);
  expect(f.options.saveCurrentDocumentBeforeReplacement).not.toHaveBeenCalled();
});
