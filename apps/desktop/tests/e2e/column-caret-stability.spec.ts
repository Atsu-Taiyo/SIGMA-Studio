import { expect, test, type Page } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 2段組の本文の途中 (2ページ目) で挿入系の操作をしたとき、
 * - 紙面 (カメラ) が文書先頭へ吹っ飛ばないこと
 * - キャレットが挿入した場所に残り、画面内に見えていること
 * を検査する。
 *
 * 根っこは 2 つ: 段組では編集面 root の矩形が潰れるため「root 矩形へクランプした座標解決」が
 * 文書先頭に化けること、挿入直後のブロックは段組配置 (decoration) が付くまで潰れた root の
 * 原点に居るため、そこへスクロールが追従すること。
 */

test.describe("two-column caret stability", () => {
  test("clicking a mid-document paragraph keeps the camera still", async ({ page }) => {
    const { scrollBefore } = await openAndClickTrigger(page);
    await page.waitForTimeout(800);
    const state = await readState(page);
    expect(state.caretBlock).toBe("trigger");
    expect(Math.abs(state.scrollTop - scrollBefore)).toBeLessThan(200);
  });

  test("inserting a box from the slash palette keeps caret and camera in place", async ({ page }) => {
    const { scrollBefore } = await openAndClickTrigger(page);
    const range = await withScrollRange(page, async () => {
      await page.keyboard.type("/titlebox");
      await expect(page.locator(".slash-command-popover")).toContainText("titlebox");
      await page.keyboard.press("Enter");
      await expect(page.locator(".slash-command-popover")).toHaveCount(0);
      await page.waitForTimeout(1500);
    });
    expect(Math.abs(range.min - scrollBefore)).toBeLessThan(300);
    expect(Math.abs(range.max - scrollBefore)).toBeLessThan(300);

    const state = await readState(page);
    expect(state.caretInBox).toBe(true);
    expect(state.caretClientTop).toBeGreaterThan(0);
    expect(state.caretClientTop).toBeLessThan(900);
  });

  test("inserting a quote container keeps caret and camera in place", async ({ page }) => {
    const { scrollBefore } = await openAndClickTrigger(page);
    const range = await withScrollRange(page, async () => {
      await page.keyboard.type("/引用");
      await expect(page.locator(".slash-command-popover")).toContainText("引用");
      await page.keyboard.press("Enter");
      await expect(page.locator(".slash-command-popover")).toHaveCount(0);
      await page.waitForTimeout(1500);
    });
    expect(Math.abs(range.min - scrollBefore)).toBeLessThan(300);
    expect(Math.abs(range.max - scrollBefore)).toBeLessThan(300);

    const state = await readState(page);
    expect(state.caretInQuote).toBe(true);
    expect(state.caretClientTop).toBeGreaterThan(0);
    expect(state.caretClientTop).toBeLessThan(900);
  });

  test("pressing Enter mid-document keeps caret and camera in place", async ({ page }) => {
    const { scrollBefore } = await openAndClickTrigger(page);
    const range = await withScrollRange(page, async () => {
      await page.keyboard.type("あ");
      await page.keyboard.press("Enter");
      await page.keyboard.type("い");
      await page.waitForTimeout(1200);
    });
    expect(Math.abs(range.min - scrollBefore)).toBeLessThan(300);
    expect(Math.abs(range.max - scrollBefore)).toBeLessThan(300);

    const state = await readState(page);
    expect(state.caretClientTop).toBeGreaterThan(0);
    expect(state.caretClientTop).toBeLessThan(900);
    const typed = await page.evaluate(() => {
      const sel = window.getSelection();
      const node = sel?.anchorNode ?? null;
      const element = node instanceof Element ? node : node?.parentElement ?? null;
      return element?.closest("[data-sigma-doc-id]")?.textContent ?? "";
    });
    expect(typed).toContain("い");
  });
});

async function openAndClickTrigger(page: Page): Promise<{ scrollBefore: number }> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createLongTwoColumnDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);
  await page.waitForTimeout(2000);

  const target = page.locator('.page-flow [data-sigma-doc-id="trigger"]').first();
  await target.scrollIntoViewIfNeeded();
  await page.waitForTimeout(600);
  await target.click();
  await page.waitForTimeout(600);
  const scrollBefore = await page.evaluate(() => (
    Math.round(document.querySelector<HTMLElement>(".editor-canvas")?.scrollTop ?? -1)
  ));
  return { scrollBefore };
}

/** 操作中の .editor-canvas scrollTop の範囲を rAF サンプリングで記録する。 */
async function withScrollRange(page: Page, action: () => Promise<void>): Promise<{ min: number; max: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __scrollRange: { min: number; max: number }; __stopRange: boolean };
    const canvas = document.querySelector<HTMLElement>(".editor-canvas");
    const current = canvas?.scrollTop ?? 0;
    w.__scrollRange = { min: current, max: current };
    w.__stopRange = false;
    const tick = () => {
      const value = canvas?.scrollTop ?? 0;
      w.__scrollRange.min = Math.min(w.__scrollRange.min, value);
      w.__scrollRange.max = Math.max(w.__scrollRange.max, value);
      if (!w.__stopRange) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  });
  await action();
  return page.evaluate(() => {
    const w = window as unknown as { __scrollRange: { min: number; max: number }; __stopRange: boolean };
    w.__stopRange = true;
    return { min: Math.round(w.__scrollRange.min), max: Math.round(w.__scrollRange.max) };
  });
}

async function readState(page: Page): Promise<{
  scrollTop: number;
  caretBlock: string | null;
  caretClientTop: number;
  caretInBox: boolean;
  caretInQuote: boolean;
}> {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".editor-canvas");
    const sel = window.getSelection();
    const node = sel?.anchorNode ?? null;
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    const block = element?.closest<HTMLElement>("[data-sigma-doc-id]") ?? null;
    let caretClientTop = -1;
    if (sel && sel.rangeCount > 0) {
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      caretClientTop = rect.top !== 0 || rect.height !== 0
        ? Math.round(rect.top)
        : Math.round(block?.getBoundingClientRect().top ?? -1);
    }
    return {
      scrollTop: Math.round(canvas?.scrollTop ?? -1),
      caretBlock: block?.dataset.sigmaDocId ?? null,
      caretClientTop,
      caretInBox: Boolean(element?.closest(".sigma-doc-box-block")),
      caretInQuote: Boolean(element?.closest("blockquote")),
    };
  });
}

function createLongTwoColumnDocument(): SigmaDocument {
  const content: SigmaBlock[] = [];
  for (let index = 0; index < 28; index += 1) {
    content.push(paragraph(`p_${index}`, `本文の段落 ${index} — 二段組の紙面を埋めるためのテキストです。行送りを稼ぐためにある程度の長さを持たせています。`));
  }
  content.push(paragraph("trigger", ""));
  for (let index = 28; index < 44; index += 1) {
    content.push(paragraph(`p_${index}`, `後続の段落 ${index} — 挿入位置より後ろの本文。`));
  }
  const document: SigmaDocument = {
    version: "2.0",
    docId: "repro_caret_jump_doc",
    metadata: { title: "キャレットジャンプ再現" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = { type: "columns", columnCount: 2, columnGapMm: 8 };
  document.pageLayout = pageLayout;
  return document;
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
