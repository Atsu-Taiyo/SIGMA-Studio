"use client";
import type { DocumentSession, SessionOverlayPresence } from "@/features/document-session/contracts";
import {
  canBoxResize,
  collectSelectedOverlayAssets,
  getCurveDrawingPreviewPoints,
  getSelectionVisualFrame,
  getShapeRotation,
  getShapeRotationPivot,
  getShapeVisualBounds,
  getShapesVisualBounds,
  getTopmostSelectedShapes,
  shouldClosePolylineDrawing,
  type OverlayShapeStyleDefaults
} from "@/features/drawing";
import type { Translate } from "@/lib/i18n";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useEffect,
  useMemo
} from "react";
import {
  OVERLAY_STYLE_PREVIEW_EVENT,
  type OverlaySelectionStylePatch,
  type OverlaySelectionSummary,
  type OverlaySolidEdgeSelection,
  type OverlayStylePreviewEvent
} from "../page-overlay-types";
import {
  getMovingShapeIdsWithFullyMovingGroups,
  getSelectedShapesForClipboard,
  getSelectedShapesInStackOrder,
  getUnlockedTransformShapes,
  isOverlayGroupShape,
  isShapeGroupMember,
  isShapeHiddenInTree,
  isShapeLockedInTree
} from "./grouping";
import { getAdjustmentDragReadout, getDrawingHint } from "./insertion-preview";
import { getAnchorDragPosition } from "./interaction-geometry";
import {
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  boundsFromPoints
} from "./math";
import { getOverlayPresencePreviewKind } from "./remote-presence";
import { getStyleTargetIds } from "./selection-command-model";
import {
  AnchorIndicator,
  AnchorMeasurements,
  getAnchorIndicator
} from "./selection-handles";
import {
  GRAPH_SHAPE_TYPE,
  isGraphLabelTextShape
} from "./shapes/graph";
import {
  getExistingGraphLabelTextShapeIds
} from "./shapes/graph-labels";
import {
  canShapeStyleFill,
  canShapeStyleLine,
  canShapeStyleLineEndpoints,
  canShapeStyleStroke,
  sharedArrowhead,
  sharedFill
} from "./style-patch";
import type {
  OverlayAsset,
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

interface Dependencies {
  shapes: OverlayShape[];
  selectedIds: string[];
  assets: Record<string, OverlayAsset>;
  editPolicyLockedShapeIds: ReadonlySet<string>;
  mode: OverlayInteractionMode;
  initialOriginPickShapeId: string | null;
  selectedRegion: OverlayBounds | null;
  dragOffset: OverlayPoint | null;
  publishesSessionPresence: boolean;
  documentSession: DocumentSession | undefined;
  tShape: Translate<"shape">;
  adjustmentDragReadoutPointerPosition: OverlayPoint | null;
  shapeStyleDefaults: OverlayShapeStyleDefaults;
  showAnchorHandles: boolean;
  anchorMeasurements: AnchorMeasurements;
  canvasWidth: number;
  canvasHeight: number;
  bleedValues: { x: number; top: number; };
  onSelectionSummaryChange: ((summary: OverlaySelectionSummary) => void) | undefined;
  solidEdge: OverlaySolidEdgeSelection | null;
  acceptsStylePreview: boolean;
  setPreview: Dispatch<SetStateAction<{ style: OverlaySelectionStylePatch; targetIds: Set<string>; } | null>>;
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
}

export function useOverlaySelectionPresentation({
  shapes,
  selectedIds,
  assets,
  editPolicyLockedShapeIds,
  mode,
  initialOriginPickShapeId,
  selectedRegion,
  dragOffset,
  publishesSessionPresence,
  documentSession,
  tShape,
  adjustmentDragReadoutPointerPosition,
  shapeStyleDefaults,
  showAnchorHandles,
  anchorMeasurements,
  canvasWidth,
  canvasHeight,
  bleedValues,
  onSelectionSummaryChange,
  solidEdge,
  acceptsStylePreview,
  setPreview,
  shapesRef,
  selectedIdsRef,
  editPolicyLockedShapeIdsRef,
}: Dependencies) {

  const selectedShapes = useMemo(
    () => getSelectedShapesInStackOrder(shapes, selectedIds),
    [selectedIds, shapes],
  );
  const selectedDimensionShapes = useMemo(
    () => getTopmostSelectedShapes(selectedShapes),
    [selectedShapes],
  );
  const selectedContextShapes = useMemo(
    () => getSelectedShapesForClipboard(shapes, selectedIds),
    [selectedIds, shapes],
  );
  const selectedContextAssets = useMemo(
    () => collectSelectedOverlayAssets(selectedContextShapes, assets),
    [assets, selectedContextShapes],
  );
  const transformSelectedShapes = useMemo(
    () => getUnlockedTransformShapes(shapes, selectedIds, editPolicyLockedShapeIds),
    [editPolicyLockedShapeIds, selectedIds, shapes],
  );
  /**
   * The rectangle the author sees — and, through `getSelectionResizeFrame`, the one a resize drag
   * moves. Rotation and alignment still read `getShapesSelectionBounds` themselves, so the
   * transform box and everything persisted from it are untouched.
   */
  const selectionBounds = useMemo(
    () => getSelectionVisualFrame(selectedShapes, shapes),
    [selectedShapes, shapes],
  );
  const selectedLocked = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeLockedInTree(shapes, shape));
  const selectedHidden = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeHiddenInTree(shapes, shape));
  const selectionCanResize = selectedShapes.length === 1
    ? canBoxResize(selectedShapes[0])
    : selectedShapes.some((shape) => !isShapeLockedInTree(shapes, shape));
  const selectionCanRotate = !transformSelectedShapes.some((shape) => shape.type === "tableShape");
  const selectionIsGraphCropping =
    mode.id === "overlay.graphEditing" &&
    selectedShapes.length === 1 &&
    selectedShapes[0]?.id === mode.shapeId;
  const selectionIsGraph3DEditing =
    mode.id === "overlay.graph3dEditing" &&
    selectedShapes.length === 1 &&
    selectedShapes[0]?.id === mode.shapeId;
  const selectionImageCropShape =
    (mode.id === "overlay.imageCropping" || mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") &&
      selectedShapes.length === 1 &&
      selectedShapes[0]?.id === (mode.id === "overlay.imageCropping" ? mode.shapeId : mode.shape.id) &&
      selectedShapes[0]?.type === "image"
      ? selectedShapes[0]
      : null;
  const selectionChromeHidden = initialOriginPickShapeId !== null;
  const marqueeBounds = mode.id === "overlay.marquee" ? boundsFromPoints([mode.start, mode.current]) : selectedRegion;
  const currentTool = mode.tool;
  const movingShapes = mode.id === "overlay.move" ? mode.shapes : null;
  const movingShapeIds = useMemo(() => {
    if (!movingShapes) {
      return null;
    }
    const ids = new Set<OverlayShapeId>(movingShapes.map((shape) => shape.id));
    // グラフ本体をドラッグ中は、グラフが所有するラベル(点・軸・注釈・式ラベル)も
    // 同じ dragOffset で一緒に動かす。ラベルはグラフの子ではなくアンカー(rx/ry)で
    // 紐づくため移動セットには入らず、従来はドラッグ中だけ取り残されていた。
    // 確定時は reanchorShapesByPosition → resolveShapeAnchorPositions が
    // アンカーからラベル位置を再計算するので、ここは描画上の追従のみで二重移動はしない。
    for (const moving of movingShapes) {
      if (moving.type === GRAPH_SHAPE_TYPE) {
        for (const labelId of getExistingGraphLabelTextShapeIds(moving, shapes)) {
          ids.add(labelId);
        }
      }
    }
    return getMovingShapeIdsWithFullyMovingGroups(shapes, ids);
  }, [movingShapes, shapes]);
  const localOverlayPresence = useMemo<SessionOverlayPresence | null>(() => {
    if (selectedIds.length === 0) return null;
    const previewKind = getOverlayPresencePreviewKind(mode);
    const previewShapes = previewKind
      ? selectedShapes.map((shape) => {
        const bounds = shape.type === "group"
          ? getShapesVisualBounds([shape], shapes) ?? getShapeVisualBounds(shape)
          : getShapeVisualBounds(shape);
        const translated = mode.id === "overlay.move" && movingShapeIds?.has(shape.id) && dragOffset
          ? { ...bounds, x: bounds.x + dragOffset.x, y: bounds.y + dragOffset.y }
          : bounds;
        const rotation = getShapeRotation(shape);
        const pivot = rotation ? getShapeRotationPivot(shape) : null;
        const translatedPivot = pivot && mode.id === "overlay.move" && movingShapeIds?.has(shape.id) && dragOffset
          ? { x: pivot.x + dragOffset.x, y: pivot.y + dragOffset.y }
          : pivot;
        return {
          id: shape.id,
          ...translated,
          ...(rotation && translatedPivot ? { rotation, pivot: translatedPivot } : {}),
        };
      })
      : [];
    return {
      selectedShapeIds: selectedIds,
      ...(previewKind ? { preview: { kind: previewKind, shapes: previewShapes } } : {}),
    };
  }, [dragOffset, mode, movingShapeIds, selectedIds, selectedShapes, shapes]);

  useEffect(() => {
    if (publishesSessionPresence) {
      documentSession?.setOverlayPresence?.(localOverlayPresence);
    }
  }, [documentSession, localOverlayPresence, publishesSessionPresence]);
  useEffect(() => () => {
    if (publishesSessionPresence) {
      documentSession?.setOverlayPresence?.(null);
    }
  }, [documentSession, publishesSessionPresence]);
  const anchorDrag = mode.id === "overlay.anchor" ? mode : null;
  const insertDrag = mode.id === "overlay.insertDrag" ? mode : null;
  const curveDrawing = mode.id === "overlay.curveDrawing" ? mode : null;
  const curveDrawingClosed = curveDrawing ? shouldClosePolylineDrawing(curveDrawing.tool, curveDrawing.points, curveDrawing.current) : false;
  const curveDrawingPreviewPoints = curveDrawing ? getCurveDrawingPreviewPoints(curveDrawing.points, curveDrawing.current, curveDrawingClosed) : null;
  /**
   * The one line of guidance shown while a click-to-place tool is active.
   *
   * Derived, never stored: following the pointer would need a `setState` per move, which is how this
   * editor has produced idle re-render loops before. A fixed pill at the bottom needs no new state,
   * and the computation is a couple of comparisons — cheap enough to leave to the compiler rather
   * than hand-memoizing it (a `useMemo` here makes React Compiler skip this component entirely).
   */
  const drawingHint = getDrawingHint(mode, curveDrawing, curveDrawingClosed, tShape);
  const insertPreview = insertDrag
    ? {
      tool: insertDrag.tool,
      start: insertDrag.start,
      current: insertDrag.current,
      points: insertDrag.points,
      closed: false,
      bounds: boundsFromPoints([insertDrag.start, insertDrag.current]),
    }
    : curveDrawing && curveDrawingPreviewPoints
      ? {
        tool: curveDrawing.tool,
        start: curveDrawingPreviewPoints[0],
        current: curveDrawingPreviewPoints[curveDrawingPreviewPoints.length - 1],
        points: curveDrawingPreviewPoints,
        closed: curveDrawingClosed,
        bounds: boundsFromPoints(curveDrawingPreviewPoints),
      }
      : null;
  // 調整ハンドル、または arc/sector 挿入のドラッグ中にポインタ近傍へライブ数値を出す。
  const adjustmentDragReadout = getAdjustmentDragReadout(
    mode,
    shapes,
    adjustmentDragReadoutPointerPosition,
    shapeStyleDefaults,
    tShape,
  );
  const anchorIndicators = useMemo(() => {
    if (!showAnchorHandles) {
      return [];
    }
    const draggingPosition = anchorDrag ? getAnchorDragPosition(anchorDrag) : null;
    return selectedShapes
      .filter((shape) => (
        // A group hangs from body text like any other figure — it is the *unit* that does, so it
        // owns the rule and its members never show one of their own (their anchor is inherited,
        // so a grip on a member would rewrite something the next re-anchor pass overwrites).
        !isShapeGroupMember(shapes, shape) &&
        !isShapeHiddenInTree(shapes, shape) &&
        !isGraphLabelTextShape(shape, shapes)
      ))
      .map((shape) => getAnchorIndicator(
        shape,
        shapes,
        anchorMeasurements,
        canvasWidth,
        canvasHeight,
        anchorDrag?.shape.id === shape.id ? draggingPosition : null,
        movingShapeIds?.has(shape.id) ?? false,
        bleedValues,
      ))
      .filter((indicator): indicator is AnchorIndicator => indicator !== null);
  }, [anchorDrag, anchorMeasurements, bleedValues, canvasHeight, canvasWidth, movingShapeIds, selectedShapes, shapes, showAnchorHandles]);

  useEffect(() => {
    const canStyleStroke = selectedShapes.some(canShapeStyleStroke);
    const canStyleFill = selectedShapes.some(canShapeStyleFill);
    const canStyleLine = selectedShapes.some(canShapeStyleLine);
    const canStyleLineEndpoints = selectedShapes.some(canShapeStyleLineEndpoints);
    const arrowheadStart = sharedArrowhead(selectedShapes, "start");
    const arrowheadEnd = sharedArrowhead(selectedShapes, "end");
    // Computed inside the effect on purpose: the summary object is rebuilt on every selection
    // change already, and adding a memo to the dependency list is how the known re-render loop
    // starts (a new array each render feeding an effect that sets state).
    // The expanded set, not the raw selection: confirming writes through groups
    // (`getStyleTargetIds`), so reading only the top level would report a single value for a
    // genuinely mixed selection and then overwrite the members.
    const fill = sharedFill(selectedContextShapes);

    onSelectionSummaryChange?.({
      ...(mode.id === "overlay.textEditing" || mode.id === "overlay.tableEditing" ? {
        textEditing: { shapeId: mode.shapeId, kind: mode.id === "overlay.tableEditing" ? "table" as const : "text" as const },
      } : {}),
      ...(selectedRegion ? { region: selectedRegion } : {}),
      selectedCount: selectedShapes.length,
      selectedShapeIds: selectedIds,
      selectedShapes: selectedContextShapes,
      selectedAssets: selectedContextAssets,
      locked: selectedLocked,
      hidden: selectedHidden,
      grouped: selectedShapes.some((shape) => isOverlayGroupShape(shape) || Boolean(shape.parentId)),
      canAlign: selectedShapes.length >= 2,
      canDistribute: selectedShapes.length >= 3,
      canStyleStroke,
      canStyleFill,
      canStyleLine,
      canStyleLineEndpoints,
      arrowheadStart,
      arrowheadEnd,
      fill,
      ...(solidEdge && selectedShapes.length === 1 && selectedShapes[0].id === solidEdge.shapeId
        ? { solidEdge }
        : {}),
    });
  }, [
    mode,
    onSelectionSummaryChange,
    solidEdge,
    selectedRegion,
    selectedContextAssets,
    selectedContextShapes,
    selectedHidden,
    selectedIds,
    selectedLocked,
    selectedShapes,
  ]);

  useEffect(() => () => {
    onSelectionSummaryChange?.({
      selectedCount: 0,
      selectedShapeIds: [],
      selectedShapes: [],
      selectedAssets: {},
      locked: false,
      hidden: false,
      grouped: false,
      canAlign: false,
      canDistribute: false,
      canStyleStroke: false,
      canStyleFill: false,
      canStyleLine: false,
      canStyleLineEndpoints: false,
      arrowheadStart: null,
      arrowheadEnd: null,
      fill: { kind: "unavailable" },
    });
  }, [onSelectionSummaryChange]);

  useEffect(() => {
    // Two canvases can be mounted at once (the body, and a header/footer being edited), and a
    // window event reaches both. The host nulls the other request channels for the inactive one;
    // this flag is the same gate for previews, so a slider cannot repaint the other canvas's
    // selection.
    if (!acceptsStylePreview) {
      return;
    }

    const handlePreview = (event: Event) => {
      const style = (event as OverlayStylePreviewEvent).detail?.style ?? null;
      setPreview(style === null ? null : {
        style,
        targetIds: getStyleTargetIds(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current),
      });
    };

    window.addEventListener(OVERLAY_STYLE_PREVIEW_EVENT, handlePreview);
    return () => window.removeEventListener(OVERLAY_STYLE_PREVIEW_EVENT, handlePreview);
  }, [acceptsStylePreview, editPolicyLockedShapeIdsRef, selectedIdsRef, setPreview, shapesRef]);
  return {
    movingShapeIds,
    selectedShapes,
    currentTool,
    selectionChromeHidden,
    selectionImageCropShape,
    selectedDimensionShapes,
    selectionBounds,
    selectionCanResize,
    selectedLocked,
    selectionIsGraphCropping,
    selectionIsGraph3DEditing,
    selectionCanRotate,
    anchorIndicators,
    marqueeBounds,
    insertPreview,
    curveDrawing,
    curveDrawingClosed,
    adjustmentDragReadout,
    drawingHint,
  };
}
