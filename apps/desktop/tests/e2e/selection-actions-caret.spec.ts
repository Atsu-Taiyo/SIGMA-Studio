import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 「AIに依頼」「コメント」の浮かぶ操作は、何かを選んでいるときだけ出す。
 * 本文にカーソルを置いただけでは帯もチップも出さない (常に画面に浮かんで邪魔になる)。
 * 文字の範囲は書式の帯、数式やブロックを丸ごと選んだときは今までどおり。
 */

const popover = (page: Page) => page.locator(".selection-action-popover");
const aiButton = (page: Page) => popover(page).getByRole("button", { name: "AIに追加" });
const commentButton = (page: Page) => popover(page).getByRole("button", { name: "コメントを追加", exact: true });

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_selection_actions_caret";
  document.metadata = { title: "選択の操作 e2e" };
  document.comments = [];
  document.content = [
    paragraph("p_text", "最初の段落です。選ぶ言葉があります。"),
    {
      type: "paragraph",
      id: "p_math",
      children: [
        { type: "text", text: "式 " },
        { type: "mathInline", id: "m_1", tex: "x^2+1", display: "inline" },
        { type: "text", text: " の値を求めなさい。" },
      ],
    },
    {
      type: "list",
      id: "list_1",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "リストの項目 一" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "リストの項目 二" }] },
      ],
    },
    {
      type: "boxBlock",
      id: "box_1",
      styleId: "fancybox",
      blocks: [paragraph("p_box_1", "箱の中の段落です。")],
    },
    {
      id: "problem_1",
      type: "problem",
      tags: [],
      lead: [],
      prompt: [paragraph("p_prompt", "問題文の段落です。")],
      hints: [],
      solution: [paragraph("p_solution", "解答の段落です。")],
      answer: { type: "math", expected: "2" },
      numbering: { value: 1 },
    },
    paragraph("p_z", "最後の段落です。"),
  ] as SigmaDocument["content"];
  return document;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
  await page.setViewportSize({ width: 1500, height: 950 });
  await installDesktopRuntimeMock(page, createDocument(), { ai: { enabled: true } });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_z"]')).toBeVisible();
});

function block(page: Page, id: string): Locator {
  return page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
}

/** カーソルが `id` のブロックの中に、範囲なしで置かれている。 */
async function caretIn(page: Page, id: string): Promise<boolean> {
  return page.evaluate((blockId) => {
    const selection = window.getSelection();
    const owner = selection?.anchorNode instanceof Node
      ? (selection.anchorNode instanceof Element ? selection.anchorNode : selection.anchorNode.parentElement)?.closest("[data-sigma-doc-id]")
      : null;
    return Boolean(selection?.isCollapsed && owner?.getAttribute("data-sigma-doc-id") === blockId);
  }, id);
}

/** 選択の操作は 120ms のデバウンス後に描く。出ない側の検証が空振りしないよう、十分に待つ。 */
async function settle(page: Page) {
  await page.waitForTimeout(500);
}

async function clickIntoText(page: Page, id: string, side: "left" | "right" = "left") {
  const target = block(page, id);
  await expect(target).toBeVisible();
  const box = (await target.boundingBox())!;
  const x = side === "left" ? box.x + Math.min(30, box.width / 2) : box.x + box.width - 30;
  await page.mouse.click(x, box.y + Math.min(box.height / 2, 12));
  await expect.poll(() => caretIn(page, id)).toBe(true);
  await settle(page);
}

test("a caret alone floats nothing, a text range shows the band, collapsing hides it again", async ({ page }) => {
  await clickIntoText(page, "p_text");
  await expect(popover(page)).toHaveCount(0);

  // 言葉を選ぶと、書式の帯に AI とコメントが並ぶ (右下の別のチップには分けない)。
  await block(page, "p_text").dblclick({ position: { x: 90, y: 10 } });
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");
  await expect(aiButton(page)).toBeVisible();
  await expect(commentButton(page)).toBeVisible();
  await expect(page.locator(".selection-action-popover--trailing")).toHaveCount(0);
  await expect(popover(page).getByRole("button", { name: "太字" })).toBeVisible();

  // 選択を解いてカーソルに戻すと、同じ段落のまま何も浮かべない。
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => caretIn(page, "p_text")).toBe(true);
  await settle(page);
  await expect(popover(page)).toHaveCount(0);

  // 別の段落にカーソルを移しても同じ。
  await clickIntoText(page, "p_z");
  await expect(popover(page)).toHaveCount(0);
});

test("a caret in a list item, a box or a problem floats nothing", async ({ page }) => {
  for (const id of ["li_2", "p_box_1", "p_prompt", "p_solution"]) {
    await clickIntoText(page, id);
    await expect(popover(page), `caret in ${id}`).toHaveCount(0);
  }
});

test("moving focus away from the caret (ribbon field, typing) does not float anything", async ({ page }) => {
  await clickIntoText(page, "p_text");
  await page.keyboard.type("あ");
  await settle(page);
  await expect(popover(page)).toHaveCount(0);

  // 本文を離れてリボンの入力欄を触っても、カーソルを置いただけの状態は変わらない。
  await page.getByRole("textbox", { name: "フォントサイズ", exact: true }).click();
  await settle(page);
  await expect(popover(page)).toHaveCount(0);
});

test("selected inline math keeps AI and comment actions", async ({ page }) => {
  const math = page.locator('.text-flow-editor .inline-math-node[data-id="m_1"]');
  await expect(math).toBeVisible();
  await math.click();
  await expect(math).toHaveClass(/editing/);
  await expect(aiButton(page)).toBeVisible();
  await expect(commentButton(page)).toBeVisible();
});

test("a block picked with its handle keeps the chip, and clicking into its text drops it", async ({ page }) => {
  await clickIntoText(page, "p_text");
  await expect(popover(page)).toHaveCount(0);

  // カーソルのあるブロックを、つまみで選び直す: 選んだブロックは同じだが、今度は丸ごと選んでいる。
  const target = block(page, "p_text");
  const handle = page.locator('.page-block-handle[data-block-id="p_text"]');
  const box = (await target.boundingBox())!;
  let wiggle = 0;
  await expect.poll(async () => {
    await page.mouse.move(box.x + box.width / 2 + (wiggle % 3), box.y + box.height / 2 + (wiggle % 2));
    wiggle += 1;
    return handle.isVisible();
  }, { timeout: 10_000, intervals: [100, 200, 300] }).toBe(true);
  await handle.click();
  await expect(page.locator(".selection-action-popover--trailing")).toBeVisible();
  await expect(aiButton(page)).toBeVisible();
  await expect(commentButton(page)).toBeVisible();

  // 本文をクリックすればカーソルだけの状態に戻り、チップは消える (つまみのメニューは左側に開くので右端を押す)。
  await clickIntoText(page, "p_text", "right");
  await expect(popover(page)).toHaveCount(0);
});
