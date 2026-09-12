import type {
  OverlayAsset,
  OverlayBounds,
  OverlayImageCrop,
  OverlayShape,
} from "@/features/document";

export const MIN_IMAGE_CROP_RATIO = 0.02;

export type OverlayImageShape = Extract<OverlayShape, { type: "image" }>;

export interface CroppedImageLayout {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function normalizeImageCrop(
  crop: OverlayImageCrop | undefined | null,
): OverlayImageCrop | null {
  if (!crop) {
    return null;
  }

  const left = clamp01(Math.min(crop.topLeft.x, crop.bottomRight.x));
  const top = clamp01(Math.min(crop.topLeft.y, crop.bottomRight.y));
  const right = clamp01(Math.max(crop.topLeft.x, crop.bottomRight.x));
  const bottom = clamp01(Math.max(crop.topLeft.y, crop.bottomRight.y));

  if (right - left < MIN_IMAGE_CROP_RATIO || bottom - top < MIN_IMAGE_CROP_RATIO) {
    return null;
  }

  return {
    topLeft: { x: left, y: top },
    bottomRight: { x: right, y: bottom },
  };
}

export function getImageCoverCrop(
  shape: OverlayImageShape,
  asset: OverlayAsset | undefined,
): OverlayImageCrop {
  const explicit = normalizeImageCrop(shape.props.crop);
  if (explicit) {
    return explicit;
  }

  const assetW = Math.max(1, asset?.props.w || shape.props.w || 1);
  const assetH = Math.max(1, asset?.props.h || shape.props.h || 1);
  const shapeW = Math.max(1, shape.props.w);
  const shapeH = Math.max(1, shape.props.h);
  const assetAspect = assetW / assetH;
  const shapeAspect = shapeW / shapeH;

  if (assetAspect > shapeAspect) {
    const cropWidth = shapeAspect / assetAspect;
    const left = (1 - cropWidth) / 2;
    return {
      topLeft: { x: left, y: 0 },
      bottomRight: { x: left + cropWidth, y: 1 },
    };
  }

  const cropHeight = assetAspect / shapeAspect;
  const top = (1 - cropHeight) / 2;
  return {
    topLeft: { x: 0, y: top },
    bottomRight: { x: 1, y: top + cropHeight },
  };
}

export function getCroppedImageLayout(
  shape: OverlayImageShape,
  asset: OverlayAsset | undefined,
  crop = getImageCoverCrop(shape, asset),
): CroppedImageLayout {
  const assetW = Math.max(1, asset?.props.w || shape.props.w || 1);
  const assetH = Math.max(1, asset?.props.h || shape.props.h || 1);
  return getCroppedImageLayoutForSize(
    { w: shape.props.w, h: shape.props.h },
    { w: assetW, h: assetH },
    crop,
  );
}

export function getCroppedImageLayoutForSize(
  frame: Pick<OverlayBounds, "w" | "h">,
  naturalSize: { w: number; h: number },
  crop: OverlayImageCrop,
): CroppedImageLayout {
  const assetW = Math.max(1, naturalSize.w);
  const assetH = Math.max(1, naturalSize.h);
  const cropW = Math.max(MIN_IMAGE_CROP_RATIO, crop.bottomRight.x - crop.topLeft.x);
  const cropH = Math.max(MIN_IMAGE_CROP_RATIO, crop.bottomRight.y - crop.topLeft.y);
  const scale = Math.max(
    frame.w / (assetW * cropW),
    frame.h / (assetH * cropH),
  );
  const width = assetW * scale;
  const height = assetH * scale;
  return {
    x: -crop.topLeft.x * width + (frame.w - cropW * width) / 2,
    y: -crop.topLeft.y * height + (frame.h - cropH * height) / 2,
    width,
    height,
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}
