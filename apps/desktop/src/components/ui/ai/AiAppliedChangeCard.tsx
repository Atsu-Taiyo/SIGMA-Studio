import { Check, RotateCcw } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { Tooltip } from "@/components/ui/Tooltip";
import { useT } from "@/lib/i18n/react";

import styles from "./AiAppliedChangeCard.module.css";

export interface AiAppliedChangeCardProps {
  children?: ReactNode;
  autoApplied?: boolean;
  canRevert?: boolean;
  reverting?: boolean;
  /**
   * canRevertがfalseのときに見せる、巻き戻せない理由の日本語1文。分類→文言の変換は
   * 呼び出し側 (features/ai-edit の describeRevertBlockedReason) が持つ。
   */
  revertBlockedReason?: string;
  onRevert?: () => void;
}

/**
 * 適用済みAI提案の実差分と安全な取消操作をまとめる共通結果面。
 * 「元に戻す」は取消経路がある限り常に見せ、実行できないときだけ無効化して理由を添える
 * (消えるボタンは「もう戻せないのか、壊れているのか」を利用者に区別させられないため)。
 * 差分生成・描画、競合判定、revision、実際の巻き戻し処理は持たない。
 */
export function AiAppliedChangeCard({
  children,
  autoApplied = false,
  canRevert = false,
  reverting = false,
  revertBlockedReason,
  onRevert,
}: AiAppliedChangeCardProps) {
  const t = useT("ai");
  const blockedReason = canRevert ? undefined : revertBlockedReason;
  return (
    <section
      className={styles.card}
      aria-label={t(autoApplied ? "applied.autoTitle" : "applied.title")}
      data-can-revert={canRevert}
    >
      <div className={styles.header}>
        <span className={styles.state}>
          <Check size={13} strokeWidth={2.2} aria-hidden="true" />
          {t(autoApplied ? "applied.autoTitle" : "applied.title")}
        </span>
        {onRevert ? (
          <Tooltip label={blockedReason ?? t("applied.revertTooltip")}>
            <Button
              className={styles.revert}
              aria-label={t("applied.revertAria")}
              tone="ghost"
              size="sm"
              disabled={!canRevert || reverting}
              onClick={onRevert}
            >
              {reverting ? (
                <Shimmer variant="icon"><RotateCcw size={14} aria-hidden="true" /></Shimmer>
              ) : (
                <RotateCcw size={14} aria-hidden="true" />
              )}
              {t("applied.revert")}
            </Button>
          </Tooltip>
        ) : null}
      </div>
      {blockedReason && onRevert ? (
        <p className={styles.blockedReason}>{blockedReason}</p>
      ) : null}
      {children ? <div className={styles.content}>{children}</div> : null}
    </section>
  );
}
