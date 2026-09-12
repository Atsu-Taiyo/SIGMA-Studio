import { expect, test } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("flows a long solution through page columns and onto the next page", async ({ page }) => {
  test.setTimeout(60_000);

  await page.setViewportSize({ width: 1700, height: 1200 });
  await installDesktopRuntimeMock(page, createProblemColumnFlowDocument());
  await page.goto("/");
  await page.waitForTimeout(1800);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);
  await expect.poll(async () => page.locator(".page-backdrop .a4-page-sheet").count()).toBeGreaterThan(1);
  await expect.poll(async () => page.locator('[data-problem-area="solution"] .text-flow-column-block').count()).toBe(12);

  const proof = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    const canvasRect = canvas?.getBoundingClientRect();
    const canvasStyle = canvas ? getComputedStyle(canvas) : null;
    const pageHeight = canvasStyle ? parseFloat(canvasStyle.getPropertyValue("--page-height")) : 0;
    const pageGap = canvasStyle ? parseFloat(canvasStyle.getPropertyValue("--page-gap")) : 0;
    const marginTop = canvasStyle ? parseFloat(canvasStyle.getPropertyValue("--page-margin-top")) : 0;
    const marginBottom = canvasStyle ? parseFloat(canvasStyle.getPropertyValue("--page-margin-bottom")) : 0;
    const pageStride = pageHeight + pageGap;
    const area = document.querySelector<HTMLElement>('[data-problem-area="solution"]');
    const first = document.querySelector<HTMLElement>('[data-sigma-doc-id="solution_flow_0"]');
    const sideNotes = area?.querySelectorAll<HTMLElement>(":scope > .problem-area-side-note") ?? [];
    const sideNote = sideNotes[0]?.querySelector<HTMLElement>("span");
    const firstRect = first?.getBoundingClientRect();
    const sideNoteRect = sideNote?.getBoundingClientRect();
    const blocks = Array.from(document.querySelectorAll<HTMLElement>('[data-problem-area="solution"] [data-sigma-doc-id^="solution_flow_"]'))
      .map((element) => {
        const rect = element.getBoundingClientRect();
        const top = canvasRect ? rect.top - canvasRect.top : 0;
        const bottom = canvasRect ? rect.bottom - canvasRect.top : 0;
        const left = canvasRect ? rect.left - canvasRect.left : 0;
        const pageIndex = pageStride > 0 ? Math.floor(Math.max(0, top) / pageStride) : 0;
        return {
          bottomInPage: bottom - pageIndex * pageStride,
          left,
          pageIndex,
          position: getComputedStyle(element).position,
          topInPage: top - pageIndex * pageStride,
        };
      });
    const firstPageLefts = blocks.filter((block) => block.pageIndex === 0).map((block) => block.left);
    const firstColumnLeft = firstPageLefts.length > 0 ? Math.min(...firstPageLefts) : 0;

    return {
      blockCount: blocks.length,
      belowContentBottom: blocks.filter((block) => block.bottomInPage > pageHeight - marginBottom + 1).length,
      beforeContentTop: blocks.filter((block) => block.topInPage < marginTop - 1).length,
      leftColumnBlocks: blocks.filter((block) => block.pageIndex === 0 && block.left < firstColumnLeft + 50).length,
      nextPageBlocks: blocks.filter((block) => block.pageIndex > 0).length,
      positionedBlocks: blocks.filter((block) => block.position === "absolute").length,
      rightColumnBlocks: blocks.filter((block) => block.pageIndex === 0 && block.left > firstColumnLeft + 50).length,
      sideNoteCount: sideNotes.length,
      sideNoteStartsBesideFirstBlock: Boolean(
        firstRect && sideNoteRect &&
        sideNoteRect.right <= firstRect.left &&
        firstRect.left - sideNoteRect.right < 50 &&
        Math.abs((sideNoteRect.top + sideNoteRect.height / 2) - (firstRect.top + 16)) < 3,
      ),
    };
  });

  expect(proof.blockCount).toBe(12);
  expect(proof.positionedBlocks).toBe(12);
  expect(proof.leftColumnBlocks).toBeGreaterThan(0);
  expect(proof.rightColumnBlocks).toBeGreaterThan(0);
  expect(proof.nextPageBlocks).toBeGreaterThan(0);
  expect(proof.beforeContentTop).toBe(0);
  expect(proof.belowContentBottom).toBe(0);
  expect(proof.sideNoteCount).toBe(1);
  expect(proof.sideNoteStartsBesideFirstBlock).toBe(true);
});

function createProblemColumnFlowDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_problem_page_column_flow";
  document.metadata = { title: "Problem page column flow E2E" };
  document.comments = [];
  document.content = [
    {
      type: "problem",
      id: "problem_column_flow",
      tags: [],
      lead: [],
      prompt: [{
        type: "paragraph",
        id: "problem_column_flow_prompt",
        children: [{
          type: "text",
          text: "問題文の末尾近くから解答が始まる配置を作ります。".repeat(2),
        }],
      }],
      answer: { type: "math", expected: "" },
      solution: Array.from({ length: 12 }, (_, index) => ({
        type: "paragraph" as const,
        id: `solution_flow_${index}`,
        children: [{
          type: "text" as const,
          text: `解答 ${index + 1}: 段から段、次ページへ順番に流れる説明です。`.repeat(2),
        }],
      })),
      hints: [],
    },
  ];
  document.pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 140 },
    marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  });
  return document;
}
