import { isDeepStrictEqual } from "node:util";

import type { SigmaDocument } from "@/features/document";
import {
  createEmptyProposalMergeReport,
  isProposalMergeQuiet,
  type ProposalMergeReport,
} from "@/lib/ai/proposal-merge-basis";
import { createAiEditSessionDocumentDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { Translate } from "@/lib/i18n";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { LocalMcpEditProposalStore } from "./local-sigma-doc-proposal-store";
import type { LocalSigmaDocStore, LocalStoreChangeEvent } from "./local-sigma-doc-store";
import type {
  LocalMcpEditProposal,
  LocalMcpEditProposalChangeEvent,
  LocalMcpEditProposalConflictReason,
} from "./proposals/contracts";
import {
  canForceApplyProposalConflict,
  classifyProposalReplayFailure,
  findProposalFreshnessConflict,
  replayMergeableProposal,
} from "./proposals/freshness";
import {
  assertAppliedProposalHasRealChanges,
  mergeProposalDraftsIntoDocument,
  replayProposalForApproval,
} from "./proposals/replay";

export interface ProposalApprovalPorts {
  sharedProposalApprover?: (proposals: LocalMcpEditProposal[]) => Promise<ApproveProposalResult | undefined>;
  localSigmaDocStore: Pick<LocalSigmaDocStore, "runExclusive" | "listFiles" | "loadDocument" | "saveDocument">;
  localMcpProposalStore: Pick<
    LocalMcpEditProposalStore,
    "loadProposal" | "runExclusive" | "recordProposalConflict" | "recordAutoApplyDeferred" | "resolveProposal"
  >;
  broadcastLocalStoreChange: (event: LocalStoreChangeEvent | LocalMcpEditProposalChangeEvent) => void;
  runPostSaveHooks: (fileId: string, document: SigmaDocument, revision: number) => Promise<void>;
  translate: Translate<"error">;
}

export type ApproveProposalResult =
  | {
      ok: true;
      proposal: LocalMcpEditProposal;
      file: Awaited<ReturnType<LocalSigmaDocStore["listFiles"]>>[number];
      document: SigmaDocument;
      /**
       * What the merging replay decided; the renderer counts its fallbacks (MISS R3). Absent for a
       * shared document's approval, which does not go through the local replay.
       */
      mergeReport?: ProposalMergeReport;
    }
  | {
      ok: false;
      error: string;
      /**
       * conflict: the proposal could not be replayed onto the current document.
       * merge-review: an automatic approval was skipped because the replay merged the human's
       * edits; the proposal stays pending for a manual decision.
       */
      code?: "conflict" | "merge-review";
      conflictBlockIds?: string[];
      conflictReason?: LocalMcpEditProposalConflictReason;
    };

/**
 * 承認の application boundary。永続化と通知はホストが提供し、ここが lock・再検査・replay・
 * 保存・提案解決の順序を所有する。単体と一括で異なる部分失敗と通知順序は各入口に残す。
 * external canvas editors の transaction / after-event の所有分離を参考にした独自実装であり、依存はない。
 */
export function createProposalApprovalCoordinator({
  sharedProposalApprover,
  localSigmaDocStore,
  localMcpProposalStore,
  broadcastLocalStoreChange,
  runPostSaveHooks,
  translate: te,
}: ProposalApprovalPorts) {
  // storage:approve-mcp-edit-proposal (手動の単体承認) と、検証済み自動承認 (aiAutoApplyVerifiedProposals
  // 設定がON、runAutoApplyCheck 経由) の両方から呼ばれる共通の承認ロジック。
  // revert (取り消し) のため、適用前に読み込んだ現在ドキュメントを revertDocument として、
  // 保存直後のファイルrevisionを appliedRevision として提案レコードに保存する。
  //
  // localSigmaDocStore.runExclusive で「最新doc読込→鮮度確認→replay→saveDocument」全体を
  // 同じfileIdについて直列化する: この間に人間の自動保存や別の承認が割り込むと、鮮度確認が
  // 古い前提のまま replay してしまい、上書き(ロストアップデート)が起きうるため。
  async function approveSingleProposal(
    proposalId: string,
    options: { autoApplied?: boolean; force?: boolean } = {},
  ): Promise<ApproveProposalResult> {
    const proposal = await localMcpProposalStore.loadProposal(proposalId);
    if (!proposal) {
      return { ok: false, error: te("electron.proposal.notFound") };
    }
    if (proposal.status !== "pending") {
      return { ok: false, error: te("electron.proposal.alreadyProcessed") };
    }
    const shared = await sharedProposalApprover?.([proposal]);
    if (shared) return shared;

    return localMcpProposalStore.runExclusive(proposal.fileId, async (): Promise<ApproveProposalResult> => {
      // lock待機中にreject/upsertされた場合は、クリック時のdraftを適用せずCAS失敗として返す。
      const claimedProposal = await localMcpProposalStore.loadProposal(proposalId);
      if (!claimedProposal) {
        return { ok: false, error: te("electron.proposal.notFound") };
      }
      if (
        claimedProposal.status !== "pending"
        || claimedProposal.fileId !== proposal.fileId
        || claimedProposal.updatedAt !== proposal.updatedAt
        || !isDeepStrictEqual(claimedProposal.draft, proposal.draft)
      ) {
        return { ok: false, error: te("electron.proposal.changedWhilePending") };
      }

      return localSigmaDocStore.runExclusive(claimedProposal.fileId, async (): Promise<ApproveProposalResult> => {
      const file = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === claimedProposal.fileId);
      if (!file) {
        return { ok: false, error: te("electron.proposal.documentNotFound") };
      }

      const loadedBaseDocument = await localSigmaDocStore.loadDocument(claimedProposal.fileId);
      if (!loadedBaseDocument) {
        return { ok: false, error: te("electron.proposal.documentLoadFailed") };
      }
      // revertへ戻すための「適用直前 (マージ前) に読み込んだ現在ドキュメント」。rebase後の承認では
      // proposal.baseDocument (提案作成時点のもの) ではなく必ずこの時点の最新ドキュメントを使う。
      const revertDocument = parseSigmaDocument(loadedBaseDocument);

      // 鮮度確認: draftが実際に上書き・削除・更新する対象だけをbaseHashと比較する。
      // insert系は選択範囲やアンカー本文が変わっていても競合にせず、最新SigmaDocへのreplayを試す。
      // 精密判定できない旧提案だけrequestSelection/touchedBlocksへフォールバックする。
      const currentHashes = computeDocumentBlockHashes(revertDocument);
      // base (mergeBasis) を持つ提案は鮮度確認と適用を1回の合成replayで行う: 人間の編集を残して
      // 合成できれば競合にせず、できない理由 (対象の消失など) だけを従来の競合として返す。
      const mergeable = claimedProposal.mergeBasis && !claimedProposal.invalidReason
        ? { draft: claimedProposal.draft, mergeBasis: claimedProposal.mergeBasis, touchedBlocks: claimedProposal.touchedBlocks }
        : null;
      let merged = mergeable ? replayMergeableProposal(mergeable, revertDocument, currentHashes) : null;
      const conflict = merged
        ? (merged.ok ? null : merged.conflict)
        : findProposalFreshnessConflict(
            claimedProposal,
            currentHashes,
            file.revision,
            revertDocument,
          );
      if (conflict && (!options.force || !canForceApplyProposalConflict(conflict))) {
          await localMcpProposalStore.recordProposalConflict(
            claimedProposal.proposalId,
            conflict.blockIds,
            file.revision,
            conflict.reason,
          );
          return {
            ok: false,
            error: claimedProposal.invalidReason ?? (conflict.reason === "anchor-missing"
              ? te("electron.proposal.regenerateMissingTarget")
              : conflict.reason === "asset-collision"
                ? te("electron.proposal.regenerateAssetCollision")
                : conflict.reason === "replay-failed"
                  ? te("electron.proposal.regenerateReplayFailed")
                  : te("electron.proposal.changedBeforeApproval")
            ),
            code: "conflict",
            conflictBlockIds: conflict.blockIds,
            conflictReason: conflict.reason,
          };
      }

      if (mergeable && merged && !merged.ok) {
        // 合成対象外の操作の対象が変わっていた (content-stale) のを force で越えた場合も、上書き
        // する単位は合成replayで人間の編集を残す。
        merged = replayMergeableProposal(mergeable, revertDocument, currentHashes, { allowContentStale: true });
        if (!merged.ok) {
          await localMcpProposalStore.recordProposalConflict(
            claimedProposal.proposalId,
            merged.conflict.blockIds,
            file.revision,
            merged.conflict.reason,
          );
          return {
            ok: false,
            error: te("electron.proposal.applyFailed"),
            code: "conflict",
            conflictBlockIds: merged.conflict.blockIds,
            conflictReason: merged.conflict.reason,
          };
        }
      }

      if (options.autoApplied && merged?.ok && !isProposalMergeQuiet(merged.result.report)) {
        // 自動承認は「人間の編集と重ならない」提案だけ。合成が起きた提案はpendingのまま残し、
        // 人間が内容を見て承認する。文書のrevisionが変わるまで再試行しないよう記録する。
        await localMcpProposalStore.recordAutoApplyDeferred(claimedProposal.proposalId, file.revision, merged.result.report);
        return { ok: false, error: te("electron.proposal.autoApplyNeedsReview"), code: "merge-review" };
      }

      let nextDocument: SigmaDocument = revertDocument;
      const mergeReport: ProposalMergeReport = merged?.ok
        ? merged.result.report
        : { ...createEmptyProposalMergeReport(), legacyNoBase: 1 };
      try {
        nextDocument = merged?.ok
          ? merged.result.nextDocument
          : createAiEditSessionDocumentDraft(nextDocument, null, claimedProposal.draft).nextDocument;
      } catch {
        const replayConflict = classifyProposalReplayFailure(claimedProposal, revertDocument);
        await localMcpProposalStore.recordProposalConflict(
          claimedProposal.proposalId,
          replayConflict.blockIds,
          file.revision,
          replayConflict.reason,
        );
        return {
          ok: false,
          error: te("electron.proposal.applyFailed"),
        };
      }

      try {
        assertAppliedProposalHasRealChanges(
          parseSigmaDocument(revertDocument),
          nextDocument,
          claimedProposal.draft,
          merged?.ok ? claimedProposal.mergeBasis : undefined,
        );
      } catch (error) {
        const replayConflict = classifyProposalReplayFailure(claimedProposal, revertDocument);
        await localMcpProposalStore.recordProposalConflict(
          claimedProposal.proposalId,
          replayConflict.blockIds,
          file.revision,
          replayConflict.reason,
        );
        return {
          ok: false,
          error: error instanceof Error ? error.message : te("electron.proposal.validationFailed"),
        };
      }

      const saveResult = await localSigmaDocStore.saveDocument(claimedProposal.fileId, nextDocument, {
        expectedRevision: file.revision,
        origin: "ai",
      });
      if (!saveResult.ok) {
        return { ok: false, error: saveResult.error ?? te("electron.proposal.saveFailed") };
      }
      if (saveResult.versionCaptured) {
        broadcastLocalStoreChange({
          type: "documentVersion",
          fileId: claimedProposal.fileId,
          change: "captured",
          timestamp: Date.now(),
        });
      }
      const savedFile = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === claimedProposal.fileId) ?? file;
      const resolved = await localMcpProposalStore.resolveProposal(
        proposalId,
        "approved",
        options.autoApplied ? te("electron.proposal.autoApproved") : te("electron.proposal.desktopApproved"),
        {
          appliedRevision: savedFile.revision,
          revertDocument,
          appliedDocument: nextDocument,
          autoApplied: options.autoApplied,
          mergeReport,
        },
      );
      await runPostSaveHooks(claimedProposal.fileId, nextDocument, saveResult.revision ?? savedFile.revision);
      broadcastLocalStoreChange({
        type: "mcpProposal",
        proposalId,
        change: "changed",
        timestamp: Date.now(),
        ...(options.autoApplied ? { autoApplied: true } : {}),
      });
      broadcastLocalStoreChange({
        type: "document",
        fileId: claimedProposal.fileId,
        change: "changed",
        timestamp: Date.now(),
        ...(options.autoApplied ? { autoAppliedProposalIds: [proposalId] } : {}),
      });
      return { ok: true, proposal: resolved, file: savedFile, document: nextDocument, mergeReport };
      });
    });
  }

  // 複数の pending proposal を1つの編集として一括承認する (決定A: Claudeの複数編集を合体)。
  // 各提案は独立に作られるため nextDocument を順に保存すると上書きになる。そこで全提案の
  // operations を作成順に現在のドキュメントへ累積適用 (= rebase replay) してから1回だけ保存する。
  // baseRevision が run 途中の人手編集等で提案ごとに異なっていてもよい。衝突判定はrevision全体
  // ではなく、各draftが実際に上書きする対象の内容で行うため、同一runの追加提案はrevisionを
  // 跨いでも1回で承認できる。
  async function approveProposals(rawIds: unknown, rawOptions?: unknown) {
    const ids = Array.isArray(rawIds) ? rawIds.filter((id): id is string => typeof id === "string") : [];
    if (ids.length === 0) {
      return { ok: false, error: te("electron.storage.noneToApprove") };
    }
    const force = isPlainObject(rawOptions) && rawOptions.force === true;

    const proposals: LocalMcpEditProposal[] = [];
    for (const id of ids) {
      const proposal = await localMcpProposalStore.loadProposal(id);
      if (!proposal) {
        return { ok: false, error: te("electron.storage.proposalNotFoundWithId", { id }) };
      }
      if (proposal.status !== "pending") {
        return { ok: false, error: te("electron.proposal.alreadyProcessed") };
      }
      proposals.push(proposal);
    }

    const fileId = proposals[0].fileId;
    if (!proposals.every((proposal) => proposal.fileId === fileId)) {
      return { ok: false, error: te("electron.storage.crossDocumentBatch") };
    }
    const shared = await sharedProposalApprover?.(proposals);
    if (shared) return shared;

    // proposal側を先にclaim(CAS)し、その保持中にdocument側のread-modify-write lockを取る。
    // reject/upsert/auto-approvalも同じproposal lockを通るため、クリック時に読んだdraftを待機後に
    // staleなまま保存したり、却下済みproposalを適用したりする窓を作らない。
    return localMcpProposalStore.runExclusive(fileId, async () => {
      const claimedProposals: LocalMcpEditProposal[] = [];
      for (const expected of proposals) {
        const current = await localMcpProposalStore.loadProposal(expected.proposalId);
        if (!current) {
          return { ok: false, error: te("electron.storage.proposalNotFoundWithId", { id: expected.proposalId }) };
        }
        if (
          current.status !== "pending"
          || current.fileId !== fileId
          || current.updatedAt !== expected.updatedAt
          || !isDeepStrictEqual(current.draft, expected.draft)
        ) {
          return { ok: false, error: te("electron.proposal.changedWhilePending") };
        }
        claimedProposals.push(current);
      }

      // 読込→鮮度確認→合成→保存を同じfileIdについて直列化する (approveSingleProposalと同じ理由)。
      return localSigmaDocStore.runExclusive(fileId, async () => {
      const file = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === fileId);
      if (!file) {
        return { ok: false, error: te("electron.proposal.documentNotFound") };
      }

      const loadedBaseDocument = await localSigmaDocStore.loadDocument(fileId);
      if (!loadedBaseDocument) {
        return { ok: false, error: te("electron.proposal.documentLoadFailed") };
      }
      // revertへ戻すための「適用直前に読み込んだ現在ドキュメント」。バッチ内の全提案が
      // 同じ1回の保存を共有するため、同じ値を全員に記録する (revertはこのバッチ全体を戻す)。
      const revertDocument = parseSigmaDocument(loadedBaseDocument);

      // 鮮度確認: content-staleだけはforceで解決できる。アンカー消失・asset ID衝突など
      // replay自体が成功しない競合はforceでも除外し、再生成が必要な理由を返す。
      let candidateProposals = claimedProposals;
      const conflicted: {
        proposalId: string;
        error: string;
        conflictReason: LocalMcpEditProposalConflictReason;
        conflictBlockIds: string[];
      }[] = [];
      const currentHashes = computeDocumentBlockHashes(revertDocument);
      const nonConflicting = [];
      for (const proposal of claimedProposals) {
        const conflict = findProposalFreshnessConflict(
          proposal,
          currentHashes,
          file.revision,
          revertDocument,
        );
        if (conflict && (!force || !canForceApplyProposalConflict(conflict))) {
          conflicted.push({
            proposalId: proposal.proposalId,
            error: conflictMessage(conflict.reason, conflict.blockIds),
            conflictReason: conflict.reason,
            conflictBlockIds: conflict.blockIds,
          });
          continue;
        }
        nonConflicting.push(proposal);
      }
      // 承認IPCが最初に検出した競合もpendingレコードへ残す。返り値だけに載せると、rendererの
      // 再読込後に通常提案へ戻って同じ承認失敗を繰り返すため、合成へ進む前にグループ単位で
      // 原子的に記録する。
      for (const conflict of conflicted) {
        await localMcpProposalStore.recordProposalConflict(
          conflict.proposalId,
          conflict.conflictBlockIds,
          file.revision,
          conflict.conflictReason,
        );
      }
      candidateProposals = nonConflicting;

      // 各提案の operations を作成順に現在のドキュメントへ累積適用する。1件が適用できなくても
      // (対象ブロックが先行編集で消えた等)、全体を失敗させず適用できたものだけ承認する。失敗した
      // 提案は pending のまま残るが、原因(エラーメッセージ)を failed として呼び出し元へ返し、
      // renderer側で「何も起きていないように見える」まま黙って残り続けないようにする
      // (合成の中核ロジックは単体テストしやすいよう mergeProposalDraftsIntoDocument に切り出してある)。
      const ordered = [...candidateProposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const merged = mergeProposalDraftsIntoDocument(revertDocument, ordered);
      let nextDocument = merged.document;
      const mergedAppliedIds = merged.appliedIds;
      const mergeFailed = merged.failed;
      // Validate that each proposal will actually create changes before saving
      const validationFailedIds = new Set<string>();
      const validationFailed: { proposalId: string; error: string }[] = [];
      for (const proposalId of mergedAppliedIds) {
        const proposal = ordered.find((p) => p.proposalId === proposalId);
        if (proposal) {
          try {
            // Validate each proposal individually by replaying it from revertDocument,
            // not against the aggregate nextDocument (which includes other proposals' changes).
            // This prevents no-op proposals from incorrectly passing validation when other
            // proposals change the same block.
            // base を持つ提案は「AIがbaseから変えたか」で判定する (人間が同じ変更を先にしていても
            // 誤って失敗にしない)。旧レコードは従来どおり単独replayの実差分で判定する。
            const individualNextDocument = replayProposalForApproval(revertDocument, proposal).nextDocument;
            assertAppliedProposalHasRealChanges(
              parseSigmaDocument(revertDocument),
              parseSigmaDocument(individualNextDocument),
              proposal.draft,
              proposal.mergeBasis,
            );
          } catch (error) {
            validationFailedIds.add(proposalId);
            validationFailed.push({
              proposalId,
              error: error instanceof Error ? error.message : te("electron.storage.aiValidationFailed"),
            });
          }
        }
      }
      let appliedIds = mergedAppliedIds.filter((proposalId) => !validationFailedIds.has(proposalId));
      let mergeReports = merged.reports;
      let mergeReport = merged.report;
      // Rebuild nextDocument with only approved proposals to prevent rejected proposals from being persisted
      if (appliedIds.length > 0 && appliedIds.length < ordered.length) {
        const approvedProposals = ordered.filter((p) => appliedIds.includes(p.proposalId));
        const rebuiltResult = mergeProposalDraftsIntoDocument(revertDocument, approvedProposals);
        // Only use approved proposals' merged result
        nextDocument = rebuiltResult.document;
        // Also update appliedIds from the rebuilding in case there were any merge failures
        appliedIds = rebuiltResult.appliedIds;
        mergeReports = rebuiltResult.reports;
        mergeReport = rebuiltResult.report;
      }
      const failed = [...conflicted, ...mergeFailed, ...validationFailed];
      for (const replayFailure of mergeFailed) {
        const failedProposal = ordered.find((proposal) => proposal.proposalId === replayFailure.proposalId);
        if (!failedProposal) {
          continue;
        }
        const typedFailure = classifyProposalReplayFailure(failedProposal, merged.document);
        await localMcpProposalStore.recordProposalConflict(
          replayFailure.proposalId,
          typedFailure.blockIds,
          file.revision,
          typedFailure.reason,
        );
      }
      for (const replayFailure of validationFailed) {
        const failedProposal = ordered.find((proposal) => proposal.proposalId === replayFailure.proposalId);
        if (!failedProposal) {
          continue;
        }
        const typedFailure = classifyProposalReplayFailure(failedProposal, revertDocument);
        await localMcpProposalStore.recordProposalConflict(
          replayFailure.proposalId,
          typedFailure.blockIds,
          file.revision,
          typedFailure.reason,
        );
      }
      if (appliedIds.length === 0) {
        const firstConflict = conflicted[0];
        return {
          ok: false,
          error: failed[0]?.error ?? te("electron.storage.applyFailed"),
          ...(firstConflict ? {
            code: "conflict" as const,
            conflictReason: firstConflict.conflictReason,
            conflictBlockIds: firstConflict.conflictBlockIds,
          } : {}),
        };
      }

      const saveResult = await localSigmaDocStore.saveDocument(fileId, nextDocument, {
        expectedRevision: file.revision,
        origin: "ai",
      });
      if (!saveResult.ok) {
        return { ok: false, error: saveResult.error ?? te("electron.proposal.saveFailed") };
      }
      if (saveResult.versionCaptured) {
        broadcastLocalStoreChange({ type: "documentVersion", fileId, change: "captured", timestamp: Date.now() });
      }
      const savedFile = (await localSigmaDocStore.listFiles()).find((item) => item.fileId === fileId) ?? file;

      const resolvedProposalIds: string[] = [];
      for (const proposalId of appliedIds) {
        await localMcpProposalStore.resolveProposal(proposalId, "approved", te("electron.proposal.desktopBatchApproved"), {
          appliedRevision: savedFile.revision,
          revertDocument,
          appliedDocument: nextDocument,
          ...(mergeReports[proposalId] ? { mergeReport: mergeReports[proposalId] } : {}),
        });
        resolvedProposalIds.push(proposalId);
      }
      if (resolvedProposalIds.length > 0) {
        broadcastLocalStoreChange({ type: "mcpProposal", change: "changed", timestamp: Date.now() });
      }
      await runPostSaveHooks(fileId, nextDocument, saveResult.revision ?? savedFile.revision);
      broadcastLocalStoreChange({ type: "document", fileId, change: "changed", timestamp: Date.now() });
      return {
        ok: true,
        file: savedFile,
        document: nextDocument,
        versionCaptured: saveResult.versionCaptured,
        versionCaptureError: saveResult.versionCaptureError,
        mergeReport,
        ...(failed.length > 0 ? { failed } : {}),
      };
      });
    });
  }

  function conflictMessage(reason: LocalMcpEditProposalConflictReason, blockIds: string[]): string {
    const targets = blockIds.length > 0 ? ` (${blockIds.join(", ")})` : "";
    if (reason === "anchor-missing") {
      return `${te("electron.proposal.regenerateMissingTarget")}${targets}`;
    }
    if (reason === "asset-collision") {
      return `${te("electron.proposal.regenerateAssetCollision")}${targets}`;
    }
    if (reason === "replay-failed") {
      return `${te("electron.proposal.regenerateReplayFailed")}${targets}`;
    }
    return `${te("electron.proposal.changedBeforeApproval")}${targets}`;
  }

  return { approveSingleProposal, approveProposals };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
