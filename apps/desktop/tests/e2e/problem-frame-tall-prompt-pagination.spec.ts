import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

for (const { mode, styleId } of [
  { mode: "single", styleId: "fancybox" },
  { mode: "single", styleId: "doublebox" },
  { mode: "single", styleId: "cornerbox" },
  { mode: "columns", styleId: "fancybox" },
] as const) {
  test(`splits a tall ${styleId} prompt without crossing page gaps in ${mode} editor flow`, async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await installDesktopRuntimeMock(page, createTallPromptDocument(mode === "columns" ? 2 : 1, styleId));
    await openEditorAndWaitForStablePagination(page, '[data-sigma-doc-id^="tall_prompt_"]');

    const first = await readTallFrameEditorGeometry(page);
    expect(first.pageCount).toBeGreaterThanOrEqual(2);
    expect(first.framePieceCount).toBeGreaterThanOrEqual(2);
    expect(first.promptPageCount).toBeGreaterThanOrEqual(2);
    expect(first.crossingGapCount).toBe(0);
    if (styleId === "fancybox") {
      expect(first.borderRolesCorrect).toBe(true);
    }
    expect(first.solutionTop).toBeGreaterThanOrEqual(first.promptBottom);
    expect(first.outerBackgroundColor).toBe("rgba(0, 0, 0, 0)");

    await page.waitForTimeout(2500);
    const second = await readTallFrameEditorGeometry(page);
    expect(second).toEqual(first);
    expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
  });
}

for (const { mode, promptParagraphCount, boundaryLabel } of [
  { mode: "single", promptParagraphCount: 3, boundaryLabel: "" },
  { mode: "single", promptParagraphCount: 2, boundaryLabel: " at the lead-unit boundary" },
  { mode: "columns", promptParagraphCount: 2, boundaryLabel: "" },
] as const) {
  test(`keeps a short framed prompt whole and moves it to the next ${mode === "single" ? "page" : "column or page"}${boundaryLabel}`, async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await installDesktopRuntimeMock(page, createShortPromptDocument(
      mode === "columns" ? 2 : 1,
      promptParagraphCount,
    ));
    await openEditorAndWaitForStablePagination(page, '[data-sigma-doc-id^="short_prompt_"]');

    const first = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    const prompt = document.querySelector<HTMLElement>(
      '[data-problem-area="prompt"][data-problem-id="short_frame_problem"]',
    );
    const intro = Array.from(document.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="short_intro_"]')).at(-1);
    const lead = document.querySelector<HTMLElement>(
      '[data-problem-area="lead"][data-problem-id="short_frame_problem"]',
    );
    if (!canvas || !prompt || !intro || !lead) {
      throw new Error("short framed prompt geometry was not rendered");
    }
    const canvasRect = canvas.getBoundingClientRect();
    const stride = Number(canvas.dataset.pageStride ?? "0");
    const relative = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top - canvasRect.top, bottom: rect.bottom - canvasRect.top, left: rect.left - canvasRect.left };
    };
    const promptRect = relative(prompt);
    const introRect = relative(intro);
    const leadRect = relative(lead);
    return {
      pageCount: Number(canvas.dataset.pageCount ?? "0"),
      promptStartPage: Math.floor((promptRect.top + 1) / stride),
      promptEndPage: Math.floor((promptRect.bottom - 1) / stride),
      introEndPage: Math.floor((introRect.bottom - 1) / stride),
      movedForward: Math.floor((promptRect.top + 1) / stride) > Math.floor((introRect.bottom - 1) / stride)
        || promptRect.left > introRect.left + 1,
      remainingBeforePrompt: Math.floor((introRect.bottom - 1) / stride) * stride
        + Number(canvas.dataset.pageHeight ?? "0")
        - Number.parseFloat(getComputedStyle(document.querySelector<HTMLElement>(".page-flow") ?? canvas)
          .getPropertyValue("--page-margin-bottom") || "0")
        - introRect.bottom,
      promptHeight: promptRect.bottom - promptRect.top,
      leadHeight: leadRect.bottom - leadRect.top,
      leadStartPage: Math.floor((leadRect.top + 1) / stride),
      leadLeft: leadRect.left,
      promptLeft: promptRect.left,
      leadBottom: leadRect.bottom,
      promptTop: promptRect.top,
      leadHasPositiveBlockSpacer: Array.from(
        lead.querySelectorAll<HTMLElement>("[data-page-break-spacer]"),
      ).some((spacer) => spacer.offsetHeight > 0),
      framePieceCount: prompt.querySelectorAll(':scope > [aria-hidden="true"].problem-area-flow-unit.with-frame').length,
    };
    });

    expect(first.promptStartPage).toBe(first.promptEndPage);
    if (boundaryLabel) {
      // The intro rect ends inside its text-flow shell. Account for the shell/unit
      // spacing before the lead when checking the pre-pagination boundary.
      expect(first.remainingBeforePrompt).toBeGreaterThanOrEqual(first.promptHeight);
      expect(first.remainingBeforePrompt).toBeLessThan(first.leadHeight + first.promptHeight + 16);
    } else {
      expect(first.remainingBeforePrompt).toBeLessThan(first.leadHeight + first.promptHeight);
    }
    expect(first.movedForward).toBe(true);
    expect(first.leadStartPage).toBe(first.promptStartPage);
    expect(first.leadLeft).toBeCloseTo(first.promptLeft, 0);
    expect(first.leadBottom).toBeLessThanOrEqual(first.promptTop + 1);
    if (mode === "single") {
      expect(first.leadHasPositiveBlockSpacer).toBe(false);
    }
    expect(first.framePieceCount).toBe(0);
    await page.waitForTimeout(2500);
    expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
  });
}

for (const columnCount of [1, 2] as const) {
test(`prints open-edged framed prompt fragments on bounded pages in ${columnCount} column flow`, async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, createTallPromptDocument(columnCount));
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toBeVisible({ timeout: 30_000 });
  const pages = page.locator(".paged-surface-page");
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => pages.count()).toBeGreaterThan(1);

  const read = async () => page.evaluate(() => {
    const surfacePages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    const sourcePage = surfacePages[0];
    const canvas = sourcePage?.querySelector<HTMLElement>(".page-canvas");
    if (!sourcePage || !canvas) throw new Error("print page canvas was not rendered");
    const sourcePageRect = sourcePage.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const pageHeight = Number(canvas.dataset.pageHeight ?? "0");
    const stride = Number(canvas.dataset.pageStride ?? "0");
    const scale = pageHeight > 0 ? sourcePageRect.height / pageHeight : 1;
    const pieces = Array.from(sourcePage.querySelectorAll<HTMLElement>(
      "[aria-hidden='true'].problem-area-flow-unit.with-frame",
    ));
    const canvasGeometry = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        top: (rect.top - canvasRect.top) / scale,
        bottom: (rect.bottom - canvasRect.top) / scale,
      };
    };
    const locate = (role: "first" | "last") => {
      const matches = pieces.filter((piece) => piece.classList.contains(`${role}-frame-area`)).map((piece) => {
        const geometry = canvasGeometry(piece);
        const page = Math.floor((geometry.top + 1) / stride);
        const pageRect = surfacePages[page]?.getBoundingClientRect();
        if (!pageRect) return { page, overflow: true };
        const visibleTop = pageRect.top + (geometry.top - page * stride) * scale;
        const visibleBottom = pageRect.top + (geometry.bottom - page * stride) * scale;
        const intersectsPage = visibleBottom > pageRect.top + 0.5 && visibleTop < pageRect.bottom - 0.5;
        return { page, overflow: !intersectsPage || visibleBottom > pageRect.bottom + 1 };
      });
      return matches.sort((left, right) => left.page - right.page)[role === "first" ? 0 : matches.length - 1]
        ?? { page: -1, overflow: true };
    };
    const borders = pieces.map((piece) => {
      const style = getComputedStyle(piece);
      return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
    });
    return { pageCount: surfacePages.length, first: locate("first"), last: locate("last"), borders };
  });

  const first = await read();
  expect(first.first.page).toBeGreaterThanOrEqual(0);
  expect(first.last.page).toBeGreaterThan(first.first.page);
  expect(first.first.overflow).toBe(false);
  expect(first.last.overflow).toBe(false);
  expect(first.borders.length).toBeGreaterThanOrEqual(3);
  expect(first.borders[0]).toEqual({ top: "1px", bottom: "0px" });
  expect(first.borders.slice(1, -1).every((border) => border.top === "0px" && border.bottom === "0px")).toBe(true);
  expect(first.borders.at(-1)).toEqual({ top: "0px", bottom: "1px" });
  await page.waitForTimeout(2500);
  expect(await read()).toEqual(first);
  expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
});
}

for (const columnCount of [1, 2] as const) {
test(`prints a fitting framed prompt as one moved unit in ${columnCount} column flow`, async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, createShortPromptDocument(columnCount));
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toBeVisible({ timeout: 30_000 });
  const pages = page.locator(".paged-surface-page");
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  const lastIntroId = shortIntroLastId(columnCount);
  const introPage = pages.filter({ has: page.locator(`[data-sigma-doc-id="${lastIntroId}"]`) });
  const leadPage = pages.filter({
    has: page.locator('[data-sigma-doc-id="short_frame_problem_lead_empty"]'),
  });
  const promptPage = pages.filter({ has: page.locator('[data-sigma-doc-id="short_prompt_1"]') });
  await expect(introPage).toHaveCount(1, { timeout: 30_000 });
  await expect(leadPage).toHaveCount(1, { timeout: 30_000 });
  await expect(promptPage).toHaveCount(1, { timeout: 30_000 });

  const introPageNumber = Number(await introPage.getAttribute("data-page-number"));
  const leadPageNumber = Number(await leadPage.getAttribute("data-page-number"));
  const promptPageNumber = Number(await promptPage.getAttribute("data-page-number"));
  expect(leadPageNumber).toBe(promptPageNumber);
  expect(introPageNumber).toBeLessThanOrEqual(promptPageNumber);
  if (columnCount > 1 && introPageNumber === promptPageNumber) {
    const introBox = await introPage.locator(`[data-sigma-doc-id="${lastIntroId}"]`).boundingBox();
    const promptBox = await promptPage.locator('[data-sigma-doc-id="short_prompt_1"]').boundingBox();
    expect(introBox).not.toBeNull();
    expect(promptBox).not.toBeNull();
    expect(promptBox!.x).toBeGreaterThan(introBox!.x + 1);
  }
  await expect(promptPage.locator(
    '[data-problem-area="prompt"][data-problem-id="short_frame_problem"]'
      + ' > [aria-hidden="true"].with-frame',
  )).toHaveCount(0);
  await page.waitForTimeout(2500);
  expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
});
}

async function openEditorAndWaitForStablePagination(page: Page, selector: string) {
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".page-backdrop .a4-page-sheet").first()).toBeVisible({ timeout: 30_000 });
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80 && stable < 5; attempt += 1) {
    const signature = await page.evaluate((targetSelector) => {
      const canvas = document.querySelector(".page-canvas");
      const pageCount = canvas?.getAttribute("data-page-count") ?? "0";
      const spacers = Array.from(document.querySelectorAll<HTMLElement>("[data-page-break-spacer]"))
        .map((element) => element.offsetHeight);
      const tops = Array.from(document.querySelectorAll<HTMLElement>(targetSelector)).slice(0, 8)
        .map((element) => Math.round(element.getBoundingClientRect().top));
      return `${pageCount}|${spacers.join(",")}|${tops.join(",")}`;
    }, selector);
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    await page.waitForTimeout(150);
  }
}

async function readTallFrameEditorGeometry(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    const area = document.querySelector<HTMLElement>(
      '[data-problem-area="prompt"][data-problem-id="tall_frame_problem"]',
    );
    if (!canvas || !area) {
      throw new Error("tall framed prompt geometry was not rendered");
    }
    const canvasRect = canvas.getBoundingClientRect();
    const pageHeight = Number(canvas.dataset.pageHeight ?? "0");
    const stride = Number(canvas.dataset.pageStride ?? "0");
    const relative = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top - canvasRect.top, bottom: rect.bottom - canvasRect.top };
    };
    const pageIndex = (y: number) => Math.floor(Math.max(0, y) / stride);
    const crossesGap = ({ top, bottom }: { top: number; bottom: number }) => {
      const firstPage = pageIndex(top + 1);
      const lastPage = pageIndex(bottom - 1);
      return firstPage !== lastPage || bottom - firstPage * stride > pageHeight + 1;
    };
    const blocks = Array.from(area.querySelectorAll<HTMLElement>('[data-sigma-doc-id^="tall_prompt_"]'))
      .map(relative).filter((rect) => rect.bottom > rect.top + 0.5);
    const pieceElements = Array.from(area.querySelectorAll<HTMLElement>(
      ':scope > [aria-hidden="true"].problem-area-flow-unit.with-frame',
    ));
    const pieces = pieceElements.map(relative);
    const borders = pieceElements.map((piece) => {
      const style = getComputedStyle(piece);
      return { top: style.borderTopWidth, bottom: style.borderBottomWidth };
    });
    const borderRolesCorrect = borders.length >= 2
      && borders[0].top === "1px"
      && borders[0].bottom === "0px"
      && borders.slice(1, -1).every((border) => border.top === "0px" && border.bottom === "0px")
      && borders.at(-1)?.bottom === "1px";
    const solution = Array.from(document.querySelectorAll<HTMLElement>(
      '[data-problem-area="solution"][data-problem-id="tall_frame_problem"] [data-sigma-doc-id^="tall_solution_"]',
    )).map(relative);
    return {
      pageCount: Number(canvas.dataset.pageCount ?? "0"),
      framePieceCount: pieces.length,
      promptPageCount: new Set([...blocks, ...pieces].map((rect) => pageIndex(rect.top + 1))).size,
      crossingGapCount: [...blocks, ...pieces].filter(crossesGap).length,
      borderRolesCorrect,
      outerBackgroundColor: getComputedStyle(area).backgroundColor,
      promptBottom: Math.max(...blocks.map((rect) => rect.bottom), ...pieces.map((rect) => rect.bottom)),
      solutionTop: Math.min(...solution.map((rect) => rect.top)),
    };
  });
}

function createTallPromptDocument(
  columnCount: number,
  styleId: "fancybox" | "doublebox" | "cornerbox" = "fancybox",
): SigmaDocument {
  const prompt = Array.from({ length: 40 }, (_, index) => paragraph(
    `tall_prompt_${index}`,
    `枠付き問題文 ${index + 1}: 条件を整理し、式の意味と場合分けを確認してから答えなさい。`.repeat(2),
  ));
  return documentWithContent([
    paragraph("tall_intro", "長い枠付き問題文の検収。"),
    {
      type: "problem",
      id: "tall_frame_problem",
      tags: [],
      lead: [],
      prompt,
      hints: [],
      solution: [paragraph("tall_solution_1", "枠付き問題文の後に続く解答。")],
      frame: { enabled: true, styleId },
    },
  ], columnCount, "tall_frame_doc");
}

function createShortPromptDocument(
  columnCount: number,
  promptParagraphCount = columnCount > 1 ? 2 : 3,
): SigmaDocument {
  const intro = Array.from({ length: shortIntroCount(columnCount) }, (_, index) => paragraph(
    `short_intro_${index}`,
    `前置き ${index + 1}: ページ末尾の残りを小さくする本文。`.repeat(3),
  ));
  return documentWithContent([
    ...intro,
    {
      type: "problem",
      id: "short_frame_problem",
      tags: [],
      lead: [],
      prompt: Array.from({ length: promptParagraphCount }, (_, index) => paragraph(
        `short_prompt_${index + 1}`,
        `短い枠付き問題文 ${index + 1}。`,
      )),
      hints: [],
      solution: [paragraph("short_solution_1", "短い解答。")],
      frame: { enabled: true, styleId: "fancybox" },
    },
  ], columnCount, `short_frame_${columnCount}_doc`);
}

function shortIntroCount(columnCount: number): number {
  return columnCount > 1 ? 22 : 9;
}

function shortIntroLastId(columnCount: number): string {
  return `short_intro_${shortIntroCount(columnCount) - 1}`;
}

function documentWithContent(content: SigmaDocument["content"], columnCount: number, docId: string): SigmaDocument {
  return {
    version: "2.0",
    docId,
    metadata: { title: "枠付き問題文の改ページ検収" },
    content,
    outputProfiles: {
      student: { showSolutions: false },
      teacher: { showSolutions: true },
      answerBook: { onlySolutions: true, showSolutions: true },
    },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 120, heightMm: 150 },
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
      flow: { type: "columns", columnCount, columnGapMm: columnCount > 1 ? 6 : 0 },
    },
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  return errors;
}

function relevantConsoleErrors(errors: string[]): string[] {
  return errors.filter((text) => !text.includes("favicon")
    && !text.includes("Download the React DevTools")
    && !text.includes("hydration-mismatch")
    && !text.includes("hydrated"));
}
