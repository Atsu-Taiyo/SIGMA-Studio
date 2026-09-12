import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * ホワイトボードのカメラ（ズーム/パン）と、紙モードのズーム錨の回帰テスト。
 *
 * ズームの入口は `EditorShell.applyZoom` の 1 箇所だけで、ホワイトボードなら
 * カメラ（zoom + pan を同一 tick で更新）、紙モードならスクロール錨に分岐する。
 * 「入口ごとに違う実装」へ戻る退行を、入口別に 1 本ずつ張って防ぐ。
 */

/** ctrl+ホイールを 1 回送る。Playwright は keyboard の修飾状態を wheel にも載せる。 */
async function ctrlWheel(page: Page, x: number, y: number, deltaY: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  await page.mouse.wheel(0, deltaY);
  await page.keyboard.up("Control");
}

test.describe("紙モードの退行防止", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRuntimeMock(page, sampleDocument);
    await page.setViewportSize({ width: 1400, height: 900 });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(page.locator(".page-canvas")).toBeVisible();
  });

  test("途中までスクロールした本文の上で ctrl+ホイールすると、その段落が動かない", async ({ page }) => {
    await page.locator(".editor-canvas").evaluate((element) => {
      element.scrollTop = 400;
    });
    await expect.poll(async () => page.locator(".editor-canvas").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);

    // ビューポート中央に最も近い本文ブロックを錨にする（スクロール位置に依存しない選び方）。
    const anchorId = await page.evaluate(() => {
      const canvas = window.document.querySelector(".editor-canvas") as HTMLElement;
      const canvasRect = canvas.getBoundingClientRect();
      const canvasCenter = canvasRect.top + canvasRect.height / 2;
      let best: { id: string; distance: number } | null = null;
      for (const element of window.document.querySelectorAll("[data-sigma-doc-id]")) {
        const rect = element.getBoundingClientRect();
        if (rect.height <= 0) continue;
        const distance = Math.abs(rect.top + rect.height / 2 - canvasCenter);
        const id = element.getAttribute("data-sigma-doc-id");
        if (!id) continue;
        if (!best || distance < best.distance) {
          best = { id, distance };
        }
      }
      return best?.id ?? null;
    });
    expect(anchorId).not.toBeNull();

    const anchor = page.locator(`[data-sigma-doc-id="${anchorId}"]`).first();
    const before = await anchor.boundingBox();
    expect(before).not.toBeNull();

    const zoomBefore = await page.locator(".page-mode").evaluate((element) => (
      Number.parseFloat(window.getComputedStyle(element).getPropertyValue("--editor-zoom"))
    ));

    await ctrlWheel(page, before!.x + before!.width / 2, before!.y + before!.height / 2, -300);

    await expect.poll(async () => page.locator(".page-mode").evaluate((element) => (
      Number.parseFloat(window.getComputedStyle(element).getPropertyValue("--editor-zoom"))
    ))).toBeGreaterThan(zoomBefore);

    // スクロール補正は requestAnimationFrame 越しなので、落ち着くまで待ってから測る。
    await expect.poll(async () => {
      const after = await anchor.boundingBox();
      if (!after) return Number.POSITIVE_INFINITY;
      return Math.abs(after.y + after.height / 2 - (before!.y + before!.height / 2));
    }, { timeout: 5_000 }).toBeLessThanOrEqual(2);

    // 錨が効いたのは「たまたま何も動かなかった」からではない、の裏取り。
    await expect.poll(async () => page.locator(".editor-canvas").evaluate((el) => el.scrollTop))
      .toBeGreaterThan(400);

    // 水平は用紙が中央寄せで scrollLeft が 0 に張り付くため、そもそも錨が効かない
    // （紙面が広がった分だけ中央寄せがずれる）。現行の実測は 3.2px 程度なので、
    // 「今より悪化しない」ことだけを 4px で固定する。
    const after = await anchor.boundingBox();
    expect(Math.abs(after!.x + after!.width / 2 - (before!.x + before!.width / 2))).toBeLessThanOrEqual(4);
  });
});

const WHITEBOARD_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_whiteboard_camera",
  metadata: { title: "ホワイトボードカメラ" },
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
        shapes: [{
          id: "camera_rect",
          type: "geo",
          x: 420,
          y: 260,
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

interface CameraState {
  zoom: number;
  panX: number;
  panY: number;
  editorZoom: number;
  viewportWidth: number;
  viewportHeight: number;
}

async function readCamera(page: Page): Promise<CameraState> {
  return page.locator(".whiteboard-page-canvas").evaluate((element) => {
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return {
      zoom: Number.parseFloat(style.getPropertyValue("--whiteboard-zoom")) || 0,
      panX: Number.parseFloat(style.getPropertyValue("--whiteboard-pan-x")) || 0,
      panY: Number.parseFloat(style.getPropertyValue("--whiteboard-pan-y")) || 0,
      editorZoom: Number.parseFloat(style.getPropertyValue("--editor-zoom")) || 0,
      viewportWidth: rect.width,
      viewportHeight: rect.height,
    };
  });
}

/** ビューポート中央の下にあるワールド座標。中心錨のズームではこれが不動になる。 */
function worldPointUnderViewportCentre(camera: CameraState): { x: number; y: number } {
  return {
    x: (camera.viewportWidth / 2 - camera.panX) / camera.zoom,
    y: (camera.viewportHeight / 2 - camera.panY) / camera.zoom,
  };
}

async function openWhiteboard(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
}

test.describe("ホワイトボードのカメラ", () => {
  test.beforeEach(async ({ page }) => {
    await installDesktopRuntimeMock(page, WHITEBOARD_DOCUMENT);
    await page.setViewportSize({ width: 1400, height: 900 });
    await openWhiteboard(page);
  });

  test("図形の上で ctrl+ホイールすると、その図形が画面上で動かない", async ({ page }) => {
    const shape = page.locator('.overlay-canvas-editor [data-overlay-shape-id="camera_rect"]');
    const before = await shape.boundingBox();
    expect(before).not.toBeNull();
    const zoomBefore = (await readCamera(page)).zoom;

    await ctrlWheel(page, before!.x + before!.width / 2, before!.y + before!.height / 2, -300);

    // CSS 変数ではなく図形の実寸が育つまで待つ。変数は 1 フレーム先に動きうるので、
    // そこで座標を読むと「まだ拡大が乗っていない瞬間」を掴んでフレーキーになる。
    // 図形が大きくなった = 本当にズームした (パンだけで見かけ上動かなかったのではない)。
    await expect.poll(async () => (await shape.boundingBox())?.width ?? 0)
      .toBeGreaterThan(before!.width + 4);
    expect((await readCamera(page)).zoom).toBeGreaterThan(zoomBefore);

    const after = await shape.boundingBox();
    expect(after).not.toBeNull();
    expect(Math.abs(after!.x + after!.width / 2 - (before!.x + before!.width / 2))).toBeLessThanOrEqual(2);
    expect(Math.abs(after!.y + after!.height / 2 - (before!.y + before!.height / 2))).toBeLessThanOrEqual(2);
  });

  test("リボンの拡大ボタンではビューポート中心が不動点になる", async ({ page }) => {
    // 中心錨を意味のあるものにするため、先にパンして原点をずらしておく。
    await page.mouse.move(700, 450);
    await page.mouse.wheel(-140, -90);
    await expect.poll(async () => Math.abs((await readCamera(page)).panX)).toBeGreaterThan(0);

    const before = await readCamera(page);
    const centreBefore = worldPointUnderViewportCentre(before);

    await page.locator(".editor-menubar").getByRole("button", { name: "拡大", exact: true }).click();

    await expect.poll(async () => (await readCamera(page)).zoom).toBeGreaterThan(before.zoom);

    const centreAfter = worldPointUnderViewportCentre(await readCamera(page));
    expect(Math.abs(centreAfter.x - centreBefore.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(centreAfter.y - centreBefore.y)).toBeLessThanOrEqual(1);
  });

  test("右下のコントロールでもビューポート中心が不動点になる", async ({ page }) => {
    await page.mouse.move(700, 450);
    await page.mouse.wheel(120, 70);
    await expect.poll(async () => Math.abs((await readCamera(page)).panY)).toBeGreaterThan(0);

    const before = await readCamera(page);
    const centreBefore = worldPointUnderViewportCentre(before);

    await page.locator(".whiteboard-zoom-controls").getByRole("button", { name: "縮小" }).click();

    await expect.poll(async () => (await readCamera(page)).zoom).toBeLessThan(before.zoom);

    const centreAfter = worldPointUnderViewportCentre(await readCamera(page));
    expect(Math.abs(centreAfter.x - centreBefore.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(centreAfter.y - centreBefore.y)).toBeLessThanOrEqual(1);
  });

  test("ズーム倍率は 25/400 ではなく共有の 10〜800% まで届く", async ({ page }) => {
    const zoomIn = page.locator(".whiteboard-zoom-controls").getByRole("button", { name: "拡大" });
    for (let index = 0; index < 32; index += 1) {
      await zoomIn.click();
    }

    await expect.poll(async () => (await readCamera(page)).zoom).toBeGreaterThan(4);
  });

  test("⌘0 で倍率もパンも原点に戻る", async ({ page }) => {
    await page.mouse.move(700, 450);
    await page.mouse.wheel(-200, -150);
    await ctrlWheel(page, 700, 450, -300);
    await expect.poll(async () => (await readCamera(page)).zoom).toBeGreaterThan(1);

    await page.keyboard.press(process.platform === "darwin" ? "Meta+0" : "Control+0");

    await expect.poll(async () => readCamera(page)).toMatchObject({ zoom: 1, panX: 0, panY: 0 });
  });

  test("無修飾ホイールでパンし、本文用の --editor-zoom は 1 のまま", async ({ page }) => {
    const before = await readCamera(page);
    expect(before.editorZoom).toBe(1);

    await page.mouse.move(700, 450);
    await page.mouse.wheel(-120, -80);

    await expect.poll(async () => (await readCamera(page)).panX).toBe(120);
    const after = await readCamera(page);
    expect(after.panY).toBe(80);
    expect(after.zoom).toBe(before.zoom);

    await ctrlWheel(page, 700, 450, -300);
    await expect.poll(async () => (await readCamera(page)).zoom).toBeGreaterThan(1);
    expect((await readCamera(page)).editorZoom).toBe(1);
  });

  test("行単位デルタ (Windows のホイール) でも 1 行ぶんパンする", async ({ page }) => {
    // Playwright の mouse.wheel は必ず deltaMode: 0 なので、行単位は合成イベントで送る。
    await page.locator(".whiteboard-page-canvas").evaluate((element) => {
      element.dispatchEvent(new WheelEvent("wheel", {
        deltaX: 0,
        deltaY: 3,
        deltaMode: 1,
        bubbles: true,
        cancelable: true,
      }));
    });

    // 生の deltaY=3 をそのまま使う実装では 3px しか動かない。行高さ 16px ぶん動くこと。
    await expect.poll(async () => (await readCamera(page)).panY).toBe(-48);
  });

  test("中ボタンドラッグはドラッグ量ぶんきっちりパンする", async ({ page }) => {
    await page.mouse.move(700, 450);
    await page.mouse.down({ button: "middle" });
    await page.mouse.move(820, 530, { steps: 6 });
    await page.mouse.up({ button: "middle" });

    // 差分で積む実装なら、途中経過が何回描かれても合計はドラッグ量ちょうどになる。
    // 絶対値で渡していた頃は、再レンダー前の連続 move が同じ古い値へ足し込んで届かなかった。
    await expect.poll(async () => (await readCamera(page)).panX).toBe(120);
    expect((await readCamera(page)).panY).toBe(80);
  });

  test("盤面の中のスクロールできる要素はホイールを取り上げられない", async ({ page }) => {
    // 数式の TeX 入力欄のように `overflow: auto` な中身を盤面へ置いたときの代弁。
    // capture リスナが問答無用で preventDefault すると、これが二度とスクロールできない。
    await page.locator(".whiteboard-canvas").evaluate((canvas) => {
      const scroller = window.document.createElement("div");
      scroller.id = "e2e-inner-scroller";
      scroller.style.cssText = "position:absolute;left:40px;top:40px;width:200px;height:60px;overflow:auto;background:#fff;z-index:99";
      const tall = window.document.createElement("div");
      tall.style.cssText = "height:600px";
      scroller.append(tall);
      canvas.append(scroller);
    });

    const scroller = page.locator("#e2e-inner-scroller");
    const box = await scroller.boundingBox();
    expect(box).not.toBeNull();
    const panBefore = await readCamera(page);

    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.mouse.wheel(0, 120);

    await expect.poll(async () => scroller.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    const panAfter = await readCamera(page);
    expect(panAfter.panY).toBe(panBefore.panY);
    expect(panAfter.panX).toBe(panBefore.panX);
  });

  test("shift+ホイールは横だけスクロールできる要素にも届く", async ({ page }) => {
    await page.locator(".whiteboard-canvas").evaluate((canvas) => {
      const scroller = window.document.createElement("div");
      scroller.id = "e2e-inner-scroller";
      scroller.style.cssText = "position:absolute;left:40px;top:40px;width:200px;height:60px;overflow-x:auto;overflow-y:hidden;background:#fff;z-index:99";
      const wide = window.document.createElement("div");
      wide.style.cssText = "width:900px;height:20px";
      scroller.append(wide);
      canvas.append(scroller);
    });

    const box = await page.locator("#e2e-inner-scroller").boundingBox();
    expect(box).not.toBeNull();
    const panBefore = await readCamera(page);

    // shift 単独のホイールは縦 delta が横パンへ振り替わる。素通し判定を生の delta で
    // やっていると横方向を一切見ないので、この要素には永久に届かず盤面が横に流れる。
    // ブラウザが実際に横スクロールさせるかは環境依存なので、こちらが判定できる
    // 「盤面を動かさずに譲ったか」で固定する (バグ側なら panX が -120 になる)。
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await page.keyboard.down("Shift");
    await page.mouse.wheel(0, 120);
    await page.keyboard.up("Shift");

    await page.waitForTimeout(300);
    const panAfter = await readCamera(page);
    expect(panAfter.panX).toBe(panBefore.panX);
    expect(panAfter.panY).toBe(panBefore.panY);
  });

  test("スクロールしきった要素の上ではホイールが盤面へ戻る", async ({ page }) => {
    await page.locator(".whiteboard-canvas").evaluate((canvas) => {
      const scroller = window.document.createElement("div");
      scroller.id = "e2e-inner-scroller";
      scroller.style.cssText = "position:absolute;left:40px;top:40px;width:200px;height:60px;overflow:auto;background:#fff;z-index:99";
      const tall = window.document.createElement("div");
      tall.style.cssText = "height:600px";
      scroller.append(tall);
      canvas.append(scroller);
    });

    const scroller = page.locator("#e2e-inner-scroller");
    const box = await scroller.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
    // 上端に居るので「上へ」はもう余地がない。盤面がパンすること。
    await page.mouse.wheel(0, -100);

    await expect.poll(async () => (await readCamera(page)).panY).toBe(100);
  });
});
