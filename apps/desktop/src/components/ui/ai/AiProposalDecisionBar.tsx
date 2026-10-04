"use client";

import { ChevronDown, ChevronUp, Eye, EyeOff } from "lucide-react";
import { useState, type ReactNode } from "react";

import { IconButton } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";

import { AiProposalActions } from "./AiProposalActions";
import styles from "./AiProposalDecisionBar.module.css";

/** 適用の結果。失敗の理由はバーに出す。 */
export type AiProposalDecisionOutcome = { ok: true } | { ok: false; reason: string };

/**
 * バーを置く面。見た目の細部 (余白など) を置く側の CSS が `data-surface` で調整する。
 * - `page`: 紙面のカードの最初の行 (本文フローの中)
 * - `overlay`: 図形だけの提案。図形のそば
 * - `panel`: サイドバーの会話
 * - `inline`: ⌘K の浮動パネル
 */
export type AiProposalDecisionBarSurface = "page" | "overlay" | "panel" | "inline";

export interface AiProposalDecisionBarProps {
  /** 変更の種類 (「AI編集案」「AI図形の変更案」など)。 */
  title: string;
  surface: AiProposalDecisionBarSurface;
  applying: boolean;
  onApply?: () => Promise<AiProposalDecisionOutcome>;
  /** 理由は破棄のポップオーバーで任意に書いたもの (空なら undefined)。 */
  onDismiss?: (reason?: string) => void;
  /** 提案の会話を開く。押したボタンを基準に置く。 */
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  /** 渡すと「破棄」は理由を書けるポップオーバーを開く。 */
  dismissReasonPlaceholder?: string;
  /** 参照元のチップなど。バーの下 (内容の上) に置く。 */
  references?: ReactNode;
  /**
   * バーの下に添える一言 (人の編集と合わせた内容である、など)。バー自身は文言を決めない。
   */
  notice?: ReactNode;
  /** 「適用」を出すか。適用できない面 (処理を渡さない面) では出さない。既定は出す。 */
  showApply?: boolean;
  /** 内容 (バーの下に置く提案内容) を隠しているか。`onContentHiddenChange` を渡したときだけ切り替えを出す。 */
  contentHidden?: boolean;
  onContentHiddenChange?: (hidden: boolean) => void;
  /** 切り替えが隠す内容の要素 id (`aria-controls`)。 */
  contentId?: string;
  /** 図形の変更前を隠しているか。`onBeforeHiddenChange` を渡したときだけ切り替えを出す。 */
  beforeHidden?: boolean;
  onBeforeHiddenChange?: (hidden: boolean) => void;
  /**
   * 適用の失敗の理由。渡すと持ち主の状態になる (バーが作り直されても残る)。渡さなければバーが持つ。
   */
  applyError?: string | null;
  onApplyErrorChange?: (error: string | null) => void;
  /** 破棄理由のポップオーバーが開いているか (持ち主の状態にするとき)。 */
  dismissReasonOpen?: boolean;
  onDismissReasonOpenChange?: (open: boolean) => void;
  /** 入力中の破棄理由 (持ち主の状態にするとき)。 */
  dismissReason?: string;
  onDismissReasonChange?: (reason: string) => void;
  /**
   * 改ページで切れたカードの続きの複製に描くとき。正本と同じ寸法で組むが、見せず、操作も
   * 支援技術にも出さない (操作は正本の 1 か所だけ)。
   */
  replica?: boolean;
}

/**
 * AI 提案の承認バー。見出し (「提案された変更」と変更の種類)・切り替え・判断操作
 * (破棄・続けて修正・適用) を折り返さない 1 行に収め、紙面・図形・サイドバー・⌘K の全提案で共有する。
 * 適用の実行と失敗の表示はここだけが持つ (表示面ごとに作らない)。提案内容は持たない。
 *
 * 紙面のページ割りはバーの中の行の間でも切れるので、バーは必ず 1 行にする (2 行目の操作が
 * 次のページの続きの複製に回ると押せない)。行が増えるもの (参照元・一言・失敗の理由) はバーの外、
 * すぐ下 (`data-ai-proposal-bar-details`) に置く。続きの複製ではバーは見せないが、下の行は
 * 見た目だけ出す (失敗の理由が次のページに回っても読める)。
 */
export function AiProposalDecisionBar({
  title,
  surface,
  applying,
  onApply,
  onDismiss,
  onOpenConversation,
  dismissReasonPlaceholder,
  references,
  notice,
  showApply = true,
  contentHidden = false,
  onContentHiddenChange,
  contentId,
  beforeHidden = false,
  onBeforeHiddenChange,
  applyError,
  onApplyErrorChange,
  dismissReasonOpen,
  onDismissReasonOpenChange,
  dismissReason,
  onDismissReasonChange,
  replica = false,
}: AiProposalDecisionBarProps) {
  const t = useT("ai");
  const [ownApplyError, setOwnApplyError] = useState<string | null>(null);
  const shownApplyError = applyError === undefined ? ownApplyError : applyError;
  const reportApplyError = (error: string | null) => {
    onApplyErrorChange?.(error);
    if (applyError === undefined) {
      setOwnApplyError(error);
    }
  };

  const runApply = async () => {
    if (!onApply) {
      return;
    }
    reportApplyError(null);
    try {
      const result = await onApply();
      if (!result.ok) {
        reportApplyError(result.reason);
      }
    } catch (error) {
      reportApplyError(error instanceof Error ? error.message : t("card.applyFailed"));
    }
  };

  const contentLabel = t(contentHidden ? "card.showContent" : "card.hideContent");
  const beforeLabel = t(beforeHidden ? "card.showBefore" : "card.hideBefore");

  const hasDetails = Boolean(references) || Boolean(notice) || Boolean(shownApplyError);
  return (
    <>
      <div
        className={styles.bar}
        data-ai-proposal-bar=""
        data-surface={surface}
        data-replica={replica ? "" : undefined}
        aria-hidden={replica ? true : undefined}
      >
        <p className={styles.heading}>
          <span className={styles.label}>{t("card.proposedChanges")}</span>
          <span className={styles.title}>{title}</span>
        </p>
        <div className={styles.controls}>
          {onBeforeHiddenChange && (
            <IconButton
              label={beforeLabel}
              tone="ghost"
              size="sm"
              className={styles.toggle}
              aria-pressed={beforeHidden}
              onClick={() => onBeforeHiddenChange(!beforeHidden)}
            >
              {beforeHidden ? <Eye size={15} aria-hidden="true" /> : <EyeOff size={15} aria-hidden="true" />}
            </IconButton>
          )}
          {onContentHiddenChange && (
            <IconButton
              label={contentLabel}
              tone="ghost"
              size="sm"
              className={styles.toggle}
              aria-expanded={!contentHidden}
              aria-controls={contentId}
              onClick={() => onContentHiddenChange(!contentHidden)}
            >
              {contentHidden ? <ChevronDown size={15} aria-hidden="true" /> : <ChevronUp size={15} aria-hidden="true" />}
            </IconButton>
          )}
          <AiProposalActions
            applying={applying}
            className={styles.actions}
            dismissReasonPlaceholder={dismissReasonPlaceholder}
            dismissReasonOpen={dismissReasonOpen}
            onDismissReasonOpenChange={onDismissReasonOpenChange}
            dismissReason={dismissReason}
            onDismissReasonChange={onDismissReasonChange}
            replica={replica}
            onOpenConversation={onOpenConversation}
            onApply={onApply ? () => void runApply() : undefined}
            showApply={showApply}
            showDismiss={Boolean(onDismiss)}
            onDismiss={onDismiss}
          />
        </div>
      </div>
      {hasDetails && (
        <div className={styles.details} data-ai-proposal-bar-details="" data-surface={surface}>
          {references}
          {notice && <div className={styles.notice}>{notice}</div>}
          {shownApplyError && (
            <p className={`ai-chat-error ${styles.error}`} role="alert">{shownApplyError}</p>
          )}
        </div>
      )}
    </>
  );
}
