import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * ツールバーで当てたスタイルが、実際に本文の SVG まで届くかを見る伝播ガード。
 *
 * WI-2 の署名 e2e はクロームの DOM しか見ないので、**クロームからキャンバスへの配線が切れていても
 * 緑のまま通る**。実際 WI-3 の抽出中に、署名は 4/4 のままスタイル適用だけが描画に反映されなくなる
 * 状態が生まれた。ここはその盲点だけを塞ぐ最小のテスト。
 *
 * タイミング依存にしないため、各ステップの前に「次の操作を受け付けられる状態」を明示的に待つ
 * （図形が選択された / メニューが開いた / メニューが閉じた）。待ち時間の固定値は使わない。
 * それでも壊れた構成では落ちることを確認済み（下記 Red 検証）。
 */

function emptyOverlayDocument(): SigmaDocument {
  return {
    ...sampleDocument,
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: { version: 1, shapes: [], assets: {} },
      },
    },
  } as SigmaDocument;
}

/** 線ツールで1本引き、選択が確定するまで待つ。 */
async function drawLine(page: Page, index: number): Promise<string> {
  await page.getByRole("button", { name: "線", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "矢印", exact: true }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + 96;
  const y = box!.y + 140 + index * 130;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 130, y + 70, { steps: 8 });
  await page.mouse.up();

  // 選択が乗るまで待ってから次へ進む（ここを待たずに進むと計測がタイミング依存になる）。
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  const id = await page.locator(".overlay-shape-arrow").nth(index).getAttribute("data-overlay-shape-id");
  expect(id).toBeTruthy();
  return id!;
}

/** 端点メニューから見た目を選ぶ。開くのも閉じるのも状態で待つ。 */
async function pickEndpoint(page: Page, label: string): Promise<void> {
  const button = page.getByRole("button", { name: /^線の右端（現在: / });
  await expect(button).toBeEnabled();
  await button.click();
  const menu = page.getByRole("menu", { name: "線の右端" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { window.localStorage.clear(); });
  await installDesktopRuntimeMock(page, emptyOverlayDocument());
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 5_000 });
});

/** 現在の実描画の線幅。伝播が止まると値が変わらない。 */
async function strokeWidthOf(page: Page, id: string): Promise<number> {
  return page
    .locator(`[data-overlay-shape-id="${id}"] line`)
    .evaluate((node) => Number.parseFloat(window.getComputedStyle(node).strokeWidth));
}

test("a toolbar style reaches the shape's SVG", async ({ page }) => {
  const id = await drawLine(page, 0);
  await pickEndpoint(page, "三角");

  const shape = page.locator(`[data-overlay-shape-id="${id}"]`);
  await expect(shape.locator(`marker#triangle-${id}-end`)).toHaveCount(1);
  await expect(shape.locator("line")).toHaveAttribute("marker-end", `url(#triangle-${id}-end)`);

  // 端点だけでなく線幅の伝播も見る。壊れたときは両方の症状が出ていたので、片方しか
  // 見ていないと線幅側だけ切れた build を緑で通してしまう。
  const before = await strokeWidthOf(page, id);
  const widthButton = page.getByRole("button", { name: /^線幅/ });
  await expect(widthButton).toBeEnabled();
  await widthButton.click();
  const widthMenu = page.getByRole("menu", { name: "線幅" });
  await expect(widthMenu).toBeVisible();
  await widthMenu.getByRole("menuitemradio", { name: "極太", exact: true }).click();
  await expect(widthMenu).toHaveCount(0);
  await expect.poll(() => strokeWidthOf(page, id)).toBeGreaterThan(before);
});

test("a style still reaches the SVG for a shape drawn after an earlier one was styled", async ({ page }) => {
  // 2本目が本題。WI-3 の抽出で壊れたときは、1本目は載るのに2本目のスタイルだけが
  // 描画に届かなくなった（キャンバス側の state には入っているのに marker が出ない）。
  const first = await drawLine(page, 0);
  await pickEndpoint(page, "三角");
  await expect(page.locator(`[data-overlay-shape-id="${first}"] marker#triangle-${first}-end`)).toHaveCount(1);

  // 壊れ方が間欠なので、後続の図形を2本ぶん確認して取りこぼしを減らす。
  for (const [index, label, kind] of [[1, "ひし形", "diamond"], [2, "矢印（細）", "thinArrow"]] as const) {
    const id = await drawLine(page, index);
    await pickEndpoint(page, label);

    const shape = page.locator(`[data-overlay-shape-id="${id}"]`);
    await expect(shape.locator(`marker#${kind}-${id}-end`), `${index + 1}本目の${label}`).toHaveCount(1);
    await expect(shape.locator("line")).toHaveAttribute("marker-end", `url(#${kind}-${id}-end)`);
  }
});
