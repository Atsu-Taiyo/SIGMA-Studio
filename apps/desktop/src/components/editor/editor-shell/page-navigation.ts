import { PAGE_NAVIGATOR_SCROLL_PADDING_PX } from "@/components/editor/editor-shell/constants";
import {
  getPageMetrics,
  normalizePageLayout,
  PAGE_GAP_PX,
  type SigmaDocument,
} from "@/features/document";

export function getVisibleEditorPageNumber(
  scroller: HTMLElement | null,
  document: SigmaDocument,
  zoom: number,
): number | null {
  const canvas = scroller?.querySelector<HTMLElement>(".page-canvas");
  if (!scroller || !canvas) {
    return null;
  }

  const { pageStride } = getEditorPageNavigationMetrics(document);
  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  const viewportRect = scroller.getBoundingClientRect();
  // 見えている範囲は «紙の中» に限る。ビューポートを丸ごとモデル座標へ割り戻すと、
  // 縮小するほど下端が紙の外まで伸びて、スクロールしていないのに最終ページを指す
  // (実測: 3ページの教材を 10% にすると、1ページ目が画面上端にあるのに「3 / 3」)。
  // 高さが取れない環境 (レイアウト前・テストのスタブ) では従来どおり無制限にする。
  // height ではなく bottom - top で採る。DOMRect なら同じ値だが、こちらは
  // 「top と bottom しか持たない矩形」でも成立する。
  const renderedHeight = canvasRect.bottom - canvasRect.top;
  const contentHeight = renderedHeight > 0
    ? renderedHeight / zoomScale
    : Number.POSITIVE_INFINITY;
  const visibleTop = Math.min(Math.max(0, (viewportRect.top - canvasRect.top) / zoomScale), contentHeight);
  const visibleBottom = Math.min(
    Math.max(visibleTop, (viewportRect.bottom - canvasRect.top) / zoomScale),
    contentHeight,
  );
  const focusY = visibleTop + (visibleBottom - visibleTop) * 0.5;

  return Math.max(1, Math.floor(focusY / pageStride) + 1);
}

export function scrollEditorCanvasToPage(
  scroller: HTMLElement | null,
  document: SigmaDocument,
  zoom: number,
  pageNumber: number,
): boolean {
  const canvas = scroller?.querySelector<HTMLElement>(".page-canvas");
  if (!scroller || !canvas || !Number.isFinite(pageNumber)) {
    return false;
  }

  const { pageStride } = getEditorPageNavigationMetrics(document);
  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  const scrollerRect = scroller.getBoundingClientRect();
  const canvasTopInScroller = canvasRect.top - scrollerRect.top + scroller.scrollTop;
  const pageTop = Math.max(0, Math.floor(pageNumber) - 1) * pageStride * zoomScale;

  scroller.scrollTo({
    top: Math.max(0, canvasTopInScroller + pageTop - PAGE_NAVIGATOR_SCROLL_PADDING_PX),
    behavior: "smooth",
  });
  return true;
}

export function getEditorPageNavigationMetrics(document: SigmaDocument): { pageStride: number } {
  const metrics = getPageMetrics(normalizePageLayout(document.pageLayout));
  return {
    pageStride: metrics.page.heightPx + PAGE_GAP_PX,
  };
}
