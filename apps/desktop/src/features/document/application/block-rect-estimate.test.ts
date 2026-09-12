import { describe, expect, it } from "vitest";

import {
  estimateBlockRects,
  TEXT_FLOW_BLOCK_ANCHOR_LEFT_OFFSET_PX,
} from "./block-rect-estimate";
import { getPageMetrics } from "./page-layout";
import type { PageLayout, SigmaBlock, SigmaDocument } from "../model";

function paragraph(id: string, text: string): SigmaBlock {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function createDocument(content: SigmaBlock[], pageLayout?: PageLayout): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_block_rect",
    metadata: { title: "ブロック矩形推定" },
    content,
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
    ...(pageLayout ? { pageLayout } : {}),
  };
}

describe("estimateBlockRects", () => {
  it("stacks single-column top-level blocks with monotonically increasing tops", () => {
    const rects = estimateBlockRects(createDocument([
      paragraph("p_1", "最初の段落"),
      paragraph("p_2", "2番目の段落"),
      paragraph("p_3", "3番目の段落"),
    ]));

    const tops = ["p_1", "p_2", "p_3"].map((id) => rects.get(id)?.top ?? Number.NaN);
    expect(tops[0]).toBeLessThan(tops[1]);
    expect(tops[1]).toBeLessThan(tops[2]);
  });

  it("offsets text-flow block lefts by the text-flow shell offset", () => {
    const rects = estimateBlockRects(createDocument([paragraph("p_1", "本文")]));
    const metrics = getPageMetrics();

    expect(rects.get("p_1")?.left).toBe(metrics.margins.leftPx + TEXT_FLOW_BLOCK_ANCHOR_LEFT_OFFSET_PX);
    expect(rects.get("p_1")?.top).toBe(metrics.margins.topPx);
    expect(rects.get("p_1")?.width).toBe(metrics.flow.columnWidthPx);
    expect(rects.get("p_1")?.height).toBeGreaterThan(0);
  });

  it("gives each column its own left in a two-column layout", () => {
    const layout: PageLayout = {
      preset: "A4",
      orientation: "portrait",
      pageSize: { widthMm: 210, heightMm: 297 },
      marginsMm: { top: 18, right: 17, bottom: 18, left: 17 },
      flow: { type: "columns", columnCount: 2, columnGapMm: 8 },
    };
    // 1段目を埋め切る分量のブロックを積み、2段目へ送る。
    const blocks = Array.from({ length: 80 }, (_, index) => (
      paragraph(`p_${index}`, `段組みテスト本文 ${index}`)
    ));
    const rects = estimateBlockRects(createDocument(blocks, layout));

    const lefts = [...new Set(blocks.map((block) => rects.get(block.id)?.left))];
    expect(lefts.length).toBeGreaterThan(1);
  });

  it("returns an empty map for a document without content", () => {
    expect(estimateBlockRects(createDocument([])).size).toBe(0);
  });

  it("does not offset non-text-flow top-level blocks", () => {
    const rects = estimateBlockRects(createDocument([{
      type: "problem",
      id: "prob_1",
      lead: [],
      prompt: [paragraph("prob_1_prompt", "問題文") as never],
      solution: [],
      hints: [],
    } as unknown as SigmaBlock]));
    const metrics = getPageMetrics();

    expect(rects.get("prob_1")?.left).toBe(metrics.margins.leftPx);
  });

  // AI挿入のアンカーは resolveOverlayInsertionTarget が問題エリアの子ブロックへ
  // 付け替える。DOM計測 (measureBlockTops) は [data-sigma-doc-id] を全部拾うので、
  // 推定側に子ブロックが無いと dx/dy が絶対座標のまま残り二重加算になる。
  it("estimates rects for problem area child blocks stacked inside the problem", () => {
    const rects = estimateBlockRects(createDocument([
      paragraph("p_before", "前の段落"),
      {
        type: "problem",
        id: "prob_1",
        lead: [paragraph("prob_1_lead", "リード文") as never],
        prompt: [paragraph("prob_1_prompt", "問題文") as never],
        solution: [paragraph("prob_1_solution", "解答") as never],
        hints: [paragraph("prob_1_hint", "ヒント") as never],
      } as unknown as SigmaBlock,
    ]));

    const problem = rects.get("prob_1")!;
    const lead = rects.get("prob_1_lead")!;
    const prompt = rects.get("prob_1_prompt")!;
    const solution = rects.get("prob_1_solution")!;
    const hint = rects.get("prob_1_hint")!;

    for (const rect of [lead, prompt, solution, hint]) {
      expect(rect).toBeDefined();
      expect(rect.left).toBe(problem.left);
    }
    expect(lead.top).toBe(problem.top);
    expect(prompt.top).toBeGreaterThan(lead.top);
    expect(solution.top).toBeGreaterThan(prompt.top);
    expect(hint.top).toBeGreaterThan(solution.top);
    expect(hint.top + hint.height).toBeLessThanOrEqual(problem.top + problem.height + 1);
  });

  it("estimates rects for boxBlock child blocks below the box padding", () => {
    const rects = estimateBlockRects(createDocument([{
      type: "boxBlock",
      id: "box_1",
      blocks: [paragraph("box_1_child", "枠内本文") as never],
    } as unknown as SigmaBlock]));

    const box = rects.get("box_1")!;
    const child = rects.get("box_1_child")!;

    expect(child).toBeDefined();
    expect(child.top).toBeGreaterThan(box.top);
    expect(child.top).toBeLessThan(box.top + box.height);
  });

  // 箇条書きはSigmaDoc上は1ブロックでも、DOMでは項目ごとに id が出る。図形は
  // そちらへ紐づくので、項目の矩形が無いと同じ二重加算が起きる。
  it("estimates rects for list items stacked inside their list", () => {
    const rects = estimateBlockRects(createDocument([{
      type: "list",
      id: "list_1",
      listType: "bullet",
      items: [
        { type: "listItem", id: "li_1", children: [{ type: "text", text: "1つめ" }] },
        { type: "listItem", id: "li_2", children: [{ type: "text", text: "2つめ" }] },
        {
          type: "listItem",
          id: "li_3",
          children: [{ type: "text", text: "3つめ" }],
          nested: [{
            type: "list",
            id: "list_nested",
            listType: "bullet",
            items: [{ type: "listItem", id: "li_3_1", children: [{ type: "text", text: "入れ子" }] }],
          }],
        },
      ],
    } as unknown as SigmaBlock]));

    const list = rects.get("list_1")!;
    const first = rects.get("li_1")!;
    const second = rects.get("li_2")!;
    const third = rects.get("li_3")!;
    const nested = rects.get("li_3_1")!;

    for (const rect of [first, second, third, nested]) {
      expect(rect).toBeDefined();
      expect(rect.left).toBeGreaterThan(list.left);
    }
    expect(first.top).toBeGreaterThanOrEqual(list.top);
    expect(second.top).toBeGreaterThan(first.top);
    expect(third.top).toBeGreaterThan(second.top);
    // 入れ子は親項目より内側かつ下、リストの高さには収まる。
    expect(nested.top).toBeGreaterThan(third.top);
    expect(nested.left).toBeGreaterThan(third.left);
    expect(rects.get("list_nested")).toBeDefined();
    expect(nested.top + nested.height).toBeLessThanOrEqual(list.top + list.height + 1);
  });

  it("keeps every nested block id resolvable so anchor deltas never stay absolute", () => {
    const rects = estimateBlockRects(createDocument([{
      type: "layoutSection",
      id: "sec_1",
      layout: { columnCount: 2 },
      children: [paragraph("sec_1_child", "段組み本文") as never],
    } as unknown as SigmaBlock]));

    expect(rects.has("sec_1_child")).toBe(true);
  });
});
