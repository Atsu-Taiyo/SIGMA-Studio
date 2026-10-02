"use client";
import type { EditorHostServices } from "./editor-host-contracts";
import { EMPTY_AI_LOCKED_TARGETS, AiEditorHost, AI_REFERENCE_TEXT_RANGE_EVENT, aiDocumentWriteInProgressMessage, AiPageCanvasEditor, buildAppliedTurnChangesByTurnId, buildInsertedShapePreviewsByTurnId, buildRestorableProposalsByTurnId, buildSourceReferencesByTurnId, deriveAiProposalPresentation, deriveAiReferenceRequestPlan, deriveAiRunStartTransition, describeAiLockedTargets, findAiLockedTargetsTouched, groupMcpProposalsForPreview, hasAiLockedTargetsTouched, isAiLockedBlock, isAiLockedShapeSelection, useAiLockedTargets, useAiPinnedReferences, useAiWorkspaceTabTitles, useAiProposalActions, useCommentAiRun } from "@/features/ai-edit";
import { AiEditPanel } from "@/components/editor/AiEditPanel";
import { AiTaskDock } from "@/components/editor/AiTaskDock";
import { AiSettingsDialog } from "@/components/editor/AiSettingsDialog";
import { AI_INLINE_ANCHOR_OFFSET_Y } from "@/components/editor/ai-inline-placement";
import { closeSurface, isInlineToggleShortcut, openInline, promoteToSidebar, resolveAiSurface, toggleSurface } from "@/lib/ai/ai-surface";
import { runAiEditViaDesktopRuntime } from "@/lib/ai/codex-ai-edit-client";
import { focusSourceReferenceInDocument, resolveSourceReferenceNavigationTarget } from "@/lib/ai/ai-source-reference-navigation";
import { deleteAiDataForDocument } from "@/lib/ai/ai-run-controller";
import { isAiRunStatusActive, useAiRunSessions } from "@/lib/ai/ai-run-session-store";
import { useAiConnection, useClaudeConnection, useGeminiConnection, resolveAiConnectionState, resolveClaudeConnectionState, resolveGeminiConnectionState } from "@/lib/ai/ai-connection";
import { DEFAULT_CLAUDE_AI_EDIT_MODEL, DEFAULT_GEMINI_AI_EDIT_MODEL } from "@/lib/ai/ai-providers";

/** Desktop-only composition; this module is absent from the public Editor graph. */
export const DESKTOP_EDITOR_HOST: EditorHostServices = {
  assistance: {
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
  },
};
