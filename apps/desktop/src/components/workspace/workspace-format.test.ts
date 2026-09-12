import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import { formatDateTime, resolveFileDisplayName, resolveFolderDisplayName } from "./workspace-format";

const tJa = createTranslator("ja", "workspace");
const tEn = createTranslator("en", "workspace");

describe("workspace-format", () => {
  describe("resolveFileDisplayName", () => {
    it("returns the file title when present", () => {
      expect(resolveFileDisplayName({ title: "二次関数の確認" }, tJa)).toBe("二次関数の確認");
    });

    it("falls back to 無題の教材 for an empty title", () => {
      expect(resolveFileDisplayName({ title: "" }, tJa)).toBe("無題の教材");
    });

    it("falls back to the English placeholder in English", () => {
      const name = resolveFileDisplayName({ title: "" }, tEn);
      expect(name).toBe("Untitled material");
      expect(name).not.toMatch(/[ぁ-んァ-ヶ一-龥]/u);
    });
  });

  describe("resolveFolderDisplayName", () => {
    it("returns the folder name", () => {
      expect(resolveFolderDisplayName({ name: "数学" })).toBe("数学");
    });
  });

  describe("formatDateTime", () => {
    it("formats an ISO timestamp into a month/day/hour/minute ja-JP string", () => {
      const formatted = formatDateTime("2026-07-26T09:05:00.000Z", "ja");
      expect(typeof formatted).toBe("string");
      expect(formatted.length).toBeGreaterThan(0);
      expect(formatted).toBe(
        new Intl.DateTimeFormat("ja", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date("2026-07-26T09:05:00.000Z")),
      );
    });

    /**
     * 日付の並びは言語ごとに違う (ja は 7/26、en は 7/26 でも時刻表記が変わる)。
     * `"ja-JP"` 決め打ちのままだと英語 UI に日本式の表記が残るので、
     * **2 つのロケールで実際に違う文字列が出ること**を押さえる。
     */
    it("formats with the requested locale, not a hard-coded ja-JP", () => {
      const stamp = "2026-07-26T09:05:00.000Z";
      expect(formatDateTime(stamp, "en")).toBe(
        new Intl.DateTimeFormat("en", {
          month: "numeric",
          day: "numeric",
          hour: "2-digit",
          minute: "2-digit",
        }).format(new Date(stamp)),
      );
      expect(formatDateTime(stamp, "en")).not.toBe(formatDateTime(stamp, "ja"));
    });
  });
});
