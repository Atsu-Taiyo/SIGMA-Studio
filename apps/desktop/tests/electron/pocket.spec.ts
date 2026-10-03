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
    await page.getByRole("button", { name: "ポケットに入れる" }).click();
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
    rmSync(userData, { recursive: true, force: true });
  }
});
