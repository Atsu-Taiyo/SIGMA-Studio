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

describe("CommentThreadsPanel", () => {
  it("コメントがないときは選択後に追加する案内を表示する", () => {
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

    expect(html).toContain("図形やテキストを選んでから");
  });
});
