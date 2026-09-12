import { describe, expect, it } from "vitest";

import type { Graph3DSpec } from "@/features/document";

import { createGraph3DIntersectionSvg } from "./graph3d-intersection-svg";

function specWith(objects: Graph3DSpec["objects"], regions: Graph3DSpec["regions"]): Graph3DSpec {
  return {
    version: 1,
    parameters: [],
    objects,
    cuts: [],
    regions,
    annotations: [],
    camera: {
      projection: "perspective",
      position: { x: 4, y: -4, z: 3 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: 0, y: 0, z: 1 },
    },
    view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#fff" },
  };
}

const flatSpec = specWith(
  [
    {
      id: "cube",
      kind: "primitive",
      primitive: "box",
      center: { x: "0", y: "0", z: "0" },
      size: { x: "2", y: "2", z: "2" },
    },
    { id: "lid", kind: "plane", plane: { kind: "equation", expression: "z = 0" } },
  ],
  [{
    id: "region",
    kind: "objectIntersection",
    label: '共通部分 <A> "test"',
    objectIds: ["cube", "lid"],
    fill: { mode: "pattern", color: "#d97706", pattern: "diagonal" },
  }],
);

describe("共通部分のSVG書き出し", () => {
  it("平面になった共通部分を、穴込みの1つのパスとして書き出す", () => {
    const result = createGraph3DIntersectionSvg(flatSpec, "region");
    expect(result?.svg).toContain('fill-rule="evenodd"');
    expect(result?.svg).toContain('aria-label="共通部分 &lt;A&gt; &quot;test&quot;"');
    expect(result?.svg).toContain("url(#intersection-hatch)");
    expect(result?.dataUrl).toMatch(/^data:image\/svg\+xml/);
  });

  it("図形の縦横比をそのまま保つ", () => {
    const result = createGraph3DIntersectionSvg(flatSpec, "region", { width: 200, padding: 20 });
    // 立方体を z=0 で共有した面は正方形。枠も正方形になる。
    expect(result?.width).toBe(200);
    expect(result?.height).toBe(200);
  });

  it("平面になっていない共通部分は書き出さない", () => {
    const solidSpec = specWith(
      [
        {
          id: "a",
          kind: "primitive",
          primitive: "box",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "2", y: "2", z: "2" },
        },
        {
          id: "b",
          kind: "primitive",
          primitive: "box",
          center: { x: "1", y: "1", z: "1" },
          size: { x: "2", y: "2", z: "2" },
        },
      ],
      [{
        id: "region",
        kind: "objectIntersection",
        objectIds: ["a", "b"],
        fill: { mode: "solid", color: "#d97706" },
      }],
    );
    expect(createGraph3DIntersectionSvg(solidSpec, "region")).toBeNull();
  });

  it("知らない共通部分を指定されたら書き出さない", () => {
    expect(createGraph3DIntersectionSvg(flatSpec, "missing")).toBeNull();
  });

  it("3Dの中で非表示にしている共通部分でも、平面図としては書き出せる", () => {
    const hidden: Graph3DSpec = {
      ...flatSpec,
      regions: [{ ...flatSpec.regions[0], visible: false } as Graph3DSpec["regions"][number]],
    };
    expect(createGraph3DIntersectionSvg(hidden, "region")?.svg).toContain("<svg");
  });
});
