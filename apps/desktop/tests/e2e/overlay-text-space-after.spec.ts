import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { selectUiOptionInPage } from "./ui-select";

/**
 * 図中テキスト (テキスト図形) の段落ごとの下余白つまみ。本文の「↓-」 (`.page-block-space-handle`) と同じ
 * つまみを、編集中の図形の左ガターに出す。見るのは次の 4 つ。
 *
 * - 掴んで下へ引くと、下の段落が **引いている間も** 追従し、図形の高さも追従する
 * - 離すと 1 回で確定し、保存された教材にも入る。取り消しで 1 手で戻る
 * - 編集を抜けた静的描画と、保存して開き直した描画が、編集中と同じ位置に段落を置く
 * - ズームが 100% でなくても、回転していても、引いた量がそのまま余白になる
 */

const SHAPE_ID = "shape_space_after";
const UPPER_TEXT = "上の段落です";
const LOWER_TEXT = "下の段落です";
/** 引く量 (画面 px)。*/
const DRAG_SCREEN_PX = 24;

const LIST_BLOCKS = [{
  type: "list",
  id: "list_space",
  listType: "bullet",
  items: [
    { type: "listItem", id: "item_a", children: [{ type: "text", text: "甲の項目" }] },
    { type: "listItem", id: "item_b", children: [{ type: "text", text: "乙の項目" }] },
    { type: "listItem", id: "item_c", children: [{ type: "text", text: "丙の項目" }] },
  ],
}];

function createDocument(rotation = 0, blocks?: unknown[]): SigmaDocument {
  const problem = sampleDocument.content.find((block) => block.type === "problem");
  if (!problem || problem.type !== "problem") {
    throw new Error("Overlay text space-after E2E fixture requires the sample problem");
  }
  return {
    ...sampleDocument,
    content: [{ ...problem, lead: [], hints: [], solution: [] }],
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [{
            id: SHAPE_ID,
            type: "text",
            x: 90,
            y: 430,
            ...(rotation ? { rotation } : {}),
            props: {
              w: 280,
              h: 60,
              color: "#111111",
              size: "m",
              blocks: blocks ?? [
                { type: "paragraph", id: "para_upper", children: [{ type: "text", text: UPPER_TEXT }] },
                { type: "paragraph", id: "para_lower", children: [{ type: "text", text: LOWER_TEXT }] },
              ],
            },
          }],
        },
      },
    },
  } as SigmaDocument;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

interface SavedParagraph {
  id: string;
  spaceAfterPx?: number;
}

interface SavedShape {
  id: string;
  props?: { h?: number; blocks?: SavedParagraph[] };
}

async function savedShape(page: Page): Promise<SavedShape | null> {
  return page.evaluate((shapeId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const doc = raw ? JSON.parse(raw) : null;
    const walk = (value: unknown): unknown[] => {
      if (!value || typeof value !== "object") return [];
      const shapes = (value as { overlaySnapshot?: { shapes?: unknown[] } }).overlaySnapshot?.shapes;
      if (Array.isArray(shapes)) return shapes;
      return Object.values(value).flatMap(walk);
    };
    return (walk(doc).find((shape) => (shape as { id?: string }).id === shapeId) ?? null) as SavedShape | null;
  }, SHAPE_ID);
}

async function flushOverlay(page: Page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
}

async function openAndEnterEditing(page: Page, doc: SigmaDocument): Promise<Locator> {
  await installDesktopRuntimeMock(page, doc);
  await page.goto("/");
  const shape = page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
  await expect(shape).toBeVisible();
  const box = await shape.boundingBox();
  expect(box).not.toBeNull();
  // 回転した図形でも中心は図形の中にある。
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await grabShapeFromBody(page, point);
  // 選んだだけの段階ではつまみを出さない (編集に入ってから)。
  await expect(page.getByTestId("overlay-text-space-handle")).toHaveCount(0);
  await page.mouse.click(point.x, point.y);
  await expect(shape.locator(".ProseMirror")).toBeVisible();
  return shape;
}

interface ShapeGeometry {
  /** 内容の箱の上端に対する各段落の上端 (図形の局所 px。ズーム・回転の影響を受けない)。 */
  paragraphOffsets: number[];
  /** 内容の箱の高さ (局所 px)。*/
  contentHeight: number;
  /** 図形の箱の高さ (局所 px)。保存される `props.h` が描かれた姿。*/
  shapeHeight: number;
  /** 画面 px / 局所 px。*/
  scale: number;
}

/** 編集面でも静的描画でも同じ形で読む: `.overlay-text-shape-content` の直下の段落。 */
async function readGeometry(page: Page, root: Locator): Promise<ShapeGeometry> {
  const handle = await root.elementHandle();
  expect(handle).not.toBeNull();
  return page.evaluate((element) => {
    const content = element!.querySelector<HTMLElement>(".overlay-text-shape-content")!;
    const paragraphs = Array.from(content.querySelectorAll<HTMLElement>(":scope > p"));
    // ズームは `.page-stack` の transform。図形は回っているかもしれないので、回らない祖先で換算率を測る。
    const stack = element!.closest<HTMLElement>(".page-stack");
    const scale = stack && stack.offsetWidth > 0 ? stack.getBoundingClientRect().width / stack.offsetWidth : 1;
    return {
      paragraphOffsets: paragraphs.map((paragraph) => paragraph.offsetTop - content.offsetTop),
      contentHeight: content.offsetHeight,
      shapeHeight: (element as HTMLElement).offsetHeight,
      scale,
    };
  }, handle);
}

/** 画面上の段落の上端 (回転していない図形で、追従を毎フレーム見るのに使う)。 */
async function screenTops(page: Page, root: Locator): Promise<number[]> {
  const handle = await root.elementHandle();
  return page.evaluate((element) => Array.from(
    element!.querySelectorAll<HTMLElement>(".overlay-text-shape-content > p"),
  ).map((paragraph) => paragraph.getBoundingClientRect().top), handle);
}

function spaceHandle(page: Page): Locator {
  return page.getByTestId("overlay-text-space-handle");
}

/** 上の段落にポインタを置いて、そのつまみを出す。 */
async function hoverUpperParagraph(page: Page, shape: Locator): Promise<Locator> {
  const upper = shape.locator(".overlay-text-shape-content > p").first();
  const box = await upper.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  const handle = spaceHandle(page);
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("data-index", "0");
  return handle;
}

/** つまみを掴み、局所の縦軸に沿って `distance` 画面 px 引く。離さずに返る。 */
async function grabAndDrag(page: Page, handle: Locator, distance: number, rotation: number, steps = 12) {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  for (let step = 1; step <= steps; step += 1) {
    const travelled = (distance * step) / steps;
    await page.mouse.move(x - Math.sin(rotation) * travelled, y + Math.cos(rotation) * travelled);
    // 1 フレーム以上空ける (まとめて投げるとブラウザが畳み、追従を観測できない)。
    await page.waitForTimeout(24);
  }
}

test("the handle follows the hovered paragraph and appears only while editing", async ({ page }) => {
  const shape = await openAndEnterEditing(page, createDocument());

  const handle = await hoverUpperParagraph(page, shape);
  const upper = await shape.locator(".overlay-text-shape-content > p").first().boundingBox();
  const lower = await shape.locator(".overlay-text-shape-content > p").nth(1).boundingBox();
  const handleBox = await handle.boundingBox();
  // 上の段落の下端 (= 下の段落の上端) に重心が乗り、図形の左側に出る。
  expect(Math.abs(handleBox!.y + handleBox!.height / 2 - (upper!.y + upper!.height))).toBeLessThan(3);
  expect(handleBox!.x + handleBox!.width).toBeLessThanOrEqual(upper!.x + 6);

  await page.mouse.move(lower!.x + lower!.width / 2, lower!.y + lower!.height / 2);
  await expect(handle).toHaveAttribute("data-index", "1");

  // 編集を抜けるとつまみは消える。
  await page.keyboard.press("Escape");
  await expect(spaceHandle(page)).toHaveCount(0);
});

test("dragging moves the next paragraph live, grows the shape, commits once and undoes in one step", async ({ page }) => {
  test.setTimeout(90_000);
  const shape = await openAndEnterEditing(page, createDocument());
  const before = await readGeometry(page, shape);
  const topsBefore = await screenTops(page, shape);
  expect(before.paragraphOffsets).toHaveLength(2);
  const handle = await hoverUpperParagraph(page, shape);
  // 編集に入った時の高さの測り直し (fixture の h は仮の値) が保存に落ち着くのを待ってから、基準を取る。
  await page.waitForTimeout(500);
  await flushOverlay(page);
  await expect.poll(async () => Math.abs(((await savedShape(page))?.props?.h ?? 0) - before.shapeHeight)).toBeLessThan(1.5);
  const initialSaved = await savedShape(page);
  const frameBefore = (await shape.boundingBox())!;

  await grabAndDrag(page, handle, DRAG_SCREEN_PX, 0);

  // 引いている間 (離す前): 下の段落が引いた分だけ下がり、図形の高さも追従する。まだ文書へは書かない。
  const topsDuring = await screenTops(page, shape);
  expect(topsDuring[0]).toBeCloseTo(topsBefore[0], 0);
  expect(Math.abs(topsDuring[1] - (topsBefore[1] + DRAG_SCREEN_PX))).toBeLessThan(1.5);
  await expect.poll(async () => ((await shape.boundingBox())?.height ?? 0) - frameBefore.height)
    .toBeGreaterThan(DRAG_SCREEN_PX - 3);
  const during = await readGeometry(page, shape);
  expect(Math.abs(during.contentHeight - (before.contentHeight + DRAG_SCREEN_PX / before.scale))).toBeLessThan(2);
  expect(Math.abs(during.shapeHeight - (before.shapeHeight + DRAG_SCREEN_PX / before.scale))).toBeLessThan(2);
  const midSaved = await savedShape(page);
  expect(midSaved?.props?.blocks?.[0]?.spaceAfterPx).toBeUndefined();
  expect(midSaved?.props?.h).toBe(initialSaved?.props?.h);

  await page.mouse.up();
  await flushOverlay(page);

  // 離したあとも位置は跳ねない (確定しても同じ場所)。
  const topsAfter = await screenTops(page, shape);
  expect(Math.abs(topsAfter[1] - topsDuring[1])).toBeLessThan(1);

  const expectedPx = Math.round(DRAG_SCREEN_PX / before.scale);
  await expect.poll(async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBe(expectedPx);
  const saved = await savedShape(page);
  expect(saved?.props?.blocks?.[1]?.spaceAfterPx).toBeUndefined();
  // 箱の高さも、描かれた高さ (引いた分だけ伸びた姿) で保存される。
  await expect.poll(async () => Math.abs(
    ((await savedShape(page))?.props?.h ?? 0) - ((initialSaved?.props?.h ?? 0) + expectedPx),
  )).toBeLessThan(1.5);
  expect(Math.abs((await readGeometry(page, shape)).shapeHeight - ((initialSaved?.props?.h ?? 0) + expectedPx))).toBeLessThan(1.5);

  // 取り消し 1 回で、余白も高さも元に戻る。
  await page.keyboard.press("ControlOrMeta+Z");
  await expect.poll(async () => (await screenTops(page, shape))[1]).toBeCloseTo(topsBefore[1], 0);
  await flushOverlay(page);
  await expect.poll(async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBeUndefined();
  await expect.poll(async () => Math.abs(((await savedShape(page))?.props?.h ?? 0) - (initialSaved?.props?.h ?? 0))).toBeLessThan(1.5);
  expect((await readGeometry(page, shape)).contentHeight).toBeCloseTo(before.contentHeight, 0);
  expect(Math.abs((await readGeometry(page, shape)).shapeHeight - (initialSaved?.props?.h ?? 0))).toBeLessThan(1.5);

  // やり直しで戻る。
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect.poll(async () => (await screenTops(page, shape))[1]).toBeCloseTo(topsBefore[1] + DRAG_SCREEN_PX, 0);
});

test("the static view, and a reloaded document, put the paragraphs where the editor did", async ({ page }) => {
  test.setTimeout(90_000);
  const shape = await openAndEnterEditing(page, createDocument());
  const handle = await hoverUpperParagraph(page, shape);
  await grabAndDrag(page, handle, DRAG_SCREEN_PX, 0);
  await page.mouse.up();
  await flushOverlay(page);
  const editing = await readGeometry(page, shape);
  await expect.poll(async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBeGreaterThan(0);

  // 編集を抜けた静的描画。
  await page.keyboard.press("Escape");
  await page.mouse.click(10, 10);
  await expect(shape.locator("[contenteditable='true']")).toHaveCount(0);
  const staticView = await readGeometry(page, shape);
  expect(staticView.paragraphOffsets[1]).toBeCloseTo(editing.paragraphOffsets[1], 0);
  expect(Math.abs(staticView.paragraphOffsets[1] - editing.paragraphOffsets[1])).toBeLessThanOrEqual(1);
  expect(Math.abs(staticView.contentHeight - editing.contentHeight)).toBeLessThanOrEqual(1);
  expect(Math.abs(staticView.shapeHeight - editing.shapeHeight)).toBeLessThanOrEqual(1);

  // 保存した教材を別のページで開き直す。
  await flushOverlay(page);
  const savedDocument = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw) : null;
  }) as SigmaDocument | null;
  expect(savedDocument).not.toBeNull();
  const reopened = await page.context().newPage();
  await installDesktopRuntimeMock(reopened, savedDocument!);
  await reopened.goto("/");
  const preview = reopened.locator(`.page-overlay-preview .overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
  await expect(preview).toBeVisible();
  await expect(preview.locator(".overlay-text-shape-content > p")).toHaveCount(2);
  const reloaded = await readGeometry(reopened, preview);
  expect(Math.abs(reloaded.paragraphOffsets[1] - editing.paragraphOffsets[1])).toBeLessThanOrEqual(1);
  expect(Math.abs(reloaded.contentHeight - editing.contentHeight)).toBeLessThanOrEqual(1);
  // 図形の枠 (保存された高さ) も、開き直しても同じ。
  expect(Math.abs(reloaded.shapeHeight - editing.shapeHeight)).toBeLessThanOrEqual(1.5);
  const savedHeight = (await savedShape(page))?.props?.h ?? 0;
  expect(Math.abs(savedHeight - editing.shapeHeight)).toBeLessThanOrEqual(1.5);
  await reopened.close();
});

test("keyboard steps, Delete and double-click work on the focused handle like the body's", async ({ page }) => {
  const shape = await openAndEnterEditing(page, createDocument());
  const handle = await hoverUpperParagraph(page, shape);
  const read = async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx;

  await handle.focus();
  await page.keyboard.press("ArrowDown");
  await flushOverlay(page);
  await expect.poll(read).toBe(1);

  await page.keyboard.press("Shift+ArrowDown");
  await flushOverlay(page);
  await expect.poll(read).toBe(11);

  await page.keyboard.press("ArrowUp");
  await flushOverlay(page);
  await expect.poll(read).toBe(10);

  await page.keyboard.press("Delete");
  await flushOverlay(page);
  await expect.poll(read).toBeUndefined();

  await page.keyboard.press("Shift+ArrowDown");
  await flushOverlay(page);
  await expect.poll(read).toBe(10);
  await handle.dblclick();
  await flushOverlay(page);
  await expect.poll(read).toBeUndefined();
});

test("Escape while dragging puts the space back and writes nothing", async ({ page }) => {
  const shape = await openAndEnterEditing(page, createDocument());
  const before = await screenTops(page, shape);
  const handle = await hoverUpperParagraph(page, shape);

  await grabAndDrag(page, handle, DRAG_SCREEN_PX, 0, 6);
  expect((await screenTops(page, shape))[1]).toBeGreaterThan(before[1] + 10);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await flushOverlay(page);

  await expect.poll(async () => (await screenTops(page, shape))[1]).toBeCloseTo(before[1], 0);
  expect((await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBeUndefined();
  // 編集は続いている (Escape はドラッグをやめただけ)。
  await expect(shape.locator(".ProseMirror")).toBeVisible();
});

test("keeps the same drag distance at 150% zoom", async ({ page }) => {
  test.setTimeout(90_000);
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1000);
  await selectUiOptionInPage(page, "ズーム", "150");
  await page.waitForTimeout(800);
  const shapeLocator = page.locator(`.overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
  await expect(shapeLocator).toBeVisible();
  await shapeLocator.scrollIntoViewIfNeeded();
  const box = await shapeLocator.boundingBox();
  const point = { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
  await grabShapeFromBody(page, point);
  await page.mouse.click(point.x, point.y);
  await expect(shapeLocator.locator(".ProseMirror")).toBeVisible();

  const before = await readGeometry(page, shapeLocator);
  expect(before.scale).toBeGreaterThan(1.4);
  const topsBefore = await screenTops(page, shapeLocator);
  const handle = await hoverUpperParagraph(page, shapeLocator);
  const travel = 30 * before.scale;

  await grabAndDrag(page, handle, travel, 0);
  const during = await screenTops(page, shapeLocator);
  // 画面 px で引いた分だけ画面 px で下がる (ズームの換算が両側で一致している)。
  expect(Math.abs(during[1] - (topsBefore[1] + travel))).toBeLessThan(2.5);
  await page.mouse.up();
  await flushOverlay(page);
  await expect.poll(async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBe(30);
});

test("follows the shape's own downward axis when the shape is turned", async ({ page }) => {
  test.setTimeout(90_000);
  // 反時計回り: 左ガターが図形の左下へ回るので、図形の真上に出る浮かぶツールバーに隠れない
  // (時計回りだと、つまみが上端より上へ回ってツールバーの下に潜る)。
  const rotation = -Math.PI / 6;
  const shape = await openAndEnterEditing(page, createDocument(rotation));
  const before = await readGeometry(page, shape);
  const handle = await hoverUpperParagraph(page, shape);
  const localPx = 24;

  await grabAndDrag(page, handle, localPx * before.scale, rotation);
  const during = await readGeometry(page, shape);
  // 局所のレイアウトで測る: 回転しても下の段落は局所で引いた分だけ下がる。
  expect(Math.abs(during.paragraphOffsets[1] - (before.paragraphOffsets[1] + localPx))).toBeLessThan(2);
  await page.mouse.up();
  await flushOverlay(page);

  await expect.poll(async () => (await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBeGreaterThanOrEqual(localPx - 1);
  expect((await savedShape(page))?.props?.blocks?.[0]?.spaceAfterPx).toBeLessThanOrEqual(localPx + 1);
});

test("a list item's space is drawn under its own line, saved, and kept after reopening", async ({ page }) => {
  test.setTimeout(90_000);
  const shape = await openAndEnterEditing(page, createDocument(0, LIST_BLOCKS));
  const readItems = (root: Locator) => root.elementHandle().then((handle) => page.evaluate((element) => {
    const content = element!.querySelector<HTMLElement>(".overlay-text-shape-content")!;
    const stack = element!.closest<HTMLElement>(".page-stack");
    const scale = stack && stack.offsetWidth > 0 ? stack.getBoundingClientRect().width / stack.offsetWidth : 1;
    const top = content.getBoundingClientRect().top;
    return Array.from(content.querySelectorAll<HTMLElement>("li")).map((item) => (item.getBoundingClientRect().top - top) / scale);
  }, handle));

  const before = await readItems(shape);
  expect(before).toHaveLength(3);
  const handle = spaceHandle(page);
  const firstItem = await shape.locator("li").first().boundingBox();
  await page.mouse.move(firstItem!.x + firstItem!.width / 2, firstItem!.y + firstItem!.height / 2);
  await expect(handle).toBeVisible();
  await expect(handle).toHaveAttribute("data-index", "0");

  await grabAndDrag(page, handle, DRAG_SCREEN_PX, 0);
  await page.mouse.up();
  await flushOverlay(page);

  const editing = await readItems(shape);
  // 下の項目だけが引いた分だけ下がる (1 つ目の項目自身は動かない)。
  expect(Math.abs(editing[0] - before[0])).toBeLessThan(1);
  expect(Math.abs(editing[1] - (before[1] + DRAG_SCREEN_PX))).toBeLessThan(2.5);
  expect(Math.abs(editing[2] - editing[1] - (before[2] - before[1]))).toBeLessThan(1);

  const savedItems = async () => page.evaluate((shapeId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const doc = raw ? JSON.parse(raw) : null;
    const walk = (value: unknown): unknown[] => {
      if (!value || typeof value !== "object") return [];
      const shapes = (value as { overlaySnapshot?: { shapes?: unknown[] } }).overlaySnapshot?.shapes;
      return Array.isArray(shapes) ? shapes : Object.values(value).flatMap(walk);
    };
    const found = walk(doc).find((candidate) => (candidate as { id?: string }).id === shapeId) as
      { props?: { blocks?: Array<{ items?: Array<{ id: string; spaceAfterPx?: number }> }> } } | undefined;
    return found?.props?.blocks?.[0]?.items ?? [];
  }, SHAPE_ID);
  await expect.poll(async () => (await savedItems())[0]?.spaceAfterPx).toBe(DRAG_SCREEN_PX);
  expect((await savedItems())[1]?.spaceAfterPx).toBeUndefined();

  // 保存した教材を別のページで開き直しても、項目の位置は編集中と同じ。
  const savedDocument = await page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    return raw ? JSON.parse(raw) : null;
  }) as SigmaDocument | null;
  const reopened = await page.context().newPage();
  await installDesktopRuntimeMock(reopened, savedDocument!);
  await reopened.goto("/");
  const preview = reopened.locator(`.page-overlay-preview .overlay-shape-text[data-overlay-shape-id="${SHAPE_ID}"]`);
  await expect(preview.locator("li")).toHaveCount(3);
  const reloaded = await reopened.evaluate((shapeId) => {
    const element = document.querySelector(`.page-overlay-preview .overlay-shape-text[data-overlay-shape-id="${shapeId}"]`)!;
    const content = element.querySelector<HTMLElement>(".overlay-text-shape-content")!;
    const stack = element.closest<HTMLElement>(".page-stack");
    const scale = stack && stack.offsetWidth > 0 ? stack.getBoundingClientRect().width / stack.offsetWidth : 1;
    const top = content.getBoundingClientRect().top;
    return Array.from(content.querySelectorAll<HTMLElement>("li")).map((item) => (item.getBoundingClientRect().top - top) / scale);
  }, SHAPE_ID);
  expect(Math.abs(reloaded[1] - editing[1])).toBeLessThanOrEqual(1);
  expect(Math.abs(reloaded[2] - editing[2])).toBeLessThanOrEqual(1);
  await reopened.close();
});

test("typing and Enter keep the space on the paragraph it belongs to", async ({ page }) => {
  test.setTimeout(90_000);
  const shape = await openAndEnterEditing(page, createDocument());
  const handle = await hoverUpperParagraph(page, shape);
  await handle.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+ArrowDown");
  await flushOverlay(page);
  const blocks = async () => (await savedShape(page))?.props?.blocks ?? [];
  await expect.poll(async () => (await blocks())[0]?.spaceAfterPx).toBe(20);

  // 打鍵: 次の打鍵が書いたばかりの余白を巻き戻さない。
  const upper = shape.locator(".overlay-text-shape-content > p").first();
  await upper.click();
  await page.keyboard.press("End");
  await page.keyboard.type("あ");
  await flushOverlay(page);
  await expect.poll(async () => (await blocks())[0]?.spaceAfterPx).toBe(20);

  // 段落の末尾での Enter: 余白は前半 (もとの段落) が持ち、新しい段落には複製されない。
  await page.keyboard.press("Enter");
  await flushOverlay(page);
  await expect.poll(async () => (await blocks()).length).toBe(3);
  expect((await blocks())[0]?.spaceAfterPx).toBe(20);
  expect((await blocks())[1]?.spaceAfterPx).toBeUndefined();
});
