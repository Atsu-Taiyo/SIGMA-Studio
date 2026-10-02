"use client";
import { AtSign, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Center, Grid, Stack } from "@/components/ui/layout";
import { getReferenceDisplayLabel, type AiEditReference } from "@/lib/ai/ai-edit-reference";
import { useT } from "@/lib/i18n/react";
import { getReferenceContextText } from "../application/ai-chat-context";
import { AI_ACTION_PRESET_ICONS, buildAiActionPresets } from "./ai-chat-presets";
export function ChatEmptyState({
  reference,
  onSelectPreset,
}: {
  reference: AiEditReference | null;
  onSelectPreset: (prompt: string) => void;
}) {
  const t = useT("ai");
  const tEditor = useT("editor");
  return (
    <Center className="ai-chat-empty" size="sm" gutter="none">
      <Stack className="ai-chat-empty-stack" gap="lg">
        <Stack className="ai-chat-empty-intro" gap="xs">
          <span className="ai-chat-empty-mark" aria-hidden="true">
            <Sparkles size={16} strokeWidth={1.75} />
          </span>
          <h3>{t("panel.emptyTitle")}</h3>
          <p>{t("panel.emptyBody")}</p>
        </Stack>

        <Stack className="ai-chat-empty-card" gap="xs" data-reference-kind={reference?.kind ?? "none"}>
          <div className="ai-chat-empty-card-title">
            <AtSign size={12} />
            <span>{t("panel.referenceTarget")}</span>
          </div>
          {reference ? (
            <>
              <strong>{getReferenceDisplayLabel(reference, t, tEditor)}</strong>
              <p>{getReferenceContextText(reference) || t("panel.noContent")}</p>
            </>
          ) : (
            <p>{t("panel.referenceHint")}</p>
          )}
        </Stack>

        <Stack className="ai-chat-empty-presets" gap="sm">
          <div className="ai-chat-empty-presets-title">{t("panel.quickActions")}</div>
          <Grid className="ai-chat-empty-presets-grid" columns={2} gap="sm" responsive={false}>
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
                  <PresetIcon size={15} strokeWidth={1.75} aria-hidden="true" />
                  <span>{preset.label}</span>
                </Button>
              );
            })}
          </Grid>
        </Stack>
      </Stack>
    </Center>
  );
}

