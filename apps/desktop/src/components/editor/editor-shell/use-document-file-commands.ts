"use client";

import { useRef, useState, type RefObject } from "react";
import type { DocumentBlockClock, DocumentBlockIdFactory, SigmaDocument } from "@/features/document";
import type { EditorSaveState } from "@/features/editor-state/types";
import { writeTextToClipboard } from "@/lib/clipboard-text";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { serializeDocumentText } from "@/lib/document-text-transfer";
import { resolveDocumentTitle } from "@/lib/document-title";
import type { Translate } from "@/lib/i18n";
import { createId } from "@/lib/id";
import type { SigmaDocumentRecoveryIssue } from "@/lib/sigma-doc-schema";
import { createDocumentFromSigmaDocument, type DocumentFileRecord } from "@/lib/storage";
import { fileFromDesktopImport, planDocumentFileImport, prepareDocumentFileImport } from "./document-file-import";
import type { EmbeddedEditorHost } from "./document-lifecycle-types";
import type { DesktopExternalDocument } from "@/types/desktop";

export interface DocumentFileCommandOptions {
  documentRef: RefObject<SigmaDocument>;
  exportDocument?: () => Promise<SigmaDocument>;
  embeddedHostRef: RefObject<EmbeddedEditorHost | undefined>;
  workspaceReady: boolean;
  isDesktopApp: boolean;
  flushOverlayChanges(): void;
  saveCurrentDocumentBeforeReplacement(): Promise<boolean>;
  openDocumentAsTab(record: DocumentFileRecord, status: string): Promise<void>;
  resetEditorDocument(document: SigmaDocument, selectedId?: string | null, observedRevision?: number | null): void;
  setOpenFileIds(fileIds: string[]): void;
  setActiveFileId(fileId: string): void;
  setActiveMenu(menu: null): void;
  setSaveState(state: EditorSaveState): void;
  setStatusMessage(message: string): void;
  announceRecovery(issues: SigmaDocumentRecoveryIssue[]): void;
  DOCUMENT_BLOCK_OPERATION_PORTS: DocumentBlockClock & DocumentBlockIdFactory;
  tEditor: Translate<"editor">;
}

/** ファイル選択と取り込み用 UI 状態を持ち、SigmaDoc の保存・切替は既存境界へ渡す。 */
export function useDocumentFileCommands({
  documentRef, exportDocument, embeddedHostRef, workspaceReady, isDesktopApp, flushOverlayChanges,
  saveCurrentDocumentBeforeReplacement, openDocumentAsTab, resetEditorDocument,
  setOpenFileIds, setActiveFileId, setActiveMenu, setSaveState, setStatusMessage,
  announceRecovery, DOCUMENT_BLOCK_OPERATION_PORTS, tEditor,
}: DocumentFileCommandOptions) {

  const importInputRef = useRef<HTMLInputElement | null>(null);

  const otherImportInputRef = useRef<HTMLInputElement | null>(null);

  // 教材のテキスト受け渡し。取り込みは貼り付け面を開くだけ、書き出しは
  // クリップボードへ直接入れ、拒否されたときだけ手で選ぶ面 (テキストを保持) を出す。
  const [textImportOpen, setTextImportOpen] = useState(false);

  const [documentTextCopyFallback, setDocumentTextCopyFallback] = useState<string | null>(null);

  const exportJson = async () => {
    flushOverlayChanges();
    let document: SigmaDocument;
    try { document = exportDocument ? await exportDocument() : documentRef.current; }
    catch { setStatusMessage(tEditor("status.saveFailed")); return; }
    const data = serializeDocumentText(document);
    const suggestedName = `${resolveDocumentTitle(documentRef.current, "lesson")}.sigma`;
    const bridge = getDesktopBridge();
    if (bridge) {
      try {
        const result = await bridge.file.saveSigmaDoc({ suggestedName, data });
        if (result) {
          setStatusMessage(tEditor("status.savedTo", { path: result.filePath }));
        }
      } catch (error) {
        setSaveState("error");
        setStatusMessage(error instanceof Error ? error.message : tEditor("status.saveFailed"));
      }
      return;
    }
    const blob = new Blob([data], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = window.document.createElement("a");
    anchor.href = url;
    anchor.download = suggestedName;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  /**
   * 教材をファイルではなくクリップボードのテキストとして持ち出す。
   * チャットやメールへそのまま貼れるので、書き出し先を選ぶ手数が要らない。
   */
  const copyDocumentText = async () => {
    setActiveMenu(null);
    flushOverlayChanges();
    let document: SigmaDocument;
    try { document = exportDocument ? await exportDocument() : documentRef.current; }
    catch { setStatusMessage(tEditor("status.saveFailed")); return; }
    const text = serializeDocumentText(document);
    if (await writeTextToClipboard(text)) {
      setStatusMessage(tEditor("status.documentTextCopied"));
      return;
    }
    // 権限で書けなかったときは行き止まりにせず、手で選べる面に同じテキストを出す。
    setDocumentTextCopyFallback(text);
  };

  const openTextImportDialog = () => {
    setActiveMenu(null);
    setTextImportOpen(true);
  };

  const openDocumentViaDesktop = async () => {
    const bridge = getDesktopBridge();
    // Web 版にはネイティブのファイルピッカーが無い。取り込みと同じ隠しinputへ回す
    // (何も起きないままだと「開く」が壊れているようにしか見えない)。
    if (!bridge) {
      importInputRef.current?.click();
      return;
    }
    try {
      const result = await bridge.file.openSigmaDoc();
      if (!result) {
        return;
      }
      const baseName = result.filePath.split(/[\\/]/).pop() ?? "document.sigmadoc.json";
      const file = new File([result.data], baseName, { type: "application/json" });
      await importDocumentFile(file);
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.fileOpenFailed"));
    }
  };

  const openImportDocumentViaDesktop = async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.file.openImportDocument) {
      importInputRef.current?.click();
      return;
    }
    try {
      const result = await bridge.file.openImportDocument();
      if (!result) {
        return;
      }
      await importDocumentFile(fileFromDesktopImport(result));
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.fileReadFailed"));
    }
  };

  const importDocumentFileWithResult = async (file: File): Promise<boolean> => {
    try {
      const request = planDocumentFileImport(file);
      const { document: importedDocument, recoveryIssues, successMessageKey } = await prepareDocumentFileImport(request, {
        ...DOCUMENT_BLOCK_OPERATION_PORTS,
        createDocumentId: () => createId("doc"),
        defaultTitle: () => tEditor("status.importedDocumentTitle"),
      });
      if (embeddedHostRef.current) {
        resetEditorDocument(importedDocument, undefined, null);
        setOpenFileIds([importedDocument.docId]);
        setActiveFileId(importedDocument.docId);
        setSaveState("saved");
        setStatusMessage(tEditor(successMessageKey));
        announceRecovery(recoveryIssues);
        return true;
      }
      if (workspaceReady && !(await saveCurrentDocumentBeforeReplacement())) {
        return false;
      }
      const importedRecord = await createDocumentFromSigmaDocument(importedDocument);
      await openDocumentAsTab(importedRecord, tEditor(successMessageKey));
      announceRecovery(recoveryIssues);
    } catch (error) {
      setSaveState("error");
      setStatusMessage(error instanceof Error ? error.message : tEditor("status.fileReadFailed"));
    }
    return true;
  };

  const importDocumentFile = async (file: File) => {
    await importDocumentFileWithResult(file);
  };

  const openExternalDocument = async (pending: DesktopExternalDocument): Promise<boolean> => {
    if (pending.error !== undefined) {
      setStatusMessage(`${tEditor("status.fileReadFailed")}: ${pending.filePath}\n${pending.error}`);
      return true;
    }
    const baseName = pending.filePath.split(/[\\/]/).pop() ?? "document.sigma";
    return importDocumentFileWithResult(new File([pending.data], baseName, { type: "application/json" }));
  };

  const openImportDialog = () => {
    setActiveMenu(null);
    if (isDesktopApp) {
      void openImportDocumentViaDesktop();
      return;
    }
    importInputRef.current?.click();
  };

  const openOtherImportDialog = () => {
    setActiveMenu(null);
    const bridge = getDesktopBridge();
    if (isDesktopApp && bridge?.file.openImportOtherDocument) {
      void (async () => {
        try {
          const result = await bridge.file.openImportOtherDocument!();
          if (!result) {
            return;
          }
          await importDocumentFile(fileFromDesktopImport(result, "document.pptx"));
        } catch (error) {
          setSaveState("error");
          setStatusMessage(error instanceof Error ? error.message : tEditor("status.fileReadFailed"));
        }
      })();
      return;
    }
    otherImportInputRef.current?.click();
  };

  return {
    importInputRef, otherImportInputRef, textImportOpen, setTextImportOpen, documentTextCopyFallback, setDocumentTextCopyFallback, exportJson, copyDocumentText, openTextImportDialog, openDocumentViaDesktop, openExternalDocument, importDocumentFile, openImportDialog, openOtherImportDialog,
  };
}
