"use client";
import { renderModelMark } from "@/components/branding/provider-logos";
import { Shimmer } from "@/components/ui/Shimmer";
import { formatReasoningEffortLabel } from "@/lib/ai/ai-model-catalog";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type { Translate } from "@/lib/i18n";
import type { DesktopAiModelOption } from "@/types/desktop";
import { Check, ChevronRight, Gauge } from "lucide-react";
import type { Dispatch, KeyboardEvent, SetStateAction } from "react";
interface Props {
  t: Translate<"ai">;
  provider: AiProvider;
  selectedProviderLabel: string;
  selectedModel: string;
  selectedModelLabel: string;
  reasoningEffort: string;
  selectedReasoningEffortLabel: string;
  reasoningEffortSupported: boolean;
  reasoningEfforts: string[];
  modelOptions: DesktopAiModelOption[];
  modelCatalogLoading: boolean;
  modelCatalogError: string | null | undefined;
  modelFlyout: "model" | "effort" | null;
  setModelFlyout: Dispatch<SetStateAction<"model" | "effort" | null>>;
  setModelMenuOpen: Dispatch<SetStateAction<boolean>>;
  onSelectModel: (item: DesktopAiModelOption) => void;
  onSelectEffort: (effort: string) => void;
}
export function AiModelMenuContents({ t, provider, selectedProviderLabel, selectedModel,
  selectedModelLabel, reasoningEffort, selectedReasoningEffortLabel, reasoningEffortSupported,
  reasoningEfforts, modelOptions, modelCatalogLoading, modelCatalogError, modelFlyout,
  setModelFlyout, setModelMenuOpen, onSelectModel, onSelectEffort }: Props) {
  const focusModelFlyoutFromKeyboard = (
    event: KeyboardEvent<HTMLButtonElement>,
    kind: "model" | "effort",
  ) => {
    if ((event.key !== "ArrowRight" && event.key !== "Enter" && event.key !== " ")
      || (kind === "effort" && !reasoningEffortSupported)) {
      return;
    }
    const menu = event.currentTarget.closest<HTMLElement>(".ai-chat-model-menu");
    event.preventDefault();
    event.stopPropagation();
    setModelFlyout(kind);
    window.requestAnimationFrame(() => {
      menu?.querySelector<HTMLElement>(`.ai-chat-model-submenu[data-kind="${kind}"] button:not([disabled])`)
        ?.focus({ preventScroll: true });
    });
  };
  return <>
    <button
      type="button"
      role="menuitem"
      className="ai-chat-model-menu-item ai-chat-model-submenu-trigger"
      aria-haspopup="menu"
      aria-expanded={modelFlyout === "model"}
      onMouseEnter={() => setModelFlyout("model")}
      onFocus={() => setModelFlyout("model")}
      onKeyDown={(event) => focusModelFlyoutFromKeyboard(event, "model")}
      onClick={() => setModelFlyout((current) => current === "model" ? null : "model")}
    >
      {renderModelMark(selectedModel, provider, { size: 13 })}
      <span className="ai-chat-model-submenu-copy"><span>{t("composer.model")}</span><small>{selectedModelLabel}</small></span>
      <ChevronRight size={13} />
    </button>
    <button
      type="button"
      role="menuitem"
      className="ai-chat-model-menu-item ai-chat-model-submenu-trigger"
      aria-haspopup={reasoningEffortSupported ? "menu" : undefined}
      aria-expanded={reasoningEffortSupported ? modelFlyout === "effort" : undefined}
      aria-disabled={!reasoningEffortSupported}
      disabled={!reasoningEffortSupported}
      onMouseEnter={() => reasoningEffortSupported && setModelFlyout("effort")}
      onFocus={() => reasoningEffortSupported && setModelFlyout("effort")}
      onKeyDown={(event) => focusModelFlyoutFromKeyboard(event, "effort")}
      onClick={() => setModelFlyout((current) => current === "effort" ? null : "effort")}
    >
      <Gauge size={13} />
      <span className="ai-chat-model-submenu-copy">
        <span>{t("composer.effort")}</span>
        <small>{reasoningEffortSupported
          ? t("composer.effortWithId", { replace: { label: selectedReasoningEffortLabel, id: reasoningEffort } })
          : t("composer.effortUnsupportedForModel")}</small>
      </span>
      {reasoningEffortSupported && <ChevronRight size={13} />}
    </button>
    {modelFlyout === "model" && (
      <div className="ai-chat-model-submenu" data-kind="model" role="menu" aria-label={t("composer.selectModel")}>
        <div className="ai-chat-menu-title">{t("composer.providerModels", { replace: { provider: selectedProviderLabel } })}</div>
        {modelCatalogLoading ? (
          <div className="ai-chat-model-menu-note"><Shimmer>{t("composer.loadingModels")}</Shimmer></div>
        ) : modelOptions.map((item) => (
          <button
            key={item.id}
            type="button"
            role="menuitemradio"
            aria-checked={selectedModel === item.id}
            title={item.description}
            className="ai-chat-model-menu-item"
            onClick={() => {
              onSelectModel(item);
              setModelFlyout(null);
              setModelMenuOpen(false);
            }}
          >
            {renderModelMark(item.id, provider, { size: 13 })}
            <span className="ai-chat-model-submenu-copy">
              <span>{item.label}</span>
              <small>{selectedProviderLabel}</small>
            </span>
            {selectedModel === item.id && <Check size={13} />}
          </button>
        ))}
        {modelCatalogError && (
          <div className="ai-chat-model-menu-note" title={modelCatalogError}>{t("composer.showingBuiltIns")}</div>
        )}
      </div>
    )}
    {modelFlyout === "effort" && reasoningEffortSupported && (
      <div className="ai-chat-model-submenu" data-kind="effort" role="menu" aria-label={t("composer.selectEffort")}>
        <div className="ai-chat-menu-title">{t("composer.effort")}</div>
        {reasoningEfforts.map((item) => (
          <button
            key={item}
            type="button"
            role="menuitemradio"
            aria-checked={reasoningEffort === item}
            className="ai-chat-model-menu-item"
            onClick={() => {
              onSelectEffort(item);
              setModelFlyout(null);
              setModelMenuOpen(false);
            }}
          >
            <Gauge size={13} />
            <span className="ai-chat-model-submenu-copy">
              <span>{formatReasoningEffortLabel(item, t)}</span>
              <small>{item || t("model.effortUnset")}</small>
            </span>
            {reasoningEffort === item && <Check size={13} />}
          </button>
        ))}
      </div>
    )}

</>;
}
