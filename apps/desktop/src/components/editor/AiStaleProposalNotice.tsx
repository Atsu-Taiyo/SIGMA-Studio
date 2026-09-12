"use client";

import { AlertTriangle, History } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import type { StaleMcpProposalGroup } from "./ai-edit-preview-types";

type RebaseOutcome = { ok: true } | { ok: false; reason: string };

interface AiStaleProposalNoticeProps {
  groups: StaleMcpProposalGroup[];
  /** 破棄。競合グループでは「編集を優先して破棄」(ユーザーの編集を残す) の意味になる。 */
  onDiscard: (proposalIds: string[]) => void;
  /** 作り直し (rebase): 現在のドキュメントに対して再適用を試みる。渡されない場合は
   * ボタンを表示せず、出現時の自動作り直しも行わない (API未対応のビルド向け)。
   * kind === "conflict" のグループには使わない (rebaseは競合の有無に関わらずAIの
   * 提案を無条件でreplayしてしまうため、人間の編集を黙って上書きしかねない)。 */
  onRebase?: (proposalIds: string[]) => Promise<RebaseOutcome>;
  /** content-stale競合専用の「AIの提案で上書き」。アンカー消失・asset衝突など、replayで
   * 解決できない競合には絶対に表示しない。 */
  onForceApply?: (proposalIds: string[]) => Promise<RebaseOutcome>;
  /** replay不能な提案を既存AIチャットへ戻し、同じroomのcomposerで再依頼できるようにする。 */
  onReRequest?: (group: StaleMcpProposalGroup) => void;
}

export function staleProposalAutoRebaseKey(group: StaleMcpProposalGroup): string {
  return [
    group.baseRevision,
    group.currentRevision,
    ...group.proposalIds.slice().sort(),
  ].join(":");
}

export function AiStaleProposalNotice({ groups, onDiscard, onRebase, onForceApply, onReRequest }: AiStaleProposalNoticeProps) {
  const t = useT("ai");
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [errorByKey, setErrorByKey] = useState<Record<string, string>>({});
  // 各 stale group につき、出現時に一度だけ自動で作り直しを試みる。無限ループを防ぐため
  // 一度試した groupKey は成否にかかわらず二度と自動実行しない (再び作り直したい場合は
  // 手動の「作り直しを試す」ボタンを使う)。conflict グループは対象外 (下記参照)。
  const autoRebasedRef = useRef(new Set<string>());

  // kind === "conflict" は人間の編集とAIの提案がぶつかっている状態: rebase (作り直し) は
  // 競合の有無に関わらずAIの提案を無条件でreplayして conflict をクリアしてしまうため、
  // 自動でも手動の「作り直しを試す」ボタンからも絶対に呼んではいけない。ユーザーが明示的に
  // 選ぶ2アクション (破棄 / 強制上書き) だけで解決する。
  const conflictGroups = groups.filter((group) => group.kind === "conflict");
  const rebaseGroups = groups.filter((group) => group.kind !== "conflict");

  const runRebase = async (group: StaleMcpProposalGroup) => {
    if (!onRebase) {
      return;
    }
    const key = staleProposalAutoRebaseKey(group);
    setBusyKey(key);
    setErrorByKey((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const result = await onRebase(group.proposalIds);
      if (!result.ok) {
        setErrorByKey((current) => ({ ...current, [key]: result.reason }));
      }
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  const runForceApply = async (group: StaleMcpProposalGroup) => {
    if (!onForceApply) {
      return;
    }
    const key = staleProposalAutoRebaseKey(group);
    setBusyKey(key);
    setErrorByKey((current) => {
      if (!(key in current)) {
        return current;
      }
      const next = { ...current };
      delete next[key];
      return next;
    });
    try {
      const result = await onForceApply(group.proposalIds);
      if (!result.ok) {
        setErrorByKey((current) => ({ ...current, [key]: result.reason }));
      }
    } finally {
      setBusyKey((current) => (current === key ? null : current));
    }
  };

  useEffect(() => {
    if (!onRebase) {
      return;
    }
    for (const group of rebaseGroups) {
      const key = staleProposalAutoRebaseKey(group);
      if (autoRebasedRef.current.has(key)) {
        continue;
      }
      autoRebasedRef.current.add(key);
      void runRebase(group);
    }
    // runRebase intentionally excluded: it is stable in behavior (keyed purely
    // by the group passed to it) and including it would re-run this effect on
    // every render since it closes over component state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rebaseGroups, onRebase]);

  if (groups.length === 0) {
    return null;
  }

  return (
    <div className="ai-stale-proposals">
      {conflictGroups.map((group) => {
        const key = staleProposalAutoRebaseKey(group);
        const busy = busyKey === key;
        const error = errorByKey[key];
        const blockCount = group.conflictBlockIds?.length ?? group.proposalIds.length;
        const canForceApply = group.conflictReason === "content-stale" && !!onForceApply;
        const canReRequest = group.conflictReason !== "content-stale" && !!onReRequest;
        const message = group.invalidReason ?? conflictNoticeMessage(group.conflictReason, t);
        return (
          <div className="ai-stale-proposal-group ai-stale-proposal-group--conflict" key={key}>
            <div className="ai-stale-proposal-row ai-stale-proposal-row--conflict">
              <AlertTriangle size={12} />
              <span className="ai-stale-proposal-text">{message}</span>
              <span className="ai-stale-proposal-meta">{t("stale.conflictMeta", { replace: { blocks: blockCount, proposals: group.proposalIds.length } })}</span>
            </div>
            <div className="ai-stale-proposal-conflict-actions">
              <button
                type="button"
                className="ai-stale-proposal-discard ai-stale-proposal-discard--primary"
                title={t("stale.keepMineTooltip")}
                disabled={busy}
                onClick={() => onDiscard(group.proposalIds)}
              >
                {t("stale.keepMine")}
              </button>
              {canForceApply && (
                <button
                  type="button"
                  className="ai-stale-proposal-force-apply"
                  title={t("stale.overwriteTooltip")}
                  disabled={busy}
                  onClick={() => void runForceApply(group)}
                >
                  {busy ? t("stale.overwriting") : t("stale.overwrite")}
                </button>
              )}
              {canReRequest && (
                <button
                  type="button"
                  className="ai-stale-proposal-re-request"
                  title={t("stale.reaskTooltip")}
                  disabled={busy}
                  onClick={() => onReRequest(group)}
                >
                  {t("stale.reask")}
                </button>
              )}
            </div>
            {error && <p className="ai-stale-proposal-error">{error}</p>}
          </div>
        );
      })}
      {rebaseGroups.map((group) => {
        const key = staleProposalAutoRebaseKey(group);
        const busy = busyKey === key;
        const error = errorByKey[key];
        return (
          <div className="ai-stale-proposal-group" key={key}>
            <div className="ai-stale-proposal-row">
              <History size={12} />
              <span className="ai-stale-proposal-text">{t("stale.revisionChanged")}</span>
              <span className="ai-stale-proposal-meta">{t("stale.revisionMeta", { replace: { proposals: group.proposalIds.length, from: group.baseRevision, to: group.currentRevision } })}</span>
              {onRebase && group.kind === "manual-rebase" && (
                <button
                  type="button"
                  className="ai-stale-proposal-rebase"
                  title={t("stale.rebuildTooltip")}
                  disabled={busy}
                  onClick={() => void runRebase(group)}
                >
                  {busy ? t("stale.rebuilding") : t("stale.rebuild")}
                </button>
              )}
              <button
                type="button"
                className="ai-stale-proposal-discard"
                title={t("stale.discardTooltip")}
                onClick={() => onDiscard(group.proposalIds)}
              >
                {t("proposal.dismiss")}
              </button>
            </div>
            {error && <p className="ai-stale-proposal-error">{error}</p>}
          </div>
        );
      })}
    </div>
  );
}

function conflictNoticeMessage(
  reason: StaleMcpProposalGroup["conflictReason"],
  t: Translate<"ai">,
): string {
  if (reason === "anchor-missing") {
    return t("stale.reason.anchorMissing");
  }
  if (reason === "asset-collision") {
    return t("stale.reason.assetCollision");
  }
  if (reason === "replay-failed") {
    return t("stale.reason.replayFailed");
  }
  if (reason === "content-stale") {
    return t("stale.reason.contentStale");
  }
  return t("stale.reason.other");
}
