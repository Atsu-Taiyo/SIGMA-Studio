import { describe, expect, it, vi } from "vitest";

import {
  getEditorPageNavigationMetrics,
  getVisibleEditorPageNumber,
  scrollEditorCanvasToPage,
} from "@/components/editor/editor-shell/page-navigation";
import { PAGE_NAVIGATOR_SCROLL_PADDING_PX } from "@/components/editor/editor-shell/constants";
import { createEmptyEditorDocument } from "@/lib/blank-document";

function rectangle(top: number, bottom: number): DOMRect {
  return { top, bottom } as DOMRect;
}

function editorScroller(options: {
  canvasTop: number;
  canvasBottom?: number;
  viewportTop: number;
  viewportBottom: number;
  scrollTop?: number;
}) {
  const canvas = {
    getBoundingClientRect: () => rectangle(options.canvasTop, options.canvasBottom ?? options.canvasTop),
  } as HTMLElement;
  const scrollTo = vi.fn();
  const scroller = {
    querySelector: () => canvas,
    getBoundingClientRect: () => rectangle(options.viewportTop, options.viewportBottom),
    scrollTop: options.scrollTop ?? 0,
    scrollTo,
  } as unknown as HTMLElement;

  return { scroller, scrollTo };
}

describe("editor page navigation", () => {
  it("derives the page stride from the normalized document page height and page gap", () => {
    expect(getEditorPageNavigationMetrics(createEmptyEditorDocument()).pageStride)
      .toBeCloseTo((297 * 96) / 25.4 + 36);
  });

  it("returns null without a mounted page canvas", () => {
    const scroller = {
      querySelector: () => null,
    } as unknown as HTMLElement;

    expect(getVisibleEditorPageNumber(null, createEmptyEditorDocument(), 100)).toBeNull();
    expect(getVisibleEditorPageNumber(scroller, createEmptyEditorDocument(), 100)).toBeNull();
  });

  it("keeps the reading inside the paper when the whole document fits on screen", () => {
    // 縮小するとビューポートは紙より «下» まで伸びる。割り戻した下端をそのまま使うと
    // スクロールしていないのに最終ページを指す（実測: 3ページを 10% にして「3 / 3」）。
    const { pageStride } = getEditorPageNavigationMetrics(createEmptyEditorDocument());
    const zoom = 10;
    const zoomScale = zoom / 100;
    const canvasTop = 0;
    // 3ページぶんの紙が 10% で描かれている高さ。
    const canvasBottom = canvasTop + pageStride * 3 * zoomScale;
    const { scroller } = editorScroller({
      canvasTop,
      canvasBottom,
      viewportTop: canvasTop,
      // ビューポートは紙の下端よりずっと下まである。
      viewportBottom: canvasTop + pageStride * 3 * zoomScale * 4,
    });

    // 紙の中央 = 2ページ目。少なくとも総ページ数を超えないこと。
    expect(getVisibleEditorPageNumber(scroller, createEmptyEditorDocument(), zoom)).toBe(2);
  });

  it("uses the visible viewport midpoint and zoom to resolve the current page", () => {
    const { pageStride } = getEditorPageNavigationMetrics(createEmptyEditorDocument());
    const { scroller } = editorScroller({
      canvasTop: -pageStride * 0.5,
      viewportTop: 0,
      viewportBottom: pageStride * 0.5,
    });

    expect(getVisibleEditorPageNumber(scroller, createEmptyEditorDocument(), 50)).toBe(2);
  });

  it("scrolls smoothly to the requested page using the current canvas offset", () => {
    const { pageStride } = getEditorPageNavigationMetrics(createEmptyEditorDocument());
    const { scroller, scrollTo } = editorScroller({
      canvasTop: 40,
      viewportTop: 10,
      viewportBottom: 410,
      scrollTop: 50,
    });

    expect(scrollEditorCanvasToPage(scroller, createEmptyEditorDocument(), 50, 3.9)).toBe(true);
    expect(scrollTo).toHaveBeenCalledOnce();
    const request = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(request.behavior).toBe("smooth");
    expect(request.top).toBeCloseTo(80 + pageStride - PAGE_NAVIGATOR_SCROLL_PADDING_PX);
  });

  it("does not scroll without a canvas or a finite page number", () => {
    const withoutCanvas = {
      querySelector: () => null,
    } as unknown as HTMLElement;
    const { scroller, scrollTo } = editorScroller({
      canvasTop: 0,
      viewportTop: 0,
      viewportBottom: 400,
    });

    expect(scrollEditorCanvasToPage(null, createEmptyEditorDocument(), 100, 1)).toBe(false);
    expect(scrollEditorCanvasToPage(withoutCanvas, createEmptyEditorDocument(), 100, 1)).toBe(false);
    expect(scrollEditorCanvasToPage(scroller, createEmptyEditorDocument(), 100, Number.NaN)).toBe(false);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
