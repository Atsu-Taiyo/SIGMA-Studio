import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const DOCUMENT_PATH = "/tmp/file_e2e_document.sigmadoc.json";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installDesktopRuntimeMock(page, sampleDocument, {
    documentLoadFailure: {
      error: 'SigmaDocの必須構造を読み込めませんでした (pageLayout.preset): Invalid option: expected one of "A4"|"A3"|"B5"|"B4"|"custom"',
      failureKind: "schema",
      documentPath: DOCUMENT_PATH,
      title: "三角関数の総復習",
      failures: [
        {
          path: "pageLayout.preset",
          message: 'Invalid option: expected one of "A4"|"A3"|"B5"|"B4"|"custom"',
          code: "invalid_value",
          expected: '"A4" | "A3" | "B5" | "B4" | "custom"',
          received: '"whiteboard"',
        },
      ],
    },
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });
});

test("開けない教材でも起動し、原因と修復プロンプトを本文の位置に表示する", async ({ page }) => {
  const panel = page.getByTestId("document-open-failure");
  await expect(panel).toBeVisible();

  // 本文エディタの代わりに原因が出ている (黙って別教材へ切り替わらない)。
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "この教材を開けませんでした" })).toBeVisible();
  await expect(panel).toContainText("三角関数の総復習");
  await expect(panel).toContainText("pageLayout.preset");
  await expect(panel).toContainText('"whiteboard"');
  await expect(panel).toContainText(DOCUMENT_PATH);

  // ウィジェットのプロンプトは、そのままAIへ貼れる自己完結の内容になっている。
  const prompt = panel.getByLabel("教材を直すためのプロンプト");
  const promptText = await prompt.inputValue();
  expect(promptText).toContain(DOCUMENT_PATH);
  expect(promptText).toContain("apps/desktop/src/lib/sigma-doc-schema.ts");
  expect(promptText).toContain("pageLayout.preset");
  expect(promptText).toContain('"whiteboard"');

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "プロンプトをコピー" }).click();
  await expect(panel.getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(promptText);

  // タイトルは編集できない (空の下書きが壊れた教材へ書き戻らないようにする)。
  await expect(page.getByLabel("教材タイトル")).toBeDisabled();
});

test("教材を直したあとは再読み込みでその場で開ける", async ({ page }) => {
  const panel = page.getByTestId("document-open-failure");
  await expect(panel).toBeVisible();

  await page.evaluate(() => {
    (window as unknown as { __sigmaRepairFailedDocument: () => void }).__sigmaRepairFailedDocument();
  });
  await panel.getByRole("button", { name: "再読み込み" }).click();

  await expect(page.getByTestId("document-open-failure")).toHaveCount(0);
  await expect(page.locator(".ProseMirror").first()).toBeVisible();
});
