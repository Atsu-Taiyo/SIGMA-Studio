import { describe, expect, it } from "vitest";

import type { Graph3DObject } from "@/features/document";

import { buildGraph3DObjectGeometry } from "./graph3d-geometry";
import { createGraph3DThumbnailDrawing, createGraph3DThumbnailObject } from "./graph3d-thumbnail";

const WIDTH = 132;
const HEIGHT = 86;

function drawingFor(object: Graph3DObject) {
  const geometry = buildGraph3DObjectGeometry(createGraph3DThumbnailObject(object), {});
  return createGraph3DThumbnailDrawing(geometry, WIDTH, HEIGHT);
}

describe("3Dカードの概形", () => {
  it("面を持つ立体は、奥から手前へ並べた陰影付きの面として描く", () => {
    const drawing = drawingFor({
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    });
    expect(drawing.faces.length).toBeGreaterThan(0);
    expect(drawing.polylines).toHaveLength(0);
    for (const face of drawing.faces) {
      expect(face.shade).toBeGreaterThan(0);
      expect(face.shade).toBeLessThanOrEqual(1);
      for (const point of face.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(WIDTH);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(HEIGHT);
      }
    }
    // 面の向きが違えば陰影も違う。1色で塗ると立体に見えない。
    expect(new Set(drawing.faces.map((face) => face.shade.toFixed(3))).size).toBeGreaterThan(1);
  });

  it("曲線は1本のつながった線として描く", () => {
    const drawing = drawingFor({
      id: "curve",
      kind: "parametricCurve",
      x: "cos(t)",
      y: "sin(t)",
      z: "t/3",
      parameter: "t",
      range: { min: "-3*pi", max: "3*pi", samples: 160 },
    });
    expect(drawing.faces).toHaveLength(0);
    // 途切れた線分の集まりになっていると、細かい破線の散らばりに見えてしまう。
    expect(drawing.polylines).toHaveLength(1);
    expect(drawing.polylines[0].length).toBeGreaterThan(50);
  });

  it("床の格子を敷いて奥行きを見せる", () => {
    const drawing = drawingFor({
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    });
    expect(drawing.floor.length).toBeGreaterThan(4);
  });

  it("カード用に plot 数を落として、元の式はそのまま保つ", () => {
    const surface = createGraph3DThumbnailObject({
      id: "surface",
      kind: "parametricSurface",
      x: "u",
      y: "v",
      z: "u^2+v^2",
      u: { min: "-2", max: "2", samples: 120 },
      v: { min: "-2", max: "2", samples: 120 },
    });
    expect(surface.kind === "parametricSurface" && surface.u.samples).toBe(20);
    expect(surface.kind === "parametricSurface" && surface.z).toBe("u^2+v^2");
  });

  it("計算できなかったときは何も描かない", () => {
    expect(createGraph3DThumbnailDrawing(null, WIDTH, HEIGHT)).toEqual({
      faces: [],
      polylines: [],
      points: [],
      floor: [],
    });
  });
});
