import { expect, test } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { ParagraphNode, SigmaDocument } from "@/types/sigma-doc";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("framed problem: solution paginates across pages while the frame stays whole", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, createDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".page-backdrop .a4-page-sheet").first()).toBeVisible({ timeout: 30_000 });

  // Wait until pagination settles: sheet count + applied spacer heights stop changing.
  let previousSignature = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80 && stable < 5; attempt += 1) {
    const signature = await page.evaluate(() => {
      const pageCount = document.querySelector(".page-canvas")?.getAttribute("data-page-count") ?? "0";
      const spacers = Array.from(document.querySelectorAll<HTMLElement>(".page-break-spacer")).map((el) => el.offsetHeight);
      return `${pageCount}|${spacers.join(",")}`;
    });
    if (signature === previousSignature) {
      stable += 1;
    } else {
      stable = 0;
      previousSignature = signature;
    }
    await page.waitForTimeout(150);
  }

  // 1) The document overflows onto at least 2 pages. Sheets are virtualized
  // (only near-viewport pages mount a .a4-page-sheet), so the page count and the
  // sheet geometry come from the canvas dataset, not from counting sheet nodes.
  const geometry = async () => page.evaluate(() => {
    const rect = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top + window.scrollY, bottom: r.bottom + window.scrollY, left: r.left + window.scrollX, height: r.height };
    };
    const canvas = document.querySelector(".page-canvas");
    if (!canvas) {
      throw new Error("page canvas not found");
    }
    const canvasTop = rect(canvas).top;
    const canvasLeft = rect(canvas).left;
    const pageCount = Number(canvas.getAttribute("data-page-count") ?? "0");
    const pageHeight = Number(canvas.getAttribute("data-page-height") ?? "0");
    const stride = Number(canvas.getAttribute("data-page-stride") ?? "0");
    const sheets = Array.from({ length: pageCount }, (_, index) => ({
      top: canvasTop + index * stride,
      bottom: canvasTop + index * stride + pageHeight,
      left: canvasLeft,
      height: pageHeight,
    }));
    const sheetIndexOf = (y: number) => sheets.findIndex((s) => y >= s.top - 1 && y <= s.bottom + 1);
    const prompt = document.querySelector('[data-problem-area="prompt"][data-problem-id="army_problem"]');
    const solutionBlocks = Array.from(document.querySelectorAll('[data-problem-area="solution"][data-problem-id="army_problem"] [data-sigma-doc-id]'))
      .map((el) => ({ id: el.getAttribute("data-sigma-doc-id"), ...rect(el) }));
    const reserved = document.querySelector('[data-problem-area="solution"][data-problem-id="army_problem2"]');
    const spacers = Array.from(document.querySelectorAll(".page-break-spacer")).map((el) => (el as HTMLElement).offsetHeight);
    return {
      sheets,
      prompt: prompt ? { ...rect(prompt), withFrame: prompt.classList.contains("with-frame") } : null,
      promptSheetSpan: prompt ? [sheetIndexOf(rect(prompt).top), sheetIndexOf(rect(prompt).bottom)] : null,
      solutionFirstSheet: solutionBlocks.length ? sheetIndexOf(solutionBlocks[0].top) : -1,
      solutionLastSheet: solutionBlocks.length ? sheetIndexOf(solutionBlocks[solutionBlocks.length - 1].bottom) : -1,
      solutionBlockCount: solutionBlocks.length,
      reserved: reserved ? rect(reserved) : null,
      reservedSheetSpan: reserved ? [sheetIndexOf(rect(reserved).top), sheetIndexOf(rect(reserved).bottom)] : null,
      spacers,
      pageCount,
    };
  });

  const g1 = await geometry();
  expect(g1.pageCount).toBeGreaterThanOrEqual(2);

  // 2) The framed prompt is drawn with its frame and never crosses a sheet boundary.
  expect(g1.prompt?.withFrame).toBe(true);
  expect(g1.promptSheetSpan?.[0]).toBeGreaterThanOrEqual(0);
  expect(g1.promptSheetSpan?.[0]).toBe(g1.promptSheetSpan?.[1]);
  // 3) The long solution flows across at least two sheets (= the answer paginates).
  expect(g1.solutionFirstSheet).toBeGreaterThanOrEqual(0);
  expect(g1.solutionLastSheet).toBeGreaterThan(g1.solutionFirstSheet);
  // 4) The reserved (minHeight) solution area of problem 2 stays on one sheet.
  expect(g1.reservedSheetSpan?.[0]).toBeGreaterThanOrEqual(0);
  expect(g1.reservedSheetSpan?.[0]).toBe(g1.reservedSheetSpan?.[1]);

  // 5) Stability probe: no gap oscillation while idle.
  await page.waitForTimeout(2500);
  const g2 = await geometry();
  expect(g2.spacers).toEqual(g1.spacers);
  expect(g2.pageCount).toBe(g1.pageCount);
  expect(g2.solutionLastSheet).toBe(g1.solutionLastSheet);

  // The AiEditWebPlaceholder hydration mismatch is pre-existing dev-mode noise
  // (AI sidebar, unrelated to pagination) — visible as the "1 Issue" overlay on
  // main as well.
  const relevantErrors = consoleErrors.filter((text) =>
    !text.includes("favicon")
    && !text.includes("Download the React DevTools")
    && !text.includes("hydration-mismatch")
    && !text.includes("hydrated"));
  expect(relevantErrors).toEqual([]);
});

function createDocument(): SigmaDocument {
  const solution: ParagraphNode[] = [];
  for (let i = 0; i < 42; i += 1) {
    solution.push(paragraph(`army_solution_${i}`, `解答 ${i + 1} 行目: 与えられた条件から x の値を順に評価し、場合分けの境界で符号が変わることを確認する。`));
  }
  return {
    version: "2.0",
    docId: "army_uxcheck_doc",
    metadata: { title: "改ページ検収" },
    content: [
      paragraph("army_intro", "枠線付き問題の改ページ検収用ドキュメント。"),
      {
        type: "problem",
        id: "army_problem",
        tags: [],
        lead: [paragraph("army_lead", "次の問いに答えよ。")],
        prompt: [
          paragraph("army_prompt_1", "関数 f(x) = x^2 - 4x + 3 について、以下の値を求めよ。"),
          paragraph("army_prompt_2", "(1) f(x) = 0 となる x の値。"),
          paragraph("army_prompt_3", "(2) f(x) の最小値とそのときの x の値。"),
        ],
        hints: [],
        solution,
        frame: { enabled: true, styleId: "fancybox" },
      },
      paragraph("army_between", "続く本文の段落。問題の後の通常フローが正しい位置から再開すること。"),
      {
        type: "problem",
        id: "army_problem2",
        tags: [],
        lead: [paragraph("army2_lead", "次の計算をせよ。")],
        prompt: [paragraph("army2_prompt", "2次方程式 x^2 - 5x + 6 = 0 を解け。")],
        hints: [],
        solution: [paragraph("army2_solution", "(x-2)(x-3)=0 より x=2, 3。")],
        frame: { enabled: true, styleId: "doublebox" },
        areaLayout: { solution: { minHeightMm: 80 } },
      },
      paragraph("army_tail", "文書末尾の段落。"),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
