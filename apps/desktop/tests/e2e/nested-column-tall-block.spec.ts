import { expect, test, type Page } from "@playwright/test";

import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import type { LayoutSectionNode, ParagraphNode, ProblemNode, SigmaDocument } from "@/types/sigma-doc";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

for (const mode of ["single", "columns"] as const) {
  test(`slices tall blocks in top-level and solution nested columns in ${mode} editor flow`, async ({ page }) => {
    test.setTimeout(180_000);
    const consoleErrors = collectConsoleErrors(page);
    await page.setViewportSize({ width: 1500, height: 1000 });
    await installDesktopRuntimeMock(page, createNestedTallDocument(mode === "columns" ? 2 : 1));
    await openEditorAndWaitForStablePagination(page);

    const first = await readEditorSlices(page);
    for (const target of [first.top, first.solution]) {
      expect(target.sourceClipped).toBe(true);
      expect(target.continuationCount).toBeGreaterThanOrEqual(2);
      expect(target.fragmentPageCount).toBeGreaterThanOrEqual(2);
      expect(target.crossingGapCount).toBe(0);
      expect(target.lineCutCount).toBe(0);
      expect(target.neighborStaysInItsColumn).toBe(true);
    }

    await page.waitForTimeout(2500);
    expect(await readEditorSlices(page)).toEqual(first);
    expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
  });
}

test("prints nested tall block slices across bounded pages", async ({ page }) => {
  test.setTimeout(180_000);
  const consoleErrors = collectConsoleErrors(page);
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installDesktopRuntimeMock(page, createNestedTallDocument(1));
  await page.goto("/print?fileId=file_e2e_document&profile=teacher", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".paged-surface[data-paged-surface-state='ready']")).toBeVisible({ timeout: 30_000 });
  const pages = page.locator(".paged-surface-page");
  await expect(pages.first()).toBeVisible({ timeout: 30_000 });
  await expect.poll(async () => pages.count()).toBeGreaterThan(2);

  const read = async () => page.evaluate(() => {
    const surfacePages = Array.from(document.querySelectorAll<HTMLElement>(".paged-surface-page"));
    const cutsRenderedLine = (viewport: HTMLElement) => {
      const boundary = viewport.getBoundingClientRect().bottom;
      const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!node.textContent?.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(node);
        if (Array.from(range.getClientRects()).some((rect) => rect.top < boundary - 1 && rect.bottom > boundary + 1)) {
          return true;
        }
      }
      return false;
    };
    const inspect = (prefix: string) => {
      const visiblePages = new Set<number>();
      let overflowing = 0;
      let fragmentCount = 0;
      let lineCutCount = 0;
      for (const [pageIndex, surfacePage] of surfacePages.entries()) {
        const pageRect = surfacePage.getBoundingClientRect();
        const fragments = Array.from(surfacePage.querySelectorAll<HTMLElement>(
          `.editor-box-fragment-viewport[data-box-source-id^="${prefix}"]`,
        ));
        for (const fragment of fragments) {
          const rect = fragment.getBoundingClientRect();
          if (rect.bottom <= pageRect.top + 0.5 || rect.top >= pageRect.bottom - 0.5) continue;
          fragmentCount += 1;
          visiblePages.add(pageIndex);
          if (rect.bottom > pageRect.bottom + 1) overflowing += 1;
          if (fragment.dataset.blockSlice !== "last" && cutsRenderedLine(fragment)) lineCutCount += 1;
        }
      }
      return { fragmentCount, pages: Array.from(visiblePages).sort((a, b) => a - b), overflowing, lineCutCount };
    };
    return { pageCount: surfacePages.length, top: inspect("nested_top_tall"), solution: inspect("nested_solution_tall") };
  });

  const first = await read();
  for (const target of [first.top, first.solution]) {
    expect(target.fragmentCount).toBeGreaterThanOrEqual(2);
    expect(target.pages.length).toBeGreaterThanOrEqual(2);
    expect(target.overflowing).toBe(0);
    expect(target.lineCutCount).toBe(0);
  }
  await page.waitForTimeout(2500);
  expect(await read()).toEqual(first);
  expect(relevantConsoleErrors(consoleErrors)).toEqual([]);
});

async function openEditorAndWaitForStablePagination(page: Page) {
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden({ timeout: 15_000 });
  await expect(page.locator(".page-backdrop .a4-page-sheet").first()).toBeVisible({ timeout: 30_000 });
  let previous = "";
  let stable = 0;
  for (let attempt = 0; attempt < 80 && stable < 5; attempt += 1) {
    const signature = await page.evaluate(() => {
      const canvas = document.querySelector(".page-canvas");
      const fragments = Array.from(document.querySelectorAll<HTMLElement>(
        '.editor-box-fragment-viewport[data-box-source-id^="nested_"]',
      )).map((element) => `${element.dataset.boxSourceId}:${Math.round(element.getBoundingClientRect().top)}`);
      return `${canvas?.getAttribute("data-page-count") ?? "0"}|${fragments.join(",")}`;
    });
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    await page.waitForTimeout(150);
  }
}

async function readEditorSlices(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>(".page-canvas");
    if (!canvas) throw new Error("page canvas was not rendered");
    const canvasRect = canvas.getBoundingClientRect();
    const pageHeight = Number(canvas.dataset.pageHeight ?? "0");
    const stride = Number(canvas.dataset.pageStride ?? "0");
    const relativeRect = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top - canvasRect.top, bottom: rect.bottom - canvasRect.top, left: rect.left - canvasRect.left };
    };
    const pageIndex = (y: number) => Math.floor(Math.max(0, y) / stride);
    const crossesGap = ({ top, bottom }: { top: number; bottom: number }) => {
      const first = pageIndex(top + 1);
      return first !== pageIndex(bottom - 1) || bottom - first * stride > pageHeight + 1;
    };
    const inspect = (prefix: string, tailPrefix: string) => {
      const source = document.querySelector<HTMLElement>(
        `[data-sigma-doc-id^="${prefix}"].text-flow-box-fragment-source`,
      );
      const continuations = Array.from(document.querySelectorAll<HTMLElement>(
        `.editor-box-fragment-viewport[data-box-source-id^="${prefix}"]`,
      ));
      const tail = document.querySelector<HTMLElement>(`[data-sigma-doc-id^="${tailPrefix}"]`);
      if (!source || !tail) throw new Error(`nested slice ${prefix} was not rendered`);
      const sourceRect = relativeRect(source);
      const sourceVisibleHeight = Number.parseFloat(
        getComputedStyle(source).getPropertyValue("--text-flow-box-fragment-visible-height"),
      );
      const scale = source.offsetHeight > 0 ? source.getBoundingClientRect().height / source.offsetHeight : 1;
      const visibleSource = {
        top: sourceRect.top,
        bottom: sourceRect.top + sourceVisibleHeight * (Number.isFinite(scale) && scale > 0 ? scale : 1),
      };
      const continuationRects = continuations.map((element) => ({
        ...relativeRect(element),
        fragmentIndex: Number(element.dataset.boxFragmentIndex ?? "0"),
      }));
      const cutsRenderedLine = (viewport: HTMLElement, boundary: number) => {
        const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          if (!node.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          if (Array.from(range.getClientRects()).some((rect) => rect.top < boundary - 1 && rect.bottom > boundary + 1)) {
            return true;
          }
        }
        return false;
      };
      const fragments = [{ ...visibleSource, left: sourceRect.left, fragmentIndex: 0 }, ...continuationRects];
      const tailRect = relativeRect(tail);
      const neighborStaysInItsColumn = Math.abs(tailRect.top - sourceRect.top) <= 1
        && tailRect.left > sourceRect.left + 1;
      return {
        sourceClipped: source.classList.contains("text-flow-box-fragment-source") && Number.isFinite(sourceVisibleHeight),
        continuationCount: continuations.length,
        fragmentPageCount: new Set(fragments.map((rect) => pageIndex(rect.top + 1))).size,
        crossingGapCount: fragments.filter(crossesGap).length,
        lineCutCount: [
          cutsRenderedLine(source, canvasRect.top + visibleSource.bottom),
          ...continuations.slice(0, -1).map((element) => cutsRenderedLine(element, element.getBoundingClientRect().bottom)),
        ].filter(Boolean).length,
        neighborStaysInItsColumn,
      };
    };
    return {
      pageCount: Number(canvas.dataset.pageCount ?? "0"),
      top: inspect("nested_top_tall", "nested_top_tail"),
      solution: inspect("nested_solution_tall", "nested_solution_tail"),
    };
  });
}

function createNestedTallDocument(columnCount: number): SigmaDocument {
  const topSection = layoutSection(
    "nested_top_section",
    paragraph("nested_top_tall", longText("トップレベル")),
    paragraph("nested_top_tail", "トップレベルの後続段落。"),
  );
  const solutionSection = layoutSection(
    "nested_solution_section",
    paragraph("nested_solution_tall", longText("解答エリア")),
    paragraph("nested_solution_tail", "解答エリアの後続段落。"),
  );
  const problem: ProblemNode = {
    type: "problem",
    id: "nested_tall_problem",
    tags: [],
    lead: [],
    prompt: [paragraph("nested_problem_prompt", "次の長い解答を確認せよ。")],
    hints: [],
    solution: [solutionSection],
    frame: { enabled: false },
  };
  return {
    version: "2.0",
    docId: `nested_tall_${columnCount}_doc`,
    metadata: { title: "入れ子段組の長大ブロック検収" },
    content: [topSection, problem],
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

function layoutSection(id: string, tall: ParagraphNode, tail: ParagraphNode): LayoutSectionNode {
  return { type: "layoutSection", id, layout: { columnCount: 2, columnGapMm: 5, columnStartIds: [tall.id, tail.id] }, children: [tall, tail] };
}

function longText(label: string): string {
  return Array.from({ length: 16 }, (_, index) => (
    `${label} ${index + 1}: 一つの段落を行境界で安全に分割し、次の段と次のページへ継続する。`
  )).join("");
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
