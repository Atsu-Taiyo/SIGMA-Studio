import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { installDocumentTabMock } from "./document-tab-mock";

/**
 * A new shape starts from the style the author last used.
 *
 * The style is kept outside the document on purpose — undo restores shapes, never the defaults —
 * and in `localStorage` rather than in React state, so it also survives a tab switch and a reload.
 * These tests drive the real toolbar and then read the saved SigmaDoc, so they cover both what is
 * drawn and what is stored.
 */

const STORAGE_KEY = "sigma-studio:overlay-shape-style-defaults";

function emptyOverlayDocument(): SigmaDocument {
  return {
    ...sampleDocument,
    pageLayout: {
      ...sampleDocument.pageLayout,
      overlay: {
        ...sampleDocument.pageLayout?.overlay,
        overlaySnapshot: { version: 1, shapes: [], assets: {} },
      },
    },
  } as SigmaDocument;
}

async function open(page: Page) {
  // The runtime mock wipes storage on every load so each test starts clean; the remembered style
  // has to opt out, or the reload test would be checking the harness rather than the feature.
  await installDesktopRuntimeMock(page, emptyOverlayDocument(), { preserveStorageKeys: [STORAGE_KEY] });
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
}

async function chooseLineTool(page: Page, label: string) {
  await page.getByRole("button", { name: "線", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
}

async function chooseShapeTool(page: Page, label: string) {
  await page.getByRole("button", { name: "図形", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: label, exact: true }).click();
}

async function dragInsert(page: Page) {
  const surface = page.locator(".overlay-canvas-editor.inserting").first();
  await expect(surface).toBeVisible();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  // One shape per row, well clear of the previous one: a drag that starts on an existing shape's
  // chrome is swallowed, and the failure then looks like "the style was not inherited".
  const drawn = await page.locator(".overlay-shape[data-overlay-shape-id]").count();
  const x = box!.x + 100;
  const y = box!.y + 120 + drawn * 130;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 120, y + 60, { steps: 8 });
  await page.mouse.up();
  await expect(page.locator(".overlay-shape[data-overlay-shape-id]")).toHaveCount(drawn + 1);
  // The toolbar only applies to a selection, and selection lands a beat after the shape does. Every
  // style click below would otherwise be a silent no-op.
  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
}

async function chooseFromToolbarMenu(page: Page, buttonName: string, itemName: string) {
  const button = page.getByRole("button", { name: new RegExp(`^${buttonName}`) }).first();
  await expect(button).toBeEnabled();
  await button.click();
  const menu = page.getByRole("menu");
  await menu.getByRole("menuitemradio", { name: itemName, exact: true }).click();
  await expect(menu).toBeHidden();
}

async function pickStrokeColour(page: Page, swatch: string) {
  const button = page.getByRole("button", { name: "枠線", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  const popover = page.locator(".color-popover");
  await expect(popover).toBeVisible();
  await popover.getByTitle(swatch).click();
  await expect(popover).toBeHidden();
}

type SavedShape = { type: string; props: Record<string, unknown> };

async function savedShapes(page: Page): Promise<SavedShape[]> {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("sigma-studio:flush-overlay-changes")));
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  });
}

/**
 * The document is saved on a debounce, so a single read races the last insertion. Poll until the
 * expected number of shapes has landed, then assert on them.
 */
async function savedShapesWhenSettled(page: Page, count: number): Promise<SavedShape[]> {
  await expect.poll(async () => (await savedShapes(page)).length, { timeout: 15_000 }).toBe(count);
  return savedShapes(page);
}

async function rememberedStyle(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  }, STORAGE_KEY);
}

test("carries the line width and colour to the next line", async ({ page }) => {
  await open(page);

  await chooseLineTool(page, "線");
  await dragInsert(page);
  // Asserted between the clicks, not only at the end: the toolbar carries one style request at a
  // time, so two menu picks in the same tick would leave the second one holding the slot.
  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });
  await chooseFromToolbarMenu(page, "線種", "破線");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ dash: "dashed" });
  await pickStrokeColour(page, "#e60000");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ color: "#e60000" });

  await chooseLineTool(page, "線");
  await dragInsert(page);

  const shapes = await savedShapesWhenSettled(page, 2);
  expect(shapes[1].props).toMatchObject({ size: "xl", dash: "dashed", color: "#e60000" });
});

test("carries the stroke across the line and arrow tools", async ({ page }) => {
  await open(page);

  await chooseLineTool(page, "線");
  await dragInsert(page);
  await chooseFromToolbarMenu(page, "線幅", "太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "l" });
  await pickStrokeColour(page, "#00b853");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ color: "#00b853" });

  await chooseLineTool(page, "矢印");
  await dragInsert(page);
  await chooseLineTool(page, "線");
  await dragInsert(page);

  const shapes = await savedShapesWhenSettled(page, 3);
  expect(shapes.map((shape) => shape.type)).toEqual(["line", "arrow", "line"]);
  for (const shape of shapes.slice(1)) {
    expect(shape.props).toMatchObject({ size: "l", color: "#00b853" });
  }
});

test("carries only what two shape families have in common", async ({ page }) => {
  await open(page);

  await chooseLineTool(page, "矢印");
  await dragInsert(page);
  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });
  await pickStrokeColour(page, "#3b48ff");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ color: "#3b48ff" });

  await chooseShapeTool(page, "四角形");
  await dragInsert(page);

  const [arrow, rectangle] = await savedShapesWhenSettled(page, 2);
  // The stroke follows; the arrow's endpoint decoration has no meaning on a rectangle, and must not
  // follow it back onto the next line either.
  expect(rectangle.props).toMatchObject({ size: "xl", color: "#3b48ff" });
  expect(arrow.props).toMatchObject({ arrowheadEnd: "arrow" });

  await chooseLineTool(page, "線");
  await dragInsert(page);
  const [, , line] = await savedShapesWhenSettled(page, 3);
  // The arrow tool always gives itself a head; that floor is the arrow's, not the author's choice.
  expect(line.props).toMatchObject({ arrowheadEnd: "none", size: "xl", color: "#3b48ff" });
});

test("never carries position, size or rotation", async ({ page }) => {
  await open(page);

  await chooseShapeTool(page, "四角形");
  await dragInsert(page);
  await chooseShapeTool(page, "四角形");
  await dragInsert(page);

  const [first, second] = await savedShapesWhenSettled(page, 2);
  expect((second as unknown as { y: number }).y).not.toBe((first as unknown as { y: number }).y);
  // Drawing alone teaches nothing at all: only a toolbar choice does. That is what keeps a shape's
  // own designed look (and its geometry) out of the next insertion.
  expect(Object.keys((await rememberedStyle(page)) ?? {})).toEqual([]);

  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => Object.keys((await rememberedStyle(page)) ?? {}).sort())
    .toEqual(["size"]);
});

test("does not roll the defaults back with an undo", async ({ page }) => {
  await open(page);

  await chooseLineTool(page, "線");
  await dragInsert(page);
  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });

  // Undo restores the document. The defaults are not part of it.
  await page.keyboard.press("ControlOrMeta+KeyZ");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });

  await chooseLineTool(page, "線");
  await dragInsert(page);
  const shapes = await savedShapesWhenSettled(page, 1);
  expect(shapes[shapes.length - 1].props).toMatchObject({ size: "xl" });
});

test("keeps the defaults across a reload, which is what a restart looks like", async ({ page }) => {
  await open(page);

  await chooseLineTool(page, "線");
  await dragInsert(page);
  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });
  await pickStrokeColour(page, "#7a3bff");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl", color: "#7a3bff" });

  // The runtime mock serves the original document again after a reload, so the page comes back
  // with no shapes — which is exactly the interesting case: the style has to come from storage.
  await page.reload();
  await expect(page.locator(".startup-splash")).toBeHidden();
  expect(await rememberedStyle(page)).toMatchObject({ size: "xl", color: "#7a3bff" });

  await chooseLineTool(page, "線");
  await dragInsert(page);
  const shapes = await savedShapesWhenSettled(page, 1);
  expect(shapes[0].props).toMatchObject({ size: "xl", color: "#7a3bff" });
});

test("keeps the defaults when the author switches material tabs", async ({ page }) => {
  // A tab switch unmounts the canvas, so the style has to live outside it. Tabs are React state in
  // one renderer, which is what `installDocumentTabMock` reproduces.
  await installDocumentTabMock(page, emptyOverlayDocument(), emptyOverlayDocument());
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.getByLabel("教材タイトル")).toBeVisible();

  await chooseLineTool(page, "線");
  await dragInsert(page);
  await chooseFromToolbarMenu(page, "線幅", "極太");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ size: "xl" });
  await pickStrokeColour(page, "#00b853");
  await expect.poll(async () => rememberedStyle(page)).toMatchObject({ color: "#00b853" });

  await page.getByLabel("教材タイトル").fill("教材A");
  await page.getByRole("button", { name: "新規教材", exact: true }).click();
  await expect(page.locator(".document-tab")).toHaveCount(2);
  expect(await rememberedStyle(page)).toMatchObject({ size: "xl", color: "#00b853" });

  await chooseLineTool(page, "線");
  const drawnBefore = await page.locator(".overlay-shape[data-overlay-shape-id]").count();
  await dragInsert(page);

  // Read the drawn line rather than the saved file: the tab mock keeps each material in its own
  // record, so the shared "last saved document" key says nothing about the tab in front of us.
  const painted = await page.locator(".overlay-shape-line").nth(drawnBefore).locator(".overlay-vector-svg").evaluate((node) => {
    const style = window.getComputedStyle(node);
    return { strokeWidth: style.strokeWidth, color: style.color };
  });
  expect(painted).toEqual({ strokeWidth: "5px", color: "rgb(0, 184, 83)" });
});
