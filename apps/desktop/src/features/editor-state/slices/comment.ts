import type { StateCreator } from "zustand";

import { getCommentAnchorCandidateKey } from "@/features/document";

import { resolveEditorStateUpdate } from "../resolve-update";

import type { EditorCommentSlice, EditorState } from "../types";

/** 全ストアが初期値として共有するので凍結しておく (誤って書き換えると文書間で漏れる)。 */
const EMPTY_COMMENT_REPLY_DRAFTS: Record<string, never> = Object.freeze({});

export function createCommentSlice(): StateCreator<EditorState, [], [], EditorCommentSlice> {
  return (set, get) => ({
    commentAnchorCandidate: null,
    pendingCommentAnchor: null,
    activeCommentThreadId: null,
    highlightedCommentThreadId: null,
    commentReplyDrafts: EMPTY_COMMENT_REPLY_DRAFTS,
    setCommentAnchorCandidate: (update) => {
      const current = get().commentAnchorCandidate;
      const commentAnchorCandidate = resolveEditorStateUpdate(update, current);
      // 打鍵のたびに「同じ段落を指す作り直しの候補」(引用文だけが伸びたもの) が届く。
      // 同値なら state を動かさない — 動かすと画面全体が再描画される。
      if (current === commentAnchorCandidate
        || getCommentAnchorCandidateKey(current) === getCommentAnchorCandidateKey(commentAnchorCandidate)) {
        return;
      }
      set({ commentAnchorCandidate });
    },
    setPendingCommentAnchor: (update) => {
      const pendingCommentAnchor = resolveEditorStateUpdate(update, get().pendingCommentAnchor);
      if (get().pendingCommentAnchor === pendingCommentAnchor) {
        return;
      }
      set({ pendingCommentAnchor });
    },
    setActiveCommentThreadId: (update) => {
      const activeCommentThreadId = resolveEditorStateUpdate(update, get().activeCommentThreadId);
      if (get().activeCommentThreadId === activeCommentThreadId) {
        return;
      }
      set({ activeCommentThreadId });
    },
    setHighlightedCommentThreadId: (update) => {
      const highlightedCommentThreadId = resolveEditorStateUpdate(update, get().highlightedCommentThreadId);
      if (get().highlightedCommentThreadId === highlightedCommentThreadId) {
        return;
      }
      set({ highlightedCommentThreadId });
    },
    clearCommentReplyDrafts: () => {
      if (Object.keys(get().commentReplyDrafts).length === 0) {
        return;
      }
      set({ commentReplyDrafts: EMPTY_COMMENT_REPLY_DRAFTS });
    },
    setCommentReplyDraft: (threadId, draft) => {
      const drafts = get().commentReplyDrafts;
      if (draft === null) {
        if (!(threadId in drafts)) {
          return;
        }
        const next = { ...drafts };
        delete next[threadId];
        set({ commentReplyDrafts: next });
        return;
      }
      if (drafts[threadId] === draft) {
        return;
      }
      set({ commentReplyDrafts: { ...drafts, [threadId]: draft } });
    },
  });
}
