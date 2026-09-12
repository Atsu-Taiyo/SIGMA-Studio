import {
  mmToPx,
  type PageMetrics,
  getRunningRegionBoundsMm,
  type PageLayout,
} from "@/features/document";

import type { PageMarginEdge, RunningRegionKind } from "./types";

export interface PagePointerRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface PagePointerContext {
  x: number;
  pageY: number;
  pageNumber: number;
}

export interface PagePointerPoint {
  x: number;
  y: number;
}

export type PageDoubleTapHit =
  | { type: "runningRegion"; kind: RunningRegionKind; pageNumber: number }
  | { type: "margin"; edge: PageMarginEdge; pageNumber: number };

export interface PageDoubleTapCandidate {
  hit: PageDoubleTapHit;
  timeStamp: number;
  clientX: number;
  clientY: number;
}

interface PagePointerInput {
  canvasRect: PagePointerRect;
  clientX: number;
  clientY: number;
  metrics: PageMetrics;
}

interface WhiteboardPointerInput {
  canvasRect: PagePointerRect;
  clientX: number;
  clientY: number;
  panX: number;
  panY: number;
  zoom: number;
}

interface WhiteboardZoomPanInput {
  anchorX: number;
  anchorY: number;
  panX: number;
  panY: number;
  currentZoom: number;
  nextZoom: number;
}

interface PaginatedPagePointerInput extends PagePointerInput {
  pageCount: number;
  pageGapPx: number;
  pageHeightPx: number;
}

export function getPagePointerContext({
  canvasRect,
  clientX,
  clientY,
  metrics,
  pageCount,
  pageGapPx,
  pageHeightPx,
}: PaginatedPagePointerInput): PagePointerContext | null {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) {
    return null;
  }

  const scale = canvasRect.width / metrics.page.widthPx || 1;
  const x = (clientX - canvasRect.left) / scale;
  const y = (clientY - canvasRect.top) / scale;
  if (x < 0 || x > metrics.page.widthPx || y < 0) {
    return null;
  }

  const pageStride = pageHeightPx + pageGapPx;
  const pageIndex = Math.floor(y / pageStride);
  if (pageIndex < 0 || pageIndex >= pageCount) {
    return null;
  }

  const pageY = y - pageIndex * pageStride;
  if (pageY < 0 || pageY > pageHeightPx) {
    return null;
  }

  return {
    x,
    pageY,
    pageNumber: pageIndex + 1,
  };
}

export function getPageOverlayPoint(input: PaginatedPagePointerInput): PagePointerPoint | null {
  const point = getPagePointerContext(input);
  if (!point) {
    return null;
  }

  return {
    x: point.x,
    y: (point.pageNumber - 1) * (input.pageHeightPx + input.pageGapPx) + point.pageY,
  };
}

export function getCanvasPointerPoint({
  canvasRect,
  clientX,
  clientY,
  metrics,
}: PagePointerInput): PagePointerPoint | null {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) {
    return null;
  }

  const scale = canvasRect.width / metrics.page.widthPx || 1;
  return {
    x: (clientX - canvasRect.left) / scale,
    y: (clientY - canvasRect.top) / scale,
  };
}

export function getWhiteboardPointerPoint({
  canvasRect,
  clientX,
  clientY,
  panX,
  panY,
  zoom,
}: WhiteboardPointerInput): PagePointerPoint | null {
  if (canvasRect.width <= 0 || canvasRect.height <= 0) {
    return null;
  }

  const scale = Math.max(0.01, zoom / 100);
  return {
    x: (clientX - canvasRect.left - panX) / scale,
    y: (clientY - canvasRect.top - panY) / scale,
  };
}

export function getWhiteboardPanForZoom({
  anchorX,
  anchorY,
  panX,
  panY,
  currentZoom,
  nextZoom,
}: WhiteboardZoomPanInput): PagePointerPoint {
  const currentScale = Math.max(0.01, currentZoom / 100);
  const nextScale = Math.max(0.01, nextZoom / 100);
  const canvasX = (anchorX - panX) / currentScale;
  const canvasY = (anchorY - panY) / currentScale;

  return {
    x: anchorX - canvasX * nextScale,
    y: anchorY - canvasY * nextScale,
  };
}

export function getPageDoubleTapHit(
  point: PagePointerContext,
  layout: PageLayout,
  metrics: PageMetrics,
): PageDoubleTapHit | null {
  const runningRegionKind = getRunningRegionDoubleTapKind(point.pageY, layout, metrics);
  if (runningRegionKind) {
    return { type: "runningRegion", kind: runningRegionKind, pageNumber: point.pageNumber };
  }

  const contentLeft = metrics.margins.leftPx;
  const contentRight = metrics.page.widthPx - metrics.margins.rightPx;
  const inBodyY = point.pageY >= metrics.margins.topPx
    && point.pageY <= metrics.page.heightPx - metrics.margins.bottomPx;
  if (!inBodyY) {
    return null;
  }

  if (point.x < contentLeft) {
    return { type: "margin", edge: "left", pageNumber: point.pageNumber };
  }

  if (point.x > contentRight) {
    return { type: "margin", edge: "right", pageNumber: point.pageNumber };
  }

  return null;
}

export function isPageBodyPoint(point: PagePointerContext, metrics: PageMetrics): boolean {
  return point.x >= metrics.margins.leftPx
    && point.x <= metrics.page.widthPx - metrics.margins.rightPx
    && point.pageY >= metrics.margins.topPx
    && point.pageY <= metrics.page.heightPx - metrics.margins.bottomPx;
}

export function arePageDoubleTapHitsEqual(a: PageDoubleTapHit, b: PageDoubleTapHit): boolean {
  if (a.type !== b.type || a.pageNumber !== b.pageNumber) {
    return false;
  }

  if (a.type === "runningRegion" && b.type === "runningRegion") {
    return a.kind === b.kind;
  }

  if (a.type === "margin" && b.type === "margin") {
    return a.edge === b.edge;
  }

  return false;
}

export function isPageDoubleTap(
  previous: PageDoubleTapCandidate | null,
  current: PageDoubleTapCandidate,
  maxDelayMs: number,
  maxDistancePx: number,
): boolean {
  if (!previous) {
    return false;
  }

  const elapsed = current.timeStamp - previous.timeStamp;
  const distance = Math.hypot(
    current.clientX - previous.clientX,
    current.clientY - previous.clientY,
  );
  return elapsed <= maxDelayMs
    && distance <= maxDistancePx
    && arePageDoubleTapHitsEqual(previous.hit, current.hit);
}

function getRunningRegionDoubleTapKind(
  pageY: number,
  layout: PageLayout,
  metrics: PageMetrics,
): RunningRegionKind | null {
  const headerBounds = layout.header?.enabled ? getRunningRegionBoundsMm(layout, "header") : null;
  const headerBottom = Math.max(
    metrics.margins.topPx,
    headerBounds ? mmToPx(headerBounds.bottomMm) : mmToPx(15),
  );
  if (pageY >= 0 && pageY <= headerBottom) {
    return "header";
  }

  const footerBounds = layout.footer?.enabled ? getRunningRegionBoundsMm(layout, "footer") : null;
  const footerTop = Math.min(
    metrics.page.heightPx - metrics.margins.bottomPx,
    footerBounds ? mmToPx(footerBounds.topMm) : metrics.page.heightPx - mmToPx(15),
  );
  if (pageY >= footerTop && pageY <= metrics.page.heightPx) {
    return "footer";
  }

  return null;
}
