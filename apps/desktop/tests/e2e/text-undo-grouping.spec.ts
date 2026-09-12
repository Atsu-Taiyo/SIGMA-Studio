import { expect, test, type Page } from "@playwright/test";

import { sampleDocument } from "../../src/lib/sample-document";
import type { SigmaDocument } from "../../src/types/sigma-doc";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

async function openEditor(page: Page) {
  const document = structuredClone(sampleDocument) as SigmaDocument;
  document.docId = "doc_e2e_text_undo_grouping";
  document.metadata = {
    ...document.metadata,
    title: "本文Undo単位 E2E",
  };
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".text-flow-editor").first()).toBeVisible();
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });
}

test("groups adjacent body typing and starts a new undo unit after a pause", async ({ page }) => {
  await openEditor(page);

  const paragraph = page.locator(".page-flow .text-flow-editor p").filter({ hasText: /\S/ }).first();
  const initialText = await paragraph.innerText();
  await paragraph.evaluate((element) => {
    element.closest<HTMLElement>(".text-flow-editor")?.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    selection?.removeAllRanges();
    selection?.addRange(range);
  });

  await page.keyboard.type("abc");
  await page.waitForTimeout(550);
  await page.keyboard.type("def");
  await expect(paragraph).toHaveText(`${initialText}abcdef`);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraph).toHaveText(`${initialText}abc`);

  await page.keyboard.press("ControlOrMeta+Z");
  await expect(paragraph).toHaveText(initialText);

  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(paragraph).toHaveText(`${initialText}abc`);
  await page.keyboard.press("ControlOrMeta+Shift+Z");
  await expect(paragraph).toHaveText(`${initialText}abcdef`);
});
