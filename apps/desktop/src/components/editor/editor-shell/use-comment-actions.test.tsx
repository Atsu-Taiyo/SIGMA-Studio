// @vitest-environment happy-dom

import { act, useLayoutEffect, type SetStateAction } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InlineNode, SigmaCommentAnchor, SigmaCommentThread, SigmaDocument } from "@/features/document";
import { createTranslator } from "@/lib/i18n";

import { useCommentActions, type CommentActionOptions } from "./use-comment-actions";

const NOW = "2026-09-09T01:00:00.000Z";
const text = (value: string): InlineNode[] => [{ type: "text", text: value }];
const anchor: SigmaCommentAnchor = { type: "block", blockId: "paragraph-1" };
const tEditor = createTranslator("ja", "editor");

let root: Root;
let container: HTMLDivElement;
let actions: ReturnType<typeof useCommentActions>;

beforeEach(() => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function Probe({ options }: { options: CommentActionOptions }) {
  const result = useCommentActions(options);
  useLayoutEffect(() => { actions = result; });
  return null;
}

function render(options: CommentActionOptions) {
  act(() => root.render(<Probe options={options} />));
}

function thread(id: string): SigmaCommentThread {
  return {
    id,
    anchor,
    messages: [{ id: `${id}-first`, authorName: "あなた", body: text("original"), createdAt: NOW }],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function fixture(comments: SigmaCommentThread[] = []) {
  const documentRef = { current: {
    version: "2.0",
    docId: "comment-hook",
    metadata: { title: "コメント" },
    content: [{ id: "paragraph-1", type: "paragraph", children: text("本文") }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    comments,
  } satisfies SigmaDocument as SigmaDocument };
  const state = {
    activeThreadId: null as string | null,
    pendingAnchor: anchor as SigmaCommentAnchor | null,
    pendingDraft: text("コメント"),
    replyDrafts: {} as Record<string, InlineNode[]>,
    panelOpen: false,
  };
  const events: string[] = [];
  let sequence = 0;
  let author = "あなた";
  const apply = <T,>(next: SetStateAction<T>, current: T): T => typeof next === "function"
    ? (next as (current: T) => T)(current)
    : next;
  const commitDocumentChange = vi.fn((next: SigmaDocument) => {
    events.push("commit");
    documentRef.current = next;
    return true;
  });
  const onCommentSubmitted = vi.fn(() => { events.push("submitted"); });
  const options: CommentActionOptions = {
    documentRef,
    commentAuthor: { get name() { return author; } },
    pendingCommentAnchor: state.pendingAnchor,
    pendingCommentDraft: state.pendingDraft,
    commentReplyDrafts: state.replyDrafts,
    commitDocumentChange,
    setPendingCommentAnchor: vi.fn((next) => { events.push("anchor"); state.pendingAnchor = apply(next, state.pendingAnchor); }),
    setPendingCommentDraft: vi.fn((next) => { events.push("draft"); state.pendingDraft = apply(next, state.pendingDraft); }),
    setActiveCommentThreadId: vi.fn((next) => { events.push("active"); state.activeThreadId = apply(next, state.activeThreadId); }),
    setCommentsPanelOpen: vi.fn((next) => { events.push("panel"); state.panelOpen = apply(next, state.panelOpen); }),
    setCommentReplyDraft: vi.fn((id, draft) => {
      events.push("replyDraft");
      if (draft === null) delete state.replyDrafts[id];
      else state.replyDrafts[id] = draft;
    }),
    setStatusMessage: vi.fn(() => { events.push("status"); }),
    onCommentSubmittedRef: { current: onCommentSubmitted },
    mutationPorts: { now: () => NOW, createId: (prefix) => `${prefix}-${++sequence}` },
    defaultCommentColor: "#f2b705",
    tEditor,
  };
  return { options, state, events, documentRef, commitDocumentChange, onCommentSubmitted, setAuthor: (name: string) => { author = name; } };
}

describe("mounted comment actions", () => {
  it("leaves document and drafts untouched for empty submissions and edits", () => {
    const f = fixture([thread("target")]);
    render({ ...f.options, pendingCommentDraft: text("  "), commentReplyDrafts: { target: [] } });
    act(() => {
      actions.addPendingCommentThread();
      actions.replyToCommentThread("target");
      actions.editCommentThread("target", []);
      actions.editCommentMessage("target", "target-first", []);
    });
    render({ ...f.options, pendingCommentAnchor: null });
    act(() => actions.addPendingCommentThread());
    expect(f.events).toEqual([]);
    expect(f.commitDocumentChange).not.toHaveBeenCalled();
  });

  it("commits against the current document before clearing the composer and notifying the current submission handler", () => {
    const f = fixture();
    render(f.options);
    const existing = thread("arrived-after-render");
    const latestDocument = { ...f.documentRef.current, comments: [existing], metadata: { title: "新しい文書内容" } };
    f.documentRef.current = latestDocument;
    f.setAuthor("You");
    const latestHandler = vi.fn(() => {
      f.events.push("submitted");
      expect(f.documentRef.current.comments).toHaveLength(2);
      expect(f.state.pendingDraft).toEqual([]);
    });
    f.options.onCommentSubmittedRef.current = latestHandler;

    act(() => actions.addPendingCommentThread());

    expect(f.events).toEqual(["commit", "anchor", "draft", "active", "panel", "status", "submitted"]);
    expect(f.commitDocumentChange).toHaveBeenCalledTimes(1);
    expect(f.documentRef.current.metadata).toBe(latestDocument.metadata);
    expect(f.documentRef.current.comments?.[0]).toBe(existing);
    expect(f.documentRef.current.comments?.[1]).toMatchObject({
      id: "comment_thread-1", anchor, color: "#f2b705", messages: [{ authorName: "You", body: text("コメント") }],
    });
    expect(latestHandler).toHaveBeenCalledWith("comment_thread-1", f.options.pendingCommentDraft, anchor);
    expect(f.onCommentSubmitted).not.toHaveBeenCalled();
    expect(f.state).toMatchObject({ pendingAnchor: null, pendingDraft: [], activeThreadId: "comment_thread-1", panelOpen: true });
  });

  it("uses the rerendered reply draft and the current thread anchor", () => {
    const f = fixture([thread("target")]);
    render({ ...f.options, commentReplyDrafts: { target: text("古い下書き") } });
    const reply = text("@claude 最新の返信");
    render({ ...f.options, commentReplyDrafts: { target: reply } });
    const movedAnchor: SigmaCommentAnchor = { type: "block", blockId: "moved-paragraph" };
    f.documentRef.current = { ...f.documentRef.current, comments: [{ ...thread("target"), anchor: movedAnchor, resolved: true }] };
    act(() => actions.replyToCommentThread("target"));

    expect(f.events).toEqual(["commit", "replyDraft", "active", "status", "submitted"]);
    expect(f.documentRef.current.comments?.[0]).toMatchObject({ resolved: false, messages: [{ id: "target-first" }, { body: reply }] });
    expect(f.onCommentSubmitted).toHaveBeenCalledWith("target", reply, movedAnchor);
    expect(f.options.setCommentReplyDraft).toHaveBeenCalledWith("target", null);
  });

  it("routes edits, resolution, reactions and deletion through the supplied commit boundary", () => {
    const target = thread("target");
    target.messages.push({ id: "reply", authorName: "他の人", body: text("返信"), createdAt: NOW });
    const untouched = thread("untouched");
    const f = fixture([target, untouched]);
    render(f.options);

    act(() => actions.editCommentThread("target", text("新しい先頭")));
    act(() => actions.editCommentMessage("target", "reply", text("新しい返信")));
    expect(f.documentRef.current.comments?.[0]?.messages.map((message) => message.body)).toEqual([text("新しい先頭"), text("新しい返信")]);
    act(() => actions.updateCommentResolved("target", true));
    expect(f.documentRef.current.comments?.[0]?.resolved).toBe(true);
    act(() => actions.toggleCommentReaction("target", "reply", "👍"));
    expect(f.documentRef.current.comments?.[0]?.messages[1].reactions).toMatchObject([{ emoji: "👍", authorName: "あなた" }]);
    act(() => actions.deleteCommentMessage("target", "reply"));
    expect(f.documentRef.current.comments?.[0]?.messages).toHaveLength(1);
    f.state.activeThreadId = "untouched";
    act(() => actions.deleteCommentThread("target"));
    expect(f.state.activeThreadId).toBe("untouched");
    expect(f.documentRef.current.comments).toEqual([untouched]);
    expect(f.documentRef.current.comments?.[0]).toBe(untouched);
    act(() => actions.deleteCommentThread("untouched"));
    expect(f.state.activeThreadId).toBeNull();
    expect(f.documentRef.current.comments).toEqual([]);
    expect(f.commitDocumentChange).toHaveBeenCalledTimes(7);
    expect(f.onCommentSubmitted).not.toHaveBeenCalled();
  });

  it("appends an attributed reply without consuming a human draft or submitting it again", () => {
    const f = fixture([thread("target")]);
    f.state.replyDrafts.target = text("入力中");
    render(f.options);
    let messageId: string | undefined;
    act(() => { messageId = actions.appendReplyMessage("target", "Claude", text("回答"), { vendor: "anthropic" }); });
    expect(messageId).toBe("comment_msg-1");
    expect(f.documentRef.current.comments?.[0]?.messages[1]).toMatchObject({ id: messageId, authorName: "Claude", body: text("回答"), agent: { vendor: "anthropic" } });
    expect(f.events).toEqual(["commit"]);
    expect(f.state.replyDrafts.target).toEqual(text("入力中"));
    expect(f.onCommentSubmitted).not.toHaveBeenCalled();
  });

  it("cannot change the source document when the host rejects a commit", () => {
    const f = fixture([thread("target")]);
    const original = f.documentRef.current;
    f.commitDocumentChange.mockImplementation(() => false);
    render(f.options);
    act(() => actions.editCommentMessage("target", "target-first", text("承認されない編集")));
    expect(f.commitDocumentChange).toHaveBeenCalledOnce();
    expect(f.documentRef.current).toBe(original);
    expect(original.comments?.[0]?.messages[0].body).toEqual(text("original"));
  });
});
