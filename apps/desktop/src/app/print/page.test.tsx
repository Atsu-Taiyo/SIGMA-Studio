import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { createTranslator } from "@/lib/i18n";

import PrintPage, {
  isTransientExportNotice,
  resolvePdfExportAvailability,
  shouldShowExportRetry,
  toOutputProfileName,
} from "./page";

describe("PrintPage", () => {
  it("does not expose the initial loading state as a PDF load error", () => {
    const html = renderToStaticMarkup(<PrintPage />);

    expect(html).toContain('class="print-load-pending"');
    expect(html).toContain('class="ui-shimmer-surface print-paper-shimmer-sheet"');
    expect(html).toContain('aria-label="教材を読み込み中"');
    expect(html).not.toContain("print-load-error");
    expect(html).not.toContain('data-print-load-state="error"');
    expect(html).not.toContain("出力プロファイル");
    expect(html).not.toContain("コメントを含める");
    expect(html).not.toContain("ページ表示");
  });

  it("keeps the profile URL contract and defaults invalid values to teacher", () => {
    expect(toOutputProfileName("student")).toBe("student");
    expect(toOutputProfileName("teacher")).toBe("teacher");
    expect(toOutputProfileName("answerBook")).toBe("answerBook");
    expect(toOutputProfileName("unknown")).toBe("teacher");
    expect(toOutputProfileName(null)).toBe("teacher");
  });

  it("auto-dismisses only transient export notices", () => {
    expect(isTransientExportNotice({ kind: "success", message: "完了" })).toBe(true);
    expect(isTransientExportNotice({ kind: "cancelled", message: "キャンセル" })).toBe(true);
    expect(isTransientExportNotice({ kind: "progress", message: "処理中" })).toBe(false);
    expect(isTransientExportNotice({ kind: "error", message: "失敗" })).toBe(false);
  });

  it("classifies missing file and bridge prerequisites as terminal", () => {
    expect(resolvePdfExportAvailability({ fileId: null, hasDesktopExportBridge: true })).toEqual({
      available: false,
      reason: "PDF保存する教材が指定されていません",
    });
    expect(resolvePdfExportAvailability({ fileId: "file-1", hasDesktopExportBridge: false })).toEqual({
      available: false,
      reason: "PDF保存はデスクトップ版で利用できます",
    });
    expect(resolvePdfExportAvailability({ fileId: "file-1", hasDesktopExportBridge: true })).toEqual({
      available: true,
    });

    const t = createTranslator("en", "print");
    expect(resolvePdfExportAvailability({ fileId: null, hasDesktopExportBridge: true }, t)).toEqual({
      available: false,
      reason: "No material was specified for PDF saving",
    });
    expect(resolvePdfExportAvailability({ fileId: "file-1", hasDesktopExportBridge: false }, t)).toEqual({
      available: false,
      reason: "PDF saving is available in the desktop app",
    });
  });

  it("offers retry only for transient export failures", () => {
    expect(shouldShowExportRetry({ kind: "error", message: "一時的な失敗", retryable: true })).toBe(true);
    expect(shouldShowExportRetry({ kind: "error", message: "前提条件不足", retryable: false })).toBe(false);
    expect(shouldShowExportRetry(null)).toBe(false);
  });
});
