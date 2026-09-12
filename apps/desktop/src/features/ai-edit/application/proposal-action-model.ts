import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";

import type {
  AiEditPreviewState,
  StaleMcpProposalGroup,
} from "../model/preview";

export interface AiProposalResolutionTarget {
  roomId?: string;
  turnId?: string;
}

export interface AiProposalApplyContext {
  previewGroup?: AiEditPreviewState;
  requestedGroups: Array<{
    proposalIds: string[];
    roomId?: string;
    turnId?: string;
  }>;
}

export interface AiProposalApplyFailure {
  proposalId: string;
  error: string;
}

export type AiProposalApplyOutcome =
  | { ok: true }
  | { ok: false; reason: string };

export interface AiProposalApplyDecision {
  failedProposalIds: Set<string>;
  appliedProposalIds: string[];
  resolvedTargets: AiProposalResolutionTarget[];
  shouldUseLegacyResolutionFallback: boolean;
  statusMessage: string;
  outcome: AiProposalApplyOutcome;
}

export interface AiProposalBusyGuardFeedback {
  statusMessage: string;
  outcome: Extract<AiProposalApplyOutcome, { ok: false }>;
}

export type AiProposalApprovedFileFeedback =
  | {
      kind: "paint-active-document";
      statusMessage: string;
    }
  | {
      kind: "report-other-document";
      statusMessage: string;
    };

export type RejectProposalsOutcome =
  | "empty"
  | "busy"
  | { rejectedCount: number; failedCount: number };

export type AiProposalRejectEffect =
  | { type: "status"; message: string }
  | {
      type: "clearPreview";
      outcome: "dismissed";
      targets: AiProposalResolutionTarget[];
    }
  | {
      type: "submitFeedback";
      roomId: string;
      turnId?: string;
      reason: string;
      proposalSummaries: string[];
    };

/**
 * Proposal ID配列を順序に依存せず比較する。
 *
 * 既存のproposal groupは作成日時順だが、UIから渡る配列の順序は同一とは限らない。
 * 同じ長さと同じmember setを持つ場合に同一groupとして扱う。
 */
/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");
const DEFAULT_EDITOR_TRANSLATE = createCurrentLocaleTranslator("editor");

export function sameProposalIdSet(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  const setA = new Set(a);
  return setA.size === new Set(b).size && b.every((id) => setA.has(id));
}

export function findAiProposalGroupByIds<
  Group extends { proposalIds: readonly string[] },
>(
  groups: readonly Group[],
  proposalIds: readonly string[],
): Group | undefined {
  return groups.find(
    (candidate) => sameProposalIdSet(candidate.proposalIds, proposalIds),
  );
}

/**
 * apply開始時点の表示groupを固定する。IPC待機中にproposal watcherが更新されても、
 * アニメーション対象と解決先はユーザーが決定した時点のgroupから変えない。
 */
export function buildAiProposalApplyContext(
  proposalIds: string[],
  previewGroups: AiEditPreviewState[],
  staleGroups: StaleMcpProposalGroup[],
): AiProposalApplyContext {
  const requestedProposalIds = new Set(proposalIds);
  return {
    previewGroup: findAiProposalGroupByIds(previewGroups, proposalIds),
    requestedGroups: [...previewGroups, ...staleGroups].filter((candidate) => (
      candidate.proposalIds.length > 0
      && candidate.proposalIds.every(
        (proposalId) => requestedProposalIds.has(proposalId),
      )
    )),
  };
}

/**
 * apply / restore / rejectの排他ガードで、操作を捨てる場合の通知と戻り値を一緒に返す。
 * 呼び出し側がstatus更新を忘れて「押したのに何も起きない」状態へ戻らないための境界。
 *
 * notify は必須にしてある: 戻り値だけ返して通知をオプションにすると、呼び出し側が
 * status更新を書き忘れた時点で「無反応クリック」のバグが復活する。通知はこの関数の中で
 * 必ず起きるので、呼び出し側にできるのは「早期returnする」ことだけになる。
 */
export function deriveAiProposalBusyGuardFeedback(
  busy: boolean,
  statusMessage: string,
  notify: (message: string) => void,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): AiProposalBusyGuardFeedback | null {
  if (!busy) {
    return null;
  }
  notify(statusMessage);
  return {
    statusMessage,
    outcome: { ok: false, reason: t("proposal.busy") },
  };
}

/**
 * 承認結果の教材が現在のタブかどうかだけを判定する。
 * 別教材なら画面へ取り込まず、対象名を明示した完了通知へ切り替える。
 */
export function deriveAiProposalApprovedFileFeedback({
  approvedFileId,
  currentFileId,
  approvedDocumentTitle,
  activeDocumentStatusMessage,
  t = DEFAULT_AI_TRANSLATE,
  tEditor = DEFAULT_EDITOR_TRANSLATE,
}: {
  approvedFileId: string;
  currentFileId: string;
  approvedDocumentTitle?: string | null;
  activeDocumentStatusMessage: string;
  t?: Translate<"ai">;
  tEditor?: Translate<"editor">;
}): AiProposalApprovedFileFeedback {
  if (approvedFileId === currentFileId) {
    return {
      kind: "paint-active-document",
      statusMessage: activeDocumentStatusMessage,
    };
  }

  // 「無題の教材」は本文編集面と同じ既定名 (`editor.untitledDocument` が唯一の出典)。
  const documentTitle = approvedDocumentTitle?.trim() || tEditor("shell.untitledDocument");
  return {
    kind: "report-other-document",
    statusMessage: t("proposal.appliedToOtherDocument", { replace: { title: documentTitle } }),
  };
}

/**
 * batch承認結果から、実際に適用されたID、解決するturn、表示メッセージをまとめて導出する。
 * 部分失敗したgroupは解決済みにせず、pending側に残す。
 */
export function deriveAiProposalApplyDecision(
  proposalIds: string[],
  failures: AiProposalApplyFailure[],
  context: AiProposalApplyContext,
  options: {
    force?: boolean;
    resolutionTargets?: AiProposalResolutionTarget[];
    disableLegacyResolutionFallback?: boolean;
  } = {},
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): AiProposalApplyDecision {
  const failedProposalIds = new Set(
    failures.map((failure) => failure.proposalId),
  );
  const appliedProposalIds = proposalIds.filter(
    (proposalId) => !failedProposalIds.has(proposalId),
  );
  const appliedProposalIdSet = new Set(appliedProposalIds);
  const resolvedTargets = options.resolutionTargets !== undefined
    ? failedProposalIds.size === 0 ? options.resolutionTargets : []
    : context.requestedGroups
        .filter((candidate) => candidate.proposalIds.every(
          (proposalId) => appliedProposalIdSet.has(proposalId),
        ))
        .map((candidate) => ({
          roomId: candidate.roomId,
          turnId: candidate.turnId,
        }));
  const shouldUseLegacyResolutionFallback = (
    resolvedTargets.length === 0
    && context.requestedGroups.length === 0
    && failedProposalIds.size === 0
    && !options.disableLegacyResolutionFallback
  );

  if (failures.length > 0) {
    const statusMessage = t("proposal.applyPartialFailure", { replace: { count: failures.length, error: failures[0].error } });
    return {
      failedProposalIds,
      appliedProposalIds,
      resolvedTargets,
      shouldUseLegacyResolutionFallback,
      statusMessage,
      outcome: { ok: false, reason: statusMessage },
    };
  }

  return {
    failedProposalIds,
    appliedProposalIds,
    resolvedTargets,
    shouldUseLegacyResolutionFallback,
    statusMessage: t(options.force ? "proposal.appliedForced" : "proposal.applied"),
    outcome: { ok: true },
  };
}

/**
 * 通常提案のdismiss後に実行するUI副作用を、既存順序
 * status → clear preview → feedback submission で返す。
 */
export function deriveAiProposalDismissEffects(
  group: AiEditPreviewState | undefined,
  outcome: RejectProposalsOutcome,
  reason?: string,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): AiProposalRejectEffect[] {
  if (outcome === "busy") {
    return [];
  }
  if (outcome !== "empty" && outcome.failedCount > 0) {
    return [{
      type: "status",
      message: t(outcome.rejectedCount > 0 ? "proposal.closePartialFailure" : "proposal.closeFailed"),
    }];
  }

  const effects: AiProposalRejectEffect[] = [
    { type: "status", message: t("proposal.closed") },
    {
      type: "clearPreview",
      outcome: "dismissed",
      targets: [{ roomId: group?.roomId, turnId: group?.turnId }],
    },
  ];
  const trimmedReason = reason?.trim();
  if (trimmedReason && group?.roomId) {
    effects.push({
      type: "submitFeedback",
      roomId: group.roomId,
      turnId: group.turnId,
      reason: trimmedReason,
      proposalSummaries: [group.draft.summary],
    });
  }
  return effects;
}

/**
 * stale提案の破棄後に実行するUI副作用を、既存順序 status → clear preview で返す。
 */
export function deriveAiStaleProposalDiscardEffects(
  group: StaleMcpProposalGroup | undefined,
  outcome: RejectProposalsOutcome,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): AiProposalRejectEffect[] {
  if (outcome === "busy") {
    return [];
  }
  if (outcome !== "empty" && outcome.failedCount > 0) {
    return [{
      type: "status",
      message: t(outcome.rejectedCount > 0 ? "proposal.discardPartialFailure" : "proposal.discardFailed"),
    }];
  }

  const effects: AiProposalRejectEffect[] = [
    { type: "status", message: t("proposal.discarded") },
  ];
  if (group) {
    effects.push({
      type: "clearPreview",
      outcome: "dismissed",
      targets: [{ roomId: group.roomId, turnId: group.turnId }],
    });
  }
  return effects;
}

export function normalizeAiProposalIds(
  proposalIdsInput: string | string[],
): string[] {
  return [...new Set(
    (Array.isArray(proposalIdsInput) ? proposalIdsInput : [proposalIdsInput])
      .filter(Boolean),
  )];
}

export function deriveAiProposalResolutionTargets(
  proposals: ReadonlyArray<Pick<
    DesktopMcpEditProposalSummary,
    "proposalId" | "roomId" | "turnId"
  >>,
  proposalIds: string[],
): AiProposalResolutionTarget[] {
  const proposalIdSet = new Set(proposalIds);
  return [...new Map(
    proposals
      .filter((proposal) => (
        proposalIdSet.has(proposal.proposalId)
        && (proposal.roomId || proposal.turnId)
      ))
      .map((proposal) => [
        `${proposal.roomId ?? ""}\u0000${proposal.turnId ?? ""}`,
        { roomId: proposal.roomId, turnId: proposal.turnId },
      ] as const),
  ).values()];
}

/**
 * 要求された提案IDを「同じ1回の保存を共有したバッチ」単位に割り、main の revert IPC を
 * 呼ぶ代表IDを **新しい保存revisionから順に** 並べる。main の getRevertPlan は1件の
 * proposalId から同じ appliedRevision のバッチを自力で引くため、バッチごとに1件で足りる。
 * 順序が降順なのは、選択的revert (buildSelectiveRevertDocument) が「後から積んだ変更を
 * 先に剥がす」合成でしか元の教材に戻らないため。
 * 巻き戻せる材料が1件も無いときは、main に理由を答えさせるため先頭のIDだけを返す
 * (呼び出し側で握り潰さず、main の文言をそのままユーザーへ見せる)。
 */
export function selectSequentialAiRevertProposalIds(
  proposals: ReadonlyArray<Pick<
    DesktopMcpEditProposalSummary,
    "proposalId" | "status" | "appliedRevision"
  >>,
  proposalIds: string[],
  activeDocumentRevision: number | null,
): string[] {
  const proposalIdSet = new Set(proposalIds);
  const byRevision = new Map<number, typeof proposals[number][]>();
  for (const proposal of proposals) {
    if (!proposalIdSet.has(proposal.proposalId) || proposal.status !== "approved") {
      continue;
    }
    if (proposal.appliedRevision === undefined) {
      continue;
    }
    const batch = byRevision.get(proposal.appliedRevision) ?? [];
    batch.push(proposal);
    byRevision.set(proposal.appliedRevision, batch);
  }
  if (byRevision.size === 0) {
    return proposalIds.length > 0 ? [proposalIds[0]] : [];
  }
  return [...byRevision.entries()]
    .sort(([a], [b]) => b - a)
    .map(([, batch]) => selectPrimaryAiProposalIdForRevert(
      batch,
      batch.map((proposal) => proposal.proposalId),
      activeDocumentRevision,
    )!);
}

export function selectPrimaryAiProposalIdForRevert(
  proposals: ReadonlyArray<Pick<
    DesktopMcpEditProposalSummary,
    "proposalId" | "status" | "appliedRevision"
  >>,
  proposalIds: string[],
  activeDocumentRevision: number | null,
): string | undefined {
  const proposalIdSet = new Set(proposalIds);
  const approvedProposals = proposals.filter((proposal) => (
    proposalIdSet.has(proposal.proposalId)
    && proposal.status === "approved"
  ));
  return (
    approvedProposals.find(
      (proposal) => proposal.appliedRevision === activeDocumentRevision,
    )
    ?? approvedProposals[0]
  )?.proposalId ?? proposalIds[0];
}
