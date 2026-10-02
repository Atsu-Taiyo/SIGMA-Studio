"use client";

import type { SetStateAction } from "react";
import { useCallback,useState } from "react";

export function useEditorDialogState() {
  const [pageSettingsOpen, setPageSettingsOpen] = useState(false);
  const [commandSettingsOpen, setCommandSettingsOpen] = useState(false);
  const [commandPaletteOpen, setCommandPaletteOpen] = useState(false);
  // パレットから設定項目を選んだとき、開いたダイアログのどこを見せるか
  // (`settings-catalog.ts` の id)。ダイアログを閉じたら捨てる。
  const [settingsFocusEntryId, setSettingsFocusEntryId] = useState<string | undefined>(undefined);
  const [texCommandReferenceOpen, setTexCommandReferenceOpen] = useState(false);
  const [texEnvironmentSettingsOpen, setTexEnvironmentSettingsOpen] = useState(false);
  const [documentListOpen, setDocumentListOpen] = useState(false);
  const [desktopSettingsOpen, setDesktopSettingsOpen] = useState(false);
  const [desktopSettingsUpdateCheckRequest, setDesktopSettingsUpdateCheckRequest] = useState(0);
  /**
   * クロームのメニュー/ツールバーから「アプリ設定」を開く経路。素の setter を渡すと、
   * Help > Check for Updates… 由来の更新チェック要求が残ったままになり、普通に設定を
   * 開いただけで更新チェックが走ってしまう。開閉のたびに要求を落としておく。
   */
  const openDesktopSettingsFromChrome = useCallback((value: SetStateAction<boolean>) => {
    setDesktopSettingsUpdateCheckRequest(0);
    setDesktopSettingsOpen(value);
  }, []);
  return { pageSettingsOpen, setPageSettingsOpen, commandSettingsOpen, setCommandSettingsOpen, commandPaletteOpen, setCommandPaletteOpen, settingsFocusEntryId, setSettingsFocusEntryId, texCommandReferenceOpen, setTexCommandReferenceOpen, texEnvironmentSettingsOpen, setTexEnvironmentSettingsOpen, documentListOpen, setDocumentListOpen, desktopSettingsOpen, setDesktopSettingsOpen, desktopSettingsUpdateCheckRequest, setDesktopSettingsUpdateCheckRequest, openDesktopSettingsFromChrome };
}
