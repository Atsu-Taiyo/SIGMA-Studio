export const AI_INLINE_ANCHOR_OFFSET_Y = 46;
export const AI_INLINE_VIEWPORT_MARGIN_PX = 12;
export const AI_INLINE_HOST_FALLBACK_WIDTH_PX = 440;
export const AI_INLINE_HOST_BOTTOM_CLEARANCE_PX = 220;
export const AI_INLINE_DRAG_BOTTOM_MARGIN_PX = 80;
export const AI_INLINE_DEFAULT_LEFT_PX = 320;
export const AI_INLINE_DEFAULT_TOP_PX = 140;

export interface AiInlineViewport {
  width: number;
  height: number;
}

export interface AiInlineAnchor {
  left: number;
  top: number;
}

export function getAiInlineHostPosition(
  anchor: AiInlineAnchor,
  viewport: AiInlineViewport,
  options: {
    hostWidth?: number;
    topBoundary?: number;
    margin?: number;
    bottomClearance?: number;
    anchorOffsetY?: number;
  } = {},
): AiInlineAnchor {
  const margin = options.margin ?? AI_INLINE_VIEWPORT_MARGIN_PX;
  const hostWidth = options.hostWidth ?? AI_INLINE_HOST_FALLBACK_WIDTH_PX;
  const topBoundary = Math.max(margin, options.topBoundary ?? margin);
  const bottomClearance = options.bottomClearance ?? AI_INLINE_HOST_BOTTOM_CLEARANCE_PX;
  const anchorOffsetY = options.anchorOffsetY ?? AI_INLINE_ANCHOR_OFFSET_Y;
  const maxLeft = Math.max(margin, viewport.width - hostWidth - margin);
  const maxTop = Math.max(topBoundary, viewport.height - bottomClearance);

  return {
    left: Math.max(margin, Math.min(anchor.left, maxLeft)),
    top: Math.max(topBoundary, Math.min(anchor.top + anchorOffsetY, maxTop)),
  };
}

export function getAiInlineDragPosition(
  nextPosition: AiInlineAnchor,
  viewport: AiInlineViewport,
  options: {
    hostWidth?: number;
    topBoundary?: number;
    margin?: number;
    bottomMargin?: number;
  } = {},
): AiInlineAnchor {
  const margin = options.margin ?? AI_INLINE_VIEWPORT_MARGIN_PX;
  const hostWidth = options.hostWidth ?? AI_INLINE_HOST_FALLBACK_WIDTH_PX;
  const topBoundary = Math.max(margin, options.topBoundary ?? margin);
  const bottomMargin = options.bottomMargin ?? AI_INLINE_DRAG_BOTTOM_MARGIN_PX;
  const maxLeft = Math.max(margin, viewport.width - hostWidth - margin);
  const maxTop = Math.max(topBoundary, viewport.height - bottomMargin);

  return {
    left: Math.max(margin, Math.min(nextPosition.left, maxLeft)),
    top: Math.max(topBoundary, Math.min(nextPosition.top, maxTop)),
  };
}

export function getAiInlineTopBoundaryFromRects(
  rects: ReadonlyArray<{ top: number; bottom: number } | null | undefined>,
  viewportHeight: number,
  options: {
    gap?: number;
    margin?: number;
  } = {},
): number {
  const margin = options.margin ?? AI_INLINE_VIEWPORT_MARGIN_PX;
  const gap = options.gap ?? 8;
  const visibleBottom = rects.reduce((bottom, rect) => {
    if (!rect || rect.bottom <= 0 || rect.top >= viewportHeight) {
      return bottom;
    }
    return Math.max(bottom, rect.bottom);
  }, margin - gap);

  return Math.min(
    Math.max(margin, visibleBottom + gap),
    Math.max(margin, viewportHeight - margin),
  );
}

export function getAiInlineTopBoundary(): number {
  if (typeof window === "undefined") {
    return AI_INLINE_VIEWPORT_MARGIN_PX;
  }
  const document = window.document;
  const menubarRect = document.querySelector<HTMLElement>(".editor-menubar")?.getBoundingClientRect();
  const topToolbarRect = document.querySelector<HTMLElement>(".top-toolbar")?.getBoundingClientRect();
  return getAiInlineTopBoundaryFromRects([topToolbarRect, menubarRect], window.innerHeight);
}
