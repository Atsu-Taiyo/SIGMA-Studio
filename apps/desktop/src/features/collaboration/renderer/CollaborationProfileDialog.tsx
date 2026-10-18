"use client";

import { ImageUp, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CollaborationProfile, CollaborationProfileRecord } from "../model/bridge";
import { collaborationAvatarSource } from "../model/profile-avatar";
import { prepareAvatarImage, type AvatarImageError, type PreparedAvatarImage } from "./avatar-image";
import styles from "./sharing.module.css";

const MAX_DISPLAY_NAME_LENGTH = 60;

type AvatarChoice = { kind: "keep" } | { kind: "new"; image: PreparedAvatarImage } | { kind: "provider" };

/**
 * 自分の名前とアイコンを変える。保存先は共有サーバーで、見られるのは共有している相手だけ。
 * 名前を空にすると Google の名前へ、「Google のアイコンに戻す」で Google のアイコンへ戻る。
 */
export function CollaborationProfileDialog({ user, onClose, onSaved }: {
  user: CollaborationProfile;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const t = useT("chrome");
  const bridge = getDesktopBridge()?.collaboration;
  const nameId = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [record, setRecord] = useState<CollaborationProfileRecord | null>(null);
  const [name, setName] = useState<string | null>(null);
  const [avatar, setAvatar] = useState<AvatarChoice>({ kind: "keep" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"load" | "save" | AvatarImageError | null>(null);

  useEffect(() => {
    let active = true;
    void bridge?.profile?.().then((value) => {
      if (!active) return;
      setRecord(value);
      setName((current) => current ?? value?.displayName ?? "");
    }).catch(() => { if (active) setError("load"); });
    return () => { active = false; };
  }, [bridge]);
  useEffect(() => () => {
    if (avatar.kind === "new") URL.revokeObjectURL(avatar.image.previewUrl);
  }, [avatar]);

  const providerName = record?.providerDisplayName ?? user.email ?? "";
  const currentSource = collaborationAvatarSource(user);
  const providerSource = record?.providerAvatarUrl
    ? collaborationAvatarSource({ actorId: user.actorId, avatarUrl: record.providerAvatarUrl })
    : undefined;
  const previewSource = avatar.kind === "new" ? avatar.image.previewUrl : avatar.kind === "provider" ? providerSource : currentSource;
  const hasCustomAvatar = avatar.kind === "new" || (avatar.kind === "keep" && (record?.avatarVersion ?? user.avatarVersion ?? 0) > 0);
  const trimmedName = (name ?? "").trim();
  const nameChanged = name !== null && trimmedName !== (record?.displayName ?? "");
  const changed = nameChanged || avatar.kind !== "keep";
  const errorMessage = error === "load" || error === "save"
    ? t(`collaboration.profile.errors.${error}`)
    : error ? t(`collaboration.profile.errors.${error === "too-large" ? "tooLarge" : error}`) : null;

  const save = async () => {
    if (!bridge || !changed) return;
    setBusy(true);
    setError(null);
    try {
      if (nameChanged) await bridge.updateProfile?.({ displayName: trimmedName || null });
      if (avatar.kind === "new") await bridge.setAvatar?.(avatar.image.bytes, avatar.image.type);
      if (avatar.kind === "provider") await bridge.clearAvatar?.();
      await onSaved();
      onClose();
    } catch {
      setError("save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <ModalFrame open onDismiss={onClose} size="sm">
      <ModalHeader title={t("collaboration.profile.title")} description={t("collaboration.profile.description")} onClose={onClose} />
      <ModalBody>
        <Stack gap="xl">
          <Inline gap="lg" align="center" className={styles.profileAvatarRow}>
            <span className={styles.profileAvatarPreview} data-testid="profile-avatar-preview">
              {previewSource
                // eslint-disable-next-line @next/next/no-img-element
                ? <img src={previewSource} alt="" referrerPolicy="no-referrer" />
                : <span aria-hidden="true">{(trimmedName || providerName || "?").slice(0, 1).toUpperCase()}</span>}
            </span>
            <Stack gap="xs">
              <Button size="sm" tone="secondary" disabled={busy} onClick={() => fileInput.current?.click()}>
                <ImageUp size={15} aria-hidden="true" />
                {t("collaboration.profile.chooseImage")}
              </Button>
              {hasCustomAvatar && providerSource !== undefined && (
                <Button size="sm" tone="ghost" disabled={busy} onClick={() => setAvatar({ kind: "provider" })}>
                  <RotateCcw size={14} aria-hidden="true" />
                  {t("collaboration.profile.useGoogleImage")}
                </Button>
              )}
              {hasCustomAvatar && providerSource === undefined && (
                <Button size="sm" tone="ghost" disabled={busy} onClick={() => setAvatar({ kind: "provider" })}>
                  <RotateCcw size={14} aria-hidden="true" />
                  {t("collaboration.profile.removeImage")}
                </Button>
              )}
            </Stack>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              hidden
              aria-label={t("collaboration.profile.chooseImage")}
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                event.currentTarget.value = "";
                if (!file) return;
                setError(null);
                void prepareAvatarImage(file).then((prepared) => {
                  if (typeof prepared === "string") setError(prepared);
                  else setAvatar({ kind: "new", image: prepared });
                });
              }}
            />
          </Inline>
          <label className={styles.field} htmlFor={nameId}>
            <span>{t("collaboration.profile.name")}</span>
            <input
              id={nameId}
              value={name ?? ""}
              maxLength={MAX_DISPLAY_NAME_LENGTH}
              placeholder={providerName}
              disabled={busy || name === null}
              onChange={(event) => setName(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) void save();
              }}
            />
            <small className={styles.profileHint}>{t("collaboration.profile.nameHint")}</small>
          </label>
          <p className={styles.profileHint}>{t("collaboration.profile.visibility")}</p>
          {errorMessage && <p role="alert" className={styles.error}>{errorMessage}</p>}
          <Inline gap="sm" justify="end">
            <Button tone="ghost" disabled={busy} onClick={onClose}>{t("collaboration.profile.cancel")}</Button>
            <Button tone="primary" disabled={busy || !changed} onClick={() => void save()}>
              {busy ? t("collaboration.profile.saving") : t("collaboration.profile.save")}
            </Button>
          </Inline>
        </Stack>
      </ModalBody>
    </ModalFrame>
  );
}
