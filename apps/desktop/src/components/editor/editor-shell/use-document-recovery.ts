"use client";

import { toDocumentOpenFailure,type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import { isPristineUntitledDocument } from "@/components/editor/editor-shell/new-document-draft";
import { type SigmaDocument } from "@/features/document";
import { DEFAULT_DOCUMENT_TITLE } from "@/lib/document-title";
import { listSavedDocuments,loadDocumentByFileIdWithRecovery,type DocumentLoadResult } from "@/lib/storage";
import { useCallback,useEffect,useRef,useState } from "react";

import type { SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";

type RecoveryIssues = SigmaDocumentRecoveryIssue[];
interface DocumentRecoveryPorts {
  announceRecovery: (issues: RecoveryIssues, backupPath?: string) => void;
  rememberPristineDraft: (fileId: string, document: SigmaDocument) => void;
  activateFailedDocument: (failure: DocumentOpenFailure, openFileIds: string[]) => Promise<void>;
}
export function useDocumentRecovery({ announceRecovery, rememberPristineDraft, activateFailedDocument }: DocumentRecoveryPorts) {
  const disposedRef = useRef(false);
  const recoveryTimersRef = useRef(new Set<number>());
  useEffect(() => {
    disposedRef.current = false;
    const timers = recoveryTimersRef.current;
    return () => {
      disposedRef.current = true;
      for (const timer of timers) window.clearTimeout(timer);
      timers.clear();
    };
  }, []);
  const [documentOpenFailure, setDocumentOpenFailure] = useState<DocumentOpenFailure | null>(null);
  const documentOpenFailureRef = useRef<DocumentOpenFailure | null>(null);
  // 直前の読み込みで観測した失敗の一時置き場。開く判断をした呼び出し側だけが
  // showRecordedDocumentOpenFailure で受け取る (候補を読み飛ばす経路では捨てる)。
  const pendingDocumentOpenFailureRef = useRef<DocumentOpenFailure | null>(null);
  const applyDocumentOpenFailure = useCallback((failure: DocumentOpenFailure | null) => {
    if (disposedRef.current) return;
    documentOpenFailureRef.current = failure;
    setDocumentOpenFailure(failure);
  }, []);

  /** 直前に記録した失敗を破棄する。同じ教材が読めるようになった時だけ呼ぶ。 */
  const clearDocumentOpenFailure = useCallback((fileId: string) => {
    if (documentOpenFailureRef.current?.fileId === fileId) {
      applyDocumentOpenFailure(null);
    }
    pendingDocumentOpenFailureRef.current = null;
  }, [applyDocumentOpenFailure]);

  /**
   * 読み込み失敗のうち「教材の中身が原因」のものだけを保留に置く。実際に画面へ
   * 出すかは呼び出し側 (その教材をアクティブにするかどうか) が決める。
   */
  const recordDocumentOpenFailure = useCallback((
    fileId: string,
    result: Extract<DocumentLoadResult, { ok: false }>,
    fallbackTitle?: string,
  ) => {
    pendingDocumentOpenFailureRef.current = toDocumentOpenFailure(
      fileId,
      result,
      fallbackTitle?.trim() || DEFAULT_DOCUMENT_TITLE,
    );
  }, []);

  /** 直前の読み込みで記録された失敗を、その教材のものに限り画面へ出す。 */
  const showRecordedDocumentOpenFailure = useCallback((fileId: string): DocumentOpenFailure | null => {
    const pending = pendingDocumentOpenFailureRef.current;
    if (!pending || pending.fileId !== fileId) {
      return null;
    }
    pendingDocumentOpenFailureRef.current = null;
    applyDocumentOpenFailure(pending);
    return pending;
  }, [applyDocumentOpenFailure]);

  /**
   * 開けなかった教材を「タブは開いたまま、本文の代わりに原因を中央へ出す」状態にする。
   * 本文は空の下書きへ差し替えるが resetEditorDocument が clean 扱いにするため
   * 自動保存は走らない。加えて documentOpenFailureRef を見る保存側のガードで、
   * この空の下書きが壊れた教材へ書き戻ることを二重に防いでいる。
   */
  const enterDocumentOpenFailureState = activateFailedDocument;

  const loadWorkspaceDocument = useCallback(async (fileId: string): Promise<{
    document: SigmaDocument;
    observedRevision: number;
  } | null> => {
    const localResult = await loadDocumentByFileIdWithRecovery(fileId);
    if (disposedRef.current) return null;
    if (localResult.ok) {
      if (isPristineUntitledDocument(localResult.document, localResult.revision)) {
        rememberPristineDraft(fileId, localResult.document);
      }
      clearDocumentOpenFailure(fileId);
      if (localResult.recoveryIssues.length > 0) {
        const timer = window.setTimeout(() => {
          recoveryTimersRef.current.delete(timer);
          if (!disposedRef.current) announceRecovery(localResult.recoveryIssues, localResult.recoveryBackupPath);
        }, 0);
        recoveryTimersRef.current.add(timer);
      }
      return { document: localResult.document, observedRevision: localResult.revision };
    }

    const metadata = await listSavedDocuments();
    if (disposedRef.current) return null;
    const target = metadata.find((item) => item.fileId === fileId);
    // 教材の中身が原因で組み立てられなかった場合は、黙って別教材へ切り替えず
    // 「開いたまま原因を出す」ために失敗内容を記録しておく (呼び出し側が
    // openDocumentOpenFailure で拾う)。
    recordDocumentOpenFailure(fileId, localResult, target?.title);
    return null;
  }, [announceRecovery, clearDocumentOpenFailure, recordDocumentOpenFailure, rememberPristineDraft]);

  return { documentOpenFailure, documentOpenFailureRef, applyDocumentOpenFailure, clearDocumentOpenFailure, recordDocumentOpenFailure, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, loadWorkspaceDocument };
}
