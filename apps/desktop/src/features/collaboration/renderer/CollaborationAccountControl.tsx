"use client";

import { LogIn, LogOut, Sparkles } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CollaborationInfo } from "../model/bridge";
import type { ServerCollaborationCapabilities } from "../model/catalog";
import { collaborationPlanState } from "../model/plan";
import { CollaborationPlanDialog } from "./CollaborationPlanDialog";
import { CollaborationProfileAvatar, collaborationProfileLabel } from "./CollaborationProfileAvatar";
import planStyles from "./plan.module.css";
import styles from "./sharing.module.css";

export function CollaborationAccountControl({ info, refresh }: {
  info: CollaborationInfo;
  refresh: () => Promise<void>;
}) {
  const t = useT("chrome");
  const bridge = getDesktopBridge()?.collaboration;
  const catalog = getDesktopBridge()?.sharedCatalog;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [capabilities, setCapabilities] = useState<ServerCollaborationCapabilities>();
  const [recovered, setRecovered] = useState<{ saved: number; failed: number } | null>(null);
  const [locked, setLocked] = useState<{ actorId: string; count: number } | null>(null);
  const actorId = info.user?.actorId;
  const [planOpen, setPlanOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const accountButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", close);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        accountButton.current?.focus();
      }
    };
    window.addEventListener("keydown", escape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", escape);
    };
  }, [open]);
  useEffect(() => {
    if (!catalog) return;
    const refreshPlan = () => { void catalog.refresh().catch(() => {}); };
    window.addEventListener("focus", refreshPlan);
    const unsubscribe = catalog.onChange(status => setCapabilities(status.capabilities));
    return () => { unsubscribe(); window.removeEventListener("focus", refreshPlan); };
  }, [catalog]);
  useEffect(() => {
    if (!open || !actorId || !catalog?.lockedDocumentCount) return;
    let generation = 0;
    const update = () => {
      const request = ++generation;
      void catalog.lockedDocumentCount!().then(count => {
        if (request === generation) setLocked({ actorId, count });
      }).catch(() => { if (request === generation) setLocked(null); });
    };
    update();
    const unsubscribe = catalog.onChange(update);
    window.addEventListener("focus", update);
    return () => { generation++; unsubscribe(); window.removeEventListener("focus", update); };
  }, [open, actorId, catalog]);
  if (!bridge || !info.configured) return null;
  if (!info.user) {
    return <div className={styles.accountControl}>
        <Button
          size="sm"
          tone="ghost"
          className={styles.loginButton}
          disabled={busy}
          onClick={() => {
            setBusy(true);
            setError(false);
            void bridge.signInWithGoogle()
              .then(refresh)
              .catch((cause: unknown) => {
                if (!(cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) setError(true);
              })
              .finally(() => setBusy(false));
          }}
        >
          <LogIn size={15} aria-hidden="true" />
          {busy ? t("collaboration.waitingForGoogle") : t("collaboration.login")}
        </Button>
        {error && <span className={styles.authError} role="alert">{t("collaboration.error")}</span>}
      </div>;
  }
  const name = collaborationProfileLabel(info.user, t("collaboration.googleAccount"));
  const plan = collaborationPlanState(capabilities);
  // Plan display follows the server's hierarchy entitlement; a failed read only hides it.
  const loadPlan = () => {
    if (!catalog) return;
    void catalog.refresh()
      .then((status) => setCapabilities(status.capabilities))
      .catch(() => setCapabilities(undefined));
  };
  return (
    <div className={styles.account} ref={root}>
      <button
        ref={accountButton}
        type="button"
        className={styles.accountButton}
        title={name}
        aria-label={t("collaboration.accountLabel", { name })}
        aria-expanded={open}
        onClick={() => {
          if (!open) { setLocked(null); setRecovered(null); loadPlan(); }
          setOpen(!open);
        }}
      >
        <CollaborationProfileAvatar profile={info.user} label={name} />
      </button>
      {open && (
        <div className={styles.accountMenu} role="dialog" aria-label={t("collaboration.accountLabel", { name })}>
          <strong>{name}</strong>
          {capabilities?.paymentWarning && <p role="alert">{t("collaboration.plan.paymentWarning")}</p>}
          {locked && locked.actorId === actorId && locked.count > 0 && <Button tone="ghost" disabled={busy} onClick={() => {
            setBusy(true); setError(false); setRecovered(null);
            void catalog?.recoverLocked().then(async result => {
              setRecovered(result);
              const count = await catalog.lockedDocumentCount?.();
              setLocked(count === undefined || !actorId ? null : { actorId, count });
              await refresh();
            }).catch(() => setError(true)).finally(() => setBusy(false));
          }}>{t("collaboration.plan.recovery")}</Button>}
          {recovered && <p role="status">{t("collaboration.plan.recovered", recovered)}</p>}
          {info.user.email && info.user.email !== name ? <span>{info.user.email}</span> : null}
          {plan !== "unavailable" && (
            <Stack gap="xs" className={planStyles.menuPlan}>
              <span>{t(`collaboration.plan.menuLabel.${plan}`)}</span>
              <Button
                size="sm"
                tone="ghost"
                onClick={() => {
                  setOpen(false);
                  setPlanOpen(true);
                }}
              >
                <Sparkles size={15} aria-hidden="true" />
                {t(plan === "free" ? "collaboration.plan.upgrade" : "collaboration.plan.viewPlan")}
              </Button>
            </Stack>
          )}
          <Button
            size="sm"
            tone="ghost"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              setError(false);
              void bridge.signOut()
                .then(refresh)
                .then(() => setOpen(false))
                .catch(() => setError(true))
                .finally(() => setBusy(false));
            }}
          >
            <LogOut size={15} aria-hidden="true" />
            {t("collaboration.signOut")}
          </Button>
          {error && <span className={styles.error} role="alert">{t("collaboration.error")}</span>}
        </div>
      )}
      {planOpen && plan !== "unavailable" && (
        <CollaborationPlanDialog billingAvailable={capabilities?.billingAvailable} plan={plan} onClose={() => setPlanOpen(false)} />
      )}
    </div>
  );
}

/** Workspace-route host backed by the same main-process auth authority as the editor. */
export function WorkspaceCollaborationAccount() {
  const bridge = getDesktopBridge()?.collaboration;
  const [info, setInfo] = useState<CollaborationInfo | null>(null);
  const refresh = useCallback(async () => {
    setInfo(bridge ? await bridge.info() : { configured: false, user: null, sessions: [], restrictedFileIds: [] });
  }, [bridge]);
  useEffect(() => {
    let mounted = true;
    if (!bridge) {
      queueMicrotask(() => { if (mounted) setInfo({ configured: false, user: null, sessions: [], restrictedFileIds: [] }); });
    } else {
      void bridge.info().then((next) => { if (mounted) setInfo(next); });
    }
    return () => { mounted = false; };
  }, [bridge]);
  return info ? <CollaborationAccountControl info={info} refresh={refresh} /> : null;
}
