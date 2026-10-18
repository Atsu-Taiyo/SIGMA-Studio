import { describe, expect, it } from "vitest";

import {
  selectVersionsToDiscard,
  VERSION_RETENTION_DAILY_MS,
  VERSION_RETENTION_RECENT_MS,
  VERSION_RETENTION_WEEKLY_MS,
  type RetainableVersion,
} from "./document-version-retention";

const HOUR = 60 * 60 * 1_000;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-18T03:00:00.000Z");

const at = (id: string, ms: number): RetainableVersion => ({ id, capturedAt: new Date(ms).toISOString() });

/** What survives repeated thinning, the way every append re-runs it. */
function thinOverTime(versions: RetainableVersion[], fromMs: number, toMs: number, stepMs: number): string[] {
  let kept = versions;
  for (let now = fromMs; now <= toMs; now += stepMs) {
    const discarded = new Set(selectVersionsToDiscard(kept, now));
    kept = kept.filter((version) => !discarded.has(version.id));
  }
  return kept.map((version) => version.id);
}

describe("selectVersionsToDiscard", () => {
  it("keeps every version from the last 24 hours", () => {
    const versions = Array.from({ length: 144 }, (_, index) => at(`v${index}`, NOW - index * 10 * 60 * 1_000));
    expect(selectVersionsToDiscard(versions, NOW)).toEqual([]);
  });

  it("keeps only the last version of each day between 24 hours and 30 days", () => {
    const day = Date.parse("2026-10-10T00:00:00.000Z");
    const versions = [
      at("morning", day + 8 * HOUR),
      at("noon", day + 12 * HOUR),
      at("evening", day + 20 * HOUR),
      at("next-day", day + DAY + 9 * HOUR),
      at("latest", NOW),
    ];
    expect(selectVersionsToDiscard(versions, NOW)).toEqual(["morning", "noon"]);
  });

  it("keeps only the last version of each Monday-based week between 30 days and a year", () => {
    // 2026-08-03 is a Monday; both versions fall in the same week, the next one starts a new week.
    const monday = Date.parse("2026-08-03T00:00:00.000Z");
    const versions = [
      at("monday", monday + 10 * HOUR),
      at("sunday", monday + 6 * DAY + 10 * HOUR),
      at("next-monday", monday + 7 * DAY + 10 * HOUR),
      at("latest", NOW),
    ];
    expect(NOW - (monday + 7 * DAY)).toBeGreaterThan(VERSION_RETENTION_DAILY_MS);
    expect(selectVersionsToDiscard(versions, NOW)).toEqual(["monday"]);
  });

  it("drops versions older than a year, but never the newest one", () => {
    const old = NOW - VERSION_RETENTION_WEEKLY_MS - DAY;
    expect(selectVersionsToDiscard([at("older", old - DAY), at("old", old), at("latest", NOW)], NOW)).toEqual(["older", "old"]);
    expect(selectVersionsToDiscard([at("only", old)], NOW)).toEqual([]);
  });

  it("puts the day boundary at local midnight when given the offset", () => {
    // 23:30 and 00:30 JST on consecutive days are the same UTC day.
    const lateJst = Date.parse("2026-10-10T14:30:00.000Z");
    const earlyJst = Date.parse("2026-10-10T15:30:00.000Z");
    const versions = [at("late", lateJst), at("early", earlyJst), at("latest", NOW)];
    expect(selectVersionsToDiscard(versions, NOW)).toEqual(["late"]);
    expect(selectVersionsToDiscard(versions, NOW, { utcOffsetMinutes: 540 })).toEqual([]);
  });

  it("never discards a version whose time cannot be read", () => {
    const versions = [{ id: "unknown", capturedAt: "yesterday" }, at("a", NOW - 3 * DAY), at("b", NOW - 3 * DAY + HOUR), at("latest", NOW)];
    expect(selectVersionsToDiscard(versions, NOW)).toEqual(["a"]);
  });

  it("converges on one version per day and per week as time passes, instead of losing whole days", () => {
    // A version every 10 minutes for 3 days, then thinned as an append would every hour for 40 days.
    const start = NOW - 3 * DAY;
    const versions = Array.from({ length: 3 * 144 }, (_, index) => at(`v${index}`, start + index * 10 * 60 * 1_000));
    const kept = thinOverTime(versions, NOW, NOW + 40 * DAY, HOUR);
    // 40+ days later every version is older than 30 days: one per week remains, and the newest.
    const keptTimes = kept.map((id) => Date.parse(versions.find((version) => version.id === id)!.capturedAt));
    expect(kept.length).toBeGreaterThanOrEqual(1);
    expect(kept.length).toBeLessThanOrEqual(2);
    expect(keptTimes.at(-1)).toBe(start + (3 * 144 - 1) * 10 * 60 * 1_000);
    // Before the 30-day mark, each of the three days kept its last version.
    const daily = thinOverTime(versions, NOW, NOW + 10 * DAY, HOUR);
    expect(daily).toHaveLength(new Set(versions.map((version) => version.capturedAt.slice(0, 10))).size);
    expect(VERSION_RETENTION_RECENT_MS).toBe(DAY);
  });
});
