import { encode, encodeImage } from "utif";
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
  it("rejects invalid TIFF bytes before allocating an asset or a fallback image", async () => {
    await expect(createOverlayImageAsset(new File(["not a TIFF"], "broken.tif"))).rejects.toThrow("Invalid TIFF header");
    expect(identifiers.asset).not.toHaveBeenCalled();
    expect(FileReaderStub.instances).toHaveLength(0);
    expect(ImageStub.instances).toHaveLength(0);
  });

  it("rejects an oversized TIFF from its header before allocating pixels", async () => {
    const buffer = encode([{ t256: [100_000], t257: [100_000] } as unknown as Parameters<typeof encode>[0][number]]);
    await expect(createOverlayImageAsset(new File([buffer], "huge.tiff", { type: "image/tiff" }))).rejects.toThrow("Invalid or oversized TIFF image");
    expect(identifiers.asset).not.toHaveBeenCalled();
  });

  it("decodes TIFF pixels into a PNG asset while preserving the source name", async () => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const canvas = { width: 0, height: 0, getContext: vi.fn(), toBlob: vi.fn() };
    const imageData = { data: new Uint8ClampedArray(8) };
    const context = { createImageData: vi.fn(() => imageData), putImageData: vi.fn() };
    canvas.getContext.mockReturnValue(context);
    canvas.toBlob.mockImplementation((callback: (blob: Blob) => void) => callback(new Blob(["PNG pixels"], { type: "image/png" })));
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const pending = createOverlayImageAsset(new File([encodeImage(pixels, 2, 1)], "scan.tif", { type: "image/tiff" }));
    await vi.waitFor(() => expect(FileReaderStub.instances).toHaveLength(1));
    expect(imageData.data).toEqual(new Uint8ClampedArray(pixels));
    expect(context.putImageData).toHaveBeenCalledWith(imageData, 0, 0);
    expect(canvas).toMatchObject({ width: 2, height: 1 });
    expect(FileReaderStub.instances[0].file).toMatchObject({ type: "image/png", size: 10 });
    await completeRead();
    ImageStub.instances[0].naturalWidth = 2;
    ImageStub.instances[0].naturalHeight = 1;
    ImageStub.instances[0].onload!();
    expect((await pending).props).toMatchObject({ name: "scan.tif", mimeType: "image/png", fileSize: 10, w: 2, h: 1 });
  });

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

  it("fits a pasted SVG by its viewBox aspect ratio", async () => {
    const source = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="10 20 400 200"><rect width="100" height="50"/></svg>';
    const decoding = createOverlayImageEntry(new File([source], "picture.svg", { type: "image/svg+xml" }), { w: 200, h: 200 });
    await completeRead(`data:image/svg+xml,${encodeURIComponent(source)}`);
    const entry = await decoding;
    expect(ImageStub.instances).toHaveLength(0);
    expect(entry.asset.props).toMatchObject({ w: 400, h: 200 });
    expect(entry.shape.props).toMatchObject({ w: 200, h: 100 });
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
