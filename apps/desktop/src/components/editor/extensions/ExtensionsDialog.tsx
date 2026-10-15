"use client";

import { Puzzle } from "lucide-react";

import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { useT } from "@/lib/i18n/react";

import { useSettingsEntryFocus } from "../settings-entry-focus";
import { OfficialPluginsSection } from "../plugins/OfficialPluginsSection";
import { CustomFontsSection } from "./CustomFontsSection";
import styles from "./ExtensionsDialog.module.css";

interface ExtensionsDialogProps {
  open: boolean;
  onClose: () => void;
  /** 追加フォントやプラグイン同梱のフォントが増減したとき、フォント一覧を読み直させる。 */
  onFontsChanged?: () => void;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

/**
 * アプリ設定とは別に、本体へ機能や素材を足す「拡張機能」(追加フォント・公式プラグイン) をまとめて管理する。
 * 追加・更新・削除の実行は各セクションがホストへ委ね、このダイアログは並べ方と開閉だけを持つ。
 */
export function ExtensionsDialog({ open, onClose, onFontsChanged, focusEntryId }: ExtensionsDialogProps) {
  if (!open) {
    return null;
  }
  return <ExtensionsDialogBody onClose={onClose} onFontsChanged={onFontsChanged} focusEntryId={focusEntryId} />;
}

function ExtensionsDialogBody({ onClose, onFontsChanged, focusEntryId }: Omit<ExtensionsDialogProps, "open">) {
  const t = useT("settings");
  useSettingsEntryFocus(focusEntryId);
  return (
    <ModalFrame open onDismiss={onClose} size="md" ariaLabel={t("extensions.title")}>
      <ModalHeader
        title={(
          <span className={styles.title}>
            <Puzzle size={18} aria-hidden="true" />
            <span>{t("extensions.title")}</span>
          </span>
        )}
        onClose={onClose}
      />
      <ModalBody className={styles.body} padding="xl">
        <CustomFontsSection id="extensions-fonts" onFontsChanged={onFontsChanged} />
        <OfficialPluginsSection id="extensions-plugins" onFontsChanged={onFontsChanged} />
      </ModalBody>
    </ModalFrame>
  );
}
