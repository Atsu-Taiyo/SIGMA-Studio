import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("detects a typed URL and turns it into a QR overlay image", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, sampleDocument);
  await page.goto("/");
  await page.waitForTimeout(1500);

  const editable = page.locator(".text-flow-editor").first();
  await expect(editable).toBeVisible();
  await editable.click();
  await page.keyboard.insertText("資料は https://example.com/page を参照");
  await page.waitForTimeout(300);

  // The URL is detected and decorated.
  const detected = page.locator(".url-detected");
  await expect(detected.first()).toContainText("https://example.com/page");

  // The inline QR affordance appears and inserts an overlay image when clicked.
  const qrButton = page.locator(".url-qr-action").first();
  await expect(qrButton).toBeVisible();

  const overlayImagesBefore = await page.locator("image, img").count();
  await qrButton.click();

  await expect
    .poll(async () => page.locator("image, img").count(), { timeout: 10_000 })
    .toBeGreaterThan(overlayImagesBefore);
});
