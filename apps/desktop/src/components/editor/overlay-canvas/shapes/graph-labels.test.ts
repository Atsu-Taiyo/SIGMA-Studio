import { describe, expect, it } from "vitest";

import {
  getGraphAxisLabelSpecText as getCanonicalGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey as getCanonicalGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText as getCanonicalOverlayRichTextLabelText,
  type OverlayGraphShape,
  type OverlayShape,
} from "@/features/document";
import { buildFunctionPath, createGraph2DSpecPreset } from "@/lib/graph2d";
import { createGraphFormulaLabelShapeEntries } from "./graph";

import {
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getTiptapLabelText,
  hydrateGraphSpecWithOwnedLabelTexts,
  materializeMissingGraphOwnedTextLabels,
} from "./graph-labels";

describe("graph formula label persistence", () => {
  it("regenerates display math after materialization and a saved graph roundtrip", () => {
    const spec = {
      ...createGraph2DSpecPreset("blank"),
      showFormulaLabels: true,
      parameters: [{ id: "parameter_s", name: "s", value: 2, min: -3, max: 3 }],
      curves: [{ id: "curve_s", expr: "s*x", exprTex: "sx", label: "y = sx", color: "#000000" }],
    };
    const graph: OverlayGraphShape = {
      id: "graph_s", type: "graph2dShape", x: 10, y: 10,
      props: { w: spec.width, h: spec.height, spec },
    };
    let id = 0;
    const saved = JSON.stringify(materializeMissingGraphOwnedTextLabels([graph], () => `label_${++id}`));
    const shapes = JSON.parse(saved) as OverlayShape[];
    const restored = shapes.find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape")!;
    const label = shapes.find((shape) => shape.id === restored.props.labelTextShapeIdsByCurveId?.curve_s)!;
    expect(label.type).toBe("text");
    if (label.type !== "text") throw new Error("Missing saved formula label");
    expect(getOverlayTextBlocksLabelText(label.props.blocks)).toBe("y = sx");
    expect(restored.props.spec.curves[0]).toEqual({ id: "curve_s", expr: "s*x", exprTex: "sx", color: "#000000" });
    expect(restored.props.spec.parameters).toEqual(spec.parameters);
    expect(hydrateGraphSpecWithOwnedLabelTexts(restored, shapes).curves[0].label).toBe("y = sx");
    const [regenerated] = createGraphFormulaLabelShapeEntries(restored, () => "new_label", { width: 800, height: 600 });
    expect(getOverlayTextBlocksLabelText(regenerated.shape.props.blocks)).toBe("y = sx");
    const path = buildFunctionPath(restored.props.spec.curves[0], restored.props.spec);
    expect(path).not.toBe("");
    expect(path).toBe(buildFunctionPath(spec.curves[0], spec));
  });
});

describe("graph label compatibility exports", () => {
  it("delegates read models to the canonical document feature", () => {
    expect(getGraphAxisLabelSpecText).toBe(getCanonicalGraphAxisLabelSpecText);
    expect(getGraphAxisLabelTextsByKey).toBe(getCanonicalGraphAxisLabelTextsByKey);
    expect(getOverlayTextBlocksLabelText).toBe(getCanonicalOverlayRichTextLabelText);
    expect(getTiptapLabelText).toBe(getCanonicalOverlayRichTextLabelText);
  });
});
