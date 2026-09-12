import { describe, expect, it } from "vitest";

import { generateQrDataUrl, generateQrPngFile, qrFileNameFor } from "./qr-code";
import { setAppLocale } from "@/lib/i18n";

describe("qrFileNameFor", () => {
  it("derives a png name from the URL host", () => {
    expect(qrFileNameFor("https://example.com/path")).toBe("qr-example.com.png");
  });

  it("falls back to a generic name for non-URL input", () => {
    expect(qrFileNameFor("not a url")).toBe("qr-link.png");
  });
});

describe("generateQrDataUrl", () => {
  it("produces a PNG data URL", async () => {
    const dataUrl = await generateQrDataUrl("https://example.com");
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);
  });

  it("rejects empty input", async () => {
    setAppLocale("ja");
    await expect(generateQrDataUrl("   ")).rejects.toThrow("QRコードにする文字列を入力してください。");
    setAppLocale("en");
    await expect(generateQrDataUrl("   ")).rejects.toThrow("Enter text to create a QR code.");
    setAppLocale("ja");
  });
});

describe("generateQrPngFile", () => {
  it("returns a non-empty PNG File", async () => {
    const file = await generateQrPngFile("https://example.com");
    expect(file.type).toBe("image/png");
    expect(file.name).toBe("qr-example.com.png");
    expect(file.size).toBeGreaterThan(0);
  });
});
