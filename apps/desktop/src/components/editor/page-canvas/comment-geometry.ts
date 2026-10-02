import { type SigmaCommentAnchor,type SigmaCommentThread } from "@/features/document";

export function getMathTexFromRange(range: Range): string[] {
  const fragment = range.cloneContents();
  const values = Array.from(fragment.querySelectorAll<HTMLElement>("[data-sigma-doc-math-inline], .inline-math-node"))
    .map((element) => element.getAttribute("data-tex") ?? "")
    .filter(Boolean);
  return Array.from(new Set(values));
}

export function findBlockElement(root: HTMLElement, blockId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `#${CSS.escape(blockId)}, [data-sigma-doc-id="${CSS.escape(blockId)}"]`,
  );
}

export function measureCommentThreadTop(canvas: HTMLElement, thread: SigmaCommentThread, zoom: number): number | null {
  const threadElement = findCommentThreadElement(canvas, thread.id);
  if (threadElement) {
    return measureElementTopInCanvas(canvas, threadElement, zoom);
  }
  return measureCommentAnchorTop(canvas, thread.anchor, zoom);
}

export function measureCommentAnchorTop(canvas: HTMLElement, anchor: SigmaCommentAnchor, zoom: number): number | null {
  if (anchor.type === "textRange") {
    return measureElementTopInCanvas(canvas, findBlockElement(canvas, anchor.start.blockId), zoom);
  }

  if (anchor.type === "inlineMath") {
    const mathElement = canvas.querySelector<HTMLElement>(
      `.inline-math-node[data-id="${CSS.escape(anchor.mathInlineId)}"]`,
    );
    return measureElementTopInCanvas(canvas, mathElement ?? findBlockElement(canvas, anchor.blockId), zoom);
  }

  if (anchor.type === "block") {
    return measureElementTopInCanvas(canvas, findBlockElement(canvas, anchor.blockId), zoom);
  }

  if (anchor.type === "overlayShape") {
    const shapeElement = anchor.shapeIds
      .map((shapeId) => findOverlayShapeElement(canvas, shapeId))
      .find((element): element is HTMLElement => Boolean(element)) ?? null;
    return measureElementTopInCanvas(canvas, shapeElement, zoom);
  }

  if (anchor.type === "overlayMath" && anchor.shapeId) {
    return measureElementTopInCanvas(canvas, findOverlayShapeElement(canvas, anchor.shapeId), zoom);
  }

  return null;
}

export function findCommentThreadElement(canvas: HTMLElement, threadId: string): HTMLElement | null {
  const escaped = CSS.escape(threadId);
  return canvas.querySelector<HTMLElement>(
    `[data-comment-thread-id="${escaped}"], [data-comment-thread-ids~="${escaped}"]`,
  );
}

export function findOverlayShapeElement(canvas: HTMLElement, shapeId: string): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(`[data-overlay-shape-id="${CSS.escape(shapeId)}"]`);
}

export function measureElementTopInCanvas(canvas: HTMLElement, element: HTMLElement | null, zoom: number): number | null {
  if (!element) {
    return null;
  }
  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return Math.max(0, (elementRect.top - canvasRect.top) / zoomScale);
}
