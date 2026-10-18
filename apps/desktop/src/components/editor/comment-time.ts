import { useSyncExternalStore } from "react";

import type { AppLocale } from "@/lib/i18n";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * コメントの時刻の表記。Figma や Claude と同じく、近い時刻は「今」「5分前」「3時間前」「昨日」と
 * 経過で書き、1週間より前は日付にする。正確な日時はツールチップ (`formatCommentAbsoluteTime`) に出す。
 * 表記は**表示中の UI 言語**に従う。
 */
export function formatCommentRelativeTime(value: string, now: number, locale: AppLocale, justNow: string): string {
  const time = new Date(value).getTime();
  if (Number.isNaN(time)) {
    return "";
  }
  // 端末の時計のずれで少し先の時刻になっても「今」と書く。
  const elapsed = Math.max(0, now - time);
  if (elapsed < MINUTE_MS) {
    return justNow;
  }
  const relative = new Intl.RelativeTimeFormat(locale, { numeric: "auto", style: "short" });
  if (elapsed < HOUR_MS) {
    return relative.format(-Math.floor(elapsed / MINUTE_MS), "minute");
  }
  if (elapsed < DAY_MS) {
    return relative.format(-Math.floor(elapsed / HOUR_MS), "hour");
  }
  if (elapsed < 7 * DAY_MS) {
    return relative.format(-Math.floor(elapsed / DAY_MS), "day");
  }
  const date = new Date(time);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(locale, sameYear ? { month: "short", day: "numeric" } : { year: "numeric", month: "short", day: "numeric" });
}

export function formatCommentAbsoluteTime(value: string, locale: AppLocale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** 「5分前」を進めるための、画面全体で 1 つの時計。カードごとにタイマーを持たない。 */
let clockNow = Date.now();
const clockListeners = new Set<() => void>();
let clockTimer: ReturnType<typeof setInterval> | null = null;

function subscribeClock(listener: () => void) {
  clockListeners.add(listener);
  if (!clockTimer) {
    clockNow = Date.now();
    clockTimer = setInterval(() => {
      clockNow = Date.now();
      clockListeners.forEach((notify) => notify());
    }, 30_000);
  }
  return () => {
    clockListeners.delete(listener);
    if (clockListeners.size === 0 && clockTimer) {
      clearInterval(clockTimer);
      clockTimer = null;
    }
  };
}

export function useCommentClock(): number {
  return useSyncExternalStore(subscribeClock, () => clockNow, () => clockNow);
}
