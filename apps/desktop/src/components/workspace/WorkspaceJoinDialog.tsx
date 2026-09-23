"use client";
import { useEffect, useRef, useState } from "react";
import { UserRoundPlus } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Stack } from "@/components/ui/layout";
import { Shimmer } from "@/components/ui/Shimmer";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { SharedCatalogBridge } from "@/lib/runtime/shared-catalog";
import styles from "@/features/collaboration/renderer/sharing.module.css";
export function WorkspaceJoinDialog({ onClose, onJoined }: {
  onClose: () => void;
  onJoined: (result: Awaited<ReturnType<SharedCatalogBridge["join"]>>) => void;
}) {
  const t = useT("chrome");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState(false);
  const alive = useRef(true);
  const [desktop] = useState(getDesktopBridge);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const close = () => { if (signingIn) { void desktop?.collaboration?.cancelSignIn(); onClose(); } else if (!busy) onClose(); };
  const join = async () => {
    const catalog = desktop?.sharedCatalog, auth = desktop?.collaboration;
    if (!catalog || !auth || busy || !token.trim()) return;
    const capturedToken = token.trim();
    setBusy(true); setError(false);
    try {
      const info = await auth.info();
      if (!info.user) { setSigningIn(true); await auth.signInWithGoogle(); if (alive.current) setSigningIn(false); }
      if (!alive.current) return;
      await catalog.refresh();
      const joined = await catalog.join(capturedToken);
      if (alive.current) onJoined(joined);
    } catch (cause) {
      if (alive.current && !(cause instanceof Error && cause.message.includes("AUTH_CANCELLED"))) setError(true);
    } finally { if (alive.current) { setBusy(false); setSigningIn(false); } }
  };
  return <ModalFrame open onDismiss={close} size="sm"><ModalHeader title={t("collaboration.join")} onClose={close} />
    <ModalBody><Stack gap="md">
      <label className={styles.field}>{t("collaboration.invitation")}<input data-modal-initial-focus value={token} disabled={busy}
        onChange={(event) => setToken(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void join(); } }} /></label>
      <Button disabled={busy || !token.trim() || !desktop?.sharedCatalog} onClick={() => void join()}><UserRoundPlus size={16} />{t("collaboration.join")}</Button>
      {busy && <Shimmer>{t(signingIn ? "collaboration.waitingForGoogle" : "collaboration.working")}</Shimmer>}
      {signingIn && <Button tone="ghost" onClick={() => void desktop?.collaboration?.cancelSignIn()}>{t("collaboration.cancel")}</Button>}
      {error && <p role="alert">{t("collaboration.error")}</p>}
    </Stack></ModalBody>
  </ModalFrame>;
}
