"use client";

import { useCallback, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from "react";
import type { OverlayAsset, OverlayExtensions, OverlayShape } from "@/features/document";
import type { Translate } from "@/lib/i18n";
import { convertSvgImageToSigma, decodeSvgDataUrl, SvgConversionError } from "@/lib/svg-to-sigma";
import { isShapeEditPolicyLockedInTree, isShapeLockedInTree } from "./grouping";
import { measureSvgFragment } from "./svg-fragment-bounds";
import { measureSvgOverlayText, prepareSvgTextFonts } from "./svg-text-measurement";
import { useMathRenderEnvironment } from "@/features/rendering/adapters/react";

interface Ports {
  documentId?: string;
  shapesRef: RefObject<OverlayShape[]>;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  extensionsRef: RefObject<OverlayExtensions | undefined>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  explicitlySavedShapeStatesRef: RefObject<WeakSet<OverlayShape[]>>;
  notifyEditPolicyBlocked: () => void;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  setSelectedShapeIds: (ids: string[]) => void;
  commitOverlayChangeNow: () => void;
  /** A `data:` or `blob:` URL for the asset; a shared document's storage reference is not readable as is. */
  readAssetSource: (source: string) => Promise<string>;
  tShape: Translate<"shape">;
}

export function useSvgConversion({ documentId, shapesRef, assetsRef, extensionsRef, editPolicyLockedShapeIdsRef,
  explicitlySavedShapeStatesRef, notifyEditPolicyBlocked, setShapes, setAssets, setSelectedShapeIds,
  commitOverlayChangeNow, readAssetSource, tShape }: Ports) {
  const [message, setMessage] = useState<string | null>(null);
  const mathEnvironment = useMathRenderEnvironment();
  const generation = useRef(0);
  useLayoutEffect(() => { generation.current++; }, [documentId]);
  useLayoutEffect(() => () => { generation.current++; }, []);
  const convertSvg = useCallback(async (shapeId: string) => {
    const requestGeneration = generation.current;
    const editable = () => {
      const shape = shapesRef.current.find((item) => item.id === shapeId && item.type === "image");
      if (!shape || isShapeLockedInTree(shapesRef.current, shape)) return null;
      if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
        return null;
      }
      return shape.type === "image" ? shape : null;
    };
    const image = editable();
    if (!image) return;
    const asset = assetsRef.current[image.props.assetId];
    try {
      if (!asset) throw new SvgConversionError("source");
      const source = await readAssetSource(asset.props.src);
      const svg = source.startsWith("blob:") ? await (await fetch(source)).text() : decodeSvgDataUrl(source);
      await prepareSvgTextFonts();
      if (requestGeneration !== generation.current) return;
      const current = editable();
      if (!current || current.props.assetId !== asset.id || assetsRef.current[asset.id] !== asset) return;
      const result = convertSvgImageToSigma({ version: 1, shapes: shapesRef.current, assets: assetsRef.current,
        ...(extensionsRef.current ? { extensions: extensionsRef.current } : {}) }, shapeId, svg, measureSvgFragment, (shape) => measureSvgOverlayText(shape, mathEnvironment));
      shapesRef.current = result.snapshot.shapes;
      assetsRef.current = result.snapshot.assets;
      explicitlySavedShapeStatesRef.current.add(result.snapshot.shapes);
      setShapes(result.snapshot.shapes);
      setAssets(result.snapshot.assets);
      commitOverlayChangeNow();
      setSelectedShapeIds(result.selectedIds);
      setMessage(tShape(result.preservedCount ? "svgConversion.partial" : "svgConversion.done", { count: result.convertedCount }));
    } catch (error) {
      if (requestGeneration !== generation.current) return;
      const reason = error instanceof SvgConversionError ? error.reason : "source";
      setMessage(tShape(`svgConversion.${reason}`));
    }
  }, [assetsRef, commitOverlayChangeNow, editPolicyLockedShapeIdsRef, explicitlySavedShapeStatesRef, extensionsRef,
    mathEnvironment, notifyEditPolicyBlocked, readAssetSource, setAssets, setSelectedShapeIds, setShapes, shapesRef, tShape]);
  useLayoutEffect(() => {
    if (!message) return;
    const timer = window.setTimeout(() => setMessage(null), 12_000);
    return () => window.clearTimeout(timer);
  }, [message]);
  return { convertSvg, svgConversionMessage: message };
}
