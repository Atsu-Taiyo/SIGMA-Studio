import type { SigmaCommentAgentVendor } from "@/features/document";

/**
 * コメント本文の AI メンション (@claude など) を、表示のために見つける純粋関数。
 * AI を実際に起動する判定は `lib/ai/comment-mention.ts` の `detectCommentAiMention` で、
 * ここの検出条件はそれと揃える (テストで突き合わせている)。
 */

/** 入力メニューに出す AI と、チップに出すアイコンの提供元。`ai` / `agy` は別名なので載せない。 */
export const COMMENT_AI_MENTION_AGENTS: readonly { keyword: string; name: string; vendor: SigmaCommentAgentVendor }[] = [
  { keyword: "claude", name: "Claude", vendor: "anthropic" },
  { keyword: "codex", name: "Codex", vendor: "openai" },
  { keyword: "chatgpt", name: "ChatGPT", vendor: "openai" },
  { keyword: "antigravity", name: "Antigravity", vendor: "google" },
];

const AI_MENTION_ALIASES: Record<string, string> = { ai: "chatgpt", agy: "antigravity" };

// 直前が行頭か空白、直後が語末であること (メールアドレスは対象外)。直前の空白は消費しない。
const MENTION_TOKEN_PATTERN = /(?<![^\s])@(codex|chatgpt|ai|claude|antigravity|agy)(?![\p{L}\p{N}_])/giu;

export interface CommentTextPart {
  text: string;
  /** AI メンションのときだけ入る。チップの表示名とアイコンの提供元。 */
  agent?: { name: string; vendor: SigmaCommentAgentVendor };
}

/** テキストを AI メンションとそれ以外に分ける。 */
export function splitCommentAiMentions(text: string): CommentTextPart[] {
  const parts: CommentTextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(MENTION_TOKEN_PATTERN)) {
    const keyword = match[1].toLowerCase();
    const agent = COMMENT_AI_MENTION_AGENTS.find((candidate) => candidate.keyword === (AI_MENTION_ALIASES[keyword] ?? keyword));
    if (!agent) continue;
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    parts.push({ text: match[0], agent: { name: agent.name, vendor: agent.vendor } });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}
