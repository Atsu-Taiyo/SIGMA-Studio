import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * リサイズは「見えている枠」を動かす (WI-15)。
 *
 * 図形は必ず用紙の内側に収まる位置・大きさで置く: 保存箱が紙面からはみ出すと、ドラッグ中に
 * 用紙の外側 (bleed) が広がって用紙自体が動き、ポインタの移動量が目減りする。挿入直後の弧で
 * これが起きるため、「掴んだ辺がポインタにぴったり追従する」の検証はここで行う。
 */

const ARC_ORIGIN = { x: 300, y: 300 };
const ARC_RADIUS = 100;
/** 0°→90° の弧。インクは中心 (400,400) から右下 100x100 だけで、保存箱 (200x200) の 1/4。 */
const ARC_INK = { x: 400, y: 400, w: ARC_RADIUS, h: ARC_RADIUS };

function createDocumentWithArcAndRect(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_visual_resize";
  document.content = [
    {
      type: "paragraph",
      id: "p_body",
      lineHeight: "1.35",
      children: [{ type: "text", text: "図形のリサイズを確かめる本文です。", fontFamily: "serif" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "shape_arc",
            type: "arc",
            x: ARC_ORIGIN.x,
            y: ARC_ORIGIN.y,
            anchor: { type: "page" },
            props: {
              r: ARC_RADIUS,
              rx: ARC_RADIUS,
              ry: ARC_RADIUS,
              startAngle: 0,
              endAngle: Math.PI / 2,
              color: "#1133cc",
              dash: "solid",
              size: "m",
            },
          },
          {
            id: "shape_rect",
            type: "geo",
            x: 120,
            y: 620,
            anchor: { type: "page" },
            props: {
              w: 200,
              h: 120,
              geo: "rectangle",
              fill: "none",
              color: "#1133cc",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
  };
  return document;
}

async function openEditor(page: Page): Promise<void> {
  // 直前の spec が残した教材を復元されると、掴む座標がまるで別の図形を指す。
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await installDesktopRuntimeMock(page, createDocumentWithArcAndRect());
  await page.goto("/");
  await expect(page.locator(".page-canvas")).toBeVisible();
  await expect(page.locator(".overlay-shape-arc")).toHaveCount(1);
}

/** 図形の DOM は保存箱そのものなので、紙面座標との対応はそこから採れる。 */
async function pageToClient(page: Page, selector: string, origin: { x: number; y: number }, storedWidth: number) {
  const box = await page.locator(selector).first().boundingBox();
  expect(box).not.toBeNull();
  const scale = box!.width / storedWidth;
  return (point: { x: number; y: number }) => ({
    x: box!.x + (point.x - origin.x) * scale,
    y: box!.y + (point.y - origin.y) * scale,
  });
}

async function selectionFrame(page: Page) {
  return page.locator(".overlay-selection-box").first().evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    y: Number.parseFloat((element as HTMLElement).style.top),
    w: Number.parseFloat((element as HTMLElement).style.width),
    h: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

async function storedBox(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => ({
    x: Number.parseFloat((element as HTMLElement).style.left),
    w: Number.parseFloat((element as HTMLElement).style.width),
    h: Number.parseFloat((element as HTMLElement).style.height),
  }));
}

async function dragEastHandle(page: Page, selector: string, dx: number): Promise<void> {
  const handle = page.locator(selector).first();
  await expect(handle).toBeVisible();
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  const x = box!.x + box!.width / 2;
  const y = box!.y + box!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y, { steps: 8 });
  await page.mouse.up();
}

test("an arc's east handle follows the pointer and leaves its west edge alone", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  const toClient = await pageToClient(page, ".overlay-shape-arc", ARC_ORIGIN, ARC_RADIUS * 2);
  // 保存箱の中心には何も描かれていないので、弧の上の点 (45°) を押す。
  await grabShapeFromBody(page, toClient({
    x: ARC_INK.x + ARC_RADIUS * Math.cos(Math.PI / 4),
    y: ARC_INK.y + ARC_RADIUS * Math.sin(Math.PI / 4),
  }));
  await expect(page.locator(".overlay-selection-box")).toHaveCount(1);

  const before = await selectionFrame(page);
  const storedBefore = await storedBox(page, ".overlay-shape-arc");
  // 見えている枠は保存箱の約 1/2 (90° 弧のインクは楕円の四半分)。ここが「70px 引いても
  // 10px しか伸びない」の出どころだった。
  expect(before.w).toBeLessThan(storedBefore.w * 0.6);

  await dragEastHandle(page, ".overlay-resize-handle.hit-only.e", 60);

  await expect.poll(async () => (await selectionFrame(page)).w).toBeGreaterThan(before.w + 40);
  const after = await selectionFrame(page);
  const storedAfter = await storedBox(page, ".overlay-shape-arc");

  // 掴んだ辺はポインタにぴったり追従し、反対側の辺と高さは動かない。許容は 0.5px:
  // ここでのポインタ移動量は client px、幅は紙面 px なので、拡大率が 1 でなければ端数が出る。
  // WI-15 以前はこの弧で +30px しか伸びなかったので、この幅でも十分に区別できる。
  expect(after.w).toBeCloseTo(before.w + 60, 0);
  expect(after.x).toBeCloseTo(before.x, 0);
  expect(after.h).toBeCloseTo(before.h, 0);
  // 保存箱の西辺は動く: 動かないのは見えている枠のほう、という取り替えそのもの。
  expect(Math.abs(storedAfter.x - storedBefore.x)).toBeGreaterThan(20);
});

test("a rectangle resizes from the same box it always did", async ({ page }) => {
  test.setTimeout(60_000);
  await openEditor(page);

  await grabShapeFromBody(page, page.locator(".overlay-shape-geo").first());
  await expect(page.locator(".overlay-selection-box")).toHaveCount(1);

  const before = await selectionFrame(page);
  const storedBefore = await storedBox(page, ".overlay-shape-geo");
  // パディングが 0 の図形では、見えている枠と保存箱は同じもの。
  expect(before.w).toBeCloseTo(storedBefore.w, 3);

  await dragEastHandle(page, ".overlay-resize-handle.e", 60);

  await expect.poll(async () => (await storedBox(page, ".overlay-shape-geo")).w)
    .toBeGreaterThan(storedBefore.w + 40);
  const storedAfter = await storedBox(page, ".overlay-shape-geo");

  expect(storedAfter.w).toBeCloseTo(storedBefore.w + 60, 0);
  expect(storedAfter.x).toBeCloseTo(storedBefore.x, 3);
  expect(storedAfter.h).toBeCloseTo(storedBefore.h, 3);
});
