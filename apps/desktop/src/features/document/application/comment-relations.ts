import type { SigmaCommentMessage, SigmaCommentThread } from "../model/comments";
import { inlineNodesToPlainText } from "../model/rich-text";

/**
 * 「自分」を指すための情報。コメントのメンションは `mentionUserId` で宛先を持つが、投稿者は
 * `authorName` (書いた時点の表示名 / メールアドレス / ID) しか持たない。そのため投稿者の判定は、
 * 自分のプロフィールが取りうる名前のどれかと一致するかで行う (コメントパネルが自分の
 * リアクションを見分けるのと同じ規則)。
 */
export interface CommentUserIdentity {
  userId: string;
  authorNames: readonly string[];
}

/** 自分に関係するコメントスレッドの、一覧表示用の射影。 */
export interface UserCommentThread {
  threadId: string;
  resolved: boolean;
  /** 自分宛てのメンションを含む。 */
  mentioned: boolean;
  /** 自分が書いたメッセージ (最初のコメントも返信も) を含む。 */
  authored: boolean;
  /** 一覧に見せるメッセージ。メンションされていれば最後にメンションしたもの、そうでなければスレッドの最新。 */
  messageId: string;
  authorName?: string;
  /** 見せるメッセージを自分が書いた。 */
  ownMessage: boolean;
  /** そのメッセージ本文のプレーンテキスト。 */
  excerpt: string;
  messageCount: number;
  /** スレッド内で最後にメッセージが付いた時刻。 */
  activityAt: string;
  /** コメントの対象箇所の引用。対象が場所を持たない (文書全体など) ときは空。 */
  quote: string;
}

export function commentMessageMentionsUser(message: SigmaCommentMessage, userId: string): boolean {
  return message.body.some((node) => node.type === "text" && node.mentionUserId === userId);
}

/** AI の返信は、表示名がたまたま自分と同じでも自分の投稿として扱わない。 */
export function commentMessageIsFromUser(message: SigmaCommentMessage, identity: CommentUserIdentity): boolean {
  return !message.agent && Boolean(message.authorName) && identity.authorNames.includes(message.authorName!);
}

/**
 * 自分に関係するスレッドを集める: 自分宛てのメンションを含むもの、または自分が書いたメッセージを含むもの。
 * 解決済みのスレッドも返す (未解決だけに絞るかは呼び出し側が決める)。メンションの宛先は、
 * ホワイトボードの `@件数` バッジと同じく `mentionUserId` だけで判定する。
 */
export function collectUserCommentThreads(
  comments: readonly SigmaCommentThread[] | undefined,
  identity: CommentUserIdentity,
): UserCommentThread[] {
  if (!comments || !identity.userId) return [];
  const result: UserCommentThread[] = [];
  for (const thread of comments) {
    const lastMention = findLast(thread.messages, (message) => commentMessageMentionsUser(message, identity.userId));
    const authored = thread.messages.some((message) => commentMessageIsFromUser(message, identity));
    if (!lastMention && !authored) continue;
    const shown = lastMention ?? thread.messages[thread.messages.length - 1];
    result.push({
      threadId: thread.id,
      resolved: thread.resolved === true,
      mentioned: Boolean(lastMention),
      authored,
      messageId: shown.id,
      ...(shown.authorName ? { authorName: shown.authorName } : {}),
      ownMessage: commentMessageIsFromUser(shown, identity),
      excerpt: inlineNodesToPlainText(shown.body).trim(),
      messageCount: thread.messages.length,
      activityAt: latestTimestamp(thread.messages),
      quote: "quote" in thread.anchor && typeof thread.anchor.quote === "string" ? thread.anchor.quote.trim() : "",
    });
  }
  return result;
}

function findLast<T>(items: readonly T[], predicate: (item: T) => boolean): T | undefined {
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (predicate(items[index])) return items[index];
  }
  return undefined;
}

/** 追記順に並んでいる前提だが、順序が乱れていても最も新しい時刻を返す。 */
function latestTimestamp(messages: readonly SigmaCommentMessage[]): string {
  let latest = messages[0].createdAt;
  for (const message of messages) {
    if ((Date.parse(message.createdAt) || 0) > (Date.parse(latest) || 0)) latest = message.createdAt;
  }
  return latest;
}
