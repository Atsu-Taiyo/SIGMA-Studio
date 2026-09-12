import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";

const DEFAULT_TEX_TRANSLATE = createCurrentLocaleTranslator("tex");

function buildExampleTexPreamble(comment: string): string {
  return String.raw`% ${comment}
\newcommand{\answerbox}[1]{
  \doubleboxed{\mathstrut\quad\raisebox{-0.04em}{$#1$}\quad}
}
\newcommand{\thickanswerbox}[1]{
  \thickboxed{\mathstrut\quad\raisebox{-0.04em}{$#1$}\quad}
}
\newcommand{\outerthickanswerbox}[1]{
  \outerthickdoubleboxed{\mathstrut\quad\raisebox{-0.04em}{$#1$}\quad}
}`;
}

export function resolveExampleTexPreamble(
  t: Translate<"tex"> = DEFAULT_TEX_TRANSLATE,
): string {
  return buildExampleTexPreamble(t("examples.preambleComment"));
}

/** Japanese-default compatibility value for existing documents and non-UI callers. */
export const EXAMPLE_TEX_PREAMBLE = resolveExampleTexPreamble();

export interface TexEnvironmentPreviewExample {
  id: string;
  label: string;
  tex: string;
}

const TEX_ENVIRONMENT_PREVIEW_EXAMPLE_DESCRIPTORS = [
  { id: "single", tex: String.raw`\answerbox{\text{ア}}` },
  { id: "multiple", tex: String.raw`\answerbox{\text{イウ}}` },
  { id: "fraction", tex: String.raw`\frac{\answerbox{\text{エオ}}}{\answerbox{\text{カ}}}` },
  { id: "decimal", tex: String.raw`\answerbox{\text{キ}}.\answerbox{\text{クケ}}` },
  { id: "radical", tex: String.raw`\sqrt{\answerbox{\text{コ}}}` },
  { id: "repeated", tex: String.raw`\answerbox{\text{サシ}},\ \answerbox{\text{ス}}` },
  { id: "formula", tex: String.raw`\answerbox{\displaystyle\sum_{i=1}^{n}i}` },
] as const;

export function resolveTexEnvironmentPreviewExamples(
  t: Translate<"tex"> = DEFAULT_TEX_TRANSLATE,
): readonly TexEnvironmentPreviewExample[] {
  return TEX_ENVIRONMENT_PREVIEW_EXAMPLE_DESCRIPTORS.map((example) => ({
    ...example,
    label: t(`examples.${example.id}` as never),
  }));
}

/** Japanese-default compatibility snapshot. TeX contents stay invariant across UI locales. */
export const TEX_ENVIRONMENT_PREVIEW_EXAMPLES = resolveTexEnvironmentPreviewExamples();
