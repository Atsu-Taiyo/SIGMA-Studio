import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import type { ParagraphNode, SigmaDocument } from "@/features/document";
import { waitForPagedSurfaceSettled } from "../e2e/paged-surface";

const APP_ROOT = path.resolve(__dirname, "../..");
const legacySerif = '"Yu Mincho", YuMincho, "Hiragino Mincho ProN", "BIZ UDPMincho", serif';

function fixture(): SigmaDocument {
  const label = (index: number): ParagraphNode => ({
    type: "paragraph", id: `label_${index}`, lineHeight: "1.35",
    children: [{ type: "text", text: `PARITY-${index}: 解答と解説`, fontFamily: legacySerif, fontSize: 8 }],
  });
  return {
    version: "2.0", docId: "continuous_pdf_parity", metadata: { title: "Continuous flow PDF parity" },
    content: Array.from({ length: 6 }, (_, column) => [
      { ...label(column * 2), ...(column ? { pagination: { break: true } } : {}) },
      ...Array.from({ length: 12 }, (_, row): ParagraphNode => ({
        type: "paragraph", id: `body_${column}_${row}`, lineHeight: "1.35", spaceAfterPx: 0.5,
        children: [
          { type: "text", text: "分母をそろえて途中式と答えを確かめる。", fontFamily: legacySerif, fontSize: 8 },
          { type: "mathInline", id: `math_${column}_${row}`, tex: String.raw`\frac{x^2+1}{3}`, display: "inline", fontSize: 8 },
        ],
      })),
      label(column * 2 + 1),
    ]).flat(),
    outputProfiles: { student: { showSolutions: false }, teacher: { showSolutions: true }, answerBook: { showSolutions: true, onlySolutions: true } },
    pageLayout: {
      preset: "B4", orientation: "landscape", pageSize: { widthMm: 364, heightMm: 257 },
      marginsMm: { top: 19, right: 17, bottom: 15, left: 17 },
      flow: { type: "columns", columnCount: 3, columnGapMm: 8 },
    },
  };
}

test("continuous B4 text keeps its settled baselines in the saved vector PDF", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-pdf-continuous-"));
  const source = path.join(profile, "continuous.sigma");
  const output = testInfo.outputPath("continuous.pdf");
  writeFileSync(source, JSON.stringify(fixture()));
  mkdirSync(path.join(profile, "data"));
  writeFileSync(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT, source], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await expect(page.locator('.editor-canvas [data-sigma-doc-id="label_0"]').first()).toBeAttached({ timeout: 60_000 });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    await waitForPagedSurfaceSettled(page);
    const expected = await page.locator(".paged-surface-page").evaluateAll(papers => papers.flatMap((paper, index) => {
      const origin = paper.getBoundingClientRect();
      return Array.from(paper.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="label_"]')).map(element => {
        const probe = document.createElement("span");
        probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
        element.prepend(probe);
        const baseline = probe.getBoundingClientRect().top - origin.top;
        probe.remove();
        return { page: index, text: element.textContent!.split(":")[0], x: element.getBoundingClientRect().left - origin.left, baseline };
      });
    }));
    expect(expected).toHaveLength(12);
    expect(new Set(expected.map(item => item.page)).size).toBe(2);
    await app.evaluate(({ dialog }, output) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: output }); }, output);
    await page.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(2);
      for (const item of expected) {
        const pdfPage = await pdf.getPage(item.page + 1);
        const text = (await pdfPage.getTextContent()).items.find(candidate => "str" in candidate && candidate.str.startsWith(`${item.text}:`));
        expect(text, item.text).toBeDefined();
        if (!text || !("str" in text)) throw new Error(`Missing vector text ${item.text}`);
        const [x, y] = pdfPage.getViewport({ scale: 96 / 72 }).convertToViewportPoint(text.transform[4], text.transform[5]);
        expect(Math.abs(x - item.x), `${item.text} x`).toBeLessThanOrEqual(1);
        expect(Math.abs(y - item.baseline), `${item.text} baseline`).toBeLessThanOrEqual(1);
      }
    } finally { await loading.destroy(); }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
});
