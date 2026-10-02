"use client";
import { PAGE_GAP_PX } from "@/features/document";
import type { RefObject } from "react";
import { useLayoutEffect,useMemo,useRef,useState } from "react";
import {
  createInitialVisiblePageRange,
  resolvePageVisibilityWindow,
  sameVisiblePageRange,
  type VisiblePageRange,
} from "./virtualization";

interface Inputs {
  isPagedRender: boolean;
  pageCount: number;
  canvasRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  pageHeightPx: number;
}

export function usePageCanvasViewport({ isPagedRender, pageCount, canvasRef, zoom, pageHeightPx }: Inputs) {

  const [scrollVisiblePageRange, setVisiblePageRange] = useState<VisiblePageRange>(
    () => createInitialVisiblePageRange(),
  );

  // Output renders materialize every page: the PDF is cut from this DOM, so a
  // windowed canvas would silently drop pages and every shape anchored to them.
  const visiblePageRange = useMemo<VisiblePageRange>(
    () => (isPagedRender
      ? { start: 0, end: Math.max(0, pageCount - 1), overscan: 0 }
      : scrollVisiblePageRange),
    [isPagedRender, pageCount, scrollVisiblePageRange],
  );

  const pageWindowScrollRef = useRef({ scrollTop: 0, timestamp: 0 });

  /**
   * 描く紙の窓。**レイアウトフェーズで**決める。
   *
   * ページ数が増えた瞬間 (箱や段落がページ境界を越えた打鍵) に、増えたページを rAF まで
   * 待って描いていたので、「本文は次のページの位置へ動いたのに、その紙がまだ無い」
   * フレームが 1 枚描かれていた — 本文が台紙の灰色の上に浮いて見える。ページ数は
   * `layoutViewState` と同じコミットで決まっているので、窓もそこで揃える。
   * スクロール・リサイズは従来どおり rAF で間引く。
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const scroller = canvas?.closest<HTMLElement>(".editor-canvas");
    if (!canvas || !scroller) {
      const resolution = resolvePageVisibilityWindow({
        measurement: null,
        pageCount,
        pageGapPx: PAGE_GAP_PX,
        pageHeightPx,
        previousScrollSample: pageWindowScrollRef.current,
        zoomScale: zoom / 100,
      });
      setVisiblePageRange((current) => {
        return sameVisiblePageRange(current, resolution.range)
          ? current
          : resolution.range;
      });
      return;
    }

    let frameId = 0;
    const updateRange = () => {
      frameId = 0;
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      const canvasRect = canvas.getBoundingClientRect();
      const viewportRect = scroller.getBoundingClientRect();
      const resolution = resolvePageVisibilityWindow({
        measurement: {
          canvasTop: canvasRect.top,
          scrollTop: scroller.scrollTop,
          timestamp: now,
          viewportBottom: viewportRect.bottom,
          viewportTop: viewportRect.top,
        },
        pageCount,
        pageGapPx: PAGE_GAP_PX,
        pageHeightPx,
        previousScrollSample: pageWindowScrollRef.current,
        zoomScale: zoom / 100,
      });
      pageWindowScrollRef.current = resolution.scrollSample;
      setVisiblePageRange((current) => (
        sameVisiblePageRange(current, resolution.range)
          ? current
          : resolution.range
      ));
    };
    const scheduleUpdate = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(updateRange);
    };

    // 初回 (= ページ数・ページ高さ・ズームが変わった直後) だけは間引かずに解く。
    updateRange();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [canvasRef, pageCount, pageHeightPx, zoom]);
  return { visiblePageRange };
}
