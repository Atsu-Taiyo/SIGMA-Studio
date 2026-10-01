"use client";

import { useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";
import { SELECT_OVERLAY_GRAPH_EVENT, type SelectedOverlayGraph } from "../EditorSettings";
import type { OverlayGraphAxisLabelKey, OverlayGraphShape, OverlayShape, OverlayShapeId } from "./types";
import type { OverlayInteractionAction } from "./interaction-mode";
import {
  createGraphAnnotationLabelShapeEntries, createGraphPointLabelShapeEntries,
  getGraphOwnedLabelTextSyncedProps, getGraphShapeSizeForSpec,
} from "./shapes/graph";
import {
  clearMaterializedGraphLabelTexts, getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId,
  getExistingGraphAxisLabelTextShapeIdsByKey, getExistingGraphLabelTextShapeIdsByCurveId,
  getExistingGraphPointLabelTextShapeIdsByPointId, getGraphAxisLabelTextsByKey,
  getOrderedGraphLabelTextShapeIds, getSelectedGraphShapeForSettings, hydrateGraphSpecWithOwnedLabelTexts,
  syncGraphOwnedLabelTextShapePositions, withGraphAnnotationLabelTextShapeIds,
  withGraphLabelTextShapeIds, withGraphPointLabelTextShapeIds,
} from "./shapes/graph-labels";
import { createOverlayShapeId } from "./ids";

interface Graph2DControllerDependencies {
  shapes: OverlayShape[];
  selectedIds: OverlayShapeId[];
  shapesRef: RefObject<OverlayShape[]>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  originPickShapeId: OverlayShapeId | null;
  graphFillPickShapeId: OverlayShapeId | null;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  setGraphAxisLabelText: (id: OverlayShapeId, key: OverlayGraphAxisLabelKey, text: string) => void;
  setGraphAxisLabelTextVisible: (id: OverlayShapeId, key: OverlayGraphAxisLabelKey, visible: boolean) => void;
  setGraphCurveFormulaLabelTextVisible: (id: OverlayShapeId, curveId: string, visible: boolean) => void;
}

/** Owns settings-panel selection, graph edits and synchronization of canonical graph-owned labels. */
export function useOverlayGraph2DController({
  shapes, selectedIds, shapesRef, setShapes, originPickShapeId, graphFillPickShapeId,
  setSelectedShapeIds, transitionMode, setGraphAxisLabelText,
  setGraphAxisLabelTextVisible, setGraphCurveFormulaLabelTextVisible,
}: Graph2DControllerDependencies): void {
  useEffect(() => {
    const selectedShape = getSelectedGraphShapeForSettings(shapes, selectedIds);
    if (!selectedShape) {
      window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail: null }));
      return;
    }

    const shapeId = selectedShape.id;
    const axisLabelShapeIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(selectedShape, shapes);
    const axisLabelTextsByKey = getGraphAxisLabelTextsByKey(selectedShape, shapes);
    const formulaLabelShapeIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(selectedShape, shapes);
    const inspectorSpec = hydrateGraphSpecWithOwnedLabelTexts(selectedShape, shapes);
    const detail: SelectedOverlayGraph = {
      shapeId,
      spec: inspectorSpec,
      axisLabelShapeIdsByKey,
      axisLabelTextsByKey,
      formulaLabelShapeIds: getOrderedGraphLabelTextShapeIds(selectedShape.props.spec, formulaLabelShapeIdsByCurveId),
      formulaLabelShapeIdsByCurveId,
      pickingOrigin: originPickShapeId === shapeId,
      pickingFill: graphFillPickShapeId === shapeId,
      onSpecChange: (nextSpec) => {
        setShapes((current) => {
          const graphShape = current.find((shape): shape is OverlayGraphShape => (
            shape.id === shapeId && shape.type === "graph2dShape"
          ));
          if (!graphShape) {
            return current;
          }
          const currentSpecWithOwnedLabels = hydrateGraphSpecWithOwnedLabelTexts(graphShape, current);

          const nextCurveIds = new Set(nextSpec.curves.map((curve) => curve.id));
          const currentLabelIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(graphShape, current);
          const nextLabelIdsByCurveId: Record<string, OverlayShapeId> = {};
          const removedLabelIds: OverlayShapeId[] = [];
          for (const [curveId, labelId] of Object.entries(currentLabelIdsByCurveId)) {
            if (nextCurveIds.has(curveId)) {
              nextLabelIdsByCurveId[curveId] = labelId;
            } else {
              removedLabelIds.push(labelId);
            }
          }

          const previousPointLabelsByPointId = new Map(
            (currentSpecWithOwnedLabels.points ?? []).map((point) => [point.id, point.label?.trim() ?? ""]),
          );
          const nextPointLabelsByPointId = new Map(
            (nextSpec.points ?? []).map((point) => [point.id, point.label?.trim() ?? ""]),
          );
          const nextPointIdsWithLabels = new Set((nextSpec.points ?? [])
            .filter((point) => Boolean(point.label?.trim()))
            .map((point) => point.id));
          const currentPointLabelIdsByPointId = getExistingGraphPointLabelTextShapeIdsByPointId(graphShape, current);
          const nextPointLabelIdsByPointId: Record<string, OverlayShapeId> = {};
          const missingPointLabelIds: string[] = [];
          for (const pointId of nextPointIdsWithLabels) {
            const labelId = currentPointLabelIdsByPointId[pointId];
            if (labelId) {
              nextPointLabelIdsByPointId[pointId] = labelId;
            } else {
              missingPointLabelIds.push(pointId);
            }
          }
          for (const [pointId, labelId] of Object.entries(currentPointLabelIdsByPointId)) {
            if (!nextPointIdsWithLabels.has(pointId)) {
              removedLabelIds.push(labelId);
            }
          }

          const previousAnnotationLabelsByAnnotationId = new Map(
            (currentSpecWithOwnedLabels.annotations ?? []).map((annotation) => [annotation.id, annotation.text.trim()]),
          );
          const nextAnnotationLabelsByAnnotationId = new Map(
            (nextSpec.annotations ?? []).map((annotation) => [annotation.id, annotation.text.trim()]),
          );
          const nextAnnotationIdsWithText = new Set((nextSpec.annotations ?? [])
            .filter((annotation) => Boolean(annotation.text.trim()))
            .map((annotation) => annotation.id));
          const currentAnnotationLabelIdsByAnnotationId = getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(graphShape, current);
          const nextAnnotationLabelIdsByAnnotationId: Record<string, OverlayShapeId> = {};
          const missingAnnotationLabelIds: string[] = [];
          for (const annotationId of nextAnnotationIdsWithText) {
            const labelId = currentAnnotationLabelIdsByAnnotationId[annotationId];
            if (labelId) {
              nextAnnotationLabelIdsByAnnotationId[annotationId] = labelId;
            } else {
              missingAnnotationLabelIds.push(annotationId);
            }
          }
          for (const [annotationId, labelId] of Object.entries(currentAnnotationLabelIdsByAnnotationId)) {
            if (!nextAnnotationIdsWithText.has(annotationId)) {
              removedLabelIds.push(labelId);
            }
          }

          const nextGraphSize = getGraphShapeSizeForSpec(graphShape, nextSpec);
          let nextGraph = withGraphLabelTextShapeIds({
            ...graphShape,
            props: {
              ...graphShape.props,
              spec: nextSpec,
              boundsMode: "plot",
              w: nextGraphSize.w,
              h: nextGraphSize.h,
            },
          }, nextLabelIdsByCurveId);
          const pointLabelShapeEntries = createGraphPointLabelShapeEntries(nextGraph, createOverlayShapeId, {
            pointIds: missingPointLabelIds,
          });
          for (const entry of pointLabelShapeEntries) {
            nextPointLabelIdsByPointId[entry.pointId] = entry.shape.id;
          }
          nextGraph = withGraphPointLabelTextShapeIds(nextGraph, nextPointLabelIdsByPointId);
          const annotationLabelShapeEntries = createGraphAnnotationLabelShapeEntries(nextGraph, createOverlayShapeId, {
            annotationIds: missingAnnotationLabelIds,
          });
          for (const entry of annotationLabelShapeEntries) {
            nextAnnotationLabelIdsByAnnotationId[entry.annotationId] = entry.shape.id;
          }
          nextGraph = withGraphAnnotationLabelTextShapeIds(nextGraph, nextAnnotationLabelIdsByAnnotationId);
          const changedPointLabelIds = [...nextPointIdsWithLabels].filter((pointId) => (
            previousPointLabelsByPointId.get(pointId) !== nextPointLabelsByPointId.get(pointId) &&
            Boolean(nextPointLabelIdsByPointId[pointId])
          ));
          const pointLabelPropsByShapeId = new Map(
            createGraphPointLabelShapeEntries(nextGraph, () => "", { pointIds: changedPointLabelIds })
              .map((entry) => [nextPointLabelIdsByPointId[entry.pointId], entry.shape.props]),
          );
          const changedAnnotationLabelIds = [...nextAnnotationIdsWithText].filter((annotationId) => (
            previousAnnotationLabelsByAnnotationId.get(annotationId) !== nextAnnotationLabelsByAnnotationId.get(annotationId) &&
            Boolean(nextAnnotationLabelIdsByAnnotationId[annotationId])
          ));
          const annotationLabelPropsByShapeId = new Map(
            createGraphAnnotationLabelShapeEntries(nextGraph, () => "", { annotationIds: changedAnnotationLabelIds })
              .map((entry) => [nextAnnotationLabelIdsByAnnotationId[entry.annotationId], entry.shape.props]),
          );
          // Materialize changed text before removing the duplicate labels from the saved spec.
          nextGraph = clearMaterializedGraphLabelTexts(nextGraph);
          const removeIdSet = new Set(removedLabelIds);
          const nextBeforeAxisSync = current
            .filter((shape) => !removeIdSet.has(shape.id))
            .map((shape) => {
              if (shape.id === shapeId) {
                return nextGraph;
              }
              // Same as above: graph-owned point/annotation labels are always "text" shapes,
              // never callout, so this text-only check is intentional.
              if (shape.type !== "text") {
                return shape;
              }
              const syncedProps = pointLabelPropsByShapeId.get(shape.id) ?? annotationLabelPropsByShapeId.get(shape.id);
              if (!syncedProps) {
                return shape;
              }
              return {
                ...shape,
                props: {
                  ...shape.props,
                  ...getGraphOwnedLabelTextSyncedProps(syncedProps),
                },
              } as OverlayShape;
            })
            .concat(pointLabelShapeEntries.map((entry) => entry.shape))
            .concat(annotationLabelShapeEntries.map((entry) => entry.shape));
          const next = syncGraphOwnedLabelTextShapePositions(nextBeforeAxisSync, nextGraph);
          shapesRef.current = next;
          return next;
        });
      },
      onStartOriginPick: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode({ type: "pickOrigin", shapeId });
      },
      onStartFillPick: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode(graphFillPickShapeId === shapeId ? { type: "select" } : { type: "pickGraphFill", shapeId });
      },
      onAxisLabelChange: (key, visible) => setGraphAxisLabelTextVisible(shapeId, key, visible),
      onAxisLabelTextChange: (key, text) => setGraphAxisLabelText(shapeId, key, text),
      onFormulaLabelChange: (curveId, visible) => setGraphCurveFormulaLabelTextVisible(shapeId, curveId, visible),
      onStartCrop: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode({ type: "editGraph", shapeId });
      },
      onClose: () => setSelectedShapeIds([]),
    };

    window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail }));
  }, [
    graphFillPickShapeId,
    originPickShapeId,
    selectedIds,
    setGraphAxisLabelText,
    setGraphAxisLabelTextVisible,
    setGraphCurveFormulaLabelTextVisible,
    setSelectedShapeIds,
    shapes,
    setShapes,
    shapesRef,
    transitionMode,
  ]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail: null }));
    };
  }, []);

}
