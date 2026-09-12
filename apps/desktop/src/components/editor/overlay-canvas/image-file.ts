import type { OverlayAsset } from "@/features/document";
import { fitImageSizeWithinArea, type ImageInsertionSize, type OverlayImageEntry } from "@/features/drawing";
import { createOverlayAssetId, createOverlayShapeId } from "./ids";

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
  const dataUrl = await readFileAsDataUrl(file);
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
      mimeType: file.type || null,
      src: dataUrl,
      fileSize: file.size,
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
    return Promise.resolve({});
  }

  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => resolve({});
    image.src = dataUrl;
  });
}
