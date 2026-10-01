"use client";
import {
  patchShape,
  upsertShape,
  type Graph2DSpec
} from "@/features/document";
import {
  getShapeBounds,
  getShapeRotation,
  isOverlayRichTextShape,
  preserveRotatedTextResizeTopLeft,
  sameOverlayShapeIds,
  sameOverlayShapeReferences,
  toggleOverlayShapeSelectionIds
} from "@/features/drawing";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback
} from "react";
import {
  type OverlayChangeHistory,
  type OverlayChangeOptions
} from "../page-overlay-types";
import {
  getShapeSelectionIds,
  normalizeOverlayGroups,
  orderShapeIdsByVisualStackOrder
} from "./grouping";
import {
  type OverlayInteractionAction,
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  syncMovedOverlayShapeAnchor
} from "./reanchor-model";
import {
  AnchorMeasurements
} from "./selection-handles";
import {
  GRAPH_SHAPE_TYPE,
  getGraphShapeSizeForSpec
} from "./shapes/graph";
import {
  syncGraphOwnedLabelTextShapePositions
} from "./shapes/graph-labels";
import type {
  OverlayBounds,
  OverlayGraphShape,
  OverlayShape,
  OverlayShapeId,
  OverlayShapePatch
} from "./types";

interface Dependencies {
  setRegionSelection: Dispatch<SetStateAction<{ documentId: string | undefined; revision: number; bounds: OverlayBounds; } | null>>;
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  setSelectedIds: Dispatch<SetStateAction<string[]>>;
  onSelectedCountChange: ((count: number) => void) | undefined;
  focusedGroupIdRef: RefObject<string | null>;
  transitionMode: (action: OverlayInteractionAction) => void;
  modeRef: RefObject<OverlayInteractionMode>;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  explicitlySavedShapeStatesRef: RefObject<WeakSet<OverlayShape[]>>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  commitOverlayChangeNow: (options?: OverlayChangeOptions) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  anchorMeasurementsRef: RefObject<AnchorMeasurements>;
}

export function useOverlayMutations({
  setRegionSelection,
  shapesRef,
  selectedIdsRef,
  setSelectedIds,
  onSelectedCountChange,
  focusedGroupIdRef,
  transitionMode,
  modeRef,
  activeTextEditorRef,
  explicitlySavedShapeStatesRef,
  setShapes,
  commitOverlayChangeNow,
  queueOverlaySave,
  anchorMeasurementsRef,
}: Dependencies) {

  const setSelectedShapeIds = useCallback((ids: OverlayShapeId[]) => {
    setRegionSelection(null);
    const uniqueIds = orderShapeIdsByVisualStackOrder(shapesRef.current, [...new Set(ids)]);
    if (sameOverlayShapeIds(selectedIdsRef.current, uniqueIds)) {
      return;
    }
    selectedIdsRef.current = uniqueIds;
    setSelectedIds(uniqueIds);
    onSelectedCountChange?.(uniqueIds.length);
  }, [onSelectedCountChange, selectedIdsRef, setRegionSelection, setSelectedIds, shapesRef]);

  const selectKnownShape = useCallback((shape: OverlayShape, options: { editing?: boolean } = {}) => {
    const nextIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
    setSelectedShapeIds(nextIds);
    if (options.editing && isOverlayRichTextShape(shape) && nextIds.length === 1 && nextIds[0] === shape.id) {
      transitionMode({ type: "editText", shapeId: shape.id });
    } else if (
      (
        modeRef.current.id !== "overlay.originPicking" &&
        modeRef.current.id !== "overlay.graphFillPicking"
      ) ||
      shape.type !== "graph2dShape"
    ) {
      transitionMode({ type: "select" });
    }
  }, [focusedGroupIdRef, modeRef, setSelectedShapeIds, shapesRef, transitionMode]);

  const selectShape = useCallback((id: OverlayShapeId) => {
    const shape = shapesRef.current.find((item) => item.id === id);
    if (shape) {
      selectKnownShape(shape);
      return;
    }

    setSelectedShapeIds([id]);
    transitionMode({ type: "select" });
  }, [selectKnownShape, setSelectedShapeIds, shapesRef, transitionMode]);

  const toggleShapeSelection = useCallback((ids: OverlayShapeId[]) => {
    activeTextEditorRef.current?.commands.blur();
    transitionMode({ type: "select" });
    setSelectedShapeIds(toggleOverlayShapeSelectionIds(selectedIdsRef.current, ids));
  }, [activeTextEditorRef, selectedIdsRef, setSelectedShapeIds, transitionMode]);

  const updateShape = useCallback((
    patch: OverlayShapePatch,
    options?: { commit?: boolean; history?: OverlayChangeHistory },
  ) => {
    const previousShape = shapesRef.current.find((shape) => (
      shape.id === patch.id && shape.type === patch.type
    ));
    let next = normalizeOverlayGroups(patchShape(shapesRef.current, patch));
    const patchedShape = next.find((shape) => (
      shape.id === patch.id && shape.type === patch.type
    ));
    if (
      previousShape &&
      patchedShape &&
      (previousShape.type === "text" || previousShape.type === "callout") &&
      patchedShape.type === previousShape.type &&
      getShapeRotation(patchedShape) !== 0 &&
      patch.x === undefined &&
      patch.y === undefined
    ) {
      const previousBounds = getShapeBounds(previousShape);
      const patchedBounds = getShapeBounds(patchedShape);
      if (previousBounds.w !== patchedBounds.w || previousBounds.h !== patchedBounds.h) {
        // Typing, the measured-height write-back, font size and size presets all reach this funnel.
        // Correcting here keeps one resize rule for every content-derived box change, while
        // explicit drag/handle patches stay authoritative because they carry x/y themselves.
        next = normalizeOverlayGroups(upsertShape(
          next,
          preserveRotatedTextResizeTopLeft(previousShape, patchedShape),
        ));
      }
    }
    if (sameOverlayShapeReferences(shapesRef.current, next)) {
      return;
    }

    if (options?.commit) {
      shapesRef.current = next;
      explicitlySavedShapeStatesRef.current.add(next);
      setShapes(next);
      commitOverlayChangeNow({ history: options.history });
      return;
    }

    shapesRef.current = next;
    if (options?.history) {
      explicitlySavedShapeStatesRef.current.add(next);
    }
    setShapes(next);
    if (options?.history) {
      queueOverlaySave({ history: options.history });
    }
  }, [commitOverlayChangeNow, explicitlySavedShapeStatesRef, queueOverlaySave, setShapes, shapesRef]);

  const updateGraphShapeSpec = useCallback((
    shapeId: OverlayShapeId,
    spec: Graph2DSpec,
    patch: Partial<Pick<OverlayGraphShape, "x" | "y">> = {},
    options: { preserveGraphOwnedLabelPositions?: boolean } = {},
  ) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === GRAPH_SHAPE_TYPE
      ));
      if (!graphShape) {
        return current;
      }

      const nextSize = getGraphShapeSizeForSpec(graphShape, spec);
      const nextGraph: OverlayGraphShape = {
        ...graphShape,
        ...patch,
        props: {
          ...graphShape.props,
          spec,
          boundsMode: "plot",
          w: nextSize.w,
          h: nextSize.h,
        },
      };
      const anchoredNextGraph =
        patch.x !== undefined || patch.y !== undefined
          ? syncMovedOverlayShapeAnchor(nextGraph, graphShape, current, anchorMeasurementsRef.current.rects)
          : nextGraph;
      const nextBeforeAxisSync = current.map((shape) => (shape.id === shapeId ? anchoredNextGraph : shape));
      const next = syncGraphOwnedLabelTextShapePositions(nextBeforeAxisSync, anchoredNextGraph, {
        preserveExistingPositions: options.preserveGraphOwnedLabelPositions === true,
      });
      shapesRef.current = next;
      return next;
    });
  }, [anchorMeasurementsRef, setShapes, shapesRef]);

  const replaceShape = useCallback((shape: OverlayShape) => {
    setShapes((current) => {
      const next = normalizeOverlayGroups(upsertShape(current, shape));
      shapesRef.current = next;
      return next;
    });
  }, [setShapes, shapesRef]);
  return {
    setSelectedShapeIds,
    replaceShape,
    updateShape,
    selectKnownShape,
    selectShape,
    updateGraphShapeSpec,
    toggleShapeSelection,
  };
}
