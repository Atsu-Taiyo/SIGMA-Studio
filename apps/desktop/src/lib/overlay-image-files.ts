// 受け付ける MIME の集合は、文書へ入れてよい `src` の許可判定と **同じ 1 箇所**から取る。
// 2 つに分かれていると、ファイルピッカーは通すのに正規化境界が落とす (= 貼れるのに消える)
// という食い違いが静かに生まれる。
export { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";

import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/features/document/asset-source";

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
  const itemFiles = getDataTransferItemFiles(dataTransfer.items);
  if (itemFiles.length > 0) {
    return itemFiles.filter(isSupportedOverlayImageFile);
  }

  return getSupportedOverlayImageFiles(dataTransfer.files);
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
