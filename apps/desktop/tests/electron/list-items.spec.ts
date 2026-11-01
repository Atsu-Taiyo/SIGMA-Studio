import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { DEFAULT_SERIF_BODY_FONT_FAMILY, type ListNode, type SigmaDocument } from "@/features/document";
import { createBlankDocument } from "@/lib/blank-document";

/**
 * リストの 2 つの不具合を実アプリで固定する。
 *
 * - 番号は項目の先頭の文字に合わせて描くが、空の項目 (Enter 直後) は既定の書体に戻っていた。
 *   直前に書かれた文字 (Enter で次の項目へ引き継がれる書式) に合わせる。
 * - 項目の下余白のつまみを引くと、下の項目がドラッグ中は止まったまま、離した瞬間にまとめて飛んでいた。
 */

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL ?? process.env.SIGMA_STUDIO_DEV_SERVER_URL;

function listDocument(title: string, items: ListNode["items"]): SigmaDocument {
  const document = createBlankDocument(title);
  document.content = [
    { type: "list", id: "list_main", listType: "ordered", items },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "リストの後" }] },
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

/** 教材ファイルを引数に渡して起動し、開いた教材の fileId を返す (起動直後に開く教材が決まる)。 */
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
  await waitForList(page);
  const files = await page.evaluate(() => window.desktopAPI!.storage.listFiles());
  return { app, page, fileId: files.find((entry) => entry.title === title)!.fileId };
}

async function waitForList(page: Page): Promise<void> {
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible({ timeout: 60_000 });
}

async function savedList(page: Page, fileId: string): Promise<ListNode | null> {
  return page.evaluate(async (id) => {
    const document = await window.desktopAPI!.storage.loadDocument(id);
    const list = document?.content.find((block) => block.id === "list_main");
    return list?.type === "list" ? list : null;
  }, fileId);
}

/** 各項目の番号 (`::marker`) が実際に描かれている書式。 */
async function markerStyles(page: Page) {
  return page.locator(".page-flow ol").first().evaluate((list) => Array.from(list.querySelectorAll(":scope > li")).map((item) => {
    const marker = getComputedStyle(item, "::marker");
    return { fontFamily: marker.fontFamily, fontSizePx: Math.round(Number.parseFloat(marker.fontSize) * 100) / 100, fontWeight: marker.fontWeight };
  }));
}

test.beforeEach(() => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
});

test("an empty item's number takes the font written right before it, while editing and after reopening", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-list-marker-empty-"));
  const opened = await launchWithDocument(profile, listDocument("空の項目の番号", [{
    type: "listItem",
    id: "li_big",
    children: [{ type: "text", text: "大きい太字の項目", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY, fontSize: 20, marks: ["bold"] }],
  }]));
  const { fileId } = opened;
  let { app, page } = opened;
  try {
    await page.locator('.page-flow [data-sigma-doc-id="li_big"]').click();
    // 行末へは DOM の選択で置く (macOS の合成 End キーは当てにならない)。
    await page.evaluate(() => {
      const item = document.querySelector('.page-flow [data-sigma-doc-id="li_big"]')!;
      const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => (node.parentElement?.closest('[contenteditable="false"]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      let last: Text | null = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) last = node as Text;
      window.getSelection()!.collapse(last!, last!.length);
    });
    await page.waitForTimeout(100);
    await page.keyboard.press("Enter");
    await expect(page.locator(".page-flow ol > li")).toHaveCount(2);

    const [styled, empty] = await markerStyles(page);
    expect(styled).toEqual({ fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY, fontSizePx: 26.67, fontWeight: "700" });
    expect(empty).toEqual(styled);

    // 打ち始めても番号は変わらない (Enter が引き継いだ書式と同じものに合わせているため)。
    await page.keyboard.insertText("続き");
    await expect.poll(async () => (await markerStyles(page))[1]).toEqual(styled);
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Backspace");
    // Empty text now retains its canonical font; it must contain no typed glyphs.
    await expect.poll(async () => (await savedList(page, fileId))?.items[1]?.children).toEqual([
      { type: "text", text: "", fontFamily: DEFAULT_SERIF_BODY_FONT_FAMILY, fontSize: 20 },
    ]);
    expect((await markerStyles(page))[1]).toEqual(styled);
    await page.screenshot({ path: testInfo.outputPath("empty-item-marker.png") });

    await app.close();
    ({ app, page } = await launch(profile));
    await waitForList(page);
    await expect(page.locator(".page-flow ol > li")).toHaveCount(2);
    expect(await markerStyles(page)).toEqual([styled, styled]);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("dragging an item's space handle moves the items below it frame by frame, and the value survives reopening", async ({}, testInfo) => {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-list-space-after-"));
  const opened = await launchWithDocument(profile, listDocument("項目の下余白", ["一", "二", "三"].map((text, index) => ({
    type: "listItem" as const,
    id: `li_${index + 1}`,
    children: [{ type: "text" as const, text: `項目${text}` }],
  }))));
  const { fileId } = opened;
  let { app, page } = opened;
  try {
    const top = (id: string) => page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).evaluate((element) => element.getBoundingClientRect().top);
    const scale = await page.locator('.page-flow [data-sigma-doc-id="li_1"]').evaluate((element) => element.getBoundingClientRect().width / (element as HTMLElement).offsetWidth);
    const before = { li_1: await top("li_1"), li_2: await top("li_2"), li_3: await top("li_3") };

    const item = (await page.locator('.page-flow [data-sigma-doc-id="li_1"]').boundingBox())!;
    await page.mouse.move(item.x + item.width / 2, item.y + item.height / 2);
    const handle = page.locator('.page-block-space-handle[data-block-id="li_1"]');
    await expect(handle).toBeVisible();
    const grip = (await handle.boundingBox())!;
    const x = grip.x + grip.width / 2;
    const y = grip.y + grip.height / 2;
    const travel = 60 * scale;

    await page.evaluate(() => {
      const samples: number[][] = [];
      const record = () => {
        samples.push(["li_2", "li_3"].map((id) => document.querySelector(`.page-flow [data-sigma-doc-id="${id}"]`)!.getBoundingClientRect().top));
        if ((window as unknown as { __listSampling?: boolean }).__listSampling) window.requestAnimationFrame(record);
      };
      Object.assign(window, { __listSamples: samples, __listSampling: true });
      window.requestAnimationFrame(record);
    });
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 20; step += 1) {
      await page.mouse.move(x, y + (travel * step) / 20);
      await page.waitForTimeout(24);
    }
    await page.screenshot({ path: testInfo.outputPath("list-space-after-dragging.png"), caret: "initial" });
    await page.mouse.up();
    await page.waitForTimeout(700);
    const samples = await page.evaluate(() => {
      Object.assign(window, { __listSampling: false });
      return (window as unknown as { __listSamples: number[][] }).__listSamples;
    });

    for (const [column, id] of (["li_2", "li_3"] as const).entries()) {
      const series = samples.map((sample) => sample[column]);
      // まとめて飛ぶと 2〜3 種類の位置しか出ない。追従していれば途中の位置が何段階も出る。
      expect(new Set(series.map(Math.round)).size, id).toBeGreaterThanOrEqual(8);
      for (let index = 1; index < series.length; index += 1) {
        expect(series[index] - series[index - 1], id).toBeGreaterThan(-1);
        expect(series[index] - series[index - 1], id).toBeLessThan(travel / 3);
      }
      expect(Math.abs(series[series.length - 1] - (before[id] + travel)), id).toBeLessThan(4 * scale);
    }

    await expect.poll(async () => (await savedList(page, fileId))?.items.map((listItem) => listItem.spaceAfterPx)).toEqual([60, undefined, undefined]);
    await app.close();
    ({ app, page } = await launch(profile));
    await waitForList(page);
    await expect.poll(async () => Math.abs(await top("li_2") - await top("li_1") - (before.li_2 - before.li_1 + travel))).toBeLessThan(2 * scale);
  } finally {
    await app.close().catch(() => undefined);
    rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
