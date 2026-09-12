import { describe, expect, it, vi } from "vitest";

import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import {
  MAX_PENDING_OVERLAY_GRAPH_DETAIL_MISSES,
  mergeOverlayGraphDetailWithPending,
  recordPendingOverlayGraphAxisLabelEdit,
  recordPendingOverlayGraphSpecEdit,
  type PendingOverlayGraphEdits,
} from "@/components/editor/editor-shell/overlay-graph-pending-edits";
import type { Graph2DSpec } from "@/features/document";
import { createGraph2DSpecPreset } from "@/lib/graph2d";

function graphSpec(patch: Partial<Graph2DSpec> = {}): Graph2DSpec {
  const spec = createGraph2DSpecPreset("line");
  return {
    ...spec,
    ...patch,
    axes: {
      ...spec.axes,
      xLabel: "x",
      yLabel: "y",
      originLabel: "O",
      ...patch.axes,
    },
  };
}

function graphDetail(options: {
  shapeId?: string;
  spec?: Graph2DSpec;
  axisLabelShapeIdsByKey?: SelectedOverlayGraph["axisLabelShapeIdsByKey"];
  axisLabelTextsByKey?: SelectedOverlayGraph["axisLabelTextsByKey"];
} = {}): SelectedOverlayGraph {
  return {
    shapeId: options.shapeId ?? "graph-1",
    spec: options.spec ?? graphSpec(),
    axisLabelShapeIdsByKey: options.axisLabelShapeIdsByKey ?? {
      x: "label-x",
      y: "label-y",
      origin: "label-origin",
    },
    axisLabelTextsByKey: options.axisLabelTextsByKey ?? {
      x: "x",
      y: "y",
      origin: "O",
    },
    formulaLabelShapeIds: [],
    formulaLabelShapeIdsByCurveId: {},
    pickingOrigin: false,
    pickingFill: false,
    onSpecChange: vi.fn(),
    onAxisLabelChange: vi.fn(),
    onAxisLabelTextChange: vi.fn(),
    onFormulaLabelChange: vi.fn(),
    onStartCrop: vi.fn(),
    onStartOriginPick: vi.fn(),
    onStartFillPick: vi.fn(),
    onClose: vi.fn(),
  };
}

describe("overlay graph pending edits", () => {
  it("keeps y unchecked when an older detail still contains the y label", () => {
    const pending = recordPendingOverlayGraphAxisLabelEdit(null, "graph-1", "y", {
      visible: false,
    });

    const result = mergeOverlayGraphDetailWithPending(graphDetail(), pending);

    expect(result.detail.axisLabelShapeIdsByKey).not.toHaveProperty("y");
    expect(result.detail.spec.axes.yLabel).toBe("");
    expect(result.pending?.axisLabels.get("y")).toMatchObject({
      visible: false,
      unmatchedDetailCount: 1,
    });
  });

  it("removes a pending uncheck once the detail reflects it", () => {
    const pending = recordPendingOverlayGraphAxisLabelEdit(null, "graph-1", "y", {
      visible: false,
    });
    const detail = graphDetail({
      spec: graphSpec({ axes: { ...graphSpec().axes, yLabel: "" } }),
      axisLabelShapeIdsByKey: {
        x: "label-x",
        origin: "label-origin",
      },
    });

    const result = mergeOverlayGraphDetailWithPending(detail, pending);

    expect(result.detail).toBe(detail);
    expect(result.pending).toBeNull();
  });

  it("reapplies a pending spec until an equivalent detail arrives", () => {
    const nextSpec = graphSpec({ title: "更新後" });
    const pending = recordPendingOverlayGraphSpecEdit(null, "graph-1", nextSpec);

    const staleResult = mergeOverlayGraphDetailWithPending(graphDetail(), pending);
    expect(staleResult.detail.spec).toBe(nextSpec);
    expect(staleResult.pending?.spec?.unmatchedDetailCount).toBe(1);

    const reflectedDetail = graphDetail({ spec: { ...nextSpec } });
    const reflectedResult = mergeOverlayGraphDetailWithPending(reflectedDetail, staleResult.pending);
    expect(reflectedResult.detail).toBe(reflectedDetail);
    expect(reflectedResult.pending).toBeNull();
  });

  it("lets detail win after the pending edit misses the safety limit", () => {
    let pending: PendingOverlayGraphEdits | null = recordPendingOverlayGraphAxisLabelEdit(
      null,
      "graph-1",
      "y",
      { visible: false },
    );
    const staleDetail = graphDetail();
    let mergedDetail = staleDetail;

    for (let index = 0; index < MAX_PENDING_OVERLAY_GRAPH_DETAIL_MISSES; index += 1) {
      const result = mergeOverlayGraphDetailWithPending(staleDetail, pending);
      mergedDetail = result.detail;
      pending = result.pending;
    }

    expect(mergedDetail).toBe(staleDetail);
    expect(mergedDetail.axisLabelShapeIdsByKey.y).toBe("label-y");
    expect(pending).toBeNull();
  });

  it("drops pending edits when the selected shape changes", () => {
    const pending = recordPendingOverlayGraphAxisLabelEdit(null, "graph-1", "y", {
      visible: false,
    });
    const detail = graphDetail({ shapeId: "graph-2" });

    expect(mergeOverlayGraphDetailWithPending(detail, pending)).toEqual({
      detail,
      pending: null,
    });
  });
});
