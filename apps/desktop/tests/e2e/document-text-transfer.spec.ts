import { expect, test, type Page } from "@playwright/test";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 教材をクリップボードのテキストだけで往復させる動線。
 *
 * ファイル保存・ファイル選択を一切通らずに «コピー → 貼り付け → 開く» が閉じることが
 * 被験対象なので、書き出しはクリップボードの中身そのものを読み、取り込みは
 * 貼り付け面から本文が紙面に出るところまで見る。
 */

const SEED_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_text_transfer_seed",
  metadata: { title: "テキスト受け渡しの種" },
  content: [{
    type: "paragraph",
    id: "p_text_transfer_seed",
    children: [{ type: "text", text: "コピー元の本文" }],
  }],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

const PASTED_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_text_transfer_pasted",
  metadata: { title: "貼り付けた三角比" },
  content: [{
    type: "paragraph",
    id: "p_text_transfer_pasted",
    children: [{ type: "text", text: "貼り付けで届いた本文" }],
  }],
  outputProfiles: {
    student: {},
    teacher: { showSolutions: true, showHints: true },
    answerBook: { includeAnswers: true, onlySolutions: true },
  },
};

test.beforeEach(async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await installDesktopRuntimeMock(page, SEED_DOCUMENT);
});

test("copies the material to the clipboard as text", async ({ page }) => {
  await openEditor(page);

  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  const fileMenu = page.getByRole("menu", { name: "ファイル" });
  await fileMenu.getByRole("menuitem", { name: "エクスポート", exact: true }).hover();
  await page.getByRole("menu", { name: "エクスポート" })
    .getByRole("menuitem", { name: "テキストでコピー", exact: true })
    .click();

  await expect(page.getByText("教材をテキストでコピーしました")).toBeVisible();

  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const parsed = JSON.parse(copied) as SigmaDocument;
  expect(parsed.docId).toBe(SEED_DOCUMENT.docId);
  expect(JSON.stringify(parsed.content)).toContain("コピー元の本文");
});

test("opens a material pasted as text", async ({ page }) => {
  await openEditor(page);

  await openTextImportDialog(page);
  const dialog = page.getByRole("dialog", { name: "テキストから読み込み" });
  await dialog.getByLabel("読み込むテキスト").fill(JSON.stringify(PASTED_DOCUMENT));
  await dialog.getByRole("button", { name: "読み込む", exact: true }).click();

  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel("教材タイトル")).toHaveValue("貼り付けた三角比");
  await expect(page.locator(".page-canvas")).toContainText("貼り付けで届いた本文");
});

test("keeps the pasted text in place and explains broken JSON", async ({ page }) => {
  await openEditor(page);

  await openTextImportDialog(page);
  const dialog = page.getByRole("dialog", { name: "テキストから読み込み" });
  await dialog.getByLabel("読み込むテキスト").fill('{"docId": "doc_broken"');
  await dialog.getByRole("button", { name: "読み込む", exact: true }).click();

  await expect(dialog.getByRole("alert")).toContainText("JSONの構文が壊れています");
  // 貼り直せるよう面は開いたままで、本文もそのまま残る。
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel("読み込むテキスト")).toHaveValue('{"docId": "doc_broken"');
  await expect(page.getByLabel("教材タイトル")).toHaveValue("テキスト受け渡しの種");
});

async function openEditor(page: Page): Promise<void> {
  await page.goto(appUrl("/"), { waitUntil: "domcontentloaded" });
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
}

async function openTextImportDialog(page: Page): Promise<void> {
  await page.getByRole("button", { name: "ファイル", exact: true }).click();
  await page.getByRole("menu", { name: "ファイル" })
    .getByRole("menuitem", { name: "テキストから読み込み", exact: true })
    .click();
}

function appUrl(path: string): string {
  return process.env.SIGMA_STUDIO_E2E_BASE_URL ? new URL(path, process.env.SIGMA_STUDIO_E2E_BASE_URL).toString() : path;
}
