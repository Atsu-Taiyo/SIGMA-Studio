"use client";

import { Check, X } from "lucide-react";
import { forwardRef } from "react";

import { IconButton, type IconButtonProps } from "@/components/ui/Button";
import { useT } from "@/lib/i18n/react";

/** AI提案に対して利用者が選べる、破棄または適用の判断。 */
export type AiProposalDecision = "dismiss" | "apply";

/**
 * AI提案の判断操作を、表示場所に依存しない同じ大きさ・階層・記号へ揃える。
 * 破棄は×、適用は黒地のチェックという製品共通の意味だけを担当する。
 */
export const AiProposalDecisionButton = forwardRef<
  HTMLButtonElement,
  Omit<IconButtonProps, "children" | "label" | "size" | "tone"> & { decision: AiProposalDecision }
>(function AiProposalDecisionButton({ decision, className, tooltip, ...buttonProps }, ref) {
  const t = useT("ai");
  const label = t(decision === "dismiss" ? "proposal.dismiss" : "proposal.apply");
  const classes = ["ai-proposal-decision-button", `ai-proposal-decision-button--${decision}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <IconButton
      {...buttonProps}
      ref={ref}
      label={label}
      tooltip={tooltip ?? { label: t(decision === "dismiss" ? "proposal.dismissTooltip" : "proposal.applyTooltip") }}
      size="sm"
      tone={decision === "apply" ? "primary" : "danger"}
      className={classes}
    >
      {decision === "dismiss" ? (
        <X size={16} strokeWidth={2.6} aria-hidden="true" />
      ) : (
        <Check size={16} strokeWidth={2.6} aria-hidden="true" />
      )}
    </IconButton>
  );
});
