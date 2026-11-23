import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";
import { handleSessionPrompts } from "./session-prompts";

const APP_ROOT = path.resolve(__dirname, "../..");

/** Synthetic only: roughly the vector count of a large import, across 51 pages. */
function vectorDocument(): SigmaDocument {
  return {
    version: "2.0", docId: "synthetic_asset_readiness", metadata: { title: "Large vector readiness" },
    content: Array.from({ length: 51 }, (_, index) => ({
      type: "paragraph", id: `page_${index}`, ...(index ? { pagination: { break: true } } : {}),
      children: [{ type: "text", text: `Synthetic page ${index + 1}` }],
    })),
    outputProfiles: { student: { showSolutions: false }, teacher: { showSolutions: true }, answerBook: { showSolutions: true } },
    pageLayout: {
      preset: "A4", orientation: "portrait", pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 }, flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: Array.from({ length: 21_124 }, (_, index) => ({
        id: `vector_${index}`, type: "line", x: 60 + index % 20 * 22, y: 90 + Math.floor(index % 415 / 20) * 22,
        anchor: { type: "block", blockId: `page_${Math.min(50, Math.floor(index / 415))}`, dy: 30 + Math.floor(index % 415 / 20) * 22 },
        props: { points: [{ x: 0, y: 0 }, { x: 12, y: 1 }], closed: false, color: "#111111", dash: "solid", size: "s" },
      })) } },
    },
  };
}

test("large vector measurement and normal PDF preview recover after delayed FontFaceSet readiness", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-print-assets-"));
  const source = path.join(profile, "synthetic.sigma");
  const value = vectorDocument();
  writeFileSync(source, JSON.stringify(value));
  mkdirSync(path.join(profile, "data"));
  writeFileSync(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  const app = await electron.launch({ args: [APP_ROOT, source], cwd: APP_ROOT, env });
  // Model a late FontFaceSet completion without owner fonts or network dependencies.
  const delayFonts = () => {
    const ready = document.fonts.ready;
    const delayed = Promise.all([ready, new Promise(resolve => setTimeout(resolve, 16_000))]).then(() => document.fonts);
    Object.defineProperty(document.fonts, "ready", { configurable: true, get: () => delayed });
  };
  try {
    const page = await app.firstWindow();
    await handleSessionPrompts(page);
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:usage-guide-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.locator('[data-startup-splash]')).toBeHidden({ timeout: 60_000 });
    await expect(page.locator('.editor-canvas [data-page-count="51"]').first()).toBeAttached({ timeout: 60_000 });
    await app.context().addInitScript(delayFonts);
    const started = Date.now();
    const measurement = await app.evaluate(async ({ app }, value) => {
      const host = process.mainModule!.require(app.getAppPath() + "/dist-electron/main.cjs") as { measurePluginDocument: (doc: unknown, ids: string[]) => Promise<{ pageCount: number }> };
      return host.measurePluginDocument(value, ["page_0", "page_50"]);
    }, value);
    expect(measurement.pageCount).toBe(51);
    expect(Date.now() - started).toBeGreaterThanOrEqual(16_000);
    await page.evaluate(delayFonts);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.send("menu:action", "print-document"));
    const preview = page.getByRole("dialog", { name: "PDFプレビュー" });
    const surface = preview.locator(".paged-surface");
    await expect(surface).toHaveAttribute("data-paged-surface-state", "pending");
    await expect(surface).toHaveAttribute("data-paged-surface-state", "ready", { timeout: 65_000 });
    await expect(surface).toHaveAttribute("data-paged-surface-page-count", "51");
    await expect(preview.locator(".paged-surface-page")).toHaveCount(51);
    await expect(preview.getByRole("button", { name: "PDF保存", exact: true })).toBeEnabled();
    await testInfo.attach("large-vector-ready", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
