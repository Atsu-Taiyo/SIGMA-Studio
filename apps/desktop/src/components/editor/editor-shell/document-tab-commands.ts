import type { SigmaDocument } from "@/features/document";
import type { DocumentLoadResult, DocumentMetadata, StorageResult, WorkspaceState } from "@/lib/runtime/types";

import { isUntouchedNewDocument } from "./new-document-draft";

export interface DocumentTabOpenOptions {
  nextOpenFileIds?: string[];
  status?: string;
  saveCurrent?: boolean;
}

interface DocumentTabs {
  openFileIds: string[];
  activeFileId: string;
}

type TabMessageKey =
  | "status.deleteFailed"
  | "status.tabClosed"
  | "status.lastTabStays"
  | "status.lastDocumentStays"
  | "status.noDocumentToSwitchTo"
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
  flushOverlayChanges(): void;
  saveCurrentDocumentBeforeReplacement(): Promise<boolean>;
  loadDocumentByFileIdWithRecovery(fileId: string): Promise<DocumentLoadResult>;
  forgetTabView(fileId: string): void;
  cancelPendingAutosave(): void;
  markWorkspaceNotReady(): void;
  navigateToWorkspace(): void;
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
    flushOverlayChanges, saveCurrentDocumentBeforeReplacement, loadDocumentByFileIdWithRecovery,
    deleteDocument, forgetTabView, cancelPendingAutosave, markWorkspaceNotReady,
    navigateToWorkspace, openDocumentInWorkspace, setOpenFileIds, saveWorkspaceState,
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
      && (fileId !== activeFileIdRef.current || isUntouchedNewDocument(initialDraft, documentRef.current))) {
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
        navigateToWorkspace();
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

/** Delete a library document, then make the open tabs and saved workspace agree. */
export async function deleteWorkspaceDocument(
  fileId: string,
  { documentMetadatas, openFileIds, activeFileId }: DocumentTabs & {
    documentMetadatas: readonly Pick<DocumentMetadata, "fileId">[];
  },
  {
    deleteDocument, openDocumentInWorkspace, setOpenFileIds, saveWorkspaceState,
    refreshDocumentMetadatas, setSaveState, setStatusMessage, tEditor,
  }: DocumentTabPorts,
): Promise<void> {
  if (documentMetadatas.length <= 1) {
    setStatusMessage(tEditor("status.lastDocumentStays"));
    return;
  }

  const nextOpenFileIds = openFileIds.filter((id) => id !== fileId);
  const nextMetadata = documentMetadatas.filter((item) => item.fileId !== fileId);
  const nextActiveId = fileId === activeFileId
    ? nextOpenFileIds[0] ?? nextMetadata[0]?.fileId
    : activeFileId;
  if (!nextActiveId) {
    setSaveState("error");
    setStatusMessage(tEditor("status.noDocumentToSwitchTo"));
    return;
  }

  const result = await deleteDocument(fileId);
  if (!result.ok) {
    setSaveState("error");
    setStatusMessage(result.error ?? tEditor("status.deleteFailed"));
    return;
  }

  await refreshDocumentMetadatas();
  if (nextActiveId && fileId === activeFileId) {
    await openDocumentInWorkspace(nextActiveId, {
      nextOpenFileIds: nextOpenFileIds.length > 0 ? nextOpenFileIds : [nextActiveId],
      status: tEditor("status.deleted"),
      saveCurrent: false,
    });
    return;
  }

  const normalizedOpenFileIds = nextOpenFileIds.length > 0 ? nextOpenFileIds : [nextActiveId];
  setOpenFileIds(normalizedOpenFileIds);
  await saveWorkspaceState({ openFileIds: normalizedOpenFileIds, activeFileId: nextActiveId });
  setStatusMessage(tEditor("status.deleted"));
}
