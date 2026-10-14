"use client";

import { useEffect, useRef, useState } from "react";
import { Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsRow, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { useT } from "@/lib/i18n/react";
import { OrganizationMembershipDisplay } from "./OrganizationMembershipBadge";
import { getOfficialPluginBridge, type OfficialPluginStatus } from "./plugin-ui-contract";

export function OfficialPluginsSection({ onFontsChanged }: { onFontsChanged?: () => void }) {
  const t = useT("settings");
  const [status, setStatus] = useState<OfficialPluginStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  const changed = useRef(onFontsChanged);
  const generation = useRef(0);
  const mounted = useRef(false);
  useEffect(() => { changed.current = onFontsChanged; }, [onFontsChanged]);
  const bridge = getOfficialPluginBridge();
  useEffect(() => {
    if (!bridge) return;
    let active = true; mounted.current = true;
    const request = ++generation.current;
    void bridge.status().then(value => { if (active && request === generation.current) setStatus(value); }).catch(() => { if (active && request === generation.current) setFailed(true); });
    const unsubscribe = bridge.onChange(value => {
      if (!active) return;
      generation.current++; setStatus(value); setFailed(false);
      if (value.phase === "idle") changed.current?.();
    });
    return () => { active = false; mounted.current = false; unsubscribe(); };
  }, [bridge]);
  async function run(action: () => Promise<OfficialPluginStatus>) {
    const request = ++generation.current;
    setPending(true);
    setFailed(false);
    try {
      const result = await action();
      if (!mounted.current || request !== generation.current) return;
      setStatus(result);
      if (!result.error) changed.current?.();
    } catch { if (mounted.current && request === generation.current) setFailed(true); }
    finally { if (mounted.current) setPending(false); }
  }
  const busy = pending || (status !== null && status.phase !== "idle");
  const visiblePlugins = status && !status.requiresLogin && !status.requiresRole ? status.plugins.filter(plugin => plugin.authorized === true) : [];
  const unavailable = !bridge || status?.available === false;
  return (
    <SettingsSection title={t("plugins.title")} description={t("plugins.description")}
      actions={bridge && <Button tone="secondary" disabled={busy || unavailable} onClick={() => void run(() => bridge.check())}>
        <RefreshCw size={14} />{t("plugins.check")}
      </Button>}>
      {unavailable ? <SettingsStatus>{t("plugins.unavailable")}</SettingsStatus> : <Stack gap="md">
        {!status?.requiresLogin && status?.organizations && status.organizations.length > 0 && <SettingsRow label={t("organizations.title")} control={<OrganizationMembershipDisplay organizations={status.organizations} />} />}
        <SettingsRow label={t("plugins.autoUpdate")} description={t("plugins.autoUpdateDescription")}
          control={<Switch label={t("plugins.autoUpdate")} checked={status?.autoUpdate ?? false} disabled={busy || !status}
            onCheckedChange={value => { if (bridge) void run(() => bridge.setAutoUpdate(value)); }} />} />
        {status?.requiresLogin && <SettingsStatus>{t("plugins.login")}</SettingsStatus>}
        {status?.requiresRole && !status.requiresLogin && <SettingsStatus>{t("plugins.roleRequired")}</SettingsStatus>}
        {!status && !failed && <SettingsStatus>{t("plugins.loading")}</SettingsStatus>}
        {status && visiblePlugins.length === 0 && !status.requiresLogin && !status.requiresRole && <SettingsStatus>{t("plugins.empty")}</SettingsStatus>}
        {status && visiblePlugins.map(plugin => <Stack key={plugin.id} gap="xs"><SettingsRow label={plugin.name}
          description={<><span>{plugin.description}</span><br />
            <span>{plugin.installedVersion ? t("plugins.installed", { version: plugin.installedVersion }) : t("plugins.notInstalled")}</span>
            {!plugin.compatible && <span>{t("plugins.incompatible")}</span>}
          </>}
          control={<Inline gap="sm" wrap>
            {plugin.installedVersion && <Switch label={t("plugins.enableNamed", { name: plugin.name })} checked={plugin.enabled && plugin.authorized !== false} disabled={busy || status.requiresLogin || plugin.authorized === false}
              onCheckedChange={value => { if (bridge) void run(() => bridge.setEnabled(plugin.id, value)); }} />}
            {plugin.latestVersion && plugin.latestVersion !== plugin.installedVersion && <Button tone="secondary"
              disabled={busy || !plugin.compatible || status.requiresLogin || plugin.authorized === false}
              onClick={() => { if (bridge) void run(() => bridge.install(plugin.id)); }}>
              <Download size={14} />{t(plugin.installedVersion ? "plugins.update" : "plugins.add")}
            </Button>}
          </Inline>} />
          {plugin.fonts && plugin.fonts.length > 0 && <details><summary>{t("plugins.fonts", { count: plugin.fonts.length })}</summary>
            <p>{plugin.fonts.join("、")}</p></details>}
        </Stack>)}
        {busy && <SettingsStatus>{t(status?.phase === "checking" ? "plugins.checking" : "plugins.working")}</SettingsStatus>}
      </Stack>}
      {(failed || status?.error) && <SettingsStatus tone="error">{t(`plugins.errors.${status?.error ?? "unavailable"}`)}</SettingsStatus>}
    </SettingsSection>
  );
}
