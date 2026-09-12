"use client";

import { useCallback, type Dispatch, type RefObject, type SetStateAction } from "react";

import {
  appendCommentMessage,
  createCommentThread,
  removeCommentReplyMessage,
  removeCommentThread,
  setCommentThreadResolved,
  toggleCommentMessageReaction,
  updateCommentMessageBody,
  updateCommentThreadBody,
  type CommentMutationPorts,
  type InlineNode,
  type SigmaCommentAgent,
  type SigmaCommentAnchor,
  type SigmaDocument,
} from "@/features/document";
import { inlineNodesToCommentText, isInlineBodyEmpty } from "@/lib/comments";
import type { Translate } from "@/lib/i18n";

export type CommentSubmissionHandler = (threadId: string, body: InlineNode[], anchor: SigmaCommentAnchor) => void;

export interface CommentActionOptions {
  documentRef: RefObject<SigmaDocument>;
  commentAuthor: { readonly name: string };
  pendingCommentAnchor: SigmaCommentAnchor | null;
  pendingCommentDraft: InlineNode[];
  commentReplyDrafts: Record<string, InlineNode[]>;
  commitDocumentChange: (document: SigmaDocument) => boolean;
  setPendingCommentAnchor: Dispatch<SetStateAction<SigmaCommentAnchor | null>>;
  setPendingCommentDraft: Dispatch<SetStateAction<InlineNode[]>>;
  setActiveCommentThreadId: Dispatch<SetStateAction<string | null>>;
  setCommentsPanelOpen: Dispatch<SetStateAction<boolean>>;
  setCommentReplyDraft: (threadId: string, draft: InlineNode[] | null) => void;
  setStatusMessage: (message: string) => void;
  onCommentSubmittedRef: RefObject<CommentSubmissionHandler>;
  mutationPorts: CommentMutationPorts;
  defaultCommentColor: string;
  tEditor: Translate<"editor">;
}

/** コメントの操作と表示上の後処理。文書の保存・履歴・編集制限は呼出元のcommitに委ねる。 */
export function useCommentActions({
  documentRef,
  commentAuthor,
  pendingCommentAnchor,
  pendingCommentDraft,
  commentReplyDrafts,
  commitDocumentChange,
  setPendingCommentAnchor,
  setPendingCommentDraft,
  setActiveCommentThreadId,
  setCommentsPanelOpen,
  setCommentReplyDraft,
  setStatusMessage,
  onCommentSubmittedRef,
  mutationPorts,
  defaultCommentColor,
  tEditor,
}: CommentActionOptions) {
  const addPendingCommentThread = useCallback(() => {
    if (!pendingCommentAnchor || isInlineBodyEmpty(pendingCommentDraft)) return;

    const body = pendingCommentDraft;
    const result = createCommentThread(documentRef.current, {
      anchor: pendingCommentAnchor,
      authorName: commentAuthor.name,
      body,
      color: defaultCommentColor,
    }, mutationPorts);
    commitDocumentChange(result.document);
    setPendingCommentAnchor(null);
    setPendingCommentDraft([]);
    setActiveCommentThreadId(result.threadId);
    setCommentsPanelOpen(true);
    const summary = inlineNodesToCommentText(body);
    setStatusMessage(summary ? tEditor("status.commentAddedWith", { summary: summary.slice(0, 24) }) : tEditor("status.commentAdded"));
    onCommentSubmittedRef.current(result.threadId, body, pendingCommentAnchor);
  }, [commentAuthor.name, commitDocumentChange, defaultCommentColor, documentRef, mutationPorts, onCommentSubmittedRef, pendingCommentAnchor, pendingCommentDraft, setActiveCommentThreadId, setCommentsPanelOpen, setPendingCommentAnchor, setPendingCommentDraft, setStatusMessage, tEditor]);

  const replyToCommentThread = useCallback((threadId: string) => {
    const draft = commentReplyDrafts[threadId] ?? [];
    if (isInlineBodyEmpty(draft)) return;

    const body = draft;
    const result = appendCommentMessage(documentRef.current, {
      threadId,
      authorName: commentAuthor.name,
      body,
    }, mutationPorts);
    commitDocumentChange(result.document);
    setCommentReplyDraft(threadId, null);
    setActiveCommentThreadId(threadId);
    setStatusMessage(tEditor("status.replyAdded"));
    if (result.anchor) onCommentSubmittedRef.current(threadId, body, result.anchor);
  }, [commentAuthor.name, commentReplyDrafts, commitDocumentChange, documentRef, mutationPorts, onCommentSubmittedRef, setActiveCommentThreadId, setCommentReplyDraft, setStatusMessage, tEditor]);

  const updateCommentResolved = useCallback((threadId: string, resolved: boolean) => {
    const result = setCommentThreadResolved(documentRef.current, { threadId, resolved }, mutationPorts);
    commitDocumentChange(result.document);
    setActiveCommentThreadId(threadId);
    setStatusMessage(resolved ? tEditor("status.commentResolved") : tEditor("status.commentReopened"));
  }, [commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setStatusMessage, tEditor]);

  const editCommentThread = useCallback((threadId: string, body: InlineNode[]) => {
    if (isInlineBodyEmpty(body)) return;
    const result = updateCommentThreadBody(documentRef.current, { threadId, body }, mutationPorts);
    commitDocumentChange(result.document);
    setActiveCommentThreadId(threadId);
    setStatusMessage(tEditor("status.commentEdited"));
  }, [commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setStatusMessage, tEditor]);

  const editCommentMessage = useCallback((threadId: string, messageId: string, body: InlineNode[]) => {
    if (isInlineBodyEmpty(body)) return;
    const result = updateCommentMessageBody(documentRef.current, { threadId, messageId, body }, mutationPorts);
    commitDocumentChange(result.document);
    setActiveCommentThreadId(threadId);
    setStatusMessage(tEditor("status.commentEdited"));
  }, [commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setStatusMessage, tEditor]);

  // 下書きを消費しない返信。提供元の判定は呼出元に置き、保存用の著者情報だけを受け取る。
  const appendReplyMessage = useCallback((threadId: string, authorName: string, body: InlineNode[], agent?: SigmaCommentAgent): string => {
    const result = appendCommentMessage(documentRef.current, { threadId, authorName, agent, body }, mutationPorts);
    commitDocumentChange(result.document);
    return result.messageId;
  }, [commitDocumentChange, documentRef, mutationPorts]);

  const toggleCommentReaction = useCallback((threadId: string, messageId: string, emoji: string) => {
    const result = toggleCommentMessageReaction(documentRef.current, {
      threadId,
      messageId,
      emoji,
      authorName: commentAuthor.name,
    }, mutationPorts);
    commitDocumentChange(result.document);
    setActiveCommentThreadId(threadId);
    setStatusMessage(tEditor("status.reactionUpdated"));
  }, [commentAuthor.name, commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setStatusMessage, tEditor]);

  const deleteCommentThread = useCallback((threadId: string) => {
    const result = removeCommentThread(documentRef.current, { threadId }, mutationPorts);
    commitDocumentChange(result.document);
    setCommentReplyDraft(threadId, null);
    setActiveCommentThreadId((current) => current === threadId ? null : current);
    setStatusMessage(tEditor("status.commentDeleted"));
  }, [commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setCommentReplyDraft, setStatusMessage, tEditor]);

  const deleteCommentMessage = useCallback((threadId: string, messageId: string) => {
    const result = removeCommentReplyMessage(documentRef.current, { threadId, messageId }, mutationPorts);
    commitDocumentChange(result.document);
    setActiveCommentThreadId(threadId);
    setStatusMessage(tEditor("status.replyDeleted"));
  }, [commitDocumentChange, documentRef, mutationPorts, setActiveCommentThreadId, setStatusMessage, tEditor]);

  return {
    addPendingCommentThread,
    replyToCommentThread,
    updateCommentResolved,
    editCommentThread,
    editCommentMessage,
    appendReplyMessage,
    toggleCommentReaction,
    deleteCommentThread,
    deleteCommentMessage,
  };
}
