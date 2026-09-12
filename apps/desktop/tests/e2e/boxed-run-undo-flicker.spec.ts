import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 「枠のついていない本文に一瞬だけ枠が出る」ちらつきの回帰テスト。
 *
 * 本文のインライン囲み (`boxed` マーク) の枠は、セグメントごとの border ではなく
 * **実測した矩形 1 枚**として別レイヤに描かれる (`boxed-text-run-height.ts` の
 * `frames` / `.boxed-run-frame`)。矩形は文書位置を持たないので、Undo のように文書を
 * 丸ごと差し替える更新でも写像しようがなく、以前は「次の計測が来るまで前の矩形を
 * 描き続ける」実装だった。その結果 Undo 直後の 1〜数フレームだけ、**囲みマークが
 * 消えた段落に古い枠が描かれる**。
 *
 * `box-undo-flicker.spec.ts` がこれを取り逃がしていたのは、あちらの fixture に
 * `marks: ["boxed"]` のインラインノードが 1 つも無く、測っていたのが boxBlock の高さと
 * 枠外本文の位置だけだったため。ここでは **同じフレームの中で** 「DOM の真実 (囲み span が
 * いくつあるか)」と「装飾の真実 (枠クラス・描かれた矩形)」を対にして採る (learnings #11)。
 *
 * 判定を「確定 2 状態のどちらかに一致するか」ではなく不変条件にしているのは、枠が
 * **遅れて出る**のは避けようがないため — 矩形は計測してからでないと描けないので、囲みを
 * 付けた直後には必ず「囲み span はあるが枠はまだ無い」フレームが挟まる。禁じたいのは逆向き、
 * つまり **本文が無いところに枠が出ること** と **本文とずれた矩形が描かれること** の 2 つ:
 *
 * - `ghostFrames`  : 囲み span が 0 個の段落に枠 (クラス or 矩形) がある → 常に不正。
 * - `misalignedFrames`: 描かれた矩形の外接箱が、同じフレームの装飾対象の外接箱とずれている
 *   → 「古い矩形が残っている」ことの直接の証拠。
 *
 * `misalignedFrames` は編集対象の段落にだけ適用する。無関係な再フローで枠が一時的に
 * 古くなるのは既存の設計 (「編集のたびに枠が消えるのを避ける」) の範囲で、本 WI の対象外。
 * 同じ理由で「自分のランの中に打っている間」も矩形は次の計測まで古いままでよい — そこは
 * 逆に **枠が消えないこと** を見る (消すと 12 フレームぶんセグメント border に落ちる)。
 */

const TOLERANCE_PX = 2;

interface CensusRect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface ContainerCensus {
  id: string | null;
  /** DOM の真実。 */
  boxedSpans: number;
  /** 装飾の真実。 */
  targets: number;
  framed: boolean;
  frames: number;
  frameUnion: CensusRect | null;
  targetUnion: CensusRect | null;
}

interface FrameCensus {
  containers: ContainerCensus[];
  /** 仮説 2 (boxBlock フラグメントのプレビューが 1 フレーム古い) の観測用。 */
  boxFragments: string[];
  boxBlocks: string[];
}

declare global {
  interface Window {
    __boxedRunCensus?: () => FrameCensus;
    __boxedRunSamples?: FrameCensus[];
  }
}

async function installCensus(page: Page): Promise<void> {
  await page.addInitScript(() => {
    interface Rect { left: number; top: number; right: number; bottom: number }

    const containerSelector = ".page-flow :is(p, h1, h2, h3, h4, h5, h6, li)";

    const union = (elements: Element[], originLeft: number, originTop: number): Rect | null => {
      let result: Rect | null = null;
      for (const element of elements) {
        for (const rect of Array.from(element.getClientRects())) {
          if (rect.width <= 0 && rect.height <= 0) {
            continue;
          }
          const next = {
            left: rect.left - originLeft,
            top: rect.top - originTop,
            right: rect.right - originLeft,
            bottom: rect.bottom - originTop,
          };
          result = result === null ? next : {
            left: Math.min(result.left, next.left),
            top: Math.min(result.top, next.top),
            right: Math.max(result.right, next.right),
            bottom: Math.max(result.bottom, next.bottom),
          };
        }
      }
      return result === null ? null : {
        left: Math.round(result.left),
        top: Math.round(result.top),
        right: Math.round(result.right),
        bottom: Math.round(result.bottom),
      };
    };

    const rectKey = (element: Element): string => {
      const rect = element.getBoundingClientRect();
      return [rect.left, rect.top, rect.width, rect.height].map((value) => Math.round(value)).join(",");
    };

    window.__boxedRunCensus = () => ({
      containers: Array.from(window.document.querySelectorAll(containerSelector)).map((container) => {
        const box = container.getBoundingClientRect();
        const frames = Array.from(container.querySelectorAll(".boxed-run-frame"));
        const targets = Array.from(container.querySelectorAll('[data-boxed-run-height-target="true"]'));
        return {
          id: container.getAttribute("data-sigma-doc-id"),
          boxedSpans: container.querySelectorAll(".boxed-text").length,
          targets: targets.length,
          framed: container.classList.contains("boxed-run-framed"),
          frames: frames.length,
          frameUnion: union(frames, box.left, box.top),
          targetUnion: union(targets, box.left, box.top),
        };
      }),
      boxFragments: Array.from(window.document.querySelectorAll<HTMLElement>(".editor-box-fragment-viewport"))
        .map((viewport) => `${viewport.dataset.boxSourceId}:${viewport.dataset.boxFragmentIndex}:${rectKey(viewport)}`),
      boxBlocks: Array.from(window.document.querySelectorAll<HTMLElement>(".sigma-doc-box-block"))
        .map((box) => `${box.dataset.sigmaDocId}:${rectKey(box)}`),
    });
  });
}

async function openEditor(page: Page, document: SigmaDocument): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installCensus(page);
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow .text-flow-editor").first()).toBeVisible();
  await page.waitForTimeout(600);
}

async function readCensus(page: Page): Promise<FrameCensus> {
  return page.evaluate(() => window.__boxedRunCensus?.() ?? { containers: [], boxFragments: [], boxBlocks: [] });
}

/** 幾何が 2 回続けて同じになるまで待つ (中間フレームの尻尾を次の測定に混ぜない)。 */
async function settleCensus(page: Page): Promise<FrameCensus> {
  let previous: string | null = null;
  await expect.poll(async () => {
    const current = JSON.stringify(await readCensus(page));
    const stable = previous === current;
    previous = current;
    return stable;
  }, { intervals: [150, 150, 150, 150, 150, 150, 150, 150] }).toBe(true);
  return readCensus(page);
}

/**
 * 操作の前後で毎フレーム census を採る。記録はページ内の rAF ループで回すので、
 * Playwright 側との往復でフレームを取りこぼさない。
 */
async function sampleCensusDuring(
  page: Page,
  action: () => Promise<void>,
  frames = 24,
): Promise<FrameCensus[]> {
  await page.evaluate((frameCount) => {
    const samples: FrameCensus[] = [];
    window.__boxedRunSamples = samples;
    let remaining = frameCount;
    const step = () => {
      const census = window.__boxedRunCensus?.();
      if (census) {
        samples.push(census);
      }
      remaining -= 1;
      if (remaining > 0) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }, frames);

  await action();
  await page.waitForTimeout(frames * 20 + 400);

  return page.evaluate(() => window.__boxedRunSamples ?? []);
}

/**
 * 囲み span が 1 つも無いのに枠の装飾が付いている段落 = ユーザー報告そのもの。
 *
 * 計測対象の印 (`targets`) まで見るのは、そこが枠の出どころだから。装飾範囲が文書全体へ
 * 広がると全インラインにこの印が付き、次の計測が段落ごとに枠を作る — 矩形そのものより
 * 1 手前で捕まえられる。
 */
function ghostFrames(samples: readonly FrameCensus[]): ContainerCensus[] {
  return samples.flatMap((sample) => sample.containers.filter(
    (container) => container.boxedSpans === 0
      && (container.framed || container.frames > 0 || container.targets > 0),
  ));
}

/** 描かれた矩形が、同じフレームの装飾対象とずれている段落 = 古い矩形が残っている証拠。 */
function misalignedFrames(samples: readonly FrameCensus[], id: string): ContainerCensus[] {
  return samples.flatMap((sample) => sample.containers.filter((container) => {
    if (container.id !== id || container.frameUnion === null) {
      return false;
    }
    const target = container.targetUnion;
    if (target === null) {
      return true;
    }
    const frame = container.frameUnion;
    return Math.abs(frame.left - target.left) > TOLERANCE_PX
      || Math.abs(frame.top - target.top) > TOLERANCE_PX
      || Math.abs(frame.right - target.right) > TOLERANCE_PX
      || Math.abs(frame.bottom - target.bottom) > TOLERANCE_PX;
  }));
}

function pageStateKey(census: FrameCensus): string {
  return `${census.boxFragments.join("|")}##${census.boxBlocks.join("|")}`;
}

/** どちらの確定状態とも一致しないフレーム (仮説 2 の判定用)。 */
function inconsistentPageFrames(samples: readonly FrameCensus[], states: readonly FrameCensus[]): string[] {
  const keys = states.map(pageStateKey);
  return samples.map(pageStateKey).filter((key) => !keys.includes(key));
}

function containerCensus(census: FrameCensus, id: string): ContainerCensus | undefined {
  return census.containers.find((container) => container.id === id);
}

/**
 * 囲みを付ける対象の段落は **最後**に置く。付けると行ボックスの高さが変わるため、下に別の
 * 囲み段落があると再フローでそちらの矩形まで一時的に古くなり、測りたいものが埋もれる。
 */
function plainTargetDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_boxed_run_undo_plain",
    metadata: { title: "囲み文字のUndoちらつき" },
    content: [
      {
        type: "paragraph",
        id: "p_lead",
        children: [{ type: "text", text: "囲みの前にある本文" }],
      },
      {
        type: "paragraph",
        id: "p_target",
        children: [{ type: "text", text: "ここを枠で囲みます" }],
      },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

/** 既に囲みランを持つ段落。こちらも編集対象なので最後に置く。 */
function existingRunDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_boxed_run_undo_existing",
    metadata: { title: "既存の囲みランのUndo" },
    content: [
      {
        type: "paragraph",
        id: "p_lead",
        children: [{ type: "text", text: "囲みの前にある本文" }],
      },
      {
        type: "paragraph",
        id: "p_run",
        lineHeight: "1.8",
        children: [
          { type: "text", text: "囲まれた文", marks: ["boxed"] },
          { type: "mathInline", id: "m_run", tex: "\\sum_{k=1}^{n}", display: "inline", marks: ["boxed"] },
          { type: "text", text: "です", marks: ["boxed"] },
        ],
      },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
    },
  };
}

/** 段組み + ページ跨ぎの枠。枠の中の本文にも囲みランを置いて 2 機構を重ねる。 */
function pagedBoxDocument(): SigmaDocument {
  const box = createBoxBlock("fancybox", "", { id: "run_box", bodyId: "run_box_1" });
  box.blocks = Array.from({ length: 14 }, (_, index) => (index === 1
    ? {
      type: "paragraph" as const,
      id: "run_box_2",
      children: [
        { type: "text" as const, text: "枠内の" },
        { type: "text" as const, text: "囲み文字", marks: ["boxed" as const] },
        { type: "text" as const, text: "です" },
      ],
    }
    : {
      type: "paragraph" as const,
      id: `run_box_${index + 1}`,
      children: [{ type: "text" as const, text: `枠の中の本文 ${index + 1} 行目` }],
    }));
  return {
    version: "2.0",
    docId: "doc_boxed_run_undo_paged",
    metadata: { title: "段組み枠内の囲み文字" },
    content: [
      {
        type: "paragraph",
        id: "p_lead",
        children: [{ type: "text", text: "枠の前の本文" }],
      },
      box,
      {
        type: "paragraph",
        id: "p_after",
        children: [{ type: "text", text: "枠の外の本文" }],
      },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 140, heightMm: 110 },
      marginsMm: { top: 12, right: 12, bottom: 12, left: 12 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    },
  };
}

async function applyBoxedTextTo(page: Page, id: string): Promise<void> {
  await page.locator(`.page-flow .text-flow-editor [data-sigma-doc-id="${id}"]`).first().click({ clickCount: 3 });
  const toggle = page.locator(".boxed-text-toggle-button");
  await expect(toggle).toBeEnabled();
  await toggle.click();
}

test("枠を付けた段落を Undo したとき、枠の無い本文に枠が残らない", async ({ page }) => {
  await openEditor(page, plainTargetDocument());

  const before = await settleCensus(page);
  expect(containerCensus(before, "p_target")).toMatchObject({ boxedSpans: 0, frames: 0, framed: false });

  await applyBoxedTextTo(page, "p_target");
  await expect.poll(async () => containerCensus(await readCensus(page), "p_target")?.frames ?? 0).toBeGreaterThan(0);
  const applied = await settleCensus(page);
  expect(containerCensus(applied, "p_target")).toMatchObject({ framed: true });

  const samples = await sampleCensusDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  expect(samples.length).toBeGreaterThan(3);
  await expect.poll(async () => containerCensus(await readCensus(page), "p_target")?.boxedSpans ?? -1).toBe(0);
  expect(ghostFrames(samples)).toEqual([]);
  expect(misalignedFrames(samples, "p_target")).toEqual([]);
});

test("Undo した枠を Redo し直すときも枠と本文が食い違わない", async ({ page }) => {
  await openEditor(page, plainTargetDocument());

  await settleCensus(page);
  await applyBoxedTextTo(page, "p_target");
  await expect.poll(async () => containerCensus(await readCensus(page), "p_target")?.frames ?? 0).toBeGreaterThan(0);
  await settleCensus(page);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => containerCensus(await readCensus(page), "p_target")?.boxedSpans ?? -1).toBe(0);
  await settleCensus(page);

  const samples = await sampleCensusDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Shift+Z");
  });

  await expect.poll(async () => containerCensus(await readCensus(page), "p_target")?.frames ?? 0).toBeGreaterThan(0);
  expect(ghostFrames(samples)).toEqual([]);
  expect(misalignedFrames(samples, "p_target")).toEqual([]);
});

test("既存の囲みランに文字を入れて Undo しても、枠が本文とずれたフレームが出ない", async ({ page }) => {
  await openEditor(page, existingRunDocument());

  const before = await settleCensus(page);
  expect(containerCensus(before, "p_run")).toMatchObject({ framed: true });
  const beforeWidth = containerCensus(before, "p_run")?.frameUnion?.right ?? 0;

  const typing = await sampleCensusDuring(page, async () => {
    await page.evaluate(() => {
      const span = window.document.querySelector('.page-flow [data-sigma-doc-id="p_run"] .boxed-text');
      const walker = span ? window.document.createTreeWalker(span, NodeFilter.SHOW_TEXT) : null;
      const text = walker?.nextNode();
      if (!(text instanceof Text)) {
        throw new Error("囲みテキストのテキストノードが見つかりません");
      }
      const range = window.document.createRange();
      range.setStart(text, Math.min(2, text.length));
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
    });
    await page.keyboard.type("々");
  });

  // 自分のランの中に打っている間は枠が消えないこと。矩形は次の計測まで 1 文字ぶん狭いままだが、
  // それは修正前からの挙動で、代わりに枠を落とすとセグメント border へ落ちる時間 (実測で
  // rAF 12 回ぶん) が生まれ、キーストロークごとに見た目が揺れる。
  expect(typing.filter((sample) => containerCensus(sample, "p_run")?.framed === false)).toEqual([]);

  await expect.poll(async () => containerCensus(await readCensus(page), "p_run")?.frameUnion?.right ?? 0)
    .toBeGreaterThan(beforeWidth);
  const edited = await settleCensus(page);
  expect(containerCensus(edited, "p_run")).toMatchObject({ framed: true });

  const undo = await sampleCensusDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  await expect.poll(async () => containerCensus(await readCensus(page), "p_run")?.frameUnion?.right ?? 0)
    .toBe(beforeWidth);
  expect(ghostFrames([...typing, ...undo])).toEqual([]);
});

test("段組みページの枠内でも Undo 中に枠の無い本文へ枠が降りない", async ({ page }) => {
  await openEditor(page, pagedBoxDocument());

  const before = await settleCensus(page);
  expect(before.boxFragments.length).toBeGreaterThan(0);

  await page.locator('.page-flow [data-sigma-doc-id="run_box_4"]').first().click({ button: "right" });
  const menu = page.getByRole("menu", { name: "本文操作" });
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "この段落を削除", exact: true }).click();
  await expect.poll(async () => (await readCensus(page)).containers.length).not.toBe(before.containers.length);
  const edited = await settleCensus(page);

  const samples = await sampleCensusDuring(page, async () => {
    await page.keyboard.press("ControlOrMeta+Z");
  });

  await expect.poll(async () => (await readCensus(page)).containers.length).toBe(before.containers.length);
  expect(ghostFrames(samples)).toEqual([]);
  // 枠フラグメントのプレビュー (`.editor-box-fragment-viewport`) が 1 フレーム古い配置で描かれる、
  // という別仮説の観測。修正前のビルドでもここは緑だったので、今回の症状はこの経路ではない。
  // 以後の退行検出用に残す。
  expect(inconsistentPageFrames(samples, [before, edited])).toEqual([]);
});
