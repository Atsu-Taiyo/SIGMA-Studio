"use client";
import { AntigravityMark, ClaudeMark, OpenAiMark } from "@/components/branding/provider-logos";
import { type AiProvider } from "@/lib/ai/ai-providers";
import { useT } from "@/lib/i18n/react";

export function ProviderSwitch({
  provider,
  onChange,
  disabled,
}: {
  provider: AiProvider;
  onChange: (provider: AiProvider) => void;
  disabled?: boolean;
}) {
  const t = useT("ai");
  return (
    <div className="ai-provider-switch" role="radiogroup" aria-label={t("composer.providerSwitchAria")}>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "chatgpt"}
        aria-label="ChatGPT"
        title="ChatGPT"
        className="ai-provider-switch-item"
        data-active={provider === "chatgpt"}
        onClick={() => onChange("chatgpt")}
        disabled={disabled}
      >
        <OpenAiMark size={14} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "claude"}
        aria-label="Claude"
        title="Claude"
        className="ai-provider-switch-item"
        data-active={provider === "claude"}
        onClick={() => onChange("claude")}
        disabled={disabled}
      >
        <ClaudeMark size={14} />
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={provider === "antigravity"}
        aria-label="Antigravity"
        title="Antigravity"
        className="ai-provider-switch-item"
        data-active={provider === "antigravity"}
        onClick={() => onChange("antigravity")}
        disabled={disabled}
      >
        <AntigravityMark size={14} />
      </button>
    </div>
  );
}
