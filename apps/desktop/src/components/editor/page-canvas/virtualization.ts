export const PAGE_WINDOW_OVERSCAN = 2;
export const PAGE_WINDOW_FAST_SCROLL_OVERSCAN = 4;
export const PAGE_WINDOW_FAST_SCROLL_THRESHOLD = 1.5;

export interface VisiblePageRange {
  start: number;
  end: number;
  overscan: number;
}

export interface PageWindowScrollSample {
  scrollTop: number;
  timestamp: number;
}

export interface PageVisibilityMeasurement {
  canvasTop: number;
  scrollTop: number;
  timestamp: number;
  viewportBottom: number;
  viewportTop: number;
}

export interface PageVisibilityResolution {
  range: VisiblePageRange;
  scrollSample: PageWindowScrollSample;
}

export function createInitialVisiblePageRange(
  overscan = PAGE_WINDOW_OVERSCAN,
): VisiblePageRange {
  return {
    start: 0,
    end: 0,
    overscan: normalizeOverscan(overscan),
  };
}

export function resolvePageVisibilityWindow({
  fastOverscan = PAGE_WINDOW_FAST_SCROLL_OVERSCAN,
  fastScrollThreshold = PAGE_WINDOW_FAST_SCROLL_THRESHOLD,
  measurement,
  overscan = PAGE_WINDOW_OVERSCAN,
  pageCount,
  pageGapPx,
  pageHeightPx,
  previousScrollSample,
  zoomScale,
}: {
  fastOverscan?: number;
  fastScrollThreshold?: number;
  measurement: PageVisibilityMeasurement | null;
  overscan?: number;
  pageCount: number;
  pageGapPx: number;
  pageHeightPx: number;
  previousScrollSample: PageWindowScrollSample;
  zoomScale: number;
}): PageVisibilityResolution {
  const safeOverscan = normalizeOverscan(overscan);
  if (!measurement) {
    return {
      range: clampVisiblePageRange({
        start: 0,
        end: safeOverscan * 2,
        overscan: safeOverscan,
      }, pageCount),
      scrollSample: previousScrollSample,
    };
  }

  const elapsed = Math.max(
    1,
    measurement.timestamp - previousScrollSample.timestamp,
  );
  const scrollSpeed = Math.abs(
    measurement.scrollTop - previousScrollSample.scrollTop,
  ) / elapsed;
  const threshold = Number.isFinite(fastScrollThreshold)
    ? Math.max(0, fastScrollThreshold)
    : PAGE_WINDOW_FAST_SCROLL_THRESHOLD;
  const selectedOverscan = scrollSpeed > threshold
    ? normalizeOverscan(fastOverscan)
    : safeOverscan;

  return {
    range: calculateVisiblePageRange({
      canvasRect: { top: measurement.canvasTop },
      overscan: selectedOverscan,
      pageCount,
      pageGapPx,
      pageHeightPx,
      viewportRect: {
        bottom: measurement.viewportBottom,
        top: measurement.viewportTop,
      },
      zoomScale,
    }),
    scrollSample: {
      scrollTop: measurement.scrollTop,
      timestamp: measurement.timestamp,
    },
  };
}

export function calculateVisiblePageRange({
  canvasRect,
  overscan,
  pageCount,
  pageGapPx,
  pageHeightPx,
  viewportRect,
  zoomScale,
}: {
  canvasRect: { top: number };
  overscan: number;
  pageCount: number;
  pageGapPx: number;
  pageHeightPx: number;
  viewportRect: { bottom: number; top: number };
  zoomScale: number;
}): VisiblePageRange {
  const safeOverscan = normalizeOverscan(overscan);
  const safeZoom = Math.max(0.01, zoomScale);
  const pageStride = pageHeightPx + pageGapPx;
  const visibleTop = Math.max(0, (viewportRect.top - canvasRect.top) / safeZoom);
  const visibleBottom = Math.max(visibleTop, (viewportRect.bottom - canvasRect.top) / safeZoom);
  const firstVisiblePage = Math.max(0, Math.floor(visibleTop / pageStride));
  const lastVisiblePage = Math.max(firstVisiblePage, Math.floor(Math.max(0, visibleBottom - 1) / pageStride));

  return clampVisiblePageRange({
    start: firstVisiblePage - safeOverscan,
    end: lastVisiblePage + safeOverscan,
    overscan: safeOverscan,
  }, pageCount);
}

export function getVisiblePageIndexes(
  range: VisiblePageRange,
  pageCount: number,
  pinnedPageNumbers: readonly number[] = [],
): number[] {
  const indexes = new Set<number>();
  const safePageCount = Math.max(1, pageCount);
  const clamped = clampVisiblePageRange(range, safePageCount);
  for (let index = clamped.start; index <= clamped.end; index += 1) {
    indexes.add(index);
  }
  for (const pageNumber of pinnedPageNumbers) {
    if (!Number.isFinite(pageNumber)) {
      continue;
    }
    const index = Math.floor(pageNumber) - 1;
    if (index >= 0 && index < safePageCount) {
      indexes.add(index);
    }
  }
  return Array.from(indexes).sort((a, b) => a - b);
}

export function clampVisiblePageRange(range: VisiblePageRange, pageCount: number): VisiblePageRange {
  const lastPageIndex = Math.max(0, pageCount - 1);
  const start = Math.max(0, Math.min(lastPageIndex, Math.floor(range.start)));
  const end = Math.max(start, Math.min(lastPageIndex, Math.floor(range.end)));
  return {
    start,
    end,
    overscan: Math.max(0, Math.floor(range.overscan)),
  };
}

export function sameVisiblePageRange(a: VisiblePageRange, b: VisiblePageRange): boolean {
  return a.start === b.start && a.end === b.end && a.overscan === b.overscan;
}

function normalizeOverscan(overscan: number): number {
  return Math.max(0, Math.floor(overscan));
}
