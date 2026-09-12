import { describe, expect, it } from "vitest";

import type { SigmaBlock, SigmaCommentThread } from "@/features/document";
import type { TextFlowBlock } from "@/features/text-editing";

import {
  buildRenderUnits,
  getProblemAreaUnitGapKey,
  getSingleColumnProblemLayoutSectionMinHeightMm,
  pickUnitBreakGaps,
  pickUnitCommentThreads,
  reconcileRenderUnits,
} from "./render-units";
import { getChunkBoundaryState } from "./text-run-chunking";
import type { RenderUnit } from "./types";

function paragraph(id: string, text = "本文"): TextFlowBlock {
  return { type: "paragraph", id, children: [{ type: "text", text }] } as TextFlowBlock;
}

/** 改ページ指定はテキスト連なりを切るので、ユニットを 2 つに分ける一番軽い方法。 */
function pageBreakParagraph(id: string, text = "本文"): TextFlowBlock {
  return { type: "paragraph", id, children: [{ type: "text", text }], pagination: { break: true } } as TextFlowBlock;
}

function thread(id: string, anchor: SigmaCommentThread["anchor"]): SigmaCommentThread {
  return { id, anchor, messages: [], createdAt: "2026-01-01T00:00:00.000Z" };
}

describe("reconcileRenderUnits", () => {
  it("keeps the editor key after deleting its anchor, without changing the new measurement ID", () => {
    const previous = buildRenderUnits([paragraph("p1"), paragraph("p2"), paragraph("p3")]);
    const after = reconcileRenderUnits(previous, buildRenderUnits([paragraph("p2"), paragraph("p3")]));
    expect(after[0]).toMatchObject({ id: "p2", renderKey: "p1" });
    const updated = reconcileRenderUnits(after, buildRenderUnits([paragraph("p2", "朝"), paragraph("p3")]));
    expect(updated[0]).toMatchObject({ id: "p2", renderKey: "p1" });
    const split = reconcileRenderUnits(updated, buildRenderUnits([paragraph("p1"), pageBreakParagraph("p2"), paragraph("p3")]));
    const keys = split.map((unit) => unit.type === "textFlow" ? unit.renderKey ?? unit.id : unit.id);
    expect(new Set(keys).size).toBe(split.length);
    expect(split[1]).toMatchObject({ id: "p2", renderKey: "p1" });
  });
  it("reuses every unit when no block changed", () => {
    // 打鍵のたびに buildRenderUnits は新しい配列を作る。中身が同じユニットまで新品になると、
    // memo 化した本文ユニットが全部描き直される。
    const content = [paragraph("p1"), paragraph("p2")] as SigmaBlock[];
    const previous = buildRenderUnits(content);
    const next = buildRenderUnits(content);

    const reconciled = reconcileRenderUnits(previous, next);

    expect(reconciled).toHaveLength(previous.length);
    reconciled.forEach((unit, index) => expect(unit).toBe(previous[index]));
  });

  it("gives a new object only to the unit whose block changed", () => {
    const first = paragraph("p1");
    const tail = pageBreakParagraph("p3");
    const previous = buildRenderUnits([first, paragraph("p2"), tail] as SigmaBlock[]);
    const next = buildRenderUnits([first, paragraph("p2", "本文あ"), tail] as SigmaBlock[]);

    const reconciled = reconcileRenderUnits(previous, next);

    expect(previous).toHaveLength(2);
    // p1+p2 が 1 ユニット、改ページ指定の p3 が次のユニット。編集したのは前者だけ。
    expect(reconciled[0]).toBe(next[0]);
    expect(reconciled[0]).not.toBe(previous[0]);
    expect(reconciled[1]).toBe(previous[1]);
  });

  it("keeps the new units when the unit set itself changed", () => {
    const first = paragraph("p1");
    const previous = buildRenderUnits([first] as SigmaBlock[]);
    const next = buildRenderUnits([first, pageBreakParagraph("p3")] as SigmaBlock[]);

    const reconciled = reconcileRenderUnits(previous, next);

    expect(reconciled).toHaveLength(next.length);
    expect(reconciled[0]).toBe(previous[0]);
    expect(reconciled[1]).toBe(next[1]);
  });
});

describe("reconcileRenderUnits with problem areas", () => {
  // 問題エリアと段組みのブロックは毎回 `cloneTextFlowBlock` で作り直されるので、
  // identity 比較では絶対に一致しない。出所 (problem / section) で判断できないと、
  // 問題型の教材ではユニット再利用が 1 つも効かない。
  function problem(promptText: string, id = "q1") {
    return {
      type: "problem",
      id,
      lead: [],
      prompt: [paragraph(`${id}_prompt`, promptText)],
      hints: [],
      solution: [],
    } as unknown as SigmaBlock;
  }

  it("reuses a problem area unit while its problem object is unchanged", () => {
    const first = problem("問題文");
    const previous = buildRenderUnits([first] as SigmaBlock[]);
    const next = buildRenderUnits([first] as SigmaBlock[]);

    expect(previous.some((unit) => unit.type === "problemArea")).toBe(true);
    const reconciled = reconcileRenderUnits(previous, next);
    reconciled.forEach((unit, index) => expect(unit).toBe(previous[index]));
  });

  it("drops the reuse when the problem itself changed", () => {
    const previous = buildRenderUnits([problem("問題文")] as SigmaBlock[]);
    const next = buildRenderUnits([problem("問題文あ")] as SigmaBlock[]);

    const reconciled = reconcileRenderUnits(previous, next);
    expect(reconciled.every((unit, index) => unit !== previous[index])).toBe(true);
  });

  it("drops the reuse when only the problem number moved", () => {
    // 前に問題を差し込むと problem オブジェクトは同じまま番号だけ変わる。
    const target = problem("問題文", "q2");
    const previous = buildRenderUnits([target] as SigmaBlock[]);
    const next = buildRenderUnits([problem("先頭", "q1"), target] as SigmaBlock[]);

    const reconciled = reconcileRenderUnits(previous, next);
    const reusedTargetUnit = reconciled.find((unit) => unit.id === previous[0].id);
    expect(reusedTargetUnit).not.toBe(previous[0]);
  });

  it("assigns the problem-id gap carrier to only the first unit of a split first area", () => {
    const splitProblem = {
      type: "problem",
      id: "q_split",
      lead: [
        paragraph("lead_before"),
        {
          type: "layoutSection",
          id: "lead_columns",
          layout: { columnCount: 2 },
          children: [paragraph("lead_column_child")],
        },
        paragraph("lead_after"),
      ],
      prompt: [],
      hints: [],
      solution: [],
    } as unknown as SigmaBlock;

    const areaUnits = buildRenderUnits([splitProblem]).filter((unit): unit is Extract<RenderUnit, {
      type: "problemArea" | "problemLayoutSection";
    }> => (
      (unit.type === "problemArea" || unit.type === "problemLayoutSection") && unit.area === "lead"
    ));

    expect(areaUnits).toHaveLength(3);
    expect(areaUnits.map((unit) => unit.isFirstProblemArea)).toEqual([true, true, true]);
    expect(areaUnits.map((unit) => unit.isFirstProblemAreaUnit)).toEqual([true, false, false]);
    expect(areaUnits.map((unit) => unit.problemAreaUnitCount)).toEqual([3, 3, 3]);
    const gapKeys = areaUnits.map(getProblemAreaUnitGapKey);
    expect(gapKeys[0]).toBe("q_split");
    expect(new Set(gapKeys).size).toBe(3);
  });

  it("applies min-height to a layout-section-only area only in the single-column path", () => {
    const layoutOnlyProblem = {
      type: "problem",
      id: "q_layout_only",
      lead: [],
      prompt: [],
      hints: [],
      solution: [{
        type: "layoutSection",
        id: "solution_columns",
        layout: { columnCount: 2 },
        children: [paragraph("solution_child")],
      }],
      areaLayout: { solution: { minHeightMm: 120 } },
    } as unknown as SigmaBlock;
    const unit = buildRenderUnits([layoutOnlyProblem]).find((candidate): candidate is Extract<RenderUnit, {
      type: "problemLayoutSection";
    }> => candidate.type === "problemLayoutSection" && candidate.area === "solution");

    expect(unit).toBeDefined();
    if (!unit) {
      throw new Error("solution problemLayoutSection was not built");
    }
    expect(getSingleColumnProblemLayoutSectionMinHeightMm(unit, false)).toBe(120);
    expect(getSingleColumnProblemLayoutSectionMinHeightMm(unit, true)).toBe(0);
  });
});

describe("buildRenderUnits with carried chunk boundaries", () => {
  function problem(id: string): SigmaBlock {
    return {
      type: "problem",
      id,
      lead: [],
      prompt: [paragraph(`${id}_prompt`, "問題文")],
      hints: [],
      solution: [],
    } as unknown as SigmaBlock;
  }

  function textFlowIds(units: ReturnType<typeof buildRenderUnits>): string[] {
    return units.flatMap((unit) => unit.type === "textFlow" ? [unit.id] : []);
  }

  // ブロックは 1 度だけ作る。呼び出しごとに作り直すと、内容が同じでも別オブジェクトになり
  // ユニット使い回しの判定 (ブロック同一性・問題の同一性) が成立しない。
  const runA = Array.from({ length: 60 }, (_, index) => paragraph(`a${index}`) as SigmaBlock);
  const runB = Array.from({ length: 60 }, (_, index) => paragraph(`b${index}`) as SigmaBlock);
  const q1 = problem("q1");

  /** 問題ブロックで切られた本文の連なりが 2 本ある文書 (教材の実際の形)。 */
  function document(head: SigmaBlock[]): SigmaBlock[] {
    return [...head, ...runA, q1, ...runB];
  }

  it("keeps the downstream unit objects when a block is inserted at the top", () => {
    // この WI の本題。境界が件数で決まっていた頃は、先頭に 1 件足すだけで以降のユニット id が
    // 全部ずれ、下流の TextFlowEditor がまるごと作り直されていた (数式ノードの再マウント)。
    const before = buildRenderUnits(document([]));
    const boundary = getChunkBoundaryState(textFlowIds(before));
    const after = buildRenderUnits(document([paragraph("inserted") as SigmaBlock]), boundary);

    expect(textFlowIds(before)).toEqual(["a0", "a40", "b0", "b40"]);
    // 先頭のユニットだけが伸び、他の境界は動かない。2 本目の連なりも巻き込まれない。
    expect(textFlowIds(after)).toEqual(["inserted", "a40", "b0", "b40"]);

    const reconciled = reconcileRenderUnits(before, after);
    expect(reconciled[0]).not.toBe(before[0]);
    reconciled.slice(1).forEach((unit, index) => expect(unit).toBe(before[index + 1]));
  });

  it("is a fixed point across renders when the document does not change", () => {
    const content = document([]);
    const first = buildRenderUnits(content);
    const second = buildRenderUnits(content, getChunkBoundaryState(textFlowIds(first)));

    expect(textFlowIds(second)).toEqual(textFlowIds(first));
    reconcileRenderUnits(first, second).forEach((unit, index) => expect(unit).toBe(first[index]));
  });
});

describe("pickUnitBreakGaps", () => {
  it("hands each unit only the gaps of the blocks it renders", () => {
    // 全ページ分の gap を渡すと、どこか 1 ページの gap が動いただけで全ユニットが描き直される。
    const blocks = [paragraph("p1"), paragraph("p2")];
    expect(pickUnitBreakGaps(blocks, { p1: 12, p3: 30 })).toEqual({ p1: 12 });
    expect(pickUnitBreakGaps(blocks, { p3: 30 })).toBeUndefined();
    expect(pickUnitBreakGaps(blocks, undefined)).toBeUndefined();
  });

  it("includes gaps keyed by a nested block id", () => {
    const boxed = {
      type: "boxBlock",
      id: "box",
      styleId: "fancybox",
      blocks: [paragraph("box_body")],
    } as unknown as TextFlowBlock;

    expect(pickUnitBreakGaps([boxed], { box_body: 8, other: 4 })).toEqual({ box_body: 8 });
  });
});

describe("pickUnitCommentThreads", () => {
  const blocks = [paragraph("p1"), paragraph("p2")];

  it("keeps only the threads that can decorate this unit", () => {
    const inside = thread("t1", { type: "block", blockId: "p2" });
    const outside = thread("t2", { type: "block", blockId: "p9" });
    const inlineMath = thread("t3", { type: "inlineMath", blockId: "p1", mathInlineId: "m1" });
    const overlay = thread("t4", { type: "overlayShape", shapeIds: ["s1"] });

    expect(pickUnitCommentThreads(blocks, [inside, outside, inlineMath, overlay])).toEqual([inside, inlineMath]);
  });

  it("keeps a text range thread only for the unit holding both ends", () => {
    // 装飾側は順序表に両端が無いと範囲を解決できないので、片端しか持たないユニットに
    // 渡しても何も描けない (渡さないのが正しい)。
    const inside = thread("t5", {
      type: "textRange",
      start: { blockId: "p1", offset: 0 },
      end: { blockId: "p2", offset: 3 },
      quote: "本文",
    });
    const spanning = thread("t6", {
      type: "textRange",
      start: { blockId: "p2", offset: 0 },
      end: { blockId: "p9", offset: 3 },
      quote: "本文",
    });

    expect(pickUnitCommentThreads(blocks, [inside])).toEqual([inside]);
    expect(pickUnitCommentThreads(blocks, [spanning])).toEqual([]);
    expect(pickUnitCommentThreads([paragraph("p5")], [spanning])).toEqual([]);
  });

  it("returns one shared empty array so an untouched unit keeps its props identity", () => {
    expect(pickUnitCommentThreads(blocks, [])).toBe(pickUnitCommentThreads([paragraph("p9")], []));
  });
});
