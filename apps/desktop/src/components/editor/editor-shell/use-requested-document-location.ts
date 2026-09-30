"use client";

import { useEffect, useRef, useState } from "react";
import { SPLASH_MARKER_ATTRIBUTE } from "@/components/StartupSplash";
import type { SigmaCommentAnchor, SigmaDocument } from "@/features/document";
import { EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT } from "@/features/text-editing";
import { getShapeBounds } from "@/features/drawing/shape-bounds";
import { decodeDocumentLocation } from "@/lib/document-location";
import { isCommentAnchorOrphan } from "@/lib/comments";
import { useStableCallback } from "@/lib/react/use-stable-callback";

function readRequest() {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  const fileId = params.get("fileId"), location = decodeDocumentLocation(params.get("location"));
  return fileId && location ? { fileId, location } : null;
}
function clearRequest() {
  const url = new URL(window.location.href);
  url.searchParams.delete("location");
  window.history.replaceState(window.history.state, "", url);
}

export function locationElements(root: HTMLElement, anchor: SigmaCommentAnchor): HTMLElement[] {
  const byId = (id: string, attribute: string) => root.querySelector<HTMLElement>(`[${attribute}="${CSS.escape(id)}"]`);
  const block = (id: string) => byId(id, "data-sigma-doc-id") ?? root.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
  switch (anchor.type) {
    case "block": return [block(anchor.blockId)].filter((e): e is HTMLElement => !!e);
    case "textRange": return [block(anchor.start.blockId), block(anchor.end.blockId)].filter((e): e is HTMLElement => !!e);
    case "inlineMath": return [root.querySelector<HTMLElement>(`[data-sigma-doc-math-inline][data-id="${CSS.escape(anchor.mathInlineId)}"]`) ?? block(anchor.blockId)].filter((e): e is HTMLElement => !!e);
    case "overlayShape": return anchor.shapeIds.map(id => byId(id, "data-overlay-shape-id")).filter((e): e is HTMLElement => !!e);
    case "overlayMath": return anchor.shapeId ? [byId(anchor.shapeId, "data-overlay-shape-id")].filter((e): e is HTMLElement => !!e) : [];
    default: return [];
  }
}

/** Wait for the requested material and its actual canvas, then reveal once and consume the URL. */
export function useRequestedDocumentLocation({ ready, fileId, document, root, selectBlock, revealRegion, unavailable }: {
  ready: boolean; fileId: string; document: SigmaDocument; root: HTMLElement | null;
  selectBlock: (id: string) => void;
  revealRegion: (bounds: { x: number; y: number; w: number; h: number }) => void;
  unavailable: () => void;
}) {
  const [request] = useState(readRequest);
  const consumed = useRef(false);
  const select = useStableCallback(selectBlock), region = useStableCallback(revealRegion), missing = useStableCallback(unavailable);
  const doc = useRef(document);
  useEffect(() => { doc.current = document; }, [document]);
  useEffect(() => {
    if (!request || consumed.current || !ready || fileId !== request.fileId || !root) return;
    let attempts = 0;
    let timer = 0;
    let highlighted: HTMLElement[] = [];
    let rangeEvent: CustomEvent | null = null;
    let ownsRange = false;
    const otherRange = (event: Event) => { if (event !== rangeEvent) ownsRange = false; };
    const clearHighlight = () => {
      highlighted.forEach(element => element.classList.remove("source-reference-focus-pulse"));
      if (ownsRange) window.dispatchEvent(new CustomEvent(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, { detail: { anchors: [] } }));
      ownsRange = false;
    };
    const reveal = () => {
      const anchor = request.location;
      // Text selections inside drawing text boxes also use persistent block IDs.
      const overlayBlocks = doc.current.pageLayout?.overlay?.overlaySnapshot?.shapes.flatMap(shape =>
        shape.type === "text" || shape.type === "callout" ? shape.props.blocks : []) ?? [];
      const orphan = isCommentAnchorOrphan({ ...doc.current, content: [...doc.current.content, ...overlayBlocks] }, anchor);
      const elements = orphan ? [] : locationElements(root, anchor);
      const covered = window.document.querySelector(`[${SPLASH_MARKER_ATTRIBUTE}]`);
      if (!covered && !orphan && (elements.length || anchor.type === "canvasRegion")) {
        consumed.current = true; clearRequest();
        if (anchor.type === "canvasRegion") region(anchor.bounds);
        else {
          const first = elements[0];
          const whiteboard = root.querySelector<HTMLElement>(".whiteboard-page-canvas");
          if (whiteboard) {
            const shapeId = first.closest("[data-overlay-shape-id]")?.getAttribute("data-overlay-shape-id");
            const shape = doc.current.pageLayout?.overlay?.overlaySnapshot?.shapes.find(s => s.id === shapeId);
            if (shape) region(getShapeBounds(shape));
          } else first.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
          if (anchor.type === "block" || anchor.type === "inlineMath") select(anchor.blockId);
          if (anchor.type === "textRange") {
            select(anchor.start.blockId);
            ownsRange = true;
            rangeEvent = new CustomEvent(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, { detail: { anchors: [anchor] } });
            window.addEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, otherRange);
            window.dispatchEvent(rangeEvent);
          }
          highlighted = [...new Set(elements)];
          highlighted.forEach(element => element.classList.add("source-reference-focus-pulse"));
        }
        timer = window.setTimeout(clearHighlight, 4000);
      } else if (++attempts < 80) timer = window.setTimeout(reveal, 100);
      else { consumed.current = true; clearRequest(); missing(); }
    };
    // The settled PageCanvas owns layout. Allow it to mount/measure before looking up the anchor.
    timer = window.setTimeout(reveal, 100);
    return () => { window.clearTimeout(timer); clearHighlight(); window.removeEventListener(EXTERNAL_TEXT_RANGE_HIGHLIGHT_EVENT, otherRange); };
  }, [request, ready, fileId, root, select, region, missing]);
}
