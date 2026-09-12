import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const PAPER_TOP_SHAPE_ID = "drag_auto_scroll_top";
const PAPER_LOW_SHAPE_ID = "drag_auto_scroll_low";
const WHITEBOARD_SHAPE_ID = "drag_auto_scroll_whiteboard";
const OUTSIDE_X = -190;

function geoShape(id: string, x: number, y: number, fillColor: string) {
  return {
    id,
    type: "geo" as const,
    x,
    y,
    rotation: 0,
    props: {
      geo: "rectangle" as const,
      w: 140,
      h: 90,
      color: "#c2410c",
      labelColor: "#111111",
      fill: "solid" as const,
      fillColor,
      dash: "solid" as const,
      size: "m" as const,
    },
  };
}

function longPaperDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_overlay_drag_auto_scroll";
  document.metadata = { ...document.metadata, title: "図形ドラッグのオートスクロール" };
  document.content = Array.from({ length: 80 }, (_, index) => ({
    type: "paragraph" as const,
    id: `p_drag_auto_scroll_${index}`,
    children: [{ type: "text" as const, text: `${index + 1}行目の本文です。`.repeat(6) }],
  }));
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          geoShape(PAPER_TOP_SHAPE_ID, OUTSIDE_X, 180, "#fed7aa"),
          geoShape(PAPER_LOW_SHAPE_ID, OUTSIDE_X, 2600, "#bfdbfe"),
        ],
        assets: {},
      },
    },
  } as SigmaDocument["pageLayout"];
  return document;
}

const WHITEBOARD_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_whiteboard_drag_auto_scroll",
  metadata: { title: "ホワイトボードの図形ドラッグオートスクロール" },
  content: [],
  pageLayout: {
    preset: "whiteboard",
    orientation: "portrait",
    pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [geoShape(WHITEBOARD_SHAPE_ID, 200, 200, "#fde68a")],
        assets: {},
      },
    },
  },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
};

async function readScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => document.querySelector(".editor-canvas")?.scrollTop ?? -1);
}

/** 図形の文書内での縦位置。overlay canvas の原点からの相対 px。 */
async function readShapeDocumentY(page: Page, id: string): Promise<number> {
  return page.evaluate((shapeId) => {
    const shape = document.querySelector(`[data-overlay-shape-id="${shapeId}"]`);
    const canvas = document.querySelector(".overlay-canvas-editor")
      ?? document.querySelector(".page-overlay-layer");
    if (!shape || !canvas) {
      return -1;
    }
    return shape.getBoundingClientRect().top - canvas.getBoundingClientRect().top;
  }, id);
}

async function shapeCenter(page: Page, id: string): Promise<{ x: number; y: number }> {
  const shape = page.locator(`[data-overlay-shape-id="${id}"]`).first();
  const box = await shape.boundingBox();
  expect(box, `${id} の矩形が取れない`).not.toBeNull();
  return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** 用紙外の図形を素のクリックで選び、overlay 編集面へ入る。 */
async function enterPaperOverlayMode(page: Page, id: string) {
  const shape = page.locator(`[data-overlay-shape-id="${id}"]`).first();
  await expect(shape).toBeVisible();
  await shape.scrollIntoViewIfNeeded();
  const point = await shapeCenter(page, id);
  await page.mouse.click(point.x, point.y);
  await expect(page.locator(".overlay-canvas-editor")).toHaveCount(1);
}

/** 指定した図形の中心を viewport 下端の帯へ寄せる。 */
async function bringShapeToBottomBand(page: Page, id: string, canvasBottom: number) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const center = await shapeCenter(page, id);
    const delta = center.y - (canvasBottom - 16);
    if (Math.abs(delta) < 4) {
      return;
    }
    await page.evaluate((amount) => {
      const canvas = document.querySelector(".editor-canvas");
      if (canvas) {
        canvas.scrollTop += amount;
      }
    }, delta);
    await page.waitForTimeout(150);
  }
}

async function readWhiteboardPanY(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewport = document.querySelector(".whiteboard-page-canvas") as HTMLElement | null;
    return Number.parseFloat(viewport?.style.getPropertyValue("--whiteboard-pan-y") ?? "") || 0;
  });
}

test.describe("紙面での図形ドラッグオートスクロール", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.setViewportSize({ width: 1400, height: 900 });
    await installDesktopRuntimeMock(page, longPaperDocument());
    await page.goto("/");
    await expect(page.locator('[data-sigma-doc-id="p_drag_auto_scroll_0"]').first()).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
  });

  test("下端の帯へ運ぶと紙面が流れ、図形が追従する", async ({ page }) => {
    const canvasBox = await page.locator(".editor-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    await enterPaperOverlayMode(page, PAPER_TOP_SHAPE_ID);

    const documentYBefore = await readShapeDocumentY(page, PAPER_TOP_SHAPE_ID);
    const grab = await shapeCenter(page, PAPER_TOP_SHAPE_ID);
    const pointerY = canvasBox!.y + canvasBox!.height - 14;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, (grab.y + pointerY) / 2, { steps: 8 });
    await page.mouse.move(grab.x, pointerY, { steps: 8 });
    const scrollAtBand = await readScrollTop(page);
    await page.waitForTimeout(1500);

    const scrollAfter = await readScrollTop(page);
    const centerWhileDragging = await shapeCenter(page, PAPER_TOP_SHAPE_ID);
    await page.mouse.up();
    const documentYAfter = await readShapeDocumentY(page, PAPER_TOP_SHAPE_ID);

    expect(scrollAfter - scrollAtBand, "下端の帯に留まる間に紙面が 600px 以上流れる").toBeGreaterThanOrEqual(600);
    expect(Math.abs(centerWhileDragging.y - pointerY), "図形がポインタに追従する").toBeLessThan(60);
    expect(documentYAfter - documentYBefore, "指を離した後も図形が文書内で 600px 以上下へ移動している").toBeGreaterThanOrEqual(600);
  });

  test("上端の帯では逆向きに流れる", async ({ page }) => {
    const canvasBox = await page.locator(".editor-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    await enterPaperOverlayMode(page, PAPER_TOP_SHAPE_ID);

    const grab = await shapeCenter(page, PAPER_TOP_SHAPE_ID);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, canvasBox!.y + canvasBox!.height - 14, { steps: 10 });
    await page.waitForTimeout(1500);
    const scrollDown = await readScrollTop(page);

    await page.mouse.move(grab.x, canvasBox!.y + 14, { steps: 10 });
    await page.waitForTimeout(1500);
    const scrollUp = await readScrollTop(page);
    await page.mouse.up();

    expect(scrollDown, "下端の帯で十分に下へ流れる").toBeGreaterThanOrEqual(600);
    expect(scrollUp, "上端の帯では scrollTop が大きく戻る").toBeLessThan(scrollDown - 400);
  });

  test("帯を出たら止まる", async ({ page }) => {
    const canvasBox = await page.locator(".editor-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    await enterPaperOverlayMode(page, PAPER_TOP_SHAPE_ID);

    const grab = await shapeCenter(page, PAPER_TOP_SHAPE_ID);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, canvasBox!.y + canvasBox!.height - 14, { steps: 10 });
    await page.waitForTimeout(800);

    // 下端の帯から 120px 内側へ戻し、停止後の位置を基準にする。
    await page.mouse.move(grab.x, canvasBox!.y + canvasBox!.height - 120, { steps: 6 });
    await page.waitForTimeout(120);
    const scrollAfterLeavingBand = await readScrollTop(page);
    await page.waitForTimeout(1000);
    const scrollLater = await readScrollTop(page);
    await page.mouse.up();

    expect(Math.abs(scrollLater - scrollAfterLeavingBand), "帯を出た後は紙面が動かない").toBeLessThan(10);
  });

  test("帯の中の図形を押しただけでは流れない", async ({ page }) => {
    const canvasBox = await page.locator(".editor-canvas").boundingBox();
    expect(canvasBox).not.toBeNull();
    await enterPaperOverlayMode(page, PAPER_TOP_SHAPE_ID);
    await bringShapeToBottomBand(page, PAPER_LOW_SHAPE_ID, canvasBox!.y + canvasBox!.height);

    const pressPoint = await shapeCenter(page, PAPER_LOW_SHAPE_ID);
    const scrollBefore = await readScrollTop(page);
    await page.mouse.move(pressPoint.x, pressPoint.y);
    await page.mouse.down();
    // 下端の帯にある図形を選ぶ際、1px の手ぶれだけで紙面と図形が約 316px 飛んだ回帰を防ぐ。
    await page.mouse.move(pressPoint.x + 1, pressPoint.y);
    await page.waitForTimeout(900);
    const scrollWhilePressed = await readScrollTop(page);
    await page.mouse.up();

    expect(Math.abs(scrollWhilePressed - scrollBefore), "1px 揺らしただけでは紙面が流れない").toBeLessThan(20);
  });
});

test.describe("ホワイトボードでの図形ドラッグオートスクロール", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => window.localStorage.clear());
    await page.setViewportSize({ width: 1400, height: 900 });
    await installDesktopRuntimeMock(page, WHITEBOARD_DOCUMENT);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
    await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  });

  test("下端へ運ぶとカメラが負方向へ流れ、図形が追従する", async ({ page }) => {
    const viewportBox = await page.locator(".whiteboard-page-canvas").boundingBox();
    expect(viewportBox).not.toBeNull();

    const initialCenter = await shapeCenter(page, WHITEBOARD_SHAPE_ID);
    await page.mouse.click(initialCenter.x, initialCenter.y);
    const grab = await shapeCenter(page, WHITEBOARD_SHAPE_ID);
    const pointerY = viewportBox!.y + viewportBox!.height - 14;
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(grab.x, (grab.y + pointerY) / 2, { steps: 8 });
    await page.mouse.move(grab.x, pointerY, { steps: 8 });
    await expect.poll(
      () => readWhiteboardPanY(page),
      { message: "下端ではカメラ pan が負方向になり、内容が上へ流れる", timeout: 5_000 },
    ).toBeLessThanOrEqual(-400);

    const panY = await readWhiteboardPanY(page);
    const centerWhileDragging = await shapeCenter(page, WHITEBOARD_SHAPE_ID);
    await page.mouse.up();

    expect(panY, "下端ではカメラ pan が負方向になり、内容が上へ流れる").toBeLessThanOrEqual(-400);
    expect(Math.abs(centerWhileDragging.y - pointerY), "カメラ移動中も図形がポインタに追従する").toBeLessThan(60);
  });
});
