import { overlayTextBlocksToInlineNodes } from "@/features/document";
import { describe, expect, it } from "vitest";

import type { OverlayGraphShape, OverlayShape } from "@/features/document";

import {
  createGraphAnnotationLabelShapeEntries,
  createGraphAxisLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphPointLabelShapeEntries,
  expandShapeIdsWithGraphOwnedLabels,
  getGraphOwnedLabelShapeIds,
  getGraphPlotSize,
  type GraphLabelLayoutPort,
} from ".";

describe("graph label layout", () => {
  it("creates all graph-owned label kinds through an injected measurement port", () => {
    const measured: Array<{ tex: string; fontSizePt: number }> = [];
    let inlineMathIndex = 0;
    const port: GraphLabelLayoutPort = {
      measureMathLabel(tex, fontSizePt) {
        measured.push({ tex, fontSizePt });
        return { width: tex.length * 6, height: fontSizePt + 4 };
      },
      evaluateExpression(expression) {
        const value = Number(expression);
        if (!Number.isFinite(value)) {
          throw new Error(`unsupported test expression: ${expression}`);
        }
        return value;
      },
      createInlineMathId: () => `math_${inlineMathIndex += 1}`,
      createBlockId: () => `p_${inlineMathIndex}`,
    };
    const graph = createTestGraph();

    const [axis] = createGraphAxisLabelShapeEntries(graph, () => "axis_x", port, { keys: ["x"] });
    const [point] = createGraphPointLabelShapeEntries(graph, () => "point_p", port);
    const [annotation] = createGraphAnnotationLabelShapeEntries(graph, () => "annotation_a", port);
    const [formula] = createGraphFormulaLabelShapeEntries(
      graph,
      () => "formula_f",
      { width: 800, height: 600 },
      port,
    );

    expect(axis).toMatchObject({ key: "x", shape: { id: "axis_x", type: "text" } });
    expect(point).toMatchObject({ pointId: "point_p", shape: { id: "point_p", type: "text" } });
    expect(annotation).toMatchObject({ annotationId: "annotation_a", shape: { id: "annotation_a", type: "text" } });
    expect(formula).toMatchObject({ curveId: "curve_f", shape: { id: "formula_f", type: "text" } });
    expect([axis, point, annotation, formula].map((entry) => (
      overlayTextBlocksToInlineNodes(entry.shape.props.blocks).find((node) => node.type === "mathInline")?.id
    ))).toEqual(["math_1", "math_2", "math_3", "math_4"]);
    expect(measured).toEqual(expect.arrayContaining([
      { tex: "x", fontSizePt: 10 },
      { tex: "P", fontSizePt: 10 },
      { tex: "A", fontSizePt: 10 },
      { tex: "y = x", fontSizePt: 12 },
    ]));
  });

  it("keeps plot size independent from SVG decoration margins", () => {
    expect(getGraphPlotSize(createTestGraph().props.spec)).toEqual({
      w: 300,
      h: 180,
    });
  });
});

describe("graph label ownership", () => {
  it("reports every label kind the graph owns, deduped", () => {
    expect(getGraphOwnedLabelShapeIds(createLabelledGraph()).sort()).toEqual([
      "annotation_label",
      "axis_x_label",
      "axis_y_label",
      "formula_label",
      "point_label",
    ]);
  });

  it("reports nothing for a graph whose labels were never materialized", () => {
    expect(getGraphOwnedLabelShapeIds(createTestGraph())).toEqual([]);
  });

  it("expands a graph id to its labels and leaves other shapes alone", () => {
    const shapes = createLabelledGraphShapes();

    expect(expandShapeIdsWithGraphOwnedLabels(shapes, ["graph_1"]).sort()).toEqual([
      "annotation_label",
      "axis_x_label",
      "axis_y_label",
      "formula_label",
      "graph_1",
      "point_label",
    ]);
    expect(expandShapeIdsWithGraphOwnedLabels(shapes, ["other_shape"])).toEqual(["other_shape"]);
    expect(expandShapeIdsWithGraphOwnedLabels(shapes, [])).toEqual([]);
  });

  it("does not expand a label id back to the graph that owns it", () => {
    expect(expandShapeIdsWithGraphOwnedLabels(createLabelledGraphShapes(), ["axis_x_label"]))
      .toEqual(["axis_x_label"]);
  });
});

function createLabelledGraph(): OverlayGraphShape {
  const graph = createTestGraph();
  return {
    ...graph,
    props: {
      ...graph.props,
      axisLabelTextShapeIds: { x: "axis_x_label", y: "axis_y_label" },
      pointLabelTextShapeIdsByPointId: { point_p: "point_label" },
      annotationTextShapeIdsByAnnotationId: { annotation_a: "annotation_label" },
      labelTextShapeIdsByCurveId: { curve_f: "formula_label" },
      labelTextShapeIds: ["formula_label"],
    },
  };
}

function createLabelledGraphShapes(): OverlayShape[] {
  return [
    createLabelledGraph(),
    {
      id: "other_shape",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      props: {
        w: 10,
        h: 10,
        geo: "rectangle",
        fill: "none",
        color: "#111111",
        fillColor: "#ffffff",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
  ];
}

function createTestGraph(): OverlayGraphShape {
  return {
    id: "graph_1",
    type: "graph2dShape",
    x: 100,
    y: 80,
    rotation: 0,
    props: {
      boundsMode: "plot",
      w: 300,
      h: 180,
      spec: {
        kind: "cartesian",
        title: "",
        width: 364,
        height: 232,
        viewBox: {
          xMin: "-5",
          xMax: "5",
          yMin: "-3",
          yMax: "3",
        },
        axes: {
          grid: false,
          showX: true,
          showY: true,
          xLabel: "x",
          yLabel: "y",
          originLabel: "O",
        },
        curves: [{
          id: "curve_f",
          expr: "x",
          label: "y = x",
          color: "#2563eb",
        }],
        points: [{
          id: "point_p",
          x: "1",
          y: "1",
          label: "P",
          labelPlacement: "ne",
        }],
        annotations: [{
          id: "annotation_a",
          x: "2",
          y: "2",
          text: "A",
        }],
      },
    },
  };
}
