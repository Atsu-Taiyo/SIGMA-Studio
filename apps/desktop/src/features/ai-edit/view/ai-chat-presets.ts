"use client";
import { ChartLine, FilePlus2, ImagePlus, PenLine, Shapes, SpellCheck, Table2, TrendingUp } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { imageToSigmaDocDefaultInstruction } from "@/lib/ai/ai-edit-runtime";
import { type Translate } from "@/lib/i18n";

export const AI_ACTION_PRESET_IDS = [
  "createProblem",
  "addAnswer",
  "table",
  "variationTable",
  "graph",
  "figure",
  "proofread",
  "imageToMaterial",
] as const;

type AiActionPresetId = (typeof AI_ACTION_PRESET_IDS)[number];

/** クイック操作の先頭に置く線画アイコン。ラベルだけだと並びが単調になるので、種類を一目で分ける。 */
export const AI_ACTION_PRESET_ICONS: Record<AiActionPresetId, LucideIcon> = {
  createProblem: FilePlus2,
  addAnswer: PenLine,
  table: Table2,
  variationTable: TrendingUp,
  graph: ChartLine,
  figure: Shapes,
  proofread: SpellCheck,
  imageToMaterial: ImagePlus,
};

export function buildAiActionPresets(t: Translate<"ai">): Array<{ id: AiActionPresetId; label: string; prompt: string }> {
  return AI_ACTION_PRESET_IDS.map((id) => ({
    id,
    label: t(`quickAction.label.${id}` as never) as unknown as string,
    // 画像からの教材化だけは、他所と同じ既定指示を使う (辞書には持たない)。
    prompt: id === "imageToMaterial"
      ? imageToSigmaDocDefaultInstruction()
      : (t(`prompt.quickAction.${id as Exclude<AiActionPresetId, "imageToMaterial">}`) as unknown as string),
  }));
}
