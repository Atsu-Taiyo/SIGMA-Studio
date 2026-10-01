"use client";
import {
  appendCurveDrawingPoint,
  canRemoveLinePointAt,
  getSelectionResizeFrame,
  getSelectionRotationPivot,
  getShapeRotation,
  getShapeRotationPivot,
  hitTestShape,
  hitTestSolidEdgeAtPagePoint,
  insertLinePointAt,
  isEditableLineKind,
  isOverlayRichTextShape,
  isSolidShape,
  removeLinePointAt,
  shouldClosePolylineDrawing
} from "@/features/drawing";
import type {
  Dispatch,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
  SetStateAction
} from "react";
import {
  useCallback
} from "react";
import { isOverlaySelectionBlockedByEditPolicy } from "./edit-policy";
import {
  getShapeSelectionIds,
  getUnlockedTransformShapes,
  isShapeDescendantOf,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree
} from "./grouping";
import {
  getOverlayTool,
  type InsertTool,
  type PointHandle,
  type ResizeHandle
} from "./interaction-mode";
import {
  angleFromCenter
} from "./math";
import type { OverlayPointerDrawingPort, OverlayPointerEditingPort, OverlayPointerGeometryPort, OverlayPointerSelectionPort } from "./pointer-contracts";
import { isShapeAdjustmentHandle } from "./shape-adjustment";
import {
  isArcInsertTool,
  isClickPointDrawingTool,
  isPointSnappedClickDrawingTool
} from "./shapes/create-shape";
import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape
} from "./types";
import type { OverlayPointerSession } from "./use-pointer-session";
interface Dependencies {
  session: Pick<OverlayPointerSession,
    "capturePointer"
    | "modeRef"
    | "transitionMode"
    | "lastInteractionPointRef"
    | "resizePaddingRef"
    | "suppressNextShapeDoubleClickRef"
  >;
  editing: Pick<OverlayPointerEditingPort, "shapesRef" | "updateShape" | "editPolicyLockedShapeIdsRef" | "notifyEditPolicyBlocked">;
  selection: Pick<OverlayPointerSelectionPort,
    "selectedIdsRef"
    | "focusedGroupIdRef"
    | "setFocusedGroupId"
    | "setSelectedShapeIds"
    | "selectShape"
    | "toggleShapeSelection"
    | "setSolidEdge"
    | "duplicateSelectedShapes"
  >;
  geometry: Pick<OverlayPointerGeometryPort,
    "pagePointFromClient"
    | "getOverlaySnapThreshold"
    | "getShapeAtPoint"
    | "getOpenStrokeShapeAtPoint"
  >;
  drawing: Pick<OverlayPointerDrawingPort, "getSnappedDrawingPoint" | "finishCurveDrawing">;
  focusOverlayCanvas: () => void;
  setAdjustmentDragReadoutPointerPosition: Dispatch<SetStateAction<OverlayPoint | null>>;
  graphFillPickShapeId: string | null;
  selectedRegion: OverlayBounds | null;
}

export function useOverlayPointerStart({
  session,
  editing,
  selection,
  geometry,
  drawing,
  focusOverlayCanvas,
  setAdjustmentDragReadoutPointerPosition,
  graphFillPickShapeId,
  selectedRegion,
}: Dependencies) {
  const {
    modeRef,
    transitionMode,
    lastInteractionPointRef,
    resizePaddingRef,
    suppressNextShapeDoubleClickRef,
  } = session;
  const { shapesRef, updateShape, editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked } = editing;
  const {
    selectedIdsRef,
    focusedGroupIdRef,
    setFocusedGroupId,
    setSelectedShapeIds,
    selectShape,
    toggleShapeSelection,
    setSolidEdge,
    duplicateSelectedShapes,
  } = selection;
  const { pagePointFromClient, getOverlaySnapThreshold, getShapeAtPoint, getOpenStrokeShapeAtPoint } = geometry;
  const { getSnappedDrawingPoint, finishCurveDrawing } = drawing;
  const captureDragPointer = session.capturePointer;

  const startInsertDragFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>, tool: InsertTool) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    setSelectedShapeIds([]);
    const point = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = point;
    if (isArcInsertTool(tool)) {
      setAdjustmentDragReadoutPointerPosition(point);
    }
    transitionMode({
      type: "startInsertDrag",
      tool,
      start: point,
      points: tool.command === "freehand" ? [point] : undefined,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, lastInteractionPointRef, pagePointFromClient, setAdjustmentDragReadoutPointerPosition, setSelectedShapeIds, transitionMode]);

  const handleCurveInsertPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, tool: InsertTool) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const interaction = modeRef.current;
    const rawPoint = pagePointFromClient(event.clientX, event.clientY);
    const previousPoint = interaction.id === "overlay.curveDrawing"
      ? interaction.points[interaction.points.length - 1]
      : undefined;
    const point = getSnappedDrawingPoint(rawPoint, {
      previousPoint,
      shiftKey: event.shiftKey,
      enabled: isPointSnappedClickDrawingTool(tool),
    });

    if (interaction.id === "overlay.curveDrawing") {
      if (shouldClosePolylineDrawing(interaction.tool, interaction.points, rawPoint)) {
        finishCurveDrawing(interaction.tool, interaction.points, true);
        return;
      }

      const nextPoints = appendCurveDrawingPoint(interaction.points, point);
      if (interaction.tool.command === "threePointArc") {
        if (nextPoints.length >= 3) {
          finishCurveDrawing(interaction.tool, nextPoints.slice(0, 3));
          return;
        }

        transitionMode({ type: "addCurvePoint", point });
        return;
      }

      if (event.detail >= 2) {
        suppressNextShapeDoubleClickRef.current = window.performance.now();
        finishCurveDrawing(interaction.tool, nextPoints);
        return;
      }

      transitionMode({ type: "addCurvePoint", point });
      return;
    }

    setSelectedShapeIds([]);
    transitionMode({ type: "startCurveDrawing", tool, point });
  }, [finishCurveDrawing, focusOverlayCanvas, getSnappedDrawingPoint, modeRef, pagePointFromClient, setSelectedShapeIds, suppressNextShapeDoubleClickRef, transitionMode]);

  const handleCurveDrawingDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const interaction = modeRef.current;
    if (interaction.id !== "overlay.curveDrawing") {
      return false;
    }
    if (interaction.tool.command === "threePointArc") {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressNextShapeDoubleClickRef.current = window.performance.now();
    const rawPoint = pagePointFromClient(event.clientX, event.clientY);
    const previousPoint = interaction.points[interaction.points.length - 1];
    const point = getSnappedDrawingPoint(rawPoint, {
      previousPoint,
      shiftKey: event.shiftKey,
      enabled: isPointSnappedClickDrawingTool(interaction.tool),
    });
    finishCurveDrawing(interaction.tool, appendCurveDrawingPoint(interaction.points, point));
    return true;
  }, [finishCurveDrawing, getSnappedDrawingPoint, modeRef, pagePointFromClient, suppressNextShapeDoubleClickRef]);

  const startShapePointerInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, point: OverlayPoint) => {
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
    const modifierSelection = event.shiftKey || event.metaKey || event.ctrlKey;
    if (modifierSelection) {
      toggleShapeSelection(shapeSelectionIds);
      return;
    }

    const wasOnlySelected = selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === shape.id;
    const clickedSelectionSelected = shapeSelectionIds.every((id) => selectedIdsRef.current.includes(id));
    if (!clickedSelectionSelected) {
      setSelectedShapeIds(shapeSelectionIds);
    }
    // 立体は、すでに選んでいる状態でもう一度線をつまむと、その辺が選ばれる (線種を変える対象)。
    // 最初の 1 回目は図形全体の選択にとどめる — 辺を狙わずに立体を選んだだけで、
    // 線種の変更が 1 本の辺にだけ効いてしまわないように。線以外を押せば辺の選択は外れる。
    // 押下のあとに動かせば、そのまま立体の移動になる。
    if (isSolidShape(shape)) {
      const edge = wasOnlySelected && !event.altKey
        ? hitTestSolidEdgeAtPagePoint(shape, point, getOverlaySnapThreshold() * 0.75)
        : null;
      setSolidEdge(edge === null ? null : { shapeId: shape.id, index: edge });
    }
    if (event.altKey) {
      const duplicatedShapes = duplicateSelectedShapes({ x: 0, y: 0 });
      if (duplicatedShapes.length === 0) {
        return;
      }
      transitionMode({
        type: "startMove",
        shapes: duplicatedShapes,
        start: point,
      });
      captureDragPointer(event);
      return;
    }

    const moveCandidateIds = clickedSelectionSelected ? selectedIdsRef.current : shapeSelectionIds;
    const moveShapesSnapshot = getUnlockedTransformShapes(shapesRef.current, moveCandidateIds, editPolicyLockedShapeIdsRef.current);
    if (moveShapesSnapshot.length === 0) {
      // Note: this silently absorbs the single-shape click-drag case (the
      // pre-filter above already excludes the policy-locked shape before a
      // "startMove" action is even built, so the central `transitionMode`
      // guard below never gets a chance to run) -- surface the same notice
      // here so the user still learns why nothing happened.
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, moveCandidateIds, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }

    transitionMode({
      type: "startMove",
      shapes: moveShapesSnapshot,
      start: point,
      editOnPointerUp: isOverlayRichTextShape(shape) && wasOnlySelected
        ? "text"
        : shape.type === "tableShape" && wasOnlySelected
          ? "table"
          : undefined,
    });
    captureDragPointer(event);
  }, [captureDragPointer, duplicateSelectedShapes, editPolicyLockedShapeIdsRef, focusOverlayCanvas, focusedGroupIdRef, getOverlaySnapThreshold, notifyEditPolicyBlocked, selectedIdsRef, setFocusedGroupId, setSelectedShapeIds, setSolidEdge, shapesRef, toggleShapeSelection, transitionMode]);

  /**
   * インクに当たらなかった押下の共通処理 (選択を落としてマーキーを始める)。
   *
   * 図形の DIV は `getShapeBounds` の箱、つまり「変形の基準箱」であってインクの範囲ではない。
   * 円弧は `x = 中心 - r` で元の円まるごとを箱に持つので、90°の弧でも円ひとつ分の DIV が
   * 本文の上に乗る。当たり判定は幾何 (`hitTestShape`) だけが決め、外したらここへ来て
   * 空白面と同じ扱いにする。
   */
  const beginEmptySpacePointerInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>, point: OverlayPoint) => {
    focusOverlayCanvas();
    if (focusedGroupIdRef.current) {
      focusedGroupIdRef.current = null;
      setFocusedGroupId(null);
    }
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!additive) {
      setSelectedShapeIds([]);
    }
    transitionMode({ type: "startMarquee", start: point, additive });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, focusedGroupIdRef, setFocusedGroupId, setSelectedShapeIds, transitionMode]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".overlay-text-shape-content, .graph2d-container.cropping")) {
      return;
    }

    // portal されたポップオーバー (3点メニュー等) の合成イベントは React ツリーを
    // 遡ってここへ届く。掴むと pointer capture を取って click が成立しなくなる。
    if (target?.closest("[data-toolbar-popover]")) {
      return;
    }

    const currentTool = getOverlayTool(modeRef.current);
    if (currentTool.kind === "insert") {
      if (isClickPointDrawingTool(currentTool)) {
        handleCurveInsertPointerDown(event, currentTool);
        return;
      }
      startInsertDragFromEvent(event, currentTool);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    if (!target?.closest("[data-overlay-shape-id]")) {
      focusOverlayCanvas();
      const hitOpenStrokeShape = getOpenStrokeShapeAtPoint(point);
      if (hitOpenStrokeShape) {
        startShapePointerInteraction(event, hitOpenStrokeShape, point);
        return;
      }
      if (selectedRegion && !event.shiftKey && !event.metaKey && !event.ctrlKey &&
        point.x >= selectedRegion.x && point.x <= selectedRegion.x + selectedRegion.w &&
        point.y >= selectedRegion.y && point.y <= selectedRegion.y + selectedRegion.h) {
        event.preventDefault();
        return;
      }
      beginEmptySpacePointerInteraction(event, point);
    }
  }, [graphFillPickShapeId, modeRef, pagePointFromClient, startInsertDragFromEvent, handleCurveInsertPointerDown, focusOverlayCanvas, getOpenStrokeShapeAtPoint, selectedRegion, beginEmptySpacePointerInteraction, startShapePointerInteraction]);

  /**
   * 図形の DIV が受け取った押下。押された DIV が持ち主だとは決めつけず、必ず幾何で選び直す
   * (DIV は外接矩形なので、円弧のように箱の大半が空白の図形ではインクを外していても当たる)。
   */
  const handleShapePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    if (event.target instanceof Element && event.target.closest(".overlay-text-shape-content, .overlay-table-shape-content, .graph2d-container.cropping")) {
      return;
    }

    const currentTool = getOverlayTool(modeRef.current);
    if (currentTool.kind === "insert") {
      if (isClickPointDrawingTool(currentTool)) {
        handleCurveInsertPointerDown(event, currentTool);
        return;
      }
      startInsertDragFromEvent(event, currentTool);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const targetShape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!targetShape) {
      // DIV には当たったがインクには当たっていない (円弧の内側など)。図形の中に置かれた
      // 操作系 — AI ロックの停止ボタンのような — だけは素通しし、それ以外は空白面と同じに扱う。
      // ここで `shape` へ流すと、描かれていないところを押しただけで選択されてしまう。
      if (event.target instanceof Element && event.target.closest("button, a, input, textarea, [contenteditable='true'], [data-toolbar-popover]")) {
        return;
      }
      beginEmptySpacePointerInteraction(event, point);
      return;
    }
    if (targetShape.type === "graph2dShape" && !hitTestShape(targetShape, point, 0)) {
      return;
    }

    const currentMode = modeRef.current;
    if (currentMode.id === "overlay.imageCropping" && currentMode.shapeId === targetShape.id && targetShape.type === "image") {
      event.preventDefault();
      event.stopPropagation();
      focusOverlayCanvas();
      selectShape(targetShape.id);
      transitionMode({ type: "startImageCropPan", shape: targetShape, start: point });
      captureDragPointer(event);
      return;
    }

    startShapePointerInteraction(event, targetShape, point);
  }, [beginEmptySpacePointerInteraction, captureDragPointer, focusOverlayCanvas, getOpenStrokeShapeAtPoint, getShapeAtPoint, graphFillPickShapeId, handleCurveInsertPointerDown, modeRef, pagePointFromClient, selectShape, startInsertDragFromEvent, startShapePointerInteraction, transitionMode]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, handle: ResizeHandle) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
    // 変形する集合 (グループはメンバーへ展開、ロック済みは除外) の見えている箱を掴む。
    // 描画側の枠は `selectedShapes` で作るので、ロックされたメンバーがいる選択では両者が
    // ずれるが、それは WI-15 以前と同じ — ロックの意味論を変えないためこちらを出典にする。
    const frame = getSelectionResizeFrame(selectedShapes, shapesRef.current);
    if (!frame) {
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }
    const start = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = start;
    resizePaddingRef.current = frame.padding;

    transitionMode({
      type: "startResize",
      shapes: selectedShapes,
      handle,
      start,
      bounds: frame.visual,
    });
    captureDragPointer(event);
  }, [captureDragPointer, editPolicyLockedShapeIdsRef, focusOverlayCanvas, lastInteractionPointRef, notifyEditPolicyBlocked, pagePointFromClient, resizePaddingRef, selectedIdsRef, shapesRef, transitionMode]);

  const handleImageCropResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: Extract<OverlayShape, { type: "image" }>, handle: ResizeHandle) => {
    if (shape.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);
    const start = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = start;
    transitionMode({
      type: "startImageCropResize",
      shape,
      handle,
      start,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, lastInteractionPointRef, pagePointFromClient, selectShape, transitionMode]);

  const handleRotatePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
    // The gesture turns the selection around the same point it is drawn turning about, so the
    // figure follows the pointer instead of swinging away from it.
    const center = getSelectionRotationPivot(selectedShapes, shapesRef.current);
    if (!center) {
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    transitionMode({
      type: "startRotate",
      shapes: selectedShapes,
      center,
      startAngle: angleFromCenter(center, point),
    });
    captureDragPointer(event);
  }, [captureDragPointer, editPolicyLockedShapeIdsRef, focusOverlayCanvas, notifyEditPolicyBlocked, pagePointFromClient, selectedIdsRef, shapesRef, transitionMode]);

  const handleAnchorPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, shape: OverlayShape, origin: OverlayPoint) => {
    if (event.button !== 0 || shape.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);
    transitionMode({
      type: "startAnchorDrag",
      shape,
      start: pagePointFromClient(event.clientX, event.clientY),
      origin,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, pagePointFromClient, selectShape, transitionMode]);

  const handlePointPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, handle: PointHandle) => {
    if (shape.locked || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);

    // Alt+click removes the point instead of dragging it. Refused rather than clamped when the line
    // would stop being a line (or when it is the origin point every other point is measured from),
    // so the shape can never jump as a side effect of an edit.
    //
    // `isEditableLineKind` matters: a freehand stroke shows handles only at its two ends and offers
    // no way to put a point back, so removal there would be one-way damage.
    if (event.altKey && shape.type === "line" && handle.type === "line" && isEditableLineKind(shape.props.kind)) {
      // `InTree`, not `shape.locked`: a line inside a locked group is locked too, and this deletes
      // rather than moves — the one place where getting that wrong is not undoable by dragging back.
      if (isShapeLockedInTree(shapesRef.current, shape)) {
        return;
      }
      if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
        return;
      }
      if (canRemoveLinePointAt(shape.props.points, handle.index, shape.props.closed === true)) {
        updateShape({
          ...shape,
          props: { ...shape.props, points: removeLinePointAt(shape.props.points, handle.index) },
        });
      }
      return;
    }
    if (isShapeAdjustmentHandle(handle)) {
      setAdjustmentDragReadoutPointerPosition(pagePointFromClient(event.clientX, event.clientY));
    }
    transitionMode({
      type: "startPoint",
      shape,
      handle,
      pivot: getShapeRotationPivot(shape),
      rotation: getShapeRotation(shape),
    });
    captureDragPointer(event);
  }, [captureDragPointer, editPolicyLockedShapeIdsRef, focusOverlayCanvas, notifyEditPolicyBlocked, pagePointFromClient, selectShape, setAdjustmentDragReadoutPointerPosition, shapesRef, transitionMode, updateShape]);

  /**
   * Grabbing a midpoint handle.
   *
   * The point is inserted first and the ordinary vertex drag takes over from there, so nothing in
   * the point-editing code has to learn about "insert". Modeled after the interaction pattern used
   * by external canvas editors, whose create-handles promote themselves on drag start.
   *
   * The drag is handed the *new* shape: `applyPointInteractionAtPoint` works from the snapshot it
   * was given, so passing the pre-insert one would roll the point back the moment the pointer moves.
   */
  const handleLineInsertPointerDown = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    shape: Extract<OverlayShape, { type: "line" }>,
    index: number,
    point: OverlayPoint,
  ) => {
    if (event.button !== 0 || isShapeLockedInTree(shapesRef.current, shape)) {
      return;
    }
    if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
      // Say so rather than leaving a handle that does nothing, the way every other refusal here does.
      notifyEditPolicyBlocked();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);

    const nextShape: OverlayShape = {
      ...shape,
      props: {
        ...shape.props,
        points: insertLinePointAt(shape.props.points, index, point),
      },
    };
    // Coalesced: the drag that follows records the step, and a press held past the save debounce
    // would otherwise leave a bare insert behind for one extra undo.
    updateShape(nextShape, { history: "coalesce" });
    transitionMode({
      type: "startPoint",
      shape: nextShape,
      handle: { type: "line", index },
      pivot: getShapeRotationPivot(nextShape),
      rotation: getShapeRotation(nextShape),
    });
    // Never `event.currentTarget.setPointerCapture`: a per-shape capture swallows the canvas's own
    // double-click handling. The bleed surface is the one element allowed to capture.
    captureDragPointer(event);
  }, [captureDragPointer, editPolicyLockedShapeIdsRef, focusOverlayCanvas, notifyEditPolicyBlocked, selectShape, shapesRef, transitionMode, updateShape]);
  return {
    handleCurveDrawingDoubleClick,
    handleCanvasPointerDown,
    handleShapePointerDown,
    handleResizePointerDown,
    handleImageCropResizePointerDown,
    handleRotatePointerDown,
    handlePointPointerDown,
    handleLineInsertPointerDown,
    handleAnchorPointerDown,
  };
}
