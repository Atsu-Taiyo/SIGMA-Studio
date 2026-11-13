import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import type { ParagraphNode, SigmaDocument } from "@/features/document";
import { waitForPagedSurfaceSettled } from "../e2e/paged-surface";

const APP_ROOT = path.resolve(__dirname, "../..");
const regions = [0, 0, 1, 2, 3, 4, 4];
type Scenario = { paper: "A4" | "B4"; columns: number; orientation: "portrait" | "landscape"; hideLead?: boolean };
type Box = { x: number; y: number; w: number; h: number };
type NumberBox = Box & { number: string; page: number };

/** No assets, benchmark code, or #425 dependencies: consecutive problems plus manual breaks. */
function fixture(scenario: Scenario): SigmaDocument {
  const paragraph = (id: string, text: string): ParagraphNode => ({ type: "paragraph", id, children: [{ type: "text", text }] });
  return {
    version: "2.0", docId: "problem_number_page_break", metadata: { title: "改ページ直後の番号枠" },
    content: regions.map((_, index) => ({
      type: "problem", id: `q${index}`, tags: [],
      // A break at the very start must not introduce a blank page/column.
      ...(index === 0 || (index >= 2 && index <= 5) ? { pagination: { break: true } } : {}),
      ...(scenario.hideLead ? { areaLayout: { lead: { hidden: true } } } : {}),
      numbering: { fontSize: index === 3 ? 28 : 12 },
      lead: scenario.hideLead || index === 4 ? [] : [paragraph(`lead_${index}`, "次の問いに答えよ。")],
      prompt: [paragraph(`prompt_${index}`, "式を計算しなさい。")], solution: [], hints: [],
    })),
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: scenario.paper, orientation: scenario.orientation,
      pageSize: scenario.paper === "A4" ? { widthMm: 210, heightMm: 297 }
        : scenario.orientation === "portrait" ? { widthMm: 257, heightMm: 364 } : { widthMm: 364, heightMm: 257 },
      marginsMm: { top: 16, right: 16, bottom: 16, left: 16 },
      flow: { type: "columns", columnCount: scenario.columns, columnGapMm: 8 },
    },
  };
}

async function savedDocument(page: Page, fileId: string) {
  return page.evaluate(async id => {
    const saved = await window.desktopAPI!.storage.loadDocument(id);
    // An autosave flush can update the timestamp without changing the document.
    if (saved) delete saved.updatedAt;
    return saved;
  }, fileId);
}

async function editorNumbers(page: Page): Promise<NumberBox[]> {
  return page.locator(".editor-canvas .page-canvas").evaluate(canvas => {
    const origin = canvas.getBoundingClientRect();
    const scale = Number(getComputedStyle(canvas).getPropertyValue("--editor-zoom")) || 1;
    const stride = Number((canvas as HTMLElement).dataset.pageStride);
    return Array.from(canvas.querySelectorAll<HTMLElement>(".problem-number-marker"), marker => {
      const rect = marker.getBoundingClientRect();
      const y = (rect.top - origin.top) / scale;
      const page = Math.floor(y / stride);
      return { number: marker.textContent!.trim(), page, x: (rect.left - origin.left) / scale, y: y - page * stride, w: rect.width / scale, h: rect.height / scale };
    });
  });
}

function sameBox(actual: Box, expected: Box, tolerance: number) {
  for (const key of ["x", "y", "w", "h"] as const) expect(Math.abs(actual[key] - expected[key]), `${key}: ${JSON.stringify({ actual, expected })}`).toBeLessThanOrEqual(tolerance);
}

/** Include the actual border pixels, not just the extracted numeral or source DOM. */
function frameInk(pixels: Uint8ClampedArray, width: number, height: number, box: Box, scale: number): Box {
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = Math.max(0, Math.floor((box.y - 3) * scale)); y < Math.min(height, Math.ceil((box.y + box.h + 3) * scale)); y++) {
    for (let x = Math.max(0, Math.floor((box.x - 3) * scale)); x < Math.min(width, Math.ceil((box.x + box.w + 3) * scale)); x++) {
      const offset = (y * width + x) * 4;
      if (pixels[offset] < 180 && pixels[offset + 1] < 180 && pixels[offset + 2] < 180) {
        left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
      }
    }
  }
  expect(right, `number frame at ${JSON.stringify(box)}`).toBeGreaterThanOrEqual(0);
  return { x: left / scale, y: top / scale, w: (right - left + 1) / scale, h: (bottom - top + 1) / scale };
}

for (const scenario of [
  { paper: "A4", columns: 1, orientation: "portrait" },
  { paper: "A4", columns: 1, orientation: "portrait", hideLead: true },
  { paper: "B4", columns: 3, orientation: "portrait" },
  { paper: "B4", columns: 3, orientation: "landscape" },
] satisfies Scenario[]) test(`${scenario.paper} ${scenario.orientation} ${scenario.columns} columns${scenario.hideLead ? " hidden lead" : ""}: number frames stay on their assigned preview/PDF page`, async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-problem-break-"));
  const source = path.join(profile, "problem-break.sigma");
  const output = testInfo.outputPath("problem-break.pdf");
  writeFileSync(source, JSON.stringify(fixture(scenario)));
  mkdirSync(path.join(profile, "data"));
  writeFileSync(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, source, "--force-color-profile=srgb"], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1600, 1100));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await expect(page.locator('.editor-canvas [data-sigma-doc-id="prompt_0"]').first()).toBeAttached({ timeout: 60_000 });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await page.evaluate(() => document.fonts.ready);
    const persisted = await page.evaluate(async () => {
      for (const file of await window.desktopAPI!.storage.listFiles()) {
        const document = await window.desktopAPI!.storage.loadDocument(file.fileId);
        // Workspace bootstrap assigns a new docId to an imported document.
        if (document?.content.some(block => block.id === "q0")) {
          delete document.updatedAt;
          return { fileId: file.fileId, document };
        }
      }
      throw new Error("Saved regression fixture not found");
    });
    let editing: NumberBox[] = [];
    let previous = "";
    await expect(async () => {
      editing = await editorNumbers(page);
      expect(editing).toHaveLength(regions.length);
      const current = JSON.stringify(editing);
      const last = previous;
      previous = current;
      expect(current).toBe(last);
    }).toPass({ timeout: 20_000, intervals: [300] });
    expect(editing.map(box => box.page)).toEqual(regions.map(region => Math.floor(region / scenario.columns)));
    const size = fixture(scenario).pageLayout!.pageSize;
    const columnWidth = ((size.widthMm - 32) - (scenario.columns - 1) * 8) * 96 / 25.4 / scenario.columns;
    for (const [index, box] of editing.entries()) {
      expect(Math.abs(box.x - (16 * 96 / 25.4 + (regions[index] % scenario.columns) * (columnWidth + 8 * 96 / 25.4)))).toBeLessThan(0.5);
    }

    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    await expect(page.locator('.paged-surface[data-paged-surface-state="ready"]')).toBeVisible({ timeout: 60_000 });
    await waitForPagedSurfaceSettled(page);
    const preview: NumberBox[] = [];
    for (const [index, box] of editing.entries()) {
      const marker = page.locator(".paged-surface-page").nth(box.page).locator(`section[data-problem-id="q${index}"] > .problem-area-paper-content > .problem-number-marker`);
      const actual = await marker.evaluate(element => {
        const origin = element.closest(".paged-surface-page")!.getBoundingClientRect();
        const rect = element.getBoundingClientRect();
        return { x: rect.left - origin.left, y: rect.top - origin.top, w: rect.width, h: rect.height };
      });
      sameBox(actual, box, 0.5);
      preview.push({ ...box, ...actual });
    }
    await page.screenshot({ path: testInfo.outputPath("desktop-preview.png") });
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    const comparisons: { number: string; page: number; preview: Box; pdf: Box }[] = [];
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(Math.floor(Math.max(...regions) / scenario.columns) + 1);
      for (let index = 0; index < pdf.numPages; index++) {
        const pdfPage = await pdf.getPage(index + 1);
        const expected = preview.filter(box => box.page === index);
        const text = (await pdfPage.getTextContent()).items.flatMap(item => "str" in item && /^\d+$/.test(item.str.trim()) ? [item.str.trim()] : []);
        expect(text, `exactly the assigned numbers on PDF page ${index + 1}`).toEqual(expected.map(box => box.number));
        const scale = 2;
        const viewport = pdfPage.getViewport({ scale: scale * 96 / 72 });
        const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
        const context = canvas.getContext("2d");
        await pdfPage.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
        writeFileSync(testInfo.outputPath(`pdf-page-${index + 1}.png`), canvas.toBuffer("image/png"));
        for (const box of expected) {
          const ink = frameInk(pixels, canvas.width, canvas.height, box, scale);
          sameBox(ink, box, 1.5);
          comparisons.push({ number: box.number, page: index + 1, preview: box, pdf: ink });
        }
      }
      const coordinates = testInfo.outputPath("number-frame-coordinates.json");
      writeFileSync(coordinates, JSON.stringify(comparisons, null, 2));
      await testInfo.attach("number-frame-coordinates", { path: coordinates, contentType: "application/json" });
      await testInfo.attach("saved-pdf", { path: output, contentType: "application/pdf" });
    } finally { await loading.destroy(); }
    // Export must clean up its hidden window and leave the editing canvas intact.
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    expect(await editorNumbers(page)).toEqual(editing);
    expect(await savedDocument(page, persisted.fileId)).toEqual(persisted.document);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect.poll(() => editorNumbers(page)).toEqual(editing);
    expect(await savedDocument(page, persisted.fileId)).toEqual(persisted.document);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
