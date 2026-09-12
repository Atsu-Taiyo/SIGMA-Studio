import type { OverlayAsset, OverlayPoint, OverlayShape } from "@/features/document";
import { fitShapesWithinPage } from "./shape-arrangement";

export interface ImageInsertionSize {
  w: number;
  h: number;
}

export interface OverlayImageEntry {
  asset: OverlayAsset;
  shape: Extract<OverlayShape, { type: "image" }>;
}

export function fitImageSizeWithinArea(
  naturalSize: ImageInsertionSize,
  areaSize: ImageInsertionSize,
): ImageInsertionSize {
  if (naturalSize.w <= 0 || naturalSize.h <= 0) {
    return { ...naturalSize };
  }

  const widthScale = areaSize.w > 0 ? areaSize.w / naturalSize.w : 1;
  const heightScale = areaSize.h > 0 ? areaSize.h / naturalSize.h : 1;
  const scale = Math.min(1, widthScale, heightScale);
  return {
    w: naturalSize.w * scale,
    h: naturalSize.h * scale,
  };
}

export function fitImageRowToWidth(
  sizes: readonly ImageInsertionSize[],
  maxWidth: number,
  gap: number,
): ImageInsertionSize[] {
  const copiedSizes = sizes.map((size) => ({ ...size }));
  if (copiedSizes.length < 2 || maxWidth <= 0) {
    return copiedSizes;
  }

  const totalImageWidth = copiedSizes.reduce((sum, size) => sum + size.w, 0);
  const availableImageWidth = maxWidth - Math.max(0, gap) * (copiedSizes.length - 1);
  if (totalImageWidth <= 0 || availableImageWidth <= 0 || totalImageWidth <= availableImageWidth) {
    return copiedSizes;
  }

  const scale = availableImageWidth / totalImageWidth;
  return copiedSizes.map((size) => ({
    w: size.w * scale,
    h: size.h * scale,
  }));
}

/** Decoded assets keep their natural dimensions; only the inserted shape row is fitted. */
export function placeOverlayImageEntries(
  entries: readonly OverlayImageEntry[],
  options: {
    areaWidth: number;
    canvasWidth: number;
    canvasHeight: number;
    gap: number;
    point?: OverlayPoint;
    parentId?: string;
  },
): OverlayShape[] {
  const rowSizes = fitImageRowToWidth(
    entries.map((entry) => ({ w: entry.shape.props.w, h: entry.shape.props.h })),
    options.areaWidth,
    options.gap,
  );
  const resized = entries.map((entry, index) => ({
    ...entry.shape,
    props: { ...entry.shape.props, ...rowSizes[index] },
  }));
  const totalWidth = resized.reduce((sum, shape, index) => (
    sum + shape.props.w + (index === 0 ? 0 : options.gap)
  ), 0);
  const origin = options.point ?? {
    x: options.canvasWidth * 0.5 - totalWidth / 2,
    y: options.canvasHeight * 0.12,
  };
  let x = origin.x;
  const shapes = resized.map((shape) => {
    const nextShape: OverlayShape = {
      ...shape,
      x,
      y: origin.y,
      ...(options.parentId ? { parentId: options.parentId } : {}),
    };
    x += shape.props.w + options.gap;
    return nextShape;
  });
  return fitShapesWithinPage(shapes, options.canvasWidth, options.canvasHeight);
}
