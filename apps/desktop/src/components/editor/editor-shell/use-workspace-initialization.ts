"use client";

import { type DocumentOpenFailure } from "@/components/editor/editor-shell/document-open-failure";
import { clearRequestedFileId,getRequestedFileId,uniqueStringIds } from "@/components/editor/editor-shell/workspace-request";
import { ensurePageLayout,repairDuplicateTopLevelIds,type SigmaDocument } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createNewDocument,initializeDocumentWorkspace,listSavedDocuments } from "@/lib/storage";
import { normalizeWorkspaceLayout,type WorkspaceLayoutV2 } from "@/lib/workspace-tab-groups";
import { useEffect } from "react";
import { DOCUMENT_BLOCK_OPERATION_PORTS } from "./document-operation-ports";
import { storageWarningOrStatus,tEditor } from "./editor-translations";

import type { LedgerSchemaFailure } from "@/lib/library-schema";
import type { StorageResult } from "@/lib/storage";
import type { SaveState } from "./types";

interface WorkspaceInitializationPorts {
  isEmbedded: boolean;
  workspaceReloadNonce: number;
  loadWorkspaceDocument: (fileId: string) => Promise<{ document: SigmaDocument; observedRevision: number } | null>;
  showRecordedDocumentOpenFailure: (fileId: string) => DocumentOpenFailure | null;
  enterDocumentOpenFailureState: (failure: DocumentOpenFailure, fileIds: string[]) => Promise<void>;
  activateDocument: (document: SigmaDocument, fileId: string, openFileIds: string[], revision: number) => void;
  installLayout: (layout: WorkspaceLayoutV2) => void;
  refreshDocumentMetadatas: () => Promise<void>;
  saveWorkspaceState: (state: { openFileIds: string[]; activeFileId: string }) => Promise<StorageResult>;
  setLedgerFailure: (error: LedgerSchemaFailure | null) => void;
  setWorkspaceReady: (ready: boolean) => void;
  setSaveState: (state: SaveState) => void;
  setStatusMessage: (message: string) => void;
}
export function useWorkspaceInitialization({ isEmbedded, workspaceReloadNonce, loadWorkspaceDocument, showRecordedDocumentOpenFailure, enterDocumentOpenFailureState, activateDocument, installLayout, refreshDocumentMetadatas, saveWorkspaceState, setLedgerFailure, setWorkspaceReady, setSaveState, setStatusMessage }: WorkspaceInitializationPorts) {
  useEffect(() => {
    if (isEmbedded) {
      return;
    }

    let cancelled = false;

    const timeoutId = window.setTimeout(() => {
      initializeDocumentWorkspace()
        .then(async (workspace) => {
          if (cancelled) {
            return;
          }
          if (!workspace.ok) {
            setLedgerFailure(workspace.ledgerError);
            setWorkspaceReady(true);
            return;
          }

          const metadata = await listSavedDocuments();
          if (cancelled) return;
          const requestedFileId = getRequestedFileId();
          const availableFileIds = new Set(metadata.map((item) => item.fileId));
          const layoutDocumentIds = new Set(
            workspace.state.layout?.groups.flatMap((group) => group.tabs.flatMap((tab) => (
              tab.kind === "ai" ? [tab.documentFileId] : []
            ))) ?? [],
          );
          let availableRoomIds: Set<string> | undefined;
          const listChatRooms = getDesktopBridge()?.aiEdit?.listChatRooms;
          if (listChatRooms && layoutDocumentIds.size > 0) {
            try {
              const rooms = await Promise.all(Array.from(layoutDocumentIds, (fileId) => listChatRooms(fileId)));
              if (cancelled) return;
              availableRoomIds = new Set(rooms.flat().map((room) => room.id));
            } catch {
              // A transient chat-store read failure must not discard restorable AI tabs.
              availableRoomIds = undefined;
            }
          }
          if (cancelled) return;
          const restoredLayout = normalizeWorkspaceLayout(
            workspace.state.layout,
            workspace.state.openFileIds,
            workspace.state.activeFileId,
            availableFileIds,
            availableRoomIds,
          );
          installLayout(restoredLayout);
          const firstLocalFileId = metadata[0]?.fileId;
          const candidateFileIds = uniqueStringIds([
            ...(requestedFileId ? [requestedFileId] : []),
            ...(availableFileIds.has(workspace.state.activeFileId) ? [workspace.state.activeFileId] : []),
            ...(metadata[0] ? [metadata[0].fileId] : []),
            ...(firstLocalFileId ? [firstLocalFileId] : []),
          ]);
          if (candidateFileIds.length === 0) {
            throw new Error(tEditor("status.noSavedDocuments"));
          }

          // ローカルの候補を順に開き、読み込めない候補は読み飛ばす。
          let nextActiveFileId: string | null = null;
          let activeDocument: { document: SigmaDocument; observedRevision: number } | null = null;
          let openFailure: DocumentOpenFailure | null = null;
          for (const candidateFileId of candidateFileIds) {
            const candidate = await loadWorkspaceDocument(candidateFileId);
            if (cancelled) {
              return;
            }
            if (candidate) {
              nextActiveFileId = candidateFileId;
              activeDocument = candidate;
              break;
            }
            // 教材の中身 (壊れたJSON / スキーマ違反) が原因の失敗は読み飛ばさない。
            // 黙って別教材が開くと「Sigma Studioが開けない」ように見えるため、
            // その教材を開いたまま原因と修復プロンプトを出す。
            openFailure = showRecordedDocumentOpenFailure(candidateFileId);
            if (openFailure) {
              break;
            }
          }

          if (openFailure) {
            const nextOpenFileIds = uniqueStringIds([
              ...workspace.state.openFileIds.filter((fileId) => availableFileIds.has(fileId)),
              openFailure.fileId,
            ]);
            await refreshDocumentMetadatas();
            if (cancelled) return;
            setWorkspaceReady(true);
            await enterDocumentOpenFailureState(openFailure, nextOpenFileIds);
            if (requestedFileId) {
              clearRequestedFileId();
            }
            return;
          }

          if (activeDocument && nextActiveFileId) {
            const migrated = repairDuplicateTopLevelIds(
              ensurePageLayout(activeDocument.document),
              DOCUMENT_BLOCK_OPERATION_PORTS,
            );
            const nextOpenFileIds = uniqueStringIds([
              ...workspace.state.openFileIds.filter((fileId) => availableFileIds.has(fileId)),
              nextActiveFileId,
            ]);
            activateDocument(migrated, nextActiveFileId, nextOpenFileIds, activeDocument.observedRevision);
            await refreshDocumentMetadatas();
            if (cancelled) return;
            setWorkspaceReady(true);
            await saveWorkspaceState({ openFileIds: nextOpenFileIds, activeFileId: nextActiveFileId });
            if (requestedFileId) {
              clearRequestedFileId();
            }
            if (cancelled) return;
            setStatusMessage(storageWarningOrStatus(requestedFileId && nextActiveFileId !== requestedFileId
              ? tEditor("status.fallbackDocument")
              : tEditor("status.ready")));
            return;
          }

          const fallback = await createNewDocument();
          if (cancelled) {
            return;
          }

          activateDocument(fallback.document, fallback.fileId, [fallback.fileId], fallback.metadata.revision);
          await refreshDocumentMetadatas();
          if (cancelled) return;
          setWorkspaceReady(true);
          if (requestedFileId) {
            clearRequestedFileId();
          }
          setStatusMessage(storageWarningOrStatus(tEditor("status.documentCreated")));
        })
        .catch((error) => {
          if (cancelled) {
            return;
          }
          setSaveState("error");
          setStatusMessage(error instanceof Error ? error.message : tEditor("status.restoreFailed"));
          setWorkspaceReady(true);
        });
    }, 0);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [enterDocumentOpenFailureState, isEmbedded, loadWorkspaceDocument, refreshDocumentMetadatas, activateDocument, installLayout, saveWorkspaceState, setSaveState, setStatusMessage, showRecordedDocumentOpenFailure, workspaceReloadNonce, setWorkspaceReady, setLedgerFailure]);

}
