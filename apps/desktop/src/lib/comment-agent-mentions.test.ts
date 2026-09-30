import { describe, expect, it } from "vitest";

import { detectCommentAiMention } from "@/lib/ai/comment-mention";
import { COMMENT_AI_MENTION_AGENTS, splitCommentAiMentions } from "@/lib/comment-agent-mentions";

describe("splitCommentAiMentions", () => {
  it("AIメンションだけをチップ用に切り出し、前後の文はそのまま残す", () => {
    expect(splitCommentAiMentions("これを @claude お願い。")).toEqual([
      { text: "これを " },
      { text: "@claude", agent: { name: "Claude", vendor: "anthropic" } },
      { text: " お願い。" },
    ]);
  });

  it("別名は代表のAIに寄せ、メールアドレスや語の途中は対象にしない", () => {
    expect(splitCommentAiMentions("@ai と @agy")).toMatchObject([
      { text: "@ai", agent: { name: "ChatGPT" } },
      { text: " と " },
      { text: "@agy", agent: { name: "Antigravity" } },
    ]);
    expect(splitCommentAiMentions("me@claude.com @claudette")).toEqual([{ text: "me@claude.com @claudette" }]);
  });

  it("AIを起動する検出と同じ文字列をメンションとみなす", () => {
    for (const { keyword } of COMMENT_AI_MENTION_AGENTS) {
      const text = `確認して @${keyword} ください`;
      expect(detectCommentAiMention([{ type: "text", text }]) !== null).toBe(splitCommentAiMentions(text).some((part) => part.agent));
    }
    for (const text of ["a@claude.com", "@claudette", "x@codex"]) {
      expect(detectCommentAiMention([{ type: "text", text }]) !== null).toBe(splitCommentAiMentions(text).some((part) => part.agent));
    }
  });
});
