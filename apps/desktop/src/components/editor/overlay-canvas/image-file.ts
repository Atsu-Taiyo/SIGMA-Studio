import { isTiffImageFile } from "@/lib/overlay-image-files";
import type { OverlayAsset } from "@/features/document";
import { fitImageSizeWithinArea, type ImageInsertionSize, type OverlayImageEntry } from "@/features/drawing";
import { createOverlayAssetId, createOverlayShapeId } from "./ids";
import { getSvgImageDimensions } from "@/lib/svg-image-source";

// Browser file/decoder adapter. Geometry and the request lifetime are owned elsewhere.
export async function createOverlayImageEntry(file: File, areaSize: ImageInsertionSize): Promise<OverlayImageEntry> {
  const asset = await createOverlayImageAsset(file);
  const naturalSize = {
    w: asset.props.w,
    h: asset.props.h,
  };
  const insertionSize = fitImageSizeWithinArea(naturalSize, areaSize);

  return {
    asset,
    shape: {
      id: createOverlayShapeId(),
      type: "image",
      x: 0,
      y: 0,
      rotation: 0,
      props: {
        assetId: asset.id,
        w: insertionSize.w,
        h: insertionSize.h,
      },
    },
  };
}

export async function createOverlayImageAsset(file: File): Promise<OverlayAsset> {
  const source = isTiffImageFile(file) ? await convertTiffToPng(file) : file;
  const dataUrl = await readFileAsDataUrl(source);
  const dimensions = await readImageDimensions(dataUrl);
  const width = dimensions.width || 240;
  const height = dimensions.height || Math.max(80, Math.round(width * 0.66));
  return {
    id: createOverlayAssetId(),
    type: "image",
    props: {
      w: width,
      h: height,
      name: file.name,
      isAnimated: false,
      mimeType: source.type || null,
      src: dataUrl,
      fileSize: source.size,
    },
  };
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function readImageDimensions(dataUrl: string): Promise<{ width?: number; height?: number }> {
  if (dataUrl.startsWith("data:image/svg+xml")) {
    return Promise.resolve(getSvgImageDimensions(dataUrl) ?? {});
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({});
    image.src = dataUrl;
  });
}

/** TIFF never enters SigmaDoc: all renderers and exports consume the same PNG. */
async function convertTiffToPng(file: File): Promise<File> {
  const { decode, decodeImage, toRGBA8 } = await import("utif");
  const buffer = firstTiffPage(await file.arrayBuffer());
  const pages = decode(buffer);
  const page = pages[0];
  const width = Number(Array.isArray(page?.t256) ? page.t256[0] : 0);
  const height = Number(Array.isArray(page?.t257) ? page.t257[0] : 0);
  // Check before decompression and RGBA allocation, including malformed dimensions.
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0 || width * height > 40_000_000) {
    throw new Error("Invalid or oversized TIFF image");
  }
  // UTIF divides by tile dimensions and loops over that result. A zero tile
  // width/height can otherwise turn a tiny malformed TIFF into an infinite loop.
  if (page.t322 || page.t323) {
    const tileWidth = Number(Array.isArray(page.t322) ? page.t322[0] : 0);
    const tileHeight = Number(Array.isArray(page.t323) ? page.t323[0] : 0);
    if (!Number.isSafeInteger(tileWidth) || !Number.isSafeInteger(tileHeight) || tileWidth <= 0 || tileHeight <= 0 || tileWidth * tileHeight > 40_000_000) {
      throw new Error("Invalid or oversized TIFF tile");
    }
  }
  decodeImage(buffer, page);
  const pixels = toRGBA8(page);
  if (!page.data || pixels.length !== width * height * 4) throw new Error("Invalid TIFF pixels");
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Image conversion unavailable");
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(value => value ? resolve(value) : reject(new Error("TIFF conversion failed")), "image/png");
  });
  return new File([blob], file.name, { type: "image/png" });
}

/** Bound UTIF's directory parsing and only expose the requested first image.
 * UTIF follows linked pages and recursively decodes camera metadata without a
 * cycle guard. Neither is needed for the first-page PNG projection.
 */
function firstTiffPage(source: ArrayBuffer): ArrayBuffer {
  const header = new DataView(source);
  if (source.byteLength < 8 || !(
    header.getUint32(0) === 0x49492a00 || header.getUint32(0) === 0x4d4d002a
  )) throw new Error("Invalid TIFF header");
  const little = header.getUint16(0) === 0x4949;
  const offset = header.getUint32(4, little);
  if (offset < 8 || offset + 2 > source.byteLength) throw new Error("Invalid TIFF directory");
  const count = header.getUint16(offset, little);
  const end = offset + 2 + count * 12;
  if (end + 4 > source.byteLength) throw new Error("Invalid TIFF directory");
  const buffer = source.slice(0);
  const view = new DataView(buffer);
  // The product imports only page one; do not traverse subsequent IFDs.
  view.setUint32(end, 0, little);
  const typeBytes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8];
  let metadataValues = 0;
  for (let entry = offset + 2; entry < end; entry += 12) {
    const tag = view.getUint16(entry, little);
    if ([330, 34665, 50740, 37500].includes(tag)) {
      // SubIFD / EXIF / DNG / MakerNote can recursively point back here.
      view.setUint16(entry, 0, little);
      view.setUint16(entry + 2, 1, little);
      view.setUint32(entry + 4, 0, little);
      continue;
    }
    const type = view.getUint16(entry + 2, little);
    const values = view.getUint32(entry + 4, little);
    const bytes = values * (typeBytes[type] ?? 0);
    const start = bytes <= 4 ? entry + 8 : view.getUint32(entry + 8, little);
    if (!typeBytes[type] || values > 1_000_000 || start + bytes > buffer.byteLength) {
      throw new Error("Invalid TIFF directory value");
    }
    // UTIF materializes every entry separately.
    // Per-entry bounds alone do not bound the decoder's total work or memory.
    metadataValues += values;
    if (metadataValues > 1_000_000) throw new Error("TIFF directory exceeds metadata limit");
  }
  return buffer;
}
