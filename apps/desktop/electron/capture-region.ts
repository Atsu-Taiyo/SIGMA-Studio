/**
 * 画面の一部をスクリーンショットにするときの入力検査と縮小計画。
 *
 * `webContents.capturePage` の矩形はウィンドウ内容の左上を原点にした DIP (CSS px) で、
 * レンダラーの `getBoundingClientRect` とそのまま対応する (このアプリは webContents のズームを使わない)。
 * Electron に依存しない純粋関数にして、IPC の外で検査できるようにする。
 */

export interface CaptureRegionRequest {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 出力の長辺の上限 (px)。AI へ渡す画像を無駄に大きくしないために使う。省略時は取得した解像度のまま。 */
  maxDimension?: number;
}

/** 1 回の取得で受け付ける矩形の一辺 (DIP)。ウィンドウより大きい要求は誤り。 */
export const MAX_CAPTURE_REGION_SIDE = 8192;
export const MIN_CAPTURE_OUTPUT_DIMENSION = 256;
export const MAX_CAPTURE_OUTPUT_DIMENSION = 4096;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseCaptureRegionRequest(value: unknown): CaptureRegionRequest | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const { x, y, width, height, maxDimension } = value as Record<string, unknown>;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(width) || !isFiniteNumber(height)) {
    return null;
  }
  const left = Math.floor(x);
  const top = Math.floor(y);
  // 端数の小数 px を含めて切り上げ、はみ出さないようにする。
  const right = Math.ceil(x + width);
  const bottom = Math.ceil(y + height);
  const rectWidth = right - left;
  const rectHeight = bottom - top;
  if (rectWidth < 1 || rectHeight < 1 || rectWidth > MAX_CAPTURE_REGION_SIDE || rectHeight > MAX_CAPTURE_REGION_SIDE) {
    return null;
  }
  const request: CaptureRegionRequest = { x: left, y: top, width: rectWidth, height: rectHeight };
  if (isFiniteNumber(maxDimension)) {
    request.maxDimension = Math.min(
      MAX_CAPTURE_OUTPUT_DIMENSION,
      Math.max(MIN_CAPTURE_OUTPUT_DIMENSION, Math.round(maxDimension)),
    );
  }
  return request;
}

/** 長辺が `maxDimension` を超えるときだけ、縦横比を保って縮めた大きさを返す。超えなければ null。 */
export function planCaptureDownscale(
  size: { width: number; height: number },
  maxDimension: number | undefined,
): { width: number; height: number } | null {
  if (maxDimension === undefined) {
    return null;
  }
  const longest = Math.max(size.width, size.height);
  if (longest <= maxDimension) {
    return null;
  }
  const scale = maxDimension / longest;
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}
