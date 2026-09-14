import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { BoxBlockChildBlock, BoxBlockNode, SigmaBlock, SigmaDocument, InlineNode, LayoutSectionNode, ParagraphNode } from "@/types/sigma-doc";

const MINCHO_FONT_VALUE = '"Hiragino Mincho ProN", "Yu Mincho", YuMincho, serif';

test("box actions omit the header and dismiss outside or with Escape", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    cornerBox("box_menu_target", [paragraph("box_menu_body", "本文")]),
    paragraph("box_menu_after", "後続本文"),
  ]));
  await page.goto("/");
  const box = page.locator('.sigma-doc-box-block[data-sigma-doc-id="box_menu_target"]').first();
  const trigger = box.getByRole("button", { name: "box操作" });
  const dialog = page.getByRole("dialog", { name: "box操作" });
  await box.hover();
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "閉じる", exact: true })).toHaveCount(0);
  await expect(dialog.getByText("box操作", { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole("button")).toHaveCount(4);
  await dialog.screenshot({ path: testInfo.outputPath("box-actions.png") });
  await page.mouse.click(10, 10);
  await expect(dialog).toHaveCount(0);
  await box.hover();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await box.hover();
  await trigger.click();
  await dialog.getByRole("button", { name: "boxを削除" }).click();
  await expect(box).toHaveCount(0);
  await expect.poll(() => topLevelBoxCount(page)).toBe(0);
});

test("keeps focus inside a box block while typing and supports formatting and deletion", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("box_trigger", ""),
    paragraph("after_box", "後続本文"),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  const trigger = page.locator('[data-sigma-doc-id="box_trigger"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.keyboard.type("/cornerbox");
  await expect(page.locator(".slash-command-popover")).toContainText("cornerbox");
  await page.keyboard.press("Enter");

  const box = page.locator('.sigma-doc-box-block[data-box-style="cornerbox"]').first();
  await expect(box).toBeVisible();
  await expect(box).toHaveClass(/box-frame--corner/);
  await expect.poll(() => box.evaluate((element) => getComputedStyle(element).containerType)).toBe("inline-size");
  const fullWidthMetrics = await cornerboxRenderMetrics(page, '.sigma-doc-box-block[data-box-style="cornerbox"]');
  expect(fullWidthMetrics.containerType).toBe("inline-size");
  expect(fullWidthMetrics.hasBoxFrameCornerClass).toBe(true);
  expect(fullWidthMetrics.hasCornerFrameClass).toBe(true);
  expect(fullWidthMetrics.beforeBackgroundImage).toContain("linear-gradient");
  expect(fullWidthMetrics.bodyFontSizePx).toBeCloseTo(16, 0);
  expect(fullWidthMetrics.bodyTextAlign).toBe("left");
  expect(fullWidthMetrics.height).toBeLessThan(70);
  expect(fullWidthMetrics.foldSizePx).toBeGreaterThanOrEqual(9);
  expect(fullWidthMetrics.foldSizePx).toBeLessThanOrEqual(10);
  expect(fullWidthMetrics.bodyInsetLeftPx).toBeGreaterThan(fullWidthMetrics.foldSizePx);
  expect(fullWidthMetrics.bodyInsetLeftPx).toBeCloseTo(24, 0);
  expect(fullWidthMetrics.bodyInsetTopPx).toBeCloseTo(24, 0);
  expect(fullWidthMetrics.referenceHeightPx).toBeCloseTo(fullWidthMetrics.height, 0);
  expect(fullWidthMetrics.cornerSquareSizePx).toBeCloseTo(5.8, 1);
  const bodyParagraph = box.locator(".sigma-doc-box-body [data-sigma-doc-id]").first();
  await expect(bodyParagraph).toBeVisible();
  const bodyId = await bodyParagraph.getAttribute("data-sigma-doc-id");
  expect(bodyId).toBeTruthy();
  await bodyParagraph.click();
  await expect.poll(() => selectedBlockId(page)).toBe(bodyId);

  const typed = "FOCUS_STAYS_INSIDE_BOX_BLOCK";
  await page.keyboard.type(typed, { delay: 20 });

  await expect(bodyParagraph).toContainText(typed);
  await expect.poll(() => selectedBlockId(page)).toBe(bodyId);
  await expect.poll(() => page.evaluate(() => Boolean(document.activeElement?.closest(".text-flow-editor")))).toBe(true);
  await expect(page.locator('[data-sigma-doc-id="after_box"]')).not.toContainText(typed);

  const fontSizeButton = page.getByLabel("フォントサイズ", { exact: true });
  await expect(fontSizeButton).toBeEnabled();
  await fontSizeButton.click();
  await page.getByRole("spinbutton", { name: "サイズ (pt)" }).fill("15");
  await page.getByRole("spinbutton", { name: "サイズ (pt)" }).press("Enter");
  await expect.poll(() => topLevelBoxFirstTextStyle(page)).toMatchObject({ fontSize: 15 });

  await bodyParagraph.click();
  await expect.poll(() => selectedBlockId(page)).toBe(bodyId);
  const fontFamilyButton = page.getByRole("button", { name: /^フォント:/ });
  await expect(fontFamilyButton).toBeEnabled();
  await fontFamilyButton.click();
  await page.getByRole("searchbox", { name: "フォントを検索" }).fill("Hiragino Mincho");
  await page.getByRole("menuitemradio", { name: "Hiragino Mincho ProN", exact: true }).click();
  await expect.poll(() => topLevelBoxFirstTextStyle(page)).toMatchObject({ fontFamily: MINCHO_FONT_VALUE });

  await box.hover();
  await box.getByRole("button", { name: "box操作" }).click();
  const dialog = page.getByRole("dialog", { name: "box操作" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "boxの設定…" })).toBeVisible();
  await dialog.getByRole("button", { name: "boxを削除" }).click();
  await expect(box).toBeHidden();
  await expect.poll(() => topLevelBoxCount(page)).toBe(0);
});

test("copies a box block from the box action menu and pastes it at the caret", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("box_copy_trigger", ""),
    paragraph("box_paste_target", "貼り付け先"),
  ]));

  await page.goto("/");
  const trigger = page.locator('[data-sigma-doc-id="box_copy_trigger"]').first();
  await trigger.click();
  await page.keyboard.type("/cornerbox");
  await expect(page.locator(".slash-command-popover")).toContainText("cornerbox");
  await page.keyboard.press("Enter");

  const box = page.locator('.sigma-doc-box-block[data-box-style="cornerbox"]').first();
  const bodyParagraph = box.locator(".sigma-doc-box-body [data-sigma-doc-id]").first();
  await bodyParagraph.click();
  await page.keyboard.type("COPY_BOX_BODY");

  await box.hover();
  await box.getByRole("button", { name: "box操作" }).click();
  const dialog = page.getByRole("dialog", { name: "box操作" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "boxの設定…" })).toBeVisible();
  await dialog.getByRole("button", { name: "boxをコピー" }).click();

  const pasteTarget = page.locator('[data-sigma-doc-id="box_paste_target"]').first();
  await pasteTarget.click();
  await page.keyboard.press("End");
  await page.keyboard.press("ControlOrMeta+V");

  await expect(page.locator('.sigma-doc-box-block[data-box-style="cornerbox"]')).toHaveCount(2);
  await expect(page.locator('.sigma-doc-box-block[data-box-style="cornerbox"]').nth(1)).toContainText("COPY_BOX_BODY");
  await expect.poll(() => topLevelBoxCount(page)).toBe(2);
  const summary = await topLevelBlockSummary(page);
  const pasteTargetIndex = summary.findIndex((block) => block.id === "box_paste_target");
  expect(pasteTargetIndex).toBeGreaterThanOrEqual(0);
  expect(summary[pasteTargetIndex + 1]?.type).toBe("boxBlock");
});

test("shows copy and delete actions for a box from the text context menu", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    cornerBox("box_context_target", [paragraph("box_context_body", "右クリック対象")]),
    paragraph("box_context_after", "後続本文"),
  ]));

  await page.goto("/");
  const box = page.locator('.sigma-doc-box-block[data-sigma-doc-id="box_context_target"]').first();
  const bodyParagraph = box.locator('.sigma-doc-box-body [data-sigma-doc-id="box_context_body"]').first();
  await expect(bodyParagraph).toBeVisible();
  const rect = await bodyParagraph.boundingBox();
  if (!rect) throw new Error("Cannot find box body bounds");

  await bodyParagraph.dispatchEvent("contextmenu", { clientX: rect.x + 24, clientY: rect.y + 10 });
  const contextMenu = page.getByRole("menu", { name: "本文操作" });
  await expect(contextMenu.getByRole("menuitem", { name: "boxの設定…" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "boxをコピー" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "boxを削除" })).toBeVisible();

  await contextMenu.getByRole("menuitem", { name: "boxを削除" }).click();
  await expect(box).toHaveCount(0);
});

test("keeps box actions in the body menu for selected text inside a box", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    cornerBox("box_selected_context_target", [paragraph("box_selected_context_body", "選択して右クリック")]),
    paragraph("box_selected_context_after", "後続本文"),
  ]));

  await page.goto("/");
  const box = page.locator('.sigma-doc-box-block[data-sigma-doc-id="box_selected_context_target"]').first();
  const bodyParagraph = box.locator('.sigma-doc-box-body [data-sigma-doc-id="box_selected_context_body"]').first();
  await expect(bodyParagraph).toBeVisible();
  await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('[data-sigma-doc-id="box_selected_context_body"]');
    const editor = block?.closest<HTMLElement>(".text-flow-editor");
    const selection = window.getSelection();
    const text = block ? document.createTreeWalker(block, NodeFilter.SHOW_TEXT).nextNode() : null;
    if (!block || !editor || !selection || !(text instanceof Text)) {
      throw new Error("Cannot select text inside box");
    }
    editor.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, text.textContent?.length ?? 0);
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange", { bubbles: true }));
  });
  const rect = await bodyParagraph.boundingBox();
  if (!rect) throw new Error("Cannot find selected box body bounds");

  await bodyParagraph.dispatchEvent("contextmenu", { clientX: rect.x + 24, clientY: rect.y + 10 });
  const contextMenu = page.getByRole("menu", { name: "本文操作" });
  await expect(contextMenu.getByRole("menuitem", { name: "boxの設定…" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "boxをコピー" })).toBeVisible();
  await expect(contextMenu.getByRole("menuitem", { name: "boxを削除" })).toBeVisible();

  await contextMenu.getByRole("menuitem", { name: "boxを削除" }).click();
  await expect(box).toHaveCount(0);
});

test("changes a box border width from the settings dialog", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    fancyBox("box_settings_target", [paragraph("box_settings_body", "設定対象")]),
    paragraph("box_settings_after", "後続本文"),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const box = page.locator('.sigma-doc-box-block[data-sigma-doc-id="box_settings_target"]').first();
  await expect(box).toBeVisible();
  await expect.poll(() => box.evaluate((element) => (
    element.style.getPropertyValue("--sigma-doc-box-border-width")
  ))).toBe("1.4px");

  await box.hover();
  await box.getByRole("button", { name: "box操作" }).click();
  const actionDialog = page.getByRole("dialog", { name: "box操作" });
  await actionDialog.getByRole("button", { name: "boxの設定…" }).click();

  const settingsDialog = page.getByRole("dialog", { name: "ボックス設定" });
  await expect(settingsDialog).toBeVisible();
  await settingsDialog.getByLabel("枠線幅（px）").fill("3");

  await expect.poll(() => box.evaluate((element) => (
    element.style.getPropertyValue("--sigma-doc-box-border-width")
  ))).toBe("3px");
  await expect.poll(() => topLevelBoxBorderWidth(page, "box_settings_target")).toBe(3);

  await page.keyboard.press("Escape");
  await expect(settingsDialog).toBeHidden();
});

test("inserts a cornerbox inside a multi-column layout section", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    layoutSection("two_column_section", [
      paragraph("column_box_trigger", ""),
      paragraph("column_after_box", "2段組の後続本文"),
    ]),
  ]));

  await page.goto("/");
  const trigger = page.locator('[data-layout-section-id="two_column_section"] [data-sigma-doc-id="column_box_trigger"]').first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.keyboard.type("/cornerbox");
  await expect(page.locator(".slash-command-popover")).toContainText("cornerbox");
  await page.keyboard.press("Enter");

  const box = page.locator('[data-layout-section-id="two_column_section"] .sigma-doc-box-block[data-box-style="cornerbox"]').first();
  await expect(box).toBeVisible();
  const columnMetrics = await cornerboxRenderMetrics(page, '[data-layout-section-id="two_column_section"] .sigma-doc-box-block[data-box-style="cornerbox"]');
  expect(columnMetrics.hasBoxFrameCornerClass).toBe(true);
  expect(columnMetrics.hasCornerFrameClass).toBe(true);
  expect(columnMetrics.foldSizePx).toBeGreaterThanOrEqual(9);
  expect(columnMetrics.foldSizePx).toBeLessThanOrEqual(10);
  expect(columnMetrics.bodyInsetLeftPx).toBeGreaterThan(columnMetrics.foldSizePx);
  expect(columnMetrics.bodyInsetTopPx).toBeCloseTo(24, 0);
  expect(columnMetrics.guideInsetPx).toBeCloseTo(columnMetrics.foldSizePx, 0);
  expect(columnMetrics.guideSideYPx).toBeCloseTo(columnMetrics.foldSizePx, 0);
  expect(columnMetrics.cornerSquareSizePx).toBeCloseTo(5.8, 1);
  await expect(page.locator('[data-layout-section-id="two_column_section"] [data-sigma-doc-id="column_after_box"]')).toContainText("2段組の後続本文");
  await expect.poll(() => firstLayoutChildType(page)).toBe("boxBlock");
});

test("scales cornerbox fold decoration with rendered height", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    cornerBox("corner_one_line", [paragraph("corner_one_line_body", "1行")]),
    cornerBox("corner_six_lines", Array.from({ length: 6 }, (_, index) => paragraph(`corner_six_line_${index}`, `高さ確認 ${index + 1}`))),
  ]));

  await page.goto("/");
  const oneLineSelector = '.sigma-doc-box-block[data-sigma-doc-id="corner_one_line"]';
  const tallSelector = '.sigma-doc-box-block[data-sigma-doc-id="corner_six_lines"]';
  await expect(page.locator(oneLineSelector)).toBeVisible();
  await expect(page.locator(tallSelector)).toBeVisible();

  await expect.poll(async () => (await cornerboxRenderMetrics(page, oneLineSelector)).foldSizePx).toBeGreaterThanOrEqual(8);
  await expect.poll(async () => (await cornerboxRenderMetrics(page, tallSelector)).foldSizePx).toBeGreaterThan(17);

  const oneLineMetrics = await cornerboxRenderMetrics(page, oneLineSelector);
  const tallMetrics = await cornerboxRenderMetrics(page, tallSelector);
  expect(tallMetrics.height).toBeGreaterThan(oneLineMetrics.height);
  expect(oneLineMetrics.foldSizePx).toBeGreaterThanOrEqual(9);
  expect(oneLineMetrics.foldSizePx).toBeLessThanOrEqual(10);
  expect(tallMetrics.foldSizePx).toBeLessThanOrEqual(18);
  expect(oneLineMetrics.cornerSquareSizePx).toBeCloseTo(5.8, 1);
  expect(tallMetrics.cornerSquareSizePx).toBeGreaterThan(oneLineMetrics.cornerSquareSizePx);
  expect(tallMetrics.cornerSquareSizePx).toBeCloseTo(8, 0);
  expect(oneLineMetrics.ruleYPx - (oneLineMetrics.cornerOffsetYPx + oneLineMetrics.cornerSquareSizePx / 2)).toBeCloseTo(oneLineMetrics.cornerSquareSizePx * 0.25, 1);
  expect(tallMetrics.ruleYPx - (tallMetrics.cornerOffsetYPx + tallMetrics.cornerSquareSizePx / 2)).toBeCloseTo(tallMetrics.cornerSquareSizePx * 0.25, 1);
  expect(tallMetrics.guideInsetPx).toBeCloseTo(tallMetrics.foldSizePx, 0);
  expect(tallMetrics.guideSideYPx).toBeCloseTo(tallMetrics.foldSizePx, 0);
  expect(tallMetrics.ruleYPx).toBeCloseTo(tallMetrics.foldSizePx * 0.62, 1);
});

test("uses the source cornerbox height for print fragments", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    cornerBox("corner_print_fragment", Array.from({ length: 180 }, (_, index) => paragraph(`corner_print_line_${index}`, `印刷分割の高さ確認 ${index + 1}`))),
  ]));

  await page.goto("/print?fileId=file_e2e_document");
  await expect(page.locator(".paged-surface-page").first()).toBeVisible();
  await expect.poll(async () => (await printCornerboxFragmentMetrics(page)).length).toBeGreaterThanOrEqual(3);

  const fragments = await printCornerboxFragmentMetrics(page);
  const roles = fragments.map((fragment) => fragment.role);
  expect(roles).toContain("first");
  expect(roles).toContain("middle");
  expect(roles).toContain("last");
  expect(new Set(fragments.map((fragment) => fragment.referenceHeightPx.toFixed(0))).size).toBe(1);
  expect(new Set(fragments.map((fragment) => fragment.foldSizePx.toFixed(0))).size).toBe(1);
  expect(new Set(fragments.map((fragment) => fragment.cornerSquareSizePx.toFixed(0))).size).toBe(1);
  // "Uses the source height": the shared reference is the whole box, not the height of
  // whichever piece is being drawn — that is what keeps the corner decoration the same
  // size on every page. (The print renderer flagged this with an attribute; the editor
  // expresses it as the resolved custom property, which is the thing that has to match.)
  expect(fragments[0].referenceHeightPx).toBeGreaterThan(0);
  expect(fragments.every((fragment) => fragment.foldSizePx <= 18 && fragment.foldSizePx > 17)).toBe(true);
  expect(fragments.every((fragment) => fragment.cornerSquareSizePx <= 8 && fragment.cornerSquareSizePx > 7)).toBe(true);
});

async function selectedBlockId(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const selection = window.getSelection();
    const anchorParent = selection?.anchorNode
      ? selection.anchorNode.nodeType === Node.ELEMENT_NODE
        ? selection.anchorNode as Element
        : selection.anchorNode.parentElement
      : null;
    return anchorParent?.closest("[data-sigma-doc-id]")?.getAttribute("data-sigma-doc-id") ?? null;
  });
}

async function firstLayoutChildType(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }

    const document = JSON.parse(raw) as SigmaDocument;
    const section = document.content.find((block): block is LayoutSectionNode => block.type === "layoutSection" && block.id === "two_column_section");
    return section?.children[0]?.type ?? null;
  });
}

async function topLevelBoxCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return 0;
    }

    const document = JSON.parse(raw) as SigmaDocument;
    return document.content.filter((block) => block.type === "boxBlock").length;
  });
}

async function topLevelBlockSummary(page: Page): Promise<Array<{ id: string; type: string }>> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [];
    }

    const document = JSON.parse(raw) as SigmaDocument;
    return document.content.map((block) => ({ id: block.id, type: block.type }));
  });
}

async function topLevelBoxFirstTextStyle(page: Page): Promise<{ fontFamily: string | null; fontSize: number | null }> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return { fontFamily: null, fontSize: null };
    }

    const document = JSON.parse(raw) as SigmaDocument;
    const box = document.content.find((block) => block.type === "boxBlock");
    if (!box || box.type !== "boxBlock") {
      return { fontFamily: null, fontSize: null };
    }

    const firstText = findFirstTextInBoxChildren(box.blocks);
    return firstText?.type === "text"
      ? { fontFamily: firstText.fontFamily ?? null, fontSize: firstText.fontSize ?? null }
      : { fontFamily: null, fontSize: null };

    function findFirstTextInBoxChildren(blocks: BoxBlockChildBlock[]): Extract<InlineNode, { type: "text" }> | null {
      for (const block of blocks) {
        if (block.type === "heading" || block.type === "paragraph") {
          const text = block.children.find((child): child is Extract<InlineNode, { type: "text" }> => child.type === "text");
          if (text) {
            return text;
          }
        } else if (block.type === "list") {
          for (const item of block.items) {
            const text = item.children.find((child): child is Extract<InlineNode, { type: "text" }> => child.type === "text");
            if (text) {
              return text;
            }
          }
        } else if (block.type === "boxBlock") {
          const text = findFirstTextInBoxChildren(block.blocks);
          if (text) {
            return text;
          }
        } else if (block.type === "layoutSection") {
          const text = findFirstTextInBoxChildren(block.children);
          if (text) {
            return text;
          }
        }
      }
      return null;
    }
  });
}

async function topLevelBoxBorderWidth(page: Page, boxId: string): Promise<number | null> {
  return page.evaluate((targetBoxId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return null;
    }

    const document = JSON.parse(raw) as SigmaDocument;
    const box = document.content.find((block) => block.type === "boxBlock" && block.id === targetBoxId);
    return box?.type === "boxBlock" ? box.frame?.borderWidthPx ?? null : null;
  }, boxId);
}

async function cornerboxRenderMetrics(page: Page, selector: string): Promise<{
  bodyFontSizePx: number;
  bodyInsetLeftPx: number;
  bodyInsetTopPx: number;
  bodyTextAlign: string;
  beforeBackgroundImage: string;
  containerType: string;
  cornerOffsetYPx: number;
  cornerSquareSizePx: number;
  foldSizePx: number;
  guideInsetPx: number;
  guideInsetToken: string;
  guideSideYPx: number;
  guideSideYToken: string;
  height: number;
  hasBoxFrameCornerClass: boolean;
  hasCornerFrameClass: boolean;
  referenceHeightPx: number;
  ruleYPx: number;
  ruleYToken: string;
  width: number;
}> {
  return page.locator(selector).first().evaluate((box) => {
    const body = box.querySelector<HTMLElement>(".sigma-doc-box-body");
    const boxRect = box.getBoundingClientRect();
    const width = boxRect.width;
    const boxStyle = getComputedStyle(box);
    const bodyStyle = body ? getComputedStyle(body) : null;
    const beforeStyle = getComputedStyle(box, "::before");
    const cornerSize = Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-corner-size")) || 0;
    const foldSize = Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-fold-size")) || 0;
    const referenceHeight = Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-reference-height")) || 0;
    return {
      bodyFontSizePx: bodyStyle ? Number.parseFloat(bodyStyle.fontSize) : 0,
      bodyInsetLeftPx: body ? body.getBoundingClientRect().left - boxRect.left : 0,
      bodyInsetTopPx: body ? body.getBoundingClientRect().top - boxRect.top : 0,
      bodyTextAlign: bodyStyle?.textAlign ?? "",
      beforeBackgroundImage: beforeStyle.backgroundImage,
      containerType: boxStyle.containerType,
      cornerOffsetYPx: Number.parseFloat(beforeStyle.getPropertyValue("--corner-frame-corner-y")) || 0,
      cornerSquareSizePx: cornerSize,
      foldSizePx: foldSize,
      guideInsetPx: Number.parseFloat(beforeStyle.getPropertyValue("--corner-frame-guide-inset-x")) || 0,
      guideInsetToken: beforeStyle.getPropertyValue("--corner-frame-guide-inset-x").trim(),
      guideSideYPx: Number.parseFloat(beforeStyle.getPropertyValue("--corner-frame-guide-side-y")) || 0,
      guideSideYToken: beforeStyle.getPropertyValue("--corner-frame-guide-side-y").trim(),
      height: boxRect.height,
      hasBoxFrameCornerClass: box.classList.contains("box-frame--corner"),
      hasCornerFrameClass: box.classList.contains("corner-frame"),
      referenceHeightPx: referenceHeight,
      ruleYPx: Number.parseFloat(beforeStyle.getPropertyValue("--corner-frame-rule-y")) || 0,
      ruleYToken: beforeStyle.getPropertyValue("--corner-frame-rule-y").trim(),
      width,
    };
  });
}

async function printCornerboxFragmentMetrics(page: Page): Promise<Array<{
  cornerSquareSizePx: number;
  foldSizePx: number;
  referenceHeightPx: number;
  role: string | null;
}>> {
  // The printed page is the editor canvas now, so a split box is the source box shown
  // clipped in place plus one `.editor-box-fragment-viewport` per continuation — not
  // print-only `[data-box-fragment]` sections. Counting only the viewports misses the
  // first piece. The role comes from the position in that sequence.
  return page.evaluate(() => {
    // Scoped to the staged canvas, not the page windows: each window holds a complete
    // clone, so a cross-window query would return every piece once per page.
    const pieces = Array.from(document.querySelectorAll<HTMLElement>(
      '.paged-surface-stage [data-box-style="cornerbox"]',
    ));
    const lastIndex = pieces.length - 1;
    return pieces.map((box, index) => {
      const boxStyle = getComputedStyle(box);
      return {
        cornerSquareSizePx: Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-corner-size")) || 0,
        foldSizePx: Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-fold-size")) || 0,
        referenceHeightPx: Number.parseFloat(boxStyle.getPropertyValue("--corner-frame-reference-height")) || 0,
        role: index === 0 ? "first" : index === lastIndex ? "last" : "middle",
      };
    });
  });
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function layoutSection(id: string, children: LayoutSectionNode["children"]): LayoutSectionNode {
  return {
    id,
    type: "layoutSection",
    layout: { columnCount: 2, columnGapMm: 8 },
    children,
  };
}

function cornerBox(id: string, blocks: BoxBlockChildBlock[]): BoxBlockNode {
  return {
    id,
    type: "boxBlock",
    styleId: "cornerbox",
    blocks,
  };
}

function fancyBox(id: string, blocks: BoxBlockChildBlock[]): BoxBlockNode {
  return {
    id,
    type: "boxBlock",
    styleId: "fancybox",
    frame: {
      borderWidthPx: 1.4,
      borderColor: "#111111",
      borderStyle: "solid",
      backgroundColor: "#ffffff",
      cornerStyle: "sharp",
      paddingPx: { top: 12, right: 14, bottom: 12, left: 14 },
    },
    blocks,
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "box_block_focus_e2e_doc",
    metadata: { title: "箱フォーカス E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
