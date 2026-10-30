import { describe, expect, it } from "vitest";
import { pickShapeAtPoint } from "./pick-shape-at-point";
import type { OverlayShape } from "./types";

const text = (id: string, x: number, w: number): OverlayShape => ({
  id, type: "text", x, y: 570.66,
  props: { w, h: 16, color: "black", size: "s", blocks: [] },
} as OverlayShape);

describe("pickShapeAtPoint", () => {
  const label = text("label", 426.23, 23.34);
  const prose = text("prose", 445.13, 76.89);
  it("selects a small formula instead of the adjacent prose's eight-pixel margin", () => {
    expect(pickShapeAtPoint([prose, label], { x: 437.9, y: 578.66 }, 8, () => true)?.id).toBe("label");
  });
  it("preserves visual stacking for actual overlap and tolerance for near misses", () => {
    expect(pickShapeAtPoint([prose, label], { x: 447, y: 578.66 }, 8, () => true)?.id).toBe("prose");
    expect(pickShapeAtPoint([label], { x: 423, y: 578.66 }, 8, () => true)?.id).toBe("label");
    expect(pickShapeAtPoint([label], { x: 400, y: 578.66 }, 8, () => true)).toBeUndefined();
  });
  it("does not promote an ineligible direct hit", () => {
    expect(pickShapeAtPoint([prose, label], { x: 437.9, y: 578.66 }, 8, s => s.id !== "label")?.id).toBe("prose");
  });
});
