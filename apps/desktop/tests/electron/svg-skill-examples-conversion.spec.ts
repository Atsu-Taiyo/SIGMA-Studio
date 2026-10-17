import { _electron as electron, expect, test } from "@playwright/test";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { getDefaultPageLayout, type OverlaySnapshot, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const SKILL = path.join(APP_ROOT, "electron", "official-skills", "sigma-svg-figure", "SKILL.md");

/**
 * The SVG figure skill tells the AI how to draw so that "図形に変換" splits a figure completely.
 * Its examples, placed the way `insert_svg_image` places them when `w` is left out (one viewBox unit per px),
 * must convert with the canvas's real text and math measurement, leave no SVG behind, and look the same.
 */
async function skillExamples(): Promise<{ svg: string; width: number; height: number }[]> {
  const raw = await readFile(SKILL, "utf8");
  return [...raw.matchAll(/```svg\n([\s\S]*?)```/g)].map((match) => {
    const svg = match[1]!.trim();
    const [, , width, height] = /viewBox="([^"]+)"/.exec(svg)![1]!.split(/\s+/).map(Number);
    return { svg, width: width!, height: height! };
  });
}

async function ink(png: Buffer) {
  const image = await loadImage(png);
  const canvas = createCanvas(image.width, image.height), context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  const { data } = context.getImageData(0, 0, image.width, image.height);
  return { width: image.width, height: image.height, dark: Uint8Array.from({ length: image.width * image.height }, (_, i) => 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2] < 140 ? 1 : 0) };
}

/** The share of `from`'s dark pixels that have a dark pixel of `to` within 3px. */
function overlap(from: Awaited<ReturnType<typeof ink>>, to: Awaited<ReturnType<typeof ink>>) {
  const near = (x: number, y: number) => {
    for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
      const px = x + dx, py = y + dy;
      if (px >= 0 && py >= 0 && px < to.width && py < to.height && to.dark[py * to.width + px]) return true;
    }
    return false;
  };
  let total = 0, kept = 0;
  for (let y = 0; y < from.height; y++) for (let x = 0; x < from.width; x++) if (from.dark[y * from.width + x]) { total++; if (near(x, y)) kept++; }
  return { total, ratio: kept / total };
}

test("the SVG figure skill's examples convert to shapes completely and look the same", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const examples = await skillExamples();
  expect(examples.length).toBeGreaterThanOrEqual(3);
  let top = 120;
  const snapshot: OverlaySnapshot = { version: 1, shapes: [], assets: {} };
  examples.forEach(({ svg, width, height }, index) => {
    snapshot.assets[`asset-${index}`] = { id: `asset-${index}`, type: "image", props: { w: width, h: height, name: `例${index + 1}`,
      mimeType: "image/svg+xml", isAnimated: false, fileSize: svg.length, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` } };
    snapshot.shapes.push({ id: `figure-${index}`, type: "image", x: 120, y: top, props: { assetId: `asset-${index}`, w: width, h: height } });
    top += height + 40;
  });
  const document: SigmaDocument = { version: "2.0", docId: "svg-skill-examples", metadata: { title: "スキルの例の変換" },
    content: [{ type: "paragraph", id: "p", children: [{ type: "text", text: "スキルのSVGの例を図形に変換する" }] }],
    pageLayout: { ...getDefaultPageLayout(), overlay: { overlaySnapshot: snapshot } }, outputProfiles: { student: {}, teacher: {}, answerBook: {} } };

  const profile = await mkdtemp(path.join(tmpdir(), "sigma-svg-skill-"));
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
    const fileId = await page.evaluate(async (doc) => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const created = await window.desktopAPI!.storage.createFileFromDocument({ document: doc });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [created.file.fileId], activeFileId: created.file.fileId });
      return created.file.fileId;
    }, document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const saved = async () => (await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId))!.pageLayout!.overlay!.overlaySnapshot!;

    for (const [index] of examples.entries()) {
      const id = `figure-${index}`;
      const frame = page.locator(`.overlay-shape-image[data-overlay-shape-id="${id}"]`);
      await expect.poll(() => frame.locator("img").evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth)).toBeGreaterThan(0);
      await frame.scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      const box = (await frame.boundingBox())!;
      const clip = { x: Math.round(box.x) - 4, y: Math.round(box.y) - 4, width: Math.round(box.width) + 8, height: Math.round(box.height) + 8 };
      await page.mouse.move(20, 100);
      const before = await page.screenshot({ clip, path: testInfo.outputPath(`example-${index + 1}-before.png`) });
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2, { button: "right" });
      await page.getByRole("menuitem", { name: "図形に変換", exact: true }).click();
      const message = page.getByTestId("svg-conversion-message");
      await expect(message).toContainText("個の図形に変換しました");
      // Nothing is kept as SVG: the "partial" message names what stayed an image.
      await expect(message).not.toContainText("SVG画像として保持しました");
      await expect.poll(async () => (await saved()).shapes.find((shape) => shape.id === id)?.type).toBe("group");
      // Deselect, so the selection frame is not in the picture.
      await page.keyboard.press("Escape");
      await page.mouse.click(box.x + box.width + 30, box.y + 20);
      await page.mouse.move(20, 100);
      await expect(page.locator(".overlay-selection-box")).toBeHidden();
      await page.waitForTimeout(500);
      const after = await page.screenshot({ clip, path: testInfo.outputPath(`example-${index + 1}-after.png`) });
      const [a, b] = [await ink(before), await ink(after)];
      const kept = overlap(a, b), extra = overlap(b, a);
      expect(kept.total).toBeGreaterThan(200);
      // What the SVG showed is what the shapes show, to within stroke widths, arrow heads and text metrics, and nothing is added.
      expect(kept.ratio, `example ${index + 1}: ink of the SVG found after conversion`).toBeGreaterThan(0.95);
      expect(extra.ratio, `example ${index + 1}: ink after conversion found in the SVG`).toBeGreaterThan(0.95);
    }

    const converted = await saved();
    expect(converted.shapes.filter((shape) => shape.type === "image")).toEqual([]);
    expect(Object.keys(converted.assets)).toEqual([]);
    const lines = converted.shapes.flatMap((shape) => shape.type === "line" ? [shape] : []);
    expect(lines.some((line) => line.props.kind === "curve")).toBe(true);
    expect(lines.filter((line) => line.props.arrowheadEnd).length).toBe(3);
    expect(converted.shapes.some((shape) => shape.type === "text"
      && shape.props.blocks.some((block) => block.type === "paragraph" && block.children.some((child) => child.type === "mathInline")))).toBe(true);

    // The converted figures are what reopening the material shows.
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator(".overlay-shape-image")).toHaveCount(0);
    await expect(page.locator(".overlay-shape-text").first()).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await app.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
