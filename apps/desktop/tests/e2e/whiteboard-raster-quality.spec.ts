import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 高倍率でホワイトボードの中身が「ぼやけない」ことの回帰テスト。
 *
 * ホワイトボードは 20000×20000 の 1 枚レイヤを transform で拡大する。Chromium が
 * そのレイヤを 100% 時のラスタのまま引き伸ばすと、数式も図形も等倍で拡大した
 * 「にじんだ絵」になる。目視やスクリーンショット比較はフォントのラスタライズ差で
 * フレーキーなので、**エッジの立ち上がりの鋭さ**という尺度で判定する:
 *
 * - ベクタのまま再ラスタされていれば、黒→白の段差は倍率によらず 1〜2px で起きる
 *   ので、隣接ピクセルの最大輝度差 (maxGradient) は 100% でも 400% でもほぼ同じ。
 * - 100% のラスタを 4 倍に引き伸ばしていれば、同じ段差が 4px に広がるので
 *   maxGradient はおよそ 1/4 に落ちる。
 *
 * この尺度で `will-change: transform` の有無を A/B したところ有意差が無かった
 * (比 0.996 / maxGradient は両方 233) ため、`.whiteboard-canvas` の
 * `will-change` は「にじみの原因」ではないと判断して残している。原因を特定
 * しないまま外して直ったことにしない。
 */

const DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_whiteboard_raster",
  metadata: { title: "ホワイトボード描画品質" },
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
        assets: {},
        shapes: [
          {
            id: "raster_math",
            type: "text",
            x: 600,
            y: 330,
            rotation: 0,
            props: {
              w: 200,
              h: 40,
              color: "#111111",
              size: "m",
              blocks: [{
                  type: "paragraph", id: "whiteboard_raster_quality_spec_44",
                  children: [
                    { type: "mathInline", id: "raster_m1", tex: "\\frac{x^2+1}{\\sqrt{y}}", display: "inline" },
                    { type: "text", text: " 微分積分学 abcdefg" },
                  ],
                }],
            },
          },
          {
            id: "raster_geo",
            type: "geo",
            x: 600,
            y: 420,
            rotation: 0,
            props: {
              w: 160,
              h: 90,
              geo: "ellipse",
              fill: "none",
              color: "#111111",
              fillColor: "#ffffff",
              labelColor: "#111111",
              dash: "solid",
              size: "s",
            },
          },
        ],
      },
    },
  },
  outputProfiles: { student: {}, teacher: {}, answerBook: {} },
} as SigmaDocument;

const VIEWPORT = { width: 1400, height: 900 };

/**
 * 領域を撮って「隣接ピクセルの最大輝度差」を返す。
 * PNG のデコードは別タブの canvas でやるので Node 側に画像ライブラリを足さずに済む。
 */
async function maxEdgeGradient(
  page: Page,
  box: { x: number; y: number; width: number; height: number },
): Promise<number> {
  const clip = {
    x: Math.max(0, box.x),
    y: Math.max(0, box.y),
    width: Math.max(1, Math.min(box.width, VIEWPORT.width - Math.max(0, box.x))),
    height: Math.max(1, Math.min(box.height, VIEWPORT.height - Math.max(0, box.y))),
  };
  const base64 = (await page.screenshot({ clip })).toString("base64");
  const probe = await page.context().newPage();
  try {
    await probe.goto("about:blank");
    return await probe.evaluate(async (data) => {
      const image = new Image();
      await new Promise((resolve, reject) => {
        image.onload = resolve;
        image.onerror = reject;
        image.src = `data:image/png;base64,${data}`;
      });
      const canvas = window.document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("2d context unavailable");
      context.drawImage(image, 0, 0);
      const { data: pixels, width, height } = context.getImageData(0, 0, image.width, image.height);
      let maxGradient = 0;
      for (let y = 0; y < height; y += 1) {
        for (let x = 1; x < width; x += 1) {
          const left = (y * width + x - 1) * 4;
          const here = (y * width + x) * 4;
          const grayLeft = 0.299 * pixels[left] + 0.587 * pixels[left + 1] + 0.114 * pixels[left + 2];
          const grayHere = 0.299 * pixels[here] + 0.587 * pixels[here + 1] + 0.114 * pixels[here + 2];
          const gradient = Math.abs(grayHere - grayLeft);
          if (gradient > maxGradient) maxGradient = gradient;
        }
      }
      return maxGradient;
    }, base64);
  } finally {
    await probe.close();
  }
}

async function shapeBox(page: Page, id: string) {
  const box = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${id}"]`).boundingBox();
  expect(box, `図形 ${id} が見つからない`).not.toBeNull();
  return box!;
}

test("400% でも数式と図形のエッジが 100% と同じ鋭さで描かれる", async ({ page }) => {
  await installDesktopRuntimeMock(page, DOCUMENT);
  await page.setViewportSize(VIEWPORT);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();

  const mathAt100 = await maxEdgeGradient(page, await shapeBox(page, "raster_math"));
  const geoAt100 = await maxEdgeGradient(page, await shapeBox(page, "raster_geo"));

  await page.locator(".editor-menubar").getByLabel("ズーム").selectOption("400");
  await expect.poll(async () => page.locator(".whiteboard-page-canvas").evaluate((element) => (
    Number.parseFloat(window.getComputedStyle(element).getPropertyValue("--whiteboard-zoom"))
  ))).toBe(4);
  // 合成レイヤの再ラスタは非同期なので、落ち着いてから撮る。
  await page.waitForTimeout(800);

  const mathAt400 = await maxEdgeGradient(page, await shapeBox(page, "raster_math"));
  const geoAt400 = await maxEdgeGradient(page, await shapeBox(page, "raster_geo"));

  // 4 倍に引き伸ばされていれば 1/4 (≒58) まで落ちる。0.85 倍を下限にして拡大縮小の
  // アンチエイリアス差ぶんだけ許容する。
  expect(mathAt400).toBeGreaterThanOrEqual(mathAt100 * 0.85);
  expect(mathAt400).toBeGreaterThanOrEqual(180);
  expect(geoAt400).toBeGreaterThanOrEqual(geoAt100 * 0.85);
  expect(geoAt400).toBeGreaterThanOrEqual(180);
});
