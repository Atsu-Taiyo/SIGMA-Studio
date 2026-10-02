"use client";

import { type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import { type ResolvedEditorTabViewState } from "@/components/editor/editor-shell/editor-tab-view-state";
import { uniqueStringIds } from "@/components/editor/editor-shell/workspace-request";
import { ensurePageLayout,repairDuplicateTopLevelIds,type SigmaDocument } from "@/features/document";
import { type TextFlowSelectionBookmark } from "@/features/text-editing";
import type { StorageResult } from "@/lib/storage";
import { useCallback } from "react";
import { DOCUMENT_BLOCK_OPERATION_PORTS } from "./document-operation-ports";
import { type DocumentTabOpenOptions } from "./document-tab-commands";
import { tEditor } from "./editor-translations";
import type { SaveState } from "./types";

import { useEditorOwnerLifetime } from "./use-editor-owner-lifetime";

interface WorkspaceNavigationPorts {
  openFileIds: string[];
  workspaceReady: boolean;
  getActiveFileId: () => string;
  setLoadingFileId: (fileId: string | null) => void;
  saveCurrentDocumentBeforeReplacement: () => Promise<boolean>;
  rememberLeavingEditorTabViewState: (leavingFileId: string | null, nextFileId: string) => void;
  loadWorkspaceDocument: (fileId: string) => Promise<{ document: SigmaDocument; observedRevision: number } | null>;
  showRecordedDocumentOpenFailure: (fileId: string) => DocumentOpenFailure | null;
  enterDocumentOpenFailureState: (failure: DocumentOpenFailure, fileIds: string[]) => Promise<void>;
  prepareIncomingEditorTabViewState: (document: SigmaDocument, fileId: string) => ResolvedEditorTabViewState;
  resetEditorDocument: (document: SigmaDocument, selectedId?: string | null, revision?: number | null) => void;
  restoreTextSelection: (selection: TextFlowSelectionBookmark) => void;
  setOpenFileIds: (fileIds: string[]) => void;
  setActiveFileId: (fileId: string) => void;
  saveWorkspaceState: (state: { openFileIds: string[]; activeFileId: string }) => Promise<StorageResult>;
  refreshDocumentMetadatas: () => Promise<void>;
  setSaveState: (state: SaveState) => void;
  setStatusMessage: (message: string) => void;
}
export function useWorkspaceDocumentNavigation({ openFileIds, workspaceReady, getActiveFileId, setLoadingFileId, saveCurrentDocumentBeforeReplacement, rememberLeavingEditorTabViewState, loadWorkspaceDocument, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, prepareIncomingEditorTabViewState, resetEditorDocument, restoreTextSelection, setOpenFileIds, setActiveFileId, saveWorkspaceState, refreshDocumentMetadatas, setSaveState, setStatusMessage }: WorkspaceNavigationPorts) {
  const captureLifetime = useEditorOwnerLifetime();
  const openDocumentInWorkspace = useCallback(async (
    fileId: string,
    options?: DocumentTabOpenOptions,
  ) => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    const nextOpenFileIds = uniqueStringIds([...(options?.nextOpenFileIds ?? openFileIds), fileId]);

    setLoadingFileId(fileId);
    try {
      if (workspaceReady && options?.saveCurrent !== false) {
        if (!(await saveCurrentDocumentBeforeReplacement())) {
          return;
        }
      }

      if (!isCurrent()) return;
      // 読み込み成否に関わらず、今の教材から離れる直前の位置を残す。
      rememberLeavingEditorTabViewState(getActiveFileId(), fileId);

      const loaded = await loadWorkspaceDocument(fileId);
      if (!isCurrent()) return;
      if (!loaded) {
        // 教材の中身が原因なら、別教材へ切り替えずタブを開いて原因を表示する。
        const failure = showRecordedDocumentOpenFailure(fileId);
        if (failure) {
          await enterDocumentOpenFailureState(failure, nextOpenFileIds);
          return;
        }
        setSaveState("error");
        setStatusMessage(tEditor("status.loadFailed"));
        await refreshDocumentMetadatas();
        return;
      }

      const migrated = repairDuplicateTopLevelIds(
        ensurePageLayout(loaded.document),
        DOCUMENT_BLOCK_OPERATION_PORTS,
      );
      const restoredView = prepareIncomingEditorTabViewState(migrated, fileId);
      resetEditorDocument(migrated, restoredView.selectedId, loaded.observedRevision);
      if (restoredView.textSelection) {
        restoreTextSelection(restoredView.textSelection);
      }
      setOpenFileIds(nextOpenFileIds);
      setActiveFileId(fileId);
      options?.onOpened?.();
      await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: fileId });
      await refreshDocumentMetadatas();
      if (!isCurrent()) return;
      setSaveState("saved");
      setStatusMessage(options?.status ?? tEditor("status.opened"));
    } finally {
      if (isCurrent()) setLoadingFileId(null);
    }
  }, [
    captureLifetime,
    enterDocumentOpenFailureState,
    loadWorkspaceDocument,
    openFileIds,
    prepareIncomingEditorTabViewState,
    refreshDocumentMetadatas,
    rememberLeavingEditorTabViewState,
    resetEditorDocument,
    saveWorkspaceState,
    saveCurrentDocumentBeforeReplacement,
    setSaveState,
    setStatusMessage,
    showRecordedDocumentOpenFailure,
    workspaceReady,
    getActiveFileId,
    restoreTextSelection,
    setActiveFileId,
    setOpenFileIds,
    setLoadingFileId,
  ]);

  return openDocumentInWorkspace;
}
