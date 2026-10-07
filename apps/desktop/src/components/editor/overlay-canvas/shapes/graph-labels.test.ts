import { describe, expect, it, vi } from "vitest";

import {
  getGraphAxisLabelSpecText as getCanonicalGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey as getCanonicalGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText as getCanonicalOverlayRichTextLabelText,
  type OverlayGraphShape,
  type OverlayShape,
} from "@/features/document";
import { buildFunctionPath, createGraph2DSpecPreset } from "@/lib/graph2d";
import { createGraphFormulaLabelShapeEntries } from "./graph";
import * as graphLayout from "./graph";

import {
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getTiptapLabelText,
  hydrateGraphSpecWithOwnedLabelTexts,
  materializeMissingGraphOwnedTextLabels,
  createGraphOwnedTextLabelReconciler,
} from "./graph-labels";

describe("incremental graph label reconciliation", () => {
  const size = { width: 800, height: 600 };
  const makeGraph = (id: string): OverlayGraphShape => {
    const spec = createGraph2DSpecPreset("blank");
    return { id, type: "graph2dShape", x: 10, y: 10, props: {
      boundsMode: "plot", w: spec.width, h: spec.height,
      spec: { ...spec, axes: { ...spec.axes, xLabel: "x", yLabel: "y", originLabel: "O" } },
    } };
  };
  const ordinaryText: OverlayShape = { id: "text", type: "text", x: 20, y: 30,
    props: { w: 120, h: 30, color: "black", size: "m", blocks: [
      { id: "block", type: "paragraph", children: [{ type: "text", text: "編集" }] },
    ] } };

  it("skips unrelated graph layout when typing, but updates only the changed graph", () => {
    let id = 0;
    const reconcile = createGraphOwnedTextLabelReconciler(() => `label_${++id}`);
    const first = reconcile([makeGraph("a"), makeGraph("b"), ordinaryText], size);
    const layout = vi.spyOn(graphLayout, "createGraphAxisLabelShapeEntries");
    try {
      const edited = first.map(shape => shape.id === "text" ? { ...ordinaryText, x: 35 } : shape);
      expect(reconcile(edited, size)).toBe(edited);
      expect(layout).not.toHaveBeenCalled();
      const moved = edited.map(shape => shape.id === "a" ? { ...shape, x: shape.x + 100 } : shape);
      const next = reconcile(moved, size);
      expect(layout.mock.calls.map((args) => args[0].id)).toEqual(["a"]);
      expect(next).toEqual(materializeMissingGraphOwnedTextLabels(moved, () => "unexpected", size));
      expect(next.find(shape => shape.id === "b")).toBe(first.find(shape => shape.id === "b"));
      expect(reconcile(next, size)).toBe(next);
    } finally { layout.mockRestore(); }
  });

  it("matches full reconciliation after label edits/deletion, undo, external restore and canvas resize", () => {
    let id = 0;
    const reconcile = createGraphOwnedTextLabelReconciler(() => `label_${++id}`);
    let shapes = reconcile([makeGraph("a"), ordinaryText], size);
    const initial = shapes;
    const graph = shapes.find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape")!;
    const labelId = graph.props.axisLabelTextShapeIds!.x!;
    shapes = shapes.map(shape => shape.id === labelId && shape.type === "text" ? {
      ...shape, props: { ...shape.props, blocks: [{ id: "edited", type: "paragraph", children: [{ type: "text", text: "時間" }] }] },
    } : shape);
    expect(reconcile(shapes, size)).toEqual(materializeMissingGraphOwnedTextLabels(shapes, () => "unexpected", size));
    const deleted = shapes.filter(shape => shape.id !== labelId);
    expect(reconcile(deleted, size)).toEqual(materializeMissingGraphOwnedTextLabels(deleted, () => "unexpected", size));
    expect(reconcile(initial, size)).toEqual(materializeMissingGraphOwnedTextLabels(initial, () => "unexpected", size));
    const restored = JSON.parse(JSON.stringify(initial)) as OverlayShape[];
    expect(reconcile(restored, size)).toEqual(materializeMissingGraphOwnedTextLabels(restored, () => "unexpected", size));
    const resized = { width: 1400, height: 900 };
    expect(reconcile(restored, resized)).toEqual(materializeMissingGraphOwnedTextLabels(restored, () => "unexpected", resized));
  });

  it("tracks upstream anchors, including missing targets and cycles", () => {
    let id = 0;
    const reconcile = createGraphOwnedTextLabelReconciler(() => `label_${++id}`);
    const graph = { ...makeGraph("a"), anchor: { type: "shape" as const, shapeId: "text", dx: 20, dy: 30 } };
    const first = reconcile([graph, ordinaryText], size);
    const moved = first.map(shape => shape.id === "text" ? { ...ordinaryText, x: 70, y: 80 } : shape);
    expect(reconcile(moved, size)).toEqual(materializeMissingGraphOwnedTextLabels(moved, () => "unexpected", size));
    const missing = moved.filter(shape => shape.id !== "text");
    expect(reconcile(missing, size)).toEqual(materializeMissingGraphOwnedTextLabels(missing, () => "unexpected", size));
    expect(reconcile(moved, size)).toEqual(materializeMissingGraphOwnedTextLabels(moved, () => "unexpected", size));
    const cyclic = moved.map(shape => shape.id === "text" ? { ...shape,
      anchor: { type: "shape" as const, shapeId: "a", dx: 0, dy: 0 },
    } : shape);
    expect(() => reconcile(cyclic, size)).not.toThrow();
  });
});

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
