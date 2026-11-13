import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { BENCHMARK_TIKZ, pdfBenchmarkFixture } from "./pdf-export-benchmark.fixture";

// Trace and failed locator expectations can snapshot the whole DOM during export.
// Keep tracing off and use waitForFunction for pending UI so it cannot distort timings.
test.use({ trace: "off", screenshot: "off" });

const ROOT = path.resolve(__dirname, "../..");
const pages = (process.env.SIGMA_PDF_BENCH_PAGES ?? "10,20,40").split(",").map(Number);
const repeats = Number(process.env.SIGMA_PDF_BENCH_REPEATS ?? "1");

for (const count of pages) for (let run = 0; run < repeats; run++) test(`PDF benchmark ${count} pages run ${run + 1}`, async ({}, info) => {
  test.skip(process.env.SIGMA_PDF_BENCH !== "1", "Opt-in benchmark; see docs/pdf-export-performance.md");
  test.setTimeout(900_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-pdf-benchmark-"));
  mkdirSync(path.join(profile, "data"));
  writeFileSync(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env: Record<string, string> = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)), SIGMA_STUDIO_USER_DATA_DIR: profile, SIGMA_STUDIO_PDF_PROFILE: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [ROOT], cwd: ROOT, env });
  let logs = "";
  app.on("console", message => { logs += message.text() + "\n"; writeFileSync(info.outputPath("main.log"), logs); });
  app.process().stdout?.on("data", chunk => { logs += chunk.toString(); writeFileSync(info.outputPath("main.log"), logs); });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1000));
    const tikzStart = performance.now();
    const rendered = await page.evaluate(input => window.desktopAPI!.tikz!.render(input), BENCHMARK_TIKZ);
    const tikzMs = performance.now() - tikzStart;
    if (!rendered.ok) throw new Error(JSON.stringify(rendered));
    const doc = pdfBenchmarkFixture(count, rendered.image);
    writeFileSync(info.outputPath("fixture.sigma"), JSON.stringify(doc));
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, doc);
    await page.reload();
    await expect(page.locator('.editor-canvas [data-sigma-doc-id="label_0"]').first()).toBeAttached({ timeout: 120_000 });
    await expect(page.locator(".startup-splash")).toBeHidden();
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Profiler.enable");
    await cdp.send("Profiler.start");
    const previewStart = performance.now();
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    await page.waitForFunction(() => document.querySelector('.paged-surface[data-paged-surface-state="ready"]'), null, { timeout: 300_000 });
    await expect(page.locator(".paged-surface-page")).toHaveCount(count);
    // Ensure late decorating passes have stopped; exclude this probe delay from previewMs.
    const previewMs = performance.now() - previewStart;
    let previous = "", stable = 0;
    const settleDeadline = Date.now() + 120_000;
    while (stable < 4) {
      if (Date.now() > settleDeadline) throw new Error("Preview revision did not settle");
      const revision = await page.locator(".paged-surface").getAttribute("data-paged-surface-revision");
      stable = revision === previous ? stable + 1 : 0; previous = revision ?? "";
      await page.waitForTimeout(250);
    }
    const previewProfile = await cdp.send("Profiler.stop");
    writeFileSync(info.outputPath("preview.cpuprofile"), JSON.stringify(previewProfile.profile));
    const counters = await page.evaluate(() => ({
      performance: window.__SIGMA_STUDIO_PERFORMANCE__,
      nodes: document.querySelectorAll(".paged-surface-pages *").length,
      firstPageNodes: document.querySelector(".paged-surface-page")?.querySelectorAll("*").length,
      htmlBytes: document.querySelector(".paged-surface-page")?.outerHTML.length,
    }));
    if (!process.env.SIGMA_STUDIO_E2E_BASE_URL) expect(counters.performance?.productionBuild).toBe(true);
    const output = info.outputPath("workbook.pdf");
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await cdp.send("Profiler.start");
    const saveStart = performance.now();
    await page.locator(".print-preview-toolbar").getByRole("button", { name: "PDF保存", exact: true }).click();
    await page.waitForFunction(() => document.querySelector(".pdf-export-success-dialog"), null, { timeout: 600_000 });
    const saveMs = performance.now() - saveStart;
    const saveProfile = await cdp.send("Profiler.stop");
    writeFileSync(info.outputPath("save.cpuprofile"), JSON.stringify(saveProfile.profile));
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(count);
      for (let index = 1; index <= count; index++) {
        const paper = await pdf.getPage(index);
        expect(paper.view[2]).toBeCloseTo(210 / 25.4 * 72, 2);
        expect(paper.view[3]).toBeCloseTo(297 / 25.4 * 72, 2);
        const text = (await paper.getTextContent()).items.filter(item => "str" in item).map(item => "str" in item ? item.str : "").join("");
        expect(text).toContain(`BENCH-${index}:`);
      }
    } finally { await loading.destroy(); }
    const saved = await page.evaluate(fileId => window.desktopAPI!.storage.loadDocument(fileId), fileId);
    expect(saved?.content).toEqual(doc.content);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
    const result = { count, run: run + 1, tikzMs, previewMs, saveMs, ...counters,
      profiles: logs.split("\n").filter(line => line.includes("[pdf-profile] ")).map(line => JSON.parse(line.slice(line.indexOf("[pdf-profile] ") + 14))),
    };
    writeFileSync(info.outputPath("metrics.json"), JSON.stringify(result, null, 2));
    writeFileSync(info.outputPath("main.log"), logs);
    console.log(JSON.stringify({ count, run: run + 1, tikzMs, previewMs, saveMs, nodes: counters.nodes }));
    await page.screenshot({ path: info.outputPath("desktop.png") });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
