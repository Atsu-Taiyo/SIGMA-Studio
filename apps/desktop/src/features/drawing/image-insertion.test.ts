import { describe, expect, it } from "vitest";

import { fitImageRowToWidth, fitImageSizeWithinArea, placeOverlayImageEntries, type OverlayImageEntry } from "./image-insertion";

function entry(id: string, w: number, h: number): OverlayImageEntry {
  return {
    asset: { id: `asset_${id}`, type: "image", props: { w, h, name: id, isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 1 } },
    shape: { id, type: "image", x: 0, y: 0, rotation: 0, props: { assetId: `asset_${id}`, w, h } },
  };
}

describe("image insertion geometry", () => {
  it("centers a fitted row while preserving file order, aspect ratios and asset dimensions", () => {
    const entries = [entry("left", 500, 250), entry("right", 500, 500)];
    const before = structuredClone(entries);
    const placed = placeOverlayImageEntries(entries, { areaWidth: 800, canvasWidth: 1000, canvasHeight: 600, gap: 16 });
    expect(placed).toMatchObject([
      { id: "left", x: 100, y: 72, props: { w: 392, h: 196, assetId: "asset_left" } },
      { id: "right", x: 508, y: 72, props: { w: 392, h: 392, assetId: "asset_right" } },
    ]);
    expect(entries).toEqual(before);
    expect(entries[0].asset.props.w).toBe(500);
  });

  it("uses a requested point and carries the requested parent into the placement plan", () => {
    const placed = placeOverlayImageEntries([entry("one", 100, 50), entry("two", 60, 40)], {
      areaWidth: 800, canvasWidth: 1000, canvasHeight: 600, gap: 16, point: { x: 40, y: 100 }, parentId: "group",
    });
    expect(placed).toMatchObject([
      { id: "one", x: 40, y: 100, parentId: "group" },
      { id: "two", x: 156, y: 100, parentId: "group" },
    ]);
  });

  it("moves the complete row inside the page without changing the inter-image gap", () => {
    const placed = placeOverlayImageEntries([entry("one", 100, 50), entry("two", 60, 40)], {
      areaWidth: 800, canvasWidth: 800, canvasHeight: 600, gap: 16, point: { x: -40, y: 590 },
    });
    expect(placed).toMatchObject([
      { id: "one", x: 0, y: 550, props: { w: 100, h: 50 } },
      { id: "two", x: 116, y: 550, props: { w: 60, h: 40 } },
    ]);
  });

  it("keeps an empty row empty", () => {
    expect(placeOverlayImageEntries([], { areaWidth: 800, canvasWidth: 800, canvasHeight: 600, gap: 16 })).toEqual([]);
  });

  it("keeps natural size for an unconstrained area or invalid natural dimensions", () => {
    expect(fitImageSizeWithinArea({ w: 100, h: 50 }, { w: 0, h: 0 })).toEqual({ w: 100, h: 50 });
    expect(fitImageSizeWithinArea({ w: 0, h: 50 }, { w: 80, h: 40 })).toEqual({ w: 0, h: 50 });
  });

  it("does not invent image space when gaps alone consume the available row", () => {
    const sizes = [{ w: 100, h: 50 }, { w: 60, h: 30 }];
    expect(fitImageRowToWidth(sizes, 16, 16)).toEqual(sizes);
    expect(fitImageRowToWidth(sizes, 0, 16)).toEqual(sizes);
  });
});
