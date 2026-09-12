import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_print_problem_column_flow",
  metadata: { title: "問題エリアの印刷段組みフロー確認" },
  content: [
    {
      type: "problem",
      id: "print_column_flow_problem",
      tags: [],
      numbering: { enabled: false },
      lead: [],
      prompt: [],
      solution: Array.from({ length: 10 }, (_, index) => ({
        type: "paragraph" as const,
        id: `print_column_flow_solution_${index + 1}`,
        children: [{ type: "text" as const, text: `解答 ${index + 1}` }],
      })),
      hints: [],
    },
  ],
  outputProfiles: {
    student: { showSolutions: false },
    teacher: { showSolutions: true },
    answerBook: { onlySolutions: true, showSolutions: true },
  },
  pageLayout: {
    preset: "custom",
    orientation: "portrait",
    pageSize: { widthMm: 80, heightMm: 90 },
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  },
};

test("flows an unframed problem area through both print columns on one page", async ({ page }) => {
  await installDesktopRuntimeMock(page, DOCUMENT);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });

  const pages = page.locator(".paged-surface-page");
  await expect(pages).toHaveCount(1);

  // The printed page carries the editor's markup, where columns are absolute placement
  // rather than column containers — so "flowed through both columns" is a statement about
  // geometry: the area's blocks occupy two distinct left offsets on the one page.
  const columnLefts = await page.evaluate(() => {
    const printedPage = document.querySelector<HTMLElement>(".paged-surface-page");
    if (!printedPage) {
      return [];
    }
    const pageLeft = printedPage.getBoundingClientRect().left;
    const lefts = Array.from(printedPage.querySelectorAll<HTMLElement>("[data-sigma-doc-id]"))
      .map((element) => Math.round((element.getBoundingClientRect().left - pageLeft) * 10) / 10);
    return Array.from(new Set(lefts)).sort((a, b) => a - b);
  });
  expect(columnLefts.length).toBe(2);
  expect(columnLefts[1]).toBeGreaterThan(columnLefts[0]);
  await expect(page.locator('[data-paged-surface-page-count="1"]')).toBeVisible();
});
