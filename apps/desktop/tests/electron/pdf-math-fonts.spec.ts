import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCanvas } from "@napi-rs/canvas";
import { _electron as electron, expect, test } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const fixture: SigmaDocument = {
  version: "2.0", docId: "pdf_math_fonts",
  metadata: { title: "PDF数式フォント", styleUnits: { fontSize: "pt" } },
  content: [{ type: "paragraph", id: "fraction", children: [{
    type: "mathInline", id: "formula", display: "inline", fontSize: 18,
    tex: String.raw`\frac{12345678+x}{98765432-y}=\sqrt{16a^2+1}`,
  }] }],
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

test("PDF retains digits, symbols and fraction bars with cold delayed math fonts", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-pdf-fonts-"));
  const output = testInfo.outputPath("math-fonts.pdf");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const storage = window.desktopAPI!.storage;
      const { file } = await storage.createFileFromDocument({ document });
      await storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, fixture);
    await page.reload();
    await expect(page.locator('.page-flow [data-id="formula"] .ML__frac-line').first()).toBeVisible();
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    const preview = page.getByRole("dialog", { name: "PDFプレビュー" });
    await expect(preview.locator('.paged-surface[data-paged-surface-state="ready"]')).toBeVisible();
    const bar = await preview.locator(".paged-surface-page .ML__frac-line").first().evaluate(element => {
      const paper = element.closest(".paged-surface-page")!.getBoundingClientRect();
      const rect = element.getBoundingClientRect();
      return { x: rect.left - paper.left, y: rect.top - paper.top, width: rect.width, paperWidth: paper.width };
    });
    // Make only the hidden snapshot's font URLs cold, then delay the real font responses.
    // This reproduces the race even when the preview already warmed Chromium's font cache.
    await app.evaluate(({ app, dialog }, output) => {
      let count = 0;
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: output });
      app.on("browser-window-created", (_event, window) => {
        const execute = window.webContents.executeJavaScript.bind(window.webContents);
        window.webContents.executeJavaScript = (source, gesture) => execute(
          source.includes("document.write(html)") ? source.replaceAll(".woff2", ".woff2?pdf-font-cold=1") : source,
          gesture,
        );
        window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
          if (details.url.includes("pdf-font-cold=1")) {
            count += 1;
            setTimeout(() => callback({}), 500);
          } else callback({});
        });
      });
      (globalThis as unknown as { pdfFontRequests: () => number }).pdfFontRequests = () => count;
    }, output);
    await preview.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    expect(await app.evaluate(() => (globalThis as unknown as { pdfFontRequests: () => number }).pdfFontRequests())).toBeGreaterThan(0);
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      expect(pdf.numPages).toBe(1);
      const pdfPage = await pdf.getPage(1);
      const text = (await pdfPage.getTextContent()).items.map(item => "str" in item ? item.str : "").join("");
      for (const expected of ["12345678", "98765432", "+", "=", "x", "y"]) expect(text).toContain(expected);
      const viewport = pdfPage.getViewport({ scale: 2 });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const context = canvas.getContext("2d");
      await pdfPage.render({ canvas: null, canvasContext: context as unknown as CanvasRenderingContext2D, viewport }).promise;
      await testInfo.attach("rendered-pdf", { body: canvas.toBuffer("image/png"), contentType: "image/png" });
      const scale = viewport.width / bar.paperWidth;
      const left = Math.ceil((bar.x + 1) * scale);
      const width = Math.floor((bar.width - 2) * scale);
      const pixels = context.getImageData(left, Math.max(0, Math.floor((bar.y - 3) * scale)), width, Math.ceil(7 * scale));
      let longest = 0;
      for (let y = 0; y < pixels.height; y += 1) {
        let dark = 0;
        for (let x = 0; x < width; x += 1) {
          const offset = (y * width + x) * 4;
          if (pixels.data[offset] < 160 && pixels.data[offset + 1] < 160 && pixels.data[offset + 2] < 160) dark += 1;
        }
        longest = Math.max(longest, dark);
      }
      expect(longest / width).toBeGreaterThan(0.9);
    } finally {
      await loading.destroy();
    }
    // Export must leave the saved canonical math unchanged and its temporary window closed.
    expect((await page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId))!.content).toEqual(fixture.content);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
