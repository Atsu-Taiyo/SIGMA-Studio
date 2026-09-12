import { expect, test } from "@playwright/test";

import { createBlankDocument } from "@/lib/blank-document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("previews snapshots on the canvas, restores from the banner, and captures tab boundaries", async ({ page }) => {
  const document = {
    ...createBlankDocument("版履歴"),
    content: [{ type: "paragraph" as const, id: "p_version", children: [{ type: "text" as const, text: "initial version" }] }],
  };
  await installDesktopRuntimeMock(page, document, { emitWatcherEventOnSave: true });
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 20_000 });
  await page.evaluate(() => (window as unknown as { __seedSigmaVersionHistory: () => void }).__seedSigmaVersionHistory());
  await expect(page.locator('[data-sigma-doc-id="p_version"]')).toContainText("second saved version with additions");

  await page.getByRole("button", { name: "バージョン履歴", exact: true }).click();
  const panel = page.getByRole("complementary", { name: "バージョン履歴" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".version-history-row")).toHaveCount(3);
  await expect(panel.locator(".version-history-row").first()).toContainText("現在の版");
  await expect(panel.locator(".version-history-row").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".text-flow-editor")).toBeVisible();

  const unchangedCount = await page.evaluate(async () => {
    const api = window.desktopAPI!;
    const file = (await api.storage.listFiles())[0];
    const current = await api.storage.loadDocument(file.fileId);
    await api.storage.saveDocument(file.fileId, { ...current!, updatedAt: new Date().toISOString() }, {
      expectedRevision: file.revision,
      origin: "ai",
    });
    return (window as unknown as { __sigmaVersionCount: number }).__sigmaVersionCount;
  });
  expect(unchangedCount).toBe(2);
  await page.waitForTimeout(200);

  await panel.locator(".version-history-row").nth(2).click();
  const preview = page.locator('[data-version-history-preview="true"]');
  await expect(preview).toBeVisible();
  await expect(page.locator('.editor-canvas > .page-mode:not([data-paged-render="true"])')).toHaveCount(0);
  await expect(preview.locator(".paged-surface-pages")).toContainText("first saved version");
  await expect(page.locator('[data-editor-toolbar="quick"]')).toHaveAttribute("inert", "");
  await expect(preview.getByText(/\u306e版を表示中$/)).toBeVisible();

  await preview.getByRole("button", { name: "現在の版に戻る", exact: true }).click();
  await expect(page.locator(".text-flow-editor")).toBeVisible();
  await expect(panel.locator(".version-history-row").first()).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator('[data-sigma-doc-id="p_version"]')).toContainText("second saved version with additions");

  await panel.locator(".version-history-row").nth(2).click();
  await preview.getByRole("button", { name: "この版に戻す", exact: true }).click();
  await expect(page.locator(".text-flow-editor")).toBeVisible();
  await expect(page.locator('[data-sigma-doc-id="p_version"]')).toContainText("first saved version");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaVersionCount: number }).__sigmaVersionCount)).toBe(3);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaCreatedFileCount: number }).__sigmaCreatedFileCount)).toBe(0);

  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __sigmaVersionCount: number }).__sigmaVersionCount)).toBe(4);
});
