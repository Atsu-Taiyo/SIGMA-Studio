"use client";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import { loadEditorCustomCommands,loadEditorShortcutOverrides,parseEditorCustomCommands,parseEditorShortcutOverrides,saveEditorCustomCommands,saveEditorShortcutOverrides,type EditorCustomCommandDefinition,type EditorShortcutOverrides } from "@/lib/editor-command-shortcuts";
import { getAppLocale,normalizeLocale,setAppLocale } from "@/lib/i18n";
import { useCallback,useEffect,useState } from "react";
import { tEditor } from "./editor-translations";

export function useCommandSettingsController(setCommandSettingsOpen: (open: boolean) => void, setStatusMessage: (message: string) => void) {
  const [shortcutOverrides, setShortcutOverrides] = useState<EditorShortcutOverrides>(() => (
    getDesktopBridge()?.settings ? {} : loadEditorShortcutOverrides()
  ));
  const [customCommands, setCustomCommands] = useState<EditorCustomCommandDefinition[]>(() => (
    getDesktopBridge()?.settings ? [] : loadEditorCustomCommands()
  ));
  const [commandSettingsLoaded, setCommandSettingsLoaded] = useState(() => !getDesktopBridge()?.settings);
  const [commandSettingsError, setCommandSettingsError] = useState<string | null>(null);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.settings) {
      return;
    }

    let canceled = false;
    void bridge.settings.get().then((settings) => {
      if (canceled) {
        return;
      }
      // settings.json が表示言語の正本。未設定 (null) の初回起動だけは、ストア側の
      // OSロケール検出結果を採用したうえで settings.json へ書き戻す。書き戻さないと
      // main / MCP プロセスが日本語、画面だけ英語という食い違いが残り続ける。
      const desktopLocale = normalizeLocale(settings.uiLocale ?? null);
      setAppLocale(desktopLocale ?? getAppLocale());
      if (!desktopLocale) {
        void bridge.settings?.setUiLocale?.(getAppLocale());
      }
      const storedShortcutOverrides = parseEditorShortcutOverrides(JSON.stringify(settings.commandShortcuts ?? {}));
      const storedCustomCommands = parseEditorCustomCommands(JSON.stringify(settings.customCommands ?? []));
      const legacyShortcutOverrides = settings.hasCommandShortcuts ? {} : loadEditorShortcutOverrides();
      const legacyCustomCommands = settings.hasCustomCommands ? [] : loadEditorCustomCommands();
      setShortcutOverrides(Object.keys(storedShortcutOverrides).length > 0 ? storedShortcutOverrides : legacyShortcutOverrides);
      setCustomCommands(storedCustomCommands.length > 0 ? storedCustomCommands : legacyCustomCommands);
      setCommandSettingsError(null);
      setCommandSettingsLoaded(true);
    }).catch(() => {
      if (!canceled) {
        setCommandSettingsError(tEditor("status.shortcutsLoadFailed"));
      }
    });

    return () => {
      canceled = true;
    };
  }, []);

  useEffect(() => {
    if (!commandSettingsLoaded || commandSettingsError) {
      return;
    }

    let cancelled = false;
    const bridge = getDesktopBridge();
    if (bridge?.settings) {
      void bridge.settings.setCommandConfig({
        commandShortcuts: Object.keys(shortcutOverrides).length > 0 ? shortcutOverrides : null,
        customCommands,
      }).then((result) => {
        if (!cancelled && !result.ok) {
          setCommandSettingsError(result.error ?? tEditor("status.shortcutsSaveFailed"));
        }
      }).catch(() => {
        if (cancelled) return;
        setCommandSettingsError(tEditor("status.shortcutsSaveFailed"));
      });
      return () => { cancelled = true; };
    }

    saveEditorShortcutOverrides(shortcutOverrides);
    saveEditorCustomCommands(customCommands);
  }, [commandSettingsError, commandSettingsLoaded, customCommands, shortcutOverrides]);

  /** 開けたら true。パレットは開けたときだけ focus 対象を覚える。 */
  const openCommandSettings = useCallback(() => {
    if (!commandSettingsLoaded) {
      setStatusMessage(commandSettingsError ?? tEditor("status.shortcutsLoading"));
      return false;
    }
    if (commandSettingsError) {
      setStatusMessage(commandSettingsError);
      return false;
    }
    setCommandSettingsOpen(true);
    return true;
  }, [commandSettingsError, commandSettingsLoaded, setStatusMessage, setCommandSettingsOpen]);

  return { shortcutOverrides, setShortcutOverrides, customCommands, setCustomCommands, commandSettingsLoaded, commandSettingsError, openCommandSettings };
}
