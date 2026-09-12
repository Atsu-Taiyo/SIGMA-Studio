import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const WHITEBOARD_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_e2e_whiteboard_selection",
  metadata: { title: "ホワイトボード選択" },
  content: [],
  pageLayout: {
    preset: "whiteboard",
    orientation: "portrait",
    pageSize: { widthMm: 210, heightMm: 297 },
    marginsMm: { top: 0, right: 0, bottom: 0, left: 0 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    overlay: {
      overlaySnapshot: {
        version: 1,
        shapes: [{
          id: "whiteboard_rect",
          type: "geo",
          x: 120,
          y: 120,
          rotation: 0,
          props: {
            w: 160,
            h: 100,
            geo: "rectangle",
            fill: "solid",
            color: "#111111",
            fillColor: "#ffffff",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    },
  },
  outputProfiles: {
    student: {},
    teacher: {},
    answerBook: {},
  },
};

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, WHITEBOARD_DOCUMENT);
});

test("selects a shape after panning, hides anchor handles, and clears on empty whiteboard taps", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  const viewport = page.locator(".whiteboard-page-canvas");
  const viewportBox = await viewport.boundingBox();
  expect(viewportBox).not.toBeNull();

  const zoomControls = page.locator(".whiteboard-zoom-controls");
  const controlsBeforeZoom = await zoomControls.boundingBox();
  expect(controlsBeforeZoom).not.toBeNull();
  await page.locator(".whiteboard-zoom-controls").getByRole("button", { name: "拡大" }).click();
  await expect(page.locator(".whiteboard-zoom-controls output")).toHaveText("110%");
  const viewportAfterZoom = await viewport.boundingBox();
  const controlsAfterZoom = await zoomControls.boundingBox();
  expect(viewportAfterZoom).not.toBeNull();
  expect(controlsAfterZoom).not.toBeNull();
  expect(Math.abs(
    viewportAfterZoom!.x + viewportAfterZoom!.width
      - controlsAfterZoom!.x - controlsAfterZoom!.width,
  )).toBeLessThanOrEqual(32);
  expect(Math.abs(
    viewportAfterZoom!.y + viewportAfterZoom!.height
      - controlsAfterZoom!.y - controlsAfterZoom!.height,
  )).toBeLessThanOrEqual(32);
  expect(controlsAfterZoom!.width).toBeCloseTo(controlsBeforeZoom!.width, 0);

  await page.mouse.move(viewportAfterZoom!.x + 400, viewportAfterZoom!.y + 260);
  await page.mouse.wheel(-120, -80);
  await expect.poll(async () => viewport.evaluate((element) => {
    const style = window.getComputedStyle(element);
    const panX = Number.parseFloat(style.getPropertyValue("--whiteboard-pan-x")) || 0;
    const panY = Number.parseFloat(style.getPropertyValue("--whiteboard-pan-y")) || 0;
    return Math.abs(panX) + Math.abs(panY);
  })).toBeGreaterThan(0);

  await expect(page.locator(".overlay-canvas-editor")).toHaveCount(1);
  await expect(page.locator(".page-overlay-preview")).toHaveCSS("pointer-events", "none");
  const editorShape = page.locator('.overlay-canvas-editor [data-overlay-shape-id="whiteboard_rect"]');
  await expect(editorShape).toBeVisible();
  const editorShapeBox = await editorShape.boundingBox();
  expect(editorShapeBox).not.toBeNull();
  await page.mouse.click(
    editorShapeBox!.x + editorShapeBox!.width / 2,
    editorShapeBox!.y + editorShapeBox!.height / 2,
  );

  await expect(page.locator(".overlay-shape.selected")).toHaveCount(1);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(1);
  await expect(page.locator(".overlay-anchor-handle")).toHaveCount(0);

  await page.mouse.click(viewportBox!.x + 600, viewportBox!.y + 400);

  await expect(page.locator(".overlay-shape.selected")).toHaveCount(0);
  await expect(page.locator(".overlay-selection-box")).toHaveCount(0);
});

test("creates an empty whiteboard from the new-document menu", async ({ page }) => {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.getByText("準備完了")).toBeVisible();
  await expect(page.locator(".startup-splash")).toBeHidden();

  await page.getByRole("button", { name: "新規教材" }).hover();
  await page.getByRole("menuitem", { name: "ホワイトボード" }).click();

  await expect(page.locator(".whiteboard-page-canvas")).toBeVisible();
  await expect(page.locator(".text-flow-editor")).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const value = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!value) return null;
    const document = JSON.parse(value) as SigmaDocument;
    return {
      preset: document.pageLayout?.preset,
      contentLength: document.content.length,
      title: document.metadata.title,
    };
  })).toEqual({
    preset: "whiteboard",
    contentLength: 0,
    title: "無題のホワイトボード",
  });
});

test("ホワイトボードで表ピッカーから可視領域中央に4列3行を挿入する", async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 950 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".startup-splash")).toBeHidden();

  const viewport = page.locator(".whiteboard-page-canvas");
  await page.locator(".whiteboard-zoom-controls").getByRole("button", { name: "拡大" }).click();
  const viewportBeforePan = await viewport.boundingBox();
  expect(viewportBeforePan).not.toBeNull();
  await page.mouse.move(viewportBeforePan!.x + 480, viewportBeforePan!.y + 320);
  await page.mouse.wheel(-180, -120);

  await page.getByRole("tab", { name: "挿入", exact: true }).click();
  await page.locator(".ribbon-body").getByRole("button", { name: "表", exact: true }).click();
  const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(tablePicker).toBeVisible();
  const fourByThree = tablePicker.getByRole("button", { name: "4列 3行の表を挿入", exact: true });
  await fourByThree.hover();
  await expect(tablePicker.locator(".table-insert-grid-size")).toHaveText("4 x 3");
  await page.keyboard.press("Escape");
  await expect(tablePicker).toHaveCount(0);

  await page.getByRole("button", { name: "図形", exact: true }).click();
  await page.getByRole("menu").getByRole("menuitem", { name: "表", exact: true }).click();
  await expect(tablePicker).toBeVisible();
  await tablePicker.getByRole("button", { name: "4列 3行の表を挿入", exact: true }).click();

  const insertedTable = page.locator(".overlay-shape-tableShape").last();
  await expect(insertedTable).toBeVisible();
  await expect(insertedTable.locator("tr")).toHaveCount(3);
  await expect(insertedTable.locator("tr").first().locator("td")).toHaveCount(4);
  const [viewportBox, tableBox] = await Promise.all([viewport.boundingBox(), insertedTable.boundingBox()]);
  expect(viewportBox).not.toBeNull();
  expect(tableBox).not.toBeNull();
  expect(Math.abs(
    tableBox!.x + tableBox!.width * 0.5 - (viewportBox!.x + viewportBox!.width * 0.5),
  )).toBeLessThan(3);
  expect(Math.abs(
    tableBox!.y + tableBox!.height * 0.5 - (viewportBox!.y + viewportBox!.height * 0.5),
  )).toBeLessThan(3);
});
