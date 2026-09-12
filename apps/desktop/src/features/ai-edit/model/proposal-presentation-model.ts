import type { AiEditPreviewState } from "./preview";

export interface AiProposalRunSessionSnapshot {
  status: unknown;
  anchor?: {
    documentId?: string;
  } | null;
}

export interface AiProposalPresentationState {
  previewGroups: AiEditPreviewState[];
  allVisibleProposalIds: string[];
  hasActiveRunForDocument: boolean;
}

/**
 * pending提案の表示可否を run snapshot から導出する。
 *
 * roomに帰属する提案は、そのroomのrunがactiveな間だけ隠す。
 *
 * 本文の編集可否はここでは決めない — AI編集のロックは対象単位で、run が握っている
 * anchor (blockIds/shapeIds) と pending提案が実際に書き換える対象だけを読み取り専用に
 * する (useAiLockedTargets / ai-editing-block-locks.ts)。以前はここで
 * 「activeRunなら文書全体をロック」する理由を返していたが、その前提だった
 * 「提案の適用可否は文書revision全体で守られる」は per-block rebase の導入
 * (findProposalFreshnessConflictIds は上書き対象ブロックの内容ハッシュだけを見る) で
 * 失効している。他の場所への人手編集はもう提案をstaleにしない。
 */
export function deriveAiProposalPresentation<
  Session extends AiProposalRunSessionSnapshot,
>(
  groups: AiEditPreviewState[],
  sessions: ReadonlyMap<string, Session>,
  activeDocumentId: string,
  isRunActive: (status: Session["status"] | undefined) => boolean,
): AiProposalPresentationState {
  const hasActiveRunForDocument = [...sessions.values()].some((session) => (
    isRunActive(session.status)
    && session.anchor?.documentId === activeDocumentId
  ));
  const previewGroups = groups.filter((group) => {
    if (!group.roomId) {
      return true;
    }
    return !isRunActive(sessions.get(group.roomId)?.status);
  });

  return {
    previewGroups,
    allVisibleProposalIds: previewGroups.flatMap((group) => group.proposalIds),
    hasActiveRunForDocument,
  };
}
