"use client";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback,
  useEffect, useLayoutEffect, useRef
} from "react";
import {
  type OverlayChangeOptions,
  type OverlayImageRequest
} from "../page-overlay-types";
import {
  getGroupShape,
  normalizeOverlayGroups
} from "./grouping";
import { createOverlayImageEntry } from "./image-file";
import { createOverlayImageImportSession } from "./image-import-session";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import type {
  OverlayAsset,
  OverlayShape,
  OverlayShapeId
} from "./types";
const IMAGE_INSERT_GAP = 16;

export interface Dependencies {
  documentId?: string;
  imageInsertAreaWidth: number;
  imageInsertAreaHeight: number;
  canvasWidthRef: RefObject<number>;
  canvasHeightRef: RefObject<number>;
  focusedGroupIdRef: RefObject<string | null>;
  shapesRef: RefObject<OverlayShape[]>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  onImageHandled: (requestId: number) => void;
  imageRequest: OverlayImageRequest | null;
}

export function useOverlayImageImport({
  documentId,
  imageInsertAreaWidth,
  imageInsertAreaHeight,
  canvasWidthRef,
  canvasHeightRef,
  focusedGroupIdRef,
  shapesRef,
  setAssets,
  assetsRef,
  setShapes,
  setSelectedShapeIds,
  transitionMode,
  queueOverlaySave,
  onImageHandled,
  imageRequest,
}: Dependencies) {

  const imageImportSessionRef = useRef<ReturnType<typeof createOverlayImageImportSession> | null>(null);
  useLayoutEffect(() => {
    const session = createOverlayImageImportSession();
    imageImportSessionRef.current = session;
    return () => {
      session.cancel();
      if (imageImportSessionRef.current === session) imageImportSessionRef.current = null;
    };
  }, [documentId]);

  const handleImageRequest = useCallback((request: OverlayImageRequest) => {
    imageImportSessionRef.current ??= createOverlayImageImportSession();
    return imageImportSessionRef.current.handle(request, {
      areaSize: { w: imageInsertAreaWidth, h: imageInsertAreaHeight },
      gap: IMAGE_INSERT_GAP,
      decodeFile: createOverlayImageEntry,
      getPlacement: () => ({
        canvasWidth: canvasWidthRef.current,
        canvasHeight: canvasHeightRef.current,
        parentId: focusedGroupIdRef.current && getGroupShape(shapesRef.current, focusedGroupIdRef.current)
          ? focusedGroupIdRef.current
          : undefined,
      }),
      insert: (nextShapes, nextAssets) => {
        setAssets((current) => {
          const next = { ...current, ...nextAssets };
          assetsRef.current = next;
          return next;
        });
        setShapes((current) => {
          const next = normalizeOverlayGroups([...current, ...nextShapes]);
          shapesRef.current = next;
          return next;
        });
        setSelectedShapeIds(nextShapes.map((shape) => shape.id));
        transitionMode({ type: "select" });
        queueOverlaySave();
      },
      onHandled: onImageHandled,
    });
  }, [assetsRef, canvasHeightRef, canvasWidthRef, focusedGroupIdRef, imageImportSessionRef, imageInsertAreaHeight, imageInsertAreaWidth, onImageHandled, queueOverlaySave, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

  useEffect(() => {
    if (imageRequest) {
      void handleImageRequest(imageRequest);
    }
  }, [handleImageRequest, imageRequest]);
}
