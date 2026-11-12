import { createTranslator } from "@/lib/i18n";
import type { StyleExample } from "./authoring-style-store";

/** Evidence-based language, never a mathematical correction promoted to a rule. */
export function summarizeAuthoringStyle(examples: readonly StyleExample[]): string {
  if (!examples.length) return "";
  const t = createTranslator("ja", "prompt");
  const lines = [t("authoringStyle.summary.title"), "", t("authoringStyle.summary.policy")];
  const features = new Map<string, Set<string>>();
  const observe = (label: string, example: StyleExample) => {
    const sources = features.get(label) ?? new Set<string>();
    sources.add(`${example.fileId}:${example.blockId}`);
    features.set(label, sources);
  };
  for (const example of examples) {
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
  return `${lines.join("\n")}\n`;
}
