const DRAG_AUTO_SCROLL_EDGE_PX = 32;
const DRAG_AUTO_SCROLL_MAX_DELTA_SECONDS = 1 / 15;

export interface DragAutoScrollViewportBounds {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

interface CreateDragAutoScrollerOptions {
  ownerWindow: Window;
  getViewportBounds: () => DragAutoScrollViewportBounds;
  panBy: DragAutoScrollPanBy;
  onPan: (
    clientX: number,
    clientY: number,
    layout: { rectSettled: boolean },
  ) => void;
  maxSpeedPxPerSec: number;
  horizontal?: boolean;
  vertical?: boolean;
}

export interface DragAutoScroller {
  update: (clientX: number, clientY: number) => void;
  stop: () => void;
}

export interface DragAutoScrollPanResult {
  appliedDx: number;
  appliedDy: number;
  rectSettled: boolean;
}

export type DragAutoScrollPanBy = (
  dx: number,
  dy: number,
) => DragAutoScrollPanResult | null;

/**
 * ドラッグ中の端スクロール速度 (画面 px/秒)。帯への食い込みを帯幅で正規化し、
 * 縦横とディスプレイのリフレッシュレートに依存しない式として持つ。
 */
export function resolveDragAutoScrollStep(
  clientPos: number,
  viewportStart: number,
  viewportEnd: number,
  maxSpeedPxPerSec: number,
  edge = DRAG_AUTO_SCROLL_EDGE_PX,
): number {
  if (viewportEnd - viewportStart <= edge * 2) {
    return 0;
  }
  if (clientPos < viewportStart + edge) {
    const incursion = viewportStart + edge - clientPos;
    return -maxSpeedPxPerSec * Math.min(1, incursion / edge);
  }
  if (clientPos > viewportEnd - edge) {
    const incursion = clientPos - (viewportEnd - edge);
    return maxSpeedPxPerSec * Math.min(1, incursion / edge);
  }
  return 0;
}

/**
 * 本文の断片 viewport は見かけ上はスクロール可能でも、translateY された内容を
 * scrollTop では戻せない。.editor-canvas を優先し、断片 viewport は候補から外す。
 */
export function findDragAutoScrollScroller(from: HTMLElement): HTMLElement | null {
  const canvas = from.closest<HTMLElement>(".editor-canvas");
  if (canvas) {
    return canvas;
  }

  const ownerWindow = from.ownerDocument.defaultView;
  for (let element = from.parentElement; element; element = element.parentElement) {
    if (element.classList.contains("editor-box-fragment-viewport")) {
      continue;
    }
    if (
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1
    ) {
      const style = ownerWindow?.getComputedStyle(element);
      const scrollsVertically = style?.overflowY === "auto" ||
        style?.overflowY === "scroll" ||
        style?.overflowY === "overlay";
      const scrollsHorizontally = style?.overflowX === "auto" ||
        style?.overflowX === "scroll" ||
        style?.overflowX === "overlay";
      if (scrollsVertically || scrollsHorizontally) {
        return element;
      }
    }
  }

  const scrollingElement = from.ownerDocument.scrollingElement;
  return scrollingElement instanceof HTMLElement ? scrollingElement : null;
}

export function getDragAutoScrollViewportBounds(
  container: HTMLElement,
  ownerWindow: Window,
): DragAutoScrollViewportBounds {
  if (container === container.ownerDocument.scrollingElement) {
    return {
      top: 0,
      bottom: ownerWindow.innerHeight,
      left: 0,
      right: ownerWindow.innerWidth,
    };
  }
  const rect = container.getBoundingClientRect();
  return {
    top: Math.max(rect.top, 0),
    bottom: Math.min(rect.bottom, ownerWindow.innerHeight),
    left: Math.max(rect.left, 0),
    right: Math.min(rect.right, ownerWindow.innerWidth),
  };
}

/** 紙面モードでは正の差分が scrollLeft / scrollTop の増加方向。 */
export function panDragAutoScrollElement(
  container: HTMLElement,
  dx: number,
  dy: number,
): DragAutoScrollPanResult | null {
  const previousLeft = container.scrollLeft;
  const previousTop = container.scrollTop;
  container.scrollLeft += dx;
  container.scrollTop += dy;
  const appliedDx = container.scrollLeft - previousLeft;
  const appliedDy = container.scrollTop - previousTop;
  return appliedDx !== 0 || appliedDy !== 0
    ? { appliedDx, appliedDy, rectSettled: true }
    : null;
}

/** ホワイトボードでは内容を流すため、スクロール方向と camera pan の符号を反転する。 */
export function createCameraDragAutoScrollPanBy(
  panBy: (dx: number, dy: number) => void,
): DragAutoScrollPanBy {
  return (dx, dy) => {
    if (dx === 0 && dy === 0) {
      return null;
    }
    panBy(dx === 0 ? 0 : -dx, dy === 0 ? 0 : -dy);
    return { appliedDx: dx, appliedDy: dy, rectSettled: false };
  };
}

/**
 * ポインタが端の帯に留まる間だけ回る共有 rAF ループ。DOM 矩形は実 pointer event の
 * `update` でだけ測り、連続フレームでは同じ矩形と適用済み pan の累計を使う。
 */
export function createDragAutoScroller(options: CreateDragAutoScrollerOptions): DragAutoScroller {
  const horizontal = options.horizontal ?? true;
  const vertical = options.vertical ?? true;
  const lastClient = { x: 0, y: 0 };
  let frame: number | null = null;
  let active = false;
  let viewportBounds: DragAutoScrollViewportBounds | null = null;
  let previousFrameTime: number | null = null;
  let remainderX = 0;
  let remainderY = 0;
  let unsettledDx = 0;
  let unsettledDy = 0;

  const step = (frameTime: number) => {
    frame = null;
    const bounds = viewportBounds;
    if (!bounds) {
      return;
    }
    const speedX = horizontal
      ? resolveDragAutoScrollStep(
          lastClient.x,
          bounds.left,
          bounds.right,
          options.maxSpeedPxPerSec,
          DRAG_AUTO_SCROLL_EDGE_PX,
        )
      : 0;
    const speedY = vertical
      ? resolveDragAutoScrollStep(
          lastClient.y,
          bounds.top,
          bounds.bottom,
          options.maxSpeedPxPerSec,
          DRAG_AUTO_SCROLL_EDGE_PX,
        )
      : 0;
    if (speedX === 0 && speedY === 0) {
      previousFrameTime = null;
      return;
    }

    const deltaSeconds = previousFrameTime === null
      ? 0
      : Math.min(
          Math.max(0, (frameTime - previousFrameTime) / 1000),
          DRAG_AUTO_SCROLL_MAX_DELTA_SECONDS,
        );
    previousFrameTime = frameTime;
    remainderX += speedX * deltaSeconds;
    remainderY += speedY * deltaSeconds;
    const dx = Math.trunc(remainderX);
    const dy = Math.trunc(remainderY);
    remainderX -= dx;
    remainderY -= dy;
    if (dx === 0 && dy === 0) {
      if (active) {
        frame = options.ownerWindow.requestAnimationFrame(step);
      }
      return;
    }

    const panResult = options.panBy(dx, dy);
    if (!panResult) {
      return;
    }
    if (panResult.rectSettled) {
      options.onPan(lastClient.x, lastClient.y, { rectSettled: true });
    } else {
      unsettledDx += panResult.appliedDx;
      unsettledDy += panResult.appliedDy;
      // camera は panBy(-dx, -dy) で内容を動かす。実 pointer event 時の矩形を固定して
      // 同じページ座標を得るには、その後に適用した累計を client 座標へ足す。
      options.onPan(
        lastClient.x + unsettledDx,
        lastClient.y + unsettledDy,
        { rectSettled: false },
      );
    }
    if (active) {
      frame = options.ownerWindow.requestAnimationFrame(step);
    }
  };

  return {
    update(clientX, clientY) {
      active = true;
      lastClient.x = clientX;
      lastClient.y = clientY;
      viewportBounds = options.getViewportBounds();
      unsettledDx = 0;
      unsettledDy = 0;
      if (frame === null) {
        frame = options.ownerWindow.requestAnimationFrame(step);
      }
    },
    stop() {
      active = false;
      viewportBounds = null;
      previousFrameTime = null;
      remainderX = 0;
      remainderY = 0;
      unsettledDx = 0;
      unsettledDy = 0;
      if (frame !== null) {
        options.ownerWindow.cancelAnimationFrame(frame);
        frame = null;
      }
    },
  };
}
