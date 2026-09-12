import { describe, expect, it, vi } from "vitest";

import type {
  InlineNode,
  SigmaCommentThread,
  SigmaDocument,
} from "../model";
import {
  appendCommentMessage,
  createCommentThread,
  removeCommentReplyMessage,
  removeCommentThread,
  setCommentThreadResolved,
  toggleCommentMessageReaction,
  updateCommentMessageBody,
  updateCommentThreadBody,
  type CommentIdPrefix,
  type CommentMutationPorts,
} from "./comment-operations";

const NOW = "2026-07-25T01:02:03.000Z";

describe("comment document operations", () => {
  it("creates a thread with deterministic ids and time while cloning its body", () => {
    const existing = commentThread("existing");
    const document = documentWithComments([existing]);
    const anchor = { type: "block" as const, blockId: "paragraph-1" };
    const body: InlineNode[] = [{
      type: "text",
      text: "確認してください",
      marks: ["bold"],
    }];
    const { ports, now, createId } = mutationPorts({
      comment_thread: ["comment_thread_created"],
      comment_msg: ["comment_msg_created"],
    });

    const result = createCommentThread(document, {
      anchor,
      authorName: "あなた",
      body,
      color: "#f2b705",
    }, ports);

    expect(result).toMatchObject({
      matched: true,
      threadId: "comment_thread_created",
      messageId: "comment_msg_created",
    });
    expect(result.document.updatedAt).toBe(NOW);
    expect(result.document.content).toBe(document.content);
    expect(result.document.comments?.[0]).toBe(existing);
    expect(result.document.comments?.[1]).toMatchObject({
      id: "comment_thread_created",
      anchor,
      color: "#f2b705",
      createdAt: NOW,
      updatedAt: NOW,
      messages: [{
        id: "comment_msg_created",
        authorName: "あなた",
        body: [{ type: "text", text: "確認してください", marks: ["bold"] }],
        createdAt: NOW,
      }],
    });
    expect(result.document.comments?.[1]?.anchor).toBe(anchor);
    expect(result.document.comments?.[1]?.messages[0]?.body).not.toBe(body);
    expect(result.document.comments?.[1]?.messages[0]?.body[0]).not.toBe(body[0]);
    expect(now).toHaveBeenCalledTimes(1);
    expect(createId.mock.calls).toEqual([
      ["comment_thread"],
      ["comment_msg"],
    ]);
  });

  it("appends human and AI replies through one operation, reopens the thread, and returns its anchor", () => {
    const target = {
      ...commentThread("target"),
      resolved: true,
    };
    const untouched = commentThread("untouched");
    const document = documentWithComments([target, untouched]);
    const body: InlineNode[] = [{ type: "text", text: "@codex 確認して" }];
    const { ports } = mutationPorts({
      comment_msg: ["comment_msg_reply"],
    });

    const result = appendCommentMessage(document, {
      threadId: "target",
      authorName: "あなた",
      body,
    }, ports);

    expect(result.matched).toBe(true);
    expect(result.messageId).toBe("comment_msg_reply");
    expect(result.anchor).toBe(target.anchor);
    expect(result.document.comments?.[0]).toMatchObject({
      id: "target",
      resolved: false,
      updatedAt: NOW,
      messages: [
        { id: "target-first" },
        {
          id: "comment_msg_reply",
          authorName: "あなた",
          body: [{ type: "text", text: "@codex 確認して" }],
          createdAt: NOW,
        },
      ],
    });
    expect(result.document.comments?.[0]?.messages[0]).toBe(target.messages[0]);
    expect(result.document.comments?.[0]?.messages[1]?.body).not.toBe(body);
    expect(result.document.comments?.[1]).toBe(untouched);
  });

  it("edits the first thread message and a specific reply without replacing untouched references", () => {
    const target = {
      ...commentThread("target"),
      messages: [
        commentThread("target").messages[0],
        {
          id: "target-reply",
          authorName: "AI",
          body: [{ type: "text" as const, text: "old reply" }],
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    };
    const untouched = commentThread("untouched");
    const document = documentWithComments([target, untouched]);
    const firstBody: InlineNode[] = [{ type: "text", text: "new first" }];

    const firstResult = updateCommentThreadBody(document, {
      threadId: "target",
      body: firstBody,
    }, mutationPorts().ports);

    expect(firstResult.matched).toBe(true);
    expect(firstResult.document.comments?.[0]?.messages[0]).toMatchObject({
      id: "target-first",
      body: [{ type: "text", text: "new first" }],
      updatedAt: NOW,
    });
    expect(firstResult.document.comments?.[0]?.messages[0]?.body).not.toBe(firstBody);
    expect(firstResult.document.comments?.[0]?.messages[1]).toBe(target.messages[1]);
    expect(firstResult.document.comments?.[1]).toBe(untouched);

    const replyBody: InlineNode[] = [{ type: "text", text: "new reply" }];
    const replyResult = updateCommentMessageBody(firstResult.document, {
      threadId: "target",
      messageId: "target-reply",
      body: replyBody,
    }, mutationPorts().ports);

    expect(replyResult.matched).toBe(true);
    expect(replyResult.document.comments?.[0]?.messages[0]).toBe(
      firstResult.document.comments?.[0]?.messages[0],
    );
    expect(replyResult.document.comments?.[0]?.messages[1]).toMatchObject({
      id: "target-reply",
      body: [{ type: "text", text: "new reply" }],
      updatedAt: NOW,
    });
    expect(replyResult.document.comments?.[0]?.messages[1]?.body).not.toBe(replyBody);
  });

  it("adds and removes message reactions and migrates a legacy first-message reaction on toggle", () => {
    const document = documentWithComments([commentThread("target")]);
    const addPorts = mutationPorts({
      comment_reaction: ["comment_reaction_added"],
    });

    const added = toggleCommentMessageReaction(document, {
      threadId: "target",
      messageId: "target-first",
      emoji: "👍",
      authorName: "あなた",
    }, addPorts.ports);

    expect(added.matched).toBe(true);
    expect(added.document.comments?.[0]?.messages[0]?.reactions).toEqual([{
      id: "comment_reaction_added",
      emoji: "👍",
      authorName: "あなた",
      createdAt: NOW,
    }]);
    expect(addPorts.createId).toHaveBeenCalledTimes(1);

    const removePorts = mutationPorts();
    const removed = toggleCommentMessageReaction(added.document, {
      threadId: "target",
      messageId: "target-first",
      emoji: "👍",
      authorName: "あなた",
    }, removePorts.ports);

    expect(removed.document.comments?.[0]?.messages[0]?.reactions).toEqual([]);
    expect(removePorts.createId).not.toHaveBeenCalled();

    const legacyReaction = {
      id: "legacy-reaction",
      emoji: "❤️",
      authorName: "あなた",
      createdAt: "2026-07-23T00:00:00.000Z",
    };
    const legacyDocument = documentWithComments([{
      ...commentThread("legacy"),
      reactions: [legacyReaction],
    }]);
    const legacyPorts = mutationPorts();
    const migrated = toggleCommentMessageReaction(legacyDocument, {
      threadId: "legacy",
      messageId: "legacy-first",
      emoji: "❤️",
      authorName: "あなた",
    }, legacyPorts.ports);

    expect(migrated.matched).toBe(true);
    expect(migrated.document.comments?.[0]?.reactions).toEqual([]);
    expect(migrated.document.comments?.[0]?.messages[0]?.reactions).toEqual([]);
    expect(legacyPorts.createId).not.toHaveBeenCalled();
  });

  it("removes replies and threads while protecting the first message", () => {
    const target = {
      ...commentThread("target"),
      messages: [
        commentThread("target").messages[0],
        {
          id: "target-reply",
          body: [{ type: "text" as const, text: "reply" }],
          createdAt: "2026-07-24T00:00:00.000Z",
        },
      ],
    };
    const untouched = commentThread("untouched");
    const document = documentWithComments([target, untouched]);

    const protectedResult = removeCommentReplyMessage(document, {
      threadId: "target",
      messageId: "target-first",
    }, mutationPorts().ports);

    expect(protectedResult.matched).toBe(false);
    expect(protectedResult.document.comments?.[0]?.messages).toHaveLength(2);
    expect(protectedResult.document.updatedAt).toBe(NOW);

    const replyResult = removeCommentReplyMessage(document, {
      threadId: "target",
      messageId: "target-reply",
    }, mutationPorts().ports);

    expect(replyResult.matched).toBe(true);
    expect(replyResult.document.comments?.[0]?.messages.map(({ id }) => id)).toEqual([
      "target-first",
    ]);
    expect(replyResult.document.comments?.[1]).toBe(untouched);

    const threadResult = removeCommentThread(replyResult.document, {
      threadId: "target",
    }, mutationPorts().ports);

    expect(threadResult.matched).toBe(true);
    expect(threadResult.document.comments).toEqual([untouched]);
  });

  it("keeps timestamp and id side effects compatible when targets are missing", () => {
    const document = documentWithComments(undefined);
    const shared = mutationPorts({
      comment_msg: ["comment_msg_reserved"],
    });
    const results = [
      appendCommentMessage(document, {
        threadId: "missing",
        authorName: "あなた",
        body: [{ type: "text", text: "reply" }],
      }, shared.ports),
      setCommentThreadResolved(document, {
        threadId: "missing",
        resolved: true,
      }, shared.ports),
      updateCommentThreadBody(document, {
        threadId: "missing",
        body: [{ type: "text", text: "edited" }],
      }, shared.ports),
      updateCommentMessageBody(document, {
        threadId: "missing",
        messageId: "missing-message",
        body: [{ type: "text", text: "edited" }],
      }, shared.ports),
      toggleCommentMessageReaction(document, {
        threadId: "missing",
        messageId: "missing-message",
        emoji: "👍",
        authorName: "あなた",
      }, shared.ports),
      removeCommentThread(document, {
        threadId: "missing",
      }, shared.ports),
      removeCommentReplyMessage(document, {
        threadId: "missing",
        messageId: "missing-message",
      }, shared.ports),
    ];

    for (const result of results) {
      expect(result.matched).toBe(false);
      expect(result.document).not.toBe(document);
      expect(result.document.comments).toEqual([]);
      expect(result.document.updatedAt).toBe(NOW);
      expect(result.document.content).toBe(document.content);
    }
    expect(results[0]).toMatchObject({
      messageId: "comment_msg_reserved",
      anchor: null,
    });
    expect(shared.now).toHaveBeenCalledTimes(results.length);
    expect(shared.createId.mock.calls).toEqual([["comment_msg"]]);
  });

  it("retains message references even when a thread-level match has no matching message", () => {
    const target = commentThread("target");
    const untouched = commentThread("untouched");
    const document = documentWithComments([target, untouched]);

    const result = updateCommentMessageBody(document, {
      threadId: "target",
      messageId: "missing-message",
      body: [{ type: "text", text: "unused" }],
    }, mutationPorts().ports);

    expect(result.matched).toBe(false);
    expect(result.document).not.toBe(document);
    expect(result.document.comments).not.toBe(document.comments);
    expect(result.document.comments?.[0]).not.toBe(target);
    expect(result.document.comments?.[0]?.messages).not.toBe(target.messages);
    expect(result.document.comments?.[0]?.messages[0]).toBe(target.messages[0]);
    expect(result.document.comments?.[1]).toBe(untouched);
    expect(result.document.content).toBe(document.content);
  });
});

function documentWithComments(
  comments: SigmaCommentThread[] | undefined,
): SigmaDocument {
  return {
    version: "2.0",
    docId: "comment-operations-test",
    metadata: { title: "コメント操作" },
    content: [{
      id: "paragraph-1",
      type: "paragraph",
      children: [{ type: "text", text: "本文" }],
    }],
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
    comments,
  };
}

function commentThread(id: string): SigmaCommentThread {
  return {
    id,
    anchor: {
      type: "block",
      blockId: "paragraph-1",
      quote: "本文",
    },
    messages: [{
      id: `${id}-first`,
      authorName: "あなた",
      body: [{ type: "text", text: "original" }],
      createdAt: "2026-07-24T00:00:00.000Z",
    }],
    createdAt: "2026-07-24T00:00:00.000Z",
    updatedAt: "2026-07-24T00:00:00.000Z",
  };
}

function mutationPorts(
  ids: Partial<Record<CommentIdPrefix, string[]>> = {},
): {
  ports: CommentMutationPorts;
  now: ReturnType<typeof vi.fn<() => string>>;
  createId: ReturnType<typeof vi.fn<(prefix: CommentIdPrefix) => string>>;
} {
  const now = vi.fn<() => string>(() => NOW);
  const createId = vi.fn<(prefix: CommentIdPrefix) => string>((prefix) => (
    ids[prefix]?.shift() ?? `${prefix}_generated`
  ));
  return {
    ports: { now, createId },
    now,
    createId,
  };
}
