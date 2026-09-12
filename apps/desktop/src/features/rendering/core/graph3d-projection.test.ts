import { describe, expect, it } from "vitest";

import { createGraph3DProjector } from "./graph3d-projection";
import { projectGraph3DLabel } from "./graph3d-labels";
import type { Graph3DCamera } from "@/features/document";

const PERSPECTIVE: Graph3DCamera = {
  projection: "perspective",
  position: { x: 5.5, y: -6.5, z: 4.5 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fov: 42,
};
const ORTHOGRAPHIC: Graph3DCamera = {
  projection: "orthographic",
  position: { x: 4, y: -4, z: 3 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  zoom: 1.5,
};

const SAMPLE_POINTS = [
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: -2.5, y: 3.25, z: -1.75 },
  { x: 3.3, y: 0, z: 0 },
];

describe("createGraph3DProjector", () => {
  it.each([["perspective", PERSPECTIVE], ["orthographic", ORTHOGRAPHIC]] as const)(
    "agrees with projectGraph3DLabel for a %s camera",
    (_name, camera) => {
      const projector = createGraph3DProjector(camera, 360, 280);
      for (const point of SAMPLE_POINTS) {
        const projected = projector.project(point);
        const label = projectGraph3DLabel(point, camera, 360, 280);
        expect(projected === null).toBe(label === null);
        if (projected && label) {
          expect(projected.x).toBeCloseTo(label.x, 10);
          expect(projected.y).toBeCloseTo(label.y, 10);
        }
      }
    },
  );

  it("reports depth growing away from the camera", () => {
    const projector = createGraph3DProjector(PERSPECTIVE, 360, 280);
    const near = projector.project({ x: 2.75, y: -3.25, z: 2.25 });
    const origin = projector.project({ x: 0, y: 0, z: 0 });
    const far = projector.project({ x: -2.75, y: 3.25, z: -2.25 });

    expect(near!.depth).toBeLessThan(origin!.depth);
    expect(origin!.depth).toBeLessThan(far!.depth);
  });

  it("drops points at or behind the near plane", () => {
    const projector = createGraph3DProjector(PERSPECTIVE, 360, 280);
    expect(projector.project({ x: 5.5, y: -6.5, z: 4.5 })).toBeNull();
    expect(projector.project({ x: 11, y: -13, z: 9 })).toBeNull();
  });

  it("keeps the authored view box while the viewport shape changes", () => {
    const wide = createGraph3DProjector(PERSPECTIVE, 720, 280).project({ x: 0, y: 0, z: 1 });
    const narrow = createGraph3DProjector(PERSPECTIVE, 280, 280).project({ x: 0, y: 0, z: 1 });

    // 縦の 6 単位ビューボックスは共通なので、高さが同じなら y は変わらない。
    expect(wide!.y).toBeCloseTo(narrow!.y, 10);
  });

  it("returns null from every projection when the camera basis is degenerate", () => {
    const degenerate = createGraph3DProjector({
      ...PERSPECTIVE,
      target: { ...PERSPECTIVE.position },
    }, 360, 280);

    expect(degenerate.project({ x: 0, y: 0, z: 0 })).toBeNull();
  });

  it("still draws a plain top view, where the up axis and the view direction are parallel", () => {
    // 真上から見下ろす視点は three.js では普通に描ける (`Matrix4.lookAt` が視線を微小にずらす)。
    // ここで諦めると、ヘッドレス側だけが真っ白なPNGを「最新」として文書へ焼き込む。
    const topView = createGraph3DProjector({
      projection: "perspective",
      position: { x: 0, y: 0, z: 10 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 42,
    }, 360, 280);

    const center = topView.project({ x: 0, y: 0, z: 0 });
    const offset = topView.project({ x: 1, y: 0, z: 0 });

    expect(center).not.toBeNull();
    expect(offset).not.toBeNull();
    // どの向きに写るかは three 側のnudgeと同じ約束に従う。ここで見たいのは
    // 「別の点が別の画素に写る」= 図がつぶれていないこと。
    expect(Math.hypot(offset!.x - center!.x, offset!.y - center!.y)).toBeGreaterThan(1);
    expect(projectGraph3DLabel({ x: 1, y: 0, z: 0 }, {
      projection: "perspective",
      position: { x: 0, y: 0, z: 10 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 42,
    }, 360, 280)).not.toBeNull();
  });

  it("zooms an orthographic camera", () => {
    const near = createGraph3DProjector({ ...ORTHOGRAPHIC, zoom: 3 }, 360, 280).project({ x: 0, y: 0, z: 1 });
    const wide = createGraph3DProjector({ ...ORTHOGRAPHIC, zoom: 1 }, 360, 280).project({ x: 0, y: 0, z: 1 });

    expect(Math.abs(near!.y - 140)).toBeGreaterThan(Math.abs(wide!.y - 140));
  });
});
