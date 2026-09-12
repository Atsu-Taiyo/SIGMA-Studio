"use client";
import { type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import  {
  recordSuccessfulDocumentSave,
  saveBeforeDocumentReplacement,
  type SuccessfulDocumentSave,
} from "@/components/editor/editor-shell/document-state-sync";
import { getDocumentBoundarySkipReason, type DocumentBoundarySkipReason } from "@/components/editor/editor-shell/workspace-request";
import { type SigmaDocument } from "@/features/document";
import type { EditorSaveState, EditorStateUpdate } from "@/features/editor-state/types";
import { trackInFlightSave } from "@/lib/ai-run-applier";
import type { DocumentVersion } from "@/lib/document-version-history";
import { type Translate } from "@/lib/i18n";
import { captureDocumentVersion, createObservedDocumentWrite, saveDocumentRecord } from "@/lib/storage";
import type { Dispatch, RefObject, SetStateAction } from "react";
import { useCallback } from "react";
import type { DocumentStorageChangeEvent, EmbeddedEditorHost } from "./document-lifecycle-types";

interface Dependencies {
  setVersionHistoryWarnings: Dispatch<SetStateAction<Record<string, string>>>;
  t: Translate<"chrome">;
  documentOpenFailureRef: RefObject<DocumentOpenFailure | null>;
  activeFileIdRef: RefObject<string>;
  documentDirtyRevisionRef: RefObject<number>;
  embeddedHostRef: RefObject<EmbeddedEditorHost | undefined>;
  documentRef: RefObject<SigmaDocument>;
  lastSavedDocumentRef: RefObject<SigmaDocument>;
  lastSavedDirtyRevisionRef: RefObject<number>;
  lastSyncedDocumentRef: RefObject<SigmaDocument>;
  tEditor: Translate<"editor">;
  documentObservedRevisionRef: RefObject<number | null>;
  inFlightSavePromiseRef: RefObject<Promise<unknown> | null>;
  successfulDocumentSavesRef: RefObject<Map<string, SuccessfulDocumentSave<SigmaDocument>>>;
  workspaceReadyRef: RefObject<boolean>;
  externalChangeFileIdsRef: RefObject<Set<string>>;
  mcpPreviewBusyRef: RefObject<boolean>;
  isCurrentDocumentDirty: () => boolean;
  isEmbedded: boolean;
  setSaveState: (update: EditorStateUpdate<EditorSaveState>) => void;
  setStatusMessage: (update: EditorStateUpdate<string>) => void;
  dispatchDocumentStorageChange: (event: DocumentStorageChangeEvent) => void;
}

export function useDocumentSaveBoundary({
  setVersionHistoryWarnings,
  t,
  documentOpenFailureRef,
  activeFileIdRef,
  documentDirtyRevisionRef,
  embeddedHostRef,
  documentRef,
  lastSavedDocumentRef,
  lastSavedDirtyRevisionRef,
  lastSyncedDocumentRef,
  tEditor,
  documentObservedRevisionRef,
  inFlightSavePromiseRef,
  successfulDocumentSavesRef,
  workspaceReadyRef,
  externalChangeFileIdsRef,
  mcpPreviewBusyRef,
  isCurrentDocumentDirty,
  isEmbedded,
  setSaveState,
  setStatusMessage,
  dispatchDocumentStorageChange,
}: Dependencies) {


  const updateVersionHistoryCaptureStatus = useCallback((fileId: string, result: {
    ok: boolean;
    versionCaptureError?: string;
  }) => {
    if (result.versionCaptureError) {
      setVersionHistoryWarnings((current) => ({
        ...current,
        [fileId]: t("versionHistory.captureWarning"),
      }));
    } else if (result.ok) {
      setVersionHistoryWarnings((current) => {
        if (!(fileId in current)) return current;
        const next = { ...current };
        delete next[fileId];
        return next;
      });
    }
  }, [setVersionHistoryWarnings, t]);


  const saveCurrentDocumentRecord = useCallback(async (origin: DocumentVersion["origin"] = "user") => {
    // 開けなかった教材には何も書かない。画面上の document は原因表示用の空の
    // 下書きなので、保存すれば元の内容を空で上書きしてしまう。
    if (documentOpenFailureRef.current?.fileId === activeFileIdRef.current) {
      return { ok: true };
    }
    const saveRevision = documentDirtyRevisionRef.current;
    const host = embeddedHostRef.current;
    if (host) {
      try {
        await host.onSave?.(documentRef.current);
        lastSavedDocumentRef.current = documentRef.current;
        lastSavedDirtyRevisionRef.current = saveRevision;
        lastSyncedDocumentRef.current = documentRef.current;
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : tEditor("status.saveFailed"),
        };
      }
    }

    const nextDocument = {
      ...documentRef.current,
      updatedAt: new Date().toISOString(),
    };
    const fileId = activeFileIdRef.current;
    const observedRevision = documentObservedRevisionRef.current;
    if (observedRevision === null) {
      return {
        ok: false,
        error: tEditor("status.saveRevisionUnknown"),
      };
    }
    const write = createObservedDocumentWrite({
      fileId,
      document: nextDocument,
      observedRevision,
    });
    return trackInFlightSave(inFlightSavePromiseRef, (async () => {
      const result = await saveDocumentRecord(write, { origin });
      updateVersionHistoryCaptureStatus(fileId, result);
      if (result.ok) {
        recordSuccessfulDocumentSave({
          savedByFileId: successfulDocumentSavesRef.current,
          save: {
            fileId,
            document: nextDocument,
            revision: result.revision ?? observedRevision + 1,
            dirtyRevision: saveRevision,
          },
          activeFileId: activeFileIdRef.current,
          observedRevisionRef: documentObservedRevisionRef,
          lastSavedDocumentRef,
          lastSavedDirtyRevisionRef,
          lastSyncedDocumentRef,
        });
      }
      return result;
    })());
  }, [activeFileIdRef, documentDirtyRevisionRef, documentObservedRevisionRef, documentOpenFailureRef, documentRef, embeddedHostRef, inFlightSavePromiseRef, lastSavedDirtyRevisionRef, lastSavedDocumentRef, lastSyncedDocumentRef, successfulDocumentSavesRef, tEditor, updateVersionHistoryCaptureStatus]);


  const saveCurrentDocumentBoundary = useCallback(async (
    origin: Extract<DocumentVersion["origin"], "tab-switch" | "app-close">,
  ): Promise<{
    ok: boolean;
    error?: string;
    code?: "revision-mismatch";
    skipped?: true;
    skippedReason?: DocumentBoundarySkipReason;
  }> => {
    const boundaryFileId = activeFileIdRef.current;
    const boundarySkipReason = () => getDocumentBoundarySkipReason({
      isEmbedded,
      workspaceReady: workspaceReadyRef.current,
      activeDocumentOpenFailed: documentOpenFailureRef.current?.fileId === activeFileIdRef.current,
      externalChangePending: externalChangeFileIdsRef.current.has(activeFileIdRef.current),
      aiWriteInProgress: mcpPreviewBusyRef.current,
      observedRevision: documentObservedRevisionRef.current,
    });
    const initialSkipReason = boundarySkipReason();
    if (initialSkipReason) return { ok: true, skipped: true, skippedReason: initialSkipReason };
    while (inFlightSavePromiseRef.current) {
      await inFlightSavePromiseRef.current.catch(() => undefined);
    }
    const fileId = activeFileIdRef.current;
    if (fileId !== boundaryFileId) return { ok: true, skipped: true };
    const skipReasonAfterWait = boundarySkipReason();
    if (skipReasonAfterWait) return { ok: true, skipped: true, skippedReason: skipReasonAfterWait };
    const observedRevision = documentObservedRevisionRef.current;
    if (observedRevision === null) {
      return { ok: true, skipped: true, skippedReason: "revision-unknown" };
    }
    if (isCurrentDocumentDirty()) {
      return saveCurrentDocumentRecord(origin);
    }
    const result = await captureDocumentVersion(createObservedDocumentWrite({
      fileId,
      document: documentRef.current,
      observedRevision,
    }), origin);
    if (!result.ok) {
      setVersionHistoryWarnings((current) => ({
        ...current,
        [fileId]: t("versionHistory.captureWarning"),
      }));
    }
    return { ok: true };
  }, [activeFileIdRef, documentObservedRevisionRef, documentOpenFailureRef, documentRef, externalChangeFileIdsRef, inFlightSavePromiseRef, isCurrentDocumentDirty, isEmbedded, mcpPreviewBusyRef, saveCurrentDocumentRecord, setVersionHistoryWarnings, t, workspaceReadyRef]);


  const saveCurrentDocumentBeforeReplacement = useCallback(async (): Promise<boolean> => {
    return saveBeforeDocumentReplacement({
      save: () => saveCurrentDocumentBoundary("tab-switch"),
      isDirtyAfterSave: isCurrentDocumentDirty,
      onFailure: (result) => {
        setSaveState("error");
        if (result.code === "revision-mismatch") {
          setStatusMessage(tEditor("status.keepOpenConflict"));
          dispatchDocumentStorageChange({
            type: "document",
            fileId: activeFileIdRef.current,
            change: "changed",
            timestamp: Date.now(),
          });
          return;
        }
        setStatusMessage(result.error ?? tEditor("status.keepOpenSaveFailed"));
      },
    });
  }, [activeFileIdRef, dispatchDocumentStorageChange, isCurrentDocumentDirty, saveCurrentDocumentBoundary, setSaveState, setStatusMessage, tEditor]);


  const attemptBoundarySave = useCallback((origin: "tab-switch" | "app-close") => {
    return saveCurrentDocumentBoundary(origin);
  }, [saveCurrentDocumentBoundary]);
  return { updateVersionHistoryCaptureStatus, saveCurrentDocumentRecord, saveCurrentDocumentBeforeReplacement, attemptBoundarySave };
}
