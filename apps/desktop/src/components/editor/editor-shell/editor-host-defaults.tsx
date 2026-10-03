import { useCallback, useEffect, type RefObject } from "react";
import type { InlineNode, SigmaCommentAnchor } from "@/features/document";

import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { PageCanvasEditor } from "../PageCanvasEditor";
import type { EditorAssistanceServices, EditorHostServices } from "./editor-host-contracts";

const EMPTY_ARRAY: never[] = [];
const EMPTY_MAP = new Map();
export function useAiWorkspaceTabTitles(): ReadonlyMap<string, string> { return EMPTY_MAP; }

export async function deleteAiDataForDocument(): Promise<void> {
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
const tAi = createCurrentLocaleTranslator("ai");
const unavailableReason = () => tAi("host.unavailable");
const EMPTY_PREVIEW_CLEAR_REQUEST = { seq: 0, outcome: "dismissed" as const };

type CommentSubmissionHandler = (threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void;

const ignoreCommentSubmission: CommentSubmissionHandler = () => undefined;

const clearDisabledAiPreview: (
  outcome?: "applied" | "dismissed",
  targets?: Array<{ roomId?: string; turnId?: string }>,
  includeResolved?: boolean,
) => void = () => undefined;

const unavailableProposalOperation: (proposalIds: string | string[]) => Promise<{ ok: false; reason: string }> = async () => (
  { ok: false, reason: unavailableReason() }
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
// AI 無効ビルドではロック自体が起きないので空文字。**関数形なのは本体に合わせるため**
// (本体は表示直前のロケールで解決する — `features/ai-edit/adapters/tiptap/edit-lock-adapter.ts`)。
export function aiDocumentWriteInProgressMessage(): string {
  return "";
}
export const AI_REFERENCE_TEXT_RANGE_EVENT = "sigma-editor:disabled-reference";
export const AI_INLINE_ANCHOR_OFFSET_Y = 0;
export const DEFAULT_CLAUDE_AI_EDIT_MODEL = "";
export const DEFAULT_GEMINI_AI_EDIT_MODEL = "";

export function AiEditPanel() {
  return null;
}

export const AiEditorHost: EditorAssistanceServices["AiEditorHost"] = () => null;

export function AiTaskDock() {
  return null;
}

export function AiSettingsDialog() {
  return null;
}

const AiPageCanvasEditor: EditorAssistanceServices["AiPageCanvasEditor"] = (props) => (
  <PageCanvasEditor {...props} />
);

export function useAiPinnedReferences() {
  const clear = useCallback(() => undefined, []);
  const pin = useCallback(() => ({
    outcome: "limit" as const,
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

export function useAiPendingAttachments() {
  const add = useCallback(() => undefined, []);
  const remove = useCallback(() => undefined, []);
  const clear = useCallback(() => undefined, []);
  return { attachments: EMPTY_ARRAY, add, remove, clear };
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
    state: resolveAiConnectionState(),
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

export function resolveAiConnectionState() {
  return {
    kind: "unavailable" as const,
    tone: "muted" as const,
    label: unavailableReason(),
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

export function resolveAiSurface() {
  return {
    hostVisible: false,
    hostClassName: "ai-chat-host--inline" as const,
    gridHasAiColumn: false,
    catcherVisible: false,
  };
}

export function closeSurface() {
  return { displayMode: "inline" as const, aiSidebarOpen: false, aiInlineOpen: false };
}

export const openInline = closeSurface;
export const promoteToSidebar = closeSurface;
export const toggleSurface = closeSurface;

export function isInlineToggleShortcut() {
  return false;
}

export function deriveAiReferenceRequestPlan() {
  return { surfaceAction: "keepActiveSurface" as const, inlineAnchor: null, selectionAction: { type: "preserve" as const, selectedId: null }, statusMessage: "" };
}

export async function runAiEditViaDesktopRuntime(): Promise<never> {
  throw new Error(unavailableReason());
}

export function focusSourceReferenceInDocument() {
  return false;
}

export function resolveSourceReferenceNavigationTarget() {
  return { selectionId: null, highlightId: null, highlightKind: "block" as const };
}

const disabledAssistance: EditorAssistanceServices = {
  EMPTY_AI_LOCKED_TARGETS,
  AiEditPanel,
  AiSettingsDialog,
  AiTaskDock,
  AI_INLINE_ANCHOR_OFFSET_Y,
  AiEditorHost,
  AI_REFERENCE_TEXT_RANGE_EVENT,
  aiDocumentWriteInProgressMessage,
  AiPageCanvasEditor,
  buildAppliedTurnChangesByTurnId,
  buildInsertedShapePreviewsByTurnId,
  buildRestorableProposalsByTurnId,
  buildSourceReferencesByTurnId,
  deriveAiProposalPresentation,
  deriveAiReferenceRequestPlan,
  deriveAiRunStartTransition,
  describeAiLockedTargets,
  findAiLockedTargetsTouched,
  groupMcpProposalsForPreview,
  hasAiLockedTargetsTouched,
  isAiLockedBlock,
  isAiLockedShapeSelection,
  useAiLockedTargets,
  useAiPinnedReferences,
  useAiPendingAttachments,
  useAiWorkspaceTabTitles,
  useAiProposalActions,
  useCommentAiRun,
  useAiConnection,
  useClaudeConnection,
  useGeminiConnection,
  DEFAULT_CLAUDE_AI_EDIT_MODEL,
  DEFAULT_GEMINI_AI_EDIT_MODEL,
  isAiRunStatusActive,
  useAiRunSessions,
  deleteAiDataForDocument,
  focusSourceReferenceInDocument,
  resolveSourceReferenceNavigationTarget,
  closeSurface,
  isInlineToggleShortcut,
  openInline,
  promoteToSidebar,
  resolveAiSurface,
  toggleSurface,
  runAiEditViaDesktopRuntime,
  resolveAiConnectionState,
  resolveClaudeConnectionState,
  resolveGeminiConnectionState,
};

export const DEFAULT_EDITOR_HOST: EditorHostServices = { assistance: disabledAssistance };
