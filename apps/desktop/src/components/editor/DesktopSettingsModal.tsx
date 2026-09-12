"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Check, ChevronRight, Download, ExternalLink, FolderOpen, Languages, RefreshCw, RotateCw, Trash2, Type } from "lucide-react";

import { AntigravityMark, ClaudeMark, OpenAiMark } from "@/components/branding/provider-logos";
import { Button, IconButton } from "@/components/ui/Button";
import { Disclosure } from "@/components/ui/Disclosure";
import { ModalBody, ModalFrame, ModalHeader } from "@/components/ui/Modal";
import { Shimmer } from "@/components/ui/Shimmer";
import { Inline, Stack } from "@/components/ui/layout";
import { SettingsField, SettingsRow, SettingsSection, SettingsStatus, Switch, Tabs } from "@/components/ui/settings";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { SUPPORTED_LOCALES, type AppLocale } from "@/lib/i18n";
import type { Translate } from "@/lib/i18n";
import { setAppLocale, useAppLocale, useT } from "@/lib/i18n/react";

import { useSettingsEntryFocus } from "./settings-entry-focus";
import { resolveAiConnectionState, resolveClaudeConnectionState, resolveGeminiConnectionState } from "@/lib/ai/ai-connection";
import type { DesktopAppInfo, DesktopClaudeStatus, DesktopCodexStatus, DesktopCustomFont, DesktopGeminiStatus, DesktopUpdateState } from "@/types/desktop";

interface DesktopSettingsModalProps {
  open: boolean;
  onClose: () => void;
  onFontsChanged?: () => void;
  requestUpdateCheck?: number;
  mode?: "app" | "ai";
  embedded?: boolean;
  /** 設定パレットから開いたときに見せたい項目 (`settings-catalog.ts` の id)。 */
  focusEntryId?: string;
}

type SettingsMessage = {
  kind: "success" | "error" | "info";
  text: string;
};

type AiSettingsProvider = "chatgpt" | "claude" | "antigravity";

const AI_PROVIDER_TABS = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude" },
  { value: "antigravity", label: "Antigravity" },
] as const;

/**
 * アプリ全体の設定とAIプロバイダー接続設定を、単独モーダル／埋め込みペインの両方で一貫して表示する。
 * 設定値の永続化や各プロバイダーの接続状態判定は担わず、desktop bridgeと接続状態ヘルパーに委ねる。
 */
export function DesktopSettingsModal({
  open,
  onClose,
  onFontsChanged,
  requestUpdateCheck = 0,
  mode = "app",
  embedded = false,
  focusEntryId,
}: DesktopSettingsModalProps) {
  if (!open) {
    return null;
  }
  if (!getDesktopBridge()) {
    return mode === "app" ? (
      <WebSettingsBody
        onClose={onClose}
        embedded={embedded}
        focusEntryId={focusEntryId}
      />
    ) : null;
  }
  return (
    <DesktopSettingsBody
      onClose={onClose}
      onFontsChanged={onFontsChanged}
      requestUpdateCheck={requestUpdateCheck}
      focusEntryId={focusEntryId}
      mode={mode}
      embedded={embedded}
    />
  );
}

function WebSettingsBody({
  onClose,
  embedded,
  focusEntryId,
}: {
  onClose: () => void;
  embedded: boolean;
  focusEntryId?: string;
}) {
  const t = useT("settings");
  const uiLocale = useAppLocale();
  const [requestedLocale, setRequestedLocale] = useState<AppLocale | null>(null);
  useSettingsEntryFocus(focusEntryId);

  const confirmUiLocaleChange = () => {
    if (!requestedLocale) {
      return;
    }
    const next = requestedLocale;
    setRequestedLocale(null);
    if (next !== uiLocale) {
      setAppLocale(next);
    }
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      embedded={embedded}
      size="md"
      ariaLabel={t("app.title")}
      className="desktop-settings-overlay"
      surfaceClassName="desktop-settings-modal web-settings-modal"
    >
      {!embedded && <ModalHeader title={t("app.title")} onClose={onClose} />}
      <ModalBody className="desktop-settings-content" padding={embedded ? "none" : "xl"}>
        <SettingsSection id="desktop-settings-language" title={t("language.title")}>
          <SettingsRow
            id="desktop-settings-language-row"
            label={t("language.label")}
            description={t("language.description")}
            control={(
              <LanguageSettingButton
                locale={uiLocale}
                dialogOpen={requestedLocale !== null}
                onOpen={() => setRequestedLocale(uiLocale)}
              />
            )}
          />
        </SettingsSection>
      </ModalBody>
      <LanguageChangeDialog
        open={requestedLocale !== null}
        currentLocale={uiLocale}
        selectedLocale={requestedLocale ?? uiLocale}
        onLocaleChange={setRequestedLocale}
        onCancel={() => setRequestedLocale(null)}
        onConfirm={confirmUiLocaleChange}
      />
      <style>{`
        .web-settings-modal { font-size: 14px; }
        .web-settings-modal .desktop-settings-content { display: flex; flex-direction: column; gap: var(--space-xl); }
        .web-settings-modal .language-setting-trigger {
          min-width: 152px;
          justify-content: flex-start;
          padding-inline: var(--space-sm);
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--text-primary) 4%, transparent),
            0 1px 2px color-mix(in srgb, var(--text-primary) 5%, transparent);
        }
        .web-settings-modal .language-setting-trigger-code {
          display: grid;
          width: 26px;
          height: 26px;
          flex: 0 0 auto;
          place-items: center;
          border-radius: calc(var(--radius-control) - var(--space-xs));
          background: var(--surface-muted);
          color: var(--text-secondary);
          font-size: 10px;
          font-weight: 750;
          letter-spacing: 0.04em;
        }
        .web-settings-modal .language-setting-trigger-chevron {
          margin-inline-start: auto;
          color: var(--text-muted);
        }
      `}</style>
    </ModalFrame>
  );
}

function DesktopSettingsBody({
  onClose,
  onFontsChanged,
  requestUpdateCheck,
  focusEntryId,
  mode,
  embedded,
}: {
  focusEntryId?: string;
  onClose: () => void;
  onFontsChanged?: () => void;
  requestUpdateCheck: number;
  mode: "app" | "ai";
  embedded: boolean;
}) {
  const [appInfo, setAppInfo] = useState<DesktopAppInfo | null>(null);
  const [codexStatus, setCodexStatus] = useState<DesktopCodexStatus | null>(null);
  const [claudeStatus, setClaudeStatus] = useState<DesktopClaudeStatus | null>(null);
  const [geminiStatus, setGeminiStatus] = useState<DesktopGeminiStatus | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [dataDir, setDataDir] = useState<string | null>(null);
  const [customFonts, setCustomFonts] = useState<DesktopCustomFont[]>([]);
  const [appActionStatus, setAppActionStatus] = useState<SettingsMessage | null>(null);
  const [fontActionStatus, setFontActionStatus] = useState<SettingsMessage | null>(null);
  const [codexActionStatus, setCodexActionStatus] = useState<SettingsMessage | null>(null);
  const [claudeActionStatus, setClaudeActionStatus] = useState<SettingsMessage | null>(null);
  const [geminiActionStatus, setGeminiActionStatus] = useState<SettingsMessage | null>(null);
  const [codexBinDraft, setCodexBinDraft] = useState("");
  const [claudeBinDraft, setClaudeBinDraft] = useState("");
  const [geminiBinDraft, setGeminiBinDraft] = useState("");
  const [codexBusy, setCodexBusy] = useState(false);
  const [claudeBusy, setClaudeBusy] = useState(false);
  const [geminiBusy, setGeminiBusy] = useState(false);
  const [activeAiProvider, setActiveAiProvider] = useState<AiSettingsProvider>("chatgpt");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [autoApplyVerified, setAutoApplyVerified] = useState(false);
  const [autoApplyBusy, setAutoApplyBusy] = useState(false);
  // aiWebSearchEnabled は未設定 (キー欠落) が有効扱いのため、既定値は true。
  const [webSearchEnabled, setWebSearchEnabled] = useState(true);
  const [webSearchBusy, setWebSearchBusy] = useState(false);
  const t = useT("settings");
  const tCommon = useT("common");
  useSettingsEntryFocus(focusEntryId);
  // 購読を張る effect は **マウント時 1 回だけ**でなければならない。deps に `t` を入れると
  // 言語切替 (このダイアログ自身にセレクタがある) のたびに購読を張り直し、`load*Status()` が
  // 走って入力中の CLI パスを上書きしてしまう。文言は ref 越しに読む。
  const tRef = useRef(t);
  useEffect(() => {
    tRef.current = t;
  }, [t]);
  const uiLocale = useAppLocale();
  const [languageActionStatus, setLanguageActionStatus] = useState<SettingsMessage | null>(null);
  const [requestedLocale, setRequestedLocale] = useState<AppLocale | null>(null);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge) {
      return;
    }
    let cancelled = false;
    bridge.app.getInfo().then((r) => {
      if (!cancelled) {
        setAppInfo(r);
      }
    });
    bridge.storage.getDataDir().then((r) => {
      if (!cancelled) {
        setDataDir(r.path);
      }
    });
    bridge.settings?.get().then((r) => {
      if (!cancelled) {
        setAutoApplyVerified(r.aiAutoApplyVerifiedProposals ?? false);
        setWebSearchEnabled(r.aiWebSearchEnabled ?? true);
      }
    });
    bridge.fonts?.list().then((r) => {
      if (!cancelled && r.ok) {
        setCustomFonts(r.fonts);
      }
    });
    // MCPのupdate_ai_settings tool(別プロセス)がsettings.jsonを書き換えた場合に、開いている
    // 設定画面のトグルを追随させる (electron/main.tsのfs.watch起点の通知)。
    const unsubscribeAiSettings = bridge.settings?.onAiSettingsChanged?.(() => {
      bridge.settings?.get().then((r) => {
        if (!cancelled) {
          setAutoApplyVerified(r.aiAutoApplyVerifiedProposals ?? false);
          setWebSearchEnabled(r.aiWebSearchEnabled ?? true);
        }
      });
    }) ?? (() => {});
    const loadCodexStatus = () => {
      bridge.codex.getStatus().then((r) => {
        if (!cancelled) {
          setCodexStatus(r);
          setCodexBinDraft(r.configuredCodexBin ?? r.codexBin ?? "");
        }
      }).catch((err) => {
        if (!cancelled) {
          setCodexStatus({
            available: false,
            running: false,
            loggedIn: false,
            codexHome: "",
            codexBin: "codex",
            configuredCodexBin: null,
            account: null,
            error: err instanceof Error ? err.message : tRef.current("provider.message.aiStatusFailed"),
          });
        }
      });
    };
    const loadClaudeStatus = () => {
      if (!bridge.claude) {
        if (!cancelled) {
          setClaudeStatus({
            available: false,
            running: false,
            loggedIn: false,
            claudeBin: "claude",
            configuredClaudeBin: null,
            account: null,
            error: tRef.current("provider.message.claudeUnavailable"),
          });
        }
        return;
      }
      bridge.claude.getStatus().then((r) => {
        if (!cancelled) {
          setClaudeStatus(r);
          setClaudeBinDraft(r.configuredClaudeBin ?? r.claudeBin ?? "");
        }
      }).catch((err) => {
        if (!cancelled) {
          setClaudeStatus({
            available: false,
            running: false,
            loggedIn: false,
            claudeBin: "claude",
            configuredClaudeBin: null,
            account: null,
            error: err instanceof Error ? err.message : tRef.current("provider.message.claudeStatusFailed"),
          });
        }
      });
    };
    const loadGeminiStatus = () => {
      if (!bridge.gemini) {
        if (!cancelled) {
          setGeminiStatus({
            available: false,
            loggedIn: false,
            geminiBin: "agy",
            configuredGeminiBin: null,
            account: null,
            error: tRef.current("provider.message.geminiUnavailable"),
          });
        }
        return;
      }
      bridge.gemini.getStatus().then((r) => {
        if (!cancelled) {
          setGeminiStatus(r);
          setGeminiBinDraft(r.configuredGeminiBin ?? r.geminiBin ?? "");
        }
      }).catch((err) => {
        if (!cancelled) {
          setGeminiStatus({
            available: false,
            loggedIn: false,
            geminiBin: "agy",
            configuredGeminiBin: null,
            account: null,
            error: err instanceof Error ? err.message : tRef.current("provider.message.geminiStatusFailed"),
          });
        }
      });
    };
    loadCodexStatus();
    loadClaudeStatus();
    loadGeminiStatus();
    const unsubscribeCodex = bridge.codex.onStatusChange(loadCodexStatus);
    const unsubscribeClaude = bridge.claude?.onStatusChange(loadClaudeStatus) ?? (() => {});
    const unsubscribeGemini = bridge.gemini?.onStatusChange(loadGeminiStatus) ?? (() => {});
    let unsubscribeUpdater = () => {};
    if (bridge.updater) {
      bridge.updater.getStatus().then((r) => {
        if (!cancelled) {
          setUpdateState(r);
        }
      }).catch((err) => {
        if (!cancelled) {
          setAppActionStatus({ kind: "error", text: err instanceof Error ? err.message : tRef.current("app.update.stateFailed") });
        }
      });
      unsubscribeUpdater = bridge.updater.onStatusChange((r) => {
        if (!cancelled) {
          setUpdateState(r);
        }
      });
    }
    return () => {
      cancelled = true;
      unsubscribeCodex();
      unsubscribeClaude();
      unsubscribeGemini();
      unsubscribeUpdater();
      unsubscribeAiSettings();
    };
  }, []);

  const bridge = getDesktopBridge();
  if (!bridge) {
    return null;
  }

  const changeUiLocale = (next: AppLocale) => {
    // 表示は即座に切り替え、デスクトップでは settings.json (正本) へも書き戻す。
    // Web/SDK 埋め込みには settings ブリッジが無いので localStorage だけが残る。
    setAppLocale(next);
    setLanguageActionStatus(null);
    const setUiLocale = bridge.settings?.setUiLocale;
    if (!setUiLocale) {
      return;
    }
    // 書き戻しの失敗を握り潰すと、画面は切り替わったのに main / MCP は古い言語のまま
    // という食い違いが再起動まで見えない。
    void setUiLocale(next).then((result) => {
      if (!result.ok) {
        setLanguageActionStatus({ kind: "error", text: result.error ?? t("language.saveFailed") });
      }
    }).catch(() => {
      setLanguageActionStatus({ kind: "error", text: t("language.saveFailed") });
    });
  };

  const openLanguageDialog = () => setRequestedLocale(uiLocale);

  const confirmUiLocaleChange = () => {
    if (!requestedLocale) {
      return;
    }
    const next = requestedLocale;
    setRequestedLocale(null);
    if (next !== uiLocale) {
      changeUiLocale(next);
    }
  };

  const openLatestReleasePage = async () => {
    setAppActionStatus(null);
    try {
      const result = await bridge.app.openLatestReleasePage();
      if (!result.ok) {
        setAppActionStatus({ kind: "error", text: result.error ?? t("app.update.openLatestFailed") });
        return;
      }
      setAppActionStatus({ kind: "success", text: t("app.update.openedLatest") });
    } catch (err) {
      setAppActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.update.openLatestFailed") });
    }
  };

  const checkForAppUpdate = async () => {
    if (!bridge.updater) {
      await openLatestReleasePage();
      return;
    }
    setUpdateBusy(true);
    setAppActionStatus(null);
    try {
      setUpdateState(await bridge.updater.checkForUpdates());
    } catch (err) {
      setAppActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.update.checkFailed") });
    } finally {
      setUpdateBusy(false);
    }
  };

  const downloadAppUpdate = async () => {
    if (!bridge.updater) {
      await openLatestReleasePage();
      return;
    }
    setUpdateBusy(true);
    setAppActionStatus(null);
    try {
      setUpdateState(await bridge.updater.downloadUpdate());
    } catch (err) {
      setAppActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.update.downloadFailed") });
    } finally {
      setUpdateBusy(false);
    }
  };

  const quitAndInstallUpdate = async () => {
    if (!bridge.updater) {
      await openLatestReleasePage();
      return;
    }
    setUpdateBusy(true);
    setAppActionStatus(null);
    try {
      const result = await bridge.updater.quitAndInstall();
      if (!result.ok) {
        setAppActionStatus({ kind: "error", text: result.error });
      }
    } catch (err) {
      setAppActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.update.applyFailed") });
    } finally {
      setUpdateBusy(false);
    }
  };

  const handleUpdatePrimaryAction = () => {
    if (updateState?.phase === "available") {
      void downloadAppUpdate();
      return;
    }
    if (updateState?.phase === "downloaded") {
      void quitAndInstallUpdate();
      return;
    }
    void checkForAppUpdate();
  };

  const importFont = async () => {
    if (!bridge.fonts) {
      setFontActionStatus({ kind: "error", text: t("app.font.unavailable") });
      return;
    }
    setFontBusy(true);
    setFontActionStatus(null);
    try {
      const result = await bridge.fonts.importFont();
      setCustomFonts(result.fonts);
      onFontsChanged?.();
      if (!result.ok) {
        setFontActionStatus({ kind: "error", text: result.error ?? t("app.font.addFailed") });
      } else if (!result.canceled) {
        setFontActionStatus({ kind: "success", text: t("app.font.added") });
      }
    } catch (err) {
      setFontActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.font.addFailed") });
    } finally {
      setFontBusy(false);
    }
  };

  const deleteFont = async (fontId: string) => {
    if (!bridge.fonts) {
      setFontActionStatus({ kind: "error", text: t("app.font.unavailable") });
      return;
    }
    setFontBusy(true);
    setFontActionStatus(null);
    try {
      const result = await bridge.fonts.deleteFont(fontId);
      setCustomFonts(result.fonts);
      onFontsChanged?.();
      setFontActionStatus(result.ok
        ? { kind: "success", text: t("app.font.deleted") }
        : { kind: "error", text: result.error ?? t("app.font.deleteFailed") });
    } catch (err) {
      setFontActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("app.font.deleteFailed") });
    } finally {
      setFontBusy(false);
    }
  };

  const loginCodex = async () => {
    setCodexBusy(true);
    setCodexActionStatus(null);
    try {
      const result = await bridge.codex.login();
      if (!result.ok) {
        setCodexActionStatus({ kind: "error", text: result.error });
        return;
      }
      setCodexActionStatus({ kind: "success", text: t("provider.message.loginOpened") });
      setCodexStatus(await bridge.codex.getStatus());
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.loginFailed") });
    } finally {
      setCodexBusy(false);
    }
  };

  const saveCodexBin = async () => {
    setCodexBusy(true);
    setCodexActionStatus(null);
    try {
      const status = await bridge.codex.setBin(codexBinDraft.trim() || null);
      setCodexStatus(status);
      setCodexBinDraft(status.configuredCodexBin ?? "");
      setCodexActionStatus({ kind: "success", text: t("provider.message.codexPathSaved") });
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.codexPathSaveFailed") });
    } finally {
      setCodexBusy(false);
    }
  };

  const selectCodexBin = async () => {
    setCodexBusy(true);
    setCodexActionStatus(null);
    try {
      const result = await bridge.codex.selectBin();
      if (!result.canceled) {
        setCodexStatus(result.status);
        setCodexBinDraft(result.status.configuredCodexBin ?? "");
        setCodexActionStatus({ kind: "success", text: t("provider.message.codexPathSaved") });
      }
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.codexSelectFailed") });
    } finally {
      setCodexBusy(false);
    }
  };

  const openCodexInstallPage = async () => {
    setCodexActionStatus(null);
    try {
      const result = await bridge.codex.openInstallPage();
      if (!result.ok) {
        setCodexActionStatus({ kind: "error", text: result.error ?? t("provider.message.codexInstallOpenFailed") });
        return;
      }
      setCodexActionStatus({ kind: "success", text: t("provider.message.codexInstallOpened") });
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.codexInstallOpenFailed") });
    }
  };

  const clearCodexBin = async () => {
    setCodexBusy(true);
    setCodexActionStatus(null);
    try {
      const status = await bridge.codex.setBin(null);
      setCodexStatus(status);
      setCodexBinDraft(status.configuredCodexBin ?? "");
      setCodexActionStatus({ kind: "success", text: t("provider.message.codexPathReset") });
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.codexResetFailed") });
    } finally {
      setCodexBusy(false);
    }
  };

  const saveClaudeBin = async () => {
    if (!bridge.claude) {
      setClaudeActionStatus({ kind: "error", text: t("provider.message.claudeUnavailable") });
      return;
    }
    setClaudeBusy(true);
    setClaudeActionStatus(null);
    try {
      const status = await bridge.claude.setBin(claudeBinDraft.trim() || null);
      setClaudeStatus(status);
      setClaudeBinDraft(status.configuredClaudeBin ?? "");
      setClaudeActionStatus({ kind: "success", text: t("provider.message.claudePathSaved") });
    } catch (err) {
      setClaudeActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.claudePathSaveFailed") });
    } finally {
      setClaudeBusy(false);
    }
  };

  const selectClaudeBin = async () => {
    if (!bridge.claude) {
      setClaudeActionStatus({ kind: "error", text: t("provider.message.claudeUnavailable") });
      return;
    }
    setClaudeBusy(true);
    setClaudeActionStatus(null);
    try {
      const result = await bridge.claude.selectBin();
      if (!result.canceled) {
        setClaudeStatus(result.status);
        setClaudeBinDraft(result.status.configuredClaudeBin ?? "");
        setClaudeActionStatus({ kind: "success", text: t("provider.message.claudePathSaved") });
      }
    } catch (err) {
      setClaudeActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.claudeSelectFailed") });
    } finally {
      setClaudeBusy(false);
    }
  };

  const openClaudeInstallPage = async () => {
    setClaudeActionStatus(null);
    try {
      const result = await bridge.claude?.openInstallPage();
      if (!result || !result.ok) {
        setClaudeActionStatus({ kind: "error", text: result?.error ?? t("provider.message.claudeInstallOpenFailed") });
        return;
      }
      setClaudeActionStatus({ kind: "success", text: t("provider.message.claudeInstallOpened") });
    } catch (err) {
      setClaudeActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.claudeInstallOpenFailed") });
    }
  };

  const clearClaudeBin = async () => {
    if (!bridge.claude) {
      setClaudeActionStatus({ kind: "error", text: t("provider.message.claudeUnavailable") });
      return;
    }
    setClaudeBusy(true);
    setClaudeActionStatus(null);
    try {
      const status = await bridge.claude.setBin(null);
      setClaudeStatus(status);
      setClaudeBinDraft(status.configuredClaudeBin ?? "");
      setClaudeActionStatus({ kind: "success", text: t("provider.message.claudePathReset") });
    } catch (err) {
      setClaudeActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.claudeResetFailed") });
    } finally {
      setClaudeBusy(false);
    }
  };

  const saveGeminiBin = async () => {
    if (!bridge.gemini) {
      setGeminiActionStatus({ kind: "error", text: t("provider.message.geminiUnavailable") });
      return;
    }
    setGeminiBusy(true);
    setGeminiActionStatus(null);
    try {
      const status = await bridge.gemini.setBin(geminiBinDraft.trim() || null);
      setGeminiStatus(status);
      setGeminiBinDraft(status.configuredGeminiBin ?? "");
      setGeminiActionStatus({ kind: "success", text: t("provider.message.geminiPathSaved") });
    } catch (err) {
      setGeminiActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.geminiPathSaveFailed") });
    } finally {
      setGeminiBusy(false);
    }
  };

  const selectGeminiBin = async () => {
    if (!bridge.gemini) {
      setGeminiActionStatus({ kind: "error", text: t("provider.message.geminiUnavailable") });
      return;
    }
    setGeminiBusy(true);
    setGeminiActionStatus(null);
    try {
      const result = await bridge.gemini.selectBin();
      if (!result.canceled) {
        setGeminiStatus(result.status);
        setGeminiBinDraft(result.status.configuredGeminiBin ?? "");
        setGeminiActionStatus({ kind: "success", text: t("provider.message.geminiPathSaved") });
      }
    } catch (err) {
      setGeminiActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.geminiSelectFailed") });
    } finally {
      setGeminiBusy(false);
    }
  };

  const openGeminiInstallPage = async () => {
    setGeminiActionStatus(null);
    try {
      const result = await bridge.gemini?.openInstallPage();
      if (!result || !result.ok) {
        setGeminiActionStatus({ kind: "error", text: result?.error ?? t("provider.message.geminiInstallOpenFailed") });
        return;
      }
      setGeminiActionStatus({ kind: "success", text: t("provider.message.geminiInstallOpened") });
    } catch (err) {
      setGeminiActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.geminiInstallOpenFailed") });
    }
  };

  const clearGeminiBin = async () => {
    if (!bridge.gemini) {
      setGeminiActionStatus({ kind: "error", text: t("provider.message.geminiUnavailable") });
      return;
    }
    setGeminiBusy(true);
    setGeminiActionStatus(null);
    try {
      const status = await bridge.gemini.setBin(null);
      setGeminiStatus(status);
      setGeminiBinDraft(status.configuredGeminiBin ?? "");
      setGeminiActionStatus({ kind: "success", text: t("provider.message.geminiPathReset") });
    } catch (err) {
      setGeminiActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.geminiResetFailed") });
    } finally {
      setGeminiBusy(false);
    }
  };

  const logoutCodex = async () => {
    setCodexBusy(true);
    setCodexActionStatus(null);
    try {
      await bridge.codex.logout();
      setCodexStatus(await bridge.codex.getStatus());
      setCodexActionStatus({ kind: "success", text: t("provider.message.disconnected") });
    } catch (err) {
      setCodexActionStatus({ kind: "error", text: err instanceof Error ? err.message : t("provider.message.disconnectFailed") });
    } finally {
      setCodexBusy(false);
    }
  };

  const codexState = resolveAiConnectionState(codexStatus);
  const codexStateLabel = codexState.accountLabel
    ? `${codexState.label} · ${codexState.accountLabel}`
    : codexState.label;
  const claudeState = resolveClaudeConnectionState(claudeStatus);
  const claudeStateLabel = claudeState.accountLabel
    ? `${claudeState.label} · ${claudeState.accountLabel}`
    : claudeState.label;
  const geminiState = resolveGeminiConnectionState(geminiStatus);
  const geminiStateLabel = geminiState.accountLabel
    ? `${geminiState.label} · ${geminiState.accountLabel}`
    : geminiState.label;
  const updateStatusMessage = getUpdateStatusMessage(updateState, t);
  const updatePhase = updateState?.phase ?? "idle";
  const updateActionDisabled = updateState?.supported === false
    || updateBusy
    || updatePhase === "checking"
    || updatePhase === "downloading";
  const updateProgressPercent = formatUpdatePercent(updateState);
  const isWindows = bridge.platform === "win32";
  const codexBinPlaceholder = isWindows ? t("provider.hint.codexPathWindows") : t("provider.hint.codexPathPosix");
  const codexBinHelp = isWindows ? t("provider.hint.codexHelpWindows") : t("provider.hint.codexHelpPosix");
  const claudeBinPlaceholder = isWindows ? t("provider.hint.claudePathWindows") : t("provider.hint.claudePathPosix");
  const claudeBinHelp = isWindows ? t("provider.hint.claudeHelpWindows") : t("provider.hint.claudeHelpPosix");
  const geminiBinPlaceholder = isWindows ? t("provider.hint.geminiPathWindows") : t("provider.hint.geminiPathPosix");
  const geminiBinHelp = isWindows ? t("provider.hint.geminiHelpWindows") : t("provider.hint.geminiHelpPosix");

  const renderCliPathField = ({
    id,
    label,
    value,
    onChange,
    placeholder,
    onSelect,
    onSave,
    onClear,
    busy,
    help,
  }: {
    id: string;
    label: string;
    value: string;
    onChange: (value: string) => void;
    placeholder: string;
    onSelect: () => void;
    onSave: () => void;
    onClear: () => void;
    busy: boolean;
    help: string;
  }) => (
    <SettingsField className="desktop-settings-field" label={label} htmlFor={id} description={help}>
      <Inline className="desktop-settings-input-row" gap="sm" align="center">
        <input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          spellCheck={false}
        />
        <IconButton tone="secondary" label={t("provider.select", { label })} onClick={onSelect} disabled={busy}>
          <FolderOpen size={15} />
        </IconButton>
      </Inline>
      <Inline className="desktop-settings-button-row" gap="sm" justify="end">
        <Button tone="secondary" onClick={onSave} disabled={busy}>
          {busy ? t("provider.busy") : tCommon("actions.save")}
        </Button>
        <Button tone="secondary" onClick={onClear} disabled={busy}>
          {t("provider.autoDetect")}
        </Button>
      </Inline>
    </SettingsField>
  );

  const setAutoApplyVerifiedSetting = async (next: boolean) => {
    setAutoApplyVerified(next);
    setAutoApplyBusy(true);
    try {
      const result = await bridge.settings?.setAiAutoApplyVerifiedProposals?.(next);
      if (result && !result.ok) {
        setAutoApplyVerified(!next);
      }
    } catch {
      setAutoApplyVerified(!next);
    } finally {
      setAutoApplyBusy(false);
    }
  };

  const setWebSearchEnabledSetting = async (next: boolean) => {
    setWebSearchEnabled(next);
    setWebSearchBusy(true);
    try {
      const result = await bridge.settings?.setAiWebSearchEnabled?.(next);
      if (result && !result.ok) {
        setWebSearchEnabled(!next);
      }
    } catch {
      setWebSearchEnabled(!next);
    } finally {
      setWebSearchBusy(false);
    }
  };

  return (
    <ModalFrame
      open
      onDismiss={onClose}
      embedded={embedded}
      size="md"
      ariaLabel={mode === "ai" ? t("app.aiTitle") : t("app.title")}
      className="desktop-settings-overlay"
      surfaceClassName="desktop-settings-modal"
    >
      {!embedded && <ModalHeader title={mode === "ai" ? t("app.aiTitle") : t("app.title")} onClose={onClose} />}
      <ModalBody className="desktop-settings-content" padding={embedded ? "none" : "xl"}>

        {mode === "ai" && (
        <SettingsSection id="desktop-settings-ai-agents" title={t("provider.section")}>
          <Tabs
            label={t("provider.tabsAria")}
            items={AI_PROVIDER_TABS}
            value={activeAiProvider}
            onValueChange={setActiveAiProvider}
          >

          {activeAiProvider === "chatgpt" && (
            <Stack className="desktop-settings-tab-panel" gap="md">
              <ProviderConnectionCard
                name="ChatGPT"
                logo={<OpenAiMark size={22} />}
                loading={codexStatus === null}
                stateLabel={codexStateLabel}
                stateTone={codexState.tone}
                action={codexState.kind === "loggedIn" ? (
                  <Button
                    tone="secondary"
                    onClick={() => void logoutCodex()}
                    disabled={codexBusy}
                  >
                    {t("provider.disconnect")}
                  </Button>
                ) : (
                  <Button
                    tone="primary"
                    onClick={() => void loginCodex()}
                    disabled={codexBusy || codexStatus?.available === false}
                  >
                    <ExternalLink size={14} />
                    {t("provider.connect")}
                  </Button>
                )}
              />
              {codexStatus !== null && (<>
              <p className="desktop-settings-help">
                {t("provider.codexHelp")}
              </p>
              {codexStatus?.available === false && (
                <Inline className="desktop-settings-button-row desktop-settings-button-row-left" gap="sm">
                  <Button tone="secondary" onClick={() => void openCodexInstallPage()} disabled={codexBusy}>
                    <ExternalLink size={14} />
                    {t("provider.installCodex")}
                  </Button>
                </Inline>
              )}
              <Disclosure label={t("provider.pathDetailsCodex")} summary={t("provider.pathSummary")} defaultOpen={codexStatus.available === false}>
                {renderCliPathField({
                  id: "desktop-settings-codex-bin",
                  label: "Codex CLI",
                  value: codexBinDraft,
                  onChange: setCodexBinDraft,
                  placeholder: codexBinPlaceholder,
                  onSelect: () => void selectCodexBin(),
                  onSave: () => void saveCodexBin(),
                  onClear: () => void clearCodexBin(),
                  busy: codexBusy,
                  help: codexBinHelp,
                })}
              </Disclosure>
              {codexStatus?.error && <SettingsStatusMessage message={{ kind: "error", text: codexStatus.error }} />}
              {codexActionStatus && <SettingsStatusMessage message={codexActionStatus} />}
              </>)}
            </Stack>
          )}

          {activeAiProvider === "claude" && (
            <Stack className="desktop-settings-tab-panel" gap="md">
              <ProviderConnectionCard
                name="Claude"
                logo={<ClaudeMark size={22} />}
                loading={claudeStatus === null}
                stateLabel={claudeStateLabel}
                stateTone={claudeState.tone}
                action={(
                <Button tone="secondary" onClick={() => void openClaudeInstallPage()} disabled={claudeBusy}>
                  <ExternalLink size={14} />
                  {t("provider.installClaude")}
                </Button>
                )}
              />
              {claudeStatus !== null && (<>
              <p className="desktop-settings-help">
                {t("provider.claudeHelp")}
              </p>
              <Disclosure label={t("provider.pathDetailsClaude")} summary={t("provider.pathSummary")} defaultOpen={claudeStatus.available === false}>
                {renderCliPathField({
                  id: "desktop-settings-claude-bin",
                  label: "Claude Code",
                  value: claudeBinDraft,
                  onChange: setClaudeBinDraft,
                  placeholder: claudeBinPlaceholder,
                  onSelect: () => void selectClaudeBin(),
                  onSave: () => void saveClaudeBin(),
                  onClear: () => void clearClaudeBin(),
                  busy: claudeBusy,
                  help: claudeBinHelp,
                })}
              </Disclosure>
              {claudeStatus?.error && <SettingsStatusMessage message={{ kind: "error", text: claudeStatus.error }} />}
              {claudeActionStatus && <SettingsStatusMessage message={claudeActionStatus} />}
              </>)}
            </Stack>
          )}

          {activeAiProvider === "antigravity" && (
            <Stack className="desktop-settings-tab-panel" gap="md">
              <ProviderConnectionCard
                name="Antigravity"
                logo={<AntigravityMark size={22} />}
                loading={geminiStatus === null}
                stateLabel={geminiStateLabel}
                stateTone={geminiState.tone}
                action={(
                <Button tone="secondary" onClick={() => void openGeminiInstallPage()} disabled={geminiBusy}>
                  <ExternalLink size={14} />
                  {t("provider.installGemini")}
                </Button>
                )}
              />
              {geminiStatus !== null && (<>
              <p className="desktop-settings-help">
                {t("provider.geminiHelpBefore")}<code>agy</code>{t("provider.geminiHelpAfter")}
              </p>
              <Disclosure label={t("provider.pathDetailsGemini")} summary={t("provider.pathSummary")} defaultOpen={geminiStatus.available === false}>
                {renderCliPathField({
                  id: "desktop-settings-gemini-bin",
                  label: "Antigravity CLI",
                  value: geminiBinDraft,
                  onChange: setGeminiBinDraft,
                  placeholder: geminiBinPlaceholder,
                  onSelect: () => void selectGeminiBin(),
                  onSave: () => void saveGeminiBin(),
                  onClear: () => void clearGeminiBin(),
                  busy: geminiBusy,
                  help: geminiBinHelp,
                })}
              </Disclosure>
              {geminiStatus?.error && <SettingsStatusMessage message={{ kind: "error", text: geminiStatus.error }} />}
              {geminiActionStatus && <SettingsStatusMessage message={geminiActionStatus} />}
              </>)}
            </Stack>
          )}

          </Tabs>
          <SettingsRow
            id="desktop-settings-auto-apply"
            label={t("provider.autoApply.label")}
            description={t("provider.autoApply.description")}
            control={(
              <Switch
                label={t("provider.autoApply.label")}
                checked={autoApplyVerified}
                disabled={autoApplyBusy || !bridge.settings?.setAiAutoApplyVerifiedProposals}
                onCheckedChange={(next) => void setAutoApplyVerifiedSetting(next)}
              />
            )}
          />
          <SettingsRow
            id="desktop-settings-web-search"
            label={t("provider.webSearch.label")}
            description={t("provider.webSearch.description")}
            control={(
              <Switch
                label={t("provider.webSearch.label")}
                checked={webSearchEnabled}
                disabled={webSearchBusy || !bridge.settings?.setAiWebSearchEnabled}
                onCheckedChange={(next) => void setWebSearchEnabledSetting(next)}
              />
            )}
          />
        </SettingsSection>
        )}

        {mode === "app" && (<>
        <SettingsSection id="desktop-settings-language" title={t("language.title")}>
          <SettingsRow
            id="desktop-settings-language-row"
            label={t("language.label")}
            description={t("language.description")}
            control={(
              <LanguageSettingButton
                locale={uiLocale}
                dialogOpen={requestedLocale !== null}
                onOpen={openLanguageDialog}
              />
            )}
          />
          {languageActionStatus && <SettingsStatusMessage message={languageActionStatus} />}
        </SettingsSection>

        <SettingsSection id="desktop-settings-fonts" title={t("app.font.section")}>
          <SettingsRow
            id="desktop-settings-font-add"
            label={t("app.font.add")}
            description={t("app.font.addDescription")}
            icon={<Type size={13} aria-hidden="true" />}
            control={(
            <Button tone="secondary" onClick={() => void importFont()} disabled={fontBusy || !bridge.fonts}>
              <FolderOpen size={14} />
              {t("app.font.addButton")}
            </Button>
            )}
          />
          <p className="desktop-settings-help">
            {t("app.font.help")}
          </p>
          <div className="desktop-settings-font-list" aria-label={t("app.font.listAria")}>
            {customFonts.length === 0 ? (
              <p className="desktop-settings-empty">{t("app.font.empty")}</p>
            ) : customFonts.map((font) => (
              <div className="desktop-settings-font-item" key={font.id}>
                <div className="desktop-settings-row-info">
                  <strong style={{ fontFamily: font.cssFamily }}>{font.displayName}</strong>
                  <span className="desktop-settings-path">{font.fileName}</span>
                </div>
                <IconButton
                  tone="danger"
                  label={t("app.font.deleteNamed", { name: font.displayName })}
                  onClick={() => void deleteFont(font.id)}
                  disabled={fontBusy}
                >
                  <Trash2 size={14} />
                </IconButton>
              </div>
            ))}
          </div>
          {fontActionStatus && <SettingsStatusMessage message={fontActionStatus} />}
        </SettingsSection>

        <SettingsSection id="desktop-settings-app-update" title={t("app.update.section")}>
          <RequestedUpdateCheck request={requestUpdateCheck} onCheck={checkForAppUpdate} />
          <SettingsRow
            id="desktop-settings-app-version"
            label={t("app.update.version")}
            description={appInfo?.version ?? t("app.update.checking")}
            control={(
            <Inline className="desktop-settings-actions" gap="sm" justify="end" wrap>
              <Button
                tone="secondary"
                onClick={handleUpdatePrimaryAction}
                disabled={updateActionDisabled}
              >
                {updatePhase === "available" ? (
                  <Download size={14} />
                ) : updatePhase === "downloaded" ? (
                  <RotateCw size={14} />
                ) : (
                  <RefreshCw size={14} />
                )}
                {getUpdateButtonLabel(updateState, t)}
              </Button>
              {(updateState?.phase === "error" || !bridge.updater) && (
                <Button tone="secondary" onClick={() => void openLatestReleasePage()}>
                  <ExternalLink size={14} />
                  {t("app.update.openManually")}
                </Button>
              )}
            </Inline>
            )}
          />
          {updateState?.phase === "downloading" && (
            <div className="desktop-settings-progress" aria-label={t("app.update.progressAria")}>
              <span style={{ width: updateProgressPercent }} />
            </div>
          )}
          {updateStatusMessage && <SettingsStatusMessage message={updateStatusMessage} />}
          {appActionStatus && <SettingsStatusMessage message={appActionStatus} />}
        </SettingsSection>

        <SettingsSection id="desktop-settings-local-data" title={t("app.localData.section")}>
          <SettingsRow
            id="desktop-settings-data-dir"
            label={t("app.localData.path")}
            icon={<FolderOpen size={13} aria-hidden="true" />}
            description={<span className="desktop-settings-path">{dataDir ?? t("app.localData.checking")}</span>}
          />
        </SettingsSection>
        </>)}
      </ModalBody>
      <LanguageChangeDialog
        open={requestedLocale !== null}
        currentLocale={uiLocale}
        selectedLocale={requestedLocale ?? uiLocale}
        onLocaleChange={setRequestedLocale}
        onCancel={() => setRequestedLocale(null)}
        onConfirm={confirmUiLocaleChange}
      />
      <style>{`
        .desktop-settings-modal { font-size: 14px; }
        .desktop-settings-content { display: flex; flex-direction: column; gap: var(--space-xl); }
        .language-setting-trigger {
          min-width: 152px;
          justify-content: flex-start;
          padding-inline: var(--space-sm);
          box-shadow:
            0 0 0 1px color-mix(in srgb, var(--text-primary) 4%, transparent),
            0 1px 2px color-mix(in srgb, var(--text-primary) 5%, transparent);
        }
        .language-setting-trigger-code {
          display: grid;
          width: 26px;
          height: 26px;
          flex: 0 0 auto;
          place-items: center;
          border-radius: calc(var(--radius-control) - var(--space-xs));
          background: var(--surface-muted);
          color: var(--text-secondary);
          font-size: 10px;
          font-weight: 750;
          letter-spacing: 0.04em;
        }
        .language-setting-trigger-chevron {
          margin-inline-start: auto;
          color: var(--text-muted);
        }
        .desktop-settings-tab-panel { min-width: 0; }
        .desktop-settings-provider {
          display: grid; grid-template-columns: 40px minmax(0, 1fr) auto;
          align-items: center; gap: var(--space-md);
          padding: var(--space-md) var(--space-lg);
          border: 1px solid var(--border-subtle); border-radius: var(--radius-panel);
          background: var(--surface-soft);
        }
        .desktop-settings-provider-logo {
          display: grid; place-items: center; width: 40px; height: 40px;
          border-radius: var(--radius-control); background: var(--background); color: var(--text-primary);
          border: 1px solid var(--border-subtle);
        }
        .desktop-settings-provider-info { display: grid; gap: var(--space-xs); min-width: 0; }
        .desktop-settings-provider-info strong {
          font-size: 13.5px; font-weight: 650; color: var(--text-primary, #111);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .desktop-settings-provider-state {
          display: inline-flex; align-items: center; gap: var(--space-sm);
          font-size: 11.5px; color: var(--text-muted, #8a8a8a);
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .desktop-settings-provider-dot {
          width: 7px; height: 7px; border-radius: 999px; flex: 0 0 auto;
          background: var(--text-disabled, #b0b0b0);
        }
        .desktop-settings-provider-state.connected { color: var(--success, #247a3d); }
        .desktop-settings-provider-state.connected .desktop-settings-provider-dot { background: var(--success, #247a3d); }
        .desktop-settings-provider-state.error { color: var(--danger, #b42318); }
        .desktop-settings-provider-state.error .desktop-settings-provider-dot { background: var(--danger, #b42318); }
        .desktop-settings-provider-logo-loading { border: 0; }
        .desktop-settings-provider-name-loading { width: min(120px, 74%); }
        .desktop-settings-provider-state-loading { width: min(180px, 92%); }
        .desktop-settings-provider-action-loading { width: 84px; height: 34px; border-radius: var(--radius-control); }
        .desktop-settings-help {
          color: var(--text-muted, #8a8a8a); margin: var(--space-none); font-size: 12px; line-height: 1.55;
        }
        .desktop-settings-field {
          display: grid; gap: var(--space-sm);
        }
        .desktop-settings-field label {
          font-size: 12px; font-weight: 650; color: var(--text-secondary, #555);
        }
        .desktop-settings-input-row {
          min-width: 0;
        }
        .desktop-settings-input-row input {
          flex: 1 1 auto; width: 100%; min-width: 0; height: 34px;
          border: 1px solid var(--border, #dadada);
          border-radius: var(--radius-control);
          padding: var(--space-none) var(--space-md);
          background: var(--background, #fff);
          color: var(--text-primary, #111);
          font: 12px ui-monospace, SFMono-Regular, Menlo, monospace;
        }
        .desktop-settings-input-row input:focus {
          outline: none;
          border-color: var(--accent, #2563eb);
          box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent, #2563eb) 15%, transparent);
        }
        .desktop-settings-button-row-left {
          justify-content: flex-start;
        }
        .desktop-settings-actions {
          max-width: 100%;
        }
        .desktop-settings-row-info { display: grid; gap: var(--space-xs); min-width: 0; }
        .desktop-settings-row-info strong {
          display: inline-flex; align-items: center; gap: var(--space-sm);
          font-size: 12px; font-weight: 650; color: var(--text-secondary, #555);
        }
        .desktop-settings-row-info > span { font-size: 13px; color: var(--text-primary, #111); }
        .desktop-settings-font-list {
          display: grid; gap: var(--space-sm);
        }
        .desktop-settings-font-item {
          display: grid; grid-template-columns: minmax(0, 1fr) 34px; gap: var(--space-sm); align-items: center;
          padding: var(--space-sm) var(--space-md);
          border: 1px solid var(--border-subtle, #e5e5e5);
          border-radius: var(--radius-panel);
          background: var(--surface-soft, #f7f7f7);
        }
        .desktop-settings-empty {
          margin: var(--space-none); padding: var(--space-sm) var(--space-md);
          border: 1px dashed var(--border, #dadada);
          border-radius: var(--radius-panel);
          color: var(--text-muted, #8a8a8a);
          font-size: 12px;
        }
        .desktop-settings-path {
          overflow-wrap: anywhere;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 11.5px !important; color: var(--text-muted, #8a8a8a) !important;
        }
        .desktop-settings-progress {
          overflow: hidden;
          height: 6px;
          margin: var(--space-md) var(--space-none) var(--space-none);
          border-radius: 999px;
          background: var(--surface-muted, #f1f1f1);
        }
        .desktop-settings-progress span {
          display: block;
          height: 100%;
          min-width: 5%;
          border-radius: inherit;
          background: var(--accent, #2563eb);
          transition: width 160ms ease;
        }
        @media (max-width: 600px) {
          .desktop-settings-provider {
            grid-template-columns: 40px minmax(0, 1fr);
          }
          .desktop-settings-provider > :last-child:not(.desktop-settings-provider-info) {
            grid-column: 1 / -1;
            justify-self: start;
          }
        }
      `}</style>
    </ModalFrame>
  );
}

export function LanguageSettingButton({
  locale,
  dialogOpen,
  onOpen,
}: {
  locale: AppLocale;
  dialogOpen: boolean;
  onOpen: () => void;
}) {
  const t = useT("settings");
  return (
    <Button
      tone="secondary"
      className="language-setting-trigger"
      aria-haspopup="dialog"
      aria-expanded={dialogOpen}
      aria-label={t("language.openAction", { language: t(`language.options.${locale}`) })}
      onClick={onOpen}
    >
      <span className="language-setting-trigger-code" aria-hidden="true">{locale.toUpperCase()}</span>
      <span lang={locale}>{t(`language.options.${locale}`)}</span>
      <ChevronRight className="language-setting-trigger-chevron icon-directional" size={15} strokeWidth={2} aria-hidden="true" />
    </Button>
  );
}

export function LanguageChangeDialog({
  open,
  currentLocale,
  selectedLocale,
  onLocaleChange,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  currentLocale: AppLocale;
  selectedLocale: AppLocale;
  onLocaleChange: (locale: AppLocale) => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = useT("settings");
  const tCommon = useT("common");

  return (
    <ModalFrame
      open={open}
      onDismiss={onCancel}
      layer="nested"
      size="sm"
      ariaLabel={t("language.changeTitle")}
      surfaceClassName="language-change-dialog"
    >
      <ModalHeader
        title={t("language.changeTitle")}
        description={t("language.changeDescription")}
        onClose={onCancel}
      />
      <ModalBody padding="xl">
        <Stack gap="xl">
          <div className="language-change-options" aria-label={t("language.changeRouteLabel")}>
            {SUPPORTED_LOCALES.map((locale) => (
              <LanguageOptionCard
                key={locale}
                locale={locale}
                current={locale === currentLocale}
                selected={locale === selectedLocale}
                onSelect={() => onLocaleChange(locale)}
              />
            ))}
          </div>
          <Inline className="language-change-note" gap="md" align="start">
            <Languages size={18} strokeWidth={1.5} aria-hidden="true" />
            <p>{t("language.changeImpact")}</p>
          </Inline>
          <Inline className="language-change-actions" gap="sm" justify="end" wrap>
            <Button tone="secondary" onClick={onCancel}>
              {tCommon("actions.cancel")}
            </Button>
            <Button tone="primary" onClick={onConfirm} disabled={selectedLocale === currentLocale}>
              <Check size={15} strokeWidth={2} aria-hidden="true" />
              {t("language.changeAction", { language: t(`language.options.${selectedLocale}`) })}
            </Button>
          </Inline>
        </Stack>
      </ModalBody>
      <style>{`
        .language-change-dialog { font-size: 14px; overscroll-behavior: contain; }
        .language-change-options {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: var(--space-md);
        }
        .language-option-card {
          display: grid;
          min-width: 0;
          gap: var(--space-md);
          padding: var(--space-lg);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          background: var(--surface-soft);
          color: var(--text-primary);
          font: inherit;
          text-align: start;
          cursor: pointer;
          transition-property: background-color, border-color, box-shadow, transform;
          transition-duration: 140ms;
          transition-timing-function: ease-out;
        }
        .language-option-card:hover { background: var(--surface-muted); }
        .language-option-card:active { transform: scale(0.96); }
        .language-option-card:focus-visible {
          outline: 2px solid color-mix(in srgb, var(--accent) 32%, transparent);
          outline-offset: 2px;
        }
        .language-option-card[aria-pressed="true"] {
          border-color: var(--border-strong);
          background: var(--background);
          box-shadow:
            0 0 0 3px color-mix(in srgb, var(--text-primary) 6%, transparent),
            0 1px 2px color-mix(in srgb, var(--text-primary) 5%, transparent);
        }
        .language-option-card-header {
          display: flex;
          min-height: var(--space-xl);
          align-items: center;
          justify-content: space-between;
          gap: var(--space-sm);
        }
        .language-option-card-current {
          padding: var(--space-xs) var(--space-sm);
          border-radius: 999px;
          background: var(--surface-muted);
          color: var(--text-muted);
          font-size: 10px;
          font-weight: 650;
        }
        .language-option-card-check { color: var(--text-primary); }
        .language-option-card-language {
          display: flex;
          align-items: center;
          gap: var(--space-sm);
          min-width: 0;
        }
        .language-option-card-code {
          display: grid;
          width: 32px;
          height: 32px;
          flex: 0 0 auto;
          place-items: center;
          border-radius: var(--radius-control);
          background: var(--surface-muted);
          color: var(--text-secondary);
          font-size: 11px;
          font-weight: 750;
          letter-spacing: 0.04em;
        }
        .language-option-card strong {
          overflow: hidden;
          color: var(--text-primary);
          font-size: 14px;
          font-weight: 650;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .language-change-note {
          padding: var(--space-lg);
          border-radius: var(--radius-panel);
          background: var(--surface-soft);
          color: var(--text-secondary);
        }
        .language-change-note svg { flex: 0 0 auto; margin-top: 2px; }
        .language-change-note p { margin: 0; font-size: 12px; line-height: 1.6; }
        @media (max-width: 28.75rem) {
          .language-change-options { grid-template-columns: 1fr; }
          .language-change-actions { align-items: stretch; }
          .language-change-actions > button { width: 100%; }
        }
        @media (prefers-reduced-motion: reduce) {
          .language-option-card { transition-duration: 0ms; }
          .language-option-card:active { transform: none; }
        }
      `}</style>
    </ModalFrame>
  );
}

function LanguageOptionCard({
  locale,
  current,
  selected,
  onSelect,
}: {
  locale: AppLocale;
  current: boolean;
  selected: boolean;
  onSelect: () => void;
}) {
  const t = useT("settings");
  return (
    <button
      type="button"
      className="language-option-card"
      aria-pressed={selected}
      data-modal-initial-focus={selected ? "" : undefined}
      onClick={onSelect}
    >
      <span className="language-option-card-header">
        {current ? <span className="language-option-card-current">{t("language.currentLabel")}</span> : <span />}
        {selected ? <Check className="language-option-card-check" size={16} strokeWidth={2} aria-hidden="true" /> : null}
      </span>
      <span className="language-option-card-language">
        <span className="language-option-card-code" aria-hidden="true">{locale.toUpperCase()}</span>
        <strong lang={locale}>{t(`language.options.${locale}`)}</strong>
      </span>
    </button>
  );
}

function RequestedUpdateCheck({ request, onCheck }: { request: number; onCheck: () => void }) {
  const handledRequest = useRef(0);

  useEffect(() => {
    if (request === 0 || request === handledRequest.current) {
      return;
    }
    handledRequest.current = request;
    document.getElementById("desktop-settings-app-update")?.scrollIntoView({ block: "nearest" });
    onCheck();
  }, [onCheck, request]);

  return null;
}

/** 接続状態カードの配置を揃え、プロバイダー固有の接続処理は呼び出し側に残す。 */
function ProviderConnectionCard({
  name,
  logo,
  loading,
  stateLabel,
  stateTone,
  action,
}: {
  name: string;
  logo: ReactNode;
  loading: boolean;
  stateLabel: string;
  stateTone: string;
  action: ReactNode;
}) {
  const t = useT("settings");
  if (loading) {
    return (
      <div className="desktop-settings-provider" role="status" aria-label={t("provider.checkingAria", { name })} aria-busy="true">
        <Shimmer variant="surface" className="desktop-settings-provider-logo desktop-settings-provider-logo-loading" />
        <div className="desktop-settings-provider-info">
          <Shimmer className="desktop-settings-provider-name-loading">{name}</Shimmer>
          <Shimmer className="desktop-settings-provider-state-loading">{t("provider.checkingState")}</Shimmer>
        </div>
        <Shimmer variant="surface" className="desktop-settings-provider-action-loading" />
      </div>
    );
  }

  return (
    <div className="desktop-settings-provider">
      <span className="desktop-settings-provider-logo" aria-hidden="true">{logo}</span>
      <div className="desktop-settings-provider-info">
        <strong>{name}</strong>
        <span className={`desktop-settings-provider-state ${stateTone}`}>
          <span className="desktop-settings-provider-dot" aria-hidden="true" />
          {stateLabel}
        </span>
      </div>
      {action}
    </div>
  );
}

function SettingsStatusMessage({ message }: { message: SettingsMessage }) {
  return (
    <SettingsStatus className={`desktop-settings-status ${message.kind}`} tone={message.kind}>
      {message.text}
    </SettingsStatus>
  );
}

function getUpdateButtonLabel(state: DesktopUpdateState | null, t: Translate<"settings">): string {
  if (state?.phase === "checking") {
    return t("app.update.checking");
  }
  if (state?.phase === "available") {
    return t("app.update.download");
  }
  if (state?.phase === "downloading") {
    return t("app.update.downloading");
  }
  if (state?.phase === "downloaded") {
    return t("app.update.restart");
  }
  return t("app.update.checkLatest");
}

function getUpdateStatusMessage(state: DesktopUpdateState | null, t: Translate<"settings">): SettingsMessage | null {
  if (!state) {
    return null;
  }
  if (!state.supported && state.phase === "idle") {
    return { kind: "info", text: t("app.update.storeManaged") };
  }
  if (state.phase === "checking") {
    return { kind: "info", text: t("app.update.checkingMessage") };
  }
  if (state.phase === "not-available") {
    return { kind: "success", text: t("app.update.upToDate") };
  }
  if (state.phase === "available") {
    return { kind: "info", text: t("app.update.available", { version: state.availableVersion ?? "" }) };
  }
  if (state.phase === "downloading") {
    const percent = Math.round(state.progress?.percent ?? 0);
    return { kind: "info", text: t("app.update.downloadingMessage", { percent }) };
  }
  if (state.phase === "downloaded") {
    return { kind: "success", text: t("app.update.ready") };
  }
  if (state.phase === "error") {
    return { kind: "error", text: state.error ?? t("app.update.failed") };
  }
  return null;
}

function formatUpdatePercent(state: DesktopUpdateState | null): string {
  const percent = state?.progress?.percent ?? 0;
  return `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
}
