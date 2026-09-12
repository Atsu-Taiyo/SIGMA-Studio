import { describe, expect, it } from "vitest";
import type { OverlayAsset, OverlaySnapshot } from "./overlay-model";
import { pruneUnusedOverlayAssets } from "./overlay-assets";

const asset = (id: string): OverlayAsset => ({
  id, type: "image", props: { w: 1, h: 1, name: id, isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 1 },
});

describe("pruneUnusedOverlayAssets", () => {
  it("removes deleted figures' images without modifying the undo snapshot", () => {
    const snapshot: OverlaySnapshot = { version: 1, shapes: [], assets: { old3d: asset("old3d"), oldImage: asset("oldImage") } };
    expect(pruneUnusedOverlayAssets(snapshot).assets).toEqual({});
    expect(Object.keys(snapshot.assets)).toEqual(["old3d", "oldImage"]);
  });

  it("retains shared images and extension references, including hidden shapes", () => {
    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: [{ id: "image", type: "image", x: 0, y: 0, hidden: true, props: { w: 1, h: 1, assetId: "shared" } }],
      assets: { shared: asset("shared"), extension: asset("extension"), unused: asset("unused") },
      extensions: { "test.references": { assetId: "extension" } },
    };
    const cleaned = pruneUnusedOverlayAssets(snapshot);
    expect(Object.keys(cleaned.assets)).toEqual(["shared", "extension"]);
    expect(cleaned.shapes).toBe(snapshot.shapes);
    expect(pruneUnusedOverlayAssets(cleaned)).toBe(cleaned);
  });
});
