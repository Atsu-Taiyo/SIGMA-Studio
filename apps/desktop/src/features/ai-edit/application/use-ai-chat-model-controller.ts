"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { resolveAiModelOptions, resolveCatalogSelection } from "@/lib/ai/ai-model-catalog";
import { getAiModelPreferences, saveAiModelPreferences } from "@/lib/ai/ai-model-preferences";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { AiEditModel, AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { DesktopAiModelCatalog } from "@/types/desktop";

/** Owns persisted choices and runtime catalog discovery independently of chat composition. */
export function useAiChatModelController() {
  const t = useT("ai");
  const initialModelPreferences = useMemo(() => getAiModelPreferences(), []);
  const [provider, setProvider] = useState<AiProvider>(initialModelPreferences.provider);
  const [model, setModel] = useState<AiEditModel>(initialModelPreferences.model);
  const [claudeModel, setClaudeModel] = useState<string>(initialModelPreferences.claudeModel);
  const [geminiModel, setGeminiModel] = useState<string>(initialModelPreferences.geminiModel);
  const [reasoningEffort, setReasoningEffort] = useState<AiEditReasoningEffort>(initialModelPreferences.reasoningEffort);
  const [runtimeModelCatalogs, setRuntimeModelCatalogs] = useState<Partial<Record<AiProvider, DesktopAiModelCatalog>>>({});
  const [modelCatalogLoadingProvider, setModelCatalogLoadingProvider] = useState<AiProvider | null>(null);
  const [modelCatalogErrors, setModelCatalogErrors] = useState<Partial<Record<AiProvider, string>>>({});
  const modelCatalogRequestSeqRef = useRef(0);
  const modelPreferencesRef = useRef({ model, claudeModel, geminiModel, reasoningEffort });
  modelPreferencesRef.current = { model, claudeModel, geminiModel, reasoningEffort };

  useEffect(() => {
    saveAiModelPreferences({ provider, model, claudeModel, geminiModel, reasoningEffort });
  }, [provider, model, claudeModel, geminiModel, reasoningEffort]);

  const refreshRuntimeModels = useCallback(async (targetProvider: AiProvider) => {
    const desktop = getDesktopBridge();
    const section = targetProvider === "claude"
      ? desktop?.claude
      : targetProvider === "antigravity"
        ? desktop?.gemini
        : desktop?.codex;
    if (!section?.listModels) {
      setModelCatalogErrors((current) => ({ ...current, [targetProvider]: t("composer.modelCatalogUnavailable") }));
      return;
    }

    const requestSeq = modelCatalogRequestSeqRef.current + 1;
    modelCatalogRequestSeqRef.current = requestSeq;
    setModelCatalogLoadingProvider(targetProvider);
    setModelCatalogErrors((current) => ({ ...current, [targetProvider]: undefined }));
    try {
      const catalog = await section.listModels();
      if (modelCatalogRequestSeqRef.current !== requestSeq) return;
      const options = resolveAiModelOptions(targetProvider, catalog);
      setRuntimeModelCatalogs((current) => ({ ...current, [targetProvider]: catalog }));

      const currentPreferences = modelPreferencesRef.current;
      if (targetProvider === "chatgpt") {
        const selection = resolveCatalogSelection({
          models: options,
          model: currentPreferences.model,
          reasoningEffort: currentPreferences.reasoningEffort,
        });
        setModel(selection.model as AiEditModel);
        setReasoningEffort(selection.reasoningEffort);
      } else if (targetProvider === "claude") {
        const selection = resolveCatalogSelection({
          models: options,
          model: currentPreferences.claudeModel,
          reasoningEffort: currentPreferences.reasoningEffort,
        });
        setClaudeModel(selection.model);
        setReasoningEffort(selection.reasoningEffort);
      } else {
        const nextModel = options.some((option) => option.id === currentPreferences.geminiModel)
          ? currentPreferences.geminiModel
          : options.find((option) => option.isDefault)?.id ?? options[0]?.id;
        if (nextModel) setGeminiModel(nextModel);
      }
    } catch (error) {
      if (modelCatalogRequestSeqRef.current !== requestSeq) return;
      setModelCatalogErrors((current) => ({
        ...current,
        [targetProvider]: error instanceof Error ? error.message : t("composer.modelCatalogFailed"),
      }));
    } finally {
      if (modelCatalogRequestSeqRef.current === requestSeq) {
        setModelCatalogLoadingProvider(null);
      }
    }
  }, [t]);

  useEffect(() => () => { modelCatalogRequestSeqRef.current++; }, []);
  useEffect(() => {
    void refreshRuntimeModels(provider);
  }, [provider, refreshRuntimeModels]);
  return {
    provider, setProvider, model, setModel, claudeModel, setClaudeModel,
    geminiModel, setGeminiModel, reasoningEffort, setReasoningEffort,
    runtimeModelCatalogs, modelCatalogLoadingProvider, modelCatalogErrors, refreshRuntimeModels,
  };
}
