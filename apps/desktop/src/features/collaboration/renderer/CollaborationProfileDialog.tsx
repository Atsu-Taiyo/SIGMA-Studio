"use client";

import { Crop, ImageUp, RotateCcw } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Inline, Stack } from "@/components/ui/layout";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useT } from "@/lib/i18n/react";
import type { CollaborationProfile, CollaborationProfileRecord } from "../model/bridge";
import type { AvatarCrop } from "../model/avatar-crop";
import { collaborationAvatarSource } from "../model/profile-avatar";
import { loadAvatarSource, renderAvatarImage, type AvatarImageError, type AvatarSource, type PreparedAvatarImage } from "./avatar-image";
import { CollaborationAvatarCropDialog } from "./CollaborationAvatarCropDialog";
import styles from "./sharing.module.css";

const MAX_DISPLAY_NAME_LENGTH = 60;

type AvatarChoice =
  | { kind: "keep" }
  /** 選んで範囲を決めた画像。元の画像と範囲も持ち、選び直さずに範囲を調整し直せる。 */
  | { kind: "new"; image: PreparedAvatarImage; source: AvatarSource; crop: AvatarCrop }
  | { kind: "provider" };

/**
 * 自分の名前とアイコンを変える。保存先は共有サーバーで、見られるのは共有している相手だけ。
 * 名前を空にすると Google の名前へ、「Google のアイコンに戻す」で Google のアイコンへ戻る。
 * 画像を選ぶと、どこをアイコンにするかを決める画面 (`CollaborationAvatarCropDialog`) を重ねて開き、
 * 決めた範囲を 256px 四方に縮めて見本に出す。キャンセルしたら、それまでの選択 (今のアイコンなど) のまま。
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
  const [cropping, setCropping] = useState<{ source: AvatarSource; crop?: AvatarCrop } | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"load" | "save" | AvatarImageError | null>(null);
  const mounted = useRef(false);
  /** このダイアログが作った object URL。今の選択と切り抜く画面のどちらからも使われなくなったら片付ける。 */
  const ownedUrls = useRef(new Set<string>());

  useEffect(() => {
    let active = true;
    void bridge?.profile?.().then((value) => {
      if (!active) return;
      setRecord(value);
      setName((current) => current ?? value?.displayName ?? "");
    }).catch(() => { if (active) setError("load"); });
    return () => { active = false; };
  }, [bridge]);
  useEffect(() => {
    mounted.current = true;
    const urls = ownedUrls.current;
    return () => {
      mounted.current = false;
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, []);
  useEffect(() => {
    const live = new Set<string>();
    if (avatar.kind === "new") {
      live.add(avatar.image.previewUrl);
      live.add(avatar.source.url);
    }
    if (cropping) live.add(cropping.source.url);
    for (const url of ownedUrls.current) {
      if (live.has(url)) continue;
      URL.revokeObjectURL(url);
      ownedUrls.current.delete(url);
    }
  }, [avatar, cropping]);

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

  const chooseFile = (file: File) => {
    setError(null);
    setPreparing(true);
    void loadAvatarSource(file).then((loaded) => {
      if (!mounted.current) {
        if (typeof loaded !== "string") URL.revokeObjectURL(loaded.url);
        return;
      }
      setPreparing(false);
      if (typeof loaded === "string") {
        setError(loaded);
        return;
      }
      ownedUrls.current.add(loaded.url);
      setCropping({ source: loaded });
    });
  };

  const applyCrop = async (source: AvatarSource, crop: AvatarCrop) => {
    const rendered = await renderAvatarImage(source, crop);
    if (!mounted.current) {
      if (typeof rendered !== "string") URL.revokeObjectURL(rendered.previewUrl);
      return;
    }
    if (typeof rendered === "string") setError(rendered);
    else {
      ownedUrls.current.add(rendered.previewUrl);
      setError(null);
      setAvatar({ kind: "new", image: rendered, source, crop });
    }
    setCropping(null);
  };

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
              <Button size="sm" tone="secondary" disabled={busy || preparing} onClick={() => fileInput.current?.click()}>
                <ImageUp size={15} aria-hidden="true" />
                {t("collaboration.profile.chooseImage")}
              </Button>
              {avatar.kind === "new" && (
                <Button
                  size="sm"
                  tone="ghost"
                  disabled={busy || preparing}
                  onClick={() => setCropping({ source: avatar.source, crop: avatar.crop })}
                >
                  <Crop size={14} aria-hidden="true" />
                  {t("collaboration.profile.adjustImage")}
                </Button>
              )}
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
                if (file) chooseFile(file);
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
      {/* 範囲を選ぶ画面は body へ重ねて出る (layer="nested")。Esc・背景の押下はその画面だけを閉じる。 */}
      {cropping && (
        <CollaborationAvatarCropDialog
          source={cropping.source}
          initialCrop={cropping.crop}
          onCancel={() => setCropping(null)}
          onApply={(crop) => applyCrop(cropping.source, crop)}
        />
      )}
    </ModalFrame>
  );
}
