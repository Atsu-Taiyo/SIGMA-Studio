import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * 未選択の図形は本文を透過する。透過を止めていたのは 2 つあり、どちらか片方だけ直しても本文は
 * 選択できない:
 *   1. `PageCanvasEditor` の capture フェーズの JS ヒットテスト (オーバーレイ編集へハンドオフ)
 *   2. `.overlay-shape { pointer-events: auto }` — プレビュー面の `pointer-events: none` を
 *      図形の DIV が打ち消していたので、押下が本文に届かず選択が始まらなかった
 *
 * ここで見るのは「図形の真上を押しても本文が反応する」ことと、「明示的に選んだ図形は今までどおり
 * 掴める」ことの両方。塗りの有無で挙動が変わらないことも 3 種類の図形で確認する。
 */

const TARGET_BLOCK_ID = "p_passthrough_target";
const SHAPE_ID = "shape_over_body";

type ShapeVariant = "filled" | "transparent" | "stroke";

function createDocument(variant: ShapeVariant = "filled"): SigmaDocument {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_body_pointer_passthrough";
  document.metadata = { ...document.metadata, title: "図形の下の本文選択 E2E" };
  document.content = [
    {
      type: "paragraph",
      id: TARGET_BLOCK_ID,
      children: [{
        type: "text",
        text: "あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよらりるれろ",
      }],
    },
    ...Array.from({ length: 4 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_passthrough_filler_${index}`,
      children: [{ type: "text" as const, text: `図形の下に続く本文 ${index + 1} 行目のテキストです。` }],
    })),
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [variantShape(variant)],
        assets: {},
      },
    },
  };
  return document;
}

function variantShape(variant: ShapeVariant) {
  const anchor = { type: "block" as const, blockId: TARGET_BLOCK_ID, dy: -4 };
  if (variant === "stroke") {
    return {
      id: SHAPE_ID,
      type: "line" as const,
      x: 60,
      y: 120,
      anchor,
      props: {
        // 本文の行を斜めに横切らせる。水平線だと DIV の高さがほぼ 0 で「行に重なる」前提が作れない。
        points: [{ x: 0, y: 0 }, { x: 320, y: 56 }],
        closed: false,
        color: "#111111",
        dash: "solid" as const,
        size: "m" as const,
      },
    };
  }

  return {
    id: SHAPE_ID,
    type: "geo" as const,
    x: 60,
    y: 120,
    anchor,
    props: {
      w: 320,
      h: 64,
      geo: "rectangle" as const,
      // 不透明な図形でも透過することが受入基準なので、既定の塗りは solid にする。
      fill: variant === "filled" ? ("solid" as const) : ("none" as const),
      color: "#1133cc",
      labelColor: "#111111",
      dash: "solid" as const,
      size: "m" as const,
    },
  };
}

async function openEditor(page: Page, variant: ShapeVariant = "filled"): Promise<void> {
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => window.localStorage.clear());
  await installDesktopRuntimeMock(page, createDocument(variant));
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await expect(page.locator(".page-flow .text-flow-editor").first()).toBeVisible();
  await expect(page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first()).toBeVisible();
}

interface ShapeGeometry {
  centerX: number;
  centerY: number;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

async function shapeGeometry(page: Page): Promise<ShapeGeometry> {
  return page.locator(`[data-overlay-shape-id="${SHAPE_ID}"]`).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    };
  });
}

/** 図形が本文の行に本当に重なっているかを確かめる (重なっていなければテストの意味がない)。 */
async function targetLineGeometry(page: Page): Promise<{ left: number; right: number; y: number }> {
  return page.locator(`[data-sigma-doc-id="${TARGET_BLOCK_ID}"]`).first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, y: rect.top + rect.height / 2 };
  });
}

async function selectedText(page: Page): Promise<string> {
  return page.evaluate(() => window.getSelection()?.toString() ?? "");
}

async function clearSelection(page: Page): Promise<void> {
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
}

for (const variant of ["filled", "transparent", "stroke"] as const) {
  test(`drags body text through an unselected ${variant} shape`, async ({ page }) => {
    await openEditor(page, variant);

    const shape = await shapeGeometry(page);
    const line = await targetLineGeometry(page);
    // 図形が本文の行に重なっていることが前提。ずれていたらフィクスチャの不備。
    expect(shape.top).toBeLessThan(line.y);
    expect(shape.bottom).toBeGreaterThan(line.y);

    await clearSelection(page);
    await page.mouse.move(line.left + 6, line.y);
    await page.mouse.down();
    // 図形の中央をまたいでドラッグする。
    await page.mouse.move(shape.centerX, line.y, { steps: 8 });
    await page.mouse.move(Math.min(shape.right + 40, line.right - 4), line.y, { steps: 8 });
    await page.mouse.up();

    await expect.poll(() => selectedText(page)).not.toBe("");
    expect(await selectedText(page)).toContain("あいうえお");
  });
}

test("puts the caret in the body when pressing the border of an unselected shape", async ({ page }) => {
  await openEditor(page);

  const shape = await shapeGeometry(page);
  const line = await targetLineGeometry(page);
  // 枠線の上 (図形の左辺) を押す。
  await page.mouse.click(Math.max(shape.left + 1, line.left + 2), line.y);

  await expect.poll(() => page.evaluate(() => (
    window.document.activeElement?.classList.contains("ProseMirror") ?? false
  ))).toBe(true);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
});

test("selects body text by double clicking under an unselected shape", async ({ page }) => {
  await openEditor(page);

  const shape = await shapeGeometry(page);
  const line = await targetLineGeometry(page);
  // 未フォーカスの本文への最初の押下はキャレットを置くだけ (図形とは無関係な既存の挙動)。
  await page.mouse.click(shape.centerX, line.y);
  await clearSelection(page);
  await page.mouse.dblclick(shape.centerX, line.y);

  await expect.poll(() => selectedText(page)).toContain("あいうえお");
});

test("extends a body selection with Shift-click under an unselected shape", async ({ page }) => {
  await openEditor(page);

  const shape = await shapeGeometry(page);
  const line = await targetLineGeometry(page);
  await clearSelection(page);
  await page.mouse.click(line.left + 6, line.y);
  // `page.mouse.click` は modifiers を取らないので、キーボードで挟む。
  await page.keyboard.down("Shift");
  await page.mouse.click(shape.centerX, line.y);
  await page.keyboard.up("Shift");

  await expect.poll(() => selectedText(page)).not.toBe("");
});

test("still enters shape editing with Ctrl/Cmd-click and moves the shape from there", async ({ page }) => {
  await openEditor(page);

  // 明示操作なので、透過せず従来どおりオーバーレイ編集へ入る。
  const entered = await enterShapeEditing(page);

  const before = await savedShapePosition(page);
  await dragShape(page, entered.centerX, entered.centerY, 70, 20);

  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect.poll(() => savedShapePosition(page)).not.toEqual(before);
});

test("keeps the shape grabbable inside overlay editing and passes through again once dropped", async ({ page }) => {
  await openEditor(page);

  const entered = await enterShapeEditing(page);
  await dragShape(page, entered.centerX, entered.centerY, 70, 20);
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);

  // オーバーレイ編集中は選択中の図形をもう一度掴んでも本文へは抜けない
  // (本文モードでは選択が常に空に戻るので、「選択済みなら図形が受け取る」規約が実際に効くのは
  //  この状態。規約そのものは `body-pointer-routing.test.ts` が固定している)。
  const selected = await shapeGeometry(page);
  const held = await savedShapePosition(page);
  await dragShape(page, selected.centerX, selected.centerY, 0, 24);
  await expect.poll(() => savedShapePosition(page)).not.toEqual(held);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");

  // 図形から離れた本文を押すと選択が落ち、透過に戻る。
  const filler = await page.locator('[data-sigma-doc-id="p_passthrough_filler_3"]').first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.left + 20, y: rect.top + rect.height / 2 };
  });
  await page.mouse.click(filler.x, filler.y);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");

  // 透過に戻ったので、図形の真上を押しても本文にキャレットが立つ。
  const dropped = await shapeGeometry(page);
  await page.mouse.click(dropped.centerX, dropped.centerY);
  await expect.poll(() => page.evaluate(() => (
    window.document.activeElement?.classList.contains("ProseMirror") ?? false
  ))).toBe(true);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "false");
});

/**
 * Ctrl/Cmd-click でオーバーレイ編集へ入り、マウントし直された図形の座標を取り直して返す。
 * 入る前の座標のままドラッグすると、レイヤの入れ替わりで押下が図形から外れる。
 */
async function enterShapeEditing(page: Page): Promise<ShapeGeometry> {
  const shape = await shapeGeometry(page);
  await ctrlClick(page, shape.centerX, shape.centerY);
  await expect(page.locator(".page-mode").first()).toHaveAttribute("data-overlay-editing", "true");
  await expect(page.locator(".overlay-canvas-editor")).toHaveCount(1);
  return shapeGeometry(page);
}

async function dragShape(page: Page, x: number, y: number, dx: number, dy: number): Promise<void> {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

/** `page.mouse.click` は modifiers を受け取らないので、修飾キーは自分で押さえる。 */
async function ctrlClick(page: Page, x: number, y: number): Promise<void> {
  await page.keyboard.down("ControlOrMeta");
  await page.mouse.click(x, y);
  await page.keyboard.up("ControlOrMeta");
}

/** 保存された図形の位置。ブロックアンカー付きなので x/y だけでなく anchor の差分も見る。 */
async function savedShapePosition(page: Page): Promise<string | null> {
  return page.evaluate((shapeId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }
    const saved = JSON.parse(raw) as {
      pageLayout?: {
        overlay?: {
          overlaySnapshot?: {
            shapes?: Array<{ id: string; x: number; y: number; anchor?: { dx?: number; dy?: number } }>;
          };
        };
      };
    };
    const shape = saved.pageLayout?.overlay?.overlaySnapshot?.shapes?.find((item) => item.id === shapeId);
    return shape
      ? `${shape.x}/${shape.y}/${shape.anchor?.dx ?? 0}/${shape.anchor?.dy ?? 0}`
      : null;
  }, SHAPE_ID);
}
