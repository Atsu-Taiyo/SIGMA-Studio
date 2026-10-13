import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import type { TestInfo } from "@playwright/test";
import os from "node:os";
import path from "node:path";
import { createCanvas, loadImage } from "@napi-rs/canvas";
import { _electron as electron, expect, test, type ElectronApplication, type Locator, type Page } from "@playwright/test";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const IMAGE_SIZE = { width: 640, height: 400 };

/**
 * 添付画像の中の場所にコメントを付ける機能を、貼り付け → コメント画面 → 送信 → 再起動後の履歴まで
 * 本物の Electron で通す。差し替えるのは AI のサインイン状態と送信 (送った中身を main で記録する) だけ。
 */
function buildWorksheetPng(): Buffer {
  const canvas = createCanvas(IMAGE_SIZE.width, IMAGE_SIZE.height);
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, IMAGE_SIZE.width, IMAGE_SIZE.height);
  context.fillStyle = "#111111";
  context.font = "28px sans-serif";
  context.fillText("Q1. x^2 - 3x + 2 = 0", 40, 70);
  context.fillText("Q2. 2x + 5 = 11", 40, 130);
  context.strokeStyle = "#111111";
  context.lineWidth = 2;
  for (let row = 0; row <= 3; row += 1) {
    context.beginPath();
    context.moveTo(40, 190 + row * 50);
    context.lineTo(600, 190 + row * 50);
    context.stroke();
  }
  for (let column = 0; column <= 4; column += 1) {
    context.beginPath();
    context.moveTo(40 + column * 140, 190);
    context.lineTo(40 + column * 140, 340);
    context.stroke();
  }
  return canvas.toBuffer("image/png");
}

async function prepare(app: ElectronApplication, page: Page) {
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("codex:get-status");
    ipcMain.handle("codex:get-status", () => ({
      available: true, running: true, loggedIn: true, codexHome: "", codexBin: "codex",
      configuredCodexBin: null, account: { type: "chatgpt", email: "check@example.com" }, error: null,
    }));
    const runs: unknown[] = [];
    (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns = runs;
    ipcMain.removeHandler("ai-edit:run");
    ipcMain.handle("ai-edit:run", (_event, _runId: string, payload: unknown) => {
      runs.push(payload);
      throw new Error("stubbed run");
    });
  });
  await page.evaluate(() => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
  });
  await page.reload();
  await page.locator(".text-flow-editor").first().waitFor({ timeout: 180_000 });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator("html")).toHaveAttribute("lang", "ja");
  expect(await page.evaluate(() => window.desktopAPI!.settings!.get())).toMatchObject({ uiLocale: "ja" });
}

function launchEnv(profile: string): Record<string, string> {
  // Seed the isolated profile before startup: setting the locale through IPC
  // during bootstrap can race the renderer saving its detected OS language.
  mkdirSync(path.join(profile, "data"), { recursive: true });
  writeFileSync(path.join(profile, "data", "settings.json"), JSON.stringify({ uiLocale: "ja" }));
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  return env;
}

async function openSideChat(page: Page): Promise<Locator> {
  const sidebar = page.locator(".ai-chat-host--sidebar");
  if (!(await sidebar.isVisible().catch(() => false))) {
    const toolbarButton = page.getByRole("button", { name: "AIチャットを開く" }).first();
    if (await toolbarButton.isVisible().catch(() => false)) {
      await toolbarButton.click();
    } else {
      await page.locator(".app-menu-button", { hasText: /^AI$/ }).click();
      await page.getByRole("menuitem", { name: "AIチャットを開く" }).click();
    }
  }
  await expect(sidebar).toBeVisible();
  return sidebar;
}

async function pasteImage(target: Locator, pngBase64: string, name: string) {
  await target.evaluate((element, { base64, fileName }) => {
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    const transfer = new DataTransfer();
    transfer.items.add(new File([bytes], fileName, { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
  }, { base64: pngBase64, fileName: name });
}

/** 確認用の画像をテストの出力先にも書き出す (list reporter では添付が残らないため)。 */
async function keep(testInfo: TestInfo, name: string, body: Buffer) {
  writeFileSync(testInfo.outputPath(`${name}.png`), body);
  await testInfo.attach(name, { body, contentType: "image/png" });
}

/** 画像の中の割合 (0〜1) を画面座標へ。 */
async function imagePoint(image: Locator, x: number, y: number) {
  const box = (await image.boundingBox())!;
  return { x: box.x + box.width * x, y: box.y + box.height * y };
}

test("comments placed on a pasted image reach the AI as numbered marks and survive a restart", async ({}, testInfo) => {
  test.setTimeout(240_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-image-annotation-"));
  const env = launchEnv(profile);
  const source = ensurePageLayout({ ...sampleDocument, docId: "image_annotation", metadata: { ...sampleDocument.metadata, title: "画像コメントの確認" } });
  const sourceFile = path.join(profile, "画像コメントの確認.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));
  const worksheet = buildWorksheetPng();
  const worksheetBase64 = worksheet.toString("base64");

  let app = await electron.launch({ args: [APP_ROOT, sourceFile, "--lang=en-US"], cwd: APP_ROOT, env });
  try {
    let page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page);

    // サイドチャットに画像を貼ると、画像の左上に「画像にコメント」が出る。
    let sidebar = await openSideChat(page);
    const composer = sidebar.locator(".ai-chat-composer textarea");
    await pasteImage(composer, worksheetBase64, "worksheet.png");
    await expect(sidebar.locator(".ai-chat-attachment-thumb")).toHaveCount(1);
    const annotate = sidebar.getByRole("button", { name: "画像にコメント: worksheet.png" });
    await expect(annotate).toBeVisible();
    await expect(composer).toHaveValue(/添付画像を元教材として読み取り/);

    // 画像を開き、クリックで点・ドラッグで範囲を選んでコメントを付ける。
    await annotate.click();
    const dialog = page.getByRole("dialog", { name: "画像にコメント" });
    await expect(dialog).toBeVisible();
    const image = dialog.getByRole("img", { name: "worksheet.png" });
    await expect(image).toBeVisible();
    const imageBox = (await image.boundingBox())!;
    // 小さな画像でも、ダイアログの中では大きく見せて場所を選びやすくする。
    expect(imageBox.width).toBeGreaterThan(IMAGE_SIZE.width * 0.9);

    const pointTarget = await imagePoint(image, 0.3, 0.17);
    await page.mouse.click(pointTarget.x, pointTarget.y);
    const input = dialog.locator("textarea");
    await expect(input).toBeFocused();
    await page.keyboard.type("ここの符号を確認して");
    await page.keyboard.press("Enter");
    await expect(input).toHaveCount(0);

    const regionStart = await imagePoint(image, 0.06, 0.47);
    const regionEnd = await imagePoint(image, 0.94, 0.85);
    await page.mouse.move(regionStart.x, regionStart.y);
    await page.mouse.down();
    await page.mouse.move((regionStart.x + regionEnd.x) / 2, (regionStart.y + regionEnd.y) / 2, { steps: 5 });
    await page.mouse.move(regionEnd.x, regionEnd.y, { steps: 5 });
    await page.mouse.up();
    await expect(input).toBeFocused();
    await page.keyboard.type("この表は消して");
    await expect(dialog.getByRole("button", { name: "追加", exact: true })).toBeEnabled();
    await page.waitForTimeout(200);
    await keep(testInfo, "dialog-while-typing", await page.screenshot());
    await page.keyboard.press("Enter");

    const list = dialog.getByRole("complementary", { name: "コメント" }).locator("li");
    await expect(list).toHaveCount(2);
    await expect(list.nth(0)).toContainText("ここの符号を確認して");
    await expect(list.nth(1)).toContainText("この表は消して");
    await expect(dialog.getByRole("button", { name: "コメント1を編集" }).first()).toBeVisible();
    await keep(testInfo, "dialog", await page.screenshot());

    // Esc は書きかけだけを閉じ、もう一度の Esc でダイアログを閉じる。
    await page.mouse.click((await imagePoint(image, 0.8, 0.1)).x, (await imagePoint(image, 0.8, 0.1)).y);
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "完了" }).click();
    await expect(dialog).toBeHidden();

    // 入力欄の画像に同じ番号の印が重なり、件数が出る。既定文はコメントに沿う依頼へ入れ替わる。
    const thumb = sidebar.locator(".ai-chat-attachment-thumb");
    await expect(thumb.locator("[class*='badge']")).toHaveCount(2);
    await expect(sidebar.getByRole("button", { name: /画像にコメント: worksheet\.png \(コメント2件\)/ })).toBeVisible();
    await expect(composer).toHaveValue("画像に付けたコメントに沿って対応して。");
    await keep(testInfo, "composer", await sidebar.screenshot());

    // 送信: AIへは印を描き込んだ画像と、同じ番号のコメントが渡る。元の画像は変えない。
    await sidebar.getByRole("button", { name: "送信", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns?.length ?? 0)).toBe(1);
    const payload = await app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns![0]) as {
      instruction: string;
      attachments: Array<{ dataUrl: string; width?: number; height?: number; annotations?: Array<{ x: number; y: number; width?: number; height?: number; comment: string }> }>;
    };
    expect(payload.instruction).toBe("画像に付けたコメントに沿って対応して。");
    const sent = payload.attachments[0]!;
    expect(sent.annotations).toHaveLength(2);
    expect(sent.annotations![0]).toMatchObject({ comment: "ここの符号を確認して" });
    expect(sent.annotations![0]!.x).toBeCloseTo(0.3, 1);
    expect(sent.annotations![0]!.y).toBeCloseTo(0.17, 1);
    expect(sent.annotations![1]).toMatchObject({ comment: "この表は消して" });
    expect(sent.annotations![1]!.width).toBeCloseTo(0.88, 1);
    expect(sent.dataUrl.startsWith("data:image/png;base64,")).toBe(true);
    expect(sent.dataUrl).not.toBe(`data:image/png;base64,${worksheetBase64}`);
    // 印で隠れた文字を読めるよう、印なしの元画像も直後に添える。
    expect(payload.attachments).toHaveLength(2);
    expect(payload.attachments[1]).toMatchObject({ dataUrl: `data:image/png;base64,${worksheetBase64}` });
    expect(payload.attachments[1]).not.toHaveProperty("annotations");
    const composite = Buffer.from(sent.dataUrl.split(",")[1]!, "base64");
    await keep(testInfo, "sent-to-ai", composite);
    // 送った画像は元の解像度のままで、範囲の枠の位置が青くなっている。
    const decoded = await loadImage(composite);
    expect([decoded.width, decoded.height]).toEqual([IMAGE_SIZE.width, IMAGE_SIZE.height]);
    const pixels = createCanvas(decoded.width, decoded.height);
    pixels.getContext("2d").drawImage(decoded, 0, 0);
    const frameLeft = Math.round(sent.annotations![1]!.x * IMAGE_SIZE.width);
    const frameMidY = Math.round((sent.annotations![1]!.y + sent.annotations![1]!.height! / 2) * IMAGE_SIZE.height);
    // 枠の線は縁取り (白) と青の2重で、境目はなめらかに混ざる。線の幅の範囲で最も青い画素を見る。
    const strip = pixels.getContext("2d").getImageData(frameLeft - 4, frameMidY, 9, 1).data;
    let bluest = [255, 255, 255];
    for (let index = 0; index < strip.length; index += 4) {
      if (strip[index + 2]! - strip[index]! > bluest[2]! - bluest[0]!) {
        bluest = [strip[index]!, strip[index + 1]!, strip[index + 2]!];
      }
    }
    expect(bluest[2]).toBeGreaterThan(180);
    expect(bluest[0]).toBeLessThan(90);

    // 履歴には元の画像に同じ印を重ね、コメントを番号順に並べる。
    const userTurn = sidebar.locator(".ai-chat-turn.user").last();
    await expect(userTurn.locator(".ai-chat-user-annotations li")).toHaveCount(2);
    await expect(userTurn.locator(".ai-chat-user-annotations")).toContainText("この表は消して");
    await expect(userTurn.locator(".ai-chat-user-attachment-image [class*='badge']")).toHaveCount(2);
    await expect(sidebar.locator(".ai-chat-attachment-thumb")).toHaveCount(0);
    await keep(testInfo, "history", await sidebar.screenshot());

    // 再起動しても、履歴の画像とコメントが残る (前回開いていた教材をそのまま開き直す)。
    await app.close();
    app = await electron.launch({ args: [APP_ROOT, "--lang=en-US"], cwd: APP_ROOT, env });
    page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page);
    sidebar = await openSideChat(page);
    await keep(testInfo, "after-restart", await page.screenshot());
    const restoredTurn = sidebar.locator(".ai-chat-turn.user").last();
    await expect(restoredTurn.locator(".ai-chat-user-annotations li")).toHaveCount(2, { timeout: 30_000 });
    await expect(restoredTurn.locator(".ai-chat-user-annotations")).toContainText("ここの符号を確認して");
    await expect(restoredTurn.locator(".ai-chat-user-attachment-image [class*='badge']")).toHaveCount(2);
    await keep(testInfo, "history-after-restart", await sidebar.screenshot());
  } catch (error) {
    await app.firstWindow().then(async (page) => keep(testInfo, "failure", await page.screenshot())).catch(() => undefined);
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

async function chordDrag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  await page.keyboard.down("Alt");
  await page.keyboard.down("Shift");
  await expect(page.locator("html")).toHaveAttribute("data-region-capture-ready", "true");
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 6 });
  await page.mouse.move(to.x, to.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.up("Shift");
  await page.keyboard.up("Alt");
}

test("a region screenshot sent to the inline AI can be commented on without closing the inline surface", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-image-annotation-inline-"));
  const env = launchEnv(profile);
  const source = ensurePageLayout({ ...sampleDocument, docId: "image_annotation_inline", metadata: { ...sampleDocument.metadata, title: "スクショへのコメント" } });
  const sourceFile = path.join(profile, "スクショへのコメント.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile, "--lang=en-US"], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page);
    await page.bringToFront();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));

    // Coordinate input has no Playwright actionability wait. Wait for the real
    // capture target to be stable and unobstructed before measuring its bounds.
    const canvas = page.locator(".editor-canvas");
    await canvas.click({ position: { x: 140, y: 90 }, trial: true });
    const canvasBox = (await canvas.boundingBox())!;
    const from = { x: canvasBox.x + 140, y: canvasBox.y + 90 };
    await chordDrag(page, from, { x: from.x + 420, y: from.y + 230 });
    await page.getByRole("toolbar", { name: "スクリーンショット" }).getByRole("button", { name: "AIに聞く" }).click();
    const inline = page.locator(".ai-chat-host--inline");
    await expect(inline.locator(".ai-chat-attachment-thumb")).toHaveCount(1);

    // 画像を押すとコメントの画面が開く。閉じてもインラインのAI面はそのまま残る。
    await inline.locator(".ai-chat-attachment-thumb").click();
    const dialog = page.getByRole("dialog", { name: "画像にコメント" });
    await expect(dialog).toBeVisible();
    const image = dialog.locator("img");
    const target = await imagePoint(image, 0.5, 0.5);
    await page.mouse.click(target.x, target.y);
    await page.keyboard.type("この式を因数分解した形にして");
    await page.keyboard.press("Enter");
    await expect(dialog.locator("li")).toHaveCount(1);
    // 開いた直後のアニメーションが終わってから撮る (Playwright の入力は一瞬で終わる)。
    await page.waitForTimeout(300);
    await keep(testInfo, "inline-dialog", await page.screenshot());
    await dialog.getByRole("button", { name: "完了" }).click();
    await expect(dialog).toBeHidden();
    await expect(inline).toBeVisible();
    await expect(inline.locator(".ai-chat-attachment-thumb [class*='badge']")).toHaveCount(1);
    await keep(testInfo, "inline-composer", await page.screenshot());

    // スクショは下書きの外 (EditorShell) が持つ画像。コメントもそちらに残り、送信で AI へ渡る。
    await inline.getByRole("button", { name: "送信", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns?.length ?? 0)).toBe(1);
    const payload = await app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns![0]) as {
      attachments: Array<{ name: string; annotations?: Array<{ comment: string }> }>;
    };
    expect(payload.attachments[0]?.annotations).toEqual([expect.objectContaining({ comment: "この式を因数分解した形にして" })]);
    expect(payload.attachments[1]?.name).toMatch(/（印なし）\.png$/);
  } catch (error) {
    await app.firstWindow().then(async (page) => keep(testInfo, "failure", await page.screenshot())).catch(() => undefined);
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});

test("a selected shape's preview can be commented on and is sent as a marked-up image", async ({}, testInfo) => {
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-image-annotation-shape-"));
  const env = launchEnv(profile);
  const source = ensurePageLayout({ ...sampleDocument, docId: "image_annotation_shape", metadata: { ...sampleDocument.metadata, title: "図形へのコメント" } });
  const sourceFile = path.join(profile, "図形へのコメント.sigma");
  writeFileSync(sourceFile, JSON.stringify(source));

  const app = await electron.launch({ args: [APP_ROOT, sourceFile, "--lang=en-US"], cwd: APP_ROOT, env });
  try {
    const page = await app.firstWindow();
    await page.waitForURL(/^(https?|file):/, { timeout: 120_000 });
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await prepare(app, page);

    // 紙面にグラフを置く (置いた直後は選択されたまま)。
    await page.getByRole("button", { name: "挿入", exact: true }).click();
    await page.getByRole("menu", { name: "挿入", exact: true }).getByRole("menuitem", { name: "グラフ" }).click();
    const insertion = page.locator(".overlay-canvas-editor.inserting").first();
    await expect(insertion).toBeVisible();
    const surface = (await insertion.boundingBox())!;
    await page.mouse.move(surface.x + 200, surface.y + 120);
    await page.mouse.down();
    await page.mouse.move(surface.x + 600, surface.y + 340, { steps: 8 });
    await page.mouse.up();
    await expect(page.locator(".graph-shape").first()).toBeVisible();

    // サイドチャットの入力欄に、選んだ図形のプレビューが入る。そこにもコメントを付けられる。
    const sidebar = await openSideChat(page);
    const preview = sidebar.locator(".ai-chat-overlay-preview");
    await expect(preview).toHaveCount(1);
    await preview.getByRole("button", { name: /^画像にコメント: / }).click();
    const dialog = page.getByRole("dialog", { name: "画像にコメント" });
    await expect(dialog).toBeVisible();
    // グラフは紙面のCSSで描くので、ダイアログでも入力欄のサムネと同じく軸が見える (白紙にならない)。
    const image = dialog.getByRole("img", { name: /^選択図形/ });
    await expect(image.locator(".graph2d-axes")).toHaveCount(1);
    const start = await imagePoint(image, 0.55, 0.2);
    const end = await imagePoint(image, 0.85, 0.45);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(end.x, end.y, { steps: 6 });
    await page.mouse.up();
    await page.keyboard.type("この部分の目盛りを細かくして");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(300);
    await keep(testInfo, "shape-dialog", await page.screenshot());
    await dialog.getByRole("button", { name: "完了" }).click();
    await expect(preview.locator("[class*='badge']")).toHaveCount(1);
    await keep(testInfo, "shape-composer", await sidebar.screenshot());

    // 送信: 図形のプレビューPNGに印を描き込み、コメントを付けて渡す。
    await sidebar.getByRole("button", { name: "送信", exact: true }).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns?.length ?? 0)).toBe(1);
    const payload = await app.evaluate(() => (globalThis as { __annotationRuns?: unknown[] }).__annotationRuns![0]) as {
      instruction: string;
      attachments: Array<{ name: string; dataUrl: string; sourceReferenceKey?: string; annotations?: Array<{ comment: string; width?: number }> }>;
    };
    const annotated = payload.attachments.find((attachment) => attachment.annotations?.length);
    expect(annotated?.sourceReferenceKey).toBeTruthy();
    expect(annotated?.annotations).toEqual([expect.objectContaining({ comment: "この部分の目盛りを細かくして", width: expect.any(Number) })]);
    expect(payload.instruction).toBe("画像に付けたコメントに沿って対応して。");
    const shapePng = Buffer.from(annotated!.dataUrl.split(",")[1]!, "base64");
    await keep(testInfo, "shape-sent-to-ai", shapePng);
    // グラフの軸は紙面の CSS で描く。CSS を埋め込まずに画像にすると線が消えて白紙になっていた。
    const shapeImage = await loadImage(shapePng);
    const shapeCanvas = createCanvas(shapeImage.width, shapeImage.height);
    shapeCanvas.getContext("2d").drawImage(shapeImage, 0, 0);
    const shapePixels = shapeCanvas.getContext("2d").getImageData(0, 0, shapeImage.width, shapeImage.height).data;
    let darkPixels = 0;
    for (let index = 0; index < shapePixels.length; index += 4) {
      if (shapePixels[index]! < 110 && shapePixels[index + 1]! < 110 && shapePixels[index + 2]! < 110) darkPixels += 1;
    }
    expect(darkPixels).toBeGreaterThan(Math.max(shapeImage.width, shapeImage.height));

    // 履歴の図形サムネにも同じ印とコメントが出る。
    const userTurn = sidebar.locator(".ai-chat-turn.user").last();
    await expect(userTurn.locator(".ai-chat-user-annotations li")).toHaveCount(1);
    await keep(testInfo, "shape-history", await sidebar.screenshot());
  } catch (error) {
    await app.firstWindow().then(async (page) => keep(testInfo, "failure", await page.screenshot())).catch(() => undefined);
    throw error;
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
