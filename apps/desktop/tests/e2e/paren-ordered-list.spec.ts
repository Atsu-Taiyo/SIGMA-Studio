import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * `(1)` は SigmaDoc 上は普通の `listType: "ordered"` で、`markerStyle: "paren"` だけが違う。
 * 見たいのは「入力ルールで作られる / Enter で項目が増える / Tab で入れ子にしてもマーカーを継ぐ /
 * Undo・Redo で構造が戻る / 貼り付けでも同じ 1 つのリストになる」。番号そのものは `::marker` から
 * 読めないので、属性と適用された `list-style-type` で確認する。
 */

const EDITOR = ".page-flow .text-flow-editor";
const PAREN_LIST = `${EDITOR} ol[data-list-marker="paren"]`;

interface SavedList {
  listType?: string;
  markerStyle?: string | null;
  items: Array<{
    text: string;
    align?: string;
    continuations?: Array<{ text: string; align?: string }>;
    nested?: SavedList[];
  }>;
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

async function savedLists(page: Page): Promise<SavedList[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [];
    }
    interface RawList {
      type: string;
      listType?: string;
      markerStyle?: string;
      items?: Array<{
        children?: Array<{ text?: string }>;
        align?: string;
        continuations?: Array<{ children?: Array<{ text?: string }>; align?: string }>;
        nested?: RawList[];
      }>;
    }
    const summarize = (list: RawList): unknown => ({
      listType: list.listType,
      markerStyle: list.markerStyle ?? null,
      items: (list.items ?? []).map((item) => ({
        text: (item.children ?? []).map((child) => child.text ?? "").join(""),
        ...(item.align ? { align: item.align } : {}),
        ...(item.continuations ? {
          continuations: item.continuations.map((continuation) => ({
            text: (continuation.children ?? []).map((child) => child.text ?? "").join(""),
            ...(continuation.align ? { align: continuation.align } : {}),
          })),
        } : {}),
        ...(item.nested ? { nested: item.nested.map(summarize) } : {}),
      })),
    });
    const saved = JSON.parse(raw) as { content: RawList[] };
    return saved.content.filter((block) => block.type === "list").map(summarize);
  }) as Promise<SavedList[]>;
}

test("turns a typed (1) into a list whose marker is drawn as (1)", async ({ page }) => {
  await openEditor(page, documentWithParagraph());

  await page.locator('[data-sigma-doc-id="paren_list_target"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("(1) ");

  await expect(page.locator(PAREN_LIST)).toHaveCount(1);
  // 括弧そのものは ::marker なので、適用されたカウンタースタイルで見る。
  // 入力ルール直後はまだ再描画が走るので、要素は掴み直しながら待つ。
  await expect.poll(async () => page.locator(PAREN_LIST).first().evaluate((element) => (
    window.getComputedStyle(element).listStyleType
  ))).toBe("sigma-doc-paren-decimal");

  await expect.poll(async () => savedLists(page)).toEqual([
    { listType: "ordered", markerStyle: "paren", items: [{ text: "" }] },
  ]);
});

test("adds the next item on Enter and keeps it in the same paren list", async ({ page }) => {
  await openEditor(page, documentWithParenList());

  await page.locator('[data-sigma-doc-id="li_2"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");

  await expect(page.locator(`${PAREN_LIST} > li`)).toHaveCount(3);
  await expect(page.locator(PAREN_LIST)).toHaveCount(1);
  await expect.poll(async () => savedLists(page)).toEqual([{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち" }, { text: "に" }, { text: "" }],
  }]);
});

test("enables center alignment inside a (1) item and persists it", async ({ page }) => {
  await openEditor(page, documentWithParenList());

  await page.locator('[data-sigma-doc-id="li_1"]').first().click();
  const alignButton = page.getByRole("button", { name: /^文字揃え:/ });
  await expect(alignButton).toBeEnabled();
  await alignButton.click();
  await page.getByRole("menuitemradio", { name: "中央揃え", exact: true }).click();

  await expect(page.locator(`${PAREN_LIST} [data-sigma-doc-id="li_1"]`).first()).toHaveCSS("text-align", "center");
  await expect.poll(async () => savedLists(page)).toEqual([{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち", align: "center" }, { text: "に" }],
  }]);
});

test("aligns three paragraphs independently under one (1) marker", async ({ page }) => {
  await openEditor(page, documentWithParenList());

  const firstItem = page.locator(`${PAREN_LIST} > li`).first();
  await page.locator('[data-sigma-doc-id="li_1"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("中央の行");

  const alignButton = page.getByRole("button", { name: /^文字揃え:/ });
  await alignButton.click();
  await page.getByRole("menuitemradio", { name: "中央揃え", exact: true }).click();

  await page.keyboard.press("Shift+Enter");
  await page.keyboard.type("左の行");
  await alignButton.click();
  await page.getByRole("menuitemradio", { name: "左揃え", exact: true }).click();

  const paragraphs = firstItem.locator(":scope > p");
  await expect(paragraphs).toHaveCount(3);
  await expect(paragraphs.nth(0)).toHaveCSS("text-align", "start");
  await expect(paragraphs.nth(1)).toHaveCSS("text-align", "center");
  await expect(paragraphs.nth(2)).toHaveCSS("text-align", "left");
  await expect(page.locator(PAREN_LIST)).toHaveCount(1);

  await expect.poll(async () => savedLists(page)).toEqual([{
    listType: "ordered",
    markerStyle: "paren",
    items: [{
      text: "いち",
      continuations: [
        { text: "中央の行", align: "center" },
        { text: "左の行", align: "left" },
      ],
    }, { text: "に" }],
  }]);
});

test("keeps the marker style when Tab nests an item and Shift+Tab lifts it back", async ({ page }) => {
  await openEditor(page, documentWithParenList());

  await page.locator('[data-sigma-doc-id="li_2"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");

  // Tab が作る入れ子リストは既定属性なので、継承が無ければ `1.` に化ける。
  await expect(page.locator(`${PAREN_LIST} li ol[data-list-marker="paren"]`)).toHaveCount(1);
  const nested: SavedList[] = [{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち", nested: [{ listType: "ordered", markerStyle: "paren", items: [{ text: "に" }] }] }],
  }];
  await expect.poll(async () => savedLists(page)).toEqual(nested);

  await page.keyboard.press("Shift+Tab");
  await expect(page.locator(`${PAREN_LIST} li ol`)).toHaveCount(0);
  await expect.poll(async () => savedLists(page)).toEqual([{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち" }, { text: "に" }],
  }]);
});

test("restores the nested paren structure through Undo and Redo", async ({ page }) => {
  await openEditor(page, documentWithParenList());

  await page.locator('[data-sigma-doc-id="li_2"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Tab");
  const nested: SavedList[] = [{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち", nested: [{ listType: "ordered", markerStyle: "paren", items: [{ text: "に" }] }] }],
  }];
  const lifted: SavedList[] = [{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち" }, { text: "に" }],
  }];
  await expect.poll(async () => savedLists(page)).toEqual(nested);

  await page.keyboard.press("Shift+Tab");
  await expect.poll(async () => savedLists(page)).toEqual(lifted);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => savedLists(page)).toEqual(nested);
  await expect(page.locator(`${PAREN_LIST} li ol[data-list-marker="paren"]`)).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => savedLists(page)).toEqual(lifted);
});

test("reads a pasted (1) block as one paren-marked list", async ({ page }) => {
  await openEditor(page, documentWithParagraph());

  await page.locator('[data-sigma-doc-id="paren_list_target"]').first().click();
  await page.evaluate(() => {
    const target = document.activeElement?.closest(".text-flow-editor");
    if (!target) {
      throw new Error("Text flow editor is not focused");
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "(1) いち\n(2) に");
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });

  await expect(page.locator(`${PAREN_LIST} > li`)).toHaveText(["いち", "に"]);
  await expect.poll(async () => savedLists(page)).toEqual([{
    listType: "ordered",
    markerStyle: "paren",
    items: [{ text: "いち" }, { text: "に" }],
  }]);
});

function createDocument(content: SigmaDocument["content"]): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_paren_ordered_list",
    metadata: { title: "(1) 番号リスト E2E" },
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  };
}

function documentWithParagraph(): SigmaDocument {
  return createDocument([{
    type: "paragraph",
    id: "paren_list_target",
    children: [{ type: "text", text: "本文" }],
  }]);
}

function documentWithParenList(): SigmaDocument {
  return createDocument([{
    type: "list",
    id: "list_paren",
    listType: "ordered",
    markerStyle: "paren",
    items: [
      { type: "listItem", id: "li_1", children: [{ type: "text", text: "いち" }] },
      { type: "listItem", id: "li_2", children: [{ type: "text", text: "に" }] },
    ],
  }]);
}
