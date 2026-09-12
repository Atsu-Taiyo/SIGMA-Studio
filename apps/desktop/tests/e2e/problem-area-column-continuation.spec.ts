import { expect, test, type Page } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("renders a solution layout section as local columns", async ({ page }) => {
  test.setTimeout(60_000);

  await page.setViewportSize({ width: 1700, height: 1200 });
  await installDesktopRuntimeMock(page, createDoc());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const section = page.locator('[data-problem-area="solution"][data-sigma-doc-id="solution_columns"]').first();
  await expect(section).toBeVisible();

  const info = await section.evaluate((el) => {
    const body = el.querySelector(".layout-section-paper-body.with-layout-columns .text-flow-shell") as HTMLElement | null;
    return {
      columnCount: body ? getComputedStyle(body).columnCount : null,
      hasOldAreaColumnFlow: Boolean(el.closest("[data-problem-area]")?.querySelector(".with-area-column-flow")),
    };
  });

  expect(info.columnCount).toBe("2");
  expect(info.hasOldAreaColumnFlow).toBe(false);

  const promptSection = page.locator('[data-problem-area="prompt"][data-sigma-doc-id="prompt_columns"]').first();
  await expect(promptSection).toBeVisible();
  await expect(promptSection.locator(".layout-section-side-note")).toContainText("2段組");
  await expect(promptSection.locator(".problem-area-side-note")).toContainText("問1 問題文");
  await expect(promptSection.locator(".page-break-marker")).toContainText("改段");

  const noteProof = await promptSection.evaluate((el) => {
    const areaNote = el.querySelector(".problem-area-side-note > span")?.getBoundingClientRect();
    const columnNote = el.querySelector(".layout-section-side-note > span")?.getBoundingClientRect();
    if (!areaNote || !columnNote) {
      return { hasBoth: false, overlaps: true };
    }
    return {
      hasBoth: true,
      overlaps: !(areaNote.bottom <= columnNote.top || columnNote.bottom <= areaNote.top || areaNote.right <= columnNote.left || columnNote.right <= areaNote.left),
    };
  });
  expect(noteProof).toEqual({ hasBoth: true, overlaps: false });
});

test("keeps problem layout section input stable while typing", async ({ page }) => {
  test.setTimeout(60_000);

  await page.setViewportSize({ width: 1700, height: 1200 });
  await installDesktopRuntimeMock(page, createDoc());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const target = page.locator('[data-problem-area="solution"][data-sigma-doc-id="solution_columns"] [data-sigma-doc-id="ans_0"]').first();
  await expect(target).toBeVisible();

  const beforeIds = await readSolutionColumnChildIds(page);
  expect(beforeIds).toEqual(["ans_0", "ans_1", "ans_2", "ans_3", "ans_4", "ans_5", "ans_6", "ans_7"]);

  await target.click();
  await page.keyboard.press("End");
  await page.keyboard.type(" TYPED_ONCE_12345", { delay: 10 });

  await expect.poll(() => readSolutionColumnTypingProof(page)).toEqual({
    childIds: beforeIds,
    typedOccurrences: 1,
  });

  const focusProof = await page.evaluate(() => {
    const selection = window.getSelection();
    const anchor = selection?.anchorNode;
    const anchorElement = anchor instanceof Element ? anchor : anchor?.parentElement;
    const blockElement = anchorElement?.closest("[data-sigma-doc-id]");
    return {
      activeEditable: Boolean(document.activeElement?.closest("[contenteditable='true']")),
      activeBlockId: blockElement?.getAttribute("data-sigma-doc-id") ?? null,
    };
  });
  expect(focusProof).toEqual({
    activeEditable: true,
    activeBlockId: "ans_0",
  });
});

test("shows column-break release in a solution layout section like body columns", async ({ page }) => {
  test.setTimeout(60_000);

  await page.setViewportSize({ width: 1700, height: 1200 });
  await installDesktopRuntimeMock(page, createDoc());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const first = page.locator('[data-problem-area="solution"][data-sigma-doc-id="solution_columns"] [data-sigma-doc-id="ans_0"]').first();
  await expect(first).toBeVisible();
  await collapseBlockSelectionToEnd(page, "ans_0");
  await first.click({ button: "right", position: { x: 8, y: 8 } });

  // A block inside a problem area (here: solution) always opens the problem menu now, which is
  // a superset of the body menu — it renders the same shared 改段/改ページ 挿入・解除 items.
  const menu = page.locator(".problem-context-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "改段を挿入", exact: true }).click();

  const marker = page.locator('[data-layout-section-id="solution_columns"] .page-break-marker[data-page-break-block-id="ans_1"]');
  await expect(marker).toBeVisible();
  await expect(marker).toContainText("改段");

  await first.click({ button: "right", position: { x: 8, y: 8 } });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改段を挿入", exact: true })).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "改段を解除", exact: true })).toBeVisible();
  await menu.getByRole("menuitem", { name: "改段を解除", exact: true }).click();

  await expect(marker).toHaveCount(0);
  await expect.poll(() => readSolutionColumnBreakBefore(page, "ans_1")).toBeNull();
});

async function readSolutionColumnChildIds(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const problem = document?.content?.find((block: { id?: string }) => block.id === "prob_solution_layout_section");
    const section = problem?.solution?.find((block: { id?: string }) => block.id === "solution_columns");
    return section?.children?.map((block: { id?: string }) => block.id) ?? [];
  });
}

async function readSolutionColumnTypingProof(page: Page) {
  return page.evaluate(() => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const problem = document?.content?.find((block: { id?: string }) => block.id === "prob_solution_layout_section");
    const section = problem?.solution?.find((block: { id?: string }) => block.id === "solution_columns");
    const target = section?.children?.find((block: { id?: string }) => block.id === "ans_0");
    const text = target?.children?.map((node: { text?: string }) => node.text ?? "").join("") ?? "";
    return {
      childIds: section?.children?.map((block: { id?: string }) => block.id) ?? [],
      typedOccurrences: text.split("TYPED_ONCE_12345").length - 1,
    };
  });
}

async function readSolutionColumnBreakBefore(page: Page, blockId: string) {
  return page.evaluate((targetBlockId) => {
    const raw = window.localStorage.getItem("sigma-studio:e2e-document");
    const document = raw ? JSON.parse(raw) : null;
    const problem = document?.content?.find((block: { id?: string }) => block.id === "prob_solution_layout_section");
    const section = problem?.solution?.find((block: { id?: string }) => block.id === "solution_columns");
    const target = section?.children?.find((block: { id?: string }) => block.id === targetBlockId);
    return target?.pagination?.break ?? null;
  }, blockId);
}

async function collapseBlockSelectionToEnd(page: Page, blockId: string) {
  await page.evaluate((targetBlockId) => {
    const block = document.querySelector(`[data-sigma-doc-id="${CSS.escape(targetBlockId)}"]`);
    if (!block) {
      return;
    }

    const range = document.createRange();
    range.selectNodeContents(block);
    range.collapse(false);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
  }, blockId);
}

function createDoc(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_solution_layout_section_columns";
  document.metadata = { title: "Solution layout section columns E2E" };
  document.comments = [];
  document.content = [
    {
      type: "problem",
      id: "prob_solution_layout_section",
      tags: [],
      lead: [{ type: "paragraph", id: "lead_1", children: [{ type: "text", text: "問1 次の問いに答えよ。" }] }],
      prompt: [{
        type: "layoutSection",
        id: "prompt_columns",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: [
          {
            type: "paragraph",
            id: "prompt_col_1",
            children: [{ type: "text", text: "問題文の一部を段組みにする。" }],
          },
          {
            type: "paragraph",
            id: "prompt_col_2",
            pagination: { break: true },
            children: [{ type: "text", text: "ここから次の段へ送る。" }],
          },
        ],
      }],
      answer: { type: "math", expected: "" },
      solution: [{
        type: "layoutSection",
        id: "solution_columns",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: Array.from({ length: 8 }, (_, index) => ({
          type: "paragraph" as const,
          id: `ans_${index}`,
          children: [{ type: "text" as const, text: `解答行 ${index}：途中式や説明を書く。` }],
        })),
      }],
      hints: [],
    },
  ];
  document.pageLayout = normalizePageLayout({
    ...document.pageLayout,
    flow: { type: "columns", columnCount: 1, columnGapMm: 8 },
  });
  return document;
}
