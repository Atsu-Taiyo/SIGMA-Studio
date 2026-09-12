"use client";

import { useCallback, useEffect, useRef, type RefObject } from "react";

import type { InlineNode, SigmaCommentAgent, SigmaCommentAnchor, SigmaDocument } from "@/features/document";
import type { AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { CodexAiEditRequest } from "@/lib/ai/codex-ai-edit-client";
import type { AiEditModel, AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import { getCommentAgentForProviderName } from "@/lib/comment-agents";
import type { Translate } from "@/lib/i18n";

import { buildCommentAiRunRequestPlan, deriveCommentAiRunEligibility } from "./run-request-model";

type CommentSubmissionHandler = (threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void;

export interface CommentAiRunOptions {
  documentRef: RefObject<SigmaDocument>;
  activeFileIdRef: RefObject<string>;
  connectedProviders: Readonly<Record<AiProvider, boolean>>;
  appendReplyMessage: (threadId: string, authorName: string, body: InlineNode[], agent?: SigmaCommentAgent) => string;
  editCommentMessage: (threadId: string, messageId: string, body: InlineNode[]) => void;
  refreshMcpEditProposals: () => Promise<void>;
  onCommentSubmittedRef: RefObject<CommentSubmissionHandler>;
  models: Readonly<Record<AiProvider, AiEditModel>>;
  reasoningEffort: AiEditReasoningEffort;
  runAiEdit: (request: CodexAiEditRequest) => Promise<AiEditRunResult>;
  tEditor: Translate<"editor">;
  tAi: Translate<"ai">;
}

/** コメントメンションの実行寿命を所有し、文書編集は通常のコメント操作と提案承認へ委ねる。 */
export function useCommentAiRun({
  documentRef,
  activeFileIdRef,
  connectedProviders: { chatgpt, claude, antigravity },
  appendReplyMessage,
  editCommentMessage,
  refreshMcpEditProposals,
  onCommentSubmittedRef,
  models: { chatgpt: chatgptModel, claude: claudeModel, antigravity: antigravityModel },
  reasoningEffort,
  runAiEdit,
  tEditor,
  tAi,
}: CommentAiRunOptions): CommentSubmissionHandler {
  // stateの反映前に同じスレッドへ連続投稿されても、多重起動させない。
  const runningThreadsRef = useRef<Set<string>>(new Set());
  const appendAiReplyMessage = useCallback((threadId: string, authorName: string, body: InlineNode[]): string => (
    appendReplyMessage(threadId, authorName, body, getCommentAgentForProviderName(authorName))
  ), [appendReplyMessage]);

  const maybeTriggerCommentAiRun = useCallback((threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => {
    const eligibility = deriveCommentAiRunEligibility({
      body,
      threadAlreadyRunning: runningThreadsRef.current.has(threadId),
      connectedProviders: { chatgpt, claude, antigravity },
      t: tAi,
    });
    if (eligibility.kind === "ignore") return;
    if (eligibility.kind === "disconnected") {
      appendAiReplyMessage(threadId, eligibility.match.authorName, [{ type: "text", text: eligibility.message }]);
      return;
    }
    const { match } = eligibility;
    const running = new Set(runningThreadsRef.current);
    running.add(threadId);
    runningThreadsRef.current = running;

    const placeholderId = appendAiReplyMessage(threadId, match.authorName, [{
      type: "text",
      text: tEditor("status.aiThinking", { name: match.authorName }),
    }]);

    void (async () => {
      try {
        const runDocument = documentRef.current;
        const requestPlan = buildCommentAiRunRequestPlan({
          document: runDocument,
          body,
          anchor,
          match,
          models: { chatgpt: chatgptModel, claude: claudeModel, antigravity: antigravityModel },
          reasoningEffort,
        });
        const result = await runAiEdit({ fileId: activeFileIdRef.current, ...requestPlan });
        const operations = result.draft.operations ?? [];
        // 全プロバイダがpending proposalを書きうる。再取得を終えてから返信を確定する。
        await refreshMcpEditProposals();
        const summary = result.draft.summary?.trim()
          || (operations.length > 0 ? tEditor("status.aiDraftReady") : tEditor("status.aiAnswerReady"));
        editCommentMessage(threadId, placeholderId, [{ type: "text", text: summary }]);
      } catch (error) {
        const message = error instanceof Error ? error.message : tEditor("status.aiRunFailed");
        editCommentMessage(threadId, placeholderId, [{ type: "text", text: tEditor("status.errorWith", { message }) }]);
      } finally {
        const next = new Set(runningThreadsRef.current);
        next.delete(threadId);
        runningThreadsRef.current = next;
      }
    })();
  }, [activeFileIdRef, antigravity, antigravityModel, appendAiReplyMessage, chatgpt, chatgptModel, claude, claudeModel, documentRef, editCommentMessage, reasoningEffort, refreshMcpEditProposals, runAiEdit, tAi, tEditor]);

  // 投稿側への配送は従来どおりpassive effectで更新し、描画中には書き換えない。
  useEffect(() => {
    onCommentSubmittedRef.current = maybeTriggerCommentAiRun;
  }, [maybeTriggerCommentAiRun, onCommentSubmittedRef]);

  return maybeTriggerCommentAiRun;
}
