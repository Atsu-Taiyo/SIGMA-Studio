import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 表示 > ページの並び = 2列。2 ページずつ横に並べるのは表示だけで、文書 (座標・ページ割り) は
 * 1 列のときと同じモデル座標のまま。
 */

const PREFERENCE_KEY = "sigma-studio:page-arrangement-preference";
const PAGE3_SHAPE_ID = "spread_page3_shape";
const PAGE1_SHAPE_ID = "spread_page1_shape";
/** A4 の高さ (297mm) + ページの間隔 36px。文書を作るときだけ使う。 */
const SEED_STRIDE = 297 * (96 / 25.4) + 36;

function geoShape(id: string, x: number, y: number, fillColor: string) {
  return {
    id,
    type: "geo" as const,
    x,
    y,
    rotation: 0,
    props: {
      geo: "rectangle" as const,
      w: 120,
      h: 80,
      color: "#c2410c",
      labelColor: "#111111",
      fill: "solid" as const,
      fillColor,
      dash: "solid" as const,
      size: "m" as const,
    },
  };
}

/** 手動改ページで 4 ページに分けた教材。3 ページ目と 1 ページ目に図形を 1 つずつ置く。 */
function fourPageDocument(stride: number): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_page_spread";
  document.metadata = { ...document.metadata, title: "2ページ並び" };
  const paragraphs = [1, 2, 3, 4].map((page) => ({
    type: "paragraph" as const,
    id: `spread_p${page}`,
    ...(page > 1 ? { pagination: { break: true } } : {}),
    children: [{ type: "text" as const, text: `${page}ページ目の本文です。` }],
  }));
  // 2 ページ目には段落を 2 つ置く (グリップ・下余白つまみ・並べ替えを右の列で試す)。
  document.content = [
    paragraphs[0],
    paragraphs[1],
    { type: "paragraph" as const, id: "spread_p2b", children: [{ type: "text" as const, text: "2ページ目の2つ目の段落です。" }] },
    paragraphs[2],
    paragraphs[3],
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    header: {
      ...document.pageLayout!.header!,
      enabled: true,
      blocks: [{ type: "paragraph", id: "spread_header", children: [{ type: "text", text: "ヘッダー{page}" }] }],
    },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          geoShape(PAGE1_SHAPE_ID, 300, 400, "#fed7aa"),
          geoShape(PAGE3_SHAPE_ID, 300, 2 * stride + 400, "#bfdbfe"),
        ],
        assets: {},
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

async function readStride(page: Page): Promise<number> {
  return page.evaluate(() => Number(document.querySelector(".page-canvas")?.getAttribute("data-page-stride")));
}

async function sheetBoxes(page: Page) {
  return page.locator(".page-backdrop .a4-page-sheet").evaluateAll((sheets) => sheets.map((sheet) => {
    const rect = sheet.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }));
}

async function savedDocument(page: Page): Promise<SigmaDocument> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document") ?? "null"));
}

function shapeById(document: SigmaDocument, id: string) {
  return document.pageLayout?.overlay?.overlaySnapshot?.shapes.find((shape) => shape.id === id);
}

async function openSpreadDocument(page: Page) {
  await installDesktopRuntimeMock(page, fourPageDocument(SEED_STRIDE), { preserveStorageKeys: [PREFERENCE_KEY] });
  await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator('[data-sigma-doc-id="spread_p4"]').first()).toBeAttached();
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-count", "4");
  const toggle = page.getByRole("button", { name: "ページの並び: 2列" });
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-arrangement", "spread");
}

test.describe("ページの並び: 2列", () => {
  test("ページ 1|2 を横に、3|4 をその下に並べる", async ({ page }) => {
    await openSpreadDocument(page);
    await expect.poll(async () => {
      const sheets = await sheetBoxes(page);
      return sheets.length === 4
        && Math.abs(sheets[1].y - sheets[0].y) < 2
        && sheets[1].x > sheets[0].x + sheets[0].width
        && Math.abs(sheets[2].x - sheets[0].x) < 2
        && sheets[2].y > sheets[0].y + sheets[0].height
        && Math.abs(sheets[3].y - sheets[2].y) < 2;
    }).toBe(true);
    const sheets = await sheetBoxes(page);

    // 本文は自分のページの用紙の中に描かれる。
    for (const [index, id] of ["spread_p1", "spread_p2", "spread_p3", "spread_p4"].entries()) {
      const box = await page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first().boundingBox();
      expect(box, id).not.toBeNull();
      const sheet = sheets[index];
      expect(box!.x, `${id} x`).toBeGreaterThan(sheet.x);
      expect(box!.x + box!.width, `${id} right`).toBeLessThan(sheet.x + sheet.width + 1);
      expect(box!.y, `${id} y`).toBeGreaterThan(sheet.y);
      expect(box!.y + box!.height, `${id} bottom`).toBeLessThan(sheet.y + sheet.height);
    }

    // 3 ページ目の図形は 2 行目の左に描かれる。
    const shape = await page.locator(`[data-overlay-shape-id="${PAGE3_SHAPE_ID}"]`).first().boundingBox();
    expect(shape).not.toBeNull();
    expect(shape!.x).toBeGreaterThan(sheets[2].x);
    expect(shape!.x + shape!.width).toBeLessThan(sheets[2].x + sheets[2].width);
    expect(shape!.y).toBeGreaterThan(sheets[2].y);
    expect(shape!.y + shape!.height).toBeLessThan(sheets[2].y + sheets[2].height);
  });

  test("右の列の 2 ページ目をクリックして打つと 2 ページ目の段落に入る", async ({ page }) => {
    await openSpreadDocument(page);
    const target = page.locator('.page-flow [data-sigma-doc-id="spread_p2"]').first();
    const box = await target.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width - 4, box!.y + box!.height / 2);
    await page.keyboard.press("End");
    await page.keyboard.type("RIGHT_COLUMN");
    await expect(target).toContainText("2ページ目の本文です。RIGHT_COLUMN");
    await expect.poll(async () => JSON.stringify((await savedDocument(page))?.content ?? [])).toContain("RIGHT_COLUMN");
    const saved = await savedDocument(page);
    const paragraph = saved.content.find((block) => block.id === "spread_p2");
    expect(JSON.stringify(paragraph)).toContain("RIGHT_COLUMN");
    expect(JSON.stringify(saved.content.find((block) => block.id === "spread_p1"))).not.toContain("RIGHT_COLUMN");
  });

  test("1 ページ目の図形を 2 ページ目へドラッグするとモデル座標で 2 ページ目に載る", async ({ page }) => {
    await openSpreadDocument(page);
    const stride = await readStride(page);
    const shape = page.locator(`[data-overlay-shape-id="${PAGE1_SHAPE_ID}"]`).first();
    const before = await shape.boundingBox();
    expect(before).not.toBeNull();
    const sheets = await sheetBoxes(page);
    const grab = { x: before!.x + before!.width / 2, y: before!.y + before!.height / 2 };
    await page.mouse.click(grab.x, grab.y);
    await expect(page.locator(".overlay-canvas-editor")).toHaveCount(1);

    // 同じ高さのまま、右の列 (2 ページ目) の同じ位置へ運ぶ。
    const dx = sheets[1].x - sheets[0].x;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x + dx / 2, grab.y, { steps: 6 });
    await page.mouse.move(grab.x + dx, grab.y, { steps: 6 });
    // ドラッグ中も図形はポインタの下に描かれる。
    const during = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${PAGE1_SHAPE_ID}"]`).first().boundingBox();
    expect(Math.abs(during!.x + during!.width / 2 - (grab.x + dx))).toBeLessThan(8);
    await page.mouse.up();

    await expect.poll(async () => {
      const moved = shapeById(await savedDocument(page), PAGE1_SHAPE_ID);
      return moved ? Math.round(moved.y - stride) : null;
    }).toBe(400);
    const moved = shapeById(await savedDocument(page), PAGE1_SHAPE_ID)!;
    expect(Math.abs(moved.x - 300)).toBeLessThan(3);

    const after = await page.locator(`[data-overlay-shape-id="${PAGE1_SHAPE_ID}"]`).first().boundingBox();
    expect(after!.x).toBeGreaterThan(sheets[1].x);
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(3);

    // 1 列に戻しても文書は同じ (2 ページ目の上から 400px)。
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "ページの並び: 2列" }).click();
    await expect(page.locator(".page-canvas")).not.toHaveAttribute("data-page-arrangement", "spread");
    const singleSheets = await sheetBoxes(page);
    const single = await page.locator(`[data-overlay-shape-id="${PAGE1_SHAPE_ID}"]`).first().boundingBox();
    expect(Math.abs(single!.x - singleSheets[1].x - (before!.x - sheets[0].x))).toBeLessThan(3);
    expect(Math.abs(single!.y - singleSheets[1].y - (before!.y - sheets[0].y))).toBeLessThan(3);
    expect(shapeById(await savedDocument(page), PAGE1_SHAPE_ID)!.y).toBe(moved.y);
  });

  test("並びは表示の設定で、教材には保存しない (読み込み直しても文書は同じ)", async ({ page }) => {
    await openSpreadDocument(page);
    await page.locator('.page-flow [data-sigma-doc-id="spread_p1"]').first().click();
    await page.keyboard.press("End");
    await page.keyboard.type("X");
    await expect.poll(async () => JSON.stringify((await savedDocument(page))?.content ?? [])).toContain("本文です。X");
    const saved = await savedDocument(page);
    expect(JSON.stringify(saved)).not.toMatch(/arrangement|"spread"/i);
    expect(saved.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => [shape.id, shape.x, shape.y]))
      .toEqual(fourPageDocument(SEED_STRIDE).pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => [shape.id, shape.x, shape.y]));
    await expect.poll(() => page.evaluate((key) => localStorage.getItem(key), PREFERENCE_KEY)).toBe("spread");

    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".page-canvas")).toHaveAttribute("data-page-arrangement", "spread");
    await expect(page.getByRole("button", { name: "ページの並び: 2列" })).toHaveAttribute("aria-pressed", "true");
  });

  test("右の列の 2 ページ目でもグリップで段落を並べ替えられる", async ({ page }) => {
    await openSpreadDocument(page);
    const sheets = await sheetBoxes(page);
    const source = page.locator('.page-flow [data-sigma-doc-id="spread_p2b"]').first();
    const handle = page.locator('.page-block-handle[data-block-id="spread_p2b"]');
    await expect.poll(async () => {
      const box = (await source.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      return handle.isVisible();
    }).toBe(true);
    // グリップは 2 ページ目の用紙の左の余白に出る。
    const handleBox = (await handle.boundingBox())!;
    expect(handleBox.x).toBeGreaterThan(sheets[1].x);
    expect(handleBox.x).toBeLessThan((await source.boundingBox())!.x);

    const from = { x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 };
    const target = (await page.locator('.page-flow [data-sigma-doc-id="spread_p2"]').first().boundingBox())!;
    const to = { x: target.x + target.width / 2, y: target.y + target.height * 0.2 };
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let step = 1; step <= 12; step += 1) {
      await page.mouse.move(from.x + ((to.x - from.x) * step) / 12, from.y + ((to.y - from.y) * step) / 12);
      await page.waitForTimeout(16);
    }
    await expect(page.locator('.page-block-drop-line[data-orientation="horizontal"]')).toBeVisible();
    await page.mouse.up();
    await expect.poll(async () => (await savedDocument(page))?.content.map((block) => block.id))
      .toEqual(["spread_p1", "spread_p2b", "spread_p2", "spread_p3", "spread_p4"]);
  });

  test("右の列の 2 ページ目でも下余白つまみで段落の下の余白を伸ばせる", async ({ page }) => {
    await openSpreadDocument(page);
    const block = page.locator('.page-flow [data-sigma-doc-id="spread_p2"]').first();
    const follower = page.locator('.page-flow [data-sigma-doc-id="spread_p2b"]').first();
    const handle = page.locator('.page-block-space-handle[data-block-id="spread_p2"]');
    await expect.poll(async () => {
      const box = (await block.boundingBox())!;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      return handle.isVisible();
    }).toBe(true);
    const sheets = await sheetBoxes(page);
    const handleBox = (await handle.boundingBox())!;
    expect(handleBox.x).toBeGreaterThan(sheets[1].x - 40);
    const before = (await follower.boundingBox())!.y;
    const x = handleBox.x + handleBox.width / 2;
    const y = handleBox.y + handleBox.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 10; step += 1) {
      await page.mouse.move(x, y + 4 * step);
      await page.waitForTimeout(24);
    }
    await page.mouse.up();
    await expect.poll(async () => (await follower.boundingBox())!.y - before).toBeGreaterThan(25);
    await expect.poll(async () => JSON.stringify((await savedDocument(page))?.content.find((entry) => entry.id === "spread_p2")))
      .toContain("spaceAfterPx");
    // 動いたのは 2 ページ目の中だけ (3 ページ目は 2 行目の左のまま)。
    const third = (await page.locator('.page-flow [data-sigma-doc-id="spread_p3"]').first().boundingBox())!;
    expect(third.x).toBeLessThan(sheets[1].x);
    expect(third.y).toBeGreaterThan(sheets[0].y + sheets[0].height);
  });

  test("ヘッダーは各ページの用紙に描かれ、右の列のページでもダブルクリックで編集できる", async ({ page }) => {
    await openSpreadDocument(page);
    const sheets = await sheetBoxes(page);
    const headers = page.locator(".page-backdrop .a4-page-sheet .page-running-region.header");
    await expect(headers.nth(1)).toContainText("ヘッダー2");
    const header2 = (await headers.nth(1).boundingBox())!;
    expect(header2.x).toBeGreaterThan(sheets[1].x);
    expect(header2.y).toBeLessThan(sheets[1].y + 100);

    await page.mouse.dblclick(sheets[1].x + sheets[1].width / 2, sheets[1].y + 42);
    const editor = page.locator(".page-running-direct-editor.header");
    await expect(editor).toBeVisible();
    const editorBox = (await editor.boundingBox())!;
    expect(editorBox.x).toBeGreaterThan(sheets[1].x);
    expect(editorBox.x + editorBox.width).toBeLessThan(sheets[1].x + sheets[1].width + 1);
    await page.locator(".page-running-direct-editor.header .text-flow-editor").click();
    await page.keyboard.press("End");
    await page.keyboard.type("右");
    await page.keyboard.press("Escape");
    await expect.poll(async () => JSON.stringify((await savedDocument(page))?.pageLayout?.header?.blocks ?? []))
      .toContain("右");
  });
});
