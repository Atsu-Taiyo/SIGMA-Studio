import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import { createThreeGraph3DCamera } from "./graph3d-three";
import { createGraph3DProjector } from "@/features/rendering/core";
import type { Graph3DCamera } from "@/features/document";

const WIDTH = 360;
const HEIGHT = 280;
const ASPECT = WIDTH / HEIGHT;

const CAMERAS: Array<[string, Graph3DCamera]> = [
  ["perspective (authored fov)", {
    projection: "perspective",
    position: { x: 5.5, y: -6.5, z: 4.5 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fov: 42,
  }],
  ["perspective (default fov)", {
    projection: "perspective",
    position: { x: 4, y: -4, z: 3 },
    target: { x: 0.5, y: 0, z: 0.5 },
    up: { x: 0, y: 0, z: 1 },
  }],
  ["orthographic", {
    projection: "orthographic",
    position: { x: 4, y: -4, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    zoom: 1.5,
  }],
];

const POINTS = [
  { x: 0, y: 0, z: 0 },
  { x: 1, y: 0, z: 0 },
  { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: 1 },
  { x: -2.5, y: 3.25, z: -1.75 },
];

/**
 * The live 3D view and the headless picture have to frame a figure identically, or a TeX label
 * drawn by the overlay layer drifts off the vertex it names. Both sides read the view box, near
 * plane and default field of view from the rendering core; this is what proves they still agree.
 */
describe("createThreeGraph3DCamera", () => {
  it.each(CAMERAS)("frames a %s camera exactly like the headless projector", (_name, camera) => {
    const threeCamera = createThreeGraph3DCamera(camera, ASPECT);
    threeCamera.updateMatrixWorld(true);
    const projector = createGraph3DProjector(camera, WIDTH, HEIGHT);

    for (const point of POINTS) {
      const ndc = new Vector3(point.x, point.y, point.z).project(threeCamera);
      const projected = projector.project(point);

      expect(projected).not.toBeNull();
      expect(projected!.x).toBeCloseTo((ndc.x * 0.5 + 0.5) * WIDTH, 6);
      expect(projected!.y).toBeCloseTo((-ndc.y * 0.5 + 0.5) * HEIGHT, 6);
    }
  });
});
