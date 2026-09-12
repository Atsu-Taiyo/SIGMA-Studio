import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("waits for the PDF document instead of treating loading as an error", async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument, { storageLoadDelayMs: 500 });

  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });

  await expect(page.locator(".print-load-pending")).toBeVisible();
  await expect(page.locator('[data-print-load-state="error"]')).toHaveCount(0);
  await expect(page.locator(".paged-surface")).toBeVisible();
  await expect(page.locator(".paged-surface-page")).not.toHaveCount(0);
});

test("saves the PDF to the PC from the final preview", async ({ page }) => {
  await installDesktopRuntimeMock(page, {
    ...sampleDocument,
    metadata: { ...sampleDocument.metadata, title: "二次関数 テスト" },
  });

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();

  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menuitem", { name: "エクスポート" }).hover();
  await page.getByRole("menuitem", { name: "PDFを書き出し" }).click();

  const preview = page.getByRole("dialog", { name: "PDFプレビュー" });
  await expect(preview).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-export-pdf-payload"))).toBeNull();

  await preview.getByRole("button", { name: "PDF保存" }).click();

  await expect.poll(async () => {
    const value = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-export-pdf-payload"));
    return value ? JSON.parse(value) : null;
  }).toEqual({
    surfaceId: expect.stringMatching(/^pdf_surface_/),
    revision: expect.any(Number),
    pageCount: expect.any(Number),
    pageWidthMm: expect.any(Number),
    pageHeightMm: expect.any(Number),
    suggestedName: "二次関数 テスト.pdf",
  });
  const savedDialog = page.getByRole("dialog", { name: "PDFを保存しました" });
  await expect(savedDialog).toBeVisible();
  await expect(savedDialog).toContainText("PDFをこのPCに保存しました。");
  await expect(savedDialog).toContainText("/Users/e2e/Downloads/二次関数 テスト.pdf");
  await savedDialog.getByRole("button", { name: "閉じる", exact: true }).click();
  await expect(savedDialog).toHaveCount(0);
});
