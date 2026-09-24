import { useCallback, useEffect, type RefObject } from "react";
import type { InlineNode, SigmaCommentAnchor } from "@sigma-studio/viewer";

import { PageCanvasEditor } from "@sigma-studio/editor-internal/page-canvas-editor";

const EMPTY_ARRAY: never[] = [];
const EMPTY_MAP = new Map();
export function useAiWorkspaceTabTitles(): ReadonlyMap<string, string> { return EMPTY_MAP; }

// Workspace tabs can inspect this store even when the embedded tab UI is hidden.
// Keep its snapshot stable and never initialize desktop persistence or providers.
export const aiChatRoomsStore = {
  subscribe: (_listener: () => void): (() => void) => () => undefined,
  getSnapshot: (): never[] => EMPTY_ARRAY,
  getActiveRoomId: (_documentIdentityKey: string): null => null,
};
export async function deleteAiDataForDocument(_documentIdentityKey: string): Promise<void> {
  return undefined;
}

const EMPTY_PREVIEWS = new Map();
const EMPTY_LOCKED_TARGETS = {
  blockIds: new Set<string>(),
  shapeIds: new Set<string>(),
  runBlockIds: new Set<string>(),
  runShapeIds: new Set<string>(),
};
export const EMPTY_AI_LOCKED_TARGETS = EMPTY_LOCKED_TARGETS;
const AI_UNAVAILABLE_REASON = "AI編集は公開Editorに含まれていません";
const EMPTY_PREVIEW_CLEAR_REQUEST = { seq: 0, outcome: "dismissed" as const };

type CommentSubmissionHandler = (threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void;

const ignoreCommentSubmission: CommentSubmissionHandler = () => undefined;

const clearDisabledAiPreview: (
  outcome?: "applied" | "dismissed",
  targets?: Array<{ roomId?: string; turnId?: string }>,
  includeResolved?: boolean,
) => void = () => undefined;

const unavailableProposalOperation: (proposalIds: string | string[]) => Promise<{ ok: false; reason: string }> = async () => (
  { ok: false, reason: AI_UNAVAILABLE_REASON }
);

const ignoreProposalOperation: (proposalIds?: string[], reason?: string) => Promise<void> = async () => undefined;

const DISABLED_PROPOSAL_ACTIONS = {
  aiApplyAnimation: null,
  aiEditPreviewClearRequest: EMPTY_PREVIEW_CLEAR_REQUEST,
  clearAiEditPreview: clearDisabledAiPreview,
  applyAiEditPreviewGroup: unavailableProposalOperation,
  forceApplyStaleProposals: unavailableProposalOperation,
  applyAllAiEditPreviewGroups: ignoreProposalOperation,
  dismissAiEditPreviewGroup: ignoreProposalOperation,
  discardStaleProposals: ignoreProposalOperation,
  rebaseStaleProposals: unavailableProposalOperation,
  restoreProposalFromHistory: unavailableProposalOperation,
  revertAppliedProposals: unavailableProposalOperation,
};

export const AI_APPLY_ADD_FLASH_MS = 0;
export const AI_APPLY_REMOVE_ANIMATION_MS = 0;
// AI 無効ビルドではロック自体が起きないので空文字。**関数形なのは本体に合わせるため**
// (本体は表示直前のロケールで解決する — `features/ai-edit/adapters/tiptap/edit-lock-adapter.ts`)。
export function aiDocumentWriteInProgressMessage(): string {
  return "";
}
export const AI_REFERENCE_TEXT_RANGE_EVENT = "sigma-editor:disabled-reference";
export const AI_SIDEBAR_WIDTH = 0;
export const AI_INLINE_ANCHOR_OFFSET_Y = 0;
export const AI_INLINE_DEFAULT_LEFT_PX = 0;
export const AI_INLINE_DEFAULT_TOP_PX = 0;
export const DEFAULT_AI_EDIT_MODEL = "";
export const DEFAULT_AI_EDIT_REASONING_EFFORT = "medium";
export const DEFAULT_CLAUDE_AI_EDIT_MODEL = "";
export const DEFAULT_GEMINI_AI_EDIT_MODEL = "";

export function AiEditPanel() {
  return null;
}

export const AiEditorHost: (props: Record<string, unknown>) => null = () => null;

export function AiTaskDock() {
  return null;
}

export function AiSettingsDialog() {
  return null;
}

export function AiPageCanvasEditor({
  aiEnabled: _aiEnabled,
  aiEditPreviewGroups: _aiEditPreviewGroups,
  aiEditPreviewApplying: _aiEditPreviewApplying,
  aiApplyAnimation: _aiApplyAnimation,
  onAiReferenceRequest: _onAiReferenceRequest,
  onAiReferenceCandidateChange: _onAiReferenceCandidateChange,
  onAiEditPreviewApply: _onAiEditPreviewApply,
  onAiEditPreviewDismiss: _onAiEditPreviewDismiss,
  onOpenSourceDocument: _onOpenSourceDocument,
  pinAiTextSelectionReference: _pinAiTextSelectionReference,
  onInlineRunPortalReady: _onInlineRunPortalReady,
  documentIdentityKey: _documentIdentityKey,
  aiDocumentEditLockReason: _aiDocumentEditLockReason,
  documentWorkspaceId: _documentWorkspaceId,
  onFocusAiSession: _onFocusAiSession,
  ...pageCanvasProps
}: Record<string, unknown>) {
  return <PageCanvasEditor {...pageCanvasProps} />;
}

export function useAiPinnedReferences() {
  const clear = useCallback(() => undefined, []);
  const pin = useCallback(() => ({
    outcome: "unavailable",
    referenceKey: "",
    references: EMPTY_ARRAY,
  }), []);
  const remove = useCallback(() => undefined, []);
  const reconcileTextRanges = useCallback(() => undefined, []);

  return {
    references: EMPTY_ARRAY,
    previews: EMPTY_PREVIEWS,
    clear,
    pin,
    remove,
    reconcileTextRanges,
  };
}

// 公開Editorには提案の保存・承認経路を持ち込まない。hostの文書やbusy stateには触れない。
export const useAiProposalActions: (options?: unknown) => typeof DISABLED_PROPOSAL_ACTIONS = () => DISABLED_PROPOSAL_ACTIONS;

// コメントのCRUDは通常のeditor hookが担う。メンションの実行配送だけを無効にする。
export function useCommentAiRun({ onCommentSubmittedRef }: {
  onCommentSubmittedRef: RefObject<CommentSubmissionHandler>;
}): CommentSubmissionHandler {
  useEffect(() => {
    onCommentSubmittedRef.current = ignoreCommentSubmission;
  }, [onCommentSubmittedRef]);
  return ignoreCommentSubmission;
}

export function useAiRunSessions() {
  return EMPTY_MAP;
}

export function useAiLockedTargets() {
  return EMPTY_LOCKED_TARGETS;
}

export function findAiLockedTargetsTouched() {
  return { blockIds: EMPTY_ARRAY, shapeIds: EMPTY_ARRAY };
}

export function hasAiLockedTargetsTouched() {
  return false;
}

export function isAiLockedBlock() {
  return false;
}

export function isAiLockedShapeSelection() {
  return false;
}

export function describeAiLockedTargets() {
  return "";
}

export function isAiRunStatusActive() {
  return false;
}

export function useAiConnection() {
  return {
    status: null,
    state: resolveAiConnectionState(null),
    loading: false,
    busy: false,
    pendingLogin: false,
    error: null,
    login: async () => undefined,
    logout: async () => undefined,
    refresh: () => undefined,
  };
}

export const useClaudeConnection = useAiConnection;
export const useGeminiConnection = useAiConnection;

export function resolveAiConnectionState(_status?: unknown) {
  return {
    kind: "unavailable",
    tone: "muted",
    label: "公開Editorでは利用できません",
    accountLabel: null,
  };
}

export const resolveClaudeConnectionState = resolveAiConnectionState;
export const resolveGeminiConnectionState = resolveAiConnectionState;

export function groupMcpProposalsForPreview() {
  return { groups: EMPTY_ARRAY, stale: EMPTY_ARRAY, current: null };
}

export function deriveAiProposalPresentation() {
  return {
    previewGroups: EMPTY_ARRAY,
    allVisibleProposalIds: EMPTY_ARRAY,
    hasActiveRunForDocument: false,
    documentEditLockReason: null,
    documentEditLocked: false,
    documentEditLockMessage: "",
  };
}

export function deriveAiRunStartTransition({
  seenRunIds = new Set(),
}: {
  seenRunIds?: ReadonlySet<string>;
} = {}) {
  return {
    seenRunIds: new Set(seenRunIds),
    newlySeenRunIds: EMPTY_ARRAY,
    activeDocumentRunIds: EMPTY_ARRAY,
    shouldClearActiveDocumentReference: false,
  };
}

export function buildSourceReferencesByTurnId() {
  return new Map();
}

export function buildInsertedShapePreviewsByTurnId() {
  return new Map();
}

export function buildRestorableProposalsByTurnId() {
  return new Map();
}

export function buildAppliedTurnChangesByTurnId() {
  return new Map();
}

export function normalizeAiProposalIds(ids: string[] = []) {
  return [...new Set(ids.filter(Boolean))];
}

export function resolveAiSurface() {
  return {
    hostVisible: false,
    hostClassName: "ai-chat-host--inline",
    gridHasAiColumn: false,
    catcherVisible: false,
  };
}

export function closeSurface() {
  return { displayMode: "inline", aiSidebarOpen: false, aiInlineOpen: false };
}

export const openInline = closeSurface;
export const promoteToSidebar = closeSurface;
export const toggleSurface = closeSurface;

export function isInlineToggleShortcut() {
  return false;
}

export function getAiInlineDragPosition(position: { left: number; top: number }) {
  return position;
}

export const getAiInlineHostPosition = getAiInlineDragPosition;

export function getAiInlineTopBoundary() {
  return 0;
}

export function deriveAiEditPreviewDiff() {
  return { addedIds: EMPTY_ARRAY, removedIds: EMPTY_ARRAY, changedIds: EMPTY_ARRAY };
}

export function buildAiProposalApplyContext() {
  return null;
}

export function deriveAiProposalApplyDecision() {
  return {
    appliedProposalIds: EMPTY_ARRAY,
    failedProposalIds: EMPTY_ARRAY,
    highlightIds: EMPTY_ARRAY,
  };
}

export function deriveAiProposalBusyGuardFeedback(
  busy: boolean,
  statusMessage: string,
  notify: (message: string) => void,
) {
  if (!busy) {
    return null;
  }
  notify(statusMessage);
  return {
    statusMessage,
    outcome: { ok: false, reason: "他の操作が進行中です" },
  };
}

export function deriveAiProposalApprovedFileFeedback({
  activeDocumentStatusMessage = "",
}: {
  activeDocumentStatusMessage?: string;
} = {}) {
  return {
    kind: "paint-active-document",
    statusMessage: activeDocumentStatusMessage,
  };
}

export function deriveAiProposalDismissEffects() {
  return EMPTY_ARRAY;
}

export function deriveAiStaleProposalDiscardEffects() {
  return EMPTY_ARRAY;
}

export function deriveAiProposalResolutionTargets() {
  return EMPTY_ARRAY;
}

export function deriveAiReferenceRequestPlan() {
  return { shouldOpenInline: false, shouldFocusComposer: false };
}

export function buildCommentAiRunRequestPlan() {
  return null;
}

export function deriveCommentAiRunEligibility() {
  return { eligible: false, reason: "AI編集は公開Editorに含まれていません" };
}

export function derivePostApplyHighlightIds() {
  return EMPTY_ARRAY;
}

export function findAiProposalGroupByIds() {
  return undefined;
}

export function selectPrimaryAiProposalIdForRevert() {
  return null;
}

export function selectSequentialAiRevertProposalIds(
  _proposals: unknown,
  proposalIds: string[] = [],
) {
  return proposalIds.length > 0 ? [proposalIds[0]] : [];
}

export async function runAiEditViaDesktopRuntime() {
  throw new Error(AI_UNAVAILABLE_REASON);
}

export function focusSourceReferenceInDocument() {
  return false;
}

export function resolveSourceReferenceNavigationTarget() {
  return { selectionId: null };
}

export function submitRejectionFeedback() {
  return undefined;
}
