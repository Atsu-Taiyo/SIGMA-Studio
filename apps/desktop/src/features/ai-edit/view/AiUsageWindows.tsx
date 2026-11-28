"use client";
import { usageLevel, usagePercent, type AiAccountUsage } from "@/lib/ai/ai-usage";
import { useAppLocale, useT } from "@/lib/i18n/react";
import { formatUsageResetTime, formatUsageWindowLabel } from "./ai-usage-format";

/**
 * 1 つの AI の利用枠。窓ごとに「呼び名・使用率・リセットの時刻」を並べる。
 * 値が無いときは、理由 (まだ分からない・この AI は知らせない・プランに含まれない) を文で出す。
 * 入力欄の使用状況と AI設定の両方が、この同じ並びを使う。
 */
export function AiUsageWindows({ usage }: { usage: AiAccountUsage }) {
  const t = useT("ai");
  const locale = useAppLocale();
  if (usage.state !== "available") {
    const text = usage.state === "unsupported"
      ? t("usage.stateUnsupported")
      : usage.state === "notIncluded"
        ? t("usage.stateNotIncluded")
        : usage.provider === "sigma" ? t("usage.stateUnknownSigma") : t("usage.stateUnknown");
    return <p className="ai-usage-state">{text}</p>;
  }
  return (
    <ul className="ai-usage-windows">
      {usage.windows.map((window) => {
        const label = formatUsageWindowLabel(window, t);
        const percent = usagePercent(window.usedRatio);
        const level = usageLevel(window.usedRatio);
        // 色だけに頼らない: 使い切った窓は、数字の代わりに言葉で出す。
        const value = level === "reached" ? t("usage.limitReached") : t("usage.percentUsed", { replace: { percent } });
        const reset = window.resetsAt !== null
          ? t("usage.resetsAt", { replace: { when: formatUsageResetTime(window.resetsAt, locale) } })
          // 内蔵AIの窓は、最初に使った時から始まる。まだ使っていない週には時刻が無い。
          : usage.provider === "sigma" ? t("usage.resetsOnNextUse") : null;
        return (
          <li key={`${window.kind}:${window.model ?? ""}`} className="ai-usage-window" data-level={level}>
            <div className="ai-usage-window-head">
              <span className="ai-usage-window-label">{label}</span>
              <span className="ai-usage-window-value">{value}</span>
            </div>
            <div
              className="ai-usage-meter"
              role="progressbar"
              aria-label={label}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              aria-valuetext={value}
            >
              <div className="ai-usage-meter-fill" style={{ width: `${percent}%` }} />
            </div>
            {reset && <div className="ai-usage-window-reset">{reset}</div>}
          </li>
        );
      })}
    </ul>
  );
}
