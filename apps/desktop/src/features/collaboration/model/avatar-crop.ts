/**
 * アイコンにする範囲 (元の画像の中の正方形) の計算。画面・canvas・React を知らない純粋な関数だけを置き、
 * 切り抜く画面 (`renderer/CollaborationAvatarCropDialog.tsx`) と縮小 (`renderer/avatar-image.ts`) が共有する。
 *
 * 座標はすべて元の画像 (写真の向きを起こした後) のピクセル。範囲は必ず画像の中に収め、送るアイコンに
 * 余白 (画像の外) が入らないようにする。拡大率 1 は「短い辺が枠いっぱい」で、それより縮めることはできない。
 */

export interface AvatarImageSize {
  width: number;
  height: number;
}

/** 元の画像の中の正方形。`x`・`y` は左上、`size` は一辺 (どれも元の画像のピクセル)。 */
export interface AvatarCrop {
  x: number;
  y: number;
  size: number;
}

/** 拡大の上限。これ以上は元の画素が粗く見えるだけなので止める。 */
export const MAX_AVATAR_ZOOM = 8;
/** 切り抜く一辺の下限 (元のピクセル)。小さな画像では、これで拡大の上限が下がる。 */
export const MIN_AVATAR_CROP_SIZE = 32;

function shortSide(image: AvatarImageSize): number {
  return Math.max(0, Math.min(image.width, image.height));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 選べる拡大率の範囲。小さな画像 (短い辺が 32px 以下) は拡大できない (`max` が 1)。 */
export function avatarZoomRange(image: AvatarImageSize): { min: number; max: number } {
  return { min: 1, max: clamp(shortSide(image) / MIN_AVATAR_CROP_SIZE, 1, MAX_AVATAR_ZOOM) };
}

/** 選んだ直後の範囲。真ん中の正方形 (短い辺いっぱい)。 */
export function initialAvatarCrop(image: AvatarImageSize): AvatarCrop {
  const size = shortSide(image);
  return { x: (image.width - size) / 2, y: (image.height - size) / 2, size };
}

/** 範囲の拡大率 (短い辺 ÷ 範囲の一辺)。 */
export function avatarCropZoom(image: AvatarImageSize, crop: AvatarCrop): number {
  return crop.size > 0 ? shortSide(image) / crop.size : 1;
}

/** 拡大率の範囲に収め、正方形が画像の外へはみ出さないように寄せる。 */
export function clampAvatarCrop(image: AvatarImageSize, crop: AvatarCrop): AvatarCrop {
  const side = shortSide(image);
  if (side <= 0) return { x: 0, y: 0, size: 0 };
  const { max } = avatarZoomRange(image);
  const size = clamp(Number.isFinite(crop.size) ? crop.size : side, side / max, side);
  return {
    x: clamp(Number.isFinite(crop.x) ? crop.x : 0, 0, image.width - size),
    y: clamp(Number.isFinite(crop.y) ? crop.y : 0, 0, image.height - size),
    size,
  };
}

/**
 * 画像を枠の中で動かす。`dx`・`dy` は画像が動いた量を枠の一辺に対する割合で表す (右・下が正)。
 * ドラッグは押した時点の範囲 (`start`) と累計の移動量から毎回求める (端で止まっても指とずれない)。
 */
export function dragAvatarCrop(image: AvatarImageSize, start: AvatarCrop, dx: number, dy: number): AvatarCrop {
  return clampAvatarCrop(image, { x: start.x - dx * start.size, y: start.y - dy * start.size, size: start.size });
}

/**
 * 拡大率を変える。`focus` は枠の中で動かさない点 (枠の一辺に対する割合。既定は枠の真ん中)。
 * ホイールやピンチはポインタの下、スライダーやキーは真ん中を止めて拡大・縮小する。
 */
export function zoomAvatarCrop(
  image: AvatarImageSize,
  crop: AvatarCrop,
  zoom: number,
  focus: { x: number; y: number } = { x: 0.5, y: 0.5 },
): AvatarCrop {
  const range = avatarZoomRange(image);
  const nextZoom = clamp(Number.isFinite(zoom) ? zoom : 1, range.min, range.max);
  const size = shortSide(image) / nextZoom;
  const pointX = crop.x + focus.x * crop.size;
  const pointY = crop.y + focus.y * crop.size;
  return clampAvatarCrop(image, { x: pointX - focus.x * size, y: pointY - focus.y * size, size });
}

/**
 * 範囲を枠に合わせて見せるときの画像の置き方。どれも枠の一辺に対する割合 (枠の左上が 0、一辺が 1)。
 * 画面では `%` にして、枠の大きさが変わっても (切り抜く画面・小さな見本) 同じ式で描く。
 */
export function avatarCropPlacement(image: AvatarImageSize, crop: AvatarCrop): { left: number; top: number; width: number; height: number } {
  if (crop.size <= 0) return { left: 0, top: 0, width: 1, height: 1 };
  return {
    left: -crop.x / crop.size,
    top: -crop.y / crop.size,
    width: image.width / crop.size,
    height: image.height / crop.size,
  };
}

/**
 * スライダーの位置 (0〜1) と拡大率の対応。拡大率は掛け算で効くので、対数で等間隔にする
 * (1倍→2倍と 4倍→8倍が同じ幅になる)。
 */
export function avatarZoomFromSlider(image: AvatarImageSize, position: number): number {
  const { max } = avatarZoomRange(image);
  return max ** clamp(position, 0, 1);
}

export function avatarSliderFromZoom(image: AvatarImageSize, zoom: number): number {
  const { max } = avatarZoomRange(image);
  if (max <= 1) return 0;
  return clamp(Math.log(clamp(zoom, 1, max)) / Math.log(max), 0, 1);
}
