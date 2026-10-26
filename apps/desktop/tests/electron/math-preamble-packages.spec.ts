import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Locator } from "@playwright/test";
import type { SigmaDocument } from "@/features/document";

const ROOT = path.resolve(__dirname, "../..");
const PREAMBLE = String.raw`\newcommand{\maru}[1]{\textcircled{\scriptsize#1}}`;

/** Measure the rendered digit and its circle, for both supported math renderers. */
async function circleCenters(surface: Locator) {
  return surface.evaluate(element => {
    const circle = Array.from(element.querySelectorAll<HTMLElement>(".ML__notation")).find(node => getComputedStyle(node).borderRadius === "50%") ?? element.querySelector<HTMLElement>(".accent-body.accent-full");
    if (!circle) return null;
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() !== "2") continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const digit = range.getBoundingClientRect();
      const outline = circle.getBoundingClientRect();
      if (!digit.width || !outline.width) return null;
      return { digit: digit.x + digit.width / 2, circle: outline.x + outline.width / 2, width: outline.width };
    }
    return null;
  });
}

test("preamble circled numbers and built-in quantities agree in desktop settings, editing and saved PDF", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!process.env.SIGMA_STUDIO_E2E_BASE_URL && !existsSync(path.join(ROOT, "out/index.html")), "Build the renderer first");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-math-preamble-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const executablePath = process.env.SIGMA_STUDIO_E2E_EXECUTABLE;
  const app = await electron.launch({ ...(executablePath ? { executablePath } : {}), args: executablePath ? [] : [ROOT], cwd: ROOT, env });
  try {
    const page = await app.firstWindow();
    await (await app.browserWindow(page)).evaluate(win => win.setContentSize(1400, 1000));
    await page.waitForFunction(() => Boolean(window.desktopAPI?.storage));
    const source: SigmaDocument = {
      version: "2.0", docId: "preamble_packages", metadata: { title: "丸数字と括弧", texPreamble: PREAMBLE },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [
        { type: "paragraph", id: "circled", children: [{ type: "mathInline", id: "circled_math", tex: String.raw`\maru2`, display: "inline" }] },
        { type: "paragraph", id: "fallback", children: [{ type: "mathInline", id: "fallback_math", tex: String.raw`\maru2+\dots`, display: "inline" }] },
        { type: "paragraph", id: "quantity", children: [{ type: "mathInline", id: "quantity_math", tex: String.raw`\qty\Big{\frac{23}{7}}+\norm{x}`, display: "inline" }] },
      ],
    };
    const fileId = await page.evaluate(async document => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      const { file } = await window.desktopAPI!.storage.createFileFromDocument({ document });
      await window.desktopAPI!.storage.saveWorkspace({ openFileIds: [file.fileId], activeFileId: file.fileId });
      return file.fileId;
    }, source);
    await page.reload();
    await expect(page.locator('.page-flow [data-id="circled_math"]').first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    for (const id of ["circled_math", "fallback_math"]) {
      const math = page.locator(`.page-flow [data-id="${id}"]`).first();
      await expect.poll(() => circleCenters(math)).not.toBeNull();
      const centers = (await circleCenters(math))!;
      expect(Math.abs(centers.digit - centers.circle)).toBeLessThan(0.75);
    }
    const quantity = page.locator('.page-flow [data-id="quantity_math"]').first();
    await expect(quantity.locator(".ML__frac-line")).toBeVisible();
    await expect(quantity.locator(".ML__error")).toHaveCount(0);

    await page.getByRole("button", { name: "設定", exact: true }).click();
    await page.getByRole("menuitem", { name: "TeX・TikZ環境設定" }).click();
    const settings = page.getByRole("dialog", { name: "TeX環境設定", exact: true });
    await settings.locator("#tex-environment-preview-input").fill(String.raw`\maru2`);
    const preview = settings.getByLabel("数式プレビュー", { exact: true });
    await expect.poll(() => circleCenters(preview)).not.toBeNull();
    const centers = (await circleCenters(preview))!;
    expect(Math.abs(centers.digit - centers.circle)).toBeLessThan(0.75);
    await preview.screenshot({ path: testInfo.outputPath("circled-settings.png") });
    await settings.locator("#tex-environment-preview-input").fill(String.raw`\qty(\frac{23}{7})`);
    await expect(preview.locator(".ML__frac-line")).toBeVisible();
    await expect(preview.locator(".ML__error")).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("quantity-settings.png") });
    await settings.getByRole("button", { name: "設定を保存", exact: true }).click();

    // The same author macro remains editable without becoming an unknown command.
    const circled = page.locator('.page-flow [data-id="circled_math"]').first();
    await circled.dblclick();
    const circledField = circled.locator("math-field");
    await expect(circledField).toBeVisible();
    await expect(circledField.locator(".ML__notation")).toBeVisible();
    await expect(circledField.locator(".ML__error")).toHaveCount(0);
    await expect.poll(() => circledField.evaluate(element => (element as HTMLElement & { value: string }).value)).toContain(String.raw`\maru`);
    await page.keyboard.press("Escape");

    // Public MathLive insertion must understand the same syntax without a preamble declaration.
    await quantity.dblclick();
    const field = quantity.locator("math-field");
    await expect(field).toBeVisible();
    await field.evaluate(element => { (element as HTMLElement & { value: string }).value = ""; });
    await field.focus();
    await page.keyboard.type(String.raw`\qty(x)`);
    await expect(field.locator(".ML__error")).toHaveCount(0);
    await expect.poll(() => field.evaluate(element => (element as HTMLElement & { value: string }).value)).toContain("x");
    await expect.poll(() => field.evaluate(element => (element as HTMLElement & { value: string }).value)).toContain(String.raw`\left(`);
    await field.evaluate(element => {
      const mathField = element as HTMLElement & { value: string; insert: (tex: string, options: { selectionMode: string }) => void };
      mathField.value = "";
      mathField.insert(String.raw`\qty(\frac{31}{11})`, { selectionMode: "after" });
      element.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
    });
    await expect(field.locator(".ML__error")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.keyboard.press("ControlOrMeta+KeyS");
    const saved = () => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), fileId);
    await expect.poll(async () => (await saved())?.metadata.texPreamble).toBe(PREAMBLE);
    await expect.poll(async () => JSON.stringify((await saved())?.content)).toContain("31");
    const savedContent = (await saved())!.content;
    await page.reload();
    await expect(page.locator('.page-flow [data-id="quantity_math"] .ML__frac-line').first()).toBeVisible();
    expect((await saved())!.content).toEqual(savedContent);

    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "エクスポート" }).hover();
    await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();
    const pdfPreview = page.getByRole("dialog", { name: "PDFプレビュー", exact: true });
    await expect(pdfPreview.locator('.paged-surface[data-paged-surface-state="ready"]')).toBeVisible();
    const pdfCircle = pdfPreview.locator('[data-id="fallback_math"]').first();
    await expect.poll(() => circleCenters(pdfCircle)).not.toBeNull();
    const printed = (await circleCenters(pdfCircle))!;
    expect(Math.abs(printed.digit - printed.circle)).toBeLessThan(0.75);
    const output = testInfo.outputPath("preamble-packages.pdf");
    await app.evaluate(({ dialog }, filePath) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath }); }, output);
    await pdfPreview.getByRole("button", { name: "PDF保存", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "PDFを保存しました" })).toBeVisible({ timeout: 60_000 });
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const loading = getDocument({ data: Uint8Array.from(readFileSync(output)), verbosity: 0 });
    try {
      const pdf = await loading.promise;
      const items = (await (await pdf.getPage(1)).getTextContent()).items.filter(item => "str" in item);
      const text = items.map(item => item.str).join("");
      expect(text).toContain("31");
      expect(text).toContain("11");
      const ring = items.find(item => item.str.includes("◯"));
      expect(ring).toBeDefined();
      const digit = items.filter(item => item.str === "2").sort((a, b) => Math.abs(a.transform[5] - ring!.transform[5]) - Math.abs(b.transform[5] - ring!.transform[5]))[0];
      expect(digit).toBeDefined();
      expect(Math.abs(digit.transform[4] + digit.width / 2 - (ring!.transform[4] + ring!.width / 2))).toBeLessThan(0.75);
    } finally { await loading.destroy(); }
    expect((await saved())!.content).toEqual(savedContent);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
