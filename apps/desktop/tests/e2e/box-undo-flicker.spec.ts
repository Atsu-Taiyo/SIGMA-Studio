import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * Undo/Redo は「ProseMirror の内容差し替え」と「レイアウト計測」が同じコミットで揃っていなければ
 * ならない。
 *
 * 揃っていなかった頃の症状: `PageCanvasEditor` は `historyRevision` の変化を見て paint 前に同期
 * `recompute()` を走らせるのに、`TextFlowEditor` の内容差し替えだけが `setTimeout(0)` に乗って
 * いたため、**Undo 前の DOM を測った高さ**が枠のクリップ
 * (`--text-flow-box-fragment-visible-height`) と枠フラグメントの高さに入り、1〜数フレームだけ
 * 「本文全体が枠の中に入った」ように見えた。
 *
 * ここでは `requestAnimationFrame` ごとに「枠の中に実際に何行あるか (DOM の真実)」と
 * 「枠の実寸・枠の外の本文の位置 (レイアウトの真実)」を**同じフレームで対にして**記録し、
 * その対が食い違うフレームが 1 枚も無いことを見る。中間値の有無ではなく対の整合を見るのは、
 * 状態が 2 つしかない遷移では「古い計測」が「もう一方の正しい値」と区別できないため。
 *
 * 編集はキーストロークではなく右クリックメニューで起こす — 初期レイアウト直後のキー入力は別系統の
 * 既存レース (learnings 参照) で取りこぼされることがあり、それを踏むと測りたいものを測れない。
 *
 * 修正前のビルドでは「枠の削除を Undo したとき」と「段組みページの Undo」の 2 本が毎回落ちる
 * (計測順序が逆転したフレームがそのまま観測される)。修正後は 3 回連続実行で 15/15 通る。
 */

const BOX_ID = "undo_flicker_box";
const OUTSIDE_ID = "undo_flicker_after";
/**
 * ページ境界をまたいだ枠は 1 ページ目に「クリップされた本体」として描かれる。ちらつくのはこの
 * クリップなので、ここを測る。
 */
const BOX_SELECTOR = `.page-flow .text-flow-box-fragment-source[data-sigma-doc-id="${BOX_ID}"]`;
const OUTSIDE_SELECTOR = `.page-flow [data-sigma-doc-id="${OUTSIDE_ID}"]`;

/** 14 行 × 110mm ページ = 枠がページ境界をまたぐ (= フラグメント分割が起きる) 構成。 */
function boxDocument(columnCount = 1, lineCount = 14, pageHeightMm = 110): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: BOX_ID, bodyId: "undo_flicker_box_1" });
  box.blocks = Array.from({ length: lineCount }, (_, index) => ({
    type: "paragraph" as const,
    id: `undo_flicker_box_${index + 1}`,
    children: [{ type: "text" as const, text: `枠の中の本文 ${index + 1} 行目` }],
  }));
  return {
    version: "2.0",
    docId: "doc_box_undo_flicker",
    metadata: { title: "枠付き本文のUndo" },
    content: [
      {
        type: "paragraph",
        id: "undo_flicker_before",
        children: [{ type: "text", text: "枠の前の本文" }],
      },
      box,
      {
        type: "paragraph",
        id: OUTSIDE_ID,
        children: [{ type: "text", text: "枠の外の本文" }],
      },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 140, heightMm: pageHeightMm },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount, columnGapMm: 8 },
    },
  };
}

interface Geometry {
  /** DOM の真実: 枠の中に今いくつ段落があるか。 */
  lineCount: number;
  /** レイアウトの真実: 計測結果から決まる値。 */
  boxHeight: number | null;
  outsideTop: number | null;
}

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(({ boxSelector, outsideSelector }) => {
    const box = window.document.querySelector<HTMLElement>(boxSelector);
    const outside = window.document.querySelector<HTMLElement>(outsideSelector);
    return {
      lineCount: window.document.querySelectorAll('.page-flow [id^="undo_flicker_box_"]').length,
      boxHeight: box ? Math.round(box.getBoundingClientRect().height) : null,
      outsideTop: outside ? Math.round(outside.getBoundingClientRect().top) : null,
    };
  }, { boxSelector: BOX_SELECTOR, outsideSelector: OUTSIDE_SELECTOR });
}

async function openEditor(page: Page, document: SigmaDocument = boxDocument()): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(BOX_SELECTOR).first()).toBeVisible();
  await page.waitForTimeout(600);
}

/**
 * 押してから数フレーム、枠の実寸・クリップ変数・枠外本文の位置を毎フレーム記録する。
 * 記録はページ内で回すので Playwright 側の往復でフレームを取りこぼさない。
 */
async function sampleFramesDuring(
  page: Page,
  action: () => Promise<void>,
  frames = 20,
): Promise<Geometry[]> {
  await page.evaluate(({ boxSelector, outsideSelector, frameCount }) => {
    interface Sample { lineCount: number; boxHeight: number | null; outsideTop: number | null }
    const samples: Sample[] = [];
    (window as unknown as { __boxUndoSamples?: Sample[] }).__boxUndoSamples = samples;
    let remaining = frameCount;
    const step = () => {
      const box = window.document.querySelector<HTMLElement>(boxSelector);
      const outside = window.document.querySelector<HTMLElement>(outsideSelector);
      samples.push({
        lineCount: window.document.querySelectorAll('.page-flow [id^="undo_flicker_box_"]').length,
        boxHeight: box ? Math.round(box.getBoundingClientRect().height) : null,
        outsideTop: outside ? Math.round(outside.getBoundingClientRect().top) : null,
      });
      remaining -= 1;
      if (remaining > 0) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }, { boxSelector: BOX_SELECTOR, outsideSelector: OUTSIDE_SELECTOR, frameCount: frames });

  await action();
  await page.waitForTimeout(frames * 20 + 400);

  return page.evaluate(() => (
    (window as unknown as { __boxUndoSamples?: Geometry[] }).__boxUndoSamples ?? []
  )) as Promise<Geometry[]>;
}

/**
 * 各フレームの (DOM の行数 → レイアウト) が、確定している 2 つの組のどちらかに一致するか。
 * 一致しないフレーム = 「新しい内容 × 古い計測」がそのまま描かれた瞬間。
 */
function inconsistentFrames(samples: readonly Geometry[], states: readonly Geometry[]): Geometry[] {
  return samples.filter((sample) => !states.some((state) => (
    state.lineCount === sample.lineCount
    && state.boxHeight === sample.boxHeight
    && state.outsideTop === sample.outsideTop
  )));
}

/**
 * 幾何が 2 回続けて同じになるまで待つ。
 *
 * 編集そのもの (Undo ではない通常の外部更新パス) は段組みページで「枠は縮んだが枠外本文がまだ
 * 動いていない」中間フレームを出す — こちらは本 WI の対象外の既存挙動なので、その尻尾を Undo の
 * サンプルに混ぜないために落ち着くまで待ってから測る。
 */
async function settleGeometry(page: Page): Promise<Geometry> {
  let previous: Geometry | null = null;
  await expect.poll(async () => {
    const current = await readGeometry(page);
    const stable = previous !== null
      && previous.lineCount === current.lineCount
      && previous.boxHeight === current.boxHeight
      && previous.outsideTop === current.outsideTop;
    previous = current;
    return stable;
  }, { intervals: [150, 150, 150, 150, 150, 150, 150, 150] }).toBe(true);
  return readGeometry(page);
}

async function deleteParagraphInBox(page: Page, blockId: string): Promise<void> {
  await page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "本文操作" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "この段落を削除", exact: true }).click();
}

async function savedContentShape(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }
    interface Block { id: string; type: string; blocks?: Block[] }
    const shape = (block: Block): unknown => ({
      id: block.id,
      type: block.type,
      ...(block.blocks ? { blocks: block.blocks.map(shape) } : {}),
    });
    return (JSON.parse(raw) as { content: Block[] }).content.map(shape);
  });
}

test("keeps content and layout consistent in every frame of an undo", async ({ page }) => {
  await openEditor(page);

  const before = await settleGeometry(page);
  await deleteParagraphInBox(page, "undo_flicker_box_3");
  await expect.poll(async () => (await readGeometry(page)).boxHeight).not.toBe(before.boxHeight);
  const edited = await settleGeometry(page);
  expect(edited.lineCount).toBeLessThan(before.lineCount);

  const samples = await sampleFramesDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  expect(samples.length).toBeGreaterThan(3);
  await expect.poll(async () => (await readGeometry(page)).boxHeight).toBe(before.boxHeight);
  expect(inconsistentFrames(samples, [before, edited])).toEqual([]);
});

test("keeps content and layout consistent in every frame of a redo", async ({ page }) => {
  await openEditor(page);

  const before = await settleGeometry(page);
  await deleteParagraphInBox(page, "undo_flicker_box_3");
  await expect.poll(async () => (await readGeometry(page)).boxHeight).not.toBe(before.boxHeight);
  const edited = await settleGeometry(page);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => (await readGeometry(page)).boxHeight).toBe(before.boxHeight);

  const samples = await sampleFramesDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Shift+Z");
  });

  await expect.poll(async () => (await readGeometry(page)).boxHeight).toBe(edited.boxHeight);
  expect(inconsistentFrames(samples, [before, edited])).toEqual([]);
});

test("restores the box to its exact pre-edit geometry after undoing its removal", async ({ page }) => {
  await openEditor(page);

  const before = await settleGeometry(page);
  await page.locator('.page-flow [data-sigma-doc-id="undo_flicker_box_2"]').first().click({ button: "right" });
  await page.getByRole("menu", { name: "本文操作" })
    .getByRole("menuitem", { name: "boxを削除", exact: true })
    .click();
  await expect(page.locator(BOX_SELECTOR)).toHaveCount(0);
  const removed = await settleGeometry(page);

  const samples = await sampleFramesDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  await expect.poll(async () => (await readGeometry(page)).boxHeight).toBe(before.boxHeight);
  expect(inconsistentFrames(samples, [before, removed])).toEqual([]);
});

test("keeps the saved SigmaDoc structure identical across undo and redo", async ({ page }) => {
  await openEditor(page);

  const original = await savedContentShape(page);
  await deleteParagraphInBox(page, "undo_flicker_box_3");
  await expect.poll(() => savedContentShape(page)).not.toEqual(original);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => savedContentShape(page)).toEqual(original);

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(() => savedContentShape(page)).not.toEqual(original);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(() => savedContentShape(page)).toEqual(original);
});

test("keeps a two-column page's box consistent through an undo", async ({ page }) => {
  await openEditor(page, boxDocument(2));

  const before = await settleGeometry(page);
  await deleteParagraphInBox(page, "undo_flicker_box_3");
  await expect.poll(async () => (await readGeometry(page)).boxHeight).not.toBe(before.boxHeight);
  const edited = await settleGeometry(page);

  const samples = await sampleFramesDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  await expect.poll(async () => (await readGeometry(page)).boxHeight).toBe(before.boxHeight);
  expect(inconsistentFrames(samples, [before, edited])).toEqual([]);
});
