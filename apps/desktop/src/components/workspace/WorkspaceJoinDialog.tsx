"use client";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CatalogSharingDetails, SharedCatalogBridge } from "@/lib/runtime/shared-catalog";
import type { SharedLink } from "@/features/collaboration/model/share-link";
import { invitationToken, parseShareLink } from "@/features/collaboration/model/share-link";
import styles from "@/features/collaboration/renderer/sharing.module.css";

type JoinError = "failed" | "participantLimit";

export function WorkspaceJoinDialog({ onClose, onJoined, initialValue = "" }: {
  initialValue?: string;
  onClose: () => void;
  onJoined: (result: Awaited<ReturnType<SharedCatalogBridge["join"]>>, location?: SharedLink["location"]) => void | Promise<void>;
}) {
  const t = useT("chrome");
  const [token, setToken] = useState(initialValue);
  const [reviewedToken, setReviewedToken] = useState<string | null>(null);
  const reviewed = reviewedToken === token.trim();
  const [preview, setPreview] = useState<{ input: string; details: CatalogSharingDetails | null } | null>(null);
  const memberLink = parseShareLink(token);
  const openingItem = Boolean(memberLink && !memberLink.token);
  const [busy, setBusy] = useState(false);
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<JoinError | null>(null);
  const alive = useRef(true);
  const [desktop] = useState(getDesktopBridge);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  // Only retrieve metadata the current account can already access. Never join or
  // sign in merely to display a link, and never infer its sender from URL text.
  useEffect(() => {
    const input = token.trim();
    const link = parseShareLink(input);
    // An invitation's claimed target is not proof that its opaque token belongs
    // to that target. Do not use it to present an owner as verified.
    if (!link || link.token || !desktop?.sharedCatalog || !desktop.collaboration) return;
    let disposed = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        const info = await desktop.collaboration!.info();
        if (!info.user || disposed) return null;
        const details = await desktop.sharedCatalog!.details({ source: "shared", shared: link.target });
        if (details?.target.kind !== link.target.kind || details.target.catalogNodeId !== link.target.catalogNodeId) return null;
        return details;
      })().catch(() => null).then(details => {
        if (!disposed) setPreview({ input, details });
      });
    }, 200);
    return () => { disposed = true; window.clearTimeout(timer); };
  }, [desktop, token]);
  const details = preview?.input === token.trim() ? preview.details : null;
  const owner = details?.members.find(member => member.userId === details.sharing.ownerId);
  const close = () => { if (signingIn) { void desktop?.collaboration?.cancelSignIn(); onClose(); } else if (!busy) onClose(); };
  const join = async () => {
    const catalog = desktop?.sharedCatalog, auth = desktop?.collaboration;
    if (!catalog || !auth || busy || !token.trim() || !reviewed) return;
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
  return <ModalFrame open onDismiss={close} size="sm">
    <ModalHeader title={t(openingItem ? "collaboration.openSharedItem" : "collaboration.join")} description={t("collaboration.joinDescription")} onClose={close} />
    <ModalBody><Stack gap="lg">
      <input className={styles.code} aria-label={t("collaboration.invitationLinkOrCode")} placeholder={t("collaboration.invitationLinkOrCode")}
        value={token} disabled={busy} spellCheck={false} autoComplete="off"
        onChange={(event) => { setToken(event.target.value); setReviewedToken(null); }} />
      <Stack gap="sm">
        <strong>{t("collaboration.checkSharedSource")}</strong>
        {memberLink && <p className={styles.message}>{t("collaboration.sharedTarget", { kind: t(`collaboration.targetKind.${memberLink.target.kind}`), id: memberLink.target.catalogNodeId })}</p>}
        {details && <p className={styles.message}>{t("collaboration.sharedName", { name: details.name })}</p>}
        <p className={styles.message}>{owner ? t("collaboration.sharedOwner", { owner: owner.email }) : t("collaboration.sharedOwnerUnknown")}</p>
        <p className={styles.message}>{t("collaboration.sharedSourceWarning")}</p>
        <label className={styles.message}>
          <input type="checkbox" checked={reviewed} disabled={busy} onChange={event => setReviewedToken(event.target.checked ? token.trim() : null)} />
          {t("collaboration.sharedSourceReviewed")}
        </label>
      </Stack>
      {signingIn && <Inline gap="sm" justify="between">
        <span className={`${styles.message} ui-shimmer-text`}>{t("collaboration.waitingForGoogle")}</span>
        <Button tone="ghost" size="sm" onClick={() => void desktop?.collaboration?.cancelSignIn()}>{t("collaboration.cancel")}</Button>
      </Inline>}
      {error && <p role="alert" className={styles.error}>{t(error === "participantLimit" ? "collaboration.joinParticipantLimit" : "collaboration.error")}</p>}
      <Inline justify="end" gap="sm">
        <Button data-modal-initial-focus tone="secondary" disabled={busy && !signingIn} onClick={close}>{t("collaboration.cancel")}</Button>
        <Button tone="primary" disabled={busy || !token.trim() || !reviewed || !desktop?.sharedCatalog} onClick={() => void join()}>{t(openingItem ? "collaboration.openSharedItem" : "collaboration.joinAction")}</Button>
      </Inline>
    </Stack></ModalBody>
  </ModalFrame>;
}
