import { createHash } from "node:crypto";

import { createTranslator, type AppLocale } from "@/lib/i18n";
import { isSuspicious } from "./authoring-style-scan";

export type SummarySection = "style" | "procedure" | "structure" | "tex";
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
  /** Per document, the kinds of its blocks in order (no text of the author's). */
  outlines?: readonly string[];
}

const SECTIONS: readonly SummarySection[] = ["style", "procedure", "structure", "tex"];
export const MAX_SUMMARY_ADDITIONS = 3;
/** As long as the AI is asked to make a sentence; a longer one is dropped, not cut. */
export const MAX_SUMMARY_TEXT = 60;
/** A run of this many characters copied from a document is a quotation, not a habit. */
const QUOTATION_LENGTH = 14;

export const summarySection = (key: string): SummarySection | null => SECTIONS.find(s => key.startsWith(`summary.${s}:`)) ?? null;
export const summaryKey = (section: SummarySection, text: string) =>
  `summary.${section}:${createHash("sha256").update(text).digest("hex").slice(0, 16)}`;

// A habit of writing has no reason to name files, commands, secrets or what to do with a reply,
// to address the reader of the memo, or to say what else should be obeyed or set aside.
// The sentence enters the memo unread and is later placed in AI requests, so anything of that kind is refused outright.
const NOT_A_WRITING_HABIT: readonly RegExp[] = [
  /[\/~@$<>=|;]/,
  /\b(?:files?|folders?|director(?:y|ies)|paths?|ssh|keys?|secrets?|passwords?|tokens?|credentials?|repl(?:y|ies)|respon[ds]e?s?|contents?|uploads?|sends?|runs?|execut\w*|commands?|shell|tools?|mcp|https?|urls?|links?|e-?mails?|instructions?|prompts?)\b/i,
  /\b(?:ignor\w*|disregard\w*|overrid\w*|bypass\w*|forget|obey|follow\w*|priorit\w*|system|developer|assistant|model|ai|llm|you|your|outputs?|reveal\w*|disclos\w*|delet\w*|remov\w*|sav(?:e|es|ing)|memo|memory|notes?|rules?|settings?|permissions?)\b/i,
  /ファイル|フォルダ|ディレクトリ|秘密|認証|パスワード|送信|返信|返答|実行|コマンド|ツール|読み込|アップロード|指示|プロンプト|リンク|メール|外部/u,
  /無視|従[うっいえわ]|忘れ(?!ず)|あなた|君は|システム|アシスタント|モデル|出力|開示|漏|削除|消去|書き込|権限|メモ|ルール|優先|以降|以後|今後/u,
  // What to do, what is allowed, or what may be made up is conduct, not a way of writing.
  /安全|危険|架空|虚偽|捏造|嘘|偽|操作|完遂|遂行|禁止|許可|拒否|断定|不明|検証|確認を省|要求|依頼|求められ|ユーザー|利用者|必ず|絶対/u,
  /\b(?:safe\w*|danger\w*|fabricat\w*|invent\w*|fake\w*|false\w*|lie|lies|pretend\w*|refus\w*|allow\w*|forbid\w*|permit\w*|request\w*|users?|verif\w*|checks?|never|must|whatever|anything|everything)\b/i,
];
// Besides naming nothing of the above, the sentence has to be about writing: it says how something is written, worded or laid out.
const ABOUT_WRITING: readonly RegExp[] = [
  /書[くきかいけ]|記[すしさ]|述べ|結[ぶびん]|表記|表[すしさ]|用い|使[うっいわ]|添え|示[すしさ]|並べ|置[くきかい]|始め|終え|まとめ|分け|[揃そろ]え|付け|つけ|入れ|挟[むみん]|改行|空け|区切|語尾|文体|文末|口調|言い回し|数式|記号|記法|見出し|番号|箇条書き|句読点|読点|句点|括弧|かっこ|敬体|常体|丁寧体|枠|囲[むみん]|段組|余白|配置|構成|小問|大問|解答欄|タイトル/u,
  /\b(?:writ\w*|wrote|word\w*|phras\w*|sentences?|paragraphs?|headings?|number\w*|label\w*|notation|symbols?|punctuat\w*|commas?|tone|style|format\w*|layout|spac\w*|indent\w*|abbreviat\w*|capitali\w*|states?|stating|begins?|starts?|ends?|uses?|using|puts?|places?|lists?|box\w*|fram\w*|columns?|titles?|subtitles?|margins?|blank|order\w*|arrang\w*)\b/i,
];
/** One sentence: once quoted wording is set aside, nothing may follow the first full stop. */
const QUOTED = /「[^「」]*」|『[^『』]*』|"[^"]*"|“[^“”]*”/gu;
const SECOND_SENTENCE = /[。．.!?！？]./u;
const JAPANESE = /[\u3040-\u30ff\u4e00-\u9fff]/u;
/** In a Japanese sentence, Latin letters belong to TeX commands or quoted notation, not to prose. */
const MAX_LOOSE_LATIN = 12;

/** One short sentence about how to write, safe to show in the memo and to place in a later AI request. */
export function isSummaryText(text: string): boolean {
  if (text.length < 4 || text.length > MAX_SUMMARY_TEXT || text !== text.trim() || /\p{Cc}/u.test(text) || /^[#>-]/.test(text)) return false;
  // Full-width and other compatibility forms are read as the plain characters they stand for.
  const plain = text.normalize("NFKC");
  // Quoted wording is an example of the habit; what the sentence itself says is what is left without it.
  const statement = plain.replace(QUOTED, "");
  if (isSuspicious(text) || isSuspicious(plain) || SECOND_SENTENCE.test(statement) || NOT_A_WRITING_HABIT.some(pattern => pattern.test(plain))) return false;
  if (!ABOUT_WRITING.some(pattern => pattern.test(statement))) return false;
  const loose = text.replace(/`[^`]*`/g, "").replace(/\\[a-zA-Z]+/g, "").replace(/[^a-zA-Z]/g, "").length;
  return !JAPANESE.test(text) || loose <= MAX_LOOSE_LATIN;
}

/** The sentence of a summary habit, or null when the key and text do not belong together. */
export function summaryText(key: string, value: string): string | null {
  const section = summarySection(key);
  return section && isSummaryText(value) && summaryKey(section, value) === key ? value : null;
}

export function buildSummaryPrompt(input: SummaryInput): string {
  const t = createTranslator(input.locale, "prompt");
  const data = {
    sample: input.sample, corrections: input.corrections, existing: input.existing,
    candidates: input.candidates.map((text, index) => ({ number: index + 1, text })), declined: input.declined, outlines: input.outlines ?? [],
  };
  return `${t("authoringStyle.summary.instructions", { count: MAX_SUMMARY_ADDITIONS, length: MAX_SUMMARY_TEXT })}\n${JSON.stringify(data)}`;
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
  // Only a reply of the form asked for says anything. An error message, or an answer to some other question, is
  // not "nothing to add and nothing confirmed": taken as that, it would count against the earlier suggestions.
  if (!data || typeof data !== "object" || !Array.isArray(data.add) || !Array.isArray(data.confirm)) return null;
  // The same goes for numbers that are not numbers: read leniently, a suggestion the AI did speak for would look
  // like one it passed over.
  if (!data.confirm.every(value => Number.isSafeInteger(value))) return null;
  const source = input.sample.join("\n");
  const quotes = (text: string) => {
    for (let index = 0; index + QUOTATION_LENGTH <= text.length; index++) if (source.includes(text.slice(index, index + QUOTATION_LENGTH))) return true;
    return false;
  };
  // A memo kept in Japanese takes Japanese sentences: an English one is not how this author writes.
  const acceptable = (sentence: string) => isSummaryText(sentence) && !(input.locale === "ja" && !JAPANESE.test(sentence)) && !quotes(sentence);
  const add: SummaryReply["add"] = [];
  for (const entry of Array.isArray(data.add) ? data.add : []) {
    const { section, text } = (entry ?? {}) as { section?: unknown; text?: unknown };
    if (typeof text !== "string" || !SECTIONS.includes(section as SummarySection)) continue;
    const sentence = text.trim();
    if (!acceptable(sentence) || add.some(a => a.text === sentence)) continue;
    add.push({ section: section as SummarySection, text: sentence });
    if (add.length === MAX_SUMMARY_ADDITIONS) break;
  }
  const confirm = [...new Set(data.confirm.filter((n): n is number => Number.isSafeInteger(n) && n >= 1 && n <= input.candidates.length))];
  return { add, confirm };
}
