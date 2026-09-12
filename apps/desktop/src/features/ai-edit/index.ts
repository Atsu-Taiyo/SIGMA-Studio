export { AiPageCanvasEditor, type AiPageCanvasEditorProps } from "./AiPageCanvasEditor";
export * from "./view";
export { useAiEditorExtensions, type AiEditorExtensionOptions, type AiEditorExtensions } from "./editor-extensions";
export {
  aiDocumentWriteInProgressMessage,
  AI_EDIT_LOCK_MAX_ANIMATED_CHARS,
  buildAiTextFlowEditPolicy,
  collectAiEditLockSpans,
  createAiEditLockDecorations,
  createAiEditLockStopButton,
  createAiReadOnlyTextFlowEditGuard,
  createAiTextFlowEditGuard,
  findTouchedLockedBlockIds,
  handleAiEditLockStopButtonClick,
  refreshAiEditLockDecorations,
  shouldAllowTextFlowTransaction,
  type AiEditLockAtomSpan,
  type AiEditLockBlockSpans,
  type AiEditLockCharSpan,
  type AiEditLockInfo,
  type AiEditLockStopButtonState,
  type AiTextFlowEditPolicyInput,
} from "./adapters/tiptap/edit-lock-adapter";
export { useAiPinnedReferences, type AiPinnedReferencesController } from "./application/use-ai-pinned-references";
export {
  describeAiLockedTargets,
  EMPTY_AI_LOCKED_TARGETS,
  isAiLockedBlock,
  isAiLockedShapeSelection,
  mergeAiLockedTargets,
  useAiLockedTargets,
  type AiLockedTargets,
} from "./application/locked-targets";
export {
  findAiLockedTargetsTouched,
  hasAiLockedTargetsTouched,
  type AiLockedTargetsTouched,
} from "./application/locked-target-diff";
export {
  buildCommentAiRunRequestPlan,
  deriveAiReferenceRequestPlan,
  deriveAiRunStartTransition,
  deriveCommentAiRunEligibility,
  type AiReferenceRequestPlan,
  type AiRunStartTransition,
  type CommentAiRunEligibility,
  type CommentAiRunRequestPlan,
} from "./application/run-request-model";
export {
  buildAiProposalApplyContext,
  deriveAiProposalApprovedFileFeedback,
  deriveAiProposalApplyDecision,
  deriveAiProposalBusyGuardFeedback,
  deriveAiProposalDismissEffects,
  deriveAiProposalResolutionTargets,
  deriveAiStaleProposalDiscardEffects,
  findAiProposalGroupByIds,
  normalizeAiProposalIds,
  sameProposalIdSet,
  selectPrimaryAiProposalIdForRevert,
  selectSequentialAiRevertProposalIds,
  type AiProposalApplyOutcome,
  type AiProposalRejectEffect,
  type RejectProposalsOutcome,
} from "./application/proposal-action-model";
export { buildCommentAiReference } from "./model/comment-reference";
export {
  buildAppliedTurnChangesByTurnId,
  buildInsertedShapePreviewsByTurnId,
  buildRestorableProposalsByTurnId,
  buildSourceReferencesByTurnId,
  deriveAiEditPreviewDiff,
  derivePostApplyHighlightIds,
  groupMcpProposalsForPreview,
  resolveOverlayShapeAnchorBlockId,
  type AiApplyAnimationState,
  type AiEditPreviewState,
} from "./model/preview";
export {
  deriveAiProposalPresentation,
  type AiProposalPresentationState,
} from "./model/proposal-presentation-model";
export { AI_REFERENCE_TEXT_RANGE_EVENT } from "./text-range-highlight";
export { MAX_AI_EDIT_REFERENCES, type AiEditReference } from "@/lib/ai/ai-edit-reference";
export type { AiEditShapeOnlyPreview } from "@/lib/ai/ai-edit-shape-preview";
export { useAiProposalActions, type AiProposalActionsDependencies } from "./application/use-ai-proposal-actions";
export { useCommentAiRun, type CommentAiRunOptions } from "./application/use-comment-ai-run";
