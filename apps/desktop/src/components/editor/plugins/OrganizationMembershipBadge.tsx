"use client";
import { useEffect, useState } from "react";
import { Building2 } from "lucide-react";
import { useT } from "@/lib/i18n/react";
import { getOfficialPluginBridge, type OfficialOrganization } from "./plugin-ui-contract";
import styles from "./OrganizationMembershipBadge.module.css";

export function OrganizationMembershipDisplay({ organizations, compact = false }: { organizations: OfficialOrganization[]; compact?: boolean }) {
  const t = useT("settings");
  if (!organizations.length) return null;
  const visible = compact ? organizations.slice(0, 2) : organizations;
  return <span className={styles.list}>
    {visible.map(group => <span key={group.id} className={styles.badge} role="group" aria-label={t("organizations.membership", { name: group.name })} title={t("organizations.membership", { name: group.name })}>
      {group.logoUrl && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/u.test(group.logoUrl)
        // Host-verified raster data needs no Next.js runtime in the public editor.
        // eslint-disable-next-line @next/next/no-img-element
        ? <img className={styles.logo} src={group.logoUrl} alt="" width={20} height={20} decoding="async" referrerPolicy="no-referrer" />
        : <Building2 size={16} aria-hidden="true" />}
      <span className={styles.name}>{group.name}</span>
    </span>)}
    {compact && organizations.length > visible.length && <span className={styles.more} title={organizations.map(group => group.name).join("、")}>{t("organizations.more", { count: organizations.length - visible.length })}</span>}
  </span>;
}

export function OrganizationMembershipBadge() {
  const [organizations, setOrganizations] = useState<OfficialOrganization[]>([]);
  const bridge = getOfficialPluginBridge();
  useEffect(() => {
    if (!bridge) return;
    let active = true, generation = 0;
    const refresh = () => {
      const request = ++generation;
      void bridge.status().then(status => {
        if (active && request === generation) setOrganizations(status.requiresLogin ? [] : status.organizations ?? []);
      }).catch(() => { if (active && request === generation) setOrganizations([]); });
    };
    const unsubscribe = bridge.onChange(status => {
      generation++;
      if (active) setOrganizations(status.requiresLogin ? [] : status.organizations ?? []);
    });
    refresh(); window.addEventListener("focus", refresh);
    return () => { active = false; generation++; unsubscribe(); window.removeEventListener("focus", refresh); };
  }, [bridge]);
  return <OrganizationMembershipDisplay organizations={organizations} compact />;
}
