// data:*/*;base64,XXXX 形式の添付を分解する共有ヘルパー。画像用の派生関数は
// Claude/Codexが受け付ける png/jpeg/gif/webp だけをallowlistし、SVGなどは汎用
// resource content側へ回す。

export type AiEditImageMimeType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

export interface ParsedAttachedImage {
  mimeType: AiEditImageMimeType;
  base64: string;
}

export interface ParsedAttachedFile {
  mimeType: string;
  base64: string;
}

const SUPPORTED_IMAGE_MIME_TYPES = new Set<AiEditImageMimeType>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export function parseAttachedFileDataUrl(dataUrl: string): ParsedAttachedFile | null {
  if (!dataUrl.startsWith("data:")) {
    return null;
  }
  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex < 0) {
    return null;
  }
  const metadata = dataUrl.slice(5, commaIndex).split(";");
  if (!metadata.slice(1).some((part) => part.toLowerCase() === "base64")) {
    return null;
  }
  const base64 = dataUrl.slice(commaIndex + 1);
  if (!base64) {
    return null;
  }
  return {
    mimeType: metadata[0] || "application/octet-stream",
    base64,
  };
}

export function parseAttachedImageDataUrl(dataUrl: string): ParsedAttachedImage | null {
  const file = parseAttachedFileDataUrl(dataUrl);
  if (!file || !SUPPORTED_IMAGE_MIME_TYPES.has(file.mimeType as AiEditImageMimeType)) {
    return null;
  }
  return { mimeType: file.mimeType as AiEditImageMimeType, base64: file.base64 };
}
