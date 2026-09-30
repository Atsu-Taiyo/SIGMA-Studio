import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommentDock, type CommentDockProps } from "./CommentDock";
import type { SigmaDocument } from "@/types/sigma-doc";

const document: SigmaDocument = {
  version: "2.0",
  docId: "comment_dock_test",
  metadata: { title: "コメントDock" },
  content: [{ id: "p_1", type: "paragraph", children: [{ type: "text", text: "本文" }] }],
  comments: [{
    id: "thread_1",
    anchor: { type: "block", blockId: "p_1" },
    messages: [{
      id: "message_1",
      authorName: "ゲスト",
      body: [{ type: "text", text: "確認してください" }],
      createdAt: "2026-07-20T00:00:00.000Z",
    }],
    createdAt: "2026-07-20T00:00:00.000Z",
  }],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};
const emptyDocument: SigmaDocument = {
  ...document,
  comments: [],
};

const noop = () => {};
const panel: CommentDockProps["panel"] = {
  activeThreadId: null,
  author: { name: "ゲスト" },
  candidateAnchor: null,
  pendingAnchor: null,
  pendingDraft: [],
  replyDrafts: {},
  showResolved: false,
  threads: document.comments ?? [],
  onAddThread: noop,
  onCancelPending: noop,
  onDeleteMessage: noop,
  onDeleteThread: noop,
  onEditMessage: noop,
  onEditThread: noop,
  onPendingDraftChange: noop,
  onReply: noop,
  onReplyDraftChange: noop,
  onResolveThread: noop,
  onReopenThread: noop,
  onSelectThread: noop,
  onShowResolvedChange: noop,
  onStartThread: noop,
  onToggleReaction: noop,
};

describe("CommentDock", () => {
  it("初期状態では右上アイコンだけを表示する", () => {
    const html = renderToStaticMarkup(createElement(CommentDock, {
      document,
      open: false,
      panel,
      onOpenChange: noop,
    }));

    expect(html).toContain("comment-dock-toggle");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("コメント (1件)");
    expect(html).not.toContain("コメントパネル");
  });

  it("明示的に開いたときだけコメントパネルを表示する", () => {
    const html = renderToStaticMarkup(createElement(CommentDock, {
      document,
      open: true,
      panel,
      onOpenChange: noop,
    }));

    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain('aria-label="コメントパネル"');
    expect(html).toContain("確認してください");
    expect(html).toContain("コメントを追加");
    expect(html).toContain("選ばない場合は文書全体へのコメントになります。");
    expect(html).toContain('aria-label="コメントを閉じる"');
  });

  it("空状態で追加ボタンと対象の選び方を表示する", () => {
    const html = renderToStaticMarkup(createElement(CommentDock, {
      document: emptyDocument,
      open: true,
      panel: { ...panel, threads: [] },
      onOpenChange: noop,
    }));

    expect(html).toContain("「コメントを追加」を押すと書き始められます。");
    expect(html.match(/>コメントを追加</g)).toHaveLength(2);
  });
});
