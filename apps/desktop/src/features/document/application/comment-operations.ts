import type {
  InlineNode,
  SigmaCommentAgent,
  SigmaCommentAnchor,
  SigmaDocument,
} from "../model";

export type CommentIdPrefix =
  | "comment_thread"
  | "comment_msg"
  | "comment_reaction";

export interface CommentMutationPorts {
  now(): string;
  createId(prefix: CommentIdPrefix): string;
}

export interface CommentMutationResult {
  document: SigmaDocument;
  matched: boolean;
}

export interface CreateCommentThreadInput {
  anchor: SigmaCommentAnchor;
  authorName: string;
  /** AI が書いた場合だけ渡す。人が書いたコメントには付けない。 */
  agent?: SigmaCommentAgent;
  body: readonly InlineNode[];
  color: string;
}

export interface CreateCommentThreadResult extends CommentMutationResult {
  matched: true;
  threadId: string;
  messageId: string;
}

export interface AppendCommentMessageInput {
  threadId: string;
  authorName: string;
  /** AI が書いた場合だけ渡す。人が書いた返信には付けない。 */
  agent?: SigmaCommentAgent;
  body: readonly InlineNode[];
}

export interface AppendCommentMessageResult extends CommentMutationResult {
  messageId: string;
  anchor: SigmaCommentAnchor | null;
}

export interface SetCommentThreadResolvedInput {
  threadId: string;
  resolved: boolean;
}

export interface UpdateCommentThreadBodyInput {
  threadId: string;
  body: readonly InlineNode[];
}

export interface UpdateCommentMessageBodyInput {
  threadId: string;
  messageId: string;
  body: readonly InlineNode[];
}

export interface ToggleCommentMessageReactionInput {
  threadId: string;
  messageId: string;
  emoji: string;
  authorName: string;
}

export interface RemoveCommentThreadInput {
  threadId: string;
}

export interface RemoveCommentReplyMessageInput {
  threadId: string;
  messageId: string;
}

export function createCommentThread(
  document: SigmaDocument,
  input: CreateCommentThreadInput,
  ports: CommentMutationPorts,
): CreateCommentThreadResult {
  const now = ports.now();
  const threadId = ports.createId("comment_thread");
  const messageId = ports.createId("comment_msg");
  const body = cloneInlineBody(input.body);

  return {
    document: withComments(document, [
      ...(document.comments ?? []),
      {
        id: threadId,
        anchor: input.anchor,
        messages: [{
          id: messageId,
          authorName: input.authorName,
          ...(input.agent ? { agent: input.agent } : {}),
          body,
          createdAt: now,
        }],
        color: input.color,
        createdAt: now,
        updatedAt: now,
      },
    ], now),
    matched: true,
    threadId,
    messageId,
  };
}

export function appendCommentMessage(
  document: SigmaDocument,
  input: AppendCommentMessageInput,
  ports: CommentMutationPorts,
): AppendCommentMessageResult {
  const now = ports.now();
  // Reserve the id before looking up the target. AI placeholder callers must
  // receive a stable id even if the thread disappeared immediately beforehand.
  const messageId = ports.createId("comment_msg");
  const body = cloneInlineBody(input.body);
  let matched = false;
  let anchor: SigmaCommentAnchor | null = null;

  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    if (!matched) {
      anchor = thread.anchor;
    }
    matched = true;
    return {
      ...thread,
      resolved: false,
      messages: [
        ...thread.messages,
        {
          id: messageId,
          authorName: input.authorName,
          ...(input.agent ? { agent: input.agent } : {}),
          body,
          createdAt: now,
        },
      ],
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
    messageId,
    anchor,
  };
}

export function setCommentThreadResolved(
  document: SigmaDocument,
  input: SetCommentThreadResolvedInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  let matched = false;
  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    matched = true;
    return {
      ...thread,
      resolved: input.resolved,
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

export function updateCommentThreadBody(
  document: SigmaDocument,
  input: UpdateCommentThreadBodyInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  const body = cloneInlineBody(input.body);
  let matched = false;
  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    matched = true;
    return {
      ...thread,
      messages: thread.messages.map((message, index) => index === 0
        ? {
            ...message,
            body,
            updatedAt: now,
          }
        : message),
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

export function updateCommentMessageBody(
  document: SigmaDocument,
  input: UpdateCommentMessageBodyInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  const body = cloneInlineBody(input.body);
  let matched = false;
  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    return {
      ...thread,
      messages: thread.messages.map((message) => {
        if (message.id !== input.messageId) {
          return message;
        }

        matched = true;
        return {
          ...message,
          body,
          updatedAt: now,
        };
      }),
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

export function toggleCommentMessageReaction(
  document: SigmaDocument,
  input: ToggleCommentMessageReactionInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  let matched = false;
  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    const firstMessageId = thread.messages[0]?.id;
    const threadReactions = thread.reactions ?? [];
    const threadReactionIndex = firstMessageId === input.messageId
      ? findReactionIndex(threadReactions, input.emoji, input.authorName)
      : -1;
    const messages = thread.messages.map((message) => {
      if (message.id !== input.messageId) {
        return message;
      }

      matched = true;
      const reactions = message.reactions ?? [];
      const existingIndex = findReactionIndex(
        reactions,
        input.emoji,
        input.authorName,
      );
      const nextReactions = existingIndex >= 0
        ? reactions.filter((_, index) => index !== existingIndex)
        : threadReactionIndex >= 0
          ? reactions
          : [
              ...reactions,
              {
                id: ports.createId("comment_reaction"),
                emoji: input.emoji,
                authorName: input.authorName,
                createdAt: now,
              },
            ];

      return {
        ...message,
        reactions: nextReactions,
        updatedAt: now,
      };
    });

    return {
      ...thread,
      messages,
      reactions: threadReactionIndex >= 0
        ? threadReactions.filter((_, index) => index !== threadReactionIndex)
        : threadReactions,
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

export function removeCommentThread(
  document: SigmaDocument,
  input: RemoveCommentThreadInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  let matched = false;
  const comments = (document.comments ?? []).filter((thread) => {
    if (thread.id !== input.threadId) {
      return true;
    }

    matched = true;
    return false;
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

export function removeCommentReplyMessage(
  document: SigmaDocument,
  input: RemoveCommentReplyMessageInput,
  ports: CommentMutationPorts,
): CommentMutationResult {
  const now = ports.now();
  let matched = false;
  const comments = (document.comments ?? []).map((thread) => {
    if (thread.id !== input.threadId) {
      return thread;
    }

    return {
      ...thread,
      messages: thread.messages.filter((message, index) => {
        const shouldRemove = index !== 0 && message.id === input.messageId;
        if (shouldRemove) {
          matched = true;
        }
        return !shouldRemove;
      }),
      updatedAt: now,
    };
  });

  return {
    document: withComments(document, comments, now),
    matched,
  };
}

function cloneInlineBody(body: readonly InlineNode[]): InlineNode[] {
  return body.map((node) => ({ ...node }));
}

function findReactionIndex(
  reactions: readonly { emoji: string; authorName?: string }[],
  emoji: string,
  authorName: string,
): number {
  return reactions.findIndex((reaction) => (
    reaction.emoji === emoji && (reaction.authorName || "") === authorName
  ));
}

function withComments(
  document: SigmaDocument,
  comments: NonNullable<SigmaDocument["comments"]>,
  updatedAt: string,
): SigmaDocument {
  return {
    ...document,
    comments,
    updatedAt,
  };
}
