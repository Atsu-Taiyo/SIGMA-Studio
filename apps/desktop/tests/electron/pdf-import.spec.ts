import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import type { OverlayTextShape, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const PAGE_COUNT = 200;
const PX_PER_PT = 96 / 72;
const A4 = { width: 595.28, height: 841.89 };
const HEADING = { x: 56.69, baseline: 90, size: 18 };
// 1x1 の赤い PNG。画像の取り込み (SVG への埋め込み) を確かめる。
const RED_PIXEL_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==", "base64");

/** 200 ページの合成 PDF。見出し・本文 30 行・枠・塗り・10 ページごとの画像。 */
async function createLargePdf(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const image = await pdf.embedPng(RED_PIXEL_PNG);
  for (let index = 0; index < PAGE_COUNT; index += 1) {
    const page = pdf.addPage([A4.width, A4.height]);
    page.drawRectangle({ x: 40, y: 60, width: A4.width - 80, height: A4.height - 160, borderColor: rgb(0.07, 0.43, 0.44), borderWidth: 1.5 });
    page.drawRectangle({ x: 40, y: A4.height - 110, width: A4.width - 80, height: 34, color: rgb(0.9, 0.95, 0.95) });
    page.drawText(`Page ${index + 1} heading`, {
      x: HEADING.x, y: A4.height - HEADING.baseline, size: HEADING.size, font: bold, color: rgb(0.07, 0.43, 0.44),
    });
    for (let line = 0; line < 30; line += 1) {
      page.drawText(`Line ${line + 1} of page ${index + 1}: the quick brown fox jumps over the lazy dog.`, {
        x: 56.69, y: A4.height - 140 - line * 20, size: 10.5, font: regular, color: rgb(0.1, 0.1, 0.1),
      });
    }
    if (index % 10 === 0) page.drawImage(image, { x: 450, y: 700, width: 60, height: 40 });
  }
  return pdf.save();
}

async function savedDocuments(profile: string): Promise<SigmaDocument[]> {
  const directory = path.join(profile, "data", "documents");
  if (!existsSync(directory)) return [];
  const names = (await readdir(directory)).filter((name) => name.endsWith(".sigmadoc.json"));
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as SigmaDocument));
}

/** 見出しの文字のベースラインと左端を、所属する紙面の左上からの CSS px (100% 換算) で返す。 */
async function headingGeometry(page: Page, text: string) {
  return page.evaluate((needle) => {
    const shape = [...document.querySelectorAll<HTMLElement>(".overlay-text-shape")]
      .find((element) => element.textContent?.trim() === needle);
    if (!shape) return null;
    const content = shape.querySelector<HTMLElement>("p") ?? shape;
    const probe = document.createElement("span");
    probe.style.cssText = "display:inline-block;width:0;height:0;padding:0;margin:0;vertical-align:baseline";
    content.prepend(probe);
    const baselineY = probe.getBoundingClientRect().top;
    probe.remove();
    const range = document.createRange();
    range.selectNodeContents(content);
    const textRect = range.getBoundingClientRect();
    const sheets = [...document.querySelectorAll<HTMLElement>(".a4-page-sheet")];
    const sheet = sheets.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return baselineY >= rect.top && baselineY <= rect.bottom;
    });
    if (!sheet) return null;
    const sheetRect = sheet.getBoundingClientRect();
    const scale = sheetRect.width / sheet.offsetWidth;
    return {
      left: (textRect.left - sheetRect.left) / scale,
      width: textRect.width / scale,
      baseline: (baselineY - sheetRect.top) / scale,
    };
  }, text);
}

test("a 200-page PDF imports as fixed pages whose text lands on the PDF baselines and survives reload", async ({}, testInfo) => {
  test.setTimeout(420_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-pdf-import-"));
  const pdfPath = path.join(profile, "large-material.pdf");
  await writeFile(pdfPath, await createLargePdf());
  await mkdir(path.join(profile, "data"), { recursive: true });
  await writeFile(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });

    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, pdfPath);
    const started = Date.now();
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "PowerPoint・PDFをインポート" }).click();
    await expect(page.getByText("PDFをSigmaDocへ変換しました")).toBeVisible({ timeout: 300_000 });
    const importMs = Date.now() - started;

    await expect.poll(async () => (await savedDocuments(profile)).find((doc) => doc.metadata.source?.format === "pdf")
      ?.pageLayout?.overlay?.overlaySnapshot?.shapes.length ?? 0, { timeout: 60_000 }).toBeGreaterThan(PAGE_COUNT * 31);
    const saved = (await savedDocuments(profile)).find((doc) => doc.metadata.source?.format === "pdf")!;
    const snapshot = saved.pageLayout!.overlay!.overlaySnapshot!;
    const texts = snapshot.shapes.filter((shape): shape is OverlayTextShape => shape.type === "text");
    const images = snapshot.shapes.filter((shape) => shape.type === "image");
    expect(saved.metadata.title).toBe("large-material");
    expect(saved.metadata.source).toMatchObject({ layoutMode: "fixedOverlay", slideCount: PAGE_COUNT });
    expect(saved.pageLayout!.pageSize.widthMm).toBeCloseTo(210, 0);
    expect(texts).toHaveLength(PAGE_COUNT * 31);
    expect(images).toHaveLength(PAGE_COUNT);
    expect(texts.find((shape) => JSON.stringify(shape.props.blocks).includes("Page 150 heading"))?.props).toMatchObject({
      color: "#126e70", fontSize: 18, textWrap: "none", blocks: [{ children: [{ marks: ["bold"] }] }],
    });
    // 画像は 10 ページごとの背景 SVG に埋め込まれる。
    const imageAssets = Object.values(snapshot.assets).filter((asset) => decodeURIComponent(asset.props.src).includes("data:image/png;base64"));
    expect(imageAssets).toHaveLength(PAGE_COUNT / 10);
    const documentBytes = Buffer.byteLength(JSON.stringify(saved));

    // 150 ページ目まで送り、見出しが PDF の位置に描かれていることを確かめる。
    const scroller = page.locator(".editor-canvas");
    const stride = await page.locator(".a4-page-sheet").first().evaluate((sheet) => {
      const next = sheet.nextElementSibling as HTMLElement | null;
      return next ? next.offsetTop - (sheet as HTMLElement).offsetTop : (sheet as HTMLElement).offsetHeight + 36;
    });
    const scrollStarted = Date.now();
    await scroller.evaluate((element, top) => { element.scrollTop = top; }, 149 * stride);
    await expect.poll(() => headingGeometry(page, "Page 150 heading"), { timeout: 30_000 }).not.toBeNull();
    const scrollMs = Date.now() - scrollStarted;
    const geometry = (await headingGeometry(page, "Page 150 heading"))!;
    expect(geometry.left).toBeCloseTo(HEADING.x * PX_PER_PT, 0);
    expect(Math.abs(geometry.baseline - HEADING.baseline * PX_PER_PT)).toBeLessThan(1.5);
    // 取り込み先の書体で測った幅を図形の横倍率で PDF の幅へ合わせている。
    const helveticaBold = await (await PDFDocument.create()).embedFont(StandardFonts.HelveticaBold);
    const pdfWidth = helveticaBold.widthOfTextAtSize("Page 150 heading", HEADING.size) * PX_PER_PT;
    expect(Math.abs(geometry.width - pdfWidth) / pdfWidth).toBeLessThan(0.03);
    await page.screenshot({ path: testInfo.outputPath("page-150.png") });

    // 再起動しても同じ教材として開き、最終ページまで描ける。
    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    page = await app.firstWindow();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    const reopened = page.locator(".editor-canvas");
    await expect.poll(() => page.locator(".a4-page-sheet").count(), { timeout: 60_000 }).toBeGreaterThan(0);
    await reopened.evaluate((element) => { element.scrollTop = element.scrollHeight; });
    await expect.poll(() => headingGeometry(page, `Page ${PAGE_COUNT} heading`), { timeout: 30_000 }).not.toBeNull();
    const reloaded = (await savedDocuments(profile)).find((doc) => doc.metadata.source?.format === "pdf")!;
    expect(reloaded.pageLayout!.overlay!.overlaySnapshot!.shapes).toHaveLength(snapshot.shapes.length);

    testInfo.annotations.push({
      type: "pdf-import",
      description: JSON.stringify({ importMs, scrollMs, documentMB: Number((documentBytes / 1e6).toFixed(2)) }),
    });
    console.log(`[pdf-import] import ${importMs}ms, scroll to page 150 ${scrollMs}ms, document ${(documentBytes / 1e6).toFixed(2)}MB`);
  } finally {
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});

test("a mixed-size PDF keeps the larger page's edge text and graphics on its own sheet", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-pdf-mixed-sizes-"));
  const pdfPath = path.join(profile, "mixed-sizes.pdf");
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  for (const [width, height] of [[360, 480], [360, 480], [720, 960]] as const) {
    const source = pdf.addPage([width, height]);
    source.drawRectangle({ x: 10, y: 10, width: width - 20, height: height - 20, borderColor: rgb(0.1, 0.4, 0.2), borderWidth: 1 });
    source.drawText(width === 720 ? "Large page edge" : "Regular page", {
      x: width === 720 ? 550 : 45, y: width === 720 ? 3 : 90, font, size: 20,
    });
  }
  await writeFile(pdfPath, await pdf.save());
  await mkdir(path.join(profile, "data"), { recursive: true });
  await writeFile(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const launch = () => electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, pdfPath);
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "PowerPoint・PDFをインポート" }).click();
    await expect(page.getByText("PDFをSigmaDocへ変換しました")).toBeVisible();
    const imported = async () => (await savedDocuments(profile)).find(({ metadata }) => metadata.title === "mixed-sizes");
    await expect.poll(imported).toBeDefined();
    const saved = (await imported())!;
    const snapshot = saved.pageLayout!.overlay!.overlaySnapshot!;
    const background = snapshot.shapes.find((shape) => shape.type === "image" && shape.id.endsWith("_p3_graphics"));
    expect(background).toMatchObject({ locked: true, stackLayer: "background" });
    if (background?.type !== "image") throw new Error("Imported page background is missing");
    expect(background.props.w).toBeCloseTo(480, 2);
    expect(background.props.h).toBeCloseTo(640, 2);
    expect(saved.metadata.source).toMatchObject({ slideCount: 3 });
    const assertLayout = async () => {
      await expect(page.locator(".a4-page-sheet")).toHaveCount(3);
      await expect.poll(() => headingGeometry(page, "Large page edge")).not.toBeNull();
      const edge = (await headingGeometry(page, "Large page edge"))!;
      expect(edge.left).toBeCloseTo(550 * PX_PER_PT / 2, 0);
      expect(edge.left + edge.width).toBeLessThan(480);
      expect(Math.abs(edge.baseline - 957 * PX_PER_PT / 2)).toBeLessThan(1.5);
    };
    await assertLayout();
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await assertLayout();
    expect((await imported())?.pageLayout?.overlay?.overlaySnapshot).toEqual(snapshot);
  } finally {
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true, maxRetries: 5 });
  }
});

/**
 * 実教材での確認。PDF はリポジトリに置かない (著作権・サイズ)。
 * `SIGMA_PDF_IMPORT_FILE=/path/to/file.pdf` を渡したときだけ走り、取り込み時間と保存容量を出し、
 * 指定ページ (`SIGMA_PDF_IMPORT_PAGES=1,50,100`) の画面を test-results に残す。
 */
test("a real PDF given by SIGMA_PDF_IMPORT_FILE imports and renders the requested pages", async ({}, testInfo) => {
  const source = process.env.SIGMA_PDF_IMPORT_FILE;
  test.skip(!source, "SIGMA_PDF_IMPORT_FILE is not set");
  test.setTimeout(900_000);
  const profile = await mkdtemp(path.join(os.tmpdir(), "sigma-pdf-import-real-"));
  await mkdir(path.join(profile, "data"), { recursive: true });
  await writeFile(path.join(profile, "data/settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  const app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await page.evaluate(() => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      localStorage.setItem("sigma-studio:github-star-dismissed:v1", "1");
    });
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
    await app.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [file] })) as typeof dialog.showOpenDialog;
    }, source!);
    const started = Date.now();
    await page.getByRole("button", { name: "ファイル", exact: true }).click();
    await page.getByRole("menuitem", { name: "PowerPoint・PDFをインポート" }).click();
    await expect(page.getByText("PDFをSigmaDocへ変換しました")).toBeVisible({ timeout: 850_000 });
    const importMs = Date.now() - started;
    await expect.poll(async () => (await savedDocuments(profile)).some((doc) => doc.metadata.source?.format === "pdf"), { timeout: 120_000 }).toBe(true);
    const saved = (await savedDocuments(profile)).find((doc) => doc.metadata.source?.format === "pdf")!;
    const scroller = page.locator(".editor-canvas");
    const stride = await page.locator(".a4-page-sheet").first().evaluate((sheet) => {
      const next = sheet.nextElementSibling as HTMLElement | null;
      return next ? next.offsetTop - (sheet as HTMLElement).offsetTop : (sheet as HTMLElement).offsetHeight + 36;
    });
    for (const pageNo of (process.env.SIGMA_PDF_IMPORT_PAGES ?? "1").split(",").map(Number).filter(Boolean)) {
      await scroller.evaluate((element, top) => { element.scrollTop = top; }, (pageNo - 1) * stride + 120);
      await page.waitForTimeout(1500);
      await page.screenshot({ path: testInfo.outputPath(`page-${pageNo}.png`) });
    }
    console.log(`[pdf-import] ${path.basename(source!)}: ${saved.metadata.source?.slideCount} pages, import ${importMs}ms, `
      + `${saved.pageLayout?.overlay?.overlaySnapshot?.shapes.length} shapes, document ${(Buffer.byteLength(JSON.stringify(saved)) / 1e6).toFixed(2)}MB`);
  } finally {
    await app.close().catch(() => undefined);
    await rm(profile, { recursive: true, force: true });
  }
});
