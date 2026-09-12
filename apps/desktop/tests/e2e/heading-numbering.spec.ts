import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_heading_numbering_check",
    metadata: { title: "見出し採番検収" },
    content: [
      { type: "heading", id: "h1_a", level: 1, children: [{ type: "text", text: "行列式" }] },
      { type: "paragraph", id: "p_a", children: [{ type: "text", text: "行列式の定義と性質を扱う。" }] },
      { type: "heading", id: "h2_a", level: 2, children: [{ type: "text", text: "余因子展開" }] },
      { type: "heading", id: "h3_a", level: 3, children: [{ type: "text", text: "計算例" }] },
      { type: "heading", id: "h2_b", level: 2, children: [{ type: "text", text: "基本性質" }] },
      { type: "heading", id: "h1_b", level: 1, children: [{ type: "text", text: "固有値と固有ベクトル" }] },
      { type: "paragraph", id: "slash_target", children: [] },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  };
}

async function openPageSettings(page: Page): Promise<void> {
  let button = page.getByRole("button", { name: "ページ設定" }).first();
  if (!(await button.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "設定", exact: true }).click();
    button = page.getByRole("menuitem", { name: /ページ設定/ }).first()
      .or(page.getByRole("button", { name: /ページ設定/ }).first());
  }
  await expect(button).toBeVisible();
  await button.click();
  await expect(page.getByRole("dialog", { name: "ページ設定" })).toBeVisible();
}

async function applyPageSettings(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: "ページ設定" }).getByRole("button", { name: "適用" }).click();
  await expect(page.getByRole("dialog", { name: "ページ設定" })).toBeHidden();
}

function editorPrefixes(page: Page) {
  return page.locator(".page-flow .text-flow-editor .heading-number-prefix");
}

test("見出し自動採番の一連の操作", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(".page-flow .text-flow-editor h1").first()).toBeVisible();

  // 初期状態では、採番は未設定なので番号を表示しない。
  await expect(editorPrefixes(page)).toHaveCount(0);

  // ページ設定から「見出し番号」を ON にする。
  await openPageSettings(page);
  const dialog = page.getByRole("dialog", { name: "ページ設定" });
  await dialog.locator("#page-settings-heading-numbering").scrollIntoViewIfNeeded();
  await dialog.getByRole("switch", { name: "見出し番号を表示" }).click();
  await applyPageSettings(page);

  // 見出し階層に応じて 1 / 1.1 / 1.1.1 / 1.2 / 2 を表示する。
  await expect(editorPrefixes(page)).toHaveCount(5);
  await expect
    .poll(async () =>
      editorPrefixes(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number"))),
    )
    .toEqual(["1", "1.1", "1.1.1", "1.2", "2"]);

  // 表示用の番号は保存 JSON の見出し文字列に焼き込まない。
  const savedTexts = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const saved = JSON.parse(raw) as { content: Array<{ type: string; children?: Array<{ text?: string }> }> };
    return saved.content
      .filter((block) => block.type === "heading")
      .map((block) => (block.children ?? []).map((child) => child.text ?? "").join(""));
  });
  if (savedTexts !== null) {
    for (const text of savedTexts) {
      expect(text).not.toMatch(/^[§0-9第]/);
    }
  }

  // スラッシュコマンドで見出し2を挿入すると 2.1 が付く。
  const target = page.locator('[data-sigma-doc-id="slash_target"]').first();
  await target.click();
  await page.keyboard.type("/");
  await expect(page.getByRole("listbox", { name: "挿入候補" })).toBeVisible();
  await page.keyboard.type("見出し2");
  await page.getByRole("option", { name: /見出し2/ }).first().click();
  await page.keyboard.type("対角化");
  await expect(editorPrefixes(page)).toHaveCount(6);
  await expect
    .poll(async () =>
      editorPrefixes(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number"))),
    )
    .toEqual(["1", "1.1", "1.1.1", "1.2", "2", "2.1"]);

  // 書式プリセットを「第1章 / 1.1」へ変更する。
  await openPageSettings(page);
  await dialog.locator("#page-settings-heading-numbering").scrollIntoViewIfNeeded();
  await dialog.getByRole("combobox", { name: "書式" }).click();
  await page.getByRole("option", { name: "第1章 / 1.1" }).click();
  await applyPageSettings(page);
  await expect
    .poll(async () =>
      editorPrefixes(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number"))),
    )
    .toEqual(["第1章", "1.1", "1.1.1", "1.2", "第2章", "2.1"]);

  // 番号を付ける深さを「H1のみ」に絞る。
  await openPageSettings(page);
  await dialog.locator("#page-settings-heading-numbering").scrollIntoViewIfNeeded();
  await dialog.getByRole("combobox", { name: "番号を付ける深さ" }).click();
  await page.getByRole("option", { name: "H1のみ" }).click();
  await applyPageSettings(page);
  await expect
    .poll(async () =>
      editorPrefixes(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number"))),
    )
    .toEqual(["第1章", "第2章"]);

  // OFF に戻すとすべての番号が消える。
  await openPageSettings(page);
  await dialog.locator("#page-settings-heading-numbering").scrollIntoViewIfNeeded();
  await dialog.getByRole("switch", { name: "見出し番号を表示" }).click();
  await applyPageSettings(page);
  await expect(editorPrefixes(page)).toHaveCount(0);
});

test("アウトラインと印刷プレビューにも同じ番号が出る", async ({ page }) => {
  const doc = createDocument();
  doc.metadata.headingNumbering = { enabled: true, style: "decimal", depth: 3 };
  await installDesktopRuntimeMock(page, doc);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(editorPrefixes(page)).toHaveCount(5);

  // アウトラインにも同じ番号を表示する。
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: "アウトラインを表示" }).click();
  const outline = page.getByRole("complementary", { name: "アウトライン" })
    .or(page.locator('[class*="outline"]').filter({ hasText: "行列式" }).first());
  await expect(outline.getByText(/1\.1\s*余因子展開|1\.1 余因子展開/).first()).toBeVisible();

  // 印刷プレビューにも同じ番号を表示する。
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  const sheet = page.locator(".paged-surface-page-slot .a4-page-sheet").first();
  await expect(sheet).toBeVisible({ timeout: 20_000 });
  await expect
    .poll(async () =>
      page
        .locator(".paged-surface-page-slot .heading-number-prefix")
        .evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number") ?? el.textContent?.trim())),
    )
    .toEqual(["1", "1.1", "1.1.1", "1.2", "2"]);
});

test("採番未設定の文書でスラッシュ見出しを使うと自動でONになる", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(editorPrefixes(page)).toHaveCount(0);

  const target = page.locator('[data-sigma-doc-id="slash_target"]').first();
  await target.click();
  await page.keyboard.type("/見出し2");
  await page.getByRole("option", { name: /見出し2/ }).first().click();
  await page.keyboard.type("追加の節");

  // 変換した見出しだけでなく、既存見出しにも番号が付く（自動 ON）。
  await expect(editorPrefixes(page)).toHaveCount(6);
  await expect
    .poll(async () =>
      editorPrefixes(page).evaluateAll((els) => els.map((el) => el.getAttribute("data-heading-number"))),
    )
    .toEqual(["1", "1.1", "1.1.1", "1.2", "2", "2.1"]);
});

test("明示的にOFFの文書ではスラッシュ見出しでも番号は出ない", async ({ page }) => {
  const doc = createDocument();
  doc.metadata.headingNumbering = { enabled: false };
  await installDesktopRuntimeMock(page, doc);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const target = page.locator('[data-sigma-doc-id="slash_target"]').first();
  await target.click();
  await page.keyboard.type("/見出し1");
  await page.getByRole("option", { name: /見出し1/ }).first().click();
  await page.keyboard.type("番号なしの見出し");

  await expect(page.locator(".page-flow .text-flow-editor h1").filter({ hasText: "番号なしの見出し" })).toBeVisible();
  await expect(editorPrefixes(page)).toHaveCount(0);
});
