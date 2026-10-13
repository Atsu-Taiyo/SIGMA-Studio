/**
 * Rasterizes the top half of a settled print page into a PNG thumbnail.
 *
 * The page comes from `PagedRenderSurface` — the same cut of the editor canvas the
 * print preview and the PDF use — so a thumbnail never has its own layout.
 *
 * The page is drawn through an SVG `<foreignObject>`. Two things decide whether that
 * works at all:
 * - The SVG must be loaded from a `data:` URL. Chromium taints the canvas for a
 *   `blob:` SVG with a foreignObject, and `toDataURL` then throws on every card.
 * - An SVG image cannot load anything, so fonts and images are inlined. Without the
 *   fonts, math and Japanese text fall back to system faces and the thumbnail no
 *   longer looks like the page.
 */

import {
  collectDocumentCssText,
  collectEmbeddedFontCss,
  readAsDataUrl,
  rootCustomPropertyDeclarations,
} from "@/lib/svg-embedded-styles";

export const WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX = 560;

export function printThumbnailRasterSize(
  pageWidthPx: number,
  pageHeightPx: number,
  outputWidthPx = WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX,
): { width: number; height: number; sourceWidth: number; sourceHeight: number } {
  const sourceWidth = Math.max(1, pageWidthPx);
  const sourceHeight = Math.max(1, pageHeightPx / 2);
  const scale = outputWidthPx / sourceWidth;
  return {
    width: Math.max(1, Math.round(outputWidthPx)),
    height: Math.max(1, Math.round(sourceHeight * scale)),
    sourceWidth,
    sourceHeight,
  };
}

/** Finds the first page window of a settled `PagedRenderSurface`. */
export function findPagedFirstPage(surface: ParentNode): HTMLElement | null {
  return surface.querySelector<HTMLElement>(".paged-surface-pages .paged-surface-page");
}

export async function rasterizePagedPageTopHalf(
  page: HTMLElement,
  outputWidthPx = WORKSPACE_PREVIEW_OUTPUT_WIDTH_PX,
): Promise<string> {
  const rect = page.getBoundingClientRect();
  const size = printThumbnailRasterSize(rect.width || page.offsetWidth, rect.height || page.offsetHeight, outputWidthPx);
  const clone = await cloneBand(page, rect.top + size.sourceHeight);
  const [css, fonts] = await Promise.all([collectDocumentCssText(), collectEmbeddedFontCss()]);
  const frame = wrapInAncestors(page, clone, size.sourceWidth);
  // XMLSerializer gives an HTML root its XHTML namespace, so foreignObject renders it as HTML.
  const root = document.createElement("div");
  root.setAttribute("style", `${rootCustomPropertyDeclarations()}width:${size.sourceWidth}px;height:${size.sourceHeight}px;overflow:hidden;background:#ffffff;${bodyTypography()}`);
  // Serialized as XML, the stylesheet's `<` and `&` are escaped for us.
  const style = document.createElement("style");
  style.textContent = `${fonts}\n${css}`;
  root.append(style, frame);
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size.sourceWidth}" height="${size.sourceHeight}">`,
    `<foreignObject x="0" y="0" width="${size.sourceWidth}" height="${size.sourceHeight}">`,
    new XMLSerializer().serializeToString(root),
    "</foreignObject></svg>",
  ].join("");
  const image = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) {
    throw new Error("canvas");
  }
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, size.width, size.height);
  context.drawImage(image, 0, 0, size.sourceWidth, size.sourceHeight, 0, 0, size.width, size.height);
  return canvas.toDataURL("image/png");
}

/**
 * Every page window holds a copy of the whole canvas. Only the top half of page 1
 * is drawn, so everything laid out below it is dropped: a long document would
 * otherwise serialize every page for each thumbnail. Removing later content never
 * moves what is above it (the canvas positions its fragments explicitly).
 */
async function cloneBand(page: HTMLElement, bandBottom: number): Promise<HTMLElement> {
  const clone = page.cloneNode(true) as HTMLElement;
  const live = Array.from(page.querySelectorAll("*"));
  const copies = Array.from(clone.querySelectorAll("*"));
  const pending: Promise<void>[] = [];
  if (live.length === copies.length) {
    live.forEach((element, index) => {
      const copy = copies[index];
      const box = element.getBoundingClientRect();
      if ((box.width > 0 || box.height > 0) && box.top >= bandBottom) {
        copy.remove();
        return;
      }
      if (element instanceof HTMLImageElement) {
        pending.push(inlineImage(element, copy, "src", element.currentSrc || element.src));
      } else if (element instanceof SVGImageElement) {
        const href = element.href.baseVal;
        pending.push(inlineImage(element, copy, "href", href));
      }
    });
  }
  await Promise.all(pending);
  clone.style.margin = "0";
  clone.style.boxShadow = "none";
  return clone;
}

async function inlineImage(live: Element, copy: Element, attribute: "src" | "href", source: string): Promise<void> {
  if (!source || source.startsWith("data:")) {
    return;
  }
  const dataUrl = await readAsDataUrl(source).catch(() => drawnImageDataUrl(live));
  if (dataUrl) {
    copy.setAttribute(attribute, dataUrl);
    if (attribute === "src") {
      copy.removeAttribute("srcset");
    }
  }
}

/** Schemes that do not support fetch can still be read back from the decoded image, unless tainted. */
function drawnImageDataUrl(live: Element): string | null {
  if (!(live instanceof HTMLImageElement) || !live.complete || live.naturalWidth === 0) {
    return null;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = live.naturalWidth;
    canvas.height = live.naturalHeight;
    canvas.getContext("2d")?.drawImage(live, 0, 0);
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}

/**
 * Rebuilds the page's ancestors down from `.paged-surface` so selectors scoped to
 * the print surface still match. They only carry classes and attributes; their own
 * box is neutralized so the page sits at the origin.
 */
function wrapInAncestors(page: HTMLElement, clone: HTMLElement, width: number): HTMLElement {
  let wrapped: HTMLElement = clone;
  let ancestor = page.parentElement;
  while (ancestor) {
    const shell = ancestor.cloneNode(false) as HTMLElement;
    shell.removeAttribute("id");
    shell.style.cssText += `;margin:0;padding:0;border:0;gap:0;box-shadow:none;background:transparent;transform:none;position:relative;display:block;width:${width}px;height:auto;min-height:0;overflow:visible;`;
    shell.appendChild(wrapped);
    wrapped = shell;
    if (ancestor.classList.contains("paged-surface")) {
      break;
    }
    ancestor = ancestor.parentElement;
  }
  return wrapped;
}

function bodyTypography(): string {
  const body = getComputedStyle(document.body);
  return `font-family:${body.fontFamily};font-size:${body.fontSize};line-height:${body.lineHeight};color:${body.color};`;
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("preview raster failed"));
    image.src = url;
  });
}
