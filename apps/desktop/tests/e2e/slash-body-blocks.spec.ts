import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { createBoxBlock } from "@/lib/box-blocks";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

/**
 * `/` から本文ブロック (引用・コード・区切り線) とタイトル地色付きの箱を作れることの検査。
 *
 * 本文ブロックはツールバーからも作れるが、`/` の一覧に**並ぶ**ことと、選んだあとに
 * トリガー文字 (`/引用`) が本文へ残らないことはここでしか担保できない。
 */

test("inserts body blocks and titled boxes from the slash command palette", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("quote_trigger", ""),
    paragraph("code_trigger", ""),
    paragraph("divider_trigger", ""),
    paragraph("box_trigger", ""),
    paragraph("tail", "末尾"),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  await runSlashCommand(page, "quote_trigger", "/引用", "引用");
  const quote = page.locator("blockquote.print-quote").first();
  await expect(quote).toBeVisible();
  await expect(quote).not.toContainText("/");
  // 引用は入れ物なので本文ランごと remount される。ツールバーのブロックボタンと同じ後始末で
  // キャレットが戻ってくるまで待ってから打つ (戻り先は引用の中)。remount は一度キャレットを
  // 落とすので、「入った」ではなく「入ったまま落ち着いた」を待つ。
  await waitForSettledCaretContainer(page, "BLOCKQUOTE");
  await page.keyboard.type("引用の中身");
  await expect(quote).toContainText("引用の中身");

  await runSlashCommand(page, "code_trigger", "/コード", "コードブロック");
  const code = page.locator(".print-code").first();
  await expect(code).toBeVisible();
  await expect(code).not.toContainText("/");

  await runSlashCommand(page, "divider_trigger", "/区切り線", "区切り線");
  await expect(page.locator("hr.print-divider").first()).toBeVisible();

  // タイトルに地色を敷く箱。帯 (`titlebox`) は本文と切る罫を持つ。
  await runSlashCommand(page, "box_trigger", "/titlebox", "titlebox");
  const box = page.locator('.sigma-doc-box-block[data-box-style="titlebox"]').first();
  await expect(box).toBeVisible();
  await expect(box).toHaveClass(/box-frame--title-band/);
  const band = await bandMetrics(page, '.sigma-doc-box-block[data-box-style="titlebox"]');
  expect(band.backgroundColor).toBe("rgb(229, 231, 235)");
  expect(band.borderBottomWidth).toBeGreaterThan(0);
  // 帯は枠の左右いっぱいまで届く (パディングぶん外へ出す負のマージンが効いている)。
  expect(band.width).toBeGreaterThan(band.boxWidth - 4);
});

test("draws the title tab inside the frame so the box owns its full height", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    paragraph("before", "前の段落"),
    paragraph("tab_trigger", ""),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  await runSlashCommand(page, "tab_trigger", "/tabbox", "tabbox");
  const box = page.locator('.sigma-doc-box-block[data-box-style="tabbox"]').first();
  await expect(box).toBeVisible();
  await expect(box).toHaveClass(/box-frame--title-tab/);

  const tab = await tabMetrics(page, '.sigma-doc-box-block[data-box-style="tabbox"]');
  expect(tab.backgroundColor).toBe("rgb(31, 56, 100)");
  expect(tab.color).toBe("rgb(255, 255, 255)");
  // タブは枠の左上に載る: 上端・左端は枠と同じで、下端は枠の中に収まる。
  expect(Math.abs(tab.top - tab.boxTop)).toBeLessThanOrEqual(1);
  expect(Math.abs(tab.left - tab.boxLeft)).toBeLessThanOrEqual(1);
  expect(tab.bottom).toBeLessThan(tab.boxBottom);
  // はみ出さないので、前のブロックとの間隔は他の箱と同じ。
  expect(tab.top).toBeGreaterThanOrEqual(tab.previousBottom);
});

test("wraps a paragraph inside a box in a quote without losing its text", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await installDesktopRuntimeMock(page, createDocument([
    createBoxBlock("fancybox", "枠", { id: "box_1", bodyId: "p_body", bodyText: "箱の本文" }) as SigmaBlock,
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  // 箱の中の空行から `/引用`。箱は入れ子にできないので候補は本文ブロックだけになる。
  await page.locator('[data-sigma-doc-id="p_body"]').first().click();
  await page.keyboard.press("End");
  await page.keyboard.press("Enter");
  await page.keyboard.type("/引用");
  const popover = page.locator(".slash-command-popover");
  await expect(popover).toContainText("引用");
  await expect(popover).not.toContainText("fancybox");
  await page.keyboard.press("Enter");

  const box = page.locator('.sigma-doc-box-block[data-box-style="fancybox"]').first();
  await expect(box.locator("blockquote.print-quote")).toBeVisible();
  // 入れ物の中で種別を変えても、同じ箱の他の本文は残る (往復で潰れない)。
  await expect(box).toContainText("箱の本文");
});

async function runSlashCommand(page: Page, blockId: string, typed: string, expected: string): Promise<void> {
  const trigger = page.locator(`[data-sigma-doc-id="${blockId}"]`).first();
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.keyboard.type(typed);
  await expect(page.locator(".slash-command-popover")).toContainText(expected);
  await page.keyboard.press("Enter");
  await expect(page.locator(".slash-command-popover")).toHaveCount(0);
}

async function waitForSettledCaretContainer(page: Page, tagName: string): Promise<void> {
  await expect.poll(async () => {
    const first = await caretContainerTag(page);
    await page.waitForTimeout(250);
    const second = await caretContainerTag(page);
    return first === tagName && second === tagName ? tagName : `${first}/${second}`;
  }, { timeout: 15_000 }).toBe(tagName);
}

async function caretContainerTag(page: Page): Promise<string> {
  return page.evaluate(() => {
    const node = window.getSelection()?.anchorNode ?? null;
    const element = node instanceof Element ? node : node?.parentElement ?? null;
    return element?.closest("blockquote, pre, .print-code")?.tagName ?? element?.tagName ?? "none";
  });
}

async function bandMetrics(page: Page, selector: string) {
  return page.evaluate((boxSelector) => {
    const box = document.querySelector<HTMLElement>(boxSelector);
    const title = box?.querySelector<HTMLElement>(".sigma-doc-box-title");
    if (!box || !title) {
      throw new Error("title band not found");
    }
    const style = getComputedStyle(title);
    return {
      backgroundColor: style.backgroundColor,
      borderBottomWidth: Number.parseFloat(style.borderBottomWidth),
      width: title.getBoundingClientRect().width,
      boxWidth: box.getBoundingClientRect().width,
    };
  }, selector);
}

async function tabMetrics(page: Page, selector: string) {
  return page.evaluate((boxSelector) => {
    const box = document.querySelector<HTMLElement>(boxSelector);
    const title = box?.querySelector<HTMLElement>(".sigma-doc-box-title");
    const previous = document.querySelector<HTMLElement>('[data-sigma-doc-id="before"]');
    if (!box || !title || !previous) {
      throw new Error("title tab not found");
    }
    const style = getComputedStyle(title);
    const tabRect = title.getBoundingClientRect();
    const boxRect = box.getBoundingClientRect();
    return {
      backgroundColor: style.backgroundColor,
      color: style.color,
      top: tabRect.top,
      left: tabRect.left,
      bottom: tabRect.bottom,
      boxTop: boxRect.top,
      boxLeft: boxRect.left,
      boxBottom: boxRect.bottom,
      previousBottom: previous.getBoundingClientRect().bottom,
    };
  }, selector);
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}

function createDocument(content: SigmaBlock[]): SigmaDocument {
  return {
    version: "2.0",
    docId: "slash_body_blocks_e2e_doc",
    metadata: { title: "スラッシュ挿入 E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
