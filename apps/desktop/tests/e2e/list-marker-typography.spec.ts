import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

/**
 * マーカー (`(1)` / `•`) は `li` の font を継ぐので、項目本文の run に指定した書体・大きさは
 * そのままでは届かない。ここで見たいのは **属性が出ていること** ではなく
 * `getComputedStyle(el, "::marker")` の実効値 — 属性一致だけを見ると、CSS 側が壊れて
 * マーカーが既定のままでもテストが緑になる。
 */

const EDITOR = ".page-flow .text-flow-editor";
const MINCHO_FONT_VALUE = '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, serif';

interface MarkerStyle {
  markerFamily: string;
  markerSize: string;
  runFamily: string | null;
  runSize: string | null;
  itemFamily: string;
  itemSize: string;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
});

async function openEditor(page: Page, document: SigmaDocument): Promise<void> {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(EDITOR).first()).toBeVisible();
}

/** 編集面の `li`。`data-sigma-doc-id` は内側の `p` に付くので、それを持つ `li` を選ぶ。 */
function editingItem(page: Page, id: string): Locator {
  return page.locator(`${EDITOR} li:has(> p[data-sigma-doc-id="${id}"])`).first();
}

/** 印刷プレビューのページ窓に切り出された `li`。 */
function printedItem(page: Page, id: string): Locator {
  return page.locator(`.paged-surface-page li:has(> p[data-sigma-doc-id="${id}"])`).first();
}

async function markerStyle(item: Locator): Promise<MarkerStyle> {
  return item.evaluate((element) => {
    const marker = getComputedStyle(element, "::marker");
    const own = getComputedStyle(element);
    const run = element.querySelector<HTMLElement>("[style*='font-family'], [style*='font-size']");
    const runStyle = run ? getComputedStyle(run) : null;
    return {
      markerFamily: marker.fontFamily,
      markerSize: marker.fontSize,
      runFamily: runStyle?.fontFamily ?? null,
      runSize: runStyle?.fontSize ?? null,
      itemFamily: own.fontFamily,
      itemSize: own.fontSize,
    };
  });
}

test("draws the marker in the typography of the item's first run", async ({ page }) => {
  await openEditor(page, listDocument());

  const styled = await markerStyle(editingItem(page, "li_styled"));

  expect(styled.runFamily).toBe(MINCHO_FONT_VALUE);
  expect(styled.markerFamily).toBe(styled.runFamily);
  expect(styled.markerSize).toBe(styled.runSize);
  // 既定と食い違っていて初めて意味のある比較になる。
  expect(styled.markerFamily).not.toBe(styled.itemFamily);
  expect(styled.markerSize).not.toBe(styled.itemSize);
});

test("follows a font family and size chosen from the toolbar", async ({ page }) => {
  await openEditor(page, listDocument());

  const item = editingItem(page, "li_plain");
  const before = await markerStyle(item);
  expect(before.markerFamily).toBe(before.itemFamily);

  // 初期状態は「設定値 = 既定」なので、必ずツールバーで既定と食い違わせてから測る。
  await item.click();
  await page.keyboard.press("Home");
  await page.keyboard.press("Shift+End");

  const fontSizeButton = page.getByLabel("フォントサイズ");
  await expect(fontSizeButton).toBeEnabled();
  await fontSizeButton.click();
  await page.getByRole("menu", { name: "フォントサイズ" }).getByRole("menuitemradio", { name: "18pt", exact: true }).click();

  const fontFamilyButton = page.locator(".toolbar-font-select");
  await expect(fontFamilyButton).toBeEnabled();
  await fontFamilyButton.click();
  await page.getByRole("searchbox", { name: "フォントを検索" }).fill("Hiragino Mincho");
  await page.getByRole("menuitemradio", { name: "Hiragino Mincho ProN", exact: true }).click();

  await expect.poll(async () => {
    const after = await markerStyle(editingItem(page, "li_plain"));
    return { family: after.markerFamily === after.runFamily, size: after.markerSize === after.runSize };
  }).toEqual({ family: true, size: true });

  const after = await markerStyle(editingItem(page, "li_plain"));
  expect(after.markerFamily).toBe(MINCHO_FONT_VALUE);
  expect(after.markerSize).toBe("24px");
});

test("leaves an unstyled item's marker on the body font", async ({ page }) => {
  await openEditor(page, listDocument());

  const plain = await markerStyle(editingItem(page, "li_plain"));

  expect(plain.runFamily).toBeNull();
  expect(plain.markerFamily).toBe(plain.itemFamily);
  expect(plain.markerSize).toBe(plain.itemSize);
});

test("does not let a styled item's font inherit into an unstyled nested item", async ({ page }) => {
  await openEditor(page, listDocument());

  const nested = await markerStyle(editingItem(page, "li_nested_plain"));
  const nestedSizeOnly = await markerStyle(editingItem(page, "li_nested_size"));
  const plain = await markerStyle(editingItem(page, "li_plain"));

  expect(nested.markerFamily).toBe(nested.itemFamily);
  expect(nested.markerFamily).toBe(plain.markerFamily);
  expect(nested.markerSize).toBe(nested.itemSize);

  // 大きさだけ指定した子には `::marker` のルールが適用されるので、カスタムプロパティのリセットが
  // 無いと `var(--…font-family, inherit)` が親の明朝を拾う。
  expect(nestedSizeOnly.markerSize).toBe(nestedSizeOnly.runSize);
  expect(nestedSizeOnly.markerFamily).toBe(plain.markerFamily);
});

test("takes only the size from a leading formula, never the family", async ({ page }) => {
  await openEditor(page, listDocument());

  const math = await markerStyle(editingItem(page, "li_math"));
  const plain = await markerStyle(editingItem(page, "li_plain"));

  // 数式は数式フォントで描かれるので、書体をマーカーへ移すと実描画と食い違う表示になる。
  expect(math.markerFamily).toBe(plain.markerFamily);
  expect(math.markerSize).toBe(math.runSize);
  expect(math.markerSize).not.toBe(math.itemSize);
});

test("applies the same rule to the static renderer used by print, PDF, and the viewer", async ({ page }) => {
  await openEditor(page, listDocument());

  // ヘッダーは `TextFlowStaticBlock` が直接描く。本文 (ProseMirror decoration) とは別実装なので、
  // ここを測らないと React 側の投影は markup の一致しか見ていないことになる。
  const styled = await markerStyle(page.locator('.page-running-region li[data-sigma-doc-id="header_li_styled"]').first());
  const plain = await markerStyle(page.locator('.page-running-region li[data-sigma-doc-id="header_li_plain"]').first());

  expect(styled.runFamily).toBe(MINCHO_FONT_VALUE);
  expect(styled.markerFamily).toBe(styled.runFamily);
  expect(styled.markerSize).toBe(styled.runSize);
  expect(styled.markerFamily).not.toBe(styled.itemFamily);
  expect(plain.markerFamily).toBe(plain.itemFamily);
  expect(plain.markerSize).toBe(plain.itemSize);
});

test("prints the same marker typography as the editing surface", async ({ page }) => {
  await openEditor(page, listDocument());
  const editing = await markerStyle(editingItem(page, "li_styled"));
  const editingPlain = await markerStyle(editingItem(page, "li_plain"));

  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await waitForPagedSurfaceSettled(page);

  // 印刷面は本文 DOM のページ切り出しなので、`data-sigma-doc-id` は編集面と同じく内側の `p` にある。
  const printedStyled = await markerStyle(printedItem(page, "li_styled"));
  const printedPlain = await markerStyle(printedItem(page, "li_plain"));

  expect(printedStyled.markerFamily).toBe(editing.markerFamily);
  expect(printedStyled.markerSize).toBe(editing.markerSize);
  expect(printedPlain.markerFamily).toBe(editingPlain.markerFamily);
  expect(printedPlain.markerSize).toBe(editingPlain.markerSize);
});

function listDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_list_marker_typography",
    metadata: { title: "マーカーの字体追従 E2E" },
    content: [{
      type: "list",
      id: "list_paren",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        {
          type: "listItem",
          id: "li_styled",
          children: [
            { type: "text", text: "明朝の項目", fontFamily: MINCHO_FONT_VALUE, fontSize: 18 },
            { type: "text", text: "つづき" },
          ],
          // 入れ子は必ず「書体を持つ項目の下」に置く。カスタムプロパティの継承を止めているかは
          // ここでしか見えない。とくに「大きさだけ指定した子」は属性が付くので `::marker` の
          // ルールが適用され、リセットが無いと親の明朝を var() から拾ってしまう。
          nested: [{
            type: "list",
            id: "list_nested",
            listType: "ordered",
            markerStyle: "paren",
            items: [
              { type: "listItem", id: "li_nested_plain", children: [{ type: "text", text: "入れ子" }] },
              {
                type: "listItem",
                id: "li_nested_size",
                children: [{ type: "text", text: "大きさだけ", fontSize: 18 }],
              },
            ],
          }],
        },
        {
          type: "listItem",
          id: "li_plain",
          children: [{ type: "text", text: "無印の項目" }],
        },
        {
          type: "listItem",
          id: "li_math",
          children: [
            { type: "mathInline", id: "m_1", tex: "x^2", display: "inline", fontSize: 18 },
            { type: "text", text: " の項目" },
          ],
        },
      ],
    }],
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 25, right: 15, bottom: 15, left: 15 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      // ヘッダーは本文と違い `TextFlowStaticBlock` (印刷 PDF・埋め込みビューア・サムネイルと
      // 同じ静的描画) がそのまま描く唯一のブラウザ経路。ここを測ると React 側の投影も
      // 実効値で押さえられる。
      header: {
        enabled: true,
        heightMm: 16,
        offsetMm: 5,
        showOnFirstPage: true,
        blocks: [{
          type: "list",
          id: "header_list",
          listType: "bullet",
          items: [
            {
              type: "listItem",
              id: "header_li_styled",
              children: [{ type: "text", text: "ヘッダー明朝", fontFamily: MINCHO_FONT_VALUE, fontSize: 18 }],
            },
            { type: "listItem", id: "header_li_plain", children: [{ type: "text", text: "ヘッダー無印" }] },
          ],
        }],
      },
    },
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  };
}
