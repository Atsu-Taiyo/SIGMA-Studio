import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";

import type { OverlayGeoShape, SigmaDocument } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const DEV_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
const PREPARED = existsSync(path.join(APP_ROOT, "dist-electron/main.cjs"))
  && (Boolean(DEV_URL) || existsSync(path.join(APP_ROOT, "out/index.html")));

type Box = { x: number; y: number; width: number; height: number };

/**
 * 小さい図形では角・辺の持ち手が図形を覆い、持ち手しか見えなくなっていた。辺の持ち手から先に
 * 描くのをやめ、さらに小さければ角も描かない。描かない持ち手は枠の外側で掴めて、内側は移動に残る。
 */
test("a shrinking shape stops drawing its handles but stays resizable and movable", async ({}, testInfo) => {
  test.skip(!PREPARED, "Build Electron and supply SIGMA_STUDIO_E2E_BASE_URL, or prepare the static renderer.");
  test.setTimeout(180_000);
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-small-shape-handles-"));
  let app: ElectronApplication | undefined;
  const errors: string[] = [];

  const launch = async (): Promise<Page> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
    delete env.ELECTRON_RUN_AS_NODE;
    env.SIGMA_STUDIO_USER_DATA_DIR = path.join(profile, "sigma");
    if (DEV_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = DEV_URL;
    app = await electron.launch({
      args: [APP_ROOT, `--user-data-dir=${path.join(profile, "chromium")}`],
      cwd: APP_ROOT,
      env,
    });
    const page = await app.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    // 起動直後の window は about:blank のことがあり、そのまま localStorage を触ると SecurityError になる。
    await page.waitForURL(/^(https?|file):/, { timeout: 60_000 });
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => Boolean(window.desktopAPI?.settings?.setUiLocale));
    // Desktop startup restores the native preference after hydration. A localStorage-only
    // locale races that restore on English CI hosts and leaves the toolbar in English.
    expect(await page.evaluate(async () => {
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true }));
      return window.desktopAPI!.settings!.setUiLocale!("ja");
    })).toMatchObject({ ok: true });
    await page.reload();
    await expect(page.locator("[data-startup-splash]")).toHaveCount(0, { timeout: 60_000 });
    await page.setViewportSize({ width: 1400, height: 900 });
    await expect(page.getByRole("button", { name: "図形", exact: true }).first()).toBeVisible();
    expect(await page.evaluate(() => window.desktopAPI?.isDesktop)).toBe(true);
    if (DEV_URL) expect(new URL(page.url()).origin).toBe(new URL(DEV_URL).origin);
    return page;
  };

  const savedRectangle = async (page: Page): Promise<OverlayGeoShape | undefined> => {
    const document = await page.evaluate(async () => {
      const [file] = await window.desktopAPI!.storage.listFiles();
      return file ? window.desktopAPI!.storage.loadDocument(file.fileId) : null;
    }) as SigmaDocument | null;
    return (document?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [])
      .find((shape): shape is OverlayGeoShape => shape.type === "geo");
  };

  /**
   * 開き直して図形を選んだ直後に閉じると、溜まった図形の変更を取り込まないまま終了時の保存が走り、
   * 「保存できませんでした」が出ることがある (この変更の前からある不具合で、PR #233 が直す)。
   * ここで確かめたいことは閉じる前に保存済みなので、出たら保存せずに閉じる。
   */
  const quit = async (page: Page) => {
    if (!app) return;
    const closing = app.close();
    const discard = page.getByRole("dialog", { name: "保存できませんでした" })
      .getByRole("button", { name: "保存せずに閉じる" });
    await Promise.race([closing, discard.click({ timeout: 30_000 }).catch(() => undefined)]);
    await closing;
    app = undefined;
  };

  const frame = (page: Page) => page.locator(".overlay-selection-box:not(.multi)").first();
  const frameBox = async (page: Page): Promise<Box> => {
    const box = await frame(page).boundingBox();
    if (!box) throw new Error("The selection frame is missing");
    return box;
  };
  const drawnHandles = (page: Page) => frame(page).locator(".overlay-resize-handle:not(.hit-only)");
  const handleLook = (page: Page, handle: string) => frame(page).locator(`.overlay-resize-handle.${handle}`).evaluate((element) => ({
    background: getComputedStyle(element).backgroundColor,
    border: getComputedStyle(element).borderTopColor,
    bar: getComputedStyle(element, "::after").display,
    cursor: getComputedStyle(element).cursor,
  }));
  const drag = async (page: Page, from: { x: number; y: number }, to: { x: number; y: number }) => {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
    await page.mouse.move(to.x, to.y, { steps: 4 });
    await page.mouse.up();
  };
  /** 南東の角を掴んで、枠が一辺 `size` (画面 px) の正方形になるまで縮める。 */
  const shrinkTo = async (page: Page, size: number) => {
    const box = await frameBox(page);
    const handle = await frame(page).locator(".overlay-resize-handle.se").boundingBox();
    if (!handle) throw new Error("The corner handle is missing");
    const from = { x: handle.x + handle.width / 2, y: handle.y + handle.height / 2 };
    await drag(page, from, { x: from.x + size - box.width, y: from.y + size - box.height });
    await expect.poll(async () => Math.round((await frameBox(page)).width)).toBe(size);
  };

  let current: Page | undefined;
  try {
    const page = current = await launch();

    await page.getByRole("button", { name: "図形", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "四角形", exact: true }).click();
    const canvas = await page.locator(".overlay-canvas-editor").first().boundingBox();
    if (!canvas) throw new Error("Canvas is missing");
    await drag(page, { x: canvas.x + 160, y: canvas.y + 200 }, { x: canvas.x + 280, y: canvas.y + 320 });
    await expect(frame(page)).toBeVisible();

    // ふつうの大きさでは角 4 つと辺 4 本の持ち手を描く。
    await expect(drawnHandles(page)).toHaveCount(8);

    // 辺の持ち手は輪郭の上に乗るので先に消える。角は残り、辺はカーソルを変えて掴める。
    // (30 は表示倍率が 75〜125% のどれでも紙面の 24〜40px に収まる大きさ。)
    await shrinkTo(page, 30);
    await expect(drawnHandles(page)).toHaveCount(4);
    await expect(frame(page).locator(".overlay-resize-handle.hit-only")).toHaveCount(4);
    expect(await handleLook(page, "e")).toMatchObject({ bar: "none", cursor: "ew-resize" });
    expect(await handleLook(page, "se")).not.toMatchObject({ border: "rgba(0, 0, 0, 0)" });
    await expect(frame(page)).not.toHaveClass(/resize-grab-outside/);

    // さらに小さいと何も描かず、枠線だけが残る。
    await shrinkTo(page, 12);
    await expect(drawnHandles(page)).toHaveCount(0);
    await expect(frame(page)).toHaveClass(/resize-grab-outside/);
    expect(await handleLook(page, "se")).toEqual({
      background: "rgba(0, 0, 0, 0)",
      border: "rgba(0, 0, 0, 0)",
      bar: "none",
      cursor: "nwse-resize",
    });
    let box = await frameBox(page);
    await testInfo.attach("tiny-selected", {
      body: await page.screenshot({ clip: { x: box.x - 50, y: box.y - 60, width: box.width + 100, height: box.height + 110 } }),
      contentType: "image/png",
    });

    // 掴む範囲は枠の外側にあるので、図形の内側を押せば移動になる (大きさは変わらない)。
    const center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    expect(await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest(".overlay-resize-handle")), center)).toBe(false);
    await drag(page, center, { x: center.x + 60, y: center.y + 40 });
    await expect.poll(async () => Math.round((await frameBox(page)).x - box.x)).toBe(60);
    box = await frameBox(page);
    expect(Math.round(box.width)).toBe(12);
    expect(Math.round(box.height)).toBe(12);

    // 枠のすぐ外 (南東の角の斜め外側) を引けば大きくなり、持ち手がまた描かれる。
    const outside = { x: box.x + box.width + 3, y: box.y + box.height + 3 };
    expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.className, outside)).toContain("se");
    await drag(page, outside, { x: outside.x + 60, y: outside.y + 60 });
    await expect.poll(async () => Math.round((await frameBox(page)).width)).toBe(72);
    expect(Math.round((await frameBox(page)).x)).toBe(Math.round(box.x));
    await expect(drawnHandles(page)).toHaveCount(8);

    // 小さく戻して保存させ、開き直しても同じように描かれる。
    await shrinkTo(page, 12);
    await expect.poll(async () => (await savedRectangle(page))?.props.w ?? Infinity, { timeout: 30_000 }).toBeLessThan(16);
    const shape = await savedRectangle(page);
    await quit(page);
    const reopenedPage = current = await launch();
    const reopened = reopenedPage.locator(`.overlay-shape[data-overlay-shape-id="${shape!.id}"]`).first();
    await expect(reopened).toBeVisible();
    const reopenedBox = await reopened.boundingBox();
    await reopenedPage.mouse.click(reopenedBox!.x + reopenedBox!.width / 2, reopenedBox!.y + reopenedBox!.height / 2);
    await expect(frame(reopenedPage)).toBeVisible();
    await expect(frame(reopenedPage)).toHaveClass(/resize-grab-outside/);
    await expect(drawnHandles(reopenedPage)).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await (current ? quit(current) : app?.close());
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
