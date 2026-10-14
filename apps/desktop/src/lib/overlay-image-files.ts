// 受け付ける MIME の集合は、文書へ入れてよい `src` の許可判定と **同じ 1 箇所**から取る。
// 2 つに分かれていると、ファイルピッカーは通すのに正規化境界が落とす (= 貼れるのに消える)
// という食い違いが静かに生まれる。
export { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";

import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";
import { EDITOR_CLIPBOARD_MIME, readEditorClipboardPayload } from "@/lib/editor-clipboard";
import { readSpreadsheetClipboard } from "@/lib/spreadsheet-clipboard";
import { decodeSvgDataUrl, parseStaticSvg, resolvedAttrs, svgViewport } from "@/lib/svg-image-source";

const SUPPORTED_OVERLAY_IMAGE_MIME_TYPE_SET = new Set<string>(SUPPORTED_OVERLAY_IMAGE_MIME_TYPES);

export function isSupportedOverlayImageFile(file: File): boolean {
  return SUPPORTED_OVERLAY_IMAGE_MIME_TYPE_SET.has(file.type);
}

export function getSupportedOverlayImageFiles(files: ArrayLike<File> | Iterable<File> | null | undefined): File[] {
  if (!files) {
    return [];
  }

  return Array.from(files).filter(isSupportedOverlayImageFile);
}

export function getSupportedOverlayImageFilesFromDataTransfer(dataTransfer: DataTransfer): File[] {
  // Office may offer a bitmap preview alongside its editable cell range.
  const html = dataTransfer.getData?.("text/html") ?? "";
  if (dataTransfer.getData && (dataTransfer.getData(EDITOR_CLIPBOARD_MIME) || html.includes("data-sigma-studio-clipboard")) && readEditorClipboardPayload(dataTransfer)) return [];
  if (readSpreadsheetClipboard(dataTransfer)) return [];
  const itemFiles = getDataTransferItemFiles(dataTransfer.items);
  const supported = itemFiles.filter(isSupportedOverlayImageFile);
  const files = supported.length > 0 ? supported : getSupportedOverlayImageFiles(dataTransfer.files);
  const hasSvgHtml = /<svg[\s>]|data:image\/svg\+xml[;,]/i.test(html);
  if (files.length > 0 && (files.length > 1 || files.some(file => file.type === "image/svg+xml") || !hasSvgHtml)) return files;
  const doc = /<(?:svg|img)[\s>]/i.test(html) && html.length <= 16_000_000
    ? new DOMParser().parseFromString(html, "text/html") : null;
  // Browser copies can expose only HTML, or a raster preview alongside the SVG.
  // Keep the vector source so the pasted image can subsequently be converted.
  if (doc && files.length <= 1 && !files.some(file => file.type === "image/svg+xml")) {
    const svg = getStandaloneSvgFile(doc);
    if (svg) return [svg];
  }
  if (files.length > 0) return files;
  if (!doc) return [];
  return Array.from(doc.querySelectorAll("img")).flatMap(img => {
    const match = img.getAttribute("src")?.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=\s]+)$/i);
    if (!match) return [];
    try {
      const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
      return [new File([bytes], "clipboard-chart", { type: match[1].toLowerCase() })];
    } catch { return []; }
  });
}

function getStandaloneSvgFile(doc: Document): File | null {
  const candidates = doc.body.querySelectorAll("svg, img");
  if (candidates.length !== 1) return null;
  const candidate = candidates[0];
  if (candidate.localName !== "svg" && !/^data:image\/svg\+xml[;,]/i.test(candidate.getAttribute("src") ?? "")) return null;
  // Do not consume an article or a mixed selection merely because it contains a diagram.
  const wrappers = new Set(["div", "span", "p", "a", "figure", "br"]);
  if (Array.from(doc.body.querySelectorAll("*")).some(element => element !== candidate && !candidate.contains(element) && !wrappers.has(element.localName))) return null;
  const remainder = doc.body.cloneNode(true) as HTMLElement;
  remainder.querySelector("svg, img")!.remove();
  if (remainder.textContent?.trim()) return null;
  try {
    const svg = candidate.localName === "svg"
      ? new XMLSerializer().serializeToString(candidate)
      : decodeSvgDataUrl(candidate.getAttribute("src") ?? "");
    svgViewport(resolvedAttrs(parseStaticSvg(svg)));
    return new File([svg], "clipboard.svg", { type: "image/svg+xml" });
  } catch { return null; }
}

export function hasSupportedOverlayImageData(dataTransfer: DataTransfer): boolean {
  if (dataTransfer.items.length > 0) {
    return Array.from(dataTransfer.items).some((item) => (
      item.kind === "file" &&
      SUPPORTED_OVERLAY_IMAGE_MIME_TYPE_SET.has(item.type)
    ));
  }

  return getSupportedOverlayImageFiles(dataTransfer.files).length > 0;
}

function getDataTransferItemFiles(items: DataTransferItemList): File[] {
  return Array.from(items).flatMap((item) => {
    if (item.kind !== "file") {
      return [];
    }

    const file = item.getAsFile();
    return file ? [file] : [];
  });
}
