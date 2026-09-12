import { describe, expect, it } from "vitest";

import { getVisibleOverlayShapes } from "@/features/rendering/core";

import { createResolvedOverlayView } from "./view-cache";
import type { OverlayShape, OverlaySnapshot } from "./types";

describe("overlay view cache", () => {
  it("slices resolved shapes by visible page and stack layer", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      assets: {},
      shapes: [
        rectangle("front_page_1", 20),
        rectangle("front_page_3", 230),
        { ...rectangle("background_page_1", 24), stackLayer: "background" },
      ],
    };
    const view = createResolvedOverlayView(
      { overlaySnapshot: snapshot },
      new Map(),
      {
        canvasHeight: 320,
        canvasWidth: 200,
        pageGapPx: 10,
        pageHeightPx: 100,
        revision: 1,
      },
    );

    expect(getVisibleOverlayShapes(view, "foreground", { start: 0, end: 0, overscan: 0 }).map((shape) => shape.id)).toEqual(["front_page_1"]);
    expect(getVisibleOverlayShapes(view, "background", { start: 0, end: 0, overscan: 0 }).map((shape) => shape.id)).toEqual(["background_page_1"]);
    expect(getVisibleOverlayShapes(view, "foreground", { start: 2, end: 2, overscan: 0 }).map((shape) => shape.id)).toEqual(["front_page_3"]);
  });

  it("keeps pinned shapes visible outside the current page range", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      assets: {},
      shapes: [rectangle("front_page_1", 20), rectangle("front_page_3", 230)],
    };
    const view = createResolvedOverlayView(
      { overlaySnapshot: snapshot },
      new Map(),
      {
        canvasHeight: 320,
        canvasWidth: 200,
        pageGapPx: 10,
        pageHeightPx: 100,
        revision: 1,
      },
    );

    expect(getVisibleOverlayShapes(view, "foreground", { start: 0, end: 0, overscan: 0 }, ["front_page_3"]).map((shape) => shape.id)).toEqual([
      "front_page_1",
      "front_page_3",
    ]);
  });
});

function rectangle(id: string, y: number): OverlayShape {
  return {
    id,
    type: "geo",
    x: 10,
    y,
    props: {
      w: 40,
      h: 30,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}
