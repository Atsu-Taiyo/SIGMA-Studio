"use client";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import { loadEditorCustomCommands,loadEditorShortcutOverrides,parseEditorCustomCommands,parseEditorShortcutOverrides,saveEditorCustomCommands,saveEditorShortcutOverrides,type EditorCustomCommandDefinition,type EditorShortcutOverrides } from "@/lib/editor-command-shortcuts";
import { getAppLocale,normalizeLocale,readStoredAppLocale,setAppLocale } from "@/lib/i18n";
import { useCallback,useEffect,useRef,useState } from "react";
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
  // いま画面が持っている割り当て。同期の読み直しが、読んでいる間の手元の変更を古い内容で上書きしないために見る。
  const held = useRef({ shortcutOverrides, customCommands });
  useEffect(() => { held.current = { shortcutOverrides, customCommands }; }, [shortcutOverrides, customCommands]);
  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.settings) {
      return;
    }

    let canceled = false;
    const load = (synced = false) => {
      const before = held.current;
      // 読み込みの間にこの画面 (設定の言語切替など) で言語が選ばれたら、そちらが新しい。
      const storedLocaleBefore = readStoredAppLocale();
      void bridge.settings!.get().then((settings) => {
      if (canceled) {
        return;
      }
      // 表示言語は端末ごとの設定で、アカウントの同期では変わらない。同期による読み直しでは触らない。
      const storedLocaleNow = readStoredAppLocale();
      if (!synced && storedLocaleNow !== storedLocaleBefore) {
        // 読んでいる間に選ばれた言語が新しい。古い読み取りは書き戻さず、画面だけをその言語にそろえる。
        if (storedLocaleNow) setAppLocale(storedLocaleNow);
      } else if (!synced) {
        // settings.json が表示言語の正本。未設定 (null) の初回起動だけは、ストア側の
        // OSロケール検出結果を採用したうえで settings.json へ書き戻す。書き戻さないと
        // main / MCP プロセスが日本語、画面だけ英語という食い違いが残り続ける。
        // 検出結果はキャッシュなので、このウィンドウに保存済みの値があればそちらを優先する。
        const desktopLocale = normalizeLocale(settings.uiLocale ?? null);
        const fallbackLocale = storedLocaleNow ?? getAppLocale();
        setAppLocale(desktopLocale ?? fallbackLocale);
        if (!desktopLocale) {
          void bridge.settings?.setUiLocale?.(fallbackLocale);
        }
      }
      const storedShortcutOverrides = parseEditorShortcutOverrides(JSON.stringify(settings.commandShortcuts ?? {}));
      const storedCustomCommands = parseEditorCustomCommands(JSON.stringify(settings.customCommands ?? []));
      // 旧保存先からの引き継ぎは起動時の1回だけ。同期で空になったものを、古い localStorage で生き返らせない。
      const legacyShortcutOverrides = synced || settings.hasCommandShortcuts ? {} : loadEditorShortcutOverrides();
      const legacyCustomCommands = synced || settings.hasCustomCommands ? [] : loadEditorCustomCommands();
      const nextShortcutOverrides = Object.keys(storedShortcutOverrides).length > 0 ? storedShortcutOverrides : legacyShortcutOverrides;
      const nextCustomCommands = storedCustomCommands.length > 0 ? storedCustomCommands : legacyCustomCommands;
      if (synced) {
        // 読んでいる間にこの画面で割り当てを変えたなら、その変更が新しい。古い読み取りでは上書きしない。
        if (held.current !== before) {
          return;
        }
        // 変わっていないものは置き直さない (表示言語だけが変わった同期で、割り当てを保存し直さないため)。
        if (JSON.stringify(nextShortcutOverrides) !== JSON.stringify(before.shortcutOverrides)) setShortcutOverrides(nextShortcutOverrides);
        if (JSON.stringify(nextCustomCommands) !== JSON.stringify(before.customCommands)) setCustomCommands(nextCustomCommands);
        return;
      }
      setShortcutOverrides(nextShortcutOverrides);
      setCustomCommands(nextCustomCommands);
      setCommandSettingsError(null);
      setCommandSettingsLoaded(true);
    }).catch(() => {
      if (!canceled && !synced) {
        setCommandSettingsError(tEditor("status.shortcutsLoadFailed"));
      }
    });
    };
    load();
    // アカウントの同期でほかの端末の設定が入ったら、同じ手順で読み直す。
    const stop = bridge.settings.onSynced?.(() => load(true));

    return () => {
      canceled = true;
      stop?.();
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
        if (result.ok) {
          // 設定ファイルに入ったので、旧保存先は役目を終えた。残しておくと、最後の1件を消した後
          // (設定ファイルから項目ごと消える) の次の起動で、古い内容が戻ってきてしまう。
          saveEditorShortcutOverrides({});
          saveEditorCustomCommands([]);
        } else if (!cancelled) {
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
