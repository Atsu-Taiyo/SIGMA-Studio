"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { SharedCatalogBridge } from "@/lib/runtime/shared-catalog";
import type { SharedLink } from "@/features/collaboration/model/share-link";
import { invitationToken, parseShareLink } from "@/features/collaboration/model/share-link";
import styles from "@/features/collaboration/renderer/sharing.module.css";

type JoinError = "failed" | "participantLimit";

export function WorkspaceJoinDialog({ onClose, onJoined, initialValue = "", autoSubmit = false }: {
  initialValue?: string;
  autoSubmit?: boolean;
  onClose: () => void;
  onJoined: (result: Awaited<ReturnType<SharedCatalogBridge["join"]>>, location?: SharedLink["location"]) => void | Promise<void>;
}) {
  const t = useT("chrome");
  const [token, setToken] = useState(initialValue);
  const memberLink = parseShareLink(token);
  const openingItem = Boolean(memberLink && !memberLink.token);
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
    const link = parseShareLink(capturedToken);
    const invitation = invitationToken(capturedToken);
    setBusy(true); setError(null);
    try {
      if (!link && !invitation) throw new Error("INVALID_LINK");
      const info = await auth.info();
      if (!info.user) { setSigningIn(true); await auth.signInWithGoogle(); if (alive.current) setSigningIn(false); }
      if (!alive.current) return;
      await catalog.refresh();
      const joined = invitation ? await catalog.join(invitation)
        : catalog.openLink && link ? await catalog.openLink(link.target) : (() => { throw new Error("INVALID_LINK"); })();
      if (link && (joined.target.kind !== link.target.kind || joined.target.catalogNodeId !== link.target.catalogNodeId)) throw new Error("TARGET_MISMATCH");
      if (alive.current) {
        if (link?.location) await onJoined(joined, link.location);
        else await onJoined(joined);
      }
    } catch (cause) {
      if (!alive.current || (cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) return;
      // The owner's plan decides the seat count; the invitee cannot upgrade it away.
      setError(cause instanceof Error && cause.message.includes("PARTICIPANT_LIMIT") ? "participantLimit" : "failed");
    } finally { if (alive.current) { setBusy(false); setSigningIn(false); } }
  };
  useEffect(() => {
    if (!autoSubmit) return;
    const timer = window.setTimeout(() => { void join(); }, 0);
    return () => window.clearTimeout(timer);
    // The initial external link is captured once; typing or auth updates must not resubmit it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return <ModalFrame open onDismiss={close} size="sm">
    <ModalHeader title={t(openingItem ? "collaboration.openSharedItem" : "collaboration.join")} description={t("collaboration.joinDescription")} onClose={close} />
    <ModalBody><Stack gap="lg">
      <input className={styles.code} data-modal-initial-focus aria-label={t("collaboration.invitationLinkOrCode")} placeholder={t("collaboration.invitationLinkOrCode")}
        value={token} disabled={busy} spellCheck={false} autoComplete="off"
        onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void join(); } }} />
      {signingIn && <Inline gap="sm" justify="between">
        <span className={`${styles.message} ui-shimmer-text`}>{t("collaboration.waitingForGoogle")}</span>
        <Button tone="ghost" size="sm" onClick={() => void desktop?.collaboration?.cancelSignIn()}>{t("collaboration.cancel")}</Button>
      </Inline>}
      {error && <p role="alert" className={styles.error}>{t(error === "participantLimit" ? "collaboration.joinParticipantLimit" : "collaboration.error")}</p>}
      <Inline justify="end">
        <Button tone="primary" disabled={busy || !token.trim() || !desktop?.sharedCatalog} onClick={() => void join()}>{t(openingItem ? "collaboration.openSharedItem" : "collaboration.joinAction")}</Button>
      </Inline>
    </Stack></ModalBody>
  </ModalFrame>;
}
