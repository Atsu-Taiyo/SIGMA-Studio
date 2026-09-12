import { describe, expect, it } from "vitest";

import { shouldKeepBlockSelectionOnPagePointerDown } from "./block-selection-pointer-policy";

function shouldKeep(overrides: Partial<Parameters<typeof shouldKeepBlockSelectionOnPagePointerDown>[0]> = {}) {
  return shouldKeepBlockSelectionOnPagePointerDown({
    isBlockSelectionControl: false,
    isOverlayEditing: false,
    isOverlaySelectionTarget: false,
    hitShapeId: null,
    bodyPointerRoute: "text",
    ...overrides,
  });
}

describe("shouldKeepBlockSelectionOnPagePointerDown", () => {
  it("keeps the selection for its handles and menus", () => {
    expect(shouldKeep({ isBlockSelectionControl: true })).toBe(true);
  });

  it("keeps the selection when body-mode routing selects a hit shape", () => {
    expect(shouldKeep({ hitShapeId: "shape_1", bodyPointerRoute: "overlayShape" })).toBe(true);
  });

  it("clears the selection for Ctrl/Cmd overlay routing on empty canvas", () => {
    expect(shouldKeep({ hitShapeId: null, bodyPointerRoute: "overlayShape" })).toBe(false);
  });

  it("clears the selection when an unselected shape passes the pointer through to text", () => {
    expect(shouldKeep({ hitShapeId: "shape_1", bodyPointerRoute: "text" })).toBe(false);
  });

  it("keeps the selection on overlay shapes and selection handles while overlay editing", () => {
    expect(shouldKeep({ isOverlayEditing: true, isOverlaySelectionTarget: true })).toBe(true);
  });

  it("clears the selection on empty overlay canvas", () => {
    expect(shouldKeep({ isOverlayEditing: true, isOverlaySelectionTarget: false })).toBe(false);
  });
});
