import { expect, test, type Locator, type Page } from "@playwright/test";

import type { OverlayShape } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const ANCHORED_BLOCK_ID = "p_anchor";
const OUTSIDE_BLOCK_ID = "p_outside";
const ANCHORED_SHAPE_ID = "shape_anchored";
const OUTSIDE_SHAPE_ID = "shape_outside";
/** アンカーを持たない (ページ固定 = 絶対座標) 図形。取り込み由来の教材はこれが並ぶ。 */
const PAGE_SHAPE_ID = "shape_page_fixed";

function geoShape(id: string, blockId: string, y: number, dy: number): OverlayShape {
  return {
    id,
    type: "geo",
    x: 420,
    y,
    anchor: { type: "block", blockId, dy },
    props: {
      w: 100,
      h: 56,
      geo: "rectangle",
      fill: "solid",
      color: "#1133cc",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  } as OverlayShape;
}

function pageFixedShape(id: string, x: number, y: number): OverlayShape {
  return {
    id,
    type: "geo",
    x,
    y,
    anchor: { type: "page" },
    props: {
      w: 80,
      h: 44,
      geo: "ellipse",
      fill: "solid",
      color: "#118844",
      labelColor: "#111111",
      dash: "solid",
      size: "m",
    },
  } as OverlayShape;
}

interface DocumentOptions {
  /** このブロックの前で改ページ。本文ユニットがそこで切れるので、跨ぐ選択は span になる。 */
  pageBreakBeforeBlockId?: string;
  extraShapes?: OverlayShape[];
}

function createDocument(options: DocumentOptions = {}): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_body_with_shapes_selection";
  document.metadata = { ...document.metadata, title: "本文と図形の同時選択 E2E" };
  document.content = [
    {
      type: "paragraph",
      id: ANCHORED_BLOCK_ID,
      children: [{ type: "text", text: "図形がぶら下がっている段落のテキストです。" }],
    },
    {
      type: "paragraph",
      id: OUTSIDE_BLOCK_ID,
      children: [{ type: "text", text: "選択範囲の外にある段落のテキストです。" }],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_filler_${index}`,
      children: [{ type: "text" as const, text: `続く本文 ${index + 1} 行目のテキストです。` }],
    })),
  ].map((block) => (
    block.id === options.pageBreakBeforeBlockId ? { ...block, pagination: { break: true } } : block
  )) as SigmaDocument["content"];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          geoShape(ANCHORED_SHAPE_ID, ANCHORED_BLOCK_ID, 200, 40),
          geoShape(OUTSIDE_SHAPE_ID, OUTSIDE_BLOCK_ID, 320, 40),
          pageFixedShape(PAGE_SHAPE_ID, 240, 300),
          ...(options.extraShapes ?? []),
        ],
        assets: {},
      },
    },
  };
  return document;
}

async function openEditor(page: Page, options: DocumentOptions = {}): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument(options));
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });
  await expect(page.locator(`[data-overlay-shape-id="${ANCHORED_SHAPE_ID}"]`).first()).toBeVisible();
}

async function clickInBlock(page: Page, blockId: string): Promise<void> {
  const box = await page.locator(`[data-sigma-doc-id="${blockId}"]`).first().boundingBox();
  if (!box) throw new Error(`${blockId} is not visible`);
  await page.mouse.click(box.x + 20, box.y + box.height / 2);
}

async function clickAtEndOfBlock(page: Page, block: Locator): Promise<void> {
  // 改ページを挟む文書では貼り付け先が画面外に出る。`page.mouse` は自動スクロールしない。
  await block.scrollIntoViewIfNeeded();
  const box = await block.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

async function selectedShapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(
    Array.from(window.document.querySelectorAll<HTMLElement>(".overlay-shape.selected"))
      .map((element) => element.closest<HTMLElement>("[data-overlay-shape-id]")?.dataset.overlayShapeId ?? "")
      .filter(Boolean),
  )]);
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

interface SavedBlock {
  id: string;
  type: string;
  pagination?: { break?: boolean };
}

async function savedBlocks(page: Page): Promise<SavedBlock[]> {
  return page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    const value: unknown = raw ? JSON.parse(raw) : null;
    const collect = (entry: unknown): SavedBlock[] => {
      if (!entry || typeof entry !== "object") return [];
      const content = (entry as { content?: unknown }).content;
      if (Array.isArray(content)) return content as SavedBlock[];
      return Object.values(entry).flatMap(collect);
    };
    return collect(value);
  });
}

/** 2 つのブロックにまたがる範囲選択。改ページを挟むと跨ぎ選択 (span) になる。 */
async function dragSelectRange(page: Page, fromBlockId: string, toBlockId: string): Promise<void> {
  const fromBlock = page.locator(`[data-sigma-doc-id="${fromBlockId}"]`).first();
  const toBlock = page.locator(`[data-sigma-doc-id="${toBlockId}"]`).first();
  await fromBlock.scrollIntoViewIfNeeded();
  const from = await fromBlock.boundingBox();
  const to = await toBlock.boundingBox();
  if (!from || !to) throw new Error("range endpoints are not visible");
  await page.mouse.click(from.x + 6, from.y + from.height / 2);
  await page.mouse.move(from.x + 4, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width - 6, to.y + to.height / 2, { steps: 12 });
  await page.mouse.up();
}

async function dragSelectBlock(page: Page, blockId: string): Promise<void> {
  const box = await page.locator(`[data-sigma-doc-id="${blockId}"]`).first().boundingBox();
  if (!box) throw new Error(`${blockId} is not visible`);
  const y = box.y + box.height / 2;
  await page.mouse.click(box.x + 6, y);
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, y, { steps: 8 });
  await page.mouse.up();
}

/** 保持選択の描画は CSS Custom Highlight (`::highlight(held-body-selection)`) が持つ。 */
async function heldSelectionHighlightActive(page: Page): Promise<boolean> {
  return page.evaluate(() => CSS.highlights.has("held-body-selection"));
}

test("does not paint the held overlay while dragging a body selection", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  await expect(page.locator(".text-flow-editor").first()).toHaveClass(/ProseMirror-focused/);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("図形がぶら下がっている段落");
  await expect.poll(() => heldSelectionHighlightActive(page)).toBe(false);
});

test("hides the held overlay when the body editor takes focus back", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  const shape = await page.locator(`[data-overlay-shape-id="${OUTSIDE_SHAPE_ID}"]`).first().boundingBox();
  if (!shape) throw new Error("shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");
  await expect.poll(() => heldSelectionHighlightActive(page)).toBe(true);
  // 数式アトム補完用の印も、保持中のエディタに付く。
  await expect(page.locator(".text-flow-editor[data-held-body-selection]")).toHaveCount(1);

  await page.locator(".text-flow-editor").first().evaluate((element) => {
    (element as HTMLElement).focus();
  });
  await expect(page.locator(".text-flow-editor").first()).toHaveClass(/ProseMirror-focused/);
  await expect.poll(() => heldSelectionHighlightActive(page)).toBe(false);
  await expect(page.locator(".text-flow-editor[data-held-body-selection]")).toHaveCount(0);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("図形がぶら下がっている段落");
  await expect.poll(() => selectedShapeIds(page)).toEqual([OUTSIDE_SHAPE_ID]);
});

test("selects the shapes hung on the selected body and shows both selections", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  await page.keyboard.press("ControlOrMeta+Shift+A");

  // 本文の選択は残り、その本文にぶら下がった図形だけが選ばれる。
  await expect.poll(() => selectedShapeIds(page)).toEqual([ANCHORED_SHAPE_ID]);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("図形がぶら下がっている段落");
  // Cmd+Shift+A は本文フォーカスを残すので、ネイティブ選択だけを見せて保持描画は出さない。
  await expect(page.locator(".text-flow-editor").first()).toHaveClass(/ProseMirror-focused/);
  await expect.poll(() => heldSelectionHighlightActive(page)).toBe(false);
});

test("adds a shape to a live body selection with a single Cmd+click", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  const shape = await page.locator(`[data-overlay-shape-id="${OUTSIDE_SHAPE_ID}"]`).first().boundingBox();
  if (!shape) throw new Error("shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");

  // 1 クリックで図形が選ばれ、本文の選択も残っている (保持描画 = Highlight が出る)。
  await expect.poll(() => selectedShapeIds(page)).toEqual([OUTSIDE_SHAPE_ID]);
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("図形がぶら下がっている段落");
  await expect.poll(() => heldSelectionHighlightActive(page)).toBe(true);
});

test("selects the whole editor body and every shape from a bare caret", async ({ page }) => {
  await openEditor(page);
  await clickInBlock(page, `p_filler_0`);

  await page.keyboard.press("ControlOrMeta+Shift+A");

  // 範囲を持たないキャレットからの ⌘Shift+A は「全選択」なので、本文にぶら下がっても
  // 重なってもいないページ固定の図形まで入る (一部だけ取り残さない)。
  await expect.poll(async () => (await selectedShapeIds(page)).sort())
    .toEqual([ANCHORED_SHAPE_ID, OUTSIDE_SHAPE_ID, PAGE_SHAPE_ID].sort());
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("選択範囲の外にある段落");
});

test("selects the whole document and every shape across a page break", async ({ page }) => {
  // 改ページは本文を別々の Tiptap インスタンスへ切る。⌘Shift+A が自分の編集器だけを
  // 全選択していた頃は、キャレットのあるページ分の本文と図形しか選べなかった。
  await openEditor(page, { pageBreakBeforeBlockId: OUTSIDE_BLOCK_ID });
  await clickInBlock(page, ANCHORED_BLOCK_ID);

  await page.keyboard.press("ControlOrMeta+Shift+A");

  await expect.poll(async () => (await selectedShapeIds(page)).sort())
    .toEqual([ANCHORED_SHAPE_ID, OUTSIDE_SHAPE_ID, PAGE_SHAPE_ID].sort());
  // 本文も 2 ページ目まで選ばれている (跨ぎ選択 = 全ユニットに印が付く)。
  await expect(page.locator(".text-flow-editor[data-text-run-span]")).toHaveCount(2);
  await expect.poll(() => page.evaluate(() => CSS.highlights.has("text-run-span"))).toBe(true);
});

test("keeps a range selection to the shapes that belong to it, page break or not", async ({ page }) => {
  // 範囲を持っているときは今までどおり「その本文にぶら下がる / 重なる図形」だけ。
  await openEditor(page, { pageBreakBeforeBlockId: OUTSIDE_BLOCK_ID });
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  await page.keyboard.press("ControlOrMeta+Shift+A");

  await expect.poll(() => selectedShapeIds(page)).toEqual([ANCHORED_SHAPE_ID]);
});

test("keeps ordinary select-all to the body alone", async ({ page }) => {
  await openEditor(page);
  await clickInBlock(page, ANCHORED_BLOCK_ID);

  await page.keyboard.press("ControlOrMeta+A");

  expect(await page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("図形がぶら下がっている段落");
  expect(await selectedShapeIds(page)).toEqual([]);
});

test("pastes the selection at the caret with the shape in the same relative position", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect.poll(() => selectedShapeIds(page)).toEqual([ANCHORED_SHAPE_ID]);

  const sourceLine = await page.locator(`[data-sigma-doc-id="${ANCHORED_BLOCK_ID}"]`).first().boundingBox();
  const original = await page
    .locator(`.overlay-canvas-editor [data-overlay-shape-id="${ANCHORED_SHAPE_ID}"]`).first().boundingBox();
  expect(sourceLine && original).toBeTruthy();
  const sourceOffsetY = original!.y - sourceLine!.y;

  await page.keyboard.press("ControlOrMeta+C");

  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText("図形がぶら下がっている段落");
  await expect.poll(async () => (await savedShapes(page)).length).toBe(4);
  const pasted = (await savedShapes(page))
    .find((shape) => shape.id !== ANCHORED_SHAPE_ID && shape.id !== OUTSIDE_SHAPE_ID && shape.id !== PAGE_SHAPE_ID);
  expect(pasted?.anchor).toMatchObject({ type: "block", blockId: "p_filler_3" });

  const pastedBox = await page
    .locator(`.overlay-canvas-editor [data-overlay-shape-id="${pasted!.id}"]`).first().boundingBox();
  const destinationLine = await destination.boundingBox();
  expect(pastedBox && destinationLine).toBeTruthy();
  // 貼り付け先の段落から見た位置が、コピー元の段落から見た位置と同じ。
  expect(Math.abs((pastedBox!.y - destinationLine!.y) - sourceOffsetY)).toBeLessThan(2);
  expect(Math.abs(pastedBox!.x - original!.x)).toBeLessThan(2);
});

test("re-anchors a shape hung outside the copied text so it lands relative to the caret", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);

  // コピー範囲の外の段落にぶら下がっている図形を、Cmd+クリックで足す。
  const shape = await page.locator(`[data-overlay-shape-id="${OUTSIDE_SHAPE_ID}"]`).first().boundingBox();
  if (!shape) throw new Error("outside shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");
  const mounted = await page.locator(`[data-overlay-shape-id="${OUTSIDE_SHAPE_ID}"]`).first().boundingBox();
  if (!mounted) throw new Error("outside shape disappeared after entering overlay editing");
  await page.mouse.move(mounted.x + mounted.width + 120, mounted.y + mounted.height + 120);
  await page.mouse.click(mounted.x + mounted.width / 2, mounted.y + mounted.height / 2);
  await expect.poll(() => selectedShapeIds(page)).toEqual([OUTSIDE_SHAPE_ID]);

  const sourceLine = await page.locator(`[data-sigma-doc-id="${ANCHORED_BLOCK_ID}"]`).first().boundingBox();
  const original = await page
    .locator(`.overlay-canvas-editor [data-overlay-shape-id="${OUTSIDE_SHAPE_ID}"]`).first().boundingBox();
  expect(sourceLine && original).toBeTruthy();
  // コピーした本文 (ANCHORED_BLOCK_ID) から見た図形の位置。
  const sourceOffsetY = original!.y - sourceLine!.y;

  await page.keyboard.press("ControlOrMeta+C");

  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText("図形がぶら下がっている段落");
  await expect.poll(async () => (await savedShapes(page)).length).toBe(4);
  const pasted = (await savedShapes(page))
    .find((shape2) => shape2.id !== ANCHORED_SHAPE_ID && shape2.id !== OUTSIDE_SHAPE_ID && shape2.id !== PAGE_SHAPE_ID);
  // 元は p_outside にぶら下がっていた図形が、貼り付け先のブロックへ付け替わる。
  expect(pasted?.anchor).toMatchObject({ type: "block", blockId: "p_filler_3" });

  const pastedBox = await page
    .locator(`.overlay-canvas-editor [data-overlay-shape-id="${pasted!.id}"]`).first().boundingBox();
  const destinationLine = await destination.boundingBox();
  expect(pastedBox && destinationLine).toBeTruthy();
  expect(Math.abs((pastedBox!.y - destinationLine!.y) - sourceOffsetY)).toBeLessThan(2);
  expect(Math.abs(pastedBox!.x - original!.x)).toBeLessThan(2);
});

async function cmdClickShape(page: Page, shapeId: string): Promise<void> {
  const box = await page.locator(`[data-overlay-shape-id="${shapeId}"]`).first().boundingBox();
  if (!box) throw new Error(`${shapeId} is not visible`);
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.up("ControlOrMeta");
}

async function shapeBox(page: Page, shapeId: string) {
  const box = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${shapeId}"]`).first().boundingBox();
  if (!box) throw new Error(`${shapeId} is not rendered in the editor`);
  return box;
}

test("pastes an unanchored shape relative to the caret instead of its absolute spot", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);
  await cmdClickShape(page, PAGE_SHAPE_ID);
  await expect.poll(() => selectedShapeIds(page)).toEqual([PAGE_SHAPE_ID]);

  const sourceLine = await page.locator(`[data-sigma-doc-id="${ANCHORED_BLOCK_ID}"]`).first().boundingBox();
  const original = await shapeBox(page, PAGE_SHAPE_ID);
  const sourceOffsetY = original.y - sourceLine!.y;

  await page.keyboard.press("ControlOrMeta+C");
  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText("図形がぶら下がっている段落");
  await expect.poll(async () => (await savedShapes(page)).length).toBe(4);
  const pasted = (await savedShapes(page)).find((shape) => (
    shape.id !== ANCHORED_SHAPE_ID && shape.id !== OUTSIDE_SHAPE_ID && shape.id !== PAGE_SHAPE_ID
  ));
  // 貼り付け先の本文にぶら下がる形へ引き直される (絶対座標のままにしない)。
  expect(pasted?.anchor).toMatchObject({ type: "block", blockId: "p_filler_3" });

  const pastedBox = await shapeBox(page, pasted!.id);
  const destinationLine = await destination.boundingBox();
  expect(Math.abs((pastedBox.y - destinationLine!.y) - sourceOffsetY)).toBeLessThan(2);
  expect(Math.abs(pastedBox.x - original.x)).toBeLessThan(2);
});

test("keeps the geometry between an anchored and an unanchored shape", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect.poll(() => selectedShapeIds(page)).toEqual([ANCHORED_SHAPE_ID]);
  await cmdClickShape(page, PAGE_SHAPE_ID);
  await expect.poll(async () => (await selectedShapeIds(page)).length).toBe(2);

  const anchoredBefore = await shapeBox(page, ANCHORED_SHAPE_ID);
  const pageBefore = await shapeBox(page, PAGE_SHAPE_ID);
  const gap = { x: pageBefore.x - anchoredBefore.x, y: pageBefore.y - anchoredBefore.y };

  await page.keyboard.press("ControlOrMeta+C");
  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => (await savedShapes(page)).length).toBe(5);
  const pastedIds = (await savedShapes(page))
    .filter((shape) => shape.id !== ANCHORED_SHAPE_ID && shape.id !== OUTSIDE_SHAPE_ID && shape.id !== PAGE_SHAPE_ID)
    .map((shape) => shape.id);
  expect(pastedIds).toHaveLength(2);

  const boxes = await Promise.all(pastedIds.map((id) => shapeBox(page, id)));
  const [first, second] = boxes.sort((left, right) => left.y - right.y);
  // 2 つの図形の相対位置は貼り付け後も変わらない。
  expect(Math.abs((second.x - first.x) - gap.x)).toBeLessThan(2);
  expect(Math.abs((second.y - first.y) - gap.y)).toBeLessThan(2);
});

test("copies body and shapes twice in a row, the second time across a page break", async ({ page }) => {
  // 「1 回目はうまくいくのに 2 回目は本文だけ貼られる」の回帰。2 回目はページを跨ぐ
  // = 複数エディタにまたがる選択で、この経路がオーバーレイまで届かないと図形が落ちる。
  await openEditor(page, { pageBreakBeforeBlockId: "p_filler_0" });
  // 自動スクロールの速度や待ち時間に依存せず、跨ぎ選択そのものだけを検証するため、
  // 2 ページ目までを 1 画面に入れる。
  await page.setViewportSize({ width: 1400, height: 1500 });

  await dragSelectBlock(page, ANCHORED_BLOCK_ID);
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect.poll(async () => (await selectedShapeIds(page)).length).toBeGreaterThan(0);
  const firstCopied = (await selectedShapeIds(page)).length;
  await page.keyboard.press("ControlOrMeta+C");

  const firstDestination = page.locator('[data-sigma-doc-id="p_filler_2"]').first();
  await clickAtEndOfBlock(page, firstDestination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");
  await expect.poll(async () => (await savedShapes(page)).length).toBe(3 + firstCopied);

  // 2 回目: 改ページを跨ぐ別の範囲。
  await dragSelectRange(page, OUTSIDE_BLOCK_ID, "p_filler_1");
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect.poll(async () => (await selectedShapeIds(page)).includes(OUTSIDE_SHAPE_ID)).toBe(true);
  const secondCopied = (await selectedShapeIds(page)).length;
  await page.keyboard.press("ControlOrMeta+C");

  await clickAtEndOfBlock(page, page.locator('[data-sigma-doc-id="p_filler_3"]').first());
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  // 跨ぎ選択は 3 ブロック丸ごとなので、貼り付け先の段落の後ろに段落として並ぶ。
  await expect.poll(async () => (await savedBlocks(page)).length).toBe(9);
  // 図形も 2 回目で増える (本文だけが貼られたら 3 + firstCopied のまま)。
  await expect.poll(async () => (await savedShapes(page)).length).toBe(3 + firstCopied + secondCopied);
});

test("keeps a manual page break inside the copied range", async ({ page }) => {
  await openEditor(page, { pageBreakBeforeBlockId: "p_filler_0" });

  await dragSelectRange(page, OUTSIDE_BLOCK_ID, "p_filler_1");
  await page.keyboard.press("ControlOrMeta+C");

  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => (await savedBlocks(page)).filter((block) => block.pagination?.break).length)
    .toBe(2);
});

test("carries a page-fixed shape that sits on the selected text", async ({ page }) => {
  // 取り込み由来の教材はアンカーを持たない図形が並ぶ。本文の上に載っているのに
  // コピーされないと「図形が付いてこない」に見える。
  // 座標は紙面キャンバス基準。2 段落目 (p_outside) の行の上に重ねてある。
  await openEditor(page, {
    extraShapes: [{
      id: "shape_on_text",
      type: "geo",
      x: 100,
      y: 108,
      anchor: { type: "page" },
      props: {
        w: 40, h: 14, geo: "rectangle", fill: "solid",
        color: "#cc3311", labelColor: "#111111", dash: "solid", size: "s",
      },
    } as OverlayShape],
  });

  await dragSelectBlock(page, OUTSIDE_BLOCK_ID);
  await page.keyboard.press("ControlOrMeta+Shift+A");

  await expect.poll(async () => (await selectedShapeIds(page)).includes("shape_on_text")).toBe(true);
});

test("cuts the body and the shapes together", async ({ page }) => {
  await openEditor(page);
  await dragSelectBlock(page, ANCHORED_BLOCK_ID);
  await page.keyboard.press("ControlOrMeta+Shift+A");
  await expect.poll(() => selectedShapeIds(page)).toEqual([ANCHORED_SHAPE_ID]);

  await page.keyboard.press("ControlOrMeta+X");

  // 本文も図形も文書から消える。
  await expect(page.locator(`[data-sigma-doc-id="${ANCHORED_BLOCK_ID}"]`).first())
    .not.toContainText("図形がぶら下がっている段落");
  await expect.poll(async () => (await savedShapes(page)).map((shape) => shape.id))
    .toEqual([OUTSIDE_SHAPE_ID, PAGE_SHAPE_ID]);

  // 切り取った中身は貼り付けで戻せる。
  const destination = page.locator('[data-sigma-doc-id="p_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText("図形がぶら下がっている段落");
  await expect.poll(async () => (await savedShapes(page)).length).toBe(3);
});
