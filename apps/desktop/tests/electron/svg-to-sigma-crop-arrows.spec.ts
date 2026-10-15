import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type OverlaySnapshot, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
// Arrows (a straight line and a quadratic curve), a rectangle that crosses the left crop edge, a circle the crop hides,
// and one the crop shows, whose size and place must come out the same.
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><defs><marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111111"/></marker></defs>' +
  '<g stroke="#111111" stroke-width="2" fill="none"><rect x="20" y="20" width="80" height="50" fill="#dddddd"/><line x1="45" y1="100" x2="170" y2="100" marker-end="url(#head)"/>' +
  '<path d="M45 160 Q100 110 170 150" marker-end="url(#head)"/><line x1="240" y1="20" x2="240" y2="180" stroke-dasharray="8 6"/><circle cx="285" cy="30" r="8" fill="#999999"/><circle cx="150" cy="45" r="15" stroke-width="3" fill="#ffffff"/></g>' +
  '<text x="190" y="70">装置図</text></svg>';
// The right 80% of the image is shown, 30px in from its left edge, in a frame of the same aspect.
const SNAPSHOT: OverlaySnapshot = {
  version: 1,
  shapes: [{ id: "svg-image", type: "image", x: 100, y: 150, props: { assetId: "svg-asset", w: 240, h: 200,
    crop: { topLeft: { x: 0.1, y: 0 }, bottomRight: { x: 0.9, y: 1 } } } }],
  assets: { "svg-asset": { id: "svg-asset", type: "image", props: { w: 300, h: 200, name: "矢印の図", mimeType: "image/svg+xml",
    isAnimated: false, fileSize: SVG.length, src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` } } },
};
const DOCUMENT: SigmaDocument = { version: "2.0", docId: "svg-crop-arrows", metadata: { title: "トリミングと矢印の変換" },
  content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "トリミングしたSVGを右クリックして変換" }] }],
  pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: SNAPSHOT } }, outputProfiles: { student: {}, teacher: {}, answerBook: {} } };

async function ink(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, dark: Uint8Array.from({ length: image.width * image.height }, (_, i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < 140 ? 1 : 0) };
}

test("a cropped SVG with arrows converts to the part the canvas shows, with real arrow heads", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-crop-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const executablePath = process.env.SIGMA_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await (await app.browserWindow(page)).evaluate((win) => win.setContentSize(1400, 1050));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const fileId = await page.evaluate(async (document) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, DOCUMENT);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const snapshot = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    const frame = page.locator(".overlay-shape-image").first();
    await expect.poll(() => frame.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(0);
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const box = (await frame.boundingBox())!;
    const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    const before = await page.screenshot({ clip });
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
    await expect(page.getByTestId("svg-conversion-message")).toContainText("個の図形に変換しました");
    await expect.poll(async () => (await snapshot()).shapes.some((shape) => shape.type === "group")).toBe(true);
    const converted = await snapshot();
    const heads = converted.shapes.filter((shape) => shape.type === "line" && shape.props.arrowheadEnd);
    expect(heads.map((shape) => shape.type === "line" ? [shape.props.kind, shape.props.arrowheadEnd] : null)).toEqual([["polyline", "triangle"], ["curve", "triangle"]]);
    // The rectangle crosses the crop edge, so only it stays SVG, cropped to what shows. The circle the crop hides is gone.
    expect(converted.shapes.filter((shape) => shape.type === "image")).toHaveLength(1);
    // Only the circle that shows is left: its box is the outline's plus the editor's 1px inset on each side.
    expect(converted.shapes.filter((shape) => shape.type === "geo" && shape.props.geo === "ellipse")).toMatchObject([{ props: { w: 32, h: 32, size: "l" } }]);
    await page.screenshot({ path: testInfo.outputPath("crop-arrows-converted.png") });
    await page.waitForTimeout(500);
    const after = await page.screenshot({ clip });
    const [a, b] = [await ink(before), await ink(after)];
    const near = (m: Uint8Array, x: number, y: number) => {
      for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && py >= 0 && px < b.width && py < b.height && m[py * b.width + px]) return true;
      }
      return false;
    };
    let total = 0, kept = 0;
    for (let y = 0; y < a.height; y++) for (let x = 0; x < a.width; x++) if (a.dark[y * a.width + x]) { total++; if (near(b.dark, x, y)) kept++; }
    expect(total).toBeGreaterThan(200);
    // What the canvas showed before is what the converted shapes show, to within the 4 stroke widths and text metrics.
    expect(kept / total).toBeGreaterThan(0.95);
    // The circle's drawn extent, found in each screenshot, agrees to the pixel (u 134..166 of the SVG is x 104..136 in the frame).
    const extent = (picture: Awaited<ReturnType<typeof ink>>) => {
      const scale = picture.width / box.width, bounds = { left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity };
      for (let y = Math.floor(20 * scale); y < Math.floor(75 * scale); y++) for (let x = Math.floor(95 * scale); x < Math.floor(145 * scale); x++) {
        if (!picture.dark[y * picture.width + x]) continue;
        bounds.left = Math.min(bounds.left, x); bounds.right = Math.max(bounds.right, x + 1);
        bounds.top = Math.min(bounds.top, y); bounds.bottom = Math.max(bounds.bottom, y + 1);
      }
      return [bounds.left, bounds.right, bounds.top, bounds.bottom].map((value) => value / scale);
    };
    const [circleBefore, circleAfter] = [extent(a), extent(b)];
    circleBefore.forEach((value, index) => expect(Math.abs(value - circleAfter[index])).toBeLessThanOrEqual(1));
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
