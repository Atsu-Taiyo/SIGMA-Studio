import { getDesktopBridge } from "@/lib/desktop-bridge";
import { downloadGeneratedFile } from "@/lib/download-file";

import { createCaptureFileName, type CaptureRect } from "./region-capture-model";

export interface CapturedImage {
  blob: Blob;
  width: number;
  height: number;
  fileName: string;
}

/** 範囲スクリーンショットの取得経路があるか。デスクトップ版だけが持つ。 */
export function canCaptureRegion(): boolean {
  return typeof getDesktopBridge()?.app?.captureRegion === "function";
}

/**
 * 画面が実際に塗り直されるまで待つ。選択枠を隠した直後に撮ると、枠が写り込んだ古いフレームを
 * 掴むことがあるので、2 フレーム分の描画を待ってから取得に進む。
 */
export function waitForNextPaint(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  });
}

/**
 * `rect` の範囲を PNG にする。取得できなかったとき (最小化中・取得経路なし) は null。
 * `maxDimension` を渡すと長辺をその大きさに縮める (AI へ渡す画像向け)。
 */
export async function captureRegionImage(
  rect: CaptureRect,
  options: { maxDimension?: number } = {},
): Promise<CapturedImage | null> {
  const captureRegion = getDesktopBridge()?.app?.captureRegion;
  if (!captureRegion) {
    return null;
  }
  const result = await captureRegion({
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height,
    ...(options.maxDimension ? { maxDimension: options.maxDimension } : {}),
  });
  if (!result || result.png.byteLength === 0) {
    return null;
  }
  // `png` は IPC を渡ってきた Uint8Array。Blob に包むだけでコピーはしない。
  const blob = new Blob([result.png as BlobPart], { type: "image/png" });
  return { blob, width: result.width, height: result.height, fileName: createCaptureFileName(new Date()) };
}

export async function copyCapturedImageToClipboard(image: CapturedImage): Promise<boolean> {
  if (
    typeof navigator === "undefined"
    || !navigator.clipboard
    || typeof navigator.clipboard.write !== "function"
    || typeof ClipboardItem === "undefined"
  ) {
    return false;
  }
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": image.blob })]);
    return true;
  } catch {
    return false;
  }
}

/** 「ダウンロード」フォルダへ保存する (保存ダイアログは出さない)。保存先の絶対パスを返す。 */
export async function saveCapturedImage(image: CapturedImage): Promise<string | null> {
  const { filePath } = await downloadGeneratedFile(image.blob, image.fileName);
  return filePath;
}

export function readBlobAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") resolve(reader.result);
      else reject(new Error("screenshot read failed"));
    }, { once: true });
    reader.addEventListener("error", () => reject(reader.error ?? new Error("screenshot read failed")), { once: true });
    reader.readAsDataURL(blob);
  });
}
