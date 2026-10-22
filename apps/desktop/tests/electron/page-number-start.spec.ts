import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { _electron as electron, expect, test, type Page } from "@playwright/test";
import { createBlankDocument } from "@/lib/blank-document";

const APP_ROOT = path.resolve(__dirname, "../..");
const devUrl = process.env.SIGMA_STUDIO_E2E_BASE_URL;

/**
 * ページ番号の開始 (表紙を 0 ページにする)。フッターの `{page}/{total}` を 3 ページ以上の教材で確かめる。
 * - ページ設定の「ページ番号の開始」に 0 を入れて適用すると、編集画面のフッターが 0,1,2,… になり、
 *   最後のページは「N-1/N-1」(`{total}` は最後のページの番号と同じ)
 * - 保存した教材 (`pageLayout.pageNumberStart`) に 0 が入り、開き直しても欄・フッターとも同じ
 * - PDF の面 (`/print`) のフッターも同じ番号
 * - 1 に戻すと値を持たなくなる (番号を変えていない教材の保存内容は変わらない)
 */
test("page number start of 0 numbers the footers 0..N-1 in the editor and the print surface, and survives a reload", async ({}, testInfo) => {
  test.skip(!existsSync(path.join(APP_ROOT, "dist-electron/main.cjs")), "Build Electron first");
  test.skip(!devUrl && !existsSync(path.join(APP_ROOT, "out/index.html")), "Start a private dev server or build the renderer");
  const profile = mkdtempSync(path.join(tmpdir(), "sigma-page-number-start-"));
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
    const blank = createBlankDocument("表紙つきの教材");
    blank.content = Array.from({ length: 36 }, (_, index) => ({
      type: "paragraph" as const,
      id: `number_start_p_${index}`,
      children: [{ type: "text" as const, text: `${index + 1}. ${"二次関数のグラフと平方完成について順に確かめます。".repeat(4)}` }],
    }));
    blank.pageLayout = {
      ...blank.pageLayout!,
      footer: {
        ...blank.pageLayout!.footer!,
        enabled: true,
        blocks: [{ type: "paragraph", id: "number_start_footer", align: "center", children: [{ type: "text", text: "{page}/{total}" }] }],
      },
    };
    const created = await page.evaluate((document) => window.desktopAPI!.storage.createFileFromDocument({ document }), blank);
    const fileId = created.file.fileId;
    await page.reload();
    await expect(body(page)).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);

    const editorSheets = page.locator(".page-backdrop .a4-page-sheet");
    const footerSelector = ".page-running-region.footer .running-field-value";
    const footers = (surface: string) => page.locator(surface).evaluateAll((sheets, selector) => sheets.map((sheet) => (
      Array.from(sheet.querySelectorAll(selector), (node) => node.textContent).join("/")
    )), footerSelector);
    // PDF の面は、ページごとの窓が積み重ねた紙を丸ごと複製して切り出す。N 番目の窓で見えているのは N 番目の紙。
    const printFooters = () => page.locator(".paged-surface-page").evaluateAll((windows, selector) => windows.map((window, index) => (
      Array.from(window.querySelectorAll(".a4-page-sheet")[index]?.querySelectorAll(selector) ?? [], (node) => node.textContent).join("/")
    )), footerSelector);
    const savedStart = () => page.evaluate(async (id) => {
      const document = await window.desktopAPI!.storage.loadDocument(id);
      return document?.pageLayout && "pageNumberStart" in document.pageLayout ? document.pageLayout.pageNumberStart : null;
    }, fileId);
    /**
     * 描かれている紙 (`drawn` 枚。編集面は見えている近くのページしか描かない) に対して、全 `total` ページで
     * `0/N-1 … ` と出ていること。総数は描いた枚数ではなく文書のページ数。
     */
    const expectedFromZero = (drawn: number, total: number) => Array.from({ length: drawn }, (_, index) => `${index}/${total - 1}`);
    const expectedFromOne = (drawn: number, total: number) => Array.from({ length: drawn }, (_, index) => `${index + 1}/${total}`);

    // 既定: 1 から数える。3 ページ以上ある。
    await expect.poll(() => editorSheets.count()).toBeGreaterThanOrEqual(3);
    const pageCount = Number(await page.locator(".page-canvas").first().getAttribute("data-page-count"));
    const drawnSheets = await editorSheets.count();
    await expect.poll(() => footers(".page-backdrop .a4-page-sheet")).toEqual(expectedFromOne(drawnSheets, pageCount));
    expect(await savedStart()).toBeNull();

    const openDialog = async () => {
      await page.getByRole("button", { name: "設定", exact: true }).first().click();
      await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
      const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    // ページ設定で 0 にする。
    let dialog = await openDialog();
    await expect(dialog.locator("#page-number-start")).toHaveValue("1");
    await dialog.locator("#page-number-start").fill("0");
    await dialog.locator("#page-number-start").press("Tab");
    await page.screenshot({ path: testInfo.outputPath("page-setup-number-start.png") });
    await dialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => footers(".page-backdrop .a4-page-sheet")).toEqual(expectedFromZero(drawnSheets, pageCount));
    await expect.poll(savedStart).toBe(0);
    await page.screenshot({ path: testInfo.outputPath("footers-from-zero.png") });

    // 開き直しても同じ (欄にも紙面にも)。
    await page.reload();
    await expect(body(page)).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);
    await expect.poll(() => footers(".page-backdrop .a4-page-sheet")).toEqual(expectedFromZero(drawnSheets, pageCount));
    dialog = await openDialog();
    await expect(dialog.locator("#page-number-start")).toHaveValue("0");
    await dialog.getByRole("button", { name: "キャンセル", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    // PDF の面 (`/print`) も同じ番号。
    const printUrl = new URL(page.url());
    printUrl.pathname = printUrl.protocol === "file:" ? printUrl.pathname.replace(/index\.html$/, "print.html") : "/print";
    printUrl.search = new URLSearchParams({ fileId, profile: "teacher" }).toString();
    await page.goto(printUrl.href);
    await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
    await expect.poll(printFooters).toEqual(expectedFromZero(pageCount, pageCount));
    await page.screenshot({ path: testInfo.outputPath("print-from-zero.png") });

    // 編集画面へ戻り、1 に戻すと値を持たなくなる。
    await page.goBack();
    await expect(body(page)).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden" }).catch(() => undefined);
    dialog = await openDialog();
    await dialog.locator("#page-number-start").fill("1");
    await dialog.locator("#page-number-start").press("Tab");
    await dialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => footers(".page-backdrop .a4-page-sheet")).toEqual(expectedFromOne(drawnSheets, pageCount));
    await expect.poll(savedStart).toBeNull();
  } finally {
    await app.close();
    rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 });
  }
});
