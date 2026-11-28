"use client";

import { useEffect, useState } from "react";

import { AntigravityMark, ClaudeMark, OpenAiMark, SigmaAiMark } from "@/components/branding/provider-logos";
import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { SettingsSection } from "@/components/ui/settings";
import { refreshAiUsage, useAiUsage } from "@/features/ai-edit/application/ai-usage-store";
import { formatUsagePlanName } from "@/features/ai-edit/view/ai-usage-format";
import { AiUsageWindows } from "@/features/ai-edit/view/AiUsageWindows";
import { AI_PROVIDER_LABELS, type AiProvider } from "@/lib/ai/ai-providers";
import { AI_USAGE_PROVIDERS } from "@/lib/ai/ai-usage";
import { useT } from "@/lib/i18n/react";

const PROVIDER_MARKS = {
  sigma: SigmaAiMark,
  chatgpt: OpenAiMark,
  claude: ClaudeMark,
  antigravity: AntigravityMark,
} as const satisfies Record<AiProvider, unknown>;

/**
 * AI設定の「使用状況」。AI ごとの利用枠 (窓ごとの使用率とリセットの時刻) を 1 画面に並べる。
 * 値は main が各 AI から受け取ったもので、開いたときと「更新」で、問い合わせられる AI を読み直す。
 */
export function AiUsagePane({ id }: { id: string }) {
  const t = useT("settings");
  const tAi = useT("ai");
  const usage = useAiUsage();
  const [refreshing, setRefreshing] = useState(false);

  const refresh = async () => {
    setRefreshing(true);
    try {
      await refreshAiUsage();
    } finally {
      setRefreshing(false);
    }
  };
  useEffect(() => {
    void refreshAiUsage();
  }, []);

  return (
    <SettingsSection
      id={id}
      className="ai-settings-pane"
      title={t("usage.title")}
      description={t("usage.description")}
      actions={(
        <Button tone="secondary" size="sm" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? t("usage.refreshing") : t("usage.refresh")}
        </Button>
      )}
    >
      <Stack gap="lg">
        {AI_USAGE_PROVIDERS.map((provider) => {
          const Mark = PROVIDER_MARKS[provider];
          const item = usage[provider];
          const plan = formatUsagePlanName(item, tAi);
          const note = provider === "sigma" && item.state !== "notIncluded"
            ? t("usage.sigmaNote")
            : provider === "claude" && item.state !== "unsupported" ? t("usage.claudeNote") : null;
          return (
            <section key={provider} className="ai-usage-provider" aria-label={AI_PROVIDER_LABELS[provider]} data-provider={provider}>
              <header className="ai-usage-provider-head">
                <Mark size={15} />
                <h3 className="ai-usage-provider-name">{AI_PROVIDER_LABELS[provider]}</h3>
                {plan && <span className="ai-usage-provider-plan">{tAi("usage.plan", { replace: { plan } })}</span>}
              </header>
              <AiUsageWindows usage={item} />
              {note && <p className="ai-usage-state">{note}</p>}
            </section>
          );
        })}
      </Stack>
    </SettingsSection>
  );
}
