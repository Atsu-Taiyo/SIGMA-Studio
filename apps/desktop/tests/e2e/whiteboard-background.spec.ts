import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * ホワイトボードの下地（方眼／点／なし）の回帰テスト。
 *
 * 「保存したのに開き直すと消える」は zod の strip・normalize の分岐・用紙設定ダイアログの
 * 再構築の 3 箇所で起きうる。それぞれ単体テストで固定してあるので、ここでは
 * 「実際に選べて、実際に描かれて、実際にファイルへ残る」ところだけを見る。
 */
function whiteboardDocument(background?: "grid" | "dots" | "none"): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_e2e_whiteboard_background",
    metadata: { title: "ホワイトボード背景" },
    content: [],
    pageLayout: {
      preset: "whiteboard",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
      ...(background ? { background } : {}),
      overlay: {
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [{
            id: "background_rect",
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
}

function backgroundImage(page: Page): Promise<string> {
  return page.locator(".whiteboard-background").evaluate((element) => (
    window.getComputedStyle(element).backgroundImage
  ));
}

/**
 * しきい値付近のフェードは、要素の opacity ではなくパターンの色のアルファに載っている。
 * 要素ごと薄めると `.whiteboard-background` が唯一の出典である下地色まで一緒に消えるため。
 */
async function patternAlpha(page: Page): Promise<number> {
  const image = await backgroundImage(page);
  const match = image.match(/rgba\(85, 85, 85, ([0-9.]+)\)/);
  return match ? Number(match[1]) : 0;
}

function groundControl(page: Page) {
  return page.getByRole("radiogroup", { name: "キャンバスの背景" });
}

async function openWhiteboard(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
}

test.describe("ホワイトボードの背景", () => {
  test.beforeEach(async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 900 });
  });

  test("背景タイプを持たない既存の教材は点で開く", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument());
    await openWhiteboard(page);

    expect(await backgroundImage(page)).toContain("radial-gradient");
    await expect(groundControl(page).getByRole("radio", { name: "点" })).toHaveAttribute("aria-checked", "true");
  });

  test("浮遊コントロールから方眼・なしへ即座に切り替わる", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument());
    await openWhiteboard(page);

    await groundControl(page).getByRole("radio", { name: "方眼" }).click();
    await expect.poll(async () => backgroundImage(page)).toContain("linear-gradient");
    await expect(groundControl(page).getByRole("radio", { name: "方眼" })).toHaveAttribute("aria-checked", "true");

    await groundControl(page).getByRole("radio", { name: "背景なし" }).click();
    await expect.poll(async () => backgroundImage(page)).toBe("none");

    // ダイアログは開かない。切り替えのたびにステータス行を書き換えることもしない。
    await expect(page.locator(".page-settings-dialog")).toHaveCount(0);
    await expect(page.getByText("ページ設定を更新しました")).toHaveCount(0);
  });

  test("選んだ背景が教材ファイルへ書き込まれる", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument());
    await openWhiteboard(page);

    await groundControl(page).getByRole("radio", { name: "方眼" }).click();

    await expect.poll(async () => page.evaluate(() => {
      const raw = window.localStorage.getItem("sigma-studio:e2e-document");
      return raw ? (JSON.parse(raw) as SigmaDocument).pageLayout?.background ?? null : null;
    })).toBe("grid");
  });

  test("保存済みの背景で開き直すと方眼のまま表示される", async ({ page }) => {
    // desktop-runtime-mock はロードのたびに初期文書へ戻すので、reload では
    // 「保存 → 再読込」を再現できない。保存された姿を初期文書として与える形で見る
    // (zod が strip しないことは sigma-doc の parse 往復テストが別途固定している)。
    await installDesktopRuntimeMock(page, whiteboardDocument("grid"));
    await openWhiteboard(page);

    expect(await backgroundImage(page)).toContain("linear-gradient");
    await expect(groundControl(page).getByRole("radio", { name: "方眼" })).toHaveAttribute("aria-checked", "true");
  });

  test("縮小すると背景が消え、拡大するとしきい値付近で滑らかに戻る", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("dots"));
    await openWhiteboard(page);
    expect(await patternAlpha(page)).toBe(0.22);

    await page.locator(".editor-menubar").getByLabel("ズーム").selectOption("25");
    await expect.poll(async () => backgroundImage(page)).toBe("none");

    // 実効間隔 24px * 0.5 = 12px はフェード帯 (9〜15px) の中。
    await page.locator(".editor-menubar").getByLabel("ズーム").selectOption("50");
    await expect.poll(async () => backgroundImage(page)).toContain("radial-gradient");
    const faded = await patternAlpha(page);
    expect(faded).toBeGreaterThan(0);
    expect(faded).toBeLessThan(0.22);
    // 下地の色は薄まらない (フェードはインクだけに載る)。
    await expect(page.locator(".whiteboard-background")).toHaveCSS("opacity", "1");

    await page.locator(".editor-menubar").getByLabel("ズーム").selectOption("100");
    await expect.poll(async () => patternAlpha(page)).toBe(0.22);
  });

  test("「なし」は倍率にかかわらず無地のまま", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("none"));
    await openWhiteboard(page);

    expect(await backgroundImage(page)).toBe("none");
    await page.locator(".editor-menubar").getByLabel("ズーム").selectOption("400");
    await expect.poll(async () => backgroundImage(page)).toBe("none");
  });

  test("背景コントロールを押しても図形の選択が外れない", async ({ page }) => {
    await installDesktopRuntimeMock(page, whiteboardDocument("dots"));
    await openWhiteboard(page);

    const shape = page.locator('.overlay-canvas-editor [data-overlay-shape-id="background_rect"]');
    const box = await shape.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width / 2, box!.y + box!.height / 2);
    await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);

    await groundControl(page).getByRole("radio", { name: "方眼" }).click();

    await expect.poll(async () => backgroundImage(page)).toContain("linear-gradient");
    await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  });

  test("紙モードには浮遊コントロールが出ない", async ({ page }) => {
    await installDesktopRuntimeMock(page, sampleDocument);
    await openWhiteboardlessPaper(page);

    await expect(groundControl(page)).toHaveCount(0);
    await expect(page.locator(".whiteboard-canvas-controls")).toHaveCount(0);
  });
});

async function openWhiteboardlessPaper(page: Page): Promise<void> {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-canvas")).toBeVisible();
}
