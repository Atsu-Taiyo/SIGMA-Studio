import { describe, expect, it } from "vitest";

import {
  clearMaterializedGraphLabelTexts,
  getExistingGraphAxisLabelTextShapeIdsByKey,
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  hydrateGraphSpecWithOwnedLabelTexts,
} from "./graph-label-read-model";
import type {
  OverlayGraphShape,
  OverlayTextBlock,
  OverlayShape,
  OverlayTextShape,
} from "./overlay-model";

function graphShape(
  axisLabelTextShapeIds: OverlayGraphShape["props"]["axisLabelTextShapeIds"] = {},
): OverlayGraphShape {
  return {
    id: "graph",
    type: "graph2dShape",
    x: 0,
    y: 0,
    props: {
      boundsMode: "plot",
      w: 300,
      h: 180,
      axisLabelTextShapeIds,
      spec: {
        kind: "cartesian",
        title: "",
        width: 364,
        height: 232,
        viewBox: {
          xMin: "-5",
          xMax: "5",
          yMin: "-5",
          yMax: "5",
        },
        axes: {
          grid: false,
          xLabel: "  x_{spec}  ",
          yLabel: "  y_{spec}  ",
          originLabel: "  O  ",
        },
        curves: [],
      },
    },
  };
}

function labelShape(
  id: string,
  blocks: OverlayTextBlock[],
): OverlayTextShape {
  return {
    id,
    type: "text",
    x: 0,
    y: 0,
    props: {
      w: 80,
      h: 24,
      blocks,
      color: "black",
      size: "m",
    },
  };
}

describe("graph label read model", () => {
  it("concatenates canonical text and math inline content without separators", () => {
    const blocks: OverlayTextBlock[] = [
      {
        type: "paragraph",
        id: "p_1",
        children: [
          { type: "text", text: " A=" },
          { type: "mathInline", id: "math_x", tex: "x^2", display: "inline" },
          { type: "text", text: "+1" },
        ],
      },
      {
        type: "paragraph",
        id: "p_2",
        children: [{ type: "text", text: " tail " }],
      },
    ];

    expect(getOverlayTextBlocksLabelText(blocks)).toBe(" A=x^2+1 tail ");
  });

  it("trims fixed spec labels and omits whitespace-only labels", () => {
    const graph = graphShape();
    graph.props.spec.axes.yLabel = "   ";

    expect(getGraphAxisLabelSpecText(graph.props.spec, "x")).toBe("x_{spec}");
    expect(getGraphAxisLabelSpecText(graph.props.spec, "y")).toBeUndefined();
    expect(getGraphAxisLabelSpecText(graph.props.spec, "origin")).toBe("O");
  });

  it("uses existing text-shape labels and falls back to spec text for missing IDs", () => {
    const graph = graphShape({
      x: "label_x",
      y: "missing_label",
      origin: "not_text",
    });
    const xLabel = labelShape("label_x", [{
      type: "paragraph",
      id: "p_x",
      children: [
        { type: "text", text: "x=" },
        { type: "mathInline", id: "math_t", tex: "t+1", display: "inline" },
      ],
    }]);
    const notText: OverlayShape = {
      id: "not_text",
      type: "geo",
      x: 0,
      y: 0,
      props: {
        w: 20,
        h: 20,
        geo: "rectangle",
        fill: "none",
        color: "black",
        labelColor: "black",
        dash: "solid",
        size: "m",
      },
    };

    expect(getGraphAxisLabelTextsByKey(graph, [graph, xLabel, notText])).toEqual({
      x: "x=t+1",
      y: "y_{spec}",
      origin: "O",
    });
    expect(getExistingGraphAxisLabelTextShapeIdsByKey(
      graph,
      [graph, xLabel, notText],
    )).toEqual({
      x: "label_x",
    });
  });

  it("does not replace an existing empty text label with legacy spec text", () => {
    const graph = graphShape({ x: "label_x" });
    const emptyLabel = labelShape("label_x", [{ type: "paragraph", id: "p_empty", children: [] }]);

    expect(getGraphAxisLabelTextsByKey(graph, [graph, emptyLabel]).x).toBe("");
  });

  it("hydrates command input from owned labels and clears duplicate persisted text", () => {
    const graph = graphShape({ x: "label_x" });
    graph.props.pointLabelTextShapeIdsByPointId = { point_1: "label_point" };
    graph.props.annotationTextShapeIdsByAnnotationId = { note_1: "label_note" };
    graph.props.labelTextShapeIdsByCurveId = { curve_1: "label_curve" };
    graph.props.spec.points = [{ id: "point_1", x: "1", y: "2", label: "stale point" }];
    graph.props.spec.annotations = [{ id: "note_1", x: "2", y: "3", text: "stale note" }];
    graph.props.spec.curves = [{ id: "curve_1", expr: "x", color: "black", label: "stale curve" }];
    const labels = [
      labelShape("label_x", [{ type: "paragraph", id: "p_lx", children: [{ type: "text", text: "X" }] }]),
      labelShape("label_point", [{ type: "paragraph", id: "p_lp", children: [{ type: "text", text: "P" }] }]),
      labelShape("label_note", [{ type: "paragraph", id: "p_ln", children: [{ type: "text", text: "N" }] }]),
      labelShape("label_curve", [{ type: "paragraph", id: "p_lc", children: [{ type: "text", text: "f" }] }]),
    ];

    const hydrated = hydrateGraphSpecWithOwnedLabelTexts(graph, [graph, ...labels]);
    expect(hydrated.axes.xLabel).toBe("X");
    expect(hydrated.points?.[0]?.label).toBe("P");
    expect(hydrated.annotations?.[0]?.text).toBe("N");
    expect(hydrated.curves[0]?.label).toBe("f");

    const cleared = clearMaterializedGraphLabelTexts(graph);
    expect(cleared.props.spec.axes.xLabel).toBe("");
    expect(cleared.props.spec.points?.[0]).not.toHaveProperty("label");
    expect(cleared.props.spec.annotations?.[0]?.text).toBe("");
    expect(cleared.props.spec.curves[0]).not.toHaveProperty("label");
  });
});
