import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";
import { MM_TO_PX } from "@/features/document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

/**
 * ヘッダーの大きさは利用者が決めたまま残る。
 * - 1 行より低く (0mm まで) ドラッグで縮められる
 * - 編集に入り直しても、中身の高さへ戻されない (以前はダブルクリックで元に戻った)
 * - 行を足すと伸び、消すと利用者の決めた高さへ戻る
 * - ページ設定で上余白を 10mm にすると、ヘッダーがその中に縮んでそのまま適用される
 * どれも保存して開き直した教材で確かめる。
 */
test("header size stays where the user puts it, down to zero, and page setup applies a 10 mm top margin", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-running-region-resize-"));
  const env: Record<string, string> = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  delete env.ELECTRON_RUN_AS_NODE;
  if (devUrl) env.SIGMA_STUDIO_DEV_SERVER_URL = devUrl;
  const app = await electron.launch({ args: [APP_ROOT, `--user-data-dir=${profile}`], cwd: APP_ROOT, env });
  const body = (page: Page) => page.locator(".page-flow .ProseMirror").first();
  try {
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    await expect(body(page)).toBeVisible();
    await page.evaluate(async () => {
      await window.desktopAPI!.settings!.setUiLocale!("ja");
      localStorage.setItem("sigma-studio:ui-layout-preference", JSON.stringify({ mode: "docs", onboardingCompleted: true, ribbonCollapsed: false }));
    });
    const blank = createBlankDocument("ヘッダーの大きさ");
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), blank);
    const fileId = created.file.fileId;
    await page.reload();
    await expect(body(page)).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);
    const savedHeader = async () => {
      const document = await page.evaluate((id) => window.desktopAPI!.storage.loadDocument(id), fileId);
      return {
        heightMm: document?.pageLayout?.header?.heightMm,
        offsetMm: document?.pageLayout?.header?.offsetMm,
        top: document?.pageLayout?.marginsMm.top,
      };
    };

    const sheet = page.locator(".a4-page-sheet").first();
    const pxPerMm = async () => ((await sheet.boundingBox())!.width / 210);
    const band = page.locator(".page-running-editor-band.header");
    const bandHeightMm = async () => ((await band.boundingBox())?.height ?? 0) / await pxPerMm();
    const enterHeader = async () => {
      const box = (await sheet.boundingBox())!;
      await page.mouse.dblclick(box.x + box.width / 2, box.y + 8 * await pxPerMm());
      await expect(page.locator(".page-running-direct-editor.header")).toBeVisible();
    };
    const leaveHeader = async () => {
      const box = (await sheet.boundingBox())!;
      await page.mouse.click(box.x + box.width / 2, box.y + 150 * await pxPerMm());
      await expect(page.locator(".page-running-direct-editor.header")).toHaveCount(0);
    };
    const dragEnd = async (deltaMm: number) => {
      const edge = page.locator(".page-running-editor-band.header.editing .page-running-edge.end");
      const box = (await edge.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + deltaMm * await pxPerMm(), { steps: 8 });
      await expect(edge.locator(".page-running-edge-value")).toHaveCSS("opacity", "1");
      await page.mouse.up();
    };

    // 有効にした直後は既定の 8mm (中身に合わせて 12mm 台へ広げない)。
    await enterHeader();
    await expect.poll(bandHeightMm).toBeCloseTo(8, 0);

    // 0mm まで縮められる。上余白も帯の辺に付いてくる。
    await dragEnd(-20);
    await expect.poll(savedHeader).toEqual({ heightMm: 0, offsetMm: 5, top: 5 });
    await page.screenshot({ path: testInfo.outputPath("header-zero.png") });

    // 引き伸ばした帯は、編集に入り直しても戻らない。
    await dragEnd(15);
    await expect.poll(savedHeader).toEqual({ heightMm: 15, offsetMm: 5, top: 20 });
    await leaveHeader();
    await enterHeader();
    await page.waitForTimeout(300);
    expect(await savedHeader()).toEqual({ heightMm: 15, offsetMm: 5, top: 20 });

    // 行を足すと伸び、消すと利用者の 15mm へ戻る。
    const headerEditor = page.locator(".page-running-direct-editor.header .text-flow-editor");
    await headerEditor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText("1行目");
    for (const line of ["2行目", "3行目", "4行目"]) {
      await page.keyboard.press("Enter");
      await page.keyboard.insertText(line);
    }
    await expect.poll(async () => (await savedHeader()).heightMm ?? 0).toBeGreaterThan(20);
    await headerEditor.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.insertText("1行目");
    await expect.poll(savedHeader).toEqual({ heightMm: 15, offsetMm: 5, top: 20 });
    await leaveHeader();

    // ページ設定: 上余白 10mm がそのまま適用され、ヘッダーはその中に収まる。
    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("#page-header-height")).toHaveValue("15");
    await dialog.locator("#margin-top").fill("10");
    await dialog.locator("#margin-top").press("Tab");
    await expect(dialog.locator("#page-header-height")).toHaveValue("5");
    await expect(dialog.getByTestId("page-setup-preview")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("page-setup-margin-10.png") });
    await dialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(savedHeader).toEqual({ heightMm: 5, offsetMm: 5, top: 10 });

    // 開き直しても同じ。本文は上から 10mm で始まる。
    await page.reload();
    await expect(body(page)).toBeVisible();
    const flowTop = await page.locator(".page-canvas").first().evaluate((element) => (
      parseFloat(getComputedStyle(element).getPropertyValue("--page-margin-top"))
    ));
    expect(flowTop).toBeCloseTo(10 * MM_TO_PX, 0);
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
