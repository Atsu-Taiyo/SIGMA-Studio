"use client";

import { useCallback, useEffect, useState } from "react";

import { getDesktopBridge } from "@/lib/desktop-bridge";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";

/**
 * `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く。
 * 固定ロケールにすると渡し忘れが静かに日本語で出るバグになるため (WI-7 で実測)。
 * `window` の無い環境では既定ロケール (日本語) に落ちるので既存の期待値は不変。
 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");
import type { DesktopAPI, DesktopClaudeStatus, DesktopCodexStatus, DesktopGeminiStatus } from "@/types/desktop";

/**
 * Generic connection hook for the local-CLI-backed providers (Claude, Gemini):
 * no in-app login flow, just (a) status polling against a bridge section that
 * exposes `getStatus`/`onStatusChange`, and (b) a fallback status object to use
 * when the bridge section is missing or a status call throws. Extracted because
 * `useClaudeConnection` / `useGeminiConnection` were near-identical copies
 * (Finding 4).
 */
interface CliProviderBridgeSection<TStatus> {
  getStatus(): Promise<TStatus>;
  onStatusChange(handler: () => void): () => void;
}

export interface CliProviderConnection<TStatus> {
  status: TStatus | null;
  state: AiConnectionStateView;
  loading: boolean;
  refresh: () => void;
}

function useCliProviderConnection<TStatus>(
  getBridgeSection: (bridge: DesktopAPI) => CliProviderBridgeSection<TStatus> | undefined,
  fallbackStatus: (message: string) => TStatus,
  resolveState: (status: TStatus | null, t: Translate<"ai">) => AiConnectionStateView,
): CliProviderConnection<TStatus> {
  const t = useT("ai");
  const [status, setStatus] = useState<TStatus | null>(null);
  const [loading, setLoading] = useState(() => {
    const bridge = getDesktopBridge();
    return Boolean(bridge && getBridgeSection(bridge));
  });

  const refresh = useCallback(() => {
    const bridge = getDesktopBridge();
    const section = bridge && getBridgeSection(bridge);
    if (!section) {
      setStatus(null);
      setLoading(false);
      return;
    }
    section.getStatus()
      .then((next) => setStatus(next))
      .catch((err) => setStatus(fallbackStatus(err instanceof Error ? err.message : t("connection.statusFailed"))))
      .finally(() => setLoading(false));
  }, [getBridgeSection, fallbackStatus, t]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    const section = bridge && getBridgeSection(bridge);
    if (!section) {
      return;
    }

    let cancelled = false;
    const load = () => {
      section.getStatus()
        .then((next) => {
          if (!cancelled) setStatus(next);
        })
        .catch((err) => {
          if (!cancelled) {
            setStatus(fallbackStatus(err instanceof Error ? err.message : t("connection.statusFailed")));
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    };

    load();
    const unsubscribe = section.onStatusChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    status,
    state: resolveState(status, t),
    loading,
    refresh,
  };
}

/**
 * Shared AI (ChatGPT) connection state for the editor. The underlying runtime
 * is the Codex CLI signed in with a ChatGPT account, but everything surfaced to
 * the user is framed as "ChatGPT" — no Codex branding in the UI.
 */
export type AiConnectionStateKind = "checking" | "unavailable" | "loggedOut" | "loggedIn";

export interface AiConnectionStateView {
  kind: AiConnectionStateKind;
  tone: "muted" | "connected" | "error";
  /** Short status label, e.g. "接続済み" / "未ログイン". */
  label: string;
  /** ChatGPT account label when signed in (email / plan / fallback), else null. */
  accountLabel: string | null;
}

export function resolveAiConnectionState(status: DesktopCodexStatus | null, t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): AiConnectionStateView {
  if (!status) {
    return { kind: "checking", tone: "muted", label: t("connection.checking"), accountLabel: null };
  }
  if (!status.available) {
    return { kind: "unavailable", tone: "error", label: t("connection.unavailable.codex"), accountLabel: null };
  }
  if (!status.loggedIn) {
    return { kind: "loggedOut", tone: "muted", label: t("connection.loggedOut"), accountLabel: null };
  }
  const accountLabel = status.account?.email ?? status.account?.type ?? t("connection.account.codex");
  return { kind: "loggedIn", tone: "connected", label: t("connection.connected"), accountLabel };
}

/**
 * Claude (Claude Code) connection state. Claude runs on the user's Pro/Max
 * subscription via the local `claude` CLI; there is no in-app login flow, so the
 * gate directs the user to authenticate the CLI once in a terminal.
 */
export function resolveClaudeConnectionState(status: DesktopClaudeStatus | null, t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): AiConnectionStateView {
  if (!status) {
    return { kind: "checking", tone: "muted", label: t("connection.checking"), accountLabel: null };
  }
  if (!status.available) {
    return { kind: "unavailable", tone: "error", label: t("connection.unavailable.claude"), accountLabel: null };
  }
  if (!status.loggedIn) {
    return { kind: "loggedOut", tone: "muted", label: t("connection.loggedOut"), accountLabel: null };
  }
  return { kind: "loggedIn", tone: "connected", label: t("connection.connected"), accountLabel: t("connection.account.claude") };
}

export type ClaudeConnection = CliProviderConnection<DesktopClaudeStatus>;

function fallbackClaudeStatus(message: string): DesktopClaudeStatus {
  return {
    available: false,
    running: false,
    loggedIn: false,
    claudeBin: "claude",
    configuredClaudeBin: null,
    account: null,
    error: message,
  };
}

export function useClaudeConnection(): ClaudeConnection {
  return useCliProviderConnection(
    (bridge) => bridge.claude,
    fallbackClaudeStatus,
    resolveClaudeConnectionState,
  );
}

/**
 * Gemini provider connection state. This route runs through Antigravity CLI
 * (`agy`) with the user's Google account; there is no in-app login flow, so the
 * gate directs the user to authenticate the CLI once in a terminal.
 */
export function resolveGeminiConnectionState(status: DesktopGeminiStatus | null, t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): AiConnectionStateView {
  if (!status) {
    return { kind: "checking", tone: "muted", label: t("connection.checking"), accountLabel: null };
  }
  if (!status.available) {
    return { kind: "unavailable", tone: "error", label: t("connection.unavailable.gemini"), accountLabel: null };
  }
  if (!status.loggedIn) {
    return { kind: "loggedOut", tone: "muted", label: t("connection.loggedOut"), accountLabel: null };
  }
  return { kind: "loggedIn", tone: "connected", label: t("connection.connected"), accountLabel: t("connection.account.gemini") };
}

export type GeminiConnection = CliProviderConnection<DesktopGeminiStatus>;

function fallbackGeminiStatus(message: string): DesktopGeminiStatus {
  return {
    available: false,
    loggedIn: false,
    geminiBin: "agy",
    configuredGeminiBin: null,
    account: null,
    error: message,
  };
}

export function useGeminiConnection(): GeminiConnection {
  return useCliProviderConnection(
    (bridge) => bridge.gemini,
    fallbackGeminiStatus,
    resolveGeminiConnectionState,
  );
}

export interface AiConnection {
  status: DesktopCodexStatus | null;
  state: AiConnectionStateView;
  /** True while the very first status lookup is in flight. */
  loading: boolean;
  /** True while a login / logout action is being started. */
  busy: boolean;
  /** True after login() opened the browser and we are waiting for completion. */
  pendingLogin: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => Promise<void>;
  refresh: () => void;
}

function fallbackStatus(message: string): DesktopCodexStatus {
  return {
    available: false,
    running: false,
    loggedIn: false,
    codexHome: "",
    codexBin: "codex",
    configuredCodexBin: null,
    account: null,
    error: message,
  };
}

export function useAiConnection(): AiConnection {
  const t = useT("ai");
  // 接続の失敗文言は設定ダイアログと**同じ操作の同じ文**なので、辞書も
  // `settings.provider.message.*` を唯一の出典にする (同じ語の辞書を2つ持つと必ずドリフトする)。
  const tSettings = useT("settings");
  const [status, setStatus] = useState<DesktopCodexStatus | null>(null);
  // Only show the "checking" state when a Codex bridge actually exists to query.
  const [loading, setLoading] = useState(() => Boolean(getDesktopBridge()?.codex));
  const [busy, setBusy] = useState(false);
  const [pendingLogin, setPendingLogin] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.codex) {
      setStatus(null);
      setLoading(false);
      return;
    }
    bridge.codex.getStatus()
      .then((next) => {
        setStatus(next);
        if (next.loggedIn) {
          setPendingLogin(false);
        }
      })
      .catch((err) => {
        setStatus(fallbackStatus(err instanceof Error ? err.message : tSettings("provider.message.aiStatusFailed")));
      })
      .finally(() => setLoading(false));
  }, [tSettings]);

  useEffect(() => {
    const bridge = getDesktopBridge();
    if (!bridge?.codex) {
      return;
    }

    let cancelled = false;
    const load = () => {
      bridge.codex.getStatus()
        .then((next) => {
          if (cancelled) return;
          setStatus(next);
          if (next.loggedIn) {
            setPendingLogin(false);
          }
        })
        .catch((err) => {
          if (cancelled) return;
          setStatus(fallbackStatus(err instanceof Error ? err.message : tSettings("provider.message.aiStatusFailed")));
        })
        .finally(() => {
          if (!cancelled) {
            setLoading(false);
          }
        });
    };

    load();
    const unsubscribe = bridge.codex.onStatusChange(load);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [tSettings]);

  const login = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.codex) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await bridge.codex.login();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPendingLogin(true);
      setStatus(await bridge.codex.getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : tSettings("provider.message.loginFailed"));
    } finally {
      setBusy(false);
    }
  }, [tSettings]);

  const logout = useCallback(async () => {
    const bridge = getDesktopBridge();
    if (!bridge?.codex) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await bridge.codex.logout();
      setPendingLogin(false);
      setStatus(await bridge.codex.getStatus());
    } catch (err) {
      setError(err instanceof Error ? err.message : tSettings("provider.message.disconnectFailed"));
    } finally {
      setBusy(false);
    }
  }, [tSettings]);

  return {
    status,
    state: resolveAiConnectionState(status, t),
    loading,
    busy,
    pendingLogin,
    error,
    login,
    logout,
    refresh,
  };
}
