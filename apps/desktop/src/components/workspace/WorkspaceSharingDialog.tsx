"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Copy, Share2, X } from "lucide-react";
import { Button, IconButton } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Select, type SelectOption } from "@/components/ui/Select";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { Translate } from "@/lib/i18n/translator";
import type { CatalogMember, CatalogSharingDetails, LibrarySharingTarget, SharedCatalogStatus } from "@/lib/runtime/shared-catalog";
import {
  collaborationPlanState,
  freeParticipantSeatTaken,
  planPaywallReasonFromError,
  type PlanPaywallReason,
} from "@/features/collaboration/model/plan";
import type { MemberRole } from "@/features/collaboration/model/protocol";
import { CollaborationPlanDialog } from "@/features/collaboration/renderer/CollaborationPlanDialog";
import styles from "@/features/collaboration/renderer/sharing.module.css";

type GrantRole = Exclude<MemberRole, "owner">;
type Attempt = Parameters<typeof planPaywallReasonFromError>[1];
const REMOVE = "remove";

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
  const [paywall, setPaywall] = useState<PlanPaywallReason | null>(null);
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

  /**
   * A plan limit is not an error to report under the form: the paywall opens
   * at once and says what the plan did not allow.
   */
  const run = async (action: () => Promise<unknown>, attempted?: Attempt) => {
    if (busy) return;
    setBusy(true); setError(false);
    try { await action(); if (alive.current) { await refresh(); onChanged(); } }
    catch (cause) {
      if (!alive.current || (cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) return;
      const reason = attempted ? planPaywallReasonFromError(cause, attempted) : null;
      if (reason) setPaywall(reason); else setError(true);
    }
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
  const plan = collaborationPlanState(status?.capabilities);
  const isDocument = target.source === "local" ? target.local.kind === "document" : details?.target.kind === "document";
  // Free owners see the admin role as a Pro option; choosing it opens the paywall.
  const adminLocked = !capabilities?.appointAdmin && details?.sharing.role === "owner" && plan === "free";
  const roleOptions: SelectOption[] = [
    ...(capabilities?.appointAdmin ? [{ value: "admin", label: t("collaboration.admin") }] : []),
    ...(adminLocked ? [{ value: "admin", label: t("collaboration.admin"), content: <ProOption label={t("collaboration.admin")} badge={t("collaboration.proBadge")} /> }] : []),
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
  const startReason: PlanPaywallReason = isDocument ? "documentLimit" : "hierarchyShare";
  const startAttempt: Attempt = isDocument ? "documentShare" : "hierarchyShare";
  const paywallPlan = plan === "unavailable" ? null : plan;

  const chooseRole = (value: string, apply: (role: GrantRole) => void) => {
    if (value === "admin" && adminLocked) { setPaywall("adminRole"); return; }
    apply(value as GrantRole);
  };
  const createInvitation = () => {
    if (!details || !capabilities) return;
    if (freeParticipantSeatTaken(status?.capabilities, details.members)) { setPaywall("participantLimit"); return; }
    void run(async () => {
      setInvite(await catalog!.invite(details.target, role === "admin" && !capabilities.appointAdmin ? "editor" : role));
      setCopied(false);
    }, "invite");
  };
  const startSharing = () => {
    if (needsUpgrade) { setPaywall(startReason); return; }
    void run(async () => { if (startTarget) await startTarget(); else if (target.source === "local") await catalog!.start(target.local); }, startAttempt);
  };

  // Trying to share what the plan does not allow opens the paywall directly.
  // The sharing dialog would only have repeated the same limit in words.
  const blockedStart = loaded && !details && !unavailable && !confirmation && needsUpgrade && paywallPlan !== null;
  if (blockedStart && paywallPlan) {
    return <CollaborationPlanDialog billingAvailable={status?.capabilities?.billingAvailable} plan={paywallPlan} reason={startReason} onClose={onClose} />;
  }

  const title = t("collaboration.shareTitle", { name: details?.name ?? name });
  const body = !catalog || !auth || configured === false ? <p className={styles.message}>{t("collaboration.unconfigured")}</p>
    : configured === null ? <SharingSkeleton />
    : status?.state === "signed-out" ? <Stack gap="md">
      <p className={styles.message}>{t("collaboration.signInRequired")}</p>
      <Button className={styles.googleButton} disabled={busy} onClick={() => {
        setSigningIn(true);
        void run(async () => { await auth.signInWithGoogle(); await catalog.refresh(); }).finally(() => { if (alive.current) setSigningIn(false); });
      }}><span className={styles.googleMark} aria-hidden="true" />{signingIn ? t("collaboration.waitingForGoogle") : t("collaboration.signInWithGoogle")}</Button>
      {signingIn && <Button tone="ghost" onClick={() => void auth.cancelSignIn()}>{t("collaboration.cancel")}</Button>}
    </Stack>
    : !loaded ? <SharingSkeleton />
    : unavailable ? <p role="alert" className={styles.message}>{t("collaboration.unavailableTarget")}</p>
    : confirmation ? <Stack gap="lg">
      <Stack gap="xs">
        <p className={styles.confirmTitle}>{typeof confirmation === "string" ? t("collaboration.confirmEnd") : t("collaboration.confirmRemove")}</p>
        <p className={styles.caption}>{typeof confirmation === "string" ? t("collaboration.endDescription") : confirmation.email}</p>
      </Stack>
      <Inline gap="sm" justify="end">
        <Button disabled={busy} onClick={() => setConfirmation(null)}>{t("collaboration.cancel")}</Button>
        <Button tone="danger" disabled={busy || !online || !confirmationAllowed} onClick={() => void run(async () => {
          if (!details) return;
          if (typeof confirmation === "string") await catalog.end(details.target, confirmation);
          else await catalog.changeMember(details.target, confirmation.userId, null);
          setConfirmation(null); setInvite(null);
        })}>{typeof confirmation === "string" ? t(`collaboration.${confirmation}`) : t("collaboration.remove")}</Button>
      </Inline>
    </Stack>
    : details ? <Stack gap="xl">
      {status?.state === "offline" && <p role="status" className={styles.notice}>{t("collaboration.offlineHierarchy")}</p>}
      {capabilities?.invite && <section className={styles.section} aria-label={t("collaboration.inviteHeading")}>
        <h3 className={styles.sectionTitle}>{t("collaboration.inviteHeading")}</h3>
        <div className={styles.inviteRow}>
          <Select className={styles.roleField} aria-label={t("collaboration.inviteRole")} value={role} options={roleOptions}
            disabled={busy || !online} menuWidth="auto" onChange={(value) => chooseRole(value, setRole)} />
          <Button tone="primary" disabled={busy || !online} onClick={createInvitation}>{t("collaboration.createInvitation")}</Button>
        </div>
        {invite && <Stack gap="xs">
          <div className={styles.codeRow}>
            <input className={styles.code} aria-label={t("collaboration.invitation")} readOnly value={invite.token} onFocus={(event) => event.currentTarget.select()} />
            <IconButton size="sm" tone="ghost" label={t(copied ? "collaboration.copied" : "collaboration.copyInvitation")} onClick={() => void run(async () => { await navigator.clipboard.writeText(invite.token); setCopied(true); })}>{copied ? <Check size={15} /> : <Copy size={15} />}</IconButton>
            <IconButton size="sm" tone="ghost" label={t("collaboration.revokeInvitation")} disabled={busy || !online} onClick={() => void run(async () => { await catalog.revokeInvitation(details.target, invite.tokenHash); setInvite(null); })}><X size={15} /></IconButton>
          </div>
          <span className={styles.caption}>{t("collaboration.expires")}</span>
        </Stack>}
      </section>}
      <section className={styles.section} aria-label={t("collaboration.members")}>
        <h3 className={styles.sectionTitle}>{t("collaboration.members")}<span className={styles.count}>{details.members.length}</span></h3>
        {!capabilities?.manageEditorViewer && !capabilities?.appointAdmin && <p className={styles.caption}>{t("collaboration.readOnlySharing")}</p>}
        <ul className={styles.memberList}>
          {details.members.map((member) => <MemberRow key={`${member.userId}:${member.direct}`} member={member} me={member.userId === status?.actorId} t={t}
            control={canManageMember(member) ? <Select className={styles.roleSelect} value={member.directRole ?? member.role} disabled={busy || !online} menuWidth="auto"
              aria-label={t("collaboration.memberRole", { name: member.email })}
              options={[...roleOptions, { value: REMOVE, label: t("collaboration.remove"), style: { color: "var(--danger)" } }]}
              onChange={(value) => {
                if (value === REMOVE) setConfirmation(member);
                else chooseRole(value, (next) => void run(() => catalog.changeMember(details.target, member.userId, next), "adminRole"));
              }} /> : null} />)}
        </ul>
      </section>
      {(onOpenDetails || canLeave || capabilities?.stopRootShare || capabilities?.deleteRootShare) && <div className={styles.footer}>
        {onOpenDetails ? <Button tone="ghost" size="sm" disabled={busy} onClick={onOpenDetails}>{t("collaboration.details")}</Button> : <span />}
        <Inline gap="xs">
          {canLeave && <Button tone="ghost" size="sm" className={styles.dangerText} disabled={busy || !online} onClick={() => setConfirmation("leave")}>{t("collaboration.leave")}</Button>}
          {capabilities?.stopRootShare && <Button tone="ghost" size="sm" className={styles.dangerText} disabled={busy || !online} onClick={() => setConfirmation("stop")}>{t("collaboration.stop")}</Button>}
          {capabilities?.deleteRootShare && <Button tone="ghost" size="sm" className={styles.dangerText} disabled={busy || !online} onClick={() => setConfirmation("delete")}>{t("collaboration.delete")}</Button>}
        </Inline>
      </div>}
    </Stack>
    : <Stack gap="lg">
      <div className={styles.startState}>
        <span className={styles.startIcon} aria-hidden="true"><Share2 size={20} /></span>
        <strong>{t("collaboration.localTarget")}</strong>
        {target.source === "local" && target.local.kind !== "document" && <span className={styles.caption}>{t("collaboration.confirmStartDescription")}</span>}
      </div>
      {status?.state === "offline" && <p role="status" className={styles.notice}>{t("collaboration.offlineHierarchy")}</p>}
      <Button tone="primary" size="lg" className={styles.wide} disabled={busy || !online || (!canStart && !needsUpgrade)} onClick={startSharing}>{t("collaboration.start")}</Button>
      {online && !canStart && !needsUpgrade && <p className={styles.caption}>{t("collaboration.startUnavailable")}</p>}
    </Stack>;

  return <><ModalFrame open onDismiss={dismiss} size="sm">
    <ModalHeader title={title} onClose={dismiss} />
    <ModalBody><Stack gap="lg">
      {body}
      {error && <p role="alert" className={styles.error}>{t("collaboration.error")}</p>}
    </Stack></ModalBody>
  </ModalFrame>
  {paywall && paywallPlan && <CollaborationPlanDialog billingAvailable={status?.capabilities?.billingAvailable} plan={paywallPlan} reason={paywall} layer="nested" onClose={() => setPaywall(null)} />}
  </>;
}

function MemberRow({ member, me, control, t }: { member: CatalogMember; me: boolean; control: ReactNode; t: Translate<"chrome"> }) {
  // The role is shown once: as the menu when it can be changed, otherwise as text.
  // Inheritance is only mentioned when it is where the access comes from.
  const inheritance = member.inheritanceSources.map((source) => t("collaboration.inheritedFrom", { name: source.name, role: t(`collaboration.${source.role}`) }));
  if (member.hasHiddenInheritance) inheritance.push(t("collaboration.inherited"));
  return <li className={styles.memberRow}>
    <span className={styles.memberAvatar} aria-hidden="true">{(member.email.trim()[0] ?? "?").toUpperCase()}</span>
    <span className={styles.memberText}>
      <span className={styles.memberName}>{member.email}{me && <span className={styles.meTag}>{t("collaboration.me")}</span>}</span>
      {inheritance.length > 0 && <span className={styles.caption}>{inheritance.join(" · ")}</span>}
    </span>
    {control ?? <span className={styles.roleText}>{t(`collaboration.${member.role}`)}</span>}
  </li>;
}

function ProOption({ label, badge }: { label: string; badge: string }) {
  return <span className={styles.proOption}>{label}<span className={styles.proBadge}>{badge}</span></span>;
}

/** Keeps the dialog's final shape while status and members load. */
function SharingSkeleton() {
  return <div className={styles.skeleton} aria-hidden="true">
    <span className="ui-shimmer-surface" />
    <span className="ui-shimmer-surface" />
    <span className="ui-shimmer-surface" />
  </div>;
}
