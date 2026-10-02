"use client";
import {
  OPEN_OVERLAY_CHART_SETTINGS_EVENT,
  OPEN_OVERLAY_GRAPH_SETTINGS_EVENT
} from "@/components/editor/EditorSettings";
import {
  OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT,
} from "@/components/editor/Graph3DSettingsPanel";
import type { OverlayFlipAxis } from "@/features/drawing";
import {
  hitTestShape,
  isOverlayRichTextShape
} from "@/features/drawing";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  RefObject,
  SetStateAction
} from "react";
import {
  useCallback,
  useEffect
} from "react";
import {
  type OverlayActionRequest,
  type OverlayChangeOptions
} from "../page-overlay-types";
import type { OverlayContextMenuState } from "./context-menu";
import {
  getSelectedShapesInStackOrder,
  getShapeSelectionIds,
  isOverlayGroupShape,
  isShapeDescendantOf,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups
} from "./grouping";
import {
  type OverlayInteractionAction,
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  clamp
} from "./math";
import {
  canChangeOverlayShapeType,
  changeOverlayShapeType,
  type ShapeTypeChangeCommand
} from "./shape-type-change";
import {
  isOpenStrokeShape
} from "./style-patch";
import type {
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";
const OPEN_STROKE_POINTER_HIT_MARGIN = 14;

interface Dependencies {
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  notifyEditPolicyBlocked: () => void;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  transitionMode: (action: OverlayInteractionAction) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  extendedActionRunnerRef: RefObject<((request: OverlayActionRequest) => void) | null>;
  applyQuickTransformToSelectedShapes: (action: "rotateClockwise" | "rotateCounterclockwise" | OverlayFlipAxis) => void;
  startImageCrop: (shapeId: OverlayShapeId) => void;
  requestImageReplacement: (shapeId: OverlayShapeId) => void;
  resetImageCrop: (shapeId: OverlayShapeId) => void;
  restoreImageNaturalSize: (shapeId: OverlayShapeId) => void;
  createChartFromTable: (tableShapeId: OverlayShapeId) => void;
  handleCurveDrawingDoubleClick: (event: ReactMouseEvent<HTMLDivElement>) => boolean;
  suppressNextShapeDoubleClickRef: RefObject<number>;
  graphFillPickShapeId: string | null;
  pagePointFromClient: (clientX: number, clientY: number, cachedRect?: { left: number; top: number; width: number; height: number; } | null) => OverlayPoint;
  focusedGroupIdRef: RefObject<string | null>;
  setFocusedGroupId: Dispatch<SetStateAction<string | null>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  selectShape: (id: OverlayShapeId) => void;
  modeRef: RefObject<OverlayInteractionMode>;
  getShapeAtPoint: (point: OverlayPoint, margin?: number) => OverlayShape | undefined;
  getOpenStrokeShapeAtPoint: (point: OverlayPoint) => OverlayShape | undefined;
  setContextMenu: Dispatch<SetStateAction<OverlayContextMenuState | null>>;
  focusOverlayCanvas: () => void;
}

export function useOverlayContextInteraction({
  shapesRef,
  selectedIdsRef,
  editPolicyLockedShapeIdsRef,
  notifyEditPolicyBlocked,
  setShapes,
  transitionMode,
  queueOverlaySave,
  extendedActionRunnerRef,
  applyQuickTransformToSelectedShapes,
  startImageCrop,
  requestImageReplacement,
  resetImageCrop,
  restoreImageNaturalSize,
  createChartFromTable,
  handleCurveDrawingDoubleClick,
  suppressNextShapeDoubleClickRef,
  graphFillPickShapeId,
  pagePointFromClient,
  focusedGroupIdRef,
  setFocusedGroupId,
  setSelectedShapeIds,
  selectShape,
  modeRef,
  getShapeAtPoint,
  getOpenStrokeShapeAtPoint,
  setContextMenu,
  focusOverlayCanvas,
}: Dependencies) {

  const changeSelectedShapeType = useCallback((command: ShapeTypeChangeCommand) => {
    const source = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current)[0];
    if (!source || selectedIdsRef.current.length !== 1 || !canChangeOverlayShapeType(source)) {
      return;
    }
    if (
      isShapeLockedInTree(shapesRef.current, source) ||
      isShapeEditPolicyLockedInTree(shapesRef.current, source, editPolicyLockedShapeIdsRef.current)
    ) {
      if (isShapeEditPolicyLockedInTree(shapesRef.current, source, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }
    const changed = changeOverlayShapeType(source, command);
    if (!changed) {
      return;
    }
    setShapes((current) => {
      const next = normalizeOverlayGroups(current.map((shape) => shape.id === source.id ? changed : shape));
      shapesRef.current = next;
      return next;
    });
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, queueOverlaySave, selectedIdsRef, setShapes, shapesRef, transitionMode]);

  useEffect(() => {
    extendedActionRunnerRef.current = (request) => {
      if (request.type === "transform") {
        applyQuickTransformToSelectedShapes(request.action);
        return;
      }
      if (request.type === "changeShapeType") {
        changeSelectedShapeType(request.command);
        return;
      }
      if (request.type !== "shapeCommand") {
        return;
      }
      // 選択が 1 つで、その図形の種類がコマンドに合うときだけ動かす。
      const [shape] = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current);
      if (!shape || selectedIdsRef.current.length !== 1) {
        return;
      }
      switch (request.command) {
        case "imageCrop":
          if (shape.type === "image") startImageCrop(shape.id);
          break;
        case "imageReplace":
          if (shape.type === "image") requestImageReplacement(shape.id);
          break;
        case "imageResetCrop":
          if (shape.type === "image") resetImageCrop(shape.id);
          break;
        case "imageNaturalSize":
          if (shape.type === "image") restoreImageNaturalSize(shape.id);
          break;
        case "chartFromTable":
          if (shape.type === "tableShape") createChartFromTable(shape.id);
          break;
        case "chartSettings":
          if (shape.type === "chartShape") {
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_CHART_SETTINGS_EVENT, { detail: { shapeId: shape.id } }));
          }
          break;
        case "graph3dSettings":
          if (shape.type === "graph3dShape") {
            transitionMode({ type: "editGraph3D", shapeId: shape.id });
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, { detail: { shapeId: shape.id } }));
          }
          break;
        case "graphSettings":
          if (shape.type === "graph2dShape") {
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, { detail: { shapeId: shape.id } }));
          }
          break;
        case "graphCrop":
          if (shape.type === "graph2dShape") transitionMode({ type: "editGraph", shapeId: shape.id });
          break;
        case "graphOriginPick":
          if (shape.type === "graph2dShape") transitionMode({ type: "pickOrigin", shapeId: shape.id });
          break;
        case "graphFillPick":
          if (shape.type === "graph2dShape" && shape.props.spec.kind === "cartesian") {
            transitionMode({ type: "pickGraphFill", shapeId: shape.id });
          }
          break;
      }
    };
  }, [applyQuickTransformToSelectedShapes, changeSelectedShapeType, createChartFromTable, extendedActionRunnerRef, requestImageReplacement, resetImageCrop, restoreImageNaturalSize, selectedIdsRef, shapesRef, startImageCrop, transitionMode]);

  const handleShapeDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>, targetShape: OverlayShape) => {
    if (handleCurveDrawingDoubleClick(event)) {
      return;
    }

    if (window.performance.now() - suppressNextShapeDoubleClickRef.current < 500) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    // 押下と同じ規約: DIV に当たっただけでは足りず、インクに当たっていること。
    // `handleCanvasDoubleClick` は幾何で解決した図形を渡してくるので、そちらは素通りする。
    const doubleClickPoint = pagePointFromClient(event.clientX, event.clientY);
    const doubleClickMargin = targetShape.type === "graph2dShape"
      ? 0
      : isOpenStrokeShape(targetShape)
        ? OPEN_STROKE_POINTER_HIT_MARGIN
        : 8;
    if (!hitTestShape(targetShape, doubleClickPoint, doubleClickMargin)) {
      return;
    }

    const selectionIds = getShapeSelectionIds(shapesRef.current, targetShape.id, focusedGroupIdRef.current);
    const selectedShape = selectionIds.length === 1
      ? shapesRef.current.find((shape) => shape.id === selectionIds[0])
      : null;
    if (selectedShape && isOverlayGroupShape(selectedShape) && focusedGroupIdRef.current !== selectedShape.id) {
      setFocusedGroupId(selectedShape.id);
      setSelectedShapeIds(getShapeSelectionIds(shapesRef.current, targetShape.id, selectedShape.id));
      transitionMode({ type: "select" });
      return;
    }

    selectShape(targetShape.id);
    if (isShapeLockedInTree(shapesRef.current, targetShape)) {
      return;
    }
    if (isOverlayRichTextShape(targetShape)) {
      transitionMode({ type: "editText", shapeId: targetShape.id });
    } else if (targetShape.type === "image") {
      transitionMode({ type: "editImageCrop", shapeId: targetShape.id });
    } else if (targetShape.type === "graph2dShape") {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "editGraph", shapeId: targetShape.id });
    } else if (targetShape.type === "graph3dShape") {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "editGraph3D", shapeId: targetShape.id });
      window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, {
        detail: { shapeId: targetShape.id },
      }));
    } else if (targetShape.type === "tableShape") {
      transitionMode({ type: "editTable", shapeId: targetShape.id });
    } else if (targetShape.type === "chartShape") {
      // A chart has no in-place editing mode — its settings live in the floating panel — so this
      // opens the panel instead of transitioning. `graph2d`/`graph3d` are handled at the capture
      // stage upstream; a chart is neither, so it arrives here in the ordinary stage.
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_CHART_SETTINGS_EVENT, {
        detail: { shapeId: targetShape.id },
      }));
    }
  }, [focusedGroupIdRef, graphFillPickShapeId, handleCurveDrawingDoubleClick, pagePointFromClient, selectShape, setFocusedGroupId, setSelectedShapeIds, shapesRef, suppressNextShapeDoubleClickRef, transitionMode]);

  const handleCanvasDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }

    if (modeRef.current.id === "overlay.curveDrawing") {
      handleCurveDrawingDoubleClick(event);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const shape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!shape) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleShapeDoubleClick(event, shape);
  }, [getOpenStrokeShapeAtPoint, getShapeAtPoint, handleCurveDrawingDoubleClick, handleShapeDoubleClick, modeRef, pagePointFromClient]);

  const handleCanvasContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    // OrbitControls blocks the browser's native context menu on its canvas. Keep that prevention,
    // but still route the event into Sigma Studio's own shape menu.
    if (event.defaultPrevented && !target?.closest(".overlay-graph3d-live-window")) {
      return;
    }

    if (target?.closest(".overlay-table-context-menu")) {
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const shape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!shape) {
      setContextMenu(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();

    const focusedGroup = focusedGroupIdRef.current;
    if (
      focusedGroup &&
      shape.id !== focusedGroup &&
      !isShapeDescendantOf(shapesRef.current, shape.id, focusedGroup)
    ) {
      focusedGroupIdRef.current = null;
      setFocusedGroupId(null);
    }

    const shapeSelectionIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
    const currentSelection = new Set(selectedIdsRef.current);
    if (!shapeSelectionIds.some((id) => currentSelection.has(id))) {
      setSelectedShapeIds(shapeSelectionIds);
    }
    transitionMode({ type: "select" });
    setContextMenu({
      x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 232)),
      y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 360)),
      shapeId: shapeSelectionIds[0] ?? shape.id,
    });
  }, [focusOverlayCanvas, focusedGroupIdRef, getOpenStrokeShapeAtPoint, getShapeAtPoint, pagePointFromClient, selectedIdsRef, setContextMenu, setFocusedGroupId, setSelectedShapeIds, shapesRef, transitionMode]);

  const runContextMenuAction = useCallback((action: () => void) => {
    action();
    setContextMenu(null);
    focusOverlayCanvas();
  }, [focusOverlayCanvas, setContextMenu]);
  return {
    handleCanvasContextMenu,
    handleCanvasDoubleClick,
    handleShapeDoubleClick,
    runContextMenuAction,
    changeSelectedShapeType,
  };
}
