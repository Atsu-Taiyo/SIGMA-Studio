import { expect, test, type Page } from "@playwright/test";
import type { SigmaBlock, SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import { installDesktopRuntimeMock } from "./desktop-runtime-mock";
import { auditPagination, findUnderfilledBreaks } from "./pagination-audit";

/**
 * Word と同じ改ページ (溢れた行だけを次のページ・段へ送る) の受入テスト。
 *
 * 問題・枠付き問題・最小高さ・引用 (空行入り)・箱・入れ子・リスト・コード・手動改ページ・全幅・
 * 部分段組を、1 段組と段組、2 種類の用紙の高さで、ページ末尾に来る位置をずらしながら描き、
 * 実描画から次を検査する (`pagination-audit.ts`)。
 *
 * 1. ページ (段) の本文領域の下端をまたぐ行が無い。行が途中で切れていない。
 * 2. 次の領域の先頭の行は、前の領域の残りに入らない (手動改ページの直後を除く)。
 * 3. すべての行がちょうど 1 回表示される。
 *
 * 基準の自然配置は、同じ教材を 1 ページに収まる高さで (手動改ページを外して) 描いたもの。
 */

const PAGE_WIDTH_MM = 180;
const MARGIN_MM = 12;
const COLUMN_GAP_MM = 8;

const text = (id: string, value: string): SigmaBlock => ({ type: "paragraph", id, children: value ? [{ type: "text", text: value }] : [] });

function doc(content: SigmaBlock[], heightMm: number, columnCount: number): SigmaDocument {
  return {
    version: "2.0", docId: "pagination_corpus", metadata: { title: "改ページ受入" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    pageLayout: {
      preset: "custom", orientation: "portrait", pageSize: { widthMm: PAGE_WIDTH_MM, heightMm },
      marginsMm: { top: MARGIN_MM, right: MARGIN_MM, bottom: MARGIN_MM, left: MARGIN_MM },
      flow: { type: "columns", columnCount, columnGapMm: COLUMN_GAP_MM },
    },
  };
}

function problemScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, index % 3 === 0 ? `本文${index}` : "")),
    {
      type: "problem", id: "problem", tags: [], lead: [],
      prompt: [text("prompt_a", "以下の問題の"), text("prompt_b", ""), text("prompt_c", "")],
      solution: [text("solution_a", "")], hints: [],
    } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function framedScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    {
      type: "problem", id: "problem", tags: [], lead: [text("lead_a", "導入")],
      prompt: Array.from({ length: 6 }, (_, index) => text(`prompt_${index}`, `枠付き問題文の行${index}`)),
      solution: [], hints: [],
      frame: { enabled: true, styleId: "doublebox" },
    } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function quoteScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    { type: "quote", id: "quote", blocks: Array.from({ length: 14 }, (_, index) => text(`q_${index}`, index % 3 === 2 ? "" : "あ")) } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function boxScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    { ...createBoxBlock("fancybox", "", { id: "box", bodyId: "box_0" }), blocks: Array.from({ length: 8 }, (_, index) => text(`box_${index}`, `箱の中の行${index}`)) } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function fullSpanScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    {
      type: "problem", id: "problem", tags: [], lead: [text("lead_a", "導入")],
      prompt: Array.from({ length: 5 }, (_, index) => text(`prompt_${index}`, `全幅の問題文の行${index}`)),
      solution: [], hints: [],
      areaLayout: { prompt: { columnSpan: "full" } },
    } as SigmaBlock,
    ...Array.from({ length: 8 }, (_, index) => text(`tail_${index}`, `後続${index}`)),
  ];
}

function localColumnsScenario(filler: number): SigmaBlock[] {
  const left = Array.from({ length: 12 }, (_, index) => text(`left_${index}`, `左の列${index}`));
  const right = Array.from({ length: 3 }, (_, index) => text(`right_${index}`, `右の列${index}`));
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    {
      type: "layoutSection", id: "local", layout: { columnCount: 2, columnStartIds: ["left_0", "right_0"] },
      children: [...left, ...right],
    } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function nestedScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    {
      ...createBoxBlock("fancybox", "", { id: "outer", bodyId: "o0" }),
      blocks: [
        text("o0", "外の箱"),
        { ...createBoxBlock("doublebox", "", { id: "inner", bodyId: "i0" }), blocks: Array.from({ length: 6 }, (_, index) => text(`i${index}`, `内の箱${index}`)) },
        { type: "quote", id: "nq", blocks: Array.from({ length: 4 }, (_, index) => text(`nq${index}`, index === 2 ? "" : `箱の中の引用${index}`)) },
        { type: "list", id: "nl", listType: "ordered", items: Array.from({ length: 4 }, (_, index) => ({ type: "listItem", id: `nli${index}`, children: [{ type: "text", text: `項目${index}` }] })) },
      ],
    } as SigmaBlock,
    { type: "codeBlock", id: "code", language: "text", children: [{ type: "text", text: "line1\n\nline3\nline4\n\nline6\nline7\nline8" }] } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

function breaksScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, index % 2 ? "" : `本文${index}`)),
    { type: "paragraph", id: "forced", pagination: { break: true }, children: [{ type: "text", text: "改ページ後" }] } as SigmaBlock,
    {
      type: "problem", id: "problem", tags: [], lead: [],
      prompt: [text("p0", "問題文"), { type: "paragraph", id: "p1", pagination: { break: true }, children: [{ type: "text", text: "問題内の改ページ後" }] } as SigmaBlock],
      solution: [text("s0", "")], hints: [],
      areaLayout: { solution: { minHeightMm: 40 } },
    } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

async function openDoc(page: Page, document: SigmaDocument) {
  // 全ページを描かせる (紙面は表示範囲だけ描かれる)。
  await page.setViewportSize({ width: 1500, height: 4000 });
  await installDesktopRuntimeMock(page, document);
  await page.goto("/");
  await expect(page.locator(".startup-splash")).toBeHidden();
  await page.evaluate(() => window.document.fonts.ready);
  let previous = "";
  let stable = 0;
  await expect.poll(async () => {
    const signature = await page.evaluate(() => {
      const canvas = window.document.querySelector<HTMLElement>(".page-canvas");
      const flow = window.document.querySelector<HTMLElement>(".page-flow");
      const displacements = Array.from(window.document.querySelectorAll("[data-flow-dy]"))
        .map((element) => element.getAttribute("data-flow-dy")).join(",");
      return `${canvas?.dataset.pageCount}:${flow?.getBoundingClientRect().height}:${window.document.querySelectorAll(".editor-box-fragment-viewport").length}:${displacements}`;
    });
    stable = signature === previous ? stable + 1 : 0;
    previous = signature;
    return stable;
  }, { timeout: 20_000, intervals: [150] }).toBeGreaterThanOrEqual(3);
}

function breakIdsOf(content: readonly SigmaBlock[]): string[] {
  const ids: string[] = [];
  JSON.stringify(content, (_key, value) => {
    if (value && typeof value === "object" && value.pagination?.break === true && typeof value.id === "string") ids.push(value.id);
    return value;
  });
  return ids;
}

async function auditScenario(page: Page, content: SigmaBlock[], heightMm: number, columnCount: number): Promise<string[]> {
  const columnGeometry = {
    marginLeftMm: MARGIN_MM,
    columnCount,
    columnWidthMm: (PAGE_WIDTH_MM - MARGIN_MM * 2 - COLUMN_GAP_MM * (columnCount - 1)) / columnCount,
    columnGapMm: COLUMN_GAP_MM,
  };
  const withoutBreaks = JSON.parse(JSON.stringify(content, (key, value) => (key === "pagination" ? undefined : value))) as SigmaBlock[];
  await openDoc(page, doc(withoutBreaks, 3000, columnCount));
  const natural = await auditPagination(page, { marginTopMm: MARGIN_MM, marginBottomMm: MARGIN_MM, pageHeightMm: 3000, ...columnGeometry });
  await openDoc(page, doc(content, heightMm, columnCount));
  const paged = await auditPagination(page, {
    marginTopMm: MARGIN_MM, marginBottomMm: MARGIN_MM, pageHeightMm: heightMm, ...columnGeometry,
    manualBreakBlockIds: breakIdsOf(content),
  });
  const counters = await page.evaluate(() => window.__SIGMA_STUDIO_PERFORMANCE__?.counters ?? {});
  const violations = [...paged.violations, ...findUnderfilledBreaks(paged, natural)];
  // 閉ループの名残 (振動ガード) が発火していないこと。
  if (counters["PageCanvasEditor.paginationOscillation"]) violations.push("pagination oscillation guard fired");
  return violations;
}

const SCENARIOS = {
  problem: problemScenario,
  framed: framedScenario,
  quote: quoteScenario,
  box: boxScenario,
  fullspan: fullSpanScenario,
  local: localColumnsScenario,
  nested: nestedScenario,
  breaks: breaksScenario,
} as const;

const FILLERS = [7, 12, 17, 22];
const PAGE_HEIGHTS_MM = [110, 150];

for (const columnCount of [1, 2]) {
  for (const [name, build] of Object.entries(SCENARIOS)) {
    test(`moves only overflowing lines: ${name}, ${columnCount} column(s)`, async ({ page }) => {
      test.setTimeout(300_000);
      const failures: string[] = [];
      for (const heightMm of PAGE_HEIGHTS_MM) {
        for (const filler of FILLERS) {
          const violations = await auditScenario(page, build(filler), heightMm, columnCount);
          failures.push(...violations.map((violation) => `h=${heightMm} filler=${filler}: ${violation}`));
        }
      }
      expect(failures).toEqual([]);
    });
  }
}

test("columns use the same spacing as a single column", async ({ page }) => {
  const content: SigmaBlock[] = [
    text("p0", "本文の段落"),
    { type: "heading", id: "h0", level: 2, children: [{ type: "text", text: "見出し" }] } as SigmaBlock,
    text("p1", "見出しの後"),
    ...problemScenario(0).slice(0, 1),
    { type: "quote", id: "quote", blocks: [text("q0", "引用0"), text("q1", "引用1")] } as SigmaBlock,
    { ...createBoxBlock("fancybox", "", { id: "box", bodyId: "b0" }), blocks: [text("b0", "箱0"), text("b1", "箱1")] } as SigmaBlock,
    text("after", "後続"),
  ];
  const tops: Record<number, Record<string, number>> = {};
  for (const columnCount of [1, 2]) {
    await openDoc(page, doc(content, 400, columnCount));
    const audit = await auditPagination(page, {
      marginTopMm: MARGIN_MM, marginBottomMm: MARGIN_MM, pageHeightMm: 400, marginLeftMm: MARGIN_MM, columnCount,
      columnWidthMm: (PAGE_WIDTH_MM - MARGIN_MM * 2 - COLUMN_GAP_MM * (columnCount - 1)) / columnCount, columnGapMm: COLUMN_GAP_MM,
    });
    tops[columnCount] = Object.fromEntries(audit.lines.map((line) => [line.key, line.top]));
  }
  for (const [key, top] of Object.entries(tops[1])) {
    expect(Math.abs((tops[2][key] ?? Number.NaN) - top), key).toBeLessThanOrEqual(0.5);
  }
});
