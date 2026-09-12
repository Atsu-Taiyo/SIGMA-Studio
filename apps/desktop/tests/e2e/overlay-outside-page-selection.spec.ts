import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 用紙の外にはみ出したオブジェクトは、素のクリックでそのまま掴める。
 *
 * 本文モードの「未選択の図形は本文を透過する」規約 (`body-pointer-passthrough.spec.ts`) は
 * 下に本文があるときの話で、用紙の外・余白・本文の切れ目には透過する相手がいない。そこまで
 * 透過していたせいで、用紙の外に出したオブジェクトは Ctrl/Cmd を押さないと選べなかった。
 *
 * 種別で挙動を変えないことも同時に固定する — 図形・画像・表・テキスト、そして「最背面へ」で
 * 背面レイヤーに送ったものまで、同じ 1 クリックで選べる。
 */

const ASSET_ID = "outside_page_asset";
const BODY_BLOCK_ID = "p_outside_page_body";

/** 実体のある PNG (1 色)。画像図形は asset が解決できないと描画されない。 */
const IMAGE_DATA_URL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAKAAAABkCAIAAACO1KzYAAABAUlEQVR4nO3RAQkAIBDAwC9jMuNbwhQijIMLMNisfQib7wU8ZXCcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEGxxkcZ3CcwXEXBGyYx39YZbIAAAAASUVORK5CYII=";

type Placement = { id: string; x: number; y: number };

/** 用紙 (A4 幅 ≒ 794px) の左外・右外・上外、用紙の中の余白、本文の上。 */
const OUTSIDE_LEFT_X = -190;
const OUTSIDE_RIGHT_X = 830;

function geoShape({ id, x, y }: Placement, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation: 0,
    ...extra,
    props: {
      geo: "rectangle",
      w: 140,
      h: 90,
      color: "#111111",
      labelColor: "#111111",
      fill: "solid",
      dash: "solid",
      size: "m",
    },
  };
}

function imageShape({ id, x, y }: Placement, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: "image",
    x,
    y,
    rotation: 0,
    ...extra,
    props: { assetId: ASSET_ID, w: 140, h: 90 },
  };
}

function tableShape({ id, x, y }: Placement) {
  return {
    id,
    type: "tableShape",
    x,
    y,
    rotation: 0,
    props: {
      w: 140,
      h: 68,
      table: {
        version: 1,
        kind: "plain",
        columns: [
          { id: `${id}_col_1`, width: { mode: "fr", value: 1, min: 60 } },
          { id: `${id}_col_2`, width: { mode: "fr", value: 1, min: 60 } },
        ],
        rows: [{ id: `${id}_row_1`, height: { mode: "auto", min: 34 }, role: "body" }],
        cells: [
          {
            id: `${id}_cell_1`,
            rowId: `${id}_row_1`,
            columnId: `${id}_col_1`,
            content: [{ type: "paragraph", id: `${id}_cell_1_p`, align: "center", children: [{ type: "text", text: "あ" }] }],
          },
          {
            id: `${id}_cell_2`,
            rowId: `${id}_row_1`,
            columnId: `${id}_col_2`,
            content: [{ type: "paragraph", id: `${id}_cell_2_p`, align: "center", children: [{ type: "text", text: "い" }] }],
          },
        ],
        grid: {
          borderColor: "#111827",
          borderWidth: 1,
          borderStyle: "solid",
          showOuterBorder: true,
          showInnerBorders: true,
        },
        defaultCellStyle: {
          align: "center",
          verticalAlign: "middle",
          paddingX: 8,
          paddingY: 5,
          color: "#111827",
          fontSize: 15,
          fontWeight: "normal",
        },
      },
    },
  };
}

function textShape({ id, x, y }: Placement) {
  return {
    id,
    type: "text",
    x,
    y,
    rotation: 0,
    props: {
      w: 140,
      h: 40,
      color: "#111111",
      size: "m",
      blocks: [{ type: "paragraph", id: "overlay_outside_page_selection_spec_43", children: [{ type: "text", text: "そと" }] }],
    },
  };
}

/** 用紙の外に出したオブジェクト。種別と、前面/背面レイヤーを一通り並べる。 */
const OUTSIDE_PAGE_IDS = [
  "outside_geo",
  "outside_image",
  "outside_table",
  "outside_text",
  "outside_background_image",
  "outside_background_geo",
  "outside_right_image",
  "outside_top_image",
] as const;

const SHAPES = [
  geoShape({ id: "outside_geo", x: OUTSIDE_LEFT_X, y: 200 }),
  imageShape({ id: "outside_image", x: OUTSIDE_LEFT_X, y: 330 }),
  tableShape({ id: "outside_table", x: OUTSIDE_LEFT_X, y: 460 }),
  textShape({ id: "outside_text", x: OUTSIDE_LEFT_X, y: 580 }),
  // 「最背面へ」で背面レイヤーに送ったオブジェクト。描画面は pointer-events を持たないので、
  // 経路は JS のヒットテストだけが頼りになる。
  imageShape({ id: "outside_background_image", x: OUTSIDE_LEFT_X, y: 670 }, { stackLayer: "background" }),
  geoShape({ id: "outside_background_geo", x: OUTSIDE_LEFT_X, y: 800 }, { stackLayer: "background" }),
  imageShape({ id: "outside_right_image", x: OUTSIDE_RIGHT_X, y: 200 }),
  imageShape({ id: "outside_top_image", x: 120, y: -150 }),
  // 用紙の中だが本文の無いところ (左の余白)。ここも透過する相手がいない。
  imageShape({ id: "margin_image", x: 18, y: 950 }),
  // 本文の上に重なった画像。従来どおり押下は本文へ透過する。
  imageShape({ id: "body_image", x: 120, y: 120 }),
];

function outsidePageDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_outside_page_selection";
  document.metadata = { ...document.metadata, title: "用紙外オブジェクトの選択 E2E" };
  document.content = [
    {
      type: "paragraph",
      id: BODY_BLOCK_ID,
      children: [{ type: "text", text: "用紙の中の本文です。".repeat(12) }],
    },
    {
      type: "paragraph",
      id: "p_outside_page_body_2",
      children: [{ type: "text", text: "二段落目の本文です。".repeat(12) }],
    },
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
              name: "outside.png",
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
  await installDesktopRuntimeMock(page, outsidePageDocument());
  await page.goto("/");
  await expect(page.locator(`[data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first()).toBeVisible();
  // 起動スプラッシュが残っていると座標押下がそこへ吸われる。図形の位置もアンカー解決と
  // ブリード適用が終わるまで動くので、落ち着いてから座標を採る。
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
  await page.waitForTimeout(1200);
});

/**
 * `page.mouse` は locator と違って自動スクロールしないので、座標を採る前に view へ入れる。
 * 用紙の外のオブジェクトは初期表示で viewport の外にいることがある。
 */
async function shapePoint(page: Page, id: string): Promise<{ x: number; y: number }> {
  const shape = page.locator(`[data-overlay-shape-id="${id}"]`).first();
  await expect(shape).toBeVisible();
  await shape.scrollIntoViewIfNeeded();
  const box = await shape.boundingBox();
  expect(box, `${id} の矩形が取れない`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

async function expectSelectedAfterPlainClick(page: Page, id: string) {
  const point = await shapePoint(page, id);
  await page.mouse.click(point.x, point.y);
  await expect(
    page.locator(`.overlay-shape.selected[data-overlay-shape-id="${id}"]`),
    `${id} が素のクリックで選択されない`,
  ).toHaveCount(1);
}

/** 図形を選んだ状態から本文モードへ戻す (次の 1 クリック目を毎回同じ条件で始める)。 */
async function backToBodyMode(page: Page) {
  await page.keyboard.press("Escape");
  const paragraph = page.locator(`[data-sigma-doc-id="${BODY_BLOCK_ID}"]`).first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox();
  await page.mouse.click(box!.x + 40, box!.y + box!.height / 2);
  await expect(page.locator('[data-overlay-editing="true"]')).toHaveCount(0);
}

test("selects every kind of object outside the paper with a plain click", async ({ page }) => {
  for (const id of OUTSIDE_PAGE_IDS) {
    await expectSelectedAfterPlainClick(page, id);
    await backToBodyMode(page);
  }
});

test("selects an object sitting in the page margin with a plain click", async ({ page }) => {
  await expectSelectedAfterPlainClick(page, "margin_image");
});

test("keeps passing the press through to the body text under an unselected object", async ({ page }) => {
  const point = await shapePoint(page, "body_image");
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
  await expect(page.locator('[data-overlay-editing="true"]')).toHaveCount(0);
});

test("moves an object outside the paper with a plain drag", async ({ page }) => {
  const start = await shapePoint(page, "outside_image");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 30, start.y + 40, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const moved = await shapePoint(page, "outside_image");
    return Math.round(moved.x - start.x);
  }).toBe(30);
  const moved = await shapePoint(page, "outside_image");
  expect(Math.abs(moved.y - start.y - 40)).toBeLessThan(6);
});

test("drags an already selected background image outside the paper", async ({ page }) => {
  await expectSelectedAfterPlainClick(page, "outside_background_image");
  const start = await shapePoint(page, "outside_background_image");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 35, start.y + 25, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.round((await shapePoint(page, "outside_background_image")).x - start.x)).toBe(35);
});

test("uses the table toolbar beyond the paper edge", async ({ page }) => {
  await expectSelectedAfterPlainClick(page, "outside_table");
  const point = await shapePoint(page, "outside_table");
  await page.mouse.dblclick(point.x, point.y);
  const table = page.locator('.overlay-shape[data-overlay-shape-id="outside_table"]');
  await expect(table.locator('.overlay-table-shape.editing')).toBeVisible();
  await table.getByTestId('overlay-table-column-boundary').first().click();
  const toolbar = page.locator('.overlay-table-floating-toolbar');
  await expect(toolbar).toBeVisible();
  const grip = toolbar.locator('.overlay-table-toolbar-grip');
  const gripBox = (await grip.boundingBox())!;
  await page.mouse.move(gripBox.x + 10, gripBox.y + 10);
  await page.mouse.down();
  await page.mouse.move(1380, gripBox.y - 100, { steps: 8 });
  await page.mouse.up();
  const paperBox = (await page.locator('.page-canvas').boundingBox())!;
  const toolbarBox = (await toolbar.boundingBox())!;
  expect(toolbarBox.x).toBeGreaterThan(paperBox.x + paperBox.width);
  await toolbar.locator('button').nth(1).click();
  const menu = page.locator('[data-toolbar-popover]').first();
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitemradio', { name: '破線', exact: true }).click();
  await expect.poll(async () => {
    const doc = await page.evaluate(() => window.desktopAPI!.storage.loadDocument('file_e2e_document'));
    return JSON.stringify(doc?.pageLayout?.overlay?.overlaySnapshot);
  }).toContain('dashed');
  await expect(table.locator('.overlay-table-shape.editing')).toBeVisible();
  await page.setViewportSize({ width: 1100, height: 900 });
  await expect.poll(async () => {
    const bounds = (await toolbar.boundingBox())!;
    return bounds.x + bounds.width;
  }).toBeLessThanOrEqual(1092);
  await backToBodyMode(page);
  await expect(toolbar).toHaveCount(0);
});

test("crops an image outside the paper and reopens the saved result", async ({ page }) => {
  await expectSelectedAfterPlainClick(page, "outside_right_image");
  await page.locator('.overlay-shape.selected[data-overlay-shape-id="outside_right_image"]').dblclick();
  const handle = page.locator('.overlay-crop-handle.se');
  await expect(handle).toBeVisible();
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 - 25, box.y + box.height / 2 - 15, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const doc = await page.evaluate(() => window.desktopAPI!.storage.loadDocument('file_e2e_document'));
    const snapshot = doc?.pageLayout?.overlay?.overlaySnapshot as { shapes: Array<{ id: string; props: { w: number } }> };
    return snapshot.shapes.find((shape) => shape.id === 'outside_right_image')!.props.w;
  }).toBeLessThan(130);
  const saved = await page.evaluate(() => window.desktopAPI!.storage.loadDocument('file_e2e_document'));
  await installDesktopRuntimeMock(page, saved!);
  await page.reload();
  await page.locator('.startup-splash').waitFor({ state: 'hidden' });
  await expectSelectedAfterPlainClick(page, 'outside_right_image');
  const image = page.locator('.overlay-shape.selected[data-overlay-shape-id="outside_right_image"]');
  await expect(image).toBeVisible();
  expect((await image.boundingBox())!.width).toBeLessThan(130);
});
