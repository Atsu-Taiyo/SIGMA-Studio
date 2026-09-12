import { describe, expect, it } from "vitest";

import {
  clampGraph3DHeadlessResolution,
  createGraph3DSceneSvg,
  MAX_GRAPH3D_HEADLESS_RESOLUTION,
  MAX_GRAPH3D_HEADLESS_SAMPLES,
} from "./graph3d-scene-svg";
import { createGraph3DSpecPreset } from "@/features/drawing";
import { buildGraph3DPresetNames } from "@/lib/graph3d-preset-names";
import { createTranslator } from "@/lib/i18n";
import { DEFAULT_GRAPH3D_AXIS_COLORS } from "@/features/document";
import type { Graph3DPreset, Graph3DSpec } from "@/features/document";

const PRESET_NAMES = buildGraph3DPresetNames(createTranslator("ja", "shape"));
const DRAWN_PRESETS: Graph3DPreset[] = ["revolution", "surface", "tricylinder", "sphereTetrahedron"];
const SIZE = { width: 360, height: 280 };

function preset(name: Graph3DPreset): Graph3DSpec {
  return createGraph3DSpecPreset(name, PRESET_NAMES);
}

function blankWith(patch: Partial<Graph3DSpec>): Graph3DSpec {
  return { ...preset("blank"), ...patch };
}

describe("createGraph3DSceneSvg", () => {
  it.each(DRAWN_PRESETS)("draws the %s preset without any text", (name) => {
    const result = createGraph3DSceneSvg(preset(name), SIZE);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(result!.svg).toContain(`viewBox="0 0 360 280"`);
    expect(result!.svg!.match(/<path /g)?.length ?? 0).toBeGreaterThan(0);
    // TeXラベルはどのビューでも別レイヤなので、焼き込むと印刷で二重に出る。
    expect(result!.svg).not.toContain("<text");
    expect(result!.svg).not.toContain("<foreignObject");
  });

  it("returns axes and grid only for a figure with no objects", () => {
    const result = createGraph3DSceneSvg(preset("blank"), SIZE);

    expect(result).not.toBeNull();
    expect(result!.svg).toContain(DEFAULT_GRAPH3D_AXIS_COLORS.x);
    expect(result!.svg!.length).toBeGreaterThan(200);
  });

  it("drops the axis and grid ink when the view hides them", () => {
    const spec = blankWith({
      view: { ...preset("blank").view, showAxes: false, showGrid: false },
    });

    const svg = createGraph3DSceneSvg(spec, SIZE)!.svg!;

    for (const color of Object.values(DEFAULT_GRAPH3D_AXIS_COLORS)) {
      expect(svg).not.toContain(color);
    }
    expect(svg).not.toContain("#8895a1");
    expect(svg).not.toContain("#d8dde2");
  });

  it("paints the authored background and falls back for a malformed colour", () => {
    const authored = createGraph3DSceneSvg(
      blankWith({ view: { ...preset("blank").view, backgroundColor: "#eef2ff" } }),
      SIZE,
    )!.svg!;
    expect(authored).toContain(`<rect width="100%" height="100%" fill="#eef2ff"/>`);

    const malformed = createGraph3DSceneSvg(
      blankWith({ view: { ...preset("blank").view, backgroundColor: 'red" onload="alert(1)' } }),
      SIZE,
    )!.svg!;
    expect(malformed).toContain(`<rect width="100%" height="100%" fill="#ffffff"/>`);
    expect(malformed).not.toContain("onload");
  });

  it("paints the far plane before the near one", () => {
    const spec = blankWith({
      view: { ...preset("blank").view, showAxes: false, showGrid: false },
      objects: [
        {
          id: "near_plane",
          kind: "plane",
          plane: { kind: "equation", expression: "x = 2" },
          size: { x: "2", y: "2", z: "0" },
          style: { color: "#ff0000", opacity: 1 },
        },
        {
          id: "far_plane",
          kind: "plane",
          plane: { kind: "equation", expression: "x = -2" },
          size: { x: "2", y: "2", z: "0" },
          style: { color: "#0000ff", opacity: 1 },
        },
      ],
    });

    const svg = createGraph3DSceneSvg(spec, SIZE)!.svg!;
    // 面ごとの陰影で明度は変わるが色相は残るので、赤い面と青い面の並びで前後を読む。
    const drawn = [...svg.matchAll(/fill="#([0-9a-f]{6})"/gi)]
      .map((match) => match[1])
      .map((hex) => ({
        red: Number.parseInt(hex.slice(0, 2), 16),
        blue: Number.parseInt(hex.slice(4, 6), 16),
      }))
      .filter((color) => color.red !== color.blue)
      .map((color) => (color.red > color.blue ? "near" : "far"));

    expect(drawn).toContain("near");
    expect(drawn).toContain("far");
    // カメラは +x 側にあるので x=-2 の面が遠い。painter's algorithm は遠い方を先に描く。
    expect(drawn.indexOf("far")).toBeLessThan(drawn.indexOf("near"));
    expect(drawn.lastIndexOf("far")).toBeLessThan(drawn.indexOf("near"));
  });

  it("projects differently for orthographic and perspective cameras and honours zoom", () => {
    const base = preset("blank");
    const perspective = createGraph3DSceneSvg(base, SIZE)!.svg!;
    const orthographic = createGraph3DSceneSvg(
      { ...base, camera: { ...base.camera, projection: "orthographic", zoom: 1 } },
      SIZE,
    )!.svg!;
    const zoomed = createGraph3DSceneSvg(
      { ...base, camera: { ...base.camera, projection: "orthographic", zoom: 2 } },
      SIZE,
    )!.svg!;

    expect(orthographic).not.toBe(perspective);
    expect(zoomed).not.toBe(orthographic);
  });

  it("clamps a dense scalar field instead of marching it at the authored density", () => {
    const dense: Graph3DSpec = blankWith({
      objects: [{
        id: "dense_solid",
        kind: "boundedSolid",
        inequalities: ["x^2 + y^2 + z^2 <= 1"],
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        resolution: 128,
      }],
    });

    expect(clampGraph3DHeadlessResolution(dense).objects[0]).toMatchObject({
      resolution: MAX_GRAPH3D_HEADLESS_RESOLUTION,
    });
    // authored spec は書き換えない。
    expect(dense.objects[0]).toMatchObject({ resolution: 128 });

    const startedAt = Date.now();
    const result = createGraph3DSceneSvg(dense, SIZE);
    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }, 30_000);

  it("gives up rather than serializing a figure past the triangle budget", () => {
    const heavy = blankWith({
      objects: Array.from({ length: 8 }, (_, index) => ({
        id: `solid_${index}`,
        kind: "boundedSolid" as const,
        inequalities: ["x^2 + y^2 + z^2 <= 1"],
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        resolution: 128,
      })),
    });

    const result = createGraph3DSceneSvg(heavy, SIZE);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.svg).toBeNull();
  }, 60_000);

  it("turns a dimension end toward the camera instead of a fixed plane", () => {
    // z 方向の寸法線を、その軸のまわりで 90 度違う 2 つの視点から見る。矢じりは常にカメラを
    // 向くので、どちらから見ても面で見える。カメラを見ていない実装では片方で線に潰れる。
    const withCamera = (position: { x: number; y: number; z: number }) => {
      const base = preset("blank");
      const spec: Graph3DSpec = {
        ...base,
        camera: { ...base.camera, position, target: { x: 0, y: 0, z: 0.5 } },
        view: { ...base.view, showAxes: false, showGrid: false },
        annotations: [{
          id: "dimension_probe",
          kind: "dimension",
          from: { x: "0", y: "0", z: "0" },
          to: { x: "0", y: "0", z: "1" },
          labelTex: "h",
          color: "#123456",
        }],
      };
      const svg = createGraph3DSceneSvg(spec, SIZE)!.svg!;
      // 矢じりは stroke-linejoin を持つ開いた折れ線として出る (寸法線の軸は持たない)。
      return [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="#123456"[^>]*stroke-linejoin/g)]
        .map((match) => {
          const xs = [...match[1].matchAll(/(-?\d+(?:\.\d+)?) -?\d+(?:\.\d+)?/g)]
            .map((pair) => Number(pair[1]));
          return Math.max(...xs) - Math.min(...xs);
        });
    };

    const fromX = withCamera({ x: 8, y: 0, z: 0.5 });
    const fromY = withCamera({ x: 0, y: 8, z: 0.5 });

    expect(fromX).toHaveLength(2);
    expect(fromY).toHaveLength(2);
    // どちらの視点でも矢じりは開いて見える。カメラを見ていない実装では片方が線に潰れる。
    for (const spread of [...fromX, ...fromY]) {
      expect(spread).toBeGreaterThan(2);
    }
  });

  it("gives every patterned common part its own hatch, keyed by position not by authored id", () => {
    const base = preset("revolution");
    const spec: Graph3DSpec = {
      ...base,
      regions: base.regions.map((region) => (
        region.kind === "objectIntersection"
          ? { ...region, id: 'evil" onload="alert(1)', fill: { mode: "pattern", color: "#aa00aa", pattern: "diagonal" } }
          : region
      )),
    };

    const svg = createGraph3DSceneSvg(spec, SIZE)!.svg!;

    expect(svg).toContain(`<pattern id="graph3d-scene-hatch-0"`);
    expect(svg).toContain(`fill="url(#graph3d-scene-hatch-0)"`);
    expect(svg).toContain("#aa00aa");
    expect(svg).not.toContain("onload");
    expect(svg).not.toContain("evil");
  });

  it("counts wireframe edges against the budget, not only the faces", () => {
    const solid = {
      id: "solid",
      kind: "boundedSolid" as const,
      inequalities: ["x^2 + y^2 + z^2 <= 1"],
      bounds: {
        x: { min: "-1", max: "1" },
        y: { min: "-1", max: "1" },
        z: { min: "-1", max: "1" },
      },
      resolution: 48,
    };

    expect(createGraph3DSceneSvg(blankWith({ objects: [solid] }), SIZE)!.truncated).toBe(false);
    // 同じ面数でも wireframe が付くと1面あたり4本になり、予算を超える。
    expect(createGraph3DSceneSvg(
      blankWith({ objects: [{ ...solid, style: { wireframe: true } }] }),
      SIZE,
    )!.truncated).toBe(true);
  }, 60_000);

  it("caps every authored density, not only the marched ones", () => {
    const spec = blankWith({
      objects: [
        {
          id: "surface",
          kind: "parametricSurface",
          x: "u", y: "v", z: "u*v",
          u: { min: "-1", max: "1", samples: 256 },
          v: { min: "-1", max: "1", samples: 256 },
        },
        {
          id: "curve",
          kind: "parametricCurve",
          x: "cos(t)", y: "sin(t)", z: "t",
          parameter: "t",
          range: { min: "0", max: "6", samples: 256 },
        },
        {
          id: "revolution",
          kind: "solidOfRevolution",
          axis: "z",
          radius: "1",
          axisRange: { min: "0", max: "1", samples: 256 },
          angleRange: { min: "0", max: "2*pi", samples: 256 },
        },
        {
          id: "ball",
          kind: "primitive",
          primitive: "sphere",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "1", y: "1", z: "1" },
          resolution: 256,
        },
      ],
    });

    const capped = clampGraph3DHeadlessResolution(spec);

    expect(capped.objects[0]).toMatchObject({
      u: { samples: MAX_GRAPH3D_HEADLESS_SAMPLES },
      v: { samples: MAX_GRAPH3D_HEADLESS_SAMPLES },
    });
    expect(capped.objects[1]).toMatchObject({ range: { samples: MAX_GRAPH3D_HEADLESS_SAMPLES } });
    expect(capped.objects[2]).toMatchObject({
      axisRange: { samples: MAX_GRAPH3D_HEADLESS_SAMPLES },
      angleRange: { samples: MAX_GRAPH3D_HEADLESS_SAMPLES },
    });
    expect(capped.objects[3]).toMatchObject({ resolution: MAX_GRAPH3D_HEADLESS_RESOLUTION });
    // authored spec は書き換えない。
    expect(spec.objects[3]).toMatchObject({ resolution: 256 });
  });

  it("refuses to start sampling a figure whose density budget is already blown", () => {
    const bomb = blankWith({
      objects: Array.from({ length: 64 }, (_, index) => ({
        id: `solid_${index}`,
        kind: "boundedSolid" as const,
        inequalities: ["x^2 + y^2 + z^2 <= 1"],
        bounds: {
          x: { min: "-1", max: "1" },
          y: { min: "-1", max: "1" },
          z: { min: "-1", max: "1" },
        },
        resolution: 256,
      })),
    });

    const startedAt = Date.now();
    const result = createGraph3DSceneSvg(bomb, SIZE);

    expect(result).not.toBeNull();
    expect(result!.truncated).toBe(true);
    expect(result!.svg).toBeNull();
    // 判定はサンプリングの前なので、返るまでにメッシュを1つも作っていない。
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it("charges a primitive what it actually samples, not the ceiling", () => {
    // 解像度を書かない直方体・球を並べても、素直な図が予算で弾かれてはいけない。
    const boxes = blankWith({
      objects: Array.from({ length: 16 }, (_, index) => ({
        id: `box_${index}`,
        kind: "primitive" as const,
        primitive: "box" as const,
        center: { x: `${index}`, y: "0", z: "0" },
        size: { x: "1", y: "1", z: "1" },
      })),
    });
    const spheres = blankWith({
      objects: Array.from({ length: 16 }, (_, index) => ({
        id: `sphere_${index}`,
        kind: "primitive" as const,
        primitive: "sphere" as const,
        center: { x: `${index}`, y: "0", z: "0" },
        size: { x: "1", y: "1", z: "1" },
      })),
    });

    expect(createGraph3DSceneSvg(boxes, SIZE)!.svg).not.toBeNull();
    expect(createGraph3DSceneSvg(spheres, SIZE)!.svg).not.toBeNull();
  });

  it("cuts a long grid line into pieces so a solid can pass in front of it", () => {
    const withGrid = createGraph3DSceneSvg(
      blankWith({ view: { ...preset("blank").view, showAxes: false } }),
      SIZE,
    )!.svg!;

    // 11+11 本のグリッド線が、線分ごとに1本の <path> なら 22 個で終わる。
    const gridPaths = [...withGrid.matchAll(/stroke="#(?:8895a1|d8dde2)"/g)].length;
    expect(gridPaths).toBeGreaterThan(22);
  });

  it("keeps one dash pattern running across the pieces a cut line is drawn in", () => {
    const svg = createGraph3DSceneSvg(
      blankWith({ view: { ...preset("blank").view, showGrid: false, axisLineStyle: "dotted" } }),
      SIZE,
    )!.svg!;

    const dashed = [...svg.matchAll(/<path [^>]*stroke-dasharray="[^"]+"[^>]*\/>/g)].map((match) => match[0]);
    expect(dashed.length).toBeGreaterThan(3);
    // 軸は前後関係のために分割して塗るが、模様は1本の線として続かないといけない。
    // 分割ごとに位相が戻ると、継ぎ目のたびに点が二重に落ちる (three側は1本で描く)。
    expect(dashed.filter((path) => path.includes("stroke-dashoffset=")).length).toBeGreaterThan(0);
  });

  it("falls back for a hex colour that is not a real CSS length", () => {
    const svg = createGraph3DSceneSvg(
      blankWith({ view: { ...preset("blank").view, backgroundColor: "#12345" } }),
      SIZE,
    )!.svg!;

    expect(svg).toContain(`<rect width="100%" height="100%" fill="#ffffff"/>`);
    expect(svg).not.toContain("#12345");
  });

  it("refuses a non-positive canvas", () => {
    expect(createGraph3DSceneSvg(preset("blank"), { width: 0, height: 280 })).toBeNull();
    expect(createGraph3DSceneSvg(preset("blank"), { width: 360, height: Number.NaN })).toBeNull();
  });

  it("keeps the authored spec untouched while rendering", () => {
    const spec = preset("revolution");
    const before = JSON.stringify(spec);

    createGraph3DSceneSvg(spec, SIZE);

    expect(JSON.stringify(spec)).toBe(before);
  });
});
