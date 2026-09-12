import { describe, expect, it } from "vitest";

import {
  replaceOverlayImageAsset,
  resizeOverlayImageToNaturalSize,
} from "./image-actions";
import type { OverlayAsset, OverlayShape } from "./types";

const oldAsset: OverlayAsset = {
  id: "asset_old",
  type: "image",
  props: {
    w: 400,
    h: 200,
    name: "old.png",
    isAnimated: false,
    mimeType: "image/png",
    src: "data:image/png;base64,old",
    fileSize: 10,
  },
};

const newAsset: OverlayAsset = {
  ...oldAsset,
  id: "asset_new",
  props: {
    ...oldAsset.props,
    w: 1200,
    h: 800,
    name: "new.png",
    src: "data:image/png;base64,new",
  },
};

function createImage(id: string, assetId = oldAsset.id): Extract<OverlayShape, { type: "image" }> {
  return {
    id,
    type: "image",
    x: 12,
    y: 24,
    props: {
      assetId,
      w: 300,
      h: 180,
      crop: {
        topLeft: { x: 0.1, y: 0.2 },
        bottomRight: { x: 0.9, y: 0.8 },
      },
    },
  };
}

describe("overlay image actions", () => {
  it("replaces the asset in place, clears crop, and removes an unreferenced old asset", () => {
    const shape = createImage("image_1");
    const result = replaceOverlayImageAsset([shape], { [oldAsset.id]: oldAsset }, shape.id, newAsset);
    const replacement = result.shapes[0] as Extract<OverlayShape, { type: "image" }>;

    expect(replacement).toMatchObject({
      id: shape.id,
      x: shape.x,
      y: shape.y,
      props: {
        assetId: newAsset.id,
        w: shape.props.w,
        h: shape.props.h,
      },
    });
    expect(replacement.props).not.toHaveProperty("crop");
    expect(result.assets).toEqual({ [newAsset.id]: newAsset });
  });

  it("keeps the old asset when another image still references it", () => {
    const target = createImage("image_1");
    const shared = createImage("image_2");
    const result = replaceOverlayImageAsset([target, shared], { [oldAsset.id]: oldAsset }, target.id, newAsset);

    expect(result.assets).toEqual({
      [oldAsset.id]: oldAsset,
      [newAsset.id]: newAsset,
    });
  });

  it("restores natural size with the insertion page-fit rule", () => {
    const resized = resizeOverlayImageToNaturalSize(createImage("image_1"), newAsset, { w: 600, h: 600 });

    expect(resized.props.w).toBe(600);
    expect(resized.props.h).toBe(400);
  });
});
