import { expect, test, type Page } from "@playwright/test";

import { createTableShapeProps } from "@/components/editor/overlay-canvas/shapes/table";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDocumentTabMock } from "./document-tab-mock";

/**
 * 教材タブ間の図形コピー&ペースト。
 *
 * タブは同一レンダラの React state なので、クリップボードのペイロードは元からタブをまたいで
 * 届いていた。届いた先に受け手が居なかった — `OverlayCanvasEditor` はオーバーレイ編集中しか
 * マウントされず、タブ切替直後は本文にキャレットがあるため、図形のペイロードが本文へ
 * プレーンテキスト (「図形 N個」) として落ちるか、単に無視されていた。
 *
 * ここでは「タブ A でコピー → タブ B で貼り付け」が種類ごとに成立すること、id が再採番されること、
 * コピー元タブを閉じても貼り付けられること、同一タブ内のコピペが退行しないことを見る。
 *
 * グラフだけフィクスチャに入っていない: `createGraphShapeProps` は MathLive を引き込み、
 * Playwright の Node 側プロセスでは読み込めない。グラフの複製 (curve / point / annotation の
 * id 振り直し) は `src/lib/editor-clipboard.test.ts` が固定している。
 */

const ASSET_ID = "asset_cross_tab";
const IMAGE_PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function asset(): OverlayAsset {
  return {
    id: ASSET_ID,
    type: "image",
    props: {
      w: 40,
      h: 40,
      name: "figure.png",
      isAnimated: false,
      mimeType: "image/png",
      src: IMAGE_PNG,
      fileSize: 68,
    },
  };
}

function shapes(): OverlayShape[] {
  return [
    {
      id: "cross_tab_rect",
      type: "geo",
      x: 60,
      y: 90,
      rotation: Math.PI / 12,
      props: {
        w: 120,
        h: 70,
        geo: "rectangle",
        fill: "solid",
        color: "#1133cc",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
    {
      id: "cross_tab_text",
      type: "text",
      x: 60,
      y: 200,
      props: {
        w: 180,
        h: 16,
        blocks: [{ type: "paragraph", id: "cross_tab_shape_paste_spec_51", children: [{ type: "text", text: "コピーされる文字" }] }],
        color: "#111111",
        size: "m",
      },
    },
    {
      id: "cross_tab_image",
      type: "image",
      x: 60,
      y: 280,
      props: { w: 80, h: 80, assetId: ASSET_ID },
    },
    {
      id: "cross_tab_table",
      type: "tableShape",
      x: 260,
      y: 90,
      props: createTableShapeProps("plain"),
    },
    { id: "cross_tab_group", type: "group", x: 0, y: 0, props: { w: 200, h: 120 } },
    {
      id: "cross_tab_group_child_a",
      type: "geo",
      x: 60,
      y: 420,
      parentId: "cross_tab_group",
      props: {
        w: 60,
        h: 40,
        geo: "ellipse",
        fill: "none",
        color: "#111111",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
    {
      id: "cross_tab_group_child_b",
      type: "geo",
      x: 140,
      y: 420,
      parentId: "cross_tab_group",
      props: {
        w: 60,
        h: 40,
        geo: "diamond",
        fill: "none",
        color: "#111111",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
  ];
}

function sourceDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_cross_tab_source",
    metadata: { title: "教材A" },
    content: [{ type: "paragraph", id: "cross_tab_body", children: [{ type: "text", text: "本文" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot: { version: 1, shapes: shapes(), assets: { [ASSET_ID]: asset() } } },
    },
  };
}

/**「新規教材」で開く 2 枚目のタブ。図形が 0 個から始まるので、貼り付いた分だけを数えられる。 */
function blankDocument(): SigmaDocument {
  return {
    ...sourceDocument(),
    docId: "doc_cross_tab_blank",
    metadata: { title: "教材B" },
    pageLayout: {
      ...sourceDocument().pageLayout!,
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  };
}

async function openSourceTab(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDocumentTabMock(page, sourceDocument(), blankDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** ids of every shape currently drawn, deduplicated across the editing and preview layers. */
async function shapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(
    Array.from(window.document.querySelectorAll<HTMLElement>("[data-overlay-shape-id]"))
      .map((element) => element.dataset.overlayShapeId ?? "")
      .filter(Boolean),
  )]);
}

async function selectAllShapes(page: Page): Promise<void> {
  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="cross_tab_rect"]').first());
  await page.keyboard.press("ControlOrMeta+KeyA");
  await expect(page.locator(".overlay-shape.selected").first()).toBeVisible();
}

/**
 * 2 枚目の教材タブを開く。
 *
 * 既に開いているタブを押して切り替える経路は統合ブランチ時点で壊れており
 * (`document-tabs.spec.ts` が同じ理由で赤)、本 WI の対象でもないので、「新規教材」で開く。
 * クリップボードから見れば「別文書が同じレンダラに載っている」状態は同じ。
 */
/**
 * 本文モードへ戻す。オーバーレイ編集中のままタブを増やすと、切り替えが間に合わないことがある。
 * 図形から離れた本文の一点を押すと選択が落ちて本文モードへ戻る (Escape では抜けない)。
 * locator の click はオーバーレイ編集中の図形に遮られるので座標で押す。
 */
async function exitOverlayEditing(page: Page): Promise<void> {
  const body = await page.locator('[data-sigma-doc-id="cross_tab_body"]').first().boundingBox();
  expect(body).not.toBeNull();
  await page.mouse.click(body!.x + body!.width - 8, body!.y + body!.height / 2);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
}

async function openSecondTab(page: Page): Promise<void> {
  await exitOverlayEditing(page);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect.poll(() => shapeIds(page)).toEqual([]);
}

test("pastes a single shape copied in another material tab", async ({ page }) => {
  await openSourceTab(page);

  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="cross_tab_rect"]').first());
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="cross_tab_rect"]')).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+KeyC");

  await openSecondTab(page);
  await page.keyboard.press("ControlOrMeta+KeyV");

  await expect.poll(() => shapeIds(page)).toHaveLength(1);
  const [pastedId] = await shapeIds(page);
  // 貼り付け先の既存図形と衝突しないよう、id は必ず振り直される。
  expect(pastedId).not.toBe("cross_tab_rect");
  await expect(page.locator(`[data-overlay-shape-id="${pastedId}"]`).first()).toBeVisible();
});

test("pastes a multi-shape selection with its group structure intact", async ({ page }) => {
  await openSourceTab(page);

  await selectAllShapes(page);
  await page.keyboard.press("ControlOrMeta+KeyC");

  await openSecondTab(page);
  await page.keyboard.press("ControlOrMeta+KeyV");

  // グループ自体は DOM 要素を持たないので、描画されるのは子を含む 6 個。
  // グループ構造そのもの (parentId の張り替えと、選択がトップレベルだけになること) は
  // `overlay-canvas/paste-shapes.test.ts` が固定している。
  await expect.poll(() => shapeIds(page)).toHaveLength(6);
  expect((await shapeIds(page)).some((id) => id.startsWith("cross_tab"))).toBe(false);
});

test("pastes every shape kind, keeping the image asset resolvable", async ({ page }) => {
  await openSourceTab(page);

  await selectAllShapes(page);
  await page.keyboard.press("ControlOrMeta+KeyC");

  await openSecondTab(page);
  await page.keyboard.press("ControlOrMeta+KeyV");
  await expect.poll(() => shapeIds(page)).toHaveLength(6);

  await expect(page.locator(".overlay-shape-text").first()).toContainText("コピーされる文字");
  await expect(page.locator(".overlay-shape-tableShape").first()).toBeVisible();
  // 画像は新しい asset id を指しつつ、バイト列 (data URL) は運ばれている。
  const imageSrc = await page.locator(".overlay-shape-image img").first().getAttribute("src");
  expect(imageSrc).toBe(IMAGE_PNG);
});

test("still pastes after the tab the shapes were copied from is closed", async ({ page }) => {
  await openSourceTab(page);

  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="cross_tab_rect"]').first());
  await page.keyboard.press("ControlOrMeta+KeyC");

  await openSecondTab(page);
  await page.getByLabel("教材A のタブを閉じる").click();
  await expect(page.locator(".document-tab")).toHaveCount(1);

  await page.keyboard.press("ControlOrMeta+KeyV");
  await expect.poll(() => shapeIds(page)).toHaveLength(1);
});

test("keeps pasting inside the same tab working", async ({ page }) => {
  await openSourceTab(page);

  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="cross_tab_rect"]').first());
  await page.keyboard.press("ControlOrMeta+KeyC");
  await page.keyboard.press("ControlOrMeta+KeyV");

  // 元の 6 個 (グループは DOM に出ない) + 貼り付けた 1 個。
  await expect.poll(() => shapeIds(page)).toHaveLength(7);
  expect(await shapeIds(page)).toContain("cross_tab_rect");
});

test("leaves a paste into a text field to that field", async ({ page }) => {
  await openSourceTab(page);

  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="cross_tab_rect"]').first());
  await page.keyboard.press("ControlOrMeta+KeyC");
  await exitOverlayEditing(page);
  const before = await shapeIds(page);

  // 図形をコピーした状態でタイトル欄に貼り付ける。図形が割り込むと、入力欄は何も受け取れない。
  const title = page.getByLabel("教材タイトル");
  await title.click();
  await title.press("ControlOrMeta+KeyA");
  await title.press("ControlOrMeta+KeyV");

  await expect(title).toHaveValue("図形 1個");
  expect(await shapeIds(page)).toEqual(before);
});
