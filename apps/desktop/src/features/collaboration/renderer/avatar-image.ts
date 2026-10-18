/** アイコンは 256px 四方で送る (表示は最大 64px。高解像度の画面でも足りる)。 */
export const AVATAR_SIZE = 256;
/** 選べる元の画像の上限。これより大きい写真は、縮める前に断る (読み込みで固まらないように)。 */
export const MAX_AVATAR_SOURCE_BYTES = 20 * 1024 * 1024;
const AVATAR_SOURCE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif", "image/heic", "image/heif"]);

export type AvatarImageError = "unsupported" | "too-large" | "unreadable";

export interface PreparedAvatarImage {
  bytes: Uint8Array;
  type: "image/webp" | "image/png";
  /** 保存前の見本 (`URL.revokeObjectURL` で片付ける)。 */
  previewUrl: string;
}

/**
 * 選んだ画像を、真ん中で正方形に切り抜いて 256px 四方の WebP にする。写真の向き (EXIF) は
 * `createImageBitmap` の `imageOrientation: "from-image"` で正しく起こす。
 */
export async function prepareAvatarImage(file: Blob): Promise<PreparedAvatarImage | AvatarImageError> {
  if (file.type && !AVATAR_SOURCE_TYPES.has(file.type)) return "unsupported";
  if (file.size > MAX_AVATAR_SOURCE_BYTES) return "too-large";
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    return "unreadable";
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height);
    if (side <= 0) return "unreadable";
    const canvas = document.createElement("canvas");
    canvas.width = AVATAR_SIZE;
    canvas.height = AVATAR_SIZE;
    const context = canvas.getContext("2d");
    if (!context) return "unreadable";
    context.imageSmoothingQuality = "high";
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      AVATAR_SIZE,
      AVATAR_SIZE,
    );
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
