import { WHEEL_ZOOM_SENSITIVITY } from "@/components/editor/editor-shell/constants";
import { clampZoom } from "@/components/editor/editor-shell/zoom";
import { getWhiteboardPanForZoom } from "@/components/editor/page-canvas/pointer-model";

/**
 * ホワイトボードのカメラ計算。**純関数のみ・DOM 非依存**。
 *
 * ズームの入口はリボンの ±、ズーム選択、⌘+/⌘-/⌘0、ホイール、右下コントロールと 5 つあるが、
 * 「どこから来ても同じカメラ計算を通る」ことが不動点の唯一の担保になる。入口ごとに式を持つと
 * （実際に以前はそうだった）片方だけがビューポート中心錨、片方は左上原点、という破綻になる。
 * ここに式を集めて `EditorShell.applyZoom` の 1 箇所からだけ呼ぶ。
 */

/** ズーム(%)とパン(画面px)。パンは `.whiteboard-canvas` の translate にそのまま入る値。 */
export interface WhiteboardCamera {
  zoom: number;
  panX: number;
  panY: number;
}

/** ビューポート左上を原点とする錨の位置(px)。 */
export interface WhiteboardCameraAnchor {
  x: number;
  y: number;
}

/** `deltaMode: 1` (行単位) を px へ直すときの 1 行。Chromium/Firefox の既定に合わせている。 */
export const WHEEL_LINE_HEIGHT_PX = 16;

/**
 * 1 イベントぶんのズーム delta の上限。
 * トラックパッドの慣性やページ単位 delta が 1 発でズーム域を端まで飛ばすのを防ぐ。
 */
export const WHEEL_ZOOM_DELTA_CLAMP = 10;

export function resetCamera(): WhiteboardCamera {
  return { zoom: 100, panX: 0, panY: 0 };
}

/**
 * 錨の下にあるワールド座標を固定したままズームする。
 *
 * `nextZoom` は**先に**共有の `clampZoom` へ通す。クランプ前の値でパンを計算すると、
 * 端に張り付いたときだけ錨がずれる（拡大は止まっているのに絵が流れる）。
 */
export function zoomCameraAt(
  camera: WhiteboardCamera,
  nextZoom: number,
  anchor: WhiteboardCameraAnchor,
): WhiteboardCamera {
  const clamped = clampZoom(nextZoom);
  if (clamped === camera.zoom) {
    return camera;
  }

  const pan = getWhiteboardPanForZoom({
    anchorX: anchor.x,
    anchorY: anchor.y,
    panX: camera.panX,
    panY: camera.panY,
    currentZoom: camera.zoom,
    nextZoom: clamped,
  });

  return { zoom: clamped, panX: pan.x, panY: pan.y };
}

/**
 * 実際に適用する倍率を決める。
 *
 * `clampZoom` は整数へ丸めるので、低倍率では乗算ズーム 1 発 (トラックパッドの小さなデルタ)
 * が丸めで消えて何も起きない。10% まで縮めると `|deltaY| <= 6` のピンチが全部無効になり、
 * 「縮めたら戻せない」に見える。潰れたときだけ意図した向きへ最小 1% 進める。
 */
export function resolveNextZoom(currentZoom: number, requestedZoom: number): number {
  const clamped = clampZoom(requestedZoom);
  if (clamped !== currentZoom || requestedZoom === currentZoom) {
    return clamped;
  }

  return clampZoom(currentZoom + Math.sign(requestedZoom - currentZoom));
}

export function panCamera(camera: WhiteboardCamera, dx: number, dy: number): WhiteboardCamera {
  return { zoom: camera.zoom, panX: camera.panX + dx, panY: camera.panY + dy };
}

/** `deltaMode` を px へ直すための実寸。ページ単位はビューポートの実サイズを使う。 */
export interface WheelDeltaScale {
  lineHeightPx: number;
  pageWidthPx: number;
  pageHeightPx: number;
}

export interface WheelDeltaInput {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
}

/**
 * `WheelEvent` の delta を px へそろえる。
 *
 * Windows のマウスホイールは `deltaMode: 1` (行単位) で `deltaY` が 3 程度しか来ない。
 * 生の値をそのままパン量に使うと「ホイールを回してもほとんど動かない」になる。
 */
export function normalizeWheelDelta(
  event: WheelDeltaInput,
  scale: WheelDeltaScale,
): { dx: number; dy: number } {
  if (event.deltaMode === 1) {
    return { dx: event.deltaX * scale.lineHeightPx, dy: event.deltaY * scale.lineHeightPx };
  }
  if (event.deltaMode === 2) {
    return { dx: event.deltaX * scale.pageWidthPx, dy: event.deltaY * scale.pageHeightPx };
  }
  return { dx: event.deltaX, dy: event.deltaY };
}

/** `-0` を作らない符号反転。パン量は state と CSS へそのまま流れるので、負のゼロを残さない。 */
function invertDelta(value: number): number {
  return value === 0 ? 0 : -value;
}

export type WheelIntent =
  /** `factor` は現在のズームに掛ける倍率。 */
  | { kind: "zoom"; factor: number }
  /** `dx`/`dy` はカメラのパンに**そのまま足す**量（スクロール方向とは逆符号）。 */
  | { kind: "pan"; dx: number; dy: number };

export interface WheelIntentInput extends WheelDeltaInput {
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * ホイール 1 発が「ズーム」なのか「パン」なのかを決める。
 *
 * macOS のトラックパッドのピンチは ctrl+wheel として届くので、ピンチとズームは同じ枝を通る。
 */
export function resolveWheelIntent(event: WheelIntentInput, scale: WheelDeltaScale): WheelIntent {
  if (event.ctrlKey || event.metaKey) {
    // ズームは「1 ノッチあたり何倍」で、パンのように px へ直す量ではない。ここで
    // `normalizeWheelDelta` を通すと行/ページ単位のデバイスだけ倍率が跳ね上がり、
    // 紙モードの既存の効き方 (生 deltaY を ±10 でクリップ) と食い違う。
    const clipped = Math.abs(event.deltaY) > WHEEL_ZOOM_DELTA_CLAMP
      ? WHEEL_ZOOM_DELTA_CLAMP * Math.sign(event.deltaY)
      : event.deltaY;
    return { kind: "zoom", factor: Math.exp(-clipped * WHEEL_ZOOM_SENSITIVITY) };
  }

  const { dx, dy } = normalizeWheelDelta(event, scale);

  // Shift 単独は横スクロール。プラットフォームが既に x 軸へ振り替えている場合は二重に倒さない。
  if (event.shiftKey && dx === 0) {
    return { kind: "pan", dx: invertDelta(dy), dy: 0 };
  }

  return { kind: "pan", dx: invertDelta(dx), dy: invertDelta(dy) };
}

export interface ZoomAnchorScrollInput {
  scrollLeft: number;
  scrollTop: number;
  /** 錨のスクローラ矩形内オフセット(px)。 */
  offsetX: number;
  offsetY: number;
  currentZoom: number;
  nextZoom: number;
}

/**
 * 紙モードのズーム錨。カーソル下のコンテンツ座標が動かないスクロール位置を返す。
 *
 * ホワイトボードは transform、紙はスクロールと手段が違うだけで「錨を固定する」意図は同じ。
 * 分岐は `applyZoom` の 1 箇所に閉じ、式はどちらもここに置く。
 */
export function getScrollForZoomAnchor({
  scrollLeft,
  scrollTop,
  offsetX,
  offsetY,
  currentZoom,
  nextZoom,
}: ZoomAnchorScrollInput): { scrollLeft: number; scrollTop: number } {
  const currentFactor = currentZoom / 100;
  const nextFactor = nextZoom / 100;
  const unzoomedX = (scrollLeft + offsetX) / currentFactor;
  const unzoomedY = (scrollTop + offsetY) / currentFactor;

  return {
    scrollLeft: unzoomedX * nextFactor - offsetX,
    scrollTop: unzoomedY * nextFactor - offsetY,
  };
}
