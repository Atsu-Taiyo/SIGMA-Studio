import { describe, expect, it } from "vitest";

import {
  createInitialVisiblePageRange,
  getVisiblePageIndexes,
  PAGE_WINDOW_FAST_SCROLL_OVERSCAN,
  PAGE_WINDOW_OVERSCAN,
  resolvePageVisibilityWindow,
  type PageWindowScrollSample,
} from "./virtualization";

const PAGE_HEIGHT_PX = 1_000;
const PAGE_GAP_PX = 40;

describe("page visibility model", () => {
  it("keeps the first page mounted initially and for an empty document", () => {
    expect(createInitialVisiblePageRange()).toEqual({
      start: 0,
      end: 0,
      overscan: PAGE_WINDOW_OVERSCAN,
    });

    const previousScrollSample: PageWindowScrollSample = {
      scrollTop: 0,
      timestamp: 0,
    };
    const result = resolvePageVisibilityWindow({
      measurement: null,
      pageCount: 0,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: PAGE_HEIGHT_PX,
      previousScrollSample,
      zoomScale: 1,
    });

    expect(result.range).toEqual({
      start: 0,
      end: 0,
      overscan: PAGE_WINDOW_OVERSCAN,
    });
    expect(result.scrollSample).toBe(previousScrollSample);
    expect(getVisiblePageIndexes(result.range, 0)).toEqual([0]);

    expect(resolvePageVisibilityWindow({
      measurement: null,
      pageCount: 10,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: PAGE_HEIGHT_PX,
      previousScrollSample,
      zoomScale: 1,
    }).range).toEqual({
      start: 0,
      end: PAGE_WINDOW_OVERSCAN * 2,
      overscan: PAGE_WINDOW_OVERSCAN,
    });
  });

  it("uses normal overscan at the threshold and fast overscan above it", () => {
    const previousScrollSample: PageWindowScrollSample = {
      scrollTop: 0,
      timestamp: 1_000,
    };
    const base = {
      pageCount: 20,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: PAGE_HEIGHT_PX,
      previousScrollSample,
      zoomScale: 1,
    };

    const normal = resolvePageVisibilityWindow({
      ...base,
      measurement: {
        canvasTop: 0,
        scrollTop: 150,
        timestamp: 1_100,
        viewportBottom: 900,
        viewportTop: 0,
      },
    });
    const fast = resolvePageVisibilityWindow({
      ...base,
      measurement: {
        canvasTop: 0,
        scrollTop: 151,
        timestamp: 1_100,
        viewportBottom: 900,
        viewportTop: 0,
      },
    });

    expect(normal.range.overscan).toBe(PAGE_WINDOW_OVERSCAN);
    expect(normal.range).toEqual({
      start: 0,
      end: 2,
      overscan: PAGE_WINDOW_OVERSCAN,
    });
    expect(fast.range.overscan).toBe(PAGE_WINDOW_FAST_SCROLL_OVERSCAN);
    expect(fast.range).toEqual({
      start: 0,
      end: 4,
      overscan: PAGE_WINDOW_FAST_SCROLL_OVERSCAN,
    });
    expect(fast.scrollSample).toEqual({
      scrollTop: 151,
      timestamp: 1_100,
    });
  });

  it("converts viewport measurements through the current zoom", () => {
    const previousScrollSample: PageWindowScrollSample = {
      scrollTop: 0,
      timestamp: 1_000,
    };
    const measurement = {
      canvasTop: -2_080,
      scrollTop: 0,
      timestamp: 1_100,
      viewportBottom: 1_000,
      viewportTop: 0,
    };
    const base = {
      measurement,
      pageCount: 10,
      pageGapPx: PAGE_GAP_PX,
      pageHeightPx: PAGE_HEIGHT_PX,
      previousScrollSample,
    };

    expect(resolvePageVisibilityWindow({
      ...base,
      zoomScale: 1,
    }).range).toEqual({
      start: 0,
      end: 4,
      overscan: PAGE_WINDOW_OVERSCAN,
    });
    expect(resolvePageVisibilityWindow({
      ...base,
      zoomScale: 2,
    }).range).toEqual({
      start: 0,
      end: 3,
      overscan: PAGE_WINDOW_OVERSCAN,
    });
  });

  it("keeps pinned print-style and editing pages outside the overlay range", () => {
    const range = {
      start: 2,
      end: 4,
      overscan: PAGE_WINDOW_OVERSCAN,
    };

    expect(getVisiblePageIndexes(range, 8, [1, 8])).toEqual([
      0,
      2,
      3,
      4,
      7,
    ]);
  });
});
