"use client";
import type { ReactNode } from "react";

import { AntigravityMark, ClaudeMark, OpenAiMark, SigmaAiMark } from "@/components/branding/provider-logos";
import { type AiProvider } from "@/lib/ai/ai-providers";
import { useT } from "@/lib/i18n/react";

const PROVIDERS: ReadonlyArray<{ provider: AiProvider; name: string; mark: ReactNode }> = [
  { provider: "sigma", name: "SIGMA AI", mark: <SigmaAiMark size={14} /> },
  { provider: "chatgpt", name: "ChatGPT", mark: <OpenAiMark size={14} /> },
  { provider: "claude", name: "Claude", mark: <ClaudeMark size={14} /> },
  { provider: "antigravity", name: "Antigravity", mark: <AntigravityMark size={14} /> },
];

/**
 * 接続の案内の上に出すAIの切り替え。4つをロゴだけの1行のセグメントで並べる
 * (名前は title と aria-label が持ち、選んでいるAIの名前は下の案内の見出しに出る)。
 */
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
      {PROVIDERS.map((item) => {
        const active = provider === item.provider;
        return (
          <button
            key={item.provider}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={item.name}
            title={item.name}
            className="ai-provider-switch-item"
            data-active={active}
            onClick={() => onChange(item.provider)}
            disabled={disabled}
          >
            {item.mark}
          </button>
        );
      })}
    </div>
  );
}
