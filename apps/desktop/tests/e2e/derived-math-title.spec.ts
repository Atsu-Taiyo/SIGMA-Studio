import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

// タイトル未入力の教材は本文の先頭行から導出される。以前はその先頭行を `$tex$` の文字列へ
// 潰してから表示側で読み直していたので、上限 (160 文字) の切り出しが `$…$` の対を割ると
// 閉じ `$` が消え、画面には `$\sum…` という生ソースが出ていた (ユーザー報告そのもの)。
// 導出側はノード列のまま渡すので、上限を超える数式でもタイトルは数式として描かれる。
const TITLE_MATH_TEX = `\\sum_{k=1}^{n} k = \\frac{n(n+1)}{2} \\quad ${"a + ".repeat(40)}b`;
const DERIVED_TITLE = `次の和を求めよ $${TITLE_MATH_TEX}$`;

test("derives a math title from the first body line", async ({ page }) => {
  expect(TITLE_MATH_TEX.length).toBeGreaterThan(160);

  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDerivedMathTitleDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  // タイトル欄とタブの両方で数式として描かれる (生ソースのままではない)。
  await expect(page.locator(".document-title-rich-overlay .math-preview-inline")).toBeVisible();
  await expect(page.locator(".document-tab-main .math-preview-inline").first()).toBeVisible();
  await expect(page.locator(".document-title-rich-overlay")).not.toContainText("$");

  // 描画のために保存値を書き換えない。入力欄は導出結果の生の文字列 (`$…$` 付き) を持ち続ける。
  await expect(page.getByLabel("教材タイトル")).toHaveValue(DERIVED_TITLE);

  // フォーカス中はリッチ表示を降ろす (IME と選択を邪魔しないため)。
  await page.getByLabel("教材タイトル").click();
  await expect(page.locator(".document-title-rich-overlay")).toHaveCount(0);
});

// 本文に素の `$` があると、文字列へ潰した瞬間に区切りの位置が分からなくなる。
// 「価格 $100 の教材 $x^2$ を解け」を読み直すと `100 の教材` が数式候補になり、
// 散文ガードに引っかかってタイトル全体が生表示に落ちる。ノード列なら曖昧さが無い。
test("keeps a lone $ in the body out of the derived title's math", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createLoneDollarTitleDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  const overlay = page.locator(".document-title-rich-overlay");
  await expect(overlay.locator(".math-preview-inline")).toHaveCount(1);
  await expect(overlay).toContainText("価格 $100 の教材");
  await expect(overlay).toContainText("を解け");
  await expect(page.getByLabel("教材タイトル")).toHaveValue("価格 $100 の教材 $x^2$ を解け");
});

function createDerivedMathTitleDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "derived_math_title_doc",
    metadata: { title: "" },
    content: [
      {
        type: "paragraph",
        id: "p_derived_title",
        children: [
          { type: "text", text: "次の和を求めよ " },
          { type: "mathInline", id: "m_derived_title", tex: TITLE_MATH_TEX, display: "inline" },
        ],
      },
    ],
    outputProfiles: {
      student: {},
      teacher: { showSolutions: true, showHints: true },
      answerBook: { includeAnswers: true, onlySolutions: true },
    },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

function createLoneDollarTitleDocument(): SigmaDocument {
  return {
    ...createDerivedMathTitleDocument(),
    docId: "lone_dollar_title_doc",
    content: [
      {
        type: "paragraph",
        id: "p_lone_dollar_title",
        children: [
          { type: "text", text: "価格 $100 の教材 " },
          { type: "mathInline", id: "m_lone_dollar_title", tex: "x^2", display: "inline" },
          { type: "text", text: " を解け" },
        ],
      },
    ],
  };
}
