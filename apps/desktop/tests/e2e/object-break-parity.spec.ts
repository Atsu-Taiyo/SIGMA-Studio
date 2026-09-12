import { expect, test, type Page } from "@playwright/test";

import { createBoxBlock } from "@/lib/box-blocks";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { waitForPagedSurfaceSettled } from "./paged-surface";

/**
 * issue #315: a manual 改ページ placed inside an object (a problem area, a framed prompt,
 * a box) used to move content in one engine and not the other — the editor lays out by
 * measured absolute placement, print runs its own pagination. These specs pin the two to
 * the same answer: the block carrying the break must start a later page/column than its
 * predecessor in BOTH the editor canvas and the print preview.
 */

const SHORT_PAGE = {
  preset: "custom" as const,
  orientation: "portrait" as const,
  pageSize: { widthMm: 90, heightMm: 100 },
  marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
};

function documentWith(content: SigmaDocument["content"], columnCount: number): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_object_break_parity",
    metadata: { title: "オブジェクト内改ページのパリティ確認" },
    content,
    outputProfiles: {
      student: { showSolutions: false },
      teacher: { showSolutions: true },
      answerBook: { onlySolutions: true, showSolutions: true },
    },
    pageLayout: {
      ...SHORT_PAGE,
      flow: { type: "columns", columnCount, columnGapMm: 8 },
    },
  };
}

function paragraphs(prefix: string, count: number, breakAt?: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "paragraph" as const,
    id: `${prefix}_${index + 1}`,
    children: [{ type: "text" as const, text: `${prefix} ${index + 1}` }],
    ...(index + 1 === breakAt ? { pagination: { break: true as const } } : {}),
  }));
}

/**
 * Which page sheet each id sits on in the editor canvas, by geometry — the editor has no
 * per-page DOM container, blocks are absolutely placed over a backdrop of page sheets.
 */
async function editorPageIndexes(page: Page, ids: string[]): Promise<Record<string, number>> {
  return page.evaluate((blockIds) => {
    const sheets = Array.from(document.querySelectorAll<HTMLElement>(".page-backdrop .a4-page-sheet"))
      .map((sheet) => sheet.getBoundingClientRect());
    const result: Record<string, number> = {};
    for (const id of blockIds) {
      const element = document.querySelector<HTMLElement>(`.page-flow [data-sigma-doc-id="${id}"]`);
      if (!element) {
        continue;
      }
      const rect = element.getBoundingClientRect();
      const center = rect.top + rect.height / 2;
      const index = sheets.findIndex((sheet) => center >= sheet.top && center <= sheet.bottom);
      result[id] = index >= 0
        ? index
        // A block past the last sheet bottom still belongs after it; clamp rather than
        // reporting -1 so a mismatch reads as a page number, not "missing".
        : sheets.findIndex((sheet) => center < sheet.top);
    }
    return result;
  }, ids);
}

/** Which printed page each id sits on, counted over `.paged-surface-page` windows. */
async function printPageIndexes(page: Page, ids: string[]): Promise<Record<string, number>> {
  return page.evaluate((blockIds) => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    const result: Record<string, number> = {};
    for (const id of blockIds) {
      // Scoped to `.page-flow` to match `editorPageIndexes`: a split frame also renders
      // the block inside a fragment preview outside the flow, and counting that copy
      // would report the piece the editor side never looks at.
      const index = pages.findIndex((printPage) => printPage.querySelector(`.page-flow [data-sigma-doc-id="${id}"]`));
      if (index >= 0) {
        result[id] = index;
      }
    }
    return result;
  }, ids);
}

async function columnIndexes(
  page: Page,
  ids: string[],
  scopeSelector: string,
): Promise<Record<string, number>> {
  return page.evaluate(({ blockIds, scope }) => {
    const result: Record<string, number> = {};
    const lefts = blockIds
      .map((id) => document.querySelector<HTMLElement>(
        `${scope} [data-sigma-doc-id="${id}"]`,
      ))
      .map((element) => element?.getBoundingClientRect().left ?? Number.NaN);
    const distinctLefts = Array.from(new Set(
      lefts.filter((left) => Number.isFinite(left)),
    )).sort((a, b) => a - b);
    blockIds.forEach((id, index) => {
      result[id] = distinctLefts.findIndex((left) => Math.abs(left - lefts[index]) < 2);
    });
    return result;
  }, { blockIds: ids, scope: scopeSelector });
}

async function openEditor(page: Page, document: SigmaDocument) {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect(page.locator(".page-flow")).toHaveCount(1);
  await page.waitForTimeout(1200);
}

async function openPrint(page: Page, document: SigmaDocument) {
  await installDesktopRuntimeMock(page, document);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);
  await expect(page.locator(".paged-surface-page").first()).toBeVisible();
  await waitForPagedSurfaceSettled(page);
}

test("a manual break in the 解答 area moves content in both the editor and the PDF", async ({ page }) => {
  test.setTimeout(90_000);
  const ids = ["parity_solution_1", "parity_solution_2"];
  const document = documentWith([
    {
      type: "problem",
      id: "parity_problem",
      tags: [],
      numbering: { enabled: false },
      lead: [],
      prompt: paragraphs("parity_prompt", 1),
      solution: paragraphs("parity_solution", 2, 2),
      hints: [],
    },
  ], 1);

  await openEditor(page, document);
  const editorPages = await editorPageIndexes(page, ids);
  expect(editorPages.parity_solution_2).toBeGreaterThan(editorPages.parity_solution_1);

  await openPrint(page, document);
  const printPages = await printPageIndexes(page, ids);
  expect(printPages.parity_solution_2).toBeGreaterThan(printPages.parity_solution_1);

  // The engines must agree on the page delta, not merely each move something.
  expect(printPages.parity_solution_2 - printPages.parity_solution_1)
    .toBe(editorPages.parity_solution_2 - editorPages.parity_solution_1);
});

test("a manual break in a 枠付き問題文 splits the frame in both the editor and the PDF", async ({ page }) => {
  test.setTimeout(90_000);
  const ids = ["parity_framed_1", "parity_framed_2"];
  const document = documentWith([
    {
      type: "problem",
      id: "parity_framed_problem",
      tags: [],
      numbering: { enabled: false },
      frame: { enabled: true },
      lead: [],
      prompt: paragraphs("parity_framed", 2, 2),
      solution: [],
      hints: [],
    },
  ], 1);

  await openEditor(page, document);
  const editorPages = await editorPageIndexes(page, ids);
  expect(editorPages.parity_framed_2).toBeGreaterThan(editorPages.parity_framed_1);
  // The frame renders open across the break rather than closing on the first piece.
  await expect(page.locator(".problem-area-frame-piece, .problem-area-flow-unit.with-frame").first()).toBeVisible();

  await openPrint(page, document);
  const printPages = await printPageIndexes(page, ids);
  expect(printPages.parity_framed_2).toBeGreaterThan(printPages.parity_framed_1);
  // Same frame-piece markup as the editor now, rather than a print-only fragment role.
  await expect(page.locator(
    ".paged-surface-page .problem-area-frame-piece, .paged-surface-page .problem-area-flow-unit.with-frame",
  ).first()).toBeVisible();
});

test("a manual break in a box-local layout becomes an inner column break in both the editor and the PDF", async ({ page }) => {
  test.setTimeout(90_000);
  const box = createBoxBlock("itembox", "", { id: "parity_box", bodyId: "parity_box_body_1" });
  box.blocks = [{
    type: "layoutSection",
    id: "parity_box_columns",
    layout: { columnCount: 2, columnGapMm: 8 },
    // Without the manual break CSS balancing would place the first two blocks in the
    // first column. A break on block 2 must instead leave block 1 alone in that column.
    children: paragraphs("parity_box_body", 4, 2),
  }];
  const document = documentWith([box], 1);
  const ids = ["parity_box_body_1", "parity_box_body_2", "parity_box_body_4"];

  await openEditor(page, document);
  await expect(page.locator('[data-sigma-doc-id="parity_box_body_2"]').first())
    .toHaveClass(/manual-column-break-before/);
  await expect(page.locator('[data-page-break-block-id="parity_box_body_2"]')).toContainText("改段");
  await expect(page.locator('.editor-box-fragment-viewport[data-box-source-id="parity_box"]')).toHaveCount(0);
  const editorColumns = await columnIndexes(page, ids, ".page-flow");
  expect(editorColumns.parity_box_body_2).toBeGreaterThan(editorColumns.parity_box_body_1);
  expect(editorColumns.parity_box_body_4).toBe(editorColumns.parity_box_body_2);

  await openPrint(page, document);
  // The printed page carries the editor's own markup now, so the break is the same
  // `manual-column-break-before` decoration rather than a print-only class.
  await expect(page.locator(
    '.paged-surface-page [data-sigma-doc-id="parity_box_body_2"].manual-column-break-before',
  )).toHaveCount(1);
  await expect(page.locator('.paged-surface-page .editor-box-fragment-viewport')).toHaveCount(0);
  const printColumns = await columnIndexes(page, ids, ".paged-surface-page");
  expect(printColumns.parity_box_body_2).toBeGreaterThan(printColumns.parity_box_body_1);
  expect(printColumns.parity_box_body_4).toBe(printColumns.parity_box_body_2);
  expect(printColumns.parity_box_body_2 - printColumns.parity_box_body_1)
    .toBe(editorColumns.parity_box_body_2 - editorColumns.parity_box_body_1);
});
