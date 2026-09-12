"use client";

import { useState, type ReactNode } from "react";
import { AlertCircle, Check, ExternalLink, Loader2, LogIn, RefreshCw, Settings } from "lucide-react";

import { AntigravityMark, ClaudeMark, OpenAiMark } from "@/components/branding/provider-logos";
import type { AiConnection, AiConnectionStateView, ClaudeConnection, GeminiConnection } from "@/lib/ai/ai-connection";
import { useT } from "@/lib/i18n/react";
import { getDesktopBridge } from "@/lib/desktop-bridge";

/**
 * Full-panel sign-in screen shown in the AI sidebar whenever the ChatGPT
 * connection is not ready. Gives the user an in-context path to sign in instead
 * of forcing them to dig through settings.
 */
export function AiConnectionGate({
  connection,
  onOpenSettings,
}: {
  connection: AiConnection;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  // CLI の導入ラベル・失敗文言は設定ダイアログと同じ文なので出典を1つに保つ。
  const tSettings = useT("settings");
  const { state, loading, busy, pendingLogin, error, login, refresh } = connection;
  const [installPageError, setInstallPageError] = useState<string | null>(null);
  const kind = loading ? "checking" : state.kind;
  const statusError = installPageError ?? error ?? connection.status?.error ?? null;

  const openInstallPage = async () => {
    setInstallPageError(null);
    const result = await getDesktopBridge()?.codex.openInstallPage();
    if (result && !result.ok) {
      setInstallPageError(result.error ?? tSettings("provider.message.codexInstallOpenFailed"));
    }
  };

  return (
    <div className="ai-connection-gate" data-state={kind}>
      <div className="ai-connection-gate-card">
        <span className="ai-connection-hero" data-state={kind} aria-hidden="true">
          <span className="ai-connection-hero-logo">
            <OpenAiMark size={34} />
          </span>
          <span className="ai-connection-hero-badge" data-state={kind}>
            {kind === "checking" ? (
              <Loader2 size={13} className="ai-spin" />
            ) : kind === "unavailable" ? (
              <AlertCircle size={13} />
            ) : kind === "loggedIn" ? (
              <Check size={13} />
            ) : (
              <LogIn size={13} />
            )}
          </span>
        </span>

        {kind === "checking" && (
          <>
            <h3 className="ai-connection-title">{t("gate.checking")}</h3>
            <p className="ai-connection-text">{t("gate.codex.checkingText")}</p>
          </>
        )}

        {kind === "loggedOut" && (
          <>
            <h3 className="ai-connection-title">{t("gate.codex.loggedOutTitle")}</h3>
            <p className="ai-connection-text">
              {t("gate.codex.loggedOutIntro")}
            </p>
            <button
              type="button"
              className="ai-connection-login"
              onClick={() => void login()}
              disabled={busy}
            >
              {busy ? (
                <>
                  <Loader2 size={16} className="ai-spin" />
                  <span>{t("gate.codex.preparingLogin")}</span>
                </>
              ) : (
                <>
                  <span className="ai-connection-login-logo" aria-hidden="true">
                    <OpenAiMark size={15} />
                  </span>
                  <span>{t("gate.codex.login")}</span>
                </>
              )}
            </button>
            {pendingLogin ? (
              <p className="ai-connection-pending">
                <Loader2 size={13} className="ai-spin" />
                <span>{t("gate.codex.pendingLogin")}</span>
              </p>
            ) : (
              <p className="ai-connection-note">{t("gate.codex.browserNote")}</p>
            )}
          </>
        )}

        {kind === "unavailable" && (
          <>
            <h3 className="ai-connection-title">{t("gate.codex.unavailableTitle")}</h3>
            <p className="ai-connection-text">
              {t("gate.pathNote")}
            </p>
            <ol className="ai-connection-steps">
              <li>{t("gate.stepRunBefore")}<code>which codex</code>{t("gate.stepRunAfter")}</li>
              <li>{t("gate.codex.stepPastePath")}</li>
              <li>{t("gate.stepRecheck")}</li>
            </ol>
            <div className="ai-connection-actions">
              <button type="button" className="ai-connection-secondary" onClick={() => void openInstallPage()}>
                <ExternalLink size={14} />
                <span>{tSettings("provider.installCodex")}</span>
              </button>
              <button type="button" className="ai-connection-login" onClick={refresh} disabled={busy}>
                <RefreshCw size={15} className={busy ? "ai-spin" : undefined} />
                <span>{t("gate.recheck")}</span>
              </button>
              {onOpenSettings && (
                <button type="button" className="ai-connection-secondary" onClick={onOpenSettings}>
                  <Settings size={14} />
                  <span>{t("gate.openSettings")}</span>
                </button>
              )}
            </div>
          </>
        )}

        {statusError && kind !== "checking" && (
          <p className="ai-connection-gate-error" role="alert">
            {statusError}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Config for the generic local-CLI connection gate (Finding 4): Claude and
 * Gemini both run on a subscription/account via a local CLI with no in-app
 * login flow, so `ClaudeConnectionGate` / `GeminiConnectionGate` were
 * near-identical copies differing only in copy text, the hero mark, and which
 * bridge section's `openInstallPage` to call. Both must never mention API
 * keys (subscription / Google-account login only; no API billing).
 */
interface CliConnectionGateConfig {
  hero: ReactNode;
  checkingText: string;
  loggedOutTitle: string;
  loggedOutIntro: ReactNode;
  loggedOutSteps: ReactNode;
  unavailableTitle: string;
  unavailableText: ReactNode;
  unavailableSteps?: ReactNode;
  installLabel: string;
  installFallbackErrorMessage: string;
  openInstallPage: () => Promise<{ ok: boolean; error?: string } | undefined>;
}

function CliConnectionGate<TConnection extends {
  state: AiConnectionStateView;
  loading: boolean;
  refresh: () => void;
  status: { error: string | null } | null;
}>({
  connection,
  onOpenSettings,
  config,
}: {
  connection: TConnection;
  onOpenSettings?: () => void;
  config: CliConnectionGateConfig;
}) {
  const t = useT("ai");
  const { state, loading, refresh } = connection;
  const [installPageError, setInstallPageError] = useState<string | null>(null);
  const kind = loading ? "checking" : state.kind;
  const statusError = installPageError ?? connection.status?.error ?? null;

  const openInstallPage = async () => {
    setInstallPageError(null);
    const result = await config.openInstallPage();
    if (result && !result.ok) {
      setInstallPageError(result.error ?? config.installFallbackErrorMessage);
    }
  };

  return (
    <div className="ai-connection-gate" data-state={kind}>
      <div className="ai-connection-gate-card">
        <span className="ai-connection-hero" data-state={kind} aria-hidden="true">
          <span className="ai-connection-hero-logo">{config.hero}</span>
          <span className="ai-connection-hero-badge" data-state={kind}>
            {kind === "checking" ? (
              <Loader2 size={13} className="ai-spin" />
            ) : kind === "unavailable" ? (
              <AlertCircle size={13} />
            ) : kind === "loggedIn" ? (
              <Check size={13} />
            ) : (
              <LogIn size={13} />
            )}
          </span>
        </span>

        {kind === "checking" && (
          <>
            <h3 className="ai-connection-title">{t("gate.checking")}</h3>
            <p className="ai-connection-text">{config.checkingText}</p>
          </>
        )}

        {kind === "loggedOut" && (
          <>
            <h3 className="ai-connection-title">{config.loggedOutTitle}</h3>
            <p className="ai-connection-text">{config.loggedOutIntro}</p>
            <ol className="ai-connection-steps">{config.loggedOutSteps}</ol>
            <button type="button" className="ai-connection-login" onClick={refresh}>
              <RefreshCw size={15} />
              <span>{t("gate.recheck")}</span>
            </button>
          </>
        )}

        {kind === "unavailable" && (
          <>
            <h3 className="ai-connection-title">{config.unavailableTitle}</h3>
            <p className="ai-connection-text">{config.unavailableText}</p>
            {config.unavailableSteps && (
              <ol className="ai-connection-steps">{config.unavailableSteps}</ol>
            )}
            <div className="ai-connection-actions">
              <button type="button" className="ai-connection-secondary" onClick={() => void openInstallPage()}>
                <ExternalLink size={14} />
                <span>{config.installLabel}</span>
              </button>
              <button type="button" className="ai-connection-login" onClick={refresh}>
                <RefreshCw size={15} />
                <span>{t("gate.recheck")}</span>
              </button>
              {onOpenSettings && (
                <button type="button" className="ai-connection-secondary" onClick={onOpenSettings}>
                  <Settings size={14} />
                  <span>{t("gate.openSettings")}</span>
                </button>
              )}
            </div>
          </>
        )}

        {statusError && kind !== "checking" && (
          <p className="ai-connection-gate-error" role="alert">
            {statusError}
          </p>
        )}
      </div>
    </div>
  );
}

/**
 * Full-panel sign-in screen for Claude (Claude Code). Claude has no in-app login
 * flow — it runs on the user's Pro/Max subscription via the local `claude` CLI —
 * so this gate explains the one-time terminal login and offers a re-check button.
 * It must never mention API keys (subscription only; no API billing).
 */
export function ClaudeConnectionGate({
  connection,
  onOpenSettings,
}: {
  connection: ClaudeConnection;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  const tSettings = useT("settings");
  const lookupCommand = getCliLookupCommand("claude");
  return (
    <CliConnectionGate
      connection={connection}
      onOpenSettings={onOpenSettings}
      config={{
        hero: <ClaudeMark size={34} />,
        checkingText: t("gate.claude.checkingText"),
        loggedOutTitle: t("gate.claude.loggedOutTitle"),
        loggedOutIntro: t("gate.claude.loggedOutIntro"),
        loggedOutSteps: (
          <>
            <li>{t("gate.stepOpenTerminal")}</li>
            <li>{t("gate.stepRunBefore")}<code>claude</code>{t("gate.claude.stepRunAfter")}<code>claude setup-token</code>{t("gate.claude.stepRunEnd")}</li>
            <li>{t("gate.claude.stepLogin")}</li>
            <li>{t("gate.stepRecheck")}</li>
          </>
        ),
        unavailableTitle: t("gate.claude.unavailableTitle"),
        unavailableText: (
          <>
            {t("gate.pathNote")}
          </>
        ),
        unavailableSteps: (
          <>
            <li>{t("gate.stepRunBefore")}<code>{lookupCommand}</code>{t("gate.stepRunAfter")}</li>
            <li>{t("gate.claude.stepPastePath")}</li>
            <li>{t("gate.stepRecheck")}</li>
          </>
        ),
        installLabel: tSettings("provider.installClaude"),
        installFallbackErrorMessage: tSettings("provider.message.claudeInstallOpenFailed"),
        openInstallPage: async () => getDesktopBridge()?.claude?.openInstallPage(),
      }}
    />
  );
}

/**
 * Full-panel sign-in screen for the Gemini route backed by Antigravity CLI.
 * It has no in-app login flow — it runs on the user's Google account via `agy` —
 * so this gate explains the one-time terminal login and offers a re-check button.
 * It must never mention API keys (Google account login only; no API billing).
 */
export function GeminiConnectionGate({
  connection,
  onOpenSettings,
}: {
  connection: GeminiConnection;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  const tSettings = useT("settings");
  const lookupCommand = getCliLookupCommand("agy");
  return (
    <CliConnectionGate
      connection={connection}
      onOpenSettings={onOpenSettings}
      config={{
        hero: <AntigravityMark size={34} />,
        checkingText: t("gate.gemini.checkingText"),
        loggedOutTitle: t("gate.gemini.loggedOutTitle"),
        loggedOutIntro: t("gate.gemini.loggedOutIntro"),
        loggedOutSteps: (
          <>
            <li>{t("gate.stepOpenTerminal")}</li>
            <li>{t("gate.stepRunBefore")}<code>agy</code>{t("gate.gemini.stepRunAfter")}</li>
            <li>{t("gate.gemini.stepLogin")}</li>
            <li>{t("gate.stepRecheck")}</li>
          </>
        ),
        unavailableTitle: t("gate.gemini.unavailableTitle"),
        unavailableText: (
          <>
            {t("gate.pathNote")}
          </>
        ),
        unavailableSteps: (
          <>
            <li>{t("gate.stepRunBefore")}<code>{lookupCommand}</code>{t("gate.stepRunAfter")}</li>
            <li>{t("gate.gemini.stepPastePath")}</li>
            <li>{t("gate.stepRecheck")}</li>
          </>
        ),
        installLabel: tSettings("provider.installGemini"),
        installFallbackErrorMessage: tSettings("provider.message.geminiInstallOpenFailed"),
        openInstallPage: async () => getDesktopBridge()?.gemini?.openInstallPage(),
      }}
    />
  );
}

function getCliLookupCommand(command: string): string {
  return getDesktopBridge()?.platform === "win32" ? `where.exe ${command}` : `which ${command}`;
}

/**
 * Compact connected-account indicator shown in the AI sidebar header once the
 * ChatGPT connection is live. Acts as a shortcut into the connection settings.
 */
export function AiConnectionChip({
  connection,
  onOpenSettings,
}: {
  connection: AiConnection;
  onOpenSettings?: () => void;
}) {
  const t = useT("ai");
  const { state } = connection;
  const label = state.accountLabel ?? state.label;
  const interactive = Boolean(onOpenSettings);

  return (
    <button
      type="button"
      className="ai-connection-chip"
      data-tone={state.tone}
      onClick={onOpenSettings}
      disabled={!interactive}
      title={t(interactive ? "gate.chipTitle" : "gate.chipTitleStatic", { replace: { label } })}
      aria-label={t("gate.chipAria", { replace: { label } })}
    >
      <span className="ai-connection-chip-logo" aria-hidden="true">
        <OpenAiMark size={12} />
      </span>
      <span className="ai-connection-chip-dot" aria-hidden="true" />
      <span className="ai-connection-chip-label">{label}</span>
    </button>
  );
}
