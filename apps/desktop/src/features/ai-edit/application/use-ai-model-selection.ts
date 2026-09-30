"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  formatReasoningEffortLabel,
  getProviderReasoningEfforts,
  resolveAiModelOptions,
  resolveCatalogSelection,
} from "@/lib/ai/ai-model-catalog";
import { getAiModelPreferences, saveAiModelPreferences, type AiModelPreferences } from "@/lib/ai/ai-model-preferences";
import { aiProviderLabel, type AiProvider } from "@/lib/ai/ai-providers";
import type { AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import type { AiConnectionStateKind } from "@/lib/ai/ai-connection";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { Translate } from "@/lib/i18n";
import type { DesktopAiModelCatalog, DesktopAiModelOption } from "@/types/desktop";

function preferredModel(preferences: AiModelPreferences, provider: AiProvider): string {
  return provider === "claude"
    ? preferences.claudeModel
    : provider === "antigravity"
      ? preferences.geminiModel
      : preferences.model;
}

function withModel(preferences: AiModelPreferences, provider: AiProvider, model: string): AiModelPreferences {
  return provider === "claude"
    ? { ...preferences, claudeModel: model }
    : provider === "antigravity"
      ? { ...preferences, geminiModel: model }
      : { ...preferences, model };
}

export interface AiModelSelection {
  provider: AiProvider;
  /** The chosen provider is connected. Until it is (or while it is being checked), nothing can be sent. */
  providerReady: boolean;
  providerLabel: string;
  model: string;
  modelLabel: string;
  /** The model as the CLI wants it: the "auto" sentinel of Antigravity means "the CLI's own default". */
  runtimeModel: string | undefined;
  reasoningEffort: string;
  reasoningEffortLabel: string;
  /** Empty when the provider or the model has no effort to choose. */
  reasoningEfforts: string[];
  reasoningEffortSupported: boolean;
  modelOptions: DesktopAiModelOption[];
  /** True while the first model list of the provider is still coming. */
  modelCatalogLoading: boolean;
  modelCatalogError: string | null;
  /** The effort to run with, or undefined when the provider takes none. */
  runtimeReasoningEffort: string | undefined;
  selectProvider: (provider: AiProvider) => void;
  selectModel: (option: DesktopAiModelOption) => void;
  selectEffort: (effort: string) => void;
}

/**
 * Provider, model and thinking depth the way the chat composers offer them: the same saved
 * preferences, the same runtime model list (with the built-in list as the fallback), and the same
 * rule that switching model may move the effort onto one the model supports. The choice is saved
 * only when the user makes it, so opening a chat never rewrites the preferences.
 *
 * `connections` is the state of each provider's connection. The saved provider is kept while it is
 * connected or still being checked (the checks finish one by one, and switching away meanwhile would
 * lose the reader's choice); once it is known not to be connected, the first connected one is used,
 * without touching the saved preferences.
 */
export function useAiModelSelection(
  t: Translate<"ai">,
  connections: Record<AiProvider, AiConnectionStateKind>,
): AiModelSelection {
  const [preferences, setPreferences] = useState<AiModelPreferences>(() => getAiModelPreferences());
  const preferred = preferences.provider;
  const provider: AiProvider = connections[preferred] === "loggedIn" || connections[preferred] === "checking"
    ? preferred
    : (["chatgpt", "claude", "antigravity"] as const).find((candidate) => connections[candidate] === "loggedIn") ?? preferred;
  const [catalogs, setCatalogs] = useState<Partial<Record<AiProvider, DesktopAiModelCatalog>>>({});
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const catalog = catalogs[provider] ?? null;
  const modelOptions = useMemo(() => resolveAiModelOptions(provider, catalog), [provider, catalog]);
  const selection = useMemo(() => resolveCatalogSelection({
    models: modelOptions,
    model: preferredModel(preferences, provider),
    reasoningEffort: preferences.reasoningEffort,
  }), [modelOptions, preferences, provider]);

  useEffect(() => {
    const desktop = getDesktopBridge();
    const section = provider === "claude"
      ? desktop?.claude
      : provider === "antigravity"
        ? desktop?.gemini
        : desktop?.codex;
    const listModels = section?.listModels;
    if (!listModels || catalogs[provider]) {
      return;
    }
    let cancelled = false;
    // Started on the next tick, like the chat composers do, so the effect itself sets no state.
    const startTimer = window.setTimeout(() => {
      setCatalogLoading(true);
      setCatalogError(null);
      listModels()
        .then((loaded) => {
          if (!cancelled) setCatalogs((current) => ({ ...current, [provider]: loaded }));
        })
        .catch((cause: unknown) => {
          if (!cancelled) setCatalogError(cause instanceof Error ? cause.message : t("composer.modelCatalogFailed"));
        })
        .finally(() => {
          if (!cancelled) setCatalogLoading(false);
        });
    }, 0);
    return () => {
      cancelled = true;
      window.clearTimeout(startTimer);
    };
    // The catalog of a provider is fetched once; the effect must not restart when it arrives.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider, t]);

  const persist = useCallback((next: AiModelPreferences) => {
    setPreferences(next);
    saveAiModelPreferences(next);
  }, []);

  const selectProvider = useCallback((next: AiProvider) => {
    persist({ ...preferences, provider: next });
  }, [persist, preferences]);

  const selectModel = useCallback((option: DesktopAiModelOption) => {
    const efforts = getProviderReasoningEfforts(provider, modelOptions, option.id);
    const effort = efforts.length > 0 && !efforts.includes(selection.reasoningEffort)
      ? (option.defaultReasoningEffort && efforts.includes(option.defaultReasoningEffort)
        ? option.defaultReasoningEffort
        : efforts[0])
      : selection.reasoningEffort;
    persist({
      ...withModel({ ...preferences, provider }, provider, option.id),
      reasoningEffort: effort as AiEditReasoningEffort,
    });
  }, [modelOptions, persist, preferences, provider, selection.reasoningEffort]);

  const selectEffort = useCallback((effort: string) => {
    persist({ ...preferences, provider, reasoningEffort: effort as AiEditReasoningEffort });
  }, [persist, preferences, provider]);

  const reasoningEfforts = getProviderReasoningEfforts(provider, modelOptions, selection.model);
  const reasoningEffortSupported = reasoningEfforts.length > 0;
  const selectedOption = modelOptions.find((option) => option.id === selection.model);

  return {
    provider,
    providerReady: connections[provider] === "loggedIn",
    providerLabel: aiProviderLabel(provider),
    model: selection.model,
    modelLabel: selectedOption?.label ?? selection.model,
    runtimeModel: provider === "antigravity" && selection.model === "auto" ? undefined : selection.model,
    reasoningEffort: selection.reasoningEffort,
    reasoningEffortLabel: formatReasoningEffortLabel(selection.reasoningEffort, t),
    reasoningEfforts,
    reasoningEffortSupported,
    modelOptions,
    modelCatalogLoading: catalogLoading && !catalog,
    modelCatalogError: catalogError,
    runtimeReasoningEffort: reasoningEffortSupported ? selection.reasoningEffort : undefined,
    selectProvider,
    selectModel,
    selectEffort,
  };
}
