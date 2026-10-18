import { describe, expect, it } from "vitest";

import { formatCommentRelativeTime } from "./comment-time";

const now = new Date("2026-10-18T12:00:00Z").getTime();
const ago = (ms: number) => new Date(now - ms).toISOString();
const MINUTE = 60_000;

describe("formatCommentRelativeTime", () => {
  it("1分未満は「今」、そこから分・時間・日の経過で書く", () => {
    expect(formatCommentRelativeTime(ago(20_000), now, "ja", "今")).toBe("今");
    expect(formatCommentRelativeTime(ago(5 * MINUTE), now, "ja", "今")).toBe("5 分前");
    expect(formatCommentRelativeTime(ago(3 * 60 * MINUTE), now, "ja", "今")).toBe("3 時間前");
    expect(formatCommentRelativeTime(ago(26 * 60 * MINUTE), now, "ja", "今")).toBe("昨日");
    expect(formatCommentRelativeTime(ago(5 * MINUTE), now, "en", "now")).toBe("5 min. ago");
  });

  it("端末の時計がずれて少し先の時刻でも「今」にし、1週間より前は日付にする", () => {
    expect(formatCommentRelativeTime(new Date(now + 30_000).toISOString(), now, "ja", "今")).toBe("今");
    expect(formatCommentRelativeTime(ago(10 * 24 * 60 * MINUTE), now, "ja", "今")).toBe("10月8日");
    expect(formatCommentRelativeTime("2025-01-02T00:00:00Z", now, "en", "now")).toMatch(/2025/);
    expect(formatCommentRelativeTime("not a date", now, "ja", "今")).toBe("");
  });
});
