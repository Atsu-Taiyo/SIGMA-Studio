import { expect, test, type Page } from "@playwright/test";

import type { OverlayShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDocumentTabMock } from "./document-tab-mock";

/**
 * ポケット: 編集画面の上の一時置き場。
 *
 * 入れたものは、コピーして貼るのと同じ内容で、別のページや別の教材へ何度でも挿入できる。
 * 教材にもクリップボードにも載らない。ここでは「入れる」「別の教材タブへ挿入する」
 * 「クリップボードを書き換えない」「紙面の高さを壊さない」を実ブラウザで固定する。
 */

const SOURCE_TEXT = "ポケットへ入れる文章";

function shapes(): OverlayShape[] {
  return [
    {
      id: "pocket_rect",
      type: "geo",
      x: 60,
      y: 420,
      rotation: 0,
      props: {
        w: 140,
        h: 80,
        geo: "rectangle",
        fill: "solid",
        color: "#1133cc",
        labelColor: "#111111",
        dash: "solid",
        size: "m",
      },
    },
  ] as OverlayShape[];
}

function sourceDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_pocket_source",
    metadata: { title: "教材A" },
    content: [
      {
        type: "paragraph",
        id: "pocket_body",
        children: [
          { type: "text", text: `${SOURCE_TEXT} ` },
          { type: "mathInline", id: "pocket_math", tex: "x^2+1", display: "inline", semanticRole: "expression" },
          { type: "text", text: " です" },
        ],
      },
      { type: "paragraph", id: "pocket_other", children: [{ type: "text", text: "別の段落" }] },
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot: { version: 1, shapes: shapes(), assets: {} } },
    },
  } as SigmaDocument;
}

/** 「新規教材」で開く 2 枚目のタブ。本文は 1 段落、図形は 0 個から始まる。 */
function blankDocument(): SigmaDocument {
  const source = sourceDocument();
  return {
    ...source,
    docId: "doc_pocket_blank",
    metadata: { title: "教材B" },
    content: [{ type: "paragraph", id: "pocket_blank_body", children: [{ type: "text", text: "貼り付け先" }] }],
    pageLayout: {
      ...source.pageLayout!,
      overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
    },
  } as SigmaDocument;
}

async function openEditor(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDocumentTabMock(page, sourceDocument(), blankDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByLabel("教材タイトル")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();
}

/** 本文の 1 行を端から端までドラッグして選ぶ。 */
async function selectSourceLine(page: Page): Promise<void> {
  const box = await page.locator('[data-sigma-doc-id="pocket_body"]').first().boundingBox();
  if (!box) throw new Error("source paragraph is not visible");
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 6, y);
  await page.mouse.move(box.x + 1, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("です");
}

async function selectRectangle(page: Page): Promise<void> {
  await grabShapeFromBody(page, page.locator('[data-overlay-shape-id="pocket_rect"]').first());
  await expect(page.locator('.overlay-shape.selected[data-overlay-shape-id="pocket_rect"]')).toHaveCount(1);
}

/** 本文へ戻す。オーバーレイ編集中のままタブを増やすと、切り替えが間に合わないことがある。 */
async function exitOverlayEditing(page: Page): Promise<void> {
  const body = await page.locator('[data-sigma-doc-id="pocket_other"]').first().boundingBox();
  expect(body).not.toBeNull();
  await page.mouse.click(body!.x + body!.width - 8, body!.y + body!.height / 2);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
}

async function openSecondTab(page: Page): Promise<void> {
  await exitOverlayEditing(page);
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  await expect(page.locator('[data-sigma-doc-id="pocket_blank_body"]').first()).toBeVisible();
}

/**
 * 図形を貼ると、その図形が選ばれて浮遊ツールバーが上に出る。図形が紙面の上端に近いと、その
 * ツールバーがポケットのカードに重なる (クロームに重なるのと同じ既存の挙動) ので、
 * 次のカードを押す前に選択を外す。
 */
async function deselectShapes(page: Page): Promise<void> {
  // Escape は本文にフォーカスがあると図形まで届かないので、図形のない紙面の空白を押す。
  await page.mouse.click(600, 820);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
}

const pocket = (page: Page) => page.locator("[data-pocket-root]");
const cards = (page: Page) => page.locator("[data-pocket-item] button[data-kind]");

async function shapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(
    Array.from(window.document.querySelectorAll<HTMLElement>("[data-overlay-shape-id]"))
      .map((element) => element.dataset.overlayShapeId ?? "")
      .filter(Boolean),
  )]);
}

/** 紙面の縦スクロールが画面全体に出ていない (ポケットの分だけ紙面が縮んでいる) こと。 */
async function pageFitsViewport(page: Page): Promise<{ overflow: number; workspaceBottom: number; innerHeight: number }> {
  return page.evaluate(() => {
    const root = window.document.documentElement;
    const workspace = window.document.querySelector("main.workspace");
    return {
      overflow: root.scrollHeight - root.clientHeight,
      workspaceBottom: Math.round(workspace?.getBoundingClientRect().bottom ?? -1),
      innerHeight: window.innerHeight,
    };
  });
}

test("stays out of the way until something is put in it", async ({ page }) => {
  await openEditor(page);

  await expect(pocket(page)).toHaveCount(0);
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);
});

test("puts selected body text in the pocket, previews it, and keeps the clipboard untouched", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  // 先に通常のコピーで「別のもの」をクリップボードへ置く。ポケットへ入れても、これが貼り付けられる。
  await page.keyboard.press("ControlOrMeta+C");

  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "shapes");
  await expect(cards(page).first().locator("img")).toBeVisible();
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);

  await exitOverlayEditing(page);
  const other = await page.locator('[data-sigma-doc-id="pocket_other"]').first().boundingBox();
  await page.mouse.click(other!.x + other!.width - 4, other!.y + other!.height / 2);
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  // ⌘V が貼るのは通常のコピー (本文)。ポケットに入れた図形ではない。
  await expect(page.locator('[data-sigma-doc-id="pocket_other"]').first()).toContainText(SOURCE_TEXT);
  expect(await shapeIds(page)).toEqual(["pocket_rect"]);
});

test("renders a text card as the real thing, formulas included", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");
  await expect(cards(page).first()).toContainText(SOURCE_TEXT);
  await expect(cards(page).first().locator(".inline-math-node").first()).toBeVisible();
  // 紙面の同じ ID の要素を増やさない (ID で探す処理が取り違える)。
  await expect(page.locator('[data-sigma-doc-id="pocket_body"]')).toHaveCount(1);
});

test("carries text and a shape to another material and keeps them for reuse", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(2);

  await openSecondTab(page);
  // タブを切り替えても、ポケットはそのまま残っている。
  await expect(cards(page)).toHaveCount(2);

  const blank = await page.locator('[data-sigma-doc-id="pocket_blank_body"]').first().boundingBox();
  await page.mouse.click(blank!.x + blank!.width - 4, blank!.y + blank!.height / 2);
  await page.keyboard.press("End");
  await cards(page).nth(0).click();
  await expect(page.locator(".app-shell")).toContainText(SOURCE_TEXT);
  // 挿入後もキャレットは本文に残り、続けて入力できる。
  await page.keyboard.type("続き");
  await expect(page.locator('[data-sigma-doc-id="pocket_blank_body"]').first()).toContainText("貼り付け先");

  await cards(page).nth(1).click();
  await expect.poll(() => shapeIds(page)).toHaveLength(1);
  expect((await shapeIds(page))[0]).not.toBe("pocket_rect");

  // 何度でも入れられる。項目は減らない。
  await deselectShapes(page);
  await cards(page).nth(1).click();
  await expect.poll(() => shapeIds(page)).toHaveLength(2);
  await expect(cards(page)).toHaveCount(2);
});

test("removes a card, undoes it, and clears everything", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await selectRectangle(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(2);

  await cards(page).first().hover();
  await pocket(page).getByRole("button", { name: "ポケットから外す" }).first().click();
  await expect(cards(page)).toHaveCount(1);
  await pocket(page).getByRole("button", { name: "元に戻す" }).click();
  await expect(cards(page)).toHaveCount(2);
  // 元の並び (本文が先頭) に戻る。
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");

  await pocket(page).getByRole("button", { name: "すべて外す" }).click();
  await expect(cards(page)).toHaveCount(0);
  await pocket(page).getByRole("button", { name: "元に戻す" }).click();
  await expect(cards(page)).toHaveCount(2);
});

test("scrolls a long row of cards sideways, with the mouse wheel too", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  for (let count = 0; count < 12; count += 1) {
    await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  }
  await expect(cards(page)).toHaveCount(12);

  const strip = pocket(page).getByRole("list", { name: "ポケットの中身" });
  const scroll = () => strip.evaluate((element) => ({ left: element.scrollLeft, overflows: element.scrollWidth > element.clientWidth }));
  // 入れた直後は、最後に入れたカードが見える端まで送られている。
  await expect.poll(async () => (await scroll()).overflows).toBe(true);
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);

  const box = await strip.boundingBox();
  await page.mouse.move(box!.x + 300, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -4000);
  await expect.poll(async () => (await scroll()).left).toBe(0);
  await page.mouse.wheel(0, 300);
  await expect.poll(async () => (await scroll()).left).toBeGreaterThan(0);
});

test("says so when nothing is selected, instead of silently doing nothing", async ({ page }) => {
  await openEditor(page);
  await page.locator('[data-sigma-doc-id="pocket_other"]').first().click();
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");

  await expect(pocket(page)).toBeVisible();
  await expect(pocket(page)).toContainText("入れるものが選ばれていません");
  await expect(cards(page)).toHaveCount(0);
});

test("collapses to a thin handle that still shows the count, and reopens", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);
  const expanded = await pocket(page).boundingBox();

  await pocket(page).getByRole("button", { name: "ポケットを閉じる" }).click();
  await expect(pocket(page).getByRole("button", { name: /ポケット 1件/ })).toBeVisible();
  const collapsed = await pocket(page).boundingBox();
  expect(collapsed!.height).toBeLessThan(expanded!.height / 2);
  expect((await pageFitsViewport(page)).overflow).toBeLessThanOrEqual(0);

  await pocket(page).getByRole("button", { name: /ポケット 1件/ }).click();
  await expect(cards(page)).toHaveCount(1);
});

test("keeps the page inside the window with the pocket open", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+Shift+KeyC");
  await expect(cards(page)).toHaveCount(1);

  const fit = await pageFitsViewport(page);
  expect(fit.overflow).toBeLessThanOrEqual(0);
  expect(fit.workspaceBottom).toBeLessThanOrEqual(fit.innerHeight);
  // ポケットは本文の真上、クロームの真下に隣接する。
  const geometry = await page.evaluate(() => {
    const bar = window.document.querySelector("[data-pocket-root]")?.getBoundingClientRect();
    const workspace = window.document.querySelector("main.workspace")?.getBoundingClientRect();
    const chrome = window.document.querySelector("header.editor-menubar")?.getBoundingClientRect();
    return {
      barTop: Math.round(bar?.top ?? -1),
      barBottom: Math.round(bar?.bottom ?? -1),
      workspaceTop: Math.round(workspace?.top ?? -1),
      chromeBottom: Math.round(chrome?.bottom ?? -1),
    };
  });
  expect(geometry.barBottom).toBe(geometry.workspaceTop);
  expect(geometry.barTop).toBe(geometry.chromeBottom);
});

test("puts the selection in the pocket from the selection toolbar and keeps the selection", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.getByRole("button", { name: "ポケットに入れる" }).click();
  await expect(cards(page)).toHaveCount(1);
  // 押しても選択は動かない。続けて別のものを選んで入れられる。
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("です");

  await selectRectangle(page);
  await page.getByRole("button", { name: "ポケットに入れる" }).click();
  await expect(cards(page)).toHaveCount(2);
  await expect(cards(page).nth(1)).toHaveAttribute("data-kind", "shapes");
});

test("runs from the command palette without a keyboard shortcut", async ({ page }) => {
  await openEditor(page);
  await selectSourceLine(page);
  await page.keyboard.press("ControlOrMeta+KeyP");
  await page.getByPlaceholder("コマンドや設定を検索").fill("ポケット");
  await page.getByRole("option", { name: /選んだものをポケットに入れる/ }).click();

  await expect(cards(page)).toHaveCount(1);
  await expect(cards(page).first()).toHaveAttribute("data-kind", "blocks");
});
