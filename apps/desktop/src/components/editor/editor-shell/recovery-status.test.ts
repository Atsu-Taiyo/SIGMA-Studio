import { describe, expect, it } from "vitest";

import { formatDocumentRecoveryStatus } from "./recovery-status";
import { createTranslator } from "@/lib/i18n";

describe("formatDocumentRecoveryStatus", () => {
  it("summarizes callouts separately and reports protected local data", () => {
    expect(formatDocumentRecoveryStatus([
      {
        kind: "overlayShape",
        path: ["pageLayout", "overlay", "overlaySnapshot", "shapes", 0],
        id: "legacy_callout",
        type: "callout",
        message: "図形の形式が異なるため除外しました。",
      },
      {
        kind: "comment",
        path: ["comments", 0],
        message: "コメントの形式が異なるため除外しました。",
      },
    ], true)).toBe("一部を除外して読み込みました（吹き出し1件、その他1件）。元データは保護されています");
  });

  it("reports an unchanged source file for imports and returns null without issues", () => {
    expect(formatDocumentRecoveryStatus([
      {
        kind: "block",
        path: ["content", 1],
        message: "本文要素の形式が異なるため除外しました。",
      },
    ], false)).toBe("一部を除外して読み込みました（その他1件）。元ファイルは変更していません");
    expect(formatDocumentRecoveryStatus([], false)).toBeNull();
  });

  it("formats recovery details in English when requested", () => {
    expect(formatDocumentRecoveryStatus([
      {
        kind: "overlayShape",
        path: ["pageLayout", "overlay", "overlaySnapshot", "shapes", 0],
        id: "legacy_callout",
        type: "callout",
        message: "fixture",
      },
      { kind: "comment", path: ["comments", 0], message: "fixture" },
    ], true, createTranslator("en", "editor"))).toBe(
      "Loaded with some content omitted (Callouts: 1, Other items: 1). The original data is protected",
    );
  });
});
