import { expect, test, type Page } from "@playwright/test";
import type { LayoutSectionNode, SigmaDocument } from "@/features/document";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

function columns(id: string): LayoutSectionNode {
  return {
    type: "layoutSection", id,
    layout: { columnCount: 2, columnGapMm: 8, columnStartIds: [`${id}_left`, `${id}_right`], columnWidths: [6500, 3500] },
    children: [
      { type: "paragraph", id: `${id}_left`, children: [{ type: "text", text: "左の短い本文" }] },
      { type: "paragraph", id: `${id}_right`, children: [{ type: "text", text: "右の長い本文です。".repeat(20) }] },
    ],
  };
}

function seed(): SigmaDocument {
  return {
    version: "2.0", docId: "local_column_parity", metadata: { title: "部分段組の統一" },
    content: [columns("outside"), { type: "boxBlock", id: "box", styleId: "fancybox", blocks: [columns("inside")] }],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

async function open(page: Page) {
  await page.setViewportSize({ width: 1400, height: 1100 });
  await installDesktopRuntimeMock(page, seed());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden" });
  await expect(page.locator('.page-flow [data-sigma-doc-id="inside_left"]').first()).toBeVisible();
}

async function caretId(page: Page) {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode;
    return (node instanceof Element ? node : node?.parentElement)?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id");
  });
}

async function savedDocument(page: Page): Promise<SigmaDocument> {
  return page.evaluate(() => JSON.parse(localStorage.getItem("sigma-studio:e2e-document")!));
}

function sectionIn(doc: SigmaDocument, id: "outside" | "inside"): LayoutSectionNode {
  const node = id === "outside" ? doc.content[0] : doc.content[1].type === "boxBlock" ? doc.content[1].blocks[0] : null;
  if (node?.type !== "layoutSection") throw new Error("missing columns");
  return node;
}

test("outside columns place the caret in the clicked column, including its blank lower area", async ({ page }) => {
  await open(page);
  const section = page.locator('.page-flow [data-layout-section-id="outside"]').first();
  for (const side of ["right", "left"]) {
    await section.locator(`[data-sigma-doc-id="outside_${side}"]`).click({ position: { x: 10, y: 10 } });
    await expect.poll(() => caretId(page)).toBe(`outside_${side}`);
  }
  const left = await section.locator('[data-layout-column-index="0"]').boundingBox();
  expect(left).not.toBeNull();
  await page.mouse.click(left!.x + 20, left!.y + left!.height - 15);
  await expect.poll(() => caretId(page)).toBe("outside_left");
  await page.keyboard.insertText("左だけ追記");
  await expect(section.locator('[data-sigma-doc-id="outside_left"]')).toContainText("左だけ追記");
  await expect(section.locator('[data-sigma-doc-id="outside_right"]')).not.toContainText("左だけ追記");
});

test("box columns use independent grid columns and saved width ratios", async ({ page }) => {
  await open(page);
  for (const id of ["outside", "inside"]) {
    const section = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    const grid = section.locator('.layout-section-independent-columns').first();
    await expect(grid).toBeVisible();
    const cols = grid.locator(':scope > .layout-section-independent-column');
    await expect(cols).toHaveCount(2);
    const a = await cols.nth(0).boundingBox();
    const b = await cols.nth(1).boundingBox();
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(2);
    expect(a!.width / b!.width).toBeCloseTo(6500 / 3500, 1);
    await expect(grid.locator('.layout-section-column-resize-handle')).toHaveCount(1);
  }
});

for (const id of ["outside", "inside"] as const) {
  test(`${id}: resize, cancel, edit and reload preserve the columns`, async ({ page }) => {
    await open(page);
    const section = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    const grid = section.locator('.layout-section-independent-columns').first();
    const handle = grid.locator(':scope > .layout-section-column-resize-handle');
    await handle.scrollIntoViewIfNeeded();
    const before = await grid.evaluate(element => getComputedStyle(element).gridTemplateColumns);
    let rect = (await handle.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 15);
    await page.mouse.down();
    await page.mouse.move(rect.x + rect.width / 2 - 35, rect.y + 15, { steps: 5 });
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns)).toBe(before);
    expect(sectionIn(await savedDocument(page), id).layout.columnWidths).toEqual([6500, 3500]);

    rect = (await handle.boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 15);
    await page.mouse.down();
    await expect(handle).toHaveAttribute("data-dragging", "true");
    await page.mouse.move(rect.x + rect.width / 2 - 45, rect.y + 15, { steps: 5 });
    await expect.poll(() => grid.evaluate(element => getComputedStyle(element).gridTemplateColumns)).not.toBe(before);
    await page.mouse.up();
    await expect.poll(async () => sectionIn(await savedDocument(page), id).layout.columnWidths?.[0]).toBeLessThan(6500);
    const resizedWidths = sectionIn(await savedDocument(page), id).layout.columnWidths;

    const left = grid.locator(':scope > .layout-section-independent-column').nth(0);
    const leftRect = (await left.boundingBox())!;
    await page.mouse.click(leftRect.x + 15, leftRect.y + leftRect.height - 10);
    await expect.poll(() => caretId(page)).toBe(`${id}_left`);
    await page.keyboard.press("End");
    await page.keyboard.press("Enter");
    await page.keyboard.insertText("左列に追加した段落");
    await expect.poll(async () => JSON.stringify(sectionIn(await savedDocument(page), id))).toContain("左列に追加した段落");
    const saved = await savedDocument(page);
    const current = sectionIn(saved, id);
    expect(current.layout.columnStartIds).toEqual([`${id}_left`, `${id}_right`]);
    expect(current.layout.columnWidths).toEqual(resizedWidths);
    await installDesktopRuntimeMock(page, saved);
    await page.reload();
    await expect(page.locator(".startup-splash")).toBeHidden();
    await expect(left).toContainText("左列に追加した段落");
    await expect(grid.locator(':scope > .layout-section-independent-column').nth(1)).not.toContainText("左列に追加した段落");
    expect(sectionIn(await savedDocument(page), id).layout.columnWidths).toEqual(resizedWidths);
  });

  test(`${id}: merging a column keeps both bodies and undo restores the grid`, async ({ page }) => {
    await open(page);
    const section = page.locator(`.page-flow [data-sigma-doc-id="${id}"]`).first();
    const grid = section.locator('.layout-section-independent-columns').first();
    const handle = grid.locator(':scope > .layout-section-column-resize-handle');
    await handle.scrollIntoViewIfNeeded();
    const rect = (await handle.boundingBox())!;
    const first = (await grid.locator(':scope > .layout-section-independent-column').first().boundingBox())!;
    await page.mouse.move(rect.x + rect.width / 2, rect.y + 15);
    await page.mouse.down();
    await page.mouse.move(first.x - 20, rect.y + 15, { steps: 8 });
    await page.mouse.up();
    await expect(section).toHaveCount(0);
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${id}_left"]`).first()).toContainText("左の短い本文");
    await expect(page.locator(`.page-flow [data-sigma-doc-id="${id}_right"]`).first()).toContainText("右の長い本文です。");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(grid).toBeVisible();
    await expect(grid.locator(':scope > .layout-section-independent-column')).toHaveCount(2);
  });
}

for (const count of [3, 4]) {
  test(`${count} columns share widths and click ownership inside and outside a box`, async ({ page }) => {
    const document = seed();
    const widths = count === 3 ? [2000, 3000, 5000] : [1000, 2000, 3000, 4000];
    for (const id of ["outside", "inside"] as const) {
      const section = sectionIn(document, id);
      section.layout = { columnCount: count, columnGapMm: 5, columnWidths: widths, columnStartIds: widths.map((_, index) => `${id}_${index}`) };
      section.children = widths.map((_, index) => ({ type: "paragraph", id: `${id}_${index}`, children: index === 1 ? [] : [{ type: "text", text: `列${index + 1}` }] }));
    }
    await page.setViewportSize({ width: 1400, height: 1100 });
    await installDesktopRuntimeMock(page, document);
    await page.goto("/");
    await expect(page.locator(".startup-splash")).toBeHidden();
    for (const id of ["outside", "inside"] as const) {
      const grid = page.locator(`.page-flow [data-sigma-doc-id="${id}"] .layout-section-independent-columns`).first();
      const columns = grid.locator(':scope > .layout-section-independent-column');
      await expect(columns).toHaveCount(count);
      const boxes = await columns.evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, top: element.getBoundingClientRect().top })));
      const total = boxes.reduce((sum, box) => sum + box.width, 0);
      for (let index = count - 1; index >= 0; index -= 1) {
        expect(boxes[index].width / total).toBeCloseTo(widths[index] / 10000, 2);
        expect(Math.abs(boxes[index].top - boxes[0].top)).toBeLessThan(2);
        await columns.nth(index).locator('p').click({ position: { x: 8, y: 8 } });
        await expect.poll(() => caretId(page)).toBe(`${id}_${index}`);
      }
    }
    await page.screenshot({ path: test.info().outputPath(`columns-${count}.png`) });
  });
}
