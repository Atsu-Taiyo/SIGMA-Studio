import type { SelectedOverlayGraph } from "@/components/editor/EditorSettings";
import { areGraphSpecsEqual } from "@/components/editor/editor-shell/document-helpers";
import type { Graph2DSpec, OverlayGraphAxisLabelKey } from "@/features/document";

const PENDING_AXIS_LABEL_SHAPE_ID = "__pending_axis_label__";

export const MAX_PENDING_OVERLAY_GRAPH_DETAIL_MISSES = 5;

export interface PendingOverlayGraphAxisLabelEdit {
  visible: boolean;
  text?: string;
  unmatchedDetailCount: number;
}

export interface PendingOverlayGraphSpecEdit {
  value: Graph2DSpec;
  unmatchedDetailCount: number;
}

export interface PendingOverlayGraphEdits {
  shapeId: string;
  axisLabels: ReadonlyMap<OverlayGraphAxisLabelKey, PendingOverlayGraphAxisLabelEdit>;
  spec?: PendingOverlayGraphSpecEdit;
}

export function recordPendingOverlayGraphAxisLabelEdit(
  pending: PendingOverlayGraphEdits | null,
  shapeId: string,
  key: OverlayGraphAxisLabelKey,
  edit: Pick<PendingOverlayGraphAxisLabelEdit, "visible" | "text">,
): PendingOverlayGraphEdits {
  const next = pendingForShape(pending, shapeId);
  const axisLabels = new Map(next.axisLabels);
  axisLabels.set(key, {
    ...edit,
    unmatchedDetailCount: 0,
  });
  return { ...next, axisLabels };
}

export function recordPendingOverlayGraphSpecEdit(
  pending: PendingOverlayGraphEdits | null,
  shapeId: string,
  spec: Graph2DSpec,
): PendingOverlayGraphEdits {
  const next = pendingForShape(pending, shapeId);
  return {
    ...next,
    spec: {
      value: spec,
      unmatchedDetailCount: 0,
    },
  };
}

export function applyOverlayGraphAxisLabelEdit(
  detail: SelectedOverlayGraph,
  key: OverlayGraphAxisLabelKey,
  edit: Pick<PendingOverlayGraphAxisLabelEdit, "visible" | "text">,
): SelectedOverlayGraph {
  const axisLabelShapeIdsByKey = { ...detail.axisLabelShapeIdsByKey };
  if (edit.visible) {
    axisLabelShapeIdsByKey[key] = axisLabelShapeIdsByKey[key] ?? PENDING_AXIS_LABEL_SHAPE_ID;
  } else {
    delete axisLabelShapeIdsByKey[key];
  }

  const axisLabelTextsByKey = edit.text === undefined
    ? detail.axisLabelTextsByKey
    : { ...detail.axisLabelTextsByKey, [key]: edit.text };
  const spec = applyAxisLabelEditToSpec(detail.spec, key, edit);

  return {
    ...detail,
    spec,
    axisLabelShapeIdsByKey,
    axisLabelTextsByKey,
  };
}

export function mergeOverlayGraphDetailWithPending(
  detail: SelectedOverlayGraph,
  pending: PendingOverlayGraphEdits | null,
  maxUnmatchedDetailCount = MAX_PENDING_OVERLAY_GRAPH_DETAIL_MISSES,
): {
  detail: SelectedOverlayGraph;
  pending: PendingOverlayGraphEdits | null;
} {
  if (!pending || pending.shapeId !== detail.shapeId) {
    return { detail, pending: null };
  }

  let mergedDetail = detail;
  const axisLabels = new Map<OverlayGraphAxisLabelKey, PendingOverlayGraphAxisLabelEdit>();

  for (const [key, edit] of pending.axisLabels) {
    if (axisLabelEditIsReflected(detail, key, edit)) {
      continue;
    }

    const unmatchedDetailCount = edit.unmatchedDetailCount + 1;
    if (unmatchedDetailCount >= maxUnmatchedDetailCount) {
      continue;
    }

    mergedDetail = applyOverlayGraphAxisLabelEdit(mergedDetail, key, edit);
    axisLabels.set(key, { ...edit, unmatchedDetailCount });
  }

  let spec: PendingOverlayGraphSpecEdit | undefined;
  if (pending.spec && !areGraphSpecsEqual(detail.spec, pending.spec.value)) {
    const unmatchedDetailCount = pending.spec.unmatchedDetailCount + 1;
    if (unmatchedDetailCount < maxUnmatchedDetailCount) {
      mergedDetail = { ...mergedDetail, spec: pending.spec.value };
      spec = { ...pending.spec, unmatchedDetailCount };
    }
  }

  return {
    detail: mergedDetail,
    pending: axisLabels.size > 0 || spec
      ? {
          shapeId: pending.shapeId,
          axisLabels,
          ...(spec ? { spec } : {}),
        }
      : null,
  };
}

function pendingForShape(
  pending: PendingOverlayGraphEdits | null,
  shapeId: string,
): PendingOverlayGraphEdits {
  if (pending?.shapeId === shapeId) {
    return pending;
  }

  return {
    shapeId,
    axisLabels: new Map(),
  };
}

function axisLabelEditIsReflected(
  detail: SelectedOverlayGraph,
  key: OverlayGraphAxisLabelKey,
  edit: PendingOverlayGraphAxisLabelEdit,
): boolean {
  const visible = detail.axisLabelShapeIdsByKey[key] !== undefined;
  const textMatches = edit.text === undefined || detail.axisLabelTextsByKey[key] === edit.text;
  return visible === edit.visible && textMatches;
}

function applyAxisLabelEditToSpec(
  spec: Graph2DSpec,
  key: OverlayGraphAxisLabelKey,
  edit: Pick<PendingOverlayGraphAxisLabelEdit, "visible" | "text">,
): Graph2DSpec {
  const text = edit.text ?? (edit.visible ? undefined : "");
  if (text === undefined) {
    return spec;
  }

  const field = key === "x" ? "xLabel" : key === "y" ? "yLabel" : "originLabel";
  if (spec.axes[field] === text) {
    return spec;
  }

  return {
    ...spec,
    axes: {
      ...spec.axes,
      [field]: text,
    },
  };
}
