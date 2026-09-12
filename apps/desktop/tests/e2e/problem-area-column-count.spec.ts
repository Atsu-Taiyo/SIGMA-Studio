import { expect, test } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("wraps part of a solution in a local column section", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createProblemSolutionDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const target = page.locator('[data-problem-area="solution"] [data-sigma-doc-id="solution_column_target"]').first();
  await expect(target).toBeVisible();

  await target.click();
  await expect(page.getByTestId("problem-area-column-count-solution-2")).toHaveCount(0);

  await target.click({ button: "right" });
  const menu = page.getByRole("menu", { name: "問題操作" });
  await expect(menu.getByRole("menuitem", { name: "ここを段組にする", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "ここを段組にする", exact: true }).hover();
  await expect(menu.getByRole("menuitem", { name: "4段組", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "2段組", exact: true }).click();

  const section = page.locator('[data-problem-area="solution"][data-sigma-doc-type="layoutSection"]').first();
  await expect(section).toBeVisible();
  await expect.poll(async () => (
    section.locator(".layout-section-paper-body.with-layout-columns .text-flow-shell").first().evaluate((element) => getComputedStyle(element).columnCount)
  )).toBe("2");

  await expect.poll(() => page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const problem = document?.content?.find((block: { id?: string }) => block.id === "problem_solution_columns");
    const solution = Array.isArray(problem?.solution) ? problem.solution : [];
    const layoutSection = solution.find((block: { type?: string }) => block.type === "layoutSection");
    return {
      solutionTypes: solution.map((block: { type?: string }) => block.type),
      columnCount: layoutSection?.layout?.columnCount ?? null,
      childIds: layoutSection?.children?.map((block: { id?: string }) => block.id) ?? [],
    };
  })).toEqual({
    solutionTypes: ["paragraph", "layoutSection", "paragraph"],
    columnCount: 2,
    childIds: ["solution_column_target"],
  });
});

function createProblemSolutionDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_problem_solution_local_columns";
  document.metadata = { title: "Problem solution local columns E2E" };
  document.comments = [];
  document.content = [
    {
      type: "problem",
      id: "problem_solution_columns",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "prompt", children: [{ type: "text", text: "問題文" }] }],
      solution: [
        { type: "paragraph", id: "solution_before", children: [{ type: "text", text: "前の解答。" }] },
        { type: "paragraph", id: "solution_column_target", children: [{ type: "text", text: "この解答だけを局所段組みにします。" }] },
        { type: "paragraph", id: "solution_after", children: [{ type: "text", text: "後の解答。" }] },
      ],
      hints: [],
    },
  ];
  document.pageLayout = normalizePageLayout({
    ...document.pageLayout,
    flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
  });
  return document;
}
