import { expect, test, type Page } from "@playwright/test";

/**
 * Web 版 (Electron の bridge が無い素のブラウザ) の保存。
 *
 * ここが落ちるときは「打った本文が再読み込みで消える」に戻っている。desktop の
 * bridge モックは**入れない** — 入れると desktop の保存経路を測ることになる。
 */

async function openEditor(page: Page): Promise<void> {
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function openWorkspace(page: Page): Promise<void> {
  await page.goto("/workspace", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".workspace-sidebar")).toBeVisible();
}

test("keeps the typed body across a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openEditor(page);

  const body = page.locator("[data-sigma-doc-id]").first();
  await body.click();
  await page.keyboard.type("ブラウザに保存した本文");
  // 自動保存はデバウンスされる。保存済みバッジが出るまでは reload しない。
  await expect(page.locator(".save-state.saved")).toContainText("自動保存");

  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();

  await expect(page.locator("[data-sigma-doc-id]").filter({ hasText: "ブラウザに保存した本文" }).first())
    .toContainText("ブラウザに保存した本文");
  // 保存先が無い時の警告が出ていない = IndexedDB に届いている。
  await expect(page.locator(".save-state.error")).toHaveCount(0);
});

test("keeps a workspace folder created from the workspace screen across a reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openWorkspace(page);

  await page.getByRole("button", { name: "新規", exact: true }).click();
  await page.getByRole("menuitem", { name: "新しいフォルダ", exact: true }).click();
  await page.getByLabel("フォルダ名").fill("単元テスト");
  await page.getByRole("button", { name: "作成", exact: true }).click();
  await expect(page.getByText("単元テスト").first()).toBeVisible();

  await page.reload();
  await expect(page.locator(".workspace-sidebar")).toBeVisible();

  await expect(page.getByText("単元テスト").first()).toBeVisible();
});

test("shows another tab's new workspace without a manual reload", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 820 });
  await openWorkspace(page);

  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 820 });
  await openWorkspace(other);
  await other.getByRole("button", { name: "新規", exact: true }).click();
  await other.getByRole("menuitem", { name: "新しいワークスペース", exact: true }).click();
  await other.getByLabel("ワークスペース名").fill("2つ目のワークスペース");
  await other.getByRole("button", { name: "作成", exact: true }).click();
  await expect(other.getByText("2つ目のワークスペース").first()).toBeVisible();

  // BroadcastChannel 経由の変更通知。手動の再読み込みはしない。
  await expect(page.getByText("2つ目のワークスペース").first()).toBeVisible({ timeout: 15_000 });
  await other.close();
});
