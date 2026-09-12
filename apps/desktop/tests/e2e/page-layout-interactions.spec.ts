import { expect, test } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, createPageLayoutInteractionsDocument());
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".page-canvas", { timeout: 10_000 });
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
});

test("header and horizontal margins are edited from page double clicks", async ({ page }) => {
  await expect(page.locator(".page-interaction-toggle")).toHaveCount(0);
  await expect(page.locator(".mode-toggle-button")).toHaveCount(0);

  const canvasBox = await page.locator(".page-canvas").boundingBox();
  expect(canvasBox).not.toBeNull();

  await page.mouse.dblclick(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + 42);
  await expect(page.locator(".page-running-direct-editor.header")).toBeVisible();
  await expect(page.locator(".page-layout-mode-chip")).toContainText("ヘッダー編集中");

  const headerBand = page.locator(".page-running-editor-band.header.editing");
  const headerEdge = page.locator(".page-running-editor-band.header.editing .page-running-edge.end");
  const headerBefore = await headerBand.boundingBox();
  const headerEdgeBox = await headerEdge.boundingBox();
  expect(headerBefore).not.toBeNull();
  expect(headerEdgeBox).not.toBeNull();

  await page.mouse.move(headerEdgeBox!.x + headerEdgeBox!.width / 2, headerEdgeBox!.y + headerEdgeBox!.height / 2);
  await page.mouse.down();
  await page.mouse.move(headerEdgeBox!.x + headerEdgeBox!.width / 2, headerEdgeBox!.y + headerEdgeBox!.height / 2 + 56, { steps: 5 });
  await page.mouse.up();

  await expect.poll(async () => (await headerBand.boundingBox())?.height ?? 0).toBeGreaterThan(headerBefore!.height + 20);

  const headerEditor = page.locator(".page-running-direct-editor.header .text-flow-editor");
  const selectAllShortcut = process.platform === "darwin" ? "Meta+A" : "Control+A";
  await headerEditor.press(selectAllShortcut);
  await page.keyboard.insertText("ヘッダー1");
  for (const line of ["ヘッダー2", "ヘッダー3", "ヘッダー4", "ヘッダー5", "ヘッダー6"]) {
    await page.keyboard.press("Enter");
    await page.keyboard.insertText(line);
  }
  await expect.poll(async () => (await headerBand.boundingBox())?.height ?? 0).toBeGreaterThan(headerBefore!.height + 60);
  const textExpandedHeaderHeight = (await headerBand.boundingBox())?.height ?? 0;

  await headerEditor.press(selectAllShortcut);
  await page.keyboard.insertText("ヘッダー1");
  await expect.poll(async () => (await headerBand.boundingBox())?.height ?? 0).toBeLessThan(textExpandedHeaderHeight - 20);

  await page.mouse.click(canvasBox!.x + canvasBox!.width / 2, canvasBox!.y + 190);
  await expect(page.locator(".page-running-direct-editor.header")).toHaveCount(0);
  await expect(page.locator(".page-layout-mode-chip")).toHaveCount(0);

  await page.mouse.dblclick(canvasBox!.x + 24, canvasBox!.y + 210);
  await expect(page.locator(".page-margin-ruler")).toBeVisible();

  const leftMarginLabel = page.locator(".page-margin-ruler-handle.left span");
  const before = await leftMarginLabel.textContent();
  const handleBox = await page.locator(".page-margin-ruler-handle.left").boundingBox();
  expect(handleBox).not.toBeNull();

  await page.mouse.move(handleBox!.x + handleBox!.width / 2, handleBox!.y + handleBox!.height - 4);
  await page.mouse.down();
  await page.mouse.move(handleBox!.x + handleBox!.width / 2 + 72, handleBox!.y + handleBox!.height - 4, { steps: 5 });
  await page.mouse.up();

  await expect(leftMarginLabel).not.toHaveText(before ?? "");
});

function createPageLayoutInteractionsDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_page_layout_interactions";
  document.metadata = {
    ...document.metadata,
    title: "ページ配置操作 E2E",
  };
  return document;
}
