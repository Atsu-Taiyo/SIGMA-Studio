import { describe, expect, it } from "vitest";

import type { TextFlowBlock } from "@/features/text-editing";

import {
  buildTextRunReplacementMutations,
  shouldRestoreTextFlowSelectionAfterChange,
} from "./text-run-replacement";

const paragraph = (id: string, text = id): Extract<TextFlowBlock, { type: "paragraph" }> => ({
  type: "paragraph",
  id,
  children: text ? [{ type: "text", text }] : [],
});

const text = (block: TextFlowBlock): string => (
  block.type === "paragraph" || block.type === "heading"
    ? block.children.map((child) => child.type === "text" ? child.text : "\ufffc").join("")
    : ""
);

const crossChunkSegments = (
  before: TextFlowBlock[],
  after: TextFlowBlock[],
  options: { endsInside?: boolean; startsInside?: boolean } = {},
) => [
  {
    unitId: "chunk-a",
    scopeId: "document",
    previousIds: ["a"],
    before,
    after: [],
    preserveEmpty: false,
    startsInsideTextBlock: options.startsInside ?? true,
  },
  {
    unitId: "chunk-b",
    scopeId: "document",
    previousIds: ["b"],
    before: [],
    after,
    preserveEmpty: false,
    endsInsideTextBlock: options.endsInside ?? true,
  },
];

/** テスト用: 既定 affinity の文字キャレット。 */
function caretAddress(blockId: string, offset: number) {
  return { affinity: "after" as const, blockId, kind: "text" as const, offset };
}

/** テスト用: 1 点だけを指す選択。 */
function caretBookmark(blockId: string, offset: number, headOffset = offset) {
  return {
    anchor: caretAddress(blockId, offset),
    head: caretAddress(blockId, headOffset),
    preferredX: null,
  };
}

describe("buildTextRunReplacementMutations", () => {
  it("deletes fully covered body blocks while preserving structural flow containers", () => {
    const result = buildTextRunReplacementMutations([
      { unitId: "body-a", scopeId: "document", previousIds: ["a"], before: [paragraph("a-before")], after: [], preserveEmpty: false },
      { unitId: "problem", scopeId: "problem:p:prompt", previousIds: ["p"], before: [], after: [], preserveEmpty: true },
      { unitId: "body-b", scopeId: "document", previousIds: ["b"], before: [], after: [paragraph("b-after")], preserveEmpty: false },
    ], [], () => paragraph("empty", ""));

    expect(result.map(({ unitId, nextBlocks }) => [unitId, nextBlocks.map((block) => block.id)])).toEqual([
      ["body-a", ["a-before"]],
      ["problem", ["empty"]],
      ["body-b", ["b-after"]],
    ]);
  });

  it("puts replacement input only in the leading editor and returns one caret bookmark", () => {
    const result = buildTextRunReplacementMutations([
      { unitId: "layout", scopeId: "layout:a", previousIds: ["a"], before: [paragraph("before")], after: [], preserveEmpty: true },
      { unitId: "problem", scopeId: "problem:b:prompt", previousIds: ["b"], before: [], after: [paragraph("after")], preserveEmpty: true },
    ], [paragraph("inserted")], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["before", "inserted"]);
    expect(result[1].nextBlocks.map((block) => block.id)).toEqual(["after"]);
    expect(result.filter((mutation) => mutation.selection)).toHaveLength(1);
    expect(result[0].selection?.head.blockId).toBe("inserted");
  });

  it("coalesces adjacent editor chunks that share one SigmaDoc change scope", () => {
    const result = buildTextRunReplacementMutations([
      { unitId: "chunk-a", scopeId: "document", previousIds: ["a"], before: [paragraph("before")], after: [], preserveEmpty: false },
      { unitId: "chunk-b", scopeId: "document", previousIds: ["b"], before: [], after: [paragraph("after")], preserveEmpty: false },
    ], [], () => paragraph("empty", ""));

    expect(result).toHaveLength(1);
    expect(result[0].previousIds).toEqual(["a", "b"]);
    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["before", "after"]);
  });

  it("joins paragraph remnants and restores the deletion caret at their boundary", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments(
        [{ ...paragraph("a", "前半"), align: "right", children: [{ type: "text", text: "前半", marks: ["bold"] }] }],
        [{ ...paragraph("b", "後半"), align: "left", children: [{ type: "text", text: "後半", marks: ["italic"] }] }],
      ),
      [],
      () => paragraph("empty", ""),
    );

    expect(result).toHaveLength(1);
    expect(result[0].nextBlocks).toEqual([{
      type: "paragraph",
      id: "a",
      align: "right",
      children: [
        { type: "text", text: "前半", marks: ["bold"] },
        { type: "text", text: "後半", marks: ["italic"] },
      ],
    }]);
    expect(result[0].selection).toEqual(caretBookmark("a", 2));
  });

  it("does not join paragraph remnants across a manual break", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments(
        [paragraph("a", "前半")],
        [{ ...paragraph("b", "後半"), pagination: { break: true } }],
      ),
      [],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block), block.pagination?.break])).toEqual([
      ["a", "前半", undefined],
      ["b", "後半", true],
    ]);
  });

  it("puts replacement text before the trailing manual-break block without joining it", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments(
        [paragraph("a", "前半")],
        [{ ...paragraph("b", "後半"), pagination: { break: true } }],
      ),
      [paragraph("typed", "入力")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block), block.pagination?.break])).toEqual([
      ["a", "前半入力", undefined],
      ["b", "後半", true],
    ]);
  });

  it("retains every manual break across a replacement spanning three chunks", () => {
    const result = buildTextRunReplacementMutations([
      {
        unitId: "chunk-a", scopeId: "document", previousIds: ["a"],
        previousBlocks: [paragraph("a", "A")], before: [paragraph("a", "A")], after: [],
        startsInsideTextBlock: true, preserveEmpty: false,
      },
      {
        unitId: "chunk-b", scopeId: "document", previousIds: ["b"],
        previousBlocks: [{ ...paragraph("b", "B"), pagination: { break: true } }], before: [], after: [],
        preserveEmpty: false,
      },
      {
        unitId: "chunk-c", scopeId: "document", previousIds: ["c"],
        previousBlocks: [{ ...paragraph("c", "C"), pagination: { break: true } }], before: [],
        after: [{ ...paragraph("c", "C"), pagination: { break: true } }],
        endsInsideTextBlock: true, preserveEmpty: false,
      },
    ], [paragraph("typed", "X")], () => paragraph("empty", ""));

    const nextBlocks = result.flatMap((mutation) => mutation.nextBlocks);
    expect(nextBlocks.filter((block) => block.pagination?.break).map((block) => block.id)).toEqual(["b", "c"]);
    expect(nextBlocks.map(text).join("")).toBe("AXC");
  });

  it("keeps manual-break chunks as independent mutations when deleting across them", () => {
    const before = paragraph("p_before", "前の");
    const breakOwner = {
      ...paragraph("p_break", "の段落テキストです。"),
      pagination: { break: true as const },
    };
    const after = paragraph("p_after", "後ろの段落テキストです。");

    const result = buildTextRunReplacementMutations([{
      unitId: "before-unit",
      scopeId: "document",
      previousIds: ["p_before"],
      previousBlocks: [paragraph("p_before", "前の段落テキストです。")],
      before: [before],
      after: [],
      startsInsideTextBlock: true,
      preserveEmpty: false,
    }, {
      unitId: "break-unit",
      scopeId: "document",
      previousIds: ["p_break", "p_after"],
      previousBlocks: [{
        ...paragraph("p_break", "改ページ後の段落テキストです。"),
        pagination: { break: true },
      }, after],
      before: [],
      after: [breakOwner, after],
      endsInsideTextBlock: true,
      preserveEmpty: false,
    }], [], () => paragraph("empty", ""));

    expect(result.map(({ unitId, nextBlocks }) => ({
      unitId,
      blocks: nextBlocks.map((block) => [block.id, text(block), block.pagination?.break]),
    }))).toEqual([{
      unitId: "before-unit",
      blocks: [["p_before", "前の", undefined]],
    }, {
      unitId: "break-unit",
      blocks: [
        ["p_break", "の段落テキストです。", true],
        ["p_after", "後ろの段落テキストです。", undefined],
      ],
    }]);
  });

  it("drops only a copied leading break when the paste lands at a container start", () => {
    const result = buildTextRunReplacementMutations([{
      unitId: "chunk-a", scopeId: "layout:a", previousIds: ["old"], previousBlocks: [paragraph("old", "")],
      before: [], after: [], preserveEmpty: true, startsInsideTextBlock: false,
    }], [
      { ...paragraph("pasted-first", "一"), pagination: { break: true } },
      { ...paragraph("pasted-second", "二"), pagination: { break: true } },
    ], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.pagination?.break)).toEqual([undefined, true]);
  });

  it("joins a single-character paste or replacement with both paragraph remnants", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "AB")], [paragraph("b", "YZ")]),
      [paragraph("typed", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks).toHaveLength(1);
    expect(text(result[0].nextBlocks[0])).toBe("ABXYZ");
    expect(result[0].nextBlocks[0].id).toBe("a");
    expect(result[0].selection?.head).toEqual(caretAddress("a", 3));
  });

  it("places the caret after a multi-character paste across editor chunks", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "AB")], [paragraph("b", "YZ")]),
      [paragraph("paste", "middle")],
      () => paragraph("empty", ""),
    );

    expect(text(result[0].nextBlocks[0])).toBe("ABmiddleYZ");
    expect(result[0].selection?.head).toEqual(caretAddress("a", 8));
  });

  it("joins only the outer boundaries of a multi-block paste and focuses its final content", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "AB")], [paragraph("b", "YZ")]),
      [paragraph("paste-1", "one"), paragraph("paste-2", "two")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block)])).toEqual([
      ["a", "ABone"],
      ["paste-2", "twoYZ"],
    ]);
    expect(result[0].selection?.head).toEqual(caretAddress("paste-2", 3));
  });

  // 段落の先頭 (offset 0) / 末尾ちょうどの端点でも doc.slice はそのブロックの「空断片」を
  // 残す (startsInside/endsInside は true)。空断片が結合されず元 id のまま生き残ると、
  // 単一エディタなら結合される場面で空段落が残る。
  it("consumes an empty leading remnant so a paragraph-start selection leaves no empty block", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("x", "")], [paragraph("y", "tail")]),
      [],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks).toEqual([{
      type: "paragraph",
      id: "x",
      children: [{ type: "text", text: "tail" }],
    }]);
    expect(result[0].selection?.head).toEqual(caretAddress("x", 0));
  });

  it("consumes an empty trailing remnant so a selection ending at a paragraph end joins cleanly", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "head")], [paragraph("b", "")]),
      [],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks).toEqual([{
      type: "paragraph",
      id: "a",
      children: [{ type: "text", text: "head" }],
    }]);
    expect(result[0].selection?.head).toEqual(caretAddress("a", 4));
  });

  it("gives typed input the original block id when the selection starts at a paragraph start", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("x", "")], [paragraph("y", "tail")]),
      [paragraph("typed", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks).toHaveLength(1);
    expect(result[0].nextBlocks[0].id).toBe("x");
    expect(text(result[0].nextBlocks[0])).toBe("Xtail");
    expect(result[0].joinedInsertionIds).toEqual({ typed: "x" });
    expect(result[0].selection?.head).toEqual(caretAddress("x", 1));
  });

  it("reuses the trailing empty remnant as the split paragraph for Enter at a paragraph end", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "head")], [paragraph("b", "")]),
      [],
      () => paragraph("empty", ""),
      { splitAtBoundary: true },
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block)])).toEqual([
      ["a", "head"],
      ["b", ""],
    ]);
    expect(result[0].selection?.head).toEqual(caretAddress("b", 0));
  });

  it("keeps an exact paragraph-start boundary separate while joining a partial end", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("before", "before")], [paragraph("b", "tail")], { startsInside: false }),
      [paragraph("paste", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block)])).toEqual([
      ["before", "before"],
      ["paste", "Xtail"],
    ]);
    expect(result[0].selection?.head).toEqual(caretAddress("paste", 1));
  });

  it("keeps an exact paragraph-end boundary separate while joining a partial start", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "head")], [paragraph("after", "after")], { endsInside: false }),
      [paragraph("paste", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => [block.id, text(block)])).toEqual([
      ["a", "headX"],
      ["after", "after"],
    ]);
    expect(result[0].selection?.head).toEqual(caretAddress("a", 5));
  });

  it("does not join across exact block boundaries and deletes whole selected blocks", () => {
    const result = buildTextRunReplacementMutations([
      {
        unitId: "chunk-a",
        scopeId: "document",
        previousIds: ["a", "selected-a"],
        before: [paragraph("a", "keep before")],
        after: [],
        preserveEmpty: false,
        startsInsideTextBlock: false,
      },
      {
        unitId: "chunk-b",
        scopeId: "document",
        previousIds: ["selected-b", "d"],
        before: [],
        after: [paragraph("d", "keep after")],
        preserveEmpty: false,
        endsInsideTextBlock: false,
      },
    ], [], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["a", "d"]);
    expect(result[0].selection?.head).toEqual(caretAddress("d", 0));
  });

  it("restores the deletion caret at the retained prefix when the selection ends exactly at a boundary", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "head")], [paragraph("after", "after")], { endsInside: false }),
      [],
      () => paragraph("empty", ""),
    );

    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["a", "after"]);
    expect(result[0].selection).toEqual(caretBookmark("a", 4));
  });

  it("restores partial deletion at the join so the next typed character lands there", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "left")], [paragraph("b", "right")]),
      [],
      () => paragraph("empty", ""),
    );
    const block = result[0].nextBlocks[0];
    const caret = result[0].selection!.head.offset;
    const currentText = text(block);
    const afterTyping = `${currentText.slice(0, caret)}X${currentText.slice(caret)}`;

    expect(afterTyping).toBe("leftXright");
  });

  it("keeps one empty paragraph with a caret when whole-document deletion would leave no blocks", () => {
    const result = buildTextRunReplacementMutations([
      { unitId: "chunk-a", scopeId: "document", previousIds: ["a"], before: [], after: [], preserveEmpty: false },
      { unitId: "chunk-b", scopeId: "document", previousIds: ["b"], before: [], after: [], preserveEmpty: false },
    ], [], () => paragraph("empty", ""), { hasBlocksOutsideSpan: false });

    // 空段落の id は旧先頭ブロックから引き継ぐ (チャンクアンカー保持 = エディタの作り直し
    // とキャレット復元前の打鍵落ちを防ぐ)。
    expect(result).toHaveLength(1);
    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["a"]);
    expect(result[0].focusBlockId).toBe("a");
    expect(result[0].selection).toEqual(caretBookmark("a", 0));
  });

  it("deletes everything without a filler paragraph while other units still hold blocks", () => {
    const result = buildTextRunReplacementMutations([
      { unitId: "chunk-a", scopeId: "document", previousIds: ["a"], before: [], after: [], preserveEmpty: false },
    ], [], () => paragraph("empty", ""), { hasBlocksOutsideSpan: true });

    expect(result[0].nextBlocks).toEqual([]);
  });

  it("splits at the boundary for Enter instead of joining the paragraph remnants", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "前半")], [paragraph("b", "後半")]),
      [],
      () => paragraph("empty", ""),
      { splitAtBoundary: true },
    );

    expect(result).toHaveLength(1);
    expect(result[0].nextBlocks.map((block) => [block.id, text(block)])).toEqual([
      ["a", "前半"],
      ["b", "後半"],
    ]);
    expect(result[0].selection).toEqual(caretBookmark("b", 0));
  });

  it("inserts an empty paragraph for Enter when the selection ends exactly at a block boundary", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "head")], [paragraph("after", "after")], { endsInside: false }),
      [],
      () => paragraph("empty", ""),
      { splitAtBoundary: true },
    );

    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["a", "empty", "after"]);
    expect(result[0].selection?.head).toEqual(caretAddress("empty", 0));
  });

  it("reports the leading boundary join so pasted shape anchors can follow it", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "AB")], [paragraph("b", "YZ")]),
      [paragraph("pasted", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].joinedInsertionIds).toEqual({ pasted: "a" });
  });

  it("reports no join when the paste starts exactly at a block boundary", () => {
    const result = buildTextRunReplacementMutations(
      crossChunkSegments([paragraph("a", "AB")], [paragraph("b", "YZ")], { startsInside: false }),
      [paragraph("pasted", "X")],
      () => paragraph("empty", ""),
    );

    expect(result[0].joinedInsertionIds).toBeUndefined();
    expect(result[0].nextBlocks.some((block) => block.id === "pasted")).toBe(true);
  });

  it("carries the leading unit's first block id onto input inserted at the unit start", () => {
    // ユニット先頭 (before 空 = ブロック境界ちょうど) からの置換は旧先頭ブロックの id を
    // 引き継ぐ。チャンクアンカー = 先頭ブロック id なので、変わるとエディタが作り直され、
    // キャレット復元前に届いた次の打鍵が落ちる (全選択タイプの 2 文字目消失)。
    const result = buildTextRunReplacementMutations([
      {
        unitId: "chunk-a",
        scopeId: "document",
        previousIds: ["a", "a2"],
        before: [],
        after: [],
        preserveEmpty: false,
        startsInsideTextBlock: false,
      },
      {
        unitId: "chunk-b",
        scopeId: "document",
        previousIds: ["b"],
        before: [],
        after: [],
        preserveEmpty: false,
        endsInsideTextBlock: false,
      },
    ], [paragraph("typed", "X")], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["a"]);
    expect(text(result[0].nextBlocks[0])).toBe("X");
    expect(result[0].joinedInsertionIds).toEqual({ typed: "a" });
    expect(result[0].selection?.head).toEqual(caretAddress("a", 1));
  });

  it("bookmarks nested boundaries at the leaf block in PM content offsets", () => {
    const boxParagraph = paragraph("box-p", "枠内");
    const result = buildTextRunReplacementMutations(
      crossChunkSegments(
        [{ type: "boxBlock", id: "box", styleId: "fancybox", blocks: [boxParagraph] }],
        [{
          type: "list",
          id: "list",
          listType: "bullet",
          items: [{ type: "listItem", id: "li-1", children: [{ type: "text", text: "項目" }] }],
        }],
        { startsInside: true, endsInside: false },
      ),
      [],
      () => paragraph("empty", ""),
    );

    // 復元側 (getTextFlowSelectionPosition) は offset をブロックノードの PM content offset と
    // して解釈する。コンテナの平坦化文字数ではなく、葉ブロック id + その文字数で表す。
    expect(result[0].selection).toEqual(caretBookmark("box-p", 2));
  });
});

describe("shouldRestoreTextFlowSelectionAfterChange", () => {
  const caretAt = (blockId: string) => caretBookmark(blockId, 1);

  it("restores a cross-editor replacement even when the caret block id already existed", () => {
    const selection = caretAt("a");
    expect(shouldRestoreTextFlowSelectionAfterChange(
      ["a", "b"],
      [paragraph("a", "joined")],
      selection,
      { historyGroup: "g", selection, crossEditor: true },
    )).toBe(true);
  });

  it("skips ordinary typing whose caret block already existed", () => {
    const selection = caretAt("a");
    expect(shouldRestoreTextFlowSelectionAfterChange(
      ["a"],
      [paragraph("a", "typed")],
      selection,
      { historyGroup: "g", selection },
    )).toBe(false);
  });

  it("restores when the caret lands on a newly created block", () => {
    const selection = caretAt("new");
    expect(shouldRestoreTextFlowSelectionAfterChange(
      ["a"],
      [paragraph("a"), paragraph("new")],
      selection,
      { historyGroup: "g", selection },
    )).toBe(true);
  });

  it("never restores when the caret block is absent from the next blocks", () => {
    const selection = caretAt("gone");
    expect(shouldRestoreTextFlowSelectionAfterChange(
      ["gone"],
      [paragraph("other")],
      selection,
      { historyGroup: "g", selection, crossEditor: true },
    )).toBe(false);
  });

  it("never restores without a selection bookmark", () => {
    expect(shouldRestoreTextFlowSelectionAfterChange(
      ["a"],
      [paragraph("a")],
      null,
      { historyGroup: "g", crossEditor: true },
    )).toBe(false);
  });
});

describe("段組セクションの貼り付け先", () => {
  const section: TextFlowBlock = {
    type: "layoutSection",
    id: "layout_1",
    layout: { columnCount: 2 },
    children: [paragraph("in_1"), paragraph("in_2")],
  };

  it("段の中へは段組を解いて段落として入れる", () => {
    // SigmaDoc では段の中に段組を入れられない。解かずに書くと不正な入れ子ができる。
    const result = buildTextRunReplacementMutations([{
      unitId: "layout-unit",
      scopeId: "layout:layout_target",
      previousIds: ["target"],
      before: [paragraph("kept")],
      after: [],
      preserveEmpty: true,
      acceptsLayoutSection: false,
      startsInsideTextBlock: false,
    }], [section], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(result[0].nextBlocks.map((block) => block.id)).toEqual(["kept", "in_1", "in_2"]);
  });

  it("本文へはそのまま段組として入れる", () => {
    const result = buildTextRunReplacementMutations([{
      unitId: "body",
      scopeId: "document",
      previousIds: ["target"],
      before: [paragraph("kept")],
      after: [],
      preserveEmpty: false,
      acceptsLayoutSection: true,
      startsInsideTextBlock: false,
    }], [section], () => paragraph("empty", ""));

    expect(result[0].nextBlocks.map((block) => block.type)).toEqual(["paragraph", "layoutSection"]);
  });
});
