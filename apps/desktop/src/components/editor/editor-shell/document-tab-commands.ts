import type { SigmaDocument } from "@/features/document";
import type { DocumentLoadResult, StorageResult, WorkspaceState } from "@/lib/runtime/types";

import { isUntouchedNewDocument } from "./new-document-draft";

export interface DocumentTabOpenOptions {
  nextOpenFileIds?: string[];
  status?: string;
  saveCurrent?: boolean;
  /** Adopt pane state only after the target document has loaded successfully. */
  onOpened?: () => void;
}

interface DocumentTabs {
  openFileIds: string[];
  activeFileId: string;
}

type TabMessageKey =
  | "status.deleteFailed"
  | "status.tabClosed"
  | "status.lastTabStays"
  | "status.deleted";

interface DocumentTabPorts {
  deleteDocument(fileId: string, options?: { expectedRevision: number }): Promise<StorageResult>;
  setOpenFileIds(fileIds: string[]): void;
  saveWorkspaceState(state: WorkspaceState): Promise<unknown>;
  openDocumentInWorkspace(fileId: string, options?: DocumentTabOpenOptions): Promise<void>;
  refreshDocumentMetadatas(): Promise<unknown>;
  setSaveState(state: "error"): void;
  setStatusMessage(message: string): void;
  tEditor(key: TabMessageKey): string;
}

/** Mutable values belong to the shell; this boundary does not own React state. */
interface CurrentValue<T> { current: T }

interface CloseDocumentTabState extends DocumentTabs {
  untouchedNewDocumentsRef: CurrentValue<Map<string, SigmaDocument>>;
  mcpPreviewBusyRef: CurrentValue<boolean>;
  activeFileIdRef: CurrentValue<string>;
  openFileIdsRef: CurrentValue<string[]>;
  documentRef: CurrentValue<SigmaDocument>;
}

interface CloseDocumentTabPorts extends DocumentTabPorts {
  canCleanupUntouchedDocument?(fileId: string): Promise<boolean>;
  flushOverlayChanges(): void;
  saveCurrentDocumentBeforeReplacement(): Promise<boolean>;
  loadDocumentByFileIdWithRecovery(fileId: string): Promise<DocumentLoadResult>;
  forgetTabView(fileId: string): void;
  cancelPendingAutosave(): void;
  markWorkspaceNotReady(): void;
  /** Leave for the workspace screen; `openFileIds` are the editor tabs that remain. */
  navigateToWorkspace(openFileIds: string[]): void;
  deleteAiDataForDocument(fileId: string): Promise<void>;
}

/**
 * Close a tab and, only for an untouched newly created document, remove its file.
 * Ordinary tabs use the render's captured list. Draft deletion deliberately reads
 * current values again after each await, then deletes the revision that was read.
 * Keep those two observation boundaries distinct during asynchronous operations.
 */
export async function closeWorkspaceDocumentTab(
  fileId: string,
  {
    openFileIds, activeFileId, untouchedNewDocumentsRef, mcpPreviewBusyRef,
    activeFileIdRef, openFileIdsRef, documentRef,
  }: CloseDocumentTabState,
  {
    canCleanupUntouchedDocument, flushOverlayChanges, saveCurrentDocumentBeforeReplacement, loadDocumentByFileIdWithRecovery,
    deleteDocument, forgetTabView, cancelPendingAutosave, markWorkspaceNotReady,
    navigateToWorkspace, deleteAiDataForDocument, openDocumentInWorkspace, setOpenFileIds, saveWorkspaceState,
    refreshDocumentMetadatas, setSaveState, setStatusMessage, tEditor,
  }: CloseDocumentTabPorts,
): Promise<void> {
  flushOverlayChanges();
  const initialDraft = untouchedNewDocumentsRef.current.get(fileId);
  if (initialDraft && !mcpPreviewBusyRef.current) {
    if (fileId === activeFileIdRef.current && !(await saveCurrentDocumentBeforeReplacement())) return;
    const loaded = await loadDocumentByFileIdWithRecovery(fileId);
    if (untouchedNewDocumentsRef.current.has(fileId) && loaded.ok
      && isUntouchedNewDocument(initialDraft, loaded.document)
      && (fileId !== activeFileIdRef.current || isUntouchedNewDocument(initialDraft, documentRef.current))
      && (!canCleanupUntouchedDocument || await canCleanupUntouchedDocument(fileId))) {
      try {
        await deleteAiDataForDocument(fileId);
      } catch (error) {
        setSaveState("error");
        setStatusMessage(error instanceof Error ? error.message : tEditor("status.deleteFailed"));
        return;
      }
      // Compare-and-delete: a concurrent save retains the newly written content.
      const result = await deleteDocument(fileId, { expectedRevision: loaded.revision });
      if (!result.ok) {
        setSaveState("error");
        setStatusMessage(result.error ?? tEditor("status.deleteFailed"));
        return;
      }
      untouchedNewDocumentsRef.current.delete(fileId);
      forgetTabView(fileId);
      const remaining = openFileIdsRef.current.filter((id) => id !== fileId);
      if (remaining.length === 0) {
        cancelPendingAutosave();
        markWorkspaceNotReady();
        navigateToWorkspace([]);
      } else if (fileId === activeFileIdRef.current) {
        await openDocumentInWorkspace(remaining[0], { nextOpenFileIds: remaining, saveCurrent: false, status: tEditor("status.tabClosed") });
      } else {
        setOpenFileIds(remaining);
        await saveWorkspaceState({ openFileIds: remaining, activeFileId: activeFileIdRef.current });
      }
      await refreshDocumentMetadatas();
      return;
    }
  }
  if (openFileIds.length <= 1) {
    setStatusMessage(tEditor("status.lastTabStays"));
    return;
  }

  const closingIndex = openFileIds.indexOf(fileId);
  const nextOpenFileIds = openFileIds.filter((id) => id !== fileId);
  forgetTabView(fileId);
  if (fileId !== activeFileId) {
    setOpenFileIds(nextOpenFileIds);
    await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId });
    setStatusMessage(tEditor("status.tabClosed"));
    return;
  }

  const nextActiveId = nextOpenFileIds[Math.max(0, closingIndex - 1)] ?? nextOpenFileIds[0];
  await openDocumentInWorkspace(nextActiveId, {
    nextOpenFileIds,
    status: tEditor("status.tabClosed"),
  });
}

interface DeleteWorkspaceDocumentPorts extends DocumentTabPorts {
  cancelPendingAutosave(): void;
  markWorkspaceNotReady(): void;
  /** Leave for the workspace screen; `openFileIds` are the editor tabs that remain. */
  navigateToWorkspace(openFileIds: string[]): void;
}

/**
 * Delete a library document, then make the open tabs and saved workspace agree.
 * Deleting the document being edited leaves the editor for the workspace screen
 * instead of silently switching to some other document, so even the last
 * document of the library can be deleted. Storage drops the deleted file from
 * the saved tabs; the remaining tabs are handed to the workspace screen.
 */
export async function deleteWorkspaceDocument(
  fileId: string,
  { openFileIds, activeFileId }: DocumentTabs,
  {
    deleteDocument, setOpenFileIds, saveWorkspaceState,
    refreshDocumentMetadatas, setSaveState, setStatusMessage, tEditor,
    cancelPendingAutosave, markWorkspaceNotReady, navigateToWorkspace,
  }: DeleteWorkspaceDocumentPorts,
): Promise<void> {
  if (fileId === activeFileId) {
    // A pending autosave must not write the deleted file back. If deletion fails
    // the edits stay dirty and the next save boundary still writes them.
    cancelPendingAutosave();
    const result = await deleteDocument(fileId);
    if (!result.ok) {
      setSaveState("error");
      setStatusMessage(result.error ?? tEditor("status.deleteFailed"));
      return;
    }
    markWorkspaceNotReady();
    navigateToWorkspace(openFileIds.filter((id) => id !== fileId));
    return;
  }

  const result = await deleteDocument(fileId);
  if (!result.ok) {
    setSaveState("error");
    setStatusMessage(result.error ?? tEditor("status.deleteFailed"));
    return;
  }

  await refreshDocumentMetadatas();
  const remaining = openFileIds.filter((id) => id !== fileId);
  const nextOpenFileIds = remaining.length > 0 ? remaining : [activeFileId];
  setOpenFileIds(nextOpenFileIds);
  await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId });
  setStatusMessage(tEditor("status.deleted"));
}
