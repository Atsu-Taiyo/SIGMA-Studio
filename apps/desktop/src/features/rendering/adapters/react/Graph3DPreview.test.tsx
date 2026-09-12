import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OrthographicCamera, PerspectiveCamera } from "three";

import type { Graph3DSpec } from "@/features/document";

import { createThreeGraph3DCamera } from "../three";

import {
  graph3DCaptureSupersample,
  graph3DDisplayPixelRatio,
  Graph3DPreview,
  Graph3DStaticLabelOverlay,
} from "./Graph3DPreview";

const spec: Graph3DSpec = {
  version: 1,
  parameters: [],
  objects: [{
    id: "surface",
    kind: "parametricSurface",
    x: "u",
    y: "v",
    z: "u^2 + v^2",
    u: { min: "-1", max: "1", samples: 4 },
    v: { min: "-1", max: "1", samples: 4 },
  }],
  cuts: [],
  regions: [],
  annotations: [{
    id: "radius",
    kind: "label",
    position: { x: "1", y: "0", z: "0" },
    labelTex: "\\sqrt{3}",
  }],
  camera: {
    projection: "perspective",
    position: { x: 4, y: -5, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#fff" },
};

describe("Graph3DPreview rendering adapter", () => {
  it("keeps unselected labels in the TeX rendering layer", () => {
    const html = renderToStaticMarkup(<Graph3DStaticLabelOverlay spec={spec} width={320} height={220} />);
    expect(html).toContain('data-graph3d-static-label-overlay="true"');
    expect(html).toContain('data-graph3d-annotation-id="radius"');
    expect(html).toContain("math-preview");
    expect(html).toContain("ML__sqrt-sign");
  });

  it("renders an accessible live 3D viewport shell with camera gestures", () => {
    const html = renderToStaticMarkup(<Graph3DPreview spec={spec} interactive />);
    expect(html).toContain('data-testid="graph3d-preview"');
    expect(html).toContain("円弧で回転、軸線のどこを掴んでも移動、軸端の◆で拡大縮小");
    expect(html).toContain("立体をクリック: 操作軸");
    expect(html).toContain("円弧: 回転（Shiftで15°）");
    expect(html).toContain('data-graph3d-annotation-overlay="true"');
    expect(html).toContain('data-graph3d-annotation-id="radius"');
    expect(html).toContain('data-graph3d-annotation-id="axis-x"');
    expect(html).toContain('data-graph3d-annotation-id="axis-y"');
    expect(html).toContain('data-graph3d-annotation-id="axis-z"');
  });

  it("uses the frame as a window without stretching world-space proportions", () => {
    const widePerspective = createThreeGraph3DCamera(spec.camera, 2);
    expect(widePerspective).toBeInstanceOf(PerspectiveCamera);
    expect((widePerspective as PerspectiveCamera).aspect).toBe(2);

    const orthographicSpec = { ...spec.camera, projection: "orthographic" as const };
    const wideOrthographic = createThreeGraph3DCamera(orthographicSpec, 2) as OrthographicCamera;
    const tallOrthographic = createThreeGraph3DCamera(orthographicSpec, 0.5) as OrthographicCamera;
    expect((wideOrthographic.right - wideOrthographic.left) / (wideOrthographic.top - wideOrthographic.bottom)).toBe(2);
    expect((tallOrthographic.right - tallOrthographic.left) / (tallOrthographic.top - tallOrthographic.bottom)).toBe(0.5);
  });

  it("raises the drawing buffer with the painted scale so a zoomed 3D object stays sharp", () => {
    // Zoom scales the shape with a transform, so the canvas keeps its layout size and only the
    // painted scale moves. A ratio of 1 there would resample the buffer up.
    expect(graph3DDisplayPixelRatio(1, 1)).toBe(2);
    expect(graph3DDisplayPixelRatio(1, 3)).toBe(3);
    expect(graph3DDisplayPixelRatio(2, 1.5)).toBe(3);
    expect(graph3DDisplayPixelRatio(2, 4)).toBe(4);
    expect(graph3DDisplayPixelRatio(Number.NaN, 1)).toBe(2);
  });

  it("supersamples the stored PNG above the shape's document size, within a pixel budget", () => {
    expect(graph3DCaptureSupersample(360, 260)).toBe(3);
    const large = graph3DCaptureSupersample(1600, 1200);
    expect(large).toBeLessThan(3);
    expect(1600 * large * 1200 * large).toBeLessThanOrEqual(6_000_000 + 1);
    expect(graph3DCaptureSupersample(0, 0)).toBe(3);
  });

  it("surfaces expression diagnostics while preserving the authored spec", () => {
    const invalidSurface = {
      id: "surface",
      kind: "parametricSurface" as const,
      x: "u",
      y: "v",
      z: "sin(",
      u: { min: "-1", max: "1", samples: 4 },
      v: { min: "-1", max: "1", samples: 4 },
    };
    const invalidSpec: Graph3DSpec = {
      ...spec,
      objects: [invalidSurface],
    };
    const html = renderToStaticMarkup(<Graph3DPreview spec={invalidSpec} interactive={false} />);
    expect(html).toContain('role="status"');
    expect(html).toContain("surface");
    expect(html).not.toContain("ドラッグ: 回転");
  });
});
