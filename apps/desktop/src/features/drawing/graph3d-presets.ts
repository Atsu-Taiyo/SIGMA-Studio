import type { Graph3DCamera, Graph3DPreset, Graph3DSpec } from "@/features/document";

/**
 * Where a 3D figure is looked at from before anyone has moved the camera.
 *
 * "視点を初期位置に戻す" and every template start from this one value. It used to be read back out
 * of the revolution template, which quietly tied the home viewpoint of every figure to whatever
 * that one template happened to need.
 */
export const GRAPH3D_DEFAULT_CAMERA: Graph3DCamera = {
  projection: "perspective",
  position: { x: 5.5, y: -6.5, z: 4.5 },
  target: { x: 0, y: 0, z: 0 },
  up: { x: 0, y: 0, z: 1 },
  fov: 42,
};

export interface Graph3DPresetNames {
  surface: string; surfacePlane: string; surfaceContour: string;
  cutHeight: string; cylinderZ: string; cylinderX: string; cylinderY: string; cutPlaneH: string;
  tricylinderIntersection: string; cylinderZPlane: string; cylinderXPlane: string; cylinderYPlane: string;
  intersectionSection: string; sphereRadius: string; tetrahedron: string; sphere: string;
  tetrahedronSphereIntersection: string; sectionHeight: string; revolution: string; cutPlaneS: string; section: string;
}

/**
 * The default viewpoint pulled in or pushed out along its own line of sight.
 *
 * A unit-sized figure at the default distance is a thumbnail in the middle of the grid, and a
 * ten-unit surface runs off both sides of it. Templates therefore state how big their subject is
 * as a factor, instead of each one carrying three hand-tuned camera numbers that drift apart.
 */
function cameraAtDistanceFactor(factor: number): Graph3DCamera {
  const { position } = GRAPH3D_DEFAULT_CAMERA;
  return {
    ...GRAPH3D_DEFAULT_CAMERA,
    position: { x: position.x * factor, y: position.y * factor, z: position.z * factor },
  };
}

/**
 * A viewpoint stated outright, for the templates whose subject sits in one octant.
 *
 * The default viewpoint looks from `+x, -y, +z`, which puts a figure built on the positive octant
 * edge-on: its `y` vertex hides directly behind its `x` one and the solid reads as a flat triangle.
 */
function cameraLookingFrom(
  position: Graph3DCamera["position"],
  target: Graph3DCamera["target"],
): Graph3DCamera {
  return { ...GRAPH3D_DEFAULT_CAMERA, position, target };
}

export function createGraph3DSpecPreset(
  preset: Graph3DPreset,
  names: Graph3DPresetNames,
): Graph3DSpec {
  const base: Pick<Graph3DSpec, "version" | "camera" | "view" | "regions" | "annotations"> = {
    version: 1,
    regions: [],
    annotations: [],
    camera: GRAPH3D_DEFAULT_CAMERA,
    view: {
      coordinateSystem: "zUp",
      showAxes: true,
      showGrid: true,
      showAxisLabels: true,
      backgroundColor: "#ffffff",
    },
  };

  if (preset === "blank") {
    return { ...base, parameters: [], objects: [], cuts: [] };
  }

  if (preset === "surface") {
    return {
      ...base,
      // Ten units across, and its subject is the ripple: the default viewpoint is both too close
      // and too low, which flattens the rings into a bowl seen edge-on.
      camera: cameraLookingFrom({ x: 7.6, y: -9, z: 8.7 }, { x: 0, y: 0, z: 0 }),
      parameters: [],
      objects: [
        {
          id: "surface_1",
          name: names.surface,
          kind: "parametricSurface",
          // The `z = f(x, y)` of a textbook, written the way this model states a surface: the patch
          // is the u/v rectangle and the height is read off it.
          x: "u",
          y: "v",
          z: "sin(sqrt(u^2 + v^2))",
          u: { min: "-5", max: "5", samples: 34 },
          v: { min: "-5", max: "5", samples: 34 },
          style: { color: "#6b7f91", opacity: 0.55, wireframe: true, wireframeColor: "#273746" },
        },
        {
          id: "plane_level",
          name: names.surfacePlane,
          kind: "plane",
          plane: { kind: "equation", expression: "z = 0.5" },
          size: { x: "10", y: "10", z: "0" },
          style: { color: "#94a3b8", opacity: 0.12 },
        },
      ],
      cuts: [],
      regions: [
        {
          // A surface and a plane share neither a volume nor an area, only the curve where they
          // cross: the level set `f(x, y) = 0.5`, drawn on the figure it belongs to.
          id: "region_level_curve",
          kind: "objectIntersection",
          label: names.surfaceContour,
          objectIds: ["surface_1", "plane_level"],
          fill: { mode: "solid", color: "#1d4ed8", opacity: 1 },
          edgeColor: "#1d4ed8",
        },
      ],
      annotations: [
        {
          id: "label_formula",
          kind: "label",
          // Above the near-left rim: over the peak the chip hides the very ripple it names.
          position: { x: "-4.5", y: "-1.1", z: "2.8" },
          labelTex: "z=\\sin\\sqrt{x^{2}+y^{2}}",
          color: "#334155",
        },
      ],
    };
  }

  if (preset === "tricylinder") {
    return {
      ...base,
      // Unit cylinders: the shared body is only 2 units across, so the camera comes in.
      camera: cameraAtDistanceFactor(0.68),
      parameters: [{
        id: "parameter_h",
        name: "h",
        label: names.cutHeight,
        value: 0.45,
        min: -0.95,
        max: 0.95,
        animation: { durationMs: 6_000, loop: "pingPong" },
      }],
      objects: [
        {
          id: "cylinder_z",
          name: names.cylinderZ,
          kind: "primitive",
          primitive: "cylinder",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "2", y: "2", z: "7.8" },
          style: { color: "#2563eb", opacity: 0.04 },
        },
        {
          id: "cylinder_x",
          name: names.cylinderX,
          kind: "primitive",
          primitive: "cylinder",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "2", y: "2", z: "7.8" },
          // A primitive cylinder stands on its own z-axis; a quarter turn about y lays it along x.
          rotation: { x: "0", y: "pi/2", z: "0" },
          style: { color: "#d14343", opacity: 0.04 },
        },
        {
          id: "cylinder_y",
          name: names.cylinderY,
          kind: "primitive",
          primitive: "cylinder",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "2", y: "2", z: "7.8" },
          rotation: { x: "pi/2", y: "0", z: "0" },
          style: { color: "#2f855a", opacity: 0.04 },
        },
        {
          id: "plane_cut",
          name: names.cutPlaneH,
          kind: "plane",
          plane: { kind: "equation", expression: "z = h" },
          // Wide enough to carry the pieces drawn on it: each cylinder meets the plane in a band
          // as long as the cylinder is, so a quad the width of the shared body would have those
          // bands running off it.
          size: { x: "8", y: "8", z: "0" },
          style: { color: "#94a3b8", opacity: 0.12 },
        },
      ],
      cuts: [],
      regions: [
        {
          id: "region_tricylinder",
          kind: "objectIntersection",
          label: names.tricylinderIntersection,
          objectIds: ["cylinder_z", "cylinder_x", "cylinder_y"],
          fill: { mode: "solid", color: "#8b98a5", opacity: 0.26 },
          resolution: 32,
          // The six curved seams where two cylinders cross are what makes this body recognisable.
          showEdges: true,
          edgeColor: "#475569",
        },
        // Each cylinder meets the plane in its own flat piece — a disc for the upright one, a band
        // for each of the two lying down. The cut of the shared body is where all three overlap,
        // which is the whole point of drawing them on top of one another.
        {
          id: "region_disc_z",
          kind: "objectIntersection",
          label: names.cylinderZPlane,
          objectIds: ["cylinder_z", "plane_cut"],
          fill: { mode: "solid", color: "#2563eb", opacity: 0.1 },
          edgeColor: "#2563eb",
        },
        {
          id: "region_band_x",
          kind: "objectIntersection",
          label: names.cylinderXPlane,
          objectIds: ["cylinder_x", "plane_cut"],
          fill: { mode: "solid", color: "#d14343", opacity: 0.1 },
          edgeColor: "#d14343",
        },
        {
          id: "region_band_y",
          kind: "objectIntersection",
          label: names.cylinderYPlane,
          objectIds: ["cylinder_y", "plane_cut"],
          fill: { mode: "solid", color: "#2f855a", opacity: 0.1 },
          edgeColor: "#2f855a",
        },
        {
          id: "region_section",
          kind: "objectIntersection",
          label: names.intersectionSection,
          objectIds: ["cylinder_z", "cylinder_x", "cylinder_y", "plane_cut"],
          fill: { mode: "solid", color: "#1d4ed8", opacity: 0.5 },
          showEdges: true,
          edgeColor: "#0f172a",
        },
      ],
      annotations: [
        {
          id: "label_plane",
          kind: "label",
          position: { x: "1.55", y: "1.55", z: "h" },
          labelTex: "z=h",
          color: "#475569",
        },
      ],
    };
  }

  if (preset === "sphereTetrahedron") {
    return {
      ...base,
      // The tetrahedron is one unit on a side; at the default distance it is a speck.
      camera: cameraLookingFrom({ x: 3.3, y: 2.55, z: 2.4 }, { x: 0.3, y: 0.3, z: 0.3 }),
      parameters: [{
        id: "parameter_r",
        name: "r",
        label: names.sphereRadius,
        // √3 is the radius at which the ball swallows the tetrahedron whole — the far end of the
        // family, not a shape worth showing on its own. The slider opens on the value where the
        // common part still has both a curved face and a flat one.
        value: 0.8,
        min: 0.1,
        max: 1.7320508,
        animation: { durationMs: 6_000, loop: "pingPong" },
      }],
      objects: [
        {
          id: "solid_tetrahedron",
          name: names.tetrahedron,
          kind: "boundedSolid",
          inequalities: ["x >= 0", "y >= 0", "z >= 0", "x + y + z <= 1"],
          bounds: {
            x: { min: "-0.2", max: "1.2" },
            y: { min: "-0.2", max: "1.2" },
            z: { min: "-0.2", max: "1.2" },
          },
          style: { color: "#65788a", opacity: 0.16, wireframe: true, wireframeColor: "#17212b" },
        },
        {
          id: "sphere_origin",
          name: names.sphere,
          kind: "primitive",
          primitive: "sphere",
          center: { x: "0", y: "0", z: "0" },
          size: { x: "2*r", y: "2*r", z: "2*r" },
          style: { color: "#d14343", opacity: 0.1 },
        },
      ],
      cuts: [],
      regions: [{
        id: "region_common",
        kind: "objectIntersection",
        label: names.tetrahedronSphereIntersection,
        objectIds: ["solid_tetrahedron", "sphere_origin"],
        fill: { mode: "solid", color: "#1d4ed8", opacity: 0.5 },
        // The slider moves this body, so it is re-marched on every tick: 32 keeps the curved face
        // smooth at a third of the cost of 44.
        resolution: 32,
        showEdges: true,
        edgeColor: "#0f172a",
      }],
      annotations: [
        { id: "label_vertex_x", kind: "label", position: { x: "1.15", y: "-0.2", z: "-0.06" }, labelTex: "(1,0,0)", color: "#334155" },
        { id: "label_vertex_y", kind: "label", position: { x: "-0.2", y: "1.15", z: "-0.06" }, labelTex: "(0,1,0)", color: "#334155" },
        { id: "label_vertex_z", kind: "label", position: { x: "-0.14", y: "-0.14", z: "1.16" }, labelTex: "(0,0,1)", color: "#334155" },
        {
          id: "dimension_radius",
          kind: "dimension",
          // Straight down, out of the octant the tetrahedron occupies. Along the diagonal the line
          // runs almost exactly away from the camera and collapses to a point, and every axis
          // direction with a positive sign is an edge of the tetrahedron.
          from: { x: "0", y: "0", z: "0" },
          to: { x: "0", y: "0", z: "-r" },
          labelTex: "r",
          color: "#b91c1c",
        },
      ],
    };
  }

  return {
    ...base,
    parameters: [{
      id: "parameter_s",
      name: "s",
      label: names.sectionHeight,
      value: 0.6,
      min: -1.7,
      max: 1.7,
      animation: { durationMs: 5_000, loop: "pingPong" },
    }],
    objects: [
      {
        id: "solid_revolution",
        name: names.revolution,
        kind: "solidOfRevolution",
        axis: "z",
        radius: "sqrt(2*z^2 + 1)",
        axisRange: { min: "-sqrt(3)", max: "sqrt(3)", samples: 24 },
        angleRange: { min: "0", max: "2*pi", samples: 48 },
        capped: true,
        style: { color: "#8b98a5", opacity: 0.2, wireframe: true, wireframeColor: "#111827" },
      },
      {
        // The moving section the template is named after. Cuts are no longer drawn; a plane taken
        // as a member of a common part is what states "slice the solid here".
        id: "plane_section",
        name: names.cutPlaneS,
        kind: "plane",
        plane: { kind: "equation", expression: "z = s" },
        size: { x: "6", y: "6", z: "0" },
        style: { color: "#94a3b8", opacity: 0.12 },
      },
    ],
    cuts: [],
    regions: [{
      id: "region_section",
      kind: "objectIntersection",
      label: names.section,
      objectIds: ["solid_revolution", "plane_section"],
      fill: { mode: "solid", color: "#1d4ed8", opacity: 0.45 },
      showEdges: true,
      edgeColor: "#0f172a",
    }],
    annotations: [
      {
        id: "dimension_upper",
        kind: "dimension",
        from: { x: "3", y: "0", z: "0" },
        to: { x: "3", y: "0", z: "sqrt(3)" },
        labelTex: "\\sqrt{3}",
      },
      {
        id: "dimension_lower",
        kind: "dimension",
        from: { x: "3", y: "0", z: "-sqrt(3)" },
        to: { x: "3", y: "0", z: "0" },
        labelTex: "\\sqrt{3}",
      },
      {
        id: "label_section",
        kind: "label",
        position: { x: "-2.9", y: "0", z: "s" },
        labelTex: "z=s",
        color: "#475569",
      },
    ],
  };
}
