import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CommentMessageBody, CommentThreadsPanel } from "./CommentThreadsPanel";

const noop = () => {};

describe("CommentMessageBody", () => {
  it("renders inline math with the same body math layout wrapper", () => {
    const html = renderToStaticMarkup(
      <CommentMessageBody
        body={[
          { type: "text", text: "面積は " },
          { type: "mathInline", id: "m_comment_1", tex: "x^2", display: "inline" },
          { type: "text", text: " です。" },
        ]}
      />,
    );

    expect(html).toContain("inline-math-node");
    expect(html).toContain("math-preview-inline");
    expect(html).toContain('data-sigma-doc-math-inline=""');
    expect(html).toContain('data-id="m_comment_1"');
  });
});

describe("CommentMessageBody mention chips", () => {
  it("宛先の人をアイコン+名前のチップにし、名前とメールをツールチップに出す", () => {
    const html = renderToStaticMarkup(
      <CommentMessageBody
        currentUserId="me"
        mentionDirectory={new Map([["taro", { userId: "taro", name: "太郎", email: "taro@example.com" }]])}
        body={[{ type: "text", text: "@太郎", mentionUserId: "taro" }, { type: "text", text: " 確認して" }]}
      />,
    );

    expect(html).toContain('data-comment-mention="taro"');
    expect(html).toContain('title="太郎 &lt;taro@example.com&gt;"');
    expect(html).toContain("comment-author-avatar");
    expect(html).toContain("@太郎");
  });

  it("一覧に居ない宛先でも本文の名前でチップを出し、自分宛は自分宛と分かる", () => {
    const html = renderToStaticMarkup(
      <CommentMessageBody
        currentUserId="me"
        body={[{ type: "text", text: "@花子", mentionUserId: "hanako" }, { type: "text", text: "@自分", mentionUserId: "me" }]}
      />,
    );

    expect(html).toContain('title="花子"');
    expect(html).toContain("is-self");
    expect(html).toContain("あなたへのメンション");
  });

  it("@claude などのAIメンションをAIのアイコン付きチップにする", () => {
    const html = renderToStaticMarkup(
      <CommentMessageBody body={[{ type: "text", text: "この式を @claude 直して" }]} />,
    );

    expect(html).toContain("is-agent");
    expect(html).toContain("comment-author-avatar agent");
    expect(html).toContain('title="Claude（AI Agent）');
    expect(html).toContain("この式を ");
    expect(html).toContain(" 直して");
  });
});

describe("CommentThreadsPanel", () => {
  it("コメントがないときは追加の案内を表示する", () => {
    const html = renderToStaticMarkup(
      <CommentThreadsPanel
        activeThreadId={null}
        author={{ name: "ゲスト" }}
        candidateAnchor={null}
        document={{
          version: "2.0",
          docId: "empty_comment_panel_test",
          metadata: { title: "コメント空状態" },
          content: [],
          outputProfiles: { student: {}, teacher: {}, answerBook: {} },
        }}
        pendingAnchor={null}
        pendingDraft={[]}
        replyDrafts={{}}
        showResolved={false}
        threads={[]}
        onAddThread={noop}
        onCancelPending={noop}
        onDeleteMessage={noop}
        onDeleteThread={noop}
        onEditMessage={noop}
        onEditThread={noop}
        onPendingDraftChange={noop}
        onReply={noop}
        onReplyDraftChange={noop}
        onResolveThread={noop}
        onReopenThread={noop}
        onSelectThread={noop}
        onShowResolvedChange={noop}
        onStartThread={noop}
        onToggleReaction={noop}
      />,
    );

    expect(html).toContain("「コメントを追加」を押すと書き始められます。");
  });
});
