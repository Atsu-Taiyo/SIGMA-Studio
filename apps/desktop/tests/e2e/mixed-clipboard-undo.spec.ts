import { expect, test, type Locator, type Page } from "@playwright/test";

import type { OverlayShape } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 本文と図形が混ざったペースト / カットが **⌘Z 1 回**で戻ること。
 *
 * 図形側の保存は `queueOverlaySave` の 250ms 後に別の `commitDocumentChange` として届く。
 * 素直に record すると履歴が 2 段積まれ、⌘Z 1 回では本文が戻らない —— 報告された
 * 「大きいブロックごとペーストしたら戻せない」「カットしたら戻せない」の正体。
 *
 * **図形だけの操作が従来どおり 1 回で戻ること (3 本目) が同じくらい重要**。
 * `commitDocumentChange` の `coalesce: true` は record を丸ごとスキップするので、
 * そちらに倒した実装はこのテストで落ちる。
 */

const TARGET_BLOCK_ID = "p_mixed_target";
const DESTINATION_BLOCK_ID = "p_mixed_filler_3";
const SHAPE_ID = "shape_mixed";
/** 混在選択に入れるがロックされていて消えない図形 (キー取り残しの再現用)。 */
const LOCKED_SHAPE_ID = "shape_mixed_locked";
const COPIED_TEXT = "あいうえおかきくけこ";

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_mixed_clipboard_undo";
  document.metadata = { ...document.metadata, title: "混在クリップボードの Undo E2E" };
  document.content = [
    {
      type: "paragraph",
      id: TARGET_BLOCK_ID,
      children: [{ type: "text", text: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ" }],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_mixed_filler_${index}`,
      children: [{ type: "text" as const, text: `続く本文 ${index + 1} 行目のテキストです。` }],
    })),
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: LOCKED_SHAPE_ID,
          type: "geo",
          locked: true,
          x: 400,
          y: 320,
          anchor: { type: "block", blockId: TARGET_BLOCK_ID, dy: 180 },
          props: {
            w: 100,
            h: 56,
            geo: "rectangle",
            fill: "solid",
            color: "#cc3311",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        }, {
          id: SHAPE_ID,
          type: "geo",
          x: 400,
          y: 200,
          anchor: { type: "block", blockId: TARGET_BLOCK_ID, dy: 60 },
          props: {
            w: 120,
            h: 64,
            geo: "rectangle",
            fill: "solid",
            color: "#1133cc",
            labelColor: "#111111",
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
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(".page-flow .text-flow-editor").first()).toBeVisible();
  await expect(page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first()).toBeVisible();
}

async function selectBodyText(page: Page): Promise<void> {
  const line = await page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first().boundingBox();
  if (!line) throw new Error("target paragraph is not visible");
  const y = line.y + line.height / 2;
  await page.mouse.click(line.x + 6, y);
  await page.mouse.move(line.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(line.x + 160, y, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(COPIED_TEXT);
}

/** 本文の選択に図形を足した混在選択 (`text-and-shapes-clipboard.spec.ts` と同じ手順)。 */
async function createMixedSelection(page: Page, shapeId: string = SHAPE_ID): Promise<void> {
  await selectBodyText(page);
  const shape = await page.locator(`[data-overlay-shape-id="${shapeId}"]`).first().boundingBox();
  if (!shape) throw new Error("shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");
  const mountedShape = await page.locator(`[data-overlay-shape-id="${shapeId}"]`).first().boundingBox();
  if (!mountedShape) throw new Error("shape disappeared after entering overlay editing");
  await page.mouse.move(mountedShape.x + mountedShape.width + 100, mountedShape.y + mountedShape.height + 100);
  await page.mouse.click(mountedShape.x + mountedShape.width / 2, mountedShape.y + mountedShape.height / 2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(COPIED_TEXT);
}

/** 本文を選ばずに図形だけを選ぶ (回帰防止テスト用)。 */
async function selectShapeOnly(page: Page): Promise<void> {
  await grabShapeFromBody(page, page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first());
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).not.toContain(COPIED_TEXT);
}

async function savedShapes(page: Page): Promise<OverlayShape[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const value: unknown = raw ? JSON.parse(raw) : null;
    const collect = (entry: unknown): OverlayShape[] => {
      if (!entry || typeof entry !== "object") return [];
      if (Array.isArray((entry as { shapes?: unknown }).shapes)) {
        return (entry as { shapes: OverlayShape[] }).shapes;
      }
      return Object.values(entry).flatMap(collect);
    };
    return collect(value);
  });
}

/**
 * 図形側の保存は `queueOverlaySave` の 250ms 遅延で届く。**undo を押す前に必ず着地させる** —
 * 着地前に undo すると、あとから来た保存が undo 後の文書へ書き込まれて何を測ったか分からなくなる
 * (実ユーザーの操作間隔でも 250ms は先に過ぎる)。
 */
async function expectSavedShapeCount(page: Page, count: number): Promise<void> {
  await expect.poll(async () => (await savedShapes(page)).length, { timeout: 10_000 }).toBe(count);
}

async function savedShapeX(page: Page, shapeId: string): Promise<number> {
  const shape = (await savedShapes(page)).find((candidate) => candidate.id === shapeId);
  if (!shape) throw new Error(`${shapeId} is not in the saved document`);
  return shape.x;
}

/** 図形を掴んで動かす (混在操作とは無関係な、ただの図形編集)。 */
async function dragShape(page: Page, shapeId: string, dx: number, dy: number): Promise<void> {
  const shape = page.locator(`[data-overlay-shape-id="${shapeId}"]`).first();
  await shape.scrollIntoViewIfNeeded();
  const targetBox = await shape.boundingBox();
  if (!targetBox) throw new Error(`${shapeId} is not visible`);
  // 中央は直前に貼った別図形の浮遊ボタンと重なることがある。矩形の露出した右下を掴む。
  const point = { x: targetBox.x + targetBox.width * 0.85, y: targetBox.y + targetBox.height * 0.85 };
  // 掴むのは共有ヘルパ経由 (本文モードからの入り方は `body-overlay-entry.ts` が唯一の規約)。
  await grabShapeFromBody(page, point);
  const box = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${shapeId}"]`).first().boundingBox();
  if (!box) throw new Error(`${shapeId} is not visible in the overlay editor`);
  const from = { x: box.x + box.width * 0.85, y: box.y + box.height * 0.85 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 10 });
  await page.mouse.up();
}

async function clickAtEndOfBlock(page: Page, block: Locator): Promise<void> {
  const box = await block.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

/** 混在ペーストを 1 回行い、図形側の保存が着地するまで待つ。 */
async function pasteMixedSelection(page: Page): Promise<Locator> {
  await createMixedSelection(page);
  await page.keyboard.press("ControlOrMeta+C");

  const destination = page.locator(`[data-sigma-doc-id="${DESTINATION_BLOCK_ID}"]`).first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText(COPIED_TEXT);
  await expectSavedShapeCount(page, 3);
  return destination;
}

test("undoes a mixed paste of body text and shapes in one step", async ({ page }) => {
  await openEditor(page);
  const destination = await pasteMixedSelection(page);

  await page.keyboard.press("ControlOrMeta+Z");

  await expect(destination).not.toContainText(COPIED_TEXT);
  await expectSavedShapeCount(page, 2);
});

test("undoes a mixed cut of body text and shapes in one step", async ({ page }) => {
  await openEditor(page);
  await createMixedSelection(page);

  await page.keyboard.press("ControlOrMeta+X");

  const source = page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first();
  await expect(source).not.toContainText(COPIED_TEXT);
  // ロックされた図形は消えないので 1 個残る。
  await expectSavedShapeCount(page, 1);

  await page.keyboard.press("ControlOrMeta+Z");

  await expect(source).toContainText(COPIED_TEXT);
  await expectSavedShapeCount(page, 2);
});

test("still undoes a shape-only cut in one step", async ({ page }) => {
  // 回帰防止。`coalesce: true` は record を丸ごとスキップするので、そちらに倒した実装だと
  // **図形だけの操作が永久に戻せなくなる**。ここが落ちたらその設計に踏み込んでいる。
  await openEditor(page);
  await selectShapeOnly(page);

  await page.keyboard.press("ControlOrMeta+X");
  await expectSavedShapeCount(page, 1);

  await page.keyboard.press("ControlOrMeta+Z");

  await expectSavedShapeCount(page, 2);
  const source = page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first();
  await expect(source).toContainText(COPIED_TEXT);
});

test("loses nothing when typing follows a mixed paste", async ({ page }) => {
  // 250ms の窓の中で本文編集が続くと、図形側は「直前のキーと違う」ので独立エントリになる。
  // undo が 2 手に増えるのは許容 —— **何も失われない**ことが条件 (plan §3.5)。
  await openEditor(page);
  const destination = await pasteMixedSelection(page);

  await page.keyboard.type("追記");
  await expect(destination).toContainText("追記");

  await page.keyboard.press("ControlOrMeta+Z");
  await page.keyboard.press("ControlOrMeta+Z");

  await expect(destination).not.toContainText("追記");
  await expect(destination).not.toContainText(COPIED_TEXT);
  await expectSavedShapeCount(page, 2);
});

test("does not leave its key behind when the cut deletes no shape", async ({ page }) => {
  // 選択が全てロックされていると `deleteSelectedShapes` は何もせずに戻る。
  //
  // ⚠️ **この e2e は修正の証明にはならない** (実測): キーを置いたままにする変異を当てても
  // 緑のままだった。掴み直しが挟む保存が先にキーを食ってしまい、ドラッグ本体には届かない。
  // ここが押さえているのは「利用者から見て次の図形編集が独立して戻せる」ことまでで、
  // キーを取り残さないこと自体は `overlay-history-group.test.ts` の構造検査が受け持つ。
  await openEditor(page);
  await createMixedSelection(page, LOCKED_SHAPE_ID);

  await page.keyboard.press("ControlOrMeta+X");
  const source = page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first();
  await expect(source).not.toContainText(COPIED_TEXT);
  // ロックされているので図形は 1 つも消えない。
  await expectSavedShapeCount(page, 2);

  const originalX = await savedShapeX(page, SHAPE_ID);
  await dragShape(page, SHAPE_ID, 90, 0);
  await expect.poll(async () => savedShapeX(page, SHAPE_ID), { timeout: 10_000 }).not.toBe(originalX);

  await page.keyboard.press("ControlOrMeta+Z");

  // 直前の移動が戻る (キーを継承していたら、この record は畳まれていて戻らない)。
  await expect.poll(async () => savedShapeX(page, SHAPE_ID), { timeout: 10_000 }).toBe(originalX);
});

test("closes its 250ms window on the operation instead of the next edit", async ({ page }) => {
  // キー付きの保存を debounce すると窓の後ろ側を縛るものが無く、続けて起きた無関係な
  // 図形編集まで同じ undo エントリに畳まれる。操作の時点で確定させて窓を閉じる。
  //
  // ⚠️ **この e2e も修正の証明にはならない** (実測): debounce に戻す変異でも緑のまま。
  // Playwright の掴み直し + ドラッグは 250ms より確実に遅く、窓がテストの遅さで勝手に
  // 閉じてしまう。即時確定であることは `overlay-history-group.test.ts` の構造検査で押さえる。
  await openEditor(page);
  await pasteMixedSelection(page);

  const originalX = await savedShapeX(page, SHAPE_ID);
  await dragShape(page, SHAPE_ID, 90, 0);
  await expect.poll(async () => savedShapeX(page, SHAPE_ID), { timeout: 10_000 }).not.toBe(originalX);

  await page.keyboard.press("ControlOrMeta+Z");

  // 1 手目で戻るのは移動だけ。ペーストはまだ残っている。
  await expect.poll(async () => savedShapeX(page, SHAPE_ID), { timeout: 10_000 }).toBe(originalX);
  await expectSavedShapeCount(page, 3);
});
