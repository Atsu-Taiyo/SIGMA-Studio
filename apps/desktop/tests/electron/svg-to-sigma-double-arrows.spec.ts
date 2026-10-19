import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type OverlaySnapshot, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
// Double-headed arrows (#234), written the ways an SVG gives a start head that points out of the line without
// `auto-start-reverse`: a start marker drawn pointing back along -x under `orient="auto"`, and numeric orients.
const MARKERS = '<marker id="end" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#111111"/></marker>' +
  '<marker id="start" viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="#111111"/></marker>' +
  '<marker id="v-end" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0,1 L10,5 L0,9" fill="none" stroke="#111111"/></marker>' +
  '<marker id="v-start" viewBox="0 0 10 10" refX="0" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M10,1 L0,5 L10,9" fill="none" stroke="#111111"/></marker>' +
  '<marker id="down" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="90"><path d="M0,0 L10,5 L0,10 z" fill="#111111"/></marker>' +
  '<marker id="up" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="-90"><path d="M0,0 L10,5 L0,10 z" fill="#111111"/></marker>';
const ARROWS = [
  { element: '<line x1="30" y1="40" x2="200" y2="40" marker-start="url(#start)" marker-end="url(#end)"/>', points: [[30, 40], [200, 40]] },
  { element: '<line x1="30" y1="95" x2="200" y2="95" marker-start="url(#v-start)" marker-end="url(#v-end)"/>', points: [[30, 95], [200, 95]] },
  { element: '<path d="M30 150 Q115 70 200 150" marker-start="url(#start)" marker-end="url(#end)"/>', points: [[30, 150], [115, 70], [200, 150]] },
  { element: '<line x1="250" y1="30" x2="250" y2="170" marker-start="url(#up)" marker-end="url(#down)"/>', points: [[250, 30], [250, 170]] },
];
/** Each end of each arrow: its vertex, and the line's direction out of it there. */
const TIPS = ARROWS.flatMap(({ points }) => [[points[0], points[1]], [points[points.length - 1], points[points.length - 2]]].map(([[x, y], [fromX, fromY]]) => {
  const span = Math.hypot(x - fromX, y - fromY);
  return { x, y, outward: { x: (x - fromX) / span, y: (y - fromY) / span } };
}));
const SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 300 200"><defs>${MARKERS}</defs>` +
  `<g stroke="#111111" stroke-width="2" fill="none">${ARROWS.map((arrow) => arrow.element).join("")}</g></svg>`;
const SNAPSHOT: OverlaySnapshot = {
  version: 1,
  shapes: [{ id: "svg-image", type: "image", x: 100, y: 150, props: { assetId: "svg-asset", w: 300, h: 200 } }],
  assets: { "svg-asset": { id: "svg-asset", type: "image", props: { w: 300, h: 200, name: "両矢印の図", mimeType: "image/svg+xml",
    isAnimated: false, fileSize: SVG.length, src: `data:image/svg+xml;base64,${Buffer.from(SVG).toString("base64")}` } } },
};
const DOCUMENT: SigmaDocument = { version: "2.0", docId: "svg-double-arrows", metadata: { title: "両矢印の変換" },
  content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "両端が矢印のSVGを右クリックして変換" }] }],
  pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: SNAPSHOT } }, outputProfiles: { student: {}, teacher: {}, answerBook: {} } };

async function ink(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, dark: Uint8Array.from({ length: image.width * image.height }, (_, i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < 140 ? 1 : 0) };
}
type Ink = Awaited<ReturnType<typeof ink>>;

/** How far past the vertex (SVG units, along the line's way out) the ink near one end reaches: where the head's tip is drawn. */
function reach(picture: Ink, tip: typeof TIPS[number]) {
  const scale = picture.width / 300;
  let farthest = -Infinity;
  for (let y = Math.max(0, Math.floor((tip.y - 16) * scale)); y < Math.min(picture.height, Math.ceil((tip.y + 16) * scale)); y++) {
    for (let x = Math.max(0, Math.floor((tip.x - 16) * scale)); x < Math.min(picture.width, Math.ceil((tip.x + 16) * scale)); x++) {
      if (!picture.dark[y * picture.width + x]) continue;
      const along = ((x + 0.5) / scale - tip.x) * tip.outward.x + ((y + 0.5) / scale - tip.y) * tip.outward.y;
      farthest = Math.max(farthest, along);
    }
  }
  return farthest;
}

/** The share of `from`'s dark pixels inside `region` (SVG units) that have a dark pixel of `to` within 3 device pixels. */
function coverage(from: Ink, to: Ink, region = { left: 0, top: 0, right: 300, bottom: 200 }) {
  const scale = from.width / 300;
  let total = 0, kept = 0;
  for (let y = Math.max(0, Math.floor(region.top * scale)); y < Math.min(from.height, Math.ceil(region.bottom * scale)); y++) {
    for (let x = Math.max(0, Math.floor(region.left * scale)); x < Math.min(from.width, Math.ceil(region.right * scale)); x++) {
      if (!from.dark[y * from.width + x]) continue;
      total++;
      search: for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
        const px = x + dx, py = y + dy;
        if (px >= 0 && py >= 0 && px < to.width && py < to.height && to.dark[py * to.width + px]) { kept++; break search; }
      }
    }
  }
  return { total, share: total ? kept / total : 0 };
}

test("double-headed SVG arrows convert to lines with heads at both ends that point the way the SVG drew them (#234)", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-double-arrows-"));
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
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("両矢印の変換");
    if (process.env.SIGMA_STUDIO_E2E_BASE_URL) expect(new URL(page.url()).origin).toBe(new URL(process.env.SIGMA_STUDIO_E2E_BASE_URL).origin);
    const snapshot = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;
    const frame = page.locator(".overlay-shape-image").first();
    await expect.poll(() => frame.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(0);
    await frame.scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    const box = (await frame.boundingBox())!;
    const clip = { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    const before = await ink(await page.screenshot({ clip }));
    await page.screenshot({ path: testInfo.outputPath("double-arrows-before.png"), clip });

    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
    await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
    await expect(page.getByTestId("svg-conversion-message")).toContainText("4個の図形に変換しました");
    await expect.poll(async () => (await snapshot()).shapes.some((shape) => shape.type === "group")).toBe(true);
    const converted = await snapshot();
    // Every arrow became a line of the editor's own, with a head at each end; nothing is left as SVG.
    expect(converted.shapes.filter((shape) => shape.type === "image")).toEqual([]);
    expect(converted.assets).toEqual({});
    expect(converted.shapes.flatMap((shape) => shape.type === "line" ? [[shape.props.kind, shape.props.arrowheadStart, shape.props.arrowheadEnd]] : []))
      .toEqual([["polyline", "triangle", "triangle"], ["polyline", "arrow", "arrow"], ["curve", "triangle", "triangle"], ["polyline", "triangle", "triangle"]]);

    // The canvas is still in shape editing, so a click on empty paper beside the drawing clears the selection
    // and only the drawing is in the picture.
    await page.mouse.click(box.x + box.width + 40, box.y + box.height / 2);
    await page.mouse.move(10, 10);
    await expect(page.locator(".overlay-selection-box")).toHaveCount(0);
    await page.waitForTimeout(500);
    const firstLine = converted.shapes.find((shape) => shape.type === "line")!;
    const lineElement = page.locator(`.overlay-shape[data-overlay-shape-id="${firstLine.id}"]`).first();
    const lineBox = (await lineElement.boundingBox())!;
    const compare = async (name: string, shift = { x: 0, y: 0 }) => {
      const shown = { ...clip, x: clip.x + shift.x, y: clip.y + shift.y };
      const png = await page.screenshot({ clip: shown });
      await page.screenshot({ path: testInfo.outputPath(`double-arrows-${name}.png`), clip: shown });
      const after = await ink(png);
      // The whole drawing is the same both ways round: nothing lost, nothing added.
      const lost = coverage(before, after), added = coverage(after, before);
      expect(lost.total).toBeGreaterThan(500);
      expect(lost.share, `${name}: ink the SVG drew`).toBeGreaterThan(0.97);
      expect(added.share, `${name}: ink the shapes drew`).toBeGreaterThan(0.97);
      for (const tip of TIPS) {
        // Around every end the ink matches, so a head turned into the line would show,
        const region = { left: tip.x - 14, top: tip.y - 14, right: tip.x + 14, bottom: tip.y + 14 };
        expect(coverage(before, after, region).share, `${name}: head at ${tip.x},${tip.y}`).toBeGreaterThan(0.95);
        expect(coverage(after, before, region).share, `${name}: head at ${tip.x},${tip.y}`).toBeGreaterThan(0.95);
        // and its tip reaches as far out of the line as the marker's did.
        expect(Math.abs(reach(after, tip) - reach(before, tip)), `${name}: tip at ${tip.x},${tip.y}`).toBeLessThanOrEqual(1);
      }
    };
    await compare("converted");

    // Saved, and the same after the desktop app reloads it.
    const roundCoordinates = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_key, child) => typeof child === "number" ? Math.round(child * 100) / 100 : child));
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.getByRole("textbox", { name: "教材タイトル" })).toHaveValue("両矢印の変換");
    expect(roundCoordinates(await snapshot())).toEqual(roundCoordinates(converted));
    await expect(page.locator(".overlay-shape-image")).toHaveCount(0);
    await lineElement.scrollIntoViewIfNeeded();
    await page.mouse.move(10, 10);
    await page.waitForTimeout(500);
    // The page may sit at another scroll position after the reload: the drawing is wherever its first line now is.
    const lineBoxAfter = (await lineElement.boundingBox())!;
    await compare("reloaded", { x: Math.round(lineBoxAfter.x - lineBox.x), y: Math.round(lineBoxAfter.y - lineBox.y) });
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
