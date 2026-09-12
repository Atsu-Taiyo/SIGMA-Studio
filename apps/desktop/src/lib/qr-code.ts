/**
 * QR code generation helpers.
 *
 * The flow editor detects URLs as the user types and lets them turn a URL into
 * a QR code "immediately". The generated QR is inserted into the page as an
 * overlay image (the same path used for pasted/imported images), so this module
 * produces a PNG `File` that can be handed to the overlay image insert flow.
 */

import QRCode from "qrcode";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

/** Default rendered size of the QR code PNG, in pixels (square). */
export const DEFAULT_QR_SIZE_PX = 320;

export interface QrCodeImageOptions {
  /** Output PNG width/height in pixels. */
  sizePx?: number;
  /** Quiet-zone width in modules around the code. */
  margin?: number;
}

/** Produce a PNG data URL encoding `text` as a QR code. */
export async function generateQrDataUrl(text: string, options: QrCodeImageOptions = {}): Promise<string> {
  const value = text.trim();
  if (!value) {
    throw new Error(te("runtime.qrTextRequired"));
  }
  return QRCode.toDataURL(value, {
    errorCorrectionLevel: "M",
    margin: options.margin ?? 2,
    width: options.sizePx ?? DEFAULT_QR_SIZE_PX,
    color: { dark: "#000000", light: "#ffffff" },
  });
}

/** Build a safe-ish file name stem from a URL for the generated QR image. */
export function qrFileNameFor(text: string): string {
  let host = "";
  try {
    host = new URL(text).hostname;
  } catch {
    host = "";
  }
  const stem = host.replace(/[^a-zA-Z0-9.-]/g, "") || "link";
  return `qr-${stem}.png`;
}

function dataUrlToArrayBuffer(dataUrl: string): ArrayBuffer {
  const commaIndex = dataUrl.indexOf(",");
  const base64 = commaIndex >= 0 ? dataUrl.slice(commaIndex + 1) : dataUrl;
  const binary = atob(base64);
  const buffer = new ArrayBuffer(binary.length);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return buffer;
}

/**
 * Generate a QR code PNG for `text` as a `File`, suitable for the overlay image
 * insert pipeline.
 */
export async function generateQrPngFile(text: string, options: QrCodeImageOptions = {}): Promise<File> {
  const dataUrl = await generateQrDataUrl(text, options);
  const buffer = dataUrlToArrayBuffer(dataUrl);
  return new File([buffer], qrFileNameFor(text), { type: "image/png" });
}
