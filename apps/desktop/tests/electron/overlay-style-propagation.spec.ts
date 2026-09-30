import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SigmaDocument } from "@/types/sigma-doc";
import { sampleDocument } from "@/lib/sample-document";

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
  const button = page.locator(".editor-menubar").getByRole("button", { name: /^線の右端（現在: / });
  await expect(button).toBeEnabled();
  await button.click();
  const menu = page.getByRole("menu", { name: "線の右端" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitemradio", { name: label, exact: true }).click();
  await expect(menu).toHaveCount(0);
}

test("consecutive arrow styles survive saving and restarting Electron", async () => {
  const root = path.resolve(__dirname, "../..");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-arrow-styles-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (process.env.SIGMA_STUDIO_E2E_BASE_URL) env.SIGMA_STUDIO_DEV_SERVER_URL = process.env.SIGMA_STUDIO_E2E_BASE_URL;
  const launch = () => electron.launch({ args: [root], cwd: root, env });
  let app = await launch();
  try {
    let page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    const created = await page.evaluate(async source => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      return window.desktopAPI!.storage.createFileFromDocument({ document: source });
    }, { ...sampleDocument, pageLayout: { ...sampleDocument.pageLayout, overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } } } } as SigmaDocument);
    await page.reload();
    await expect(page.locator(".text-flow-editor").first()).toBeVisible();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await page.setViewportSize({ width: 1400, height: 900 });
    const expected: { id: string; props: { arrowheadEnd: string } }[] = [];
    for (const [index, label, kind] of [[0, "三角", "triangle"], [1, "ひし形", "diamond"], [2, "矢印（細）", "thinArrow"]] as const) {
      const id = await drawLine(page, index);
      await pickEndpoint(page, label);
      await expect(page.locator(`[data-overlay-shape-id="${id}"] marker#${kind}-${id}-end`)).toHaveCount(1);
      expected.push({ id, props: { arrowheadEnd: kind } });
    }
    await expect.poll(() => page.evaluate(id => window.desktopAPI!.storage.loadDocument(id), created.file.fileId))
      .toMatchObject({ pageLayout: { overlay: { overlaySnapshot: { shapes: expected } } } });
    await app.close();
    app = await launch();
    page = await app.firstWindow();
    for (const { id, props: { arrowheadEnd: kind } } of expected) {
      await expect(page.locator(`[data-overlay-shape-id="${id}"] marker#${kind}-${id}-end`)).toHaveCount(1);
    }
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
});
