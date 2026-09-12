import { expect, test, type Page } from "@playwright/test";

import type { SigmaDocument } from "@/features/document";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const LINE_COUNT = 500;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 1000 });
  await page.addInitScript(() => window.localStorage.clear());
});

test("大量 plain text を一括保存し、1 回の undo で全体を戻す", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });

  const target = page.locator('[data-sigma-doc-id="paste_target"]').first();
  await target.click();
  await page.keyboard.press("End");
  const lines = Array.from({ length: LINE_COUNT }, (_, index) => `line-${index}`);
  const dispatchDuration = await dispatchPlainTextPaste(page, lines.join("\n\n"));
  expect(dispatchDuration).toBeLessThan(1_500);

  await expect.poll(async () => (await savedParagraphTexts(page)).length, { timeout: 20_000 })
    .toBe(LINE_COUNT);
  await expect.poll(async () => await savedParagraphTexts(page), { timeout: 20_000 })
    .toEqual([`seed-${lines[0]}`, ...lines.slice(1)]);
  await expect(page.locator('[data-large-paste-deferred="true"]')).toHaveCount(0, { timeout: 20_000 });

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => await savedParagraphTexts(page), { timeout: 10_000 })
    .toEqual(["seed-"]);
});

test("大量 plain text の直後の入力を最終行の後ろに追加する", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });

  const target = page.locator('[data-sigma-doc-id="paste_target"]').first();
  await target.click();
  await page.keyboard.press("End");
  const lines = Array.from({ length: LINE_COUNT }, (_, index) => `line-${index}`);
  const dispatchDuration = await dispatchPlainTextPaste(page, lines.join("\n\n"));
  expect(dispatchDuration).toBeLessThan(1_500);

  await page.keyboard.type("追記");
  await expect.poll(async () => await savedParagraphTexts(page), { timeout: 20_000 })
    .toEqual([`seed-${lines[0]}`, ...lines.slice(1, -1), `${lines.at(-1)}追記`]);
});

test("大量 plain text の最終行が整定完了まで可視域に留まる", async ({ page }) => {
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 15_000 });

  const target = page.locator('[data-sigma-doc-id="paste_target"]').first();
  await target.click();
  await page.keyboard.press("End");
  const lines = Array.from({ length: LINE_COUNT }, (_, index) => `line-${index}`);
  await dispatchPlainTextPaste(page, lines.join("\n\n"));

  const expectedLine = lines.at(-1)!;
  const startedAt = Date.now();
  let sawCaretLine = false;
  let settled = false;
  const samples: Array<{ bottom: number; top: number; viewportBottom: number; viewportTop: number }> = [];
  while (Date.now() - startedAt < 20_000) {
    const sample = await sampleLargePasteCaretLine(page, expectedLine);
    settled = sample.deferredCount === 0;
    if (sample.rect) {
      sawCaretLine = true;
      samples.push(sample.rect);
      expect(sample.rect.bottom).toBeGreaterThanOrEqual(sample.rect.viewportTop - 160);
      expect(sample.rect.top).toBeLessThanOrEqual(sample.rect.viewportBottom + 160);
    } else if (sawCaretLine) {
      throw new Error("整定中に最終ペースト行が DOM から外れました");
    }
    if (!sawCaretLine && Date.now() - startedAt > 2_500) {
      throw new Error("最終ペースト行が 2.5 秒以内に hydrate されませんでした");
    }
    if (settled && sawCaretLine) {
      break;
    }
    await page.waitForTimeout(250);
  }

  expect(settled).toBe(true);
  expect(samples.length).toBeGreaterThan(0);
});

async function dispatchPlainTextPaste(page: Page, text: string): Promise<number> {
  return page.evaluate((pastedText) => {
    const target = document.activeElement?.closest(".text-flow-editor");
    if (!target) {
      throw new Error("Text flow editor is not focused");
    }
    const clipboardData = new DataTransfer();
    clipboardData.setData("text/plain", pastedText);
    const start = performance.now();
    target.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData,
    }));
    return performance.now() - start;
  }, text);
}

async function savedParagraphTexts(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    if (!raw) {
      return [];
    }
    const document = JSON.parse(raw) as {
      content?: Array<{ type: string; children?: Array<{ type: string; text?: string }> }>;
    };
    return (document.content ?? []).flatMap((block) => (
      block.type === "paragraph"
        ? [block.children?.map((child) => child.type === "text" ? child.text ?? "" : "").join("") ?? ""]
        : []
    ));
  });
}

async function sampleLargePasteCaretLine(page: Page, expectedLine: string): Promise<{
  deferredCount: number;
  rect: { bottom: number; top: number; viewportBottom: number; viewportTop: number } | null;
}> {
  return page.evaluate((lineText) => {
    const deferredCount = document.querySelectorAll('[data-large-paste-deferred="true"]').length;
    const line = Array.from(document.querySelectorAll<HTMLElement>(".text-flow-editor [data-sigma-doc-id]"))
      .find((element) => element.textContent === lineText);
    const scroller = line?.closest<HTMLElement>(".editor-canvas");
    if (!line || !scroller) {
      return { deferredCount, rect: null };
    }
    const rect = line.getBoundingClientRect();
    const viewport = scroller.getBoundingClientRect();
    return {
      deferredCount,
      rect: {
        bottom: rect.bottom,
        top: rect.top,
        viewportBottom: viewport.bottom,
        viewportTop: viewport.top,
      },
    };
  }, expectedLine);
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_large_body_paste",
    metadata: { title: "大量本文ペースト" },
    content: [{
      type: "paragraph",
      id: "paste_target",
      children: [{ type: "text", text: "seed-" }],
    }],
    outputProfiles: {
      student: { showSolutions: false, showHints: false, includeAnswers: false },
      teacher: { showSolutions: true, showHints: true, includeAnswers: true, includeComments: true },
      answerBook: { showSolutions: true, showHints: false, includeAnswers: true, onlySolutions: true },
    },
  } as SigmaDocument;
}
