import type { AvatarCrop } from "../model/avatar-crop";

/** アイコンは 256px 四方で送る (表示は最大 64px。高解像度の画面でも足りる)。 */
export const AVATAR_SIZE = 256;
/** 選べる元の画像の上限。これより大きい写真は、縮める前に断る (読み込みで固まらないように)。 */
export const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;
const AVATAR_SOURCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export type AvatarImageError = "unsupported" | "too-large" | "unreadable";

/** 選んだ元の画像。切り抜く範囲を決める間はこれを見せ、確定したときに読み直して縮める。 */
export interface AvatarSource {
  file: Blob;
  /** 写真の向き (EXIF) を起こした後の大きさ。切り抜く範囲はこの座標で持つ。 */
  width: number;
  height: number;
  /** 切り抜く画面で見せる URL (`URL.revokeObjectURL` で片付ける)。 */
  url: string;
}

export interface PreparedAvatarImage {
  bytes: Uint8Array;
  type: "image/webp" | "image/png";
  /** 保存前の見本 (`URL.revokeObjectURL` で片付ける)。 */
  previewUrl: string;
}

/**
 * 選んだ画像を確かめて、向きを起こした後の大きさを測る。寸法は `createImageBitmap` で測る
 * (main の `nativeImage` は WebP を読めない)。写真の向きは `imageOrientation: "from-image"` で起こし、
 * 画面の `<img>` (既定で EXIF に従う) と同じ向きの座標にする。
 */
export async function loadAvatarSource(file: Blob): Promise<AvatarSource | AvatarImageError> {
  if (file.type && !AVATAR_SOURCE_TYPES.has(file.type)) return "unsupported";
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return "too-large";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return "unreadable";
  }
  const { width, height } = bitmap;
  bitmap.close();
  if (width <= 0 || height <= 0) return "unreadable";
  return { file, width, height, url: URL.createObjectURL(file) };
}

/**
 * 決めた範囲 (元の画像の中の正方形) を 256px 四方の WebP にする (WebP を書けなければ PNG)。
 * ファイルから読んだ画像は、`imageSmoothingQuality: "high"` の 1 回の縮小で細かい模様も均される
 * (1500px の 1px 縞を 256px にしても縞が残らないことを `tests/electron/profile-avatar-crop.spec.ts` で確かめている)。
 */
export async function renderAvatarImage(source: AvatarSource, crop: AvatarCrop): Promise<PreparedAvatarImage | AvatarImageError> {
  if (!(crop.size > 0)) return "unreadable";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(source.file, { imageOrientation: "from-image" });
  } catch {
    return "unreadable";
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return "unreadable";
    context.imageSmoothingQuality = "high";
    context.drawImage(bitmap, crop.x, crop.y, crop.size, crop.size, 0, 0, AVATAR_SIZE, AVATAR_SIZE);
    const webp = await canvasBlob(canvas, "image/webp", 0.88);
    const blob = webp?.type === "image/webp" ? webp : await canvasBlob(canvas, "image/png");
    if (!blob) return "unreadable";
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      type: blob.type === "image/webp" ? "image/webp" : "image/png",
      previewUrl: URL.createObjectURL(blob),
    };
  } finally {
    bitmap.close();
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
