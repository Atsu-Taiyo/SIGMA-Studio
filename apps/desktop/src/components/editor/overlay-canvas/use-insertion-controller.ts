"use client";
import {
  upsertShape
} from "@/features/document";
import {
  isOverlayRichTextShape,
  pickStyleDefaultsForInsert,
  removeNearDuplicateDrawingPoints
} from "@/features/drawing";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback
} from "react";
import {
  type OverlayChangeOptions
} from "../page-overlay-types";
import {
  getGroupShape,
  normalizeOverlayGroups
} from "./grouping";
import { createOverlayShapeId } from "./ids";
import {
  type InsertTool,
  type OverlayInteractionAction
} from "./interaction-mode";
import {
  clamp
} from "./math";
import { rememberCalloutCornerRadius } from "./remembered-callout-radius";
import { readRememberedShapeStyle } from "./remembered-shape-style";
import { createChartShapeProps, getChartBoundsForTable } from "./shapes/chart";
import {
  buildInsertShape
} from "./shapes/create-shape";
import {
  createGraphAnnotationLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphPointLabelShapeEntries
} from "./shapes/graph";
import {
  clearMaterializedGraphLabelTexts,
  withGraphAnnotationLabelTextShapeIds,
  withGraphLabelTextShapeIds,
  withGraphPointLabelTextShapeIds
} from "./shapes/graph-labels";
import {
  TABLE_SHAPE_TYPE
} from "./shapes/table";
import type {
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export interface Dependencies {
  lastCalloutCornerRadiusRef: RefObject<number>;
  focusedGroupIdRef: RefObject<string | null>;
  shapesRef: RefObject<OverlayShape[]>;
  canvasWidthRef: RefObject<number>;
  canvasHeightRef: RefObject<number>;
  suppressNextSaveRef: RefObject<boolean>;
  insertedTableFocusRef: RefObject<string | null>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  selectKnownShape: (shape: OverlayShape, options?: { editing?: boolean; }) => void;
  commitOverlayChangeNow: (options?: OverlayChangeOptions) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  clearSnapGuides: () => void;
}

export function useOverlayInsertionController({
  lastCalloutCornerRadiusRef,
  focusedGroupIdRef,
  shapesRef,
  canvasWidthRef,
  canvasHeightRef,
  suppressNextSaveRef,
  insertedTableFocusRef,
  setShapes,
  selectKnownShape,
  commitOverlayChangeNow,
  queueOverlaySave,
  setSelectedShapeIds,
  transitionMode,
  clearSnapGuides,
}: Dependencies) {

  const createShapeFromInsertDrag = useCallback((
    tool: InsertTool,
    start: OverlayPoint,
    end: OverlayPoint,
    points?: OverlayPoint[],
    closed = false,
  ): OverlayShapeId | null => {
    const resolvedTool = tool.command === "callout" && tool.calloutRadius === undefined
      ? { ...tool, calloutRadius: lastCalloutCornerRadiusRef.current }
      : tool;
    const baseShape = buildInsertShape(
      resolvedTool,
      start,
      end,
      createOverlayShapeId(),
      points,
      closed,
      pickStyleDefaultsForInsert(resolvedTool.command, readRememberedShapeStyle()),
    );
    if (!baseShape) {
      return null;
    }
    // Nothing is learned here on purpose. The shape that comes back also carries the builder's own
    // fallbacks (a sector's shading, an arrow's head), and storing those would turn one shape's
    // design into every later shape's default. Only a toolbar change is a choice.
    if (baseShape.type === "callout") {
      lastCalloutCornerRadiusRef.current = baseShape.props.radius;
      rememberCalloutCornerRadius(baseShape.props.radius);
    }
    const activeGroupId = focusedGroupIdRef.current && getGroupShape(shapesRef.current, focusedGroupIdRef.current)
      ? focusedGroupIdRef.current
      : null;
    const withActiveParent = <T extends OverlayShape>(nextShape: T): T => (
      activeGroupId ? { ...nextShape, parentId: activeGroupId } as T : nextShape
    );
    const shape = withActiveParent(baseShape);

    const labelShapeEntries = shape.type === "graph2dShape"
      ? createGraphFormulaLabelShapeEntries(shape, createOverlayShapeId, {
        width: canvasWidthRef.current,
        height: canvasHeightRef.current,
      })
      : [];
    const pointLabelShapeEntries = shape.type === "graph2dShape"
      ? createGraphPointLabelShapeEntries(shape, createOverlayShapeId)
      : [];
    const annotationLabelShapeEntries = shape.type === "graph2dShape"
      ? createGraphAnnotationLabelShapeEntries(shape, createOverlayShapeId)
      : [];
    const labelShapes = [
      ...labelShapeEntries,
      ...pointLabelShapeEntries,
      ...annotationLabelShapeEntries,
    ].map((entry) => withActiveParent(entry.shape));
    let insertedShape = shape;
    if (insertedShape.type === "graph2dShape" && labelShapeEntries.length > 0) {
      insertedShape = withGraphLabelTextShapeIds(insertedShape, Object.fromEntries(
        labelShapeEntries.map((entry) => [entry.curveId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape" && pointLabelShapeEntries.length > 0) {
      insertedShape = withGraphPointLabelTextShapeIds(insertedShape, Object.fromEntries(
        pointLabelShapeEntries.map((entry) => [entry.pointId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape" && annotationLabelShapeEntries.length > 0) {
      insertedShape = withGraphAnnotationLabelTextShapeIds(insertedShape, Object.fromEntries(
        annotationLabelShapeEntries.map((entry) => [entry.annotationId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape") {
      insertedShape = clearMaterializedGraphLabelTexts(insertedShape);
    }

    let nextShapes = upsertShape(shapesRef.current, insertedShape);
    for (const labelShape of labelShapes) {
      nextShapes = upsertShape(nextShapes, labelShape);
    }
    nextShapes = normalizeOverlayGroups(nextShapes);
    shapesRef.current = nextShapes;
    if (isOverlayRichTextShape(insertedShape)) {
      suppressNextSaveRef.current = true;
    }
    if (insertedShape.type === TABLE_SHAPE_TYPE) insertedTableFocusRef.current = insertedShape.id;
    setShapes(nextShapes);
    selectKnownShape(insertedShape, { editing: isOverlayRichTextShape(insertedShape) });
    if (isOverlayRichTextShape(insertedShape)) {
      commitOverlayChangeNow();
    } else {
      queueOverlaySave();
    }
    return insertedShape.id;
  }, [canvasHeightRef, canvasWidthRef, commitOverlayChangeNow, focusedGroupIdRef, insertedTableFocusRef, lastCalloutCornerRadiusRef, queueOverlaySave, selectKnownShape, setShapes, shapesRef, suppressNextSaveRef]);

  /**
   * Creates a chart from an existing table and selects it.
   *
   * The chart is placed directly beneath the table and clamped into the canvas. It carries **no
   * anchor of its own** — only x/y — because `emitOverlayChange` re-anchors against the canvas on
   * the way out. Writing an anchor here as well is the "x/y and anchor offset held twice" trap:
   * one of the two silently wins on the next save and the shape jumps back.
   */
  const createChartFromTable = useCallback((tableShapeId: OverlayShapeId) => {
    const tableShape = shapesRef.current.find((shape) => shape.id === tableShapeId);
    if (tableShape?.type !== "tableShape") {
      return;
    }
    const bounds = getChartBoundsForTable({
      x: tableShape.x,
      y: tableShape.y,
      w: tableShape.props.w,
      h: tableShape.props.h,
    });
    const x = clamp(bounds.x, 0, Math.max(0, canvasWidthRef.current - bounds.w));
    const y = clamp(bounds.y, 0, Math.max(0, canvasHeightRef.current - bounds.h));
    const props = createChartShapeProps(
      tableShape.props.table,
      tableShapeId,
      bounds.w,
      bounds.h,
    );

    const shapeId = createShapeFromInsertDrag(
      {
        kind: "insert",
        command: "chart",
        chart: {
          sourceTableShapeId: tableShapeId,
          spec: props.spec,
          dataSnapshot: props.dataSnapshot,
        },
      },
      { x, y },
      { x: x + bounds.w, y: y + bounds.h },
    );
    if (shapeId) {
      // Selected, not opened for editing: a chart is configured from its floating panel, and the
      // author's next move is normally to place it rather than to change its settings.
      setSelectedShapeIds([shapeId]);
    }
  }, [canvasHeightRef, canvasWidthRef, createShapeFromInsertDrag, setSelectedShapeIds, shapesRef]);

  const finishCurveDrawing = useCallback((tool: InsertTool, points: OverlayPoint[], closed = false) => {
    const finalPoints = removeNearDuplicateDrawingPoints(points, 2);
    if (finalPoints.length < (tool.command === "threePointArc" ? 3 : 2)) {
      return false;
    }

    const start = finalPoints[0];
    const end = finalPoints[finalPoints.length - 1];
    const shapeId = createShapeFromInsertDrag(tool, start, end, finalPoints, closed);
    if (!shapeId) {
      return false;
    }
    transitionMode({ type: "setTool", tool: { kind: "select" } });
    clearSnapGuides();
    return true;
  }, [clearSnapGuides, createShapeFromInsertDrag, transitionMode]);
  return { createShapeFromInsertDrag, finishCurveDrawing, createChartFromTable };
}
