import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const SELECT_ALL = process.platform === "darwin" ? "Meta+A" : "Control+A";

/**
 * ヘッダー/フッターをページごとに変える。どれも保存して開き直した教材で確かめる。
 * - 編集中に「ヘッダー編集中」の札も帯の名札も出ず、帯の右の設定ボタンから設定できる
 * - 設定カードから、ページ番号・総ページ数・題名を書き方を知らなくても入れられる
 * - 表示するページ: すべて / 先頭ページのみ / 先頭ページ以外 と、そのページだけの例外
 * - そのページだけ内容を変える (文字だけ。共通の文字やほかのページは変わらない)
 */
async function openMaterial(title: string) {
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-running-region-visibility-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const page = await app.firstWindow();
  const body = (target: Page) => target.locator(".page-flow .ProseMirror").first();
  await page.waitForFunction(() => Boolean(window.desktopAPI));
  await expect(body(page)).toBeVisible();
  await page.evaluate(async () => {
    await window.desktopAPI!.settings!.setUiLocale!("ja");
    localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
  });
  const blank = createBlankDocument(title);
  blank.content = Array.from({ length: 36 }, (_, index) => ({
    type: "paragraph" as const,
    id: `visibility_p_${index}`,
    children: [{ type: "text" as const, text: `${index + 1}. ${"二次関数のグラフと平方完成について順に確かめます。".repeat(4)}` }],
  }));
  const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), blank);
  const fileId = created.file.fileId;
  await page.reload();
  await expect(body(page)).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);

  const textOf = (blocks: Array<{ children?: Array<{ text?: string }> }> | undefined) => blocks
    ?.map((block) => (block.children ?? []).map((child) => child.text ?? "").join("")).join("\n");
  const savedHeader = async () => {
    const document = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
    const header = document?.pageLayout?.header;
    return {
      showOnFirstPage: header?.showOnFirstPage,
      showOnLaterPages: header?.showOnLaterPages,
      hiddenPages: header?.hiddenPages,
      shownPages: header?.shownPages,
      text: textOf(header?.blocks as never),
      pageContents: header?.pageContents?.map((content) => ({ page: content.page, text: textOf(content.blocks as never) })),
    };
  };
  const sheets = page.locator(".a4-page-sheet");
  await expect.poll(() => sheets.count()).toBeGreaterThanOrEqual(3);
  const headerOnSheet = (index: number) => sheets.nth(index).locator(".page-running-region.header");
  // 帯の操作面は紙とは別の層 (ページごとに 1 枚) にある。
  const bandOnSheet = (index: number) => page.locator(".page-layout-control-sheet").nth(index).locator(".page-running-editor-band.header");
  const pxPerMm = async () => ((await sheets.first().boundingBox())!.width / 210);
  const scrollSheetIntoView = async (index: number) => {
    await sheets.nth(index).evaluate((element) => element.scrollIntoView({ block: "start" }));
    await page.waitForTimeout(200);
  };
  const topSheetIndex = async () => {
    for (let index = 0; index < await sheets.count(); index += 1) {
      const box = await sheets.nth(index).boundingBox();
      if (box && box.y > -5 && box.y < 400) return index;
    }
    return 0;
  };
  const leaveHeader = async () => {
    const box = (await sheets.nth(await topSheetIndex()).boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + 150 * await pxPerMm());
    await expect(page.locator(".page-running-direct-editor.header")).toHaveCount(0);
  };
  /** 帯にカーソルを合わせて、設定ボタンからカードを開く (編集には入らない)。 */
  const openCardOnHover = async (index: number) => {
    await scrollSheetIntoView(index);
    const box = (await sheets.nth(index).boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 12 * await pxPerMm());
    const toggle = bandOnSheet(index).locator(".page-running-options-toggle");
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator(".page-running-options-card")).toBeVisible();
  };
  /** 1 ページ目の帯をダブルクリックして、ヘッダーを出して編集に入る。 */
  const enterFirstHeader = async () => {
    // 開き直した直後は、紙面の組み直しと重なって最初のダブルクリックを取りこぼすことがある。
    await expect(async () => {
      await scrollSheetIntoView(0);
      const first = (await sheets.first().boundingBox())!;
      await page.mouse.dblclick(first.x + first.width / 2, first.y + 8 * await pxPerMm());
      await expect(page.locator(".page-running-direct-editor.header")).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 20_000 });
  };
  const cleanup = async () => {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  };
  return {
    page, body, savedHeader, sheets, headerOnSheet, bandOnSheet, scrollSheetIntoView, leaveHeader,
    openCardOnHover, enterFirstHeader, cleanup, card: page.locator(".page-running-options-card"),
  };
}

function skipWithoutBuild() {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
}

test("header can be switched off for a single page and page numbers insert from the card", async ({}, testInfo) => {
  skipWithoutBuild();
  const m = await openMaterial("ページごとのヘッダー");
  const { page, card } = m;
  try {
    // 1 ページ目で編集に入る。名札はどこにも出ない。
    await m.enterFirstHeader();
    await expect(page.getByText("ヘッダー編集中")).toHaveCount(0);
    await expect(page.locator(".page-running-editor-label")).toHaveCount(0);
    const toggle = page.locator(".page-running-editor-band.header.editing .page-running-options-toggle");
    await expect(toggle).toBeVisible();

    // 設定カード: 編集中は差し込みの行が出る。「ページ番号 / 総ページ数」を押すと、カーソルの位置に入る。
    await toggle.click();
    await expect(card).toBeVisible();
    await expect(card.getByText("ページ番号などを入れる")).toBeVisible();
    await card.getByRole("button", { name: /^ページ番号 \/ 総ページ数/ }).click();
    await expect.poll(async () => (await m.savedHeader()).text).toContain("{page} / {total}");
    // 押しても編集欄から焦点が外れない (続けて打てる)。
    await expect(page.locator(".page-running-direct-editor.header .ProseMirror")).toBeFocused();
    await page.screenshot({ path: testInfo.outputPath("card-editing.png") });

    // 1 ページ目だけ出さない → showOnFirstPage。まとまりは「先頭ページ以外」になる。編集面では帯が薄くなる。
    const range = card.getByRole("radiogroup", { name: "表示するページ" });
    await expect(range.getByRole("radio", { name: "すべて" })).toHaveAttribute("aria-checked", "true");
    const switchFirst = card.getByRole("switch", { name: "1ページ目にヘッダーを表示" });
    await expect(switchFirst).toHaveAttribute("aria-checked", "true");
    await switchFirst.click();
    await expect.poll(async () => (await m.savedHeader()).showOnFirstPage).toBe(false);
    await expect(range.getByRole("radio", { name: "先頭ページ以外" })).toHaveAttribute("aria-checked", "true");
    await expect(page.locator(".page-running-editor-band.header.editing.page-hidden")).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("card-first-page-off.png") });

    // 編集をやめると、1 ページ目からは消え、2 ページ目以降には残る。
    await page.keyboard.press("Escape");
    await expect(card).toHaveCount(0);
    await m.leaveHeader();
    await expect(m.headerOnSheet(0)).toHaveCount(0);
    await expect(m.headerOnSheet(1)).toHaveCount(1);
    // 差し込みは、そのページの値で描かれる (2 ページ目の「ページ番号 / 総ページ数」)。
    await expect(m.headerOnSheet(1).locator(".running-field-value")).toHaveText(["2", /^\d+$/, "ページごとのヘッダー"]);

    // 2 ページ目: 編集に入らず、帯にカーソルを合わせて切り替える。カードに差し込みの行は出ない。
    await m.openCardOnHover(1);
    await expect(card.getByText("ページ番号などを入れる")).toHaveCount(0);
    await card.getByRole("switch", { name: "2ページ目にヘッダーを表示" }).click();
    await expect.poll(async () => (await m.savedHeader()).hiddenPages).toEqual([2]);
    await expect(m.headerOnSheet(1)).toHaveCount(0);
    await expect(m.headerOnSheet(2)).toHaveCount(1);
    // ページごとの例外があるので、まとまりのどれも選ばれず、出していないページが読める。
    for (const name of ["すべて", "先頭ページのみ", "先頭ページ以外"]) {
      await expect(card.getByRole("radio", { name })).toHaveAttribute("aria-checked", "false");
    }
    await expect(card.getByText("表示していないページ: 1・2")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("second-page-off.png") });

    // 開き直しても同じ。
    await page.reload();
    await expect(m.body(page)).toBeVisible();
    await expect.poll(() => m.sheets.count()).toBeGreaterThanOrEqual(3);
    await expect(m.headerOnSheet(0)).toHaveCount(0);
    await expect(m.headerOnSheet(1)).toHaveCount(0);
    await expect(m.headerOnSheet(2)).toHaveCount(1);

    // 「すべて」で戻す。保存した教材には例外のページの印が残らない。
    await m.openCardOnHover(1);
    await card.getByRole("radio", { name: "すべて" }).click();
    await expect.poll(m.savedHeader).toMatchObject({ showOnFirstPage: true, hiddenPages: undefined, shownPages: undefined });
    for (let index = 0; index < 3; index += 1) {
      await expect(m.headerOnSheet(index)).toHaveCount(1);
    }
  } finally {
    await m.cleanup();
  }
});

test("header can be shown on the first page only, with a later page added back as an exception", async ({}, testInfo) => {
  skipWithoutBuild();
  const m = await openMaterial("先頭ページのみのヘッダー");
  const { page, card } = m;
  try {
    await m.enterFirstHeader();
    await page.locator(".page-running-editor-band.header.editing .page-running-options-toggle").click();
    await card.getByRole("radio", { name: "先頭ページのみ" }).click();
    // 2 ページ目以降の既定を「出さない」にするので、ページが増えても効く (全ページぶんの印は持たない)。
    await expect.poll(m.savedHeader).toMatchObject({ showOnFirstPage: true, showOnLaterPages: false, hiddenPages: undefined, shownPages: undefined });
    await expect(card.getByRole("radio", { name: "先頭ページのみ" })).toHaveAttribute("aria-checked", "true");
    await page.keyboard.press("Escape");
    await m.leaveHeader();
    await expect(m.headerOnSheet(0)).toHaveCount(1);
    await expect(m.headerOnSheet(1)).toHaveCount(0);
    await expect(m.headerOnSheet(2)).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("first-only.png") });

    // 3 ページ目だけ出し直す → 「出すページ」の例外。
    await m.openCardOnHover(2);
    await card.getByRole("switch", { name: "3ページ目にヘッダーを表示" }).click();
    await expect.poll(async () => (await m.savedHeader()).shownPages).toEqual([3]);
    await expect(m.headerOnSheet(1)).toHaveCount(0);
    await expect(m.headerOnSheet(2)).toHaveCount(1);
    await expect(card.getByText("表示するページ: 1・3")).toBeVisible();
    await expect(card.getByRole("radio", { name: "先頭ページのみ" })).toHaveAttribute("aria-checked", "false");

    // 開き直しても同じ。
    await page.reload();
    await expect(m.body(page)).toBeVisible();
    await expect.poll(() => m.sheets.count()).toBeGreaterThanOrEqual(3);
    await expect(m.headerOnSheet(0)).toHaveCount(1);
    await expect(m.headerOnSheet(1)).toHaveCount(0);
    await expect(m.headerOnSheet(2)).toHaveCount(1);

    // ページ設定でも「先頭ページのみ」と読める (例外を戻すとまとまりが選ばれる)。
    await m.openCardOnHover(2);
    await card.getByRole("switch", { name: "3ページ目にヘッダーを表示" }).click();
    await expect.poll(async () => (await m.savedHeader()).shownPages).toBeUndefined();
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
    await expect(dialog.getByRole("radio", { name: "先頭ページのみ" })).toHaveAttribute("aria-checked", "true");
    await page.screenshot({ path: testInfo.outputPath("page-setup-first-only.png") });
  } finally {
    await m.cleanup();
  }
});

test("a page can have its own header text while the others keep sharing one", async ({}, testInfo) => {
  skipWithoutBuild();
  const m = await openMaterial("ページごとの内容");
  const { page, card } = m;
  try {
    await m.enterFirstHeader();
    await page.locator(".page-running-direct-editor.header .text-flow-editor").press(SELECT_ALL);
    await page.keyboard.insertText("共通のヘッダー");
    await expect.poll(async () => (await m.savedHeader()).text).toBe("共通のヘッダー");
    await page.keyboard.press("Escape");
    await m.leaveHeader();
    for (let index = 0; index < 3; index += 1) {
      await expect(m.headerOnSheet(index)).toContainText("共通のヘッダー");
    }

    // 2 ページ目だけ内容を変える: 共通の文字を写して、そのまま編集に入る。
    await m.openCardOnHover(1);
    await card.getByRole("switch", { name: "2ページ目だけヘッダーの内容を変える" }).click();
    await expect.poll(async () => (await m.savedHeader()).pageContents).toEqual([{ page: 2, text: "共通のヘッダー" }]);
    await expect(page.locator(".page-running-editor-band.header.editing")).toHaveCount(1);
    await page.locator(".page-running-direct-editor.header .text-flow-editor").press(SELECT_ALL);
    await page.keyboard.insertText("第2回 確認テスト");
    await expect.poll(async () => (await m.savedHeader()).pageContents).toEqual([{ page: 2, text: "第2回 確認テスト" }]);
    // 共通の文字とほかのページは変わらない。
    expect((await m.savedHeader()).text).toBe("共通のヘッダー");
    await page.screenshot({ path: testInfo.outputPath("own-content-editing.png") });

    await page.keyboard.press("Escape");
    await m.leaveHeader();
    await expect(m.headerOnSheet(0)).toContainText("共通のヘッダー");
    await expect(m.headerOnSheet(1)).toContainText("第2回 確認テスト");
    await expect(m.headerOnSheet(1)).not.toContainText("共通のヘッダー");
    await expect(m.headerOnSheet(2)).toContainText("共通のヘッダー");

    // 開き直しても同じ。
    await page.reload();
    await expect(m.body(page)).toBeVisible();
    await expect.poll(() => m.sheets.count()).toBeGreaterThanOrEqual(3);
    await expect(m.headerOnSheet(1)).toContainText("第2回 確認テスト");
    await expect(m.headerOnSheet(2)).toContainText("共通のヘッダー");

    // 共通の文字を直すと、専用の中身を持たないページだけが変わる。
    await m.enterFirstHeader();
    await page.locator(".page-running-direct-editor.header .text-flow-editor").press(SELECT_ALL);
    await page.keyboard.insertText("共通を直した");
    await expect.poll(async () => (await m.savedHeader()).text).toBe("共通を直した");
    await page.keyboard.press("Escape");
    await m.leaveHeader();
    await expect(m.headerOnSheet(0)).toContainText("共通を直した");
    await expect(m.headerOnSheet(1)).toContainText("第2回 確認テスト");
    await expect(m.headerOnSheet(2)).toContainText("共通を直した");

    // 共通に戻すと、そのページ専用の文字は捨てられる。
    await m.openCardOnHover(1);
    await expect(card.getByText("内容を変えているページ: 2")).toBeVisible();
    await card.getByRole("switch", { name: "2ページ目だけヘッダーの内容を変える" }).click();
    await expect.poll(async () => (await m.savedHeader()).pageContents).toBeUndefined();
    await expect(m.headerOnSheet(1)).toContainText("共通を直した");
    await expect(m.headerOnSheet(1)).not.toContainText("第2回 確認テスト");
  } finally {
    await m.cleanup();
  }
});
