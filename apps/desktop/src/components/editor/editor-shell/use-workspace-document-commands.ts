"use client";

import { useLayoutEffect, type RefObject } from "react";
import { useStableCallback } from "@/lib/react/use-stable-callback";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";
import type { EditorSaveState } from "@/features/editor-state/types";
import type { TextFlowSelectionBookmark } from "@/features/text-editing";
import { navigateToAppRoute, registerAppNavigationGuard } from "@/lib/app-navigation";
import { createBlankDocument } from "@/lib/blank-document";
import type { Translate } from "@/lib/i18n";
import {
  createDocumentFromSigmaDocument,
  createNewDocument,
  deleteDocument,
  duplicateDocument,
  loadDocumentByFileIdWithRecovery,
  listSavedDocuments,
  type DocumentFileRecord,
  type DocumentMetadata,
} from "@/lib/storage";
import type { WorkspaceState } from "@/lib/storage";
import type { EmbeddedEditorHost } from "./document-lifecycle-types";
import { closeWorkspaceDocumentTab, deleteWorkspaceDocument, type DocumentTabOpenOptions } from "./document-tab-commands";
import type { EditorTabViewState, ResolvedEditorTabViewState } from "./editor-tab-view-state";
import { uniqueStringIds } from "./workspace-request";
import { duplicateNoticeOrigin, loadCreatedMaterialNotice, resolveNewMaterialDestination, type CreatedMaterialNotice } from "./new-material-destination";
import { duplicateFailureMessage } from "./duplicate-failure-message";
import { flushNewDocumentPageSetup } from "./new-document-page-setup-memory";
import { createMaterialFromTemplate } from "./create-material-from-template";
import type { TemplateItem } from "@/types/template";

export interface WorkspaceDocumentCommandOptions {
  deleteAiDataForDocument(fileId: string): Promise<void>;
  openFileIds: string[];
  activeFileId: string;
  documentMetadatas: DocumentMetadata[];
  workspaceReady: boolean;
  embeddedHostRef: RefObject<EmbeddedEditorHost | undefined>;
  documentRef: RefObject<SigmaDocument>;
  activeFileIdRef: RefObject<string>;
  openFileIdsRef: RefObject<string[]>;
  untouchedNewDocumentsRef: RefObject<Map<string, SigmaDocument>>;
  mcpPreviewBusyRef: RefObject<boolean>;
  workspaceReadyRef: RefObject<boolean>;
  editorTabViewStateByFileIdRef: RefObject<Map<string, EditorTabViewState>>;
  textSelectionBookmarkRef: RefObject<TextFlowSelectionBookmark | null>;
  cancelPendingAutosaveRef: RefObject<() => void>;
  flushOverlayChanges(): void;
  saveCurrentDocumentBeforeReplacement(): Promise<boolean>;
  saveCurrentDocumentRecord(): Promise<unknown>;
  rememberLeavingEditorTabViewState(leavingFileId: string | null, nextFileId: string): void;
  prepareIncomingEditorTabViewState(document: SigmaDocument, fileId: string): ResolvedEditorTabViewState;
  resetEditorDocument(document: SigmaDocument, selectedId?: string | null, observedRevision?: number | null): void;
  openDocumentInWorkspace(fileId: string, options?: DocumentTabOpenOptions): Promise<void>;
  saveWorkspaceState(state: WorkspaceState): Promise<unknown>;
  refreshDocumentMetadatas(): Promise<unknown>;
  setOpenFileIds(fileIds: string[]): void;
  setActiveFileId(fileId: string): void;
  setWorkspaceReady(ready: boolean): void;
  setActiveMenu(menu: null): void;
  setDocumentListOpen(open: boolean): void;
  setSaveState(state: EditorSaveState): void;
  setStatusMessage(message: string): void;
  /** 新規教材を作ったあと、実際に作った場所 (ワークスペースとフォルダの階層) を示す。 */
  showCreatedMaterialLocation(notice: CreatedMaterialNotice): void;
  t: Translate<"chrome">;
  tEditor: Translate<"editor">;
}

/** 文書コマンドの配送。保存・切替・履歴の所有者は呼び出し元の境界に残す。 */
export function useWorkspaceDocumentCommands({
  deleteAiDataForDocument,
  openFileIds, activeFileId, documentMetadatas, workspaceReady, embeddedHostRef,
  documentRef, activeFileIdRef, openFileIdsRef, untouchedNewDocumentsRef,
  mcpPreviewBusyRef, workspaceReadyRef, editorTabViewStateByFileIdRef,
  textSelectionBookmarkRef, cancelPendingAutosaveRef, flushOverlayChanges,
  saveCurrentDocumentBeforeReplacement, saveCurrentDocumentRecord,
  rememberLeavingEditorTabViewState, prepareIncomingEditorTabViewState,
  resetEditorDocument, openDocumentInWorkspace, refreshDocumentMetadatas,
  saveWorkspaceState,
  setOpenFileIds, setActiveFileId, setWorkspaceReady, setActiveMenu,
  setDocumentListOpen, setSaveState, setStatusMessage, showCreatedMaterialLocation, t, tEditor,
}: WorkspaceDocumentCommandOptions) {

  const prepareExternalNavigation = useStableCallback(async () => {
    if (embeddedHostRef.current || !workspaceReadyRef.current) return false;
    flushOverlayChanges();
    return saveCurrentDocumentBeforeReplacement();
  });
  useLayoutEffect(() => {
    if (embeddedHostRef.current) return;
    return registerAppNavigationGuard(prepareExternalNavigation);
  }, [embeddedHostRef, prepareExternalNavigation]);

  const openWorkspaceScreen = async () => {
    setActiveMenu(null);
    if (embeddedHostRef.current) {
      setStatusMessage(tEditor("status.embeddedHostOwnsDocuments"));
      return;
    }
    if (workspaceReady) {
      setSaveState("saving");
      setStatusMessage(tEditor("status.openingWorkspace"));
      flushOverlayChanges();
      if (!(await saveCurrentDocumentBeforeReplacement())) return;
    }

    navigateToAppRoute("/workspace");
  };

  const openDocumentAsTab = async (record: DocumentFileRecord, status: string) => {
    const nextOpenFileIds = uniqueStringIds([...openFileIds, record.fileId]);
    rememberLeavingEditorTabViewState(activeFileIdRef.current, record.fileId);
    const restoredView = prepareIncomingEditorTabViewState(record.document, record.fileId);
    resetEditorDocument(record.document, restoredView.selectedId, record.metadata.revision);
    if (restoredView.textSelection) {
      textSelectionBookmarkRef.current = restoredView.textSelection;
    }
    setOpenFileIds(nextOpenFileIds);
    setActiveFileId(record.fileId);
    await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: record.fileId });
    await refreshDocumentMetadatas();
    setSaveState("saved");
    setStatusMessage(status);
  };

  /**
   * 新規教材・新規ホワイトボード。そのまま押したときは直前の教材と同じワークスペース (同じフォルダ) に、
   * メニューでワークスペースを選んだときはそこに作り、作った場所をダイアログで示す
   * (決め方は `new-material-destination.ts`)。
   * `template` を渡すと、空の教材ではなくそのテンプレートの教材 (用紙設定ごと) から作る。作成先の決め方は同じ。
   */
  const createMaterialTab = async (
    kind: Exclude<CreatedMaterialNotice["kind"], "duplicate">,
    chosenWorkspaceId?: string,
    template?: TemplateItem,
  ) => {
    setActiveMenu(null);
    setDocumentListOpen(false);
    if (embeddedHostRef.current) {
      setStatusMessage(tEditor(kind === "whiteboard" ? "status.embeddedHostOwnsWhiteboardCreate" : "status.embeddedHostOwnsCreate"));
      return;
    }
    try {
      if (workspaceReady && !(await saveCurrentDocumentBeforeReplacement())) {
        return;
      }
      const current = documentMetadatas.find(item => item.fileId === activeFileIdRef.current);
      if (workspaceReady && !current) throw new Error("TARGET_UNAVAILABLE");
      const destination = await resolveNewMaterialDestination(current, chosenWorkspaceId);
      // 新しい教材は、いま開いている教材の用紙設定で作る (main が覚えた値を当てる)。
      // テンプレートからのときは、テンプレート自身の用紙設定をそのまま使うので覚えた値は渡さない。
      if (kind === "material" && !template) await flushNewDocumentPageSetup();
      const created = template
        ? await createMaterialFromTemplate(template, destination.location)
        : kind === "whiteboard"
          ? await createDocumentFromSigmaDocument({
            ...createBlankDocument(t("tabs.untitledWhiteboard")),
            content: [],
            pageLayout: getDefaultPageLayout("whiteboard"),
          }, destination.location)
          : await createNewDocument(undefined, destination.location);
      // 何も書かずに閉じた空の教材は消す。テンプレートから作った教材は中身があるので、閉じても残す
      // (ワークスペース画面から作ったときと同じ)。
      if (!template) untouchedNewDocumentsRef.current.set(created.fileId, created.document);
      await openDocumentAsTab(created, tEditor(template ? "status.templateDocumentCreated" : kind === "whiteboard" ? "status.whiteboardCreated" : "status.documentCreated"));
      showCreatedMaterialLocation(await loadCreatedMaterialNotice(created.metadata, { kind, origin: destination.origin }));
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error && error.message.includes("FORBIDDEN") ? tEditor("status.creationNotAllowed") : error instanceof Error ? error.message : tEditor(kind === "whiteboard" ? "status.whiteboardCreateFailed" : "status.createFailed"));
    }
  };

  const createDocumentTab = () => createMaterialTab("material");
  /** ホバーで開くメニューから、作成先のワークスペースを選んで空の教材を作る。 */
  const createDocumentTabInWorkspace = (workspaceId: string) => createMaterialTab("material", workspaceId);
  const createWhiteboardDocumentTab = () => createMaterialTab("whiteboard");
  /** 「テンプレートから新規」。用紙設定・ヘッダー/フッター・図形ごと、テンプレートの教材を新しいタブで開く。 */
  const createDocumentTabFromTemplate = (template: TemplateItem) => createMaterialTab("material", undefined, template);

  /**
   * 複製して開く。共有教材の複製が複製元と違う場所や保存先 (このPC) になったときは、作った場所を示す (#250)。
   * 失敗しても複製元は変わらないので、理由と次の操作を日本語で示すだけにする。
   * 複製する教材は保存を待った後に決める (保存の間に開いている教材が変わることがある)。
   */
  const duplicateAndOpen = async (resolveFileId: () => string, beforeOpen?: () => void) => {
    try {
      if (!(await saveCurrentDocumentBeforeReplacement())) {
        return;
      }
      const fileId = resolveFileId();
      const source = documentMetadatas.find((item) => item.fileId === fileId);
      const duplicated = await duplicateDocument(fileId);
      beforeOpen?.();
      await openDocumentAsTab(duplicated, tEditor("status.duplicated"));
      const origin = duplicateNoticeOrigin(source, duplicated.metadata);
      if (origin) showCreatedMaterialLocation(await loadCreatedMaterialNotice(duplicated.metadata, { kind: "duplicate", origin }));
    } catch (error) {
      setSaveState("error");
      setStatusMessage(duplicateFailureMessage(error, tEditor));
    }
  };

  const duplicateActiveDocument = async () => {
    setActiveMenu(null);
    if (embeddedHostRef.current) {
      setStatusMessage(tEditor("status.embeddedHostOwnsDuplicate"));
      return;
    }
    await duplicateAndOpen(() => activeFileIdRef.current);
  };

  const openDocumentListDialog = async () => {
    setActiveMenu(null);
    if (embeddedHostRef.current) {
      setStatusMessage(tEditor("status.embeddedHostOwnsList"));
      return;
    }
    if (workspaceReady) {
      await saveCurrentDocumentRecord();
    }
    await refreshDocumentMetadatas();
    setDocumentListOpen(true);
  };

  const closeDocumentTab = (fileId: string) => closeWorkspaceDocumentTab(fileId, {
    openFileIds,
    activeFileId,
    untouchedNewDocumentsRef,
    mcpPreviewBusyRef,
    activeFileIdRef,
    openFileIdsRef,
    documentRef,
  }, {
    flushOverlayChanges,
    saveCurrentDocumentBeforeReplacement,
    loadDocumentByFileIdWithRecovery,
    deleteDocument,
    forgetTabView: (id) => { editorTabViewStateByFileIdRef.current.delete(id); },
    cancelPendingAutosave: () => cancelPendingAutosaveRef.current(),
    markWorkspaceNotReady: () => {
      workspaceReadyRef.current = false;
      setWorkspaceReady(false);
    },
    navigateToWorkspace: () => navigateToAppRoute("/workspace"),
    canCleanupUntouchedDocument: async (fileId) => {
      const metadata = (await listSavedDocuments()).find((item) => item.fileId === fileId);
      return Boolean(metadata && !metadata.sharing && !metadata.sharingPending);
    },
    deleteAiDataForDocument,
    openDocumentInWorkspace,
    setOpenFileIds,
    saveWorkspaceState,
    refreshDocumentMetadatas,
    setSaveState,
    setStatusMessage,
    tEditor,
  });

  const openDocumentFromList = async (fileId: string) => {
    setDocumentListOpen(false);
    await openDocumentInWorkspace(fileId, { status: tEditor("status.opened") });
  };

  const duplicateDocumentFromList = (fileId: string) => duplicateAndOpen(() => fileId, () => setDocumentListOpen(false));

  const deleteDocumentFromList = (fileId: string) => deleteWorkspaceDocument(fileId, {
    documentMetadatas,
    openFileIds,
    activeFileId,
  }, {
    deleteDocument,
    openDocumentInWorkspace,
    setOpenFileIds,
    saveWorkspaceState,
    refreshDocumentMetadatas,
    setSaveState,
    setStatusMessage,
    tEditor,
  });

  const deleteActiveDocument = async () => {
    setActiveMenu(null);
    if (embeddedHostRef.current) {
      setStatusMessage(tEditor("status.embeddedHostOwnsDelete"));
      return;
    }
    await deleteDocumentFromList(activeFileId);
  };
  return {
    openWorkspaceScreen, openDocumentAsTab, createDocumentTab, createDocumentTabInWorkspace, createWhiteboardDocumentTab, createDocumentTabFromTemplate, duplicateActiveDocument, openDocumentListDialog, closeDocumentTab, openDocumentFromList, duplicateDocumentFromList, deleteDocumentFromList, deleteActiveDocument
  };
}
