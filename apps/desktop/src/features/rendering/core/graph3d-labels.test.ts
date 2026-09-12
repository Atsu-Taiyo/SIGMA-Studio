import { describe, expect, it } from "vitest";

import { createGraph3DDisplayAnnotations, projectGraph3DLabel } from "./graph3d-labels";

describe("graph 3D label render model", () => {
  it("keeps TeX annotations and adds the enabled axis labels", () => {
    const annotations = createGraph3DDisplayAnnotations(
      { view: { coordinateSystem: "zUp", showAxes: true, showGrid: false, backgroundColor: "#fff" } },
      [{ id: "radius", kind: "label", position: { x: 0, y: 0, z: 0 }, labelTex: "\\sqrt{3}" }],
      { x: "#f00", y: "#0f0", z: "#00f" },
    );
    expect(annotations.map((annotation) => annotation.labelTex)).toEqual(["\\sqrt{3}", "x", "y", "z"]);
  });

  it("projects the camera target to the viewport centre with z pointing upward", () => {
    const camera = {
      projection: "perspective" as const,
      position: { x: 0, y: -10, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
      fov: 45,
    };
    expect(projectGraph3DLabel({ x: 0, y: 0, z: 0 }, camera, 320, 200)).toEqual({ x: 160, y: 100 });
    expect(projectGraph3DLabel({ x: 1, y: 0, z: 0 }, camera, 320, 200)?.x).toBeGreaterThan(160);
    expect(projectGraph3DLabel({ x: 0, y: 0, z: 1 }, camera, 320, 200)?.y).toBeLessThan(100);
  });
});
