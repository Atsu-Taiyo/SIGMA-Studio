import { expect, test, type Locator, type Page } from "@playwright/test";

import type { SigmaTableSpec } from "@/features/document";
import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

// Seed the persisted document with a figure block-anchored to a known paragraph.
function createAnchoredFigureDocument(anchorBlockId: string): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_reanchor";
  document.content = [
    {
      type: "paragraph",
      id: "p_problem_statement",
      lineHeight: "1.35",
      children: [{ type: "text", text: "複素数平面における図形の問題文です。", fontFamily: "serif" }],
    },
    {
      type: "paragraph",
      id: "p_source_note",
      lineHeight: "1.35",
      children: [{ type: "text", text: "（2022東大実戦）", fontFamily: "serif" }],
    },
    ...Array.from({ length: 8 }, (_, index) => ({
      type: "paragraph" as const,
      id: `p_filler_${index}`,
      lineHeight: "1.35" as const,
      children: [{ type: "text" as const, text: `図形より下に続く本文 ${index + 1}。`, fontFamily: "serif" }],
    })),
    {
      type: "paragraph",
      id: "p_xy_define",
      lineHeight: "1.35",
      children: [{ type: "text", text: "X, Y を定める図形より下の本文です。", fontFamily: "serif" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "fig_reanchor",
            type: "geo",
            x: 120,
            y: 300,
            anchor: { type: "block", blockId: anchorBlockId, dy: 40 },
            props: {
              w: 200,
              h: 120,
              geo: "rectangle",
              fill: "none",
              color: "#1133cc",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
  };
  return document;
}

function createSplitLineAnchoredFigureDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_split_line_anchor";
  document.content = [
    {
      type: "paragraph",
      id: "p_before_split",
      lineHeight: "1.35",
      children: [{ type: "text", text: "アンカーの直前で改行された本文です。", fontFamily: "serif" }],
    },
    {
      type: "paragraph",
      id: "p_after_split",
      lineHeight: "1.35",
      children: [{ type: "text", text: "この行へアンカー行が移動した想定です。", fontFamily: "serif" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "fig_split_line",
            type: "geo",
            x: 120,
            y: 320,
            anchor: { type: "block", blockId: "p_before_split", dx: 40, dy: 180, line: { index: 1, dy: 8 } },
            props: {
              w: 160,
              h: 80,
              geo: "rectangle",
              fill: "none",
              color: "#1133cc",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
  };
  return document;
}

function createAnswerAnchoredTableDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  const table: SigmaTableSpec = {
    version: 1,
    kind: "plain",
    columns: [
      { id: "table_col_a", width: { mode: "fr", value: 1, min: 64 } },
      { id: "table_col_b", width: { mode: "fr", value: 1, min: 64 } },
    ],
    rows: [
      { id: "table_row_header", height: { mode: "auto", min: 34 }, role: "header" },
      { id: "table_row_body", height: { mode: "auto", min: 32 }, role: "body" },
    ],
    cells: [
      {
        id: "cell_a_header",
        rowId: "table_row_header",
        columnId: "table_col_a",
        content: [{ type: "paragraph", id: "cell_text_a_header", children: [{ type: "text", text: "x" }], align: "center" }],
      },
      {
        id: "cell_b_header",
        rowId: "table_row_header",
        columnId: "table_col_b",
        content: [{ type: "paragraph", id: "cell_text_b_header", children: [{ type: "text", text: "f(x)" }], align: "center" }],
      },
      {
        id: "cell_a_body",
        rowId: "table_row_body",
        columnId: "table_col_a",
        content: [{ type: "paragraph", id: "cell_text_a_body", children: [{ type: "text", text: "0" }], align: "center" }],
      },
      {
        id: "cell_b_body",
        rowId: "table_row_body",
        columnId: "table_col_b",
        content: [{ type: "paragraph", id: "cell_text_b_body", children: [{ type: "text", text: "1" }], align: "center" }],
      },
    ],
    grid: {
      borderColor: "#111827",
      borderWidth: 1,
      borderStyle: "solid",
      showOuterBorder: true,
      showInnerBorders: true,
    },
    defaultCellStyle: {
      align: "center",
      verticalAlign: "middle",
      paddingX: 8,
      paddingY: 5,
      color: "#111827",
      fontSize: 15,
      fontWeight: "normal",
    },
  };

  document.docId = "doc_e2e_answer_table_anchor";
  document.content = [
    {
      type: "paragraph",
      id: "p_intro_answer_table",
      lineHeight: "1.35",
      children: [{ type: "text", text: "表を使って増減を確認する問題です。", fontFamily: "serif" }],
    },
    {
      type: "paragraph",
      id: "p_answer",
      lineHeight: "1.35",
      children: [{ type: "text", text: "解答", marks: ["bold"], fontFamily: "serif", fontSize: 24 }],
    },
    {
      type: "paragraph",
      id: "p_answer_body",
      lineHeight: "1.35",
      children: [{ type: "text", text: "よって、次の表を用いる。", fontFamily: "serif" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "table_answer_anchor",
            type: "tableShape",
            x: 240,
            y: 260,
            anchor: { type: "block", blockId: "p_answer", dx: 180, dy: 26, line: { index: 0, dy: 26 } },
            props: {
              w: 240,
              h: 96,
              table: structuredClone(table),
            },
          },
        ],
        assets: {},
      },
    },
  };
  return document;
}

/**
 * A group tall enough to straddle two paragraphs: its top member sits under the first, its bottom
 * member under a paragraph 200px further down. Anchored per member, the two halves bind to
 * different blocks and drift apart on the first reflow; the group is the unit that must hang from
 * one block.
 */
function createGroupedFigureDocument(): SigmaDocument {
  const document = createAnchoredFigureDocument("p_source_note");
  document.docId = "doc_e2e_group_anchor";
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          { id: "grp_figure", type: "group", x: 120, y: 200, props: { w: 200, h: 280 } },
          {
            id: "fig_group_top",
            type: "geo",
            parentId: "grp_figure",
            x: 120,
            y: 200,
            props: {
              w: 200,
              h: 60,
              geo: "rectangle",
              fill: "none",
              color: "#1133cc",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
          {
            id: "fig_group_bottom",
            type: "geo",
            parentId: "grp_figure",
            x: 140,
            y: 420,
            props: {
              w: 180,
              h: 60,
              geo: "rectangle",
              fill: "none",
              color: "#cc3311",
              labelColor: "#111111",
              dash: "solid",
              size: "m",
            },
          },
        ],
        assets: {},
      },
    },
  };
  return document;
}

async function openEditor(page: Page, document: SigmaDocument): Promise<void> {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".page-canvas")).toBeVisible();
}

/**
 * The anchored paragraph is washed in while the figure is merely selected — the rule alone cannot
 * say which of two paragraphs a line apart holds it.
 */
async function expectAnchorTargetCoversBlock(page: Page, blockId: string): Promise<void> {
  const target = page.locator(".overlay-anchor-target");
  await expect(target).toHaveCount(1);
  const targetBox = await target.boundingBox();
  const blockBox = await page.locator(`.page-flow [data-sigma-doc-id="${blockId}"]`).boundingBox();
  expect(targetBox).not.toBeNull();
  expect(blockBox).not.toBeNull();
  expect(Math.abs(targetBox!.y - blockBox!.y)).toBeLessThan(4);
  expect(Math.abs(targetBox!.height - blockBox!.height)).toBeLessThan(4);
}

/** Rendered top of every drawn shape, in document order. */
async function memberTops(page: Page): Promise<number[]> {
  return page.locator(".overlay-shape-geo").evaluateAll((elements) => elements.map((element) => (
    Number.parseFloat((element as HTMLElement).style.top)
  )));
}

/**
 * A body block in the middle of the gap between the group's two members — far enough below the
 * top member's block to leave it where it is, and far enough above the bottom member's to push
 * that one down. Anchored per member, that is exactly the edit that splits the group in half.
 */
async function blockIdBetweenMembers(page: Page): Promise<string> {
  const blockId = await page.evaluate(() => {
    const members = [...window.document.querySelectorAll(".overlay-shape-geo")]
      .map((element) => element.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    if (members.length < 2) {
      return null;
    }
    const blocks = [...window.document.querySelectorAll(".page-flow [data-sigma-doc-id]")]
      .filter((element) => {
        const rect = element.getBoundingClientRect();
        return rect.top > members[0].bottom && rect.bottom < members[members.length - 1].top;
      });
    return blocks[Math.floor(blocks.length / 2)]?.getAttribute("data-sigma-doc-id") ?? null;
  });

  expect(blockId, "メンバーの間に本文ブロックが無い").not.toBeNull();
  return blockId!;
}

async function figureTop(page: Page): Promise<number> {
  return page.locator(".overlay-shape-geo").first().evaluate((element) => (
    Number.parseFloat((element as HTMLElement).style.top)
  ));
}

async function tablePreviewTop(page: Page): Promise<number> {
  return page.locator(".overlay-shape-tableShape").first().evaluate((element) => (
    Number.parseFloat((element as HTMLElement).style.top)
  ));
}

async function placeCaretAtStartOfBlock(page: Page, blockId: string): Promise<void> {
  const placed = await page.evaluate((id) => {
    const block = document.querySelector(`[data-sigma-doc-id="${id}"]`);
    const editor = block?.closest(".ProseMirror");
    if (!block || !(editor instanceof HTMLElement)) {
      return false;
    }

    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    const firstText = walker.nextNode();
    const range = document.createRange();
    if (firstText) {
      range.setStart(firstText, 0);
    } else {
      range.setStart(block, 0);
    }
    range.collapse(true);

    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    editor.focus();
    return true;
  }, blockId);
  expect(placed).toBe(true);
}

test("figure moves up and re-anchors when its anchor block is deleted", async ({ page }) => {
  test.setTimeout(60_000);
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });

  // Anchor to the 2nd content paragraph so it is not the first block.
  await openEditor(page, createAnchoredFigureDocument("p_source_note"));
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  const yBefore = await figureTop(page);

  // Delete the figure's own anchor paragraph: select its text, then remove the
  // now-empty block (merging into the previous line).
  const target = page.locator('.page-flow [data-sigma-doc-id="p_source_note"]');
  await target.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(800);

  // The anchor block is gone; the figure should have re-anchored and moved UP.
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_source_note"]')).toHaveCount(0);
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  const yAfter = await figureTop(page);
  expect(yAfter).toBeLessThan(yBefore - 8);

  expect(consoleErrors).toEqual([]);
});

test("figure does not move when a block below it is deleted", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnchoredFigureDocument("p_source_note"));
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  const yBefore = await figureTop(page);

  // Delete a paragraph that sits well below the figure's anchor.
  const below = page.locator('.page-flow [data-sigma-doc-id="p_xy_define"]');
  await below.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");
  await page.waitForTimeout(800);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_xy_define"]')).toHaveCount(0);
  const yAfter = await figureTop(page);
  expect(Math.abs(yAfter - yBefore)).toBeLessThan(6);
});

test("figure follows an anchored line that moved into the next paragraph after a line break", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createSplitLineAnchoredFigureDocument());
  const figure = page.locator(".overlay-shape-geo").first();
  const beforeBlock = page.locator('.page-flow [data-sigma-doc-id="p_before_split"]');
  const afterBlock = page.locator('.page-flow [data-sigma-doc-id="p_after_split"]');

  await expect(figure).toBeVisible();
  await expect(beforeBlock).toBeVisible();
  await expect(afterBlock).toBeVisible();

  const figureBox = await figure.boundingBox();
  const beforeBox = await beforeBlock.boundingBox();
  const afterBox = await afterBlock.boundingBox();
  expect(figureBox).not.toBeNull();
  expect(beforeBox).not.toBeNull();
  expect(afterBox).not.toBeNull();

  expect(figureBox!.y).toBeGreaterThan(afterBox!.y);
  expect(figureBox!.y - afterBox!.y).toBeLessThan(40);
  expect(figureBox!.y - beforeBox!.y).toBeLessThan(80);
});

test("table follows the answer block when a line is inserted before it", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnswerAnchoredTableDocument());
  const table = page.locator(".overlay-shape-tableShape").first();
  const answer = page.locator('.page-flow [data-sigma-doc-id="p_answer"]');

  await expect(table).toBeVisible();
  await expect(answer).toContainText("解答");
  const yBefore = await tablePreviewTop(page);

  await placeCaretAtStartOfBlock(page, "p_answer");
  await page.keyboard.press("Enter");
  await page.waitForTimeout(800);

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_answer"]')).toContainText("解答");
  const yAfter = await tablePreviewTop(page);
  expect(yAfter).toBeGreaterThan(yBefore + 8);
});

test("selected table shape follows the answer block when a line is inserted before it", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnswerAnchoredTableDocument());
  const previewTable = page.locator(".overlay-shape-tableShape").first();
  await expect(previewTable).toBeVisible();

  // Measure the read-only shape wrapper itself: outside overlay editing the table is drawn by the
  // static renderer, which has no `.overlay-table-shape` element at all (that class belongs to the
  // interactive editor's table). Table cells and boundary controls intentionally consume pointer
  // events before preview handoff, so the wrapper is also the right pointer target.
  const previewBox = await previewTable.boundingBox();
  expect(previewBox).not.toBeNull();
  const selectPoint = { x: previewBox!.x + 30, y: previewBox!.y + 20 };
  await previewTable.dispatchEvent("pointerdown", {
    button: 0,
    buttons: 1,
    clientX: selectPoint.x,
    clientY: selectPoint.y,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  });
  await page.evaluate(({ x, y }) => window.dispatchEvent(new PointerEvent("pointerup", {
    bubbles: true,
    button: 0,
    buttons: 0,
    clientX: x,
    clientY: y,
    isPrimary: true,
    pointerId: 1,
    pointerType: "mouse",
  })), selectPoint);

  const selectedTable = page.locator(".overlay-canvas-editor .overlay-shape-tableShape").first();
  await expect(selectedTable).toHaveClass(/selected/);
  const tableBefore = await selectedTable.boundingBox();
  expect(tableBefore).not.toBeNull();

  await placeCaretAtStartOfBlock(page, "p_answer");
  await page.keyboard.press("Enter");
  await expect(page.locator('.page-flow [data-sigma-doc-id="p_answer"]')).toContainText("解答");

  await expect.poll(async () => {
    const box = await selectedTable.boundingBox();
    return box?.y ?? tableBefore!.y;
  }).toBeGreaterThan(tableBefore!.y + 8);
});

test("selected figure shows a draggable horizontal anchor line and can rebind to another block", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnchoredFigureDocument("p_source_note"));
  const shape = page.locator(".overlay-shape-geo").first();
  await expect(shape).toBeVisible();
  await grabShapeFromBody(page, shape);
  await expect(shape).toHaveClass(/selected/);
  const shapeBefore = await shape.boundingBox();
  expect(shapeBefore).not.toBeNull();

  const anchor = page.locator(".overlay-anchor-handle").first();
  const grip = anchor.locator(".overlay-anchor-grip");
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute("data-anchor-block-id", "p_source_note");
  await expect(anchor).toHaveAttribute("data-anchor-state", "block");
  await grip.hover();
  await expectAnchorTargetCoversBlock(page, "p_source_note");
  await expect(grip.locator("svg")).toHaveClass(/lucide-grip-horizontal/);
  await expect(grip).toHaveText("");
  const anchorBox = await anchor.boundingBox();
  expect(anchorBox).not.toBeNull();
  expect(anchorBox!.width).toBeGreaterThan(100);
  expect(anchorBox!.height).toBeLessThanOrEqual(20);

  const targetBlock = page.locator('.page-flow [data-sigma-doc-id="p_problem_statement"]');
  await expect(targetBlock).toBeVisible();
  const targetBox = await targetBlock.boundingBox();
  expect(targetBox).not.toBeNull();

  await dragHandleTo(page, grip, targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
  await expect(anchor).toHaveAttribute("data-anchor-block-id", "p_problem_statement");
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_reanchor"))
    .toBe("p_problem_statement");

  // Dropping mid-block still snaps the rule to the boundary after the block's
  // text instead of leaving it across the paragraph.
  const ruleBox = await anchor.boundingBox();
  expect(ruleBox).not.toBeNull();
  const ruleY = ruleBox!.y + ruleBox!.height / 2;
  expect(ruleY).toBeGreaterThan(targetBox!.y + targetBox!.height - 3);
  expect(ruleY).toBeLessThan(targetBox!.y + targetBox!.height + 6);
  const shapeAfter = await shape.boundingBox();
  expect(shapeAfter).not.toBeNull();
  expect(Math.abs(shapeAfter!.y - shapeBefore!.y)).toBeLessThan(6);
});

test("a group shows one anchor line and rebinds every member with it", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createGroupedFigureDocument());
  const topMember = page.locator(".overlay-shape-geo").first();
  await expect(topMember).toBeVisible();
  await grabShapeFromBody(page, topMember);

  // 掴んだのはメンバーでも、選択されるのはグループ。アンカー線はグループのぶん 1 本だけ。
  const anchor = page.locator(".overlay-anchor-handle");
  await expect(anchor).toHaveCount(1);
  await expect(anchor).toHaveAttribute("data-anchor-state", "block");
  // 選んだだけで「どの本文と繋がっているか」が見える: グループの箱は必ずアンカー線と同じ高さに
  // 来る (先頭メンバーの直上のブロックにぶら下がるため) ので、引き出し線を出さないと、
  // 段落の端に退避したグリップだけが浮いて対応が読めなくなる。
  await expect(page.locator(".overlay-anchor-leader")).toBeVisible();
  await expectAnchorTargetCoversBlock(page, "p_filler_2");
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_group_bottom"))
    .toBe(await getSavedAnchorBlockId(page, "fig_group_top"));

  const memberTopsBefore = await memberTops(page);
  const targetBlock = page.locator('.page-flow [data-sigma-doc-id="p_problem_statement"]');
  const targetBox = await targetBlock.boundingBox();
  expect(targetBox).not.toBeNull();

  await dragHandleTo(
    page,
    anchor.locator(".overlay-anchor-grip"),
    targetBox!.x + targetBox!.width / 2,
    targetBox!.y + targetBox!.height / 2,
  );

  await expect(anchor).toHaveAttribute("data-anchor-block-id", "p_problem_statement");
  await expect.poll(() => getSavedAnchorBlockId(page, "grp_figure")).toBe("p_problem_statement");
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_group_top")).toBe("p_problem_statement");
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_group_bottom")).toBe("p_problem_statement");
  // 追従先を変えても図は動かない。
  expect(await memberTops(page)).toEqual(memberTopsBefore);
});

test("a grouped figure stays rigid when the text between its members grows", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createGroupedFigureDocument());
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_group_bottom")).not.toBeNull();
  const before = await memberTops(page);

  // メンバーごとにアンカーを選ぶと、ここに行を足した瞬間に下のメンバーだけが押し下げられて
  // グループが割れる。グループ単位で 1 つのブロックに紐づいていれば図は 1px も動かない。
  const between = await blockIdBetweenMembers(page);
  await placeCaretAtStartOfBlock(page, between);
  await page.keyboard.type("メンバーの間に本文を足す。");
  await page.keyboard.press("Enter");

  await expect(page.locator(`.page-flow [data-sigma-doc-id="${between}"]`)).toContainText("メンバーの間に本文を足す。");
  const after = await memberTops(page);
  expect(after.map((top) => Math.round(top))).toEqual(before.map((top) => Math.round(top)));
});

test("a grouped figure follows the text it hangs from, as one piece", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createGroupedFigureDocument());
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_group_top")).not.toBeNull();
  const before = await memberTops(page);

  await placeCaretAtStartOfBlock(page, "p_problem_statement");
  await page.keyboard.type("グループより上に本文を足す。");
  await page.keyboard.press("Enter");

  await expect.poll(async () => (await memberTops(page))[0]).toBeGreaterThan(before[0] + 8);
  const after = await memberTops(page);
  expect(after[1] - before[1]).toBeCloseTo(after[0] - before[0], 1);
});

test("reveals the anchor line and explanation only while the grip is hovered", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnchoredFigureDocument("p_source_note"));
  await grabShapeFromBody(page, page.locator(".overlay-shape-geo").first());

  const grip = page.locator(".overlay-anchor-grip").first();
  await expect(grip).toBeVisible();
  await expect(grip).toHaveText("");
  const handle = page.locator(".overlay-anchor-handle").first();
  const tip = page.getByRole("tooltip").first();
  await expect(handle).toHaveAttribute("aria-describedby", await tip.getAttribute("id") ?? "");
  await expect(tip).toContainText("この線から下の図と繋がっています");
  await expect(tip).toContainText("ドラッグすると繋げる本文を変えられます");
  await expect.poll(() => tip.evaluate((el) => window.getComputedStyle(el).opacity)).toBe("0");
  const rule = page.locator(".overlay-anchor-rule").first();
  await expect.poll(() => rule.evaluate((el) => window.getComputedStyle(el).opacity)).toBe("0");

  await grip.hover();
  await expect.poll(() => rule.evaluate((el) => window.getComputedStyle(el).opacity)).toBe("1");
  await expect.poll(() => tip.evaluate((el) => window.getComputedStyle(el).opacity)).toBe("1");
});

test("an unanchored visible figure attaches to nearby body text without changing body layout", async ({ page }) => {
  test.setTimeout(60_000);

  const document = createAnchoredFigureDocument("p_source_note");
  const seededShape = document.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
  if (seededShape) {
    delete seededShape.anchor;
  }

  await openEditor(page, document);
  const bodyBlock = page.locator('.page-flow [data-sigma-doc-id="p_source_note"]');
  const bodyBefore = await bodyBlock.boundingBox();
  expect(bodyBefore).not.toBeNull();

  await expect.poll(() => getSavedAnchorBlockId(page, "fig_reanchor")).not.toBeNull();
  const persistedAnchorBlockId = await getSavedAnchorBlockId(page, "fig_reanchor");

  const shape = page.locator(".overlay-shape-geo").first();
  await grabShapeFromBody(page, shape);
  const anchor = page.locator(".overlay-anchor-handle").first();
  await expect(anchor).toBeVisible();
  await expect(anchor).toHaveAttribute("data-anchor-block-id", persistedAnchorBlockId!);

  const bodyAfter = await bodyBlock.boundingBox();
  expect(bodyAfter).not.toBeNull();
  expect(Math.abs(bodyAfter!.y - bodyBefore!.y)).toBeLessThan(1);
  expect(Math.abs(bodyAfter!.height - bodyBefore!.height)).toBeLessThan(1);
});

test("an arc keeps its exact page position when it is given an anchor", async ({ page }) => {
  test.setTimeout(60_000);

  // 下に膨らむ浅い弧。保存箱 (楕円全体) の上端は実際のインクより 1 半径ぶん上にあるので、
  // アンカー先の選び方は変わりうる。変わってはいけないのは紙面上の位置のほう。
  const document = createAnchoredFigureDocument("p_source_note");
  const snapshot = document.pageLayout?.overlay?.overlaySnapshot;
  if (snapshot) {
    snapshot.shapes = [{
      id: "fig_reanchor",
      type: "arc",
      x: 120,
      y: 300,
      props: {
        r: 60,
        startAngle: Math.PI / 3,
        endAngle: (Math.PI * 2) / 3,
        color: "#1133cc",
        dash: "solid",
        size: "m",
      },
    }] as typeof snapshot.shapes;
  }

  await openEditor(page, document);
  const arc = page.locator(".overlay-shape-arc").first();
  await expect(arc).toBeVisible();

  await expect.poll(() => getSavedAnchorBlockId(page, "fig_reanchor")).not.toBeNull();

  const position = await arc.evaluate((element) => ({
    left: Number.parseFloat((element as HTMLElement).style.left),
    top: Number.parseFloat((element as HTMLElement).style.top),
  }));
  expect(position).toEqual({ left: 120, top: 300 });
});

test("moving a selected figure automatically repositions its anchor handle", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createAnchoredFigureDocument("p_source_note"));
  const shape = page.locator(".overlay-shape-geo").first();
  await expect(shape).toBeVisible();
  await grabShapeFromBody(page, shape);
  const anchor = page.locator(".overlay-anchor-handle").first();
  await expect(anchor).toHaveAttribute("data-anchor-block-id", "p_source_note");

  const targetBlock = page.locator('.page-flow [data-sigma-doc-id="p_problem_statement"]');
  await expect(targetBlock).toBeVisible();
  const targetBox = await targetBlock.boundingBox();
  expect(targetBox).not.toBeNull();

  await dragHandleTo(page, shape, targetBox!.x + targetBox!.width / 2, targetBox!.y + targetBox!.height / 2);
  await expect(anchor).toHaveAttribute("data-anchor-block-id", "p_problem_statement");
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_reanchor"))
    .toBe("p_problem_statement");
});

async function getSavedAnchorBlockId(page: Page, shapeId: string): Promise<string | null> {
  return page.evaluate((id) => {
    const serialized = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!serialized) {
      return null;
    }
    const document = JSON.parse(serialized);
    const shape = document.pageLayout?.overlay?.overlaySnapshot?.shapes?.find(
      (candidate: { id?: string }) => candidate.id === id,
    );
    return shape?.anchor?.type === "block" ? shape.anchor.blockId : null;
  }, shapeId);
}

async function dragHandleTo(page: Page, handle: Locator, x: number, y: number): Promise<void> {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}
