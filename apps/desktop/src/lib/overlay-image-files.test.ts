import { describe, expect, it } from "vitest";

import {
  getSupportedOverlayImageFilesFromDataTransfer,
  getSupportedOverlayImageFiles,
  hasSupportedOverlayImageData,
  isSupportedOverlayImageFile,
} from "@/lib/overlay-image-files";

describe("overlay image file helpers", () => {
  it("accepts only supported image MIME types", () => {
    expect(isSupportedOverlayImageFile(new File(["png"], "image.png", { type: "image/png" }))).toBe(true);
    expect(isSupportedOverlayImageFile(new File(["jpg"], "image.jpg", { type: "image/jpeg" }))).toBe(true);
    expect(isSupportedOverlayImageFile(new File(["webp"], "image.webp", { type: "image/webp" }))).toBe(true);
    expect(isSupportedOverlayImageFile(new File(["svg"], "image.svg", { type: "image/svg+xml" }))).toBe(true);
    expect(isSupportedOverlayImageFile(new File(["gif"], "image.gif", { type: "image/gif" }))).toBe(false);
    expect(isSupportedOverlayImageFile(new File(["txt"], "note.txt", { type: "text/plain" }))).toBe(false);
  });

  it("filters array-like file lists without keeping unsupported files", () => {
    const files = [
      new File(["png"], "image.png", { type: "image/png" }),
      new File(["gif"], "image.gif", { type: "image/gif" }),
      new File(["svg"], "image.svg", { type: "image/svg+xml" }),
    ];

    expect(getSupportedOverlayImageFiles(files).map((file) => file.name)).toEqual(["image.png", "image.svg"]);
  });

  it("ignores URL and HTML clipboard entries for v1", () => {
    const transfer = createDataTransfer([
      createStringTransferItem("https://example.com/image.png", "text/uri-list"),
      createStringTransferItem('<img src="https://example.com/image.png">', "text/html"),
    ]);

    expect(hasSupportedOverlayImageData(transfer)).toBe(false);
    expect(getSupportedOverlayImageFilesFromDataTransfer(transfer)).toEqual([]);
  });

  it("detects supported file entries in data transfer items", () => {
    const file = new File(["png"], "image.png", { type: "image/png" });
    const transfer = createDataTransfer([createFileTransferItem(file)]);

    expect(hasSupportedOverlayImageData(transfer)).toBe(true);
    expect(getSupportedOverlayImageFilesFromDataTransfer(transfer)).toEqual([file]);
  });
});

function createDataTransfer(items: DataTransferItem[]): DataTransfer {
  const itemList = Object.assign([...items], {
    item: (index: number) => items[index] ?? null,
    add: () => null,
    clear: () => undefined,
    remove: () => undefined,
  }) as unknown as DataTransferItemList;
  const files = Object.assign([], {
    item: () => null,
  }) as unknown as FileList;

  return {
    items: itemList,
    files,
  } as DataTransfer;
}

function createFileTransferItem(file: File): DataTransferItem {
  return {
    kind: "file",
    type: file.type,
    getAsFile: () => file,
    getAsString: () => undefined,
    webkitGetAsEntry: () => null,
  } as DataTransferItem;
}

function createStringTransferItem(value: string, type: string): DataTransferItem {
  return {
    kind: "string",
    type,
    getAsFile: () => null,
    getAsString: (callback: FunctionStringCallback | null) => callback?.(value),
    webkitGetAsEntry: () => null,
  } as DataTransferItem;
}
