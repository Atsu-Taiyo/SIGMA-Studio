"use client";

import { type OverlayShape } from "@/features/document";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import { useCallback,useEffect,useMemo,useRef,useState } from "react";
import type { EditorAssistanceServices } from "./editor-host-contracts";
import { tAi } from "./editor-translations";

import { useEditorOwnerLifetime } from "./use-editor-owner-lifetime";

type McpProposalRefreshBatch = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};
type ProposalPresentationServices = Pick<EditorAssistanceServices, "groupMcpProposalsForPreview" | "useAiRunSessions" | "deriveAiProposalPresentation" | "isAiRunStatusActive" | "buildSourceReferencesByTurnId" | "buildInsertedShapePreviewsByTurnId" | "buildRestorableProposalsByTurnId" | "buildAppliedTurnChangesByTurnId">;
interface ProposalControllerPorts {
  activeFileId: string;
  activeDocumentRevision: number | null;
  overlayShapes: OverlayShape[];
  getActiveFileId: () => string;
  services: ProposalPresentationServices;
}
export function useMcpProposalController({ activeFileId, activeDocumentRevision, overlayShapes, getActiveFileId, services: { groupMcpProposalsForPreview, useAiRunSessions, deriveAiProposalPresentation, isAiRunStatusActive, buildSourceReferencesByTurnId, buildInsertedShapePreviewsByTurnId, buildRestorableProposalsByTurnId, buildAppliedTurnChangesByTurnId } }: ProposalControllerPorts) {
  const captureLifetime = useEditorOwnerLifetime();
  const MCP_PROPOSAL_REFRESH_DEBOUNCE_MS = 75;
  const [mcpEditProposals, setMcpEditProposals] = useState<DesktopMcpEditProposalSummary[]>([]);
  // チャット turn の参照元チップ・挿入図形サムネイル用。pending プレビューとは別に
  // 全 status の proposal を保持し、適用/却下後も派生表示を turn 下に残す。
  const [mcpProposalCitations, setMcpProposalCitations] = useState<DesktopMcpEditProposalSummary[]>([]);
  const locallyResolvedProposalIdsRef = useRef(new Set<string>());
  const mcpProposalRefreshTimerRef = useRef<number | null>(null);
  const mcpProposalRefreshBatchRef = useRef<McpProposalRefreshBatch | null>(null);
  const mcpProposalRefreshInFlightRef = useRef<Promise<void> | null>(null);

  const performMcpEditProposalsRefresh = useCallback(async () => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return;
    const fileId = getActiveFileId();
    const storage = getDesktopBridge()?.storage;
    // pendingは全教材分を維持し、解決済み履歴だけ現在の教材に絞って一度に取得する。
    const all = await storage?.listMcpEditProposals({
      status: "all",
      fileId,
    });
    if (!isCurrent() || getActiveFileId() !== fileId) return;
    const allList = all ?? [];
    const pendingList = allList.filter((proposal) => proposal.status === "pending");
    const locallyResolved = locallyResolvedProposalIdsRef.current;
    if (locallyResolved.size > 0) {
      for (const proposalId of [...locallyResolved]) {
        if (!pendingList.some((proposal) => proposal.proposalId === proposalId)) {
          locallyResolved.delete(proposalId);
        }
      }
    }
    setMcpEditProposals(
      locallyResolved.size > 0
        ? pendingList.filter((proposal) => !locallyResolved.has(proposal.proposalId))
        : pendingList,
    );
    setMcpProposalCitations(allList);
  }, [captureLifetime, getActiveFileId]);

  // proposal書き込みはwatcher通知と明示refreshが近接して届く。75msのtrailing debounceで
  // 1回へまとめ、すでに取得中ならその完了後に最大1回だけ追従取得する。各呼び出しは自分を
  // 含むbatchの完了Promiseを共有するため、承認後のawaitも最新一覧の反映まで待機できる。
  const refreshMcpEditProposals = useCallback((): Promise<void> => {
    const isCurrent = captureLifetime();
    if (!isCurrent()) return Promise.resolve();
    let batch = mcpProposalRefreshBatchRef.current;
    if (!batch) {
      let resolve!: () => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<void>((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
      });
      batch = { promise, resolve, reject };
      mcpProposalRefreshBatchRef.current = batch;
    }

    if (mcpProposalRefreshTimerRef.current !== null) {
      window.clearTimeout(mcpProposalRefreshTimerRef.current);
    }
    mcpProposalRefreshTimerRef.current = window.setTimeout(() => {
      mcpProposalRefreshTimerRef.current = null;
      const scheduledBatch = mcpProposalRefreshBatchRef.current;
      mcpProposalRefreshBatchRef.current = null;
      if (!scheduledBatch) {
        return;
      }

      const precedingRefresh = mcpProposalRefreshInFlightRef.current;
      const refresh = (async () => {
        await precedingRefresh?.catch(() => undefined);
        if (!isCurrent()) return;
        await performMcpEditProposalsRefresh();
      })();
      mcpProposalRefreshInFlightRef.current = refresh;
      void refresh.then(scheduledBatch.resolve, scheduledBatch.reject).finally(() => {
        if (mcpProposalRefreshInFlightRef.current === refresh) {
          mcpProposalRefreshInFlightRef.current = null;
        }
      });
    }, MCP_PROPOSAL_REFRESH_DEBOUNCE_MS);

    return batch.promise;
  }, [captureLifetime, performMcpEditProposalsRefresh]);

  useEffect(() => () => {
    if (mcpProposalRefreshTimerRef.current !== null) {
      window.clearTimeout(mcpProposalRefreshTimerRef.current);
      mcpProposalRefreshTimerRef.current = null;
    }
    mcpProposalRefreshBatchRef.current?.resolve();
    mcpProposalRefreshBatchRef.current = null;
  }, []);

  const mcpProposalPreview = useMemo(
    () => groupMcpProposalsForPreview(mcpEditProposals, activeFileId, activeDocumentRevision, tAi),
    [groupMcpProposalsForPreview, mcpEditProposals, activeFileId, activeDocumentRevision],
  );
  const aiRunSessions = useAiRunSessions();
  const aiProposalPresentation = useMemo(
    () => deriveAiProposalPresentation(
      mcpProposalPreview.groups,
      aiRunSessions,
      activeFileId,
      isAiRunStatusActive,
    ),
    [activeFileId, aiRunSessions, deriveAiProposalPresentation, isAiRunStatusActive, mcpProposalPreview.groups],
  );
  const aiEditPreviewGroups = aiProposalPresentation.previewGroups;
  const staleProposalGroups = mcpProposalPreview.stale;
  const resolvedMcpEditProposals = useMemo(
    () => mcpProposalCitations.filter(
      (proposal) => proposal.fileId === activeFileId && proposal.status !== "pending",
    ),
    [activeFileId, mcpProposalCitations],
  );
  // Phase 1: Agentic RAG。チャットサイドバーの各 assistant turn の下に「参照したドキュメント」
  // を出すため、turnId ごとに proposal (pending / approved / rejected / reverted すべて)
  // の sourceReferences を集約・重複排除する。適用後もチップを残すため pending 専用にしない。
  const sourceReferencesByTurnId = useMemo(
    () => buildSourceReferencesByTurnId(mcpProposalCitations),
    [buildSourceReferencesByTurnId, mcpProposalCitations],
  );
  const insertedShapePreviewsByTurnId = useMemo(
    () => buildInsertedShapePreviewsByTurnId(
      mcpProposalCitations.filter((proposal) => proposal.fileId === activeFileId),
    ),
    [activeFileId, buildInsertedShapePreviewsByTurnId, mcpProposalCitations],
  );
  // AIチャット履歴の各 assistant turn に「復元」ボタンを出すかどうかの判定。turnId ごとに
  // 最新の提案が rejected/reverted のときだけ復元可能 (pending/approvedのターンは対象外)。
  // 全件を渡さず最小限のMapだけをAiEditPanelへ渡す (不要な情報は表示せず、必要になった時
  // だけ追加する)。
  const restorableProposalsByTurnId = useMemo(
    () => buildRestorableProposalsByTurnId(mcpProposalCitations),
    [buildRestorableProposalsByTurnId, mcpProposalCitations],
  );
  const appliedChangesByTurnId = useMemo(
    () => buildAppliedTurnChangesByTurnId(
      mcpProposalCitations,
      activeFileId,
      activeDocumentRevision,
      overlayShapes,
      tAi,
    ),
    [activeDocumentRevision, activeFileId, buildAppliedTurnChangesByTurnId, overlayShapes, mcpProposalCitations],
  );
  return { mcpEditProposals, mcpProposalCitations, aiRunSessions, aiProposalPresentation, aiEditPreviewGroups, staleProposalGroups, resolvedMcpEditProposals, sourceReferencesByTurnId, insertedShapePreviewsByTurnId, restorableProposalsByTurnId, appliedChangesByTurnId, refreshMcpEditProposals, locallyResolvedProposalIdsRef };
}
