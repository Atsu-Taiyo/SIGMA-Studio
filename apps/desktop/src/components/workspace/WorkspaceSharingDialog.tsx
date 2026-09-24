"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy, LogIn, Share2, Sparkles, UserRound, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Select } from "@/components/ui/Select";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CatalogMember, CatalogSharingDetails, LibrarySharingTarget, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import { collaborationPlanState } from "@/features/collaboration/model/plan";
import type { MemberRole } from "@/features/collaboration/model/protocol";
import { CollaborationPlanDialog } from "@/features/collaboration/renderer/CollaborationPlanDialog";
import planStyles from "@/features/collaboration/renderer/plan.module.css";
import styles from "@/features/collaboration/renderer/sharing.module.css";

type GrantRole = Exclude<MemberRole, "owner">;
/** The captured target is immutable for the lifetime of this dialog, including OAuth. */
export function WorkspaceSharingDialog({ target, name, onClose, onChanged, startTarget, onOpenDetails }: {
  target: LibrarySharingTarget;
  name: string;
  onClose: () => void;
  onChanged: () => void;
  startTarget?: () => Promise<void>;
  onOpenDetails?: () => void;
}) {
  const t = useT("chrome");
  const [desktop] = useState(getDesktopBridge);
  const catalog = desktop?.sharedCatalog;
  const auth = desktop?.collaboration;
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [status, setStatus] = useState<SharedCatalogStatus | null>(null);
  const [details, setDetails] = useState<CatalogSharingDetails | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [invite, setInvite] = useState<{ token: string; tokenHash: string } | null>(null);
  const [role, setRole] = useState<GrantRole>("editor");
  const [copied, setCopied] = useState(false);
  const [confirmation, setConfirmation] = useState<CatalogMember | "stop" | "delete" | "leave" | null>(null);
  const [planOpen, setPlanOpen] = useState(false);
  const generation = useRef(0);
  const alive = useRef(true);
  const attemptedAuth = useRef(false);
  const lastStatusKey = useRef("");
  const actor = useRef<string | null | undefined>(undefined);

  const refresh = useCallback(async () => {
    if (!catalog) return;
    const ticket = ++generation.current;
    const next = await catalog.status();
    if (!alive.current || ticket !== generation.current) return;
    const accountChanged = actor.current !== undefined && actor.current !== next.actorId;
    actor.current = next.actorId;
    lastStatusKey.current = JSON.stringify(next);
    setStatus(next);
    if (accountChanged) { setDetails(null); setInvite(null); setConfirmation(null); setLoaded(false); }
    if (next.state === "signed-out") { setLoaded(true); return; }
    if (!next.actorId) return;
    try {
      const result = await catalog.details(target);
      if (!alive.current || ticket !== generation.current) return;
      setDetails(result);
      setUnavailable(target.source === "shared" && result === null);
      setLoaded(true);
    } catch {
      if (!alive.current || ticket !== generation.current) return;
      if (next.state !== "offline") { setDetails(null); setUnavailable(true); }
      setLoaded(true);
    }
  }, [catalog, target]);

  useEffect(() => {
    alive.current = true;
    const timer = window.setTimeout(() => {
      void auth?.info().then((info) => { if (alive.current) setConfigured(info.configured); }).catch(() => { if (alive.current) setError(true); });
      void refresh().catch(() => { if (alive.current) setError(true); });
    }, 0);
    const unsubscribe = catalog?.onChange((next) => {
      if (JSON.stringify(next) === lastStatusKey.current) return;
      lastStatusKey.current = JSON.stringify(next);
      void refresh().catch(() => { if (alive.current) setError(true); });
    });
    return () => { alive.current = false; window.clearTimeout(timer); unsubscribe?.(); };
  }, [auth, catalog, refresh]);

  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await action(); if (alive.current) { await refresh(); onChanged(); } }
    catch (cause) { if (alive.current && !(cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) setError(true); }
    finally { if (alive.current) setBusy(false); }
  };
  useEffect(() => {
    if (status?.state !== "signed-out" || !configured || !auth || !catalog || attemptedAuth.current) return;
    attemptedAuth.current = true;
    const timer = window.setTimeout(() => {
      setSigningIn(true); setBusy(true);
      void auth.info().then(async (info) => {
        if (!info.configured) throw new Error("UNCONFIGURED");
        await auth.signInWithGoogle();
        await catalog.refresh();
        await refresh();
      }).catch((cause) => {
        if (alive.current && !(cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) setError(true);
      }).finally(() => { if (alive.current) { setSigningIn(false); setBusy(false); } });
    }, 0);
    return () => window.clearTimeout(timer);
  }, [status?.state, configured, auth, catalog, refresh]);

  const online = status?.state === "ready";
  const capabilities = details?.sharing.capabilities;
  const roles = [
    ...(capabilities?.appointAdmin ? [{ value: "admin", label: t("collaboration.admin") }] : []),
    { value: "editor", label: t("collaboration.editor") },
    { value: "viewer", label: t("collaboration.viewer") },
  ];
  const canManageMember = (member: CatalogMember) => member.directRole !== null && member.role !== "owner"
    && (member.role === "admin" ? capabilities?.appointAdmin : capabilities?.manageEditorViewer);
  const dismiss = () => { if (signingIn) { void auth?.cancelSignIn(); onClose(); } else if (!busy) onClose(); };
  const canLeave = details?.sharing.placement === "incoming" && details.members.some((member) => member.userId === status?.actorId && member.directRole !== null);
  const confirmationAllowed = confirmation === "stop" ? capabilities?.stopRootShare
    : confirmation === "delete" ? capabilities?.deleteRootShare
    : confirmation === "leave" ? canLeave
    : confirmation ? canManageMember(confirmation) : false;
  const canStart = target.source === "local" && online && (target.local.kind === "document"
    ? status?.capabilities?.canStartDocumentShare === true
    : status?.capabilities?.canStartHierarchyShare === true);
  const needsUpgrade = target.source === "local" && online && !canStart && status?.capabilities?.hierarchySharingEnabled === true;
  const plan = collaborationPlanState(status?.capabilities);
  return <><ModalFrame open onDismiss={dismiss} size="sm">
    <ModalHeader title={t("collaboration.settingsTitle")} onClose={dismiss} />
    <ModalBody><Stack gap="lg">
      <Inline gap="sm"><Share2 size={18} /><strong>{details?.name ?? name}</strong></Inline>
      {!catalog || !auth || configured === false ? <p>{t("collaboration.unconfigured")}</p>
        : configured === null ? <Shimmer>{t("collaboration.working")}</Shimmer>
        : status?.state === "signed-out" ? <Stack gap="sm">
          <Button disabled={busy} onClick={() => {
            setSigningIn(true);
            void run(async () => { await auth.signInWithGoogle(); await catalog.refresh(); }).finally(() => { if (alive.current) setSigningIn(false); });
          }}><LogIn size={16} />{signingIn ? t("collaboration.waitingForGoogle") : t("collaboration.signInWithGoogle")}</Button>
          {signingIn && <Button tone="ghost" onClick={() => void auth.cancelSignIn()}>{t("collaboration.cancel")}</Button>}
        </Stack>
        : !loaded ? <Shimmer>{t("collaboration.working")}</Shimmer>
        : unavailable ? <p role="alert">{t("collaboration.unavailableTarget")}</p>
        : confirmation ? <Stack gap="md">
          <p>{typeof confirmation === "string" ? t("collaboration.confirmEnd") : t("collaboration.confirmRemove")}</p>
          {typeof confirmation !== "string" && <p>{confirmation.email}</p>}
          <Inline gap="sm"><Button disabled={busy} onClick={() => setConfirmation(null)}>{t("collaboration.cancel")}</Button>
            <Button tone="danger" disabled={busy || !online || !confirmationAllowed} onClick={() => void run(async () => {
              if (!details) return;
              if (typeof confirmation === "string") await catalog.end(details.target, confirmation);
              else await catalog.changeMember(details.target, confirmation.userId, null);
              setConfirmation(null); setInvite(null);
            })}>{typeof confirmation === "string" ? t(`collaboration.${confirmation}`) : t("collaboration.remove")}</Button>
          </Inline>
        </Stack>
        : details ? <Stack gap="lg">
          <Inline gap="sm"><span>{t(`collaboration.${details.sharing.role}`)}</span><span className={styles.caption}>{t("collaboration.sharedBadge")}</span></Inline>
          {status?.state === "offline" && <p role="status">{t("collaboration.offlineHierarchy")}</p>}
          {!capabilities?.manageEditorViewer && !capabilities?.appointAdmin && <p className={styles.caption}>{t("collaboration.readOnlySharing")}</p>}
          <Stack gap="sm">
            <span className={styles.caption}>{t("collaboration.members")}</span>
            {details.members.map((member) => <Inline key={`${member.userId}:${member.direct}`} gap="sm">
              <UserRound size={16} /><Stack gap="xs" className={styles.member}>
                <span>{member.userId === status?.actorId ? t("collaboration.me") : member.email}</span>
                <span className={styles.caption}>{t("collaboration.effectiveRole", { role: t(`collaboration.${member.role}`) })}</span>
                {member.inheritanceSources.map((source) => <span key={source.catalogNodeId} className={styles.caption}>{t("collaboration.inheritedFrom", { name: source.name, role: t(`collaboration.${source.role}`) })}</span>)}
                {member.hasHiddenInheritance && <span className={styles.caption}>{t("collaboration.inherited")}</span>}
                {member.directRole && <span className={styles.caption}>{t("collaboration.direct")}</span>}
              </Stack>
              {canManageMember(member) ? <Select value={member.directRole ?? member.role} disabled={busy || !online}
                aria-label={`${member.email} ${t("collaboration.members")}`}
                options={[...roles, { value: "remove", label: t("collaboration.remove") }]}
                onChange={(value) => { if (value === "remove") setConfirmation(member); else void run(() => catalog.changeMember(details.target, member.userId, value as GrantRole)); }} />
                : <span className={styles.caption}>{t(`collaboration.${member.role}`)}</span>}
            </Inline>)}
          </Stack>
          {capabilities?.invite && <Stack gap="sm">
            <Inline gap="sm"><Select aria-label={t("collaboration.invitation")} value={role} options={roles} disabled={busy || !online}
              onChange={(value) => setRole(value as GrantRole)} />
              <Button disabled={busy || !online} onClick={() => void run(async () => { setInvite(await catalog.invite(details.target, role === "admin" && !capabilities.appointAdmin ? "editor" : role)); setCopied(false); })}>{t("collaboration.createInvitation")}</Button>
            </Inline>
            {invite && <><Inline gap="sm"><input className={styles.code} aria-label={t("collaboration.invitation")} readOnly value={invite.token} />
              <IconButton label={t(copied ? "collaboration.copied" : "collaboration.copyInvitation")} onClick={() => void run(async () => { await navigator.clipboard.writeText(invite.token); setCopied(true); })}>{copied ? <Check size={16} /> : <Copy size={16} />}</IconButton>
              <IconButton label={t("collaboration.revokeInvitation")} disabled={busy || !online} onClick={() => void run(async () => { await catalog.revokeInvitation(details.target, invite.tokenHash); setInvite(null); })}><X size={16} /></IconButton>
            </Inline><span className={styles.caption}>{t("collaboration.expires")}</span></>}
          </Stack>}
          {canLeave && <Button tone="ghost" disabled={busy || !online} onClick={() => setConfirmation("leave")}>{t("collaboration.leave")}</Button>}
          {(capabilities?.stopRootShare || capabilities?.deleteRootShare) && <Inline gap="sm">
            {capabilities.stopRootShare && <Button tone="ghost" disabled={busy || !online} onClick={() => setConfirmation("stop")}>{t("collaboration.stop")}</Button>}
            {capabilities.deleteRootShare && <Button tone="ghost" disabled={busy || !online} onClick={() => setConfirmation("delete")}>{t("collaboration.delete")}</Button>}
          </Inline>}
        </Stack> : <Stack gap="sm">
          <p>{t("collaboration.localTarget")}</p>
          {target.source === "local" && target.local.kind !== "document" && <p className={styles.caption}>{t("collaboration.confirmStartDescription")}</p>}
          {needsUpgrade ? <>
            <p className={planStyles.upsellText}>{t(target.source === "local" && target.local.kind === "document" ? "collaboration.plan.documentLimit" : "collaboration.plan.hierarchyRequired")}</p>
            <Button tone="primary" disabled={busy} onClick={() => setPlanOpen(true)}><Sparkles size={16} aria-hidden="true" />{t("collaboration.plan.viewPlan")}</Button>
          </> : <Button tone="primary" disabled={busy || !canStart} onClick={() => void run(async () => { if (startTarget) await startTarget(); else if (target.source === "local") await catalog.start(target.local); })}>{t("collaboration.start")}</Button>}
          {status?.state === "offline" && <p role="status">{t("collaboration.offlineHierarchy")}</p>}
          {online && !canStart && !needsUpgrade && <p>{t("collaboration.startUnavailable")}</p>}
        </Stack>}
      {details && onOpenDetails && <Button tone="ghost" disabled={busy} onClick={onOpenDetails}>{t("collaboration.details")}</Button>}
      {busy && <Shimmer>{t("collaboration.working")}</Shimmer>}
      {error && <p role="alert" className={styles.error}>{t("collaboration.error")}</p>}
    </Stack></ModalBody>
  </ModalFrame>
  {planOpen && needsUpgrade && plan !== "unavailable" && <CollaborationPlanDialog billingAvailable={status?.capabilities?.billingAvailable} plan={plan} reason={target.source === "local" && target.local.kind === "document" ? "documentLimit" : "hierarchyShare"} layer="nested" onClose={() => setPlanOpen(false)} />}
  </>;
}
