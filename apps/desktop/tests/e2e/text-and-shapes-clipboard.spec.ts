import { expect, test, type Locator, type Page } from "@playwright/test";

import type { OverlayShape } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { installDocumentTabMock } from "./document-tab-mock";

const TARGET_BLOCK_ID = "p_mixed_target";
const SHAPE_ID = "shape_mixed";
const COPIED_TEXT = "あいうえおかきくけこ";

const MATH_BLOCK_ID = "p_mixed_math";
const MATH_TEX = "x^2+1";

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_text_and_shapes_clipboard";
  document.metadata = { ...document.metadata, title: "本文と図形の混在コピー E2E" };
  document.content = [
    {
      type: "paragraph",
      id: TARGET_BLOCK_ID,
      children: [{ type: "text", text: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ" }],
    },
    {
      // 数式を含む段落: 選択に数式が入ると inline-math 拡張が本文側の copy を横取りして
      // Sigma の wrapper HTML を書く経路になる (PM 既定の HTML は無い)。
      type: "paragraph",
      id: MATH_BLOCK_ID,
      children: [
        { type: "text", text: "式 " },
        { type: "mathInline", id: "m_mixed", tex: MATH_TEX, display: "inline", semanticRole: "expression" },
        { type: "text", text: " を含む本文" },
      ],
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

/**「新規教材」で開く 2 枚目のタブ。図形が無いので、貼り付いた分だけを数えられる。 */
function blankDocument(): SigmaDocument {
  const document = createDocument();
  document.docId = "doc_e2e_text_and_shapes_clipboard_blank";
  document.metadata = { ...document.metadata, title: "貼り付け先" };
  document.content = [{
    type: "paragraph",
    id: "p_blank_body",
    children: [{ type: "text", text: "貼り付け先の本文" }],
  }];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: { overlaySnapshot: { version: 1, shapes: [], assets: {} } },
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

async function createMixedSelection(page: Page): Promise<void> {
  await selectBodyText(page);
  const shape = await page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  if (!shape) throw new Error("shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");
  const mountedShape = await page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  if (!mountedShape) throw new Error("shape disappeared after entering overlay editing");
  await page.mouse.move(mountedShape.x + mountedShape.width + 100, mountedShape.y + mountedShape.height + 100);
  await page.mouse.click(mountedShape.x + mountedShape.width / 2, mountedShape.y + mountedShape.height / 2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain(COPIED_TEXT);
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

async function clickAtEndOfBlock(page: Page, block: Locator): Promise<void> {
  const box = await block.boundingBox();
  if (!box) throw new Error("destination paragraph is not visible");
  await page.mouse.click(box.x + box.width - 4, box.y + box.height / 2);
}

/** 描画中の図形 id (編集レイヤとプレビューレイヤの重複を除く)。 */
async function shapeIds(page: Page): Promise<string[]> {
  return page.evaluate(() => [...new Set(
    Array.from(window.document.querySelectorAll<HTMLElement>("[data-overlay-shape-id]"))
      .map((element) => element.dataset.overlayShapeId ?? "")
      .filter(Boolean),
  )]);
}

async function bodyTexts(page: Page): Promise<string[]> {
  return page.locator(".page-flow .ProseMirror [data-sigma-doc-id]").evaluateAll((elements) => (
    elements.map((element) => element.textContent ?? "")
  ));
}

test("pastes mixed text and shapes at a body caret and remaps the block anchor", async ({ page }) => {
  await openEditor(page);
  await createMixedSelection(page);
  await page.keyboard.press("ControlOrMeta+C");

  // オーバーレイ編集中は locator の click が「オーバーレイに遮られている」と判定して永久に
  // リトライするので座標で押す (`body-overlay-entry.ts` と同じ規約)。図形に当たらない素の
  // クリックはオーバーレイ編集を降りて本文にキャレットを置く。
  const destination = page.locator('[data-sigma-doc-id="p_mixed_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText(COPIED_TEXT);
  await expect.poll(async () => (await savedShapes(page)).length).toBe(2);
  const pasted = (await savedShapes(page)).find((shape) => shape.id !== SHAPE_ID);
  expect(pasted?.anchor).toMatchObject({ type: "block", blockId: "p_mixed_filler_3" });
  // 保存時の再アンカーは実測位置から dy を逆算するので、浮動小数の誤差だけ許す。
  expect(pasted?.anchor?.type === "block" ? pasted.anchor.dy : NaN).toBeCloseTo(60, 3);
  // 貼り付けた図形は貼り付け先の段落に相対配置される: 元の図形と同じ dy なので、段落間の
  // 距離だけ下に出る。
  const original = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  const pastedBox = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${pasted!.id}"]`).first().boundingBox();
  const sourceLine = await page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first().boundingBox();
  const destinationLine = await destination.boundingBox();
  expect(original && pastedBox && sourceLine && destinationLine).toBeTruthy();
  expect(Math.abs((pastedBox!.y - original!.y) - (destinationLine!.y - sourceLine!.y))).toBeLessThan(2);
  expect(Math.abs(pastedBox!.x - original!.x)).toBeLessThan(2);
});

test("duplicates the shape while replacing the stale mixed body selection with the same text", async ({ page }) => {
  await openEditor(page);
  await createMixedSelection(page);
  const before = await bodyTexts(page);
  await page.keyboard.press("ControlOrMeta+C");
  await page.keyboard.press("ControlOrMeta+V");

  await expect.poll(async () => (await savedShapes(page)).length).toBe(2);
  expect(await bodyTexts(page)).toEqual(before);
});

test("does not add a shape for a body-only text copy", async ({ page }) => {
  await openEditor(page);
  await selectBodyText(page);
  await page.keyboard.press("ControlOrMeta+C");
  const destination = page.locator('[data-sigma-doc-id="p_mixed_filler_2"]').first();
  await clickAtEndOfBlock(page, destination);
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText(COPIED_TEXT);
  await expect.poll(async () => (await savedShapes(page)).length).toBe(1);
});

test("pastes the mixed copy into another material tab and anchors the shape to the pasted-into paragraph", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDocumentTabMock(page, createDocument(), blankDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first()).toBeVisible();

  await createMixedSelection(page);
  await page.keyboard.press("ControlOrMeta+C");
  const sourceLine = await page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first().boundingBox();
  const original = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  expect(sourceLine && original).toBeTruthy();
  const sourceOffsetY = original!.y - sourceLine!.y;

  // 図形から離れた本文を押してオーバーレイ編集を降りてからタブを増やす (cross-tab-shape-paste.spec と同じ規約)。
  await clickAtEndOfBlock(page, page.locator('[data-sigma-doc-id="p_mixed_filler_3"]').first());
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  const destination = page.locator('[data-sigma-doc-id="p_blank_body"]').first();
  await expect(destination).toBeVisible();
  await expect.poll(() => shapeIds(page)).toEqual([]);

  await destination.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText(COPIED_TEXT);
  // 描画レイヤは同じ図形を複数要素で持つので id で数える。
  await expect.poll(() => shapeIds(page)).toHaveLength(1);
  const [pastedId] = await shapeIds(page);
  expect(pastedId).not.toBe(SHAPE_ID);
  // 別文書でも、コピー範囲内の段落へ向いていた anchor は貼り付け先の段落に付け替わり、
  // 元と同じ相対位置 (段落上端からの距離) に出る。
  const pastedBox = await page.locator(`.overlay-canvas-editor [data-overlay-shape-id="${pastedId}"]`).first().boundingBox();
  const destinationLine = await destination.boundingBox();
  expect(pastedBox && destinationLine).toBeTruthy();
  expect(Math.abs((pastedBox!.y - destinationLine!.y) - sourceOffsetY)).toBeLessThan(2);
});

test("carries inline math through the mixed copy", async ({ page }) => {
  await openEditor(page);
  // 数式段落を丸ごとドラッグ選択してから図形を足す。
  const line = await page.locator(`[data-sigma-doc-id="${MATH_BLOCK_ID}"]`).first().boundingBox();
  if (!line) throw new Error("math paragraph is not visible");
  await page.mouse.click(line.x + 6, line.y + line.height / 2);
  await page.mouse.move(line.x + 2, line.y + line.height / 2);
  await page.mouse.down();
  await page.mouse.move(line.x + line.width - 2, line.y + line.height / 2, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("を含む本文");
  const shape = await page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  if (!shape) throw new Error("shape is not visible");
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(shape.x + shape.width / 2, shape.y + shape.height / 2);
  await page.keyboard.up("ControlOrMeta");
  const mountedShape = await page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first().boundingBox();
  if (!mountedShape) throw new Error("shape disappeared after entering overlay editing");
  await page.mouse.move(mountedShape.x + mountedShape.width + 100, mountedShape.y + mountedShape.height + 100);
  await page.mouse.click(mountedShape.x + mountedShape.width / 2, mountedShape.y + mountedShape.height / 2);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await page.keyboard.press("ControlOrMeta+C");

  const destination = page.locator('[data-sigma-doc-id="p_mixed_filler_3"]').first();
  await clickAtEndOfBlock(page, destination);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(destination).toContainText("を含む本文");
  await expect(destination.locator(".inline-math-node")).toHaveCount(1);
  await expect.poll(async () => (await savedShapes(page)).length).toBe(2);
});
