import { _electron as electron, expect, test, type ElectronApplication } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { encodeImage } from "utif";
import { createBlankDocument } from "@/lib/blank-document";

// Exercise the real decoder, canvas conversion, document normalization and disk assets.
test("TIFF imports become PNG assets and survive an Electron restart", async ({}, testInfo) => {
  const root = path.resolve(__dirname, "../..");
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-tiff-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app: ElectronApplication | undefined;
  const launch = async () => {
    app = await electron.launch({ args: [root], cwd: root, env });
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    return page;
  };
  try {
    let page = await launch();
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      const api = window.desktopAPI!.storage;
      const created = await api.createFileFromDocument({ document });
      await api.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, createBlankDocument("TIF画像の挿入確認"));
    await page.reload();
    const rgba = new Uint8Array(160 * 100 * 4);
    for (let i = 0; i < rgba.length; i += 4) rgba.set([32, 96, 224, 255], i);
    const buffer = Buffer.from(encodeImage(rgba, 160, 100));
    // Both cycles hung or overflowed UTIF before the first-page import guard.
    const offset = buffer.readUInt32BE(4);
    const count = buffer.readUInt16BE(offset);
    buffer.writeUInt32BE(offset, offset + 2 + count * 12);
    const metadata = Array.from({ length: count }, (_, i) => offset + 2 + i * 12)
      .find(entry => buffer.readUInt16BE(entry) === 282)!;
    buffer.writeUInt16BE(330, metadata); buffer.writeUInt16BE(4, metadata + 2);
    buffer.writeUInt32BE(1, metadata + 4); buffer.writeUInt32BE(offset, metadata + 8);
    const picker = page.locator('header input[type="file"][multiple][accept*="image/"]');
    await expect(picker).toHaveAttribute("accept", /\.tif/);
    await picker.setInputFiles({ name: "scan.TIF", mimeType: "application/octet-stream", buffer });
    const images = page.locator("img.overlay-image-shape");
    await expect(images).toHaveCount(1);
    await expect.poll(() => images.first().evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(160);
    expect(await images.first().evaluate((img: HTMLImageElement) => {
      const canvas = document.createElement("canvas"); canvas.width = 160; canvas.height = 100;
      const context = canvas.getContext("2d")!; context.drawImage(img, 0, 0);
      return Array.from(context.getImageData(80, 50, 1, 1).data);
    })).toEqual([32, 96, 224, 255]);
    // Paste follows the same import adapter, including the canonical MIME variant.
    await page.locator(".page-flow").first().evaluate((element, base64) => {
      const transfer = new DataTransfer();
      transfer.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], "pasted.tiff", { type: "image/tiff" }));
      element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, buffer.toString("base64"));
    await expect(images).toHaveCount(2);
    await expect.poll(async () => {
      const doc = await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const assets = Object.values(doc?.pageLayout?.overlay?.overlaySnapshot?.assets ?? {});
      return assets.map(asset => ({ name: asset.props.name, mimeType: asset.props.mimeType, w: asset.props.w, h: asset.props.h }));
    }).toEqual([
      { name: "scan.TIF", mimeType: "image/png", w: 160, h: 100 },
      { name: "pasted.tiff", mimeType: "image/png", w: 160, h: 100 },
    ]);
    // A corrupt import must not leave a broken placeholder in the document.
    await picker.setInputFiles({ name: "broken.tif", mimeType: "image/tiff", buffer: Buffer.from("invalid") });
    await expect(picker).toHaveValue("");
    await app!.close(); app = undefined;
    page = await launch();
    const restored = page.locator("img.overlay-image-shape");
    await expect(restored).toHaveCount(2);
    for (const image of await restored.all()) {
      await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(160);
    }
    await page.screenshot({ path: testInfo.outputPath("tiff-reloaded.png") });
  } finally {
    if (app) await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
