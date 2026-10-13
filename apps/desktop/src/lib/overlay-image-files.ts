// 受け付ける MIME の集合は、文書へ入れてよい `src` の許可判定と **同じ 1 箇所**から取る。
// 2 つに分かれていると、ファイルピッカーは通すのに正規化境界が落とす (= 貼れるのに消える)
// という食い違いが静かに生まれる。
export { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";

import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";
import { readSpreadsheetClipboard } from "@/lib/spreadsheet-clipboard";

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
  if (readSpreadsheetClipboard(dataTransfer)) return [];
  const itemFiles = getDataTransferItemFiles(dataTransfer.items);
  const supported = itemFiles.filter(isSupportedOverlayImageFile);
  if (supported.length > 0) return supported;
  const files = getSupportedOverlayImageFiles(dataTransfer.files);
  if (files.length > 0) return files;
  if (!/<img[\s>]/i.test(html) || html.length > 16_000_000) return [];
  const doc = new DOMParser().parseFromString(html, "text/html");
  return Array.from(doc.querySelectorAll("img")).flatMap(img => {
    const match = img.getAttribute("src")?.match(/^data:(image\/(?:png|jpeg|webp));base64,([a-z\d+/=\s]+)$/i);
    if (!match) return [];
    try {
      const bytes = Uint8Array.from(atob(match[2]), char => char.charCodeAt(0));
      return [new File([bytes], "clipboard-chart", { type: match[1].toLowerCase() })];
    } catch { return []; }
  });
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
