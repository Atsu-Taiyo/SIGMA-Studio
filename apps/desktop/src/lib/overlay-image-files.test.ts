// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createEditorClipboardHtml, createOverlayClipboardPayload } from "@/lib/editor-clipboard";
import { getSvgImageDimensions } from "@/lib/svg-image-source";

import {
  getSupportedOverlayImageFilesFromDataTransfer,
  getSupportedOverlayImageFiles,
  hasSupportedOverlayImageData,
  isSupportedOverlayImageFile,
} from "@/lib/overlay-image-files";

describe("overlay image file helpers", () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect width="100" height="60" fill="#dddddd"/><text x="150" y="60">装置図</text></svg>';
  const htmlTransfer = (html: string, files: File[] = []) => {
    const data = new DataTransfer();
    data.setData("text/html", html);
    data.setData("text/plain", "装置図");
    files.forEach(file => data.items.add(file));
    return data;
  };

  it("keeps standalone inline SVG as a vector image, without inserting its DOM", async () => {
    const before = document.body.innerHTML;
    const files = getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(`<html><body><!--StartFragment--><div>${svg}</div><!--EndFragment--></body></html>`));
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/svg+xml");
    const source = await files[0].text();
    expect(source).toContain("装置図");
    expect(source).toContain('fill="#dddddd"');
    expect(getSvgImageDimensions(`data:image/svg+xml,${encodeURIComponent(source)}`)).toEqual({ width: 300, height: 200 });
    expect(document.body.innerHTML).toBe(before);
  });

  it.each(["base64", "percent"])("keeps an embedded %s SVG instead of the clipboard bitmap preview", async encoding => {
    const src = encoding === "base64" ? `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` : `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    const preview = new File(["png"], "preview.png", { type: "image/png" });
    const files = getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(`<p><img src="${src}"></p>`, [preview]));
    expect(files).toHaveLength(1);
    expect(files[0].type).toBe("image/svg+xml");
    expect(await files[0].text()).toBe(svg);
  });

  it("also prefers inline SVG over one preview, while preserving explicit SVG and multiple files", () => {
    const preview = new File(["png"], "preview.png", { type: "image/png" });
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(svg, [preview]))[0].type).toBe("image/svg+xml");
    const file = new File([svg], "original.svg", { type: "image/svg+xml" });
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(svg, [file]))).toEqual([file]);
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(svg, [preview, file]))).toEqual([preview, file]);
  });

  it("leaves articles, captions, multiple diagrams and plain SVG code to their existing paste owners", () => {
    for (const html of [`<p>解説</p>${svg}`, `${svg}<p>キャプション</p>`, `${svg}${svg}`, `${svg}<hr>`]) {
      expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(html))).toEqual([]);
    }
    const code = new DataTransfer();
    code.setData("text/plain", svg);
    expect(getSupportedOverlayImageFilesFromDataTransfer(code)).toEqual([]);
  });

  it.each([
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200" onload="evil()"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><script>evil()</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><foreignObject>HTML</foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><rect style="fill:url(https://example.com/a)"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 -1 200"/>',
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><text>' + "x".repeat(256 * 1024) + "</text></svg>",
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><!--' + "x".repeat(256 * 1024) + "--></svg>",
  ])("rejects unsupported, invalid or oversized SVG without replacing a usable bitmap", source => {
    const html = `<img src="data:image/svg+xml,${encodeURIComponent(source)}">`;
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(html))).toEqual([]);
    const preview = new File(["png"], "preview.png", { type: "image/png" });
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(html, [preview]))).toEqual([preview]);
  });

  it("does not override Sigma's structured clipboard with a vector preview", () => {
    const payload = createOverlayClipboardPayload([], {});
    const html = createEditorClipboardHtml(payload, svg);
    expect(getSupportedOverlayImageFilesFromDataTransfer(htmlTransfer(html))).toEqual([]);
  });
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

  it("ignores external image URLs", () => {
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
