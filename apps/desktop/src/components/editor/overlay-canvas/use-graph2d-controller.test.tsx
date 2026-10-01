// @vitest-environment happy-dom
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SELECT_OVERLAY_GRAPH_EVENT, type SelectedOverlayGraph } from "../EditorSettings";
import { createGraph2DSpecPreset } from "@/lib/graph2d";
import type { OverlayGraphShape, OverlayShape } from "./types";
import { hydrateGraphSpecWithOwnedLabelTexts, materializeMissingGraphOwnedTextLabels } from "./shapes/graph-labels";
import { useOverlayGraph2DController } from "./use-graph2d-controller";

it("hydrates graph-owned labels during settings edits and preserves them after serialization and reload", async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  const spec = { ...createGraph2DSpecPreset("blank"), showFormulaLabels: true,
    curves: [{ id: "curve", expr: "x", label: "y=x", color: "#000000" }],
    points: [{ id: "point", x: "1", y: "2", label: "P" }],
    annotations: [{ id: "note", x: "2", y: "3", text: "Note" }],
  };
  const graph: OverlayGraphShape = { id: "graph", type: "graph2dShape", x: 0, y: 0, props: { w: 300, h: 200, spec } };
  let sequence = 0;
  const initial = materializeMissingGraphOwnedTextLabels([graph], () => `label-${++sequence}`);
  const shapesRef = { current: initial };
  let selected: SelectedOverlayGraph | null = null;
  const listener = (event: Event) => { selected = (event as CustomEvent<SelectedOverlayGraph | null>).detail; };
  window.addEventListener(SELECT_OVERLAY_GRAPH_EVENT, listener);
  const host = document.createElement("div"); const root = createRoot(host);
  const noop = vi.fn();
  function Harness({ source }: { source: OverlayShape[] }) {
    const [shapes, setShapes] = useState(source);
    useOverlayGraph2DController({ shapes, setShapes, shapesRef, selectedIds: ["graph"], originPickShapeId: null, graphFillPickShapeId: null,
      setSelectedShapeIds: noop, transitionMode: noop, setGraphAxisLabelText: noop, setGraphAxisLabelTextVisible: noop, setGraphCurveFormulaLabelTextVisible: noop,
    });
    return null;
  }
  const inspect = () => { expect(selected).not.toBeNull(); return selected!; };
  try {
    await act(async () => root.render(<Harness source={initial} />));
    expect(inspect().spec.curves[0].label).toBe("y=x");
    await act(async () => inspect().onSpecChange({ ...inspect().spec, width: 500, points: [{ id: "point", x: "1", y: "2", label: "P changed" }] }));
    const serialized = JSON.stringify(shapesRef.current);
    const savedShapes = JSON.parse(serialized) as OverlayShape[];
    const savedGraph = savedShapes.find((shape): shape is OverlayGraphShape => shape.type === "graph2dShape")!;
    const hydrated = hydrateGraphSpecWithOwnedLabelTexts(savedGraph, savedShapes);
    expect(hydrated.curves[0].label).toBe("y=x");
    expect(hydrated.points?.[0].label).toBe("P changed");
    expect(hydrated.annotations?.[0].text).toBe("Note");
    expect(savedGraph.props.spec.points?.[0].label).toBeUndefined();
    await act(async () => root.render(<Harness key="reloaded" source={savedShapes} />));
    expect(inspect().spec.points?.[0].label).toBe("P changed");
    expect(inspect().spec.annotations?.[0].text).toBe("Note");
  } finally {
    await act(async () => root.unmount());
    expect(selected).toBeNull();
    window.removeEventListener(SELECT_OVERLAY_GRAPH_EVENT, listener);
  }
});
