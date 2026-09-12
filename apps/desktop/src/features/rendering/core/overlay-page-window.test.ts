import { describe, expect, it } from "vitest";

import type {
  OverlayBounds,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";

import {
  createOverlayPageSlices,
  getVisibleOverlayShapes,
  type OverlayPageWindow,
} from "./overlay-page-window";

const PAGE_OPTIONS = {
  pageGapPx: 10,
  pageHeightPx: 100,
};

describe("overlay page window", () => {
  it("indexes a shape on every page crossed by its bounds", () => {
    const crossing = rectangle("crossing");
    const pageThree = rectangle("page_three");
    const slices = createOverlayPageSlices(
      [pageThree, crossing],
      boundsMap([
        ["crossing", { x: 0, y: 90, w: 20, h: 30 }],
        ["page_three", { x: 0, y: 225, w: 20, h: 10 }],
      ]),
      PAGE_OPTIONS,
    );

    expect(slices).toEqual([
      { pageIndex: 0, shapeIds: ["crossing"] },
      { pageIndex: 1, shapeIds: ["crossing"] },
      { pageIndex: 2, shapeIds: ["page_three"] },
    ]);
  });

  it("does not spill an exact page-stride boundary into the next page", () => {
    const endingAtBoundary = rectangle("ending_at_boundary");
    const startingAtBoundary = rectangle("starting_at_boundary");
    const slices = createOverlayPageSlices(
      [endingAtBoundary, startingAtBoundary],
      boundsMap([
        ["ending_at_boundary", { x: 0, y: 0, w: 20, h: 110 }],
        ["starting_at_boundary", { x: 0, y: 110, w: 20, h: 1 }],
      ]),
      PAGE_OPTIONS,
    );

    expect(slices).toEqual([
      { pageIndex: 0, shapeIds: ["ending_at_boundary"] },
      { pageIndex: 1, shapeIds: ["starting_at_boundary"] },
    ]);
  });

  it("clamps negative y bounds to the first page", () => {
    const abovePage = rectangle("above_page");
    const crossingFromAbove = rectangle("crossing_from_above");
    const slices = createOverlayPageSlices(
      [abovePage, crossingFromAbove],
      boundsMap([
        ["above_page", { x: 0, y: -30, w: 20, h: 10 }],
        ["crossing_from_above", { x: 0, y: -10, w: 20, h: 130 }],
      ]),
      PAGE_OPTIONS,
    );

    expect(slices).toEqual([
      {
        pageIndex: 0,
        shapeIds: ["above_page", "crossing_from_above"],
      },
      { pageIndex: 1, shapeIds: ["crossing_from_above"] },
    ]);
  });

  it("skips shapes without injected bounds", () => {
    const indexed = rectangle("indexed");
    const missing = rectangle("missing");

    expect(createOverlayPageSlices(
      [indexed, missing],
      boundsMap([
        ["indexed", { x: 0, y: 20, w: 20, h: 20 }],
      ]),
      PAGE_OPTIONS,
    )).toEqual([
      { pageIndex: 0, shapeIds: ["indexed"] },
    ]);
  });

  it("preserves shape order for page slices and visible pinned results", () => {
    const first = rectangle("first");
    const second = rectangle("second");
    const pinned = rectangle("pinned");
    const pageSlices = createOverlayPageSlices(
      [second, first, pinned],
      boundsMap([
        ["first", { x: 0, y: 20, w: 20, h: 20 }],
        ["second", { x: 0, y: 30, w: 20, h: 20 }],
        ["pinned", { x: 0, y: 230, w: 20, h: 20 }],
      ]),
      PAGE_OPTIONS,
    );
    const view: OverlayPageWindow = {
      pageSlicesByLayer: {
        all: pageSlices,
        background: [],
        foreground: pageSlices,
      },
      visibleShapesByLayer: {
        all: [pinned, second, first],
        background: [],
        foreground: [pinned, second, first],
      },
    };

    expect(pageSlices[0]).toEqual({
      pageIndex: 0,
      shapeIds: ["second", "first"],
    });
    expect(getVisibleOverlayShapes(
      view,
      "foreground",
      { start: 0, end: 0, overscan: 0 },
      ["pinned"],
    ).map((shape) => shape.id)).toEqual([
      "pinned",
      "second",
      "first",
    ]);
  });
});

function rectangle(id: OverlayShapeId): OverlayShape {
  return {
    id,
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: 20,
      h: 20,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function boundsMap(
  entries: Array<[OverlayShapeId, OverlayBounds]>,
): Map<OverlayShapeId, OverlayBounds> {
  return new Map(entries);
}
