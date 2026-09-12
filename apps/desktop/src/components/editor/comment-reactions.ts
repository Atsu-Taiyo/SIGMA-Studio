import { createTranslator, DEFAULT_LOCALE, type AppLocale, type Translate } from "@/lib/i18n";

/** カタログの 1 件。**データは emoji と id だけ**で、文言は `editor` 辞書が持つ。 */
export interface CommentReactionDefinition {
  emoji: string;
  id: string;
}

/** 表示用に文言を解決したリアクション。UI と検索だけが受け取る。 */
export interface CommentReactionEmoji extends CommentReactionDefinition {
  label: string;
  /** 検索専用の語 (表示しない)。空白区切り。 */
  keywords: string;
}

export interface CommentReactionUsage {
  counts: Record<string, number>;
  recent: string[];
}

export const COMMENT_REACTION_USAGE_STORAGE_KEY = "sigma-studio.commentReactionUsage.v1";

export const DEFAULT_COMMENT_REACTION_EMOJIS = ["👍", "✅", "👀", "💡", "❤️", "🎉"];

export const COMMENT_REACTION_EMOJI_CATALOG: readonly CommentReactionDefinition[] = [
  { emoji: "👍", id: "like" },
  { emoji: "✅", id: "done" },
  { emoji: "👀", id: "looking" },
  { emoji: "💡", id: "idea" },
  { emoji: "❤️", id: "love" },
  { emoji: "🎉", id: "celebrate" },
  { emoji: "🙌", id: "helpful" },
  { emoji: "👏", id: "clap" },
  { emoji: "🙏", id: "please" },
  { emoji: "👌", id: "ok" },
  { emoji: "🤔", id: "thinking" },
  { emoji: "❓", id: "question" },
  { emoji: "❗", id: "attention" },
  { emoji: "⚠️", id: "warning" },
  { emoji: "🔥", id: "hot" },
  { emoji: "🚀", id: "ship" },
  { emoji: "✨", id: "polish" },
  { emoji: "📝", id: "memo" },
  { emoji: "✏️", id: "edit" },
  { emoji: "🔍", id: "investigate" },
  { emoji: "📌", id: "pin" },
  { emoji: "📎", id: "related" },
  { emoji: "📚", id: "material" },
  { emoji: "🧠", id: "insight" },
  { emoji: "🧪", id: "verify" },
  { emoji: "🛠️", id: "fix" },
  { emoji: "📐", id: "design" },
  { emoji: "➕", id: "add" },
  { emoji: "➖", id: "remove" },
  { emoji: "🔁", id: "recheck" },
  { emoji: "⏳", id: "waiting" },
  { emoji: "❌", id: "reject" },
  { emoji: "⭐", id: "star" },
  { emoji: "💬", id: "comment" },
  { emoji: "📣", id: "announce" },
  { emoji: "🔒", id: "lock" },
  { emoji: "🔓", id: "unlock" },
  { emoji: "📈", id: "trendUp" },
  { emoji: "📉", id: "trendDown" },
  { emoji: "🙂", id: "acknowledge" },
  { emoji: "😄", id: "nice" },
  { emoji: "😅", id: "careful" },
  { emoji: "😮", id: "surprised" },
  { emoji: "😢", id: "trouble" },
  { emoji: "💪", id: "effort" },
  { emoji: "🤝", id: "agree" },
  { emoji: "🙇", id: "gratitude" },
  { emoji: "💯", id: "perfect" },
  { emoji: "🏁", id: "goal" },
  { emoji: "🧩", id: "piece" },
  { emoji: "🧭", id: "direction" },
  { emoji: "🗂️", id: "organize" },
  { emoji: "📦", id: "deliverable" },
  { emoji: "🧾", id: "checklist" },
  { emoji: "📊", id: "chart" },
  { emoji: "🧮", id: "calculate" },
  { emoji: "📘", id: "explain" },
  { emoji: "🧑‍🏫", id: "teach" },
];

const EMPTY_USAGE: CommentReactionUsage = {
  counts: {},
  recent: [],
};

export function parseCommentReactionUsage(value: string | null): CommentReactionUsage {
  if (!value) {
    return EMPTY_USAGE;
  }

  try {
    return normalizeCommentReactionUsage(JSON.parse(value));
  } catch {
    return EMPTY_USAGE;
  }
}

export function normalizeCommentReactionUsage(value: unknown): CommentReactionUsage {
  if (!value || typeof value !== "object") {
    return EMPTY_USAGE;
  }

  const candidate = value as Partial<CommentReactionUsage>;
  const counts: Record<string, number> = {};
  if (candidate.counts && typeof candidate.counts === "object") {
    for (const [emoji, count] of Object.entries(candidate.counts)) {
      if (typeof emoji === "string" && typeof count === "number" && Number.isFinite(count) && count > 0) {
        counts[emoji] = Math.floor(count);
      }
    }
  }

  const recent = Array.isArray(candidate.recent)
    ? uniqueEmojis(candidate.recent.filter((emoji): emoji is string => typeof emoji === "string" && emoji.trim().length > 0))
    : [];

  return { counts, recent };
}

export function recordCommentReactionUsage(
  usage: CommentReactionUsage,
  emoji: string,
  recentLimit = 12,
): CommentReactionUsage {
  const trimmed = emoji.trim();
  if (!trimmed) {
    return usage;
  }

  return {
    counts: {
      ...usage.counts,
      [trimmed]: (usage.counts[trimmed] ?? 0) + 1,
    },
    recent: [trimmed, ...usage.recent.filter((item) => item !== trimmed)].slice(0, recentLimit),
  };
}

export function getQuickCommentReactionEmojis(usage: CommentReactionUsage, limit = 3): string[] {
  return uniqueEmojis([
    ...usage.recent,
    ...getFrequentCommentReactionEmojis(usage, 8),
    ...DEFAULT_COMMENT_REACTION_EMOJIS,
  ]).slice(0, limit);
}

export function getFrequentCommentReactionEmojis(usage: CommentReactionUsage, limit = 8): string[] {
  return Object.entries(usage.counts)
    .filter(([, count]) => count > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([emoji]) => emoji)
    .slice(0, limit);
}

/** 辞書から文言を解決したカタログ。表示も検索もこれを見る。 */
export function resolveCommentReactionEmojis(
  t: Translate<"editor">,
  catalog: readonly CommentReactionDefinition[] = COMMENT_REACTION_EMOJI_CATALOG,
): CommentReactionEmoji[] {
  return uniqueCatalogEmojis(catalog).map((item) => ({
    ...item,
    label: t(`reaction.label.${item.id}` as never) as string,
    keywords: t(`reaction.keywords.${item.id}` as never, { defaultValue: "" }) as string,
  }));
}

/**
 * 絵文字ピッカーの検索。**表示中の UI 言語で引ける**ことが要件なので、
 * 語彙は辞書側 (`reaction.keywords.*`) が言語ごとに独自に持つ — 英語側は
 * 日本語の訳語ではなく、英語話者が実際に打つ語を並べてある。
 *
 * `locale` の既定が日本語なのは、既存の呼び出しとテストを無傷にするため。
 */
export function searchCommentReactionEmojis(
  query: string,
  options: { locale?: AppLocale; limit?: number } = {},
): CommentReactionEmoji[] {
  const locale = options.locale ?? DEFAULT_LOCALE;
  const limit = options.limit ?? 72;
  const catalog = resolveCommentReactionEmojis(createTranslator(locale, "editor"));
  const normalizedQuery = normalizeSearchText(query, locale);
  if (!normalizedQuery) {
    return catalog.slice(0, limit);
  }

  return catalog
    .filter((item) => normalizeSearchText(
      [item.emoji, item.label, item.keywords].join(" "),
      locale,
    ).includes(normalizedQuery))
    .slice(0, limit);
}

function uniqueCatalogEmojis(
  items: readonly CommentReactionDefinition[],
): CommentReactionDefinition[] {
  const seen = new Set<string>();
  const result: CommentReactionDefinition[] = [];
  for (const item of items) {
    if (seen.has(item.emoji)) {
      continue;
    }
    seen.add(item.emoji);
    result.push(item);
  }
  return result;
}

function uniqueEmojis(items: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    if (seen.has(item)) {
      continue;
    }
    seen.add(item);
    result.push(item);
  }
  return result;
}

/**
 * 検索用の正規化。畳み方は言語で違う (トルコ語の `I` など) ので、
 * `"ja-JP"` 決め打ちではなく**表示中のロケール**で小文字化する。
 */
function normalizeSearchText(value: string, locale: AppLocale): string {
  return value.trim().toLocaleLowerCase(locale);
}
