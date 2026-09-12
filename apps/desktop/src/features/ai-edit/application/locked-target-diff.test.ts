import { describe, expect, it } from "vitest";

import { findAiLockedTargetsTouched, hasAiLockedTargetsTouched } from "./locked-target-diff";
import { EMPTY_AI_LOCKED_TARGETS, mergeAiLockedTargets } from "./locked-targets";
import { derivePendingAiProposalLockTargets } from "@/features/ai-edit/model/preview";
import type { AiEditPreviewState } from "@/features/ai-edit/model/preview";
import type { SigmaDocument } from "@/types/sigma-doc";

function paragraph(id: string, text: string) {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

function rect(id: string, x: number) {
  return { id, type: "rect", x, y: 0, w: 10, h: 10 };
}

function makeDocument(
  blocks: ReturnType<typeof paragraph>[],
  shapes: ReturnType<typeof rect>[] = [],
): SigmaDocument {
  return {
    content: blocks,
    pageLayout: {
      overlay: { overlaySnapshot: { version: 1, shapes, assets: {} } },
    },
  } as unknown as SigmaDocument;
}

function locked(blockIds: string[], shapeIds: string[] = []) {
  return mergeAiLockedTargets(blockIds, shapeIds, { blockIds: [], shapeIds: [] });
}

describe("findAiLockedTargetsTouched", () => {
  it("reports nothing when no target is locked", () => {
    const before = makeDocument([paragraph("p1", "before")]);
    const after = makeDocument([paragraph("p1", "after")]);

    expect(findAiLockedTargetsTouched(before, after, EMPTY_AI_LOCKED_TARGETS))
      .toEqual({ blockIds: [], shapeIds: [] });
  });

  it("allows editing a block the AI does not hold", () => {
    const untouched = paragraph("p1", "AIの対象");
    const before = makeDocument([untouched, paragraph("p2", "人間が編集")]);
    const after = makeDocument([untouched, paragraph("p2", "人間が編集した")]);

    const touched = findAiLockedTargetsTouched(before, after, locked(["p1"]));

    expect(touched).toEqual({ blockIds: [], shapeIds: [] });
    expect(hasAiLockedTargetsTouched(touched)).toBe(false);
  });

  // A body edit commits blocks round-tripped through Tiptap, which rebuilds
  // every block in the edited flow and can reorder their JSON keys. Treating
  // that as a change refused edits to entirely unrelated blocks.
  it("treats a locked block whose keys were merely reordered as untouched", () => {
    const before = makeDocument([
      { id: "p1", type: "paragraph", children: [{ type: "text", text: "同じ内容" }] },
      paragraph("p2", "編集する段落"),
    ]);
    const after = makeDocument([
      { type: "paragraph", id: "p1", children: [{ text: "同じ内容", type: "text" }] } as unknown as ReturnType<typeof paragraph>,
      paragraph("p2", "編集した段落"),
    ]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])))
      .toEqual({ blockIds: [], shapeIds: [] });
  });

  it("treats an absent field and an explicitly undefined field as equal", () => {
    const before = makeDocument([
      { id: "p1", type: "paragraph", children: [{ type: "text", text: "本文" }] },
    ]);
    const after = makeDocument([
      { id: "p1", type: "paragraph", align: undefined, children: [{ type: "text", text: "本文" }] } as unknown as ReturnType<typeof paragraph>,
    ]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])).blockIds).toEqual([]);
  });

  it("still catches a reordering of inline children, which is real content", () => {
    const before = makeDocument([
      { id: "p1", type: "paragraph", children: [{ type: "text", text: "A" }, { type: "text", text: "B" }] },
    ]);
    const after = makeDocument([
      { id: "p1", type: "paragraph", children: [{ type: "text", text: "B" }, { type: "text", text: "A" }] },
    ]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])).blockIds).toEqual(["p1"]);
  });

  it("refuses a content change to a locked block", () => {
    const before = makeDocument([paragraph("p1", "元の式")]);
    const after = makeDocument([paragraph("p1", "書き換えた式")]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])).blockIds).toEqual(["p1"]);
  });

  it("refuses deleting a locked block", () => {
    const before = makeDocument([paragraph("p1", "a"), paragraph("p2", "b")]);
    const after = makeDocument([paragraph("p2", "b")]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])).blockIds).toEqual(["p1"]);
  });

  it("refuses a change to a locked block nested inside a container", () => {
    const nest = (childText: string) => ({
      id: "section-1",
      type: "layoutSection",
      columns: 2,
      children: [paragraph("p-nested", childText)],
    }) as unknown as ReturnType<typeof paragraph>;
    const before = makeDocument([nest("元")]);
    const after = makeDocument([nest("変更後")]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p-nested"])).blockIds)
      .toEqual(["p-nested"]);
  });

  it("allows a locked block that merely moved, since approval replays by targetId", () => {
    const held = paragraph("p1", "AIの対象");
    const other = paragraph("p2", "別の段落");
    const before = makeDocument([held, other]);
    const after = makeDocument([other, held]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"])).blockIds).toEqual([]);
  });

  it("ignores a locked id that does not exist in the previous document", () => {
    const before = makeDocument([paragraph("p1", "a")]);
    const after = makeDocument([paragraph("p1", "a"), paragraph("p2", "new")]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p2"])).blockIds).toEqual([]);
  });

  it("refuses moving a locked shape but allows moving an unlocked one", () => {
    const before = makeDocument([], [rect("s1", 0), rect("s2", 0)]);
    const movedLocked = makeDocument([], [rect("s1", 40), rect("s2", 0)]);
    const movedOther = makeDocument([], [rect("s1", 0), rect("s2", 40)]);
    const targets = locked([], ["s1"]);

    expect(findAiLockedTargetsTouched(before, movedLocked, targets).shapeIds).toEqual(["s1"]);
    expect(findAiLockedTargetsTouched(before, movedOther, targets).shapeIds).toEqual([]);
  });

  it("refuses deleting a locked shape", () => {
    const before = makeDocument([], [rect("s1", 0)]);
    const after = makeDocument([], []);

    expect(findAiLockedTargetsTouched(before, after, locked([], ["s1"])).shapeIds).toEqual(["s1"]);
  });

  it("allows inserting a new shape while another shape is locked", () => {
    const held = rect("s1", 0);
    const before = makeDocument([], [held]);
    const after = makeDocument([], [held, rect("s-new", 100)]);

    expect(findAiLockedTargetsTouched(before, after, locked([], ["s1"])))
      .toEqual({ blockIds: [], shapeIds: [] });
  });

  it("reports both kinds when one change straddles a locked block and a locked shape", () => {
    const before = makeDocument([paragraph("p1", "元")], [rect("s1", 0)]);
    const after = makeDocument([paragraph("p1", "後")], [rect("s1", 40)]);

    expect(findAiLockedTargetsTouched(before, after, locked(["p1"], ["s1"])))
      .toEqual({ blockIds: ["p1"], shapeIds: ["s1"] });
  });
});

/**
 * pending 提案のロックは「決めるまで」の予約。**解決したら外れる**ことが、
 * `restoreDocumentHistory` が ref から読む価値の裏づけになる —— ロック集合は
 * 提案の解決に合わせて動くので、⌘Z のたびに**その時点の集合**を読まなければならない。
 */
function previewHolding(targetIds: string[]): AiEditPreviewState {
  return {
    draft: {
      operations: targetIds.map((targetId) => ({
        operation: "replace",
        targetId,
        // アンカー補助の下書きを除外する判定が読む (本物の下書きは必ず持っている)。
        summary: "本文を書き換える",
      })),
    },
  } as unknown as AiEditPreviewState;
}

function lockedByPreviews(previews: AiEditPreviewState[]) {
  return mergeAiLockedTargets([], [], derivePendingAiProposalLockTargets(previews));
}

describe("a pending proposal's reservation", () => {
  const before = makeDocument([paragraph("p1", "元"), paragraph("p2", "別")]);
  const undoOfP1 = makeDocument([paragraph("p1", "戻した"), paragraph("p2", "別")]);

  it("refuses an undo that would rewrite what the proposal is holding", () => {
    const targets = lockedByPreviews([previewHolding(["p1"])]);

    expect(hasAiLockedTargetsTouched(findAiLockedTargetsTouched(before, undoOfP1, targets)))
      .toBe(true);
  });

  it("lets the same undo through once the proposal is resolved", () => {
    // 適用・却下で提案はプレビュー集合から外れる。**そこでロックも外れる**。
    const targets = lockedByPreviews([]);

    expect(hasAiLockedTargetsTouched(findAiLockedTargetsTouched(before, undoOfP1, targets)))
      .toBe(false);
  });

  it("keeps undo available elsewhere while the proposal is still pending", () => {
    // ロックは「握っている対象」だけ。実行中でも他所の undo は通る。
    const targets = lockedByPreviews([previewHolding(["p1"])]);
    const undoOfP2 = makeDocument([paragraph("p1", "元"), paragraph("p2", "戻した")]);

    expect(hasAiLockedTargetsTouched(findAiLockedTargetsTouched(before, undoOfP2, targets)))
      .toBe(false);
  });

  it("releases only the proposal that was resolved", () => {
    const targets = lockedByPreviews([previewHolding(["p2"])]);

    expect(hasAiLockedTargetsTouched(findAiLockedTargetsTouched(before, undoOfP1, targets)))
      .toBe(false);
    const stillHeld = makeDocument([paragraph("p1", "元"), paragraph("p2", "戻した")]);
    expect(hasAiLockedTargetsTouched(findAiLockedTargetsTouched(before, stillHeld, targets)))
      .toBe(true);
  });
});

describe("a live text-fragment reservation", () => {
  const original = "前の本文【AI対象】後の本文";
  const targets = mergeAiLockedTargets(["p1"], [], { blockIds: [], shapeIds: [] }, [], new Map([
    ["p1", [{ baselineText: original, ranges: [{ from: 4, to: 10 }], inlineMathIds: [] }]],
  ]));
  const before = makeDocument([paragraph("p1", original)]);

  it("commits edits on both sides of the reservation, including subsequent saves", () => {
    const after = makeDocument([paragraph("p1", "前の本文を追記【AI対象】後の本文も編集")]);
    expect(findAiLockedTargetsTouched(before, after, targets).blockIds).toEqual([]);
    const next = makeDocument([paragraph("p1", "前の本文を追記【AI対象】後の本文も編集した")]);
    expect(findAiLockedTargetsTouched(after, next, targets).blockIds).toEqual([]);
  });

  it("refuses deletion or changes to the reservation", () => {
    expect(findAiLockedTargetsTouched(before, makeDocument([]), targets).blockIds).toEqual(["p1"]);
    expect(findAiLockedTargetsTouched(before, makeDocument([paragraph("p1", "前の本文【人間対象】後の本文")]), targets).blockIds).toEqual(["p1"]);
  });

  it("checks formatting inside the fragment while allowing formatting outside it", () => {
    const after = structuredClone(before);
    const block = after.content[0];
    if (block.type !== "paragraph") throw new Error("paragraph required");
    block.children = [
      { type: "text", text: "前の本文", marks: ["bold"] },
      { type: "text", text: "【AI対象】後の本文" },
    ];
    expect(findAiLockedTargetsTouched(before, after, targets).blockIds).toEqual([]);
    block.children = [{ type: "text", text: original, marks: ["bold"] }];
    expect(findAiLockedTargetsTouched(before, after, targets).blockIds).toEqual(["p1"]);
  });

  it("reserves a math atom without reserving the surrounding text", () => {
    const before = makeDocument([paragraph("p1", "")]);
    const block = before.content[0];
    if (block.type !== "paragraph") throw new Error("paragraph required");
    block.children = [{ type: "text", text: "前" }, { type: "mathInline", id: "m1", tex: "x", display: "inline" }, { type: "text", text: "後" }];
    const targets = mergeAiLockedTargets(["p1"], [], { blockIds: [], shapeIds: [] }, [], new Map([
      ["p1", [{ baselineText: "前$x$後", ranges: [], inlineMathIds: ["m1"] }]],
    ]));
    const after = structuredClone(before);
    const nextBlock = after.content[0];
    if (nextBlock.type !== "paragraph") throw new Error("paragraph required");
    nextBlock.children[0] = { type: "text", text: "前に追記" };
    expect(findAiLockedTargetsTouched(before, after, targets).blockIds).toEqual([]);
    nextBlock.children[1] = { type: "mathInline", id: "m1", tex: "y", display: "inline" };
    expect(findAiLockedTargetsTouched(before, after, targets).blockIds).toEqual(["p1"]);
  });
});
