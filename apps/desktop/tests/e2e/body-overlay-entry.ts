import { expect, type Locator, type Page } from "@playwright/test";

/**
 * 本文モードから図形を掴む唯一の明示操作。
 *
 * 未選択の図形は本文を透過するので、素のクリックはオーバーレイに入らず本文へ届く
 * (`body-pointer-passthrough.spec.ts` が両方向を固定している)。Ctrl/Cmd-click はオーバーレイ編集を
 * 立ち上げるところまでを担い、図形そのものの選択はその後の素のクリックが行う ——
 * `PageCanvasEditor` の Ctrl/Cmd 経路は marquee 起点なので、押した点の図形を直接は選ばない。
 *
 * **必ず座標で押す。** プレビュー面の図形は `pointer-events: none` なので、locator の click は
 * 「`.page-canvas` が pointer events を横取りしている」と判定されて永久にリトライする。座標は
 * locator から採ってよいが、押すのは `page.mouse`。
 */
export async function grabShapeFromBody(page: Page, target: Locator | { x: number; y: number }): Promise<void> {
  // `page.mouse` は locator と違って actionability を待たない。起動スプラッシュが残っていると
  // 押下がそこへ吸われるので、明示的に消えるまで待つ。
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  const point = "x" in target ? target : await centerOf(target);

  // locator の click と違って座標押下は遮蔽を検出しないので、自分で確かめる。浮遊パネルが
  // 被っていると押下が黙って別の場所へ落ち、原因の分からない失敗になる。
  await expectPointReachesPage(page, point);

  // すでにオーバーレイ編集中なら透過は関係ない (`handlePagePointerDownCapture` は編集中を即 return
  // するので、Ctrl/Cmd を足しても何も起きない)。素のクリックだけで選択できる。
  if (await page.locator('[data-overlay-editing="true"]').count() === 0) {
    await page.keyboard.down("ControlOrMeta");
    await page.mouse.click(point.x, point.y);
    await page.keyboard.up("ControlOrMeta");
    // オーバーレイ編集は状態が先、DOM (動的 import) は後。状態で待ってから実体を待つ。
    await expect(page.locator('[data-overlay-editing="true"]')).toHaveCount(1);
    await expect(page.locator(".overlay-canvas-editor")).toBeVisible();
  }
  // Ctrl/Cmd クリックはその場で図形を掴む。掴めていれば追加の押下は要らない — 選択済みの
  // 図形への素のクリックはテキスト/表の編集に入ってしまい、呼び出し側の「掴んでから
  // ダブルクリックで編集」が 1 手ずれる。
  if (await page.locator(".overlay-shape.selected").count() > 0) {
    return;
  }

  // 同じ座標を連続で押すと Chromium は 2 回目を detail=2 (ダブルクリック) として数え、呼び出し側が
  // 足す 3 回目のクリックが 1 手早く編集へ入ってしまう。一度離してからカウンタを切る。
  await page.mouse.move(point.x + 120, point.y + 120);
  await page.mouse.click(point.x, point.y);
}

/** その座標を押したら本当に紙面に届くか (浮遊 UI に食われていないか)。 */
async function expectPointReachesPage(page: Page, point: { x: number; y: number }): Promise<void> {
  const blocker = await page.evaluate((target) => {
    const element = window.document.elementFromPoint(target.x, target.y);
    if (!element) {
      return "no element at point";
    }
    return element.closest(".page-stack")
      ? null
      : `${element.tagName}.${(element.className || "").toString().split(" ")[0]}`;
  }, point);

  expect(blocker, `(${Math.round(point.x)}, ${Math.round(point.y)}) が紙面の外か遮蔽されている`).toBeNull();
}

/**
 * `page.mouse` は locator と違って自動スクロールしないので、座標を採る前に自分で view に入れる。
 * 入れずに撮った座標は viewport の外を指し、押下がまったく別の場所に落ちる。
 */
async function centerOf(locator: Locator): Promise<{ x: number; y: number }> {
  await locator.scrollIntoViewIfNeeded();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}
