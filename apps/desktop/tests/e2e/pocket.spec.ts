import { expect, test, type Locator, type Page } from "@playwright/test";

import { getDefaultPageLayout, type OverlayShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDocumentTabMock } from "./document-tab-mock";

/**
 * ポケット: 編集画面の上の一時置き場。
 *
 * 入れたものは、コピーして貼るのと同じ内容で、別のページや別の教材へ何度でも挿入できる。
 * 教材にもクリップボードにも載らない。ここでは「入れる」「別の教材タブへ挿入する」
 * 「クリップボードを書き換えない」「紙面の高さを壊さない」を実ブラウザで固定する。
 */

const SOURCE_TEXT = "ポケットへ入れる文章";

function shapes(): OverlayShape[] {
  return [
    {
      id: "pocket_rect",
      type: "geo",
      x: 60,
      y: 420,
      rotation: 0,
      props: {
        w: 140,
        h: 80,
        geo: "rectangle",
        fill: "solid",
        color: "#1133cc",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
  ] as OverlayShape[];
}

function sourceDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_pocket_source",
    metadata: { title: "教材A" },
    content: [
      {
        type: "paragraph",
        id: "pocket_body",
        children: [
          { type: "text", text: `${SOURCE_TEXT} ` },
          { type: "mathInline", id: "pocket_math", tex: "x^2+1", display: "inline", semanticRole: "expression" },
          { type: "text", text: " です" },
        ],
      },
      { type: "paragraph", id: "pocket_other", children: [{ type: "text", text: "別の段落" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot: { version: 1, shapes: shapes(), assets: {} } },
    },
  } as SigmaDocument;
}

/** 「新規教材」で開く 2 枚目のタブ。本文は 1 段落、図形は 0 個から始まる。 */
function blankDocument(): SigmaDocument {
  const source = sourceDocument();
  return {
    ...source,
    docId: "doc_pocket_blank",
    metadata: { title: "教材B" },
    content: [{ type: "paragraph", id: "pocket_blank_body", children: [{ type: "text", text: "貼り付け先" }] }],
    pageLayout: {
      ...source.pageLayout!,
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  } as SigmaDocument;
}

/**
 * 開閉と「飛んでいく」の動きを止める。動きの最中は、ポケットが開く分だけ紙面や本文の座標が動き続けるので、
 * 座標を測って押すテストは、動きを減らす設定で走らせる。動きそのもののテストだけ、あとから有効にする
 * (`enableMotion`)。
 */
async function reduceMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "reduce" });
}

async function enableMotion(page: Page): Promise<void> {
  await page.emulateMedia({ reducedMotion: "no-preference" });
}

async function openEditor(page: Page): Promise<void> {
  await reduceMotion(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDocumentTabMock(page, sourceDocument(), blankDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** 本文の 1 行を端から端までドラッグして選ぶ。 */
async function selectSourceLine(page: Page): Promise<void> {
  const box = await page.locator('[data-sigma-doc-id="pocket_body"]').first().boundingBox();
  if (!box) throw new Error("source paragraph is not visible");
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 6, y);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("です");
}

async function selectRectangle(page: Page): Promise<void> {
  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="pocket_rect"]').first());
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="pocket_rect"]')).toHaveCount(1);
}

/** 本文へ戻す。オーバーレイ編集中のままタブを増やすと、切り替えが間に合わないことがある。 */
async function exitOverlayEditing(page: Page): Promise<void> {
  const body = await page.locator('[data-sigma-doc-id="pocket_other"]').first().boundingBox();
  expect(body).not.toBeNull();
  await page.mouse.click(body!.x + body!.width - 8, body!.y + body!.height / 2);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
}

async function openSecondTab(page: Page): Promise<void> {
  await exitOverlayEditing(page);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect(page.locator('[data-sigma-doc-id="pocket_blank_body"]').first()).toBeVisible();
}

/**
 * 図形を貼ると、その図形が選ばれて浮遊ツールバーが上に出る。図形が紙面の上端に近いと、その
 * ツールバーがポケットのカードに重なる (クロームに重なるのと同じ既存の挙動) ので、
 * 次のカードを押す前に選択を外す。
 */
async function deselectShapes(page: Page): Promise<void> {
  // Escape は本文にフォーカスがあると図形まで届かないので、図形のない紙面の空白を押す。
  await page.mouse.click(600, 820);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
}

const pocket = (page: Page) => page.locator("[data-pocket-root]");
const cards = (page: Page) => page.locator("[data-pocket-item] button[data-kind]");

async function shapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(
    Array.from(window.document.querySelectorAll<HTMLElement>("[data-overlay-shape-id]"))
      .map((element) => element.dataset.overlayShapeId ?? "")
      .filter(Boolean),
  )]);
}

/** 紙面の縦スクロールが画面全体に出ていない (ポケットの分だけ紙面が縮んでいる) こと。 */
async function pageFitsViewport(page: Page): Promise<{ overflow: number; workspaceBottom: number; innerHeight: number }> {
  return page.evaluate(() => {
    const root = window.document.documentElement;
    const workspace = window.document.querySelector("main.workspace");
    return {
      overflow: root.scrollHeight - root.clientHeight,
      workspaceBottom: Math.round(workspace?.getBoundingClientRect().bottom ?? -1),
      innerHeight: window.innerHeight,
    };
  });
}

test("stays out of the way until something is put in it", async ({ page }) => {
  await openEditor(page);

  await expect(pocket(page)).toHaveCount(0);
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);
});

test("puts selected body text in the pocket, previews it, and keeps the clipboard untouched", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  // 先に通常のコピーで「別のもの」をクリップボードへ置く。ポケットへ入れても、これが貼り付けられる。
  await page.keyboard.press("ControlOrMeta+C");

  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "shapes");
  await expect(cards(page).first().locator("img")).toBeVisible();
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);

  await exitOverlayEditing(page);
  const other = await page.locator('[data-sigma-doc-id="pocket_other"]').first().boundingBox();
  await page.mouse.click(other!.x + other!.width - 4, other!.y + other!.height / 2);
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  // ⌘V が貼るのは通常のコピー (本文)。ポケットに入れた図形ではない。
  await expect(page.locator('[data-sigma-doc-id="pocket_other"]').first()).toContainText(SOURCE_TEXT);
  expect(await shapeIds(page)).toEqual(["pocket_rect"]);
});

test("renders a text card as the real thing, formulas included", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");
  await expect(cards(page).first()).toContainText(SOURCE_TEXT);
  await expect(cards(page).first().locator(".inline-math-node").first()).toBeVisible();
  // 紙面の同じ ID の要素を増やさない (ID で探す処理が取り違える)。
  await expect(page.locator('[data-sigma-doc-id="pocket_body"]')).toHaveCount(1);
});

test("carries text and a shape to another material and keeps them for reuse", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(2);

  await openSecondTab(page);
  // タブを切り替えても、ポケットはそのまま残っている。
  await expect(cards(page)).toHaveCount(2);

  const blank = await page.locator('[data-sigma-doc-id="pocket_blank_body"]').first().boundingBox();
  await page.mouse.click(blank!.x + blank!.width - 4, blank!.y + blank!.height / 2);
  await page.keyboard.press("End");
  await cards(page).nth(0).click();
  await expect(page.locator(".app-shell")).toContainText(SOURCE_TEXT);
  // 挿入後もキャレットは本文に残り、続けて入力できる。
  await page.keyboard.type("続き");
  await expect(page.locator('[data-sigma-doc-id="pocket_blank_body"]').first()).toContainText("貼り付け先");

  await cards(page).nth(1).click();
  await expect.poll(() => shapeIds(page)).toHaveLength(1);
  expect((await shapeIds(page))[0]).not.toBe("pocket_rect");

  // 何度でも入れられる。項目は減らない。
  await deselectShapes(page);
  await cards(page).nth(1).click();
  await expect.poll(() => shapeIds(page)).toHaveLength(2);
  await expect(cards(page)).toHaveCount(2);
});

test("removes a card, undoes it, and clears everything", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(2);

  await cards(page).first().hover();
  await pocket(page).getByRole("button", { name: "ポケットから外す" }).first().click();
  await expect(cards(page)).toHaveCount(1);
  await pocket(page).getByRole("button", { name: "元に戻す" }).click();
  await expect(cards(page)).toHaveCount(2);
  // 元の並び (本文が先頭) に戻る。
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");

  await pocket(page).getByRole("button", { name: "すべて外す" }).click();
  await expect(cards(page)).toHaveCount(0);
  await pocket(page).getByRole("button", { name: "元に戻す" }).click();
  await expect(cards(page)).toHaveCount(2);
});

test("scrolls a long row of cards sideways, with the mouse wheel too", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  for (let count = 0; count < 12; count += 1) {
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  }
  await expect(cards(page)).toHaveCount(12);

  const strip = pocket(page).getByRole("list", { name: "ポケットの中身" });
  const scroll = () => strip.evaluate((element) => ({ left: element.scrollLeft, overflows: element.scrollWidth > element.clientWidth }));
  // 入れた直後は、最後に入れたカードが見える端まで送られている。
  await expect.poll(async () => (await scroll()).overflows).toBe(true);
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);

  const box = await strip.boundingBox();
  await page.mouse.move(box!.x + 300, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -4000);
  await expect.poll(async () => (await scroll()).left).toBe(0);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);
});

test("says so when nothing is selected, instead of silently doing nothing", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-sigma-doc-id="pocket_other"]').first().click();
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");

  await expect(pocket(page)).toBeVisible();
  await expect(pocket(page)).toContainText("入れるものが選ばれていません");
  await expect(cards(page)).toHaveCount(0);
});

/** 畳んだポケットの上部 (段の上端から少し下) へマウスを持っていく。チップが現れる。 */
async function hoverClosedPocketTop(page: Page): Promise<void> {
  const bar = (await pocket(page).boundingBox())!;
  await page.mouse.move(40, bar.y + 200);
  await page.mouse.move(700, bar.y + 12, { steps: 4 });
}

test("collapses without taking any room, and reopens from the chip", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  const expanded = await pocket(page).boundingBox();
  const paperTopOpen = (await page.locator('[data-sigma-doc-id="pocket_body"]').first().boundingBox())!.y;

  await pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click();
  const collapsed = await pocket(page).boundingBox();
  expect(collapsed!.height).toBeLessThan(expanded!.height / 2);
  // 畳むと、紙面はポケットの分だけ上へ戻る (ポケットが無いときと同じ位置)。
  const paperTopClosed = (await page.locator('[data-sigma-doc-id="pocket_body"]').first().boundingBox())!.y;
  expect(paperTopClosed).toBeLessThan(paperTopOpen - expanded!.height / 2);
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);

  await hoverClosedPocketTop(page);
  await pocket(page).getByRole("button", { name: /ポケット 1件/ }).click();
  await expect(cards(page)).toHaveCount(1);
});

test("keeps the page inside the window with the pocket open", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  const fit = await pageFitsViewport(page);
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.workspaceBottom).toBeLessThanOrEqual(fit.innerHeight);
  // ポケットは本文の真上、クロームの真下に隣接する。
  const geometry = await page.evaluate(() => {
    const bar = window.document.querySelector("[data-pocket-root]")?.getBoundingClientRect();
    const workspace = window.document.querySelector("main.workspace")?.getBoundingClientRect();
    const chrome = window.document.querySelector("header.editor-menubar")?.getBoundingClientRect();
    return {
      barTop: Math.round(bar?.top ?? -1),
      barBottom: Math.round(bar?.bottom ?? -1),
      workspaceTop: Math.round(workspace?.top ?? -1),
      chromeBottom: Math.round(chrome?.bottom ?? -1),
    };
  });
  expect(geometry.barBottom).toBe(geometry.workspaceTop);
  expect(geometry.barTop).toBe(geometry.chromeBottom);
});

test("puts the selection in the pocket from the selection toolbar and keeps the selection", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.getByRole("button", { name: "ポケットに追加" }).click();
  await expect(cards(page)).toHaveCount(1);
  // 押しても選択は動かない。続けて別のものを選んで入れられる。
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("です");

  await selectRectangle(page);
  await page.getByRole("button", { name: "ポケットに追加" }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1)).toHaveAttribute("data-kind", "shapes");
});

test("runs from the command palette without a keyboard shortcut", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+KeyP");
  await page.getByPlaceholder("コマンドや設定を検索").fill("ポケット");
  await page.getByRole("option", { name: /選んだものをポケットに入れる/ }).click();

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");
});

/** カードを掴んで画面の (x, y) まで運んで離す。本物のマウス操作なので、ブラウザの drag & drop が走る。 */
async function dragChipTo(page: Page, chip: Locator, x: number, y: number): Promise<void> {
  const box = await chip.boundingBox();
  if (!box) throw new Error("card is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 12, box.y + box.height / 2 + 12, { steps: 4 });
  await page.mouse.move(x, y, { steps: 16 });
  await page.mouse.up();
}

test("shows the closed pocket as a small chip at the top centre, only while the pointer is up there", async ({ page }) => {
  await openEditor(page);
  await enableMotion(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  await pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click();
  const handle = pocket(page).getByRole("button", { name: /ポケット 1件/ });
  const opacity = () => handle.evaluate((element) => parseFloat(getComputedStyle(element).opacity));

  // マウスが上にいないあいだは見えず、その下の紙面を操作できる (チップはマウスを受けない)。
  const bar = (await pocket(page).boundingBox())!;
  await page.mouse.move(700, bar.y + 300);
  await expect.poll(opacity).toBe(0);
  expect(await handle.evaluate((element) => getComputedStyle(element).pointerEvents)).toBe("none");

  // 上部へマウスを持っていくと現れる。
  await page.mouse.move(700, bar.y + 12, { steps: 4 });
  await expect.poll(opacity).toBe(1);
  const chip = (await handle.boundingBox())!;
  const viewport = page.viewportSize()!;
  // 上部の真ん中。丸い小さなチップで、帯いっぱいには広がらない。
  expect(Math.abs(chip.x + chip.width / 2 - viewport.width / 2)).toBeLessThanOrEqual(2);
  expect(chip.width).toBeLessThan(viewport.width / 4);
  expect(chip.height).toBeLessThanOrEqual(28);
  const radius = await handle.evaluate((element) => parseFloat(getComputedStyle(element).borderTopLeftRadius));
  expect(radius).toBeGreaterThanOrEqual(chip.height / 2 - 1);
  // 帯そのものには枠も背景も無い。
  const band = await pocket(page).evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, borderBottom: style.borderBottomWidth };
  });
  expect(band.background).toBe("rgba(0, 0, 0, 0)");
  expect(band.borderBottom).toBe("0px");

  // 離れると、少しして引っ込む。
  await page.mouse.move(700, bar.y + 300, { steps: 4 });
  await expect.poll(opacity).toBe(0);

  // 開くと、中身のカードが元のとおり並ぶ。
  await page.mouse.move(700, bar.y + 12, { steps: 4 });
  await expect.poll(opacity).toBe(1);
  await handle.click();
  await expect(cards(page)).toHaveCount(1);
});

/** 動いている間の、バーの高さと紙面の上端を、フレームごとに記録する。 */
async function sampleFrames(page: Page, run: () => Promise<void>, ms = 700): Promise<Array<{ t: number; bar: number; barBottom: number; paper: number }>> {
  await page.evaluate(() => {
    const frames: Array<{ t: number; bar: number; barBottom: number; paper: number }> = [];
    (window as unknown as { __frames: typeof frames; __sampling: boolean }).__frames = frames;
    (window as unknown as { __sampling: boolean }).__sampling = true;
    const start = performance.now();
    const tick = () => {
      const bar = window.document.querySelector("[data-pocket-root]")?.getBoundingClientRect();
      const workspace = window.document.querySelector("main.workspace")?.getBoundingClientRect();
      frames.push({
        t: performance.now() - start,
        bar: bar?.height ?? 0,
        barBottom: bar?.bottom ?? 0,
        paper: workspace?.top ?? 0,
      });
      if ((window as unknown as { __sampling: boolean }).__sampling) window.requestAnimationFrame(tick);
    };
    window.requestAnimationFrame(tick);
  });
  await run();
  await page.waitForTimeout(ms);
  return page.evaluate(() => {
    (window as unknown as { __sampling: boolean }).__sampling = false;
    return (window as unknown as { __frames: Array<{ t: number; bar: number; barBottom: number; paper: number }> }).__frames;
  });
}

test("opens by growing from the top, and the page moves down with it frame by frame", async ({ page }) => {
  await openEditor(page);
  await enableMotion(page);
  await selectSourceLine(page);
  const paperBefore = (await page.locator("main.workspace").boundingBox())!.y;

  const frames = await sampleFrames(page, () => page.keyboard.press("ControlOrMeta+Shift+KeyC"));

  const heights = frames.map((frame) => frame.bar);
  const final = heights[heights.length - 1]!;
  // 開き切ると 88px。途中の高さを通っていて (一瞬で切り替わらない)、縮まずに増え続ける。
  expect(final).toBe(88);
  expect(heights.some((height) => height > 8 && height < 80)).toBe(true);
  for (let index = 1; index < heights.length; index += 1) {
    expect(heights[index]!).toBeGreaterThanOrEqual(heights[index - 1]! - 0.5);
  }
  // バーの下端と紙面の上端は、どのフレームでも一致する (紙面がバーに押されて同じ速さで下がる)。
  for (const frame of frames) {
    expect(Math.abs(frame.barBottom - frame.paper)).toBeLessThanOrEqual(1);
  }
  expect(frames[frames.length - 1]!.paper - paperBefore).toBe(88);
  // 動きの最中に、画面全体が引っかかるほど長いフレームが無い (高さを動かしても重くならない)。
  const gaps = frames.slice(1).map((frame, index) => frame.t - frames[index]!.t);
  expect(Math.max(...gaps)).toBeLessThan(200);
});

test("folds up when it is closed, then leaves only the chip", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  await enableMotion(page);
  await page.waitForTimeout(500);

  const frames = await sampleFrames(page, () => pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click());

  const heights = frames.map((frame) => frame.bar);
  expect(heights[heights.length - 1]).toBe(0);
  expect(heights.some((height) => height > 8 && height < 80)).toBe(true);
  for (let index = 1; index < heights.length; index += 1) {
    expect(heights[index]!).toBeLessThanOrEqual(heights[index - 1]! + 0.5);
  }
  for (const frame of frames) {
    expect(Math.abs(frame.barBottom - frame.paper)).toBeLessThanOrEqual(1);
  }
  // 畳み終わると、カードは消えて、普段は見えないチップだけが残る。
  await expect(pocket(page)).toHaveAttribute("data-phase", "collapsed");
  await expect(cards(page)).toHaveCount(0);
});

test("opens and closes at once for someone who asked for less motion", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);

  // 途中の高さを通らない: 閉じている (0) か開いている (88) かのどちらかしか無い。
  const opening = await sampleFrames(page, () => page.keyboard.press("ControlOrMeta+Shift+KeyC"), 300);
  expect(opening.every((frame) => frame.bar === 0 || frame.bar === 88)).toBe(true);
  expect(opening[opening.length - 1]!.bar).toBe(88);
  await expect(page.locator("[data-pocket-flyer]")).toHaveCount(0);

  const closing = await sampleFrames(page, () => pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click(), 300);
  expect(closing.every((frame) => frame.bar === 0 || frame.bar === 88)).toBe(true);
  expect(closing[closing.length - 1]!.bar).toBe(0);
  await expect(pocket(page)).toHaveAttribute("data-phase", "collapsed");
});

test("the card flies in only after the pocket has finished opening", async ({ page }) => {
  await openEditor(page);
  await enableMotion(page);
  await selectSourceLine(page);

  await page.getByRole("button", { name: "ポケットに追加" }).click();

  // 開く動きの最中 (まだ高さが伸びている) は飛ばさない。開き切ってから、着く先の位置が決まった状態で飛ぶ。
  const flyer = page.locator("[data-pocket-flyer]");
  const heightWhenFlyerAppears = await (async () => {
    await expect(flyer).toBeVisible();
    return pocket(page).evaluate((element) => element.getBoundingClientRect().height);
  })();
  expect(heightWhenFlyerAppears).toBe(88);
  await expect(flyer).toHaveCount(0);
});

test("the chip is reachable from the keyboard even while it is out of sight", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click();
  const handle = pocket(page).getByRole("button", { name: /ポケット 1件/ });

  await handle.focus();

  // 焦点が来ると現れ、Enter で開く。
  await expect.poll(() => handle.evaluate((element) => parseFloat(getComputedStyle(element).opacity))).toBe(1);
  await page.keyboard.press("Enter");
  await expect(cards(page)).toHaveCount(1);
});

test("the selected part flies into the pocket when it is put in, and the card lands", async ({ page }) => {
  await openEditor(page);
  await enableMotion(page);
  await selectSourceLine(page);

  await page.getByRole("button", { name: "ポケットに追加" }).click();

  // 選んでいた場所から飛んでいく。着くまで、本物のカードは隠れている。
  const flyer = page.locator("[data-pocket-flyer]");
  await expect(flyer).toBeVisible();
  await expect(cards(page).first()).toHaveAttribute("data-flying", "true");
  const flying = (await flyer.boundingBox())!;
  const source = (await page.locator('[data-sigma-doc-id="pocket_body"]').first().boundingBox())!;
  // 出発は本文 (選んでいた行) の近く。着く先のカードは上部にある。
  const card = (await cards(page).first().boundingBox())!;
  expect(card.y).toBeLessThan(source.y);

  // 着いたら、飛ぶものは消えて、カードが現れる。
  await expect(flyer).toHaveCount(0);
  await expect(cards(page).first()).not.toHaveAttribute("data-flying", "true");
  expect(parseFloat(await cards(page).first().evaluate((element) => getComputedStyle(element).opacity))).toBe(1);
  // 着いたあと、はずむ動きが終われば、カードの大きさのまま (縮んだまま残らず) 落ち着く。
  await expect(cards(page).first()).not.toHaveAttribute("data-landed", "true");
  const landed = (await cards(page).first().boundingBox())!;
  expect(Math.abs(landed.width - card.width)).toBeLessThanOrEqual(1);
  expect(flying.width).toBeGreaterThan(0);
});

test("the part flies in for a shape too, and for the add button in the pocket", async ({ page }) => {
  await openEditor(page);
  await enableMotion(page);
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(page.locator("[data-pocket-flyer]")).toBeVisible();
  await expect(page.locator("[data-pocket-flyer]")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(1);

  // 選んだまま、ポケットの「選んだものを入れる」からも同じ動き。
  await pocket(page).getByRole("button", { name: "選んだものを入れる" }).click();
  await expect(page.locator("[data-pocket-flyer]")).toBeVisible();
  await expect(page.locator("[data-pocket-flyer]")).toHaveCount(0);
  await expect(cards(page)).toHaveCount(2);
});

test("drags a text card into the body and drops it at the pointer", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  const other = page.locator('[data-sigma-doc-id="pocket_other"]').first();
  const box = await other.boundingBox();
  // 段落の左端 (「別の」の前) へ落とす。
  await dragChipTo(page, cards(page).first(), box!.x + 2, box!.y + box!.height / 2);

  await expect(other).toContainText(SOURCE_TEXT);
  const text = (await other.innerText()).replace(/\s+/g, "");
  // 落とした位置 (段落の頭) に入る。末尾ではない。
  expect(text.indexOf(SOURCE_TEXT.replace(/\s+/g, ""))).toBeLessThan(text.indexOf("別の段落"));
  // 元の本文はそのまま、ポケットの項目も減らない。
  await expect(page.locator('[data-sigma-doc-id="pocket_body"]').first()).toContainText(SOURCE_TEXT);
  await expect(cards(page)).toHaveCount(1);
});

test("drops at the end of a paragraph when dropped at its end", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");

  const other = page.locator('[data-sigma-doc-id="pocket_other"]').first();
  const box = await other.boundingBox();
  await dragChipTo(page, cards(page).first(), box!.x + box!.width - 3, box!.y + box!.height / 2);

  await expect(other).toContainText(SOURCE_TEXT);
  const text = (await other.innerText()).replace(/\s+/g, "");
  expect(text.indexOf("別の段落")).toBeLessThan(text.indexOf(SOURCE_TEXT.replace(/\s+/g, "")));
});

test("drops a shape card on the page, centred on the pointer", async ({ page }) => {
  await openEditor(page);
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  await deselectShapes(page);

  const target = { x: 700, y: 640 };
  await dragChipTo(page, cards(page).first(), target.x, target.y);

  await expect.poll(() => shapeIds(page)).toHaveLength(2);
  const dropped = (await shapeIds(page)).find((id) => id !== "pocket_rect")!;
  const box = (await page.locator(`.overlay-shape[data-overlay-shape-id="${dropped}"]`).first().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - target.x)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.y + box.height / 2 - target.y)).toBeLessThanOrEqual(8);
});

test("drops text into the body even while a shape is selected and the figures cover the page", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  // 図形を選ぶと、図形のレイヤーが本文の手前を覆う (オーバーレイ編集)。
  await selectRectangle(page);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");

  const other = page.locator('[data-sigma-doc-id="pocket_other"]').first();
  const box = await other.boundingBox();
  // 「別の」と「段落」の間あたり。
  await dragChipTo(page, cards(page).first(), box!.x + 30, box!.y + box!.height / 2);

  await expect(other).toContainText(SOURCE_TEXT);
  const text = (await other.innerText()).replace(/\s+/g, "");
  expect(text.indexOf("別の")).toBeLessThan(text.indexOf("ポケットへ入れる文章"));
  expect(text.indexOf("ポケットへ入れる文章")).toBeLessThan(text.indexOf("段落"));
});

test("ignores a drop on the chrome: nothing is inserted and the pocket is kept", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  // 紙面の外 (メニューバー) には落とせない。何も増えず、ポケットはそのまま。
  await dragChipTo(page, cards(page).first(), 400, 20);
  await expect(page.locator('[data-sigma-doc-id="pocket_other"]').first()).not.toContainText(SOURCE_TEXT);
  await expect(cards(page)).toHaveCount(1);
});

test("tells the user when text is dropped where there is no text to put it in", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  // 紙面の空白 (本文のない場所)。図形なら置けるが、文章を入れる先が無い。
  await dragChipTo(page, cards(page).first(), 600, 820);

  await expect(pocket(page)).toContainText("ここには挿入できません");
  await expect(page.locator('[data-sigma-doc-id="pocket_other"]').first()).not.toContainText(SOURCE_TEXT);
  await expect(cards(page)).toHaveCount(1);
});

function whiteboardDocument(): SigmaDocument {
  const source = sourceDocument();
  return {
    ...source,
    docId: "doc_pocket_whiteboard",
    metadata: { title: "ホワイトボード" },
    content: [],
    pageLayout: {
      ...getDefaultPageLayout("whiteboard"),
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  } as SigmaDocument;
}

async function openWhiteboardTab(page: Page): Promise<void> {
  await exitOverlayEditing(page);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
}

async function openEditorWithWhiteboardAsSecondTab(page: Page): Promise<void> {
  await reduceMotion(page);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDocumentTabMock(page, sourceDocument(), whiteboardDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

const overlayTextShapes = (page: Page) => page.locator(".overlay-shape", { hasText: SOURCE_TEXT });

test("whiteboard: a click puts copied body text on the board as an overlay text shape", async ({ page }) => {
  await openEditorWithWhiteboardAsSecondTab(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  await openWhiteboardTab(page);
  await expect(overlayTextShapes(page)).toHaveCount(0);

  await cards(page).first().click();

  await expect(overlayTextShapes(page)).toHaveCount(1);
  // 見えている範囲の中に置かれ、そのまま選ばれている (数式も含めて図形の中身として描かれる)。
  const viewport = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
  const shape = (await overlayTextShapes(page).first().boundingBox())!;
  expect(shape.x).toBeGreaterThanOrEqual(viewport.x);
  expect(shape.x + shape.width).toBeLessThanOrEqual(viewport.x + viewport.width);
  expect(shape.y).toBeGreaterThanOrEqual(viewport.y);
  expect(shape.y + shape.height).toBeLessThanOrEqual(viewport.y + viewport.height);
  await expect(overlayTextShapes(page).first().locator(".inline-math-node").first()).toBeVisible();
  // 何度でも入れられる。
  await page.mouse.click(viewport.x + 40, viewport.y + viewport.height - 40);
  await cards(page).first().click();
  await expect(overlayTextShapes(page)).toHaveCount(2);
});

test("whiteboard: a dropped body copy becomes an overlay text shape under the pointer", async ({ page }) => {
  await openEditorWithWhiteboardAsSecondTab(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await openWhiteboardTab(page);

  const viewport = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
  const target = { x: viewport.x + 420, y: viewport.y + 300 };
  await dragChipTo(page, cards(page).first(), target.x, target.y);

  await expect(overlayTextShapes(page)).toHaveCount(1);
  const shape = (await overlayTextShapes(page).first().boundingBox())!;
  // 左右は中心がポインタの下、上下はポインタが図形の高さの中に入る (高さは描画のあとで決まる)。
  expect(Math.abs(shape.x + shape.width / 2 - target.x)).toBeLessThanOrEqual(8);
  expect(shape.y).toBeLessThanOrEqual(target.y);
  expect(shape.y + shape.height).toBeGreaterThanOrEqual(target.y);
});

test("whiteboard: a dropped shape lands centred on the pointer", async ({ page }) => {
  await openEditorWithWhiteboardAsSecondTab(page);
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await openWhiteboardTab(page);

  const viewport = (await page.locator(".whiteboard-page-canvas").boundingBox())!;
  const target = { x: viewport.x + 500, y: viewport.y + 350 };
  await dragChipTo(page, cards(page).first(), target.x, target.y);

  await expect.poll(() => shapeIds(page)).toHaveLength(1);
  const box = (await page.locator(".overlay-shape").first().boundingBox())!;
  expect(Math.abs(box.x + box.width / 2 - target.x)).toBeLessThanOrEqual(8);
  expect(Math.abs(box.y + box.height / 2 - target.y)).toBeLessThanOrEqual(8);
});

test("selection toolbar: the pocket button says what it does, next to the AI button's style", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);

  const button = page.locator(".selection-action-popover").getByRole("button", { name: "ポケットに追加" });
  await expect(button).toBeVisible();
  // アイコンだけではなく、文字も見えている。
  await expect(button).toContainText("ポケットに追加");
  await expect(button.locator("svg")).toHaveCount(1);
});
