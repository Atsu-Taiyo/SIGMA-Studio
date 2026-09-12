import { describe, expect, it } from "vitest";

import {
  addGraph3DLocalAxisRotation,
  applyGraph3DMeshTransform,
  graph3DPointerRotationStep,
  rotateGraph3DEuler,
  snapGraph3DRotationAngle,
} from "./graph3d-transform";

describe("立体の局所軸回転", () => {
  it("ドラッグを続ける限り、半回転を越えて回り続ける", () => {
    // 掴んだ点が1ラジアンあたり100px動く見え方で、10pxずつ40回引く。
    let angle = 0;
    for (let index = 0; index < 40; index += 1) {
      angle += graph3DPointerRotationStep({ x: 10, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 });
    }
    expect(angle).toBeCloseTo(4, 6);
    expect(angle).toBeGreaterThan(Math.PI);
  });

  it("掴んだ点が動く向きへ引けば正、逆へ引けば負に回る", () => {
    const widest = { x: -40, y: -30 };
    const forward = graph3DPointerRotationStep({ x: 6, y: -8 }, { x: 30, y: -40 }, widest);
    expect(forward).toBeCloseTo(10 / 50, 6);
    expect(graph3DPointerRotationStep({ x: -6, y: 8 }, { x: 30, y: -40 }, widest)).toBeCloseTo(-forward, 6);
    expect(graph3DPointerRotationStep({ x: 8, y: 6 }, { x: 30, y: -40 }, widest)).toBeCloseTo(0, 6);
  });

  it("軸を真横から見ていても、1pxあたりの回転量が発散しない", () => {
    // 90度先では50px/radなので、下限は15px/rad。2px/radの見え方でもそこで頭打ちになる。
    expect(graph3DPointerRotationStep({ x: 40, y: 0 }, { x: 2, y: 0 }, { x: 0, y: 50 })).toBeCloseTo(40 / 15, 6);
    expect(graph3DPointerRotationStep({ x: 40, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 50 })).toBe(0);
  });

  it("下限は画面上の見かけの大きさに対して決まる", () => {
    // 十分に見えている向きでは下限は効かず、掴んだ点がカーソルに追従する。
    expect(graph3DPointerRotationStep({ x: 20, y: 0 }, { x: 20, y: 0 }, { x: 0, y: 30 })).toBeCloseTo(1, 6);
  });

  it("すでに傾いた立体でも、表示中の自分の軸のまわりに回る", () => {
    const start = { x: 0.4, y: -0.3, z: 0.8 };
    const next = addGraph3DLocalAxisRotation(start, "z", Math.PI / 2);
    const localZ = rotateGraph3DEuler({ x: 0, y: 0, z: 1 }, start);
    const expected = rotateGraph3DEuler({ x: 0, y: 1, z: 0 }, start);
    expect(rotateGraph3DEuler({ x: 0, y: 0, z: 1 }, next).x).toBeCloseTo(localZ.x, 6);
    expect(rotateGraph3DEuler({ x: 0, y: 0, z: 1 }, next).y).toBeCloseTo(localZ.y, 6);
    expect(rotateGraph3DEuler({ x: 0, y: 0, z: 1 }, next).z).toBeCloseTo(localZ.z, 6);
    expect(rotateGraph3DEuler({ x: 1, y: 0, z: 0 }, next).x).toBeCloseTo(expected.x, 5);
    expect(rotateGraph3DEuler({ x: 1, y: 0, z: 0 }, next).y).toBeCloseTo(expected.y, 5);
    expect(rotateGraph3DEuler({ x: 1, y: 0, z: 0 }, next).z).toBeCloseTo(expected.z, 5);
  });

  it("Shiftを押している間は最寄りの15度へ揃える", () => {
    expect(snapGraph3DRotationAngle(22 * Math.PI / 180, true)).toBeCloseTo(15 * Math.PI / 180);
    expect(snapGraph3DRotationAngle(23 * Math.PI / 180, true)).toBeCloseTo(30 * Math.PI / 180);
    expect(snapGraph3DRotationAngle(23 * Math.PI / 180, false)).toBeCloseTo(23 * Math.PI / 180);
  });

  it("式を書き換えずに、局所軸の倍率とワールド座標の移動を頂点へ適用する", () => {
    const geometry = {
      positions: [{ x: 2, y: 1, z: 1 }],
      triangles: [],
      lineSegments: [],
    };
    const transformed = applyGraph3DMeshTransform(
      geometry,
      { x: 0, y: 0, z: Math.PI / 2 },
      { x: 3, y: 1, z: 1 },
      { x: 4, y: -2, z: 0 },
      { x: 1, y: 1, z: 1 },
    );
    expect(transformed.positions[0]).toEqual({ x: 5, y: 2, z: 1 });
  });
});
