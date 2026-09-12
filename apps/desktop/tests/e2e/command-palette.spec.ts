import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * ⌘P のコマンドパレット。受入基準は「キーボードだけで 開く→絞る→実行 が終わる」ことと、
 * 「検索が**今表示している言語**で効く」こと。日本語 UI と英語 UI の両方で同じ流れを通す。
 */

const SETTINGS_FOCUS_HIGHLIGHT = ".settings-entry-focus";

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  // 本文にフォーカスを置く。ショートカットは本文編集中でも効くのが仕様。
  await page.locator(".text-flow-editor").first().click();
}

/**
 * 本文の先頭ブロックに入って数文字選ぶ。
 *
 * **この本文の選択は DOM Selection には出ない** (CSS Custom Highlight 方式) ので、
 * 選択できたかどうかは「コマンドが効いたか」でしか観測できない。
 */
async function selectBodyText(page: Page): Promise<void> {
  const paragraph = page.locator("[data-sigma-doc-id]").first();
  await paragraph.click();
  // クリック直後はまだキー入力を受け取れない。本文にフォーカスが入るまで待つ。
  await expect.poll(() => page.evaluate(
    () => document.activeElement?.closest(".text-flow-editor") !== null,
  )).toBe(true);
  for (let index = 0; index < 5; index += 1) {
    await page.keyboard.press("Shift+ArrowRight");
  }
}

/** パレットを開いて絞り込み、先頭候補を Enter で実行する。マウスは一度も使わない。 */
async function runFromPalette(page: Page, dialogName: string, query: string): Promise<void> {
  await page.keyboard.press("ControlOrMeta+p");
  const palette = page.getByRole("dialog", { name: dialogName, exact: true });
  await expect(palette).toBeVisible();
  await page.keyboard.type(query);
  // 先頭候補が選ばれている状態が Enter の対象。
  await expect(palette.getByRole("option").first()).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("Enter");
  await expect(palette).toBeHidden();
}

test.describe("コマンドパレット (日本語 UI)", () => {
  test.beforeEach(openEditorFixture);

  test("⌘P で開き、絞り込んだコマンドを Enter で実行できる", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "コマンドパレット", exact: true });
    await expect(palette).toBeVisible();
    // 入力欄に最初からフォーカスが乗っている (キーボードだけで完結させるため)。
    await expect(palette.getByRole("combobox", { name: "コマンドや設定を検索" })).toBeFocused();

    await page.keyboard.type("PDF");
    const first = palette.getByRole("option").first();
    await expect(first).toContainText("PDFプレビュー");
    // 割り当て直したショートカットがそのまま候補に出る (表記は OS で変わるので、
    // 「Shift 相当が入っていること」だけを見る)。
    await expect(first.locator("kbd")).toHaveText(/⇧|Shift/u);

    await page.keyboard.press("Enter");
    await expect(palette).toBeHidden();
    await expect(page.locator(".preview-drawer")).toBeVisible();
  });

  test("設定項目を選ぶと、そのダイアログを該当箇所まで開く", async ({ page }) => {
    await runFromPalette(page, "コマンドパレット", "言語");

    const settings = page.getByRole("dialog", { name: "設定", exact: true });
    await expect(settings).toBeVisible();
    // WI-3 の `focusEntryId` 配線でハイライトが付く = 正しい行まで飛んでいる。
    await expect(settings.locator(SETTINGS_FOCUS_HIGHLIGHT)).toBeVisible();
    await expect(settings.getByLabel("表示言語")).toBeVisible();
  });

  test("選んだコマンドが本文に効く", async ({ page }) => {
    // パレットの本業。ダイアログを開くだけでなく、本文の編集コマンドが通ること。
    await selectBodyText(page);

    await runFromPalette(page, "コマンドパレット", "太字");

    await expect(page.locator(".text-flow-editor strong").first()).toBeVisible();
  });

  test("開いている間は本文のショートカットを食わない", async ({ page }) => {
    // 観測したいのは「検索を打っている間に本文が勝手に変わらない」こと。
    //
    // なお実測では、抑止フラグ (`commandPaletteOpen`) を外してもこのテストは緑のままになる
    // — `isCommandShortcutBlockedByTarget` が「event.target が `[role=dialog]` か
    // input の中なら全ショートカットを止める」ので、二重に守られているため。
    // **フラグそのものの存在は `command-palette-shortcut-suppression.test.ts` が
    // ソース走査で固定している** (フォーカスがパレット外に居るときの保険)。
    await selectBodyText(page);

    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "コマンドパレット", exact: true });
    await expect(palette).toBeVisible();

    // 検索中に ⌘B。抑止が外れていると、裏の本文選択が太字になる。
    await page.keyboard.press("ControlOrMeta+b");
    await page.waitForTimeout(300);
    expect(await page.locator(".text-flow-editor strong").count()).toBe(0);
    await expect(palette).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(palette).toBeHidden();

    // 閉じたあとは PDF プレビューのショートカットが効く (⌘⇧P に移設済み)。
    await page.keyboard.press("ControlOrMeta+Shift+p");
    await expect(page.locator(".preview-drawer")).toBeVisible();
  });

  test("⌘P をもう一度押すと閉じる", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "コマンドパレット", exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.press("ControlOrMeta+p");
    await expect(palette).toBeHidden();
  });
});

test.describe("コマンドパレット (英語 UI)", () => {
  test.use({ locale: "en-US" });
  test.beforeEach(openEditorFixture);

  test("英語表示のときは英語で検索できる", async ({ page }) => {
    await runFromPalette(page, "Command palette", "language");

    const settings = page.getByRole("dialog", { name: "Settings", exact: true });
    await expect(settings).toBeVisible();
    await expect(settings.locator(SETTINGS_FOCUS_HIGHLIGHT)).toBeVisible();
    await expect(settings.getByLabel("Display language")).toBeVisible();
  });

  test("コマンド名も英語で引ける", async ({ page }) => {
    await page.keyboard.press("ControlOrMeta+p");
    const palette = page.getByRole("dialog", { name: "Command palette", exact: true });
    await expect(palette).toBeVisible();
    await page.keyboard.type("pdf preview");
    await expect(palette.getByRole("option").first()).toContainText("PDF preview");
    // 日本語 UI 向けの文言は出ない。
    await expect(palette.getByText("プレビュー")).toHaveCount(0);
  });
});

async function openEditorFixture({ page }: { page: Page }): Promise<void> {
  await openEditor(page);
}
