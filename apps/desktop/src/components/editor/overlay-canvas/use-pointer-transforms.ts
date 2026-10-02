"use client";
import {
  upsertShape
} from "@/features/document";
import {
  getShapeBounds,
  getShapeRotation,
  getShapesSelectionBounds,
  getShapesSnapSourcePoints,
  mergeShapesById,
  resizeRotatedShapeToBounds,
  resizeRotatedShapeToVisualBounds,
  resizeShapesToVisualBounds,
  resolveResizePointer,
  snapBoundsToGeometry,
  snapMovedPointsToGeometry,
  snapPointToGeometry,
  snapResizeBoundsToGeometry,
  updateShapePoint,
  type OverlaySnapGuide
} from "@/features/drawing";
import type {
  Dispatch,
  PointerEvent as ReactPointerEvent,
  RefObject,
  SetStateAction
} from "react";
import {
  useCallback
} from "react";
import { snapPointAround } from "./angle";
import {
  getIdsWithDescendants,
  normalizeOverlayGroups
} from "./grouping";
import { getImageCoverCrop, panImageCrop, resizeImageCropFrame } from "./image-crop";
import { areImageCropStatesEqual, getConstrainedInsertDragPoint, getSnappablePointHandlePagePoint } from "./interaction-geometry";
import {
  type InsertTool,
  type OverlayInteractionMode
} from "./interaction-mode";
import {
  pagePointToUnrotatedShapePoint
} from "./math";
import type { OverlayPointerEditingPort, OverlayPointerGeometryPort } from "./pointer-contracts";
import {
  reanchorShapesByPosition
} from "./reanchor-model";
import { rememberCalloutCornerRadius } from "./remembered-callout-radius";
import {
  getLocalResizeDelta
} from "./resize";
import {
  isPointSnappedClickDrawingTool,
  isPointSnappedInsertDragTool
} from "./shapes/create-shape";
import type {
  OverlayPoint,
  OverlayShape
} from "./types";
import type { OverlayPointerSession } from "./use-pointer-session";
interface Dependencies {
  session: Pick<OverlayPointerSession, "transitionMode" | "lastInteractionPointRef" | "resizePaddingRef">;
  editing: Pick<OverlayPointerEditingPort, "shapesRef" | "setShapes" | "assetsRef" | "replaceShape">;
  geometry: Pick<OverlayPointerGeometryPort, "getOverlaySnapThreshold" | "createSnapGeometry" | "anchorMeasurementsRef">;
  snapDisabledRef: RefObject<boolean>;
  setSnapGuides: Dispatch<SetStateAction<OverlaySnapGuide[]>>;
  clearSnapGuides: () => void;
  lastCalloutCornerRadiusRef: RefObject<number>;
  imageCropDirtyRef: RefObject<boolean>;
}

export function useOverlayPointerTransforms({
  session,
  editing,
  geometry,
  snapDisabledRef,
  setSnapGuides,
  clearSnapGuides,
  lastCalloutCornerRadiusRef,
  imageCropDirtyRef,
}: Dependencies) {
  const { transitionMode, lastInteractionPointRef, resizePaddingRef } = session;
  const { shapesRef, setShapes, assetsRef, replaceShape } = editing;
  const { getOverlaySnapThreshold, createSnapGeometry, anchorMeasurementsRef } = geometry;

  const applyMoveInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.move" }>,
    point: OverlayPoint,
  ) => {
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const movedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
    const startBounds = getShapesSelectionBounds(interaction.shapes);
    let finalDx = dx;
    let finalDy = dy;

    if (startBounds) {
      const geometry = createSnapGeometry(getIdsWithDescendants(shapesRef.current, [...movedIdSet], { includeGroups: true }));
      const snapOptions = {
        threshold: getOverlaySnapThreshold(),
        disabled: snapDisabledRef.current,
      };
      // 線端を掴んでいなくても、動かしている図形の角・端点が他図形の角へ吸い付く。
      // 点が合う場合は x・y を同時に合わせ、合わなければ従来どおり枠の辺・中心を軸へ合わせる。
      const pointSnap = snapMovedPointsToGeometry(
        getShapesSnapSourcePoints(interaction.shapes),
        { x: dx, y: dy },
        geometry,
        snapOptions,
      );
      const snap = pointSnap.guides.length > 0
        ? pointSnap
        : snapBoundsToGeometry(
          { ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy },
          geometry,
          snapOptions,
        );
      finalDx += snap.nudge.x;
      finalDy += snap.nudge.y;
      setSnapGuides(snap.guides);
    } else {
      clearSnapGuides();
    }

    transitionMode({ type: "updateMove", offset: { x: finalDx, y: finalDy } });
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, setSnapGuides, shapesRef, snapDisabledRef, transitionMode]);

  const applyResizeInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.resize" }>,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ) => {
    const {
      bounds: resizedBounds,
      isRotated: rotated,
      preserveAspect,
      targetAspect: regularAspect,
    } = resolveResizePointer(interaction, point, modifiers);
    const resizedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
    let finalBounds = resizedBounds;
    if (rotated) {
      clearSnapGuides();
    } else {
      const snap = snapResizeBoundsToGeometry(
        resizedBounds,
        interaction.handle,
        createSnapGeometry(getIdsWithDescendants(shapesRef.current, [...resizedIdSet], { includeGroups: true })),
        {
          threshold: getOverlaySnapThreshold(),
          disabled: snapDisabledRef.current,
          preserveAspect,
          targetAspect: regularAspect,
        },
      );
      finalBounds = snap.bounds;
      setSnapGuides(snap.guides);
    }
    // 掴んだ辺・スナップ・アスペクト維持はすべて「見えている箱」の上で行い、図形へ渡す直前に
    // 線幅と矢印ヘッド分のパディングを外す (`resize-frame.ts`)。
    const frame = { visual: interaction.bounds, padding: resizePaddingRef.current };
    setShapes((current) => {
      const resizedShapes = rotated
        ? [resizeRotatedShapeToVisualBounds(interaction.shapes[0], frame, finalBounds, interaction.handle)]
        : resizeShapesToVisualBounds(interaction.shapes, frame, finalBounds, interaction.handle);
      const nextResizedIdSet = new Set(resizedShapes.map((shape) => shape.id));
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        mergeShapesById(current, resizedShapes),
        nextResizedIdSet,
        anchorMeasurementsRef.current.ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [anchorMeasurementsRef, clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, resizePaddingRef, setShapes, setSnapGuides, shapesRef, snapDisabledRef]);

  const applyPointInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.point" }>,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "shiftKey">,
  ) => {
    const constrainedShape = updateShapePoint(
      interaction.shape,
      interaction.handle,
      pagePointToUnrotatedShapePoint(
        point,
        interaction.pivot,
        interaction.rotation,
        interaction.shape.flipX,
        interaction.shape.flipY,
      ),
      modifiers.shiftKey,
    );
    if (constrainedShape.type === "callout" && interaction.handle.type === "calloutCornerRadius") {
      lastCalloutCornerRadiusRef.current = constrainedShape.props.radius;
      rememberCalloutCornerRadius(constrainedShape.props.radius);
    }
    const handlePoint = getSnappablePointHandlePagePoint(constrainedShape, interaction.handle);
    if (!handlePoint) {
      clearSnapGuides();
      replaceShape(constrainedShape);
      return;
    }

    const snap = snapPointToGeometry(
      handlePoint,
      createSnapGeometry(getIdsWithDescendants(shapesRef.current, [interaction.shape.id], { includeGroups: true })),
      {
        threshold: getOverlaySnapThreshold(),
        disabled: snapDisabledRef.current,
      },
    );
    setSnapGuides(snap.guides);

    const nextShape = snap.snapped
      ? updateShapePoint(
        interaction.shape,
        interaction.handle,
        pagePointToUnrotatedShapePoint(
          snap.point,
          interaction.pivot,
          interaction.rotation,
          interaction.shape.flipX,
          interaction.shape.flipY,
        ),
        modifiers.shiftKey,
      )
      : constrainedShape;
    replaceShape(nextShape);
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, lastCalloutCornerRadiusRef, replaceShape, setSnapGuides, shapesRef, snapDisabledRef]);

  const applyImageCropInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.imageCropResize" | "overlay.imageCropPan" }>,
    point: OverlayPoint,
  ) => {
    clearSnapGuides();
    const currentShape = shapesRef.current.find((shape): shape is Extract<OverlayShape, { type: "image" }> =>
      shape.id === interaction.shape.id && shape.type === "image",
    );
    if (!currentShape) {
      return;
    }
    const asset = assetsRef.current[currentShape.props.assetId];
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const unflippedDelta = getLocalResizeDelta(dx, dy, getShapeRotation(interaction.shape));
    const localDelta = {
      x: interaction.shape.flipX ? -unflippedDelta.x : unflippedDelta.x,
      y: interaction.shape.flipY ? -unflippedDelta.y : unflippedDelta.y,
    };
    if (interaction.id === "overlay.imageCropPan") {
      const nextShape = panImageCrop(interaction.shape, asset, localDelta.x, localDelta.y);
      const positionedNextShape: Extract<OverlayShape, { type: "image" }> = {
        ...nextShape,
        x: currentShape.x,
        y: currentShape.y,
        rotation: currentShape.rotation,
        anchor: currentShape.anchor,
      };
      if (areImageCropStatesEqual(currentShape, positionedNextShape, asset)) {
        return;
      }
      imageCropDirtyRef.current = true;
      replaceShape(positionedNextShape);
      return;
    }

    const startBounds = getShapeBounds(interaction.shape);
    const resizedCropFrame = resizeImageCropFrame(
      startBounds,
      getImageCoverCrop(interaction.shape, asset),
      {
        w: asset?.props.w || interaction.shape.props.w,
        h: asset?.props.h || interaction.shape.props.h,
      },
      interaction.handle,
      localDelta,
    );
    const resizedShape = resizeRotatedShapeToBounds(
      interaction.shape,
      startBounds,
      resizedCropFrame.bounds,
      interaction.handle,
    ) as Extract<OverlayShape, { type: "image" }>;
    const nextShape: Extract<OverlayShape, { type: "image" }> = {
      ...currentShape,
      x: resizedShape.x,
      y: resizedShape.y,
      props: {
        ...currentShape.props,
        w: resizedShape.props.w,
        h: resizedShape.props.h,
        crop: resizedCropFrame.crop,
      },
    };
    if (areImageCropStatesEqual(currentShape, nextShape, asset)) {
      return;
    }
    imageCropDirtyRef.current = true;
    setShapes((current) => {
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        upsertShape(current, nextShape),
        new Set([nextShape.id]),
        anchorMeasurementsRef.current.ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [anchorMeasurementsRef, assetsRef, clearSnapGuides, imageCropDirtyRef, replaceShape, setShapes, shapesRef]);

  const getSnappedDrawingPoint = useCallback((
    rawPoint: OverlayPoint,
    options: {
      previousPoint?: OverlayPoint;
      shiftKey?: boolean;
      enabled?: boolean;
    } = {},
  ): OverlayPoint => {
    const constrainedPoint = options.shiftKey && options.previousPoint
      ? snapPointAround(options.previousPoint, rawPoint)
      : rawPoint;
    if (options.enabled === false) {
      clearSnapGuides();
      return constrainedPoint;
    }

    const snap = snapPointToGeometry(constrainedPoint, createSnapGeometry(), {
      threshold: getOverlaySnapThreshold(),
      disabled: snapDisabledRef.current,
    });
    setSnapGuides(snap.guides);
    return snap.point;
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, setSnapGuides, snapDisabledRef]);

  const getSnappedInsertDragPoint = useCallback((
    tool: InsertTool,
    start: OverlayPoint,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ): OverlayPoint => {
    const constrained = getConstrainedInsertDragPoint(tool, start, point, modifiers);
    if (!isPointSnappedInsertDragTool(tool)) {
      clearSnapGuides();
      return constrained;
    }

    return getSnappedDrawingPoint(constrained, { enabled: true });
  }, [clearSnapGuides, getSnappedDrawingPoint]);

  const updateModifierDrivenInteraction = useCallback((
    interaction: OverlayInteractionMode,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ): boolean => {
    const point = lastInteractionPointRef.current;
    if (!point) {
      return false;
    }

    if (interaction.id === "overlay.move") {
      applyMoveInteractionAtPoint(interaction, point);
      return true;
    }

    if (interaction.id === "overlay.resize") {
      applyResizeInteractionAtPoint(interaction, point, modifiers);
      return true;
    }

    if (interaction.id === "overlay.point") {
      applyPointInteractionAtPoint(interaction, point, modifiers);
      return true;
    }

    if (interaction.id === "overlay.insertDrag") {
      transitionMode({
        type: "updateInsertDrag",
        current: getSnappedInsertDragPoint(interaction.tool, interaction.start, point, modifiers),
      });
      return true;
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
      return true;
    }

    return false;
  }, [applyMoveInteractionAtPoint, applyPointInteractionAtPoint, applyResizeInteractionAtPoint, getSnappedDrawingPoint, getSnappedInsertDragPoint, lastInteractionPointRef, transitionMode]);
  return {
    updateModifierDrivenInteraction,
    getSnappedDrawingPoint,
    applyMoveInteractionAtPoint,
    applyResizeInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyImageCropInteractionAtPoint,
    getSnappedInsertDragPoint,
  };
}
