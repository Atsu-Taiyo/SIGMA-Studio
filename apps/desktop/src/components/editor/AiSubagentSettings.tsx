"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { AntigravityMark, ClaudeMark, OpenAiMark, SigmaAiMark } from "@/components/branding/provider-logos";
import { Disclosure } from "@/components/ui/Disclosure";
import { Select } from "@/components/ui/Select";
import { Stack } from "@/components/ui/layout";
import { SettingsRow, SettingsStatus, Switch } from "@/components/ui/settings";
import {
  AI_SUBAGENT_MAX_CONCURRENT,
  AI_SUBAGENT_MAX_DEPTH,
  AI_SUBAGENT_MIN_CONCURRENT,
  AI_SUBAGENT_MIN_DEPTH,
  DEFAULT_AI_SUBAGENT_SETTINGS,
  normalizeAiSubagentSettings,
  type AiSubagentProvider,
  type AiSubagentSettings as AiSubagentSettingsValue,
} from "@/lib/ai/subagent-settings";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";

function range(min: number, max: number): number[] {
  return Array.from({ length: max - min + 1 }, (_, index) => min + index);
}

const PROVIDER_ROWS: ReadonlyArray<{
  provider: AiSubagentProvider;
  name: string;
  noteKey:
    | "provider.subagents.claudeNote"
    | "provider.subagents.chatgptNote"
    | "provider.subagents.antigravityNote"
    | "provider.subagents.sigmaNote";
}> = [
  { provider: "sigma", name: "SIGMA AI", noteKey: "provider.subagents.sigmaNote" },
  { provider: "chatgpt", name: "ChatGPT", noteKey: "provider.subagents.chatgptNote" },
  { provider: "claude", name: "Claude", noteKey: "provider.subagents.claudeNote" },
  { provider: "antigravity", name: "Antigravity", noteKey: "provider.subagents.antigravityNote" },
];

function ProviderLogo({ provider }: { provider: AiSubagentProvider }) {
  if (provider === "sigma") return <SigmaAiMark size={14} />;
  if (provider === "claude") return <ClaudeMark size={14} />;
  if (provider === "antigravity") return <AntigravityMark size={14} />;
  return <OpenAiMark size={14} />;
}

/**
 * AI設定の「サブエージェント」: 全体のスイッチと、開いたときだけ見せる詳細
 * (入れ子の深さ・同時に動かす数・AIごとのスイッチ)。
 *
 * 値の範囲と既定値は `lib/ai/subagent-settings.ts` が持ち、保存は desktop bridge に任せる。
 * 画面はすぐ切り替え、保存に失敗したら元の値へ戻して知らせる。
 *
 * `id` は設定パレットから飛ぶ先の目印 (`settings-catalog.ts` の anchorId)。置き場所である
 * 設定画面が決めて渡す。
 */
export function AiSubagentSettings({ id }: { id: string }) {
  const t = useT("settings");
  const bridge = getDesktopBridge();
  const [settings, setSettings] = useState<AiSubagentSettingsValue>(DEFAULT_AI_SUBAGENT_SETTINGS);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  // 保存の往復中に次の変更が来ても、最後に選んだ値を保存済みとして扱うための連番。
  const saveSequence = useRef(0);

  useEffect(() => {
    const settingsBridge = getDesktopBridge()?.settings;
    if (!settingsBridge) {
      return;
    }
    let cancelled = false;
    const load = () => {
      void settingsBridge.get().then((result) => {
        if (!cancelled) {
          setSettings(normalizeAiSubagentSettings(result.aiSubagents));
        }
      });
    };
    load();
    // 設定ファイルがほかの経路で書き換わったとき (同期など) に、開いている画面を追随させる。
    const unsubscribe = settingsBridge.onAiSettingsChanged?.(load) ?? (() => {});
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  const save = useCallback(async (next: AiSubagentSettingsValue, previous: AiSubagentSettingsValue) => {
    const setAiSubagents = getDesktopBridge()?.settings?.setAiSubagents;
    if (!setAiSubagents) {
      return;
    }
    const sequence = ++saveSequence.current;
    setSettings(next);
    setSaveFailed(false);
    setBusy(true);
    try {
      const result = await setAiSubagents(next);
      if (sequence !== saveSequence.current) {
        return;
      }
      if (!result.ok) {
        setSettings(previous);
        setSaveFailed(true);
      } else if (result.aiSubagents) {
        setSettings(normalizeAiSubagentSettings(result.aiSubagents));
      }
    } catch {
      if (sequence === saveSequence.current) {
        setSettings(previous);
        setSaveFailed(true);
      }
    } finally {
      if (sequence === saveSequence.current) {
        setBusy(false);
      }
    }
  }, []);

  const depthOptions = useMemo(
    () => range(AI_SUBAGENT_MIN_DEPTH, AI_SUBAGENT_MAX_DEPTH).map((depth) => ({
      value: String(depth),
      label: depth === 1
        ? t("provider.subagents.maxDepthNone")
        : t("provider.subagents.maxDepthLevels", { replace: { count: depth } }),
    })),
    [t],
  );
  const concurrentOptions = useMemo(
    () => range(AI_SUBAGENT_MIN_CONCURRENT, AI_SUBAGENT_MAX_CONCURRENT).map((count) => ({
      value: String(count),
      label: t("provider.subagents.maxConcurrentCount", { replace: { count } }),
    })),
    [t],
  );

  const unavailable = !bridge?.settings?.setAiSubagents;

  return (
    <>
      <SettingsRow
        id={id}
        label={t("provider.subagents.label")}
        description={t("provider.subagents.description")}
        control={(
          <Switch
            label={t("provider.subagents.label")}
            checked={settings.enabled}
            disabled={busy || unavailable}
            onCheckedChange={(enabled) => void save({ ...settings, enabled }, settings)}
          />
        )}
      />
      {saveFailed && <SettingsStatus tone="error">{t("provider.subagents.saveFailed")}</SettingsStatus>}
      {settings.enabled && (
        <Disclosure label={t("provider.subagents.details")} data-testid="desktop-settings-subagents-details">
          <Stack gap="sm">
            <SettingsRow
              label={t("provider.subagents.maxDepthLabel")}
              description={t("provider.subagents.maxDepthDescription")}
              control={(
                <Select
                  aria-label={t("provider.subagents.maxDepthLabel")}
                  data-testid="desktop-settings-subagents-depth"
                  value={String(settings.maxDepth)}
                  options={depthOptions}
                  disabled={busy || unavailable}
                  onChange={(value) => void save({ ...settings, maxDepth: Number(value) }, settings)}
                />
              )}
            />
            <SettingsRow
              label={t("provider.subagents.maxConcurrentLabel")}
              description={t("provider.subagents.maxConcurrentDescription")}
              control={(
                <Select
                  aria-label={t("provider.subagents.maxConcurrentLabel")}
                  data-testid="desktop-settings-subagents-concurrent"
                  value={String(settings.maxConcurrent)}
                  options={concurrentOptions}
                  disabled={busy || unavailable}
                  onChange={(value) => void save({ ...settings, maxConcurrent: Number(value) }, settings)}
                />
              )}
            />
            {PROVIDER_ROWS.map(({ provider, name, noteKey }) => (
              <SettingsRow
                key={provider}
                icon={<ProviderLogo provider={provider} />}
                label={name}
                description={t(noteKey)}
                control={(
                  <Switch
                    label={`${t("provider.subagents.providersTitle")}: ${name}`}
                    data-testid={`desktop-settings-subagents-${provider}`}
                    checked={settings.providers[provider]}
                    disabled={busy || unavailable}
                    onCheckedChange={(checked) => void save({
                      ...settings,
                      providers: { ...settings.providers, [provider]: checked },
                    }, settings)}
                  />
                )}
              />
            ))}
          </Stack>
        </Disclosure>
      )}
    </>
  );
}
