import type { ComponentType } from "react";
/** Optional host services. Implementations are injected by the application composition.
 * Imports below describe existing input/output contracts only; they never initialize providers.
 */
export interface EditorAssistanceServices {
  EMPTY_AI_LOCKED_TARGETS: typeof import("@/features/ai-edit").EMPTY_AI_LOCKED_TARGETS;
  AiEditPanel: ComponentType<Parameters<typeof import("@/components/editor/AiEditPanel").AiEditPanel>[0]>;
  AiSettingsDialog: ComponentType<Parameters<typeof import("@/components/editor/AiSettingsDialog").AiSettingsDialog>[0]>;
  AiTaskDock: ComponentType<Parameters<typeof import("@/components/editor/AiTaskDock").AiTaskDock>[0]>;
  AI_INLINE_ANCHOR_OFFSET_Y: number;
  AiEditorHost: ComponentType<Parameters<typeof import("@/features/ai-edit").AiEditorHost>[0]>;
  AI_REFERENCE_TEXT_RANGE_EVENT: string;
  aiDocumentWriteInProgressMessage: typeof import("@/features/ai-edit").aiDocumentWriteInProgressMessage;
  AiPageCanvasEditor: ComponentType<Parameters<typeof import("@/features/ai-edit").AiPageCanvasEditor>[0]>;
  buildAppliedTurnChangesByTurnId: typeof import("@/features/ai-edit").buildAppliedTurnChangesByTurnId;
  buildInsertedShapePreviewsByTurnId: typeof import("@/features/ai-edit").buildInsertedShapePreviewsByTurnId;
  buildRestorableProposalsByTurnId: typeof import("@/features/ai-edit").buildRestorableProposalsByTurnId;
  buildSourceReferencesByTurnId: typeof import("@/features/ai-edit").buildSourceReferencesByTurnId;
  deriveAiProposalPresentation: typeof import("@/features/ai-edit").deriveAiProposalPresentation;
  deriveAiReferenceRequestPlan: typeof import("@/features/ai-edit").deriveAiReferenceRequestPlan;
  deriveAiRunStartTransition: typeof import("@/features/ai-edit").deriveAiRunStartTransition;
  describeAiLockedTargets: typeof import("@/features/ai-edit").describeAiLockedTargets;
  findAiLockedTargetsTouched: typeof import("@/features/ai-edit").findAiLockedTargetsTouched;
  groupMcpProposalsForPreview: typeof import("@/features/ai-edit").groupMcpProposalsForPreview;
  hasAiLockedTargetsTouched: typeof import("@/features/ai-edit").hasAiLockedTargetsTouched;
  isAiLockedBlock: typeof import("@/features/ai-edit").isAiLockedBlock;
  isAiLockedShapeSelection: typeof import("@/features/ai-edit").isAiLockedShapeSelection;
  useAiLockedTargets: typeof import("@/features/ai-edit").useAiLockedTargets;
  withAiResultOnlyTargets: typeof import("@/features/ai-edit").withAiResultOnlyTargets;
  aiLockedTargetsForOrigin: typeof import("@/features/ai-edit").aiLockedTargetsForOrigin;
  useAiPinnedReferences: typeof import("@/features/ai-edit").useAiPinnedReferences;
  useAiPendingAttachments: typeof import("@/features/ai-edit").useAiPendingAttachments;
  useAiWorkspaceTabTitles: typeof import("@/features/ai-edit").useAiWorkspaceTabTitles;
  useAiProposalActions: typeof import("@/features/ai-edit").useAiProposalActions;
  useCommentAiRun: typeof import("@/features/ai-edit").useCommentAiRun;
  useAiConnection: typeof import("@/lib/ai/ai-connection").useAiConnection;
  useClaudeConnection: typeof import("@/lib/ai/ai-connection").useClaudeConnection;
  useGeminiConnection: typeof import("@/lib/ai/ai-connection").useGeminiConnection;
  DEFAULT_CLAUDE_AI_EDIT_MODEL: typeof import("@/lib/ai/ai-providers").DEFAULT_CLAUDE_AI_EDIT_MODEL;
  DEFAULT_GEMINI_AI_EDIT_MODEL: typeof import("@/lib/ai/ai-providers").DEFAULT_GEMINI_AI_EDIT_MODEL;
  isAiRunStatusActive: typeof import("@/lib/ai/ai-run-session-store").isAiRunStatusActive;
  useAiRunSessions: typeof import("@/lib/ai/ai-run-session-store").useAiRunSessions;
  deleteAiDataForDocument: typeof import("@/lib/ai/ai-run-controller").deleteAiDataForDocument;
  focusSourceReferenceInDocument: typeof import("@/lib/ai/ai-source-reference-navigation").focusSourceReferenceInDocument;
  resolveSourceReferenceNavigationTarget: typeof import("@/lib/ai/ai-source-reference-navigation").resolveSourceReferenceNavigationTarget;
  closeSurface: typeof import("@/lib/ai/ai-surface").closeSurface;
  isInlineToggleShortcut: typeof import("@/lib/ai/ai-surface").isInlineToggleShortcut;
  openInline: typeof import("@/lib/ai/ai-surface").openInline;
  promoteToSidebar: typeof import("@/lib/ai/ai-surface").promoteToSidebar;
  resolveAiSurface: typeof import("@/lib/ai/ai-surface").resolveAiSurface;
  toggleSurface: typeof import("@/lib/ai/ai-surface").toggleSurface;
  runAiEditViaDesktopRuntime: typeof import("@/lib/ai/codex-ai-edit-client").runAiEditViaDesktopRuntime;
  resolveAiConnectionState: typeof import("@/lib/ai/ai-connection").resolveAiConnectionState;
  resolveClaudeConnectionState: typeof import("@/lib/ai/ai-connection").resolveClaudeConnectionState;
  resolveGeminiConnectionState: typeof import("@/lib/ai/ai-connection").resolveGeminiConnectionState;
}

export interface EditorHostServices {
  assistance: EditorAssistanceServices;
}
export type { AiEditPreviewState } from "@/features/ai-edit";
export type { AiEditReference } from "@/features/ai-edit";
export type { AiEditShapeOnlyPreview } from "@/features/ai-edit";
export type { AiProposalApplyOutcome } from "@/features/ai-edit";
export type { AiDisplayMode } from "@/lib/ai/ai-surface";
export type { AiSurfaceState } from "@/lib/ai/ai-surface";
export type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
