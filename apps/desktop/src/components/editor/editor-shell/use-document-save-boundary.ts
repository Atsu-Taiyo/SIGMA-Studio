"use client";
import { type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import {
recordSuccessfulDocumentSave,
saveBeforeDocumentReplacement,
type SuccessfulDocumentSave,
} from "@/components/editor/editor-shell/document-state-sync";
import { getDocumentBoundarySkipReason,uniqueStringIds,type DocumentBoundarySkipReason } from "@/components/editor/editor-shell/workspace-request";
import { type SigmaDocument } from "@/features/document";
import type { DocumentSession } from "@/features/document-session/contracts";
import type { EditorSaveState,EditorStateUpdate } from "@/features/editor-state/types";
import { trackInFlightSave } from "@/lib/ai-run-applier";
import type { DocumentVersion } from "@/lib/document-version-history";
import { type Translate } from "@/lib/i18n";
import { captureDocumentVersion,createObservedDocumentWrite,saveDocumentRecord,type StorageResult } from "@/lib/storage";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useCallback,useEffect,useRef,useState } from "react";
import type { DocumentStorageChangeEvent,EmbeddedEditorHost } from "./document-lifecycle-types";

interface Dependencies {
  autosave: {
    activeFileId: string;
    document: SigmaDocument;
    documentSession?: DocumentSession;
    workspaceReady: boolean;
    blocked: boolean;
    isDesktopApp: boolean;
    openFileIds: string[];
    setOpenFileIds: (ids: string[]) => void;
    saveWorkspaceState: (state: { openFileIds: string[]; activeFileId: string }) => Promise<StorageResult>;
    refreshDocumentMetadatas: () => Promise<void>;
  };

  documentSessionRef?: RefObject<DocumentSession | undefined>;
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
  documentSessionRef,
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
  autosave,
}: Dependencies) {



  const { activeFileId, document, documentSession, workspaceReady, blocked: ledgerFailure, isDesktopApp, openFileIds, setOpenFileIds, saveWorkspaceState, refreshDocumentMetadatas } = autosave;
  const disposedRef = useRef(false);
  useEffect(() => {
    disposedRef.current = false;
    return () => { disposedRef.current = true; };
  }, []);
  const [autosaveRetry, setAutosaveRetry] = useState(0);
  const autosaveRetryTimerRef = useRef<number | null>(null);
  const cancelPendingAutosaveRef = useRef<() => void>(() => undefined);

  const scheduleAutosaveRetry = useCallback(() => {
    if (autosaveRetryTimerRef.current !== null) {
      return;
    }
    autosaveRetryTimerRef.current = window.setTimeout(() => {
      autosaveRetryTimerRef.current = null;
      setAutosaveRetry((current) => current + 1);
    }, 300);
  }, []);
  useEffect(() => () => {
    if (autosaveRetryTimerRef.current !== null) {
      window.clearTimeout(autosaveRetryTimerRef.current);
      autosaveRetryTimerRef.current = null;
    }
  }, []);
  const updateVersionHistoryCaptureStatus = useCallback((fileId: string, result: {
    ok: boolean;
    versionCaptureError?: string;
  }) => {
    if (disposedRef.current) return;
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
    const session = documentSessionRef?.current;
    if (session) {
      try {
        await session.flush();
        lastSavedDocumentRef.current = session.project();
        lastSyncedDocumentRef.current = lastSavedDocumentRef.current;
        lastSavedDirtyRevisionRef.current = saveRevision;
        return { ok: true, revision: 1 };
      } catch { return { ok: false, error: tEditor("status.saveFailed") }; }
    }
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
  }, [activeFileIdRef, documentDirtyRevisionRef, documentObservedRevisionRef, documentOpenFailureRef, documentRef, documentSessionRef, embeddedHostRef, inFlightSavePromiseRef, lastSavedDirtyRevisionRef, lastSavedDocumentRef, lastSyncedDocumentRef, successfulDocumentSavesRef, tEditor, updateVersionHistoryCaptureStatus]);


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
    if (documentSessionRef?.current) return saveCurrentDocumentRecord(origin);
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
  }, [activeFileIdRef, documentObservedRevisionRef, documentOpenFailureRef, documentRef, documentSessionRef, externalChangeFileIdsRef, inFlightSavePromiseRef, isCurrentDocumentDirty, isEmbedded, mcpPreviewBusyRef, saveCurrentDocumentRecord, setVersionHistoryWarnings, t, workspaceReadyRef]);


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
  useEffect(() => {
    if (!workspaceReady || ledgerFailure) {
      return;
    }
    if (documentSession) {
      let cancelled = false;
      void documentSession.flush().then(() => {
        if (cancelled || activeFileIdRef.current !== activeFileId) return;
        lastSavedDocumentRef.current = documentSession.project();
        lastSavedDirtyRevisionRef.current = documentDirtyRevisionRef.current;
      }).catch(() => { if (!cancelled) setSaveState("error"); });
      return () => { cancelled = true; };
    }

    // 開けなかった教材がアクティブな間は自動保存しない (saveCurrentDocumentRecord と同じ理由)。
    if (documentOpenFailureRef.current?.fileId === activeFileId) {
      return;
    }

    // documentはeffectのデバウンス起点。保存時点ではdocumentRefから最新内容を取り直し、
    // 承認後に古いrender snapshotをIPCへ渡さない。
    void document;
    const saveRevision = documentDirtyRevisionRef.current;
    // A clean document has nothing to persist; skipping keeps the save indicator
    // quiet (no saving→saved flicker) when switching tabs or opening documents.
    // Use a numeric dirty revision here so typing does not stringify the whole
    // SigmaDoc on every document state update.
    if (saveRevision <= lastSavedDirtyRevisionRef.current) {
      return;
    }

    if (isEmbedded) {
      let cancelled = false;
      const timeoutId = window.setTimeout(() => {
        const host = embeddedHostRef.current;
        setSaveState("saving");
        Promise.resolve(host?.onSave?.(document))
          .then(() => {
            if (cancelled) {
              return;
            }
            lastSavedDocumentRef.current = document;
            lastSavedDirtyRevisionRef.current = saveRevision;
            lastSyncedDocumentRef.current = document;
            setSaveState("saved");
            setStatusMessage(host?.onSave ? tEditor("status.hostAutosaved") : tEditor("status.hostSynced"));
          })
          .catch((error) => {
            if (cancelled) {
              return;
            }
            setSaveState("error");
            setStatusMessage(error instanceof Error ? error.message : tEditor("status.saveFailed"));
          });
      }, 450);

      const cancelAutosave = () => {
        cancelled = true;
        window.clearTimeout(timeoutId);
      };
      cancelPendingAutosaveRef.current = cancelAutosave;
      return () => {
        cancelAutosave();
        if (cancelPendingAutosaveRef.current === cancelAutosave) {
          cancelPendingAutosaveRef.current = () => undefined;
        }
      };
    }

    let cancelled = false;
    const savingTimeoutId = window.setTimeout(() => {
      if (
        externalChangeFileIdsRef.current.has(activeFileId)
        || mcpPreviewBusyRef.current
      ) {
        scheduleAutosaveRetry();
        return;
      }
      setSaveState("saving");
    }, 0);
    const timeoutId = window.setTimeout(async () => {
      // 直列化: 進行中の保存が終わるまで次を送らない。
      //
      // 重ねて投げると 2 本目は 1 本目が確定させる前の observedRevision で CAS に入るため、
      // 中身が競合していなくても revision-mismatch になり「他の変更を読み込んでいます」に落ちる。
      // 待ってから下の判定と snapshot を作ることが重要 — 待った後に revision だけ取り直すと、
      // 古い document に新しい revision を貸すことになり `ObservedDocumentWrite` が
      // 防いでいる lost update そのものになる。ここでは本文も revision も待機後に読む。
      // 1 回待つだけでは足りない: 待っている間に明示保存 (AI 承認前の flush 等) が
      // 始まると `.current` が差し替わり、結局それと重なって走ってしまう。
      while (inFlightSavePromiseRef.current) {
        await inFlightSavePromiseRef.current.catch(() => undefined);
        if (cancelled) {
          return;
        }
      }
      // 明示save（AI提案承認前のflush/save等）がこのtimerより先に同revisionを保存した
      // 場合、古いdocument snapshotで後から上書きしない。timer作成時の判定だけでは、
      // 承認IPC中に450msを跨いだときstale autosaveがAI適用結果の後へ並ぶraceが残る。
      if (saveRevision <= lastSavedDirtyRevisionRef.current) {
        return;
      }
      if (
        externalChangeFileIdsRef.current.has(activeFileId)
        || mcpPreviewBusyRef.current
      ) {
        scheduleAutosaveRetry();
        return;
      }
      const revisionToSave = documentDirtyRevisionRef.current;
      if (revisionToSave <= lastSavedDirtyRevisionRef.current) {
        return;
      }
      const nextDocument = {
        ...documentRef.current,
        updatedAt: new Date().toISOString(),
      };
      const observedRevision = documentObservedRevisionRef.current;
      if (observedRevision === null) {
        setSaveState("error");
        setStatusMessage(tEditor("status.saveRevisionUnknown"));
        return;
      }
      const write = createObservedDocumentWrite({
        fileId: activeFileId,
        document: nextDocument,
        observedRevision,
      });
      const saveTask = saveDocumentRecord(write)
        .then(async (result) => {
          updateVersionHistoryCaptureStatus(activeFileId, result);
          if (result.ok) {
            const savedFileIsActive = recordSuccessfulDocumentSave({
              savedByFileId: successfulDocumentSavesRef.current,
              save: {
                fileId: activeFileId,
                document: nextDocument,
                revision: result.revision ?? observedRevision + 1,
                dirtyRevision: revisionToSave,
              },
              activeFileId: activeFileIdRef.current,
              observedRevisionRef: documentObservedRevisionRef,
              lastSavedDocumentRef,
              lastSavedDirtyRevisionRef,
              lastSyncedDocumentRef,
            });
            // Effect cleanup means its UI snapshot is stale, not that the completed
            // write did not happen. Same-file refs above must advance even when a
            // newer keystroke has already created the next autosave effect.
            if (cancelled || !savedFileIsActive) {
              return;
            }
            if (!openFileIds.includes(activeFileId)) {
              const nextOpenFileIds = uniqueStringIds([...openFileIds, activeFileId]);
              setOpenFileIds(nextOpenFileIds);
              await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId });
            }
            await refreshDocumentMetadatas();
            if (cancelled) {
              return;
            }
            setSaveState(result.versionCaptureError ? "warning" : "saved");
            setStatusMessage(result.versionCaptureError
              ? t("versionHistory.captureWarning")
              : result.error
                ? tEditor("status.localAutosavedWith", { reason: result.error })
                : isDesktopApp
                  ? tEditor("status.localAutosavedThisPc")
                  : tEditor("status.localAutosaved"));
          } else if (result.code === "revision-mismatch") {
            // queued済みの古いpayloadは一切mergeせず破棄する。metadataだけを読み直して
            // revisionを進めると同じstale payloadがCASを通るため、documentRefを外部変更
            // 取り込みで更新できるまでは再保存しない。
            if (activeFileIdRef.current === activeFileId) {
              dispatchDocumentStorageChange({
                type: "document",
                fileId: activeFileId,
                change: "changed",
                timestamp: Date.now(),
              });
              if (!cancelled) {
                setSaveState("error");
                setStatusMessage(tEditor("status.reloadingOtherChanges"));
              }
            }
          } else {
            if (!cancelled && activeFileIdRef.current === activeFileId) {
              setSaveState("error");
              setStatusMessage(result.error ?? tEditor("status.saveFailedShort"));
            }
          }
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          setSaveState("error");
          setStatusMessage(error instanceof Error ? error.message : tEditor("status.saveFailedShort"));
        });
      void trackInFlightSave(inFlightSavePromiseRef, saveTask);
    }, 450);

    const cancelAutosave = () => {
      cancelled = true;
      window.clearTimeout(savingTimeoutId);
      window.clearTimeout(timeoutId);
    };
    cancelPendingAutosaveRef.current = cancelAutosave;
    return () => {
      cancelAutosave();
      if (cancelPendingAutosaveRef.current === cancelAutosave) {
        cancelPendingAutosaveRef.current = () => undefined;
      }
    };
  }, [activeFileId, documentSession, autosaveRetry, dispatchDocumentStorageChange, document, isDesktopApp, isEmbedded, ledgerFailure, openFileIds, refreshDocumentMetadatas, scheduleAutosaveRetry, saveWorkspaceState, setSaveState, setStatusMessage, t, updateVersionHistoryCaptureStatus, workspaceReady, documentOpenFailureRef, documentDirtyRevisionRef, lastSavedDirtyRevisionRef, activeFileIdRef, lastSavedDocumentRef, embeddedHostRef, lastSyncedDocumentRef, tEditor, externalChangeFileIdsRef, mcpPreviewBusyRef, inFlightSavePromiseRef, documentRef, documentObservedRevisionRef, successfulDocumentSavesRef, setOpenFileIds]);

  return { cancelPendingAutosaveRef, scheduleAutosaveRetry, updateVersionHistoryCaptureStatus, saveCurrentDocumentRecord, saveCurrentDocumentBeforeReplacement, attemptBoundarySave };
}
