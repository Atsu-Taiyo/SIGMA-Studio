import { expect, test, type Locator, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { grabShapeFromBody } from "./body-overlay-entry";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

// A figure can be anchored to any block that carries an id in the DOM, which
// includes blocks nested inside a container: list items (markdown lists expand
// into these) and the children of a box block. These specs guard that the page
// layout resolves those anchors too — when it does not, the figure silently
// stops following text reflow.

function createNestedBlockDocument(anchorBlockId: string): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_nested_block_anchor";
  document.content = [
    {
      type: "paragraph",
      id: "p_intro",
      lineHeight: "1.35",
      children: [{ type: "text", text: "次の手順で解きます。", fontFamily: "serif" }],
    },
    {
      type: "list",
      id: "list_steps",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_step_1", children: [{ type: "text", text: "手順その1です。" }] },
        { type: "listItem", id: "li_step_2", children: [{ type: "text", text: "手順その2です。" }] },
        { type: "listItem", id: "li_step_3", children: [{ type: "text", text: "手順その3です。" }] },
      ],
    },
    {
      type: "boxBlock",
      id: "box_note",
      styleId: "fancybox",
      title: [{ type: "text", text: "補足" }],
      blocks: [
        { type: "paragraph", id: "p_in_box", children: [{ type: "text", text: "枠の中の本文です。" }] },
      ],
    },
    {
      type: "paragraph",
      id: "p_tail",
      lineHeight: "1.35",
      children: [{ type: "text", text: "以上より答えが求まります。", fontFamily: "serif" }],
    },
  ];
  document.pageLayout = {
    ...document.pageLayout!,
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [
          {
            id: "fig_nested_anchor",
            type: "geo",
            x: 340,
            y: 240,
            anchor: { type: "block", blockId: anchorBlockId, dx: 200, dy: 10 },
            props: {
              w: 150,
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

async function openEditor(page: Page, document: SigmaDocument): Promise<void> {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".page-canvas")).toBeVisible();
}

async function figureTop(page: Page): Promise<number> {
  return page.locator(".overlay-shape-geo").first().evaluate((element) => (
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

async function expectFigureFollowsNewlineAbove(page: Page, anchorBlockId: string): Promise<void> {
  await openEditor(page, createNestedBlockDocument(anchorBlockId));
  await expect(page.locator(".overlay-shape-geo").first()).toBeVisible();
  const yBefore = await figureTop(page);

  await placeCaretAtStartOfBlock(page, "p_intro");
  await page.keyboard.press("Enter");
  await expect.poll(() => figureTop(page)).toBeGreaterThan(yBefore + 8);
}

test("figure anchored to a list item follows a newline inserted above the list", async ({ page }) => {
  test.setTimeout(60_000);
  await expectFigureFollowsNewlineAbove(page, "li_step_2");
});

test("figure anchored to a whole list follows a newline inserted above the list", async ({ page }) => {
  test.setTimeout(60_000);
  await expectFigureFollowsNewlineAbove(page, "list_steps");
});

test("figure anchored to a block inside a box follows a newline inserted above the box", async ({ page }) => {
  test.setTimeout(60_000);
  await expectFigureFollowsNewlineAbove(page, "p_in_box");
});

test("dragging a figure onto a list anchors it to a list item, which still tracks reflow", async ({ page }) => {
  test.setTimeout(60_000);

  await openEditor(page, createNestedBlockDocument("p_intro"));
  const shape = page.locator(".overlay-shape-geo").first();
  await expect(shape).toBeVisible();
  await grabShapeFromBody(page, shape);
  await expect(shape).toHaveClass(/selected/);

  const item = page.locator('.page-flow [data-sigma-doc-id="li_step_3"]');
  await expect(item).toBeVisible();
  const itemBox = await item.boundingBox();
  expect(itemBox).not.toBeNull();

  // Drop the figure beside the list. The anchor follows the shape's top edge,
  // so which item it lands on depends on the shape height; what matters is that
  // the ordinary drag path really does bind figures to list items.
  await dragTo(page, shape, itemBox!.x + itemBox!.width - 40, itemBox!.y + itemBox!.height / 2);
  await expect.poll(() => getSavedAnchorBlockId(page, "fig_nested_anchor")).toMatch(/^li_step_\d$/);

  // …and from there it must still track reflow.
  const yBefore = await figureTop(page);
  await placeCaretAtStartOfBlock(page, "p_intro");
  await page.keyboard.press("Enter");
  await expect.poll(() => figureTop(page)).toBeGreaterThan(yBefore + 8);
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

async function dragTo(page: Page, handle: Locator, x: number, y: number): Promise<void> {
  const box = await handle.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}
