import { expect, test } from "@playwright/test";

import { sampleDocument } from "@/lib/sample-document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { expectUiSelectValue, selectUiOption } from "./ui-select";

test.beforeEach(async ({ page }) => {
  await installDesktopRuntimeMock(page, sampleDocument);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.goto("/");
  await page.waitForSelector(".text-flow-editor", { timeout: 5_000 });
});

test("search dialog opens fully inside the viewport (not clipped)", async ({ page }) => {
  await page.getByRole("button", { name: "検索置換" }).first().click();

  const findWidget = page.locator(".find-widget");
  await expect(findWidget).toBeVisible();

  const box = await findWidget.boundingBox();
  const viewport = page.viewportSize()!;
  expect(box).not.toBeNull();
  // The whole widget must sit within the viewport on every side.
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);

  // Closes when clicking outside.
  await page.mouse.click(viewport.width / 2, viewport.height - 40);
  await expect(findWidget).toHaveCount(0);
});

test("text color button is not stuck in the selected state", async ({ page }) => {
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  const paragraph = page.locator(".text-flow-editor p[data-sigma-doc-id]").filter({ hasText: /\S/ }).first();
  await expect(paragraph).toBeVisible();
  await paragraph.evaluate((element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = walker.nextNode();
    if (!text || !text.textContent) {
      throw new Error("selectable paragraph text was not found");
    }
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(4, text.textContent.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  const colorButton = page.getByRole("button", { name: "文字色" });
  await expect(colorButton).toBeVisible();
  await expect(colorButton).toBeEnabled();
  await expect(colorButton).not.toHaveClass(/active/);

  // Open the palette and pick a color; the popover should be portaled to <body>.
  await colorButton.click();
  const palette = page.locator(".color-popover .color-palette");
  await expect(palette).toBeVisible();
  await palette.locator(".color-palette-swatch").first().click();

  // After choosing a color the button must return to its resting (unselected) look.
  await expect(palette).toBeHidden();
  await expect(colorButton).toHaveAttribute("aria-expanded", "false");
  await expect(colorButton).not.toHaveClass(/active/);
  await colorButton.evaluate((element) => element.blur());
  await page.mouse.move(1390, 890);
  // Resting state has a transparent background (selected state uses --surface-muted).
  await expect.poll(async () => {
    const background = await colorButton.evaluate((element) => getComputedStyle(element).backgroundColor);
    return ["rgba(0, 0, 0, 0)", "transparent"].includes(background);
  }).toBe(true);
});

test("inserted body paragraph is focused and supports font controls", async ({ page }) => {
  await page.locator(".text-flow-editor").first().click();

  await page.getByRole("button", { name: "挿入", exact: true }).click();
  await page.getByRole("menuitem", { name: "本文", exact: true }).click();

  await expect.poll(async () => page.evaluate(() => (
    document.activeElement?.closest(".text-flow-editor") != null
  ))).toBe(true);
  await expect.poll(async () => page.evaluate(() => window.getSelection()?.toString() ?? "")).toBe("");
  await expect.poll(async () => page.evaluate(() => {
    const selection = window.getSelection();
    const node = selection?.focusNode instanceof Element
      ? selection.focusNode
      : selection?.focusNode?.parentElement;
    const paragraph = node?.closest("[data-sigma-doc-id]");
    return {
      placeholder: paragraph?.getAttribute("data-placeholder"),
      hasMark: Boolean(paragraph?.querySelector("[data-formatting-mark='paragraph']")),
      text: paragraph?.textContent?.replace(/\u200b/g, "").trim() ?? "",
    };
  })).toEqual({ placeholder: null, hasMark: true, text: "" });
  await page.keyboard.type("本文追加テスト");
  await expect(page.getByRole("main").getByText("本文を入力", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("main").getByText("本文追加テスト", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const block = Array.from(document.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .find((element) => element.textContent?.includes("本文追加テスト"));
    if (!block) throw new Error("inserted body paragraph was not found");
    const range = document.createRange();
    range.selectNodeContents(block);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });

  await page.locator('button[aria-label="フォントサイズ"]').click();
  await page.getByRole("menu", { name: "フォントサイズ" }).getByRole("menuitemradio", { name: "15pt", exact: true }).click();
  await page.getByRole("button", { name: /^フォント:/ }).click();
  const fontMenu = page.getByRole("menu", { name: "フォント", exact: true });
  await expect(fontMenu).toBeVisible();
  await expect(fontMenu).toHaveCSS("overflow-y", /^(auto|scroll)$/);
  await page.getByRole("searchbox", { name: "フォントを検索" }).fill("BIZ");
  await expect(page.getByRole("menuitemradio")).toHaveCount(2);
  await page.getByRole("menuitemradio", { name: "BIZ UDP明朝", exact: true }).click();

  await expect.poll(async () => {
    return page.evaluate(() => {
      const block = Array.from(window.document.querySelectorAll("[data-sigma-doc-id]"))
        .find((element) => element.textContent?.includes("本文追加テスト"));
      return block?.outerHTML ?? "";
    });
  }).toContain("font-size: 15pt");
  await expect.poll(async () => {
    return page.evaluate(() => {
      const block = Array.from(window.document.querySelectorAll("[data-sigma-doc-id]"))
        .find((element) => element.textContent?.includes("本文追加テスト"));
      return block?.outerHTML ?? "";
    });
  }).toContain("BIZ UDPMincho");
  await expect.poll(async () => page.evaluate(() => {
    const raw = localStorage.getItem("sigma-studio:e2e-document");
    return raw ?? "";
  })).toContain("BIZ UDPMincho");
});

test("main editor omits the overview grid and zoom stops at the 10 percent minimum", async ({ page }) => {
  await expect(page.getByRole("button", { name: "グリッド表示", exact: true })).toHaveCount(0);

  const zoomSelect = page.getByRole("combobox", { name: "ズーム", exact: true });
  await selectUiOption(zoomSelect, "10");
  await expectUiSelectValue(zoomSelect, "10");
  await page.getByRole("button", { name: "縮小", exact: true }).click();
  await expectUiSelectValue(zoomSelect, "10");
});

test("page settings dialog closes when its backdrop is pressed", async ({ page }) => {
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await page.getByRole("menuitem", { name: "ページ設定", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "ページ設定", exact: true });
  await expect(dialog).toBeVisible();
  await page.locator(".page-settings-backdrop").click({ position: { x: 8, y: 8 } });
  await expect(dialog).toHaveCount(0);
});

test("table can be inserted directly from the editing toolbar", async ({ page }) => {
  const insertMenuButton = page.getByRole("button", { name: "挿入", exact: true });
  await insertMenuButton.click();
  await expect(page.getByRole("menuitem", { name: "表", exact: true })).toHaveCount(0);
  await insertMenuButton.click();

  const tableButton = page.getByRole("button", { name: "表", exact: true }).first();
  await expect(tableButton).toBeVisible();
  await tableButton.click();

  const tablePicker = page.getByRole("dialog", { name: "表を挿入" });
  await expect(tablePicker).toBeVisible();
  await expect(page.getByRole("menu", { name: "挿入" })).toHaveCount(0);
  await expect(page.getByRole("menu", { name: "図形" })).toHaveCount(0);

  await page.keyboard.press("Escape");
  await expect(tablePicker).toHaveCount(0);

  await tableButton.click();
  await expect(tablePicker).toBeVisible();
  await tablePicker.getByRole("button", { name: "3列 2行の表を挿入" }).click();

  const tableShape = page.locator(".overlay-shape-tableShape");
  await expect(tableShape).toHaveCount(1);
  await expect(tableShape.locator("td")).toHaveCount(6);
});
