import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * ホワイトボードの表示領域は「エディタ領域そのもの」であることの回帰テスト。
 *
 * 余白・額縁・縦スクロールバーが出ると無限キャンバスに見えないだけでなく、右下の
 * ズームコントロールが画面外へ沈む。高さの出典は `.workspace` のグリッド行なので、
 * クロームの高さ（Googleドキュメント風 / Word風 / 折りたたみ）が変わっても
 * 表示領域はずれてはならない。
 */
const WHITEBOARD_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_whiteboard_viewport",
  metadata: { title: "ホワイトボード表示領域" },
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
        shapes: [{
          id: "whiteboard_rect",
          type: "geo",
          x: 120,
          y: 120,
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
        assets: {},
      },
    },
  },
  outputProfiles: {
    student: {},
    teacher: {},
    answerBook: {},
  },
};

interface ViewportGeometry {
  canvas: { left: number; right: number; top: number; bottom: number };
  viewport: { left: number; right: number; top: number; bottom: number };
  scrollHeight: number;
  clientHeight: number;
  scrollWidth: number;
  clientWidth: number;
  paddingLeft: string;
  paddingBottom: string;
}

async function measureWhiteboardViewport(page: Page): Promise<ViewportGeometry> {
  return page.evaluate(() => {
    const canvas = window.document.querySelector(".editor-canvas") as HTMLElement;
    const viewport = window.document.querySelector(".whiteboard-page-canvas") as HTMLElement;
    const canvasRect = canvas.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    const canvasStyle = window.getComputedStyle(canvas);
    return {
      canvas: {
        left: canvasRect.left,
        right: canvasRect.right,
        top: canvasRect.top,
        bottom: canvasRect.bottom,
      },
      viewport: {
        left: viewportRect.left,
        right: viewportRect.right,
        top: viewportRect.top,
        bottom: viewportRect.bottom,
      },
      scrollHeight: canvas.scrollHeight,
      clientHeight: canvas.clientHeight,
      scrollWidth: canvas.scrollWidth,
      clientWidth: canvas.clientWidth,
      paddingLeft: canvasStyle.paddingLeft,
      paddingBottom: canvasStyle.paddingBottom,
    };
  });
}

function expectViewportFillsCanvas(geometry: ViewportGeometry): void {
  expect(Math.abs(geometry.viewport.left - geometry.canvas.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.viewport.right - geometry.canvas.right)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.viewport.top - geometry.canvas.top)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.viewport.bottom - geometry.canvas.bottom)).toBeLessThanOrEqual(1);
  expect(geometry.scrollHeight).toBeLessThanOrEqual(geometry.clientHeight);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
}

async function openWhiteboard(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
}

test.describe("Googleドキュメント風クローム", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRuntimeMock(page, WHITEBOARD_DOCUMENT);
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test("キャンバスが表示領域いっぱいに広がり余白もスクロールバーも出ない", async ({ page }) => {
    await openWhiteboard(page);

    const geometry = await measureWhiteboardViewport(page);
    expect(geometry.paddingLeft).toBe("0px");
    expect(geometry.paddingBottom).toBe("0px");
    expectViewportFillsCanvas(geometry);
    await expect(page.locator(".editor-canvas")).toHaveAttribute("data-whiteboard", "true");
  });

  test("右下のズームコントロールがビューポート内に完全に収まる", async ({ page }) => {
    await openWhiteboard(page);

    const geometry = await measureWhiteboardViewport(page);
    const controls = await page.locator(".whiteboard-zoom-controls").boundingBox();
    expect(controls).not.toBeNull();
    expect(controls!.x).toBeGreaterThanOrEqual(geometry.canvas.left);
    expect(controls!.y).toBeGreaterThanOrEqual(geometry.canvas.top);
    expect(controls!.x + controls!.width).toBeLessThanOrEqual(geometry.canvas.right);
    expect(controls!.y + controls!.height).toBeLessThanOrEqual(geometry.canvas.bottom);
  });

  test("余白が消えてもAIタスクDockとコメントDockは端に貼り付かない", async ({ page }) => {
    await openWhiteboard(page);

    const geometry = await measureWhiteboardViewport(page);
    const aiDock = await page.locator(".ai-task-dock-toggle").boundingBox();
    const commentDock = await page.locator(".comment-dock-toggle").boundingBox();
    expect(aiDock).not.toBeNull();
    expect(commentDock).not.toBeNull();
    expect(aiDock!.x - geometry.canvas.left).toBeGreaterThanOrEqual(8);
    expect(geometry.canvas.right - (commentDock!.x + commentDock!.width)).toBeGreaterThanOrEqual(8);
  });

  test("狭い画面でもメディアクエリの12pxパディングに負けない", async ({ page }) => {
    await page.setViewportSize({ width: 800, height: 700 });
    await openWhiteboard(page);

    await expect(page.locator(".editor-canvas")).toHaveCSS("padding-left", "0px");
    await expect(page.locator(".editor-canvas")).toHaveCSS("padding-bottom", "0px");
  });
});

test.describe("クローム高さが変わっても追従する", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRuntimeMock(page, WHITEBOARD_DOCUMENT);
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  /**
   * Word風リボンは現在アプリ側で docs に倒されていて e2e から出せない（EditorShell の
   * uiLayoutPreference が mode を固定している）。そこで「リボンの段数・折りたたみ・
   * ステータスバーの有無」を、それらが実際に動かすトークンを直接動かして代弁させる。
   * 高さの出典が `.workspace` のグリッド行なら追従し、100vh からの引き算なら破綻する。
   */
  test("クローム高とステータスバーを変えても表示領域がずれない", async ({ page }) => {
    await openWhiteboard(page);
    expectViewportFillsCanvas(await measureWhiteboardViewport(page));

    await page.evaluate(() => {
      const shell = window.document.querySelector(".app-shell") as HTMLElement;
      // Word風リボン展開時 (74+32+98) + ステータスバー 28px 相当。
      shell.style.setProperty("--editor-chrome-height", "204px");
      shell.style.setProperty("--editor-statusbar-height", "28px");
    });
    await expect.poll(async () => (await measureWhiteboardViewport(page)).clientHeight)
      .toBeLessThan(900 - 204);

    const expanded = await measureWhiteboardViewport(page);
    expectViewportFillsCanvas(expanded);
    const expandedControls = await page.locator(".whiteboard-zoom-controls").boundingBox();
    expect(expandedControls).not.toBeNull();
    expect(expandedControls!.y + expandedControls!.height).toBeLessThanOrEqual(expanded.canvas.bottom);

    await page.evaluate(() => {
      const shell = window.document.querySelector(".app-shell") as HTMLElement;
      // 折りたたみ時 (74+32)。
      shell.style.setProperty("--editor-chrome-height", "106px");
    });
    await expect.poll(async () => (await measureWhiteboardViewport(page)).clientHeight)
      .toBeGreaterThan(900 - 204);
    expectViewportFillsCanvas(await measureWhiteboardViewport(page));
  });
});

test.describe("紙モードの退行防止", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRuntimeMock(page, sampleDocument);
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test("A4文書の表示領域は今までどおり額縁を保つ", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".page-canvas")).toBeVisible();

    const canvas = page.locator(".editor-canvas");
    await expect(canvas).toHaveCSS("padding-left", "38px");
    await expect(canvas).toHaveCSS("padding-right", "38px");
    await expect(canvas).toHaveCSS("padding-bottom", "36px");
    await expect(canvas).toHaveCSS("overflow-y", "auto");
    await expect(canvas).not.toHaveAttribute("data-whiteboard", "true");
  });
});
