import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { createTranslator } from "@/lib/i18n";

import {
  PrintPreviewToolbar,
  resolveDrawerExportUnavailableReason,
  shouldOfferExternalPrintWindow,
} from "./PrintPreviewToolbar";

describe("PrintPreviewToolbar", () => {
  it("offers a separate browser tab only outside desktop and embedded runtimes", () => {
    expect(shouldOfferExternalPrintWindow({ isDesktopApp: false, isEmbedded: false })).toBe(true);
    expect(shouldOfferExternalPrintWindow({ isDesktopApp: true, isEmbedded: false })).toBe(false);
    expect(shouldOfferExternalPrintWindow({ isDesktopApp: false, isEmbedded: true })).toBe(false);
    expect(shouldOfferExternalPrintWindow({ isDesktopApp: true, isEmbedded: true })).toBe(false);
  });

  it("keeps drawer export available in embedded mode", () => {
    expect(resolveDrawerExportUnavailableReason({
      isDesktopApp: false,
      isEmbedded: true,
      hasDesktopExportBridge: false,
    })).toBeUndefined();
  });

  it("disables drawer export in a non-embedded browser", () => {
    expect(resolveDrawerExportUnavailableReason({
      isDesktopApp: false,
      isEmbedded: false,
      hasDesktopExportBridge: false,
    })).toBe("PDF保存はデスクトップ版で利用できます");

    expect(resolveDrawerExportUnavailableReason({
      isDesktopApp: false,
      isEmbedded: false,
      hasDesktopExportBridge: false,
    }, createTranslator("en", "print"))).toBe("PDF saving is available in the desktop app");
  });

  it("keeps drawer export available in desktop mode with the export bridge", () => {
    expect(resolveDrawerExportUnavailableReason({
      isDesktopApp: true,
      isEmbedded: false,
      hasDesktopExportBridge: true,
    })).toBeUndefined();
  });

  it("shows page state and drawer-only actions without output controls", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="ready"
        pageCount={4}
        isExporting={false}
        onOpenExternal={vi.fn()}
        onExport={vi.fn()}
        onClose={vi.fn()}
      />,
    );

    expect(html).toContain("PDFプレビュー");
    expect(html).toContain("全4ページ");
    expect(html).not.toContain("出力プロファイル");
    expect(html).not.toContain("コメントを含める");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="checkbox"');
    expect(html).toContain('aria-label="別ウィンドウで開く"');
    expect(html).toContain('aria-label="閉じる"');
    expect(html).not.toContain("ページ表示");
  });

  it("keeps standalone actions limited to PDF save", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="ready"
        pageCount={2}
        isExporting={false}
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("PDF保存");
    expect(html).not.toContain('aria-label="別ウィンドウで開く"');
    expect(html).not.toContain('aria-label="閉じる"');
    expect(html).not.toContain("出力プロファイル");
    expect(html).not.toContain("コメントを含める");
  });

  it("uses shimmer metadata and a disabled processing action while pending", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="pending"
        pageCount={0}
        isExporting
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("print-preview-toolbar-meta-shimmer");
    expect(html).toContain("PDF保存中");
    expect(html).toContain("disabled");
    expect(html).not.toContain("コメントを含める");
  });

  it("disables PDF save while exporting", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="ready"
        pageCount={2}
        isExporting
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("PDF保存中");
    expect(html).toContain("disabled");
    expect(html).not.toContain("<select");
    expect(html).not.toContain('type="checkbox"');
  });

  it("hides pending metadata when the document is unavailable", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        documentUnavailable
        renderState="pending"
        pageCount={0}
        isExporting={false}
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("PDFプレビュー");
    expect(html).not.toContain("print-preview-toolbar-meta");
    expect(html).not.toContain("print-preview-toolbar-meta-shimmer");
  });

  it("reports a stalled preview and keeps export unavailable", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="stalled"
        pageCount={0}
        isExporting={false}
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("プレビューの準備に失敗しました");
    expect(html).toContain("プレビューの準備完了後にPDF保存できます");
    expect(html).toContain("disabled");
    expect(html).not.toContain("print-preview-toolbar-meta-shimmer");
  });

  it("disables export when the runtime prerequisite is unavailable", () => {
    const html = renderToStaticMarkup(
      <PrintPreviewToolbar
        renderState="ready"
        pageCount={2}
        isExporting={false}
        exportUnavailableReason="PDF保存はデスクトップ版で利用できます"
        onExport={vi.fn()}
      />,
    );

    expect(html).toContain("PDF保存はデスクトップ版で利用できます");
    expect(html).toContain("disabled");
  });
});
