"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  EMPTY_TIKZ_ENVIRONMENT, pruneUnusedOverlayAssets, readTikzClipboardSource,
  type OverlayAsset, type OverlayImageShape, type SigmaDocument, type TikzImageSource,
} from "@/features/document";
import { createOverlayAssetId, createOverlayShapeId } from "../overlay-canvas/ids";
import { createOverlayClipboardPayload, type EditorClipboardPayload } from "@/lib/editor-clipboard";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import { OPEN_TIKZ_EDITOR_EVENT, type TikzRenderResult } from "@/lib/tikz-contract";
import { TikzEditorDialog } from "./TikzEditorDialog";
import type { OverlayImagePreview } from "../overlay-canvas/image-preview-context";

interface Request {
  id: number;
  documentId: string;
  fileId: string | null;
  input: TikzImageSource;
  shapeId?: string;
  originalSource?: TikzImageSource;
  image?: TikzRenderResult;
}

export function useTikzEditor(ports: {
  document: SigmaDocument;
  fileId: string | null;
  writable: boolean;
  commit: (change: (current: SigmaDocument) => SigmaDocument) => boolean;
  insert: (payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>) => void;
}) {
  const live = useRef(ports);
  useLayoutEffect(() => { live.current = ports; });
  const counter = useRef(0);
  const [request, setRequest] = useState<Request | null>(null);
  const [preview, setPreview] = useState<(OverlayImagePreview & { requestId: number }) | null>(null);
  const key = `${ports.fileId}:${ports.document.docId}`;
  const [documentKey, setDocumentKey] = useState(key);
  if (documentKey !== key) {
    setDocumentKey(key);
    setRequest(null);
    setPreview(null);
  }
  const pasteTikz = useCallback((text: string): boolean => {
    const current = live.current;
    if (!current.writable || !getDesktopBridge()?.tikz) return false;
    const source = readTikzClipboardSource(text);
    if (!source) return false;
    setRequest({ id: ++counter.current, documentId: current.document.docId, fileId: current.fileId,
      input: { source, environment: current.document.metadata.tikzEnvironment ?? EMPTY_TIKZ_ENVIRONMENT } });
    return true;
  }, []);

  useEffect(() => {
    const open = (event: Event) => {
      const current = live.current;
      const detail = (event as CustomEvent<{ documentId: string; shapeId: string }>).detail;
      if (!detail || !current.writable || detail.documentId !== current.document.docId) return;
      const snapshot = current.document.pageLayout?.overlay?.overlaySnapshot;
      const shape = snapshot?.shapes.find((item) => item.id === detail.shapeId);
      if (shape?.type !== "image" || !shape.props.tikz || shape.locked) return;
      const asset = snapshot?.assets[shape.props.assetId];
      const next = { id: ++counter.current, documentId: current.document.docId, fileId: current.fileId,
        input: shape.props.tikz, originalSource: shape.props.tikz, shapeId: shape.id,
        image: asset ? { src: asset.props.src, width: asset.props.w, height: asset.props.h } : undefined };
      setRequest((existing) => existing?.shapeId === shape.id && existing.documentId === next.documentId && existing.fileId === next.fileId
        ? existing : next);
    };
    window.addEventListener(OPEN_TIKZ_EDITOR_EVENT, open);
    return () => window.removeEventListener(OPEN_TIKZ_EDITOR_EVENT, open);
  }, []);

  const apply = (input: TikzImageSource, image: TikzRenderResult): boolean => {
    const current = live.current;
    if (!request || !current.writable || request.documentId !== current.document.docId || request.fileId !== current.fileId) return false;
    const snapshot = current.document.pageLayout?.overlay?.overlaySnapshot;
    const existing = request.shapeId ? snapshot?.shapes.find((item) => item.id === request.shapeId) : undefined;
    if (request.shapeId) {
      if (existing?.type !== "image" || existing.locked || JSON.stringify(existing.props.tikz) !== JSON.stringify(request.originalSource)) return false;
      // A reloaded image may use a storage URL. Applying an unchanged draft needs no new asset.
      if (JSON.stringify(input) === JSON.stringify(existing.props.tikz) && snapshot?.assets[existing.props.assetId]?.props.src === image.src) return true;
    }
    const asset: OverlayAsset = { id: createOverlayAssetId(), type: "image", props: {
      src: image.src, w: image.width, h: image.height, name: "TikZ.svg", mimeType: "image/svg+xml", isAnimated: false, fileSize: atob(image.src.split(",")[1]).length,
    } };
    if (existing?.type === "image") {
      return current.commit((doc) => {
        const overlay = doc.pageLayout!.overlay!;
        const source = overlay.overlaySnapshot!;
        return { ...doc, pageLayout: { ...doc.pageLayout!, overlay: { ...overlay,
          overlaySnapshot: pruneUnusedOverlayAssets({ ...source, assets: { ...source.assets, [asset.id]: asset },
            shapes: source.shapes.map((item) => item.id === existing.id && item.type === "image"
              ? { ...item, props: { ...item.props, assetId: asset.id, tikz: input,
                  h: item.props.w * image.height / image.width, crop: undefined } } : item),
          }),
        } } };
      });
    }
    const scale = Math.min(1, 480 / image.width, 400 / image.height);
    const shape: OverlayImageShape = { id: createOverlayShapeId(), type: "image", x: 80, y: 80, rotation: 0,
      props: { assetId: asset.id, w: image.width * scale, h: image.height * scale, tikz: input } };
    current.insert(createOverlayClipboardPayload([shape], { [asset.id]: asset }, current.document.docId));
    return true;
  };

  const target = request?.shapeId ? ports.document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === request.shapeId) : null;
  const targetValid = !request?.shapeId || (target?.type === "image" && !target.locked && JSON.stringify(target.props.tikz) === JSON.stringify(request.originalSource));
  const visible = request && request.documentId === ports.document.docId && request.fileId === ports.fileId && ports.writable && targetValid;
  if (request && !visible) {
    setRequest(null);
    setPreview(null);
  }
  return { pasteTikz, preview: visible && preview?.requestId === request.id ? preview : null,
    dialog: visible ? <TikzEditorDialog key={request.id} initial={request.input} initialImage={request.image} shapeId={request.shapeId}
      autoInsert={!request.shapeId} onApply={apply}
      onPreview={(image) => {
        // Returning to the original code also restores any existing image crop.
        if (image === request.image) setPreview(null);
        else if (request.shapeId) setPreview({ ...image, shapeId: request.shapeId, requestId: request.id });
      }}
      onClose={() => { setRequest(null); setPreview(null); }} /> : null };
}
