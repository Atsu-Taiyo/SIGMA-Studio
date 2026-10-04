"use client";
import type { OverlayAlignAction, OverlayDistributeAxis } from "@/features/drawing";
import {
  isOverlayRichTextShape,
  mergeShapesById,
  mergeStyleDefaults,
  moveShapes,
  type OverlayShapeStyleDefaults
} from "@/features/drawing";
import type { EditorClipboardPayload } from "@/lib/editor-clipboard";
import { OPEN_TIKZ_EDITOR_EVENT } from "@/lib/tikz-contract";
import type { Editor as TiptapEditor } from "@tiptap/core";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback,
  useEffect
} from "react";
import {
  type OverlayActionRequest,
  type OverlayChangeOptions,
  type OverlaySelectPointRequest,
  type OverlaySelectionStylePatch,
  type OverlaySolidEdgeSelection
} from "../page-overlay-types";
import { getAllSelectableShapeIds, getShapeIdsAnchoredToBlocks } from "./anchored-shape-selection";
import {
  getSelectedShapesInStackOrder,
  getShapeSelectionIds,
  getUnlockedTransformShapes,
  isOverlayGroupShape,
  isShapeHiddenInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups
} from "./grouping";
import type { InsertTool } from "./interaction-mode";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import {
  reanchorShapesByPosition
} from "./reanchor-model";
import type { ApplyPastedOverlayShapesOptions } from "./paste-shapes";
import { readRememberedShapeStyle } from "./remembered-shape-style";
import { type OverlayArrangeAction } from "./reorder-shapes";
import { getStyleTargetIds } from "./selection-command-model";
import {
  AnchorMeasurements
} from "./selection-handles";
import type {
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

interface Dependencies {
  handledActionRequestIdRef: RefObject<number | null>;
  duplicateSelectedShapes: (offset?: OverlayPoint) => OverlayShape[];
  deleteSelectedShapes: () => void;
  arrangeSelectedShapes: (action: OverlayArrangeAction) => void;
  alignSelectedShapes: (action: OverlayAlignAction) => void;
  distributeSelectedShapes: (axis: OverlayDistributeAxis) => void;
  groupSelectedShapes: () => void;
  ungroupSelectedShapes: () => void;
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  setSelectedShapesLocked: (locked: boolean) => void;
  setSelectedShapesHidden: (hidden: boolean) => void;
  setPreview: Dispatch<SetStateAction<{ style: OverlaySelectionStylePatch; targetIds: Set<string>; } | null>>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  solidEdgeRef: RefObject<OverlaySolidEdgeSelection | null>;
  learnShapeStyleDefaults: (next: OverlayShapeStyleDefaults) => void;
  applyStyleToSelectedShapes: (style: OverlaySelectionStylePatch) => void;
  applyPastedOverlayShapes: (payload: Extract<EditorClipboardPayload, { kind: "overlayShapes"; }>, options?: ApplyPastedOverlayShapesOptions) => boolean;
  setFocusedGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  refreshAnchorMeasurements: () => AnchorMeasurements;
  transitionMode: (action: OverlayInteractionAction) => void;
  extendedActionRunnerRef: RefObject<((request: OverlayActionRequest) => void) | null>;
  activeTextEditorRef: RefObject<TiptapEditor | null>;
  createShapeFromInsertDrag: (tool: InsertTool, start: OverlayPoint, end: OverlayPoint, points?: OverlayPoint[], closed?: boolean) => OverlayShapeId | null;
  onActionHandled: (requestId: number) => void;
  actionRequest: OverlayActionRequest | null;
  handledSelectPointRequestIdRef: RefObject<number | null>;
  focusOverlayCanvas: () => void;
  onSelectPointHandled: (requestId: number, hitShape: boolean) => void;
  getShapeAtPoint: (point: OverlayPoint, margin?: number) => OverlayShape | undefined;
  getOpenStrokeShapeAtPoint: (point: OverlayPoint) => OverlayShape | undefined;
  focusedGroupIdRef: RefObject<string | null>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  selectShape: (id: OverlayShapeId) => void;
  documentId: string | undefined;
  selectPointRequest: OverlaySelectPointRequest | null;
}

export function useOverlayExternalRequests({
  handledActionRequestIdRef,
  duplicateSelectedShapes,
  deleteSelectedShapes,
  arrangeSelectedShapes,
  alignSelectedShapes,
  distributeSelectedShapes,
  groupSelectedShapes,
  ungroupSelectedShapes,
  shapesRef,
  selectedIdsRef,
  setSelectedShapesLocked,
  setSelectedShapesHidden,
  setPreview,
  editPolicyLockedShapeIdsRef,
  solidEdgeRef,
  learnShapeStyleDefaults,
  applyStyleToSelectedShapes,
  applyPastedOverlayShapes,
  setFocusedGroupId,
  setSelectedShapeIds,
  refreshAnchorMeasurements,
  transitionMode,
  extendedActionRunnerRef,
  activeTextEditorRef,
  createShapeFromInsertDrag,
  onActionHandled,
  actionRequest,
  handledSelectPointRequestIdRef,
  focusOverlayCanvas,
  onSelectPointHandled,
  getShapeAtPoint,
  getOpenStrokeShapeAtPoint,
  focusedGroupIdRef,
  setShapes,
  queueOverlaySave,
  selectShape,
  documentId,
  selectPointRequest,
}: Dependencies) {

  const handleActionRequest = useCallback((request: OverlayActionRequest) => {
    if (handledActionRequestIdRef.current === request.id) {
      return;
    }

    handledActionRequestIdRef.current = request.id;
    if (request.type === "duplicate") {
      duplicateSelectedShapes();
    } else if (request.type === "delete") {
      deleteSelectedShapes();
    } else if (request.type === "arrange") {
      arrangeSelectedShapes(request.action);
    } else if (request.type === "align") {
      alignSelectedShapes(request.action);
    } else if (request.type === "distribute") {
      distributeSelectedShapes(request.axis);
    } else if (request.type === "group") {
      groupSelectedShapes();
    } else if (request.type === "ungroup") {
      ungroupSelectedShapes();
    } else if (request.type === "toggleLock") {
      const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current);
      const locked = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeLockedInTree(shapesRef.current, shape));
      setSelectedShapesLocked(!locked);
    } else if (request.type === "toggleHidden") {
      const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current);
      const hidden = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeHiddenInTree(shapesRef.current, shape));
      setSelectedShapesHidden(!hidden);
    } else if (request.type === "style") {
      setPreview(null);
      // Only when the change actually lands: with a locked selection the patch is dropped, and
      // reprogramming the next insertion from a click that visibly did nothing would be a surprise.
      if (getStyleTargetIds(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current).size > 0) {
        // 辺だけの線種・太さは「次に描く図形の線種・太さ」にはしない。
        const learnedStyle = solidEdgeRef.current
          ? { ...request.style, dash: undefined, size: undefined }
          : request.style;
        learnShapeStyleDefaults(mergeStyleDefaults(readRememberedShapeStyle(), learnedStyle));
      }
      applyStyleToSelectedShapes(request.style);
    } else if (request.type === "pasteShapes") {
      applyPastedOverlayShapes(request.payload, {
        anchorBlockIdMap: request.anchorBlockIdMap,
        historyGroup: request.historyGroup,
        centerAt: request.centerAt,
      });
    } else if (request.type === "selectShapesForBlocks") {
      // フォーカスは本文に残したまま選択だけ立てる。`focusOverlayCanvas` を呼ぶと本文の
      // DOM 選択が消えて、混在選択が「図形だけ」に痩せる。
      setFocusedGroupId(null);
      // 矩形は「見た目が本文の選択に重なっている図形」を拾うため。計測が無い面
      // (running region など) では渡らず、アンカーだけの判定に落ちる。
      // 本文の全選択から来た要求だけは、アンカーも重なりも持たない図形 (余白の注記など) まで
      // 含めて「全部」にする。
      setSelectedShapeIds(request.allShapes
        ? getAllSelectableShapeIds(shapesRef.current)
        : getShapeIdsAnchoredToBlocks(
          shapesRef.current,
          request.blockIds,
          refreshAnchorMeasurements().rects,
        ));
      transitionMode({ type: "select" });
    } else if (
      request.type === "transform"
      || request.type === "changeShapeType"
      || request.type === "shapeCommand"
    ) {
      extendedActionRunnerRef.current?.(request);
    } else if (request.type === "insertTextAtPoint") {
      activeTextEditorRef.current?.commands.blur();
      // No drag, so no width was asked for: an empty rect at the point lets the builder apply the
      // one default width. A box made this way and a box made by a click have to come out the same
      // size — a second size spelled out here would be a different answer to the same question.
      createShapeFromInsertDrag(
        { kind: "insert", command: "text" },
        request.point,
        request.point,
      );
    }

    onActionHandled(request.id);
  }, [handledActionRequestIdRef, onActionHandled, duplicateSelectedShapes, deleteSelectedShapes, arrangeSelectedShapes, alignSelectedShapes, distributeSelectedShapes, groupSelectedShapes, ungroupSelectedShapes, shapesRef, selectedIdsRef, setSelectedShapesLocked, setSelectedShapesHidden, setPreview, editPolicyLockedShapeIdsRef, applyStyleToSelectedShapes, solidEdgeRef, learnShapeStyleDefaults, applyPastedOverlayShapes, setFocusedGroupId, setSelectedShapeIds, refreshAnchorMeasurements, transitionMode, extendedActionRunnerRef, activeTextEditorRef, createShapeFromInsertDrag]);

  useEffect(() => {
    if (actionRequest) {
      const timeoutId = window.setTimeout(() => handleActionRequest(actionRequest), 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [actionRequest, handleActionRequest]);

  const handleSelectPointRequest = useCallback((request: OverlaySelectPointRequest) => {
    if (handledSelectPointRequestIdRef.current === request.id) {
      return;
    }

    handledSelectPointRequestIdRef.current = request.id;

    if (request.startMarquee) {
      focusOverlayCanvas();
      transitionMode({
        type: "startMarquee",
        start: request.point,
        additive: true,
        selectOnClick: true,
      });
      onSelectPointHandled(request.id, true);
      return;
    }

    const requestedShape = request.targetShapeId
      ? shapesRef.current.find((item) => (
        item.id === request.targetShapeId &&
        !isOverlayGroupShape(item) &&
        !isShapeHiddenInTree(shapesRef.current, item)
      ))
      : undefined;
    const shape = requestedShape ?? getShapeAtPoint(request.point, 8) ?? getOpenStrokeShapeAtPoint(request.point);

    if (shape) {
      activeTextEditorRef.current?.commands.blur();
      activeTextEditorRef.current = null;
      focusOverlayCanvas();

      if (request.dragEndPoint) {
        const dx = request.dragEndPoint.x - request.point.x;
        const dy = request.dragEndPoint.y - request.point.y;
        if (Math.hypot(dx, dy) >= 3) {
          const selectionIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
          const movingShapes = getUnlockedTransformShapes(shapesRef.current, selectionIds, editPolicyLockedShapeIdsRef.current);
          if (movingShapes.length > 0) {
            const movedIdSet = new Set(movingShapes.map((movingShape) => movingShape.id));
            const movedShapes = moveShapes(movingShapes, dx, dy);
            const { ordered } = refreshAnchorMeasurements();
            setSelectedShapeIds(selectionIds);
            setShapes((current) => {
              const next = normalizeOverlayGroups(reanchorShapesByPosition(mergeShapesById(current, movedShapes), movedIdSet, ordered));
              shapesRef.current = next;
              return next;
            });
            transitionMode({ type: "select" });
            onSelectPointHandled(request.id, true);
            queueOverlaySave();
            return;
          }
        }
      }

      transitionMode({ type: "select" });
      selectShape(shape.id);
      if (shape.type === "image" && shape.props.tikz && !shape.locked &&
        !editPolicyLockedShapeIdsRef.current.has(shape.id) && request.dragEndPoint &&
        Math.hypot(request.dragEndPoint.x - request.point.x, request.dragEndPoint.y - request.point.y) < 3) {
        window.dispatchEvent(new CustomEvent(OPEN_TIKZ_EDITOR_EVENT, { detail: { documentId, shapeId: shape.id } }));
      }
      if (request.startCrop && shape.type === "graph2dShape") {
        transitionMode({ type: "editGraph", shapeId: shape.id });
      } else if (request.startCrop && isOverlayRichTextShape(shape)) {
        transitionMode({ type: "editText", shapeId: shape.id });
      } else if (request.startCrop && shape.type === "tableShape") {
        transitionMode({ type: "editTable", shapeId: shape.id });
      }
      onSelectPointHandled(request.id, true);
    } else {
      setSelectedShapeIds([]);
      transitionMode({ type: "select" });
      onSelectPointHandled(request.id, false);
    }
  }, [handledSelectPointRequestIdRef, shapesRef, getShapeAtPoint, getOpenStrokeShapeAtPoint, focusOverlayCanvas, transitionMode, onSelectPointHandled, activeTextEditorRef, selectShape, editPolicyLockedShapeIdsRef, focusedGroupIdRef, refreshAnchorMeasurements, setSelectedShapeIds, setShapes, queueOverlaySave, documentId]);

  useEffect(() => {
    if (selectPointRequest) {
      const timeoutId = window.setTimeout(() => handleSelectPointRequest(selectPointRequest), 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [handleSelectPointRequest, selectPointRequest]);
}
