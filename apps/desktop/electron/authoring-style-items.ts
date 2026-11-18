import type { AuthoringStyleSection } from "@/lib/ai/authoring-style";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import { BOX_CATEGORIES, BOX_STYLE_IDS, LAYOUT_KINDS, MAX_SEQUENCE_KINDS, PROBLEM_FRAME_IDS } from "./authoring-style-layout";
import { summaryText } from "./authoring-style-summary";

type Loose = (key: string, options?: Record<string, unknown>) => string;
const translator = (locale: AppLocale) => createTranslator(locale, "prompt") as unknown as Loose;

const TEX_CATEGORIES = new Set(["fraction", "display", "brackets", "multiply", "spacing", "alignment", "vector", "differential", "units", "punctuation", "inequality",
  "ellipsis", "arrow", "implies", "iff", "approx", "overline", "numberSet", "therefore", "inlineSize"]);
/** Notations with no single command to name: each value has its own fixed sentence. */
const TEX_SENTENCES: Record<string, readonly string[]> = {
  derivative: ["leibniz", "operator", "prime"],
  combination: ["upright", "italic", "binom"],
  equationNumber: ["tag", "circled", "parenthesized"],
  longEquation: ["display", "inline"],
  integralSpacing: ["spaced"],
  brackets: ["sized"],
  setBuilder: ["mid", "bar", "colon"],
  interval: ["brackets", "reversed"],
  degree: ["circ", "symbol"],
};
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

/** Layout habits whose every value has a sentence of its own. */
const LAYOUT_SENTENCES: Record<string, readonly string[]> = {
  problemNumber: ["none", "fullwidth"],
  problemLead: ["filled", "hidden"],
  comment: ["boxAfter", "boxBefore", "none"],
  answerSpace: ["area", "after"],
  boxTitle: ["titled", "untitled"],
  boxSubtitle: ["filled"],
  headingNumber: ["chapter", "section", "sign", "nested", "dot", "paren", "bracket", "symbol"],
  headingAlign: ["center", "right"],
  docTitle: ["heading", "box"],
  subtitle: ["heading", "text"],
};
const PROBLEM_LABELS = ["daimon", "mon", "bracket", "square", "reidai", "renshu", "dot"];
const LIST_MARKERS = ["decimal", "paren", "parenLowerAlpha", "parenUpperAlpha", "parenLowerRoman", "parenUpperRoman"];
const PAGE_SIZE = /^(A4|A3|B5|B4)-(portrait|landscape)$/;

/** The order of blocks in words, or null when the value is not one `sequenceOf` makes. */
function sequenceText(value: string, t: Loose): string | null {
  const [, lead = "", repeated, rest] = value.match(/^((?:[a-z]+>){0,2})\(([a-z>]+)\)$|^([a-z>]+)$/) ?? [];
  const names = (part: string) => part.split(">").filter(Boolean);
  const kinds = [...names(lead), ...names(repeated ?? rest ?? "")];
  const whole = repeated ? `${lead}${repeated}` : rest;
  if (!whole || kinds.length < 2 || kinds.length > MAX_SEQUENCE_KINDS || whole !== kinds.join(">") || kinds.some(kind => !(LAYOUT_KINDS as readonly string[]).includes(kind))) return null;
  const words = (list: string[]) => list.map(kind => t(`authoringStyle.memo.layout.kinds.${kind}`)).join(" → ");
  const order = repeated ? [...(lead ? [words(names(lead))] : []), t("authoringStyle.memo.layout.sequenceRepeat", { value: words(names(repeated)) })].join(" → ") : words(kinds);
  return t("authoringStyle.memo.layout.sequence", { value: order, interpolation: { escapeValue: false } });
}

/** A habit of layout: fixed sentences, and ids and kinds from fixed lists. */
function layoutText(name: string, value: string, t: Loose): string | null {
  const plain = { interpolation: { escapeValue: false } };
  const code = `\`${value}\``;
  if (LAYOUT_SENTENCES[name]) return LAYOUT_SENTENCES[name].includes(value) ? t(`authoringStyle.memo.layout.${name}.${value}`) : null;
  if (name.startsWith("box.")) {
    const category = name.slice(4);
    return (BOX_CATEGORIES as readonly string[]).includes(category) && BOX_STYLE_IDS.includes(value)
      ? t("authoringStyle.memo.layout.boxFor", { category: t(`authoringStyle.memo.layout.categories.${category}`), value: code, ...plain }) : null;
  }
  switch (name) {
    case "problemLabel": return PROBLEM_LABELS.includes(value) ? t("authoringStyle.memo.layout.problemLabel", { value: t(`authoringStyle.memo.layout.problemLabels.${value}`), ...plain }) : null;
    case "problemFrame": return PROBLEM_FRAME_IDS.includes(value) ? t("authoringStyle.memo.layout.problemFrame", { value: code, ...plain }) : null;
    case "subquestionList": return LIST_MARKERS.includes(value) ? t("authoringStyle.memo.layout.subquestionList", { value: t(`authoringStyle.memo.layout.markers.${value}`), ...plain }) : null;
    case "boxStyle": return BOX_STYLE_IDS.includes(value) ? t("authoringStyle.memo.layout.boxStyle", { value: code, ...plain }) : null;
    case "headingDepth": return ["1", "2", "3"].includes(value) ? t("authoringStyle.memo.layout.headingDepth", { value }) : null;
    case "columns": return ["2", "3", "4"].includes(value) ? t("authoringStyle.memo.layout.columns", { value }) : null;
    case "pageSize": {
      const [, size, orientation] = value.match(PAGE_SIZE) ?? [];
      return size && value !== "A4-portrait" ? t("authoringStyle.memo.layout.pageSize", { size, orientation: t(`authoringStyle.memo.layout.orientations.${orientation}`) }) : null;
    }
    case "sequence": return sequenceText(value, t);
    default: return null;
  }
}

/** Where a habit stands in the memo. How a document is laid out has a part of its own. */
export function sectionOf(key: string): AuthoringStyleSection {
  if (key.startsWith("summary.")) return key.startsWith("summary.tex:") ? "tex" : key.startsWith("summary.procedure:") ? "procedure" : key.startsWith("summary.structure:") ? "structure" : "style";
  if (key.startsWith("layout.") || key.startsWith("numbering.") || key === "procedure.hints") return "structure";
  return key.startsWith("tex.") ? "tex" : key.startsWith("procedure.") ? "procedure" : "style";
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
    if (TEX_SENTENCES[category]?.includes(value)) return t(`authoringStyle.memo.texSentence.${category}.${value}`);
    if (!TEX_CATEGORIES.has(category)) return null;
    if (TEX_VALUE_LABELS.has(value)) return t(`authoringStyle.memo.tex.${category}`, { value: t(`authoringStyle.memo.texValues.${value}`) });
    return SAFE_TEX_VALUE.test(value) ? t(`authoringStyle.memo.tex.${category}`, { value: `\`${value}\``, interpolation: { escapeValue: false } }) : null;
  }
  if (key.startsWith("layout.")) return layoutText(key.slice(7), value, t);
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

export const SECTION_ORDER: readonly AuthoringStyleSection[] = ["style", "procedure", "structure", "tex", "custom"];

export function memoLabels(locale: AppLocale) {
  const t = translator(locale);
  return {
    title: t("authoringStyle.memo.title"),
    policy: t("authoringStyle.memo.policy"),
    sections: Object.fromEntries(SECTION_ORDER.map(section => [section, t(`authoringStyle.memo.sections.${section}`)])) as Record<AuthoringStyleSection, string>,
  };
}
