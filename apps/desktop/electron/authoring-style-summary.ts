import { changedTexFeatures } from "./authoring-style-tex";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import { AUTHORING_STYLE_NOTE_LIMIT } from "@/lib/ai/authoring-style";
import type { StyleExample } from "./authoring-style-store";

// Invalidate automatic summaries from earlier extraction rules, preserving edited notes.
export const AUTHORING_STYLE_SUMMARY_VERSION = "tex-notation-v1";

/** Evidence-based language, never a mathematical correction promoted to a rule. */
export function summarizeAuthoringStyle(examples: readonly StyleExample[], locale: AppLocale = "ja"): string {
  if (!examples.length) return "";
  const t = createTranslator(locale, "prompt");
  const lines = [t("authoringStyle.summary.title"), "", t("authoringStyle.summary.policy")];
  const features = new Map<string, Set<string>>();
  const observe = (label: string, example: StyleExample) => {
    const sources = features.get(label) ?? new Set<string>();
    sources.add(`${example.fileId}:${example.blockId}`);
    features.set(label, sources);
  };
  const texFeatures = new Map<string, Set<string>>();
  for (const example of examples) {
    for (const [category, values] of changedTexFeatures(example)) {
      for (const value of values) {
        const label = `${category}:${value}`;
        const sources = texFeatures.get(label) ?? new Set<string>();
        sources.add(`${example.fileId}:${example.blockId}`);
        texFeatures.set(label, sources);
      }
    }
    const after = example.after;
    if (!after) continue;
    // Only changed features count. Unchanged AI text in an edited paragraph is not evidence.
    for (const [pattern, label] of [
      [/求めよ[。.!！]?$/u, "ending"],
      [/示せ[。.!！]?$/u, "proof"],
      [/(?:です|ます|ください)[。.!！]?$/u, "polite"],
      [/(?:である|となる|とする)[。.!！]?$/u, "plain"],
      [/(?:よって|したがって|従って)/u, "conclusion"],
      [/(?:なぜなら|理由|ため|注意)/u, "reason"],
      [/\n/u, "breaks"],
    ] as const) {
      if (pattern.test(after.text) && !pattern.test(example.before?.text ?? "")) observe(t(`authoringStyle.summary.${label}`), example);
    }
    if (after.area === "solution" && example.before?.area !== "solution") observe(t("authoringStyle.summary.solution"), example);
    if (after.area === "hints" && example.before?.area !== "hints") observe(t("authoringStyle.summary.hints"), example);
    if (after.format.includes('"bold"') && !example.before?.format.includes('"bold"')) observe(t("authoringStyle.summary.bold"), example);
    if (after.area === "structure" && after.format !== example.before?.format) observe(t("authoringStyle.summary.structure"), example);
  }
  for (const [label, sources] of features) if (sources.size >= 2) lines.push(`- ${label}${t("authoringStyle.summary.sources", { count: sources.size })}`);
  if (lines.length === 3) lines.push(t("authoringStyle.summary.sparse"));
  lines.push("", t("authoringStyle.summary.texTitle"));
  const categoryKeys = {
    fraction: "authoringStyle.summary.tex.fraction",
    display: "authoringStyle.summary.tex.display",
    brackets: "authoringStyle.summary.tex.brackets",
    multiply: "authoringStyle.summary.tex.multiply",
    spacing: "authoringStyle.summary.tex.spacing",
    alignment: "authoringStyle.summary.tex.alignment",
    vector: "authoringStyle.summary.tex.vector",
    differential: "authoringStyle.summary.tex.differential",
    units: "authoringStyle.summary.tex.units",
    punctuation: "authoringStyle.summary.tex.punctuation",
  } as const;
  const valueKeys = {
    display: "authoringStyle.summary.texValues.display",
    inline: "authoringStyle.summary.texValues.inline",
    scalable: "authoringStyle.summary.texValues.scalable",
    fixed: "authoringStyle.summary.texValues.fixed",
    none: "authoringStyle.summary.texValues.none",
    upright: "authoringStyle.summary.texValues.upright",
    plain: "authoringStyle.summary.texValues.plain",
    inside: "authoringStyle.summary.texValues.inside",
    outside: "authoringStyle.summary.texValues.outside",
  } as const;
  let texCount = 0;
  for (const [label, sources] of texFeatures) {
    if (sources.size < 2) continue;
    const separator = label.indexOf(":");
    const category = label.slice(0, separator);
    const value = label.slice(separator + 1);
    const localized = Object.hasOwn(valueKeys, value)
      ? t(valueKeys[value as keyof typeof valueKeys]) : `\`${value}\``;
    const line = `- ${t(categoryKeys[category as keyof typeof categoryKeys], { value: localized })}${t("authoringStyle.summary.sources", { count: sources.size })}`;
    if ([...lines, line].join("\n").length + 1 > AUTHORING_STYLE_NOTE_LIMIT) continue;
    lines.push(line);
    texCount++;
  }
  if (!texCount) lines.push(t("authoringStyle.summary.texSparse"));
  return `${lines.join("\n")}\n`;
}
