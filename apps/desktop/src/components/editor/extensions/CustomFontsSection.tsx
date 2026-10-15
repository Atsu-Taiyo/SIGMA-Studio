"use client";

import { FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/Button";
import { Grid } from "@/components/ui/layout";
import { SettingsSection, SettingsStatus } from "@/components/ui/settings";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { useAppLocale, useT } from "@/lib/i18n/react";
import type { DesktopCustomFont } from "@/types/desktop";

import { ExtensionItemMenu } from "./ExtensionItemMenu";
import styles from "./ExtensionsDialog.module.css";

type FontStatus = { kind: "success" | "error"; text: string };

function formatAddedDate(importedAt: string, locale: string): string | null {
  const date = new Date(importedAt);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat(locale, { dateStyle: "medium" }).format(date);
}

/**
 * ユーザーが手元から追加したフォントの一覧。タイルには「どんな書体か」(その書体で描いた見本) と名前だけを
 * 置き、ファイル名・追加日・削除は3点メニューへ収める。取り込みと削除は desktop bridge に委ね、
 * 反映が必要な画面へは `onFontsChanged` で知らせる。
 */
/** 拡張機能が配る書体 (id が `plugin-` で始まる) は、ここの「追加フォント」には出さない。書体の選択には出る。 */
const isUserFont = (font: DesktopCustomFont): boolean => !font.id.startsWith("plugin-");

export function CustomFontsSection({ id, onFontsChanged }: { id?: string; onFontsChanged?: () => void }) {
  const t = useT("settings");
  const locale = useAppLocale();
  const [allFonts, setFonts] = useState<DesktopCustomFont[]>([]);
  const fonts = allFonts.filter(isUserFont);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<FontStatus | null>(null);
  const [menuFontId, setMenuFontId] = useState<string | null>(null);
  const bridge = getDesktopBridge();
  const mounted = useRef(true);
  const changed = useRef(onFontsChanged);
  useEffect(() => { changed.current = onFontsChanged; }, [onFontsChanged]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let active = true;
    bridge?.fonts?.list().then((result) => {
      if (active && result.ok) {
        setFonts(result.fonts);
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, [bridge]);

  const run = async (
    action: () => Promise<{ ok: boolean; canceled?: boolean; error?: string; fonts: DesktopCustomFont[] }>,
    messages: { success: string | null; failed: string },
  ) => {
    setBusy(true);
    setStatus(null);
    try {
      const result = await action();
      if (!mounted.current) return;
      setFonts(result.fonts);
      changed.current?.();
      if (!result.ok) {
        setStatus({ kind: "error", text: result.error ?? messages.failed });
      } else if (!result.canceled && messages.success) {
        setStatus({ kind: "success", text: messages.success });
      }
    } catch (error) {
      if (mounted.current) {
        setStatus({ kind: "error", text: error instanceof Error ? error.message : messages.failed });
      }
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  const importFont = () => {
    if (!bridge?.fonts) {
      setStatus({ kind: "error", text: t("extensions.font.unavailable") });
      return;
    }
    const { fonts: fontsApi } = bridge;
    void run(() => fontsApi.importFont(), { success: t("extensions.font.added"), failed: t("extensions.font.addFailed") });
  };

  const deleteFont = (fontId: string) => {
    if (!bridge?.fonts) {
      setStatus({ kind: "error", text: t("extensions.font.unavailable") });
      return;
    }
    const { fonts: fontsApi } = bridge;
    void run(() => fontsApi.deleteFont(fontId), { success: t("extensions.font.deleted"), failed: t("extensions.font.deleteFailed") });
  };

  return (
    <SettingsSection
      id={id}
      title={t("extensions.font.section")}
      description={t("extensions.font.help")}
      actions={(
        <Button tone="secondary" title={t("extensions.font.addDescription")} onClick={importFont} disabled={busy || !bridge?.fonts}>
          <FolderOpen size={14} aria-hidden="true" />
          {t("extensions.font.addButton")}
        </Button>
      )}
    >
      {fonts.length === 0 ? (
        <p className={styles.empty}>{t("extensions.font.empty")}</p>
      ) : (
        <Grid as="ul" className={styles.grid} columns={3} gap="md" aria-label={t("extensions.font.listAria")}>
          {fonts.map((font) => {
            const addedOn = formatAddedDate(font.importedAt, locale);
            return (
              <li className={styles.tile} key={font.id} data-menu-open={menuFontId === font.id ? "true" : undefined}>
                <div className={styles.fontPreview} style={{ fontFamily: font.cssFamily }} aria-hidden="true">
                  {t("extensions.font.sample")}
                </div>
                <div className={styles.tileFooter}>
                  <span className={styles.tileName} title={font.displayName}>
                    {font.displayName}
                  </span>
                  <ExtensionItemMenu
                    label={t("extensions.font.menuNamed", { name: font.displayName })}
                    disabled={busy}
                    details={[
                      { label: t("extensions.font.fileName"), value: font.fileName, mono: true },
                      ...(addedOn ? [{ label: t("extensions.font.addedOn"), value: addedOn }] : []),
                    ]}
                    actions={[{
                      key: "delete",
                      label: t("extensions.font.delete"),
                      icon: <Trash2 size={14} />,
                      tone: "danger",
                      onSelect: () => deleteFont(font.id),
                    }]}
                    onOpenChange={(open) => setMenuFontId((current) => (open ? font.id : current === font.id ? null : current))}
                  />
                </div>
              </li>
            );
          })}
        </Grid>
      )}
      {status && <SettingsStatus tone={status.kind}>{status.text}</SettingsStatus>}
    </SettingsSection>
  );
}
