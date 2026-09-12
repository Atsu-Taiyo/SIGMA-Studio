import { describe, expect, it } from "vitest";

import { resolveGraph3DDimensionEndStyle } from "./model/graph3d";
import { OVERLAY_ARROWHEADS, type OverlayTextBlock } from "./overlay-model";
import {
  isGraph3DSpec,
  isOverlayTextBlocks,
  isValidOverlaySnapshot,
} from "./overlay-validation";

const supportedDocument: OverlayTextBlock[] = [
    {
      type: "paragraph", id: "overlay_validation_test_66",
      children: [
        {
          type: "text",
          text: "辺\n",
          marks: ["bold", "italic", "boxed"],
          boxedPaddingY: 2,
          boxedVariant: "double",
          boxedTone: "blue",
        },
        {
          type: "mathInline",
          id: "math_pq",
          tex: "\\overline{PQ}",
          display: "inline",
          marks: ["underline"],
          backgroundColor: "#fff3c2",
          fontFamily: '"Yu Mincho", serif',
          fontSize: 13,
        },
      ],
    },
    {
      type: "heading", id: "overlay_validation_test_67",
      level: 3,
      align: "center",
      lineHeight: "1.8",
      children: [{ type: "text", text: "見出し" }],
    },
  ];

describe("overlay rich-text validation", () => {
  it("accepts semantic blocks backed by canonical InlineNode arrays", () => {
    expect(isOverlayTextBlocks(supportedDocument)).toBe(true);
  });

  it.each([
    { type: "doc", content: [{ type: "paragraph", content: [] }] },
    [{ type: "bulletList", children: [] }],
    [{ type: "paragraph", id: "overlay_validation_test_68", children: [{ type: "text", text: "x", marks: ["strike"] }] }],
    [{ type: "paragraph", id: "overlay_validation_test_69", children: [{ type: "mathInline", id: "", tex: "x", display: "inline" }] }],
    [{ type: "heading", id: "overlay_validation_test_70", level: 4, children: [] }],
    [{ type: "paragraph", id: "overlay_validation_test_71", align: "start", children: [] }],
    // A block with no id: shape blocks carry the body's identity, and losing it breaks every
    // consumer that tracks a block across an edit.
    [{ type: "paragraph", children: [{ type: "text", text: "x" }] }],
    [{ type: "list", id: "overlay_validation_test_72", listType: "square", items: [] }],
    [{ type: "list", id: "overlay_validation_test_73", listType: "bullet", items: [{ type: "listItem", children: [] }] }],
    // Page furniture: a shape is drawn on top of the page, so it does not own page structure.
    [{ type: "boxBlock", id: "overlay_validation_test_74", styleId: "plain", blocks: [] }],
    [{ type: "layoutSection", id: "overlay_validation_test_75", columnCount: 2, children: [] }],
    [{ type: "problem", id: "overlay_validation_test_76", prompt: [] }],
    // A quote holds blocks, and a quote inside a quote is not a shape the editor can build.
    [{ type: "quote", id: "overlay_validation_test_77", blocks: [{ type: "quote", id: "inner", blocks: [] }] }],
    [{ type: "codeBlock", id: "overlay_validation_test_78", children: [{ type: "text", text: "x", marks: ["strike"] }] }],
  ])("rejects unsupported persisted content %#", (document) => {
    expect(isOverlayTextBlocks(document)).toBe(false);
  });

  /**
   * The three blocks a shape gained. They are the body's own, so the point of the pin is the
   * membership itself: the editor can create all three now, and a validator that still refused one
   * would make the document unopenable the moment someone typed it.
   */
  it.each([
    ["a divider", [{ type: "divider", id: "divider_1" }]],
    ["a code block", [{ type: "codeBlock", id: "code_1", language: "typescript", children: [{ type: "text", text: "x" }] }]],
    ["a quote", [{
      type: "quote",
      id: "quote_1",
      blocks: [{ type: "paragraph", id: "quote_p", children: [{ type: "text", text: "引用" }] }],
    }]],
  ])("accepts %s", (_name, document) => {
    expect(isOverlayTextBlocks(document)).toBe(true);
  });

  it("accepts a list, its nested lists and the blocks that continue an item", () => {
    expect(isOverlayTextBlocks([{
      type: "list",
      id: "list_1",
      listType: "ordered",
      start: 3,
      markerStyle: "paren",
      items: [{
        type: "listItem",
        id: "li_1",
        align: "center",
        children: [{ type: "text", text: "一" }],
        continuations: [
          { type: "paragraph", id: "p_cont", children: [{ type: "text", text: "続き" }] },
          { type: "divider", id: "divider_cont" },
        ],
        nested: [{
          type: "list",
          id: "list_2",
          listType: "bullet",
          items: [{ type: "listItem", id: "li_2", children: [] }],
        }],
      }],
    }])).toBe(true);
  });

  it("uses the semantic rich-text validator from snapshot validation", () => {
    const snapshot = {
      version: 1,
      shapes: [
        {
          id: "shape_text",
          type: "text",
          x: 0,
          y: 0,
          props: {
            w: 120,
            h: 32,
            blocks: supportedDocument,
            color: "#111111",
            size: "m",
          },
        },
      ],
      assets: {},
    };

    expect(isValidOverlaySnapshot(snapshot)).toBe(true);
    const invalidSnapshot = structuredClone(snapshot);
    (invalidSnapshot.shapes[0].props.blocks[0] as { children: Array<{ marks?: string[] }> })
      .children[0].marks?.push("strike" as never);
    expect(isValidOverlaySnapshot(invalidSnapshot)).toBe(false);
  });

  it.each(OVERLAY_ARROWHEADS)("accepts %s on both endpoints of a line", (head) => {
    expect(isValidOverlaySnapshot(lineSnapshotWithHeads(head, head))).toBe(true);
  });

  it("rejects an endpoint decoration the model does not define", () => {
    // The validator is what keeps an unknown head out of the renderers, which would otherwise
    // reference a marker that no `<defs>` declares and silently draw a bare line.
    expect(isValidOverlaySnapshot(lineSnapshotWithHeads("spiral", "arrow"))).toBe(false);
    expect(isValidOverlaySnapshot(lineSnapshotWithHeads("arrow", "__proto__"))).toBe(false);
  });
});

const supportedGraph3DSpec = {
  version: 1,
  parameters: [{
    id: "parameter_s",
    name: "s",
    label: "切断位置",
    value: 0.5,
    min: 0,
    max: 1,
    animation: { durationMs: 4_000, loop: "pingPong" },
  }],
  objects: [
    {
      id: "surface_paraboloid",
      kind: "parametricSurface",
      x: "u",
      y: "v",
      z: "u^2 + v^2",
      u: { min: "-2", max: "2", samples: 48 },
      v: { min: "-2", max: "2", samples: 48 },
      translation: { x: "1", y: "0", z: "0" },
      scale: { x: "2", y: "1", z: "1" },
      rotation: { x: "0", y: "0", z: "pi/4" },
      style: { color: "#4f6f91", opacity: 0.75, wireframe: true },
    },
    {
      id: "solid_tetrahedron",
      kind: "boundedSolid",
      inequalities: ["x >= 0", "y >= 0", "z >= 0", "x + y + z <= 1"],
      bounds: {
        x: { min: "0", max: "1" },
        y: { min: "0", max: "1" },
        z: { min: "0", max: "1" },
      },
      style: { color: "#7c8f65", opacity: 0.35 },
    },
    {
      id: "solid_triangular_prism",
      kind: "polyhedron",
      vertices: [
        { x: "0", y: "0", z: "0" },
        { x: "1", y: "0", z: "0" },
        { x: "0", y: "1", z: "0" },
        { x: "0", y: "0", z: "2" },
      ],
      faces: [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
    },
  ],
  cuts: [
    {
      id: "cut_equation",
      targetObjectIds: ["surface_paraboloid", "solid_tetrahedron"],
      plane: { kind: "equation", expression: "x + y = 1" },
      showPlane: true,
      showContour: true,
      section: {
        showInScene: true,
        showFlattened2D: true,
        lineWidth: 2.5,
        overlapMode: "subtract",
        fill: { mode: "pattern", color: "#d97706", opacity: 0.3, pattern: "diagonal" },
      },
    },
    {
      id: "cut_three_points",
      targetObjectIds: ["solid_triangular_prism"],
      plane: {
        kind: "threePoints",
        points: [
          { x: "0", y: "0", z: "s" },
          { x: "1", y: "0", z: "s" },
          { x: "0", y: "1", z: "s" },
        ],
      },
      showContour: true,
    },
  ],
  regions: [{
    id: "section_fill",
    kind: "section",
    cutId: "cut_equation",
    fill: { mode: "solid", color: "#d97706", opacity: 0.25 },
  }, {
    id: "shared_part",
    kind: "objectIntersection",
    label: "共通部分",
    objectIds: ["solid_triangular_prism", "solid_revolution"],
    fill: { mode: "solid", color: "#d97706", opacity: 0.5 },
    showEdges: true,
    edgeColor: "#b45309",
  }],
  annotations: [{
    id: "height_label",
    kind: "dimension",
    from: { x: "0", y: "0", z: "0" },
    to: { x: "0", y: "0", z: "sqrt(3)" },
    labelTex: "\\sqrt{3}",
    lineStyle: "dashed",
    lineWidth: 2.5,
    endStyle: "tick",
  }],
  camera: {
    projection: "perspective",
    position: { x: 5, y: -6, z: 4 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 0, z: 1 },
    fov: 45,
  },
  view: {
    coordinateSystem: "zUp",
    showAxes: true,
    showGrid: true,
    backgroundColor: "#ffffff",
    axisLineStyle: "dashed",
    axisEndStyle: "diamond",
  },
} as const;

describe("graph 3D overlay validation", () => {
  it("accepts expressions, animation, equation cuts, three-point planes, and filled sections", () => {
    expect(isGraph3DSpec(supportedGraph3DSpec)).toBe(true);
    expect(isValidOverlaySnapshot({
      version: 1,
      shapes: [{
        id: "shape_graph3d",
        type: "graph3dShape",
        x: 40,
        y: 80,
        props: {
          w: 420,
          h: 300,
          spec: supportedGraph3DSpec,
          previewAssetId: "asset_graph3d_preview",
          previewSourceHash: "fnv1a32:example",
        },
      }],
      assets: {
        asset_graph3d_preview: {
          id: "asset_graph3d_preview",
          type: "image",
          props: {
            w: 840,
            h: 600,
            name: "3D preview.png",
            isAnimated: false,
            mimeType: "image/png",
            src: "data:image/png;base64,AA==",
            fileSize: 1,
          },
        },
      },
    })).toBe(true);
  });

  it("accepts axis-style dimension ends and still reads the older tick name", () => {
    expect(resolveGraph3DDimensionEndStyle(undefined)).toBe("arrow");
    expect(resolveGraph3DDimensionEndStyle("tick")).toBe("bar");
    expect(isGraph3DSpec({
      ...supportedGraph3DSpec,
      annotations: [{ ...supportedGraph3DSpec.annotations[0], endStyle: "diamond" }],
    })).toBe(true);
    expect(isGraph3DSpec({
      ...supportedGraph3DSpec,
      annotations: [{ ...supportedGraph3DSpec.annotations[0], endStyle: "tick" }],
    })).toBe(true);
  });

  it("rejects unknown coordinate-axis presentation values", () => {
    expect(isGraph3DSpec({
      ...supportedGraph3DSpec,
      view: { ...supportedGraph3DSpec.view, axisLineStyle: "wavy" },
    })).toBe(false);
    expect(isGraph3DSpec({
      ...supportedGraph3DSpec,
      view: { ...supportedGraph3DSpec.view, axisEndStyle: "star" },
    })).toBe(false);
  });

  it("rejects an animation whose one pass takes no time", () => {
    expect(isGraph3DSpec({
      ...supportedGraph3DSpec,
      parameters: [{
        ...supportedGraph3DSpec.parameters[0],
        animation: { durationMs: 0, loop: "pingPong" },
      }],
    })).toBe(false);
  });

  it.each([
    { ...supportedGraph3DSpec, version: 2 },
    { ...supportedGraph3DSpec, parameters: [{ ...supportedGraph3DSpec.parameters[0], value: Number.NaN }] },
    { ...supportedGraph3DSpec, camera: { ...supportedGraph3DSpec.camera, up: { x: 0, y: 0, z: Number.POSITIVE_INFINITY } } },
    { ...supportedGraph3DSpec, cuts: [{ ...supportedGraph3DSpec.cuts[0], plane: { kind: "threePoints", points: [{ x: "0", y: "0", z: "0" }] } }] },
    { ...supportedGraph3DSpec, cuts: [{ ...supportedGraph3DSpec.cuts[0], section: { lineWidth: 0 } }] },
    { ...supportedGraph3DSpec, cuts: [{ ...supportedGraph3DSpec.cuts[0], section: { overlapMode: "xor" } }] },
    { ...supportedGraph3DSpec, regions: [{ ...supportedGraph3DSpec.regions[0], fill: { mode: "pattern", color: "#000", opacity: 2, pattern: "dots" } }] },
    { ...supportedGraph3DSpec, regions: [{ ...supportedGraph3DSpec.regions[1], objectIds: ["ok", ""] }] },
    { ...supportedGraph3DSpec, annotations: [{ ...supportedGraph3DSpec.annotations[0], lineStyle: "wavy" }] },
    { ...supportedGraph3DSpec, annotations: [{ ...supportedGraph3DSpec.annotations[0], lineWidth: 0 }] },
    { ...supportedGraph3DSpec, annotations: [{ ...supportedGraph3DSpec.annotations[0], endStyle: "circle" }] },
  ])("rejects malformed persisted 3D data %#", (spec) => {
    expect(isGraph3DSpec(spec)).toBe(false);
  });

  it("keeps unfinished expressions structurally valid so editor input is not discarded", () => {
    const unfinished = {
      ...supportedGraph3DSpec,
      objects: [
        { ...supportedGraph3DSpec.objects[0], z: "sin(" },
        ...supportedGraph3DSpec.objects.slice(1),
      ],
      cuts: [
        { ...supportedGraph3DSpec.cuts[0], plane: { kind: "equation", expression: "x + =" } },
        ...supportedGraph3DSpec.cuts.slice(1),
      ],
    };
    expect(isGraph3DSpec(unfinished)).toBe(true);
  });

  it("accepts a solid of revolution around the line shared by two planes", () => {
    const customAxis = {
      ...supportedGraph3DSpec,
      objects: [
        ...supportedGraph3DSpec.objects,
        {
          id: "diagonal_revolution",
          kind: "solidOfRevolution",
          axis: {
            kind: "planeIntersection",
            equations: ["x = y", "z = 0"],
            parameter: "t",
          },
          radius: "1",
          axisRange: { min: "-2", max: "2", samples: 24 },
        },
      ],
    };
    expect(isGraph3DSpec(customAxis)).toBe(true);
    expect(isGraph3DSpec({
      ...customAxis,
      objects: [{
        ...customAxis.objects.at(-1),
        axis: { kind: "planeIntersection", equations: ["x = y"] },
      }],
    })).toBe(false);
  });
});

function lineSnapshotWithHeads(start: string, end: string) {
  return {
    version: 1,
    shapes: [
      {
        id: "shape_line",
        type: "line",
        x: 0,
        y: 0,
        props: {
          kind: "polyline",
          points: [{ x: 0, y: 0 }, { x: 40, y: 0 }],
          closed: false,
          arrowheadStart: start,
          arrowheadEnd: end,
          color: "#111111",
          dash: "solid",
          size: "m",
        },
      },
    ],
    assets: {},
  };
}

const chartSpecFixture = {
  version: 1,
  kind: "bar",
  orientation: "columns",
  headerRow: true,
  labelColumn: true,
  title: "Scores",
  legend: true,
  seriesColors: { c2: "#0083d5" },
} as const;

const chartDataFixture = {
  labels: ["Class A", "Class B"],
  series: [{ id: "c2", name: "Math", values: [80, null] }],
} as const;

function chartSnapshot(props: unknown) {
  return {
    version: 1,
    shapes: [{ id: "shape_chart", type: "chartShape", x: 20, y: 40, props }],
    assets: {},
  };
}

describe("chart overlay validation", () => {
  it("accepts a chart that references a table", () => {
    expect(isValidOverlaySnapshot(chartSnapshot({
      w: 360,
      h: 220,
      spec: chartSpecFixture,
      sourceTableShapeId: "shape_table",
      dataSnapshot: chartDataFixture,
    }))).toBe(true);
  });

  it("accepts a chart whose table reference is gone", () => {
    expect(isValidOverlaySnapshot(chartSnapshot({
      w: 360,
      h: 220,
      spec: { ...chartSpecFixture, title: undefined },
      dataSnapshot: chartDataFixture,
    }))).toBe(true);
  });

  it("accepts the scatter x coordinates", () => {
    expect(isValidOverlaySnapshot(chartSnapshot({
      w: 360,
      h: 220,
      spec: { ...chartSpecFixture, kind: "scatter" },
      dataSnapshot: { ...chartDataFixture, xValues: [1, null] },
    }))).toBe(true);
  });

  it.each([
    ["no box", { spec: chartSpecFixture, dataSnapshot: chartDataFixture }],
    ["no spec", { w: 1, h: 1, dataSnapshot: chartDataFixture }],
    ["no snapshot", { w: 1, h: 1, spec: chartSpecFixture }],
    ["an unknown chart kind", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, kind: "radar" },
      dataSnapshot: chartDataFixture,
    }],
    ["a future spec version", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, version: 2 },
      dataSnapshot: chartDataFixture,
    }],
    ["an unknown orientation", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, orientation: "diagonal" },
      dataSnapshot: chartDataFixture,
    }],
    ["a non-boolean header flag", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, headerRow: "yes" },
      dataSnapshot: chartDataFixture,
    }],
    ["a non-string series colour", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, seriesColors: { c2: 16711680 } },
      dataSnapshot: chartDataFixture,
    }],
    ["series colours in an array", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, seriesColors: ["#0083d5"] },
      dataSnapshot: chartDataFixture,
    }],
    ["a non-string label", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { ...chartDataFixture, labels: [1] },
    }],
    ["a value that is neither a number nor a gap", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { labels: ["a"], series: [{ id: "c2", name: "Math", values: ["80"] }] },
    }],
    ["a non-finite value", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { labels: ["a"], series: [{ id: "c2", name: "Math", values: [Number.NaN] }] },
    }],
    ["a series without an id", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { labels: ["a"], series: [{ name: "Math", values: [1] }] },
    }],
    ["malformed scatter x coordinates", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { ...chartDataFixture, xValues: "1,2" },
    }],
    ["more values than labels", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { labels: ["a", "b"], series: [{ id: "c2", name: "Math", values: [1, 2, 3] }] },
    }],
    ["fewer values than labels", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: { labels: ["a", "b"], series: [{ id: "c2", name: "Math", values: [1] }] },
    }],
    ["one series out of step with the others", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      dataSnapshot: {
        labels: ["a"],
        series: [
          { id: "c2", name: "Math", values: [1] },
          { id: "c3", name: "Science", values: [1, 2] },
        ],
      },
    }],
    ["scatter x coordinates out of step with the labels", {
      w: 1,
      h: 1,
      spec: { ...chartSpecFixture, kind: "scatter" },
      dataSnapshot: { ...chartDataFixture, xValues: [1] },
    }],
    ["a non-string table reference", {
      w: 1,
      h: 1,
      spec: chartSpecFixture,
      sourceTableShapeId: 7,
      dataSnapshot: chartDataFixture,
    }],
  ])("rejects a chart with %s", (_label, props) => {
    expect(isValidOverlaySnapshot(chartSnapshot(props))).toBe(false);
  });
});
