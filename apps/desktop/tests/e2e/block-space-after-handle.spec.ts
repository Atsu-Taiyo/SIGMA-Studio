import { expect, test, type Page } from "@playwright/test";

import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOptionInPage } from "./ui-select";

const DRAG_PX = 30;
/** 紙面の「余白のダブルタップ」判定窓 (`PageCanvasEditor` の PAGE_DOUBLE_TAP_MS) を越える待ち。 */
const PAGE_MARGIN_DOUBLE_TAP_WINDOW_MS = 500;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

/**
 * 紙面は zoom の CSS transform 越しに描かれるので、`getBoundingClientRect` は拡大率ぶん
 * 伸びている。レイアウト px との換算率を実測してから比べる。
 */
async function readScale(page: Page, blockId: string): Promise<number> {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${CSS.escape(id)}"]`);
    if (!element || element.offsetWidth === 0) {
      return 1;
    }
    return element.getBoundingClientRect().width / element.offsetWidth;
  }, blockId);
}

/** ブロックの実測矩形 (画面 px)。 */
async function blockBox(page: Page, blockId: string): Promise<{
  left: number;
  top: number;
  bottom: number;
  height: number;
}> {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${CSS.escape(id)}"]`);
    const rect = element?.getBoundingClientRect();
    return {
      left: rect?.left ?? Number.NaN,
      top: rect?.top ?? Number.NaN,
      bottom: rect?.bottom ?? Number.NaN,
      height: rect?.height ?? Number.NaN,
    };
  }, blockId);
}

async function blockTop(page: Page, blockId: string): Promise<number> {
  return page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${CSS.escape(id)}"]`);
    return element ? element.getBoundingClientRect().top : Number.NaN;
  }, blockId);
}

/** ブロックの中央にポインタを置いて、そのブロックのつまみを出す。 */
async function hoverBlock(page: Page, blockId: string) {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
  await expect(block).toBeVisible();
  const box = await block.boundingBox();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  return page.locator(`.page-block-space-handle[data-block-id="${blockId}"]`);
}

async function dragHandle(page: Page, handle: ReturnType<Page["locator"]>, deltaScreenPx: number) {
  const box = await handle.boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaScreenPx, { steps: 6 });
  await page.mouse.up();
}

/**
 * 実ユーザーのように、フレームを跨ぎながら少しずつ引く。離さないまま返るので、掴んだ
 * ままの状態を観測できる。
 */
async function grabAndDrag(
  page: Page,
  handle: ReturnType<Page["locator"]>,
  deltaScreenPx: number,
  steps = 16,
): Promise<{ x: number; y: number }> {
  const box = await handle.boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(x, y + (deltaScreenPx * step) / steps);
    // 1 フレーム以上空ける。まとめて投げるとブラウザ側で 1 フレームに畳まれ、
    // 「追従しているか」を観測できなくなる (poll と同じ盲点)。
    await page.waitForTimeout(24);
  }
  return { x, y };
}

interface DragSample {
  handleTop: number;
  tops: Record<string, number>;
}

/** サンプリング中だけ紙面側に置く受け皿。 */
type SamplingWindow = Window & {
  __spaceAfterSamples?: DragSample[];
  __spaceAfterSampling?: boolean;
};

/**
 * `action` の間、**毎フレーム** 幾何を記録する。
 *
 * `expect.poll` は 1 フレームの往復も「まとめて瞬間移動」も吸収してしまう (最終位置しか
 * 見えない) ので、この spec の追従・継ぎ目の判定には使わない。
 */
async function sampleFramesDuring(
  page: Page,
  blockIds: readonly string[],
  action: () => Promise<void>,
  settleMs = 0,
): Promise<DragSample[]> {
  await page.evaluate((ids) => {
    const samples: DragSample[] = [];
    const read = (): DragSample => {
      const handle = document.querySelector<HTMLElement>(".page-block-space-handle");
      const tops: Record<string, number> = {};
      for (const id of ids) {
        const element = document.querySelector<HTMLElement>(
          `.page-flow [data-sigma-doc-id="${CSS.escape(id)}"]`,
        );
        tops[id] = element ? element.getBoundingClientRect().top : Number.NaN;
      }
      return {
        handleTop: handle ? handle.getBoundingClientRect().top : Number.NaN,
        tops,
      };
    };
    const window_ = window as SamplingWindow;
    window_.__spaceAfterSamples = samples;
    window_.__spaceAfterSampling = true;
    const step = () => {
      samples.push(read());
      if (window_.__spaceAfterSampling) {
        window.requestAnimationFrame(step);
      }
    };
    window.requestAnimationFrame(step);
  }, blockIds as string[]);

  await action();
  if (settleMs > 0) {
    await page.waitForTimeout(settleMs);
  }

  return page.evaluate(() => {
    const window_ = window as SamplingWindow;
    window_.__spaceAfterSampling = false;
    return window_.__spaceAfterSamples ?? [];
  });
}

/** 記録した系列が「ポインタに連続で追従した」と言える形かどうかを見る。 */
function expectContinuousDescent(series: readonly number[], totalTravelPx: number): void {
  const values = series.filter((value) => Number.isFinite(value));
  expect(values.length).toBeGreaterThan(10);

  // (a) 途中の相異なる値。「まとめて瞬間移動」だと 2〜3 種類しか出ない。
  expect(new Set(values.map((value) => Math.round(value))).size).toBeGreaterThanOrEqual(8);

  // (b) 単調。戻るフレームがあれば継ぎ目のちらつき (プレビューを先に外した形)。
  let maxJump = 0;
  for (let index = 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    expect(delta).toBeGreaterThan(-1);
    maxJump = Math.max(maxJump, Math.abs(delta));
  }

  // (c) 1 フレームの跳躍が総移動量の 1/3 未満。追いつかずに飛んでいれば必ずここで落ちる。
  expect(maxJump).toBeLessThan(totalTravelPx / 3);
}

/**
 * 「字体が 1 つ増えて読み込みが終わった」を紙面へ知らせる。
 *
 * 紙面はこれを受けて全体を測り直す予約を出す (`fonts.ready` / `loadingdone` の購読)。
 * ドラッグ中の凍結を **外因で** 試すための、いちばん安い実物の引き金。判定は
 * `${fonts.status}:${fonts.size}` の変化なので、毎回別の family で足す。
 */
async function announceFontLoad(page: Page, family: string): Promise<void> {
  await page.evaluate((name) => {
    // 実体は要らない (読み込みは走らせない)。`fonts.size` が動けば紙面は測り直しにくる。
    document.fonts.add(new FontFace(name, "local('Helvetica')"));
    document.fonts.dispatchEvent(new Event("loadingdone"));
  }, family);
}

async function readPerformanceCounters(page: Page): Promise<Record<string, number>> {
  const counters = await page.evaluate(
    () => window.__SIGMA_STUDIO_PERFORMANCE__?.counters ?? null,
  );
  expect(
    counters,
    "計測が無効なビルドです (window.__SIGMA_STUDIO_PERFORMANCE__ にカウンタがありません)。",
  ).not.toBeNull();
  return counters ?? {};
}

async function openDocument(page: Page, document: SigmaDocument): Promise<void> {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await page.waitForTimeout(1500);
}

test("the handle appears on hover and drags the space below the block", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();
  // ホバーする前は出ない (常時表示にしない)。
  await expect(page.locator(".page-block-space-handle")).toHaveCount(0);

  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");

  const handle = await hoverBlock(page, "p_spaced");
  await expect(handle).toBeVisible();

  await dragHandle(page, handle, DRAG_PX * scale);

  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeLessThanOrEqual(DRAG_PX + 2);

  // 文書へ保存されている。
  await expect.poll(async () => page.evaluate(
    () => window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
  )).toContain("spaceAfterPx");
});

test("dragging up stops at 0 and a double-click resets it", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument({ spaceAfterPx: 40 }));
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();
  const scale = await readScale(page, "p_spaced");
  const withSpace = await blockTop(page, "p_after");

  // 大きく上へ引いても 0 で止まる (負にならない)。
  const handle = await hoverBlock(page, "p_spaced");
  await dragHandle(page, handle, -400 * scale);

  await expect.poll(async () => Math.round((withSpace - await blockTop(page, "p_after")) / scale))
    .toBeGreaterThanOrEqual(38);
  const atZero = await blockTop(page, "p_after");

  // ここから下へ戻して、ダブルクリックで 0 に戻ることを見る。
  const handleAgain = await hoverBlock(page, "p_spaced");
  await dragHandle(page, handleAgain, DRAG_PX * scale);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - atZero) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);

  const handleForReset = await hoverBlock(page, "p_spaced");
  await handleForReset.dblclick();

  await expect.poll(async () => Math.round(Math.abs(await blockTop(page, "p_after") - atZero) / scale))
    .toBeLessThanOrEqual(2);
});

test("a second drag continues from the value the first one saved", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();
  const scale = await readScale(page, "p_spaced");
  const start = await blockTop(page, "p_after");

  await dragHandle(page, await hoverBlock(page, "p_spaced"), DRAG_PX * scale);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - start) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);

  // 2 回目。ホバーが取り直されていない値から足すと、ここで紙面が 1 回目の分だけ巻き戻る。
  await dragHandle(page, await hoverBlock(page, "p_spaced"), DRAG_PX * scale);

  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - start) / scale))
    .toBeGreaterThanOrEqual(2 * DRAG_PX - 4);
});

test("dragging the handle does not move the caret or the selection", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  // 本文に選択を作ってから、つまみを引く。
  const before = page.locator('.page-flow [data-sigma-doc-id="p_before"]').first();
  await before.click({ clickCount: 3 });
  const selectionBefore = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selectionBefore.length).toBeGreaterThan(0);

  const scale = await readScale(page, "p_spaced");
  const handle = await hoverBlock(page, "p_spaced");
  await dragHandle(page, handle, DRAG_PX * scale);

  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe(selectionBefore);
});

/**
 * **キャレットを本文に置いたまま**離しても、確定した余白が紙面に残る。
 *
 * 編集中の面 (ProseMirror) は自分が正本なので、外からの更新はブロック id 列か種別が動いた
 * ときだけ流し込まれる。下余白は id も種別も動かさないので、この経路を通さないとキャレットの
 * 居るチャンクにだけ永遠に届かない —「離した瞬間に元の位置へ戻る」の正体がそれだった。
 * 文書には正しく入るので、保存を見るだけでは検出できない: **紙面の padding を見る**。
 *
 * 置き方は **1 回のクリック**でなければならない。ダブル/トリプルクリックは紙面の
 * 「余白のダブルタップ」経路に吸われて面のフォーカスが外れ、外部同期が普通に流れてしまう
 * (上の選択の test が不具合を素通りしていたのはこれ)。焦点が本文にあることを先に確かめる。
 */
test("the committed space survives with the caret still in the body", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();
  // 本文を編集していた流れそのもの: キャレットが同じチャンクに残ったまま掴む。
  await page.locator('.page-flow [data-sigma-doc-id="p_before"]').first().click();
  await expect.poll(async () => page.evaluate(
    () => !!document.activeElement?.closest(".ProseMirror"),
  )).toBe(true);

  const scale = await readScale(page, "p_spaced");
  const startTop = await blockTop(page, "p_after");
  await dragHandle(page, await hoverBlock(page, "p_spaced"), DRAG_PX * scale);

  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - startTop) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);
  // 紙面の面そのものが余白を持っている (プレビューの平行移動が残っているだけではない)。
  await expect.poll(async () => page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    return element ? Number.parseFloat(window.getComputedStyle(element).paddingBottom || "0") : 0;
  })).toBeGreaterThanOrEqual(DRAG_PX - 2);
});

test("the handle follows the column a block sits in", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createTwoColumnDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const secondColumnId = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".page-flow [data-sigma-doc-id^=\"p_col_\"]"));
    const lefts = blocks.map((block) => block.getBoundingClientRect().left);
    const firstLeft = Math.min(...lefts);
    const inSecond = blocks.find((block) => block.getBoundingClientRect().left > firstLeft + 50);
    return inSecond?.getAttribute("data-sigma-doc-id") ?? null;
  });
  expect(secondColumnId).not.toBeNull();

  const handle = await hoverBlock(page, secondColumnId!);
  await expect(handle).toBeVisible();

  const proof = await page.evaluate((id) => {
    const block = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    const handleElement = document.querySelector<HTMLElement>(`.page-block-space-handle[data-block-id="${id}"]`);
    const blockRect = block!.getBoundingClientRect();
    const handleRect = handleElement!.getBoundingClientRect();
    return {
      // ハンドルは段の左端の外側 (ガター) に、段の左に揃えて出る。
      columnLeftDelta: handleRect.right - blockRect.left,
      bottomDelta: handleRect.top + handleRect.height / 2 - blockRect.bottom,
    };
  }, secondColumnId);

  // 用紙左端ではなく、その段の左のすぐ外 (右端の透明な当たり判定は本文左端に密着する)。
  expect(proof.columnLeftDelta).toBeLessThanOrEqual(0.5);
  expect(proof.columnLeftDelta).toBeGreaterThan(-60);
  expect(Math.abs(proof.bottomDelta)).toBeLessThan(3);
});

test("the handle survives the pointer's approach in every column and zoom", async ({ page }) => {
  test.setTimeout(120_000);

  await installDesktopRuntimeMock(page, createTwoColumnDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const pickColumnBlocks = () => page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('.page-flow [data-sigma-doc-id^="p_col_"]'));
    const lefts = blocks.map((block) => block.getBoundingClientRect().left);
    const firstLeft = Math.min(...lefts);
    return {
      first: blocks.find((block) => Math.abs(block.getBoundingClientRect().left - firstLeft) < 5)
        ?.getAttribute("data-sigma-doc-id") ?? null,
      second: blocks.find((block) => block.getBoundingClientRect().left > firstLeft + 50)
        ?.getAttribute("data-sigma-doc-id") ?? null,
    };
  });

  // ブロック中央からつまみまで、実ユーザーのように少しずつポインタを寄せる。ガターと段間の
  // 救済プローブが「ポインタの居る段」を探らないと、この途中でホバーが隣の段や空振りへ
  // 解決し直され、つまみが unmount されて掴めない (これが直したバグの形)。
  const approach = async (blockId: string) => {
    const block = page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
    const box = await block.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    const handle = page.locator(`.page-block-space-handle[data-block-id="${blockId}"]`);
    await expect(handle).toBeVisible();
    const target = await handle.boundingBox();
    const [sx, sy] = [box!.x + box!.width / 2, box!.y + box!.height / 2];
    const [tx, ty] = [target!.x + target!.width / 2, target!.y + target!.height / 2];
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(sx + ((tx - sx) * step) / 12, sy + ((ty - sy) * step) / 12);
      await expect(handle).toBeVisible();
    }
  };

  const setZoom = async (value: string) => {
    await selectUiOptionInPage(page, "ズーム", value);
    await page.waitForTimeout(800);
  };

  for (const zoom of ["100", "150"]) {
    await setZoom(zoom);
    const picks = await pickColumnBlocks();
    expect(picks.first).not.toBeNull();
    expect(picks.second).not.toBeNull();
    await approach(picks.first!);
    await approach(picks.second!);
  }

  // 寄せた後のつまみはそのまま掴めて、その段のブロックへ効く。
  await setZoom("100");
  const picks = await pickColumnBlocks();
  const handle = await hoverBlock(page, picks.second!);
  await dragHandle(page, handle, DRAG_PX);
  await expect.poll(async () => page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    return element ? Number.parseFloat(getComputedStyle(element).paddingBottom || "0") : -1;
  }, picks.second)).toBeGreaterThanOrEqual(DRAG_PX - 2);
});

test("partial columns show only the hovered row handle and switch across rows and columns", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createPartialColumnsDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_in_1"]')).toBeVisible();

  // 常に現在のレーン・高さの 1 単位だけ。各行へ動かすたびに対象が切り替わる。
  for (const id of ["p_in_1", "p_in_2", "p_in_3", "p_in_4"]) {
    await hoverBlock(page, id);
    await expect(page.locator(".page-block-handle")).toHaveCount(1);
    await expect(page.locator(".page-block-space-handle")).toHaveCount(1);
    await expect(page.locator(`.page-block-handle[data-block-id="${id}"]`)).toBeVisible();
    await expect(page.locator(`.page-block-space-handle[data-block-id="${id}"]`)).toBeVisible();
  }

  // 2 段目のブロックを掴んで引くと、そのブロックの下余白として文書に保存される。
  const scale = await readScale(page, "p_in_1");
  const rightColumnId = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="p_in_"]'));
    const lefts = blocks.map((block) => block.getBoundingClientRect().left);
    const firstLeft = Math.min(...lefts);
    return blocks.find((block) => block.getBoundingClientRect().left > firstLeft + 50)
      ?.getAttribute("data-sigma-doc-id") ?? null;
  });
  expect(rightColumnId).not.toBeNull();

  const handle = await hoverBlock(page, rightColumnId!);
  await dragHandle(page, handle, DRAG_PX * scale);

  await expect.poll(async () => page.evaluate((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    return element ? Number.parseFloat(getComputedStyle(element).paddingBottom || "0") : -1;
  }, rightColumnId)).toBeGreaterThanOrEqual(DRAG_PX - 2);
  await expect.poll(async () => page.evaluate(
    () => window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
  )).toContain("spaceAfterPx");
});

test("a sibling lane's nested grid cannot steal the singleton handle", async ({ page }) => {
  await installDesktopRuntimeMock(page, createSiblingNestedColumnsDocument());
  await page.goto("/");
  const target = page.locator('.page-flow [data-sigma-doc-id="right_inner_1"]');
  await expect(target).toBeVisible();

  // Probe from the right outer lane's local gutter while the left sibling's narrower nested
  // grid overlaps the same y range. Width-only selection used to jump across to left_inner_1.
  const grip = page.locator('.page-block-handle[data-block-id="right_inner_1"]');
  const spaceHandle = page.locator('.page-block-space-handle[data-block-id="right_inner_1"]');
  let wiggle = 0;
  await expect.poll(async () => {
    const box = await target.boundingBox();
    if (!box) return false;
    await page.mouse.move(box.x - 10 + (wiggle % 3), box.y + box.height / 2 + (wiggle % 2));
    wiggle += 1;
    return (await grip.isVisible()) && (await spaceHandle.isVisible());
  }, { timeout: 10_000, intervals: [100, 200, 300] }).toBe(true);
  await expect(page.locator('.page-block-handle[data-block-id="right_inner_1"]')).toBeVisible();
  await expect(page.locator('.page-block-space-handle[data-block-id="right_inner_1"]')).toBeVisible();
  await expect(page.locator(".page-block-handle")).toHaveCount(1);
});

test("a partial-column divider appears only near its hit band and follows a cancellable drag", async ({ page }) => {
  await installDesktopRuntimeMock(page, createPartialColumnsDocument());
  await page.goto("/");
  const divider = page.locator(".layout-section-column-resize-handle").first();
  const grid = page.locator(".layout-section-independent-columns").first();
  await expect(divider).toBeAttached();

  await page.mouse.move(5, 5);
  expect(await divider.evaluate((element) => getComputedStyle(element, "::after").opacity)).toBe("0");
  let wiggle = 0;
  await expect.poll(async () => {
    const box = await divider.boundingBox();
    if (!box) return "0";
    await page.mouse.move(5, 5);
    await page.mouse.move(
      box.x + box.width / 2 + (wiggle % 3),
      box.y + 20 + (wiggle % 2),
      { steps: 3 },
    );
    wiggle += 1;
    return divider.evaluate((element) => getComputedStyle(element, "::after").opacity);
  }, { timeout: 10_000, intervals: [100, 200, 300] }).toBe("1");
  const before = (await divider.boundingBox())!;

  const styleBefore = await grid.getAttribute("style");
  await page.mouse.down();
  await page.mouse.move(before.x + 70, before.y + 20, { steps: 8 });
  const during = await divider.boundingBox();
  expect(during!.x).toBeGreaterThan(before.x + 45);
  await page.keyboard.press("Escape");
  const after = await divider.boundingBox();
  expect(Math.abs(after!.x - before.x)).toBeLessThan(2);
  expect(await grid.getAttribute("style")).toBe(styleBefore);
  await page.mouse.up();
});

test("Enter at the bottom of the left partial column extends only that column", async ({ page }) => {
  await installDesktopRuntimeMock(page, createPartialColumnsDocument());
  await page.goto("/");
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_in_2"]')).toBeVisible();

  const sectionBefore = (await page.locator('.page-flow [data-sigma-doc-id="section_1"]').boundingBox())!;
  const rightBefore = (await page.locator('.page-flow [data-sigma-doc-id="p_in_3"]').boundingBox())!;
  const left = page.locator('.page-flow [data-sigma-doc-id="p_in_2"]');
  await left.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("左列で追加");

  const inserted = page.getByText("左列で追加", { exact: true });
  await expect(inserted).toBeVisible();
  const insertedBox = (await inserted.boundingBox())!;
  const sectionAfter = (await page.locator('.page-flow [data-sigma-doc-id="section_1"]').boundingBox())!;
  const rightAfter = (await page.locator('.page-flow [data-sigma-doc-id="p_in_3"]').boundingBox())!;
  expect(insertedBox.x).toBeLessThan(rightAfter.x);
  expect(Math.abs((rightAfter.y - sectionAfter.y) - (rightBefore.y - sectionBefore.y))).toBeLessThan(2);

  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const saved = JSON.parse(raw) as SigmaDocument;
    const section = saved.content.find((block) => block.type === "layoutSection");
    if (!section || section.type !== "layoutSection") return null;
    return {
      columnCount: section.layout.columnCount,
      starts: section.layout.columnStartIds,
      rightIndex: section.children.findIndex((block) => block.id === "p_in_3"),
      insertedIndex: section.children.findIndex((block) => (
        block.type === "paragraph" && block.children.some((child) => child.type === "text" && child.text === "左列で追加")
      )),
    };
  })).toEqual({ columnCount: 2, starts: ["p_in_1", "p_in_3"], rightIndex: 3, insertedIndex: 2 });
});

// Enter 後のスクロールは main でも起きるブラウザ既存の reveal なので、
// 各編集後に対象ブロックを再ホバーしてつまみの位置を確かめる。
test("Enter, Backspace and multiline paste keep partial-column starts stable", async ({ page }) => {
  await installDesktopRuntimeMock(page, createPartialColumnsDocument());
  await page.goto("/");
  const left = page.locator('.page-flow [data-sigma-doc-id="p_in_1"]');
  await left.click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await expectAffordanceOnRenderedEdge(page, "p_in_1");
  await page.keyboard.type("一時行");
  await page.keyboard.press("Home");
  await page.keyboard.press("Backspace");
  await expectAffordanceOnRenderedEdge(page, "p_in_1");

  await page.evaluate(() => {
    const target = document.activeElement;
    if (!(target instanceof HTMLElement)) return;
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", "貼り付け一行目\n貼り付け二行目\n貼り付け三行目");
    target.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }));
  });
  await expectAffordanceOnRenderedEdge(page, "p_in_1");

  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const saved = JSON.parse(raw) as SigmaDocument;
    const section = saved.content.find((block) => block.id === "section_1");
    if (section?.type !== "layoutSection") return null;
    const starts = section.layout.columnStartIds ?? [];
    return {
      columnCount: section.layout.columnCount,
      startCount: starts.length,
      startsAreChildren: starts.every((id) => section.children.some((child) => child.id === id)),
      rightStart: starts[1],
      hasRightTail: section.children.some((child) => child.id === "p_in_4"),
    };
  })).toEqual({
    columnCount: 2,
    startCount: 2,
    startsAreChildren: true,
    rightStart: "p_in_3",
    hasRightTail: true,
  });
});

async function expectAffordanceOnRenderedEdge(page: Page, blockId: string) {
  const block = page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).first();
  await block.scrollIntoViewIfNeeded();
  const handle = await hoverBlock(page, blockId);
  await expect(handle).toBeVisible();

  await expect.poll(async () => page.evaluate((id) => {
    const block = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    const handle = document.querySelector<HTMLElement>(`.page-block-space-handle[data-block-id="${id}"]`);
    if (!block || !handle) return null;
    const blockRect = block.getBoundingClientRect();
    const handleRect = handle.getBoundingClientRect();
    return Math.abs(handleRect.top + handleRect.height / 2 - blockRect.bottom);
  }, blockId)).toBeLessThan(2);
}

test("partial columns inside a problem reach both columns, on the right gutter lanes", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createProblemPartialColumnsDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);
  await expect(page.locator('.page-flow [data-sigma-doc-id="q_1"]')).toBeVisible();

  // 左の段は問題番号・エリア高さハンドルと同居するので 1 レーン外 (problem)。
  const leftHandle = await hoverBlock(page, "q_1");
  await expect(leftHandle).toBeVisible();
  await expect(leftHandle).toHaveAttribute("data-gutter-lane", "problem");

  // 右の段の左に問題 chrome は無い。通常レーンに出て、段間から掴める。
  const rightHandle = await hoverBlock(page, "q_3");
  await expect(rightHandle).toBeVisible();
  await expect(rightHandle).not.toHaveAttribute("data-gutter-lane", "problem");
});

test("the handle lands on the block edge at 150% zoom too", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await selectUiOptionInPage(page, "ズーム", "150");
  await page.waitForTimeout(800);

  const scale = await readScale(page, "p_spaced");
  expect(scale).toBeGreaterThan(1.4);

  const handle = await hoverBlock(page, "p_spaced");
  await expect(handle).toBeVisible();

  const placement = await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    const handleElement = document.querySelector<HTMLElement>('.page-block-space-handle[data-block-id="p_spaced"]');
    const blockRect = block!.getBoundingClientRect();
    const handleRect = handleElement!.getBoundingClientRect();
    return {
      bottomDelta: handleRect.top + handleRect.height / 2 - blockRect.bottom,
      leftDelta: handleRect.right - blockRect.left,
    };
  });

  // つまみは拡大率が変わってもブロックの下端の線に乗る。
  expect(Math.abs(placement.bottomDelta)).toBeLessThan(4);
  // 右端の透明な当たり判定は本文左端に密着する (拡大率ぶんの誤差を許す)。
  expect(placement.leftDelta).toBeLessThanOrEqual(1);

  // 換算も拡大率に追従する: 論理 30px ぶん引いたら 30px ぶん下がる。
  const before = await blockTop(page, "p_after");
  await dragHandle(page, handle, DRAG_PX * scale);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 3);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeLessThanOrEqual(DRAG_PX + 3);
});

test("the handle reaches blocks inside a problem area without covering its own gutter", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createProblemDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const handle = await hoverBlock(page, "p_in_prompt");
  await expect(handle).toBeVisible();

  const overlap = await page.evaluate(() => {
    const handleElement = document.querySelector<HTMLElement>(".page-block-space-handle");
    if (!handleElement) {
      return null;
    }
    const handleRect = handleElement.getBoundingClientRect();
    const intersects = (other: Element | null) => {
      if (!other) {
        return false;
      }
      const rect = other.getBoundingClientRect();
      return handleRect.left < rect.right
        && handleRect.right > rect.left
        && handleRect.top < rect.bottom
        && handleRect.bottom > rect.top;
    };
    return {
      lane: handleElement.getAttribute("data-gutter-lane"),
      hitsAreaResize: Array.from(document.querySelectorAll(".problem-area-resize-handle")).some(intersects),
      hitsNumberMarker: Array.from(document.querySelectorAll(".problem-number-marker")).some(intersects),
      hitsSideNote: Array.from(document.querySelectorAll(".problem-area-side-note")).some(intersects),
    };
  });

  expect(overlap).not.toBeNull();
  expect(overlap!.lane).toBe("problem");
  expect(overlap!.hitsAreaResize).toBe(false);
  expect(overlap!.hitsNumberMarker).toBe(false);
  expect(overlap!.hitsSideNote).toBe(false);
});

test("plain, continued and nested list items draw one saved space at their owned edge", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createListDocument());

  const parent = page.locator('.page-flow [data-sigma-doc-id="li_nested"]');
  const nested = page.locator('.page-flow [data-sigma-doc-id="nested_item"]');
  const parentBox = (await parent.boundingBox())!;
  const nestedBox = (await nested.boundingBox())!;
  for (const x of [nestedBox.x - 2, nestedBox.x - 10, parentBox.x + 2, parentBox.x - 10]) {
    await page.mouse.move(x, nestedBox.y + nestedBox.height / 2);
    await expect(page.locator('.page-block-handle[data-block-id="nested_item"]')).toBeVisible();
    await expect(page.locator('.page-block-space-handle[data-block-id="nested_item"]')).toBeVisible();
    await expect(page.locator(".page-block-handle")).toHaveCount(1);
  }

  for (const id of ["li_plain", "li_continued", "li_nested"]) {
    await expect(await hoverBlock(page, id)).toBeVisible();
    await expect(page.locator(".page-block-space-handle")).toHaveCount(1);
    const scale = await readScale(page, id);
    await dragHandle(page, await hoverBlock(page, id), DRAG_PX * scale);
    await expect.poll(async () => page.evaluate((itemId) => {
      const leading = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${itemId}"]`);
      const item = leading?.closest("li");
      const owned = item
        ? Array.from(item.children).filter((child) => child.tagName !== "UL" && child.tagName !== "OL")
        : [];
      const edge = owned.at(-1);
      return item && leading && edge
        ? {
            itemPadding: Number.parseFloat(getComputedStyle(item).paddingBottom || "0"),
            leadingPadding: Number.parseFloat(getComputedStyle(leading).paddingBottom || "0"),
            edgePadding: Number.parseFloat(getComputedStyle(edge).paddingBottom || "0"),
          }
        : null;
    }, id)).toEqual({
      itemPadding: 0,
      leadingPadding: id === "li_plain" || id === "li_nested" ? DRAG_PX : 0,
      edgePadding: DRAG_PX,
    });
  }

  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) return null;
    const saved = JSON.parse(raw) as SigmaDocument;
    const list = saved.content.find((block) => block.id === "list_spaced");
    return list?.type === "list"
      ? { list: list.spaceAfterPx, items: list.items.map((item) => [item.id, item.spaceAfterPx]) }
      : null;
  })).toEqual({
    list: undefined,
    items: [
      ["li_plain", DRAG_PX],
      ["li_continued", DRAG_PX],
      ["li_nested", DRAG_PX],
    ],
  });
});

test("a page-crossing block below the drag keeps its continuation still", async ({ page }) => {
  test.setTimeout(90_000);

  await openDocument(page, createSplitBlockDocument());
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_tall"]').first()).toBeVisible();
  // 続きの複製が出るまで待つ (この文書のためのフィクスチャ条件そのもの)。
  await expect(page.locator(".editor-box-fragment-viewport").first()).toBeVisible();

  const scale = await readScale(page, "p_head");
  const handle = await hoverBlock(page, "p_head");
  await expect(handle).toBeVisible();

  const before = await page.evaluate(() => {
    const replica = document.querySelector<HTMLElement>(".editor-box-fragment-viewport .ProseMirror");
    return replica ? replica.getBoundingClientRect().top : Number.NaN;
  });
  await grabAndDrag(page, handle, 60 * scale, 10);

  const midDrag = await page.evaluate(() => {
    const replicaEditor = document.querySelector<HTMLElement>(
      ".editor-box-fragment-viewport .ProseMirror",
    );
    const replicaBlock = replicaEditor?.querySelector<HTMLElement>("[data-sigma-doc-id]") ?? null;
    return {
      // 印はモジュールのストアからブロック id で配られる。複製の面が素通しだと、
      // 掴んだページとは別のページのクリップ窓の中身がドラッグ中に一緒に動く。
      marked: replicaBlock?.classList.contains("sigma-space-after-follower") ?? null,
      top: replicaEditor ? replicaEditor.getBoundingClientRect().top : Number.NaN,
    };
  });

  await page.mouse.up();

  expect(midDrag.marked).toBe(false);
  expect(Math.abs(midDrag.top - before)).toBeLessThan(1);
});

test("the handle and the block below it follow the pointer frame by frame", async ({ page }) => {
  test.setTimeout(90_000);

  await openDocument(page, createDocument());
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_after"]')).toBeVisible();

  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");
  const handle = await hoverBlock(page, "p_spaced");
  await expect(handle).toBeVisible();
  const travel = 90 * scale;

  // 離すところまで含めてサンプリングする。継ぎ目 (プレビュー → 確定) で 1 フレームでも
  // 元の位置へ戻れば、下の単調性の判定が落ちる。
  const samples = await sampleFramesDuring(page, ["p_after"], async () => {
    await grabAndDrag(page, handle, travel, 20);
    await page.mouse.up();
  }, 700);

  expectContinuousDescent(samples.map((sample) => sample.tops.p_after), travel);
  expectContinuousDescent(samples.map((sample) => sample.handleTop), travel);

  // 最後は引いた分だけ下がって落ち着く。
  const last = samples[samples.length - 1];
  expect(Math.abs(last.tops.p_after - (before + travel))).toBeLessThan(4 * scale);
});

test("the document is untouched until the pointer is released", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createDocument());
  const scale = await readScale(page, "p_spaced");
  const handle = await hoverBlock(page, "p_spaced");
  await grabAndDrag(page, handle, DRAG_PX * scale, 10);

  const midDrag = await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    return {
      // 正本が変わっていれば、その値は必ず padding として描かれる。
      paddingBottom: block ? Number.parseFloat(getComputedStyle(block).paddingBottom || "0") : -1,
      inlineValue: block?.style.getPropertyValue("--sigma-doc-space-after") ?? "?",
      storage: window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
    };
  });

  expect(midDrag.paddingBottom).toBeLessThan(0.5);
  expect(midDrag.inlineValue).toBe("");
  expect(midDrag.storage).not.toContain("spaceAfterPx");

  await page.mouse.up();

  await expect.poll(async () => page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    return block ? Number.parseFloat(getComputedStyle(block).paddingBottom || "0") : -1;
  })).toBeGreaterThanOrEqual(DRAG_PX - 2);
  await expect.poll(async () => page.evaluate(
    () => window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
  )).toContain("spaceAfterPx");
});

test("dragging freezes the page walk instead of re-running it per pointermove", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createDocument());
  const scale = await readScale(page, "p_spaced");
  const handle = await hoverBlock(page, "p_spaced");
  await expect(handle).toBeVisible();
  // ホバー解決が予約した再計測を消化してから測り始める。
  await page.waitForTimeout(800);

  // 対照実験: まず掴んでいない状態で外因 (字体の遅延ロード) を起こし、それが本当に
  // 再ページ割りの予約まで届くことを確かめる。これが無いと、下の「増えていない」は
  // 「そもそも何も起きない条件だった」でも通ってしまい、凍結を一切証明できない。
  const idle = await readPerformanceCounters(page);
  await announceFontLoad(page, "SigmaE2EProbeIdle");
  await expect.poll(async () => (
    (await readPerformanceCounters(page))["PageCanvasEditor.deferredRecompute"] ?? 0
  )).toBeGreaterThan(idle["PageCanvasEditor.deferredRecompute"] ?? 0);

  const before = await readPerformanceCounters(page);
  await grabAndDrag(page, handle, DRAG_PX * scale, 14);
  // 同じ外因を、今度は掴んだまま起こす。
  await announceFontLoad(page, "SigmaE2EProbeDragging");
  await page.waitForTimeout(250);
  const during = await readPerformanceCounters(page);
  await page.mouse.up();

  const delta = (name: string) => (during[name] ?? 0) - (before[name] ?? 0);
  // ドラッグ中はページ割りを取り直さない。ここが増えると、答えが途中で差し替わって
  // 後続ブロックが「別のページへ一気に移る」ように見える。
  expect(delta("PageCanvasEditor.deferredRecompute")).toBe(0);
  // 装飾の打ち直しは掴んだ瞬間の 1 本だけ (移動量は custom property が運ぶ)。
  expect(delta("TextFlowEditor.refreshDispatch")).toBeLessThanOrEqual(2);

  // 離したら凍結が解け、握りつぶしていた分を含めて 1 回測り直す。
  await expect.poll(async () => (
    (await readPerformanceCounters(page))["PageCanvasEditor.deferredRecompute"] ?? 0
  )).toBeGreaterThan(during["PageCanvasEditor.deferredRecompute"] ?? 0);
});

test("the whole drag is one undo step", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createDocument());
  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");

  await dragHandle(page, await hoverBlock(page, "p_spaced"), DRAG_PX * scale);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);

  await page.keyboard.press("ControlOrMeta+Z");

  await expect.poll(async () => Math.round(Math.abs(await blockTop(page, "p_after") - before) / scale))
    .toBeLessThanOrEqual(2);
});

test("Escape throws the drag away and leaves nothing behind", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createDocument());
  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");

  const handle = await hoverBlock(page, "p_spaced");
  await grabAndDrag(page, handle, 60 * scale, 8);
  expect(await blockTop(page, "p_after")).toBeGreaterThan(before + 20 * scale);

  await page.keyboard.press("Escape");
  await page.mouse.up();

  // 表示が元へ戻り、文書にも入っていない。
  await expect.poll(async () => Math.round(Math.abs(await blockTop(page, "p_after") - before)))
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(
    () => window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
  )).not.toContain("spaceAfterPx");

  // リスナも凍結も残っていない: もう一度掴んで引ける。
  //
  // 同じ画素をすぐもう一度押すと、紙面側の「余白のダブルタップ」(PAGE_DOUBLE_TAP_MS = 450ms /
  // PAGE_DOUBLE_TAP_DISTANCE_PX = 28px) が 2 回目の押下を横取りする。これは本件と無関係の
  // 既存の経路なので、その窓を越えてから掴み直す (人手でも 0.5 秒は空く)。
  await page.waitForTimeout(PAGE_MARGIN_DOUBLE_TAP_WINDOW_MS);
  const again = await hoverBlock(page, "p_spaced");
  await expect(again).toBeVisible();
  await dragHandle(page, again, DRAG_PX * scale);
  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);
});

test("a cancelled pointer discards the drag and unfreezes hover resolution", async ({ page }) => {
  test.setTimeout(60_000);

  await openDocument(page, createDocument());
  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");

  const handle = await hoverBlock(page, "p_spaced");
  await grabAndDrag(page, handle, 60 * scale, 8);

  // タッチのキャンセル / 別ウィンドウへポインタが移ったときに来るイベント。
  await page.evaluate(() => window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true })));
  await page.mouse.up();

  await expect.poll(async () => Math.round(Math.abs(await blockTop(page, "p_after") - before)))
    .toBeLessThanOrEqual(2);
  expect(await page.evaluate(
    () => window.localStorage.getItem("sigma-studio:e2e-document") ?? "",
  )).not.toContain("spaceAfterPx");

  // ホバー解決が復活している (凍結が残っていれば別ブロックのつまみは二度と出ない)。
  await expect(await hoverBlock(page, "p_before")).toBeVisible();
});

test("in page columns only the dragged column moves", async ({ page }) => {
  test.setTimeout(90_000);

  await openDocument(page, createTwoColumnDocument());
  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const picks = await pickColumnNeighbours(page, "p_col_");
  expect(picks.dragged).not.toBeNull();
  expect(picks.sameColumnBelow).not.toBeNull();
  expect(picks.otherColumn).not.toBeNull();

  const handle = await hoverBlock(page, picks.dragged!);
  await expect(handle).toBeVisible();
  const ids = [picks.sameColumnBelow!, picks.otherColumn!];
  const beforeTops = await topsOf(page, ids);

  const samples = await sampleFramesDuring(page, ids, async () => {
    await grabAndDrag(page, handle, 40, 14);
  });
  await page.mouse.up();

  const followerSeries = samples.map((sample) => sample.tops[picks.sameColumnBelow!]);
  expectContinuousDescent(followerSeries, 40);

  const neighbourSeries = samples
    .map((sample) => sample.tops[picks.otherColumn!])
    .filter((value) => Number.isFinite(value));
  // 隣の段は 1px も動かない。
  expect(Math.max(...neighbourSeries) - Math.min(...neighbourSeries)).toBeLessThan(1);
  expect(Math.abs(neighbourSeries[neighbourSeries.length - 1] - beforeTops[picks.otherColumn!]))
    .toBeLessThan(1);
});

test("in a problem's own columns only the dragged column moves", async ({ page }) => {
  test.setTimeout(90_000);

  await openDocument(page, createProblemPartialColumnsDocument());
  await expect(page.locator('.page-flow [data-sigma-doc-id="q_1"]')).toBeVisible();

  const handle = await hoverBlock(page, "q_1");
  await expect(handle).toBeVisible();
  const ids = ["q_2", "q_3"];
  const beforeTops = await topsOf(page, ids);

  const samples = await sampleFramesDuring(page, ids, async () => {
    await grabAndDrag(page, handle, 40, 14);
  });
  await page.mouse.up();

  expectContinuousDescent(samples.map((sample) => sample.tops.q_2), 40);

  const neighbourSeries = samples.map((sample) => sample.tops.q_3).filter((value) => Number.isFinite(value));
  expect(Math.max(...neighbourSeries) - Math.min(...neighbourSeries)).toBeLessThan(1);
  expect(Math.abs(neighbourSeries[neighbourSeries.length - 1] - beforeTops.q_3)).toBeLessThan(1);
});

test("the drag stays continuous at 150% zoom", async ({ page }) => {
  test.setTimeout(90_000);

  await openDocument(page, createDocument());
  await selectUiOptionInPage(page, "ズーム", "150");
  await page.waitForTimeout(800);

  const scale = await readScale(page, "p_spaced");
  expect(scale).toBeGreaterThan(1.4);
  const before = await blockTop(page, "p_after");
  const handle = await hoverBlock(page, "p_spaced");
  const travel = 60 * scale;

  const samples = await sampleFramesDuring(page, ["p_after"], async () => {
    await grabAndDrag(page, handle, travel, 16);
    await page.mouse.up();
  }, 700);

  expectContinuousDescent(samples.map((sample) => sample.tops.p_after), travel);
  // 画面 px で引いた分だけ画面 px で下がる (ズーム換算が両側で一致している)。
  const last = samples[samples.length - 1];
  expect(Math.abs(last.tops.p_after - (before + travel))).toBeLessThan(5 * scale);
});

async function topsOf(page: Page, blockIds: readonly string[]): Promise<Record<string, number>> {
  return page.evaluate((ids) => Object.fromEntries(ids.map((id) => {
    const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
    return [id, element ? element.getBoundingClientRect().top : Number.NaN];
  })), blockIds as string[]);
}

/**
 * 段組の中から「掴む段落」「その直下 (同じ段)」「隣の段の段落」を選ぶ。
 * 段の割り当てはブラウザが決めるので、id からは決め打ちできない。
 */
async function pickColumnNeighbours(page: Page, idPrefix: string): Promise<{
  dragged: string | null;
  sameColumnBelow: string | null;
  otherColumn: string | null;
}> {
  return page.evaluate((prefix) => {
    const blocks = Array.from(
      document.querySelectorAll<HTMLElement>(`.page-flow [data-sigma-doc-id^="${prefix}"]`),
    ).map((element) => ({
      id: element.getAttribute("data-sigma-doc-id") ?? "",
      rect: element.getBoundingClientRect(),
    }));
    const firstLeft = Math.min(...blocks.map((block) => block.rect.left));
    const firstColumn = blocks.filter((block) => Math.abs(block.rect.left - firstLeft) < 5);
    const otherColumn = blocks.filter((block) => block.rect.left > firstLeft + 50);
    return {
      dragged: firstColumn[0]?.id ?? null,
      sameColumnBelow: firstColumn[1]?.id ?? null,
      otherColumn: otherColumn[0]?.id ?? null,
    };
  }, idPrefix);
}

test("the handle stays put while dragging, even when the pointer leaves the block", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const scale = await readScale(page, "p_spaced");
  const before = await blockTop(page, "p_after");
  const handle = await hoverBlock(page, "p_spaced");
  const box = await handle.boundingBox();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  // 掴んだままブロックの外へ大きく出る。ホバー解決を凍結していないと、ここで
  // affordance が空になってつまみごと unmount される。
  await page.mouse.move(5, y + 40 * scale, { steps: 6 });

  await expect(page.locator('.page-block-space-handle[data-block-id="p_spaced"]')).toBeVisible();

  await page.mouse.up();

  await expect.poll(async () => Math.round((await blockTop(page, "p_after") - before) / scale))
    .toBeGreaterThanOrEqual(38);
});

/**
 * 問題・囲み枠の直前のブロックでは、同じ辺に「ここに本文を追加」の ＋ が出る
 * (キャレットが入れない隙間だから)。人は本文の下端へ寄ってから左のつまみへ滑らせるので、
 * ＋ がつまみと同じレーンに重なっていると、押しても何も起きない = 高さを変えられない。
 */
test("a block above a problem can still be grabbed from the text side", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createParagraphAboveProblemDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const scale = await readScale(page, "p_head");
  const before = await blockBox(page, "p_head");

  // 本文の中で下端へ寄る → ＋ と下端つまみが同時に出る辺。
  await page.mouse.move(before.left + 60, before.bottom - 10);
  await page.waitForTimeout(80);
  await page.mouse.move(before.left + 40, before.bottom - 3);
  await page.waitForTimeout(150);
  await expect(page.locator(".page-block-insert-button")).toHaveCount(1);

  // そのまま左のガターへ滑らせて、つまみを掴む。
  for (let x = before.left + 20; x >= before.left - 15; x -= 4) {
    await page.mouse.move(x, before.bottom - 1);
    await page.waitForTimeout(24);
  }
  await page.mouse.move(before.left - 15, before.bottom);
  await page.waitForTimeout(120);

  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(before.left - 15, before.bottom + (DRAG_PX * scale * step) / 8);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  await expect.poll(async () => Math.round(((await blockBox(page, "p_head")).height - before.height) / scale))
    .toBeGreaterThanOrEqual(DRAG_PX - 2);

  // 縮める側も同じ経路で。伸ばした後は下端が本文から離れるので、寄る経路は必ず本文側になる。
  const grown = await blockBox(page, "p_head");
  await page.mouse.move(grown.left + 60, grown.bottom - 20);
  await page.waitForTimeout(80);
  await page.mouse.move(grown.left + 40, grown.bottom - 3);
  await page.waitForTimeout(150);
  for (let x = grown.left + 20; x >= grown.left - 15; x -= 4) {
    await page.mouse.move(x, grown.bottom - 1);
    await page.waitForTimeout(24);
  }
  await page.mouse.move(grown.left - 15, grown.bottom);
  await page.waitForTimeout(120);

  await page.mouse.down();
  for (let step = 1; step <= 8; step += 1) {
    await page.mouse.move(grown.left - 15, grown.bottom - (20 * scale * step) / 8);
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  await expect.poll(async () => Math.round(((await blockBox(page, "p_head")).height - grown.height) / scale))
    .toBeLessThanOrEqual(-18);
});

test("the insert button beside that edge still adds a paragraph", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createParagraphAboveProblemDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const before = await blockBox(page, "p_head");
  await page.mouse.move(before.left + 60, before.bottom - 10);
  await page.waitForTimeout(80);
  await page.mouse.move(before.left + 40, before.bottom - 3);
  await page.waitForTimeout(150);

  const insert = page.locator(".page-block-insert-button");
  await expect(insert).toHaveCount(1);
  await insert.click();

  // 問題の手前に段落が 1 つ増える。
  await expect.poll(async () => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document") ?? "{}";
    return (JSON.parse(raw) as { content?: unknown[] }).content?.length ?? 0;
  })).toBe(3);
});

test("the handle never reaches the PDF surface", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createDocument({ spaceAfterPx: 40 }));
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);

  // 紙面の上をひととおりなぞる (編集面ならどこかでつまみが出る動き)。
  const surface = page.locator(".paged-surface").first();
  const box = await surface.boundingBox();
  for (const ratio of [0.2, 0.4, 0.6]) {
    await page.mouse.move(box!.x + box!.width * 0.5, box!.y + box!.height * ratio);
    await page.waitForTimeout(120);
  }

  // 編集専用のアフォーダンスは紙面 (= PDF の元) に一切出ない。
  await expect(page.locator(".page-block-space-handle")).toHaveCount(0);
  await expect(page.locator(".page-block-affordance-layer")).toHaveCount(0);
});

/**
 * 伸ばした余白の下端がフッター帯へ入っても、掴み直して縮められる。
 *
 * フッター帯 (`.page-running-editor-band`) はダブルタップで直接編集に入るので当たり判定を
 * 持ち、本文より前面に敷かれている。ページ下余白の側にあるので普段は本文と重ならないが、
 * 下余白を伸ばすとブロックの下端がそこへ入る。当たり判定を最前面の 1 枚だけで見ていた頃は、
 * そこで「ブロックが居ない」に倒れて左ガターのアフォーダンスがまるごと消え、伸ばした余白を
 * 二度と掴めなかった。
 */
test("the handle survives when the grown space reaches the footer band", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createFooterBandDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const footerBand = page.locator(".page-running-editor-band.footer").first();
  await expect(footerBand).toHaveCount(1);
  const band = await footerBand.boundingBox();

  // 下端を帯の中まで伸ばす。ここが「掴めなくなっていた」位置。
  const start = await blockBox(page, "p_spaced");
  const travel = band!.y + band!.height - 6 - start.bottom;
  expect(travel).toBeGreaterThan(20);
  await dragHandle(page, await hoverBlock(page, "p_spaced"), travel);

  const grown = await blockBox(page, "p_spaced");
  expect(grown.bottom).toBeGreaterThan(band!.y);
  expect(grown.bottom).toBeLessThan(band!.y + band!.height);

  const handle = page.locator('.page-block-space-handle[data-block-id="p_spaced"]');

  // 左ガターの、つまみの少し上 — 帯に覆われていて、つまみ自身の当たり判定にはまだ入って
  // いない一点。ここで解決が空振りすると、寄っていく途中でつまみが unmount される。
  const probeY = grown.bottom - 14;
  expect(probeY).toBeGreaterThan(band!.y);
  await page.mouse.move(grown.left + 40, grown.top + 6);
  await expect(handle).toBeVisible();
  await page.mouse.move(grown.left - 12, probeY);
  await expect(handle).toBeVisible();

  // 本文から左ガターのつまみへ寄せる間も、つまみは一度も消えない。
  await page.mouse.move(grown.left + 40, grown.top + 6);
  const target = await handle.boundingBox();
  const [sx, sy] = [grown.left + 40, grown.top + 6];
  const [tx, ty] = [target!.x + target!.width / 2, target!.y + target!.height / 2];
  for (let step = 1; step <= 12; step += 1) {
    await page.mouse.move(sx + ((tx - sx) * step) / 12, sy + ((ty - sy) * step) / 12);
    await expect(handle).toBeVisible();
  }

  // そのまま掴んで縮められる。
  const before = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    return element ? Number.parseFloat(getComputedStyle(element).paddingBottom || "0") : -1;
  });
  await dragHandle(page, handle, -DRAG_PX);
  await expect.poll(async () => page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('.page-flow [data-sigma-doc-id="p_spaced"]');
    return element ? Number.parseFloat(getComputedStyle(element).paddingBottom || "0") : -1;
  })).toBeLessThanOrEqual(before - DRAG_PX + 2);
});

function baseDocument(docId: string): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = docId;
  document.metadata = { title: "下端つまみ e2e" };
  document.comments = [];
  return document;
}

/**
 * フッター帯がページ下余白に敷かれた紙面。帯の上端は本文領域の下端のすぐ下なので、
 * 下余白を少し伸ばしただけでブロックの下端が帯の中へ入る。
 */
function createFooterBandDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_footer_band");
  document.content = [
    { type: "paragraph", id: "p_spaced", children: [{ type: "text", text: "下端を掴む段落" }] },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "つまみの後の段落" }] },
  ];
  document.pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 110 },
    marginsMm: { top: 10, right: 16, bottom: 18, left: 16 },
    footer: {
      enabled: true,
      heightMm: 12.5,
      offsetMm: 5,
      showOnFirstPage: true,
      blocks: [
        {
          type: "paragraph",
          id: "page_footer_running_body",
          children: [{ type: "text", text: "{page}" }],
          align: "center",
        },
      ],
    },
  });
  return document;
}

function createDocument(options: { spaceAfterPx?: number } = {}): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_handle");
  document.content = [
    { type: "paragraph", id: "p_before", children: [{ type: "text", text: "つまみの前の段落" }] },
    {
      type: "paragraph",
      id: "p_spaced",
      children: [{ type: "text", text: "下端を掴む段落" }],
      ...(options.spaceAfterPx ? { spaceAfterPx: options.spaceAfterPx } : {}),
    },
    { type: "paragraph", id: "p_after", children: [{ type: "text", text: "つまみの後の段落" }] },
  ];
  return document;
}

function createTwoColumnDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_handle_columns");
  document.content = Array.from({ length: 14 }, (_, index) => ({
    type: "paragraph" as const,
    id: `p_col_${index + 1}`,
    children: [{ type: "text" as const, text: `段組の段落 ${index + 1}` }],
  }));
  document.pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 90 },
    marginsMm: { top: 10, right: 16, bottom: 10, left: 16 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  });
  return document;
}

function createPartialColumnsDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_partial_columns");
  document.content = [
    { type: "paragraph", id: "p_head", children: [{ type: "text", text: "段組の前の段落" }] },
    {
      type: "layoutSection",
      id: "section_1",
      layout: {
        columnCount: 2,
        columnStartIds: ["p_in_1", "p_in_3"],
        columnWidths: [5000, 5000],
      },
      children: [
        { type: "paragraph", id: "p_in_1", children: [{ type: "text", text: "局所段組の段落 1" }] },
        { type: "paragraph", id: "p_in_2", children: [{ type: "text", text: "局所段組の段落 2" }] },
        { type: "paragraph", id: "p_in_3", children: [{ type: "text", text: "局所段組の段落 3" }] },
        { type: "paragraph", id: "p_in_4", children: [{ type: "text", text: "局所段組の段落 4" }] },
      ],
    },
    { type: "paragraph", id: "p_tail", children: [{ type: "text", text: "段組の後の段落" }] },
  ];
  return document;
}

function createProblemPartialColumnsDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_problem_partial_columns");
  document.content = [{
    type: "problem",
    id: "problem_columns",
    tags: [],
    lead: [],
    prompt: [
      { type: "paragraph", id: "p_intro", children: [{ type: "text", text: "問題文の導入" }] },
      {
        type: "layoutSection",
        id: "section_p",
        layout: {
          columnCount: 2,
          columnStartIds: ["q_1", "q_3"],
          columnWidths: [5000, 5000],
        },
        children: [
          { type: "paragraph", id: "q_1", children: [{ type: "text", text: "(1) 左の設問" }] },
          { type: "paragraph", id: "q_2", children: [{ type: "text", text: "(2) 左の設問の続き" }] },
          { type: "paragraph", id: "q_3", children: [{ type: "text", text: "(3) 右の設問" }] },
          { type: "paragraph", id: "q_4", children: [{ type: "text", text: "(4) 右の設問の続き" }] },
        ],
      },
    ],
    solution: [],
    hints: [],
    numbering: { enabled: true, value: 1 },
  }];
  return document;
}

function createSiblingNestedColumnsDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_sibling_nested_columns");
  const nestedBox = (side: "left" | "right") => ({
    type: "boxBlock" as const,
    id: `${side}_box`,
    styleId: "fancybox",
    blocks: [{
      type: "layoutSection" as const,
      id: `${side}_inner_section`,
      layout: {
        columnCount: 2,
        columnStartIds: [`${side}_inner_1`, `${side}_inner_2`],
        columnWidths: side === "left" ? [3500, 6500] : [5000, 5000],
      },
      children: [
        { type: "paragraph" as const, id: `${side}_inner_1`, children: [{ type: "text" as const, text: `${side} 1` }] },
        { type: "paragraph" as const, id: `${side}_inner_2`, children: [{ type: "text" as const, text: `${side} 2` }] },
      ],
    }],
  });
  document.content = [{
    type: "layoutSection",
    id: "outer_section",
    layout: {
      columnCount: 2,
      columnStartIds: ["left_box", "right_box"],
      columnWidths: [5000, 5000],
    },
    children: [nestedBox("left"), nestedBox("right")],
  }];
  return document;
}

/** 問題の直前に本文ブロックが 1 つある紙面。その境目には ＋ と下端つまみが同居する。 */
function createParagraphAboveProblemDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_above_problem");
  document.content = [
    { type: "paragraph", id: "p_head", children: [{ type: "text", text: "問題の前の段落" }] },
    {
      type: "problem",
      id: "problem_below",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "p_in_prompt", children: [{ type: "text", text: "問題文の段落" }] }],
      solution: [],
      hints: [],
      numbering: { enabled: true, value: 1 },
    },
  ];
  return document;
}

function createProblemDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_handle_problem");
  document.content = [{
    type: "problem",
    id: "problem_handle",
    tags: [],
    lead: [],
    prompt: [
      { type: "paragraph", id: "p_in_prompt", children: [{ type: "text", text: "問題文の段落" }] },
      { type: "paragraph", id: "p_in_prompt_2", children: [{ type: "text", text: "問題文の 2 行目" }] },
    ],
    solution: [],
    hints: [],
    numbering: { enabled: true, value: 1 },
  }];
  return document;
}

/**
 * 掴むブロックの下に「ページを跨いで分割されるブロック」がある紙面。
 *
 * 分割されたブロックは正本のクリップと **続きの複製** の 2 面で描かれ、複製は正本と同じ
 * ブロック id を持つ。追従の印は id で配られるので、面ごとの出し分けが無いと別ページの
 * 複製まで動く。
 */
function createSplitBlockDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_split_block");
  document.content = [
    { type: "paragraph", id: "p_head", children: [{ type: "text", text: "つまみを掴む段落" }] },
    {
      type: "quote",
      id: "p_tall",
      blocks: Array.from({ length: 14 }, (_, index) => ({
        type: "paragraph" as const,
        id: `p_tall_line_${index + 1}`,
        children: [{ type: "text" as const, text: `ページを跨ぐ引用の ${index + 1} 行目` }],
      })),
    },
    { type: "paragraph", id: "p_tail", children: [{ type: "text", text: "分割の後の段落" }] },
  ];
  document.pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 120 },
    marginsMm: { top: 12, right: 16, bottom: 12, left: 16 },
  });
  return document;
}

function createListDocument(): SigmaDocument {
  const document = baseDocument("doc_e2e_space_after_handle_list");
  document.content = [
    {
      type: "list",
      id: "list_spaced",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_plain", children: [{ type: "text", text: "通常項目" }] },
        {
          type: "listItem",
          id: "li_continued",
          children: [{ type: "text", text: "継続項目" }],
          continuations: [{ type: "paragraph", id: "li_continuation", children: [{ type: "text", text: "継続行" }] }],
        },
        {
          type: "listItem",
          id: "li_nested",
          children: [{ type: "text", text: "入れ子の親" }],
          nested: [{
            type: "list",
            id: "nested_list",
            listType: "bullet",
            items: [{ type: "listItem", id: "nested_item", children: [{ type: "text", text: "入れ子" }] }],
          }],
        },
      ],
    },
    { type: "paragraph", id: "p_list_after", children: [{ type: "text", text: "リストの後" }] },
  ];
  return document;
}
