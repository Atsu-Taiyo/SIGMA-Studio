"use client";
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import { ToolbarPopover } from "@/components/editor/ToolbarPopover";
import { AI_PERMISSION_MODES, type AiPermissionMode } from "@/lib/ai/ai-permission-mode";
import { aiProviderLabel, type AiProvider } from "@/lib/ai/ai-providers";
import {
  contextUsageRatio,
  formatTokenCount,
  usageLevel,
  usagePercent,
  type AiAccountUsage,
  type AiContextUsage,
  type AiUsageLevel,
} from "@/lib/ai/ai-usage";
import { useAppLocale, useT } from "@/lib/i18n/react";
import {
  setAiPermissionMode,
  useAiPermissionMode,
  useCanSetAiPermissionMode,
} from "../application/ai-permission-mode-store";
import { refreshAiUsage, syncAiUsage, useAiUsage } from "../application/ai-usage-store";
import { AI_PERMISSION_COPY } from "./ai-permission-copy";
import { formatUsageResetTime } from "./ai-usage-format";
import { AiUsageWindows } from "./AiUsageWindows";

const POPOVER_Z_INDEX = 4900;

/**
 * AIの権限を選ぶボタン。教材に対して AI にどこまで任せるか (読み取りのみ / 承認を求める / 自動で適用)。
 * 入力欄では「＋」の隣にアイコンだけで置き、いまの権限はアイコンの形と title・読み上げで示す。
 * 設定は端末全体のもので、実行中でも次のツール呼び出しから効く。
 */
export function AiPermissionPicker() {
  const t = useT("ai");
  const mode = useAiPermissionMode();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  // 設定の口があるのはデスクトップ版だけ。サーバー側の描画と最初の描画では出さない。
  const available = useCanSetAiPermissionMode();
  if (!available) return null;

  const current = AI_PERMISSION_COPY[mode];
  const CurrentIcon = current.icon;
  const select = async (next: AiPermissionMode) => {
    setOpen(false);
    buttonRef.current?.focus({ preventScroll: true });
    if (next === mode) return;
    setFailed(!(await setAiPermissionMode(next)));
  };

  return (
    <div className="ai-chat-permission-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="ai-chat-icon-button ai-chat-permission-button"
        data-mode={mode}
        title={failed ? t("permission.saveFailed") : `${t("permission.title")}: ${t(current.label)}`}
        aria-label={t("permission.buttonAria", { replace: { label: t(current.label) } })}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setFailed(false);
          setOpen(value => !value);
        }}
      >
        <CurrentIcon size={16} aria-hidden="true" />
      </button>
      {open && (
        <ToolbarPopover
          open
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          align="left"
          placement="top"
          gap={8}
          zIndex={POPOVER_Z_INDEX}
          className="ai-chat-model-menu ai-chat-permission-menu"
          role="menu"
          ariaLabel={t("permission.title")}
        >
          <div className="ai-chat-menu-title">{t("permission.title")}</div>
          {AI_PERMISSION_MODES.map((item) => {
            const copy = AI_PERMISSION_COPY[item];
            const Icon = copy.icon;
            return (
              <button
                key={item}
                type="button"
                role="menuitemradio"
                aria-checked={item === mode}
                className="ai-chat-model-menu-item ai-chat-permission-item"
                {...(item === mode ? { "data-popover-initial-focus": "" } : {})}
                onClick={() => void select(item)}
              >
                <Icon size={14} aria-hidden="true" />
                <span className="ai-chat-permission-item-copy">
                  <span>{t(copy.label)}</span>
                  <small>{t(copy.description)}</small>
                </span>
                {item === mode && <Check size={13} aria-hidden="true" />}
              </button>
            );
          })}
        </ToolbarPopover>
      )}
    </div>
  );
}

const RING_RADIUS = 7;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

function worstLevel(levels: AiUsageLevel[]): AiUsageLevel {
  return levels.includes("reached") ? "reached" : levels.includes("warning") ? "warning" : "normal";
}

function accountLevel(usage: AiAccountUsage): AiUsageLevel {
  if (usage.state !== "available") return "normal";
  return usage.limitReached ? "reached" : worstLevel(usage.windows.map(window => usageLevel(window.usedRatio)));
}

export interface AiUsageButtonProps {
  provider: AiProvider;
  /** この会話のコンテキスト使用量。まだ応答が無い会話・知らせない AI では null。 */
  contextUsage: AiContextUsage | null;
  /** AI設定の「使用状況」を開く (すべての AI の利用枠)。 */
  onOpenUsageSettings?: () => void;
}

/**
 * 使用状況のボタン。輪はこの会話のコンテキスト使用率で、押すとコンテキストと、いまの AI の利用枠が出る。
 * 利用枠が残り少ない・使い切ったときは輪の脇に印を出し、読み上げにも含める。
 */
export function AiUsageButton({ provider, contextUsage, onOpenUsageSettings }: AiUsageButtonProps) {
  const t = useT("ai");
  const usage = useAiUsage()[provider];
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  // 入力欄が出た時・AI を切り替えた時に、main が覚えている値へ合わせる (問い合わせはしない)。
  useEffect(() => {
    void syncAiUsage();
  }, [provider]);
  const ratio = contextUsageRatio(contextUsage);
  const contextLevel = ratio === null ? "normal" : usageLevel(ratio);
  const limitLevel = accountLevel(usage);
  const providerLabel = aiProviderLabel(provider);
  const label = ratio === null
    ? t("usage.buttonAria")
    : t("usage.buttonAriaContext", { replace: { percent: usagePercent(ratio) } });
  const title = limitLevel === "reached" ? `${label} · ${providerLabel}: ${t("usage.limitReached")}` : label;

  return (
    <div className="ai-chat-usage-wrap">
      <button
        ref={buttonRef}
        type="button"
        className="ai-chat-icon-button ai-chat-usage-button"
        data-context-level={contextLevel}
        data-limit-level={limitLevel}
        title={title}
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => {
            // 開くたびに、問い合わせられる AI の値を読み直す。
            if (!value) void refreshAiUsage(provider);
            return !value;
          });
        }}
      >
        <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden="true">
          <circle className="ai-chat-usage-ring-track" cx={9} cy={9} r={RING_RADIUS} />
          {ratio !== null && (
            <circle
              className="ai-chat-usage-ring-value"
              cx={9}
              cy={9}
              r={RING_RADIUS}
              strokeDasharray={`${Math.max(ratio, 0.02) * RING_LENGTH} ${RING_LENGTH}`}
              transform="rotate(-90 9 9)"
            />
          )}
        </svg>
        {limitLevel !== "normal" && <span className="ai-chat-usage-badge" aria-hidden="true" />}
      </button>
      {open && (
        <ToolbarPopover
          open
          anchorRef={buttonRef}
          onClose={() => setOpen(false)}
          align="right"
          placement="top"
          gap={8}
          zIndex={POPOVER_Z_INDEX}
          className="ai-chat-model-menu ai-chat-usage-popover"
          role="dialog"
          ariaLabel={t("usage.buttonAria")}
        >
          <section className="ai-chat-usage-section">
            <h3 className="ai-chat-menu-title">{t("usage.contextTitle")}</h3>
            <AiContextUsageSummary provider={provider} contextUsage={contextUsage} />
          </section>
          <section className="ai-chat-usage-section">
            <h3 className="ai-chat-menu-title">
              {t("usage.accountTitle", { replace: { provider: providerLabel } })}
            </h3>
            <AiUsageWindows usage={usage} />
          </section>
          {onOpenUsageSettings && (
            <button
              type="button"
              className="ai-chat-model-menu-item ai-chat-usage-settings-link"
              onClick={() => {
                setOpen(false);
                onOpenUsageSettings();
              }}
            >
              <span aria-hidden="true" />
              <span>{t("usage.openSettings")}</span>
            </button>
          )}
        </ToolbarPopover>
      )}
    </div>
  );
}

function AiContextUsageSummary({ provider, contextUsage }: Pick<AiUsageButtonProps, "provider" | "contextUsage">) {
  const t = useT("ai");
  if (!contextUsage) {
    // Antigravity の CLI は、応答のトークン数を知らせない。
    return <p className="ai-usage-state">{provider === "antigravity" ? t("usage.contextUnsupported") : t("usage.contextUnknown")}</p>;
  }
  const ratio = contextUsageRatio(contextUsage);
  const used = formatTokenCount(contextUsage.usedTokens);
  if (ratio === null || contextUsage.windowTokens === null) {
    return <p className="ai-usage-state">{t("usage.contextUsedOnly", { replace: { used } })} {t("usage.contextEstimated")}</p>;
  }
  const percent = usagePercent(ratio);
  const summary = t("usage.contextSummary", { replace: { used, window: formatTokenCount(contextUsage.windowTokens), percent } });
  return (
    <div className="ai-usage-window" data-level={usageLevel(ratio)}>
      <div className="ai-usage-window-head">
        <span className="ai-usage-window-label">{summary}</span>
      </div>
      <div
        className="ai-usage-meter"
        role="progressbar"
        aria-label={t("usage.contextTitle")}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={summary}
      >
        <div className="ai-usage-meter-fill" style={{ width: `${percent}%` }} />
      </div>
      <div className="ai-usage-window-reset">{t("usage.contextEstimated")}</div>
    </div>
  );
}

/**
 * 利用枠を使い切っている AI を選んでいるときの一行。送る前に、止められることと戻る時刻が分かる。
 * 使い切っていなければ何も出さない。
 */
export function AiUsageLimitNotice({ provider }: { provider: AiProvider }) {
  const t = useT("ai");
  const locale = useAppLocale();
  const usage = useAiUsage()[provider];
  if (usage.state !== "available" || !usage.limitReached) return null;
  const resets = usage.windows
    .filter(window => window.usedRatio >= 1 && window.resetsAt !== null)
    .map(window => window.resetsAt as number);
  // 複数の窓を使い切っているなら、すべてが戻る時刻 (いちばん遅いもの) を出す。
  const when = resets.length > 0 ? formatUsageResetTime(Math.max(...resets), locale) : null;
  const providerLabel = aiProviderLabel(provider);
  return (
    <p className="ai-chat-usage-notice" role="status">
      {when
        ? t("usage.limitNotice", { replace: { provider: providerLabel, when } })
        : t("usage.limitNoticeNoReset", { replace: { provider: providerLabel } })}
    </p>
  );
}
