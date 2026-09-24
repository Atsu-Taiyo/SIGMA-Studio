"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { SharedCatalogBridge } from "@/lib/runtime/shared-catalog";
import styles from "@/features/collaboration/renderer/sharing.module.css";

type JoinError = "failed" | "participantLimit";

export function WorkspaceJoinDialog({ onClose, onJoined }: {
  onClose: () => void;
  onJoined: (result: Awaited<ReturnType<SharedCatalogBridge["join"]>>) => void;
}) {
  const t = useT("chrome");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<JoinError | null>(null);
  const alive = useRef(true);
  const [desktop] = useState(getDesktopBridge);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = () => { if (signingIn) { void desktop?.collaboration?.cancelSignIn(); onClose(); } else if (!busy) onClose(); };
  const join = async () => {
    const catalog = desktop?.sharedCatalog, auth = desktop?.collaboration;
    if (!catalog || !auth || busy || !token.trim()) return;
    const capturedToken = token.trim();
    setBusy(true); setError(null);
    try {
      const info = await auth.info();
      if (!info.user) { setSigningIn(true); await auth.signInWithGoogle(); if (alive.current) setSigningIn(false); }
      if (!alive.current) return;
      await catalog.refresh();
      const joined = await catalog.join(capturedToken);
      if (alive.current) onJoined(joined);
    } catch (cause) {
      if (!alive.current || (cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) return;
      // The owner's plan decides the seat count; the invitee cannot upgrade it away.
      setError(cause instanceof Error && cause.message.includes("PARTICIPANT_LIMIT") ? "participantLimit" : "failed");
    } finally { if (alive.current) { setBusy(false); setSigningIn(false); } }
  };
  return <ModalFrame open onDismiss={close} size="sm">
    <ModalHeader title={t("collaboration.join")} description={t("collaboration.joinDescription")} onClose={close} />
    <ModalBody><Stack gap="lg">
      <input className={styles.code} data-modal-initial-focus aria-label={t("collaboration.invitation")} placeholder={t("collaboration.invitation")}
        value={token} disabled={busy} spellCheck={false} autoComplete="off"
        onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void join(); } }} />
      {signingIn && <Inline gap="sm" justify="between">
        <span className={`${styles.message} ui-shimmer-text`}>{t("collaboration.waitingForGoogle")}</span>
        <Button tone="ghost" size="sm" onClick={() => void desktop?.collaboration?.cancelSignIn()}>{t("collaboration.cancel")}</Button>
      </Inline>}
      {error && <p role="alert" className={styles.error}>{t(error === "participantLimit" ? "collaboration.joinParticipantLimit" : "collaboration.error")}</p>}
      <Inline justify="end">
        <Button tone="primary" disabled={busy || !token.trim() || !desktop?.sharedCatalog} onClick={() => void join()}>{t("collaboration.joinAction")}</Button>
      </Inline>
    </Stack></ModalBody>
  </ModalFrame>;
}
