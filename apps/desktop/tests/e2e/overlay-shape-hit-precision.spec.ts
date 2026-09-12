import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 図形モードの当たり判定は「描かれているところ」だけ。
 *
 * 図形の DIV は `getShapeBounds` の箱 — 変形の基準箱であってインクの範囲ではない。円弧は
 * `x = 中心 - r` で元の円まるごとを箱に持つので、3点指定で描いた浅い弧でも円ひとつ分の DIV が
 * 本文の上に乗る。押下がその DIV に当たっただけで図形を選んでいたため、弧の内側の本文を
 * 押すと本文ではなく円弧が選ばれていた。
 *
 * ここで固定するのは 2 つ:
 *   1. 円弧はインクの上でだけ掴め、内側の空白は空白として扱われる
 *   2. 図形の外側で本文に触れたら (クリックでもドラッグでも) 本文へ抜ける
 */

const TARGET_BLOCK_ID = "p_arc_hit_target";
const ARC_SHAPE_ID = "shape_three_point_arc";
const ARC_RADIUS = 120;

/** 3点指定 (`createArcShapeFromThreePoints`) が作るのと同じ形: 円の一部だけを描く弧。 */
function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_overlay_shape_hit_precision";
  document.metadata = { ...document.metadata, title: "図形の当たり判定 E2E" };
  document.content = [
    {
      type: "paragraph",
      id: TARGET_BLOCK_ID,
      children: [{
        type: "text",
        text: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ",
      }],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_arc_filler_${index}`,
      children: [{ type: "text" as const, text: `円弧の内側に敷く本文 ${index + 1} 行目のテキストです。` }],
    })),
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: ARC_SHAPE_ID,
          type: "arc",
          // 円の左上が基準。DIV は 2r 角の正方形になる。
          x: 80,
          y: 60,
          anchor: { type: "block", blockId: TARGET_BLOCK_ID, dy: -8 },
          rotation: 0,
          props: {
            kind: "arc",
            r: ARC_RADIUS,
            // 上側だけを通る浅い弧 (真上 -π/2 を含み、中心の周りは空白)。
            startAngle: -2.4,
            endAngle: -0.74,
            color: "#111111",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    },
  };
  return document;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(".page-flow .text-flow-editor").first()).toBeVisible();
  await expect(page.locator(`[data-overlay-shape-id="${ARC_SHAPE_ID}"]`).first()).toBeVisible();
}

interface ArcGeometry {
  centerX: number;
  centerY: number;
  radius: number;
  top: number;
}

/** 円弧の DIV は元の円の外接箱そのもの。中心と半径はそこから読める (ズーム込み)。 */
async function arcGeometry(page: Page): Promise<ArcGeometry> {
  return page.locator(`[data-overlay-shape-id="${ARC_SHAPE_ID}"]`).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      radius: rect.width / 2,
      top: rect.top,
    };
  });
}

/** 弧の上の点。`angle` は画面座標系 (y 下向き) のラジアン。 */
function pointOnArc(arc: ArcGeometry, angle: number): { x: number; y: number } {
  return {
    x: arc.centerX + Math.cos(angle) * arc.radius,
    y: arc.centerY + Math.sin(angle) * arc.radius,
  };
}

async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** `page.mouse.click` は modifiers を受け取らないので、修飾キーは自分で押さえる。 */
async function ctrlClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(x, y);
  await page.keyboard.up("ControlOrMeta");
}

/**
 * 本文モードから、弧の線を Ctrl/Cmd クリックして図形モードへ入る。
 * Ctrl/Cmd の押下は「いまは図形を触る」の明示操作なので、当たっていなくても図形モードへ入る
 * (選択はまだ付かない — `body-pointer-routing.ts` の規約)。
 */
async function enterShapeMode(page: Page): Promise<ArcGeometry> {
  const arc = await arcGeometry(page);
  const onInk = pointOnArc(arc, -Math.PI / 2);
  await ctrlClick(page, onInk.x, onInk.y + 2);
  await expect(page.locator(".overlay-canvas-editor")).toHaveCount(1);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");
  // 図形モードへ入るとレイヤが入れ替わるので座標を取り直す。
  return arcGeometry(page);
}

test("3点円弧は描かれている線の上で掴める", async ({ page }) => {
  await openEditor(page);

  const arc = await enterShapeMode(page);

  // 真上 (弧の頂点) と、弧の別の角度。どちらもインクの上。
  const top = pointOnArc(arc, -Math.PI / 2);
  await page.mouse.click(top.x, top.y + 2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);

  const side = pointOnArc(arc, -Math.PI / 3);
  await page.mouse.click(side.x, side.y);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");
});

test("円弧の内側の空白を押しても選択されず、本文にキャレットが立つ", async ({ page }) => {
  await openEditor(page);

  const arc = await enterShapeMode(page);
  const top = pointOnArc(arc, -Math.PI / 2);
  await page.mouse.click(top.x, top.y + 2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);

  // 円の中心 — DIV の真ん中で、インクからは半径ぶん離れている。
  await page.mouse.click(arc.centerX, arc.centerY);

  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await expect.poll(() => page.evaluate(() => (
    window.document.activeElement?.classList.contains("ProseMirror") ?? false
  ))).toBe(true);
});

test("図形を掴まないドラッグは本文の範囲選択になる", async ({ page }) => {
  await openEditor(page);

  const arc = await enterShapeMode(page);
  const line = await page.locator('[data-sigma-doc-id="p_arc_filler_6"]').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
  // 弧の箱から離れた行を選ぶ (マーキーが図形を掴まないことが前提)。
  expect(line.y).toBeGreaterThan(arc.centerY + arc.radius);

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(line.left + 6, line.y);
  await page.mouse.down();
  await page.mouse.move(line.left + 160, line.y, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await expect.poll(() => selectedText(page)).not.toBe("");
});

test("紙の余白での空振りマーキーは図形モードに留まる", async ({ page }) => {
  await openEditor(page);

  await enterShapeMode(page);
  const margin = await page.locator(".page-flow .text-flow-editor").first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left - 24, top: rect.top };
  });

  await page.mouse.move(margin.x, margin.top + 40);
  await page.mouse.down();
  await page.mouse.move(margin.x, margin.top + 160, { steps: 10 });
  await page.mouse.up();

  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");
});
