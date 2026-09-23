"use client";

import { LogIn, LogOut } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CollaborationInfo } from "../model/bridge";
import { CollaborationProfileAvatar, collaborationProfileLabel } from "./CollaborationProfileAvatar";
import styles from "./sharing.module.css";

export function CollaborationAccountControl({ info, refresh }: {
  info: CollaborationInfo;
  refresh: () => Promise<void>;
}) {
  const t = useT("chrome");
  const bridge = getDesktopBridge()?.collaboration;
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
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
  return (
    <div className={styles.account} ref={root}>
      <button
        ref={accountButton}
        type="button"
        className={styles.accountButton}
        title={name}
        aria-label={t("collaboration.accountLabel", { name })}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <CollaborationProfileAvatar profile={info.user} label={name} />
      </button>
      {open && (
        <div className={styles.accountMenu} role="dialog" aria-label={t("collaboration.accountLabel", { name })}>
          <strong>{name}</strong>
          {info.user.email && info.user.email !== name ? <span>{info.user.email}</span> : null}
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
