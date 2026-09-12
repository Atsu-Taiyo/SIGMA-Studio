import {
  clearMaterializedGraphLabelTexts,
  GRAPH_AXIS_LABEL_KEYS,
  getExistingGraphAxisLabelTextShapeIdsByKey,
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getTiptapLabelText,
  hydrateGraphSpecWithOwnedLabelTexts,
  isOverlayGraphAxisLabelKey,
  type Graph2DSpec,
} from "@/features/document";

import { resolveShapeAnchorPositions } from "../anchor";
import { normalizeOverlayGroups } from "../grouping";
import { areOverlayAnchorsEqual } from "../reanchor-model";
import type { OverlayGraphAxisLabelKey, OverlayGraphShape, OverlayShape, OverlayShapeId } from "../types";
import {
  GRAPH_SHAPE_TYPE,
  createGraphAnnotationLabelShapeEntries,
  createGraphAxisLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphPointLabelShapeEntries,
  getGraphFormulaLabelEntries,
  getGraphOwnedTextLabelCropSyncPatch,
  isGraphLabelTextShape,
} from "./graph";

export {
  GRAPH_AXIS_LABEL_KEYS,
  clearMaterializedGraphLabelTexts,
  getExistingGraphAxisLabelTextShapeIdsByKey,
  getGraphAxisLabelSpecText,
  getGraphAxisLabelTextsByKey,
  getOverlayTextBlocksLabelText,
  getTiptapLabelText,
  hydrateGraphSpecWithOwnedLabelTexts,
  isOverlayGraphAxisLabelKey,
};

export function materializeMissingGraphOwnedTextLabels(
  shapes: OverlayShape[],
  createShapeId: () => OverlayShapeId,
  canvasSize: { width: number; height: number } = { width: 1600, height: 1200 },
): OverlayShape[] {
  let nextShapes = shapes;
  const nextGraphById = new Map<OverlayShapeId, OverlayGraphShape>();
  const newLabelShapes: OverlayShape[] = [];

  for (const shape of shapes) {
    if (shape.type !== "graph2dShape") {
      continue;
    }

    let nextGraph = shape;
    let existingAxisLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(nextGraph, shapes);
    const axisKeys = getMissingGraphAxisLabelKeys(nextGraph, existingAxisLabelIdsByKey);
    if (axisKeys.length > 0) {
      const entries = createGraphAxisLabelShapeEntries(nextGraph, createShapeId, { keys: axisKeys });
      if (entries.length > 0) {
        const labelIdsByKey = {
          ...existingAxisLabelIdsByKey,
          ...Object.fromEntries(entries.map((entry) => [entry.key, entry.shape.id])),
        };
        existingAxisLabelIdsByKey = labelIdsByKey;
        nextGraph = withGraphAxisLabelTextShapeIds(nextGraph, labelIdsByKey);
        newLabelShapes.push(...entries.map((entry) => entry.shape));
      }
    }
    if (areGraphFixedAxisLabelsBackedByTextShapes(nextGraph, existingAxisLabelIdsByKey)) {
      nextGraph = clearGraphFixedAxisLabels(nextGraph);
    }

    const existingPointLabelIdsByPointId = getExistingGraphPointLabelTextShapeIdsByPointId(nextGraph, shapes);
    const missingPointLabelIds = (nextGraph.props.spec.points ?? [])
      .filter((point) => Boolean(point.label?.trim()))
      .map((point) => point.id)
      .filter((pointId) => !existingPointLabelIdsByPointId[pointId]);
    if (missingPointLabelIds.length > 0) {
      const entries = createGraphPointLabelShapeEntries(nextGraph, createShapeId, { pointIds: missingPointLabelIds });
      if (entries.length > 0) {
        const labelIdsByPointId = {
          ...existingPointLabelIdsByPointId,
          ...Object.fromEntries(entries.map((entry) => [entry.pointId, entry.shape.id])),
        };
        nextGraph = withGraphPointLabelTextShapeIds(nextGraph, labelIdsByPointId);
        newLabelShapes.push(...entries.map((entry) => entry.shape));
      }
    }

    const existingAnnotationLabelIdsByAnnotationId = getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(nextGraph, shapes);
    const missingAnnotationLabelIds = (nextGraph.props.spec.annotations ?? [])
      .filter((annotation) => Boolean(annotation.text.trim()))
      .map((annotation) => annotation.id)
      .filter((annotationId) => !existingAnnotationLabelIdsByAnnotationId[annotationId]);
    if (missingAnnotationLabelIds.length > 0) {
      const entries = createGraphAnnotationLabelShapeEntries(nextGraph, createShapeId, { annotationIds: missingAnnotationLabelIds });
      if (entries.length > 0) {
        const labelIdsByAnnotationId = {
          ...existingAnnotationLabelIdsByAnnotationId,
          ...Object.fromEntries(entries.map((entry) => [entry.annotationId, entry.shape.id])),
        };
        nextGraph = withGraphAnnotationLabelTextShapeIds(nextGraph, labelIdsByAnnotationId);
        newLabelShapes.push(...entries.map((entry) => entry.shape));
      }
    }

    if (nextGraph.props.spec.showFormulaLabels === true) {
      const existingFormulaLabelIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(nextGraph, shapes);
      const missingFormulaLabelCurveIds = nextGraph.props.spec.curves
        .map((curve) => curve.id)
        .filter((curveId) => !existingFormulaLabelIdsByCurveId[curveId]);
      if (missingFormulaLabelCurveIds.length > 0) {
        const entries = createGraphFormulaLabelShapeEntries(
          nextGraph,
          createShapeId,
          canvasSize,
          { curveIds: missingFormulaLabelCurveIds },
        );
        if (entries.length > 0) {
          nextGraph = withGraphLabelTextShapeIds(nextGraph, {
            ...existingFormulaLabelIdsByCurveId,
            ...Object.fromEntries(entries.map((entry) => [entry.curveId, entry.shape.id])),
          });
          newLabelShapes.push(...entries.map((entry) => entry.shape));
        }
      }
    }

    nextGraph = clearMaterializedGraphLabelTexts(nextGraph);
    if (nextGraph !== shape) {
      nextGraphById.set(shape.id, nextGraph);
    }
  }

  if (nextGraphById.size > 0 || newLabelShapes.length > 0) {
    nextShapes = normalizeOverlayGroups(
      shapes
        .map((shape) => nextGraphById.get(shape.id) ?? shape)
        .concat(newLabelShapes),
    );
  }

  let synced = nextShapes;
  for (const shape of synced) {
    if (shape.type !== "graph2dShape") {
      continue;
    }
    const nextGraph = nextGraphById.get(shape.id) ?? shape;
    synced = syncGraphOwnedLabelTextShapePositions(synced, nextGraph);
  }

  return synced;
}

export function getMissingGraphAxisLabelKeys(
  shape: OverlayGraphShape,
  existingLabelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>>,
): OverlayGraphAxisLabelKey[] {
  const keys: OverlayGraphAxisLabelKey[] = [];
  if (shape.props.spec.axes.xLabel?.trim() && !existingLabelIdsByKey.x) {
    keys.push("x");
  }
  if (shape.props.spec.axes.yLabel?.trim() && !existingLabelIdsByKey.y) {
    keys.push("y");
  }
  if (shape.props.spec.axes.originLabel?.trim() && !existingLabelIdsByKey.origin) {
    keys.push("origin");
  }
  return keys;
}

export function areGraphFixedAxisLabelsBackedByTextShapes(
  shape: OverlayGraphShape,
  existingLabelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>>,
): boolean {
  const fixedLabelKeys: OverlayGraphAxisLabelKey[] = [];
  if (shape.props.spec.axes.xLabel?.trim()) {
    fixedLabelKeys.push("x");
  }
  if (shape.props.spec.axes.yLabel?.trim()) {
    fixedLabelKeys.push("y");
  }
  if (shape.props.spec.axes.originLabel?.trim()) {
    fixedLabelKeys.push("origin");
  }
  return fixedLabelKeys.length > 0 && fixedLabelKeys.every((key) => Boolean(existingLabelIdsByKey[key]));
}

export function getExistingGraphLabelTextShapeIds(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): OverlayShapeId[] {
  return [
    ...Object.values(getExistingGraphAxisLabelTextShapeIdsByKey(shape, shapes))
      .filter((id): id is OverlayShapeId => typeof id === "string"),
    ...Object.values(getExistingGraphPointLabelTextShapeIdsByPointId(shape, shapes)),
    ...Object.values(getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(shape, shapes)),
    ...getOrderedGraphLabelTextShapeIds(
      shape.props.spec,
      getExistingGraphLabelTextShapeIdsByCurveId(shape, shapes),
    ),
  ];
}

export function getSelectedGraphShapeForSettings(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
): OverlayGraphShape | null {
  if (selectedIds.length !== 1) {
    return null;
  }

  const selectedShape = shapes.find((shape) => shape.id === selectedIds[0]);
  if (selectedShape?.type === GRAPH_SHAPE_TYPE) {
    return selectedShape;
  }
  if (!selectedShape || !isGraphLabelTextShape(selectedShape, shapes)) {
    return null;
  }

  return shapes.find((shape): shape is OverlayGraphShape => (
    shape.type === GRAPH_SHAPE_TYPE &&
    getExistingGraphLabelTextShapeIds(shape, shapes).includes(selectedShape.id)
  )) ?? null;
}

export function getExistingGraphPointLabelTextShapeIdsByPointId(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Record<string, OverlayShapeId> {
  const textShapeIds = getTextShapeIdSet(shapes);
  const pointIds = new Set((shape.props.spec.points ?? []).map((point) => point.id));
  const labelIdsByPointId: Record<string, OverlayShapeId> = {};

  for (const [pointId, labelId] of Object.entries(shape.props.pointLabelTextShapeIdsByPointId ?? {})) {
    if (!pointIds.has(pointId) || !textShapeIds.has(labelId)) {
      continue;
    }
    labelIdsByPointId[pointId] = labelId;
  }

  return labelIdsByPointId;
}

export function getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Record<string, OverlayShapeId> {
  const textShapeIds = getTextShapeIdSet(shapes);
  const annotationIds = new Set((shape.props.spec.annotations ?? []).map((annotation) => annotation.id));
  const labelIdsByAnnotationId: Record<string, OverlayShapeId> = {};

  for (const [annotationId, labelId] of Object.entries(shape.props.annotationTextShapeIdsByAnnotationId ?? {})) {
    if (!annotationIds.has(annotationId) || !textShapeIds.has(labelId)) {
      continue;
    }
    labelIdsByAnnotationId[annotationId] = labelId;
  }

  return labelIdsByAnnotationId;
}

export function getExistingGraphLabelTextShapeIdsByCurveId(
  shape: OverlayGraphShape,
  shapes: OverlayShape[],
): Record<string, OverlayShapeId> {
  const textShapeIds = new Set(
    shapes
      .filter((item) => item.type === "text")
      .map((item) => item.id),
  );
  const curveIds = new Set(shape.props.spec.curves.map((curve) => curve.id));
  const usedTextShapeIds = new Set<OverlayShapeId>();
  const labelIdsByCurveId: Record<string, OverlayShapeId> = {};

  for (const [curveId, labelId] of Object.entries(shape.props.labelTextShapeIdsByCurveId ?? {})) {
    if (!curveIds.has(curveId) || !textShapeIds.has(labelId)) {
      continue;
    }
    labelIdsByCurveId[curveId] = labelId;
    usedTextShapeIds.add(labelId);
  }

  const unkeyedLabelIds = (shape.props.labelTextShapeIds ?? [])
    .filter((id) => textShapeIds.has(id) && !usedTextShapeIds.has(id));
  const labelableCurveIds = getGraphFormulaLabelEntries(shape.props.spec).map((entry) => entry.curveId);
  let unkeyedLabelIndex = 0;
  for (const curveId of labelableCurveIds) {
    if (labelIdsByCurveId[curveId]) {
      continue;
    }

    const unkeyedLabelId = unkeyedLabelIds[unkeyedLabelIndex];
    if (!unkeyedLabelId) {
      break;
    }
    labelIdsByCurveId[curveId] = unkeyedLabelId;
    unkeyedLabelIndex += 1;
  }

  return labelIdsByCurveId;
}

export function withGraphLabelTextShapeIds(
  shape: OverlayGraphShape,
  labelIdsByCurveId: Record<string, OverlayShapeId>,
): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      labelTextShapeIds: getOrderedGraphLabelTextShapeIds(shape.props.spec, labelIdsByCurveId),
      labelTextShapeIdsByCurveId: labelIdsByCurveId,
    },
  };
}

export function withGraphAxisLabelTextShapeIds(
  shape: OverlayGraphShape,
  labelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>>,
): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      axisLabelTextShapeIds: labelIdsByKey,
    },
  };
}

export function withGraphPointLabelTextShapeIds(
  shape: OverlayGraphShape,
  labelIdsByPointId: Record<string, OverlayShapeId>,
): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      pointLabelTextShapeIdsByPointId: labelIdsByPointId,
    },
  };
}

export function withGraphAnnotationLabelTextShapeIds(
  shape: OverlayGraphShape,
  labelIdsByAnnotationId: Record<string, OverlayShapeId>,
): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      annotationTextShapeIdsByAnnotationId: labelIdsByAnnotationId,
    },
  };
}

export function clearGraphFixedAxisLabels(shape: OverlayGraphShape): OverlayGraphShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      spec: {
        ...shape.props.spec,
        axes: {
          ...shape.props.spec.axes,
          xLabel: "",
          yLabel: "",
          originLabel: "",
        },
      },
    },
  };
}

export function syncGraphOwnedLabelTextShapePositions(
  shapes: OverlayShape[],
  graphShape: OverlayGraphShape,
  options: { preserveExistingPositions?: boolean } = {},
): OverlayShape[] {
  // Persisted graphs keep label content in their owned text shapes, not duplicated in the graph
  // spec. Layout helpers still need that content to build point/annotation templates. Hydrate a
  // transient shape for layout only; otherwise any unrelated graph settings edit sees the cleared
  // canonical spec, produces no template, and incorrectly hides those owned labels.
  const layoutGraphShape: OverlayGraphShape = {
    ...graphShape,
    props: {
      ...graphShape.props,
      spec: hydrateGraphSpecWithOwnedLabelTexts(graphShape, shapes),
    },
  };
  const currentLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(graphShape, shapes);
  const axisEntries = createGraphAxisLabelShapeEntries(layoutGraphShape, () => "", {
    keys: Object.keys(currentLabelIdsByKey).filter(isOverlayGraphAxisLabelKey),
  });
  const currentLabelIdsByPointId = getExistingGraphPointLabelTextShapeIdsByPointId(graphShape, shapes);
  const pointEntries = createGraphPointLabelShapeEntries(layoutGraphShape, () => "", {
    pointIds: Object.keys(currentLabelIdsByPointId),
  });
  const currentLabelIdsByAnnotationId = getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(graphShape, shapes);
  const annotationEntries = createGraphAnnotationLabelShapeEntries(layoutGraphShape, () => "", {
    annotationIds: Object.keys(currentLabelIdsByAnnotationId),
  });
  const entries = [
    ...axisEntries.map((entry) => ({ key: `axis:${entry.key}`, shape: entry.shape })),
    ...pointEntries.map((entry) => ({ key: `point:${entry.pointId}`, shape: entry.shape })),
    ...annotationEntries.map((entry) => ({ key: `annotation:${entry.annotationId}`, shape: entry.shape })),
  ];
  const entriesByKey = new Map(entries.map((entry) => [entry.key, entry.shape]));
  let changed = false;
  const next = shapes.map((shape) => {
    if (shape.type !== "text") {
      return shape;
    }

    const key = findGraphOwnedLabelKeyForShapeId(
      shape.id,
      currentLabelIdsByKey,
      currentLabelIdsByPointId,
      currentLabelIdsByAnnotationId,
    );
    if (!key) {
      return shape;
    }
    const template = entriesByKey.get(key);
    if (!template) {
      if (shape.hidden) {
        return shape;
      }
      changed = true;
      return { ...shape, hidden: true } as OverlayShape;
    }
    const templateAnchor = template.anchor;
    if (!templateAnchor || templateAnchor.type !== "shape") {
      return shape;
    }

    if (options.preserveExistingPositions) {
      const patch = getGraphOwnedTextLabelCropSyncPatch(graphShape, shape, template);
      const nextAnchor = patch.anchor;
      if (!nextAnchor || nextAnchor.type !== "shape") {
        return shape;
      }

      const anchorUnchanged = areOverlayAnchorsEqual(nextAnchor, shape.anchor);
      const hiddenUnchanged = patch.hidden === shape.hidden || (patch.hidden === undefined && !shape.hidden);
      const xUnchanged = patch.x === undefined || patch.x === shape.x;
      const yUnchanged = patch.y === undefined || patch.y === shape.y;
      if (anchorUnchanged && hiddenUnchanged && xUnchanged && yUnchanged) {
        return shape;
      }

      changed = true;
      return {
        ...shape,
        ...patch,
      } as OverlayShape;
    }

    const nextAnchor = shape.anchor?.type === "shape"
      ? {
          ...templateAnchor,
          dx: shape.anchor.dx,
          dy: shape.anchor.dy,
        }
      : templateAnchor;
    // The final x/y is re-derived from the anchor by resolveShapeAnchorPositions
    // below, so only the anchor and hidden flag matter here. Keying `changed` on
    // the throwaway syncedX/syncedY made this sync fight resolveShapeAnchorPositions
    // (sync sets a template position, resolve reverts it to the anchored position),
    // so on docs with graph labels the editor's [shapes] effect setState'd forever
    // ("Maximum update depth exceeded") and figures could not be dragged. Preserve
    // object identity when nothing meaningful changed so the effect converges.
    const anchorUnchanged = areOverlayAnchorsEqual(nextAnchor, shape.anchor);
    const hiddenUnchanged = !shape.hidden;
    if (anchorUnchanged && hiddenUnchanged) {
      return shape;
    }

    const syncedX = template.x + nextAnchor.dx - templateAnchor.dx;
    const syncedY = template.y + nextAnchor.dy - templateAnchor.dy;
    changed = true;
    return {
      ...shape,
      x: syncedX,
      y: syncedY,
      hidden: undefined,
      anchor: nextAnchor,
    } as OverlayShape;
  });

  return resolveShapeAnchorPositions(changed ? next : shapes);
}

export function getTextShapeIdSet(shapes: OverlayShape[]): Set<OverlayShapeId> {
  return new Set(
    shapes
      .filter((item) => item.type === "text")
      .map((item) => item.id),
  );
}

export function findGraphOwnedLabelKeyForShapeId(
  shapeId: OverlayShapeId,
  axisLabelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>>,
  pointLabelIdsByPointId: Record<string, OverlayShapeId>,
  annotationLabelIdsByAnnotationId: Record<string, OverlayShapeId>,
): string | null {
  const axisKey = findGraphAxisLabelKeyForShapeId(axisLabelIdsByKey, shapeId);
  if (axisKey) {
    return `axis:${axisKey}`;
  }

  for (const [pointId, id] of Object.entries(pointLabelIdsByPointId)) {
    if (id === shapeId) {
      return `point:${pointId}`;
    }
  }

  for (const [annotationId, id] of Object.entries(annotationLabelIdsByAnnotationId)) {
    if (id === shapeId) {
      return `annotation:${annotationId}`;
    }
  }

  return null;
}

export function findGraphAxisLabelKeyForShapeId(
  labelIdsByKey: Partial<Record<OverlayGraphAxisLabelKey, OverlayShapeId>>,
  shapeId: OverlayShapeId,
): OverlayGraphAxisLabelKey | null {
  for (const [key, id] of Object.entries(labelIdsByKey)) {
    if (id === shapeId && isOverlayGraphAxisLabelKey(key)) {
      return key;
    }
  }
  return null;
}

export function getOrderedGraphLabelTextShapeIds(
  spec: Graph2DSpec,
  labelIdsByCurveId: Record<string, OverlayShapeId>,
): OverlayShapeId[] {
  return spec.curves
    .map((curve) => labelIdsByCurveId[curve.id])
    .filter((id): id is OverlayShapeId => typeof id === "string");
}
