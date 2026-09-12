import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const identifiers = vi.hoisted(() => ({ asset: vi.fn(), shape: vi.fn() }));
vi.mock("./ids", () => ({ createOverlayAssetId: identifiers.asset, createOverlayShapeId: identifiers.shape }));

import { createOverlayImageAsset, createOverlayImageEntry } from "./image-file";

class FileReaderStub {
  static instances: FileReaderStub[] = [];
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  file: File | null = null;
  constructor() { FileReaderStub.instances.push(this); }
  readAsDataURL(file: File) { this.file = file; }
}

class ImageStub {
  static instances: ImageStub[] = [];
  naturalWidth = 0;
  naturalHeight = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  src = "";
  constructor() { ImageStub.instances.push(this); }
}

beforeEach(() => {
  FileReaderStub.instances = [];
  ImageStub.instances = [];
  identifiers.asset.mockReset().mockReturnValue("asset-id");
  identifiers.shape.mockReset().mockReturnValue("shape-id");
  vi.stubGlobal("FileReader", FileReaderStub);
  vi.stubGlobal("Image", ImageStub);
});

afterEach(() => { vi.unstubAllGlobals(); });

async function completeRead(dataUrl = "data:image/png;base64,AA==") {
  const reader = FileReaderStub.instances.at(-1)!;
  reader.result = dataUrl;
  reader.onload!();
  await Promise.resolve();
}

describe("overlay image browser decoding", () => {
  it("waits for file bytes and image dimensions before allocating asset and shape IDs", async () => {
    const file = new File(["bytes"], "picture.png", { type: "image/png" });
    const decoding = createOverlayImageEntry(file, { w: 800, h: 600 });
    expect(FileReaderStub.instances[0].file).toBe(file);
    expect(ImageStub.instances).toHaveLength(0);
    expect(identifiers.asset).not.toHaveBeenCalled();
    await completeRead();
    const image = ImageStub.instances[0];
    expect(image.src).toBe("data:image/png;base64,AA==");
    expect(identifiers.asset).not.toHaveBeenCalled();
    image.naturalWidth = 1600;
    image.naturalHeight = 900;
    image.onload!();
    const entry = await decoding;
    expect(entry).toEqual({
      asset: {
        id: "asset-id", type: "image",
        props: { w: 1600, h: 900, name: "picture.png", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,AA==", fileSize: 5 },
      },
      shape: { id: "shape-id", type: "image", x: 0, y: 0, rotation: 0, props: { assetId: "asset-id", w: 800, h: 450 } },
    });
    expect(identifiers.asset.mock.invocationCallOrder[0]).toBeLessThan(identifiers.shape.mock.invocationCallOrder[0]);
  });

  it("keeps the SVG fallback dimensions without invoking the raster decoder", async () => {
    const file = new File(["<svg/>"], "picture.svg", { type: "image/svg+xml" });
    const decoding = createOverlayImageEntry(file, { w: 120, h: 100 });
    await completeRead("data:image/svg+xml;base64,PHN2Zy8+");
    const entry = await decoding;
    expect(ImageStub.instances).toHaveLength(0);
    expect(entry.asset.props).toMatchObject({ w: 240, h: 158, mimeType: "image/svg+xml" });
    expect(entry.shape.props).toMatchObject({ w: 120, h: 79 });
  });

  it("keeps the original fallback asset when raster decoding fails", async () => {
    const decoding = createOverlayImageAsset(new File(["bytes"], "unknown"));
    await completeRead();
    ImageStub.instances[0].onerror!();
    expect((await decoding).props).toMatchObject({ w: 240, h: 158, mimeType: null, name: "unknown", fileSize: 5 });
    expect(identifiers.shape).not.toHaveBeenCalled();
  });

  it("falls back for a missing height without discarding a decoded width", async () => {
    const decoding = createOverlayImageAsset(new File(["bytes"], "picture.png"));
    await completeRead();
    ImageStub.instances[0].naturalWidth = 100;
    ImageStub.instances[0].onload!();
    expect((await decoding).props).toMatchObject({ w: 100, h: 80 });
  });

  it("propagates a file read failure without creating an image or allocating IDs", async () => {
    const error = new Error("read failure");
    const decoding = createOverlayImageEntry(new File(["bytes"], "picture.png"), { w: 800, h: 600 });
    const reader = FileReaderStub.instances[0];
    reader.error = error;
    reader.onerror!();
    await expect(decoding).rejects.toBe(error);
    expect(ImageStub.instances).toHaveLength(0);
    expect(identifiers.asset).not.toHaveBeenCalled();
    expect(identifiers.shape).not.toHaveBeenCalled();
  });
});
