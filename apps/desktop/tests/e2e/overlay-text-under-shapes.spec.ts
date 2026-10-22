import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 図形に覆われた文章の図形も、ダブルクリックで編集に入れる。
 *
 * 当たり判定は一番手前の図形を返すので、文章の図形の上に画像・図・四角形が重なると、
 * ダブルクリックは覆っている図形 (画像ならトリミング) に奪われて、下の文章へ届かなかった。
 * クリックでの選択は一番手前が勝つままで、ダブルクリックだけが「手前が文字を直さない図形なら
 * 下の文章の図形へ抜ける」。下に文章が無ければ従来どおり (画像はトリミング)。
 */

const ASSET_ID = "under_shapes_asset";
const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwC9jMuNbwhQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXBGyYx39YZbIAAAAASUVORK5CYII=";
const BODY_BLOCK_ID = "p_under_shapes_body";

const TEXT_UNDER_IMAGE = "text_under_image";
const COVER_IMAGE = "cover_image";
const TEXT_UNDER_RECT = "text_under_rect";
const COVER_RECT = "cover_rect";
const TEXT_ON_TOP = "text_on_top";
const BELOW_IMAGE = "below_image";
const LONE_IMAGE = "lone_image";
const LOCKED_TEXT = "locked_text";
const COVER_OF_LOCKED = "cover_of_locked";

function richText(id: string, x: number, y: number, label: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "text",
    x,
    y,
    rotation: 0,
    anchor: { type: "page" },
    ...extra,
    props: {
      w: 220,
      h: 40,
      color: "#111111",
      size: "m",
      blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text: label }] }],
    },
  };
}

function image(id: string, x: number, y: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "image",
    x,
    y,
    rotation: 0,
    anchor: { type: "page" },
    ...extra,
    props: { assetId: ASSET_ID, w: 140, h: 90 },
  };
}

function dashedRectangle(id: string, x: number, y: number) {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation: 0,
    anchor: { type: "page" },
    props: {
      geo: "rectangle",
      w: 240,
      h: 90,
      color: "#111111",
      labelColor: "#111111",
      fill: "none",
      dash: "dashed",
      size: "m",
    },
  };
}

// 本文は短く、図形は本文の無い下の余白に置く (素のクリックで掴める領域)。
const SHAPES = [
  // 画像が文章を覆う。後ろにある配列ほど手前。
  richText(TEXT_UNDER_IMAGE, 120, 430, "画像の下の文章"),
  image(COVER_IMAGE, 100, 410),
  // 四角形 (塗りなし・破線) が文章を覆う。
  richText(TEXT_UNDER_RECT, 120, 560, "四角形の下の文章"),
  dashedRectangle(COVER_RECT, 100, 540),
  // 文章が画像より手前: 今までどおり手前の文章が編集される。
  image(BELOW_IMAGE, 500, 410),
  richText(TEXT_ON_TOP, 510, 430, "手前の文章"),
  // 下に文章の無い画像: 今までどおりトリミング。
  image(LONE_IMAGE, 500, 560),
  // ロックされた文章の上に画像: 編集に入れない文章へは抜けず、画像のトリミングのまま。
  richText(LOCKED_TEXT, 120, 700, "ロックされた文章", { locked: true }),
  image(COVER_OF_LOCKED, 100, 680),
];

function underShapesDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_text_under_shapes";
  document.metadata = { ...document.metadata, title: "覆われた文章のダブルクリック E2E" };
  document.content = [
    { type: "paragraph", id: BODY_BLOCK_ID, children: [{ type: "text", text: "本文の一行です。" }] },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: SHAPES,
        assets: {
          [ASSET_ID]: {
            id: ASSET_ID,
            type: "image",
            props: {
              w: 160,
              h: 100,
              name: "under-shapes.png",
              isAnimated: false,
              mimeType: "image/png",
              src: IMAGE_DATA_URL,
              fileSize: 1024,
            },
          },
        },
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 1600, height: 1100 });
  await installDesktopRuntimeMock(page, underShapesDocument());
  await page.goto("/");
  await expect(page.locator(`[data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first()).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  // 図形の位置はアンカー解決とブリード適用が終わるまで動くので、落ち着いてから座標を採る。
  await page.waitForTimeout(1200);
});

interface Box { x: number; y: number; width: number; height: number }

async function boxOf(page: Page, id: string): Promise<Box> {
  const shape = page.locator(`.overlay-shape[data-overlay-shape-id="${id}"]`).first();
  await expect(shape).toBeVisible();
  await shape.scrollIntoViewIfNeeded();
  const box = await shape.boundingBox();
  expect(box, `${id} の矩形が取れない`).not.toBeNull();
  return box!;
}

/** 2 つの図形が重なっている部分の中心。文章の箱の中で、覆っている図形の中でもある点。 */
async function overlapPoint(page: Page, textId: string, coverId: string): Promise<{ x: number; y: number }> {
  const text = await boxOf(page, textId);
  const cover = await boxOf(page, coverId);
  const left = Math.max(text.x, cover.x);
  const right = Math.min(text.x + text.width, cover.x + cover.width);
  const top = Math.max(text.y, cover.y);
  const bottom = Math.min(text.y + text.height, cover.y + cover.height);
  expect(right - left, `${textId} と ${coverId} が重なっていない`).toBeGreaterThan(10);
  expect(bottom - top, `${textId} と ${coverId} が重なっていない`).toBeGreaterThan(10);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

async function savedShapes(page: Page): Promise<Array<{ id: string; x: number; y: number; props: Record<string, unknown> }>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const saved = raw ? JSON.parse(raw) : null;
    return saved?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  });
}

function plainText(blocks: unknown): string {
  const walk = (node: unknown): string => {
    if (!node || typeof node !== "object") return "";
    const value = node as { text?: string; children?: unknown[] };
    return (value.text ?? "") + (value.children ?? []).map(walk).join("");
  };
  return (Array.isArray(blocks) ? blocks : []).map(walk).join("\n");
}

async function savedText(page: Page, id: string): Promise<string | null> {
  const shape = (await savedShapes(page)).find((item) => item.id === id);
  return shape ? plainText(shape.props.blocks) : null;
}

function textEditor(page: Page, id: string) {
  return page.locator(`.overlay-shape-text[data-overlay-shape-id="${id}"] .overlay-text-shape-content`);
}

/** 本文モードから、素のクリックで一番手前の図形を掴む (下に本文が無いので透過しない)。 */
async function grabTopmost(page: Page, point: { x: number; y: number }, selectedId: string): Promise<void> {
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${selectedId}"]`)).toHaveCount(1);
  // 連続した押下を 1 つのダブルクリックに数えないよう、間を空ける。
  await page.waitForTimeout(700);
}

test("edits the text under an image when the image is selected and double-clicked", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_UNDER_IMAGE, COVER_IMAGE);
  await grabTopmost(page, point, COVER_IMAGE);

  await page.mouse.dblclick(point.x, point.y);

  const editor = textEditor(page, TEXT_UNDER_IMAGE);
  await expect(editor).toBeFocused();
  await expect(page.locator(".overlay-selection-box.image-cropping")).toHaveCount(0);

  await page.keyboard.type("追記");
  await page.keyboard.press("Escape");

  await expect.poll(() => savedText(page, TEXT_UNDER_IMAGE)).toContain("追記");
  // 覆っていた画像は触っていない (位置もトリミングも元のまま)。
  const cover = (await savedShapes(page)).find((item) => item.id === COVER_IMAGE)!;
  expect({ x: cover.x, y: cover.y }).toEqual({ x: 100, y: 410 });
  expect(cover.props.crop).toBeUndefined();
});

test("edits the text under an image straight from the body, with plain double-clicking", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_UNDER_IMAGE, COVER_IMAGE);

  // 本文モードのまま、掴む前にいきなりダブルクリックする。
  await page.mouse.dblclick(point.x, point.y);

  await expect(textEditor(page, TEXT_UNDER_IMAGE)).toBeFocused();
  await page.keyboard.type("本文から");
  await page.keyboard.press("Escape");
  await expect.poll(() => savedText(page, TEXT_UNDER_IMAGE)).toContain("本文から");
  await expect(page.locator(".overlay-selection-box.image-cropping")).toHaveCount(0);
});

test("edits the text under a rectangle", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_UNDER_RECT, COVER_RECT);
  await grabTopmost(page, point, COVER_RECT);

  await page.mouse.dblclick(point.x, point.y);

  await expect(textEditor(page, TEXT_UNDER_RECT)).toBeFocused();
  await page.keyboard.type("四角の下");
  await page.keyboard.press("Escape");

  await expect.poll(() => savedText(page, TEXT_UNDER_RECT)).toContain("四角の下");
  const cover = (await savedShapes(page)).find((item) => item.id === COVER_RECT)!;
  expect({ x: cover.x, y: cover.y }).toEqual({ x: 100, y: 540 });
});

test("a single click still selects the topmost shape, not the text under it", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_UNDER_IMAGE, COVER_IMAGE);

  await page.mouse.click(point.x, point.y);

  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${COVER_IMAGE}"]`)).toHaveCount(1);
  await expect(page.locator(`.overlay-shape.selected[data-overlay-shape-id="${TEXT_UNDER_IMAGE}"]`)).toHaveCount(0);
});

test("keeps editing the topmost text shape when it is on top of an image", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_ON_TOP, BELOW_IMAGE);
  await grabTopmost(page, point, TEXT_ON_TOP);

  await page.mouse.dblclick(point.x, point.y);

  await expect(textEditor(page, TEXT_ON_TOP)).toBeFocused();
  await expect(page.locator(".overlay-selection-box.image-cropping")).toHaveCount(0);
});

test("still crops an image that has no text under it", async ({ page }) => {
  const box = await boxOf(page, LONE_IMAGE);
  const point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await grabTopmost(page, point, LONE_IMAGE);

  await page.mouse.dblclick(point.x, point.y);

  await expect(page.locator(".overlay-selection-box.image-cropping")).toBeVisible();
});

test("does not reach through to text that cannot be edited, and crops the image as before", async ({ page }) => {
  const point = await overlapPoint(page, LOCKED_TEXT, COVER_OF_LOCKED);
  await grabTopmost(page, point, COVER_OF_LOCKED);

  await page.mouse.dblclick(point.x, point.y);

  await expect(page.locator(".overlay-selection-box.image-cropping")).toBeVisible();
  await expect(textEditor(page, LOCKED_TEXT)).not.toBeFocused();
});

test("keeps the image's crop reachable from its selection toolbar and menu when text sits under it", async ({ page }) => {
  const point = await overlapPoint(page, TEXT_UNDER_IMAGE, COVER_IMAGE);
  await grabTopmost(page, point, COVER_IMAGE);

  // 右クリックのメニューからトリミング。
  await page.mouse.click(point.x, point.y, { button: "right" });
  const menu = page.locator(".overlay-shape-context-menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: "画像をトリミング", exact: true }).click();
  await expect(page.locator(".overlay-selection-box.image-cropping")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".overlay-selection-box.image-cropping")).toHaveCount(0);

  // 選択バーのトリミングボタンからも入れる。
  await page.mouse.click(point.x, point.y);
  await page.getByRole("button", { name: "トリミング", exact: true }).click();
  await expect(page.locator(".overlay-selection-box.image-cropping")).toBeVisible();
});
