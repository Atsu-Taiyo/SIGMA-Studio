import { describe, expect, it } from "vitest";

import type { Graph3DSpec } from "@/features/document";

import { buildGraph3DSceneGeometry, createGraph3DRenderSpec, createGraph3DSampledSpec } from "./graph3d-scene";

const movingCubeSpec: Graph3DSpec = {
  version: 1,
  parameters: [
    { id: "parameter_s", name: "s", value: 0, min: -0.8, max: 0.8 },
  ],
  objects: [
    {
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    },
  ],
  cuts: [
    {
      id: "moving_cut",
      targetObjectIds: ["cube"],
      plane: { kind: "equation", expression: "z = s" },
      showContour: true,
      section: { showInScene: true, showFlattened2D: true },
      trail: { parameterId: "parameter_s", samples: 5 },
    },
  ],
  regions: [],
  annotations: [
    {
      id: "dimension_height",
      kind: "dimension",
      from: { x: "1", y: "0", z: "0" },
      to: { x: "1", y: "0", z: "s + 1" },
      labelTex: "\\sqrt{3}",
      color: "#1f2937",
    },
    {
      id: "label_origin",
      kind: "label",
      position: { x: "0", y: "0", z: "0" },
      labelTex: "O",
    },
  ],
  camera: {
    projection: "perspective",
    position: { x: 4, y: -5, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#fff" },
};

describe("graph 3D scene geometry", () => {
  it("evaluates generic parameters for objects and leaves authored cuts undrawn", () => {
    const scene = buildGraph3DSceneGeometry(movingCubeSpec, { s: 0.5 });
    expect(scene.issues).toEqual([]);
    expect(scene.objects).toHaveLength(1);
    expect(scene.cuts).toEqual([]);
    expect(scene.annotations[0]).toEqual(expect.objectContaining({
      to: { x: 1, y: 0, z: 1.5 },
    }));
  });

  it("resolves mathematical labels and dimension endpoints with the same parameters", () => {
    const scene = buildGraph3DSceneGeometry(movingCubeSpec, { s: 0.5 });

    expect(scene.annotations).toEqual([
      expect.objectContaining({
        id: "dimension_height",
        kind: "dimension",
        from: { x: 1, y: 0, z: 0 },
        to: { x: 1, y: 0, z: 1.5 },
        labelTex: "\\sqrt{3}",
      }),
      expect.objectContaining({
        id: "label_origin",
        kind: "label",
        position: { x: 0, y: 0, z: 0 },
      }),
    ]);
  });

  it("reports an authored expression error without dropping valid sibling objects", () => {
    const spec: Graph3DSpec = {
      ...movingCubeSpec,
      objects: [
        ...movingCubeSpec.objects,
        {
          id: "unfinished_surface",
          kind: "parametricSurface",
          x: "u",
          y: "v",
          z: "sin(",
          u: { min: "-1", max: "1", samples: 4 },
          v: { min: "-1", max: "1", samples: 4 },
        },
      ],
    };
    const scene = buildGraph3DSceneGeometry(spec);
    expect(scene.objects.map((object) => object.objectId)).toEqual(["cube"]);
    expect(scene.issues).toEqual([
      expect.objectContaining({ scope: "object", id: "unfinished_surface" }),
    ]);
  });
});

describe("3D シーンの作り直しコスト", () => {
  it("色・名前・表示切り替えだけの編集では立体を採寸し直さない", () => {
    const first = buildGraph3DSceneGeometry(movingCubeSpec);
    const recoloured = buildGraph3DSceneGeometry({
      ...movingCubeSpec,
      objects: movingCubeSpec.objects.map((object) => ({
        ...object,
        name: "立方体",
        style: { color: "#ff0000", opacity: 0.5 },
      })),
    });

    // 同じメッシュを配り直すだけ。採寸し直していれば別インスタンスになる。
    expect(recoloured.objects[0].geometry).toBe(first.objects[0].geometry);
    // 新しいスタイルはちゃんと載っている。
    expect(recoloured.objects[0].object.style?.color).toBe("#ff0000");
    expect(recoloured.objects[0].object.name).toBe("立方体");
  });

  it("同じ spec を複数の表示面が読んでも1回しか組み立てない", () => {
    expect(buildGraph3DSceneGeometry(movingCubeSpec))
      .toBe(buildGraph3DSceneGeometry(movingCubeSpec));
  });

  it("形が変わる編集ではちゃんと作り直す", () => {
    const first = buildGraph3DSceneGeometry(movingCubeSpec);
    const resized = buildGraph3DSceneGeometry({
      ...movingCubeSpec,
      objects: movingCubeSpec.objects.map((object) => (
        object.kind === "primitive" ? { ...object, size: { x: "4", y: "2", z: "2" } } : object
      )),
    });

    expect(resized.objects[0].geometry).not.toBe(first.objects[0].geometry);
    expect(resized.objects[0].geometry.positions.some((point) => point.x === 2)).toBe(true);
  });

  it("パラメータが動けば寸法の端点も動く", () => {
    const atZero = buildGraph3DSceneGeometry(movingCubeSpec);
    const moved = buildGraph3DSceneGeometry(movingCubeSpec, { s: 0.5 });

    expect(moved.annotations[0]).toEqual(expect.objectContaining({ to: { x: 1, y: 0, z: 1.5 } }));
    expect(atZero.annotations[0]).toEqual(expect.objectContaining({ to: { x: 1, y: 0, z: 1 } }));
    expect(moved.objects[0].geometry).toBe(atZero.objects[0].geometry);
  });

  it("再生中だけ採寸密度を下げ、元のspecは変更しない", () => {
    const surfaceSpec: Graph3DSpec = {
      ...movingCubeSpec,
      objects: [{
        id: "surface",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "sin(u+s)",
        u: { min: "-2", max: "2", samples: 40 },
        v: { min: "-2", max: "2", samples: 30 },
      }],
    };
    const balanced = createGraph3DRenderSpec(surfaceSpec, "balanced");
    const lightweight = createGraph3DRenderSpec(surfaceSpec, "lightweight");

    expect(balanced.objects[0]).toMatchObject({
      u: { samples: 26 },
      v: { samples: 20 },
    });
    expect(lightweight.objects[0]).toMatchObject({
      u: { samples: 16 },
      v: { samples: 12 },
    });
    expect(surfaceSpec.objects[0]).toMatchObject({
      u: { samples: 40 },
      v: { samples: 30 },
    });
  });
});

describe("createGraph3DSampledSpec", () => {
  const spec: Graph3DSpec = {
    version: 1,
    parameters: [],
    objects: [
      {
        id: "ball",
        kind: "primitive",
        primitive: "sphere",
        center: { x: "0", y: "0", z: "0" },
        size: { x: "2", y: "2", z: "2" },
      },
      {
        id: "solid",
        kind: "boundedSolid",
        inequalities: ["x^2 + y^2 + z^2 <= 1"],
        bounds: {
          x: { min: "-1.2", max: "1.2" },
          y: { min: "-1.2", max: "1.2" },
          z: { min: "-1.2", max: "1.2" },
        },
        resolution: 20,
      },
      {
        id: "sheet",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "u*v",
        u: { min: "-1", max: "1", samples: 12 },
        v: { min: "-1", max: "1", samples: 12 },
      },
    ],
    cuts: [],
    regions: [{
      id: "shared",
      kind: "objectIntersection",
      objectIds: ["ball", "solid"],
      fill: { mode: "solid", color: "#1d4ed8" },
      resolution: 18,
    }],
    annotations: [],
    camera: {
      projection: "perspective",
      position: { x: 4, y: -4, z: 3 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
    view: {
      coordinateSystem: "zUp",
      showAxes: true,
      showGrid: true,
      backgroundColor: "#ffffff",
    },
  };

  it("raises every plot count together when the caller can afford more", () => {
    const finer = createGraph3DSampledSpec(spec, 2);
    const [ball, solid, sheet] = finer.objects;
    expect(solid.kind === "boundedSolid" && solid.resolution).toBe(40);
    expect(sheet.kind === "parametricSurface" && sheet.u.samples).toBe(24);
    expect(sheet.kind === "parametricSurface" && sheet.v.samples).toBe(24);
    expect(finer.regions[0].kind === "objectIntersection" && finer.regions[0].resolution).toBe(36);
    // A ring of segments is nothing next to a marched solid, so it goes straight to the ceiling.
    expect(ball.kind === "primitive" && ball.resolution).toBe(256);
  });

  it("keeps every count inside the bounds the settings panel enforces", () => {
    const absurd = createGraph3DSampledSpec(spec, 1_000);
    const [, solid, sheet] = absurd.objects;
    expect(solid.kind === "boundedSolid" && solid.resolution).toBe(128);
    expect(sheet.kind === "parametricSurface" && sheet.u.samples).toBe(256);
    const nothing = createGraph3DSampledSpec(spec, 0.0001);
    const [, tinySolid, tinySheet] = nothing.objects;
    expect(tinySolid.kind === "boundedSolid" && tinySolid.resolution).toBe(10);
    expect(tinySheet.kind === "parametricSurface" && tinySheet.u.samples).toBe(6);
  });

  it("hands back the authored spec itself at factor 1, and never mutates it", () => {
    const before = JSON.stringify(spec);
    expect(createGraph3DSampledSpec(spec, 1)).toBe(spec);
    createGraph3DSampledSpec(spec, 3);
    createGraph3DRenderSpec(spec, "lightweight");
    expect(JSON.stringify(spec)).toBe(before);
  });

  it("leaves a cheap primitive alone when the caller is giving density up", () => {
    const [ball] = createGraph3DRenderSpec(spec, "lightweight").objects;
    expect(ball.kind === "primitive" && ball.resolution).toBeUndefined();
  });
});
