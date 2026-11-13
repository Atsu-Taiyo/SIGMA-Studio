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

  it("rejects a minimal cyclic TIFF without hanging or allocating an asset", async () => {
    const buffer = new ArrayBuffer(14);
    const view = new DataView(buffer);
    view.setUint16(0, 0x4949); view.setUint16(2, 42, true);
    view.setUint32(4, 8, true); view.setUint32(10, 8, true);
    await expect(createOverlayImageAsset(new File([buffer], "cycle.tif"))).rejects.toThrow("Invalid or oversized TIFF image");
    expect(identifiers.asset).not.toHaveBeenCalled();
  });

  it.each([[0, 1], [1, 0], [100_000, 100_000]])("rejects invalid tile dimensions %s x %s before UTIF decompression", async (tileWidth, tileHeight) => {
    const buffer = encodeImage(new Uint8Array(8), 2, 1);
    const view = new DataView(buffer);
    const offset = view.getUint32(4);
    const count = view.getUint16(offset);
    for (let i = 0; i < count; i++) {
      const entry = offset + 2 + i * 12;
      const tag = view.getUint16(entry);
      if (tag === 278 || tag === 282) {
        view.setUint16(entry, tag === 278 ? 322 : 323);
        view.setUint16(entry + 2, 4); view.setUint32(entry + 4, 1);
        view.setUint32(entry + 8, tag === 278 ? tileWidth : tileHeight);
      }
    }
    await expect(createOverlayImageAsset(new File([buffer], "invalid-tile.tif"))).rejects.toThrow("Invalid or oversized TIFF tile");
    expect(identifiers.asset).not.toHaveBeenCalled();
  });

  it.each([false, true])("rejects truncated or unbounded directory values before decoding (little endian: %s)", async little => {
    const buffer = new ArrayBuffer(26);
    const view = new DataView(buffer);
    view.setUint16(0, little ? 0x4949 : 0x4d4d);
    view.setUint16(2, 42, little); view.setUint32(4, 8, little);
    view.setUint16(8, 1, little); view.setUint16(10, 256, little);
    view.setUint16(12, 4, little); view.setUint32(14, 0xffffffff, little);
    await expect(createOverlayImageAsset(new File([buffer], "bad.tif"))).rejects.toThrow("Invalid TIFF directory value");
    expect(identifiers.asset).not.toHaveBeenCalled();
  });

  it("bounds the total directory values even when each individual entry fits", async () => {
    const encoded = encodeImage(new Uint8Array(8), 2, 1);
    const values = 600_000;
    const buffer = new ArrayBuffer(encoded.byteLength + 2 * values * 4);
    new Uint8Array(buffer).set(new Uint8Array(encoded));
    const view = new DataView(buffer);
    const offset = view.getUint32(4);
    const entries = view.getUint16(offset);
    let added = 0;
    for (let index = 0; index < entries; index++) {
      const entry = offset + 2 + index * 12;
      if (![282, 283].includes(view.getUint16(entry))) continue;
      view.setUint16(entry, 40000 + added);
      view.setUint16(entry + 2, 4);
      view.setUint32(entry + 4, values);
      view.setUint32(entry + 8, encoded.byteLength + added++ * values * 4);
    }
    expect(added).toBe(2);
    const createElement = vi.fn(() => { throw new Error("must reject before canvas allocation"); });
    vi.stubGlobal("document", { createElement });
    await expect(createOverlayImageAsset(new File([buffer], "large-metadata.tif")))
      .rejects.toThrow("TIFF directory exceeds metadata limit");
    expect(createElement).not.toHaveBeenCalled();
    expect(identifiers.asset).not.toHaveBeenCalled();
    expect(FileReaderStub.instances).toHaveLength(0);
  });

  it.each(["plain", "cyclic page", "cyclic metadata"])("decodes first TIFF page safely into PNG: %s", async variant => {
    const pixels = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 255]);
    const canvas = { width: 0, height: 0, getContext: vi.fn(), toBlob: vi.fn() };
    const imageData = { data: new Uint8ClampedArray(8) };
    const context = { createImageData: vi.fn(() => imageData), putImageData: vi.fn() };
    canvas.getContext.mockReturnValue(context);
    canvas.toBlob.mockImplementation((callback: (blob: Blob) => void) => callback(new Blob(["PNG pixels"], { type: "image/png" })));
    vi.stubGlobal("document", { createElement: vi.fn(() => canvas) });
    const encoded = encodeImage(pixels, 2, 1);
    const view = new DataView(encoded);
    const offset = view.getUint32(4);
    const entries = view.getUint16(offset);
    if (variant === "cyclic page") view.setUint32(offset + 2 + entries * 12, offset);
    if (variant === "cyclic metadata") {
      // Replace an optional resolution tag with a SubIFD that refers to itself.
      const entry = Array.from({ length: entries }, (_, i) => offset + 2 + i * 12)
        .find(entry => view.getUint16(entry) === 282)!;
      view.setUint16(entry, 330); view.setUint16(entry + 2, 4);
      view.setUint32(entry + 4, 1); view.setUint32(entry + 8, offset);
    }
    const pending = createOverlayImageAsset(new File([encoded], "scan.tif", { type: "image/tiff" }));
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
