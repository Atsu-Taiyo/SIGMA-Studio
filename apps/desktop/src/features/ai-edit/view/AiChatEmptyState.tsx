"use client";
import { Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Center, Stack } from "@/components/ui/layout";
import { useT } from "@/lib/i18n/react";
import { AI_ACTION_PRESET_ICONS, buildAiActionPresets } from "./ai-chat-presets";

/**
 * 会話を始める前の画面。ひとこと案内と、よく使う依頼の入口だけを置く。
 * 参照中の対象は入力欄のチップが示すので、ここでは繰り返さない。
 */
export function ChatEmptyState({
  onSelectPreset,
}: {
  onSelectPreset: (prompt: string) => void;
}) {
  const t = useT("ai");
  return (
    <Center className="ai-chat-empty" size="sm" gutter="none">
      <Stack className="ai-chat-empty-stack" gap="md">
        <Stack className="ai-chat-empty-intro" gap="xs">
          <span className="ai-chat-empty-mark" aria-hidden="true">
            <Sparkles size={16} strokeWidth={1.75} />
          </span>
          <h3>{t("panel.emptyTitle")}</h3>
          <p>{t("panel.emptyBody")}</p>
        </Stack>
        <div className="ai-chat-empty-presets" role="group" aria-label={t("panel.quickActions")}>
          {buildAiActionPresets(t).map((preset) => {
            const PresetIcon = AI_ACTION_PRESET_ICONS[preset.id];
            return (
              <Button
                key={preset.id}
                tone="ghost"
                size="sm"
                className="ai-chat-empty-preset"
                data-preset={preset.id}
                onClick={() => onSelectPreset(preset.prompt)}
              >
                <PresetIcon size={14} strokeWidth={1.75} aria-hidden="true" />
                <span>{preset.label}</span>
              </Button>
            );
          })}
        </div>
      </Stack>
    </Center>
  );
}
