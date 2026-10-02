"use client";
import { getSupportedOverlayImageFiles } from "@/lib/overlay-image-files";
import type {
  Dispatch,
  ChangeEvent as ReactChangeEvent,
  RefObject,
  SetStateAction
} from "react";
import { useCallback, useLayoutEffect, useRef } from "react";
import {
  type OverlayChangeHistory,
  type OverlayChangeOptions
} from "../page-overlay-types";
import {
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups
} from "./grouping";
import { replaceOverlayImageAsset, resetOverlayImageCrop, resizeOverlayImageToNaturalSize } from "./image-actions";
import { createOverlayImageAsset } from "./image-file";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import {
  clamp
} from "./math";
import type {
  OverlayAsset,
  OverlayShape,
  OverlayShapeId,
  OverlayShapePatch
} from "./types";

export interface Dependencies {
  shapesRef: RefObject<OverlayShape[]>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  notifyEditPolicyBlocked: () => void;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  documentId?: string;

  assetsRef: RefObject<Record<string, OverlayAsset>>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  replaceShape: (shape: OverlayShape) => void;
  imageInsertAreaRef: RefObject<{ w: number; h: number; }>;
  updateShape: (patch: OverlayShapePatch, options?: { commit?: boolean; history?: OverlayChangeHistory; }) => void;
}

export function useOverlayImageController({
  shapesRef,
  editPolicyLockedShapeIdsRef,
  notifyEditPolicyBlocked,
  setSelectedShapeIds,
  transitionMode,
  documentId,
  assetsRef,
  setShapes,
  setAssets,
  queueOverlaySave,
  replaceShape,
  imageInsertAreaRef,
  updateShape,
}: Dependencies) {

  const imageReplacementInputRef = useRef<HTMLInputElement | null>(null);
  const imageReplacementShapeIdRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  useLayoutEffect(() => () => {
    generationRef.current++;
    imageReplacementShapeIdRef.current = null;
  }, [documentId]);

  const getEditableImageShape = useCallback((shapeId: OverlayShapeId) => {
    const shape = shapesRef.current.find((item): item is Extract<OverlayShape, { type: "image" }> => (
      item.id === shapeId && item.type === "image"
    ));
    if (!shape || isShapeLockedInTree(shapesRef.current, shape)) {
      return null;
    }
    if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return null;
    }
    return shape;
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, shapesRef]);

  const startImageCrop = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    setSelectedShapeIds([shape.id]);
    transitionMode({ type: "editImageCrop", shapeId: shape.id });
  }, [getEditableImageShape, setSelectedShapeIds, transitionMode]);

  const requestImageReplacement = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    imageReplacementShapeIdRef.current = shape.id;
    if (imageReplacementInputRef.current) {
      imageReplacementInputRef.current.value = "";
      imageReplacementInputRef.current.click();
    }
  }, [getEditableImageShape, imageReplacementShapeIdRef]);

  const handleImageReplacementChange = useCallback(async (event: ReactChangeEvent<HTMLInputElement>) => {
    const generation = generationRef.current;
    const shapeId = imageReplacementShapeIdRef.current;
    const file = getSupportedOverlayImageFiles(event.currentTarget.files)[0];
    event.currentTarget.value = "";
    imageReplacementShapeIdRef.current = null;
    if (!shapeId || !file) {
      return;
    }

    try {
      const asset = await createOverlayImageAsset(file);
      if (generation !== generationRef.current) return;
      const shape = getEditableImageShape(shapeId);
      if (!shape) {
        return;
      }
      const next = replaceOverlayImageAsset(shapesRef.current, assetsRef.current, shape.id, asset);
      shapesRef.current = normalizeOverlayGroups(next.shapes);
      assetsRef.current = next.assets;
      setShapes(shapesRef.current);
      setAssets(next.assets);
      setSelectedShapeIds([shape.id]);
      transitionMode({ type: "select" });
      queueOverlaySave();
    } catch {
      return;
    }
  }, [assetsRef, getEditableImageShape, queueOverlaySave, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

  const resetImageCrop = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    const nextShape = resetOverlayImageCrop(shape);
    if (nextShape === shape) {
      return;
    }
    replaceShape(nextShape);
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [getEditableImageShape, queueOverlaySave, replaceShape, transitionMode]);

  const restoreImageNaturalSize = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    const nextShape = resizeOverlayImageToNaturalSize(
      shape,
      assetsRef.current[shape.props.assetId],
      imageInsertAreaRef.current,
    );
    if (nextShape === shape) {
      return;
    }
    replaceShape(nextShape);
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [assetsRef, getEditableImageShape, imageInsertAreaRef, queueOverlaySave, replaceShape, transitionMode]);

  const setImageOpacity = useCallback((shapeId: OverlayShapeId, opacity: number) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    updateShape({
      id: shape.id,
      type: "image",
      opacity: clamp(opacity, 0, 1),
    });
  }, [getEditableImageShape, updateShape]);
  return {
    imageReplacementInputRef,
    startImageCrop,
    requestImageReplacement,
    resetImageCrop,
    restoreImageNaturalSize,
    handleImageReplacementChange,
    setImageOpacity,
  };
}
