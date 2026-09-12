import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

/**
 * 画面で選んだ下地が印刷 / PDF にも出ることの回帰テスト。
 *
 * PDF はエディタ DOM のページ窓切り出しなので、紙面 (`.a4-page-sheet`) に載せれば
 * 画面プレビューと PDF の両方に同時に効く。印刷専用のレンダラは作らない。
 * 位相合わせ（図形とマス目の相対位置が画面と紙面で一致すること）は、切り出し原点を
 * セル境界へ寄せることで成立している — ここではその結果だけを実測で見る。
 */
const CELL_PX = 24;
/** セル境界からずれた位置。原点をそのまま使うと紙面でこのズレが消えてしまう。 */
const SHAPE_X = 137;
const SHAPE_Y = 262;

function whiteboardDocument(background: "grid" | "dots" | "none"): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_e2e_print_background",
    metadata: { title: "ホワイトボード印刷背景" },
    content: [],
    pageLayout: {
      preset: "whiteboard",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      background,
      overlay: {
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [{
            id: "print_rect",
            type: "geo",
            x: SHAPE_X,
            y: SHAPE_Y,
            rotation: 0,
            props: {
              w: 160,
              h: 100,
              geo: "rectangle",
              fill: "solid",
              color: "#111111",
              fillColor: "#ffffff",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          }],
        },
      },
    },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  } as SigmaDocument;
}

async function openPrintPreview(page: Page): Promise<void> {
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await waitForPagedSurfaceSettled(page);
  await expect(page.locator(".paged-surface-page-slot .a4-page-sheet").first()).toBeVisible();
}

function printedSheet(page: Page) {
  return page.locator(".paged-surface-page-slot .a4-page-sheet").first();
}

/** セル境界からの位相。原点 (パターンの開始点) からの距離を 1 セットで割った余り。 */
function phase(value: number): number {
  return ((value % CELL_PX) + CELL_PX) % CELL_PX;
}

/**
 * 位相どうしの距離。**剰余の折り返しを跨いで測る** — 23.5 と 0.5 の実差は 1px であって
 * 23px ではない。単純な差で見ると、位相が 0 付近になる座標に変えた瞬間に嘘の赤が出る。
 */
function phaseDistance(a: number, b: number): number {
  const raw = Math.abs(phase(a) - phase(b));
  return Math.min(raw, CELL_PX - raw);
}

test.describe("ホワイトボードの背景を印刷に反映する", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test("方眼のホワイトボードは用紙にも方眼が出る", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("grid"));
    await openPrintPreview(page);

    const sheet = printedSheet(page);
    await expect(sheet).toHaveCSS("background-image", /linear-gradient/);
    // 個別プロパティで渡しているので、用紙の白は消えない。
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
    // 方眼は縦横 2 枚の gradient なので、background-size もレイヤごとに並ぶ。
    await expect(sheet).toHaveCSS("background-size", /^24px 24px(, 24px 24px)?$/);
    // 既定の padding-box だと用紙の 1px ボーダーぶんパターンだけ内側へずれる。
    await expect(sheet).toHaveCSS("background-origin", /^border-box(, border-box)?$/);
    // これが `economy` のままだと、ブラウザ印刷で下地だけ落ちた紙になる。
    await expect(sheet).toHaveCSS("print-color-adjust", "exact");
  });

  test("点のホワイトボードは用紙にも点が出る", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("dots"));
    await openPrintPreview(page);

    await expect(printedSheet(page)).toHaveCSS("background-image", /radial-gradient/);
  });

  test("「なし」では用紙に何も描かれない", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("none"));
    await openPrintPreview(page);

    const sheet = printedSheet(page);
    await expect(sheet).toHaveCSS("background-image", "none");
    await expect(sheet).toHaveCSS("background-color", "rgb(255, 255, 255)");
  });

  test("図形とマス目の相対位置が画面と紙面で一致する", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("grid"));

    // 画面: 倍率 100% / パン 0 なので、パターンの原点はビューポートの左上。
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();

    const screen = await page.evaluate(() => {
      const viewport = window.document.querySelector(".whiteboard-page-canvas")!.getBoundingClientRect();
      const shape = window.document
        .querySelector('.overlay-canvas-editor [data-overlay-shape-id="print_rect"]')!
        .getBoundingClientRect();
      return { dx: shape.left - viewport.left, dy: shape.top - viewport.top };
    });

    // 紙面: パターンの原点は `background-origin` が決める。ボーダーボックスの左上から
    // 測るだけだと、`padding-box` のままボーダー 1px ぶんずれていても気づけない。
    await openPrintPreview(page);
    const paper = await page.evaluate(() => {
      const sheetElement = window.document
        .querySelector(".paged-surface-page-slot .a4-page-sheet") as HTMLElement;
      const style = window.getComputedStyle(sheetElement);
      const sheet = sheetElement.getBoundingClientRect();
      const usesBorderBox = style.backgroundOrigin.split(",")[0].trim() === "border-box";
      const originX = sheet.left + (usesBorderBox ? 0 : Number.parseFloat(style.borderLeftWidth));
      const originY = sheet.top + (usesBorderBox ? 0 : Number.parseFloat(style.borderTopWidth));
      const shape = window.document
        .querySelector('.paged-surface-page-slot [data-overlay-shape-id="print_rect"]')!
        .getBoundingClientRect();
      return { dx: shape.left - originX, dy: shape.top - originY };
    });

    // 位相がそのまま残っていること (= 紙面のマス目が画面のワールドグリッドと揃っている)。
    // 許容を 1px にすると、用紙のボーダー 1px ぶんの系統的なズレをちょうど見逃す。
    expect(phaseDistance(paper.dx, screen.dx)).toBeLessThanOrEqual(0.5);
    expect(phaseDistance(paper.dy, screen.dy)).toBeLessThanOrEqual(0.5);
    // 「たまたま両方 0」ではないことの裏取り: 図形はセル境界に乗っていない。
    expect(phase(screen.dx)).toBeGreaterThan(1);
    expect(phase(screen.dy)).toBeGreaterThan(1);
  });
});
