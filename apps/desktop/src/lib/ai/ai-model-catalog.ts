import {
  CLAUDE_AI_EDIT_MODELS,
  claudeModelLabel,
  GEMINI_AI_EDIT_MODELS,
  geminiModelLabel,
  type AiProvider,
} from "@/lib/ai/ai-providers";
import {
  AI_EDIT_MODELS,
  AI_EDIT_REASONING_EFFORTS,
  type AiEditReasoningEffort,
} from "@/lib/ai/sigma-doc-edit-schema";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { DesktopAiModelCatalog, DesktopAiModelOption } from "@/types/desktop";

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 辞書を持っている推論強度。**プロバイダが将来増やした値は id のまま出す**ので、
 * 「知っている id か」をここで持つ (未知の id で生キーを出さないため)。
 */
export const REASONING_EFFORT_IDS = [
  "none", "minimal", "low", "medium", "high", "xhigh", "max",
] as const;

const REASONING_EFFORT_ID_SET: ReadonlySet<string> = new Set(REASONING_EFFORT_IDS);

/** Never renders a blank effort label; unknown runtime values remain identifiable by id. */
export function formatReasoningEffortLabel(
  value: unknown,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) {
    return t("model.effortUnset");
  }
  return REASONING_EFFORT_ID_SET.has(id)
    ? (t(`model.effort.${id}` as never) as unknown as string)
    : id;
}

export function getFallbackAiModelOptions(provider: AiProvider): DesktopAiModelOption[] {
  if (provider === "claude") {
    return CLAUDE_AI_EDIT_MODELS.map((id, index) => ({
      id,
      label: claudeModelLabel(id),
      ...(index === 0 ? { isDefault: true } : {}),
      defaultReasoningEffort: "low",
      supportedReasoningEfforts: AI_EDIT_REASONING_EFFORTS.map((effort) => ({ id: effort })),
    }));
  }
  if (provider === "antigravity") {
    return GEMINI_AI_EDIT_MODELS.map((id, index) => ({
      id,
      label: geminiModelLabel(id),
      ...(index === 0 ? { isDefault: true } : {}),
    }));
  }
  return AI_EDIT_MODELS.map((id, index) => ({
    id,
    label: id,
    ...(index === AI_EDIT_MODELS.length - 1 ? { isDefault: true } : {}),
    defaultReasoningEffort: "xhigh",
    supportedReasoningEfforts: AI_EDIT_REASONING_EFFORTS.map((effort) => ({ id: effort })),
  }));
}

export function resolveAiModelOptions(
  provider: AiProvider,
  catalog: DesktopAiModelCatalog | null | undefined,
): DesktopAiModelOption[] {
  const runtimeModels = (catalog?.models ?? []).flatMap((option): DesktopAiModelOption[] => {
    const id = option.id?.trim();
    if (!id) return [];
    return [{
      ...option,
      id,
      label: option.label?.trim() || id,
      supportedReasoningEfforts: option.supportedReasoningEfforts
        ?.flatMap((effort) => effort.id?.trim() ? [{ ...effort, id: effort.id.trim() }] : []),
    }];
  });
  if (runtimeModels.length === 0) return getFallbackAiModelOptions(provider);
  // CLI help lists example aliases, not an exhaustive catalog. Older CLI
  // versions can still select Fable by its full model id.
  if (provider === "claude" && !runtimeModels.some((model) => /^(?:claude-)?fable(?:-|$)/.test(model.id))) {
    const fable = getFallbackAiModelOptions(provider).find((model) => model.id === "claude-fable-5-1");
    if (fable) runtimeModels.push(fable);
  }
  return runtimeModels;
}

export function getModelReasoningEfforts(
  models: DesktopAiModelOption[],
  selectedModel: string,
): string[] {
  const selected = models.find((option) => option.id === selectedModel);
  if (selected?.supportedReasoningEfforts !== undefined) {
    return [...new Set(selected.supportedReasoningEfforts.map((option) => option.id).filter(Boolean))];
  }
  return [...AI_EDIT_REASONING_EFFORTS];
}

export function getProviderReasoningEfforts(
  provider: AiProvider,
  models: DesktopAiModelOption[],
  selectedModel: string,
): string[] {
  return provider === "antigravity" ? [] : getModelReasoningEfforts(models, selectedModel);
}

export function resolveCatalogSelection(input: {
  models: DesktopAiModelOption[];
  model: string;
  reasoningEffort: AiEditReasoningEffort;
}): { model: string; reasoningEffort: AiEditReasoningEffort } {
  const model = input.models.some((option) => option.id === input.model)
    ? input.model
    : input.models.find((option) => option.isDefault)?.id ?? input.models[0]?.id ?? input.model;
  const efforts = getModelReasoningEfforts(input.models, model);
  if (efforts.includes(input.reasoningEffort)) {
    return { model, reasoningEffort: input.reasoningEffort };
  }
  const defaultEffort = input.models.find((option) => option.id === model)?.defaultReasoningEffort;
  return {
    model,
    reasoningEffort: efforts.includes(defaultEffort ?? "")
      ? defaultEffort as AiEditReasoningEffort
      : (efforts[0] ?? input.reasoningEffort) as AiEditReasoningEffort,
  };
}

export function cycleReasoningEffort(
  efforts: readonly string[],
  current: AiEditReasoningEffort,
  direction: -1 | 1,
): AiEditReasoningEffort {
  if (efforts.length === 0) {
    return current;
  }
  const currentIndex = efforts.indexOf(current);
  const startIndex = currentIndex >= 0 ? currentIndex : 0;
  return efforts[(startIndex + direction + efforts.length) % efforts.length] as AiEditReasoningEffort;
}
