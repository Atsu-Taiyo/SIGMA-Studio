import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 3D教材のアニメーションを動画にする経路と、その裏返し —
 * 「設定パネルを開いている間はページ用のアニメーションを焼き直さない」— の確認。
 *
 * 焼き直しはライブ窓でループを1周まわすので、パネルで色やスライダーを触るたびに本文の立体が
 * チカチカしていた。撮り直しはパネルを閉じたときにまとめて走る。
 */

const GRAPH3D_VIDEO_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_graph3d_video",
  metadata: { title: "3D教材の動画 e2e" },
  content: [
    { type: "paragraph", id: "p_e2e_graph3d_video", children: [{ type: "text", text: "3D教材の動画書き出し" }] },
  ],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, GRAPH3D_VIDEO_DOCUMENT);
  await page.setViewportSize({ width: 1440, height: 960 });
});

test("writes the parameter animation to a video file", async ({ page }) => {
  await openEditor(page);
  const panel = await insertGraph3D(page);

  const parameterDetails = await openParameterDetails(page, panel);
  // 1秒の動画で足りる。長さはパラメータの秒数がそのまま決めるので、往復で下限ちょうどになる。
  await parameterDetails.getByLabel("秒").fill("0.5");
  await page.keyboard.press("Escape");
  await expect(panel.getByText("約1.0秒・ダウンロードフォルダへ保存します")).toBeVisible();

  await panel.getByRole("button", { name: "動画で書き出す" }).click();
  await expect(panel.getByText(/^保存しました: /)).toBeVisible({ timeout: 60_000 });

  const saved = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-saved-download");
    return raw ? JSON.parse(raw) as { fileName: string; byteLength: number } : null;
  });
  expect(saved?.fileName).toMatch(/^3Dアニメーション\.(mp4|webm)$/);
  expect(saved?.byteLength ?? 0).toBeGreaterThan(1_000);
  await expect(panel.getByRole("button", { name: "フォルダを開く" })).toBeVisible();
});

test("leaves the page animation alone until the settings panel is closed", async ({ page }) => {
  await openEditor(page);
  const panel = await insertGraph3D(page);

  const parameterDetails = await openParameterDetails(page, panel);
  const playOnPage = parameterDetails.getByLabel("ページ上でも動かす");
  await playOnPage.click();
  await expect(playOnPage).toBeChecked();
  await page.keyboard.press("Escape");

  // 焼き直しは待ち時間 (180ms) のあと数フレームで終わる。開いている間は一度も走らない。
  await page.waitForTimeout(5_000);
  expect(await readsAnimatedPreview(page)).toBe(false);

  await panel.getByRole("button", { name: "閉じる" }).click();
  await expect(panel).toBeHidden();

  await expect.poll(() => readsAnimatedPreview(page), { timeout: 30_000 }).toBe(true);
});

async function openEditor(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 20_000 }).catch(() => undefined);
}

/** 3D教材を1つ置き、開いた設定パネルを返す。 */
async function insertGraph3D(page: Page): Promise<Locator> {
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  const insertMenu = page.getByRole("menu", { name: "挿入", exact: true });
  await expect(insertMenu).toBeVisible();
  await insertMenu.getByRole("menuitem", { name: "3D教材" }).click();

  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const surfaceBox = await surface.boundingBox();
  expect(surfaceBox).not.toBeNull();
  await page.mouse.move(surfaceBox!.x + 120, surfaceBox!.y + 150);
  await page.mouse.down();
  await page.mouse.move(surfaceBox!.x + 440, surfaceBox!.y + 360, { steps: 10 });
  await page.mouse.up();

  const panel = page.getByRole("dialog", { name: "3D教材の設定" });
  await expect(panel).toBeVisible();
  return panel;
}

async function openParameterDetails(page: Page, panel: Locator): Promise<Locator> {
  const trigger = panel.getByRole("button", { name: /の詳細設定$/ }).first();
  const label = await trigger.getAttribute("aria-label");
  expect(label).not.toBeNull();
  await trigger.click();
  const details = page.getByRole("dialog", { name: label! });
  await expect(details).toBeVisible();
  return details;
}

/** 保存された教材の派生プレビューがアニメーションPNGになっているか。まだ無ければ false。 */
async function readsAnimatedPreview(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return false;
    const document_ = JSON.parse(raw) as {
      pageLayout?: { overlay?: { overlaySnapshot?: { assets?: unknown } } };
    };
    const assets = document_.pageLayout?.overlay?.overlaySnapshot?.assets;
    const list = Array.isArray(assets)
      ? assets
      : Object.values((assets ?? {}) as Record<string, unknown>);
    return list.some((asset) => (asset as { props?: { isAnimated?: boolean } }).props?.isAnimated === true);
  });
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL
    ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString()
    : path;
}
