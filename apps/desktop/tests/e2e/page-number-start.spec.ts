import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

/**
 * ページ番号の開始 (`pageLayout.pageNumberStart`)。表紙を 0 ページにできる。
 *
 * - フッターの `{page}` `{total}` だけが変わる。5 ページで開始 0 なら 0,1,2,3,4 と出て、最後の
 *   ページは「4/4」(`{total}` は最後のページの番号と同じ)。
 * - 編集画面と PDF (印刷) の面が同じ番号を出す。
 * - 「先頭ページのみ」のような表示するページの指定は、番号が 0 でも組版上の 1 枚目のまま。
 * 保存して開き直す確認は実機の spec (`tests/electron/page-number-start.spec.ts`)。
 */
const PAGES = 5;

function coverDocument(options: { pageNumberStart?: number; footer?: Record<string, unknown> } = {}): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_page_number_start",
    metadata: { title: "表紙つきの教材" },
    content: Array.from({ length: PAGES }, (_, index) => ({
      type: "paragraph" as const,
      id: `page_start_p${index + 1}`,
      children: [{ type: "text" as const, text: index === 0 ? "表紙" : `${index}ページ目の本文` }],
      ...(index === 0 ? {} : { pagination: { break: true } }),
    })),
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 90, heightMm: 100 },
      marginsMm: { top: 10, right: 10, bottom: 18, left: 10 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      footer: {
        enabled: true,
        heightMm: 6,
        offsetMm: 5,
        showOnFirstPage: true,
        blocks: [{
          type: "paragraph",
          id: "footer_numbers",
          align: "center",
          children: [{ type: "text", text: "{page}/{total}" }],
        }],
        ...options.footer,
      },
      ...(options.pageNumberStart === undefined ? {} : { pageNumberStart: options.pageNumberStart }),
    },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  } as SigmaDocument;
}

/** 紙 1 枚につき、フッターの差し込みの値 (`{page}` `{total}`) を並べた文字列。 */
async function footerTexts(page: Page, sheets: string): Promise<string[]> {
  return page.locator(sheets).evaluateAll((elements) => elements.map((sheet) => (
    Array.from(sheet.querySelectorAll(".page-running-region.footer .running-field-value"), (node) => node.textContent).join("/")
  )));
}

const EDITOR_SHEETS = ".page-backdrop .a4-page-sheet";
const PRINT_SHEETS = ".paged-surface-page-slot .a4-page-sheet";

async function openEditor(page: Page, document: SigmaDocument): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow")).toHaveCount(1);
  await expect.poll(() => page.locator(EDITOR_SHEETS).count()).toBe(PAGES);
}

async function openPrint(page: Page, document: SigmaDocument): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await waitForPagedSurfaceSettled(page);
  await expect.poll(() => page.locator(PRINT_SHEETS).count()).toBe(PAGES);
}

test.describe("ページ番号の開始", () => {
  test("既定では 1 から数え、最後のページの総ページ数は物理のページ数", async ({ page }) => {
    await openEditor(page, coverDocument());

    await expect.poll(() => footerTexts(page, EDITOR_SHEETS)).toEqual(["1/5", "2/5", "3/5", "4/5", "5/5"]);
  });

  test("ページ設定で 0 にすると、フッターが 0..4 になり最後は 4/4 と読める", async ({ page }) => {
    await openEditor(page, coverDocument());

    await page.getByRole("button", { name: "設定", exact: true }).first().click();
    await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
    await expect(dialog).toBeVisible();
    const input = dialog.locator("#page-number-start");
    await expect(input).toHaveValue("1");
    await expect(dialog.getByText("表紙を0ページにするときは0にします。")).toBeVisible();
    await input.fill("0");
    await input.press("Tab");
    await dialog.getByRole("button", { name: "適用", exact: true }).click();
    await expect(dialog).toHaveCount(0);

    await expect.poll(() => footerTexts(page, EDITOR_SHEETS)).toEqual(["0/4", "1/4", "2/4", "3/4", "4/4"]);
    // 保存された教材に値が入る (既定に戻すと持たなくなる)。
    await expect.poll(() => page.evaluate(() => (
      JSON.parse(window.localStorage.getItem("sigma-studio:e2e-document") ?? "{}").pageLayout?.pageNumberStart
    ))).toBe(0);
  });

  test("PDF (印刷) の面も同じ番号を出す", async ({ page }) => {
    await openPrint(page, coverDocument({ pageNumberStart: 0 }));

    await expect.poll(() => footerTexts(page, PRINT_SHEETS)).toEqual(["0/4", "1/4", "2/4", "3/4", "4/4"]);
  });

  test("別の開始番号でも、ページと総ページ数が同じだけずれる", async ({ page }) => {
    await openPrint(page, coverDocument({ pageNumberStart: 10 }));

    await expect.poll(() => footerTexts(page, PRINT_SHEETS)).toEqual(["10/14", "11/14", "12/14", "13/14", "14/14"]);
  });

  test("表示するページの指定は番号が 0 でも組版上のページのまま (先頭ページのみ = 表紙だけ)", async ({ page }) => {
    await openEditor(page, coverDocument({ pageNumberStart: 0, footer: { showOnLaterPages: false } }));

    await expect.poll(() => footerTexts(page, EDITOR_SHEETS)).toEqual(["0/4", "", "", "", ""]);
  });
});
