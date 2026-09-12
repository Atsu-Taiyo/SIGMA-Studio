import { expect, test } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { LayoutSectionNode, ParagraphNode, ProblemNode, SigmaDocument } from "@/types/sigma-doc";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("flows a long layout section across page columns while preserving reserved solution space", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text());
    }
  });
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, createColumnModeDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".page-backdrop .a4-page-sheet").first()).toBeVisible({ timeout: 30_000 });

  // Guard against sampling transient geometry while column pagination is still converging.
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80 && stable < 5; attempt += 1) {
    const signature = await page.evaluate(() => {
      const pageCount = document.querySelector(".page-canvas")?.getAttribute("data-page-count") ?? "0";
      const tops = Array.from(document.querySelectorAll<HTMLElement>('.page-flow [data-sigma-doc-id^="sec_child_"]'))
        .slice(0, 8)
        .map((el) => Math.round(el.getBoundingClientRect().top));
      return `${pageCount}|${tops.join(",")}`;
    });
    if (signature === previous) {
      stable += 1;
    } else {
      stable = 0;
      previous = signature;
    }
    await page.waitForTimeout(150);
  }

  const geometry = async () => page.evaluate(() => {
    const canvas = document.querySelector(".page-canvas");
    if (!canvas) {
      throw new Error("page canvas not found");
    }
    const canvasRect = canvas.getBoundingClientRect();
    const pageCount = Number(canvas.getAttribute("data-page-count") ?? "0");
    const pageHeight = Number(canvas.getAttribute("data-page-height") ?? "0");
    const stride = Number(canvas.getAttribute("data-page-stride") ?? "0");
    const rel = (el: Element) => {
      const r = el.getBoundingClientRect();
      return { top: r.top - canvasRect.top, bottom: r.bottom - canvasRect.top, left: r.left - canvasRect.left };
    };
    // Derive sheet positions from canvas data attributes because offscreen sheet DOM is virtualized.
    const pageIndexOf = (y: number) => Math.floor(y / stride);
    const inGap = (y: number) => (y - pageIndexOf(y) * stride) > pageHeight + 1;
    const scale = new DOMMatrixReadOnly(getComputedStyle(canvas.closest(".page-stack")!).transform).a;
    const sectionChildren = Array.from(document.querySelectorAll<HTMLElement>('.page-flow [data-sigma-doc-id^="sec_child_"]'))
      .map((el) => {
        const rect = rel(el);
        const visibleHeight = Number.parseFloat(getComputedStyle(el).getPropertyValue("--text-flow-box-fragment-visible-height"));
        // Source paragraphs keep their full editing DOM; only their clipped
        // first slice and the continuation viewports are visible on paper.
        return { ...rect, bottom: el.classList.contains("text-flow-box-fragment-source") && Number.isFinite(visibleHeight)
          ? rect.top + visibleHeight * scale : rect.bottom };
      });
    const sectionFragments = Array.from(document.querySelectorAll<HTMLElement>(
      '.editor-box-fragment-viewport[data-box-source-id^="sec_child_"]',
    )).map(rel);
    const solutionBlocks = Array.from(document.querySelectorAll<HTMLElement>('[data-problem-area="solution"][data-problem-id="army2_problem"] [data-sigma-doc-id]'))
      .map((el) => rel(el));
    const tail = document.querySelector('.page-flow [data-sigma-doc-id="army2_tail"]');
    const columnKey = (b: { top: number; left: number }) => `${pageIndexOf(b.top)}:${b.left > 350 ? 1 : 0}`;
    return {
      pageCount,
      pageHeight,
      stride,
      sectionChildCount: sectionChildren.length,
      sectionColumns: Array.from(new Set(sectionChildren.map(columnKey))).sort(),
      childBottomInGap: [...sectionChildren, ...sectionFragments].filter((b) => inGap(b.bottom) || pageIndexOf(b.top + 1) !== pageIndexOf(b.bottom - 1)).length,
      solutionLastBottom: solutionBlocks.length ? Math.max(...solutionBlocks.map((b) => b.bottom)) : -1,
      tailTop: tail ? rel(tail).top : -1,
    };
  });

  const g1 = await geometry();

  // A section must fragment across columns instead of overflowing as one atomic block.
  expect(g1.sectionChildCount).toBeGreaterThan(10);
  expect(g1.sectionColumns.length).toBeGreaterThan(1);
  // No section child may bleed through the visual gap between page sheets.
  expect(g1.childBottomInGap).toBe(0);
  // Reserved solution height must be allocated before the following body tail.
  expect(g1.solutionLastBottom).toBeGreaterThan(0);
  expect(g1.tailTop).toBeGreaterThan(g1.solutionLastBottom + 40);

  // Catch delayed repagination loops that move content after the layout first appears stable.
  await page.waitForTimeout(2500);
  const g2 = await geometry();
  expect(g2.pageCount).toBe(g1.pageCount);
  expect(g2.sectionColumns).toEqual(g1.sectionColumns);
  expect(g2.tailTop).toBe(g1.tailTop);

  // Surface unexpected runtime errors while allowing known browser-development noise.
  const relevantErrors = consoleErrors.filter((text) =>
    !text.includes("favicon") && !text.includes("Download the React DevTools") && !text.includes("hydrat"));
  expect(relevantErrors).toEqual([]);
});

test("splits a problem-area layout section across printed pages without overflow", async ({ page }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1400, height: 1000 });
  await installDesktopRuntimeMock(page, createPrintDocument());
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });

  const pages = page.locator(".paged-surface-page");
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => pages.count()).toBeGreaterThan(1);

  const proof = await page.evaluate(() => {
    const surfacePages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    // Exclude the offscreen measurement copy so only content in live printed pages proves the split.
    const childPages = Array.from(new Set(
      surfacePages.flatMap((p, index) =>
        p.querySelector('[data-sigma-doc-id^="psec_child_"]') ? [index] : []),
    )).sort();
    const overflowing = surfacePages.filter((p) => {
      const pr = p.getBoundingClientRect();
      return Array.from(p.querySelectorAll('[data-sigma-doc-id^="psec_child_"]')).some((el) => {
        const r = el.getBoundingClientRect();
        return r.bottom > pr.bottom + 1;
      });
    }).length;
    return { pageCount: surfacePages.length, childPages, overflowing };
  });

  // The section must continue onto a later live page without painting past any page boundary.
  expect(proof.childPages.length).toBeGreaterThan(1);
  expect(proof.childPages).not.toContain(-1);
  expect(proof.overflowing).toBe(0);
});

function createColumnModeDocument(): SigmaDocument {
  const sectionChildren: ParagraphNode[] = [];
  for (let i = 0; i < 28; i += 1) {
    sectionChildren.push(paragraph(`sec_child_${i}`, `段組セクション ${i + 1} 行目: 二段に分かれた本文がページ段を跨いで流れることを確認する。`));
  }
  const section: LayoutSectionNode = {
    type: "layoutSection",
    id: "army2_section",
    layout: { columnCount: 2 },
    children: sectionChildren,
  };
  const problem: ProblemNode = {
    type: "problem",
    id: "army2_problem",
    tags: [],
    lead: [paragraph("army2_lead", "次の問いに答えよ。")],
    prompt: [paragraph("army2_prompt", "関数 f(x) = x^2 - 4x + 3 の最小値を求めよ。")],
    hints: [],
    solution: [
      paragraph("army2_sol_1", "頂点の x 座標は x = 2。"),
      paragraph("army2_sol_2", "f(2) = -1 なので最小値は -1。"),
    ],
    frame: { enabled: true, styleId: "fancybox" },
    areaLayout: { solution: { minHeightMm: 45 } },
  };
  return {
    version: "2.0",
    docId: "army2_column_doc",
    metadata: { title: "段組改段検収" },
    content: [
      paragraph("army2_intro", "段組モードの検収ドキュメント。"),
      section,
      problem,
      paragraph("army2_tail", "解答余白の後に続く本文。"),
    ],
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 15, bottom: 18, left: 15 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    },
  };
}

function createPrintDocument(): SigmaDocument {
  const sectionChildren: ParagraphNode[] = [];
  for (let i = 0; i < 30; i += 1) {
    sectionChildren.push(paragraph(`psec_child_${i}`, `解答内セクション ${i + 1} 行目の説明文。`));
  }
  return {
    version: "2.0",
    docId: "army2_print_doc",
    metadata: { title: "印刷分割検収" },
    content: [
      paragraph("p_intro", "印刷検収の前文。"),
      {
        type: "problem",
        id: "army2_print_problem",
        tags: [],
        numbering: { enabled: false },
        lead: [],
        prompt: [paragraph("p_prompt", "次の計算をせよ。")],
        hints: [],
        solution: [{
          type: "layoutSection",
          id: "army2_print_section",
          layout: { columnCount: 2 },
          children: sectionChildren,
        }],
        frame: { enabled: true },
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
      pageSize: { widthMm: 120, heightMm: 120 },
      marginsMm: { top: 10, right: 10, bottom: 10, left: 10 },
      flow: { type: "columns", columnCount: 1, columnGapMm: 0 },
    },
  };
}

function paragraph(id: string, text: string): ParagraphNode {
  return {
    id,
    type: "paragraph",
    children: text ? [{ type: "text", text }] : [],
  };
}
