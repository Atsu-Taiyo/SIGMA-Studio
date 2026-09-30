import { describe, expect, it } from "vitest";

import type { OverlayGeoShape, OverlayPoint } from "@/features/document";

import { updateShapePoint } from "./point-edit";
import { hitTestShape } from "./shape-hit-test";
import { getShapeRotationPivot } from "./shape-visual-bounds";
import { resizeBoxShape } from "./shape-transform";
import {
  createSolidEdgeDash,
  getSharedSolidDash,
  getSharedSolidSize,
  getSolidEdgeCount,
  getSolidEdgeDash,
  getSolidEdgeSize,
  getSolidFillPolygon,
  getSolidNaturalAspect,
  getSolidPoints,
  getSolidPreset,
  getSolidStrokes,
  getSolidTopology,
  hasCustomSolidPoints,
  hitTestSolidEdge,
  hitTestSolidEdgeAtPagePoint,
  isSolidShape,
  moveSolidVertex,
  OVERLAY_SOLID_COMMANDS,
  scaleSolidPoints,
  setSolidDash,
  setSolidEdgeDash,
  setSolidEdgeSize,
  setSolidSize,
  SOLID_BASE_SIDES,
  solidCommandFor,
  solidFromCommand,
} from "./solid-geometry";

function solid(
  geo: "pyramid" | "prism" | "sphere",
  baseSides: number | undefined,
  overrides: Partial<OverlayGeoShape["props"]> & Pick<OverlayGeoShape, never> = {},
  frame: Partial<Pick<OverlayGeoShape, "x" | "y" | "rotation" | "flipX" | "flipY">> = {},
): OverlayGeoShape {
  return {
    id: "solid",
    type: "geo",
    x: 100,
    y: 50,
    ...frame,
    props: {
      w: 120,
      h: 160,
      geo,
      ...(baseSides ? { baseSides: baseSides as never } : {}),
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
      ...overrides,
    },
  };
}

/** 頂点の、回転・反転をかけた後のページ座標。描画される位置。 */
function renderedPoint(shape: OverlayGeoShape, point: OverlayPoint): OverlayPoint {
  const pivot = getShapeRotationPivot(shape);
  const q = { x: shape.x + point.x, y: shape.y + point.y };
  const flipped = {
    x: shape.flipX ? pivot.x * 2 - q.x : q.x,
    y: shape.flipY ? pivot.y * 2 - q.y : q.y,
  };
  const rotation = shape.rotation ?? 0;
  const dx = flipped.x - pivot.x;
  const dy = flipped.y - pivot.y;
  return {
    x: pivot.x + dx * Math.cos(rotation) - dy * Math.sin(rotation),
    y: pivot.y + dx * Math.sin(rotation) + dy * Math.cos(rotation),
  };
}

describe("solid commands", () => {
  it("names every pyramid, prism and the sphere, and reads them back", () => {
    expect(OVERLAY_SOLID_COMMANDS).toHaveLength(21);
    expect(new Set(OVERLAY_SOLID_COMMANDS).size).toBe(21);
    for (const command of OVERLAY_SOLID_COMMANDS) {
      const kind = solidFromCommand(command);
      expect(kind).not.toBeNull();
      expect(solidCommandFor(kind!)).toBe(command);
    }
    expect(solidFromCommand("pyramid3")).toEqual({ geo: "pyramid", baseSides: 3 });
    expect(solidFromCommand("prism12")).toEqual({ geo: "prism", baseSides: 12 });
    expect(solidFromCommand("sphere")).toEqual({ geo: "sphere" });
  });

  it("does not mistake other tools or out-of-range base sides for a solid", () => {
    for (const command of ["pentagon", "rectangle", "pyramid2", "pyramid13", "prism0", "pyramid", "sphere2", ""]) {
      expect(solidFromCommand(command)).toBeNull();
    }
  });
});

describe("solid topology", () => {
  it("gives a pyramid n + 1 vertices and 2n edges, a prism 2n vertices and 3n edges", () => {
    for (const n of SOLID_BASE_SIDES) {
      const pyramid = getSolidTopology("pyramid", n);
      expect(pyramid.vertexCount).toBe(n + 1);
      expect(pyramid.edges).toHaveLength(2 * n);
      expect(pyramid.faces).toHaveLength(n + 1);
      const prism = getSolidTopology("prism", n);
      expect(prism.vertexCount).toBe(2 * n);
      expect(prism.edges).toHaveLength(3 * n);
      expect(prism.faces).toHaveLength(n + 2);
    }
  });

  it("uses every vertex exactly as often as the solid demands", () => {
    // 角錐の頂点は n 本の辺が集まり、底面の頂点は 3 本。角柱はどの頂点にも 3 本。
    const degree = (edges: ReadonlyArray<readonly [number, number]>, vertexCount: number) => {
      const counts = Array.from({ length: vertexCount }, () => 0);
      for (const [a, b] of edges) {
        counts[a] += 1;
        counts[b] += 1;
      }
      return counts;
    };
    const pyramid = getSolidTopology("pyramid", 5);
    expect(degree(pyramid.edges, pyramid.vertexCount)).toEqual([3, 3, 3, 3, 3, 5]);
    const prism = getSolidTopology("prism", 4);
    expect(degree(prism.edges, prism.vertexCount)).toEqual(Array.from({ length: 8 }, () => 3));
  });

  it("counts a sphere's edges as its outline and the two halves of the equator", () => {
    expect(getSolidEdgeCount({ geo: "sphere" })).toBe(3);
    expect(getSolidEdgeCount({ geo: "pyramid", baseSides: 4 })).toBe(8);
    expect(getSolidEdgeCount({ geo: "prism", baseSides: 5 })).toBe(15);
  });
});

describe("solid preset", () => {
  it("hides only the edges that sit behind the solid, like a textbook figure", () => {
    // 三角錐: 奥の底面の頂点につながる 3 本 (底面の 2 辺と頂点への 1 辺) だけが見えない。
    const pyramid = getSolidPreset("pyramid", 3);
    expect(pyramid.hiddenEdges.filter(Boolean)).toHaveLength(3);
    // 三角柱: 奥の下底の頂点につながる 3 本。
    expect(getSolidPreset("prism", 3).hiddenEdges.filter(Boolean)).toHaveLength(3);
    // 四角柱 (直方体): 奥の下の頂点につながる 3 本。
    expect(getSolidPreset("prism", 4).hiddenEdges.filter(Boolean)).toHaveLength(3);
    // 四角錐: 奥の底面の頂点につながる 3 本。
    expect(getSolidPreset("pyramid", 4).hiddenEdges.filter(Boolean)).toHaveLength(3);
  });

  it("always leaves some edges visible and some hidden, for every solid", () => {
    for (const n of SOLID_BASE_SIDES) {
      for (const geo of ["pyramid", "prism"] as const) {
        const { hiddenEdges } = getSolidPreset(geo, n);
        expect(hiddenEdges.some(Boolean)).toBe(true);
        expect(hiddenEdges.some((hidden) => !hidden)).toBe(true);
      }
    }
  });

  it("normalises the vertices so their bounding box touches all four sides of the unit square", () => {
    for (const n of SOLID_BASE_SIDES) {
      for (const geo of ["pyramid", "prism"] as const) {
        const { unitPoints } = getSolidPreset(geo, n);
        const xs = unitPoints.map((point) => point.x);
        const ys = unitPoints.map((point) => point.y);
        expect(Math.min(...xs)).toBeCloseTo(0, 9);
        expect(Math.max(...xs)).toBeCloseTo(1, 9);
        expect(Math.min(...ys)).toBeCloseTo(0, 9);
        expect(Math.max(...ys)).toBeCloseTo(1, 9);
      }
    }
  });

  it("puts a pyramid's apex above its base and a prism's top ring above its bottom ring", () => {
    const pyramid = getSolidPreset("pyramid", 5);
    const apex = pyramid.unitPoints[5];
    expect(apex.y).toBeCloseTo(0, 9);
    for (const base of pyramid.unitPoints.slice(0, 5)) {
      expect(base.y).toBeGreaterThan(apex.y);
    }
    const prism = getSolidPreset("prism", 5);
    for (let index = 0; index < 5; index += 1) {
      expect(prism.unitPoints[index + 5].y).toBeLessThan(prism.unitPoints[index].y);
    }
  });

  it("reports the aspect ratio the preset needs", () => {
    expect(getSolidNaturalAspect({ geo: "sphere" })).toBe(1);
    const { aspect } = getSolidPreset("pyramid", 3);
    expect(getSolidNaturalAspect({ geo: "pyramid", baseSides: 3 })).toBe(aspect);
    expect(aspect).toBeGreaterThan(0.5);
  });

  it("dashes the hidden edges of a new solid and gives the rest the requested line style", () => {
    const hidden = getSolidPreset("prism", 4).hiddenEdges;
    expect(createSolidEdgeDash({ geo: "prism", baseSides: 4 })).toEqual(
      hidden.map((isHidden) => (isHidden ? "dashed" : "solid")),
    );
    expect(createSolidEdgeDash({ geo: "prism", baseSides: 4 }, "dotted")).toEqual(
      hidden.map((isHidden) => (isHidden ? "dashed" : "dotted")),
    );
    expect(createSolidEdgeDash({ geo: "sphere" })).toEqual(["solid", "solid", "dashed"]);
  });
});

describe("solid points and strokes", () => {
  it("scales the preset to the frame when no vertex has been moved", () => {
    const shape = solid("pyramid", 3);
    const points = getSolidPoints(shape);
    expect(points).toHaveLength(4);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(120, 9);
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(160, 9);
    expect(hasCustomSolidPoints(shape)).toBe(false);
  });

  it("falls back to the preset when the stored vertices do not fit the solid", () => {
    const stale = solid("pyramid", 3, { solidPoints: [{ x: 0, y: 0 }, { x: 10, y: 10 }] });
    expect(getSolidPoints(stale)).toEqual(getSolidPoints(solid("pyramid", 3)));
    expect(hasCustomSolidPoints(stale)).toBe(false);
    const nonFinite = solid("pyramid", 3, {
      solidPoints: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: Number.NaN }, { x: 3, y: 3 }],
    });
    expect(getSolidPoints(nonFinite)).toEqual(getSolidPoints(solid("pyramid", 3)));
  });

  it("reads an edge's line style, defaulting to the whole shape's", () => {
    const shape = solid("prism", 3, { dash: "dotted", solidEdgeDash: ["solid", "dashed"] });
    expect(getSolidEdgeDash(shape, 0)).toBe("solid");
    expect(getSolidEdgeDash(shape, 1)).toBe("dashed");
    expect(getSolidEdgeDash(shape, 2)).toBe("dotted");
    expect(getSolidEdgeDash(shape, 99)).toBe("dotted");
  });

  it("emits one stroke per edge, each with its own line style", () => {
    const shape = solid("pyramid", 4, { solidEdgeDash: createSolidEdgeDash({ geo: "pyramid", baseSides: 4 }) });
    const strokes = getSolidStrokes(shape);
    expect(strokes).toHaveLength(8);
    expect(strokes.map((stroke) => stroke.index)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(strokes.map((stroke) => stroke.dash)).toEqual(shape.props.solidEdgeDash);
    expect(strokes[0].d).toMatch(/^M [-\d.e]+ [-\d.e]+ L [-\d.e]+ [-\d.e]+$/u);
    expect(strokes[0].points).toHaveLength(2);
  });

  it("draws a sphere as an outline plus a front and a back equator", () => {
    const shape = solid("sphere", undefined, { w: 100, h: 100, solidEdgeDash: ["solid", "solid", "dashed"] });
    const strokes = getSolidStrokes(shape);
    expect(strokes.map((stroke) => stroke.dash)).toEqual(["solid", "solid", "dashed"]);
    // 手前の赤道は中心より下、奥は上。
    const meanY = (points: OverlayPoint[]) => points.reduce((sum, point) => sum + point.y, 0) / points.length;
    expect(meanY(strokes[1].points)).toBeGreaterThan(50);
    expect(meanY(strokes[2].points)).toBeLessThan(50);
    // 輪郭は枠の四辺に接する。
    const outline = strokes[0].points;
    expect(Math.min(...outline.map((point) => point.x))).toBeCloseTo(0, 6);
    expect(Math.max(...outline.map((point) => point.x))).toBeCloseTo(100, 6);
  });

  it("fills the convex hull of the vertices", () => {
    const shape = solid("prism", 4);
    const hull = getSolidFillPolygon(shape);
    const points = getSolidPoints(shape);
    expect(hull.length).toBeGreaterThanOrEqual(3);
    expect(hull.length).toBeLessThanOrEqual(points.length);
    for (const vertex of hull) {
      expect(points).toContainEqual(vertex);
    }
  });

  it("recognises solids and nothing else as solid shapes", () => {
    expect(isSolidShape(solid("pyramid", 3))).toBe(true);
    expect(isSolidShape(solid("sphere", undefined))).toBe(true);
    expect(isSolidShape({ ...solid("prism", 3), props: { ...solid("prism", 3).props, geo: "rectangle" } })).toBe(false);
  });
});

describe("solid edge hit testing", () => {
  it("finds the edge under the pointer and nothing away from the lines", () => {
    const shape = solid("prism", 4, { w: 100, h: 100 });
    const strokes = getSolidStrokes(shape);
    const target = strokes[5];
    const midpoint = {
      x: (target.points[0].x + target.points[1].x) / 2,
      y: (target.points[0].y + target.points[1].y) / 2,
    };
    expect(hitTestSolidEdge(shape, midpoint, 4)).toBe(5);
    expect(hitTestSolidEdge(shape, { x: midpoint.x + 2, y: midpoint.y + 2 }, 4)).toBe(5);
    expect(hitTestSolidEdge(shape, { x: -50, y: -50 }, 4)).toBeNull();
  });

  it("prefers the nearest edge where two edges meet", () => {
    const shape = solid("pyramid", 4, { w: 100, h: 100 });
    const apex = getSolidPoints(shape)[4];
    const nearApex = { x: apex.x + 1, y: apex.y + 1 };
    const hit = hitTestSolidEdge(shape, nearApex, 6);
    expect(hit).not.toBeNull();
    const distance = (index: number) => {
      const [a, b] = getSolidStrokes(shape)[index].points;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const t = Math.max(0, Math.min(1, ((nearApex.x - a.x) * dx + (nearApex.y - a.y) * dy) / (dx * dx + dy * dy)));
      return Math.hypot(nearApex.x - (a.x + t * dx), nearApex.y - (a.y + t * dy));
    };
    for (let index = 0; index < 8; index += 1) {
      expect(distance(hit!)).toBeLessThanOrEqual(distance(index) + 1e-9);
    }
  });

  it("selects a sphere's outline and each half of its equator", () => {
    const shape = solid("sphere", undefined, { w: 100, h: 100 });
    expect(hitTestSolidEdge(shape, { x: 0, y: 50 }, 3)).not.toBeNull();
    expect(hitTestSolidEdge(shape, { x: 50, y: 0 }, 3)).toBe(0);
    // 赤道の手前の半周 (下) と奥の半周 (上)。
    expect(hitTestSolidEdge(shape, { x: 50, y: 50 + 50 * 0.3 }, 3)).toBe(1);
    expect(hitTestSolidEdge(shape, { x: 50, y: 50 - 50 * 0.3 }, 3)).toBe(2);
    expect(hitTestSolidEdge(shape, { x: 50, y: 50 }, 3)).toBeNull();
  });

  it("reads a pointer on the page through the shape's rotation and flip", () => {
    const rotated = solid("prism", 4, { w: 100, h: 100 }, { rotation: Math.PI / 3, flipX: true });
    const target = getSolidStrokes(rotated)[3];
    const midpoint = {
      x: (target.points[0].x + target.points[1].x) / 2,
      y: (target.points[0].y + target.points[1].y) / 2,
    };
    expect(hitTestSolidEdgeAtPagePoint(rotated, renderedPoint(rotated, midpoint), 3)).toBe(3);
    expect(hitTestSolidEdgeAtPagePoint(rotated, { x: rotated.x - 200, y: rotated.y - 200 }, 3)).toBeNull();
  });
});

describe("moving a vertex", () => {
  it("moves the vertex to the pointer and refits the frame around all vertices", () => {
    const shape = solid("pyramid", 3, { w: 120, h: 160 });
    const before = getSolidPoints(shape);
    // 頂点 3 (頂点) を枠の外の左上へ引き出す。
    const moved = moveSolidVertex(shape, 3, { x: shape.x - 30, y: shape.y - 40 });

    const after = getSolidPoints(moved);
    expect(hasCustomSolidPoints(moved)).toBe(true);
    // 外接矩形は頂点にぴったり接する。
    expect(Math.min(...after.map((point) => point.x))).toBeCloseTo(0, 9);
    expect(Math.min(...after.map((point) => point.y))).toBeCloseTo(0, 9);
    expect(Math.max(...after.map((point) => point.x))).toBeCloseTo(moved.props.w, 9);
    expect(Math.max(...after.map((point) => point.y))).toBeCloseTo(moved.props.h, 9);
    // ページ上の位置は、動かした頂点はポインタの位置、動かしていない頂点はそのまま。
    expect(moved.x + after[3].x).toBeCloseTo(shape.x - 30, 9);
    expect(moved.y + after[3].y).toBeCloseTo(shape.y - 40, 9);
    for (const index of [0, 1, 2]) {
      expect(moved.x + after[index].x).toBeCloseTo(shape.x + before[index].x, 9);
      expect(moved.y + after[index].y).toBeCloseTo(shape.y + before[index].y, 9);
    }
  });

  it("keeps the unmoved vertices where they were drawn when the shape is rotated and flipped", () => {
    for (const frame of [
      { rotation: 0.7 },
      { rotation: -2.1, flipX: true },
      { rotation: 1.2, flipY: true },
      { rotation: 3, flipX: true, flipY: true },
    ]) {
      const shape = solid("prism", 5, { w: 140, h: 120 }, frame);
      const before = getSolidPoints(shape).map((point) => renderedPoint(shape, point));
      // ドラッグ中はポインタを回転・反転の前の座標へ戻して渡す (`pagePointToUnrotatedShapePoint`)。
      const dragTo = { x: shape.x + 260, y: shape.y - 80 };
      const moved = moveSolidVertex(shape, 2, dragTo);
      const after = getSolidPoints(moved).map((point) => renderedPoint(moved, point));
      for (let index = 0; index < before.length; index += 1) {
        if (index === 2) {
          continue;
        }
        expect(after[index].x).toBeCloseTo(before[index].x, 6);
        expect(after[index].y).toBeCloseTo(before[index].y, 6);
      }
    }
  });

  it("is reached through the point handle, and ignores handles that are not for it", () => {
    const shape = solid("pyramid", 4);
    const viaHandle = updateShapePoint(shape, { type: "solidVertex", index: 1 }, { x: 150, y: 90 });
    expect(viaHandle).toEqual(moveSolidVertex(shape, 1, { x: 150, y: 90 }));
    expect(updateShapePoint(shape, { type: "triangleApex" }, { x: 150, y: 90 })).toBe(shape);
    expect(moveSolidVertex(shape, 99, { x: 0, y: 0 })).toBe(shape);
    expect(moveSolidVertex(shape, -1, { x: 0, y: 0 })).toBe(shape);
  });

  it("never lets the frame collapse to nothing", () => {
    const shape = solid("prism", 3, { w: 10, h: 10 });
    let moved = shape;
    for (let index = 0; index < 6; index += 1) {
      moved = moveSolidVertex(moved, index, { x: shape.x + 5, y: shape.y + 5 });
    }
    expect(moved.props.w).toBeGreaterThanOrEqual(1);
    expect(moved.props.h).toBeGreaterThanOrEqual(1);
  });
});

describe("resizing a solid", () => {
  it("scales moved vertices with the frame and leaves an untouched solid on its preset", () => {
    const plain = solid("pyramid", 3);
    expect(scaleSolidPoints(plain, 240, 80)).toBeUndefined();

    const moved = moveSolidVertex(plain, 0, { x: plain.x + 10, y: plain.y + 20 });
    const scaled = scaleSolidPoints(moved, moved.props.w * 2, moved.props.h / 2)!;
    const original = getSolidPoints(moved);
    scaled.forEach((point, index) => {
      expect(point.x).toBeCloseTo(original[index].x * 2, 9);
      expect(point.y).toBeCloseTo(original[index].y / 2, 9);
    });
  });

  it("resizes through the shared transform, keeping the moved vertices proportional", () => {
    const moved = moveSolidVertex(solid("prism", 4), 5, { x: 260, y: 30 });
    const bounds = { x: moved.x + 10, y: moved.y + 5, w: moved.props.w * 1.5, h: moved.props.h * 0.5 };
    const resized = resizeBoxShape(moved, bounds) as OverlayGeoShape;
    expect(resized.x).toBe(bounds.x);
    expect(resized.y).toBe(bounds.y);
    expect(resized.props.w).toBeCloseTo(bounds.w, 9);
    expect(resized.props.h).toBeCloseTo(bounds.h, 9);
    expect(hasCustomSolidPoints(resized)).toBe(true);
    const points = getSolidPoints(resized);
    expect(Math.max(...points.map((point) => point.x))).toBeCloseTo(bounds.w, 9);
    expect(Math.max(...points.map((point) => point.y))).toBeCloseTo(bounds.h, 9);
  });
});

describe("edge line styles", () => {
  it("changes one edge and keeps the others as they are drawn", () => {
    const shape = solid("prism", 3, { solidEdgeDash: createSolidEdgeDash({ geo: "prism", baseSides: 3 }) });
    const changed = setSolidEdgeDash(shape, 4, "dotted");
    expect(changed.props.solidEdgeDash![4]).toBe("dotted");
    expect(changed.props.solidEdgeDash!.filter((_, index) => index !== 4))
      .toEqual(shape.props.solidEdgeDash!.filter((_, index) => index !== 4));
    // もとの図形は変わらない。
    expect(shape.props.solidEdgeDash![4]).not.toBe("dotted");
  });

  it("fills in edges that had no style of their own from the whole shape's line style", () => {
    const shape = solid("pyramid", 3, { dash: "dashed" });
    const changed = setSolidEdgeDash(shape, 2, "solid");
    expect(changed.props.solidEdgeDash).toEqual(["dashed", "dashed", "solid", "dashed", "dashed", "dashed"]);
  });

  it("refuses an edge the solid does not have", () => {
    const shape = solid("pyramid", 3);
    expect(setSolidEdgeDash(shape, 6, "dotted")).toBe(shape);
    expect(setSolidEdgeDash(shape, -1, "dotted")).toBe(shape);
    const sphere = solid("sphere", undefined);
    expect(setSolidEdgeDash(sphere, 3, "dotted")).toBe(sphere);
    expect(setSolidEdgeDash(sphere, 2, "dotted").props.solidEdgeDash).toEqual(["solid", "solid", "dotted"]);
  });

  it("sets every edge at once, dropping the per-edge overrides", () => {
    const shape = solid("prism", 3, { solidEdgeDash: createSolidEdgeDash({ geo: "prism", baseSides: 3 }) });
    const all = setSolidDash(shape, "dashed");
    expect(all.props.dash).toBe("dashed");
    expect(all.props.solidEdgeDash).toBeUndefined();
    expect(getSolidStrokes(all).every((stroke) => stroke.dash === "dashed")).toBe(true);
  });

  it("reports the shared style only when every edge agrees", () => {
    expect(getSharedSolidDash(solid("prism", 3, { dash: "dotted" }))).toBe("dotted");
    const mixed = solid("prism", 3, { solidEdgeDash: createSolidEdgeDash({ geo: "prism", baseSides: 3 }) });
    expect(getSharedSolidDash(mixed)).toBeNull();
    expect(getSharedSolidDash(setSolidDash(mixed, "dashed"))).toBe("dashed");
  });
});

describe("grabbing a solid", () => {
  it("grabs an unfilled solid only where a line is drawn, not in the empty space inside it", () => {
    const shape = solid("prism", 4, { w: 100, h: 100 });
    const [a, b] = getSolidStrokes(shape)[0].points;
    const onEdge = { x: shape.x + (a.x + b.x) / 2, y: shape.y + (a.y + b.y) / 2 };
    expect(hitTestShape(shape, onEdge)).toBe(true);
    expect(hitTestShape(shape, { x: onEdge.x, y: onEdge.y + 3 })).toBe(true);
    // 枠の中だが、どの線からも離れた場所。
    const empty = { x: shape.x + 50, y: shape.y + 50 };
    expect(hitTestSolidEdge(shape, { x: 50, y: 50 }, 6)).toBeNull();
    expect(hitTestShape(shape, empty)).toBe(false);
    expect(hitTestShape(shape, { x: shape.x - 40, y: shape.y - 40 })).toBe(false);
  });

  it("grabs the inside of a solid that is filled", () => {
    const shape = solid("prism", 4, { w: 100, h: 100, fill: "solid" });
    expect(hitTestShape(shape, { x: shape.x + 50, y: shape.y + 50 })).toBe(true);
    expect(hitTestShape(shape, { x: shape.x - 40, y: shape.y - 40 })).toBe(false);
    const sphere = solid("sphere", undefined, { w: 100, h: 100, fill: "solid" });
    expect(hitTestShape(sphere, { x: sphere.x + 50, y: sphere.y + 50 })).toBe(true);
    // 球の輪郭の外 (枠の角) は塗りの外。
    expect(hitTestShape(sphere, { x: sphere.x + 3, y: sphere.y + 3 })).toBe(false);
  });

  it("follows the rotation and flip of the shape", () => {
    const shape = solid("pyramid", 3, { w: 100, h: 140 }, { rotation: 1.1, flipY: true });
    const stroke = getSolidStrokes(shape)[3];
    const midpoint = {
      x: (stroke.points[0].x + stroke.points[1].x) / 2,
      y: (stroke.points[0].y + stroke.points[1].y) / 2,
    };
    expect(hitTestShape(shape, renderedPoint(shape, midpoint))).toBe(true);
    expect(hitTestShape(shape, { x: shape.x - 300, y: shape.y - 300 })).toBe(false);
  });
});

describe("edge line widths", () => {
  it("reads an edge's own width, defaulting to the whole shape's", () => {
    const shape = solid("prism", 3, { size: "l", solidEdgeSize: ["s", "xl"] });
    expect(getSolidEdgeSize(shape, 0)).toBe("s");
    expect(getSolidEdgeSize(shape, 1)).toBe("xl");
    expect(getSolidEdgeSize(shape, 2)).toBe("l");
    expect(getSolidEdgeSize(shape, 99)).toBe("l");
  });

  it("gives every stroke its own width — straight edges and the sphere's curves alike", () => {
    const pyramid = solid("pyramid", 3, { solidEdgeSize: ["s", "m", "l", "xl", "s", "m"] });
    expect(getSolidStrokes(pyramid).map((stroke) => stroke.size)).toEqual(["s", "m", "l", "xl", "s", "m"]);
    const sphere = solid("sphere", undefined, { w: 100, h: 100, solidEdgeSize: ["xl", "s", "l"] });
    expect(getSolidStrokes(sphere).map((stroke) => stroke.size)).toEqual(["xl", "s", "l"]);
  });

  it("changes one edge's width and keeps the others, including its line style", () => {
    const shape = solid("prism", 3, {
      size: "m",
      solidEdgeDash: createSolidEdgeDash({ geo: "prism", baseSides: 3 }),
    });
    const changed = setSolidEdgeSize(shape, 4, "xl");
    expect(changed.props.solidEdgeSize).toEqual(["m", "m", "m", "m", "xl", "m", "m", "m", "m"]);
    expect(changed.props.solidEdgeDash).toEqual(shape.props.solidEdgeDash);
    expect(shape.props.solidEdgeSize).toBeUndefined();
  });

  it("refuses an edge the solid does not have", () => {
    const shape = solid("pyramid", 3);
    expect(setSolidEdgeSize(shape, 6, "l")).toBe(shape);
    expect(setSolidEdgeSize(shape, -1, "l")).toBe(shape);
    const sphere = solid("sphere", undefined);
    expect(setSolidEdgeSize(sphere, 3, "l")).toBe(sphere);
    expect(setSolidEdgeSize(sphere, 1, "l").props.solidEdgeSize).toEqual(["m", "l", "m"]);
  });

  it("sets every edge at once, dropping the per-edge widths", () => {
    const shape = solid("prism", 3, { solidEdgeSize: ["s", "xl"] });
    const all = setSolidSize(shape, "l");
    expect(all.props.size).toBe("l");
    expect(all.props.solidEdgeSize).toBeUndefined();
    expect(getSolidStrokes(all).every((stroke) => stroke.size === "l")).toBe(true);
  });

  it("reports the shared width only when every edge agrees", () => {
    expect(getSharedSolidSize(solid("prism", 3, { size: "l" }))).toBe("l");
    expect(getSharedSolidSize(solid("prism", 3, { solidEdgeSize: ["s"] }))).toBeNull();
    expect(getSharedSolidSize(setSolidSize(solid("prism", 3, { solidEdgeSize: ["s"] }), "xl"))).toBe("xl");
  });
});
