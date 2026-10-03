import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const REGION = { dx: 140, dy: 90, width: 420, height: 230 };

/**
 * 実画面を撮る機能なので、取得 (webContents.capturePage)・IPC・クリップボード・保存・AI入力欄の
 * 添付までを本物で通す。差し替えるのは次の3つだけ:
 *  - AIのサインイン状態と送信 (AI面を出すため。送信内容は main で記録して中身を確かめる)
 *  - ダウンロードフォルダ (利用者の「ダウンロード」を汚さないよう一時ディレクトリへ)
 *  - navigator.clipboard.write (開発者の実クリップボードを上書きしないよう、渡された画像を捕まえるだけ)
 */
async function prepare(app: ElectronApplication, page: Page, downloads: string) {
  await app.evaluate(({ ipcMain, app: electronApp }, dir) => {
    electronApp.setPath("downloads", dir);
    ipcMain.removeHandler("codex:get-status");
    ipcMain.handle("codex:get-status", () => ({
      available: true, running: true, loggedIn: true, codexHome: "", codexBin: "codex",
      configuredCodexBin: null, account: { type: "chatgpt", email: "check@example.com" }, error: null,
    }));
    const runs: unknown[] = [];
    (globalThis as { __regionCaptureRuns?: unknown[] }).__regionCaptureRuns = runs;
    ipcMain.removeHandler("ai-edit:run");
    ipcMain.handle("ai-edit:run", (_event, _runId: string, payload: unknown) => {
      runs.push(payload);
      throw new Error("stubbed run");
    });
  }, downloads);
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await page.locator(".text-flow-editor").first().waitFor({ timeout: 180_000 });
  await expect(page.locator(".startup-splash")).toBeHidden();
  // 変更を取り消せるように、コピーされた画像を window に保持する (実クリップボードには書かない)。
  await page.evaluate(() => {
    navigator.clipboard.write = async (items) => {
      const blob = await items[0]!.getType("image/png");
      const bytes = new Uint8Array(await blob.arrayBuffer());
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      (window as unknown as { __copiedPng: string }).__copiedPng = btoa(binary);
    };
  });
  // 初回表示直後は組版が落ち着くまで数百ms 動く。範囲を測る前に待つ。
  await page.waitForTimeout(1500);
}

async function chordDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, chord = true) {
  if (chord) {
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
  }
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  if (chord) {
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
  }
}

function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** 2 枚の画像の画素の食い違いの平均 (0〜255)。枠・暗い幕・操作バーが写り込むと大きく跳ねる。 */
async function meanPixelDifference(a: Buffer, b: Buffer): Promise<number> {
  const [imageA, imageB] = await Promise.all([loadImage(a), loadImage(b)]);
  expect([imageA.width, imageA.height]).toEqual([imageB.width, imageB.height]);
  const read = (image: typeof imageA) => {
    const canvas = createCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    return context.getImageData(0, 0, image.width, image.height).data;
  };
  const [pixelsA, pixelsB] = [read(imageA), read(imageB)];
  let total = 0;
  for (let index = 0; index < pixelsA.length; index += 4) {
    total += Math.abs(pixelsA[index]! - pixelsB[index]!)
      + Math.abs(pixelsA[index + 1]! - pixelsB[index + 1]!)
      + Math.abs(pixelsA[index + 2]! - pixelsB[index + 2]!);
  }
  return total / (pixelsA.length / 4) / 3;
}

test("an Option+Shift drag picks a range, and copy / save / ask AI each use exactly that range", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-region-capture-"));
  const downloads = path.join(profile, "downloads");
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const source = ensurePageLayout({ ...sampleDocument, docId: "region_capture", metadata: { ...sampleDocument.metadata, title: "範囲スクショの確認" } });
  const sourceFile = path.join(profile, "範囲スクショの確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page, downloads);

    const canvasBox = (await page.locator(".editor-canvas").boundingBox())!;
    const from = { x: canvasBox.x + REGION.dx, y: canvasBox.y + REGION.dy };
    const to = { x: from.x + REGION.width, y: from.y + REGION.height };
    const toolbar = page.getByRole("toolbar", { name: "スクリーンショット" });
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    // 撮る前の同じ範囲を、枠も幕もない状態で撮っておく (写り込みの比較の基準)。
    const reference = await page.screenshot({
      clip: { x: from.x, y: from.y, width: REGION.width, height: REGION.height },
      caret: "initial",
    });

    // 押している間だけ十字カーソルになり、離すと戻る。
    await page.keyboard.down("Alt");
    await page.keyboard.down("Shift");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".editor-canvas")!).cursor)).toBe("crosshair");
    await page.keyboard.up("Shift");
    await page.keyboard.up("Alt");
    await expect.poll(() => page.evaluate(() => getComputedStyle(document.querySelector(".editor-canvas")!).cursor)).not.toBe("crosshair");

    // 範囲を選ぶと、枠のすぐ下に 3 つの操作が出る。
    await chordDrag(page, from, to);
    await expect(toolbar).toBeVisible();
    await expect(toolbar.getByRole("button")).toHaveCount(3);
    const frame = (await page.locator(".region-capture-frame").boundingBox())!;
    expect(Math.abs(frame.x - from.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.width - REGION.width)).toBeLessThanOrEqual(1);
    expect(Math.abs(frame.height - REGION.height)).toBeLessThanOrEqual(1);
    const bar = (await toolbar.boundingBox())!;
    expect(bar.y - (frame.y + frame.height)).toBeGreaterThanOrEqual(0);
    expect(bar.y - (frame.y + frame.height)).toBeLessThan(16);

    // コピー: 選んだ範囲の大きさのPNGで、枠や操作バーは写っていない。
    await toolbar.getByRole("button", { name: "スクリーンショットをコピー" }).click();
    await expect.poll(() => page.evaluate(() => (window as unknown as { __copiedPng?: string }).__copiedPng ?? null)).not.toBeNull();
    const copied = Buffer.from((await page.evaluate(() => (window as unknown as { __copiedPng: string }).__copiedPng)), "base64");
    await testInfo.attach("reference", { body: reference, contentType: "image/png" });
    await testInfo.attach("captured", { body: copied, contentType: "image/png" });
    const copiedSize = pngSize(copied);
    expect(Math.abs(copiedSize.width - REGION.width * dpr)).toBeLessThanOrEqual(2);
    expect(Math.abs(copiedSize.height - REGION.height * dpr)).toBeLessThanOrEqual(2);
    if (copiedSize.width === reference.readUInt32BE(16) && copiedSize.height === reference.readUInt32BE(20)) {
      expect(await meanPixelDifference(copied, reference)).toBeLessThan(2);
    }
    await expect(toolbar).toBeHidden();
    await expect(page.locator(".region-capture-frame")).toHaveCount(0);

    // 保存: ダウンロードフォルダに PNG ができる。
    await chordDrag(page, from, to);
    await toolbar.getByRole("button", { name: "画像として保存" }).click();
    // フォルダは最初の保存で作られる。
    const savedFiles = () => (existsSync(downloads) ? readdirSync(downloads) : []).filter((name) => /^screenshot-\d{8}-\d{6}\.png$/.test(name));
    await expect.poll(() => savedFiles().length).toBe(1);
    const savedName = savedFiles()[0]!;
    expect(pngSize(readFileSync(path.join(downloads, savedName))).width).toBe(copiedSize.width);

    // AIに聞く: 入力欄に画像が付き、すぐ質問を打てる。
    await chordDrag(page, from, to);
    await toolbar.getByRole("button", { name: "AIに聞く" }).click();
    const inline = page.locator(".ai-chat-host--inline");
    await expect(inline).toBeVisible();
    await expect(inline.locator(".ai-chat-attachment-thumb")).toHaveCount(1);
    await expect(inline.locator("textarea")).toBeFocused();
    await page.keyboard.type("この範囲の面積は？");

    // 開いたままもう 1 枚: 打ちかけの質問は消えず、画像が増える。
    await chordDrag(page, { x: from.x + 20, y: from.y + 20 }, { x: to.x - 20, y: to.y - 40 });
    await toolbar.getByRole("button", { name: "AIに聞く" }).click();
    await expect(inline.locator(".ai-chat-attachment-thumb")).toHaveCount(2);
    await expect(inline.locator("textarea")).toHaveValue("この範囲の面積は？");

    // 送信すると、画像がそのままAIへの入力に入る (撮った大きさの PNG)。
    await inline.getByRole("button", { name: "送信", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __regionCaptureRuns?: unknown[] }).__regionCaptureRuns?.length ?? 0)).toBe(1);
    const run = JSON.stringify(await app.evaluate(() => (globalThis as { __regionCaptureRuns?: unknown[] }).__regionCaptureRuns![0]));
    expect(run).toContain("この範囲の面積は？");
    expect(run.match(/data:image\/png;base64,/g)).toHaveLength(2);
    expect(run.match(/screenshot-\d{8}-\d{6}\.png/g)!.length).toBeGreaterThanOrEqual(2);
    // 使った画像は入力欄から消える。
    await expect(inline.locator(".ai-chat-attachment-thumb")).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("ordinary clicks and drags are left to the page, and a drag outside the page area never starts a range", async () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-region-capture-plain-"));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const source = ensurePageLayout({ ...sampleDocument, docId: "region_capture_plain", metadata: { ...sampleDocument.metadata, title: "範囲スクショの確認2" } });
  const sourceFile = path.join(profile, "範囲スクショの確認2.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page, path.join(profile, "downloads"));
    const toolbar = page.getByRole("toolbar", { name: "スクリーンショット" });

    // キーを押さない普通のクリックは本文のキャレットになる。
    const editor = (await page.locator(".text-flow-editor").first().boundingBox())!;
    await page.mouse.click(editor.x + 60, editor.y + 20);
    await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest("[contenteditable='true']")))).toBe(true);
    await expect(toolbar).toHaveCount(0);

    // 紙面の外 (リボン) からの ⌥⇧ ドラッグは範囲にならない。
    await chordDrag(page, { x: 300, y: 90 }, { x: 600, y: 160 });
    await expect(toolbar).toHaveCount(0);

    // コマンドから始めると、キーなしの次の 1 回のドラッグが範囲になり、Esc で取り消せる。
    await page.evaluate(() => window.dispatchEvent(new Event("sigma-editor:region-capture-arm")));
    await expect(page.locator(".region-capture-hint")).toBeVisible();
    const canvasBox = (await page.locator(".editor-canvas").boundingBox())!;
    await chordDrag(page, { x: canvasBox.x + 140, y: canvasBox.y + 90 }, { x: canvasBox.x + 480, y: canvasBox.y + 260 }, false);
    await expect(toolbar).toBeVisible();
    await expect(page.locator(".region-capture-hint")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(toolbar).toHaveCount(0);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
