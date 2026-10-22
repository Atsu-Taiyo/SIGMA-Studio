import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 図形の貼り付け (⌘V) は、マウスポインタが文書の編集領域の上にあればその位置を中心に置く。
 * メニューバー・ツールバー・サイドバー・ダイアログの上や、位置が分からないときは、従来どおり
 * 元の位置から 20px ずらす。ページの灰色の余白を指していれば、近いページの内側へ押し戻す。
 */

const BODY_BLOCK_ID = "p_paste_pointer_body";
const SECOND_PAGE_BLOCK_ID = "p_paste_pointer_page_two";
const SOURCE_RECT = "paste_pointer_rect";
const ANCHORED_RECT = "paste_pointer_anchored_rect";
const RECT_SIZE = { w: 160, h: 90 };

function pointerPasteDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_paste_at_pointer";
  document.metadata = { ...document.metadata, title: "ポインタ位置への貼り付け E2E" };
  document.content = [
    { type: "paragraph", id: BODY_BLOCK_ID, children: [{ type: "text", text: "本文の一行です。" }] },
    // 2 ページ目 (ページの間の灰色の隙間へ貼る確認に使う)。
    {
      type: "paragraph",
      id: SECOND_PAGE_BLOCK_ID,
      pagination: { break: true },
      children: [{ type: "text", text: "二ページ目の本文です。" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        assets: {},
        shapes: [
          {
            id: ANCHORED_RECT,
            type: "geo",
            x: 420,
            y: 330,
            rotation: 0,
            // 本文のブロックにぶら下がった図形: 貼り付けても本文に付いたまま (ページ固定にはしない)。
            anchor: { type: "block", blockId: BODY_BLOCK_ID, dy: 250 },
            props: {
              geo: "rectangle",
              w: RECT_SIZE.w,
              h: RECT_SIZE.h,
              color: "#111111",
              labelColor: "#111111",
              fill: "none",
              dash: "dashed",
              size: "m",
            },
          },
          {
            id: SOURCE_RECT,
            type: "geo",
            x: 120,
            y: 420,
            rotation: 0,
            // ページに固定した図形: 貼り付けても固定のまま。
            anchor: { type: "page" },
            props: {
              geo: "rectangle",
              w: RECT_SIZE.w,
              h: RECT_SIZE.h,
              color: "#111111",
              labelColor: "#111111",
              fill: "none",
              dash: "dashed",
              size: "m",
            },
          },
        ],
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  // 2 ページが縦に並んで見える高さ (ページの間の隙間へポインタを置く確認のため)。
  await page.setViewportSize({ width: 1600, height: 2500 });
  await installDesktopRuntimeMock(page, pointerPasteDocument());
  await page.goto("/");
  await expect(page.locator(`[data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first()).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
});

interface Box { x: number; y: number; width: number; height: number }
interface Point { x: number; y: number }

function centerOfBox(box: Box): Point {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function savedShapes(page: Page): Promise<Array<{ id: string; x: number; y: number; anchor?: { type: string } }>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const saved = raw ? JSON.parse(raw) : null;
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  });
}

/** 元の図形を掴んでコピーする。 */
async function copySourceRectangle(page: Page, id = SOURCE_RECT): Promise<Box> {
  const source = page.locator(`.overlay-shape-geo[data-overlay-shape-id="${id}"]`).first();
  await expect(source).toBeVisible();
  const box = (await source.boundingBox())!;
  // 枠だけの四角形の中央は、(当たり判定は面全体だが) 別の図形と重ならない点を選ぶ。
  const center = centerOfBox(box);
  await page.mouse.click(center.x, center.y);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${id}"]`)).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+C");
  return box;
}

/** 紙面のページ (灰色の余白の内側) の矩形。 */
async function pageBox(page: Page): Promise<Box> {
  const canvas = page.locator(".page-canvas").first();
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

async function pasteAndGetNewBox(page: Page, before: number): Promise<Box> {
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(before + 1);
  // 貼り付けた図形が選択される。
  const pasted = page.locator(".overlay-shape-geo.selected").first();
  await expect(pasted).toBeVisible();
  const box = await pasted.boundingBox();
  expect(box).not.toBeNull();
  return box!;
}

test("pastes the copied shape centred on the mouse pointer", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page);
  const paper = await pageBox(page);
  const target = { x: paper.x + paper.width * 0.62, y: sourceBox.y + sourceBox.height + 160 };

  await page.mouse.move(target.x, target.y);
  const pasted = await pasteAndGetNewBox(page, 2);

  const center = centerOfBox(pasted);
  expect(Math.abs(center.x - target.x)).toBeLessThan(3);
  expect(Math.abs(center.y - target.y)).toBeLessThan(3);
  // 元の図形はそのまま。
  const original = await page.locator(`.overlay-shape-geo[data-overlay-shape-id="${SOURCE_RECT}"]`).boundingBox();
  expect(original!.x).toBeCloseTo(sourceBox.x, 0);
  expect(original!.y).toBeCloseTo(sourceBox.y, 0);
});

test("pastes at the pointer even when the caret is in the body text", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page);
  const paper = await pageBox(page);

  // 本文にキャレットを戻す (オーバーレイ編集を降りる)。
  const body = page.locator(`[data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first();
  const bodyBox = (await body.boundingBox())!;
  await page.mouse.click(bodyBox.x + 20, bodyBox.y + bodyBox.height / 2);
  await expect(page.locator('[data-overlay-editing="true"]')).toHaveCount(0);

  const target = { x: paper.x + paper.width * 0.55, y: sourceBox.y + sourceBox.height + 220 };
  await page.mouse.move(target.x, target.y);
  const pasted = await pasteAndGetNewBox(page, 2);

  const center = centerOfBox(pasted);
  expect(Math.abs(center.x - target.x)).toBeLessThan(3);
  expect(Math.abs(center.y - target.y)).toBeLessThan(3);
});

test("keeps the 20px offset when the pointer is over the menu bar", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page);
  const menubar = (await page.locator(".editor-menubar").first().boundingBox())!;

  await page.mouse.move(menubar.x + menubar.width / 2, menubar.y + menubar.height / 2);
  const pasted = await pasteAndGetNewBox(page, 2);

  // 100% 表示ではそのまま 20px。表示倍率があれば倍率をかけた分。
  const scale = sourceBox.width / RECT_SIZE.w;
  expect(pasted.x - sourceBox.x).toBeCloseTo(20 * scale, 0);
  expect(pasted.y - sourceBox.y).toBeCloseTo(20 * scale, 0);
});

test("pulls a paste aimed at the grey margin back onto the page", async ({ page }) => {
  await copySourceRectangle(page);
  const paper = await pageBox(page);
  const viewportWidth = page.viewportSize()!.width;
  // 紙の左の灰色の余白。
  const margin = Math.max(8, Math.min(paper.x / 2, paper.x - 20));
  expect(margin).toBeLessThan(paper.x);
  expect(margin).toBeGreaterThan(0);
  expect(paper.x + paper.width).toBeLessThan(viewportWidth);

  const pointerY = paper.y + 520;
  await page.mouse.move(margin, pointerY);
  const pasted = await pasteAndGetNewBox(page, 2);

  // 横は紙の左端へ押し戻され、縦はポインタの高さに置かれる (従来の +20px ではない)。
  expect(Math.abs(pasted.x - paper.x)).toBeLessThan(2);
  expect(Math.abs(centerOfBox(pasted).y - pointerY)).toBeLessThan(3);
});

test("puts a paste aimed at the grey gap between two pages on the nearer page", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page);
  const canvas = page.locator(".page-canvas").first();
  const paper = (await canvas.boundingBox())!;
  const pageHeight = Number(await canvas.getAttribute("data-page-height"));
  const stride = Number(await canvas.getAttribute("data-page-stride"));
  expect(await canvas.getAttribute("data-page-count")).toBe("2");
  const scale = sourceBox.width / RECT_SIZE.w;
  const firstBottom = paper.y + pageHeight * scale;
  const secondTop = paper.y + stride * scale;
  const gap = secondTop - firstBottom;
  expect(gap).toBeGreaterThan(8);
  const x = paper.x + paper.width / 2;

  // 隙間の上寄り (1 ページ目に近い): 1 ページ目の内側に収まる。
  await page.mouse.move(x, firstBottom + gap * 0.2);
  const upper = await pasteAndGetNewBox(page, 2);
  expect(upper.y + upper.height).toBeLessThanOrEqual(firstBottom + 1);
  expect(upper.y).toBeGreaterThanOrEqual(paper.y - 1);

  // 隙間の下寄り (2 ページ目に近い): 2 ページ目の内側に収まる。
  await page.mouse.move(x, secondTop - gap * 0.2);
  await page.keyboard.press("ControlOrMeta+V");
  await expect(page.locator(".overlay-shape-geo")).toHaveCount(4);
  const lower = (await page.locator(".overlay-shape-geo.selected").first().boundingBox())!;
  expect(lower.y).toBeGreaterThanOrEqual(secondTop - 1);
});

test("keeps a page-pinned shape pinned and saves the pasted position", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page);
  const paper = await pageBox(page);
  const target = { x: paper.x + paper.width * 0.6, y: sourceBox.y + sourceBox.height + 140 };

  await page.mouse.move(target.x, target.y);
  const pasted = await pasteAndGetNewBox(page, 2);
  const center = centerOfBox(pasted);
  expect(Math.abs(center.x - target.x)).toBeLessThan(3);
  expect(Math.abs(center.y - target.y)).toBeLessThan(3);
  const scale = sourceBox.width / RECT_SIZE.w;

  await expect.poll(async () => (await savedShapes(page)).length).toBe(3);
  const saved = await savedShapes(page);
  const copy = saved.find((shape) => shape.id !== SOURCE_RECT && shape.id !== ANCHORED_RECT)!;
  expect(copy.anchor?.type).toBe("page");
  // 保存された座標は、画面の位置を紙面の座標に直したもの。
  expect(copy.x).toBeCloseTo((pasted.x - paper.x) / scale, 0);
  expect(copy.y).toBeCloseTo((pasted.y - paper.y) / scale, 0);
});

test("hangs a pasted block-anchored shape on the body text again instead of pinning it to the page", async ({ page }) => {
  const sourceBox = await copySourceRectangle(page, ANCHORED_RECT);
  const paper = await pageBox(page);
  const target = { x: paper.x + paper.width * 0.6, y: sourceBox.y + sourceBox.height + 200 };

  await page.mouse.move(target.x, target.y);
  const pasted = await pasteAndGetNewBox(page, 2);
  const center = centerOfBox(pasted);
  expect(Math.abs(center.x - target.x)).toBeLessThan(3);
  expect(Math.abs(center.y - target.y)).toBeLessThan(3);

  // 新しく描いた図形と同じく、置いた位置から近い本文ブロックへ付け直される (ページ固定にはならない)。
  await expect.poll(async () => {
    const saved = await savedShapes(page);
    const copy = saved.find((shape) => shape.id !== SOURCE_RECT && shape.id !== ANCHORED_RECT);
    return copy?.anchor?.type ?? null;
  }).toBe("block");
});
