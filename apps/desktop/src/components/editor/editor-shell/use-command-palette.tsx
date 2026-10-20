"use client";

import { useCallback, useMemo, type RefObject } from "react";

import { buildPaletteEntries, type PaletteEntry } from "../command-palette-model";
import { SETTINGS_SURFACE_DESKTOP_MODE } from "../settings-catalog";
import type { TooltipContent } from "@/components/ui/Tooltip";
import {
  formatShortcutText,
  getEditorCommandCatalog,
  getShortcutForCommand,
  isEditorAddedFontCommand,
  resolveEditorCommandCatalog,
  type EditorCommandDescriptionOptions,
  type EditorCommandId,
  type EditorRuntimeCommandDefinition,
  type EditorShortcutOverrides,
  type EditorShortcutPlatform,
} from "@/lib/editor-command-shortcuts";
import type { Translate } from "@/lib/i18n";

import { SHORTCUT_FONT_FAMILIES } from "./constants";

export interface EditorCommandPaletteCatalog {
  /** 組み込みの一覧に無いコマンド: ユーザーのカスタムコマンドと、追加フォントごとの書体コマンド。 */
  customCommands: readonly EditorRuntimeCommandDefinition[];
  /** 説明文に出す CSS の font-family を書体名で読ませる (無ければ値のまま)。 */
  fontLabel?: EditorCommandDescriptionOptions["fontLabel"];
  shortcutOverrides: EditorShortcutOverrides;
  shortcutPlatform: EditorShortcutPlatform;
  isEmbedded: boolean;
  tCommand: Translate<"command">;
  tSettings: Translate<"settings">;
}

/** Settings navigation stays explicit, including the command-settings load/error guard. */
export interface EditorCommandPaletteSurfaces {
  setCommandPaletteOpen(open: boolean): void;
  setSettingsFocusEntryId(id: string | undefined): void;
  setDesktopSettingsOpen(open: boolean): void;
  setExtensionsOpen(open: boolean): void;
  setAiSettingsOpen(open: boolean): void;
  setPageSettingsOpen(open: boolean): void;
  setTexEnvironmentSettingsOpen(open: boolean): void;
  openCommandSettings(): boolean;
}

export interface EditorCommandPaletteOptions {
  commandPaletteOpen: boolean;
  catalog: EditorCommandPaletteCatalog;
  surfaces: EditorCommandPaletteSurfaces;
  runShortcutCommandRef: RefObject<(commandId: EditorCommandId) => void>;
}

/** Resolve labels only for an open palette and execute commands after its modal focus isolation ends. */
export function useCommandPalette({
  commandPaletteOpen,
  catalog: { customCommands, fontLabel, shortcutOverrides, shortcutPlatform, isEmbedded, tCommand, tSettings },
  surfaces: {
    setCommandPaletteOpen, setSettingsFocusEntryId, setDesktopSettingsOpen, setExtensionsOpen, setAiSettingsOpen,
    setPageSettingsOpen, setTexEnvironmentSettingsOpen, openCommandSettings,
  },
  runShortcutCommandRef,
}: EditorCommandPaletteOptions) {
  const renderMenuShortcut = (commandId: EditorCommandId) => {
    const label = formatShortcutText(getShortcutForCommand(shortcutOverrides, commandId, customCommands), shortcutPlatform);
    return label ? <kbd>{label}</kbd> : null;
  };
  // 書体メニューの各行に「この書体にするキー」を添えるための表。値 (CSS の font-family) が
  // メニューの行と完全に一致する書体コマンドだけを載せる。キーが無い書体は載せない。
  const fontFamilyShortcutLabels = useMemo(() => {
    const labels = new Map<string, string>();
    const add = (fontFamily: string, commandId: EditorCommandId) => {
      if (!fontFamily || labels.has(fontFamily)) return;
      const label = formatShortcutText(getShortcutForCommand(shortcutOverrides, commandId, customCommands), shortcutPlatform);
      if (label) labels.set(fontFamily, label);
    };
    for (const [commandId, fontFamily] of Object.entries(SHORTCUT_FONT_FAMILIES)) add(fontFamily, commandId);
    for (const command of customCommands) {
      if (isEditorAddedFontCommand(command)) add(command.fontFamily, command.id);
    }
    return labels;
  }, [customCommands, shortcutOverrides, shortcutPlatform]);
  const fontFamilyShortcut = (fontFamily: string): string | undefined => fontFamilyShortcutLabels.get(fontFamily);
  // パレットの候補。`t` を持ち込むのは **描画のときだけ** で、打鍵ごとに走る
  // `findCommandByShortcut` はこの解決を通らない (罠 6)。
  // 開くまで作らないのは、155 件の解決 (t() 約 600 回) を初回描画から外すため。
  const paletteEntries = useMemo(() => (commandPaletteOpen ? buildPaletteEntries({
    commands: resolveEditorCommandCatalog(getEditorCommandCatalog(customCommands), tCommand, { fontLabel }),
    resolveShortcut: (commandId) => getShortcutForCommand(shortcutOverrides, commandId, customCommands),
    formatShortcut: (binding) => formatShortcutText(binding, shortcutPlatform),
    translateSetting: (key) => tSettings(key as never) as string,
    settingsGroupLabel: tCommand("palette.groupSetting"),
    // 開いている状態でもう一度出しても意味がない。
    hiddenCommandIds: ["view.commandPalette"],
    // 埋め込み (SDK web) にはデスクトップブリッジも AI 設定も無く、選んでも
    // 何も描かれない。死に行を並べない。
    isSettingsSurfaceAvailable: (surface) => !isEmbedded
      || (surface !== "desktopApp" && surface !== "desktopAi" && surface !== "aiResources" && surface !== "extensions"),
  }) : []), [commandPaletteOpen, customCommands, fontLabel, isEmbedded, shortcutOverrides, shortcutPlatform, tCommand, tSettings]);

  const runPaletteEntry = useCallback((entry: PaletteEntry) => {
    setCommandPaletteOpen(false);
    if (entry.kind === "command") {
      // パレットが閉じてから実行する。閉じる前は本文側にまだ `inert` が付いていて
      // (Modal の隔離)、フォーカスを本文へ戻すコマンドが inert 配下に入れない。
      const commandId = entry.id as EditorCommandId;
      requestAnimationFrame(() => runShortcutCommandRef.current(commandId));
      return;
    }
    // 設定項目は WI-3 が用意した配線をそのまま使う: surface でダイアログを決め、
    // `focusEntryId` を渡すとダイアログ側がスクロールとハイライトを担当する。
    // アプリ設定モーダルは同じ実装を mode で 2 面に出し分けているので、どちらの面かは
    // カタログ側の `SETTINGS_SURFACE_DESKTOP_MODE` から引く。
    const desktopMode = SETTINGS_SURFACE_DESKTOP_MODE[entry.surface];
    switch (entry.surface) {
      case "desktopApp":
        setSettingsFocusEntryId(entry.id);
        setDesktopSettingsOpen(true);
        return;
      case "extensions":
        setSettingsFocusEntryId(entry.id);
        setExtensionsOpen(true);
        return;
      case "desktopAi":
      case "aiResources":
        // mode="ai" の面は単独では出ず、AI 設定ダイアログの「接続・動作」セクションに
        // 埋め込まれている (`AiSettingsDialog` が `focusEntryId` を中へ渡す)。
        void desktopMode;
        setSettingsFocusEntryId(entry.id);
        setAiSettingsOpen(true);
        return;
      case "page":
        setSettingsFocusEntryId(entry.id);
        setPageSettingsOpen(true);
        return;
      case "texEnvironment":
        setSettingsFocusEntryId(entry.id);
        setTexEnvironmentSettingsOpen(true);
        return;
      case "commands":
        // 読み込み中/エラーだと開かないことがある。開かないのに focus id を残すと
        // 次に別の設定を開いたときに 120 フレーム空振りする。
        if (openCommandSettings()) {
          setSettingsFocusEntryId(entry.id);
        }
        return;
      default: {
        // 面が増えたら**コンパイルで**気付く (黙って別のダイアログが開かない)。
        const exhaustive: never = entry.surface;
        void exhaustive;
      }
    }
  }, [
    openCommandSettings, runShortcutCommandRef, setAiSettingsOpen, setCommandPaletteOpen,
    setDesktopSettingsOpen, setExtensionsOpen, setSettingsFocusEntryId, setPageSettingsOpen, setTexEnvironmentSettingsOpen,
  ]);

  const commandTooltip = (label: string, commandId: EditorCommandId): TooltipContent => {
    const shortcut = formatShortcutText(getShortcutForCommand(shortcutOverrides, commandId, customCommands), shortcutPlatform);
    return { label, shortcut: shortcut || null };
  };
  const overlayArrangeShortcutLabels = {
    front: formatShortcutText(getShortcutForCommand(shortcutOverrides, "overlay.arrange.front"), shortcutPlatform) || undefined,
    forward: formatShortcutText(getShortcutForCommand(shortcutOverrides, "overlay.arrange.forward"), shortcutPlatform) || undefined,
    backward: formatShortcutText(getShortcutForCommand(shortcutOverrides, "overlay.arrange.backward"), shortcutPlatform) || undefined,
    back: formatShortcutText(getShortcutForCommand(shortcutOverrides, "overlay.arrange.back"), shortcutPlatform) || undefined,
  };
  return {
    renderMenuShortcut,
    fontFamilyShortcut,
    paletteEntries,
    runPaletteEntry,
    commandTooltip,
    overlayArrangeShortcutLabels,
  };
}
