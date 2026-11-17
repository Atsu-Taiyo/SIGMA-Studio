import { createHash } from "node:crypto";

import { createTranslator, type AppLocale } from "@/lib/i18n";
import { isSuspicious } from "./authoring-style-scan";

export type SummarySection = "style" | "procedure" | "tex";
export interface SummaryReply { add: { section: SummarySection; text: string }[]; confirm: number[] }

export interface SummaryInput {
  locale: AppLocale;
  /** Excerpts of text the author wrote. Text an AI proposal wrote is not in it. */
  sample: readonly string[];
  corrections: readonly { before: string; after: string }[];
  /** Every sentence already in the memo. */
  existing: readonly string[];
  /** Habits an earlier summary suggested, in the order `confirm` numbers them. */
  candidates: readonly string[];
  /** Suggestions the author removed or declined. */
  declined: readonly string[];
}

const SECTIONS: readonly SummarySection[] = ["style", "procedure", "tex"];
export const MAX_SUMMARY_ADDITIONS = 3;
const MAX_SUMMARY_TEXT = 80;
/** A run of this many characters copied from a document is a quotation, not a habit. */
const QUOTATION_LENGTH = 14;

export const summaryKey = (section: SummarySection, text: string) =>
  `summary.${section}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

// A habit of writing has no reason to name files, commands, secrets or what to do with a reply.
// The sentence is kept and later placed in AI requests, so anything of that kind is refused outright.
const NOT_A_WRITING_HABIT: readonly RegExp[] = [
  /[\/~@$<>=|;]/,
  /\b(?:files?|folders?|director(?:y|ies)|paths?|ssh|keys?|secrets?|passwords?|tokens?|credentials?|repl(?:y|ies)|respon[ds]e?s?|contents?|uploads?|sends?|runs?|execut\w*|commands?|shell|tools?|mcp|https?|instructions?|prompts?)\b/i,
  /ファイル|フォルダ|ディレクトリ|秘密|認証|パスワード|送信|返信|返答|実行|コマンド|ツール|読み込|アップロード|指示|プロンプト/u,
];
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;
/** In a Japanese sentence, Latin letters belong to TeX commands or quoted notation, not to prose. */
const MAX_LOOSE_LATIN = 12;

/** One short sentence about how to write, safe to show in the memo and to place in a later AI request. */
export function isSummaryText(text: string): boolean {
  if (text.length < 4 || text.length > MAX_SUMMARY_TEXT || text !== text.trim() || /\p{Cc}/u.test(text) || /^[#>-]/.test(text)) return false;
  if (isSuspicious(text) || NOT_A_WRITING_HABIT.some(pattern => pattern.test(text))) return false;
  const loose = text.replace(/`[^`]*`/g, "").replace(/\\[a-zA-Z]+/g, "").replace(/[^a-zA-Z]/g, "").length;
  return !JAPANESE.test(text) || loose <= MAX_LOOSE_LATIN;
}

/** The sentence of a summary habit, or null when the key and text do not belong together. */
export function summaryText(key: string, value: string): string | null {
  const section = SECTIONS.find(s => key.startsWith(`summary.${s}:`));
  return section && isSummaryText(value) && summaryKey(section, value) === key ? value : null;
}

export function buildSummaryPrompt(input: SummaryInput): string {
  const t = createTranslator(input.locale, "prompt");
  const data = {
    sample: input.sample, corrections: input.corrections, existing: input.existing,
    candidates: input.candidates.map((text, index) => ({ number: index + 1, text })), declined: input.declined,
  };
  return `${t("authoringStyle.summary.instructions", { count: MAX_SUMMARY_ADDITIONS, length: 60 })}\n${JSON.stringify(data)}`;
}

/**
 * Read the model's reply as data. Anything that is not a short habit sentence,
 * or that repeats a passage of the documents, is dropped rather than repaired.
 */
export function parseSummaryReply(raw: string, input: Pick<SummaryInput, "sample" | "candidates" | "locale">): SummaryReply | null {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let data: { add?: unknown; confirm?: unknown };
  try { data = JSON.parse(raw.slice(start, end + 1)); } catch { return null; }
  if (!data || typeof data !== "object") return null;
  const source = input.sample.join("\n");
  const quotes = (text: string) => {
    for (let index = 0; index + QUOTATION_LENGTH <= text.length; index++) if (source.includes(text.slice(index, index + QUOTATION_LENGTH))) return true;
    return false;
  };
  const add: SummaryReply["add"] = [];
  for (const entry of Array.isArray(data.add) ? data.add : []) {
    const { section, text } = (entry ?? {}) as { section?: unknown; text?: unknown };
    if (typeof text !== "string" || !SECTIONS.includes(section as SummarySection)) continue;
    const sentence = text.trim();
    // A memo kept in Japanese takes Japanese sentences: an English one is not how this author writes.
    if (!isSummaryText(sentence) || (input.locale === "ja" && !JAPANESE.test(sentence)) || quotes(sentence) || add.some(a => a.text === sentence)) continue;
    add.push({ section: section as SummarySection, text: sentence });
    if (add.length === MAX_SUMMARY_ADDITIONS) break;
  }
  const confirm = [...new Set((Array.isArray(data.confirm) ? data.confirm : [])
    .filter((n): n is number => Number.isSafeInteger(n) && n >= 1 && n <= input.candidates.length))];
  return { add, confirm };
}
