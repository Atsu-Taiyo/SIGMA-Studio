import { expect, test } from "@playwright/test";

import type { LedgerSchemaFailure } from "@/lib/library-schema";
import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import {
  createDefaultWorkspaceMockSeed,
  installWorkspaceRuntimeMock,
} from "./workspace-runtime-mock";

const LIBRARY_PATH = "/Users/e2e/Library/Application Support/Sigma Studio/data/library.json";
const LEDGER_SCHEMA_FAILURE: LedgerSchemaFailure = {
  libraryPath: LIBRARY_PATH,
  expectedVersion: 4,
  actualVersion: 3,
  violations: [
    {
      path: "workspaces[0].kind",
      reason: { kind: "forbiddenField" as const, field: "kind" },
      expected: null,
      received: '"cloud"',
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
});

test("Editor起動時に台帳エラーを表示し、修復後は再読み込みで復帰する", async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument, {
    ledgerSchemaFailure: LEDGER_SCHEMA_FAILURE,
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  const panel = page.getByTestId("ledger-schema-failure");
  await expect(panel).toBeVisible();
  await expect(page.locator(".ProseMirror")).toHaveCount(0);
  await expect(panel.getByRole("heading", { name: "教材ライブラリの索引を読み込めませんでした" })).toBeVisible();
  await expect(panel).toContainText("ファイルは変更していません。");

  const prompt = panel.getByLabel("教材ライブラリの索引を直すためのプロンプト");
  const promptText = await prompt.inputValue();
  expect(promptText).toContain(LIBRARY_PATH);
  expect(promptText).toContain("workspaces[0].kind");

  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await panel.getByRole("button", { name: "プロンプトをコピー" }).click();
  await expect(panel.getByRole("button", { name: "コピーしました" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(promptText);

  await page.evaluate(() => {
    (window as unknown as { __sigmaRepairLedger: () => void }).__sigmaRepairLedger();
  });
  await panel.getByRole("button", { name: "再読み込み" }).click();

  await expect(page.getByTestId("ledger-schema-failure")).toHaveCount(0);
  await expect(page.locator(".ProseMirror").first()).toBeVisible();
});

test("workspace画面でも台帳エラーを表示し、修復後は一覧へ復帰する", async ({ page }) => {
  await installWorkspaceRuntimeMock(page, createDefaultWorkspaceMockSeed(), {
    ledgerSchemaFailure: LEDGER_SCHEMA_FAILURE,
  });
  await page.goto("/workspace", { waitUntil: "domcontentloaded" });

  const panel = page.getByTestId("ledger-schema-failure");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText(LIBRARY_PATH);
  await expect(panel).toContainText("workspaces[0].kind");
  await expect(page.locator(".workspace-sidebar")).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { __sigmaRepairLedger: () => void }).__sigmaRepairLedger();
  });
  await panel.getByRole("button", { name: "再読み込み" }).click();

  await expect(page.getByTestId("ledger-schema-failure")).toHaveCount(0);
  await expect(page.locator(".workspace-sidebar")).toBeVisible();
});
