import { describe, expect, it } from "vitest";

import { resizeRotatedShapeToBounds } from "@/features/drawing";
import {
  getCroppedImageLayout,
  getImageCoverCrop,
  MIN_IMAGE_CROP_FRAME_SIZE,
  panImageCrop,
  resizeImageCropFrame,
} from "./image-crop";
import type { ResizeHandle } from "./interaction-mode";
import { getShapeBounds } from "./shapes/geometry";
import type { OverlayAsset, OverlayBounds, OverlayPoint, OverlayShape } from "./types";

const asset: OverlayAsset = {
  id: "asset_image",
  type: "image",
  props: {
    w: 800,
    h: 400,
    name: "wide.png",
    isAnimated: false,
    mimeType: "image/png",
    src: "data:image/png;base64,AAAA",
    fileSize: 4,
  },
};

type ImageShape = Extract<OverlayShape, { type: "image" }>;

function imageShape(props: Partial<ImageShape["props"]> = {}): ImageShape {
  return {
    id: "shape_image",
    type: "image",
    x: 10,
    y: 20,
    props: {
      assetId: asset.id,
      w: 200,
      h: 200,
      ...props,
    },
  };
}

function applyCropFrame(shape: ImageShape, bounds: OverlayBounds, crop: ImageShape["props"]["crop"]): ImageShape {
  return {
    ...shape,
    x: bounds.x,
    y: bounds.y,
    props: {
      ...shape.props,
      w: bounds.w,
      h: bounds.h,
      crop,
    },
  };
}

function getGhostBounds(shape: ImageShape): OverlayBounds {
  const layout = getCroppedImageLayout(shape, asset);
  return {
    x: shape.x + layout.x,
    y: shape.y + layout.y,
    w: layout.width,
    h: layout.height,
  };
}

function getGhostPageCorners(shape: ImageShape): OverlayPoint[] {
  const bounds = getGhostBounds(shape);
  const center = {
    x: shape.x + shape.props.w / 2,
    y: shape.y + shape.props.h / 2,
  };
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y },
    { x: bounds.x + bounds.w, y: bounds.y + bounds.h },
    { x: bounds.x, y: bounds.y + bounds.h },
  ].map((point) => rotatePointAround(point, center, shape.rotation ?? 0));
}

function rotatePointAround(point: OverlayPoint, center: OverlayPoint, rotation: number): OverlayPoint {
  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  const dx = point.x - center.x;
  const dy = point.y - center.y;
  return {
    x: center.x + dx * cos - dy * sin,
    y: center.y + dx * sin + dy * cos,
  };
}

function expectBoundsClose(actual: OverlayBounds, expected: OverlayBounds): void {
  expect(actual.x).toBeCloseTo(expected.x);
  expect(actual.y).toBeCloseTo(expected.y);
  expect(actual.w).toBeCloseTo(expected.w);
  expect(actual.h).toBeCloseTo(expected.h);
}

describe("overlay image crop", () => {
  it("creates a centered cover crop when an image has no explicit crop", () => {
    expect(getImageCoverCrop(imageShape(), asset)).toEqual({
      topLeft: { x: 0.25, y: 0 },
      bottomRight: { x: 0.75, y: 1 },
    });
  });

  it("pans the visible image crop without changing its size", () => {
    const shape = imageShape();
    const panned = panImageCrop(shape, asset, -40, 0);

    expect(panned.props.crop?.topLeft.x).toBeGreaterThan(0.25);
    expect(
      (panned.props.crop?.bottomRight.x ?? 0) - (panned.props.crop?.topLeft.x ?? 0),
    ).toBeCloseTo(0.5);
  });

  it.each<[ResizeHandle, OverlayPoint]>([
    ["nw", { x: 24, y: 18 }],
    ["n", { x: 0, y: 18 }],
    ["ne", { x: -24, y: 18 }],
    ["e", { x: -24, y: 0 }],
    ["se", { x: -24, y: -18 }],
    ["s", { x: 0, y: -18 }],
    ["sw", { x: 24, y: -18 }],
    ["w", { x: 24, y: 0 }],
  ])("keeps the full-image ghost invariant while dragging the %s crop handle", (handle, localDelta) => {
    const shape = imageShape();
    const beforeGhost = getGhostBounds(shape);
    const resized = resizeImageCropFrame(
      getShapeBounds(shape),
      getImageCoverCrop(shape, asset),
      asset.props,
      handle,
      localDelta,
    );
    const nextShape = applyCropFrame(shape, resized.bounds, resized.crop);

    expectBoundsClose(getGhostBounds(nextShape), beforeGhost);
  });

  it("clamps outward frame drags at the full-image ghost edges", () => {
    const square = imageShape();
    const squareBounds = getShapeBounds(square);
    const squareGhost = getGhostBounds(square);
    const west = resizeImageCropFrame(
      squareBounds,
      getImageCoverCrop(square, asset),
      asset.props,
      "w",
      { x: -10_000, y: 0 },
    );
    const east = resizeImageCropFrame(
      squareBounds,
      getImageCoverCrop(square, asset),
      asset.props,
      "e",
      { x: 10_000, y: 0 },
    );

    expect(west.bounds.x).toBeCloseTo(squareGhost.x);
    expect(east.bounds.x + east.bounds.w).toBeCloseTo(squareGhost.x + squareGhost.w);
    expect(west.crop.topLeft.x).toBe(0);
    expect(east.crop.bottomRight.x).toBe(1);

    const wideFrame = imageShape({ h: 100 });
    const wideBounds = getShapeBounds(wideFrame);
    const wideGhost = getGhostBounds(wideFrame);
    const north = resizeImageCropFrame(
      wideBounds,
      getImageCoverCrop(wideFrame, asset),
      asset.props,
      "n",
      { x: 0, y: -10_000 },
    );
    const south = resizeImageCropFrame(
      wideBounds,
      getImageCoverCrop(wideFrame, asset),
      asset.props,
      "s",
      { x: 0, y: 10_000 },
    );

    expect(north.bounds.y).toBeCloseTo(wideGhost.y);
    expect(south.bounds.y + south.bounds.h).toBeCloseTo(wideGhost.y + wideGhost.h);
    expect(north.crop.topLeft.y).toBe(0);
    expect(south.crop.bottomRight.y).toBe(1);
  });

  it("does not shrink the crop frame below the minimum size", () => {
    const shape = imageShape();
    const resized = resizeImageCropFrame(
      getShapeBounds(shape),
      getImageCoverCrop(shape, asset),
      asset.props,
      "se",
      { x: -10_000, y: -10_000 },
    );

    expect(resized.bounds.w).toBe(MIN_IMAGE_CROP_FRAME_SIZE);
    expect(resized.bounds.h).toBe(MIN_IMAGE_CROP_FRAME_SIZE);
  });

  it("keeps the ghost fixed in page space for a rotated crop frame", () => {
    const shape = { ...imageShape(), rotation: Math.PI / 6 };
    const startBounds = getShapeBounds(shape);
    const beforeCorners = getGhostPageCorners(shape);
    const resizedCropFrame = resizeImageCropFrame(
      startBounds,
      getImageCoverCrop(shape, asset),
      asset.props,
      "se",
      { x: -36, y: -24 },
    );
    const resizedShape = resizeRotatedShapeToBounds(
      shape,
      startBounds,
      resizedCropFrame.bounds,
      "se",
    ) as ImageShape;
    const nextShape = {
      ...resizedShape,
      props: {
        ...resizedShape.props,
        crop: resizedCropFrame.crop,
      },
    };

    getGhostPageCorners(nextShape).forEach((point, index) => {
      expect(point.x).toBeCloseTo(beforeCorners[index].x);
      expect(point.y).toBeCloseTo(beforeCorners[index].y);
    });
  });
});
