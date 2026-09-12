import { describe, expect, it } from "vitest";

import type { OverlayShape } from "@/features/document";

import { reorderShapes } from "./reorder-shapes";

function rect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    props: {
      w,
      h,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
  };
}

function ids(shapes: OverlayShape[]): string[] {
  return shapes.map((shape) => shape.id);
}

describe("overlay stack ordering", () => {
  it("reorders selected shapes to front, back, and one step at a time", () => {
    const shapes = ["a", "b", "c", "d", "e"].map(
      (id, index) => rect(id, index * 10, 0, 10, 10),
    );
    const selected = ["b", "d"];

    expect(ids(reorderShapes(shapes, selected, "front"))).toEqual([
      "a",
      "c",
      "e",
      "b",
      "d",
    ]);
    expect(ids(reorderShapes(shapes, selected, "back"))).toEqual([
      "b",
      "d",
      "a",
      "c",
      "e",
    ]);
    expect(ids(reorderShapes(shapes, selected, "forward"))).toEqual([
      "a",
      "c",
      "b",
      "e",
      "d",
    ]);
    expect(ids(reorderShapes(shapes, selected, "backward"))).toEqual([
      "b",
      "a",
      "d",
      "c",
      "e",
    ]);
  });

  it("marks shapes sent to the very back as the background stack layer", () => {
    const shapes = ["a", "b", "c"].map(
      (id, index) => rect(id, index * 10, 0, 10, 10),
    );
    const sentBack = reorderShapes(shapes, ["b"], "back");

    expect(ids(sentBack)).toEqual(["b", "a", "c"]);
    expect(
      sentBack.find((shape) => shape.id === "b")?.stackLayer,
    ).toBe("background");

    const broughtForward = reorderShapes(sentBack, ["b"], "forward");
    expect(
      broughtForward.find((shape) => shape.id === "b")?.stackLayer,
    ).toBeUndefined();
  });

  it("moves a group and its children as one stack unit", () => {
    const shapes: OverlayShape[] = [
      rect("a", 0, 0, 20, 20),
      {
        id: "group",
        type: "group",
        x: 40,
        y: 0,
        props: { w: 50, h: 20 },
      },
      { ...rect("b", 40, 0, 20, 20), parentId: "group" },
      { ...rect("c", 70, 0, 20, 20), parentId: "group" },
      rect("d", 100, 0, 20, 20),
    ];

    expect(ids(reorderShapes(shapes, ["group"], "front"))).toEqual([
      "a",
      "d",
      "group",
      "b",
      "c",
    ]);
    expect(ids(reorderShapes(shapes, ["group"], "back"))).toEqual([
      "group",
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("prioritizes overlapping siblings for one-step layer moves", () => {
    const shapes = [
      rect("a", 0, 0, 20, 20),
      rect("b", 80, 0, 20, 20),
      rect("c", 10, 10, 20, 20),
      rect("d", 120, 0, 20, 20),
    ];

    expect(ids(reorderShapes(shapes, ["a"], "forward"))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
    expect(ids(reorderShapes(shapes, ["c"], "backward"))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
  });
});
