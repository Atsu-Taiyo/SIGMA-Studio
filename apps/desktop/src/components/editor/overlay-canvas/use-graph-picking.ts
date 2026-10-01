"use client";
import {
  GRAPH_FILL_UNRESOLVED_EVENT
} from "@/components/editor/EditorSettings";
import {
  type Graph2DSpec
} from "@/features/document";
import { createGraphFillId, toggleGraphFillAtPoint } from "@/lib/graph-fill";
import {
  getGraphNumericRange,
  getGraphPlotBox,
  moveGraphOriginToRatios,
  unmapGraphPoint
} from "@/lib/graph2d";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction
} from "react";
import {
  useCallback
} from "react";
import {
  type OverlayChangeOptions
} from "../page-overlay-types";
import { areOriginPickPreviewsEqual, graphSvgPointFromClient } from "./interaction-geometry";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import type { OriginPickPreview } from "./shape-editors";
import {
  getGraphDisplaySpec
} from "./shapes/graph";
import type {
  OverlayGraphShape,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export interface Dependencies {
  shapesRef: RefObject<OverlayShape[]>;
  pagePointFromClient: (clientX: number, clientY: number, cachedRect?: { left: number; top: number; width: number; height: number; } | null) => OverlayPoint;
  originPickShapeId: string | null;
  setOriginPickPreview: Dispatch<SetStateAction<OriginPickPreview | null>>;
  updateGraphShapeSpec: (shapeId: OverlayShapeId, spec: Graph2DSpec, patch?: Partial<Pick<OverlayGraphShape, "x" | "y">>, options?: { preserveGraphOwnedLabelPositions?: boolean; }) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  graphFillPickShapeId: string | null;
}

export function useOverlayGraphPicking({
  shapesRef,
  pagePointFromClient,
  originPickShapeId,
  setOriginPickPreview,
  updateGraphShapeSpec,
  queueOverlaySave,
  transitionMode,
  graphFillPickShapeId,
}: Dependencies) {

  const getOriginPickPreviewFromClientPoint = useCallback((
    shapeId: OverlayShapeId,
    clientX: number,
    clientY: number,
  ): OriginPickPreview | null => {
    const shape = shapesRef.current.find((item): item is OverlayGraphShape => item.id === shapeId && item.type === "graph2dShape");
    if (!shape) {
      return null;
    }

    const spec = getGraphDisplaySpec(shape);
    const plotBox = getGraphPlotBox(spec);
    const plotWidth = spec.width - plotBox.left - plotBox.right;
    const plotHeight = spec.height - plotBox.top - plotBox.bottom;
    const svgPoint = graphSvgPointFromClient(shape, clientX, clientY, pagePointFromClient);
    if (!svgPoint || plotWidth <= 0 || plotHeight <= 0) {
      return null;
    }

    if (
      svgPoint.x < plotBox.left ||
      svgPoint.x > spec.width - plotBox.right ||
      svgPoint.y < plotBox.top ||
      svgPoint.y > spec.height - plotBox.bottom
    ) {
      return null;
    }

    return {
      shapeId,
      spec: moveGraphOriginToRatios(
        spec,
        (svgPoint.x - plotBox.left) / plotWidth,
        (svgPoint.y - plotBox.top) / plotHeight,
      ),
      point: svgPoint,
    };
  }, [pagePointFromClient, shapesRef]);

  const updateOriginPickPreviewFromEvent = useCallback((event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "clientY">) => {
    if (!originPickShapeId) {
      setOriginPickPreview(null);
      return;
    }

    const nextPreview = getOriginPickPreviewFromClientPoint(originPickShapeId, event.clientX, event.clientY);
    setOriginPickPreview((current) => (
      areOriginPickPreviewsEqual(current, nextPreview) ? current : nextPreview
    ));
  }, [getOriginPickPreviewFromClientPoint, originPickShapeId, setOriginPickPreview]);

  const handleOriginPickPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!originPickShapeId) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const graphElement = target?.closest(".graph-shape");
    if (!(graphElement instanceof HTMLElement) || graphElement.id !== originPickShapeId) {
      return;
    }

    const preview = getOriginPickPreviewFromClientPoint(originPickShapeId, event.clientX, event.clientY);
    if (!preview) {
      setOriginPickPreview(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    updateGraphShapeSpec(originPickShapeId, preview.spec);
    // Mark the local edit pending before leaving origin picking. Otherwise the
    // select-mode reconciliation can restore the pre-pick document snapshot
    // before the shapes effect has queued this edit for saving.
    queueOverlaySave();
    setOriginPickPreview(null);
    transitionMode({ type: "setTool", tool: { kind: "select" } });
  }, [getOriginPickPreviewFromClientPoint, originPickShapeId, queueOverlaySave, setOriginPickPreview, transitionMode, updateGraphShapeSpec]);

  const handleGraphFillPickPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!graphFillPickShapeId || event.defaultPrevented) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const graphElement = target?.closest(".graph-shape");
    if (!(graphElement instanceof HTMLElement) || graphElement.id !== graphFillPickShapeId) {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "select" });
      return;
    }

    const shape = shapesRef.current.find((item): item is OverlayGraphShape => item.id === graphFillPickShapeId && item.type === "graph2dShape");
    if (!shape) {
      return;
    }

    const spec = getGraphDisplaySpec(shape);
    if (spec.kind !== "cartesian") {
      return;
    }

    const reportUnresolvedFill = () => {
      window.dispatchEvent(new CustomEvent(GRAPH_FILL_UNRESOLVED_EVENT, {
        detail: { shapeId: graphFillPickShapeId },
      }));
    };

    const svgPoint = graphSvgPointFromClient(shape, event.clientX, event.clientY, pagePointFromClient);
    if (!svgPoint) {
      reportUnresolvedFill();
      return;
    }

    const plotBox = getGraphPlotBox(spec);
    let range: ReturnType<typeof getGraphNumericRange>;
    try {
      range = getGraphNumericRange(spec);
    } catch {
      reportUnresolvedFill();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const graphPoint = unmapGraphPoint(svgPoint.x, svgPoint.y, range, spec, plotBox);
    const nextSpec = toggleGraphFillAtPoint(spec, graphPoint, createGraphFillId());
    if (nextSpec === spec) {
      // 閉じた領域を解決できなかった。無反応に見えないよう設定パネルへ理由を渡す。
      reportUnresolvedFill();
      return;
    }

    updateGraphShapeSpec(graphFillPickShapeId, nextSpec);
  }, [graphFillPickShapeId, pagePointFromClient, shapesRef, transitionMode, updateGraphShapeSpec]);
  return { updateOriginPickPreviewFromEvent, handleOriginPickPointerDown, handleGraphFillPickPointerDown };
}
