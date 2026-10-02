"use client";
import {
  SELECT_OVERLAY_CHART_EVENT,
  type SelectedOverlayChart
} from "@/components/editor/EditorSettings";
import {
  resolveChartData,
  type SigmaChartSpec
} from "@/features/document";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback,
  useEffect
} from "react";
import {
  type OverlayChangeOptions
} from "../page-overlay-types";
import { createOverlayShapeId } from "./ids";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import {
  createGraphAxisLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  getGraphOwnedLabelTextSyncedProps
} from "./shapes/graph";
import {
  clearGraphFixedAxisLabels,
  getExistingGraphAxisLabelTextShapeIdsByKey,
  getExistingGraphLabelTextShapeIdsByCurveId,
  syncGraphOwnedLabelTextShapePositions,
  withGraphAxisLabelTextShapeIds,
  withGraphLabelTextShapeIds
} from "./shapes/graph-labels";
import type {
  OverlayGraphAxisLabelKey,
  OverlayGraphShape,
  OverlayShape,
  OverlayShapeId
} from "./types";
import { useOverlayGraph2DController } from "./use-graph2d-controller";

export interface Dependencies {
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  canvasWidthRef: RefObject<number>;
  canvasHeightRef: RefObject<number>;
  shapesRef: RefObject<OverlayShape[]>;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  selectedIds: string[];
  shapes: OverlayShape[];
  originPickShapeId: string | null;
  graphFillPickShapeId: string | null;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
}

export function useOverlayGraphLabelController({
  setShapes,
  canvasWidthRef,
  canvasHeightRef,
  shapesRef,
  queueOverlaySave,
  selectedIds,
  shapes,
  originPickShapeId,
  graphFillPickShapeId,
  setSelectedShapeIds,
  transitionMode,
}: Dependencies) {

  const setGraphCurveFormulaLabelTextVisible = useCallback((shapeId: OverlayShapeId, curveId: string, visible: boolean) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(graphShape, current);
      const currentLabelId = currentLabelIdsByCurveId[curveId];
      if (visible) {
        if (currentLabelId) {
          return current;
        }

        const nextVisibleCurveIds = graphShape.props.spec.curves
          .map((curve) => curve.id)
          .filter((id) => id === curveId || Boolean(currentLabelIdsByCurveId[id]));
        const labelShapeEntries = createGraphFormulaLabelShapeEntries(graphShape, createOverlayShapeId, {
          width: canvasWidthRef.current,
          height: canvasHeightRef.current,
        }, { curveIds: nextVisibleCurveIds });
        const nextLabelShapeEntry = labelShapeEntries.find((entry) => entry.curveId === curveId);
        if (!nextLabelShapeEntry) {
          return current;
        }

        const nextLabelIdsByCurveId = {
          ...currentLabelIdsByCurveId,
          [curveId]: nextLabelShapeEntry.shape.id,
        };
        const nextGraph = withGraphLabelTextShapeIds(graphShape, nextLabelIdsByCurveId);
        const next = current.map((shape) => (shape.id === shapeId ? nextGraph : shape)).concat(nextLabelShapeEntry.shape);
        shapesRef.current = next;
        return next;
      }

      if (!currentLabelId) {
        return current;
      }

      const nextLabelIdsByCurveId = { ...currentLabelIdsByCurveId };
      delete nextLabelIdsByCurveId[curveId];
      const removeIdSet = new Set([currentLabelId]);
      const next = current
        .filter((shape) => !removeIdSet.has(shape.id))
        .map((shape) => {
          if (shape.id !== shapeId || shape.type !== "graph2dShape") {
            return shape;
          }

          return withGraphLabelTextShapeIds(shape, nextLabelIdsByCurveId);
        });
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [canvasHeightRef, canvasWidthRef, queueOverlaySave, setShapes, shapesRef]);

  const setGraphAxisLabelTextVisible = useCallback((shapeId: OverlayShapeId, key: OverlayGraphAxisLabelKey, visible: boolean) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(graphShape, current);
      const currentLabelId = currentLabelIdsByKey[key];
      if (visible) {
        if (currentLabelId) {
          return current;
        }

        const labelShapeEntry = createGraphAxisLabelShapeEntries(graphShape, createOverlayShapeId, { keys: [key] })[0];
        if (!labelShapeEntry) {
          return current;
        }

        const nextLabelIdsByKey = {
          ...currentLabelIdsByKey,
          [key]: labelShapeEntry.shape.id,
        };
        const nextGraph = withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(graphShape), nextLabelIdsByKey);
        const next = current.map((shape) => (shape.id === shapeId ? nextGraph : shape)).concat(labelShapeEntry.shape);
        shapesRef.current = next;
        return next;
      }

      const nextLabelIdsByKey = { ...currentLabelIdsByKey };
      delete nextLabelIdsByKey[key];
      const removeIdSet = new Set(currentLabelId ? [currentLabelId] : []);
      const next = current
        .filter((shape) => !removeIdSet.has(shape.id))
        .map((shape) => {
          if (shape.id !== shapeId || shape.type !== "graph2dShape") {
            return shape;
          }

          return withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(shape), nextLabelIdsByKey);
        });
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave, setShapes, shapesRef]);

  const setGraphAxisLabelText = useCallback((shapeId: OverlayShapeId, key: OverlayGraphAxisLabelKey, text: string) => {
    const nextText = text.trim();
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(graphShape, current);
      const currentLabelId = currentLabelIdsByKey[key];
      if (!nextText) {
        const nextLabelIdsByKey = { ...currentLabelIdsByKey };
        delete nextLabelIdsByKey[key];
        const removeIdSet = new Set(currentLabelId ? [currentLabelId] : []);
        const next = current
          .filter((shape) => !removeIdSet.has(shape.id))
          .map((shape) => {
            if (shape.id !== shapeId || shape.type !== "graph2dShape") {
              return shape;
            }

            return withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(shape), nextLabelIdsByKey);
          });
        shapesRef.current = next;
        return next;
      }

      const labelShapeEntry = createGraphAxisLabelShapeEntries(graphShape, () => currentLabelId ?? createOverlayShapeId(), {
        keys: [key],
        labelsByKey: { [key]: nextText },
      })[0];
      if (!labelShapeEntry) {
        return current;
      }

      const nextLabelIdsByKey = {
        ...currentLabelIdsByKey,
        [key]: labelShapeEntry.shape.id,
      };
      const nextGraph = withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(graphShape), nextLabelIdsByKey);
      const nextBeforeSync = current
        .map((shape) => {
          if (shape.id === shapeId) {
            return nextGraph;
          }
          // Graph axis/point/annotation label shapes are always created as "text" (see
          // createGraphAxisLabelShapeEntries etc.); callout is never a graph-owned label, so
          // this stays text-only intentionally.
          if (shape.id !== currentLabelId || shape.type !== "text") {
            return shape;
          }
          return {
            ...shape,
            props: {
              ...shape.props,
              ...getGraphOwnedLabelTextSyncedProps(labelShapeEntry.shape.props),
            },
          } as OverlayShape;
        })
        .concat(currentLabelId ? [] : [labelShapeEntry.shape]);
      const next = syncGraphOwnedLabelTextShapePositions(nextBeforeSync, nextGraph);
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave, setShapes, shapesRef]);

  /**
   * Announces the selected chart to the shell, which owns the floating settings panel.
   *
   * The shell bails on an equal payload (`areSelectedOverlayChartsEqual`). Without that guard this
   * effect — which depends on `shapes` — dispatches on every commit, the shell calls `setState`, and
   * the two re-render each other indefinitely.
   */
  const handleChartSpecChange = useCallback((shapeId: OverlayShapeId, spec: SigmaChartSpec) => {
    setShapes((current) => {
      const next = current.map((shape) => (
        shape.id === shapeId && shape.type === "chartShape"
          ? { ...shape, props: { ...shape.props, spec } }
          : shape
      ));
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave, setShapes, shapesRef]);

  useEffect(() => {
    const selected = selectedIds.length === 1
      ? shapes.find((shape) => shape.id === selectedIds[0])
      : undefined;
    if (selected?.type !== "chartShape") {
      window.dispatchEvent(new CustomEvent<SelectedOverlayChart | null>(SELECT_OVERLAY_CHART_EVENT, { detail: null }));
      return;
    }
    const sourceTable = selected.props.sourceTableShapeId
      ? shapes.find((shape) => shape.id === selected.props.sourceTableShapeId)
      : undefined;
    const table = sourceTable?.type === "tableShape" ? sourceTable.props.table : null;
    window.dispatchEvent(new CustomEvent<SelectedOverlayChart | null>(SELECT_OVERLAY_CHART_EVENT, {
      detail: {
        shapeId: selected.id,
        spec: selected.props.spec,
        data: resolveChartData(selected.props, table),
        linked: table !== null,
        onSpecChange: (spec) => handleChartSpecChange(selected.id, spec),
      },
    }));
  }, [handleChartSpecChange, selectedIds, shapes]);

  useOverlayGraph2DController({
    shapes, selectedIds, shapesRef, setShapes, originPickShapeId, graphFillPickShapeId,
    setSelectedShapeIds, transitionMode, setGraphAxisLabelText,
    setGraphAxisLabelTextVisible, setGraphCurveFormulaLabelTextVisible,
  });
}
