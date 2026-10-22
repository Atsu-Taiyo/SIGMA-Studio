import { spaceFreeFileName } from "@/lib/file-name";
import { getDesktopBridge } from "./desktop-bridge";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const tError = createCurrentLocaleTranslator("error");

/**
 * Puts a generated file where the user expects a download to land.
 *
 * On the desktop app that is the OS download folder, written straight through without a save
 * dialog — the caller already knows what the file is called, and an export the user asked for by
 * name should not stop to ask again. In a browser it is the browser's own download, which is the
 * same place.
 */

export interface DownloadedFile {
  /** Absolute path on desktop; `null` when the browser owns the download. */
  filePath: string | null;
}

export async function downloadGeneratedFile(blob: Blob, fileName: string): Promise<DownloadedFile> {
  fileName = spaceFreeFileName(fileName);
  const saveToDownloads = getDesktopBridge()?.file.saveToDownloads;
  if (saveToDownloads) {
    const dataBase64 = await blobToBase64(blob);
    return saveToDownloads({ fileName, dataBase64 });
  }

  downloadBlobInBrowser(blob, fileName);
  return { filePath: null };
}

/** Browser-owned download; desktop document exports keep their native save dialog. */
export function downloadBlobInBrowser(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  let anchor: HTMLAnchorElement | undefined;
  try {
    anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = spaceFreeFileName(fileName);
    anchor.rel = "noopener";
    document.body.append(anchor);
    anchor.click();
  } finally {
    anchor?.remove();
    // Keep the URL alive briefly for browsers that read the blob asynchronously after the click.
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  }
}

/** Reveals a downloaded file in Finder/Explorer. A no-op outside the desktop app. */
export async function revealDownloadedFile(filePath: string): Promise<void> {
  await getDesktopBridge()?.file.showInFolder?.(filePath);
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error(tError("download.fileReadFailed")));
    }, { once: true });
    reader.addEventListener("error", () => reject(new Error(tError("download.fileReadFailed"))), { once: true });
    reader.readAsDataURL(blob);
  });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : "";
}
