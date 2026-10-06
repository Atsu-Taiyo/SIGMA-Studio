import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { grabShapeFromBody } from "../e2e/body-overlay-entry";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout, type SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

/** 入れるだけで挿入しない 2 つ目の文章。ポケットがどこにも保存されないことを、この文字列の在り処で確かめる。 */
const POCKET_ONLY_TEXT = "ポケットにだけ置く文章XQZ";
const CARRIED_TEXT = "別の教材へ運ぶ文章";

/** ユーザーデータ配下で、指定の文字列を含むファイル (1MB 以下のテキストだけ読む)。 */
function filesContaining(root: string, needle: string): string[] {
  const hits: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (entry.isFile() && statSync(entryPath).size <= 1_000_000) {
        try {
          if (readFileSync(entryPath).includes(needle)) hits.push(path.relative(root, entryPath));
        } catch {
          // 他のプロセスが握っているファイルは読めなくてよい。
        }
      }
    }
  };
  visit(root);
  return hits;
}

async function selectBody(page: Page, id: string, from: number, to: number) {
  await page.evaluate(({ id, from, to }) => {
    const block = document.querySelector(`[data-sigma-doc-id="${id}"]`)!;
    const editor = block.closest<HTMLElement>(".ProseMirror")!;
    editor.focus();
    const text = document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode()!;
    const range = document.createRange();
    range.setStart(text, from);
    range.setEnd(text, to);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  }, { id, from, to });
}

function sourceDocument(): SigmaDocument {
  const source = ensurePageLayout({
    ...sampleDocument,
    version: "2.0",
    docId: "electron_pocket",
    metadata: { title: "ポケット 実機検証" },
    content: [
      { type: "paragraph", id: "body_carried", children: [{ type: "text", text: CARRIED_TEXT }] },
      { type: "paragraph", id: "body_pocket_only", children: [{ type: "text", text: POCKET_ONLY_TEXT }] },
    ],
  });
  source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [{
    id: "shape_pocket",
    type: "geo",
    x: 100,
    y: 360,
    rotation: 0,
    props: { w: 160, h: 90, geo: "rectangle", fill: "solid", color: "#1133cc", labelColor: "#111111", dash: "solid", size: "m" },
  }] } };
  return source;
}

async function prepare(app: ElectronApplication): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await expect(page.locator(".page-flow .ProseMirror").first()).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
  return page;
}

test("the pocket carries text and a shape to another material in the real app, off the clipboard and off disk", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const launch = () => electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  let app = await launch();
  try {
    let page = await prepare(app);
    const source = sourceDocument();
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="body_carried"]')).toBeVisible();
    const cards = () => page.locator("[data-pocket-item] button[data-kind]");

    // ポケットは OS のクリップボードに触れない: 前後で文字が同じ (テストは書き換えない)。
    // 普通のコピーなら text/plain も書かれるので、ここが変わらないことで書き込みが無いと分かる。
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const clipboardBefore = await clipboard();

    await selectBody(page, "body_carried", 0, CARRIED_TEXT.length);
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    await expect(cards()).toHaveCount(1);
    await expect(cards().first()).toHaveAttribute("data-kind", "blocks");
    await expect(cards().first()).toContainText(CARRIED_TEXT);

    await selectBody(page, "body_pocket_only", 0, POCKET_ONLY_TEXT.length);
    await page.getByRole("button", { name: "ポケットに追加" }).click();
    await expect(cards()).toHaveCount(2);

    await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="shape_pocket"]').first());
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    await expect(cards()).toHaveCount(3);
    await expect(cards().nth(2)).toHaveAttribute("data-kind", "shapes");
    await expect(cards().nth(2).locator("img")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("pocket-expanded.png") });

    // 別の教材 (新しいタブ) へ運ぶ。ポケットはタブを跨いで残る。
    // 図形を掴んだままタブを増やすと切り替えが間に合わないことがあるので、先に本文へ戻る
    // (オーバーレイ編集中は locator の click が遮られるので、座標で押す)。
    const box = await page.locator('.text-flow-editor [data-sigma-doc-id="body_pocket_only"]').first().boundingBox();
    await page.mouse.click(box!.x + box!.width - 8, box!.y + box!.height / 2);
    await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
    await page.getByRole("button", { name: "新規教材", exact: true }).click();
    await expect(page.locator(".document-tab")).toHaveCount(2);
    await expect(page.locator('[data-sigma-doc-id="body_carried"]')).toHaveCount(0);
    await expect(cards()).toHaveCount(3);

    await page.locator(".page-flow .ProseMirror").first().click();
    await cards().nth(0).click();
    await expect(page.locator(".page-flow .ProseMirror").first()).toContainText(CARRIED_TEXT);
    await cards().nth(2).click();
    await expect.poll(() => page.locator("[data-overlay-shape-id]").count()).toBeGreaterThan(0);
    await page.screenshot({ path: testInfo.outputPath("pocket-inserted.png") });

    // ポケットからの挿入も、本文・図形の順に一操作ずつ取り消し、やり直せる。
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(page.locator("[data-overlay-shape-id]")).toHaveCount(0);
    await expect(page.locator(".page-flow .ProseMirror").first()).toContainText(CARRIED_TEXT);
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(page.locator(".page-flow .ProseMirror").first()).not.toContainText(CARRIED_TEXT);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(page.locator(".page-flow .ProseMirror").first()).toContainText(CARRIED_TEXT);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(page.locator("[data-overlay-shape-id]")).toHaveCount(1);

    // 保存された結果: 運んだ文章と図形は新しい教材に入り、運ばなかった文章は入っていない。
    // 新しい教材のファイルは、元の教材以外のうち運んだ文章を持つもの (初期の無題の教材も並んでいる)。
    const savedCarrier = (sourceFileId: string) => page.evaluate(async ({ sourceFileId, carried }) => {
      const files = await window.desktopAPI!.storage.listFiles();
      for (const file of files.filter((candidate) => candidate.fileId !== sourceFileId)) {
        const document = await window.desktopAPI!.storage.loadDocument(file.fileId);
        if (JSON.stringify(document).includes(carried)) return document;
      }
      return null;
    }, { sourceFileId, carried: CARRIED_TEXT });
    await expect.poll(async () => (await savedCarrier(created.file.fileId)) !== null).toBe(true);
    const carrier = await savedCarrier(created.file.fileId);
    expect(JSON.stringify(carrier?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])).toContain("rectangle");
    expect(JSON.stringify(carrier)).not.toContain(POCKET_ONLY_TEXT);
    // 元の教材は読み出しただけで書き換わっていない。
    const sourceAfter = await page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
    expect(sourceAfter?.content.map((block) => block.id)).toEqual(["body_carried", "body_pocket_only"]);
    expect(sourceAfter?.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id)).toEqual(["shape_pocket"]);

    // クリップボードは前後で変わらない。
    expect(await clipboard()).toEqual(clipboardBefore);

    // ポケットだけにあった文章は、元の教材のファイルにしか無い (別ファイル・設定・ブラウザの保存領域へ漏れていない)。
    await app.close();
    const holders = filesContaining(userData, POCKET_ONLY_TEXT);
    expect(holders.filter((file) => !file.includes(created.file.fileId))).toEqual([]);

    // 再起動すると、ポケットは空になり、挿入した結果は保存から戻る。
    app = await launch();
    page = await prepare(app);
    await expect(page.locator("[data-pocket-root]")).toHaveCount(0);
    await expect.poll(async () => (await savedCarrier(created.file.fileId)) !== null).toBe(true);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/**
 * アプリを終える。保存されていない無題のホワイトボードが開いていると、終了は確認を待ち続けるので、
 * 待ちきれなければ強制的に終わらせる (テストが終わらなくなるのを避けるだけで、検証の対象ではない)。
 */
async function closeApp(app: ElectronApplication): Promise<void> {
  const closed = app.close().then(() => "closed" as const, () => "closed" as const);
  const timedOut = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 8000));
  if ((await Promise.race([closed, timedOut])) === "timeout") {
    app.process().kill("SIGKILL");
  }
}

/** カードを掴んで画面の (x, y) まで運んで離す。 */
async function dragCardTo(page: Page, card: ReturnType<Page["locator"]>, x: number, y: number) {
  const box = await card.boundingBox();
  if (!box) throw new Error("card is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.up();
}

test("dragging a card lands it where it is dropped, on the page and on a whiteboard, in the real app", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-drag-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await prepare(app);
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), sourceDocument());
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="body_carried"]')).toBeVisible();
    const cards = () => page.locator("[data-pocket-item] button[data-kind]");

    await selectBody(page, "body_carried", 0, CARRIED_TEXT.length);
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="shape_pocket"]').first());
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    await expect(cards()).toHaveCount(2);

    // 本文の「ポケットにだけ置く文章」の頭 (左端) へ文章のカードを落とす。
    // 図形を掴んだまま (図形のレイヤーが本文を覆っている最中) でも、落とした位置へ入る。
    const target = page.locator('.text-flow-editor [data-sigma-doc-id="body_pocket_only"]').first();
    const targetBox = (await target.boundingBox())!;
    await dragCardTo(page, cards().nth(0), targetBox.x + 2, targetBox.y + targetBox.height / 2);
    await expect(target).toContainText(CARRIED_TEXT);
    const droppedText = (await target.innerText()).replace(/\s+/g, "");
    expect(droppedText.indexOf(CARRIED_TEXT)).toBeLessThan(droppedText.indexOf(POCKET_ONLY_TEXT));
    await page.screenshot({ path: testInfo.outputPath("pocket-drop-body.png") });
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(target).not.toContainText(CARRIED_TEXT);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(target).toContainText(CARRIED_TEXT);

    // 紙面の空白へ図形のカードを落とす: ポインタの位置が図形の中心になる。
    const paperTarget = { x: targetBox.x + targetBox.width / 2, y: targetBox.y + 220 };
    const shapesBefore = await page.locator(".overlay-shape").count();
    await dragCardTo(page, cards().nth(1), paperTarget.x, paperTarget.y);
    await expect.poll(() => page.locator(".overlay-shape").count()).toBeGreaterThan(shapesBefore);
    const pasted = (await page.locator('.overlay-shape:not([data-overlay-shape-id="shape_pocket"])').last().boundingBox())!;
    expect(Math.abs(pasted.x + pasted.width / 2 - paperTarget.x)).toBeLessThanOrEqual(8);
    expect(Math.abs(pasted.y + pasted.height / 2 - paperTarget.y)).toBeLessThanOrEqual(8);
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(page.locator(".overlay-shape")).toHaveCount(shapesBefore);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(page.locator(".overlay-shape")).toHaveCount(shapesBefore + 1);

    // 保存された結果: 落とした文章が、落とした位置 (文章の前) のまま、図形も 2 つになって教材に入っている。
    const savedSource = () => page.evaluate((fileId) => window.desktopAPI!.storage.loadDocument(fileId), created.file.fileId);
    await expect.poll(async () => JSON.stringify((await savedSource())?.content ?? []).includes(`${CARRIED_TEXT}${POCKET_ONLY_TEXT}`)).toBe(true);
    await expect.poll(async () => (await savedSource())?.pageLayout?.overlay?.overlaySnapshot?.shapes.length ?? 0).toBe(2);

    // ホワイトボード: 本文のコピーは文章の図形 (オーバーレイ) として、落とした位置に置かれる。
    // (新規のホワイトボードのタブは、普通の貼り付けでも変更前から保存されないので、ここでは画面の結果だけを見る。
    //  図形の保存・読み込みの往復は clipboard-overlay-payload.test.ts がスキーマ検証で担保している。)
    const box = await target.boundingBox();
    await page.mouse.click(box!.x + box!.width - 8, box!.y + box!.height / 2);
    await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
    await page.getByRole("button", { name: "新規教材" }).hover();
    await page.getByRole("menuitem", { name: "ホワイトボード", exact: true }).click();
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
    await expect(cards()).toHaveCount(2);

    const viewport = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
    const drop = { x: viewport.x + 420, y: viewport.y + 280 };
    await dragCardTo(page, cards().nth(0), drop.x, drop.y);
    const textShape = page.locator(".overlay-shape", { hasText: CARRIED_TEXT });
    await expect(textShape).toHaveCount(1);
    const textBox = (await textShape.first().boundingBox())!;
    expect(Math.abs(textBox.x + textBox.width / 2 - drop.x)).toBeLessThanOrEqual(8);
    expect(textBox.y).toBeLessThanOrEqual(drop.y);
    expect(textBox.y + textBox.height).toBeGreaterThanOrEqual(drop.y);
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(textShape).toHaveCount(0);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(textShape).toHaveCount(1);

    // クリックでの挿入は、見えている範囲に文章の図形を置く。
    await page.mouse.click(viewport.x + 60, viewport.y + viewport.height - 60);
    await cards().nth(0).click();
    await expect(textShape).toHaveCount(2);
    await dragCardTo(page, cards().nth(1), viewport.x + 700, viewport.y + 420);
    await expect.poll(() => page.locator(".overlay-shape").count()).toBe(3);
    await page.screenshot({ path: testInfo.outputPath("pocket-whiteboard.png") });
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("the selected part flies into the pocket, and the closed pocket is a chip at the top centre, in the real app", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-fly-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await prepare(app);
    await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), sourceDocument());
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="body_carried"]')).toBeVisible();
    const cards = () => page.locator("[data-pocket-item] button[data-kind]");

    await selectBody(page, "body_carried", 0, CARRIED_TEXT.length);
    // 入れると、ポケットが上から開く。高さが途中の値を通って 88px になる (一瞬で切り替わらない)。
    await page.evaluate(() => {
      const heights: number[] = [];
      (window as unknown as { __pocketHeights: number[] }).__pocketHeights = heights;
      // 開き切って少し経つまで記録する (クリックまでの間も、上限までは待つ)。
      let settled = 0;
      const tick = () => {
        const height = document.querySelector("[data-pocket-root]")?.getBoundingClientRect().height ?? 0;
        heights.push(height);
        settled = height === 88 ? settled + 1 : 0;
        if (settled < 10 && heights.length < 1200) window.requestAnimationFrame(tick);
      };
      window.requestAnimationFrame(tick);
    });
    await page.getByRole("button", { name: "ポケットに追加" }).click();

    // 選んでいた部分が、ポケットのカードへ飛んでいく。飛ぶ間は本物のカードは隠れ、着くと現れる。
    const flyer = page.locator("[data-pocket-flyer]");
    await expect(flyer).toBeVisible();
    await expect(cards().first()).toHaveAttribute("data-flying", "true");
    await page.screenshot({ path: testInfo.outputPath("pocket-flying.png") });
    await expect(flyer).toHaveCount(0);
    await expect(cards().first()).not.toHaveAttribute("data-flying", "true");
    const heights = await page.evaluate(() => (window as unknown as { __pocketHeights: number[] }).__pocketHeights);
    expect(heights.some((height) => height > 8 && height < 80)).toBe(true);
    expect(heights[heights.length - 1]).toBe(88);

    // 畳むと、チップは普段は見えない。上部へマウスを持っていくと、上部の真ん中に現れる。
    await page.locator("[data-pocket-root]").getByRole("button", { name: "ポケットを閉じる" }).click();
    const handle = page.locator("[data-pocket-root]").getByRole("button", { name: /ポケット 1件/ });
    const opacity = () => handle.evaluate((element) => parseFloat(getComputedStyle(element).opacity));
    const bar = (await page.locator("[data-pocket-root]").boundingBox())!;
    await page.mouse.move(700, bar.y + 300);
    await expect.poll(opacity).toBe(0);
    await page.mouse.move(700, bar.y + 12, { steps: 4 });
    await expect.poll(opacity).toBe(1);
    const chip = (await handle.boundingBox())!;
    const width = await page.evaluate(() => window.innerWidth);
    expect(Math.abs(chip.x + chip.width / 2 - width / 2)).toBeLessThanOrEqual(2);
    await page.screenshot({ path: testInfo.outputPath("pocket-closed-chip.png") });
    await handle.click();
    await expect(cards()).toHaveCount(1);
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("text copied across blocks pastes onto a new whiteboard as one text shape, through the real clipboard", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-wb-paste-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  // OS のクリップボードを実際に使うので、終わったら元の文字へ戻す。
  const clipboardBefore = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const page = await prepare(app);
    await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), sourceDocument());
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="body_carried"]')).toBeVisible();

    // 2 つのブロックにまたがる範囲を選んで、ふつうにコピーする。
    await page.evaluate(() => {
      const first = document.querySelector('[data-sigma-doc-id="body_carried"]')!;
      const second = document.querySelector('[data-sigma-doc-id="body_pocket_only"]')!;
      first.closest<HTMLElement>(".ProseMirror")!.focus();
      const start = document.createTreeWalker(first, NodeFilter.SHOW_TEXT).nextNode()!;
      const end = document.createTreeWalker(second, NodeFilter.SHOW_TEXT).nextNode()!;
      const range = document.createRange();
      range.setStart(start, 0);
      range.setEnd(end, end.textContent!.length);
      const selection = window.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    await page.keyboard.press("ControlOrMeta+C");

    await page.getByRole("button", { name: "新規教材" }).hover();
    await page.getByRole("menuitem", { name: "ホワイトボード", exact: true }).click();
    const canvas = page.locator(".whiteboard-page-canvas");
    await expect(canvas).toBeVisible();
    const viewport = (await canvas.boundingBox())!;
    await page.mouse.click(viewport.x + 80, viewport.y + viewport.height - 80);
    await expect(page.locator(".overlay-shape")).toHaveCount(0);

    await page.keyboard.press("ControlOrMeta+V");

    // 本文は貼る場所が無いので、テキスト部分が文章の図形 1 つになり、見えている範囲の中央に置かれる。
    const shape = page.locator(".overlay-shape", { hasText: CARRIED_TEXT });
    await expect(shape).toHaveCount(1);
    await expect(shape.first()).toContainText(POCKET_ONLY_TEXT);
    const box = (await shape.first().boundingBox())!;
    expect(Math.abs(box.x + box.width / 2 - (viewport.x + viewport.width / 2))).toBeLessThanOrEqual(40);
    expect(Math.abs(box.y + box.height / 2 - (viewport.y + viewport.height / 2))).toBeLessThanOrEqual(60);
    await page.screenshot({ path: testInfo.outputPath("whiteboard-body-paste.png") });

    // パンとズームのあと (原点より左上の負の座標を見ている) でも、見えている場所へ貼られる。
    // 紙の範囲へ押し戻すと、画面の外へ出て、貼れたのに何も見えなくなる。
    await page.mouse.move(viewport.x + viewport.width / 2, viewport.y + viewport.height / 2);
    await page.mouse.wheel(-1500, -900);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, 200);
    await page.keyboard.up("Control");
    await expect.poll(() => canvas.evaluate((element) => parseFloat(getComputedStyle(element).getPropertyValue("--whiteboard-pan-x")))).toBeGreaterThan(500);
    await page.mouse.click(viewport.x + 60, viewport.y + viewport.height - 60);

    await page.keyboard.press("ControlOrMeta+V");

    await expect(page.locator(".overlay-shape", { hasText: CARRIED_TEXT })).toHaveCount(2);
    const panned = await page.locator(".overlay-shape", { hasText: CARRIED_TEXT }).evaluateAll((elements) => elements.map((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
    }));
    const inView = panned.filter((rect) => rect.x >= viewport.x - 1 && rect.y >= viewport.y - 1
      && rect.right <= viewport.x + viewport.width + 1 && rect.bottom <= viewport.y + viewport.height + 1);
    // 最初に貼った 1 つはパンで画面の外へ出ている。あとから貼った 1 つだけが、見えている範囲にある。
    expect(inView).toHaveLength(1);
    await page.screenshot({ path: testInfo.outputPath("whiteboard-body-paste-panned.png") });
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), clipboardBefore).catch(() => undefined);
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a pocket body drop containing a problem is one undo step and survives redo and reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-body-undo-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await prepare(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1200));
    const source = sourceDocument();
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [] } };
    source.content = [
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "問題の前の段落です。" }] },
      {
        type: "problem", id: "problem_source", tags: [], lead: [], hints: [],
        prompt: [{ type: "paragraph", id: "problem_prompt", children: [{ type: "text", text: "問題文です。" }] }],
        solution: [{ type: "paragraph", id: "problem_solution", children: [{ type: "text", text: "解答です。" }] }],
      },
      { type: "paragraph", id: "p_after", children: [{ type: "text", text: "問題の後の段落です。" }] },
      { type: "paragraph", id: "p_target", children: [{ type: "text", text: "貼り付け先です。" }] },
    ];
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    await page.reload();
    const before = page.locator('.text-flow-editor [data-sigma-doc-id="p_before"]').first();
    await expect(before).toBeVisible();
    await before.click();
    await page.keyboard.press("ControlOrMeta+KeyA");
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    const card = page.locator("[data-pocket-item] button[data-kind]").first();
    await expect(card).toHaveAttribute("data-kind", "blocks");
    await expect(card).toContainText("問題文です。");
    await expect(page.locator("[data-pocket-flyer]")).toHaveCount(0);
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), created.file.fileId);
    const original = (await saved())!.content;
    const target = page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]').first();
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await dragCardTo(page, card, box.x + box.width - 4, box.y + box.height / 2);
    await expect.poll(async () => (await saved())!.content.filter(block => block.type === "problem").length).toBe(2);
    const inserted = (await saved())!.content;
    await page.screenshot({ path: testInfo.outputPath("problem-drop.png") });
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect.poll(async () => (await saved())!.content).toEqual(original);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect.poll(async () => (await saved())!.content).toEqual(inserted);
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_before"]').first()).toBeVisible();
    expect((await saved())!.content).toEqual(inserted);
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("a pocket body drop into an empty paragraph is one undo step", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-body-undo-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await prepare(app);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1400, 1200));
    const source = sourceDocument();
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [] } };
    source.content = [
      { type: "paragraph", id: "p_before", children: [{ type: "text", text: "数式と文章" }, { type: "mathInline", id: "m", tex: "x^2+1", display: "inline", semanticRole: "expression" }] },
      { type: "paragraph", id: "p_target", children: [] },
    ];
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    await page.reload();
    const before = page.locator('.text-flow-editor [data-sigma-doc-id="p_before"]').first();
    await expect(before).toBeVisible();
    await before.click();
    await page.keyboard.press("ControlOrMeta+KeyA");
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    const card = page.locator("[data-pocket-item] button[data-kind]").first();
    await expect(card).toHaveAttribute("data-kind", "blocks");
    await expect(card).toContainText("数式と文章");
    await expect(page.locator("[data-pocket-flyer]")).toHaveCount(0);
    const saved = () => page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), created.file.fileId);
    const original = (await saved())!.content;
    const target = page.locator('.text-flow-editor [data-sigma-doc-id="p_target"]').first();
    await target.scrollIntoViewIfNeeded();
    const box = (await target.boundingBox())!;
    await dragCardTo(page, card, box.x + box.width - 4, box.y + box.height / 2);
    await expect.poll(async () => JSON.stringify((await saved())!.content).split("数式と文章").length).toBe(3);
    const inserted = (await saved())!.content;
    await page.screenshot({ path: testInfo.outputPath("empty-drop.png") });
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect.poll(async () => (await saved())!.content).toEqual(original);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect.poll(async () => (await saved())!.content).toEqual(inserted);
    await page.reload();
    await expect(page.locator('.text-flow-editor [data-sigma-doc-id="p_before"]').first()).toBeVisible();
    expect((await saved())!.content).toEqual(inserted);
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("consecutive pocket body drops are separately undoable", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Run npm run electron:build first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const userData = mkdtempSync(path.join(tmpdir(), "sigma-pocket-repeat-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = userData;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${userData}`], cwd: APP_ROOT, env });
  try {
    const page = await prepare(app);
    await page.emulateMedia({ reducedMotion: "reduce" });
    const source = sourceDocument();
    source.pageLayout!.overlay = { overlaySnapshot: { version: 1, assets: {}, shapes: [] } };
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), source);
    const savedText = () => page.evaluate(async (id) => JSON.stringify((await window.desktopAPI!.storage.loadDocument(id))!.content), created.file.fileId);
    await page.reload();
    await expect(page.locator('[data-sigma-doc-id="body_carried"]').first()).toBeVisible();
    await selectBody(page, "body_carried", 0, CARRIED_TEXT.length);
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
    const card = page.locator("[data-pocket-item] button[data-kind]").first();
    await expect(card).toBeVisible();
    await expect.poll(() => page.locator("[data-pocket-root]").evaluate(element => element.getBoundingClientRect().height)).toBe(88);
    const target = page.locator('.text-flow-editor [data-sigma-doc-id="body_pocket_only"]').first();
    await card.click({ trial: true });
    const box = (await target.boundingBox())!;
    for (let count = 0; count < 2; count++) {
      await dragCardTo(page, card, box.x + 2, box.y + box.height / 2);
      await expect(target).toContainText(CARRIED_TEXT.repeat(count + 1));
    }
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(target).toContainText(CARRIED_TEXT);
    await expect(target).not.toContainText(CARRIED_TEXT.repeat(2));
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(target).not.toContainText(CARRIED_TEXT);
    await expect.poll(async () => (await savedText()).split(CARRIED_TEXT).length).toBe(2);
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(target).toContainText(CARRIED_TEXT);
    await expect(target).not.toContainText(CARRIED_TEXT.repeat(2));
    await page.keyboard.press("ControlOrMeta+Shift+KeyZ");
    await expect(target).toContainText(CARRIED_TEXT.repeat(2));
    await expect.poll(async () => (await savedText()).split(CARRIED_TEXT).length).toBe(4);
    await page.keyboard.press("ControlOrMeta+KeyZ");
    await expect(target).not.toContainText(CARRIED_TEXT.repeat(2));
    await expect.poll(async () => (await savedText()).split(CARRIED_TEXT).length).toBe(3);
    await page.reload();
    await expect(target).toContainText(CARRIED_TEXT);
    await expect(target).not.toContainText(CARRIED_TEXT.repeat(2));
  } finally {
    await closeApp(app);
    rmSync(userData, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
