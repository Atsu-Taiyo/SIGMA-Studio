import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

async function typeUrl(page: import("@playwright/test").Page) {
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.goto("/");
  await page.waitForTimeout(1500);

  const editable = page.locator(".text-flow-editor").first();
  await expect(editable).toBeVisible();
  await editable.click();
  await page.keyboard.insertText("資料は https://example.com/page を参照");
  await page.waitForTimeout(300);

  // The URL is detected and decorated; there is no inline button beside it any more.
  const detected = page.locator(".url-detected");
  await expect(detected.first()).toContainText("https://example.com/page");
  await expect(page.locator(".url-qr-action")).toHaveCount(0);
  return detected.first();
}

test("hovering a detected URL offers QR code and the default browser, and the QR code becomes an overlay image", async ({ page }) => {
  test.setTimeout(60_000);
  const link = await typeUrl(page);

  await link.hover();
  const card = page.locator(".url-link-card");
  await expect(card).toBeVisible();
  await expect(card.locator("[data-action]")).toHaveText(["QRコード", "ブラウザで開く"]);

  const overlayImagesBefore = await page.locator("image, img").count();
  await card.locator('[data-action="qr"]').click();
  await expect(card).toHaveCount(0);

  await expect
    .poll(async () => page.locator("image, img").count(), { timeout: 10_000 })
    .toBeGreaterThan(overlayImagesBefore);
});

test("the hover card opens the URL in the default browser, and Cmd/Ctrl+click does the same", async ({ page }) => {
  test.setTimeout(60_000);
  const link = await typeUrl(page);
  await page.evaluate(() => {
    const opened: string[] = [];
    (window as unknown as { __opened: string[] }).__opened = opened;
    window.desktopAPI!.shell.openExternal = async (url: string) => {
      opened.push(url);
      return { ok: true };
    };
  });
  const opened = () => page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);

  await link.hover();
  await page.locator('.url-link-card [data-action="browser"]').click();
  await expect.poll(opened).toEqual(["https://example.com/page"]);

  // A plain click only places the caret.
  await link.click();
  await page.waitForTimeout(200);
  expect(await opened()).toHaveLength(1);

  const modifier = process.platform === "darwin" ? "Meta" : "Control";
  await link.click({ modifiers: [modifier] });
  await expect.poll(opened).toEqual(["https://example.com/page", "https://example.com/page"]);
});
