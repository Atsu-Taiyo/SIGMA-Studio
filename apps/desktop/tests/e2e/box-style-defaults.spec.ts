import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { createBoxBlock } from "@/lib/box-blocks";
import type { ParagraphNode, SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

/**
 * 箱の見た目を設定ダイアログで決めると、**次に同じスタイルを挿すときの既定**になる、という約束。
 *
 * 覚えるのはスタイルごとの差分だけで、既にある箱は自分の `frame` を持ったまま。だから
 * 「既定に戻す」を押した後の新しい箱は組み込みの色に戻る。
 */

const STORAGE_KEY = "sigma-studio:box-style-defaults";
const TITLE_BACKGROUND = "#ffc400";

test("remembers a customized box style and uses it for the next insertion", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, createDocument([
    createBoxBlock("titlebox", "見出し", { id: "box_1", bodyId: "p_body", bodyText: "箱の本文" }) as SigmaBlock,
    paragraph("trigger", ""),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const firstBox = page.locator('.sigma-doc-box-block[data-box-style="titlebox"]').first();
  await expect(firstBox).toBeVisible();
  expect(await titleBandColor(page, 0)).not.toBe("rgb(255, 196, 0)");

  await openBoxSettings(page, "p_body");
  await pickColor(page, "titleBackgroundColor", TITLE_BACKGROUND);
  await expect.poll(() => titleBandColor(page, 0)).toBe("rgb(255, 196, 0)");
  await closeDialog(page);

  // 覚えているのは触った差分だけ。組み込みの既定はそのまま残る。
  expect(await remembered(page)).toEqual({ titlebox: { titleBackgroundColor: TITLE_BACKGROUND } });

  // 2 つ目の箱は、決めた見た目で入る。
  await insertBoxCommand(page, "trigger", "/titlebox");
  await expect(page.locator('.sigma-doc-box-block[data-box-style="titlebox"]')).toHaveCount(2);
  await expect.poll(() => titleBandColor(page, 1)).toBe("rgb(255, 196, 0)");
  // 帯の罫のような、触っていない項目は組み込みの既定のまま。
  // (`getComputedStyle` の border-width は端数が丸まるので、変数の値そのものを見る)
  expect(await titleBandRuleWidth(page, 1)).toBe("1.2px");
});

test("forgets the customization from the dialog and inserts the built-in style again", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, createDocument([
    createBoxBlock("titlebox", "見出し", { id: "box_1", bodyId: "p_body", bodyText: "箱の本文" }) as SigmaBlock,
    paragraph("trigger", ""),
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  await openBoxSettings(page, "p_body");
  await pickColor(page, "titleBackgroundColor", TITLE_BACKGROUND);
  await expect.poll(() => titleBandColor(page, 0)).toBe("rgb(255, 196, 0)");

  await page.getByRole("button", { name: "このスタイルの既定に戻す" }).click();
  // 押した箱も組み込みへ戻る。
  await expect.poll(() => titleBandColor(page, 0)).toBe("rgb(229, 231, 235)");
  await closeDialog(page);

  expect(await remembered(page)).toEqual({});

  await insertBoxCommand(page, "trigger", "/titlebox");
  await expect(page.locator('.sigma-doc-box-block[data-box-style="titlebox"]')).toHaveCount(2);
  await expect.poll(() => titleBandColor(page, 1)).toBe("rgb(229, 231, 235)");
});

test("exposes every decoration of the current style, and only that style's", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, createDocument([
    createBoxBlock("theorembox", "定理", { id: "box_1", bodyId: "p_body", bodyText: "本文" }) as SigmaBlock,
  ]));

  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
  await openBoxSettings(page, "p_body");

  // 左罫を持つスタイルなので、その太さと色が出る。帯もタブも無いので出ない。
  await expect(page.getByTestId("box-field-leftBar.color")).toBeVisible();
  await expect(page.getByTestId("box-field-leftBar.widthPx")).toBeVisible();
  await expect(page.getByTestId("box-field-titleBand.ruleColor")).toHaveCount(0);
  await expect(page.getByTestId("box-field-titleTab.heightPx")).toHaveCount(0);
  // 色は装飾を持たないスタイルでも共通で出る。
  await expect(page.getByTestId("box-field-backgroundColor")).toBeVisible();
  await expect(page.getByTestId("box-field-bodyColor")).toBeVisible();

  await pickColor(page, "leftBar.color", "#e60000");
  await expect.poll(() => page.evaluate(() => {
    const box = document.querySelector<HTMLElement>('.sigma-doc-box-block[data-box-style="theorembox"]');
    return box ? getComputedStyle(box).getPropertyValue("--sigma-doc-box-left-bar-color").trim() : "";
  })).toBe("#e60000");
});

async function openBoxSettings(page: Page, bodyBlockId: string): Promise<void> {
  await page.locator(`[data-sigma-doc-id="${bodyBlockId}"]`).first().click({ button: "right" });
  await page.locator(".page-context-menu").getByRole("menuitem", { name: "boxの設定…" }).click();
  await expect(page.getByRole("dialog", { name: "ボックス設定" })).toBeVisible();
}

async function closeDialog(page: Page): Promise<void> {
  await page.getByRole("dialog", { name: "ボックス設定" }).getByRole("button", { name: "閉じる" }).click();
  await expect(page.getByRole("dialog", { name: "ボックス設定" })).toHaveCount(0);
}

async function pickColor(page: Page, fieldId: string, swatch: string): Promise<void> {
  await page.getByTestId(`box-field-${fieldId}`).click();
  const popover = page.locator(".color-popover");
  await expect(popover).toBeVisible();
  await popover.getByTitle(swatch).first().click();
  await expect(popover).toHaveCount(0);
}

async function insertBoxCommand(page: Page, blockId: string, typed: string): Promise<void> {
  await page.locator(`[data-sigma-doc-id="${blockId}"]`).first().click();
  await page.keyboard.type(typed);
  await expect(page.locator(".slash-command-popover")).toContainText(typed.slice(1));
  await page.keyboard.press("Enter");
  await expect(page.locator(".slash-command-popover")).toHaveCount(0);
}

function titleBandColor(page: Page, index: number): Promise<string> {
  return page.evaluate((boxIndex) => {
    const box = document.querySelectorAll<HTMLElement>('.sigma-doc-box-block[data-box-style="titlebox"]')[boxIndex];
    const title = box?.querySelector<HTMLElement>(".sigma-doc-box-title");
    return title ? getComputedStyle(title).backgroundColor : "";
  }, index);
}

function titleBandRuleWidth(page: Page, index: number): Promise<string> {
  return page.evaluate((boxIndex) => {
    const box = document.querySelectorAll<HTMLElement>('.sigma-doc-box-block[data-box-style="titlebox"]')[boxIndex];
    return box ? getComputedStyle(box).getPropertyValue("--sigma-doc-box-title-band-rule-width").trim() : "";
  }, index);
}

function remembered(page: Page): Promise<unknown> {
  return page.evaluate((key) => {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : {};
  }, STORAGE_KEY);
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
    docId: "box_style_defaults_e2e_doc",
    metadata: { title: "箱の既定 E2E" },
    content,
    outputProfiles: {
      student: {},
      teacher: {},
      answerBook: {},
    },
  };
}
