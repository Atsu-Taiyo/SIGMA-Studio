import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { AiDisplayMode } from "@/lib/ai/ai-surface";
import type { AiProvider } from "@/lib/ai/ai-providers";
import {
  buildCommentInstruction,
  detectCommentAiMention,
  type CommentMentionMatch,
} from "@/lib/ai/comment-mention";
import { getCommentAnchorQuote } from "@/lib/comments";
import {
  MAX_AI_EDIT_REFERENCES,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import type {
  AiEditModel,
  AiEditReasoningEffort,
} from "@/lib/ai/sigma-doc-edit-schema";
import type {
  InlineNode,
  SigmaCommentAnchor,
  SigmaDocument,
} from "@/features/document";

import { buildCommentAiReference } from "../model/comment-reference";
import type { AiPinnedReferenceAddOutcome } from "../model/pinned-reference-model";

export type CommentAiRunEligibility =
  | { kind: "ignore"; reason: "noMention" | "alreadyRunning" }
  | {
      kind: "disconnected";
      match: CommentMentionMatch;
      message: string;
    }
  | { kind: "ready"; match: CommentMentionMatch };

export interface CommentAiRunRequestPlan {
  provider: AiProvider;
  model: AiEditModel;
  reasoningEffort: AiEditReasoningEffort;
  instruction: string;
  document: SigmaDocument;
  selectedId: string | null;
  references: AiEditReference[];
}

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

export function deriveCommentAiRunEligibility({
  body,
  threadAlreadyRunning,
  connectedProviders,
  t = DEFAULT_AI_TRANSLATE,
}: {
  body: readonly InlineNode[];
  threadAlreadyRunning: boolean;
  connectedProviders: Readonly<Record<AiProvider, boolean>>;
  t?: Translate<"ai">;
}): CommentAiRunEligibility {
  const match = detectCommentAiMention(body);
  if (!match) {
    return { kind: "ignore", reason: "noMention" };
  }
  if (threadAlreadyRunning) {
    return { kind: "ignore", reason: "alreadyRunning" };
  }
  if (!connectedProviders[match.provider]) {
    return {
      kind: "disconnected",
      match,
      // `authorName` はブランド名 (ChatGPT / Claude / Antigravity) なので翻訳対象ではない。
      message: t("run.providerDisconnected", { replace: { name: match.authorName } }),
    };
  }
  return { kind: "ready", match };
}

export function buildCommentAiRunRequestPlan({
  document,
  body,
  anchor,
  match,
  models,
  reasoningEffort,
}: {
  document: SigmaDocument;
  body: readonly InlineNode[];
  anchor: SigmaCommentAnchor;
  match: CommentMentionMatch;
  models: Readonly<Record<AiProvider, AiEditModel>>;
  reasoningEffort: AiEditReasoningEffort;
}): CommentAiRunRequestPlan {
  const { selectedId, reference } = buildCommentAiReference(document, anchor);
  return {
    provider: match.provider,
    model: models[match.provider],
    reasoningEffort,
    instruction: buildCommentInstruction(
      body,
      match,
      getCommentAnchorQuote(anchor),
    ),
    document,
    selectedId,
    references: reference ? [reference] : [],
  };
}

export type AiReferenceSelectionAction =
  | { type: "preserve"; selectedId: string | null }
  | { type: "selectBlock"; targetId: string };

export interface AiReferenceRequestPlan {
  surfaceAction: "keepActiveSurface" | "openInline";
  inlineAnchor: { left: number; top: number } | null;
  selectionAction: AiReferenceSelectionAction;
  statusMessage: string;
}

/**
 * 参照pin後のUI routingを決める。既にinline/sidebarが開いていれば、そのactive roomと
 * composerを維持する。overlay参照では既存block選択を維持し、図形選択を解除しない。
 */
export function deriveAiReferenceRequestPlan({
  reference,
  pinOutcome,
  displayMode,
  inlineOpen,
  sidebarOpen,
  anchor,
  selectedId,
  t = DEFAULT_AI_TRANSLATE,
}: {
  reference: AiEditReference;
  t?: Translate<"ai">;
  pinOutcome: AiPinnedReferenceAddOutcome;
  displayMode: AiDisplayMode;
  inlineOpen: boolean;
  sidebarOpen: boolean;
  anchor?: { left: number; top: number } | null;
  selectedId: string | null;
}): AiReferenceRequestPlan {
  const activeSurfaceOpen = (
    (displayMode === "inline" && inlineOpen)
    || (displayMode === "sidebar" && sidebarOpen)
  );
  return {
    surfaceAction: activeSurfaceOpen ? "keepActiveSurface" : "openInline",
    inlineAnchor: anchor ?? null,
    selectionAction: reference.overlaySelection
      ? { type: "preserve", selectedId }
      : { type: "selectBlock", targetId: reference.targetId },
    statusMessage: pinOutcome === "limit"
      ? t("reference.limit", { replace: { max: MAX_AI_EDIT_REFERENCES } })
      : t("reference.set"),
  };
}

export interface AiRunStartSessionSnapshot {
  runId: string | null;
  status: unknown;
  anchor?: {
    documentId?: string;
  } | null;
}

export interface AiRunStartTransition {
  seenRunIds: Set<string>;
  newlySeenRunIds: string[];
  activeDocumentRunIds: string[];
  shouldClearActiveDocumentReference: boolean;
}

/**
 * run session snapshotから、初回seedと新規run開始を区別する。background documentのrunも
 * seenには記録するため、後からdocumentを切り替えても既に進行中だったrunで選択を消さない。
 */
export function deriveAiRunStartTransition<
  Session extends AiRunStartSessionSnapshot,
>({
  sessions,
  activeDocumentId,
  seenRunIds,
  initialized,
  isRunActive,
}: {
  sessions: Iterable<Session>;
  activeDocumentId: string;
  seenRunIds: ReadonlySet<string>;
  initialized: boolean;
  isRunActive: (status: Session["status"]) => boolean;
}): AiRunStartTransition {
  const nextSeenRunIds = new Set(seenRunIds);
  const newlySeenRunIds: string[] = [];
  const activeDocumentRunIds: string[] = [];

  for (const session of sessions) {
    if (!session.runId || !isRunActive(session.status)) {
      continue;
    }
    if (nextSeenRunIds.has(session.runId)) {
      continue;
    }
    nextSeenRunIds.add(session.runId);
    newlySeenRunIds.push(session.runId);
    if (initialized && session.anchor?.documentId === activeDocumentId) {
      activeDocumentRunIds.push(session.runId);
    }
  }

  return {
    seenRunIds: nextSeenRunIds,
    newlySeenRunIds,
    activeDocumentRunIds,
    shouldClearActiveDocumentReference: activeDocumentRunIds.length > 0,
  };
}
