import { describe, expect, it } from "vitest";

import type { Graph3DObject } from "@/features/document";

import {
  buildGraph3DIntersectionGeometry,
  createGraph3DSolidField,
  getGraph3DIntersectionGeometry,
} from "./graph3d-solid";
import { Graph3DModelError } from "./graph3d-errors";

function box(id: string, center: [number, number, number], size: number): Graph3DObject {
  return {
    id,
    kind: "primitive",
    primitive: "box",
    center: { x: `${center[0]}`, y: `${center[1]}`, z: `${center[2]}` },
    size: { x: `${size}`, y: `${size}`, z: `${size}` },
  };
}

function plane(id: string, expression: string): Extract<Graph3DObject, { kind: "plane" }> {
  return { id, kind: "plane", plane: { kind: "equation", expression } };
}

function vector(x: string, y: string, z: string) {
  return { x, y, z };
}

function bounds(points: Array<{ x: number; y: number; z: number }>) {
  const axes = ["x", "y", "z"] as const;
  return Object.fromEntries(axes.map((axis) => [axis, {
    // `+ 0` は -0 を 0 に寄せるため (座標の意味は同じ)。
    min: Math.min(...points.map((point) => point[axis])) + 0,
    max: Math.max(...points.map((point) => point[axis])) + 0,
  }]));
}

describe("立体の共通部分", () => {
  it("半空間だけでできた立体どうしは、標本化せずそのままの形で交わる", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("a", [0, 0, 0], 2), box("b", [1, 1, 1], 2)],
      {},
    );
    expect(result.kind).toBe("solid");
    if (result.kind !== "solid") return;
    // 交わりは [0,1]^3。標本化した曲面ではなく、8頂点の直方体そのものになる。
    expect(result.geometry.positions).toHaveLength(8);
    expect(bounds(result.geometry.positions)).toEqual({
      x: { min: 0, max: 1 },
      y: { min: 0, max: 1 },
      z: { min: 0, max: 1 },
    });
  });

  it("不等式で囲んだ立体と直方体の共通部分も面で表せる", () => {
    const tetrahedron: Graph3DObject = {
      id: "tetra",
      kind: "boundedSolid",
      inequalities: ["x >= 0", "y >= 0", "z >= 0", "x+y+z <= 3"],
      bounds: {
        x: { min: "-1", max: "4" },
        y: { min: "-1", max: "4" },
        z: { min: "-1", max: "4" },
      },
    };
    const result = buildGraph3DIntersectionGeometry([tetrahedron, box("cube", [1, 1, 1], 2)], {});
    expect(result.kind).toBe("solid");
    if (result.kind !== "solid") return;
    for (const point of result.geometry.positions) {
      expect(point.x).toBeGreaterThanOrEqual(-1e-6);
      expect(point.x).toBeLessThanOrEqual(2 + 1e-6);
      expect(point.x + point.y + point.z).toBeLessThanOrEqual(3 + 1e-6);
    }
  });

  it("半空間だけでできた立体どうしには継ぎ目を付けない (面がそのまま出ている)", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("a", [0, 0, 0], 2), box("b", [1, 1, 1], 2)],
      {},
    );
    expect(result.kind).toBe("solid");
    if (result.kind !== "solid") return;
    expect(result.seams).toBeUndefined();
  });

  it("標本化した共通部分は、面が入れ替わる線だけを継ぎ目として返す", () => {
    // 半径1.2の球は一辺2の立方体の角 (原点から √3) を削り、面 (原点から1) は残す。
    // 継ぎ目は6つの面それぞれに現れる半径 √(1.2^2-1)=0.663 の円になる。
    const result = buildGraph3DIntersectionGeometry(
      [box("cube", [0, 0, 0], 2), {
        id: "ball",
        kind: "primitive",
        primitive: "sphere",
        center: vector("0", "0", "0"),
        size: vector("2.4", "2.4", "2.4"),
      }],
      {},
      { resolution: 40 },
    );
    expect(result.kind).toBe("solid");
    if (result.kind !== "solid" || !result.seams) throw new Error("継ぎ目がありません");

    // 三角形の稜線をすべて引くと数千本になる。継ぎ目はそのごく一部でしかない。
    expect(result.seams.length).toBeLessThan(result.geometry.triangles.length / 4);

    for (const [from, to] of result.seams) {
      for (const point of [from, to]) {
        const onFace = Math.max(Math.abs(point.x), Math.abs(point.y), Math.abs(point.z));
        const radius = Math.hypot(point.x, point.y, point.z);
        expect(onFace).toBeCloseTo(1, 1);
        expect(radius).toBeCloseTo(1.2, 1);
      }
    }

    const total = result.seams.reduce(
      (sum, [from, to]) => sum + Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z),
      0,
    );
    // 6面 × 2π × 0.663 ≒ 25.0。ぎざぎざを均す処理が線をつぶしていないことも、ここで分かる。
    expect(total).toBeGreaterThan(25 * 0.85);
    expect(total).toBeLessThan(25 * 1.15);
  });

  it("曲面を持つ立体が混ざるときは格子で標本化する", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("cube", [0, 0, 0], 2), {
        id: "ball",
        kind: "primitive",
        primitive: "sphere",
        center: { x: "0.5", y: "0", z: "0" },
        size: { x: "1", y: "1", z: "1" },
      }],
      {},
      { resolution: 24 },
    );
    expect(result.kind).toBe("solid");
    if (result.kind !== "solid") return;
    expect(result.geometry.triangles.length).toBeGreaterThan(0);
    for (const point of result.geometry.positions) {
      // 球 (中心 0.5、半径 0.5) の外へはみ出さない。格子1目盛りぶんの誤差は許す。
      expect(Math.hypot(point.x - 0.5, point.y, point.z)).toBeLessThan(0.62);
    }
  });

  it("重なっていない立体は空を返す", () => {
    expect(buildGraph3DIntersectionGeometry(
      [box("a", [0, 0, 0], 2), box("b", [9, 9, 9], 2)],
      {},
    ).kind).toBe("empty");
  });

  it("平面を混ぜると、共有する面を返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("cube", [0, 0, 0], 2), {
        id: "lid",
        kind: "plane",
        plane: { kind: "equation", expression: "z = 0.5" },
      }],
      {},
    );
    expect(result.kind).toBe("section");
    if (result.kind !== "section") return;
    expect(result.section.loops).toHaveLength(1);
    for (const point of result.section.loops[0].points3D) {
      expect(point.z).toBeCloseTo(0.5, 6);
    }
  });

  it("面も中身も持たない要素は理由を添えて断る", () => {
    let modelError: unknown;
    try {
      buildGraph3DIntersectionGeometry(
      [box("cube", [0, 0, 0], 2), {
        id: "curve",
        name: "空間曲線",
        kind: "parametricCurve",
        x: "cos(t)",
        y: "sin(t)",
        z: "t",
        parameter: "t",
        range: { min: "0", max: "1" },
      }],
      {},
      );
    } catch (error) {
      modelError = error;
    }
    expect(modelError).toBeInstanceOf(Graph3DModelError);
    expect((modelError as Graph3DModelError).code).toBe("commonPartObjectHasNoSurfaceOrInterior");
    expect((modelError as Graph3DModelError).params).toEqual({ name: "空間曲線" });
    expect(() => buildGraph3DIntersectionGeometry([box("cube", [0, 0, 0], 2)], {})).toThrow();
  });

  it("パラメータが動くと共通部分も動く", () => {
    const moving: Graph3DObject = {
      id: "moving",
      kind: "primitive",
      primitive: "box",
      center: { x: "s", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    };
    const near = buildGraph3DIntersectionGeometry([box("a", [0, 0, 0], 2), moving], { s: 0.5 });
    const far = buildGraph3DIntersectionGeometry([box("a", [0, 0, 0], 2), moving], { s: 3 });
    expect(near.kind).toBe("solid");
    expect(far.kind).toBe("empty");
  });
});

describe("共通部分のキャッシュ", () => {
  it("式が使っていないパラメータが動いても作り直さない", () => {
    const members = [box("a", [0, 0, 0], 2), box("b", [1, 1, 1], 2)];
    const first = getGraph3DIntersectionGeometry(members, { s: 0 });
    // 立体の式に s は出てこない。スライダーを動かしても形は変わらないので同じ結果を返す。
    expect(getGraph3DIntersectionGeometry(members, { s: 1.5 })).toBe(first);
  });

  it("式が使っているパラメータが動いたら作り直す", () => {
    const members = [box("a", [0, 0, 0], 2), {
      id: "moving",
      kind: "primitive" as const,
      primitive: "box" as const,
      center: { x: "s", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    }];
    const first = getGraph3DIntersectionGeometry(members, { s: 0 });
    expect(getGraph3DIntersectionGeometry(members, { s: 0.5 })).not.toBe(first);
  });
});

describe("立体の内外判定", () => {
  it("不等式を文字列置換せず、逆変換で拡縮と移動を解釈する", () => {
    const field = createGraph3DSolidField({
      id: "transformed-inequalities",
      kind: "boundedSolid",
      inequalities: ["x >= -1", "x <= 1", "y >= -1", "y <= 1", "z >= -1", "z <= 1"],
      bounds: {
        x: { min: "-1", max: "1" },
        y: { min: "-1", max: "1" },
        z: { min: "-1", max: "1" },
      },
      scale: { x: "3", y: "1", z: "1" },
      translation: { x: "1", y: "0", z: "0" },
    }, {});
    expect(field).not.toBeNull();
    if (!field) return;
    expect(field.value({ x: 3.9, y: 0, z: 0 })).toBeLessThanOrEqual(0);
    expect(field.value({ x: 4.2, y: 0, z: 0 })).toBeGreaterThan(0);
  });

  it("回転体は軸からの距離と軸の範囲で決まる", () => {
    const field = createGraph3DSolidField({
      id: "revolution",
      kind: "solidOfRevolution",
      axis: "z",
      radius: "1",
      axisRange: { min: "-1", max: "1" },
    }, {});
    expect(field).not.toBeNull();
    if (!field) return;
    expect(field.value({ x: 0, y: 0, z: 0 })).toBeLessThan(0);
    expect(field.value({ x: 0.9, y: 0, z: 0.5 })).toBeLessThan(0);
    expect(field.value({ x: 1.4, y: 0, z: 0 })).toBeGreaterThan(0);
    expect(field.value({ x: 0, y: 0, z: 2 })).toBeGreaterThan(0);
  });

  it("二次の不等式でも、探索範囲の中で閉じた立体として扱う", () => {
    const field = createGraph3DSolidField({
      id: "parabolic-cylinder",
      kind: "boundedSolid",
      inequalities: ["z >= 0", "x^2 <= y", "x^2 + y^2 <= 4"],
      bounds: {
        x: { min: "-3", max: "3" },
        y: { min: "-3", max: "3" },
        z: { min: "-1", max: "3" },
      },
    }, {});
    expect(field).not.toBeNull();
    if (!field) return;
    expect(field.value({ x: 0, y: 1, z: 0.5 })).toBeLessThan(0);
    expect(field.value({ x: 0, y: -1, z: 0.5 })).toBeGreaterThan(0);
    expect(field.value({ x: 0, y: 1, z: -0.5 })).toBeGreaterThan(0);
    expect(field.value({ x: 0, y: 3, z: 0.5 })).toBeGreaterThan(0);
  });

  it("カンマで並んだ不等式を、別々の壁として読む", () => {
    const field = createGraph3DSolidField({
      id: "listed",
      kind: "boundedSolid",
      inequalities: ["z >= 0, x^2 <= y, x^2+y^2 <= 4"],
      bounds: {
        x: { min: "-3", max: "3" },
        y: { min: "-3", max: "3" },
        z: { min: "-1", max: "3" },
      },
    }, {});
    expect(field).not.toBeNull();
    if (!field) return;
    expect(field.value({ x: 0, y: 1, z: 0.4 })).toBeLessThan(0);
  });

  it("閉じた媒介変数曲面は、中身のある立体として共通部分に使える", () => {
    const torus = createGraph3DSolidField({
      id: "torus",
      kind: "parametricSurface",
      x: "(2 + cos(v))*cos(u)",
      y: "(2 + cos(v))*sin(u)",
      z: "sin(v)",
      u: { min: "0", max: "2*pi", samples: 24 },
      v: { min: "0", max: "2*pi", samples: 16 },
    }, {});
    expect(torus).not.toBeNull();
    if (!torus) return;
    expect(torus.value({ x: 2, y: 0, z: 0 })).toBeLessThan(0);
    expect(torus.value({ x: 0, y: 0, z: 0 })).toBeGreaterThan(0);
    expect(torus.value({ x: 6, y: 0, z: 0 })).toBeGreaterThan(0);
  });

  it("非表示の立体でも共通部分の判定には残る", () => {
    const hidden = {
      ...box("hidden", [0.5, 0.5, 0.5], 2),
      visible: false,
    };
    const result = buildGraph3DIntersectionGeometry([box("shown", [0, 0, 0], 2), hidden], {});
    expect(result.kind).toBe("solid");
  });

  it("曲線・点・平面は中身を持たない", () => {
    expect(createGraph3DSolidField({
      id: "point",
      kind: "point",
      position: { x: "0", y: "0", z: "0" },
    }, {})).toBeNull();
    expect(createGraph3DSolidField({
      id: "plane",
      kind: "plane",
      plane: { kind: "equation", expression: "z = 0" },
    }, {})).toBeNull();
  });
});

describe("平面どうしの共通部分", () => {
  it("交わる2平面は交線を返す", () => {
    const result = buildGraph3DIntersectionGeometry([plane("a", "z = 0"), plane("b", "x = 0")], {});
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    // 2平面 z=0 と x=0 の共通部分は y 軸。描いてある範囲の中で線分1本になる。
    expect(result.segments).toHaveLength(1);
    for (const point of result.segments[0]) {
      expect(point.x).toBeCloseTo(0, 6);
      expect(point.z).toBeCloseTo(0, 6);
    }
    const [from, to] = result.segments[0];
    expect(Math.abs(to.y - from.y)).toBeGreaterThan(1);
  });

  it("交わる3平面は1点を返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [plane("a", "z = 0"), plane("b", "x = 0"), plane("c", "y = 1")],
      {},
    );
    expect(result.kind).toBe("points");
    if (result.kind !== "points") return;
    expect(result.points).toHaveLength(1);
    expect(result.points[0].x).toBeCloseTo(0, 6);
    expect(result.points[0].y).toBeCloseTo(1, 6);
    expect(result.points[0].z).toBeCloseTo(0, 6);
  });

  it("平行で重ならない平面には共有点がない", () => {
    expect(buildGraph3DIntersectionGeometry(
      [plane("a", "z = 0"), plane("b", "z = 1")],
      {},
    ).kind).toBe("empty");
  });

  it("同じ平面を2枚重ねたら、描いてある四角形の重なりを返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [plane("a", "z = 0"), { ...plane("b", "z = 0"), size: vector("2", "2", "0") }],
      {},
    );
    expect(result.kind).toBe("section");
    if (result.kind !== "section") return;
    expect(result.section.loops).toHaveLength(1);
    // 小さいほうの四角形 (2×2) が答え。大きいほうにはみ出さない。
    for (const point of result.section.loops[0].points3D) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(1 + 1e-6);
      expect(point.z).toBeCloseTo(0, 6);
    }
  });

  it("2平面の交線は、立体と共有する部分だけに切り詰められる", () => {
    const result = buildGraph3DIntersectionGeometry(
      [plane("a", "z = 0"), plane("b", "x = 0"), box("cube", [0, 0, 0], 2)],
      {},
    );
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    const ys = result.segments.flat().map((point) => point.y);
    expect(Math.min(...ys)).toBeCloseTo(-1, 3);
    expect(Math.max(...ys)).toBeCloseTo(1, 3);
  });

  it("交点が立体の外にあるなら共有点はない", () => {
    expect(buildGraph3DIntersectionGeometry(
      [plane("a", "z = 0"), plane("b", "x = 0"), plane("c", "y = 9"), box("cube", [0, 0, 0], 2)],
      {},
    ).kind).toBe("empty");
  });
});

describe("外側だけの共通部分", () => {
  it("中身を持たない曲面は、立体と共有する面と輪郭を返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("cube", [0, 0, 0], 2), {
        id: "sheet",
        name: "曲面",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "0",
        u: { min: "-3", max: "3", samples: 12 },
        v: { min: "-3", max: "3", samples: 12 },
      }],
      {},
    );
    expect(result.kind).toBe("surface");
    if (result.kind !== "surface") return;
    // 立方体の中にある部分だけが残る。曲面全体 (6×6) は残らない。
    for (const point of result.geometry.positions) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1 + 1e-6);
      expect(Math.abs(point.y)).toBeLessThanOrEqual(1 + 1e-6);
    }
    expect(result.contour.length).toBeGreaterThan(0);
  });

  it("曲面と平面が交わるところは輪郭の線になる", () => {
    const result = buildGraph3DIntersectionGeometry(
      [{
        id: "bowl",
        name: "曲面",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "u^2 + v^2",
        u: { min: "-2", max: "2", samples: 24 },
        v: { min: "-2", max: "2", samples: 24 },
      }, plane("lid", "z = 1")],
      {},
    );
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    expect(result.segments.length).toBeGreaterThan(8);
    // z = x^2 + y^2 と z = 1 の交わりは単位円。
    for (const point of result.segments.flat()) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 1);
      expect(point.z).toBeCloseTo(1, 6);
    }
  });

  it("曲面どうしが交わる線も輪郭で返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [{
        id: "bowl",
        name: "曲面",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "u^2 + v^2",
        u: { min: "-2", max: "2", samples: 24 },
        v: { min: "-2", max: "2", samples: 24 },
      }, {
        id: "roof",
        name: "曲面2",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "2 - u^2 - v^2",
        u: { min: "-2", max: "2", samples: 24 },
        v: { min: "-2", max: "2", samples: 24 },
      }],
      {},
    );
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    // x^2+y^2 = 2-x^2-y^2 は x^2+y^2 = 1、つまり z = 1 の単位円。
    for (const point of result.segments.flat()) {
      expect(Math.hypot(point.x, point.y)).toBeCloseTo(1, 1);
      expect(point.z).toBeCloseTo(1, 1);
    }
  });

  it("曲面の書かれていないところまで輪郭を伸ばさない", () => {
    const result = buildGraph3DIntersectionGeometry(
      [{
        id: "wide",
        name: "広い曲面",
        kind: "parametricSurface",
        x: "u",
        y: "v",
        z: "0",
        u: { min: "-4", max: "4", samples: 24 },
        v: { min: "-4", max: "4", samples: 24 },
      }, {
        id: "narrow",
        name: "狭い曲面",
        kind: "parametricSurface",
        // 交わりは y = 0 の直線だが、狭いほうは |x| <= 1 にしか描かれていない。
        x: "u",
        y: "v",
        z: "v",
        u: { min: "-1", max: "1", samples: 12 },
        v: { min: "-4", max: "4", samples: 24 },
      }],
      {},
    );
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    for (const point of result.segments.flat()) {
      expect(Math.abs(point.x)).toBeLessThanOrEqual(1 + 1e-6);
      expect(point.y).toBeCloseTo(0, 6);
    }
  });

  it("外側で触れているだけの立体どうしは、触れている輪郭を返す", () => {
    const result = buildGraph3DIntersectionGeometry(
      [box("lower", [0, 0, 0], 2), box("upper", [0, 0, 2], 2)],
      {},
    );
    // 体積の共通部分はないが、面どうしは z = 1 で接している。
    expect(result.kind).toBe("curve");
    if (result.kind !== "curve") return;
    for (const point of result.segments.flat()) {
      expect(point.z).toBeCloseTo(1, 6);
    }
  });
});
