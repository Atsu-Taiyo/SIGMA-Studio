import { describe, expect, it } from "vitest";
import { Group, LineBasicMaterial, LineDashedMaterial, LineLoop, LineSegments, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D } from "three";

import { DEFAULT_GRAPH3D_AXIS_COLORS, type Graph3DSpec } from "@/features/document";
import { buildGraph3DSceneGeometry } from "@/features/drawing";

import {
  createThreeGraph3DAxes,
  createThreeGraph3DGroup,
  createThreeGraph3DObjectGizmo,
  createThreeGraph3DSectionFillGeometry,
  disposeThreeGraph3DGroup,
  updateThreeGraph3DGroup,
} from "./graph3d-three";

const spec: Graph3DSpec = {
  version: 1,
  parameters: [],
  objects: [{
    id: "cube",
    kind: "primitive",
    primitive: "box",
    center: { x: "0", y: "0", z: "0" },
    size: { x: "2", y: "2", z: "2" },
    style: { color: "#334455", opacity: 0.6, wireframe: true },
  }],
  cuts: [{
    id: "cut",
    targetObjectIds: ["cube"],
    plane: { kind: "equation", expression: "z = 0" },
    showPlane: true,
    showContour: true,
    section: {
      showInScene: true,
      lineWidth: 4,
      fill: { mode: "pattern", color: "#d97706", opacity: 0.25, pattern: "cross" },
    },
  }],
  regions: [],
  annotations: [{
    id: "height",
    kind: "dimension",
    from: { x: "1.2", y: "0", z: "-1" },
    to: { x: "1.2", y: "0", z: "1" },
    labelTex: "2",
  }],
  camera: {
    projection: "perspective",
    position: { x: 4, y: -4, z: 3 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
  },
  view: { coordinateSystem: "zUp", showAxes: true, showGrid: true, backgroundColor: "#fff" },
};

describe("three.js graph 3D adapter", () => {
  it("adapts canonical mesh, wireframe, and dimension without drawing authored cuts", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry(spec));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));

    expect(descendants.some((object) => object instanceof Mesh && object.name === "graph3d-object:cube")).toBe(true);
    expect(descendants.some((object) => object instanceof LineSegments && object.name === "graph3d-wireframe:cube")).toBe(true);
    expect(descendants.some((object) => object.name.startsWith("graph3d-cut"))).toBe(false);
    expect(descendants.some((object) => object.name.startsWith("graph3d-section"))).toBe(false);
    const dimension = descendants.find((object) => object.name === "graph3d-dimension:height");
    // 寸法線は太さも矢印も持てるよう実体のあるジオメトリで描く (WebGL の線幅は効かない)。
    expect(dimension).toBeInstanceOf(Group);
    expect(dimension?.children.some((child) => child instanceof Mesh)).toBe(true);
  });

  it("builds pickable local axes for a selected solid", () => {
    const gizmo = createThreeGraph3DObjectGizmo(1.5, DEFAULT_GRAPH3D_AXIS_COLORS);
    expect(gizmo.name).toBe("graph3d-object-gizmo");
    expect(gizmo.getObjectByName("graph3d-object-gizmo-translate:x")?.userData.graph3dOperation).toBe("translate");
    expect(gizmo.getObjectByName("graph3d-object-gizmo-scale:y")?.userData.graph3dOperation).toBe("scale");
    expect(gizmo.getObjectByName("graph3d-object-gizmo-rotate:z")?.userData.graph3dOperation).toBe("rotate");
    expect(gizmo.getObjectByName("graph3d-object-gizmo-rotate-arrow:z")).toBeDefined();
    disposeThreeGraph3DGroup(gizmo);
  });

  it("draws the authored coordinate-axis line and endpoint styles", () => {
    const dotted = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS, "dotted", "dot");
    const xLine = dotted.getObjectByName("graph3d-axis-line:x") as LineSegments | undefined;
    const xEnd = dotted.getObjectByName("graph3d-axis-arrow:x") as Mesh | undefined;
    expect(xLine?.material).toBeInstanceOf(LineDashedMaterial);
    expect(xEnd?.userData.graph3dAxisEndPlanar).toBe(true);
    expect(Array.from(xEnd?.geometry.getAttribute("position").array ?? [])
      .filter((_, index) => index % 3 === 2)
      .every((coordinate) => coordinate === 0)).toBe(true);

    const arrow = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS, "solid", "arrow");
    expect(arrow.getObjectByName("graph3d-axis-arrow:x")).toBeInstanceOf(LineSegments);
    const triangle = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS, "solid", "triangle");
    expect(triangle.getObjectByName("graph3d-axis-arrow:x")).toBeInstanceOf(Mesh);

    const withoutEnds = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS, "solid", "none");
    expect(withoutEnds.getObjectByName("graph3d-axis-arrow:x")).toBeUndefined();
    expect(withoutEnds.getObjectByName("graph3d-axis-arrow:y")).toBeUndefined();
    expect(withoutEnds.getObjectByName("graph3d-axis-arrow:z")).toBeUndefined();
  });

  it("keeps an unaffected object group while replacing a parameter-dependent sibling", () => {
    const animatedSpec: Graph3DSpec = {
      ...spec,
      parameters: [{ id: "parameter_s", name: "s", value: 0, min: -1, max: 1 }],
      objects: [
        spec.objects[0],
        {
          id: "moving-cube",
          kind: "primitive",
          primitive: "box",
          center: { x: "s", y: "0", z: "0" },
          size: { x: "1", y: "1", z: "1" },
        },
      ],
    };
    const before = buildGraph3DSceneGeometry(animatedSpec, { s: 0 });
    const after = buildGraph3DSceneGeometry(animatedSpec, { s: 0.5 });
    const group = createThreeGraph3DGroup(before);
    const stableChild = group.getObjectByName("graph3d-object-group:cube");
    const movingChild = group.getObjectByName("graph3d-object-group:moving-cube");

    updateThreeGraph3DGroup(group, before, after);

    expect(group.getObjectByName("graph3d-object-group:cube")).toBe(stableChild);
    expect(group.getObjectByName("graph3d-object-group:moving-cube")).not.toBe(movingChild);
    disposeThreeGraph3DGroup(group);
  });


  it("draws a dashed dimension line as separate bodies and skips arrow heads when asked", () => {
    const dimensionParts = (
      lineStyle: "solid" | "dashed",
      endStyle: "arrow" | "none" | "tick",
    ) => {
      const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
        ...spec,
        annotations: [{
          id: "height",
          kind: "dimension",
          from: { x: "1.2", y: "0", z: "-1" },
          to: { x: "1.2", y: "0", z: "1" },
          labelTex: "2",
          lineStyle,
          lineWidth: 3,
          endStyle,
        }],
      }));
      const dimension = group.children.find((child) => child.name === "graph3d-dimension:height");
      const children = dimension?.children ?? [];
      return {
        total: children.length,
        heads: children.filter((child) => child.userData.graph3dAxisEndPlanar === true).length,
      };
    };
    expect(dimensionParts("solid", "none")).toEqual({ total: 1, heads: 0 });
    expect(dimensionParts("solid", "arrow")).toEqual({ total: 3, heads: 2 });
    expect(dimensionParts("solid", "tick")).toEqual({ total: 3, heads: 2 });
    expect(dimensionParts("dashed", "none").total).toBeGreaterThan(3);
  });

  it("fills the volume two solids share", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
      ...spec,
      objects: [
        ...spec.objects,
        {
          id: "wedge",
          kind: "boundedSolid",
          inequalities: ["x + y + z <= 1"],
          bounds: {
            x: { min: "-2", max: "2" },
            y: { min: "-2", max: "2" },
            z: { min: "-2", max: "2" },
          },
        },
      ],
      regions: [{
        id: "shared",
        kind: "objectIntersection",
        objectIds: ["cube", "wedge"],
        fill: { mode: "solid", color: "#d97706", opacity: 0.5 },
      }],
    }));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));
    const shared = descendants.find((object): object is Mesh => (
      object instanceof Mesh && object.name === "graph3d-intersection-solid:shared"
    ));
    expect(shared).toBeDefined();
    expect((shared?.material as MeshStandardMaterial | undefined)?.color.getHexString()).toBe("d97706");
    expect(descendants.some((object) => object.name === "graph3d-intersection-edges:shared")).toBe(true);
  });

  it("fills the flat area a solid shares with a plane", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
      ...spec,
      objects: [
        ...spec.objects,
        { id: "lid", kind: "plane", plane: { kind: "equation", expression: "z = 0" } },
      ],
      regions: [{
        id: "shared",
        kind: "objectIntersection",
        objectIds: ["cube", "lid"],
        fill: { mode: "pattern", color: "#d97706", opacity: 0.4, pattern: "diagonal" },
      }],
    }));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));
    expect(descendants.some((object) => object.name === "graph3d-intersection-area:shared")).toBe(true);
    expect(descendants.some((object) => object.name === "graph3d-intersection-solid:shared")).toBe(false);
  });

  it("draws the line two planes share", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
      ...spec,
      objects: [
        { id: "floor", kind: "plane", plane: { kind: "equation", expression: "z = 0" } },
        { id: "wall", kind: "plane", plane: { kind: "equation", expression: "x = 0" } },
      ],
      regions: [{
        id: "shared",
        kind: "objectIntersection",
        objectIds: ["floor", "wall"],
        fill: { mode: "solid", color: "#d97706", opacity: 0.5 },
        edgeColor: "#b91c1c",
      }],
    }));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));
    const line = descendants.find((object): object is LineSegments => (
      object instanceof LineSegments && object.name === "graph3d-intersection-line:shared"
    ));
    expect(line).toBeDefined();
    expect((line?.material as LineBasicMaterial | undefined)?.color.getHexString()).toBe("b91c1c");
  });

  it("draws the single point three planes share", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
      ...spec,
      objects: [
        { id: "floor", kind: "plane", plane: { kind: "equation", expression: "z = 0" } },
        { id: "wall", kind: "plane", plane: { kind: "equation", expression: "x = 0" } },
        { id: "back", kind: "plane", plane: { kind: "equation", expression: "y = 0" } },
      ],
      regions: [{
        id: "shared",
        kind: "objectIntersection",
        objectIds: ["floor", "wall", "back"],
        fill: { mode: "solid", color: "#d97706" },
      }],
    }));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));
    expect(descendants.some((object) => object.name === "graph3d-intersection-points:shared")).toBe(true);
  });

  it("draws the patch and the outline a shell shares with a solid", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry({
      ...spec,
      objects: [
        ...spec.objects,
        {
          id: "sheet",
          kind: "parametricSurface",
          x: "u",
          y: "v",
          z: "0",
          u: { min: "-3", max: "3", samples: 10 },
          v: { min: "-3", max: "3", samples: 10 },
        },
      ],
      regions: [{
        id: "shared",
        kind: "objectIntersection",
        objectIds: ["cube", "sheet"],
        fill: { mode: "solid", color: "#d97706", opacity: 0.5 },
      }],
    }));
    const descendants: Object3D[] = [];
    group.traverse((object) => descendants.push(object));
    expect(descendants.some((object) => object.name === "graph3d-intersection-patch:shared")).toBe(true);
    expect(descendants.some((object) => object.name === "graph3d-intersection-contour:shared")).toBe(true);
  });

  it("disposes GPU resources owned by the adapter", () => {
    const group = createThreeGraph3DGroup(buildGraph3DSceneGeometry(spec));
    const geometries: Array<{ dispose: () => void }> = [];
    group.traverse((object) => {
      if (object instanceof Mesh || object instanceof LineSegments || object instanceof LineLoop) {
        geometries.push(object.geometry);
      }
    });
    const disposeCounts = new Map(geometries.map((geometry) => [geometry, 0]));
    for (const geometry of geometries) {
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposeCounts.set(geometry, (disposeCounts.get(geometry) ?? 0) + 1);
        original();
      };
    }

    disposeThreeGraph3DGroup(group);
    expect([...disposeCounts.values()].every((count) => count === 1)).toBe(true);
  });

  it("keeps nested section loops as holes instead of filling an annulus centre", () => {
    const outer2D = [
      { x: -2, y: -2 }, { x: 2, y: -2 }, { x: 2, y: 2 }, { x: -2, y: 2 },
    ];
    const inner2D = [
      { x: -1, y: -1 }, { x: -1, y: 1 }, { x: 1, y: 1 }, { x: 1, y: -1 },
    ];
    const geometry = createThreeGraph3DSectionFillGeometry({
      segments: [],
      loops: [outer2D, inner2D].map((points2D) => ({
        points2D,
        points3D: points2D.map((point) => ({ ...point, z: 0 })),
        triangles: [],
      })),
    });
    expect(geometry).not.toBeNull();
    const position = geometry?.getAttribute("position");
    const index = geometry?.getIndex();
    let area = 0;
    for (let offset = 0; index && position && offset < index.count; offset += 3) {
      const a = index.getX(offset);
      const b = index.getX(offset + 1);
      const c = index.getX(offset + 2);
      const ax = position.getX(a);
      const ay = position.getY(a);
      const bx = position.getX(b);
      const by = position.getY(b);
      const cx = position.getX(c);
      const cy = position.getY(c);
      area += Math.abs((ax * (by - cy) + bx * (cy - ay) + cx * (ay - by)) / 2);
      const centroidX = (ax + bx + cx) / 3;
      const centroidY = (ay + by + cy) / 3;
      expect(Math.max(Math.abs(centroidX), Math.abs(centroidY))).toBeGreaterThanOrEqual(1);
    }
    expect(area).toBeCloseTo(12);
    geometry?.dispose();
  });
});

describe("coordinate axes", () => {
  it("colours each axis independently and puts an arrow head on the positive end", () => {
    const colors = { x: "#ff0000", y: "#00ff00", z: "#0000ff" };
    const axes = createThreeGraph3DAxes(3, colors);

    for (const axis of ["x", "y", "z"] as const) {
      const head = axes.getObjectByName(`graph3d-axis-arrow:${axis}`);
      expect(head).toBeInstanceOf(LineSegments);
      const material = (head as LineSegments).material as LineBasicMaterial;
      expect(`#${material.color.getHexString()}`).toBe(colors[axis]);
      // The head sits on the positive end of its own axis and nowhere else.
      const position = (head as LineSegments).position;
      expect(position[axis]).toBeGreaterThan(2.5);
      for (const other of ["x", "y", "z"] as const) {
        if (other !== axis) expect(position[other]).toBeCloseTo(0);
      }
      expect(head?.userData.graph3dAxisEndPlanar).toBe(true);
    }
  });

  it("falls back to the documented default palette", () => {
    const axes = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS);
    const head = axes.getObjectByName("graph3d-axis-arrow:x") as Mesh;
    expect(`#${(head.material as MeshBasicMaterial).color.getHexString()}`)
      .toBe(DEFAULT_GRAPH3D_AXIS_COLORS.x);
  });

  it("disposes the axis geometry it owns", () => {
    const axes = createThreeGraph3DAxes(3, DEFAULT_GRAPH3D_AXIS_COLORS);
    const disposed: string[] = [];
    axes.traverse((object) => {
      if (!(object instanceof Mesh) && !(object instanceof LineSegments)) return;
      const original = object.geometry.dispose.bind(object.geometry);
      object.geometry.dispose = () => {
        disposed.push(object.name);
        original();
      };
    });
    disposeThreeGraph3DGroup(axes);
    expect(disposed).toHaveLength(6);
  });
});
