import { expect, test, type Page } from "@playwright/test";
import { createPlainTableSpec } from "@/components/editor/overlay-canvas/shapes/table";
import type { OverlayShape, SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { createBoxBlock } from "@/lib/box-blocks";

function documentWithShape(type: "tableShape" | "text" | "callout", whiteboard = true): SigmaDocument {
  const table = createPlainTableSpec(2, 2);
  table.cells[0].content = [{ type: "paragraph", id: "cell_text", children: [{ type: "text", text: "前 対象 後" }] }];
  const textProps = {
    w: 260, h: 90, color: "#111111", size: "m" as const,
    blocks: [{ type: "paragraph" as const, id: "shape_text", children: [{ type: "text" as const, text: "前 対象 後" }] }],
  };
  const shape: OverlayShape = type === "tableShape"
    ? { id: "target_shape", type, x: 80, y: 100, rotation: 0, props: { w: 300, h: 140, table } }
    : type === "callout"
      ? { id: "target_shape", type, x: 80, y: 100, rotation: 0, props: {
          ...textProps, radius: 14, dash: "solid", strokeWidth: "m",
          tail: { baseStart: { x: 60, y: 90 }, baseEnd: { x: 100, y: 90 }, tip: { x: 40, y: 110 } },
        } }
      : { id: "target_shape", type, x: 80, y: 100, rotation: 0, props: textProps };
  return {
    version: "2.0", docId: "nested_editing", metadata: { title: "入れ子編集" },
    content: [{ type: "paragraph", id: "body", children: [{ type: "text", text: "本文はそのまま" }] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: whiteboard ? "whiteboard" : "A4", orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 15, right: 15, bottom: 15, left: 15 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
      overlay: { overlaySnapshot: { version: 1, shapes: [shape], assets: {} } },
    },
  };
}

async function readSaved(page: Page): Promise<SigmaDocument> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!));
}

for (const type of ["tableShape", "text", "callout"] as const) {
  test(`formats a selected run inside ${type} using the toolbar and keeps it after reopening`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    await installDesktopRuntimeMock(page, documentWithShape(type));
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    const shape = page.locator('.overlay-shape[data-overlay-shape-id="target_shape"]');
    await expect(shape).toBeVisible();
    const bounds = await shape.boundingBox();
    await page.mouse.dblclick(bounds!.x + 20, bounds!.y + Math.min(10, bounds!.height / 2));
    const editor = shape.locator(type === "tableShape" ? ".overlay-table-shape-content" : ".overlay-text-shape-content").first();
    await editor.click();
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    await page.keyboard.press("Shift+ArrowRight");
    const sizeButton = page.getByRole("button", { name: "フォントサイズ", exact: true });
    await expect(sizeButton).toBeEnabled();
    await sizeButton.click();
    await page.getByRole("spinbutton", { name: "サイズ (pt)" }).fill("24");
    await page.getByRole("spinbutton", { name: "サイズ (pt)" }).press("Enter");
    await expect(editor.locator('span[style*="font-size:"]').filter({ hasText: "対象" })).toHaveCSS("font-size", "32px");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("対象");
    await expect.poll(async () => {
      const saved = await readSaved(page);
      const stored = saved.pageLayout?.overlay?.overlaySnapshot?.shapes[0];
      return stored?.type === "tableShape" ? stored.props.table.cells[0].content[0]
        : stored?.type === "text" || stored?.type === "callout" ? stored.props.blocks[0] : null;
    }).toMatchObject({ children: [
      { type: "text", text: "前 " }, { type: "text", text: "対象", fontSize: 24 }, { type: "text", text: " 後" },
    ] });
    const saved = await readSaved(page);
    expect(saved.content[0]).toMatchObject({ children: [{ type: "text", text: "本文はそのまま" }] });
    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(shape.locator('span[style*="font-size:"]').filter({ hasText: "対象" })).toHaveCSS("font-size", "32px");
  });
}

for (const whiteboard of [true, false]) {
  test(`keeps a pasted table after releasing Cmd+V and reopening (${whiteboard ? "whiteboard" : "paper"})`, async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.setViewportSize({ width: 1400, height: 1000 });
    await installDesktopRuntimeMock(page, documentWithShape("tableShape", whiteboard), { platform: "darwin" });
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    const source = page.locator('.overlay-shape[data-overlay-shape-id="target_shape"]');
    await expect(source).toBeVisible();
    const bounds = await source.boundingBox();
    if (!whiteboard) await page.keyboard.down("Meta");
    await page.mouse.click(bounds!.x + 10, bounds!.y + 10);
    if (!whiteboard) await page.keyboard.up("Meta");
    await expect(source).toHaveClass(/selected/);
    await page.keyboard.press("Meta+c");
    await page.keyboard.down("Meta");
    await page.keyboard.down("v");
    const tables = page.locator("main table").filter({ hasText: "前 対象 後" });
    await expect(tables).toHaveCount(2);
    await page.keyboard.up("v");
    await page.keyboard.up("Meta");
    await expect(tables).toHaveCount(2);
    await expect.poll(async () => (await readSaved(page)).pageLayout?.overlay?.overlaySnapshot?.shapes.length).toBe(2);
    await page.waitForTimeout(600);
    await expect(tables).toHaveCount(2);
    const saved = await readSaved(page);
    const copied = saved.pageLayout!.overlay!.overlaySnapshot!.shapes;
    expect(copied[0].id).not.toBe(copied[1].id);
    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(tables).toHaveCount(2);
  });
}

test("keeps a table pasted from the body when the temporary Cmd drawing mode ends", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, documentWithShape("tableShape", false), { platform: "darwin" });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  const source = page.locator('.overlay-shape[data-overlay-shape-id="target_shape"]');
  await expect(source).toBeVisible();
  const bounds = await source.boundingBox();
  await page.keyboard.down("Meta");
  await page.mouse.click(bounds!.x + 10, bounds!.y + 10);
  await page.keyboard.up("Meta");
  await expect(source).toHaveClass(/selected/);
  await page.keyboard.press("Meta+c");
  const body = page.locator('.ProseMirror [data-sigma-doc-id="body"]');
  const bodyBounds = await body.boundingBox();
  await page.mouse.click(bodyBounds!.x + 15, bodyBounds!.y + bodyBounds!.height / 2);
  await expect.poll(() => body.evaluate(element => element.closest("[contenteditable=true]") === document.activeElement)).toBe(true);
  await page.keyboard.press("Meta+v");
  const tables = page.locator("main table").filter({ hasText: "前 対象 後" });
  await expect(tables).toHaveCount(2);
  await expect.poll(async () => (await readSaved(page)).pageLayout?.overlay?.overlaySnapshot?.shapes.length).toBe(2);
  await page.waitForTimeout(800);
  await expect(tables).toHaveCount(2);
  for (const table of await tables.all()) await expect(table).toBeVisible();
  await installDesktopRuntimeMock(page, await readSaved(page));
  await page.reload();
  await expect(tables).toHaveCount(2);
});

function documentWithBox(columnCount = 1): SigmaDocument {
  const document = documentWithShape("tableShape", false);
  document.pageLayout!.overlay = undefined;
  document.pageLayout!.flow = { type: "columns", columnCount, columnGapMm: 8 };
  document.content = [{
    ...createBoxBlock("itembox"), id: "outer", title: [{ type: "text", text: "外枠" }],
    blocks: [
      { type: "paragraph", id: "before", children: [{ type: "text", text: "前半の文章" }] },
      { ...createBoxBlock("itembox"), id: "inner", title: [{ type: "text", text: "内枠" }], blocks: [
        { type: "paragraph", id: "inner_text", children: [{ type: "text", text: "内側の文章" }] },
      ] },
      { type: "paragraph", id: "trigger", children: [] },
    ],
  }];
  return document;
}

test("opens the inner box actions and inserts another box and a problem without escaping the outer box", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, documentWithBox());
  await page.goto("/");
  const inner = page.locator('.ProseMirror [data-sigma-doc-id="inner"]');
  await inner.hover();
  await inner.locator(':scope > .sigma-doc-box-action-button').click();
  await expect(page.locator(".box-action-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await inner.locator(':scope > .sigma-doc-box-action-button').focus();
  await page.keyboard.press("Enter");
  await expect(page.locator(".box-action-dialog")).toBeVisible();
  await page.keyboard.press("Escape");
  await page.locator('.ProseMirror [data-sigma-doc-id="trigger"]').click();
  await page.keyboard.type("/problem");
  await page.keyboard.press("Enter");
  await expect(page.locator('.ProseMirror [data-sigma-doc-id="outer"] [data-sigma-doc-type="problem"]')).toHaveCount(1);
  await expect(page.locator('.ProseMirror [data-sigma-doc-type="problem"] [data-problem-number="1"]')).toBeVisible();
  await expect.poll(async () => {
    const outer = (await readSaved(page)).content[0];
    return outer.type === "boxBlock" ? outer.blocks.map(block => block.type) : [];
  }).toContain("problem");
  await page.keyboard.type("/itembox");
  await page.keyboard.press("Enter");
  await expect.poll(async () => {
    const outer = (await readSaved(page)).content[0];
    return outer.type === "boxBlock" ? outer.blocks.filter(block => block.type === "boxBlock").length : 0;
  }).toBe(2);
  const saved = await readSaved(page);
  expect(saved.content).toHaveLength(1);
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator('.ProseMirror [data-sigma-doc-id="outer"] [data-sigma-doc-type="problem"]')).toHaveCount(1);
});

test("renders nested problem numbers, frames and reserved answer space from saved settings", async ({ page }) => {
  const document = documentWithBox();
  const outer = document.content[0];
  if (outer.type !== "boxBlock") throw new Error("expected box");
  outer.blocks.push({
    type: "problem", id: "styled_problem", tags: [], numbering: { value: 7, fontSize: 18 },
    frame: { enabled: true, styleId: "doublebox" }, areaLayout: { solution: { minHeightMm: 20 } },
    lead: [], prompt: [{ type: "paragraph", id: "styled_prompt", children: [{ type: "text", text: "枠の中の問題" }] }],
    hints: [], solution: [],
  });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  const problem = page.locator('.ProseMirror [data-sigma-doc-id="styled_problem"]');
  const number = problem.locator('[data-problem-number="7"]');
  await expect(number).toBeVisible();
  expect(await number.evaluate(element => getComputedStyle(element, "::before").fontSize)).toBe("24px");
  await expect(problem.locator('[data-problem-area="prompt"]')).toHaveClass(/with-frame.*first-frame-area/);
  await expect(problem.locator('[data-problem-area="solution"]')).toHaveCSS("min-height", /75\.59/);
  await expect(problem.locator('[data-problem-area="solution"]')).toHaveClass(/last-frame-area/);
  await problem.locator('[data-sigma-doc-id="styled_prompt"]').click();
  await page.keyboard.press("End");
  await page.keyboard.type(" edited");
  await expect.poll(async () => JSON.stringify((await readSaved(page)).content)).toContain("edited");
  await installDesktopRuntimeMock(page, await readSaved(page));
  await page.reload();
  await expect(number).toBeVisible();
  await expect(problem.locator('[data-problem-area="solution"]')).toHaveCSS("min-height", /75\.59/);
});

test("inserts a problem from the top menu inside the selected box and continues typing there", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, documentWithBox());
  await page.goto("/");
  await page.locator('.ProseMirror [data-sigma-doc-id="trigger"]').click();
  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menuitem", { name: "問題", exact: true }).click();
  await expect(page.locator('.ProseMirror [data-sigma-doc-id="outer"] [data-sigma-doc-type="problem"]')).toHaveCount(1);
  await page.keyboard.insertText("メニュー挿入の続き");
  await expect.poll(async () => JSON.stringify((await readSaved(page)).content)).toContain("メニュー挿入の続き");
  const saved = await readSaved(page);
  expect(saved.content).toHaveLength(1);
  const outer = saved.content[0];
  expect(outer.type === "boxBlock" && outer.blocks.at(-1)).toMatchObject({ type: "paragraph", children: [{ type: "text", text: "メニュー挿入の続き" }] });
  await installDesktopRuntimeMock(page, saved);
  await page.reload();
  await expect(page.locator('.ProseMirror [data-sigma-doc-id="outer"]')).toContainText("メニュー挿入の続き");
});

for (const columnCount of [1, 2]) {
  test(`hides new breaks but can remove a saved box break in ${columnCount} column flow`, async ({ page }) => {
    await page.setViewportSize({ width: 1400, height: 1000 });
    const saved = documentWithBox(columnCount);
    const box = saved.content[0];
    if (box.type !== "boxBlock") throw new Error("missing box");
    box.blocks[1] = { ...box.blocks[1], pagination: { break: true } };
    await installDesktopRuntimeMock(page, saved);
    await page.goto("/");
    const first = page.locator('.ProseMirror [data-sigma-doc-id="before"]').first();
    await first.click({ button: "right" });
    await expect(page.getByRole("menuitem", { name: "改ページを挿入", exact: true })).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: "改段を挿入", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    const fragments = page.locator('[data-box-source-id="outer"]');
    await expect(fragments).toHaveCount(1);
    const fragmentBounds = await fragments.boundingBox();
    const firstBounds = await first.boundingBox();
    if (columnCount === 1) expect(fragmentBounds!.y - firstBounds!.y).toBeGreaterThan(700);
    else expect(fragmentBounds!.x - firstBounds!.x).toBeGreaterThan(200);
    await installDesktopRuntimeMock(page, await readSaved(page));
    await page.reload();
    await expect(fragments).toHaveCount(1);
    const innerText = fragments.locator('[data-sigma-doc-id="inner_text"]').first();
    await innerText.click({ button: "right" });
    await page.getByRole("menuitem", { name: columnCount === 1 ? "改ページを解除" : "改段を解除", exact: true }).click();
    await expect.poll(async () => {
      const outer = (await readSaved(page)).content[0];
      return outer.type === "boxBlock" ? outer.blocks.some(block => block.pagination?.break) : false;
    }).toBe(false);
    await expect(fragments).toHaveCount(0);
    await installDesktopRuntimeMock(page, await readSaved(page));
    await page.reload();
    await expect(fragments).toHaveCount(0);
  });
}
