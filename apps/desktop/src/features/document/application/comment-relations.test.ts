import { describe, expect, it } from "vitest";

import type { InlineNode, SigmaCommentThread } from "../model";
import { collectUserCommentThreads, commentMessageIsFromUser, commentMessageMentionsUser, type CommentUserIdentity } from "./comment-relations";

const ME: CommentUserIdentity = { userId: "user-me", authorNames: ["山田 太郎", "yamada@example.com"] };
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";
const T2 = "2026-09-03T00:00:00.000Z";

function text(value: string, mentionUserId?: string): InlineNode {
  return { type: "text", text: value, ...(mentionUserId ? { mentionUserId } : {}) };
}

interface MessageInput { id: string; author?: string; at: string; body?: InlineNode[]; agent?: boolean }

function thread(id: string, messages: MessageInput[], extra: Partial<SigmaCommentThread> = {}): SigmaCommentThread {
  return {
    id,
    anchor: { type: "block", blockId: "p1", quote: "  引用文  " },
    messages: messages.map((message) => ({
      id: message.id,
      authorName: message.author,
      ...(message.agent ? { agent: { vendor: "anthropic" as const } } : {}),
      body: message.body ?? [text(`本文 ${message.id}`)],
      createdAt: message.at,
    })),
    createdAt: messages[0]?.at ?? T0,
    ...extra,
  };
}

const ids = (comments: SigmaCommentThread[], identity = ME) => collectUserCommentThreads(comments, identity).map((entry) => entry.threadId);

describe("collectUserCommentThreads", () => {
  it("returns nothing without comments or without a user id", () => {
    expect(collectUserCommentThreads(undefined, ME)).toEqual([]);
    expect(collectUserCommentThreads([], ME)).toEqual([]);
    expect(ids([thread("t", [{ id: "m", author: "山田 太郎", at: T0 }])], { userId: "", authorNames: ME.authorNames })).toEqual([]);
  });

  it("includes threads I am mentioned in, my own threads and threads where I replied, but not unrelated ones", () => {
    const comments = [
      thread("mentioned", [{ id: "m1", author: "佐藤", at: T0, body: [text("確認を "), text("@私", ME.userId)] }]),
      thread("started", [{ id: "m2", author: "山田 太郎", at: T0 }]),
      thread("replied", [{ id: "m3", author: "佐藤", at: T0 }, { id: "m4", author: "yamada@example.com", at: T1 }]),
      thread("unrelated", [{ id: "m5", author: "佐藤", at: T0 }, { id: "m6", author: "田中", at: T1 }]),
      thread("other-mention", [{ id: "m7", author: "佐藤", at: T0, body: [text("@他の人", "user-other")] }]),
      thread("plain-at", [{ id: "m8", author: "佐藤", at: T0, body: [text("@私 という文字だけ")] }]),
    ];
    expect(ids(comments)).toEqual(["mentioned", "started", "replied"]);
  });

  it("flags why a thread is related", () => {
    const [mentionedOnly, authoredOnly, both] = collectUserCommentThreads([
      thread("a", [{ id: "m1", author: "佐藤", at: T0, body: [text("@私", ME.userId)] }]),
      thread("b", [{ id: "m2", author: "山田 太郎", at: T0 }]),
      thread("c", [{ id: "m3", author: "山田 太郎", at: T0 }, { id: "m4", author: "佐藤", at: T1, body: [text("@私", ME.userId)] }]),
    ], ME);
    expect([mentionedOnly.mentioned, mentionedOnly.authored]).toEqual([true, false]);
    expect([authoredOnly.mentioned, authoredOnly.authored]).toEqual([false, true]);
    expect([both.mentioned, both.authored]).toEqual([true, true]);
  });

  it("shows the latest mentioning message, or the latest message when I was not mentioned", () => {
    const [mentioned, replied] = collectUserCommentThreads([
      thread("t1", [
        { id: "first", author: "佐藤", at: T0, body: [text("@私", ME.userId), text(" まず確認")] },
        { id: "other", author: "田中", at: T1 },
        { id: "last", author: "鈴木", at: T2, body: [text("@私", ME.userId), text(" 修正しました")] },
        { id: "tail", author: "田中", at: T2 },
      ]),
      thread("t2", [
        { id: "mine", author: "山田 太郎", at: T0 },
        { id: "answer", author: "佐藤", at: T1, body: [text("ありがとう")] },
      ]),
    ], ME);
    expect(mentioned).toMatchObject({ messageId: "last", authorName: "鈴木", ownMessage: false, excerpt: "@私 修正しました", messageCount: 4 });
    expect(replied).toMatchObject({ messageId: "answer", authorName: "佐藤", ownMessage: false, excerpt: "ありがとう", activityAt: T1 });
  });

  it("marks my own latest message, and reports the newest activity even when messages are out of order", () => {
    const [entry] = collectUserCommentThreads([
      thread("t", [
        { id: "late", author: "佐藤", at: T2 },
        { id: "mine", author: "山田 太郎", at: T0 },
      ]),
    ], ME);
    expect(entry).toMatchObject({ messageId: "mine", ownMessage: true, activityAt: T2 });
  });

  it("does not treat an AI reply as mine even if it shares my display name", () => {
    expect(ids([thread("t", [{ id: "m", author: "山田 太郎", at: T0, agent: true }])])).toEqual([]);
  });

  it("marks resolved threads instead of dropping them", () => {
    const [entry] = collectUserCommentThreads([thread("done", [{ id: "m", author: "山田 太郎", at: T0 }], { resolved: true })], ME);
    expect(entry.resolved).toBe(true);
  });

  it("trims the quote, uses an empty one for anchors without it, and renders math as TeX", () => {
    const [withQuote, withoutQuote] = collectUserCommentThreads([
      thread("q", [{ id: "m1", author: "山田 太郎", at: T0 }]),
      thread("doc", [{
        id: "m2",
        author: "山田 太郎",
        at: T0,
        body: [text("式 "), { type: "mathInline", id: "x", tex: "x^2", display: "inline" }],
      }], { anchor: { type: "document" } }),
    ], ME);
    expect(withQuote.quote).toBe("引用文");
    expect(withoutQuote.quote).toBe("");
    expect(withoutQuote.excerpt).toBe("式 $x^2$");
  });

  it("omits authorName when the shown message has none", () => {
    const [entry] = collectUserCommentThreads([
      thread("t", [{ id: "m", at: T0, body: [text("@私", ME.userId)] }]),
    ], ME);
    expect("authorName" in entry).toBe(false);
  });
});

describe("message helpers", () => {
  const message = { id: "m", authorName: "山田 太郎", body: [text("a", "user-other"), text("b", ME.userId)], createdAt: T0 };

  it("commentMessageMentionsUser only matches text nodes carrying the user id", () => {
    expect(commentMessageMentionsUser(message, ME.userId)).toBe(true);
    expect(commentMessageMentionsUser(message, "nobody")).toBe(false);
  });

  it("commentMessageIsFromUser matches any of my author names but not an unnamed or AI message", () => {
    expect(commentMessageIsFromUser(message, ME)).toBe(true);
    expect(commentMessageIsFromUser({ ...message, authorName: "yamada@example.com" }, ME)).toBe(true);
    expect(commentMessageIsFromUser({ ...message, authorName: undefined }, ME)).toBe(false);
    expect(commentMessageIsFromUser({ ...message, authorName: "他の人" }, ME)).toBe(false);
    expect(commentMessageIsFromUser({ ...message, agent: { vendor: "openai" } }, ME)).toBe(false);
  });
});
