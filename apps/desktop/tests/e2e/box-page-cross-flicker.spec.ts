import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 箱の中に打ち続けて**ページ境界を越える瞬間**の描画。
 *
 * 分割されたブロック (ページを跨ぐ箱) の見た目 — 正本のクリップ・続きの位置・その下の本文の
 * 位置・キャレットの行 — は、すべてページ割りの答えそのものである。内容の変化だけを先に描くと
 * 「新しい内容 × 古いページ割り」というどちらでもない状態がそのまま描かれる。実際に見えていた
 * 症状は 3 つとも同じ 1〜2 フレームに出る:
 *
 * - 箱がページ下端をはみ出して伸び、次のフレームで縮む
 * - 箱より下の本文が 1 行ぶん下がってから戻る
 * - キャレットが 1 行下へ跳ねてから戻る
 *
 * 箱の外の段落には往復が無い (伸びた分だけ下へ動いて終わる) ので、ここでは「箱の中でも往復が
 * 起きない」ことを 2 つの角度から見る。
 */

const BOX_ID = "page_cross_box";
const AFTER_ID = "page_cross_after";

function boxDocument(): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: BOX_ID, bodyId: "page_cross_box_1" });
  box.blocks = Array.from({ length: 7 }, (_, index) => ({
    type: "paragraph" as const,
    id: `page_cross_box_${index + 1}`,
    children: [{ type: "text" as const, text: `枠の中の本文 ${index + 1} 行目` }],
  }));
  return {
    version: "2.0",
    docId: "doc_page_cross_box",
    metadata: { title: "箱のページ跨ぎ" },
    content: [
      { type: "paragraph", id: "page_cross_before", children: [{ type: "text", text: "枠の前の本文" }] },
      box,
      { type: "paragraph", id: AFTER_ID, children: [{ type: "text", text: "枠の後の本文" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 140, heightMm: 110 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

interface Geometry {
  /** 分割されているか (続きの複製の数)。 */
  fragments: number;
  /** 正本が見せている高さ (クリップ)。分割されていなければ null。 */
  visibleHeight: number | null;
  /** 箱より下の本文の位置。往復するとここに出る。 */
  afterTop: number | null;
  /** キャレット矩形の上端。 */
  caretTop: number | null;
}

const READ_GEOMETRY = `() => {
  const source = document.querySelector(".page-flow .text-flow-box-fragment-source");
  const after = document.querySelector('.page-flow [data-sigma-doc-id="${AFTER_ID}"]');
  const selection = window.getSelection();
  const caret = selection && selection.rangeCount > 0
    ? selection.getRangeAt(0).getBoundingClientRect()
    : null;
  const visible = source
    ? Number.parseFloat(getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"))
    : Number.NaN;
  return {
    fragments: document.querySelectorAll(".editor-box-fragment-viewport").length,
    visibleHeight: Number.isFinite(visible) ? Math.round(visible) : null,
    afterTop: after ? Math.round(after.getBoundingClientRect().top) : null,
    caretTop: caret && (caret.top !== 0 || caret.bottom !== 0) ? Math.round(caret.top) : null,
  };
}`;

async function readGeometry(page: Page): Promise<Geometry> {
  return page.evaluate(`(${READ_GEOMETRY})()`) as Promise<Geometry>;
}

/** 幾何が 2 回続けて同じになるまで待つ。 */
async function settleGeometry(page: Page): Promise<Geometry> {
  let previous: Geometry | null = null;
  await expect.poll(async () => {
    const current = await readGeometry(page);
    const stable = previous !== null && sameGeometry(previous, current);
    previous = current;
    return stable;
  }, { intervals: [120, 120, 120, 120, 120, 120, 120, 120] }).toBe(true);
  return readGeometry(page);
}

function sameGeometry(left: Geometry, right: Geometry): boolean {
  return left.fragments === right.fragments
    && left.visibleHeight === right.visibleHeight
    && left.afterTop === right.afterTop
    && left.caretTop === right.caretTop;
}

/** `action` の間、毎フレーム幾何を記録する。往復は隣接 2 状態の比較では見えないので全部見る。 */
async function sampleFramesDuring(
  page: Page,
  action: () => Promise<void>,
  settleMs = 700,
): Promise<Geometry[]> {
  await page.evaluate(`(() => {
    const read = ${READ_GEOMETRY};
    const samples = [];
    window.__boxCrossSamples = samples;
    window.__boxCrossSampling = true;
    const step = () => {
      samples.push(read());
      if (window.__boxCrossSampling) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  })()`);

  await action();
  await page.waitForTimeout(settleMs);

  return page.evaluate(`(() => {
    window.__boxCrossSampling = false;
    return window.__boxCrossSamples ?? [];
  })()`) as Promise<Geometry[]>;
}

async function openEditorAtBoxEnd(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1200, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, boxDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(`.page-flow [data-sigma-doc-id="${BOX_ID}"]`).first()).toBeVisible();
  await page.waitForTimeout(800);

  // 箱の最後の段落の末尾から打ち始める。箱の外周エディタが被さるので座標クリックで入れる。
  await page.locator('.page-flow [data-sigma-doc-id="page_cross_box_7"]').first().click({ force: true });
  await page.keyboard.press("End");
  await page.waitForTimeout(200);
}

/** 分割が起きるまでに要る文字数。ページ寸法とフォントの実測に依存するので毎回測る。 */
async function countKeystrokesToSplit(page: Page): Promise<number> {
  for (let typed = 1; typed <= 80; typed += 1) {
    await page.keyboard.type("あ");
    await page.waitForTimeout(90);
    if ((await readGeometry(page)).fragments > 0) {
      return typed;
    }
  }
  throw new Error("箱がページ境界を越えなかった (フィクスチャの寸法を見直すこと)");
}

test("crossing the page boundary inside a box paints no in-between layout", async ({ page }) => {
  // 分割が起きる打鍵数を測るために教材を 2 回開く。dev サーバー相手だと既定の 60 秒に入らない。
  test.setTimeout(180_000);
  await openEditorAtBoxEnd(page);
  const keystrokes = await countKeystrokesToSplit(page);

  // 越える直前まで打ち直してから、その 1 打鍵だけを毎フレーム見る。
  await openEditorAtBoxEnd(page);
  for (let index = 0; index < keystrokes - 1; index += 1) {
    await page.keyboard.type("あ");
    await page.waitForTimeout(90);
  }
  const before = await settleGeometry(page);
  expect(before.fragments).toBe(0);

  const samples = await sampleFramesDuring(page, async () => {
    await page.keyboard.type("あ");
  });

  const after = await settleGeometry(page);
  expect(after.fragments).toBe(1);
  expect(samples.length).toBeGreaterThan(3);

  // どのフレームも「越える前」か「越えた後」のどちらか。キャレットの点滅は矩形に出ないので、
  // キャレットが無いフレーム (caretTop === null) だけは両方の候補と照合しない。
  const inBetween = samples.filter((sample) => ![before, after].some((state) => (
    state.fragments === sample.fragments
    && state.visibleHeight === sample.visibleHeight
    && state.afterTop === sample.afterTop
    && (sample.caretTop === null || state.caretTop === sample.caretTop)
  )));
  expect(inBetween).toEqual([]);

  // 「どの面がキャレットを持つか」はここでは見ない。React の StrictMode (dev サーバー) は
  // マウント時に `EditorContent` の効果を 1 往復させ、その間 ProseMirror の DOM が一度
  // 外れるため、複製に配ったフォーカスが dev でだけ落ちる。所有権は
  // `box-inner-break.spec.ts` が (フォーカスを配り直す操作から) 見ている。
});

test("typing inside a split box never pushes the text below it down and back", async ({ page }) => {
  test.setTimeout(180_000);
  await openEditorAtBoxEnd(page);
  await countKeystrokesToSplit(page);
  await settleGeometry(page);

  // 分割された箱の続きに打ち続ける。文字を足すだけなので、箱より下の本文は下へ動くか
  // 動かないかのどちらかしかない — 一度でも上へ戻ったら、それが往復 (= ちらつき)。
  const samples = await sampleFramesDuring(page, async () => {
    for (let index = 0; index < 60; index += 1) {
      await page.keyboard.type("い");
      await page.waitForTimeout(60);
    }
  });

  const tops = samples.map((sample) => sample.afterTop).filter((top): top is number => top !== null);
  expect(tops.length).toBeGreaterThan(10);
  const movedUp = tops.filter((top, index) => index > 0 && top < tops[index - 1]);
  expect(movedUp).toEqual([]);
});
