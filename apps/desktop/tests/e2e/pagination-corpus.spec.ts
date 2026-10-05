import { expect, test, type Page } from "@playwright/test";
import type { SigmaBlock, SigmaDocument } from "@/features/document";
import { createBoxBlock } from "@/lib/box-blocks";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import { installDesktopRuntimeMock, type DesktopRuntimeMockOptions } from "./desktop-runtime-mock";
import { auditPagination, findUnderfilledBreaks } from "./pagination-audit";

/**
 * Word と同じ改ページ (溢れた行だけを次のページ・段へ送る) の受入テスト。
 *
 * 問題・枠付き問題・最小高さ・引用 (空行入り)・箱・入れ子・リスト・コード・手動改ページ (入れ物の中を含む)・全幅・
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

/** 枠付き問題 (解答の予約空白あり) → 全幅の問題 → 段に戻る後続。全幅の直前の段は左右を揃えて詰める。 */
function fullSpanAfterFrameScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    {
      type: "problem", id: "framed", tags: [], lead: [text("lead_a", "導入")],
      prompt: Array.from({ length: 6 }, (_, index) => text(`prompt_${index}`, `枠付き問題文の行${index}`)),
      solution: [text("solution_a", "解答")], hints: [],
      frame: { enabled: true, styleId: "doublebox" },
      areaLayout: { solution: { minHeightMm: 30 } },
    } as SigmaBlock,
    {
      type: "problem", id: "wide", tags: [], lead: [],
      prompt: Array.from({ length: 4 }, (_, index) => text(`wide_${index}`, `全幅の問題文の行${index}`)),
      solution: [], hints: [],
      areaLayout: { prompt: { columnSpan: "full" } },
    } as SigmaBlock,
    ...Array.from({ length: 16 }, (_, index) => text(`tail_${index}`, `後続${index}`)),
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
    // 入れ物の中の区切り: 引用・箱はその位置で分割して次のページ (段) へ続く。
    {
      type: "quote", id: "break_quote",
      blocks: [text("bq0", "引用の前半"), { type: "paragraph", id: "bq1", pagination: { break: true }, children: [{ type: "text", text: "引用の後半" }] }, text("bq2", "引用の続き")],
    } as SigmaBlock,
    {
      ...createBoxBlock("fancybox", "", { id: "break_box", bodyId: "bb0" }),
      blocks: [text("bb0", "箱の前半"), { type: "paragraph", id: "bb1", pagination: { break: true }, children: [{ type: "text", text: "箱の後半" }] }, text("bb2", "箱の続き")],
    } as SigmaBlock,
    text("after", "後続の本文"),
  ];
}

async function openDoc(page: Page, document: SigmaDocument, mockOptions: DesktopRuntimeMockOptions = {}) {
  // 全ページを描かせる (紙面は表示範囲だけ描かれる)。
  await page.setViewportSize({ width: 1500, height: 4000 });
  await installDesktopRuntimeMock(page, document, mockOptions);
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
      const extensions = window.document.querySelectorAll("[data-flow-extension-node-id], [data-flow-extension-replica]").length;
      return `${canvas?.dataset.pageCount}:${flow?.getBoundingClientRect().height}:${window.document.querySelectorAll(".editor-box-fragment-viewport").length}:${extensions}:${displacements}`;
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

async function auditScenario(
  page: Page,
  content: SigmaBlock[],
  heightMm: number,
  columnCount: number,
  mockOptions: DesktopRuntimeMockOptions = {},
  afterOpen: (page: Page) => Promise<void> = async () => {},
): Promise<string[]> {
  const columnGeometry = {
    marginLeftMm: MARGIN_MM,
    columnCount,
    columnWidthMm: (PAGE_WIDTH_MM - MARGIN_MM * 2 - COLUMN_GAP_MM * (columnCount - 1)) / columnCount,
    columnGapMm: COLUMN_GAP_MM,
  };
  const withoutBreaks = JSON.parse(JSON.stringify(content, (key, value) => (key === "pagination" ? undefined : value))) as SigmaBlock[];
  await openDoc(page, doc(withoutBreaks, 3000, columnCount), mockOptions);
  await afterOpen(page);
  const natural = await auditPagination(page, { marginTopMm: MARGIN_MM, marginBottomMm: MARGIN_MM, pageHeightMm: 3000, ...columnGeometry });
  await openDoc(page, doc(content, heightMm, columnCount), mockOptions);
  await afterOpen(page);
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
  fullspanAfterFrame: fullSpanAfterFrameScenario,
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

/**
 * 本文ブロックの後ろに差し込まれる拡張ノード (AI の提案カード) も本文と同じ行として改ページする。
 * カードはページ下端に来ても行の間で切れ、続きは次のページ (段) に描かれる。対象の段落の位置を
 * ずらして、カードがページ (段) の境目をまたぐ配置を作る。
 */
function proposalCardScenario(filler: number): SigmaBlock[] {
  return [
    ...Array.from({ length: filler }, (_, index) => text(`fill_${index}`, `本文${index}`)),
    text("proposal_target", "提案の対象の段落"),
    ...Array.from({ length: 6 }, (_, index) => text(`tail_${index}`, `後続${index}`)),
  ];
}

const PROPOSAL_ROWS = 7;

/** 対象の段落の後ろに段落を連ねて挿入する提案 (カードの中身は挿入される行)。 */
function pendingInsertionProposal(targetId: string): DesktopMcpEditProposalSummary {
  const createdAt = "2026-01-01T00:00:00.000Z";
  return {
    proposalId: "proposal_corpus",
    fileId: "file_e2e_document",
    baseRevision: 1,
    baseDocId: "pagination_corpus",
    title: "改ページ受入の提案",
    summary: "提案カード",
    plan: ["段落を挿入する"],
    warnings: [],
    changedIds: [targetId],
    provider: "chatgpt",
    runId: "run_corpus",
    roomId: "room_corpus",
    draft: {
      summary: "提案カード",
      plan: ["段落を挿入する"],
      warnings: [],
      operations: Array.from({ length: PROPOSAL_ROWS }, (_, index) => ({
        operation: "insertAfter" as const,
        summary: "段落を挿入",
        targetId: index === 0 ? targetId : `proposal_row_${index - 1}`,
        insertedBlock: {
          id: `proposal_row_${index}`,
          type: "paragraph" as const,
          children: [{ type: "text" as const, text: `提案で足す行${index}` }],
        },
      })),
    },
    status: "pending",
    createdAt,
    updatedAt: createdAt,
  };
}

for (const columnCount of [1, 2]) {
  test(`moves only overflowing lines: proposal card at the page bottom, ${columnCount} column(s)`, async ({ page }) => {
    test.setTimeout(300_000);
    const mockOptions: DesktopRuntimeMockOptions = {
      ai: { enabled: true, initialProposals: [pendingInsertionProposal("proposal_target")] },
    };
    const waitForCard = async (current: Page) => {
      const card = current.locator('.page-flow [data-flow-extension-node-id^="extension:ai-proposal:proposal_target:"]');
      await expect(card).toHaveCount(1);
      await expect(card).toContainText(`提案で足す行${PROPOSAL_ROWS - 1}`);
    };
    const failures: string[] = [];
    let splitCards = 0;
    for (const heightMm of PAGE_HEIGHTS_MM) {
      for (const filler of FILLERS) {
        const violations = await auditScenario(page, proposalCardScenario(filler), heightMm, columnCount, mockOptions, waitForCard);
        failures.push(...violations.map((violation) => `h=${heightMm} filler=${filler}: ${violation}`));
        splitCards += await page.locator("[data-flow-extension-replica]").count();
      }
    }
    expect(failures).toEqual([]);
    // 少なくとも 1 つの配置でカードがページ (段) の境目をまたぎ、続きが描かれている。
    expect(splitCards).toBeGreaterThan(0);
  });
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
