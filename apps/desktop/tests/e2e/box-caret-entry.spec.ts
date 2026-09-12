import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { LayoutSectionNode, ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 矢印キーが箱 (boxBlock)・n段組 (layoutSection)・ユニット境界を**直感的に**渡れることの固定。
 *
 * ネイティブのキャレット移動が動けない境界が 3 種類あり、どれも「押しても動かない」か
 * 「見えない場所・無関係な場所へ跳ぶ」になっていた:
 *
 * - CSS multicol (n段組) の外→中・中→外: Chromium のネイティブ移動は multicol の境界を
 *   水平に渡れない。
 * - ProseMirror doc の端 (ユニット境界・ページを跨ぐ箱の複製の端): ネイティブは doc の外へ
 *   出られない。複製の doc は箱 1 つしか持たないので、箱の最終行で ↓ / → が死んでいた。
 * - 隣のユニットの端が「ページを跨ぐ箱」の中: 面の順番タプルだけで行き先を選ぶと、箱より
 *   後ろの本文の末尾から ↓ で同じ箱の複製の頭へ逆戻りしていた。
 */

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function layoutSection(id: string, children: LayoutSectionNode["children"]): LayoutSectionNode {
  return {
    id,
    type: "layoutSection",
    layout: { columnCount: 2, columnGapMm: 8 },
    children,
  };
}

function createDocument(content: SigmaBlock[], smallPage = false): SigmaDocument {
  return {
    version: "2.0",
    docId: "box_caret_entry_e2e_doc",
    metadata: { title: "箱キャレット進入 E2E" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    ...(smallPage ? {
      pageLayout: {
        preset: "custom",
        orientation: "portrait",
        pageSize: { widthMm: 140, heightMm: 110 },
        marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
        flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      },
    } : {}),
  } as SigmaDocument;
}

/** DOM 選択のアンカーが載っているブロックの id と、複製面かどうか。 */
async function caretBlock(page: Page): Promise<{ blockId: string | null; inReplica: boolean }> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.anchorNode ?? null;
    const el = node
      ? (node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement)
      : null;
    return {
      blockId: el?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null,
      inReplica: Boolean(el?.closest(".editor-box-fragment-editor")),
    };
  });
}

async function expectCaretAt(page: Page, blockId: string): Promise<void> {
  await expect.poll(async () => (await caretBlock(page)).blockId, { timeout: 5_000 }).toBe(blockId);
}

/**
 * クリックできる方の描画を選ぶ。ページを跨ぐ箱の後半のブロックは、クリップされた正本 (上に
 * 複製レイヤーが被さっていてクリックを受けない) と複製の 2 回描かれるので、複製側を突く。
 */
async function clickableBlock(page: Page, blockId: string) {
  const replica = page.locator(`.editor-box-fragment-editor [data-sigma-doc-id="${blockId}"]`);
  if (await replica.count() > 0) {
    return replica.first();
  }
  return page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
}

/** 短い段落の中央クリックは行末に畳まれる。行頭に置きたいときは左端を突く。 */
async function clickAtLineStart(page: Page, blockId: string): Promise<void> {
  const block = await clickableBlock(page, blockId);
  await block.scrollIntoViewIfNeeded();
  await block.click({ position: { x: 4, y: 8 } });
  await expectCaretAt(page, blockId);
}

async function clickAtLineEnd(page: Page, blockId: string): Promise<void> {
  const block = await clickableBlock(page, blockId);
  await block.scrollIntoViewIfNeeded();
  await block.click();
  await expectCaretAt(page, blockId);
}

async function openDocument(page: Page, document: SigmaDocument): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 960 });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await page.locator(".page-flow [data-sigma-doc-id]").first().waitFor({ state: "visible" });
}

test("矢印キーで箱のタイトルと本文へ入り、また出られる", async ({ page }) => {
  const box = createBoxBlock("fancybox", "題名", { id: "entry_box", bodyId: "entry_box_body" });
  box.blocks = [
    paragraph("entry_box_body", "箱の一段落目"),
    paragraph("entry_box_body2", "箱の二段落目"),
  ];
  await openDocument(page, createDocument([
    paragraph("entry_before", "前の本文"),
    box,
    paragraph("entry_after", "後の本文"),
  ]));

  // → 連打: 前の本文の末尾 → タイトル → (タイトルを通って) 本文。
  await clickAtLineEnd(page, "entry_before");
  await page.keyboard.press("ArrowRight");
  await expectCaretAt(page, "entry_box");
  for (let index = 0; index < 3; index += 1) {
    await page.keyboard.press("ArrowRight");
  }
  await expectCaretAt(page, "entry_box_body");

  // ↓ で箱を通り抜けて後の本文まで。
  await clickAtLineEnd(page, "entry_before");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "entry_box");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "entry_box_body");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "entry_box_body2");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "entry_after");

  // ← で後の本文の先頭から箱の末尾へ。
  await clickAtLineStart(page, "entry_after");
  await page.keyboard.press("ArrowLeft");
  await expectCaretAt(page, "entry_box_body2");
});

test("ページを跨ぐ箱を ↓ で通り抜け、端で迷子にならない", async ({ page }) => {
  const box = createBoxBlock("fancybox", "題名", { id: "cross_box", bodyId: "cross_box_1" });
  box.blocks = Array.from({ length: 14 }, (_, index) => (
    paragraph(`cross_box_${index + 1}`, `枠の中の本文 ${index + 1} 行目`)
  ));
  await openDocument(page, createDocument([
    paragraph("cross_before", "前の本文"),
    box,
    paragraph("cross_after", "後の本文"),
  ], true));
  await expect.poll(() => page.locator(".editor-box-fragment-viewport").count()).toBeGreaterThan(0);

  // ↓ 連打で前の本文からタイトル・箱の全段落 (ページ境界を跨いで複製へ) を通り、後の本文へ。
  await clickAtLineStart(page, "cross_before");
  const visited: string[] = [];
  for (let index = 0; index < 17 && visited.at(-1) !== "cross_after"; index += 1) {
    await page.keyboard.press("ArrowDown");
    await expect.poll(async () => (await caretBlock(page)).blockId).not.toBe(visited.at(-1) ?? "cross_before");
    const current = await caretBlock(page);
    visited.push(current.blockId ?? "none");
  }
  expect(visited).toContain("cross_box_1");
  expect(visited).toContain("cross_box_14");
  expect(visited.at(-1)).toBe("cross_after");
  // ページ 2 に入った位置 (箱の後半) は複製面が見せている。
  await clickAtLineEnd(page, "cross_box_14");
  expect((await caretBlock(page)).inReplica).toBe(true);

  // 複製の末尾からの ↓ / → はブロックの外 (後の本文) へ出る。以前はここで迷子になっていた。
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "cross_after");
  await clickAtLineEnd(page, "cross_box_14");
  await page.keyboard.press("ArrowRight");
  await expectCaretAt(page, "cross_after");

  // 後の本文の末尾から ↓ を押しても、同じ箱の複製の頭へ**逆戻りしない**。
  await clickAtLineEnd(page, "cross_after");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "cross_after");

  // ← で後の本文から複製 (箱の最終行) へ戻れる。
  await clickAtLineStart(page, "cross_after");
  await page.keyboard.press("ArrowLeft");
  await expectCaretAt(page, "cross_box_14");
  expect((await caretBlock(page)).inReplica).toBe(true);
});

test("矢印キーで n 段組の中へ入り、また出られる", async ({ page }) => {
  await openDocument(page, createDocument([
    paragraph("col_before", "前の本文"),
    layoutSection("col_section", [
      paragraph("col_first", "一段目の本文"),
      paragraph("col_second", "二段目の本文"),
    ]),
    paragraph("col_after", "後の本文"),
  ]));

  // → で前の本文の末尾から一段目の先頭へ (Chromium のネイティブ移動は multicol へ入れない)。
  await clickAtLineEnd(page, "col_before");
  await page.keyboard.press("ArrowRight");
  await expectCaretAt(page, "col_first");

  // ← で後の本文の先頭から二段目の末尾へ。
  await clickAtLineStart(page, "col_after");
  await page.keyboard.press("ArrowLeft");
  await expectCaretAt(page, "col_second");

  // → で二段目の末尾から後の本文へ出る。
  await clickAtLineEnd(page, "col_second");
  await page.keyboard.press("ArrowRight");
  await expectCaretAt(page, "col_after");

  // ↓ で外→一段目→二段目→外 (段を跨ぐネイティブ ↓ は PM の選択が古いまま残ることがある)。
  await clickAtLineStart(page, "col_before");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "col_first");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "col_second");
  await page.keyboard.press("ArrowDown");
  await expectCaretAt(page, "col_after");
});

test("ユニット境界 (本文チャンクの切れ目) を ← / → で渡れる", async ({ page }) => {
  const fillers = Array.from({ length: 90 }, (_, index) => (
    paragraph(`unit_fill_${index + 1}`, `本文 ${index + 1}`)
  ));
  await openDocument(page, createDocument(fillers));
  // 90 段落は 40 + 40 + 10 の 3 ユニットに切られる。
  await expect.poll(() => page.evaluate(() => (
    document.querySelectorAll("[data-flow-unit-id]").length
  ))).toBeGreaterThan(1);

  // → でユニット 1 の末尾からユニット 2 の先頭へ。
  await clickAtLineEnd(page, "unit_fill_40");
  await page.keyboard.press("ArrowRight");
  await expectCaretAt(page, "unit_fill_41");

  // ← でユニット 2 の先頭からユニット 1 の末尾へ。
  await clickAtLineStart(page, "unit_fill_41");
  await page.keyboard.press("ArrowLeft");
  await expectCaretAt(page, "unit_fill_40");
});
