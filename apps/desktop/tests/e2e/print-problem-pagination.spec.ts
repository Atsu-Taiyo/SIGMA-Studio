import { expect, test } from "@playwright/test";

import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

const DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_print_problem_pagination",
  metadata: { title: "問題と解答の改ページ確認" },
  content: [
    {
      type: "paragraph",
      id: "before_problem",
      children: [{ type: "text", text: "問題の前にある本文" }],
    },
    {
      type: "problem",
      id: "kept_problem",
      tags: [],
      numbering: { enabled: false },
      lead: [],
      prompt: [{
        type: "paragraph",
        id: "kept_prompt",
        children: [{ type: "text", text: "問題文" }],
      }],
      solution: [{
        type: "paragraph",
        id: "kept_solution",
        children: [{ type: "text", text: "解答" }],
      }],
      hints: [],
      frame: { enabled: true },
      areaLayout: {
        prompt: { minHeightMm: 32 },
        solution: { minHeightMm: 32 },
      },
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
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  },
};

/**
 * エリア単位 keep-together を固定する（問題全体をまとめて動かす規則は 3 エンジン統一で撤去済み）。
 * 各エリアは自分の予約込みで残りに収まるページに置かれ、90mm 文書では prompt が 1 ページ目、
 * solution が 2 ページ目に置かれる。どちらも予約高さを確保し、紙面外へはみ出さない。
 */
test("places the 90mm prompt and solution by area without overflowing either reservation", async ({ page }) => {
  await installDesktopRuntimeMock(page, DOCUMENT);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });

  const pages = page.locator(".paged-surface-page");
  await expect(pages).toHaveCount(2);
  await expect(pages.nth(0).locator('[data-sigma-doc-id="before_problem"]')).toBeVisible();
  await expect(pages.nth(0).locator('[data-sigma-doc-id="kept_prompt"]')).toBeVisible();
  await expect(pages.nth(0).locator('[data-sigma-doc-id="kept_solution"]')).toHaveCount(0);
  await expect(pages.nth(1).locator('[data-sigma-doc-id="kept_prompt"]')).toHaveCount(0);
  await expect(pages.nth(1).locator('[data-sigma-doc-id="kept_solution"]')).toBeVisible();

  const areas = await page.evaluate(() => {
    const pageElements = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    return ["kept_prompt", "kept_solution"].map((id) => {
      const area = pageElements
        .map((pageElement) => pageElement.querySelector<HTMLElement>(`[data-sigma-doc-id="${id}"]`)?.closest<HTMLElement>(".problem-area-flow-unit"))
        .find((candidate) => candidate);
      const pageElement = area?.closest<HTMLElement>(".paged-surface-page");
      if (!area || !pageElement) return null;
      const rect = area.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      return {
        height: rect.height,
        insidePage: rect.top >= pageRect.top - 0.5
          && rect.left >= pageRect.left - 0.5
          && rect.bottom <= pageRect.bottom + 0.5
          && rect.right <= pageRect.right + 0.5,
      };
    });
  });
  expect(areas).not.toBeNull();
  expect(areas).not.toContain(null);
  for (const area of areas!) {
    expect(area!.height).toBeGreaterThanOrEqual(32 * (96 / 25.4) - 1);
    expect(area!.insidePage).toBe(true);
  }
});


/**
 * エリア単位 keep-together を固定する（問題全体をまとめて動かす規則は 3 エンジン統一で撤去済み）。
 * 各エリアは自分の予約込みで残りに収まるページに置かれる。
 */
const RESERVED_AREA_DOCUMENT: SigmaDocument = {
  version: "2.0",
  docId: "doc_reserved_area_keep_together",
  metadata: { title: "解答欄の確保とページ送り" },
  content: [
    ...Array.from({ length: 6 }, (_, index) => ({
      type: "paragraph" as const,
      id: `filler_${index + 1}`,
      children: [{ type: "text" as const, text: `本文 ${index + 1} 行目のサンプルです` }],
    })),
    {
      type: "problem",
      id: "reserved_problem",
      tags: [],
      numbering: { enabled: false },
      lead: [],
      prompt: [{ type: "paragraph", id: "reserved_prompt", children: [{ type: "text", text: "問題文" }] }],
      solution: [{ type: "paragraph", id: "reserved_solution", children: [{ type: "text", text: "解答" }] }],
      hints: [],
      frame: { enabled: true },
      areaLayout: {
        prompt: { minHeightMm: 22 },
        solution: { minHeightMm: 22 },
      },
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
    pageSize: { widthMm: 90, heightMm: 110 },
    marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
    flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
  },
};

test("places the 110mm prompt and solution on separate pages and keeps both areas in bounds", async ({ page }) => {
  test.setTimeout(120_000);
  await installDesktopRuntimeMock(page, RESERVED_AREA_DOCUMENT);
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toHaveCount(1);

  const pages = page.locator(".paged-surface-page");
  await expect(pages).toHaveCount(2);
  await expect(pages.nth(0).locator('[data-sigma-doc-id="reserved_prompt"]')).toBeVisible();
  await expect(pages.nth(0).locator('[data-sigma-doc-id="reserved_solution"]')).toHaveCount(0);
  await expect(pages.nth(1).locator('[data-sigma-doc-id="reserved_prompt"]')).toHaveCount(0);
  await expect(pages.nth(1).locator('[data-sigma-doc-id="reserved_solution"]')).toBeVisible();

  // 各エリアが予約高さを確保し、紙面外へはみ出さない。
  const areas = await page.evaluate(() => {
    const pageElements = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    return ["reserved_prompt", "reserved_solution"].map((id) => {
      const area = pageElements
        .map((pageElement) => pageElement.querySelector<HTMLElement>(`[data-sigma-doc-id="${id}"]`)?.closest<HTMLElement>(".problem-area-flow-unit"))
        .find((candidate) => candidate);
      const pageElement = area?.closest<HTMLElement>(".paged-surface-page");
      if (!area || !pageElement) return null;
      const rect = area.getBoundingClientRect();
      const pageRect = pageElement.getBoundingClientRect();
      return {
        height: rect.height,
        insidePage: rect.top >= pageRect.top - 0.5
          && rect.left >= pageRect.left - 0.5
          && rect.bottom <= pageRect.bottom + 0.5
          && rect.right <= pageRect.right + 0.5,
      };
    });
  });
  expect(areas).not.toBeNull();
  expect(areas).not.toContain(null);
  for (const area of areas!) {
    expect(area!.height).toBeGreaterThanOrEqual(22 * (96 / 25.4) - 1);
    expect(area!.insidePage).toBe(true);
  }
});
