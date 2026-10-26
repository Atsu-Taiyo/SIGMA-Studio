import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import type { ListNode, SigmaDocument } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";

/**
 * `(1)` のリストを実アプリで固定する。
 *
 * - リストの前後に段落より広い隙間が空いていた (UA 既定の 1em の margin)。段落と同じ間隔にする。
 * - 字下げが 40px で深すぎた。既定はマーカーの左端が本文の左端に揃う幅。
 * - キャレットのあるリストに字下げのつまみ (▼) が出て、左右に引くと文字の始まる線が動き、保存される。
 * - 行頭の `(a) `・`(i) ` でも番号付きリストになる。
 */

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL ?? process.env.SIGMA_STUDIO_DEV_SERVER_URL;
const text = (value: string) => [{ type: "text" as const, text: value }];

function indentDocument(title: string): SigmaDocument {
  const document = createBlankDocument(title);
  document.content = [
    { type: "paragraph", id: "p_1", children: text("段落1") },
    { type: "paragraph", id: "p_2", children: text("段落2") },
    {
      type: "list",
      id: "list_main",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        { type: "listItem", id: "li_1", children: text("項目1") },
        { type: "listItem", id: "li_2", children: text("項目2") },
      ],
    },
    { type: "paragraph", id: "p_3", children: text("段落3") },
    { type: "paragraph", id: "p_after", children: text("リストの後") },
  ];
  return document;
}

async function launch(profile: string, file?: string): Promise<{ app: ElectronApplication; page: Page }> {
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`, ...(file ? [file] : [])], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  return { app, page };
}

async function launchWithDocument(profile: string, document: SigmaDocument): Promise<{ app: ElectronApplication; page: Page; fileId: string }> {
  const title = document.metadata.title;
  const file = path.join(profile, `${title}.sigma`);
  writeFileSync(file, JSON.stringify(document));
  const { app, page } = await launch(profile, file);
  await page.evaluate(async () => {
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
    await window.desktopAPI!.settings!.setUiLocale!("ja");
  });
  await page.reload();
  await waitForDocument(page);
  const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
  return { app, page, fileId: files.find((entry) => entry.title === title)!.fileId };
}

async function waitForDocument(page: Page): Promise<void> {
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible({ timeout: 60_000 });
}

async function savedLists(page: Page, fileId: string): Promise<ListNode[]> {
  return page.evaluate(async (id) => {
    const document = await window.desktopAPI!.storage.loadDocument(id);
    return (document?.content ?? []).filter((block): block is ListNode => block.type === "list");
  }, fileId);
}

/** 要素の上端・下端・左端 (紙面の倍率を外した値)。 */
async function boxes(page: Page, ids: string[]) {
  return page.evaluate((blockIds) => Object.fromEntries(blockIds.map((id) => {
    const rect = document.querySelector(`.page-flow [data-sigma-doc-id="${id}"]`)!.getBoundingClientRect();
    return [id, { top: rect.top, bottom: rect.bottom, left: rect.left }];
  })), ids);
}

/** 段落の DOM 選択の末尾へキャレットを置く (macOS の合成 End キーは当てにならない)。 */
async function placeCaretAtEnd(page: Page, id: string): Promise<void> {
  await page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).click();
  await page.evaluate((blockId) => {
    const block = document.querySelector(`.page-flow [data-sigma-doc-id="${blockId}"]`)!;
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
    window.getSelection()!.collapse(last!, last!.length);
  }, id);
  await page.waitForTimeout(100);
}

test.beforeEach(() => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
});

test("a list sits at paragraph spacing, and its indent slider moves the text line and is saved", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-list-indent-"));
  const opened = await launchWithDocument(profile, indentDocument("リストの字下げ"));
  const { fileId } = opened;
  let { app, page } = opened;
  try {
    const before = await boxes(page, ["p_1", "p_2", "li_1", "li_2", "p_3"]);
    const paragraphGap = before.p_2.top - before.p_1.bottom;
    // リストの前後も項目の間も、段落どうしと同じ間隔。
    expect(Math.abs(before.li_1.top - before.p_2.bottom - paragraphGap)).toBeLessThan(0.5);
    expect(Math.abs(before.p_3.top - before.li_2.bottom - paragraphGap)).toBeLessThan(0.5);
    expect(Math.abs(before.li_2.top - before.li_1.bottom - paragraphGap)).toBeLessThan(0.5);
    // 既定の字下げは 1.75字 (`(1) ` の幅)。UA 既定の 40px より浅い。
    const fontSizePx = await page.locator(".page-flow ol").evaluate((list) => Number.parseFloat(getComputedStyle(list).fontSize));
    expect(before.li_1.left - before.p_1.left).toBeLessThan(40);

    const knob = page.locator(".page-flow .list-indent-slider-knob");
    await expect(knob).toBeHidden();
    await placeCaretAtEnd(page, "li_1");
    await expect(knob).toBeVisible();
    await expect(knob).toHaveAttribute("aria-valuenow", "1.75");

    const knobBox = (await knob.boundingBox())!;
    const scale = await page.locator(".page-flow ol").evaluate((list) => list.getBoundingClientRect().width / (list as HTMLElement).offsetWidth);
    const x = knobBox.x + knobBox.width / 2;
    const y = knobBox.y + knobBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    // 2字ぶん右へ → 3.75字。
    await page.mouse.move(x + 2 * fontSizePx * scale, y, { steps: 8 });
    await expect(page.locator(".page-flow .list-indent-slider-value")).toHaveText("3.75字");
    await page.screenshot({ path: testInfo.outputPath("list-indent-drag.png"), caret: "initial" });
    await page.mouse.up();
    await expect.poll(async () => (await savedLists(page, fileId))[0]?.indentEm).toBe(3.75);
    const moved = await boxes(page, ["p_1", "li_1"]);
    expect(Math.abs(moved.li_1.left - moved.p_1.left - (3.75 * fontSizePx * scale))).toBeLessThan(1);

    // 元に戻すは 1 回で戻る (引いている途中の見た目は履歴に積まない)。
    await page.keyboard.press("Meta+z");
    await expect.poll(async () => (await savedLists(page, fileId))[0]?.indentEm).toBeUndefined();
    await page.keyboard.press("Meta+Shift+z");
    await expect.poll(async () => (await savedLists(page, fileId))[0]?.indentEm).toBe(3.75);

    // 開き直しても同じ位置。
    await app.close();
    ({ app, page } = await launch(profile));
    await waitForDocument(page);
    const reopened = await boxes(page, ["p_1", "li_1"]);
    expect(Math.abs(reopened.li_1.left - reopened.p_1.left - (moved.li_1.left - moved.p_1.left))).toBeLessThan(1);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("typing (a) or (i) at the start of a line makes a numbered list", async () => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-list-marker-input-"));
  const { app, page, fileId } = await launchWithDocument(profile, indentDocument("英字とローマ数字の番号"));
  try {
    await placeCaretAtEnd(page, "p_3");
    await page.keyboard.press("Enter");
    await page.keyboard.type("(a) あ");
    await page.keyboard.press("Enter");
    await page.keyboard.type("い");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Enter");
    await page.keyboard.type("(i) う");
    await page.keyboard.press("Enter");
    await page.keyboard.type("え");

    await expect(page.locator('.page-flow ol[data-list-marker="parenLowerAlpha"] > li')).toHaveCount(2);
    await expect(page.locator('.page-flow ol[data-list-marker="parenLowerRoman"] > li')).toHaveCount(2);
    await expect.poll(async () => (await savedLists(page, fileId)).map((list) => list.markerStyle))
      .toEqual(["paren", "parenLowerAlpha", "parenLowerRoman"]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
