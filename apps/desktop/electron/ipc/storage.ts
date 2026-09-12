import { ipcMain } from "electron";

import {
  LocalMcpEditProposalStore,
  type LocalMcpEditProposal,
  type LocalMcpEditProposalChangeEvent,
} from "../local-sigma-doc-proposal-store";
import { LocalSigmaDocStore, type LocalStoreChangeEvent } from "../local-sigma-doc-store";
import { toLedgerSchemaFailure } from "../ledger-schema-error";
import { createProposalApprovalCoordinator, type ApproveProposalResult } from "../proposal-approval";
import type { SigmaDocument } from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface RegisterStorageIpcDeps {
  localSigmaDocStore: LocalSigmaDocStore;
  localMcpProposalStore: LocalMcpEditProposalStore;
  approveSingleProposal: (
    proposalId: string,
    options?: { autoApplied?: boolean; force?: boolean },
  ) => Promise<ApproveProposalResult>;
  broadcastLocalStoreChange: (event: LocalStoreChangeEvent | LocalMcpEditProposalChangeEvent) => void;
  /** 保存が成功するたびに呼ぶ共通フック (自動rebase + 自動承認再チェックのスケジューリング)。 */
  runPostSaveHooks: (fileId: string, document: SigmaDocument, revision: number) => Promise<void>;
  /**
   * renderer からの保存IPC (storage:save-document、= 人間の自動保存) が成功するたびに記録する
   * フック。検証済み自動承認 (runAutoApplyCheck) が「人間が今アクティブに編集中の教材」を
   * 判定するために使う。承認IPC・revert等ここを通らない保存経路では呼ばない。
   */
  recordRendererSave: (fileId: string) => void;
}

export function registerStorageIpc(deps: RegisterStorageIpcDeps): void {
  const {
    localSigmaDocStore,
    localMcpProposalStore,
    approveSingleProposal,
    broadcastLocalStoreChange,
    runPostSaveHooks,
    recordRendererSave,
  } = deps;
  const approvalCoordinator = createProposalApprovalCoordinator({
    localSigmaDocStore,
    localMcpProposalStore,
    broadcastLocalStoreChange,
    runPostSaveHooks,
    translate: te,
  });

  ipcMain.handle("storage:initialize-workspace", async (_event, payload: unknown) => {
    try {
      const state = await localSigmaDocStore.initializeWorkspace(
        payload as Parameters<LocalSigmaDocStore["initializeWorkspace"]>[0],
      );
      return { ok: true, state };
    } catch (error) {
      const ledgerError = toLedgerSchemaFailure(error);
      if (ledgerError) {
        return { ok: false, ledgerError };
      }
      throw error;
    }
  });

  ipcMain.handle("storage:list-files", async () => {
    return localSigmaDocStore.listFiles();
  });

  ipcMain.handle("storage:load-document", async (_event, fileId: string) => {
    return localSigmaDocStore.loadDocument(fileId);
  });

  ipcMain.handle("storage:load-document-with-recovery", async (_event, fileId: string) => {
    return localSigmaDocStore.loadDocumentWithRecovery(fileId);
  });

  ipcMain.handle("storage:save-document", async (
    _event,
    fileId: string,
    document: unknown,
    rawOptions: unknown,
  ) => {
    const expectedRevision = isPlainObject(rawOptions) ? rawOptions.expectedRevision : undefined;
    if (typeof expectedRevision !== "number" || !Number.isFinite(expectedRevision)) {
      return {
        ok: false,
        error: te("electron.storage.revisionMissing"),
      };
    }
    const nextDocument = document as Parameters<LocalSigmaDocStore["saveDocument"]>[1];
    const origin = isPlainObject(rawOptions) && ["ai", "tab-switch", "app-close"].includes(String(rawOptions.origin))
      ? rawOptions.origin as "ai" | "tab-switch" | "app-close"
      : "user";
    const saveResult = await localSigmaDocStore.saveDocument(fileId, nextDocument, { expectedRevision, origin });
    if (saveResult.ok && saveResult.revision !== undefined) {
      if (saveResult.versionCaptured) {
        broadcastLocalStoreChange({ type: "documentVersion", fileId, change: "captured", timestamp: Date.now() });
      }
      recordRendererSave(fileId);
      await runPostSaveHooks(fileId, nextDocument, saveResult.revision);
    }
    return saveResult;
  });

  ipcMain.handle("storage:list-document-versions", async (_event, fileId: string) => {
    return localSigmaDocStore.listDocumentVersions(fileId);
  });

  ipcMain.handle("storage:get-document-version", async (_event, fileId: string, versionId: string) => {
    return localSigmaDocStore.getDocumentVersion(fileId, versionId);
  });

  ipcMain.handle("storage:capture-document-version", async (
    _event,
    fileId: string,
    document: unknown,
    rawOptions: unknown,
  ) => {
    if (!isPlainObject(rawOptions) || typeof rawOptions.expectedRevision !== "number") {
      return { ok: false, error: te("electron.storage.revisionMissing") };
    }
    const origin = ["ai", "restore-backup", "tab-switch", "app-close"].includes(String(rawOptions.origin))
      ? rawOptions.origin as "ai" | "restore-backup" | "tab-switch" | "app-close"
      : "user";
    const result = await localSigmaDocStore.captureDocumentVersion(
      fileId,
      document as SigmaDocument,
      { expectedRevision: rawOptions.expectedRevision, origin },
    );
    if (result.ok && result.version) {
      broadcastLocalStoreChange({ type: "documentVersion", fileId, change: "captured", timestamp: Date.now() });
    }
    return result;
  });

  ipcMain.handle("storage:create-document", async (_event, payload: unknown) => {
    return localSigmaDocStore.createDocument(payload as Parameters<LocalSigmaDocStore["createDocument"]>[0]);
  });

  ipcMain.handle("storage:create-file-from-document", async (_event, payload: unknown) => {
    return localSigmaDocStore.createFileFromDocument(
      payload as Parameters<LocalSigmaDocStore["createFileFromDocument"]>[0],
    );
  });

  ipcMain.handle("storage:duplicate-file", async (_event, fileId: string) => {
    return localSigmaDocStore.duplicateFile(fileId);
  });

  ipcMain.handle("storage:delete-file", async (_event, fileId: string, options?: { expectedRevision: number }) => {
    return localSigmaDocStore.deleteFile(fileId, options);
  });

  ipcMain.handle("storage:save-workspace", async (_event, state: unknown) => {
    return localSigmaDocStore.saveWorkspace(state as Parameters<LocalSigmaDocStore["saveWorkspace"]>[0]);
  });

  ipcMain.handle("storage:get-workspace-overview", async (_event, workspaceId?: string | null) => {
    return localSigmaDocStore.getWorkspaceOverview(workspaceId);
  });

  ipcMain.handle("storage:create-workspace", async (_event, name: string) => {
    return localSigmaDocStore.createWorkspace(name);
  });

  ipcMain.handle("storage:rename-workspace", async (_event, workspaceId: string, name: string) => {
    return localSigmaDocStore.renameWorkspace(workspaceId, name);
  });

  ipcMain.handle("storage:delete-workspace", async (_event, workspaceId: string) => {
    return localSigmaDocStore.deleteWorkspace(workspaceId);
  });

  ipcMain.handle("storage:create-folder", async (
    _event,
    workspaceId: string,
    name: string,
    parentFolderId?: string | null,
  ) => {
    return localSigmaDocStore.createFolder(workspaceId, name, parentFolderId);
  });

  ipcMain.handle("storage:update-folder", async (
    _event,
    workspaceId: string,
    folderId: string,
    patch: unknown,
  ) => {
    return localSigmaDocStore.updateFolder(
      workspaceId,
      folderId,
      patch as Parameters<LocalSigmaDocStore["updateFolder"]>[2],
    );
  });

  ipcMain.handle("storage:delete-folder", async (_event, workspaceId: string, folderId: string) => {
    return localSigmaDocStore.deleteFolder(workspaceId, folderId);
  });

  ipcMain.handle("storage:move-file-to-folder", async (
    _event,
    workspaceId: string,
    fileId: string,
    folderId?: string | null,
  ) => {
    return localSigmaDocStore.moveFileToFolder(workspaceId, fileId, folderId);
  });

  ipcMain.handle("storage:move-file-to-workspace", async (
    _event,
    fileId: string,
    targetWorkspaceId: string,
    folderId?: string | null,
  ) => {
    return localSigmaDocStore.moveFileToWorkspace(fileId, targetWorkspaceId, folderId);
  });

  ipcMain.handle("storage:get-data-dir", async () => {
    return { path: localSigmaDocStore.getDataDir() };
  });

  ipcMain.handle("storage:list-mcp-edit-proposals", async (_event, rawOptions?: unknown) => {
    const options = (isPlainObject(rawOptions) ? rawOptions : {}) as {
      status?: unknown;
      fileId?: string;
      resolvedLimit?: number;
    };
    const status = options.status;
    const validStatus = (
      status === "all"
      || status === "pending"
      || status === "approved"
      || status === "rejected"
      || status === "reverted"
    ) ? status : "pending";

    return localMcpProposalStore.listProposals({
      status: validStatus,
      fileId: options.fileId,
      resolvedLimit: options.resolvedLimit,
    });
  });

  ipcMain.handle("storage:begin-mcp-proposal-run", async (_event, roomId: unknown, fileId: unknown) => {
    try {
      const snapshotId = await localMcpProposalStore.beginProposalRunSnapshot(
        typeof roomId === "string" ? roomId : "",
        typeof fileId === "string" ? fileId : "",
      );
      return { ok: true, snapshotId };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : te("electron.storage.runStartFailed") };
    }
  });

  ipcMain.handle("storage:complete-mcp-proposal-run", async (_event, snapshotId: unknown) => ({
    ok: typeof snapshotId === "string" && localMcpProposalStore.completeProposalRunSnapshot(snapshotId),
  }));

  ipcMain.handle("storage:rollback-mcp-proposal-run", async (_event, snapshotId: unknown) => ({
    ok: typeof snapshotId === "string" && await localMcpProposalStore.rollbackProposalRunSnapshot(snapshotId),
  }));

  ipcMain.handle("storage:approve-mcp-edit-proposal", async (_event, proposalId: string, rawOptions?: unknown) => {
    const force = isPlainObject(rawOptions) && rawOptions.force === true;
    return approveSingleProposal(proposalId, { force });
  });

  ipcMain.handle("storage:approve-mcp-edit-proposals", (_event, rawIds: unknown, rawOptions?: unknown) => (
    approvalCoordinator.approveProposals(rawIds, rawOptions)
  ));

  // 旧来の単一proposalId呼び出し (renderer側の既存呼び出しはこれを .map() で複数回呼んでいる)
  // との後方互換を保ちつつ、reasonつきの一括却下 { proposalIds, reason } もサポートする。
  ipcMain.handle("storage:reject-mcp-edit-proposal", async (_event, proposalId: string) => {
    try {
      const proposal = await localMcpProposalStore.resolveProposal(proposalId, "rejected", te("electron.proposal.desktopRejected"));
      broadcastLocalStoreChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
      return { ok: true, proposal };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.proposalStore.rejectFailed"),
      };
    }
  });

  // 新しい却下IPC: 理由つきで複数件をまとめて却下できる。approve-mcp-edit-proposals (承認の複数形)
  // と対になる命名。各対象は独立に却下されるため、一部が処理済みで失敗しても他は処理を続ける。
  ipcMain.handle("storage:reject-mcp-edit-proposals", async (_event, rawPayload: unknown) => {
    const payload = isPlainObject(rawPayload) ? rawPayload : {};
    const proposalIds = Array.isArray(payload.proposalIds)
      ? payload.proposalIds.filter((id): id is string => typeof id === "string")
      : [];
    const reason = typeof payload.reason === "string" && payload.reason.trim() ? payload.reason.trim() : undefined;
    if (proposalIds.length === 0) {
      return { ok: false, error: te("electron.storage.noneToReject") };
    }

    const { rejected, failed } = await localMcpProposalStore.rejectProposals(proposalIds, reason);
    if (rejected.length > 0) {
      broadcastLocalStoreChange({
        type: "mcpProposal",
        change: "changed",
        timestamp: Date.now(),
        rejectedProposalIds: rejected.map((proposal) => proposal.proposalId),
        ...(reason ? { rejectedReason: reason } : {}),
      });
    }
    if (rejected.length === 0) {
      return { ok: false, error: failed[0]?.error ?? te("electron.proposalStore.rejectFailed") };
    }
    return { ok: true, proposals: rejected, failed };
  });

  // pending提案を、提案作成時点 (baseRevision) ではなく現在のドキュメントに対して
  // 再適用できるか試す。承認プレビューが「stale (baseRevisionが古い)」状態のとき、
  // 提案を作り直させずにその場で追従させるためのIPC。
  ipcMain.handle("storage:rebase-mcp-edit-proposal", async (_event, rawProposalId: unknown) => {
    const proposalId = typeof rawProposalId === "string" ? rawProposalId.trim() : "";
    if (!proposalId) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    const proposal = await localMcpProposalStore.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    const file = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === proposal.fileId);
    if (!file) {
      return { ok: false, reason: te("electron.proposal.documentNotFound") };
    }
    const currentDocument = await localSigmaDocStore.loadDocument(proposal.fileId);
    if (!currentDocument) {
      return { ok: false, reason: te("electron.proposal.documentLoadFailed") };
    }
    const result = await localMcpProposalStore.rebaseProposal(proposalId, currentDocument, file.revision);
    if (result.ok) {
      broadcastLocalStoreChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
    }
    return result;
  });

  // 却下(rejected)・差し戻し(reverted)済みdraftをAI再実行なしでpendingに戻す。対象の内容が
  // 却下/差し戻し後に変更された場合やdraftが現在SigmaDocへreplayできない場合はstoreが拒否し、
  // レコードは元のstatusのまま保つ。
  ipcMain.handle("storage:restore-mcp-edit-proposal", async (_event, rawProposalId: unknown) => {
    const proposalId = typeof rawProposalId === "string" ? rawProposalId.trim() : "";
    if (!proposalId) {
      return { ok: false, error: te("electron.proposal.notFound") };
    }
    const proposal = await localMcpProposalStore.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, error: te("electron.proposal.notFound") };
    }
    const file = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === proposal.fileId);
    if (!file) {
      return { ok: false, error: te("electron.proposal.documentNotFound") };
    }
    const currentDocument = await localSigmaDocStore.loadDocument(proposal.fileId);
    if (!currentDocument) {
      return { ok: false, error: te("electron.proposal.documentLoadFailed") };
    }
    const result = await localMcpProposalStore.restoreResolvedProposal(proposalId, currentDocument, file.revision);
    if (!result.ok) {
      return { ok: false, error: result.reason };
    }
    broadcastLocalStoreChange({ type: "mcpProposal", proposalId, change: "changed", timestamp: Date.now() });
    return result;
  });

  // エディタの Ctrl+Z (undo) がAI適用を1手で取り消したときのストア側整合。ドキュメント本体の
  // 巻き戻しは renderer の undo スタック + 自動保存が行うため、ここでは提案の status 遷移
  // (approved → reverted) だけを行う。revert-mcp-edit-proposal と違い appliedRevision の一致は
  // 要求しない — undo は後続編集を先に巻き戻してから到達する順序が保証されているため。
  ipcMain.handle("storage:mark-mcp-edit-proposals-reverted", async (_event, rawIds: unknown) => {
    const proposalIds = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
    if (proposalIds.length === 0) {
      return { ok: false, error: te("electron.storage.noneToUndo") };
    }
    const { transitioned, skipped } = await localMcpProposalStore.markProposalsRevertedByUndo(proposalIds);
    if (transitioned.length > 0) {
      broadcastLocalStoreChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
    }
    return { ok: transitioned.length > 0, transitioned, skipped };
  });

  // markProposalsRevertedByUndo の逆方向: Ctrl+Y (redo) がAI適用をやり直したとき reverted → approved。
  ipcMain.handle("storage:mark-mcp-edit-proposals-reapplied", async (_event, rawIds: unknown) => {
    const proposalIds = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
    if (proposalIds.length === 0) {
      return { ok: false, error: te("electron.storage.noneToRedo") };
    }
    const { transitioned, skipped } = await localMcpProposalStore.markProposalsReappliedByRedo(proposalIds);
    if (transitioned.length > 0) {
      broadcastLocalStoreChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
    }
    return { ok: transitioned.length > 0, transitioned, skipped };
  });

  // 承認済み (approved) 提案の取り消し。承認直後のrevisionから教材がさらに変更されていなければ
  // revertDocumentをまるごと書き戻す (mode: "full")。それ以降に無関係な編集が入っていても、
  // この提案(と同じ保存を共有した承認バッチ全員)が触った範囲自体が無編集なら、現在の
  // ドキュメントを土台にその範囲だけ書き戻す (mode: "selective", getRevertPlan/
  // buildSelectiveRevertDocument参照)。どちらも保存なので新しいrevisionが発行される
  // (「なかったことにする」のではなく前方向の1手として記録される)。
  ipcMain.handle("storage:revert-mcp-edit-proposal", async (_event, rawProposalId: unknown) => {
    const proposalId = typeof rawProposalId === "string" ? rawProposalId.trim() : "";
    if (!proposalId) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    const proposal = await localMcpProposalStore.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, reason: te("electron.proposal.notFound") };
    }
    // 「revisionの確認→(選択的revertなら合成)→保存」を同じfileIdについて直列化する
    // (approveSingleProposalと同じ理由: この間に他の保存が割り込むと、確認済みのはずの
    // revisionがずれた状態で保存してしまう)。
    return localSigmaDocStore.runExclusive(proposal.fileId, async () => {
      const currentFile = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === proposal.fileId);
      if (!currentFile) {
        return { ok: false, reason: te("electron.proposal.documentNotFound") };
      }
      const currentDocument = await localSigmaDocStore.loadDocument(proposal.fileId);
      if (!currentDocument) {
        return { ok: false, reason: te("electron.proposal.documentLoadFailed") };
      }
      const plan = await localMcpProposalStore.getRevertPlan(proposalId, currentFile.revision, currentDocument);
      if (!plan.ok) {
        return plan;
      }
      const saveResult = await localSigmaDocStore.saveDocument(proposal.fileId, plan.document, {
        expectedRevision: currentFile.revision,
      });
      if (!saveResult.ok) {
        return { ok: false, reason: saveResult.error ?? te("electron.storage.undoSaveFailed") };
      }
      if (saveResult.versionCaptured) {
        broadcastLocalStoreChange({ type: "documentVersion", fileId: proposal.fileId, change: "captured", timestamp: Date.now() });
      }
      // バッチ全員 (このIPCが解決した proposalId 自身を含む) を reverted に遷移させる。
      // approve-mcp-edit-proposals が1回の保存で複数提案を合成した場合、この保存1回で
      // バッチ全員が巻き戻されたことになるため、全員のstatusを揃える必要がある。
      let revertedProposal: LocalMcpEditProposal | undefined;
      for (const id of plan.proposalIds) {
        const reverted = await localMcpProposalStore.markReverted(id);
        if (id === proposalId) {
          revertedProposal = reverted;
        }
        broadcastLocalStoreChange({ type: "mcpProposal", proposalId: id, change: "changed", timestamp: Date.now() });
      }
      broadcastLocalStoreChange({ type: "document", fileId: proposal.fileId, change: "changed", timestamp: Date.now() });
      await runPostSaveHooks(proposal.fileId, plan.document, saveResult.revision ?? currentFile.revision);
      return { ok: true, proposal: revertedProposal };
    });
  });
}
