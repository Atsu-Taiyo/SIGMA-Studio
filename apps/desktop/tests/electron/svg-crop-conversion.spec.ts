import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 500 460"><defs><linearGradient id="gradient" gradientUnits="userSpaceOnUse" x2="100%"><stop offset="0" stop-color="black"/><stop offset="1" stop-color="white"/></linearGradient></defs><rect x="50%" y="75%" width="20%" height="10%" fill="url(#gradient)"/><g stroke="black" stroke-width="2" fill="none"><rect x="100" y="100" width="100" height="80"/><path d="M150 300 Q250 200 350 300"/><rect x="10" y="200" width="100" height="100"/><circle cx="480" cy="100" r="5"/></g><text x="220" y="150">装置</text></svg>';
function fixture(crop: boolean): SigmaDocument {
  return { version: "2.0", docId: "svg-crop-test", metadata: { title: "SVGトリミング変換" },
    content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "SVG変換確認" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: { version: 1,
      shapes: [{ id: "svg", type: "image", x: 100, y: 150, anchor: { type: "page" }, props: { assetId: "asset", w: crop ? 350 : 440, h: crop ? 460 : 405,
        ...(crop ? { crop: { topLeft: { x: 0.1, y: 0 }, bottomRight: { x: 0.8, y: 1 } } } : {}) } }],
      assets: { asset: { id: "asset", type: "image", props: { w: 500, h: 460, name: "図", mimeType: "image/svg+xml", isAnimated: false, fileSize: Buffer.byteLength(SVG),
        src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` } } } } } } };
}
const rounded = (value: unknown) => JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "number" ? Math.round(child * 100) / 100 : child));

async function ink(png: Buffer) {
  const image = await loadImage(png), canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  // Subpixel black strokes can rasterize as gray after an SVG viewport is cropped.
  return { width: image.width, height: image.height, pixels: Uint8Array.from({ length: image.width * image.height }, (_, i) =>
    0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < 160 ? 1 : 0) };
}

for (const mode of ["rounded", "crop", "reference"] as const) {
  test(`${mode} SVG converts in Electron, preserves the visible drawing, undoes and reloads`, async ({}, testInfo) => {
    test.skip(mode === "reference" && !process.env.SIGMA_STUDIO_SVG_REFERENCE_DOCUMENT, "Optional local reference document");
    test.setTimeout(180_000);
    const sourcePath = mode === "reference" ? process.env.SIGMA_STUDIO_SVG_REFERENCE_DOCUMENT : undefined;
    const original = sourcePath ? await readFile(sourcePath) : undefined;
    const document: SigmaDocument = original ? JSON.parse(original.toString("utf8")) : fixture(mode === "crop");
    const overlay = document.pageLayout!.overlay!.overlaySnapshot!;
    const target = overlay.shapes.find(shape => shape.type === "image" && overlay.assets[shape.props.assetId]?.props.mimeType === "image/svg+xml")!;
    const profile = await mkdtemp(path.join(tmpdir(), "sigma-crop-regression-"));
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.SIGMA_STUDIO_DEV_SERVER_URL;
    env.SIGMA_STUDIO_USER_DATA_DIR = profile;
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
    const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    try {
      const page = await app.firstWindow(), errors: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1050));
      if (process.env.SIGMA_STUDIO_E2E_BASE_URL) expect(page.url()).toContain(process.env.SIGMA_STUDIO_E2E_BASE_URL);
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      const fileId = await page.evaluate(async document => {
        localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
        localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
        await window.desktopAPI!.settings!.setUiLocale!("ja");
        const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
        await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
        return created.file.fileId;
      }, document);
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      const saved = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
      const before = (await saved())!;
      const image = page.locator(`.overlay-shape-image[data-overlay-shape-id="${target.id}"]`);
      await image.scrollIntoViewIfNeeded();
      await expect.poll(() => image.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
      const box = (await image.boundingBox())!;
      const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
      await page.mouse.move(20, 100);
      const beforePng = await page.screenshot({ clip, path: testInfo.outputPath("before.png") });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
      await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
      await expect.poll(async () => (await saved())!.pageLayout!.overlay!.overlaySnapshot!.shapes.find(s => s.id === target.id)?.type).toBe("group");
      const converted = (await saved())!;
      expect(converted.content).toEqual(before.content);
      expect(converted.pageLayout!.overlay!.overlaySnapshot!.shapes.filter(s => s.type === "geo" || s.type === "line").length).toBeGreaterThan(0);
      await page.keyboard.press("Escape");
      await page.mouse.click(box.x + box.width + 30, box.y + 20);
      await page.mouse.move(20, 100);
      await expect(page.locator(".overlay-selection-box")).toBeHidden();
      const afterPng = await page.screenshot({ clip, path: testInfo.outputPath("after.png") });
      const [a, b] = await Promise.all([ink(beforePng), ink(afterPng)]);
      const near = (pixels: Uint8Array, x: number, y: number) => {
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
          const px = x + dx, py = y + dy;
          if (px >= 0 && py >= 0 && px < b.width && py < b.height && pixels[py * b.width + px]) return true;
        }
        return false;
      };
      for (const [source, destination] of [[a, b], [b, a]]) {
        let total = 0, kept = 0;
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) if (source.pixels[y * source.width + x]) {
          total++; if (near(destination.pixels, x, y)) kept++;
        }
        expect(total).toBeGreaterThan(100);
        expect(kept / total).toBeGreaterThan(0.95);
      }
      await page.getByRole("button", { name: "元に戻す", exact: true }).click();
      await expect.poll(async () => rounded((await saved())!.pageLayout!.overlay!.overlaySnapshot)).toEqual(rounded(before.pageLayout!.overlay!.overlaySnapshot));
      await page.getByRole("button", { name: "やり直す", exact: true }).click();
      await expect.poll(async () => rounded((await saved())!.pageLayout!.overlay!.overlaySnapshot)).toEqual(rounded(converted.pageLayout!.overlay!.overlaySnapshot));
      await page.reload();
      await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
      expect(rounded((await saved())!.pageLayout!.overlay!.overlaySnapshot)).toEqual(rounded(converted.pageLayout!.overlay!.overlaySnapshot));
      expect(errors).toEqual([]);
      if (sourcePath && original) expect(createHash("sha256").update(await readFile(sourcePath)).digest("hex")).toBe(createHash("sha256").update(original).digest("hex"));
      if (mode === "reference") {
        const output = testInfo.outputPath("converted.sigma");
        await writeFile(output, JSON.stringify(converted, null, 2));
        await testInfo.attach("converted.sigma", { path: output, contentType: "application/json" });
      }
    } finally {
      await app.close();
      await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  });
}
