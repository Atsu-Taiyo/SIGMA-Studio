import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  type CommentReactionUsage,
  getFrequentCommentReactionEmojis,
  getQuickCommentReactionEmojis,
  parseCommentReactionUsage,
  recordCommentReactionUsage,
  resolveCommentReactionEmojis,
  searchCommentReactionEmojis,
} from "./comment-reactions";

describe("comment reaction helpers", () => {
  it("records recent reactions with the newest emoji first", () => {
    const usage = recordCommentReactionUsage(
      recordCommentReactionUsage({ counts: {}, recent: [] }, "👍"),
      "💡",
    );

    expect(usage.recent.slice(0, 2)).toEqual(["💡", "👍"]);
    expect(usage.counts).toMatchObject({ "👍": 1, "💡": 1 });
  });

  it("moves a reused emoji to the top and increments frequency", () => {
    const emptyUsage: CommentReactionUsage = { counts: {}, recent: [] };
    const usage = ["👍", "💡", "👍"].reduce(
      (current, emoji) => recordCommentReactionUsage(current, emoji),
      emptyUsage,
    );

    expect(usage.recent.slice(0, 2)).toEqual(["👍", "💡"]);
    expect(getFrequentCommentReactionEmojis(usage, 2)).toEqual(["👍", "💡"]);
  });

  it("builds quick reactions from recent, frequent, then defaults", () => {
    const usage = recordCommentReactionUsage({ counts: { "🎉": 4 }, recent: ["💡"] }, "👀");

    expect(getQuickCommentReactionEmojis(usage, 3)).toEqual(["👀", "💡", "🎉"]);
  });

  it("searches by Japanese labels and English keywords", () => {
    expect(searchCommentReactionEmojis("調査").map((item) => item.emoji)).toContain("🔍");
    expect(searchCommentReactionEmojis("math").map((item) => item.emoji)).toContain("🧮");
  });

  it("searches with the vocabulary of the current UI language", () => {
    // 英語は日本語の訳語ではなく**英語話者が打つ語**を辞書側に持たせてある。
    const en = (query: string) =>
      searchCommentReactionEmojis(query, { locale: "en" }).map((item) => item.emoji);
    expect(en("like")).toContain("👍");
    expect(en("thumbs up")).toContain("👍");
    expect(en("done")).toContain("✅");
    expect(en("investigate")).toContain("🔍");
    // 日本語側の語では英語 UI に出てこない (別語彙になっている証拠)。
    expect(en("調査")).toEqual([]);

    const ja = (query: string) =>
      searchCommentReactionEmojis(query, { locale: "ja" }).map((item) => item.emoji);
    expect(ja("いいね")).toContain("👍");
    expect(ja("調査")).toContain("🔍");
  });

  it("labels every catalog entry in both locales", () => {
    // **辞書オブジェクトではなく `t()` 越しに見る** — 「辞書に書いてある」ことと
    // 「引けること」は別 (WI-4 の前方一致潰れ)。
    for (const locale of ["ja", "en"] as const) {
      const resolved = resolveCommentReactionEmojis(createTranslator(locale, "editor"));
      expect(resolved.length).toBeGreaterThanOrEqual(50);
      const broken = resolved
        .filter((item) => !item.label || item.label === `reaction.label.${item.id}` || !item.keywords)
        .map((item) => item.id);
      expect(broken, `${locale} で解決できないリアクション`).toEqual([]);
    }
  });

  it("keeps the picker searchable without a query", () => {
    expect(searchCommentReactionEmojis("").length).toBeGreaterThan(10);
    expect(searchCommentReactionEmojis("", { limit: 4 })).toHaveLength(4);
  });

  it("parses invalid persisted usage as empty usage", () => {
    expect(parseCommentReactionUsage("{bad json")).toEqual({ counts: {}, recent: [] });
  });
});
