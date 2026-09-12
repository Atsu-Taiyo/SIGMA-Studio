import { describe, expect, it } from "vitest";

import { buildCommentInstruction, detectCommentAiMention } from "@/lib/ai/comment-mention";
import type { InlineNode } from "@/types/sigma-doc";

function text(value: string): InlineNode[] {
  return [{ type: "text", text: value }];
}

describe("detectCommentAiMention", () => {
  it("maps @codex / @chatgpt / @ai to the chatgpt provider", () => {
    for (const token of ["@codex", "@chatgpt", "@ai"]) {
      const match = detectCommentAiMention(text(`この式を直して ${token}`));
      expect(match).toEqual({ provider: "chatgpt", authorName: "ChatGPT", token });
    }
  });

  it("maps @claude to the claude provider", () => {
    const match = detectCommentAiMention(text("@claude ここを整理して"));
    expect(match).toEqual({ provider: "claude", authorName: "Claude", token: "@claude" });
  });

  it("maps @antigravity / @agy to the Antigravity route", () => {
    expect(detectCommentAiMention(text("@antigravity ここを整理して"))).toEqual({
      provider: "antigravity",
      authorName: "Antigravity",
      token: "@antigravity",
    });
    expect(detectCommentAiMention(text("@agy ここを整理して"))).toEqual({
      provider: "antigravity",
      authorName: "Antigravity",
      token: "@agy",
    });
  });

  it("does not treat @gemini as a supported mention", () => {
    expect(detectCommentAiMention(text("@gemini ここを整理して"))).toBeNull();
  });

  it("is case insensitive", () => {
    expect(detectCommentAiMention(text("@Claude"))?.provider).toBe("claude");
    expect(detectCommentAiMention(text("@CODEX"))?.provider).toBe("chatgpt");
    expect(detectCommentAiMention(text("@Antigravity"))?.provider).toBe("antigravity");
  });

  it("returns null when there is no mention", () => {
    expect(detectCommentAiMention(text("ここを直してほしい"))).toBeNull();
  });

  it("does not match when the keyword is part of a larger word", () => {
    expect(detectCommentAiMention(text("@codexample"))).toBeNull();
    expect(detectCommentAiMention(text("mail@claude.example"))).toBeNull();
  });

  it("returns the first mention when multiple are present", () => {
    expect(detectCommentAiMention(text("@claude @codex"))?.provider).toBe("claude");
  });
});

describe("buildCommentInstruction", () => {
  const claude = { provider: "claude", authorName: "Claude", token: "@claude" } as const;

  it("strips the mention token and prepends the anchor quote", () => {
    const result = buildCommentInstruction(text("@claude この式を整理して"), claude, "x^2 + 1");
    expect(result).toContain("対象箇所: x^2 + 1");
    expect(result).toContain("この式を整理して");
    expect(result).not.toContain("@claude");
  });

  it("falls back to a default instruction when only the mention is present", () => {
    const result = buildCommentInstruction(text("@claude"), claude, "x^2");
    expect(result).toContain("対象箇所: x^2");
    expect(result).toContain("文脈に沿って");
  });

  it("omits the 対象箇所 line when there is no quote", () => {
    const result = buildCommentInstruction(text("@claude ここを直して"), claude, "");
    expect(result).toBe("ここを直して");
  });
});
