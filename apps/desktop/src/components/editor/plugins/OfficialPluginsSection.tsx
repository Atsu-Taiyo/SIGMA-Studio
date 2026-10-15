"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsRow, SettingsSection, SettingsStatus, Switch } from "@/components/ui/settings";
import { useT } from "@/lib/i18n/react";
import { OrganizationMembershipDisplay } from "./OrganizationMembershipBadge";
import { getOfficialPluginBridge, type OfficialPluginRow, type OfficialPluginStatus } from "./plugin-ui-contract";

type PluginError = NonNullable<OfficialPluginStatus["error"]>;
/** What a user action should have committed; judged only against a committed idle host status. */
type Intent = { kind: "check" } | { kind: "install"; id: string; version: string; update: boolean } | { kind: "load"; id: string };
interface Notice {
  key: "plugins.checkComplete" | "plugins.updatesAvailable" | "plugins.addComplete" | "plugins.updateComplete" | "plugins.loadComplete";
  params?: Record<string, string | number>;
  plugin?: string;
}

function isStatus(value: unknown): value is OfficialPluginStatus {
  if (!value || typeof value !== "object") return false;
  const status = value as Partial<Record<keyof OfficialPluginStatus, unknown>>;
  return typeof status.available === "boolean" && typeof status.requiresLogin === "boolean" && typeof status.autoUpdate === "boolean"
    && (status.phase === "idle" || status.phase === "checking" || status.phase === "installing") && Array.isArray(status.plugins);
}
const hasAccess = (status: OfficialPluginStatus) => status.available && !status.requiresLogin && !status.requiresRole;
function completion(intent: Intent, status: OfficialPluginStatus): Notice | null {
  if (status.phase !== "idle" || status.error || !hasAccess(status)) return null;
  const granted = status.plugins.filter(plugin => plugin.authorized === true);
  if (intent.kind === "check") {
    const count = granted.filter(plugin => plugin.installedVersion && plugin.latestVersion && plugin.latestVersion !== plugin.installedVersion).length;
    return count > 0 ? { key: "plugins.updatesAvailable", params: { count } } : { key: "plugins.checkComplete" };
  }
  const target = intent.id;
  const plugin = granted.find(row => row.id === target);
  if (!plugin?.installedVersion || !plugin.compatible || plugin.enabled !== true) return null;
  if (intent.kind === "load") return { key: "plugins.loadComplete", params: { name: plugin.name }, plugin: plugin.id };
  if (plugin.installedVersion !== intent.version) return null;
  return { key: intent.update ? "plugins.updateComplete" : "plugins.addComplete", params: { name: plugin.name }, plugin: plugin.id };
}
const keeps = (notice: Notice, status: OfficialPluginStatus) => hasAccess(status) && status.phase === "idle" && !status.error
  && (!notice.plugin || status.plugins.some(row => row.id === notice.plugin && row.authorized === true));

export function OfficialPluginsSection({ onFontsChanged }: { onFontsChanged?: () => void }) {
  const t = useT("settings");
  const [status, setStatus] = useState<OfficialPluginStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [actionError, setActionError] = useState<PluginError | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const changed = useRef(onFontsChanged);
  // Latest committed host status; each commit bumps generation so older in-flight responses cannot overwrite it.
  const latest = useRef<OfficialPluginStatus | null>(null);
  const generation = useRef(0);
  // Bumped by every event without access; anything started before it is stale even if access returns.
  const accessEpoch = useRef(0);
  const requestId = useRef(0);
  // An action that returned while the host was still working waits here for the next idle event.
  const awaiting = useRef<Intent | null>(null);
  const activePlugin = useRef<string | null>(null);
  const mounted = useRef(false);
  useEffect(() => { changed.current = onFontsChanged; }, [onFontsChanged]);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; awaiting.current = null; }; }, []);
  const bridge = getOfficialPluginBridge();
  useEffect(() => {
    if (!bridge) return;
    let active = true;
    const since = generation.current, request = requestId.current;
    const stale = () => !active || since !== generation.current || request !== requestId.current;
    void bridge.status().then(value => {
      if (stale()) return;
      if (!isStatus(value)) { setLoadFailed(true); return; }
      generation.current++; latest.current = value; setStatus(value);
    }).catch(() => { if (!stale()) setLoadFailed(true); });
    const unsubscribe = bridge.onChange(value => {
      if (!active || !isStatus(value)) return;
      generation.current++; latest.current = value; setStatus(value); setLoadFailed(false);
      const target = activePlugin.current ?? (awaiting.current && awaiting.current.kind !== "check" ? awaiting.current.id : null);
      if (!hasAccess(value) || (target && !value.plugins.some(row => row.id === target && row.authorized === true))) {
        accessEpoch.current++; awaiting.current = null; setActionError(null);
      }
      setNotice(current => current && keeps(current, value) ? current : null);
      const intent = awaiting.current;
      if (intent && (value.phase === "idle" || value.error)) {
        awaiting.current = null;
        const done = completion(intent, value);
        if (done) setNotice(done);
      }
      if (value.phase === "idle") changed.current?.();
    });
    return () => { active = false; awaiting.current = null; unsubscribe(); };
  }, [bridge]);
  async function run(intent: Intent | null, action: () => Promise<OfficialPluginStatus>) {
    const request = ++requestId.current, since = generation.current, epoch = accessEpoch.current;
    const live = () => mounted.current && request === requestId.current;
    awaiting.current = null;
    activePlugin.current = intent && intent.kind !== "check" ? intent.id : null;
    setPending(true); setLoadFailed(false); setActionError(null); setNotice(null);
    try {
      const result = await action();
      if (!live() || epoch !== accessEpoch.current) return;
      if (!isStatus(result)) { setActionError("unavailable"); return; }
      if (since === generation.current) {
        generation.current++; latest.current = result; setStatus(result);
        if (!result.error) changed.current?.();
      }
      if (result.error) { setActionError(result.error); return; }
      const committed = latest.current;
      if (!intent || !committed || committed.error) return;
      if (committed.phase !== "idle") { awaiting.current = intent; return; }
      const done = completion(intent, committed);
      if (done) setNotice(done);
    } catch {
      if (live() && epoch === accessEpoch.current) setActionError("unavailable");
    } finally {
      if (live()) { activePlugin.current = null; setPending(false); }
    }
  }
  function install(plugin: OfficialPluginRow) {
    if (!bridge || !plugin.latestVersion) return;
    void run({ kind: "install", id: plugin.id, version: plugin.latestVersion, update: Boolean(plugin.installedVersion) }, () => bridge.install(plugin.id));
  }
  const busy = pending || (status !== null && status.phase !== "idle");
  const visiblePlugins = status && !status.requiresLogin && !status.requiresRole ? status.plugins.filter(plugin => plugin.authorized === true) : [];
  const unavailable = !bridge || status?.available === false;
  const error = status?.error ?? actionError ?? (loadFailed ? "unavailable" : null);
  return (
    <SettingsSection title={t("plugins.title")} description={t("plugins.description")}
      actions={bridge && <Button tone="secondary" disabled={busy || unavailable} onClick={() => void run({ kind: "check" }, () => bridge.check())}>
        <RefreshCw size={14} />{t("plugins.check")}
      </Button>}>
      {unavailable ? <SettingsStatus>{t("plugins.unavailable")}</SettingsStatus> : <Stack gap="md">
        {!status?.requiresLogin && status?.organizations && status.organizations.length > 0 && <SettingsRow label={t("organizations.title")} control={<OrganizationMembershipDisplay organizations={status.organizations} />} />}
        <SettingsRow label={t("plugins.autoUpdate")} description={t("plugins.autoUpdateDescription")}
          control={<Switch label={t("plugins.autoUpdate")} checked={status?.autoUpdate ?? false} disabled={busy || !status}
            onCheckedChange={value => { if (bridge) void run(null, () => bridge.setAutoUpdate(value)); }} />} />
        {status?.requiresLogin && <SettingsStatus>{t("plugins.login")}</SettingsStatus>}
        {status?.requiresRole && !status.requiresLogin && <SettingsStatus>{t("plugins.roleRequired")}</SettingsStatus>}
        {!status && !error && <SettingsStatus>{t("plugins.loading")}</SettingsStatus>}
        {status && visiblePlugins.length === 0 && !status.requiresLogin && !status.requiresRole && <SettingsStatus>{t("plugins.empty")}</SettingsStatus>}
        {status && visiblePlugins.map(plugin => <Stack key={plugin.id} gap="xs"><SettingsRow label={plugin.name}
          description={<><span>{plugin.description}</span><br />
            <span>{plugin.installedVersion ? t("plugins.installed", { version: plugin.installedVersion }) : t("plugins.notInstalled")}</span>
            {!plugin.compatible && <span>{t("plugins.incompatible")}</span>}
          </>}
          control={<Inline gap="sm" wrap>
            {plugin.installedVersion && <Switch label={t("plugins.enableNamed", { name: plugin.name })} checked={plugin.enabled && plugin.authorized !== false} disabled={busy || status.requiresLogin || plugin.authorized === false}
              onCheckedChange={value => { if (bridge) void run(value ? { kind: "load", id: plugin.id } : null, () => bridge.setEnabled(plugin.id, value)); }} />}
            {plugin.latestVersion && plugin.latestVersion !== plugin.installedVersion && <Button tone="secondary"
              disabled={busy || !plugin.compatible || status.requiresLogin || plugin.authorized === false}
              onClick={() => install(plugin)}>
              <Download size={14} />{t(plugin.installedVersion ? "plugins.update" : "plugins.add")}
            </Button>}
          </Inline>} />
          {plugin.fonts && plugin.fonts.length > 0 && <details><summary>{t("plugins.fonts", { count: plugin.fonts.length })}</summary>
            <p>{plugin.fonts.join("、")}</p></details>}
        </Stack>)}
        {busy && <SettingsStatus>{t(status?.phase === "checking" ? "plugins.checking" : "plugins.working")}</SettingsStatus>}
        {notice && <SettingsStatus tone="success"><Check size={14} aria-hidden="true" />{t(notice.key, notice.params)}</SettingsStatus>}
      </Stack>}
      {error && <SettingsStatus tone="error">{t(`plugins.errors.${error}`)}</SettingsStatus>}
    </SettingsSection>
  );
}
