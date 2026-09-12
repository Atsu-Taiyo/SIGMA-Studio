import path from "node:path";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

export interface AttachedPdfPages {
  pageCount: number;
  pages: Array<{ pageNumber: number; text: string; previewFile: string }>;
  nextPageStart: number | null;
}

/** Derived AI input only: the original PDF stays in the run's attachments. */
export async function renderAttachedPdfPages(
  bytes: Uint8Array,
  options: {
    pageStart: number;
    writePage: (pageNumber: number, png: Buffer) => Promise<string>;
    onPageImage?: (pageNumber: number, png: Buffer) => void;
  },
): Promise<AttachedPdfPages> {
  if (!Number.isSafeInteger(options.pageStart) || options.pageStart < 1) {
    throw new Error(te("electron.pdfAttachment.invalidPageStart"));
  }
  // Keep the ESM library external to the Electron/MCP CommonJS bundles.
  const { createCanvas } = await import("@napi-rs/canvas");
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const packageRoot = path.dirname(require.resolve("pdfjs-dist/package.json"));
  const loading = getDocument({
    data: Uint8Array.from(bytes),
    cMapUrl: path.join(packageRoot, "cmaps") + path.sep,
    cMapPacked: true,
    standardFontDataUrl: path.join(packageRoot, "standard_fonts") + path.sep,
    wasmUrl: path.join(packageRoot, "wasm") + path.sep,
    isEvalSupported: false,
    verbosity: 0,
  });
  try {
    const pdf = await loading.promise;
    if (options.pageStart > pdf.numPages) {
      throw new Error(te("electron.pdfAttachment.pageOutOfRange", { count: pdf.numPages }));
    }
    const end = Math.min(pdf.numPages, options.pageStart + 3);
    const pages: AttachedPdfPages["pages"] = [];
    for (let pageNumber = options.pageStart; pageNumber <= end; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const originalViewport = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 2000 / Math.max(originalViewport.width, originalViewport.height));
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      try {
        await page.render({
          canvas: null,
          canvasContext: canvas.getContext("2d") as unknown as CanvasRenderingContext2D,
          viewport,
        }).promise;
        const content = await page.getTextContent();
        const text = content.items.map((item) => "str" in item ? item.str + (item.hasEOL ? "\n" : " ") : "").join("");
        const png = canvas.toBuffer("image/png");
        const previewFile = await options.writePage(pageNumber, png);
        pages.push({ pageNumber, text, previewFile });
        options.onPageImage?.(pageNumber, png);
      } finally {
        page.cleanup();
        canvas.width = 0;
        canvas.height = 0;
      }
    }
    return { pageCount: pdf.numPages, pages, nextPageStart: end < pdf.numPages ? end + 1 : null };
  } finally {
    await loading.destroy();
  }
}
