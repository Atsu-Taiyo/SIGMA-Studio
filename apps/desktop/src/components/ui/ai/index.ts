/** AI提案の判断操作をまとめた共通アクションフレーム。 */
export { AiProposalActions, type AiProposalActionsProps } from "./AiProposalActions";

/** 全提案 (紙面・図形・サイドバー・⌘K) で共有する、見出しと判断操作の細いバー。 */
export {
  AiProposalDecisionBar,
  type AiProposalDecisionBarProps,
  type AiProposalDecisionBarSurface,
  type AiProposalDecisionOutcome,
} from "./AiProposalDecisionBar";

/** 表示場所に依存しないAI提案の破棄・適用ボタン。 */
export { AiProposalDecisionButton, type AiProposalDecision } from "./AiProposalDecisionButton";

/** 適用済みAI提案の変更要約と安全な取消導線をまとめる共通結果面。 */
export { AiAppliedChangeCard, type AiAppliedChangeCardProps } from "./AiAppliedChangeCard";
