import { expect, test, type Page, type TestInfo } from "@playwright/test";

import {
  createLargePerformanceDocument,
  LARGE_PERFORMANCE_TARGET_PAGES,
  LARGE_PERFORMANCE_TEXT_BLOCKS,
  LARGE_PERFORMANCE_TOTAL_OVERLAY_SHAPES,
} from "../fixtures/large-performance-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const MIN_LARGE_DOCUMENT_PAGES = 30;
const MAX_INITIAL_MOUNTED_SHEETS = 12;
const MAX_SCROLLED_MOUNTED_SHEETS = 16;
const MAX_MOUNTED_OVERLAY_SHAPES = 260;
const REQUIRED_RENDER_MEASURE_NAMES = [
  "PageCanvasEditor.computeColumnUnitLayouts",
  "PageCanvasEditor.createResolvedOverlayView",
] as const;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("large two-column document keeps heavy layers windowed", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await installDesktopRuntimeMock(page, createLargePerformanceDocument());

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(appUrl("/"), { timeout: 60_000, waitUntil: "domcontentloaded" });
  await expect.poll(
    async () => page.locator('[data-sigma-doc-id^="perf_block_"]').count(),
    { timeout: 60_000 },
  ).toBeGreaterThanOrEqual(LARGE_PERFORMANCE_TEXT_BLOCKS);
  await expect.poll(
    async () => (await readWindowProof(page)).mountedOverlayShapes,
    { timeout: 30_000 },
  ).toBeGreaterThan(0);

  const initialProof = await readWindowProof(page);
  assertWindowedProof(initialProof, {
    maxMountedSheets: MAX_INITIAL_MOUNTED_SHEETS,
    maxMountedOverlayShapes: MAX_MOUNTED_OVERLAY_SHAPES,
  });

  const renderTimingStats = await readRenderTimingStats(page);
  for (const stat of renderTimingStats) {
    expect(Number.isFinite(stat.minMs), `${stat.name} minimum duration is finite`).toBe(true);
    expect(Number.isFinite(stat.maxMs), `${stat.name} maximum duration is finite`).toBe(true);
    expect(Number.isFinite(stat.totalMs), `${stat.name} total duration is finite`).toBe(true);
    expect(stat.minMs, `${stat.name} minimum duration`).toBeGreaterThanOrEqual(0);
    expect(stat.maxMs, `${stat.name} maximum duration`).toBeGreaterThanOrEqual(stat.minMs);
    expect(stat.totalMs, `${stat.name} total duration`).toBeGreaterThanOrEqual(stat.maxMs);
    expect(Number.isFinite(stat.averageMs), `${stat.name} average duration`).toBe(true);
    expect(stat.latestAt, `${stat.name} latest timestamp`).toBeGreaterThanOrEqual(0);
  }

  const postMeasureProof = await readWindowProof(page);
  assertWindowedProof(postMeasureProof, {
    maxMountedSheets: MAX_SCROLLED_MOUNTED_SHEETS,
    maxMountedOverlayShapes: MAX_MOUNTED_OVERLAY_SHAPES,
  });

  await page.locator(".editor-canvas").evaluate((element) => {
    element.scrollTo({ top: element.scrollHeight * 0.52 });
  });
  await page.waitForTimeout(350);

  const scrolledProof = await readWindowProof(page);
  assertWindowedProof(scrolledProof, {
    maxMountedSheets: MAX_SCROLLED_MOUNTED_SHEETS,
    maxMountedOverlayShapes: MAX_MOUNTED_OVERLAY_SHAPES,
  });

  const perf = await page.evaluate(() => ({
    counters: window.__SIGMA_STUDIO_PERFORMANCE__?.counters ?? {} as Record<string, number>,
  }));
  expect(perf.counters["PageCanvasEditor.render"] ?? 0).toBeGreaterThan(0);
  expect(perf.counters["OverlayShapeView.render"] ?? 0).toBeGreaterThan(0);
  await attachPerformanceReport(testInfo, {
    initialProof,
    postMeasureProof,
    renderTimingStats,
    scrolledProof,
  });

  expect(consoleErrors).toEqual([]);
});

test("typing into a large document re-measures only the edited block, not the whole doc", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await installDesktopRuntimeMock(page, createLargePerformanceDocument());

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(appUrl("/"), { timeout: 60_000, waitUntil: "domcontentloaded" });
  await expect.poll(
    async () => page.locator('[data-sigma-doc-id^="perf_block_"]').count(),
    { timeout: 60_000 },
  ).toBeGreaterThanOrEqual(LARGE_PERFORMANCE_TEXT_BLOCKS);

  // Let layout settle (fonts/images load and re-measure) before sampling, so
  // the post-edit delta reflects the edit alone, not async mount churn.
  await waitForLineBoxMeasureStable(page);

  // The cold pass must have line-measured at least the whole document once —
  // this is the O(n)-per-keystroke cost the cache is built to eliminate.
  const coldLineBoxMeasures = await readCounter(page, "PageCanvasEditor.lineBoxMeasure");
  expect(coldLineBoxMeasures).toBeGreaterThanOrEqual(LARGE_PERFORMANCE_TEXT_BLOCKS);

  // Type into the first body block, enough characters to force it to wrap onto
  // new lines (so its measured height genuinely changes and it must re-measure).
  const firstBlock = page.locator('.page-flow .ProseMirror > [data-sigma-doc-id^="perf_block_"]').first();
  await firstBlock.click();
  await page.keyboard.press("End");

  const beforeEdit = await readCounter(page, "PageCanvasEditor.lineBoxMeasure");
  await page.keyboard.type("追記テキストを十分な長さで入力して行の折り返しと再測定を発生させる。".repeat(3), { delay: 5 });
  await waitForLineBoxMeasureStable(page);
  const afterEdit = await readCounter(page, "PageCanvasEditor.lineBoxMeasure");

  const editLineBoxMeasures = afterEdit - beforeEdit;

  await testInfo.attach("incremental-line-measure.json", {
    body: JSON.stringify(
      { coldLineBoxMeasures, beforeEdit, afterEdit, editLineBoxMeasures, totalTextBlocks: LARGE_PERFORMANCE_TEXT_BLOCKS },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // The edit must NOT re-measure the whole document. A handful of re-measures
  // (the edited block as it grows line by line) is expected; anything close to
  // the block count would mean the cache is not working.
  expect(editLineBoxMeasures).toBeGreaterThan(0);
  expect(editLineBoxMeasures).toBeLessThan(Math.floor(LARGE_PERFORMANCE_TEXT_BLOCKS / 4));

  // The edited text must actually be in the document.
  await expect(firstBlock).toContainText("追記テキスト");

  expect(consoleErrors).toEqual([]);
});

test("typing defers pagination off the keystroke path instead of recomputing synchronously", async ({ page }) => {
  test.setTimeout(120_000);
  page.setDefaultTimeout(30_000);
  await page.setViewportSize({ width: 1440, height: 1040 });
  await installDesktopRuntimeMock(page, createLargePerformanceDocument());

  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });

  await page.goto(appUrl("/"), { timeout: 60_000, waitUntil: "domcontentloaded" });
  await expect.poll(
    async () => page.locator('[data-sigma-doc-id^="perf_block_"]').count(),
    { timeout: 60_000 },
  ).toBeGreaterThanOrEqual(LARGE_PERFORMANCE_TEXT_BLOCKS);
  await waitForLineBoxMeasureStable(page);

  // Mount and font/metrics settling go through the synchronous (pre-paint) path.
  expect(await readCounter(page, "PageCanvasEditor.syncRecompute")).toBeGreaterThan(0);

  const firstBlock = page.locator('.page-flow .ProseMirror > [data-sigma-doc-id^="perf_block_"]').first();
  await firstBlock.click();
  await page.keyboard.press("End");

  const syncBefore = await readCounter(page, "PageCanvasEditor.syncRecompute");
  const deferredBefore = await readCounter(page, "PageCanvasEditor.deferredRecompute");

  await page.keyboard.type("段組み本文への連続入力で再ページ送りが遅延実行されることを確認する。".repeat(2), { delay: 8 });
  // Confirm the controlled editor has committed the keystrokes before waiting
  // for the post-paint pagination task. Line-box stability can happen in the
  // short window before that deferred task increments its counter.
  await expect(firstBlock).toContainText("段組み本文への連続入力");
  await expect.poll(
    async () => readCounter(page, "PageCanvasEditor.deferredRecompute"),
    { timeout: 30_000, intervals: [50, 100, 200, 400] },
  ).toBeGreaterThan(deferredBefore);
  await waitForLineBoxMeasureStable(page);

  const syncAfter = await readCounter(page, "PageCanvasEditor.syncRecompute");
  const deferredAfter = await readCounter(page, "PageCanvasEditor.deferredRecompute");

  // Typing must drive the deferred (post-paint) path...
  expect(deferredAfter).toBeGreaterThan(deferredBefore);
  // ...and must NOT trigger any synchronous, paint-blocking recompute.
  expect(syncAfter).toBe(syncBefore);

  expect(consoleErrors).toEqual([]);
});

async function readCounter(page: Page, name: string): Promise<number> {
  return page.evaluate(
    (counterName) => window.__SIGMA_STUDIO_PERFORMANCE__?.counters?.[counterName] ?? 0,
    name,
  );
}

async function waitForLineBoxMeasureStable(page: Page): Promise<void> {
  let previous = -1;
  await expect.poll(
    async () => {
      const current = await readCounter(page, "PageCanvasEditor.lineBoxMeasure");
      const stable = current === previous;
      previous = current;
      return stable;
    },
    { timeout: 30_000, intervals: [400, 400, 400] },
  ).toBe(true);
}

function assertWindowedProof(
  proof: WindowProof,
  options: { maxMountedOverlayShapes: number; maxMountedSheets: number },
): void {
  expect(proof.totalOverlayShapes).toBe(LARGE_PERFORMANCE_TOTAL_OVERLAY_SHAPES);
  expect(proof.estimatedPageCount).toBeGreaterThanOrEqual(MIN_LARGE_DOCUMENT_PAGES);
  expect(proof.estimatedPageCount).toBeGreaterThanOrEqual(LARGE_PERFORMANCE_TARGET_PAGES);
  expect(proof.sheetCount).toBeGreaterThan(0);
  expect(proof.sheetCount).toBeLessThan(proof.estimatedPageCount);
  expect(proof.sheetCount).toBeLessThanOrEqual(options.maxMountedSheets);
  expect(proof.mountedOverlayShapes).toBeGreaterThan(0);
  expect(proof.mountedOverlayShapes).toBeLessThan(proof.totalOverlayShapes);
  expect(proof.mountedOverlayShapes).toBeLessThanOrEqual(Math.floor(proof.totalOverlayShapes / 2));
  expect(proof.mountedOverlayShapes).toBeLessThanOrEqual(options.maxMountedOverlayShapes);
}

async function readRenderTimingStats(page: Page): Promise<RenderTimingStat[]> {
  return page.evaluate((measureNames) => {
    const measures = window.__SIGMA_STUDIO_PERFORMANCE__?.measures ?? [];
    return measureNames.map((name) => {
      const entries = measures.filter((measure) => measure.name === name);
      const durations = entries.map((measure) => measure.duration);
      const totalMs = durations.reduce((sum, duration) => sum + duration, 0);
      return {
        name,
        count: entries.length,
        minMs: durations.length > 0 ? Math.min(...durations) : 0,
        maxMs: durations.length > 0 ? Math.max(...durations) : 0,
        totalMs,
        averageMs: durations.length > 0 ? totalMs / durations.length : 0,
        latestAt: entries.reduce((latest, measure) => Math.max(latest, measure.at), 0),
      };
    });
  }, Array.from(REQUIRED_RENDER_MEASURE_NAMES));
}

async function attachPerformanceReport(
  testInfo: TestInfo,
  report: {
    initialProof: WindowProof;
    postMeasureProof: WindowProof;
    renderTimingStats: RenderTimingStat[];
    scrolledProof: WindowProof;
  },
): Promise<void> {
  await testInfo.attach("large-document-performance.json", {
    body: JSON.stringify(report, null, 2),
    contentType: "application/json",
  });
}

type RenderTimingStat = {
  name: string;
  count: number;
  minMs: number;
  maxMs: number;
  totalMs: number;
  averageMs: number;
  latestAt: number;
};

type WindowProof = {
  estimatedPageCount: number;
  mountedOverlayShapes: number;
  sheetCount: number;
  totalOverlayShapes: number;
};

async function readWindowProof(page: Page): Promise<WindowProof> {
  const proof = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    const pageHeight = canvas ? parseFloat(getComputedStyle(canvas).getPropertyValue("--page-height")) : 0;
    const pageGap = canvas ? parseFloat(getComputedStyle(canvas).getPropertyValue("--page-gap")) : 0;
    const canvasHeight = canvas?.offsetHeight ?? 0;
    const pageStride = pageHeight + pageGap;
    const mountedOverlayShapeIds = new Set(
      Array.from(document.querySelectorAll('.page-overlay-preview [data-overlay-shape-id^="perf_"]'))
        .map((element) => element.getAttribute("data-overlay-shape-id"))
        .filter((shapeId): shapeId is string => Boolean(shapeId)),
    );

    return {
      estimatedPageCount: pageStride > 0 ? Math.round((canvasHeight + pageGap) / pageStride) : 0,
      mountedOverlayShapes: mountedOverlayShapeIds.size,
      sheetCount: document.querySelectorAll(".page-backdrop .a4-page-sheet").length,
    };
  });
  return {
    ...proof,
    totalOverlayShapes: LARGE_PERFORMANCE_TOTAL_OVERLAY_SHAPES,
  };
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}
