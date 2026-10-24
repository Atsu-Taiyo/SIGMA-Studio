import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type OverlaySnapshot, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const dots = [0.4, 0.5, 0.75, 2.5, 10];
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 160">
  ${dots.map((r, index) => `<circle cx="${30 + index * 60}" cy="40" r="${r}" fill="#111111"/>`).join("")}
  <ellipse cx="30" cy="110" rx="0.4" ry="8" fill="#111111"/>
  <ellipse cx="90" cy="110" rx="8" ry="0.4" fill="#111111"/>
  <ellipse cx="150" cy="110" rx="0.5" ry="8" fill="#111111"/>
  <ellipse cx="210" cy="110" rx="12" ry="6" fill="#111111" transform="rotate(30,210,110)"/>
</svg>`;

async function inkByCell(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  // Integrate darkness, including antialiasing, per dot: a large circle must not hide a changed tiny one.
  const cells = Array<number>(10).fill(0);
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const i = (y * image.width + x) * 4;
    const darkness = 1 - (data[i] + data[i + 1] + data[i + 2]) / (255 * 3);
    cells[Math.min(1, Math.floor(y / image.height * 2)) * 5 + Math.min(4, Math.floor(x / image.width * 5))] += darkness;
  }
  return cells;
}

test("circles retain their radii and undersized dots stay SVG through desktop undo and reload", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const snapshot: OverlaySnapshot = { version: 1,
    shapes: [{ id: "dots", type: "image", x: 120, y: 140, props: { assetId: "dots-asset", w: 300, h: 160 } }],
    assets: { "dots-asset": { id: "dots-asset", type: "image", props: { w: 300, h: 160, name: "点と円",
      mimeType: "image/svg+xml", isAnimated: false, fileSize: SVG.length, src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` } } },
  };
  const document: SigmaDocument = { version: "2.0", docId: "svg-small-circles", metadata: { title: "小さな円の変換" },
    content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "円の半径と画像として残る点を確認" }] }],
    pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: snapshot } }, outputProfiles: { student: {}, teacher: {}, answerBook: {} } };
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-small-circles-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  // Sample 1px geometry at 2x so half-pixel placement is not rounded to a whole screen pixel.
  const app = await electron.launch({ args: [APP_ROOT, "--force-device-scale-factor=2"], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1050));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const fileId = await page.evaluate(async doc => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document: doc });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("小さな円の変換");
    if (env.SIGMA_STUDIO_DEV_SERVER_URL) expect(new URL(page.url()).origin).toBe(new URL(env.SIGMA_STUDIO_DEV_SERVER_URL).origin);
    const saved = async () => (await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    const original = await saved();
    const frame = page.locator('.overlay-shape-image[data-overlay-shape-id="dots"]');
    await expect.poll(() => frame.locator("img").evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await frame.scrollIntoViewIfNeeded();
    const box = (await frame.boundingBox())!;
    const clip = { x: box.x, y: box.y, width: box.width, height: box.height };
    await page.mouse.move(20, 100);
    const beforeInk = await inkByCell(await page.screenshot({ clip, scale: "device", animations: "disabled", path: testInfo.outputPath("before.png") }));
    await page.mouse.click(box.x + 150, box.y + 80, { button: "right" });
    await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
    await expect(page.getByTestId("svg-conversion-message")).toContainText("SVG画像として保持しました");
    await expect.poll(async () => (await saved()).shapes.filter(shape => shape.type === "geo").length).toBe(6);
    const converted = await saved();
    expect(converted.shapes.filter(shape => shape.type === "image")).toHaveLength(3);
    expect(converted.shapes.filter(shape => shape.type === "geo").map(shape => [shape.props.w, shape.props.h])).toEqual([
      [1, 1], [1.5, 1.5], [5, 5], [20, 20], [1, 16], [24, 12],
    ]);
    const deselect = async () => {
      await page.keyboard.press("Escape");
      await page.mouse.click(box.x + box.width + 40, box.y + 20);
      await page.mouse.move(20, 100);
      await expect(page.locator(".overlay-selection-box")).toBeHidden();
    };
    const compareInk = async (name: string) => {
      await expect.poll(async () => page.locator(".overlay-shape-image img").evaluateAll(images => images.every(img => (img as HTMLImageElement).complete))).toBe(true);
      const afterInk = await inkByCell(await page.screenshot({ clip, scale: "device", animations: "disabled", path: testInfo.outputPath(`${name}.png`) }));
      beforeInk.forEach((ink, index) => expect(Math.abs(afterInk[index] - ink), `dot ${index}: ink area`).toBeLessThan(Math.max(0.6, ink * 0.08)));
    };
    await deselect();
    await compareInk("after");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+z`);
    await expect.poll(saved).toEqual(original);
    await page.keyboard.press(`${modifier}+Shift+z`);
    await expect.poll(saved).toEqual(converted);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("小さな円の変換");
    expect(await saved()).toEqual(converted);
    await deselect();
    await compareInk("reloaded");
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
