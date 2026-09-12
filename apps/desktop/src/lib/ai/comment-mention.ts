// コメント本文に含まれる AI メンション (@codex / @chatgpt / @ai / @claude / @antigravity / @agy) を検出し、
// AI 実行用の指示文へ変換するピュア関数群。EditorShell から分離してテスト可能にする。

import { inlineNodesToCommentText } from "@/lib/comments";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { InlineNode } from "@/features/document";

export interface CommentMentionMatch {
  provider: AiProvider;
  /** スレッドへ投稿する AI 返信の差出人表示名。 */
  authorName: "ChatGPT" | "Claude" | "Antigravity";
  /** 実際に打たれたトークン (例: "@claude")。指示文から除去するために使う。 */
  token: string;
}

// @codex / @chatgpt / @ai → ChatGPT (Codex)、@claude → Claude、
// @antigravity / @agy → Antigravity。
// 直前が行頭か空白、直後が語末・空白・区切り文字であることを要求し、メールアドレス等の誤検出を避ける。
const MENTION_PATTERN = /(?:^|\s)@(codex|chatgpt|ai|claude|antigravity|agy)(?![\p{L}\p{N}_])/iu;

/**
 * コメント本文 (InlineNode[]) の最初の AI メンションを検出する。なければ null。
 */
export function detectCommentAiMention(body: readonly InlineNode[]): CommentMentionMatch | null {
  const text = inlineNodesToCommentText(body);
  const match = MENTION_PATTERN.exec(text);
  if (!match) {
    return null;
  }

  const keyword = match[1].toLowerCase();
  const token = `@${keyword}`;
  if (keyword === "claude") {
    return { provider: "claude", authorName: "Claude", token };
  }
  if (keyword === "antigravity" || keyword === "agy") {
    return { provider: "antigravity", authorName: "Antigravity", token };
  }
  return { provider: "chatgpt", authorName: "ChatGPT", token };
}

/**
 * メンショントークンを取り除いたプレーン指示文を組み立てる。
 * コメント本文が実質空 (メンションのみ) の場合は対象箇所に基づく既定指示へフォールバックする。
 */
export function buildCommentInstruction(
  body: readonly InlineNode[],
  match: CommentMentionMatch,
  contextQuote: string,
): string {
  const raw = inlineNodesToCommentText(body);
  // 検出したトークンを語境界つきで除去 (大文字小文字無視)。
  const stripped = raw
    .replace(new RegExp(`@${match.token.slice(1)}(?![\\p{L}\\p{N}_])`, "giu"), "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const quote = contextQuote.trim();
  const instruction = stripped.length > 0
    ? stripped
    : "コメントが指している箇所を、文脈に沿って適切に修正・補足してください。";

  if (quote.length > 0) {
    return `対象箇所: ${quote}\n\n指示: ${instruction}`;
  }
  return instruction;
}
