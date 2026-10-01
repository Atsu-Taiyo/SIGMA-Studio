"use client";
import {
  OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT,
} from "@/components/editor/Graph3DSettingsPanel";
import {
  getTablePlacementBounds, hitTestSolidEdgeAtPagePoint,
  isSolidShape, mergeShapesById, moveShapes, resolveRotatePointerDelta,
  rotateShapesAround
} from "@/features/drawing";
import { OPEN_TIKZ_EDITOR_EVENT } from "@/lib/tikz-contract";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction
} from "react";
import {
  useCallback,
  useEffect,
  useLayoutEffect
} from "react";
import {
  createDragAutoScroller,
  findDragAutoScrollScroller,
  getDragAutoScrollViewportBounds,
  panDragAutoScrollElement,
  type DragAutoScrollPanBy
} from "../drag-auto-scroll";
import {
  type OverlayChangeOptions,
  type OverlaySolidEdgeSelection
} from "../page-overlay-types";
import {
  normalizeOverlayGroups
} from "./grouping";
import { getAnchorDragPosition, isDragAutoScrollInteraction, pickAnchorForHandleDrop } from "./interaction-geometry";
import {
  isInteractionMode,
  resolveMovePointerUp,
  type OverlayInteractionMode
} from "./interaction-mode";
import { getMarqueeSelectionIds } from "./marquee-selection";
import {
  boundsFromPoints
} from "./math";
import type { OverlayPointerDrawingPort, OverlayPointerEditingPort, OverlayPointerGeometryPort, OverlayPointerSelectionPort, OverlayPointerTransformsPort } from "./pointer-contracts";
import {
  areOverlayAnchorsEqual,
  inheritGroupAnchorsForMembers,
  reanchorShapesByPosition
} from "./reanchor-model";
import { isShapeAdjustmentHandle } from "./shape-adjustment";
import {
  isArcInsertTool,
  isPointSnappedClickDrawingTool
} from "./shapes/create-shape";
import { bindTablePlacementFeedback, finishTablePlacementFeedback, hasTablePlacementFeedback } from "./table-placement-feedback";
import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape
} from "./types";
import type { OverlayPointerSession } from "./use-pointer-session";
const ANCHOR_DRAG_SLOP_PX = 2;
const DRAG_AUTO_SCROLL_SLOP_PX = 8;
const SHAPE_DRAG_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC = 1100;
interface Dependencies {
  session: Pick<OverlayPointerSession,
    "modeRef"
    | "transitionMode"
    | "bleedSurfaceRef"
    | "lastInteractionPointRef"
    | "dragPointerRef"
    | "dragCanvasRectRef"
    | "lastPointerModifiersRef"
    | "advanceInteractionFromClientRef"
    | "dragAutoScrollerRef"
  >;
  editing: Pick<OverlayPointerEditingPort, "shapesRef" | "setShapes" | "editPolicyLockedShapeIdsRef">;
  selection: Pick<OverlayPointerSelectionPort, "selectedIdsRef" | "focusedGroupIdRef" | "setSelectedShapeIds" | "selectShape">;
  geometry: Pick<OverlayPointerGeometryPort,
    "pagePointFromClient"
    | "clientPointFromPage"
    | "getOverlaySnapThreshold"
    | "getShapeAtPoint"
    | "getOpenStrokeShapeAtPoint"
    | "refreshAnchorMeasurements"
  >;
  drawing: Pick<OverlayPointerDrawingPort, "getSnappedDrawingPoint" | "getSnappedInsertDragPoint" | "createShapeFromInsertDrag">;
  transforms: Pick<OverlayPointerTransformsPort,
    "applyMoveInteractionAtPoint"
    | "applyResizeInteractionAtPoint"
    | "applyPointInteractionAtPoint"
    | "applyImageCropInteractionAtPoint"
  >;
  clearSnapGuides: () => void;
  setAdjustmentDragReadoutPointerPosition: Dispatch<SetStateAction<OverlayPoint | null>>;
  canvasRef: RefObject<HTMLDivElement | null>;
  autoScrollPanBy: DragAutoScrollPanBy | undefined;
  autoScrollViewportElement: HTMLElement | null;
  originPickShapeId: string | null;
  updateOriginPickPreviewFromEvent: (event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "clientY">) => void;
  setHoverSolidEdge: Dispatch<SetStateAction<OverlaySolidEdgeSelection | null>>;
  mode: OverlayInteractionMode;
  cancelTablePlacement: () => void;
  restoreTransientInteraction: (interaction: OverlayInteractionMode) => void;
  setRegionSelection: Dispatch<SetStateAction<{ documentId: string | undefined; revision: number; bounds: OverlayBounds; } | null>>;
  handledCommandRequestIdRef: RefObject<number | null>;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  documentId: string | undefined;
  onRequestTextMode: (screenPoint?: { x: number; y: number; }) => void;
  retainEmptySelection: boolean;
  externalRevision: number;
  onRequestTextSelection: ((screenStart: { x: number; y: number; }, screenEnd: { x: number; y: number; }) => void) | undefined;
  queueDirtyImageCropSave: () => void;
}

export function useOverlayPointerLifecycle({
  session,
  editing,
  selection,
  geometry,
  drawing,
  transforms,
  clearSnapGuides,
  setAdjustmentDragReadoutPointerPosition,
  canvasRef,
  autoScrollPanBy,
  autoScrollViewportElement,
  originPickShapeId,
  updateOriginPickPreviewFromEvent,
  setHoverSolidEdge,
  mode,
  cancelTablePlacement,
  restoreTransientInteraction,
  setRegionSelection,
  handledCommandRequestIdRef,
  queueOverlaySave,
  documentId,
  onRequestTextMode,
  retainEmptySelection,
  externalRevision,
  onRequestTextSelection,
  queueDirtyImageCropSave,
}: Dependencies) {
  const {
    modeRef,
    transitionMode,
    bleedSurfaceRef,
    lastInteractionPointRef,
    dragPointerRef,
    dragCanvasRectRef,
    lastPointerModifiersRef,
    advanceInteractionFromClientRef,
    dragAutoScrollerRef,
  } = session;
  const { shapesRef, setShapes, editPolicyLockedShapeIdsRef } = editing;
  const { selectedIdsRef, focusedGroupIdRef, setSelectedShapeIds, selectShape } = selection;
  const {
    pagePointFromClient,
    clientPointFromPage,
    getOverlaySnapThreshold,
    getShapeAtPoint,
    getOpenStrokeShapeAtPoint,
    refreshAnchorMeasurements,
  } = geometry;
  const { getSnappedDrawingPoint, getSnappedInsertDragPoint, createShapeFromInsertDrag } = drawing;
  const {
    applyMoveInteractionAtPoint,
    applyResizeInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyImageCropInteractionAtPoint,
  } = transforms;

  const advanceInteractionFromClient = useCallback((
    clientX: number,
    clientY: number,
    modifiers: { ctrlKey: boolean; shiftKey: boolean },
    cachedCanvasRect?: { left: number; top: number; width: number; height: number } | null,
  ) => {
    const interaction = modeRef.current;
    if (!isInteractionMode(interaction)) {
      return;
    }

    const point = pagePointFromClient(clientX, clientY, cachedCanvasRect);
    lastInteractionPointRef.current = point;
    if (interaction.id === "overlay.move") {
      applyMoveInteractionAtPoint(interaction, point);
      return;
    }

    if (interaction.id === "overlay.resize") {
      applyResizeInteractionAtPoint(interaction, point, modifiers);
      return;
    }

    if (interaction.id === "overlay.rotate") {
      clearSnapGuides();
      const nextDelta = resolveRotatePointerDelta(interaction, point, modifiers.shiftKey);
      setShapes((current) => {
        const next = normalizeOverlayGroups(mergeShapesById(current, rotateShapesAround(interaction.shapes, interaction.center, nextDelta)));
        shapesRef.current = next;
        return next;
      });
      return;
    }

    if (interaction.id === "overlay.anchor") {
      clearSnapGuides();
      transitionMode({ type: "updateAnchorDrag", current: point });
      return;
    }

    if (interaction.id === "overlay.marquee") {
      clearSnapGuides();
      transitionMode({ type: "updateMarquee", current: point });
      return;
    }

    if (interaction.id === "overlay.point") {
      applyPointInteractionAtPoint(interaction, point, modifiers);
      if (isShapeAdjustmentHandle(interaction.handle)) {
        setAdjustmentDragReadoutPointerPosition(point);
      }
      return;
    }

    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      applyImageCropInteractionAtPoint(interaction, point);
      return;
    }

    if (interaction.id === "overlay.curveDrawing") {
      const previousPoint = interaction.points[interaction.points.length - 1];
      transitionMode({
        type: "updateCurveDrawing",
        current: getSnappedDrawingPoint(point, {
          previousPoint,
          shiftKey: modifiers.shiftKey,
          enabled: isPointSnappedClickDrawingTool(interaction.tool),
        }),
      });
      return;
    }

    if (interaction.id === "overlay.insertDrag") {
      if (interaction.tool.command === "table" && hasTablePlacementFeedback()) return;
      const current = getSnappedInsertDragPoint(interaction.tool, interaction.start, point, modifiers);
      if (interaction.tool.command === "table" && interaction.tool.tableCellSize) {
        const before = getTablePlacementBounds(interaction.start, interaction.current, interaction.tool.tableCellSize);
        const after = getTablePlacementBounds(interaction.start, current, interaction.tool.tableCellSize);
        // Pointer motion inside the same cell does not need a document-canvas render.
        if (before.x === after.x && before.y === after.y && before.w === after.w && before.h === after.h) return;
      }
      transitionMode({
        type: "updateInsertDrag",
        current,
        point: interaction.tool.command === "freehand" ? current : undefined,
      });
      if (isArcInsertTool(interaction.tool)) {
        setAdjustmentDragReadoutPointerPosition(point);
      }
      return;
    }
  }, [modeRef, pagePointFromClient, lastInteractionPointRef, applyMoveInteractionAtPoint, applyResizeInteractionAtPoint, clearSnapGuides, setShapes, shapesRef, transitionMode, applyPointInteractionAtPoint, setAdjustmentDragReadoutPointerPosition, applyImageCropInteractionAtPoint, getSnappedDrawingPoint, getSnappedInsertDragPoint]);

  useLayoutEffect(() => {
    advanceInteractionFromClientRef.current = advanceInteractionFromClient;
  }, [advanceInteractionFromClient, advanceInteractionFromClientRef]);

  const stopDragAutoScroll = useCallback(() => {
    dragAutoScrollerRef.current?.stop();
    dragAutoScrollerRef.current = null;
  }, [dragAutoScrollerRef]);

  const updateDragAutoScroll = useCallback((clientX: number, clientY: number) => {
    if (!isDragAutoScrollInteraction(modeRef.current)) {
      stopDragAutoScroll();
      return;
    }

    if (!dragAutoScrollerRef.current) {
      const startElement = canvasRef.current ?? bleedSurfaceRef.current;
      const scrollContainer = startElement && !autoScrollPanBy
        ? findDragAutoScrollScroller(startElement)
        : null;
      const viewportElement = autoScrollViewportElement ?? scrollContainer;
      if (!viewportElement) {
        return;
      }
      const ownerWindow = viewportElement.ownerDocument.defaultView;
      if (!ownerWindow) {
        return;
      }
      const panBy = autoScrollPanBy ?? (
        scrollContainer
          ? (dx: number, dy: number) => panDragAutoScrollElement(scrollContainer, dx, dy)
          : null
      );
      if (!panBy) {
        return;
      }
      dragAutoScrollerRef.current = createDragAutoScroller({
        ownerWindow,
        getViewportBounds: () => getDragAutoScrollViewportBounds(viewportElement, ownerWindow),
        panBy,
        onPan: (lastClientX, lastClientY, layout) => {
          if (!isDragAutoScrollInteraction(modeRef.current)) {
            stopDragAutoScroll();
            return;
          }
          advanceInteractionFromClientRef.current(
            lastClientX,
            lastClientY,
            lastPointerModifiersRef.current,
            layout.rectSettled ? null : dragCanvasRectRef.current,
          );
        },
        maxSpeedPxPerSec: SHAPE_DRAG_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC,
      });
    }
    dragAutoScrollerRef.current.update(clientX, clientY);
  }, [advanceInteractionFromClientRef, autoScrollPanBy, autoScrollViewportElement, bleedSurfaceRef, canvasRef, dragAutoScrollerRef, dragCanvasRectRef, lastPointerModifiersRef, modeRef, stopDragAutoScroll]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (originPickShapeId) {
      updateOriginPickPreviewFromEvent(event);
    }

    lastPointerModifiersRef.current = {
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    };
    // 立体を 1 つだけ選んでいるときは、ポインタの下の辺をうっすら示す。ドラッグ中は出さない。
    const soleShape = selectedIdsRef.current.length === 1
      ? shapesRef.current.find((shape) => shape.id === selectedIdsRef.current[0])
      : undefined;
    if (soleShape && isSolidShape(soleShape) && !soleShape.locked && event.buttons === 0 && modeRef.current.id === "overlay.select") {
      const edge = hitTestSolidEdgeAtPagePoint(
        soleShape,
        pagePointFromClient(event.clientX, event.clientY),
        getOverlaySnapThreshold() * 0.75,
      );
      setHoverSolidEdge((current) => (
        current?.shapeId === soleShape.id && current.index === edge
          ? current
          : edge === null ? null : { shapeId: soleShape.id, index: edge }
      ));
    } else {
      setHoverSolidEdge((current) => (current === null ? current : null));
    }
    advanceInteractionFromClient(event.clientX, event.clientY, lastPointerModifiersRef.current);
    const dragPointer = dragPointerRef.current;
    if (event.buttons !== 0 && dragPointer?.pointerId === event.pointerId) {
      if (!dragPointer.autoScrollArmed) {
        dragPointer.autoScrollArmed = Math.hypot(
          event.clientX - dragPointer.startClientX,
          event.clientY - dragPointer.startClientY,
        ) > DRAG_AUTO_SCROLL_SLOP_PX;
      }
      if (dragPointer.autoScrollArmed) {
        updateDragAutoScroll(event.clientX, event.clientY);
      } else {
        stopDragAutoScroll();
      }
    } else {
      stopDragAutoScroll();
    }
  }, [advanceInteractionFromClient, dragPointerRef, getOverlaySnapThreshold, lastPointerModifiersRef, modeRef, originPickShapeId, pagePointFromClient, selectedIdsRef, setHoverSolidEdge, shapesRef, stopDragAutoScroll, updateDragAutoScroll, updateOriginPickPreviewFromEvent]);

  useEffect(() => {
    if (!isDragAutoScrollInteraction(mode)) {
      stopDragAutoScroll();
    }
  }, [mode, stopDragAutoScroll]);

  useEffect(() => stopDragAutoScroll, [stopDragAutoScroll]);

  const handlePointerCancel = useCallback(() => {
    const tool = modeRef.current.tool;
    if (tool.kind === "insert" && tool.command === "table") {
      cancelTablePlacement();
      return;
    }
    const pointerId = dragPointerRef.current?.pointerId;
    if (pointerId !== undefined && bleedSurfaceRef.current?.hasPointerCapture(pointerId)) {
      bleedSurfaceRef.current.releasePointerCapture(pointerId);
    }
    dragPointerRef.current = null;
    stopDragAutoScroll();
    const interaction = modeRef.current;
    if (isInteractionMode(interaction)) {
      restoreTransientInteraction(interaction);
      setRegionSelection(null);
      transitionMode({ type: "select" });
    }
  }, [bleedSurfaceRef, cancelTablePlacement, dragPointerRef, modeRef, restoreTransientInteraction, setRegionSelection, stopDragAutoScroll, transitionMode]);

  useLayoutEffect(() => {
    const tool = mode.tool;
    if (tool.kind !== "insert" || tool.command !== "table" || !tool.tableCellSize) return;
    const modelStart = (client: OverlayPoint) => modeRef.current.id === "overlay.insertDrag"
      ? modeRef.current.start : pagePointFromClient(client.x, client.y);
    return bindTablePlacementFeedback(handledCommandRequestIdRef.current!, {
      bounds: (start, end) => {
        const box = getTablePlacementBounds(modelStart(start), pagePointFromClient(end.x, end.y), tool.tableCellSize!);
        const topLeft = clientPointFromPage(box);
        const bottomRight = clientPointFromPage({ x: box.x + box.w, y: box.y + box.h });
        const w = bottomRight.x - topLeft.x;
        const h = bottomRight.y - topLeft.y;
        return { ...box, ...topLeft, w, h, cellW: w / box.columns, cellH: h / box.rows };
      },
      freeze: () => {
        const pointerId = dragPointerRef.current?.pointerId;
        if (pointerId !== undefined && bleedSurfaceRef.current?.hasPointerCapture(pointerId)) {
          bleedSurfaceRef.current.releasePointerCapture(pointerId);
        }
        dragPointerRef.current = null;
        stopDragAutoScroll();
      },
      cancel: cancelTablePlacement,
      commit: (start, end) => {
        const first = modelStart(start);
        const last = pagePointFromClient(end.x, end.y);
        cancelTablePlacement();
        const id = createShapeFromInsertDrag(tool, first, last);
        if (id) transitionMode({ type: "editTable", shapeId: id });
        else finishTablePlacementFeedback();
      },
    });
  }, [mode.tool, cancelTablePlacement, clientPointFromPage, createShapeFromInsertDrag, pagePointFromClient, stopDragAutoScroll, transitionMode, handledCommandRequestIdRef, modeRef, dragPointerRef, bleedSurfaceRef]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragPointerRef.current = null;
    stopDragAutoScroll();
    const interaction = modeRef.current;
    if (!isInteractionMode(interaction)) {
      return;
    }
    let shouldSaveOverlay = interaction.id === "overlay.resize" ||
      interaction.id === "overlay.point" ||
      interaction.id === "overlay.imageCropResize" ||
      interaction.id === "overlay.imageCropPan";

    const moveResolution = interaction.id === "overlay.move"
      ? resolveMovePointerUp(
        interaction,
        pagePointFromClient(event.clientX, event.clientY),
      )
      : null;
    if (moveResolution?.kind === "edit") {
      if (moveResolution.editor === "table") {
        transitionMode({ type: "editTable", shapeId: moveResolution.shapeId });
      } else {
        transitionMode({ type: "editText", shapeId: moveResolution.shapeId });
      }
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      clearSnapGuides();
      return;
    }

    if (interaction.id === "overlay.anchor") {
      const point = pagePointFromClient(event.clientX, event.clientY);
      const dropPoint = getAnchorDragPosition({ ...interaction, current: point });
      // A click that never moved is not a rebind: the rule snaps to boundaries,
      // so re-picking one from the resting position could shift it by a line.
      const moved = Math.abs(point.x - interaction.start.x) > ANCHOR_DRAG_SLOP_PX ||
        Math.abs(point.y - interaction.start.y) > ANCHOR_DRAG_SLOP_PX;
      const measurements = refreshAnchorMeasurements();
      const currentShape = shapesRef.current.find((shape) => shape.id === interaction.shape.id);
      const anchor = moved && currentShape && !currentShape.locked
        ? pickAnchorForHandleDrop(currentShape, dropPoint, measurements)
        : null;
      const anchorChanged = Boolean(anchor && !areOverlayAnchorsEqual(currentShape?.anchor, anchor));
      if (anchor && anchorChanged) {
        setShapes((current) => {
          const rebound = current.map((shape) => {
            if (shape.id !== interaction.shape.id || areOverlayAnchorsEqual(shape.anchor, anchor)) {
              return shape;
            }

            return { ...shape, anchor } as OverlayShape;
          });
          // Dropping a group's rule rebinds the whole unit: its members hang from the block the
          // user chose, not from wherever each of them was picked before.
          const next = inheritGroupAnchorsForMembers(rebound, measurements.ordered);
          shapesRef.current = next;
          return next;
        });
      }

      transitionMode({ type: "select" });
      clearSnapGuides();
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      if (anchorChanged) {
        queueOverlaySave();
      }
      return;
    }

    if (interaction.id === "overlay.move") {
      const tapped = interaction.shapes.length === 1 ? interaction.shapes[0] : null;
      const release = pagePointFromClient(event.clientX, event.clientY);
      if (moveResolution?.kind === "noop" && tapped?.type === "image" && tapped.props.tikz &&
        !tapped.locked && !editPolicyLockedShapeIdsRef.current.has(tapped.id) &&
        !event.shiftKey && !event.metaKey && !event.ctrlKey &&
        Math.hypot(release.x - interaction.start.x, release.y - interaction.start.y) < 3) {
        window.dispatchEvent(new CustomEvent(OPEN_TIKZ_EDITOR_EVENT, { detail: { documentId, shapeId: tapped.id } }));
      }
      if (moveResolution?.kind === "commit") {
        const { offset } = moveResolution;
        shouldSaveOverlay = true;
        const movedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
        const movedShapes = moveShapes(interaction.shapes, offset.x, offset.y);
        const { ordered } = refreshAnchorMeasurements();
        setShapes((current) => {
          const next = normalizeOverlayGroups(reanchorShapesByPosition(
            mergeShapesById(current, movedShapes),
            movedIdSet,
            ordered,
          ));
          shapesRef.current = next;
          return next;
        });
      }
    }

    if (interaction.id === "overlay.curveDrawing") {
      return;
    }

    if (interaction.id === "overlay.marquee") {
      const marqueeBounds = boundsFromPoints([interaction.start, interaction.current]);
      if (Math.hypot(marqueeBounds.w, marqueeBounds.h) < 3) {
        if (interaction.selectOnClick) {
          const clickPoint = pagePointFromClient(event.clientX, event.clientY);
          const hitShape = getShapeAtPoint(clickPoint, 8) ?? getOpenStrokeShapeAtPoint(clickPoint);
          if (hitShape) {
            selectShape(hitShape.id);
          } else {
            setSelectedShapeIds([]);
          }
        } else if (!interaction.additive) {
          setSelectedShapeIds([]);
          onRequestTextMode({ x: event.clientX, y: event.clientY });
        }
      } else {
        const marqueeIds = getMarqueeSelectionIds({
          shapes: shapesRef.current,
          marquee: marqueeBounds,
          focusedGroupId: focusedGroupIdRef.current,
          currentIds: selectedIdsRef.current,
          additive: interaction.additive,
        });
        setSelectedShapeIds(marqueeIds);
        if (retainEmptySelection && marqueeIds.length === 0 && !interaction.additive &&
          marqueeBounds.w > 0 && marqueeBounds.h > 0) {
          setRegionSelection({ documentId, revision: externalRevision, bounds: marqueeBounds });
        }
        // 図形を1つも囲まなかったドラッグは、図形選択ではなく本文の範囲選択だった。
        // 空振りのクリックが本文へ抜けるのと同じ規約で、掴んだ範囲ごと本文へ渡す
        // (本文の上で始まったドラッグかどうかは受け手が確かめる — 余白での空振りマーキーで
        //  図形モードを降りてしまわないように)。
        if (marqueeIds.length === 0 && !interaction.additive && !interaction.selectOnClick) {
          onRequestTextSelection?.(
            clientPointFromPage(interaction.start),
            { x: event.clientX, y: event.clientY },
          );
        }
      }
    }

    if (interaction.id === "overlay.insertDrag") {
      const rawPoint = pagePointFromClient(event.clientX, event.clientY);
      const point = getSnappedInsertDragPoint(interaction.tool, interaction.start, rawPoint, event);
      const dragDistance = Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y);
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      if (dragDistance < 4 && interaction.tool.command !== "table") {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        onRequestTextMode({ x: event.clientX, y: event.clientY });
        clearSnapGuides();
        return;
      }
      const insertedShapeId = createShapeFromInsertDrag(
        interaction.tool,
        interaction.start,
        point,
        interaction.tool.command === "freehand"
          ? [...(interaction.points ?? [interaction.start]), point]
          : interaction.points,
      );
      if (interaction.tool.command === "graph" && insertedShapeId) {
        transitionMode({ type: "pickOrigin", shapeId: insertedShapeId, initial: true });
      } else if (interaction.tool.command === "graph3d" && insertedShapeId) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        transitionMode({ type: "editGraph3D", shapeId: insertedShapeId });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, {
            detail: { shapeId: insertedShapeId },
          }));
        }, 0);
      } else if (interaction.tool.command === "table" && insertedShapeId) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        transitionMode({ type: "editTable", shapeId: insertedShapeId });
      } else if (interaction.tool.command === "text" && insertedShapeId) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        transitionMode({ type: "editText", shapeId: insertedShapeId });
      } else {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
      }
      clearSnapGuides();
      return;
    }

    clearSnapGuides();
    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      transitionMode({ type: "editImageCrop", shapeId: interaction.shape.id });
    } else {
      transitionMode({ type: "select" });
    }
    if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
      bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
    }
    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      queueDirtyImageCropSave();
    } else if (shouldSaveOverlay) {
      queueOverlaySave();
    }
  }, [dragPointerRef, stopDragAutoScroll, modeRef, pagePointFromClient, clearSnapGuides, bleedSurfaceRef, transitionMode, refreshAnchorMeasurements, shapesRef, setShapes, queueOverlaySave, editPolicyLockedShapeIdsRef, documentId, getShapeAtPoint, getOpenStrokeShapeAtPoint, selectShape, setSelectedShapeIds, onRequestTextMode, focusedGroupIdRef, selectedIdsRef, retainEmptySelection, setRegionSelection, externalRevision, onRequestTextSelection, clientPointFromPage, getSnappedInsertDragPoint, createShapeFromInsertDrag, queueDirtyImageCropSave]);
  // Layout cleanup restores a transient preview before passive save cleanup can flush it.
  // External snapshot adoption remains the owner of the next document's shapes/selection.
  useLayoutEffect(() => {
    const surface = bleedSurfaceRef.current;
    return () => {
      const pointerId = dragPointerRef.current?.pointerId;
      if (pointerId !== undefined && surface?.hasPointerCapture(pointerId)) surface.releasePointerCapture(pointerId);
      dragPointerRef.current = null;
      stopDragAutoScroll();
      // This ref stores the live gesture, rather than a DOM node. Cleanup must restore its latest preview.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      const interaction = modeRef.current;
      if (isInteractionMode(interaction)) restoreTransientInteraction(interaction);
    };
  }, [documentId, bleedSurfaceRef, dragPointerRef, modeRef, restoreTransientInteraction, stopDragAutoScroll]);

  return { handlePointerMove, handlePointerCancel, handlePointerUp };
}
