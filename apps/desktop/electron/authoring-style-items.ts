import type { AuthoringStyleSection } from "@/lib/ai/authoring-style";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import { summaryText } from "./authoring-style-summary";

type Loose = (key: string, options?: Record<string, unknown>) => string;
const translator = (locale: AppLocale) => createTranslator(locale, "prompt") as unknown as Loose;

const TEX_CATEGORIES = new Set(["fraction", "display", "brackets", "multiply", "spacing", "alignment", "vector", "differential", "units", "punctuation", "inequality"]);
const TEX_VALUE_LABELS = new Set(["display", "inline", "scalable", "fixed", "none", "upright", "plain", "inside", "outside"]);
// Command names and delimiters only: a value is never free text from a document.
const TEX_TOKEN = String.raw`(?:\\[a-zA-Z]{1,20}\*?(?:\{[a-z]{1,10}\*?\})?|\\[,;:!]|[×·d])`;
const SAFE_TEX_VALUE = new RegExp(`^${TEX_TOKEN}(?: / ${TEX_TOKEN}){0,5}$`);
const ENUMERATED: Record<string, readonly string[]> = {
  "tone.explanation": ["polite", "plain"],
  "ending.question": ["imperative", "nasai", "kudasai"],
  "connective.conclusion": ["yotte", "shitagatte", "yueni", "ijou-yori"],
  "punctuation.style": ["、。", "，．", "，。", "、．"],
  "numbering.subquestion": ["(1)", "（1）", "①", "[1]"],
  "procedure.solution": ["filled"],
  "procedure.hints": ["filled"],
};

export function sectionOf(key: string): AuthoringStyleSection {
  if (key.startsWith("summary.")) return key.startsWith("summary.tex:") ? "tex" : key.startsWith("summary.procedure:") ? "procedure" : "style";
  return key.startsWith("tex.") ? "tex" : key.startsWith("procedure.") || key.startsWith("numbering.") ? "procedure" : "style";
}

/**
 * The sentence shown for a learned habit. Habits counted on this device are
 * built only from fixed templates and whitelisted values, so document text
 * cannot reach the memo through an observation. A habit the AI summary
 * suggested is its own validated sentence. Returns null for anything else.
 */
export function itemText(key: string, value: string, locale: AppLocale): string | null {
  if (key.startsWith("summary.")) return summaryText(key, value);
  const t = translator(locale);
  if (key.startsWith("tex.")) {
    const category = key.slice(4);
    if (!TEX_CATEGORIES.has(category)) return null;
    if (TEX_VALUE_LABELS.has(value)) return t(`authoringStyle.memo.tex.${category}`, { value: t(`authoringStyle.memo.texValues.${value}`) });
    return SAFE_TEX_VALUE.test(value) ? t(`authoringStyle.memo.tex.${category}`, { value: `\`${value}\``, interpolation: { escapeValue: false } }) : null;
  }
  if (!ENUMERATED[key]?.includes(value)) return null;
  switch (key) {
    case "tone.explanation": return t(`authoringStyle.memo.item.tone.${value}`);
    case "ending.question": return t(`authoringStyle.memo.item.question.${value}`);
    case "connective.conclusion": return t("authoringStyle.memo.item.connective", { value: t(`authoringStyle.memo.connectives.${value}`) });
    case "punctuation.style": return t("authoringStyle.memo.item.punctuation", { value });
    case "numbering.subquestion": return t("authoringStyle.memo.item.numbering", { value });
    case "procedure.solution": return t("authoringStyle.memo.item.solution");
    case "procedure.hints": return t("authoringStyle.memo.item.hints");
    default: return null;
  }
}

export const SECTION_ORDER: readonly AuthoringStyleSection[] = ["style", "procedure", "tex", "custom"];

export function memoLabels(locale: AppLocale) {
  const t = translator(locale);
  return {
    title: t("authoringStyle.memo.title"),
    policy: t("authoringStyle.memo.policy"),
    sections: Object.fromEntries(SECTION_ORDER.map(section => [section, t(`authoringStyle.memo.sections.${section}`)])) as Record<AuthoringStyleSection, string>,
  };
}
