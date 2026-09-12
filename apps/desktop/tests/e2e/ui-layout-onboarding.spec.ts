import { expect, test, type Page } from "@playwright/test";

import { SPLASH_MARKER_ATTRIBUTE } from "@/components/StartupSplash";
import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 初回起動のUI選択画面。
 *
 * 表示条件そのもの（未完了 && デスクトップ && 非埋め込み && 起動完了）はユニットテストが
 * 押さえているので、ここでは「実際のアプリで出て、選んだ結果がクロームと再起動に効く」ことだけを見る。
 *
 * `preserveStorageKeys` が要るのはモックの都合: 毎ロードで localStorage を wipe してから
 * `uiLayout` を再 seed するため、これを渡さないとリロード後に必ず初期値へ戻り、
 * アプリ側の永続化バグと区別が付かなくなる。
 */
const LAYOUT_STORAGE_KEY = "sigma-studio:ui-layout-preference";
const DIALOG_NAME = "UIの表示を選ぶ";

async function bootWithOnboarding(page: Page, options: { completed?: boolean } = {}): Promise<void> {
  await installDesktopRuntimeMock(page, sampleDocument, {
    uiLayout: { mode: "docs", onboardingCompleted: options.completed ?? false },
    preserveStorageKeys: [LAYOUT_STORAGE_KEY],
  });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
}

function onboardingDialog(page: Page) {
  return page.getByRole("dialog", { name: DIALOG_NAME });
}

/**
 * ダイアログが「出ない」ことを判定してよい時点まで待つ。
 *
 * オンボーディングは app-ready **かつ** スプラッシュ消滅の後にしか出ない。エディタは
 * スプラッシュの下にマウントされるので、`.text-flow-editor` を待っただけで
 * `toHaveCount(0)` を見ると、永続が壊れていても1秒早く緑になってしまう。
 */
async function waitUntilOnboardingCouldAppear(page: Page): Promise<void> {
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
  // 目印は StartupSplash から import する。リテラルで書くと、目印の名前が変わった日に
  // セレクタが何にも一致せず「待ったつもり」で修正前の空振りに戻る。
  await expect(page.locator(`[${SPLASH_MARKER_ATTRIBUTE}]`)).toHaveCount(0, { timeout: 20_000 });
  // 消滅の検知は MutationObserver → React レンダーの順で1タスク遅れる。フレームを2回
  // 送って、その反映まで終わらせてから「出ない」を判定する（時間待ちではない）。
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

/** どのカードが「現在のレイアウト」として示されているか（示されるのは常に1枚だけ）。 */
async function selectedChoice(page: Page): Promise<string | null> {
  await expect(page.locator('[data-ui-layout-choice][data-selected="true"]')).toHaveCount(1);
  return page.evaluate(() =>
    document.querySelector('[data-ui-layout-choice][data-selected="true"]')?.getAttribute("data-ui-layout-choice")
      ?? null);
}

/** いまフォーカスされている要素を、テストから見分けられる名前にする。 */
async function focusedName(page: Page): Promise<string> {
  const name = await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    return active?.dataset.uiLayoutChoice ?? active?.getAttribute("aria-label") ?? "";
  });
  // 名前が取れない要素があると「動いていない」と「見分けが付かない」を混同するので落とす。
  expect(name).not.toBe("");
  return name;
}

test("picks the Word ribbon on first launch and keeps it across a restart", async ({ page }) => {
  await bootWithOnboarding(page);

  const dialog = onboardingDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  // 初期状態では既定（Googleドキュメント風）が現在の選択として示される。
  expect(await selectedChoice(page)).toBe("docs");

  // Tabキーがダイアログの中だけを回り、かつ1周して戻ってくること（ModalFrameのフォーカストラップ）。
  // ダイアログの操作面は「閉じる」+ カード2枚の3つなので、3回押すと開始位置へ戻る。
  // ModalFrame は先に surface へフォーカスし、初期フォーカスの移動は rAF の中で行う。
  // 先に着地を待たないと、開始位置が surface のまま記録されて的外れな失敗になる。
  await expect(page.locator('[data-ui-layout-choice="docs"]')).toBeFocused();
  const start = await focusedName(page);
  const visited: string[] = [];
  for (let step = 0; step < 3; step += 1) {
    await page.keyboard.press("Tab");
    const inside = await page.evaluate(() =>
      Boolean(document.activeElement?.closest('[role="dialog"]')));
    expect(inside).toBe(true);
    visited.push(await focusedName(page));
  }
  // フォーカスが実際に動いていること（同じ要素に留まっていたら循環ではない）。
  expect(new Set(visited).size).toBe(3);
  // 3回で開始位置へ戻る = ダイアログ内で閉じている。
  expect(visited.at(-1)).toBe(start);

  await page.locator('[data-ui-layout-choice="word"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toBeVisible();
  await expect(page.getByRole("tablist", { name: "リボンタブ" })).toBeVisible();

  await page.reload();
  await waitUntilOnboardingCouldAppear(page);
  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toBeVisible();
  await expect(onboardingDialog(page)).toHaveCount(0);
});

test("Escape skips the picker, leaves the Google Docs chrome and does not come back", async ({ page }) => {
  await bootWithOnboarding(page);

  const dialog = onboardingDialog(page);
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // スキップはmodeを書き換えない: 既定のGoogleドキュメント風のまま。
  await expect(page.locator('.app-shell[data-ui-layout="word"]')).toHaveCount(0);
  await expect(page.locator('.editor-menubar [data-editor-toolbar="quick"]')).toHaveCount(1);
  await expect(page.getByRole("tablist", { name: "リボンタブ" })).toHaveCount(0);

  await page.reload();
  await waitUntilOnboardingCouldAppear(page);
  await expect(onboardingDialog(page)).toHaveCount(0);
  await expect(page.locator('.editor-menubar [data-editor-toolbar="quick"]')).toHaveCount(1);
});

test("the settings menu can bring the picker back and the layout can be changed there", async ({ page }) => {
  await bootWithOnboarding(page, { completed: true });
  await waitUntilOnboardingCouldAppear(page);
  await expect(onboardingDialog(page)).toHaveCount(0);

  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: "UIの選択画面を再表示", exact: true }).click();

  const dialog = onboardingDialog(page);
  await expect(dialog).toBeVisible();
  // 開き直したときに「今どちらか」が読み取れること。
  expect(await selectedChoice(page)).toBe("docs");

  await page.locator('[data-ui-layout-choice="word"]').click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "リボンタブ" })).toBeVisible();

  // Word風から開き直すと、今度はWord風が現在の選択として示される。
  // Word風では設定メニューが無く、同じコマンドはファイルタブ = Backstage の
  // 「オプション」に置いてある。Word風は同名のコマンドが複数箇所に出うるので、
  // getByRole は必ず Backstage にスコープする。
  await page.getByRole("tab", { name: "ファイル", exact: true }).click();
  const backstage = page.getByRole("tabpanel", { name: "ファイル" });
  await expect(backstage).toBeVisible();
  await backstage.getByRole("button", { name: "オプション", exact: true }).click();
  await backstage.getByRole("button", { name: "UIの選択画面を再表示", exact: true }).click();
  await expect(onboardingDialog(page)).toBeVisible();
  expect(await selectedChoice(page)).toBe("word");
});
