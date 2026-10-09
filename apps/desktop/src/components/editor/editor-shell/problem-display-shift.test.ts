import { describe, expect, it } from "vitest";

import type { MeasuredBlock } from "@/components/editor/overlay-canvas/anchor";
import { reanchorShapesAgainstMeasuredBlocks } from "@/components/editor/overlay-canvas/reanchor-model";
import type { OverlayShape, SigmaBlock } from "@/features/document";
import { resolveShapesPosition } from "@/features/drawing";
import { collectProblemDisplayHiddenShapeIds, type ProblemDisplayFilter } from "@/features/rendering/core";

import { buildProblemDisplayEditorExtensions } from "./use-problem-display-editing";

/**
 * 「解答を隠している間に問題文が伸びたら、解答を戻したとき解答の図もその分だけ下がる」の契約。
 *
 * 図の位置の正本は錨 (段落と、そこからの位置)。隠している間の図形の保存 (保存時の付け替え) が、描かれていない
 * 段落に付いた図を見えている段落へ付け替えると、戻したときに図は解答から外れ、伸びた分だけずれて残る。
 * 編集面の方針 (`preservedShapeIds`) がそれを止め、戻したあとの実測で図が解答と一緒に下がることを確かめる。
 */

const ONLY_PROBLEM: ProblemDisplayFilter = { problem: true, solution: false, hints: false };

function paragraph(id: string) {
  return { type: "paragraph" as const, id, children: [{ type: "text" as const, text: id }] };
}

const content = [
  paragraph("body_intro"),
  { type: "problem", id: "q1", tags: [], lead: [], prompt: [paragraph("q1_prompt")], hints: [], solution: [paragraph("q1_solution")] },
  { type: "problem", id: "q2", tags: [], lead: [], prompt: [paragraph("q2_prompt")], hints: [], solution: [paragraph("q2_solution")] },
] as unknown as SigmaBlock[];

function figure(id: string, blockId: string, y: number, dy = 6): OverlayShape {
  return {
    id, type: "geo", x: 300, y,
    anchor: { type: "block", blockId, dy },
    props: { w: 60, h: 36, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" },
  } as OverlayShape;
}

function block(id: string, top: number, height = 28): MeasuredBlock {
  return { id, top, left: 64, width: 600, height, lines: [{ index: 0, top, left: 64, width: 120, height }] };
}

/** ふだんの紙面。問題文の下に解答、その下に次の問題。 */
const FULL_BEFORE = [block("body_intro", 80), block("q1_prompt", 160), block("q1_solution", 200), block("q2_prompt", 300), block("q2_solution", 340)];
/** 解答を隠し、問題文を 240px 伸ばした紙面。解答は描かれず、次の問題の問題文が問題文のすぐ下に来る。 */
const GROWTH = 240;
const FILTERED_GROWN = [block("body_intro", 80), block("q1_prompt", 160, 28 + GROWTH), block("q2_prompt", 200 + GROWTH)];
/** 解答を戻した紙面。解答から下は、問題文が伸びた分だけ下がっている。 */
const FULL_AFTER = [block("body_intro", 80), block("q1_prompt", 160, 28 + GROWTH), block("q1_solution", 200 + GROWTH), block("q2_prompt", 300 + GROWTH), block("q2_solution", 340 + GROWTH)];

const shapes = [
  // 解答の図。保存されている y は、隠す前の紙面での位置 (解答の上端 200 + 6)。
  figure("fig_solution", "q1_solution", 206),
  figure("fig_q2_solution", "q2_solution", 346),
  figure("fig_q2_prompt", "q2_prompt", 306),
];

function rectsOf(blocks: MeasuredBlock[]) {
  return new Map(blocks.map((item) => [item.id, item]));
}

function offsetFromAnchor(shape: OverlayShape | undefined, blocks: MeasuredBlock[]) {
  if (shape?.anchor?.type !== "block") throw new Error("not block-anchored");
  const anchorId = shape.anchor.blockId;
  return shape.y - blocks.find((item) => item.id === anchorId)!.top;
}

describe("a figure on a hidden answer follows the answer when the prompt grows while hidden", () => {
  const hidden = collectProblemDisplayHiddenShapeIds(content, shapes, ONLY_PROBLEM);
  const policy = buildProblemDisplayEditorExtensions([...hidden], [])?.overlayEditPolicy;

  it("treats the figures on the hidden answers as the ones a save must not rewrite", () => {
    expect([...hidden].sort()).toEqual(["fig_q2_solution", "fig_solution"]);
    expect([...(policy?.preservedShapeIds ?? [])].sort()).toEqual(["fig_q2_solution", "fig_solution"]);
  });

  it("keeps the anchors through a save made on the narrowed page, so the figures move down with their answers", () => {
    // 隠している間の図形の保存: 絞った紙面の実測で付け替える。
    const savedWhileHidden = reanchorShapesAgainstMeasuredBlocks(shapes, FILTERED_GROWN, {}, policy?.preservedShapeIds);
    const byId = new Map(savedWhileHidden.map((shape) => [shape.id, shape]));
    expect(byId.get("fig_solution")?.anchor).toEqual(shapes[0].anchor);
    expect(byId.get("fig_q2_solution")?.anchor).toEqual(shapes[1].anchor);

    // 解答を戻した紙面: 図は解答と同じだけ (GROWTH) 下がり、解答からの位置は隠す前と同じ。
    const shown = resolveShapesPosition(savedWhileHidden, rectsOf(FULL_AFTER));
    const shownById = new Map(shown.map((shape) => [shape.id, shape]));
    expect(shownById.get("fig_solution")!.y - 206).toBe(GROWTH);
    expect(shownById.get("fig_q2_solution")!.y - 346).toBe(GROWTH);
    expect(offsetFromAnchor(shownById.get("fig_solution"), FULL_AFTER)).toBe(offsetFromAnchor(shapes[0], FULL_BEFORE));
    expect(offsetFromAnchor(shownById.get("fig_q2_solution"), FULL_AFTER)).toBe(offsetFromAnchor(shapes[1], FULL_BEFORE));
  });

  it("would leave the figures behind by exactly the growth without that policy (the failure this guards against)", () => {
    const savedWhileHidden = reanchorShapesAgainstMeasuredBlocks(shapes, FILTERED_GROWN, {});
    const moved = savedWhileHidden.find((shape) => shape.id === "fig_solution");
    // 描かれていない解答の代わりに、見えている問題文へ付け替えられる。
    expect(moved?.anchor).toMatchObject({ type: "block", blockId: "q1_prompt" });
    const shown = resolveShapesPosition(savedWhileHidden, rectsOf(FULL_AFTER));
    const solutionTop = FULL_AFTER.find((item) => item.id === "q1_solution")!.top;
    expect(shown.find((shape) => shape.id === "fig_solution")!.y - solutionTop).toBe(6 - GROWTH);
  });
});
