"use client";

import { useCallback, useEffect, type Dispatch, type RefObject, type SetStateAction } from "react";

import {
  SELECT_OVERLAY_GRAPH3D_EVENT,
  type Graph3DDerivedImage,
  type SelectedOverlayGraph3D,
} from "@/components/editor/Graph3DSettingsPanel";
import { dispatchGraph3DAnimationPreview } from "@/components/editor/graph3d-animation-preview";
import type {
  Graph3DCamera,
  Graph3DExpressionVector3,
  Graph3DObject,
  OverlayAsset,
  OverlayGraph3DShape,
  OverlayShape,
  OverlayShapeId,
} from "@/features/document";
import { getGraph3DPreviewSourceHash, getShapeBounds } from "@/features/drawing";

import type { OverlayChangeOptions } from "../page-overlay-types";
import { normalizeOverlayGroups } from "./grouping";
import { createOverlayAssetId, createOverlayShapeId } from "./ids";
import type { OverlayInteractionAction } from "./interaction-mode";

interface Graph3DControllerDependencies {
  shapes: OverlayShape[];
  selectedIds: OverlayShapeId[];
  shapesRef: RefObject<OverlayShape[]>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  explicitlySavedShapeStatesRef: RefObject<WeakSet<OverlayShape[]>>;
  canvasWidthRef: RefObject<number>;
  canvasHeightRef: RefObject<number>;
  imageInsertGap: number;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  tShape: (key: "graph3d.animationFileName" | "graph3d.previewFileName") => string;
}

/** 3D 教材の編集、派生画像の保存、配置と設定パネル通知を canvas の状態へ接続する。 */
export function useOverlayGraph3DController({
  shapes,
  selectedIds,
  shapesRef,
  assetsRef,
  setShapes,
  setAssets,
  explicitlySavedShapeStatesRef,
  canvasWidthRef,
  canvasHeightRef,
  imageInsertGap: IMAGE_INSERT_GAP,
  queueOverlaySave,
  setSelectedShapeIds,
  transitionMode,
  tShape,
}: Graph3DControllerDependencies) {
  const handleGraph3DSpecChange = useCallback((
    shapeId: OverlayShapeId,
    nextSpec: OverlayGraph3DShape["props"]["spec"],
    options?: { save?: boolean },
  ) => {
    setShapes((current) => {
      const next = current.map((shape) => shape.id === shapeId && shape.type === "graph3dShape"
        ? { ...shape, props: { ...shape.props, spec: nextSpec } }
        : shape);
      shapesRef.current = next;
      return next;
    });
    if (options?.save !== false) queueOverlaySave();
  }, [queueOverlaySave, setShapes, shapesRef]);

  const handleGraph3DCameraChange = useCallback((shapeId: OverlayShapeId, camera: Graph3DCamera) => {
    const currentShape = shapesRef.current.find((shape): shape is OverlayGraph3DShape => (
      shape.id === shapeId && shape.type === "graph3dShape"
    ));
    if (!currentShape) return;
    handleGraph3DSpecChange(shapeId, { ...currentShape.props.spec, camera });
  }, [handleGraph3DSpecChange, shapesRef]);

  const handleGraph3DObjectRotationChange = useCallback((
    shapeId: OverlayShapeId,
    objectId: string,
    rotation: Graph3DExpressionVector3,
  ) => {
    const currentShape = shapesRef.current.find((shape): shape is OverlayGraph3DShape => (
      shape.id === shapeId && shape.type === "graph3dShape"
    ));
    if (!currentShape) return;
    handleGraph3DSpecChange(shapeId, {
      ...currentShape.props.spec,
      objects: currentShape.props.spec.objects.map((object) => (
        object.id === objectId ? { ...object, rotation } : object
      )),
    });
  }, [handleGraph3DSpecChange, shapesRef]);

  const handleGraph3DObjectTransformChange = useCallback((
    shapeId: OverlayShapeId,
    objectId: string,
    transform: Pick<Graph3DObject, "rotation" | "translation" | "scale">,
  ) => {
    const currentShape = shapesRef.current.find((shape): shape is OverlayGraph3DShape => (
      shape.id === shapeId && shape.type === "graph3dShape"
    ));
    if (!currentShape) return;
    handleGraph3DSpecChange(shapeId, {
      ...currentShape.props.spec,
      objects: currentShape.props.spec.objects.map((object) => (
        object.id === objectId ? { ...object, ...transform } : object
      )),
    });
  }, [handleGraph3DSpecChange, shapesRef]);

  const handleGraph3DPreviewReady = useCallback((
    shapeId: OverlayShapeId,
    dataUrl: string,
    size: { width: number; height: number },
    renderedSourceHash: string,
    options: { animated: boolean },
  ) => {
    const currentShape = shapesRef.current.find((shape): shape is OverlayGraph3DShape => (
      shape.id === shapeId && shape.type === "graph3dShape"
    ));
    if (!currentShape) return;
    const previewSourceHash = getGraph3DPreviewSourceHash(currentShape.props.spec);
    // Encoding finishes after the WebGL frame was drawn. A newer edit may already be current;
    // never label an older bitmap with the newer spec's hash.
    if (renderedSourceHash !== previewSourceHash) return;
    const assetId = currentShape.props.previewAssetId ?? `asset_graph3d_preview_${shapeId}`;
    const currentAsset = assetsRef.current[assetId];
    if (
      currentAsset?.props.src === dataUrl &&
      currentShape.props.previewSourceHash === previewSourceHash
    ) return;
    const fileSize = Math.max(0, Math.floor((dataUrl.split(",")[1]?.length ?? 0) * 0.75));
    const asset: OverlayAsset = {
      id: assetId,
      type: "image",
      props: {
        // The capture is supersampled above the shape's document size so it stays sharp when the
        // document is zoomed in or printed; the asset records what was actually rendered.
        w: Math.max(1, Math.round(size.width)),
        h: Math.max(1, Math.round(size.height)),
        name: options.animated ? tShape("graph3d.animationFileName") : tShape("graph3d.previewFileName"),
        // An animated PNG: the page and the viewer play it, print and the SVG export read the
        // still frame it also carries.
        isAnimated: options.animated,
        mimeType: "image/png",
        src: dataUrl,
        fileSize,
      },
    };
    setAssets((current) => {
      const next = { ...current, [assetId]: asset };
      assetsRef.current = next;
      return next;
    });
    setShapes((current) => {
      const next = current.map((shape) => shape.id === shapeId && shape.type === "graph3dShape"
        ? {
            ...shape,
            props: {
              ...shape.props,
              previewAssetId: assetId,
              previewSourceHash,
            },
          }
        : shape);
      shapesRef.current = next;
      explicitlySavedShapeStatesRef.current.add(next);
      return next;
    });
    // The PNG is derived from the spec, not something the user did: it folds into the edit that
    // changed the spec instead of becoming its own undo step. Recording it would also make undo
    // unusable — restoring a state whose PNG is one edit behind puts the live window back on
    // screen, which captures again, records again, and drops the redo branch every time.
    queueOverlaySave({ history: "coalesce" });
  }, [assetsRef, explicitlySavedShapeStatesRef, queueOverlaySave, setAssets, setShapes, shapesRef, tShape]);

  /**
   * Puts something derived from a 3D material onto the page next to the material it came from.
   *
   * Beside it when the page has the width, under it otherwise, and always carrying the source's
   * block anchor so the new shape travels with the same paragraph. Position lives in both `x`/`y`
   * and the anchor offset: writing only one of them makes the shape jump back on the next save.
   */
  const insertShapeBesideGraph3D = useCallback((
    sourceShapeId: OverlayShapeId,
    build: () => { shape: OverlayShape; asset?: OverlayAsset },
  ) => {
    const source = shapesRef.current.find((shape) => shape.id === sourceShapeId);
    if (!source || source.type !== "graph3dShape") return;
    const built = build();
    const size = getShapeBounds(built.shape);
    const fitsBeside = source.x + source.props.w + IMAGE_INSERT_GAP + size.w <= canvasWidthRef.current;
    // Clamping happens before the anchor offsets are worked out, not after: `fitShapesWithinPage`
    // moves `x`/`y` alone, and a block-anchored shape whose offset disagrees with its cached
    // position snaps back the first time the anchor is resolved again.
    const x = Math.max(0, Math.min(
      source.x + (fitsBeside ? source.props.w + IMAGE_INSERT_GAP : 0),
      Math.max(0, canvasWidthRef.current - size.w),
    ));
    const offsetX = x - source.x;
    const offsetY = fitsBeside ? 0 : source.props.h + IMAGE_INSERT_GAP;
    const blockAnchor = source.anchor?.type === "block" ? source.anchor : null;
    const y = blockAnchor
      ? source.y + offsetY
      : Math.max(0, Math.min(source.y + offsetY, Math.max(0, canvasHeightRef.current - size.h)));
    const anchor = blockAnchor
      ? {
          ...blockAnchor,
          ...(typeof blockAnchor.dx === "number" ? { dx: blockAnchor.dx + offsetX } : {}),
          dy: blockAnchor.dy + offsetY,
          ...(blockAnchor.line
            ? { line: { ...blockAnchor.line, dy: blockAnchor.line.dy + offsetY } }
            : {}),
        }
      : undefined;
    const nextShapes = normalizeOverlayGroups([{
      ...built.shape,
      x,
      y,
      ...(anchor ? { anchor } : {}),
      ...(source.parentId ? { parentId: source.parentId } : {}),
    } as OverlayShape]);
    if (built.asset) {
      const asset = built.asset;
      setAssets((current) => {
        const next = { ...current, [asset.id]: asset };
        assetsRef.current = next;
        return next;
      });
    }
    setShapes((current) => {
      const next = normalizeOverlayGroups([...current, ...nextShapes]);
      shapesRef.current = next;
      return next;
    });
    setSelectedShapeIds(nextShapes.map((shape) => shape.id));
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [IMAGE_INSERT_GAP, assetsRef, canvasHeightRef, canvasWidthRef, queueOverlaySave, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

  const handleGraph3DInsertImage = useCallback((
    sourceShapeId: OverlayShapeId,
    image: Graph3DDerivedImage,
  ) => {
    insertShapeBesideGraph3D(sourceShapeId, () => {
      const asset: OverlayAsset = {
        id: createOverlayAssetId(),
        type: "image",
        props: {
          w: image.width,
          h: image.height,
          name: image.name,
          isAnimated: false,
          mimeType: "image/svg+xml",
          src: image.dataUrl,
          // The picture is drawn here, not read off disk: its bytes are the data URL itself.
          fileSize: image.dataUrl.length,
        },
      };
      return {
        asset,
        shape: {
          id: createOverlayShapeId(),
          type: "image",
          x: 0,
          y: 0,
          rotation: 0,
          props: { assetId: asset.id, w: image.width, h: image.height },
        },
      };
    });
  }, [insertShapeBesideGraph3D]);

  const handleGraph3DInsertSpec = useCallback((
    sourceShapeId: OverlayShapeId,
    spec: OverlayGraph3DShape["props"]["spec"],
  ) => {
    insertShapeBesideGraph3D(sourceShapeId, () => {
      const source = shapesRef.current.find((shape) => shape.id === sourceShapeId);
      const size = source?.type === "graph3dShape"
        ? { w: source.props.w, h: source.props.h }
        : { w: 240, h: 200 };
      return {
        shape: {
          id: createOverlayShapeId(),
          type: "graph3dShape",
          x: 0,
          y: 0,
          rotation: 0,
          props: { ...size, spec },
        },
      };
    });
  }, [insertShapeBesideGraph3D, shapesRef]);

  useEffect(() => {
    const selectedShape = selectedIds.length === 1
      ? shapes.find((shape): shape is OverlayGraph3DShape => shape.id === selectedIds[0] && shape.type === "graph3dShape")
      : undefined;
    if (!selectedShape) {
      window.dispatchEvent(new CustomEvent<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT, { detail: null }));
      return;
    }

    const shapeId = selectedShape.id;
    const detail: SelectedOverlayGraph3D = {
      shapeId,
      spec: selectedShape.props.spec,
      size: { width: selectedShape.props.w, height: selectedShape.props.h },
      onSpecChange: (nextSpec, options) => handleGraph3DSpecChange(shapeId, nextSpec, options),
      onAnimationPreview: (overrides, playing) => dispatchGraph3DAnimationPreview({
        shapeId,
        overrides,
        playing,
      }),
      onInsertImage: (image) => handleGraph3DInsertImage(shapeId, image),
      onInsertSpec: (nextSpec) => handleGraph3DInsertSpec(shapeId, nextSpec),
      onClose: () => setSelectedShapeIds([]),
    };
    window.dispatchEvent(new CustomEvent<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT, { detail }));
  }, [
    handleGraph3DInsertImage,
    handleGraph3DInsertSpec,
    handleGraph3DSpecChange,
    selectedIds,
    setSelectedShapeIds,
    shapes,
  ]);

  useEffect(() => () => {
    window.dispatchEvent(new CustomEvent<SelectedOverlayGraph3D | null>(SELECT_OVERLAY_GRAPH3D_EVENT, { detail: null }));
  }, []);

  return {
    handleGraph3DCameraChange,
    handleGraph3DObjectRotationChange,
    handleGraph3DObjectTransformChange,
    handleGraph3DPreviewReady,
  };
}
