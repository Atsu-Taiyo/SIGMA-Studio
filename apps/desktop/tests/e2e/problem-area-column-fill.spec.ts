import { expect, test } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test("solution layout section columns balance without old area column styles", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createSolutionLayoutSectionDocument());
  await page.goto("/");
  await page.locator(".startup-splash").waitFor({ state: "hidden", timeout: 10_000 });

  const section = page.locator('[data-problem-area="solution"][data-sigma-doc-id="solution_balanced_columns"]').first();
  await expect(section).toBeVisible();

  const info = await section.evaluate((el) => {
    const body = el.querySelector(".layout-section-paper-body.with-layout-columns .text-flow-shell") as HTMLElement | null;
    const cs = body ? getComputedStyle(body) : null;
    const paras = Array.from(el.querySelectorAll<HTMLElement>(".layout-section-paper-body .text-flow-editor > *"));
    const lefts = Array.from(new Set(paras.map((p) => Math.round(p.getBoundingClientRect().left)))).sort((a, b) => a - b);
    return {
      columnFill: cs?.columnFill,
      columnCount: cs?.columnCount,
      distinctLeftCount: lefts.length,
      usesOldAreaColumns: Boolean(el.closest("[data-problem-area]")?.querySelector(".with-area-columns")),
    };
  });

  expect(info.columnFill).toBe("balance");
  expect(info.columnCount).toBe("2");
  expect(info.distinctLeftCount).toBe(2);
  expect(info.usesOldAreaColumns).toBe(false);
});

function createSolutionLayoutSectionDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_solution_layout_section_balance";
  document.metadata = { title: "Solution layout section balance E2E" };
  document.comments = [];
  document.content = [
    {
      type: "problem",
      id: "prob_answer_columns",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "prob_prompt", children: [{ type: "text", text: "問題文" }] }],
      answer: { type: "math", expected: "" },
      solution: [{
        type: "layoutSection",
        id: "solution_balanced_columns",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: Array.from({ length: 12 }, (_, index) => ({
          type: "paragraph" as const,
          id: `ans_${index}`,
          children: [{ type: "text" as const, text: `解答行 ${index}` }],
        })),
      }],
      hints: [],
      areaLayout: {
        solution: { minHeightMm: 60 },
      },
    },
  ];
  document.pageLayout = normalizePageLayout({
    ...document.pageLayout,
    flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
  });
  return document;
}
