/**
 * 版の間引き。ローカル教材の版履歴 (デスクトップのサイドカー・Web の IndexedDB) と、共有教材で
 * 共有サーバーが自動で残す版が、同じ規則で残す (#244)。共有サーバーは公開リポの写しからこのファイルを
 * 読むので、ここは他のモジュールを import しない。
 *
 * - 直近 24 時間: すべて残す (版は 10 分ごと、AI の適用・復元のたびにも作られる)
 * - 24 時間〜30 日: 1 日ごとに、その日の最後の版だけ
 * - 30 日〜1 年: 1 週 (月曜始まり) ごとに、その週の最後の版だけ
 * - 1 年より前: 残さない
 * - いちばん新しい版は、いつの版でも残す
 *
 * 日・週の区切りは時刻から決まる固定の枠で、今の時刻からの相対ではない。相対にすると時間が進むたびに
 * 「枠の最後の版」が入れ替わり、間引くたびに別の版が消えて、結局どの日も残らなくなる。
 */

export const VERSION_RETENTION_RECENT_MS = 24 * 60 * 60 * 1_000;
export const VERSION_RETENTION_DAILY_MS = 30 * 24 * 60 * 60 * 1_000;
export const VERSION_RETENTION_WEEKLY_MS = 365 * 24 * 60 * 60 * 1_000;

const DAY_MS = 24 * 60 * 60 * 1_000;
const WEEK_MS = 7 * DAY_MS;
/** 1970-01-01 は木曜。3 日足すと週の枠が月曜で切り替わる。 */
const MONDAY_WEEK_SHIFT_MS = 3 * DAY_MS;

export interface RetainableVersion {
  id: string;
  /** ISO 8601。読めない時刻の版は消さない (どの枠に入るか決められない)。 */
  capturedAt: string;
}

export interface VersionRetentionOptions {
  /**
   * 日・週の区切りをずらす分 (UTC からの差)。ローカル教材は端末の時差 (日本なら 540) を渡し、
   * 日付が変わる位置を利用者の 0 時にそろえる。共有サーバーは UTC (0)。
   */
  utcOffsetMinutes?: number;
}

/** 間引きで消す版の id。古い順。 */
export function selectVersionsToDiscard(
  versions: readonly RetainableVersion[],
  nowMs: number,
  { utcOffsetMinutes = 0 }: VersionRetentionOptions = {},
): string[] {
  const dated = versions
    .map((version) => ({ id: version.id, at: Date.parse(version.capturedAt) }))
    .filter((version) => Number.isFinite(version.at))
    // 新しい順。同じ時刻は id で順を決め、何度間引いても同じ版を残す。
    .sort((a, b) => b.at - a.at || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
  const offsetMs = utcOffsetMinutes * 60 * 1_000;
  const keptBuckets = new Set<string>();
  const discarded: string[] = [];
  dated.forEach((version, index) => {
    const age = nowMs - version.at;
    if (age < VERSION_RETENTION_RECENT_MS) return;
    const newest = index === 0;
    if (age >= VERSION_RETENTION_WEEKLY_MS) {
      if (!newest) discarded.push(version.id);
      return;
    }
    const local = version.at + offsetMs;
    const bucket = age < VERSION_RETENTION_DAILY_MS
      ? `day:${Math.floor(local / DAY_MS)}`
      : `week:${Math.floor((local + MONDAY_WEEK_SHIFT_MS) / WEEK_MS)}`;
    // 新しい順に見ているので、枠で最初に出会った版がその枠の最後の版。
    if (keptBuckets.has(bucket)) {
      discarded.push(version.id);
      return;
    }
    keptBuckets.add(bucket);
  });
  return discarded.reverse();
}
