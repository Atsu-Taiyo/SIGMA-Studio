"use client";

import { MessageSquarePlus, X } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button, IconButton } from "@/components/ui/Button";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";

import { AiProposalDecisionButton } from "./AiProposalDecisionButton";

/** AI提案の判断フレームが必要とする操作と表示状態。 */
export interface AiProposalActionsProps {
  applying: boolean;
  onApply?: () => void;
  onDismiss?: (reason?: string) => void;
  onOpenConversation?: (anchorElement: HTMLElement) => void;
  dismissReasonPlaceholder?: string;
  className?: string;
  actionClassName?: string;
  showApply?: boolean;
  showDismiss?: boolean;
}

function normalizeDismissReason(rawReason: string): string | undefined {
  const trimmed = rawReason.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * AI提案カードに共通する「破棄・続けて修正・適用」の順序と状態表現を固定する。
 * 提案内容や適用処理は持たず、各表示面から渡された操作だけを実行する。
 */
export function AiProposalActions({
  applying,
  onApply,
  onDismiss,
  onOpenConversation,
  dismissReasonPlaceholder,
  className,
  actionClassName = "ai-inline-preview-action",
  showApply = true,
  showDismiss = true,
}: AiProposalActionsProps) {
  const t = useT("ai");
  // 「閉じる」は汎用語 (`common.actions.*` が唯一の出典)。
  const tCommon = useT("common");
  const [reasonOpen, setReasonOpen] = useState(false);
  const [reason, setReason] = useState("");
  const dismissTriggerRef = useRef<HTMLButtonElement | null>(null);
  const reasonPopoverRef = useRef<HTMLDivElement | null>(null);
  const reasonPopoverId = useId();

  const closeReasonPopover = useCallback((restoreTriggerFocus: boolean) => {
    setReasonOpen(false);
    if (restoreTriggerFocus) {
      dismissTriggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!reasonOpen) {
      return;
    }

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      closeReasonPopover(true);
    };
    const handlePointerDown = (event: globalThis.PointerEvent) => {
      const target = event.target as Node | null;
      if (!target
        || reasonPopoverRef.current?.contains(target)
        || dismissTriggerRef.current?.contains(target)) {
        return;
      }
      // 外側の操作先へ自然にフォーカスが移るよう、この経路ではtriggerへ戻さない。
      closeReasonPopover(false);
    };

    document.addEventListener("keydown", handleKeyDown, true);
    document.addEventListener("pointerdown", handlePointerDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
      document.removeEventListener("pointerdown", handlePointerDown, true);
    };
  }, [closeReasonPopover, reasonOpen]);

  const confirmDismiss = () => {
    onDismiss?.(normalizeDismissReason(reason));
    setReasonOpen(false);
    setReason("");
  };

  const requestDismiss = () => {
    if (dismissReasonPlaceholder) {
      if (reasonOpen) {
        closeReasonPopover(true);
      } else {
        setReasonOpen(true);
      }
      return;
    }
    onDismiss?.();
  };

  return (
    <Inline
      as="footer"
      className={["ai-proposal-actions", className].filter(Boolean).join(" ")}
      gap="xs"
      align="center"
      justify="end"
      role="group"
      aria-label={t("proposal.actionsAria")}
    >
      {applying && <Shimmer>{t("proposal.applying")}</Shimmer>}
      {showDismiss && (
        <div className="ai-inline-preview-discard-wrap">
          <AiProposalDecisionButton
            ref={dismissTriggerRef}
            decision="dismiss"
            className={[actionClassName, "discard"].filter(Boolean).join(" ")}
            disabled={applying}
            aria-expanded={dismissReasonPlaceholder ? reasonOpen : undefined}
            aria-controls={dismissReasonPlaceholder && reasonOpen ? reasonPopoverId : undefined}
            onClick={requestDismiss}
          />
          {reasonOpen && dismissReasonPlaceholder && (
            <div
              ref={reasonPopoverRef}
              id={reasonPopoverId}
              className="ai-inline-preview-reason-popover"
              role="group"
              aria-label={t("proposal.dismissReason")}
            >
              <div className="ai-inline-preview-reason-head">
                <span>{t("proposal.dismissReasonOptional")}</span>
                <IconButton
                  label={tCommon("actions.close")}
                  tone="ghost"
                  size="sm"
                  className="ai-inline-preview-reason-close"
                  onClick={() => closeReasonPopover(true)}
                >
                  <X size={12} aria-hidden="true" />
                </IconButton>
              </div>
              <textarea
                className="ai-inline-preview-reason-textarea"
                value={reason}
                maxLength={200}
                placeholder={dismissReasonPlaceholder}
                aria-label={t("proposal.dismissReasonOptional")}
                onChange={(event) => setReason(event.target.value)}
                autoFocus
              />
              <Inline className="ai-inline-preview-reason-actions" justify="end">
                <Button tone="primary" size="sm" className="ai-inline-preview-reason-submit" onClick={confirmDismiss}>
                  {t("proposal.dismiss")}
                </Button>
              </Inline>
            </div>
          )}
        </div>
      )}
      {onOpenConversation && (
        <IconButton
          label={t("proposal.continue")}
          tooltip={{ label: t("proposal.continueTooltip") }}
          tone="secondary"
          size="sm"
          className={[actionClassName, "continue"].filter(Boolean).join(" ")}
          disabled={applying}
          onClick={(event) => onOpenConversation(event.currentTarget)}
        >
          <MessageSquarePlus size={16} strokeWidth={2.5} aria-hidden="true" />
        </IconButton>
      )}
      {showApply && (
        <AiProposalDecisionButton
          decision="apply"
          className={[actionClassName, "apply"].filter(Boolean).join(" ")}
          disabled={!onApply || applying}
          onClick={onApply}
        />
      )}
    </Inline>
  );
}
