import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

/**
 * グリップを掴んでブロックを動かす (Notion 風)。
 *
 * ドラッグは実ユーザーのようにフレームを跨いで少しずつ動かす。まとめて投げると 1 フレームに
 * 畳まれ、「掴んでいる間に何が見えるか」(ゴースト・落とし先の線) を観測できない。
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function createDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_block_drag";
  document.metadata = { title: "ブロック移動 e2e" };
  document.comments = [];
  document.content = [
    paragraph("p_a", "段落 A"),
    paragraph("p_b", "段落 B"),
    paragraph("p_c", "段落 C"),
    {
      type: "list",
      id: "list_1",
      listType: "ordered",
      markerStyle: "paren",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "項目 1" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "項目 2" }] },
        { type: "listItem", id: "li_3", children: [{ type: "text", text: "項目 3" }] },
      ],
    },
    {
      type: "boxBlock",
      id: "box_1",
      styleId: "fancybox",
      blocks: [paragraph("p_box_1", "箱の中 1"), paragraph("p_box_2", "箱の中 2")],
    },
    paragraph("p_z", "段落 Z"),
  ];
  return document;
}

async function openDocument(page: Page) {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_z"]')).toBeVisible();
}

function block(page: Page, id: string): Locator {
  return page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
}

/**
 * ブロックの中央にポインタを置いて、そのブロックのグリップを出す。
 *
 * 開いた直後はフォント読み込みと初回のページ割りが続いていて、最初の 1 回のホバーが
 * 描画の取り直しに飲まれることがある。実ユーザーは止まらずに動かすので、出るまで少しずつ
 * 動かして待つ (`expect.poll`)。
 */
async function hoverBlock(page: Page, id: string): Promise<Locator> {
  const target = block(page, id);
  await expect(target).toBeVisible();
  const handle = page.locator(`.page-block-handle[data-block-id="${id}"]`);
  let wiggle = 0;
  await expect.poll(async () => {
    const box = (await target.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2 + (wiggle % 3), box.y + box.height / 2 + (wiggle % 2));
    wiggle += 1;
    return handle.isVisible();
  }, { timeout: 10_000, intervals: [100, 200, 300] }).toBe(true);
  return handle;
}

async function pressHandle(page: Page, handle: Locator): Promise<{ x: number; y: number }> {
  const box = (await handle.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  return { x, y };
}

/** 掴んだまま `to` まで刻んで動かす。離さない。 */
async function dragTo(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, steps = 12) {
  for (let step = 1; step <= steps; step += 1) {
    await page.mouse.move(from.x + ((to.x - from.x) * step) / steps, from.y + ((to.y - from.y) * step) / steps);
    await page.waitForTimeout(16);
  }
}

async function savedContent(page: Page): Promise<SigmaBlock[]> {
  const raw = await page.evaluate(() => window.localStorage.getItem("sigma-studio:e2e-document") ?? "");
  return raw ? (JSON.parse(raw) as SigmaDocument).content : [];
}

async function expectSavedTopIds(page: Page, ids: string[]) {
  await expect.poll(async () => (await savedContent(page)).map((entry) => entry.id), { timeout: 8_000 }).toEqual(ids);
}

/** 紙面上の並び (上から)。 */
async function domOrder(page: Page, ids: string[]): Promise<string[] | null> {
  const boxes = await Promise.all(ids.map((id) => block(page, id).boundingBox()));
  if (boxes.some((box) => box === null)) {
    return null;
  }
  const tops = ids.map((id, index) => ({ id, top: boxes[index]!.y }));
  return tops.sort((a, b) => a.top - b.top).map((entry) => entry.id);
}

test("the grip follows inner rows from the gutter, while the box owns only its top band", async ({ page }) => {
  await openDocument(page);
  await hoverBlock(page, "li_2");
  const inner = (await block(page, "p_box_1").boundingBox())!;
  const box = (await block(page, "box_1").boundingBox())!;

  // 同じ高さの左ガターからも、箱ではなく一番内側の段落へ降りる。
  await page.mouse.move(inner.x - 18, inner.y + inner.height / 2);
  await expect(page.locator('.page-block-handle[data-block-id="p_box_1"]')).toBeVisible();
  await expect(page.locator(".page-block-handle")).toHaveCount(1);

  // 最初の行より上の縁だけは、入れ物そのものを掴む帯。
  await page.mouse.move(box.x + 8, box.y + Math.max(2, (inner.y - box.y) / 2));
  await expect(page.locator('.page-block-handle[data-block-id="box_1"]')).toBeVisible();
  await hoverBlock(page, "p_a");
});

test("dragging a paragraph below another reorders the body, with a ghost and a drop line while dragging", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_a");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "p_c").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height * 0.8 });

  // 掴んでいる間: 写しが追従し、落とし先は横線、元のブロックは薄くなる。本文は動かない。
  await expect(page.locator(".page-block-drag-ghost")).toBeVisible();
  await expect(page.locator('.page-block-drop-line[data-orientation="horizontal"]')).toBeVisible();
  await expect(page.locator(".page-block-drag-source-veil")).toHaveCount(1);
  expect(await domOrder(page, ["p_a", "p_b", "p_c"])).toEqual(["p_a", "p_b", "p_c"]);

  await page.mouse.up();
  await expect(page.locator(".page-block-drag-ghost")).toHaveCount(0);
  await expect(page.locator(".page-block-drop-line")).toHaveCount(0);
  await expect.poll(() => domOrder(page, ["p_a", "p_b", "p_c"])).toEqual(["p_b", "p_c", "p_a"]);
  await expectSavedTopIds(page, ["p_b", "p_c", "p_a", "list_1", "box_1", "p_z"]);
  // メニューは開かない (ドラッグの終わりの click は食う)。
  await expect(page.locator(".page-context-menu")).toHaveCount(0);
});

test("dropping at the right edge of a paragraph makes a two-column section", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_c");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "p_a").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width - 8, y: target.y + target.height / 2 });
  await expect(page.locator('.page-block-drop-line[data-orientation="vertical"]')).toBeVisible();
  await page.mouse.up();

  await expect.poll(async () => {
    const content = await savedContent(page);
    const section = content[0];
    return section?.type === "layoutSection"
      ? {
        columns: section.layout.columnCount,
        starts: section.layout.columnStartIds,
        widths: section.layout.columnWidths,
        children: section.children.map((child) => [child.id, child.pagination?.break === true]),
      }
      : null;
  }, { timeout: 8_000 }).toEqual({
    columns: 2,
    starts: ["p_a", "p_c"],
    widths: [5000, 5000],
    children: [["p_a", false], ["p_c", false]],
  });
  // 紙面でも横に並ぶ。
  const a = (await block(page, "p_a").boundingBox())!;
  const c = (await block(page, "p_c").boundingBox())!;
  expect(Math.abs(a.y - c.y)).toBeLessThan(4);
  expect(c.x).toBeGreaterThan(a.x + a.width - 1);
});

test("a list item dragged out stays a (1)-style item, and the list keeps the rest", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "li_1");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "p_z").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height * 0.8 });
  await page.mouse.up();

  await expect.poll(async () => {
    const content = await savedContent(page);
    const list = content.find((entry) => entry.id === "list_1");
    const tail = content[content.length - 1];
    return {
      listItems: list?.type === "list" ? list.items.map((item) => item.id) : null,
      tail: tail?.type === "list"
        ? { markerStyle: tail.markerStyle, items: tail.items.map((item) => item.id) }
        : tail?.type,
    };
  }, { timeout: 8_000 }).toEqual({ listItems: ["li_2", "li_3"], tail: { markerStyle: "paren", items: ["li_1"] } });
});

test("a paragraph dropped between items splits the list and the numbering continues", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_b");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "li_2").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height * 0.2 });
  await page.mouse.up();

  await expect.poll(async () => {
    const content = await savedContent(page);
    return content.map((entry) => (
      entry.type === "list"
        ? `list:${entry.items.map((item) => item.id).join(",")}:start=${entry.start ?? 1}`
        : entry.id
    ));
  }, { timeout: 8_000 }).toEqual(["p_a", "p_c", "list:li_1:start=1", "p_b", "list:li_2,li_3:start=2", "box_1", "p_z"]);
  // 紙面の番号も続く: 後半の最初の項目が (2)。
  await expect(block(page, "li_2").locator("xpath=..")).toBeVisible();
});

test("Escape cancels the drag and leaves the document alone", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_a");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "p_z").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height * 0.8 });
  await expect(page.locator(".page-block-drag-ghost")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".page-block-drag-ghost")).toHaveCount(0);
  await page.mouse.up();
  await page.waitForTimeout(300);
  expect(await domOrder(page, ["p_a", "p_b", "p_z"])).toEqual(["p_a", "p_b", "p_z"]);
  await expect(page.locator(".page-block-drag-source-veil")).toHaveCount(0);
});

test("clicking the grip without moving still selects the block and opens its menu", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_b");
  await handle.click();
  await expect(page.locator(".page-context-menu")).toBeVisible();
  await expect(page.locator(".page-block-selection-outline")).toHaveCount(1);
});

test("Option+Shift+Arrow moves the block with the caret", async ({ page }) => {
  await openDocument(page);
  await block(page, "p_a").click();
  await page.keyboard.press("End");
  await page.keyboard.press("Alt+Shift+ArrowDown");
  await expect.poll(() => domOrder(page, ["p_a", "p_b", "p_c"])).toEqual(["p_b", "p_a", "p_c"]);
  // キャレットは同じブロックに残る: 続けて打った文字が動かした段落に入る。
  await page.keyboard.type("x");
  await expect(block(page, "p_a")).toHaveText(/段落 Ax$/);
  await page.keyboard.press("Alt+Shift+ArrowUp");
  await expect.poll(() => domOrder(page, ["p_a", "p_b", "p_c"])).toEqual(["p_a", "p_b", "p_c"]);
});

test("a paragraph can be dragged out of a box, which keeps its other paragraph", async ({ page }) => {
  await openDocument(page);
  const handle = await hoverBlock(page, "p_box_1");
  const from = await pressHandle(page, handle);
  const target = (await block(page, "p_a").boundingBox())!;
  await dragTo(page, from, { x: target.x + target.width / 2, y: target.y + target.height * 0.2 });
  await page.mouse.up();
  await expect.poll(async () => {
    const content = await savedContent(page);
    const box = content.find((entry) => entry.id === "box_1");
    return { first: content[0]?.id, box: box?.type === "boxBlock" ? box.blocks.map((entry) => entry.id) : null };
  }, { timeout: 8_000 }).toEqual({ first: "p_box_1", box: ["p_box_2"] });
});
