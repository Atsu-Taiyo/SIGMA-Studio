import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { _electron as electron, expect, test, type Locator, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { waitForPagedSurfaceSettled } from "../e2e/paged-surface";

const APP_ROOT = path.resolve(__dirname, "../..");
const marks = Array.from({ length: 12 }, (_, index) => ({
  id: `label_${index}`,
  shapeId: `ellipse_${index}`,
  ink: [20, 40 + index * 15, 210],
  stroke: [210, 20 + index * 15, 40],
}));
const hex = (rgb: number[]) => `#${rgb.map(value => value.toString(16).padStart(2, "0")).join("")}`;

function fixture(orientation: "portrait" | "landscape"): SigmaDocument {
  const paragraph = (id: string, text: string) => ({ type: "paragraph" as const, id, children: [{ type: "text" as const, text }] });
  return {
    version: "2.0", docId: "b4_three_column_ellipses", metadata: { title: "B4三段組の解答解説" },
    content: Array.from({ length: 6 }, (_, index) => ({
      type: "problem" as const, id: `problem_${index}`, tags: [], lead: [], hints: [],
      // Each new problem starts in the next column; problems 4–6 exercise page 2.
      ...(index ? { pagination: { break: true } } : {}),
      prompt: [paragraph(`prompt_${index}`, `第${index + 1}問　次の式を計算しなさい。`), {
        type: "paragraph" as const, id: `math_${index}`, children: [{ type: "mathInline" as const, id: `formula_${index}`, tex: String.raw`\frac{123+x}{45-y}=\sqrt{a^2+1}`, display: "inline" as const }],
      }],
      solution: marks.slice(index * 2, index * 2 + 2).flatMap((mark, area) => [
        { type: "paragraph" as const, id: mark.id, children: [{ type: "text" as const, text: area ? "解説" : "解答", color: hex(mark.ink) }] },
        paragraph(`body_${mark.id}`, "分母をそろえて計算する。途中式と答えを確かめる。".repeat(4)),
      ]),
    })),
    outputProfiles: { student: { showSolutions: false }, teacher: { showSolutions: true }, answerBook: { showSolutions: true, onlySolutions: true } },
    pageLayout: {
      preset: "B4", orientation, pageSize: orientation === "landscape" ? { widthMm: 364, heightMm: 257 } : { widthMm: 257, heightMm: 364 },
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      flow: { type: "columns", columnCount: 3, columnGapMm: 8 },
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: marks.map(mark => ({
        id: mark.shapeId, type: "geo", x: 0, y: 0,
        anchor: { type: "block", blockId: mark.id, dx: -5, dy: -3 },
        props: { w: 65, h: 30, geo: "ellipse", fill: "none", color: hex(mark.stroke), labelColor: "#111111", dash: "solid", size: "m" },
      })) } },
    },
  };
}

type Bounds = { x: number; y: number; w: number; h: number };
type Geometry = Bounds & { page: number };

function inkBounds(data: Uint8ClampedArray, width: number, height: number, rgb: number[]): Bounds {
  let left = width, top = height, right = -1, bottom = -1;
  const darkest = rgb.indexOf(Math.min(...rgb));
  for (let y = 0; y < height; y += 1) for (let x = 0; x < width; x += 1) {
    const offset = (y * width + x) * 4;
    // Include antialiased ink blended with the white paper, not just fully
    // saturated pixels (thin Japanese strokes may contain no saturated edge).
    const alpha = (255 - data[offset + darkest]) / (255 - rgb[darkest]);
    if (alpha >= 0.3 && rgb.every((value, channel) => Math.abs(data[offset + channel] - (255 + (value - 255) * alpha)) <= 2)) {
      left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
    }
  }
  expect(right, `visible ink ${rgb}`).toBeGreaterThanOrEqual(0);
  return { x: left, y: top, w: right - left + 1, h: bottom - top + 1 };
}

async function editorGeometry(page: Page): Promise<Record<string, Geometry>> {
  const result: Record<string, Geometry> = {};
  for (const mark of marks) for (const [id, selector] of [
    [mark.id, `[data-sigma-doc-id="${mark.id}"]`],
    [mark.shapeId, `[data-overlay-shape-id="${mark.shapeId}"]`],
  ]) {
    // Scroll the body first: later-page overlays are deliberately virtualized.
    await page.locator(`.editor-canvas .page-flow [data-sigma-doc-id="${mark.id}"]`).first().scrollIntoViewIfNeeded();
    const element = page.locator(`.editor-canvas .page-canvas ${selector}`).first();
    await expect(element).toBeVisible();
    result[id] = await element.evaluate(element => {
      const canvas = element.closest<HTMLElement>(".page-canvas")!;
      const origin = canvas.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      // offsetWidth rounds B4's fractional millimetre width to an integer;
      // dividing by it creates artificial drift on later pages.
      const scale = Number(getComputedStyle(canvas).getPropertyValue("--editor-zoom")) || 1;
      const stride = Number(canvas.dataset.pageStride);
      const y = (rect.top - origin.top) / scale;
      const page = Math.floor(y / stride);
      return { page, x: (rect.left - origin.left) / scale, y: y - page * stride, w: rect.width / scale, h: rect.height / scale };
    });
  }
  return result;
}

async function previewInk(element: Locator, rgb: number[]): Promise<Bounds> {
  let result: Bounds | undefined;
  await expect(async () => { result = await previewInkSnapshot(element, rgb); }).toPass({ timeout: 10_000, intervals: [200] });
  return result!;
}

async function previewInkSnapshot(element: Locator, rgb: number[]): Promise<Bounds> {
  await element.scrollIntoViewIfNeeded();
  const position = await element.evaluate(element => {
    const paper = element.closest(".paged-surface-page")!.getBoundingClientRect();
    const box = element.getBoundingClientRect();
    const x = Math.floor(box.left), y = Math.floor(box.top);
    return { x: x - paper.left, y: y - paper.top,
      clip: { x, y, width: Math.ceil(box.right) - x, height: Math.ceil(box.bottom) - y } };
  });
  expect(position.clip.width).toBeGreaterThan(0);
  expect(position.clip.height).toBeGreaterThan(0);
  // Use an integer viewport clip, so subpixel rounding is not stretched across
  // the element's width/height by an element screenshot at fractional DPI.
  const bitmap = await loadImage(await element.page().screenshot({ clip: position.clip, scale: "css" }));
  const canvas = createCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  const ink = inkBounds(context.getImageData(0, 0, bitmap.width, bitmap.height).data, bitmap.width, bitmap.height, rgb);
  return { x: position.x + ink.x, y: position.y + ink.y, w: ink.w, h: ink.h };
}

function sameBounds(actual: Bounds, expected: Bounds, tolerance: number, label: string) {
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual[key] - expected[key]), `${label}: ${key}`).toBeLessThanOrEqual(tolerance);
}

function sameInk(actual: Bounds, expected: Bounds, label: string, tolerance = 2) {
  // Rasterizers antialias each edge independently; compare edges, not the sum
  // of two edge rounding errors as a width/height error.
  const edges = (box: Bounds) => ({ left: box.x, top: box.y, right: box.x + box.w, bottom: box.y + box.h });
  for (const key of ["left", "top", "right", "bottom"] as const) {
    expect(Math.abs(edges(actual)[key] - edges(expected)[key]), `${label}: ${key} ${JSON.stringify({actual,expected})}`).toBeLessThanOrEqual(tolerance);
  }
}

for (const orientation of ["landscape", "portrait"] as const) for (const displayScale of [1, 1.25, 1.5]) test(`B4 ${orientation} three columns: saved ellipses match editor, preview and vector PDF at ${displayScale * 100}% display scale`, async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-pdf-b4-"));
  const sourceFile = path.join(profile, "B4三段組.sigma");
  writeFileSync(sourceFile, JSON.stringify(fixture(orientation)));
  mkdirSync(path.join(profile, "data"), { recursive: true });
  writeFileSync(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const output = testInfo.outputPath("b4-three-columns.pdf");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, sourceFile, `--force-device-scale-factor=${displayScale}`], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1600, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    testInfo.annotations.push({ type: "runtime", description: JSON.stringify({
      platform: process.platform, orientation, requestedDisplayScale: displayScale,
      devicePixelRatio: await page.evaluate(() => window.devicePixelRatio),
      versions: await app.evaluate(() => process.versions),
    }) });
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    // Open through the actual file argument before bootstrap. Seeding workspace
    // through IPC during startup races the empty-document workspace save on CI.
    await expect(page.locator('.page-flow [data-sigma-doc-id="label_0"]').first()).toBeAttached({ timeout: 60_000 });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.page-flow [data-sigma-doc-id="label_0"]').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    let previous = "";
    await expect(async () => {
      let current: string;
      try {
        current = JSON.stringify(await editorGeometry(page));
      } catch (error) {
        // A late reflow may replace a target during scrolling/measurement. A
        // failed observation cannot count toward two consecutive stable samples.
        previous = "";
        throw error;
      }
      const last = previous;
      previous = current;
      expect(current).toBe(last);
    }).toPass({ timeout: 30_000, intervals: [300] });
    const editing = JSON.parse(previous) as Record<string, Geometry>;
    expect([...new Set(Object.values(editing).map(box => box.page))]).toEqual([0, 1]);
    expect(new Set(marks.slice(0, 6).map(mark => Math.round(editing[mark.id].x))).size).toBe(3);

    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    const preview = page.getByRole("dialog", { name: "PDFプレビュー" });
    await expect(preview.locator('.paged-surface[data-paged-surface-state="ready"]')).toBeVisible({ timeout: 60_000 });
    await waitForPagedSurfaceSettled(page);
    const ink: Record<string, Bounds> = {};
    const textBaselines: Record<string, number> = {};
    for (const mark of marks) for (const [id, selector, rgb] of [
      [mark.id, `[data-sigma-doc-id="${mark.id}"]`, mark.ink],
      [mark.shapeId, `[data-overlay-shape-id="${mark.shapeId}"]`, mark.stroke],
    ] as const) {
      const expected = editing[id];
      const paper = preview.locator(".paged-surface-page").nth(expected.page);
      const element = paper.locator(selector);
      await expect(element).toHaveCount(1);
      // A late anchor/font pass can replace the page window between resolving
      // the locator and evaluating its rectangle. Require a connected, settled copy.
      await expect(async () => {
        const actual = await element.evaluate(element => {
          if (!element.isConnected) throw new Error("Page window was replaced");
          const paper = element.closest(".paged-surface-page")!.getBoundingClientRect();
          const box = element.getBoundingClientRect();
          if (box.width <= 0 || box.height <= 0) throw new Error("Page window is not laid out");
          return { x: box.left - paper.left, y: box.top - paper.top, w: box.width, h: box.height };
        });
        sameBounds(actual, expected, 0.5, `editor/preview ${id}`);
      }).toPass({ timeout: 10_000, intervals: [200] });
      if (id === mark.id) textBaselines[id] = await element.evaluate(element => {
        // This is the inert page-window clone, with no editor attached. A zero-size
        // inline box exposes the text baseline without changing line layout.
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
        const paragraph = element.matches("p") ? element : element.querySelector("p");
        if (!paragraph) throw new Error("Missing label paragraph");
        paragraph.prepend(probe);
        try { return probe.getBoundingClientRect().top - element.closest(".paged-surface-page")!.getBoundingClientRect().top; }
        finally { probe.remove(); }
      });
      ink[id] = await previewInk(element, rgb);
    }

    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await preview.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(2);
      for (let index = 0; index < pdf.numPages; index += 1) {
        const pdfPage = await pdf.getPage(index + 1);
        // Supersample thin glyphs so their color isn't lost to PDF antialiasing.
        const rasterScale = 3;
        const viewport = pdfPage.getViewport({ scale: rasterScale * 96 / 72 });
        // Chromium quantizes the MediaBox; use the exporter's 0.75pt (= 1 CSS px) tolerance.
        const paperSize = fixture(orientation).pageLayout!.pageSize;
        expect(Math.abs(viewport.width / rasterScale - paperSize.widthMm * 96 / 25.4)).toBeLessThanOrEqual(1);
        expect(Math.abs(viewport.height / rasterScale - paperSize.heightMm * 96 / 25.4)).toBeLessThanOrEqual(1);
        // Text extraction also guards against replacing the output with a bitmap.
        const text = (await pdfPage.getTextContent()).items.filter(item => "str" in item);
        expect(text.length).toBeGreaterThan(10);
        const cssViewport = pdfPage.getViewport({ scale: 96 / 72 });
        for (const mark of marks.filter(mark => editing[mark.id].page === index)) {
          // PDF font subsets may split the two-character label into separate items.
          const candidates = text.filter(item => item.str.trim().startsWith("解"))
            .map(item => cssViewport.convertToViewportPoint(item.transform[4], item.transform[5]));
          const baseline = textBaselines[mark.id];
          const origin = candidates.sort((a, b) => Math.hypot(a[0] - editing[mark.id].x, a[1] - baseline) - Math.hypot(b[0] - editing[mark.id].x, b[1] - baseline))[0];
          expect(origin, `extractable text ${mark.id}`).toBeDefined();
          expect(Math.abs(origin[0] - editing[mark.id].x), `PDF text origin ${mark.id}`).toBeLessThanOrEqual(1);
          expect(Math.abs(origin[1] - baseline), `PDF text baseline ${mark.id}`).toBeLessThanOrEqual(1);
        }
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await pdfPage.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
        await testInfo.attach(`pdf-page-${index + 1}`, { body: canvas.toBuffer("image/png"), contentType: "image/png" });
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const bounds = (rgb: number[]) => {
          const box = inkBounds(pixels, canvas.width, canvas.height, rgb);
          return { x: box.x / rasterScale, y: box.y / rasterScale, w: box.w / rasterScale, h: box.h / rasterScale };
        };
        const comparisons = marks.filter(mark => editing[mark.id].page === index).flatMap(mark => [
          { id: mark.id, editor: editing[mark.id], previewInk: ink[mark.id], pdfInk: bounds(mark.ink) },
          { id: mark.shapeId, editor: editing[mark.shapeId], previewInk: ink[mark.shapeId], pdfInk: bounds(mark.stroke) },
        ]);
        await testInfo.attach(`geometry-page-${index + 1}`, { body: JSON.stringify(comparisons, null, 2), contentType: "application/json" });
        for (const comparison of comparisons) {
          // The text origin/baseline is checked above independently of glyph
          // hinting. Windows screen and PDF rasterizers can differ at an ink edge.
          sameInk(comparison.pdfInk, comparison.previewInk, `PDF ${comparison.id}`, comparison.id.startsWith("label_") ? 3 : 2);
        }
      }
      await testInfo.attach("saved-pdf", { path: output, contentType: "application/pdf" });
    } finally { await loading.destroy(); }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
