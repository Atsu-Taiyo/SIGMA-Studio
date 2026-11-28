import type { AppLocale } from "@/lib/i18n";
import type { Translate } from "@/lib/i18n";
import type { AiAccountUsage, AiUsageWindow } from "@/lib/ai/ai-usage";

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * 60;

/** 窓の呼び名 (5時間・1週間・1週間 (opus) など)。長さが分からない短い窓は、決めつけない呼び名にする。 */
export function formatUsageWindowLabel(window: AiUsageWindow, t: Translate<"ai">): string {
  if (window.kind === "weekly") return t("usage.windowWeekly");
  if (window.kind === "weeklyModel") {
    return t("usage.windowModel", { replace: { window: t("usage.windowWeekly"), model: window.model ?? "" } });
  }
  const minutes = window.windowMinutes;
  if (!minutes) return t("usage.windowSession");
  if (minutes % MINUTES_PER_DAY === 0) return t("usage.windowDays", { replace: { days: minutes / MINUTES_PER_DAY } });
  return t("usage.windowHours", { replace: { hours: Math.round(minutes / MINUTES_PER_HOUR * 10) / 10 } });
}

/**
 * プランの呼び名。AI が返した識別子 (pro・plus・max …) は頭を大文字にして見せ、
 * 内蔵AIの「無料」「試用期間」だけは言葉にする。プランが増えても、知らない名前のまま出せる。
 */
export function formatUsagePlanName(usage: Pick<AiAccountUsage, "provider" | "plan">, t: Translate<"ai">): string | null {
  if (!usage.plan) return null;
  if (usage.provider === "sigma" && usage.plan === "free") return t("usage.planFree");
  if (usage.provider === "sigma" && usage.plan === "trial") return t("usage.planTrial");
  // 識別子の区切り (self_serve_business …) は空白にして読めるようにする。
  const words = usage.plan.replace(/[_-]+/gu, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** リセットの時刻を、その言語の短い日時にする (例: 12/5(土) 12:14)。 */
export function formatUsageResetTime(resetsAt: number, locale: AppLocale): string {
  return new Intl.DateTimeFormat(locale, {
    month: "numeric", day: "numeric", weekday: "short", hour: "numeric", minute: "2-digit",
  }).format(resetsAt);
}
