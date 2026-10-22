import type { OverlayPoint } from "./types";

/**
 * 図形の貼り付け (⌘V) をマウスポインタの位置へ置くための部品。
 *
 * - ポインタの最後の位置は、window の `pointermove` / `pointerleave` を軽く聞いて覚えるだけ
 *   (React の状態は持たない — 動くたびに描画し直さない)。
 * - 貼り付けの瞬間に、その位置が「文書の編集領域 (ページの並ぶスクロール面)」の上かを
 *   `elementFromPoint` で確かめる。メニューバー・ツールバー・サイドバー・ダイアログの上や、
 *   位置が分からないとき (ウィンドウの外・まだ動かしていない) は null を返し、呼び出し側は
 *   従来の「元の位置から少しずらす」に戻る。
 * - 紙面の座標への変換と、ページへの押し戻しは純粋な関数に分けてある。
 */

export interface ClientPoint {
  x: number;
  y: number;
}

/** 貼り付け先の紙面の並び。ページは縦に等間隔で並ぶ (`ANCHOR_PAGE_STRIDE_PX` と同じ前提)。 */
export interface PasteCanvasLayout {
  canvasWidth: number;
  canvasHeight: number;
  /** 1 ページの高さ。0 以下はページの並びを持たない面 (running region・素材編集) で、置き方を変えない。 */
  pageHeightPx: number;
  /** ページ間の隙間。 */
  pageGapPx: number;
}

export interface CanvasClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** ページの並びを持つ面か (持たない面では、ポインタの位置へは置かない)。 */
export function hasPageLayout(layout: PasteCanvasLayout): boolean {
  return layout.pageHeightPx > 0 && layout.canvasWidth > 0 && layout.canvasHeight > 0;
}

/** `layout` のページ数。高さ = ページ数 × ページ高 + (ページ数 - 1) × 隙間 から逆算する。 */
export function countPasteLayoutPages(layout: PasteCanvasLayout): number {
  if (!hasPageLayout(layout)) {
    return 1;
  }
  const stride = layout.pageHeightPx + Math.max(0, layout.pageGapPx);
  return Math.max(1, Math.round((layout.canvasHeight + Math.max(0, layout.pageGapPx)) / stride));
}

/**
 * 画面上の点 (client 座標) を、重ねた面の座標へ。`pagePointFromClient` と同じ写し方
 * (キャンバス要素の見た目の矩形を、面の寸法へ引き伸ばす) で、ズームに依らない。
 */
export function clientPointToCanvasPoint(
  point: ClientPoint,
  rect: CanvasClientRect,
  layout: Pick<PasteCanvasLayout, "canvasWidth" | "canvasHeight">,
): OverlayPoint | null {
  if (rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  return {
    x: ((point.x - rect.left) / rect.width) * layout.canvasWidth,
    y: ((point.y - rect.top) / rect.height) * layout.canvasHeight,
  };
}

/**
 * 貼り付けた図形全体 (幅 w × 高さ h) の中心を、いちばん近いページの内側へ押し戻す。
 *
 * ページとページの間の灰色の隙間や、紙の左右の外にポインタがあるときは、近い方のページへ
 * 寄せる (同じ距離なら上のページ)。図形がページより大きいときは、その軸ではページの中央に置く。
 */
export function clampPasteCenterToNearestPage(
  center: OverlayPoint,
  size: { w: number; h: number },
  layout: PasteCanvasLayout,
): OverlayPoint {
  const pageCount = countPasteLayoutPages(layout);
  const stride = layout.pageHeightPx + Math.max(0, layout.pageGapPx);
  const nearest = pickNearestPageIndex(center.y, layout.pageHeightPx, stride, pageCount);
  const top = nearest * stride;
  return {
    x: clampAxis(center.x, size.w, 0, layout.canvasWidth),
    y: clampAxis(center.y, size.h, top, top + layout.pageHeightPx),
  };
}

function pickNearestPageIndex(y: number, pageHeight: number, stride: number, pageCount: number): number {
  const cell = Math.min(pageCount - 1, Math.max(0, Math.floor(y / stride)));
  const next = cell + 1;
  if (next >= pageCount) {
    return cell;
  }
  // y が cell 番目のページの下の隙間 (または下に外れた位置) なら、次のページとの近さで決める。
  const distanceToCell = Math.max(0, y - (cell * stride + pageHeight));
  const distanceToNext = Math.max(0, next * stride - y);
  return distanceToNext < distanceToCell ? next : cell;
}

function clampAxis(center: number, extent: number, min: number, max: number): number {
  const half = extent / 2;
  if (max - min <= extent) {
    return (min + max) / 2;
  }
  return Math.min(max - half, Math.max(min + half, center));
}

export interface PointerPastePlacement {
  /** ポインタを紙面の座標へ写した点 (まだページへ押し戻していない)。 */
  point: OverlayPoint;
  layout: PasteCanvasLayout;
}

/**
 * ポインタの client 座標から、貼り付けの置き場所の指定を作る。置けない面
 * (ページの並びを持たない・キャンバスの寸法が取れない) は null で、従来の置き方に戻る。
 */
export function resolvePointerPastePlacement(
  pointer: ClientPoint | null | undefined,
  rect: CanvasClientRect | null | undefined,
  layout: PasteCanvasLayout,
): PointerPastePlacement | null {
  if (!pointer || !rect || !hasPageLayout(layout)) {
    return null;
  }
  const point = clientPointToCanvasPoint(pointer, rect, layout);
  return point ? { point, layout } : null;
}

// ---------------------------------------------------------------------------
// ポインタの追跡
// ---------------------------------------------------------------------------

/** 文書の編集領域 (ページが並ぶ面)。灰色の余白も含む。 */
const PASTE_SURFACE_SELECTOR = ".page-mode";
/** 領域に見えても貼り付け先ではない面: 分割表示の読み取り専用ペインと、ホワイトボード。 */
const PASTE_SURFACE_EXCLUDE_SELECTOR = ".workspace-passive-editor, [data-whiteboard='true']";

interface ClosestCapable {
  closest(selector: string): ClosestCapable | null;
}

/** この要素が、貼り付けをポインタへ置いてよい編集領域の中か。 */
export function isPointerPasteSurface(element: ClosestCapable | null | undefined): boolean {
  const surface = element?.closest(PASTE_SURFACE_SELECTOR);
  return Boolean(surface) && !surface!.closest(PASTE_SURFACE_EXCLUDE_SELECTOR);
}

let lastPointer: ClientPoint | null = null;
let trackerUsers = 0;
let removeListeners: (() => void) | null = null;

function installPointerListeners(): () => void {
  const remember = (event: PointerEvent) => {
    // 指やペンで触れた後の位置は「ポインタが乗っている」とは言えないので覚えない。
    lastPointer = event.pointerType === "touch" ? null : { x: event.clientX, y: event.clientY };
  };
  const forget = () => {
    lastPointer = null;
  };
  const root = document.documentElement;
  window.addEventListener("pointermove", remember, { capture: true, passive: true });
  window.addEventListener("pointerdown", remember, { capture: true, passive: true });
  root.addEventListener("pointerleave", forget);
  return () => {
    window.removeEventListener("pointermove", remember, { capture: true });
    window.removeEventListener("pointerdown", remember, { capture: true });
    root.removeEventListener("pointerleave", forget);
    lastPointer = null;
  };
}

/**
 * ポインタの最後の位置の追跡を始める。何度呼んでもリスナーは 1 組で、返り値を全員が呼んだら止まる。
 * ブラウザ以外 (SSR・node のテスト) では何もしない。
 */
export function trackPointerForPaste(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => undefined;
  }
  trackerUsers += 1;
  if (trackerUsers === 1) {
    removeListeners = installPointerListeners();
  }
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    trackerUsers -= 1;
    if (trackerUsers === 0) {
      removeListeners?.();
      removeListeners = null;
    }
  };
}

/**
 * 貼り付けの瞬間のポインタ位置。文書の編集領域の上にあるときだけ返す。
 *
 * メニューバー・ツールバー・サイドバー・ダイアログの上、ウィンドウの外、まだ一度も動かして
 * いないときは null (従来どおり元の位置から少しずらして置く)。位置は最後に動いた点のままで、
 * スクロールしていても `elementFromPoint` と紙面への変換を貼り付けの瞬間に行うので食い違わない。
 */
export function getPointerPasteClientPoint(): ClientPoint | null {
  const pointer = lastPointer;
  if (!pointer || typeof document === "undefined" || typeof document.elementFromPoint !== "function") {
    return null;
  }
  return isPointerPasteSurface(document.elementFromPoint(pointer.x, pointer.y)) ? { ...pointer } : null;
}
