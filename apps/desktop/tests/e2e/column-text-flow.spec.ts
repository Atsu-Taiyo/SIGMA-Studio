import { expect, test } from "@playwright/test";
import { normalizePageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import type { SigmaDocument } from "@/types/sigma-doc";

import { readCaretSurface } from "./caret-surface";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => window.localStorage.clear());
});

test("deletes an emptied text row in two-column flow", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createTwoColumnSeedDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const target = page.locator('.page-flow [data-sigma-doc-id="p_source_note"]');
  await expect(target).toBeVisible();

  await target.click({ clickCount: 3 });
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Backspace");

  await expect(page.locator('.page-flow [data-sigma-doc-id="p_source_note"]')).toHaveCount(0);
});

test("typed paragraphs continue from the first column into the next column", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createActiveTwoColumnSeedDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const first = page.locator('.page-flow [data-sigma-doc-id="p_column_active_start"]').first();
  await expect(first).toBeVisible();
  await first.click();

  for (let index = 0; index < 14; index += 1) {
    await page.keyboard.insertText(`入力で増えた段落 ${index}`);
    await page.keyboard.press("Enter");
    await page.waitForTimeout(30);
  }

  await expect.poll(async () => {
    return page.evaluate(() => {
      const blocks = Array.from(document.querySelectorAll<HTMLElement>(".page-flow [data-sigma-doc-id]"))
        .filter((block) => block.textContent?.includes("入力で増えた段落"));
      const firstLeft = blocks[0] ? blocks[0].getBoundingClientRect().left : 0;
      return blocks.filter((block) => block.getBoundingClientRect().left > firstLeft + 50).length;
    });
  }).toBeGreaterThan(0);

  const layoutProof = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".page-flow [data-sigma-doc-id]"))
      .filter((block) => block.textContent?.includes("入力で増えた段落"))
      .map((block) => ({
        id: block.getAttribute("data-sigma-doc-id") ?? "",
        left: block.getBoundingClientRect().left,
        text: block.textContent ?? "",
      }));
    return {
      rightColumnBlocks: blocks.filter((block) => block.left > (blocks[0]?.left ?? 0) + 50).length,
      typedBlockCount: blocks.length,
      duplicateMarkerCount: blocks.filter((block) => block.text.includes("入力で増えた段落 0")).length,
    };
  });

  expect(layoutProof.rightColumnBlocks).toBeGreaterThan(0);
  expect(layoutProof.typedBlockCount).toBeGreaterThan(8);
  expect(layoutProof.duplicateMarkerCount).toBe(1);
});

test("column units are absolutely placed and stack without doubled gaps", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createMultilineTwoColumnDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-column-guides span").count()).toBeGreaterThan(0);

  const proof = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(".page-flow .text-flow-column-block"));
    const positions = new Set(blocks.map((block) => getComputedStyle(block).position));
    const lefts = Array.from(new Set(blocks.map((block) => Math.round(parseFloat(block.style.left || "0"))))).sort((a, b) => a - b);

    // Visual gaps between consecutive positioned paragraphs within the first
    // column. A regression in column positioning balloons this to roughly one
    // paragraph height instead of staying near zero.
    const firstLeft = lefts[0] ?? 0;
    const column1 = blocks
      .filter((block) => Math.abs(parseFloat(block.style.left || "0") - firstLeft) < 1)
      .map((block) => block.getBoundingClientRect())
      .sort((a, b) => a.top - b.top);
    const intraColumnGaps: number[] = [];
    for (let i = 1; i < column1.length; i += 1) {
      const gap = column1[i].top - column1[i - 1].bottom;
      // Ignore the large jump that marks a page break.
      if (gap < 100) intraColumnGaps.push(gap);
    }
    const maxGap = intraColumnGaps.length > 0 ? Math.max(...intraColumnGaps) : 0;
    return { positions: Array.from(positions), distinctLefts: lefts.length, maxIntraColumnGap: Math.round(maxGap) };
  });

  expect(proof.positions).toEqual(["absolute"]);
  expect(proof.distinctLefts).toBeGreaterThanOrEqual(2);
  // Consecutive paragraphs in a column should butt up against each other.
  expect(proof.maxIntraColumnGap).toBeLessThan(12);
});

test("selects adjacent page-wide column paragraphs in one text flow", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createSelectionTwoColumnDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  await expect.poll(async () => page.locator(".page-flow .text-flow-column-block").count()).toBeGreaterThan(1);

  await dragSelectBetween(
    page,
    '.page-flow [data-sigma-doc-id="p_select_first"]',
    '.page-flow [data-sigma-doc-id="p_select_second"]',
  );

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("ドラッグで選択");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("選択終了");
});

test("selects adjacent paragraphs inside a solution layout section", async ({ page }) => {
  test.setTimeout(60_000);

  await installDesktopRuntimeMock(page, createProblemAreaSelectionDocument());
  await page.goto("/");
  await page.waitForTimeout(1500);

  const solutionArea = page.locator('[data-problem-area="solution"][data-sigma-doc-id="solution_select_section"]').first();
  await expect(solutionArea).toBeVisible();
  await expect.poll(async () => (
    solutionArea.locator(".layout-section-paper-body.with-layout-columns .text-flow-shell").first().evaluate((element) => getComputedStyle(element).columnCount)
  )).toBe("2");

  await dragSelectBetween(
    page,
    '[data-problem-area="solution"] [data-sigma-doc-id="solution_select_first"]',
    '[data-problem-area="solution"] [data-sigma-doc-id="solution_select_second"]',
  );

  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("解説選択A");
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? "")).toContain("解説選択B");
});

test("段組みを跨ぐ下移動が次の段の先頭へ行く", async ({ page }) => {
  test.setTimeout(60_000);
  await installDesktopRuntimeMock(page, createMultilineTwoColumnDocument());
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await expect.poll(async () => page.locator(".page-flow .text-flow-column-block").count())
    .toBeGreaterThan(1);

  // 1 段目の最後の段落へキャレットを置く。
  const lastInFirstColumn = await page.evaluate(() => {
    const blocks = Array.from(document.querySelectorAll<HTMLElement>(
      ".page-flow .text-flow-column-block[data-sigma-doc-id]",
    ));
    const first = blocks[0]?.getBoundingClientRect();
    if (!first) {
      return null;
    }
    // 同じ段 = 左端がほぼ同じ。その中でいちばん下のもの。
    const sameColumn = blocks
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => Math.abs(rect.left - first.left) < 2);
    const last = sameColumn.at(-1);
    const next = blocks
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .find(({ rect }) => rect.left > first.left + 2);
    if (!last || !next) {
      return null;
    }
    last.element.scrollIntoView({ block: "center", inline: "nearest" });
    // 1 段目の最後のブロックの末尾へキャレットを置く (クリックは段組みの絶対配置と重なる
    // レイヤに拾われることがあるので、DOM 選択で直接置く)。
    const text = last.element.lastChild;
    if (!(text instanceof Text)) {
      return null;
    }
    last.element.closest<HTMLElement>('[contenteditable="true"]')?.focus({ preventScroll: true });
    const range = document.createRange();
    range.setStart(text, text.length);
    range.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return {
      lastBlockId: last.element.dataset.sigmaDocId ?? null,
      nextColumnBlockId: next.element.dataset.sigmaDocId ?? null,
    };
  });
  expect(lastInFirstColumn).not.toBeNull();

  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    blockId: lastInFirstColumn!.lastBlockId,
    caretVisible: true,
  });

  await page.keyboard.press("ArrowDown");

  // 2 段目の先頭ブロックへ入り、そこがフォーカスも持っていること。
  await expect.poll(() => readCaretSurface(page)).toMatchObject({
    blockId: lastInFirstColumn!.nextColumnBlockId,
    caretVisible: true,
  });
  const moved = await readCaretSurface(page);
  expect(moved.activeSurface).toEqual(moved.selectionSurface);
});

function createMultilineTwoColumnDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_column_gap";
  document.metadata = { title: "Column gap E2E" };
  document.comments = [];
  document.content = Array.from({ length: 12 }, (_, index) => ({
    type: "paragraph" as const,
    id: `p_gap_${index}`,
    children: [
      {
        type: "text" as const,
        text: `第${index + 1}段落: これは段組みの確認用テキストです。列の中で自然に折り返す長さの文章を入れています。`,
      },
    ],
  }));
  const pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 200 },
    marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  });
  document.pageLayout = pageLayout;
  return document;
}

function createSelectionTwoColumnDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_column_text_selection";
  document.metadata = { title: "Column text selection E2E" };
  document.comments = [];
  document.content = [
    {
      type: "paragraph",
      id: "p_select_first",
      children: [{ type: "text", text: "選択開始の段落です。隣の段落までドラッグで選択できることを確認します。" }],
    },
    {
      type: "paragraph",
      id: "p_select_second",
      children: [{ type: "text", text: "選択終了の段落です。段組み中でも同じTiptap editorとして扱います。" }],
    },
  ];
  const pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 160 },
    marginsMm: { top: 18, right: 18, bottom: 18, left: 18 },
    flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
  });
  document.pageLayout = pageLayout;
  return document;
}

function createProblemAreaSelectionDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_problem_area_column_selection";
  document.metadata = { title: "Problem area column selection E2E" };
  document.comments = [];
  document.content = [
    {
      type: "problem",
      id: "prob_column_select",
      tags: [],
      lead: [],
      prompt: [{ type: "paragraph", id: "prob_column_select_prompt", children: [{ type: "text", text: "問題文" }] }],
      answer: { type: "math", expected: "" },
      solution: [{
        type: "layoutSection",
        id: "solution_select_section",
        layout: { columnCount: 2, columnGapMm: 8 },
        children: [
        {
          type: "paragraph",
          id: "solution_select_first",
          children: [{ type: "text", text: "解説選択A。問題内段組みの先頭段落です。" }],
        },
        {
          type: "paragraph",
          id: "solution_select_second",
          children: [{ type: "text", text: "解説選択B。隣接段落まで選択できることを確認します。" }],
        },
        ...Array.from({ length: 6 }, (_, index) => ({
          type: "paragraph" as const,
          id: `solution_select_tail_${index}`,
          children: [{ type: "text" as const, text: `補足 ${index}` }],
        })),
        ],
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

function createTwoColumnSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_column_text_delete";
  const pageLayout = normalizePageLayout(document.pageLayout);
  pageLayout.flow = {
    type: "columns",
    columnCount: 2,
    columnGapMm: 8,
  };
  document.pageLayout = pageLayout;
  return document;
}

function createActiveTwoColumnSeedDocument(): SigmaDocument {
  const document = structuredClone(sampleDocument);
  document.docId = "doc_e2e_column_text_typing";
  document.metadata = { title: "Column text typing E2E" };
  document.comments = [];
  document.content = [
    {
      type: "paragraph",
      id: "p_column_active_start",
      children: [{ type: "text", text: "" }],
    },
  ];
  const pageLayout = normalizePageLayout({
    preset: "custom",
    pageSize: { widthMm: 210, heightMm: 86 },
    marginsMm: { top: 10, right: 16, bottom: 10, left: 16 },
    flow: {
      type: "columns",
      columnCount: 2,
      columnGapMm: 8,
    },
  });
  document.pageLayout = pageLayout;
  return document;
}

async function dragSelectBetween(page: import("@playwright/test").Page, startSelector: string, endSelector: string) {
  const start = page.locator(startSelector).first();
  const end = page.locator(endSelector).first();
  await expect(start).toBeVisible();
  await expect(end).toBeVisible();
  await start.scrollIntoViewIfNeeded();

  const startPoint = await textDragPoint(page, startSelector, "start");
  const endPoint = await textDragPoint(page, endSelector, "end");

  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  await page.mouse.move(startPoint.x, startPoint.y);
  await page.mouse.down();
  await page.mouse.move(endPoint.x, endPoint.y, { steps: 12 });
  await page.mouse.up();
}

async function textDragPoint(
  page: import("@playwright/test").Page,
  selector: string,
  edge: "start" | "end",
): Promise<{ x: number; y: number }> {
  return page.locator(selector).first().evaluate((element, requestedEdge) => {
    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.textContent?.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      textNodes.push(node as Text);
    }

    const fallback = element.getBoundingClientRect();
    const textNode = requestedEdge === "start" ? textNodes[0] : textNodes.at(-1);
    if (!textNode || textNode.length === 0) {
      return {
        x: requestedEdge === "start" ? fallback.left + 2 : fallback.right - 2,
        y: fallback.top + fallback.height / 2,
      };
    }

    const range = document.createRange();
    if (requestedEdge === "start") {
      range.setStart(textNode, 0);
      range.setEnd(textNode, Math.min(1, textNode.length));
    } else {
      range.setStart(textNode, Math.max(0, textNode.length - 1));
      range.setEnd(textNode, textNode.length);
    }
    const rect = range.getClientRects()[requestedEdge === "start" ? 0 : range.getClientRects().length - 1] ?? fallback;
    return {
      x: requestedEdge === "start" ? rect.left + 1 : rect.right - 1,
      y: rect.top + rect.height / 2,
    };
  }, edge);
}
