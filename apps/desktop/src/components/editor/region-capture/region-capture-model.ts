/**
 * 範囲スクリーンショットの純粋な幾何と入力判定。DOM・React・Electron を知らない。
 * 座標はすべてウィンドウ内容の左上を原点にした CSS px (`clientX` / `getBoundingClientRect` と同じ)。
 */

export interface CapturePoint {
  x: number;
  y: number;
}

export interface CaptureRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CaptureBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface CaptureModifierState {
  altKey: boolean;
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
}

/** これより小さいドラッグは「ただのクリック」とみなし、撮影範囲にしない。 */
export const MIN_CAPTURE_SIZE_PX = 12;

/** 操作バーと選択枠のあいだの間隔、画面の端に残す余白。 */
export const CAPTURE_BAR_GAP_PX = 8;
export const CAPTURE_BAR_MARGIN_PX = 8;

/**
 * 範囲を決めるために押しっぱなしにするキー: ⌥ (Alt) + ⇧ (Shift)。
 *
 * Shift / Cmd / Ctrl の単独や組み合わせは図形の追加選択に、Alt の単独は図形の複製ドラッグに
 * すでに使われているため、この 2 つだけを同時に押した状態を撮影の合図にする。
 */
export function isCaptureChord(modifiers: CaptureModifierState): boolean {
  return modifiers.altKey && modifiers.shiftKey && !modifiers.ctrlKey && !modifiers.metaKey;
}

export function clampPointToBounds(point: CapturePoint, bounds: CaptureBounds): CapturePoint {
  return {
    x: Math.min(bounds.right, Math.max(bounds.left, point.x)),
    y: Math.min(bounds.bottom, Math.max(bounds.top, point.y)),
  };
}

/** ドラッグの始点と現在点から、`bounds` の内側に収めた矩形を作る (どの向きのドラッグでも同じ)。 */
export function rectFromDrag(start: CapturePoint, current: CapturePoint, bounds: CaptureBounds): CaptureRect {
  const a = clampPointToBounds(start, bounds);
  const b = clampPointToBounds(current, bounds);
  return {
    left: Math.min(a.x, b.x),
    top: Math.min(a.y, b.y),
    width: Math.abs(a.x - b.x),
    height: Math.abs(a.y - b.y),
  };
}

export function isCaptureRectLargeEnough(rect: CaptureRect): boolean {
  return rect.width >= MIN_CAPTURE_SIZE_PX && rect.height >= MIN_CAPTURE_SIZE_PX;
}

/**
 * 選択枠の近くに置く操作バーの位置 (左上)。枠の下に置き、下に収まらなければ上、
 * どちらも収まらなければ枠の内側の下端に重ねる。左右は枠の中心に合わせて画面内に収める。
 */
export function placeCaptureActionBar(
  rect: CaptureRect,
  bar: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number } {
  const maxLeft = Math.max(CAPTURE_BAR_MARGIN_PX, viewport.width - bar.width - CAPTURE_BAR_MARGIN_PX);
  const left = Math.min(maxLeft, Math.max(CAPTURE_BAR_MARGIN_PX, rect.left + rect.width / 2 - bar.width / 2));

  const below = rect.top + rect.height + CAPTURE_BAR_GAP_PX;
  if (below + bar.height + CAPTURE_BAR_MARGIN_PX <= viewport.height) {
    return { left, top: below };
  }
  const above = rect.top - CAPTURE_BAR_GAP_PX - bar.height;
  if (above >= CAPTURE_BAR_MARGIN_PX) {
    return { left, top: above };
  }
  return {
    left,
    top: Math.max(CAPTURE_BAR_MARGIN_PX, viewport.height - bar.height - CAPTURE_BAR_MARGIN_PX),
  };
}

/** 保存する画像のファイル名 (例: `screenshot-20261003-142530.png`)。ローカル時刻で付ける。 */
export function createCaptureFileName(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `screenshot-${date}-${time}.png`;
}
