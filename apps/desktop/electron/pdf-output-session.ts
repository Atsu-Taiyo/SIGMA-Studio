import { BrowserWindow, type WebContents } from "electron";
import { PDFDocument } from "pdf-lib";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

import { FREEZE_ANIMATED_IMAGES_SOURCE } from "./pdf-animated-image-freeze";

export interface PdfOutputSessionExpectation {
  surfaceId: string;
  revision: number;
  pageCount: number;
  pageWidthMm: number;
  pageHeightMm: number;
}

interface PreparedPdfPageState extends PdfOutputSessionExpectation {
  pageIndex: number;
}

interface CapturedPdfPage extends PreparedPdfPageState {
  documentHtml: string;
}

const MM_PER_INCH = 25.4;
const POINTS_PER_INCH = 72;
const CSS_PX_PER_MM = 96 / MM_PER_INCH;
const PAGE_SIZE_TOLERANCE_POINTS = 0.75;
const PDF_EXPORT_ROOT_ID = "sigma-pdf-export-root";
const PDF_EXPORT_STYLE_ID = "sigma-pdf-export-style";

/**
 * Exports the already-settled preview surface in the invoking renderer.
 *
 * The visible window is read-only: each page is serialized there, then printed from a
 * hidden BrowserWindow so `printToPDF`'s `@media print` never flashes the editor UI.
 * One-page vector PDFs are merged with pdf-lib. SigmaDoc remains the source of truth.
 */
export async function renderPdfOutputSession(
  webContents: WebContents,
  expectation: PdfOutputSessionExpectation,
): Promise<Buffer> {
  const pagePdfs: Buffer[] = [];
  let hiddenWindow: BrowserWindow | null = null;

  try {
    hiddenWindow = createHiddenPdfWindow(webContents, expectation);
    await loadHiddenPdfDocument(hiddenWindow, webContents);

    for (let pageIndex = 0; pageIndex < expectation.pageCount; pageIndex += 1) {
      const captured = await capturePdfPage(webContents, expectation, pageIndex);
      assertPreparedPageState(captured, expectation, pageIndex);

      await writeHiddenPdfPage(hiddenWindow, captured.documentHtml);
      const pdf = await hiddenWindow.webContents.printToPDF({
        displayHeaderFooter: false,
        margins: { marginType: "none" },
        pageSize: {
          width: expectation.pageWidthMm / MM_PER_INCH,
          height: expectation.pageHeightMm / MM_PER_INCH,
        },
        preferCSSPageSize: true,
        printBackground: true,
      });
      await assertPdfPages(pdf, expectation, 1);
      pagePdfs.push(pdf);
    }

    // A late canvas mutation invalidates the revision. Check once more after printing
    // the final page so a mixed-revision document is never written successfully.
    const finalState = await readPdfOutputSessionState(webContents, expectation.surfaceId);
    assertPreparedPageState(
      { ...finalState, pageIndex: expectation.pageCount - 1 },
      expectation,
      expectation.pageCount - 1,
    );

    const merged = await mergePdfPages(pagePdfs);
    await assertPdfPages(merged, expectation, expectation.pageCount);
    return merged;
  } finally {
    closeHiddenPdfWindow(hiddenWindow);
  }
}

function createHiddenPdfWindow(
  source: WebContents,
  expectation: PdfOutputSessionExpectation,
): BrowserWindow {
  const width = Math.max(1, Math.round(expectation.pageWidthMm * CSS_PX_PER_MM));
  const height = Math.max(1, Math.round(expectation.pageHeightMm * CSS_PX_PER_MM));
  return new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    paintWhenInitiallyHidden: true,
    backgroundColor: "#ffffff",
    webPreferences: {
      ...(source.session ? { session: source.session } : {}),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false,
    },
  });
}

async function loadHiddenPdfDocument(window: BrowserWindow, source: WebContents): Promise<void> {
  const sourceUrl = typeof source.getURL === "function" ? source.getURL() : "";
  await window.loadURL(resolveHiddenPdfDocumentUrl(sourceUrl));
}

export function resolveHiddenPdfDocumentUrl(sourceUrl: string): string {
  try {
    const url = new URL(sourceUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/[^/]+$/, "print.html");
    return url.toString();
  } catch {
    return "about:blank";
  }
}

async function capturePdfPage(
  webContents: WebContents,
  expectation: PdfOutputSessionExpectation,
  pageIndex: number,
): Promise<CapturedPdfPage> {
  return webContents.executeJavaScript(buildCapturePageScript(expectation, pageIndex), true) as Promise<CapturedPdfPage>;
}

async function writeHiddenPdfPage(window: BrowserWindow, documentHtml: string): Promise<void> {
  if (window.isDestroyed() || window.webContents.isDestroyed()) {
    throw new Error(te("electron.pdf.previewChanged"));
  }
  await window.webContents.executeJavaScript(
    `(() => {
      const html = ${JSON.stringify(documentHtml)};
      document.open();
      document.write(html);
      document.close();
      const images = Array.from(document.images ?? []);
      const imagesReady = Promise.all(images.map((image) => {
        if (image.complete) {
          return Promise.resolve();
        }
        return new Promise((resolve) => {
          image.addEventListener("load", resolve, { once: true });
          image.addEventListener("error", resolve, { once: true });
        });
      }));
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      return imagesReady
        .then(() => fontsReady)
        .then(() => new Promise((resolve) => {
          requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
        }));
    })()`,
    true,
  );
}

async function readPdfOutputSessionState(
  webContents: WebContents,
  surfaceId: string,
): Promise<PdfOutputSessionExpectation> {
  return webContents.executeJavaScript(buildReadSessionScript(surfaceId), true) as Promise<PdfOutputSessionExpectation>;
}

function closeHiddenPdfWindow(window: BrowserWindow | null): void {
  if (!window || window.isDestroyed()) {
    return;
  }
  window.close();
}

function buildReadSessionScript(surfaceId: string): string {
  const sessionNotFound = te("electron.pdf.sessionNotFound");
  const layoutNotReady = te("electron.pdf.layoutNotReady");
  return `
    (() => {
      const surfaceId = ${JSON.stringify(surfaceId)};
      const surface = Array.from(document.querySelectorAll(".paged-surface"))
        .find((element) => element.getAttribute("data-paged-surface-id") === surfaceId);
      if (!surface) {
        throw new Error(${JSON.stringify(sessionNotFound)});
      }
      if (surface.getAttribute("data-paged-surface-state") !== "ready") {
        throw new Error(${JSON.stringify(layoutNotReady)});
      }
      const readNumber = (name) => Number(surface.getAttribute(name) ?? "0");
      return {
        surfaceId,
        revision: readNumber("data-paged-surface-revision"),
        pageCount: readNumber("data-paged-surface-page-count"),
        pageWidthMm: readNumber("data-paged-surface-page-width-mm"),
        pageHeightMm: readNumber("data-paged-surface-page-height-mm"),
      };
    })()
  `;
}

function buildCapturePageScript(
  expectation: PdfOutputSessionExpectation,
  pageIndex: number,
): string {
  const sessionNotFound = te("electron.pdf.sessionNotFound");
  const layoutNotReady = te("electron.pdf.layoutNotReady");
  const pageStructureMismatch = te("electron.pdf.pageStructureMismatch");
  const pageCss = buildHiddenPageCss(expectation);

  return `
    (() => {
      const pdfCaptureMode = "detached-snapshot";
      const expected = ${JSON.stringify(expectation)};
      const pageIndex = ${JSON.stringify(pageIndex)};
      const exportRootId = ${JSON.stringify(PDF_EXPORT_ROOT_ID)};
      const exportStyleId = ${JSON.stringify(PDF_EXPORT_STYLE_ID)};
      const pageCss = ${JSON.stringify(pageCss)};
      const surface = Array.from(document.querySelectorAll(".paged-surface"))
        .find((element) => element.getAttribute("data-paged-surface-id") === expected.surfaceId);
      if (!surface) {
        throw new Error(${JSON.stringify(sessionNotFound)});
      }
      if (surface.getAttribute("data-paged-surface-state") !== "ready") {
        throw new Error(${JSON.stringify(layoutNotReady)});
      }
      const readNumber = (name) => Number(surface.getAttribute(name) ?? "0");
      const state = {
        surfaceId: expected.surfaceId,
        revision: readNumber("data-paged-surface-revision"),
        pageCount: readNumber("data-paged-surface-page-count"),
        pageWidthMm: readNumber("data-paged-surface-page-width-mm"),
        pageHeightMm: readNumber("data-paged-surface-page-height-mm"),
        pageIndex,
      };
      const pages = Array.from(surface.querySelectorAll(
        ".paged-surface-pages > .paged-surface-page-slot > .paged-surface-page",
      ));
      if (pages.length !== state.pageCount || !pages[pageIndex]) {
        throw new Error(${JSON.stringify(pageStructureMismatch)});
      }

      const clone = pages[pageIndex].cloneNode(true);
      inlineCanvasBitmaps(pages[pageIndex], clone);

      const htmlLang = document.documentElement.getAttribute("lang") ?? "";
      const htmlClass = document.documentElement.getAttribute("class") ?? "";
      const htmlStyle = document.documentElement.getAttribute("style") ?? "";
      const fontsReady = document.fonts?.ready ?? Promise.resolve();
      return Promise.resolve(fontsReady)
        // A moving 3D material would otherwise print whichever frame its loop had reached, giving
        // a different picture on every export. Pin every animated image to its first frame.
        .then(() => inlineBlobUrls(clone))
        .then(() => (${FREEZE_ANIMATED_IMAGES_SOURCE})(clone))
        .then(() => {
          void pdfCaptureMode;
          return {
            ...state,
            documentHtml: [
              "<!DOCTYPE html>",
              "<html",
              htmlLang ? " lang=\\"" + escapeHtml(htmlLang) + "\\"" : "",
              htmlClass ? " class=\\"" + escapeHtml(htmlClass) + "\\"" : "",
              htmlStyle ? " style=\\"" + escapeHtml(htmlStyle) + "\\"" : "",
              " data-sigma-pdf-export-page=\\"true\\">",
              "<head>",
              "<style id=\\"" + exportStyleId + "\\">",
              collectAbsoluteCss(),
              pageCss,
              "</style>",
              "</head>",
              "<body style=\\"margin:0\\">",
              "<div id=\\"" + exportRootId + "\\">",
              clone.outerHTML,
              "</div>",
              "</body></html>",
            ].join(""),
          };
        });

      function collectAbsoluteCss() {
        const parts = [];
        for (const sheet of Array.from(document.styleSheets)) {
          const base = sheet.href || document.baseURI;
          try {
            for (const rule of Array.from(sheet.cssRules)) {
              parts.push(absolutizeCssUrls(rule.cssText, base));
            }
          } catch {
            /* skip unreadable sheets */
          }
        }
        return parts.join("\\n");
      }

      function absolutizeCssUrls(cssText, base) {
        return cssText.replace(/url\\((['"]?)([^'")]+)\\1\\)/g, (match, quote, url) => {
          const trimmed = String(url).trim();
          if (!trimmed || /^(data:|blob:|#)/.test(trimmed)) {
            return match;
          }
          try {
            return "url(" + quote + new URL(trimmed, base).href + quote + ")";
          } catch {
            return match;
          }
        });
      }

      function inlineCanvasBitmaps(sourcePage, clonedPage) {
        const sources = sourcePage.querySelectorAll("canvas");
        const targets = clonedPage.querySelectorAll("canvas");
        sources.forEach((source, index) => {
          const target = targets[index];
          if (!target) {
            return;
          }
          try {
            const image = source.ownerDocument.createElement("img");
            image.setAttribute("src", source.toDataURL("image/png"));
            image.setAttribute("width", String(source.width));
            image.setAttribute("height", String(source.height));
            target.replaceWith(image);
          } catch {
            /* tainted canvas */
          }
        });
      }

      function inlineBlobUrls(root) {
        const nodes = Array.from(root.querySelectorAll("img, image"));
        return Promise.all(nodes.map(async (node) => {
          const hrefName = node.getAttribute("href") ? "href" : (node.getAttribute("xlink:href") ? "xlink:href" : "src");
          const value = node.getAttribute(hrefName) || node.currentSrc || "";
          if (!value.startsWith("blob:")) {
            return;
          }
          try {
            const response = await fetch(value);
            const blob = await response.blob();
            const dataUrl = await blobToDataUrl(blob);
            node.setAttribute(hrefName, dataUrl);
            if (hrefName === "src") {
              node.src = dataUrl;
            }
          } catch {
            /* leave original url */
          }
        }));
      }

      function blobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(String(reader.result ?? ""));
          reader.onerror = () => reject(reader.error);
          reader.readAsDataURL(blob);
        });
      }

      function escapeHtml(value) {
        return value
          .replace(/&/g, "&amp;")
          .replace(/"/g, "&quot;")
          .replace(/</g, "&lt;");
      }
    })()
  `;
}

function buildHiddenPageCss(expectation: PdfOutputSessionExpectation): string {
  return `
    @page { size: ${expectation.pageWidthMm}mm ${expectation.pageHeightMm}mm; margin: 0; }
    html[data-sigma-pdf-export-page="true"],
    html[data-sigma-pdf-export-page="true"] body {
      width: ${expectation.pageWidthMm}mm !important;
      min-width: ${expectation.pageWidthMm}mm !important;
      max-width: ${expectation.pageWidthMm}mm !important;
      height: ${expectation.pageHeightMm}mm !important;
      min-height: ${expectation.pageHeightMm}mm !important;
      max-height: ${expectation.pageHeightMm}mm !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: hidden !important;
      background: #ffffff !important;
    }
    html[data-sigma-pdf-export-page="true"] body > :not(#${PDF_EXPORT_ROOT_ID}) {
      display: none !important;
    }
    #${PDF_EXPORT_ROOT_ID} {
      display: block !important;
      position: relative !important;
      width: ${expectation.pageWidthMm}mm !important;
      height: ${expectation.pageHeightMm}mm !important;
      margin: 0 !important;
      padding: 0 !important;
      overflow: clip !important;
      contain: strict !important;
      background: #ffffff !important;
    }
    #${PDF_EXPORT_ROOT_ID} > .paged-surface-page {
      display: block !important;
      position: relative !important;
      width: 100% !important;
      height: 100% !important;
      margin: 0 !important;
      border: 0 !important;
      overflow: clip !important;
      box-shadow: none !important;
      break-after: auto !important;
      break-inside: avoid !important;
      contain: strict !important;
    }
  `;
}

function assertPreparedPageState(
  actual: PreparedPdfPageState,
  expected: PdfOutputSessionExpectation,
  pageIndex: number,
): void {
  if (
    actual.surfaceId !== expected.surfaceId
    || actual.revision !== expected.revision
    || actual.pageCount !== expected.pageCount
    || !nearlyEqual(actual.pageWidthMm, expected.pageWidthMm)
    || !nearlyEqual(actual.pageHeightMm, expected.pageHeightMm)
    || actual.pageIndex !== pageIndex
  ) {
    throw new Error(te("electron.pdf.previewChanged"));
  }
}

async function assertPdfPages(
  pdfBytes: Uint8Array,
  expectation: PdfOutputSessionExpectation,
  expectedPageCount: number,
): Promise<void> {
  const pdf = await PDFDocument.load(pdfBytes);
  if (pdf.getPageCount() !== expectedPageCount) {
    throw new Error(
      te("electron.pdf.pageCountMismatch", { expected: expectedPageCount, actual: pdf.getPageCount() }),
    );
  }

  const expectedWidthPoints = mmToPoints(expectation.pageWidthMm);
  const expectedHeightPoints = mmToPoints(expectation.pageHeightMm);
  for (const [index, page] of pdf.getPages().entries()) {
    const { width, height } = page.getMediaBox();
    if (
      Math.abs(width - expectedWidthPoints) > PAGE_SIZE_TOLERANCE_POINTS
      || Math.abs(height - expectedHeightPoints) > PAGE_SIZE_TOLERANCE_POINTS
    ) {
      throw new Error(te("electron.pdf.pageSizeMismatch", { page: index + 1 }));
    }
  }
}

async function mergePdfPages(pagePdfs: readonly Uint8Array[]): Promise<Buffer> {
  const merged = await PDFDocument.create();
  merged.setCreator("Sigma Studio");
  merged.setProducer("Sigma Studio");
  for (const pagePdf of pagePdfs) {
    const source = await PDFDocument.load(pagePdf);
    const [page] = await merged.copyPages(source, [0]);
    merged.addPage(page);
  }
  return Buffer.from(await merged.save());
}

function mmToPoints(value: number): number {
  return value / MM_PER_INCH * POINTS_PER_INCH;
}

function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.001;
}
