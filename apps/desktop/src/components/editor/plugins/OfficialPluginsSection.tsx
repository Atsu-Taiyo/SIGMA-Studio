"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsRow, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { useT } from "@/lib/i18n/react";
import { getOfficialPluginBridge, type OfficialPluginStatus } from "./plugin-ui-contract";

export function OfficialPluginsSection({ onFontsChanged }: { onFontsChanged?: () => void }) {
  const t = useT("settings");
  const [status, setStatus] = useState<OfficialPluginStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const changed = useRef(onFontsChanged);
  useEffect(() => { changed.current = onFontsChanged; }, [onFontsChanged]);
  const bridge = getOfficialPluginBridge();
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    void bridge.status().then(value => { if (active) setStatus(value); }).catch(() => { if (active) setFailed(true); });
    const unsubscribe = bridge.onChange(value => {
      if (!active) return;
      setStatus(value);
      if (value.phase === "idle") changed.current?.();
    });
    return () => { active = false; unsubscribe(); };
  }, [bridge]);
  async function run(action: () => Promise<OfficialPluginStatus>) {
    setPending(true);
    setFailed(false);
    try {
      const result = await action();
      setStatus(result);
      if (!result.error) changed.current?.();
    } catch { setFailed(true); }
    finally { setPending(false); }
  }
  const busy = pending || (status !== null && status.phase !== "idle");
  const unavailable = !bridge || status?.available === false;
  return (
    <SettingsSection title={t("plugins.title")} description={t("plugins.description")}
      actions={bridge && <Button tone="secondary" disabled={busy || unavailable} onClick={() => void run(() => bridge.check())}>
        <RefreshCw size={14} />{t("plugins.check")}
      </Button>}>
      {unavailable ? <SettingsStatus>{t("plugins.unavailable")}</SettingsStatus> : <Stack gap="md">
        <SettingsRow label={t("plugins.autoUpdate")} description={t("plugins.autoUpdateDescription")}
          control={<Switch label={t("plugins.autoUpdate")} checked={status?.autoUpdate ?? false} disabled={busy || !status}
            onCheckedChange={value => { if (bridge) void run(() => bridge.setAutoUpdate(value)); }} />} />
        {status?.requiresLogin && <SettingsStatus>{t("plugins.login")}</SettingsStatus>}
        {!status && !failed && <SettingsStatus>{t("plugins.loading")}</SettingsStatus>}
        {status && status.plugins.length === 0 && !status.requiresLogin && <SettingsStatus>{t("plugins.empty")}</SettingsStatus>}
        {status?.plugins.map(plugin => <SettingsRow key={plugin.id} label={plugin.name}
          description={<Stack gap="xs"><span>{plugin.description}</span>
            <span>{plugin.installedVersion ? t("plugins.installed", { version: plugin.installedVersion }) : t("plugins.notInstalled")}</span>
            {!plugin.compatible && <span>{t("plugins.incompatible")}</span>}
          </Stack>}
          control={<Inline gap="sm" wrap>
            {plugin.installedVersion && <Switch label={t("plugins.enableNamed", { name: plugin.name })} checked={plugin.enabled} disabled={busy}
              onCheckedChange={value => { if (bridge) void run(() => bridge.setEnabled(plugin.id, value)); }} />}
            {plugin.latestVersion && plugin.latestVersion !== plugin.installedVersion && <Button tone="secondary"
              disabled={busy || !plugin.compatible || status.requiresLogin}
              onClick={() => { if (bridge) void run(() => bridge.install(plugin.id)); }}>
              <Download size={14} />{t(plugin.installedVersion ? "plugins.update" : "plugins.add")}
            </Button>}
          </Inline>} />)}
        {busy && <SettingsStatus>{t(status?.phase === "checking" ? "plugins.checking" : "plugins.working")}</SettingsStatus>}
      </Stack>}
      {(failed || status?.error) && <SettingsStatus tone="error">{t(`plugins.errors.${status?.error ?? "unavailable"}`)}</SettingsStatus>}
    </SettingsSection>
  );
}
