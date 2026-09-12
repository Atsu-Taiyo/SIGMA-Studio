import {
  getCroppedImageLayout,
  getCroppedImageLayoutForSize,
  getImageCoverCrop,
  MIN_IMAGE_CROP_RATIO,
  normalizeImageCrop,
} from "@/features/drawing";
import type { OverlayImageShape } from "@/features/drawing";

import type { ResizeHandle } from "./interaction-mode";
import type { OverlayAsset, OverlayBounds, OverlayImageCrop, OverlayPoint } from "./types";

export const MIN_IMAGE_CROP_FRAME_SIZE = 16;

export {
  getCroppedImageLayout,
  getImageCoverCrop,
  normalizeImageCrop,
} from "@/features/drawing";
export type { OverlayImageShape } from "@/features/drawing";

export function getImageCropCss(shape: OverlayImageShape, asset: OverlayAsset | undefined): {
  width: number;
  height: number;
  transform: string;
} {
  const crop = getImageCoverCrop(shape, asset);
  const layout = getCroppedImageLayout(shape, asset, crop);
  return {
    width: layout.width,
    height: layout.height,
    transform: `translate(${layout.x}px, ${layout.y}px)`,
  };
}

export function resizeImageCropFrame(
  startBounds: OverlayBounds,
  startCrop: OverlayImageCrop,
  naturalSize: { w: number; h: number },
  handle: ResizeHandle,
  localDelta: OverlayPoint,
): { bounds: OverlayBounds; crop: OverlayImageCrop } {
  const crop = normalizeImageCrop(startCrop) ?? {
    topLeft: { x: 0, y: 0 },
    bottomRight: { x: 1, y: 1 },
  };
  const layout = getCroppedImageLayoutForSize(startBounds, naturalSize, crop);
  const ghostLeft = startBounds.x + layout.x;
  const ghostTop = startBounds.y + layout.y;
  const ghostRight = ghostLeft + layout.width;
  const ghostBottom = ghostTop + layout.height;
  const startRight = startBounds.x + startBounds.w;
  const startBottom = startBounds.y + startBounds.h;
  const minWidth = Math.min(
    startBounds.w,
    Math.max(MIN_IMAGE_CROP_FRAME_SIZE, layout.width * MIN_IMAGE_CROP_RATIO),
  );
  const minHeight = Math.min(
    startBounds.h,
    Math.max(MIN_IMAGE_CROP_FRAME_SIZE, layout.height * MIN_IMAGE_CROP_RATIO),
  );

  let left = startBounds.x;
  let top = startBounds.y;
  let right = startRight;
  let bottom = startBottom;

  if (handle.includes("w")) {
    left = clamp(startBounds.x + localDelta.x, ghostLeft, startRight - minWidth);
  }
  if (handle.includes("e")) {
    right = clamp(startRight + localDelta.x, startBounds.x + minWidth, ghostRight);
  }
  if (handle.includes("n")) {
    top = clamp(startBounds.y + localDelta.y, ghostTop, startBottom - minHeight);
  }
  if (handle.includes("s")) {
    bottom = clamp(startBottom + localDelta.y, startBounds.y + minHeight, ghostBottom);
  }

  return {
    bounds: {
      x: left,
      y: top,
      w: right - left,
      h: bottom - top,
    },
    crop: {
      topLeft: {
        x: clamp01((left - ghostLeft) / layout.width),
        y: clamp01((top - ghostTop) / layout.height),
      },
      bottomRight: {
        x: clamp01((right - ghostLeft) / layout.width),
        y: clamp01((bottom - ghostTop) / layout.height),
      },
    },
  };
}

export function panImageCrop(
  shape: OverlayImageShape,
  asset: OverlayAsset | undefined,
  dx: number,
  dy: number,
): OverlayImageShape {
  const crop = getImageCoverCrop(shape, asset);
  const cropW = crop.bottomRight.x - crop.topLeft.x;
  const cropH = crop.bottomRight.y - crop.topLeft.y;
  const layout = getCroppedImageLayout(shape, asset, crop);
  const normalizedDx = -dx / layout.width;
  const normalizedDy = -dy / layout.height;
  const left = clamp(crop.topLeft.x + normalizedDx, 0, 1 - cropW);
  const top = clamp(crop.topLeft.y + normalizedDy, 0, 1 - cropH);

  return withImageCrop(shape, {
    topLeft: { x: left, y: top },
    bottomRight: { x: left + cropW, y: top + cropH },
  });
}

export function drawCroppedImageToCanvas(
  canvas: HTMLCanvasElement,
  image: CanvasImageSource,
  shape: OverlayImageShape,
  asset: OverlayAsset | undefined,
): void {
  const crop = getImageCoverCrop(shape, asset);
  const layout = getCroppedImageLayout(shape, asset, crop);
  canvas.width = Math.max(1, Math.round(shape.props.w));
  canvas.height = Math.max(1, Math.round(shape.props.h));
  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }
  context.clearRect(0, 0, canvas.width, canvas.height);
  context.drawImage(image, layout.x, layout.y, layout.width, layout.height);
}

function withImageCrop(shape: OverlayImageShape, crop: OverlayImageCrop): OverlayImageShape {
  return {
    ...shape,
    props: {
      ...shape.props,
      crop,
    },
  };
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, value));
}
