import { describe, expect, it } from "vitest";

import {
  getPageMetrics,
  mmToPx,
  PAGE_GAP_PX,
} from "@/lib/page-layout";
import { hitTestShape } from "@/features/drawing";
import type { OverlayGeoShape } from "@/features/document";
import type { PageLayout } from "@/types/sigma-doc";

import {
  arePageDoubleTapHitsEqual,
  getCanvasPointerPoint,
  getPageDoubleTapHit,
  getPageOverlayPoint,
  getPagePointerContext,
  getWhiteboardPanForZoom,
  getWhiteboardPointerPoint,
  isPageBodyPoint,
  isPageDoubleTap,
  type PageDoubleTapCandidate,
  type PagePointerRect,
} from "./pointer-model";

const layout = createLayout();
const metrics = getPageMetrics(layout);

describe("page pointer coordinates", () => {
  it("converts zoomed client coordinates into page-local coordinates", () => {
    const zoomScale = 1.75;
    const canvasRect = createCanvasRect(zoomScale, 2);
    const x = mmToPx(25);
    const pageY = mmToPx(60);

    const point = getPagePointerContext({
      canvasRect,
      clientX: canvasRect.left + x * zoomScale,
      clientY: canvasRect.top + pageY * zoomScale,
      metrics,
      pageCount: 2,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: metrics.page.heightPx,
    });

    expect(point?.pageNumber).toBe(1);
    expect(point?.x).toBeCloseTo(x);
    expect(point?.pageY).toBeCloseTo(pageY);
  });

  it("maps later pages while rejecting the page gap and out-of-range points", () => {
    const zoomScale = 2;
    const canvasRect = createCanvasRect(zoomScale, 2);
    const pageStride = metrics.page.heightPx + PAGE_GAP_PX;
    const secondPageY = pageStride + mmToPx(12);
    const input = {
      canvasRect,
      clientX: canvasRect.left + mmToPx(40) * zoomScale,
      metrics,
      pageCount: 2,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: metrics.page.heightPx,
    };

    const secondPage = getPagePointerContext({
      ...input,
      clientY: canvasRect.top + secondPageY * zoomScale,
    });
    expect(secondPage?.pageNumber).toBe(2);
    expect(secondPage?.pageY).toBeCloseTo(mmToPx(12));
    expect(getPageOverlayPoint({
      ...input,
      clientY: canvasRect.top + secondPageY * zoomScale,
    })?.y).toBeCloseTo(secondPageY);

    expect(getPagePointerContext({
      ...input,
      clientY: canvasRect.top + (metrics.page.heightPx + PAGE_GAP_PX / 2) * zoomScale,
    })).toBeNull();
    expect(getPagePointerContext({
      ...input,
      clientX: canvasRect.left - 1,
      clientY: canvasRect.top,
    })).toBeNull();
    expect(getPagePointerContext({
      ...input,
      clientX: canvasRect.left + canvasRect.width + 1,
      clientY: canvasRect.top,
    })).toBeNull();
    expect(getPagePointerContext({
      ...input,
      clientY: canvasRect.top - 1,
    })).toBeNull();
    expect(getPagePointerContext({
      ...input,
      clientY: canvasRect.top + pageStride * 2 * zoomScale,
    })).toBeNull();
  });

  it("keeps overflow-canvas coordinates unclamped and rejects invalid rects", () => {
    const zoomScale = 1.5;
    const canvasRect = createCanvasRect(zoomScale, 1);
    const point = getCanvasPointerPoint({
      canvasRect,
      clientX: canvasRect.left - 30,
      clientY: canvasRect.top + 45,
      metrics,
    });

    expect(point).toEqual({ x: -20, y: 30 });
    expect(getCanvasPointerPoint({
      canvasRect: { ...canvasRect, width: 0 },
      clientX: canvasRect.left,
      clientY: canvasRect.top,
      metrics,
    })).toBeNull();
    expect(getPagePointerContext({
      canvasRect: { ...canvasRect, height: 0 },
      clientX: canvasRect.left,
      clientY: canvasRect.top,
      metrics,
      pageCount: 1,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: metrics.page.heightPx,
    })).toBeNull();
  });

  it("maps a visual press after pan and zoom back onto its whiteboard geo", () => {
    const canvasRect = { left: 80, top: 60, width: 900, height: 600 };
    const shape: OverlayGeoShape = {
      id: "whiteboard_rect",
      type: "geo",
      x: 120,
      y: 120,
      props: {
        w: 160,
        h: 100,
        geo: "rectangle",
        fill: "solid",
        color: "#111111",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    };
    const shapeCenter = { x: 200, y: 170 };
    const point = getWhiteboardPointerPoint({
      canvasRect,
      clientX: canvasRect.left + 140 + shapeCenter.x * 1.5,
      clientY: canvasRect.top - 30 + shapeCenter.y * 1.5,
      panX: 140,
      panY: -30,
      zoom: 150,
    });

    expect(point).toEqual(shapeCenter);
    expect(point && hitTestShape(shape, point, 0)).toBe(true);
    expect(getWhiteboardPointerPoint({
      canvasRect: { ...canvasRect, width: 0 },
      clientX: canvasRect.left,
      clientY: canvasRect.top,
      panX: 0,
      panY: 0,
      zoom: 100,
    })).toBeNull();
  });

  it("keeps the whiteboard point under the viewport center fixed while zooming", () => {
    const anchor = { x: 450, y: 300 };
    const currentPan = { x: 120, y: -60 };
    const currentZoom = 80;
    const nextZoom = 150;
    const worldPoint = {
      x: (anchor.x - currentPan.x) / (currentZoom / 100),
      y: (anchor.y - currentPan.y) / (currentZoom / 100),
    };

    const nextPan = getWhiteboardPanForZoom({
      anchorX: anchor.x,
      anchorY: anchor.y,
      panX: currentPan.x,
      panY: currentPan.y,
      currentZoom,
      nextZoom,
    });

    expect(nextPan.x + worldPoint.x * (nextZoom / 100)).toBeCloseTo(anchor.x);
    expect(nextPan.y + worldPoint.y * (nextZoom / 100)).toBeCloseTo(anchor.y);
  });
});

describe("page double-tap hits", () => {
  it("distinguishes header, footer, left margin, right margin, and body", () => {
    const bodyY = mmToPx(100);

    expect(getPageDoubleTapHit({
      x: mmToPx(50),
      pageY: mmToPx(40),
      pageNumber: 2,
    }, layout, metrics)).toEqual({
      type: "runningRegion",
      kind: "header",
      pageNumber: 2,
    });
    expect(getPageDoubleTapHit({
      x: mmToPx(50),
      pageY: mmToPx(160),
      pageNumber: 2,
    }, layout, metrics)).toEqual({
      type: "runningRegion",
      kind: "footer",
      pageNumber: 2,
    });
    expect(getPageDoubleTapHit({
      x: mmToPx(10),
      pageY: bodyY,
      pageNumber: 2,
    }, layout, metrics)).toEqual({
      type: "margin",
      edge: "left",
      pageNumber: 2,
    });
    expect(getPageDoubleTapHit({
      x: mmToPx(90),
      pageY: bodyY,
      pageNumber: 2,
    }, layout, metrics)).toEqual({
      type: "margin",
      edge: "right",
      pageNumber: 2,
    });
    expect(getPageDoubleTapHit({
      x: mmToPx(50),
      pageY: bodyY,
      pageNumber: 2,
    }, layout, metrics)).toBeNull();
  });

  it("treats the content boundary as body and points beyond it as margins", () => {
    expect(isPageBodyPoint({
      x: metrics.margins.leftPx,
      pageY: metrics.margins.topPx,
      pageNumber: 1,
    }, metrics)).toBe(true);
    expect(isPageBodyPoint({
      x: metrics.page.widthPx - metrics.margins.rightPx,
      pageY: metrics.page.heightPx - metrics.margins.bottomPx,
      pageNumber: 1,
    }, metrics)).toBe(true);
    expect(isPageBodyPoint({
      x: metrics.margins.leftPx - 0.01,
      pageY: mmToPx(100),
      pageNumber: 1,
    }, metrics)).toBe(false);
    expect(isPageBodyPoint({
      x: metrics.page.widthPx - metrics.margins.rightPx + 0.01,
      pageY: mmToPx(100),
      pageNumber: 1,
    }, metrics)).toBe(false);
  });

  it("compares the hit target together with its page and region or edge", () => {
    expect(arePageDoubleTapHitsEqual(
      { type: "runningRegion", kind: "header", pageNumber: 1 },
      { type: "runningRegion", kind: "header", pageNumber: 1 },
    )).toBe(true);
    expect(arePageDoubleTapHitsEqual(
      { type: "margin", edge: "left", pageNumber: 2 },
      { type: "margin", edge: "left", pageNumber: 2 },
    )).toBe(true);
    expect(arePageDoubleTapHitsEqual(
      { type: "runningRegion", kind: "header", pageNumber: 1 },
      { type: "runningRegion", kind: "footer", pageNumber: 1 },
    )).toBe(false);
    expect(arePageDoubleTapHitsEqual(
      { type: "margin", edge: "left", pageNumber: 1 },
      { type: "margin", edge: "left", pageNumber: 2 },
    )).toBe(false);
    expect(arePageDoubleTapHitsEqual(
      { type: "runningRegion", kind: "header", pageNumber: 1 },
      { type: "margin", edge: "left", pageNumber: 1 },
    )).toBe(false);
  });

  it("matches only nearby candidates within the double-tap interval", () => {
    const previous: PageDoubleTapCandidate = {
      hit: { type: "margin", edge: "left", pageNumber: 1 },
      timeStamp: 100,
      clientX: 20,
      clientY: 30,
    };

    expect(isPageDoubleTap(previous, {
      ...previous,
      timeStamp: 550,
      clientX: 48,
    }, 450, 28)).toBe(true);
    expect(isPageDoubleTap(previous, {
      ...previous,
      timeStamp: 551,
      clientX: 48,
    }, 450, 28)).toBe(false);
    expect(isPageDoubleTap(previous, {
      ...previous,
      timeStamp: 550,
      clientX: 48.01,
    }, 450, 28)).toBe(false);
    expect(isPageDoubleTap(previous, {
      ...previous,
      hit: { type: "margin", edge: "right", pageNumber: 1 },
      timeStamp: 550,
    }, 450, 28)).toBe(false);
  });
});

function createCanvasRect(zoomScale: number, pageCount: number): PagePointerRect {
  return {
    left: 120,
    top: 80,
    width: metrics.page.widthPx * zoomScale,
    height: (
      metrics.page.heightPx * pageCount
      + PAGE_GAP_PX * Math.max(0, pageCount - 1)
    ) * zoomScale,
  };
}

function createLayout(): PageLayout {
  return {
    preset: "custom",
    orientation: "portrait",
    pageSize: {
      widthMm: 100,
      heightMm: 200,
    },
    marginsMm: {
      top: 30,
      right: 20,
      bottom: 30,
      left: 20,
    },
    flow: {
      type: "columns",
      columnCount: 1,
      columnGapMm: 0,
    },
    header: {
      enabled: true,
      heightMm: 40,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [],
    },
    footer: {
      enabled: true,
      heightMm: 40,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [],
    },
  };
}
