import { fitImageSizeWithinArea, type ImageInsertionSize } from "./image-insert";
import type { OverlayAsset, OverlayShape } from "./types";

export type OverlayImageShape = Extract<OverlayShape, { type: "image" }>;

export function resetOverlayImageCrop(shape: OverlayImageShape): OverlayImageShape {
  if (!shape.props.crop) {
    return shape;
  }

  const props = { ...shape.props };
  delete props.crop;
  return { ...shape, props };
}

export function resizeOverlayImageToNaturalSize(
  shape: OverlayImageShape,
  asset: OverlayAsset | undefined,
  areaSize: ImageInsertionSize,
): OverlayImageShape {
  if (!asset) {
    return shape;
  }

  const size = fitImageSizeWithinArea({ w: asset.props.w, h: asset.props.h }, areaSize);
  if (shape.props.w === size.w && shape.props.h === size.h) {
    return shape;
  }

  return {
    ...shape,
    props: {
      ...shape.props,
      ...size,
    },
  };
}

export function replaceOverlayImageAsset(
  shapes: readonly OverlayShape[],
  assets: Readonly<Record<string, OverlayAsset>>,
  shapeId: string,
  nextAsset: OverlayAsset,
): { shapes: OverlayShape[]; assets: Record<string, OverlayAsset> } {
  const target = shapes.find((shape): shape is OverlayImageShape => shape.id === shapeId && shape.type === "image");
  if (!target) {
    return { shapes: [...shapes], assets: { ...assets } };
  }

  const previousAssetId = target.props.assetId;
  const replacement = resetOverlayImageCrop({
    ...target,
    props: {
      ...target.props,
      assetId: nextAsset.id,
    },
  });
  const nextShapes = shapes.map((shape) => shape.id === shapeId ? replacement : shape);
  const nextAssets = { ...assets, [nextAsset.id]: nextAsset };
  const previousAssetStillReferenced = nextShapes.some((shape) => (
    shape.type === "image" && shape.props.assetId === previousAssetId
  ));
  if (previousAssetId !== nextAsset.id && !previousAssetStillReferenced) {
    delete nextAssets[previousAssetId];
  }

  return { shapes: nextShapes, assets: nextAssets };
}
