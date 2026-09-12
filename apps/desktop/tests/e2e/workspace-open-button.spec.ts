import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

// エディタ上部の単独「ワークスペース」ボタン。以前はここがアカウントメニュー
// (サインイン導線) で、ワークスペースはメニューを開いた先の項目だった。
test("opens the workspace screen with a single click from the editor menubar", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();

  const workspaceButton = page.getByRole("button", { name: "ワークスペース", exact: true });
  await expect(workspaceButton).toBeVisible();

  // サインイン導線は残っていない。
  await expect(page.getByRole("button", { name: /サインイン/ })).toHaveCount(0);

  await workspaceButton.click();
  await page.waitForURL(/\/workspace/);
  expect(new URL(page.url()).pathname).toContain("/workspace");
});
