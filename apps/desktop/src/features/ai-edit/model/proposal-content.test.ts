import { describe, expect, it } from "vitest";

import type {
  InlineNode,
  OverlayAsset,
  OverlayImageShape,
  OverlayShape,
  SigmaBlock,
  SigmaDocument,
} from "@/features/document";
import type { AiEditDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { buildAppliedDiffRows } from "@/lib/ai/applied-diff-lines";
import { computeProposalMergeBasis } from "@/lib/ai/proposal-merge-basis";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import type { AiEditPreviewState } from "./preview";
import {
  AI_PROPOSAL_PREVIEW_ID_PREFIX,
  AI_PROPOSAL_WORD_HIGHLIGHT,
  buildAppliedProposalContent,
  buildPendingProposalContent,
  collectPendingRemovedBlockIds,
  collectProposalRemovals,
  collectShapesKeptByMerge,
  groupPendingProposalContentByAnchor,
  isProposalContentEmpty,
  proposalContentToAppliedDiff,
  toDisplayProposalHunk,
} from "./proposal-content";
import { resolveProposalMergePreview } from "./proposal-merge-preview";

/** 承認と同じ replay で作る、保留中の提案の適用後の文書。 */
function resolvePendingProposalAfterDocument(document: SigmaDocument, preview: AiEditPreviewState): SigmaDocument | null {
  return resolveProposalMergePreview(document, preview).afterDocument;
}

function paragraph(id: string, text: string): SigmaBlock {
  return { id, type: "paragraph", children: [{ type: "text", text }] };
}

function documentOf(content: SigmaBlock[], extra: Partial<SigmaDocument> = {}): SigmaDocument {
  return parseSigmaDocument({
    version: "2.0",
    docId: "doc_proposal_content",
    metadata: { title: "提案内容" },
    content,
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    ...extra,
  });
}

function problem(): SigmaBlock {
  return {
    id: "problem_1",
    type: "problem",
    tags: [],
    lead: [],
    prompt: [paragraph("prompt_1", "元の問題文") as never],
    hints: [],
    solution: [paragraph("solution_1", "元の解答") as never],
    answer: { type: "math", expected: "" },
    numbering: { value: 7 },
  } as SigmaBlock;
}

function box(): SigmaBlock {
  return {
    id: "box_1",
    type: "boxBlock",
    styleId: "itembox",
    title: [{ type: "text", text: "要点" }],
    blocks: [paragraph("box_p", "箱の本文") as never],
  } as SigmaBlock;
}

function baseDocument(): SigmaDocument {
  return documentOf([paragraph("p1", "変更前の問題文"), problem(), box(), paragraph("p_last", "最後")]);
}

function previewOf(
  operations: AiEditDraft[],
  mutationOperations: SigmaDocMutationOp[] = [],
  overrides: Partial<AiEditPreviewState> = {},
): AiEditPreviewState {
  return {
    targetId: operations[0]?.targetId ?? "",
    draft: {
      summary: "提案",
      plan: [],
      warnings: [],
      operations,
      ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
    },
    createdAt: 0,
    proposalIds: ["proposal_1"],
    baseRevision: 1,
    providers: ["chatgpt"],
    ...overrides,
  };
}

function replace(targetId: string, text: string): AiEditDraft {
  return { operation: "replace", summary: "書き換え", targetId, replacementBlock: paragraph(targetId, text) as never };
}

function insertAfter(targetId: string, insertedId: string, text: string): AiEditDraft {
  return { operation: "insertAfter", summary: text, targetId, insertedBlock: paragraph(insertedId, text) as never };
}

function pending(document: SigmaDocument, preview: AiEditPreviewState) {
  return buildPendingProposalContent(document, resolvePendingProposalAfterDocument(document, preview), preview);
}

const PNG_ASSET: OverlayAsset = {
  id: "asset_1",
  type: "image",
  props: {
    w: 40,
    h: 30,
    name: "図.png",
    isAnimated: false,
    mimeType: "image/png",
    src: "data:image/png;base64,AA==",
    fileSize: 1,
  },
};

function imageShape(): OverlayImageShape {
  return { id: "img_1", type: "image", x: 10, y: 20, rotation: 0, props: { assetId: "asset_1", w: 40, h: 30 } };
}

function overlayDocument(shapes: OverlayShape[]): SigmaDocument {
  return {
    ...baseDocument(),
    pageLayout: {
      overlay: { overlaySnapshot: { version: 1, shapes, assets: { asset_1: PNG_ASSET } } },
    },
  } as unknown as SigmaDocument;
}

function texts(nodes: readonly InlineNode[]): string {
  return nodes.map((node) => (node.type === "text" ? node.text : `$${node.tex}$`)).join("");
}

describe("buildPendingProposalContent", () => {
  it("pairs the current block with the proposed one at the replaced block", () => {
    const document = baseDocument();
    const content = pending(document, previewOf([replace("p1", "変更後の問題文")]));

    expect(content.hunks).toHaveLength(1);
    const [hunk] = content.hunks;
    expect(hunk.anchorBlockId).toBe("p1");
    expect(hunk.operations).toEqual(["replace"]);
    expect(hunk.removed.map((block) => block.id)).toEqual(["p1"]);
    expect(hunk.added.map((block) => block.id)).toEqual(["p1"]);
    expect(texts((hunk.removed[0] as { children: InlineNode[] }).children)).toBe("変更前の問題文");
    expect(texts((hunk.added[0] as { children: InlineNode[] }).children)).toBe("変更後の問題文");
    expect(content.shapes).toEqual([]);
  });

  it("folds a chain of insertAfter ops onto the real anchor, in the order the applied document has them", () => {
    const content = pending(baseDocument(), previewOf([
      insertAfter("p1", "ins_0", "候補0"),
      insertAfter("ins_0", "ins_1", "候補1"),
      insertAfter("ins_1", "ins_2", "候補2"),
    ]));

    expect(content.hunks.map((hunk) => hunk.anchorBlockId)).toEqual(["p1"]);
    expect(content.hunks[0].added.map((block) => block.id)).toEqual(["ins_0", "ins_1", "ins_2"]);
    expect(content.hunks[0].operations).toEqual(["insertAfter", "insertAfter", "insertAfter"]);
  });

  it("orders two inserts after the same block as the applied document places them, not by op order", () => {
    const content = pending(baseDocument(), previewOf([
      insertAfter("p1", "first", "先に挿入"),
      insertAfter("p1", "second", "後から p1 の直後へ"),
    ]));

    // 2 つ目は p1 の直後に入るので、適用後の文書では first より前に来る。
    expect(content.hunks[0].added.map((block) => block.id)).toEqual(["second", "first"]);
  });

  it("keeps the problem-area ownership and the applied problem number for an edit inside a problem", () => {
    const content = pending(baseDocument(), previewOf([insertAfter("prompt_1", "next_prompt", "新しい問題文")]));

    const [hunk] = content.hunks;
    expect(hunk.anchorBlockId).toBe("prompt_1");
    expect(hunk.problemArea).toEqual({ problemId: "problem_1", area: "prompt" });
    expect(hunk.numbering.added.problems.get("problem_1")).toBe(7);
  });

  it("lifts a nested target to the flow block the page can hang content after", () => {
    const content = pending(baseDocument(), previewOf([replace("box_p", "箱の新しい本文")]));

    expect(content.hunks.map((hunk) => hunk.anchorBlockId)).toEqual(["box_1"]);
    expect(content.hunks[0].added.map((block) => block.id)).toEqual(["box_p"]);
  });

  it("presents a list item inside a one-item list that keeps its nested items and its number", () => {
    const document = documentOf([{
      id: "list_1",
      type: "list",
      listType: "ordered",
      start: 3,
      items: [
        { type: "listItem", id: "li_0", children: [{ type: "text", text: "前" }] },
        {
          type: "listItem",
          id: "li_1",
          children: [{ type: "text", text: "親" }],
          nested: [{ id: "nested_1", type: "list", listType: "bullet", items: [{ type: "listItem", id: "li_1a", children: [{ type: "text", text: "子" }] }] }],
        },
      ],
    } as SigmaBlock]);
    const content = pending(document, previewOf([{
      operation: "replace",
      summary: "子の項目を直す",
      targetId: "li_1",
      replacementBlock: {
        type: "listItem",
        id: "li_1",
        children: [{ type: "text", text: "親" }],
        nested: [{ id: "nested_1", type: "list", listType: "bullet", items: [{ type: "listItem", id: "li_1a", children: [{ type: "text", text: "子を直した" }] }] }],
      } as never,
    }]));

    const [hunk] = content.hunks;
    expect(hunk.anchorBlockId).toBe("list_1");
    for (const block of [...hunk.removed, ...hunk.added]) {
      expect(block).toMatchObject({ id: "li_1", type: "list", listType: "ordered", start: 4 });
    }
    // 件数は変わった子の行だけ (変わらない親の行は数えない)。
    expect(buildAppliedDiffRows(proposalContentToAppliedDiff(content)).filter((row) => row.type !== "context").map((row) => [row.type, row.key]))
      .toEqual([["removed", "li_1a"], ["added", "li_1a"]]);
  });

  it("uses the proposed numbering setting, including a hidden number", () => {
    const document = baseDocument();
    const current = document.content[1] as Extract<SigmaBlock, { type: "problem" }>;
    const content = pending(document, previewOf([{
      operation: "replace",
      summary: "問題番号を非表示",
      targetId: "problem_1",
      replacementBlock: { ...current, numbering: { enabled: false, value: 12 } } as never,
    }]));

    const [hunk] = content.hunks;
    expect(hunk.anchorBlockId).toBe("problem_1");
    expect(hunk.problemArea).toBeUndefined();
    expect(hunk.numbering.added.problems.has("problem_1")).toBe(false);
    expect(hunk.numbering.removed.problems.get("problem_1")).toBe(7);
  });

  it("leaves the shape's anchor-support paragraph and the shape itself out of the body hunks", () => {
    const supportDraft = {
      operation: "replace",
      summary: "図形の挿入先として問題の問題文に空行を追加しました。",
      targetId: "problem_1",
      replacementBlock: { id: "problem_1", type: "problem", prompt: [] },
    } as unknown as AiEditDraft;
    const shapeDraft: AiEditDraft = {
      operation: "insertOverlayShape",
      summary: "画像を挿入",
      targetId: "p1",
      overlayShape: imageShape(),
      assets: { asset_1: PNG_ASSET },
    };
    const content = buildPendingProposalContent(
      baseDocument(),
      null,
      previewOf([supportDraft, shapeDraft, insertAfter("p_last", "body_insert", "本文の追加")]),
    );

    expect(content.hunks.map((hunk) => hunk.anchorBlockId)).toEqual(["p_last"]);
    expect(content.hunks[0].added.map((block) => block.id)).toEqual(["body_insert"]);
    expect(content.shapes.map((entry) => [entry.change, entry.shape.id])).toEqual([["added", "img_1"]]);
    expect(content.shapes[0].assets.asset_1).toEqual(PNG_ASSET);
  });

  it("shows the blocks a deletion removes and keeps a moved-only op as a note", () => {
    const content = pending(baseDocument(), previewOf([], [
      { operation: "deleteBlocks", summary: "2件を削除", blockIds: ["p1", "p_last"] },
      { operation: "moveBlocks", summary: "解答を移動", blockIds: ["box_1"], targetId: "p1", position: "before" },
    ]));

    const deletion = content.hunks.find((hunk) => hunk.anchorBlockId === "p1");
    expect(deletion?.removed.map((block) => block.id)).toEqual(["p1", "p_last"]);
    expect(deletion?.added).toEqual([]);
    expect(deletion?.notes).toEqual(["2件を削除"]);
    expect(deletion?.operations).toEqual(["deleteBlocks"]);
    const move = content.hunks.find((hunk) => hunk.anchorBlockId === "box_1");
    expect(move?.notes).toEqual(["解答を移動"]);
    expect(move?.removed).toEqual([]);
    expect(move?.added).toEqual([]);
  });

  it("draws an updated image with the document's assets on both sides", () => {
    const document = overlayDocument([imageShape()]);
    const content = pending(document, previewOf([], [
      { operation: "updateOverlayShape", summary: "画像を右へ", shapeId: "img_1", patch: { x: 120 } },
    ]));

    expect(content.hunks).toEqual([]);
    expect(content.shapes.map((entry) => [entry.change, entry.shape.id, entry.shape.x])).toEqual([
      ["removed", "img_1", 10],
      ["added", "img_1", 120],
    ]);
    expect(content.shapes.every((entry) => entry.assets.asset_1?.props.src === PNG_ASSET.props.src)).toBe(true);
  });

  it("shows a replaced shape as removed and the replacement at the old shape's place and identity", () => {
    const oldShape = {
      id: "shape_old",
      type: "geo",
      x: 48,
      y: 72,
      rotation: Math.PI / 6,
      opacity: 0.4,
      props: { w: 80, h: 40 },
    } as unknown as OverlayShape;
    const temporaryShape = {
      id: "shape_temporary",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 120, h: 60 },
    } as unknown as OverlayShape;
    const content = buildPendingProposalContent(overlayDocument([oldShape]), null, previewOf(
      [{ operation: "insertOverlayShape", summary: "置き換え後の図形を挿入", targetId: "p1", overlayShape: temporaryShape as never, assets: {} }],
      [{ operation: "deleteOverlayShapes", summary: "旧図形を削除", shapeIds: ["shape_old"] }],
      { shapeReplacements: [{ removedShapeId: "shape_old", addedShapeId: "shape_temporary" }] },
    ));

    expect(content.shapes.map((entry) => entry.change)).toEqual(["removed", "added"]);
    expect(content.shapes[0]?.shape).toEqual(oldShape);
    expect(content.shapes[1]?.shape).toMatchObject({ id: "shape_old", x: 48, y: 72, rotation: Math.PI / 6, opacity: 0.4, props: { w: 120, h: 60 } });
  });

  it("uses the replaced table's place for a table replacement", () => {
    const oldTable = {
      id: "table_old",
      type: "tableShape",
      x: 24,
      y: 36,
      rotation: Math.PI / 15,
      opacity: 0.65,
      props: { w: 180, h: 90, table: { rows: [] } },
    } as unknown as OverlayShape;
    const newTable = {
      id: "table_temporary",
      type: "tableShape",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 220, h: 120, table: { rows: [] } },
    } as unknown as OverlayShape;
    const content = buildPendingProposalContent(overlayDocument([oldTable]), null, previewOf(
      [{ operation: "insertTableShape", summary: "置き換え後の表を挿入", targetId: "p1", tableShape: newTable as never }],
      [],
      { shapeReplacements: [{ removedShapeId: "table_old", addedShapeId: "table_temporary" }] },
    ));

    expect(content.shapes.map((entry) => [entry.change, entry.shape.id])).toEqual([["removed", "table_old"], ["added", "table_old"]]);
    expect(content.shapes[1]?.shape).toMatchObject({ x: 24, y: 36, rotation: Math.PI / 15, opacity: 0.65, props: { w: 220, h: 120 } });
  });

  it("reads the proposed blocks from the after-document it is given, not from the draft", () => {
    // WI-7 は合成後の文書をここへ渡す。draft の中身ではなく、渡された文書の中身を見せる。
    const document = baseDocument();
    const merged = documentOf([paragraph("p1", "人間とAIを合わせた文"), problem(), box(), paragraph("p_last", "最後")]);
    const content = buildPendingProposalContent(document, merged, previewOf([replace("p1", "AIだけの文")]));

    expect(texts((content.hunks[0].added[0] as { children: InlineNode[] }).children)).toBe("人間とAIを合わせた文");
  });

  it("falls back to the draft's own blocks and the current numbering when no after-document exists", () => {
    const content = buildPendingProposalContent(baseDocument(), null, previewOf([replace("p1", "AIだけの文")]));

    expect(texts((content.hunks[0].added[0] as { children: InlineNode[] }).children)).toBe("AIだけの文");
    expect(content.hunks[0].numbering.added.problems.get("problem_1")).toBe(7);
  });

  it("drops a proposed block that a later op of the same draft removed again", () => {
    const content = pending(baseDocument(), previewOf(
      [insertAfter("p1", "temporary", "一時的")],
      [{ operation: "deleteBlocks", summary: "一時的な段落を削除", blockIds: ["temporary"] }],
    ));

    expect(content.hunks.flatMap((hunk) => hunk.added.map((block) => block.id))).not.toContain("temporary");
  });
});

describe("resolveProposalMergePreview (after-document of a pending proposal)", () => {
  it("replays the draft once per document and preview, and skips overlay-only proposals", () => {
    const document = baseDocument();
    const preview = previewOf([replace("p1", "変更後")]);

    const first = resolvePendingProposalAfterDocument(document, preview);
    expect(first).not.toBeNull();
    expect(resolvePendingProposalAfterDocument(document, preview)).toBe(first);
    expect(resolvePendingProposalAfterDocument(document, previewOf([], [
      { operation: "updateOverlayShape", summary: "図形を移動", shapeId: "img_1", patch: { x: 1 } },
    ]))).toBeNull();
  });

  it("keeps only the latest after-document per proposal, so older documents in the undo history are not pinned", () => {
    const preview = previewOf([replace("p1", "変更後")]);
    const first = baseDocument();
    const afterFirst = resolvePendingProposalAfterDocument(first, preview);
    resolvePendingProposalAfterDocument(baseDocument(), preview);
    resolvePendingProposalAfterDocument(baseDocument(), preview);

    // 3 回差し替えた後に最初の文書で引き直すと、作り直しになる (最初の結果は持ち続けていない)。
    const again = resolvePendingProposalAfterDocument(first, preview);
    expect(again).not.toBeNull();
    expect(again).not.toBe(afterFirst);
    // 同じ文書のままなら、紙面とサイドバーで同じ結果を共有する。
    expect(resolvePendingProposalAfterDocument(first, preview)).toBe(again);
  });

  it("returns null instead of throwing when a stale proposal no longer replays", () => {
    expect(resolvePendingProposalAfterDocument(baseDocument(), previewOf([replace("missing", "x")]))).toBeNull();
  });
});

describe("buildAppliedProposalContent", () => {
  it("pairs removed/added blocks with the same id, skips unchanged pairs, and draws shapes with the given assets", () => {
    const content = buildAppliedProposalContent({
      body: [
        { change: "removed", block: paragraph("p1", "前") as never },
        { change: "added", block: paragraph("p1", "後") as never },
        { change: "removed", block: paragraph("moved", "同じ") as never },
        { change: "added", block: paragraph("moved", "同じ") as never },
        { change: "added", block: paragraph("new", "新規") as never },
      ],
      shapes: [{ change: "added", shape: imageShape() }],
    }, { asset_1: PNG_ASSET });

    expect(content.hunks.map((hunk) => [hunk.anchorBlockId, hunk.operations, hunk.removed.length, hunk.added.length]))
      .toEqual([["p1", ["replace"], 1, 1], ["new", ["insertAfter"], 0, 1]]);
    expect(content.shapes).toEqual([{ change: "added", shape: imageShape(), assets: { asset_1: PNG_ASSET } }]);
  });

  it("round-trips into the stats input the sidebar counts", () => {
    const content = buildAppliedProposalContent({
      body: [
        { change: "removed", block: paragraph("p1", "前") as never },
        { change: "added", block: paragraph("p1", "後") as never },
      ],
      shapes: [],
    });

    expect(proposalContentToAppliedDiff(content).body.map((entry) => [entry.change, entry.block.id]))
      .toEqual([["removed", "p1"], ["added", "p1"]]);
    expect(isProposalContentEmpty(content)).toBe(false);
    expect(isProposalContentEmpty(buildAppliedProposalContent({ body: [], shapes: [] }))).toBe(true);
  });
});

describe("groupPendingProposalContentByAnchor", () => {
  it("keeps two runs proposing at the same anchor as two separate cards, and gives overlay-only proposals none", () => {
    const document = overlayDocument([imageShape()]);
    const runA = previewOf([insertAfter("p1", "ins_a", "A案")], [], { runId: "run-a", proposalIds: ["pa"] });
    const runB = previewOf([insertAfter("p1", "ins_b", "B案")], [], { runId: "run-b", proposalIds: ["pb"] });
    const overlayOnly = previewOf([], [
      { operation: "updateOverlayShape", summary: "画像を右へ", shapeId: "img_1", patch: { x: 120 } },
    ], { runId: "run-c", proposalIds: ["pc"] });

    const grouped = groupPendingProposalContentByAnchor([runA, runB, overlayOnly], document);

    expect([...grouped.keys()]).toEqual(["p1"]);
    const cards = grouped.get("p1")!;
    expect(cards.map((card) => card.preview.runId)).toEqual(["run-a", "run-b"]);
    expect(cards.map((card) => card.content.hunks.map((hunk) => hunk.added[0]?.id))).toEqual([["ins_a"], ["ins_b"]]);
    // 紙面のカードは本文だけを描く。図形はキャンバス上で決める。
    expect(cards.every((card) => card.content.shapes.length === 0)).toBe(true);
  });

  it("makes no card where the page has nothing to place it after (the decision falls back to a floating bar)", () => {
    const document = baseDocument();
    // 文書に無いブロック (ヘッダーの中など) を対象にした置き換えと、対象ブロックを持たない操作。
    const missingAnchor = previewOf([replace("not_in_document", "どこにも置けない")], [], { proposalIds: ["p-missing"] });
    const layoutOnly = previewOf([], [
      { operation: "updatePageLayout", summary: "余白を広げる", patch: { marginsMm: { top: 20 } } } as unknown as SigmaDocMutationOp,
    ], { proposalIds: ["p-layout"] });

    expect(groupPendingProposalContentByAnchor([missingAnchor, layoutOnly], document).size).toBe(0);
  });
});

/** 作成時の文書から元の内容 (`mergeBasis`) を持たせた提案 (承認と同じ合成 replay でプレビューする)。 */
function mergeablePreviewOf(
  base: SigmaDocument,
  operations: AiEditDraft[],
  mutationOperations: SigmaDocMutationOp[] = [],
): AiEditPreviewState {
  const preview = previewOf(operations, mutationOperations);
  return {
    ...preview,
    mergeSources: [{
      proposalId: "proposal_1",
      createdAt: "2026-10-05T00:00:00.000Z",
      draft: preview.draft,
      mergeBasis: computeProposalMergeBasis(preview.draft, base),
    }],
  };
}

function withParagraph(document: SigmaDocument, id: string, text: string): SigmaDocument {
  return { ...document, content: document.content.map((block) => (block.id === id ? paragraph(id, text) : block)) };
}

describe("collectPendingRemovedBlockIds (the red underlay on the page body)", () => {
  it("marks the blocks a pending proposal replaces or deletes, as the cards list them", () => {
    const document = baseDocument();
    const preview = previewOf([replace("p1", "変更後")], [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_last"] }]);

    const cards = groupPendingProposalContentByAnchor([preview], document);

    expect(collectPendingRemovedBlockIds(cards).sort()).toEqual(["p1", "p_last"]);
  });

  it("leaves out a block the AI deletes when the human's edit keeps it (an edit beats a delete)", () => {
    const base = baseDocument();
    const preview = mergeablePreviewOf(base, [replace("p1", "変更後")], [
      { operation: "deleteBlocks", summary: "削除", blockIds: ["p_last"] },
    ]);
    const current = withParagraph(base, "p_last", "人が直した最後の段落");

    const cards = groupPendingProposalContentByAnchor([preview], current);

    expect(collectPendingRemovedBlockIds(cards)).toEqual(["p1"]);
  });
});

describe("shapes a pending proposal deletes but the merge keeps", () => {
  const deleteImage: SigmaDocMutationOp = { operation: "deleteOverlayShapes", summary: "画像を削除", shapeIds: ["img_1"] };

  it("does not list a deleted shape the human moved as removed: the approval keeps the human's shape", () => {
    const base = overlayDocument([imageShape()]);
    const preview = mergeablePreviewOf(base, [], [deleteImage]);
    const current = overlayDocument([{ ...imageShape(), x: 90 }]);

    const merged = resolveProposalMergePreview(current, preview);

    expect(merged.afterDocument?.pageLayout?.overlay?.overlaySnapshot?.shapes.map((shape) => shape.id)).toEqual(["img_1"]);
    expect(merged.humanEditedUnits).toEqual(["img_1"]);
    expect(collectShapesKeptByMerge(current, merged.afterDocument, preview)).toEqual(new Set(["img_1"]));
    expect(buildPendingProposalContent(current, merged.afterDocument, preview).shapes).toEqual([]);
  });

  it("does not count the old shape of a replacement pair as kept: its replacement takes its id at approval", () => {
    const base = overlayDocument([imageShape()]);
    const preview = { ...mergeablePreviewOf(base, [], [deleteImage]), shapeReplacements: [{ removedShapeId: "img_1", addedShapeId: "img_new" }] };
    const current = overlayDocument([{ ...imageShape(), x: 90 }]);

    expect(collectShapesKeptByMerge(current, resolveProposalMergePreview(current, preview).afterDocument, preview)).toEqual(new Set());
  });

  it("gives the approval and the page the same removals, decided by the merged result", () => {
    const base = { ...overlayDocument([imageShape(), { ...imageShape(), id: "img_2" }]) };
    const preview = mergeablePreviewOf(base, [], [
      { operation: "deleteBlocks", summary: "削除", blockIds: ["p1", "p_last"] },
      { operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["img_1", "img_2"] },
    ]);
    // 人が p_last と img_1 を直した。合成はその 2 つを残す。
    const current = overlayDocument([{ ...imageShape(), x: 90 }, { ...imageShape(), id: "img_2" }]);
    const edited = { ...current, content: current.content.map((block) => (block.id === "p_last" ? paragraph("p_last", "人が直した") : block)) };

    expect(collectProposalRemovals([preview], edited)).toEqual({ blockIds: ["p1"], shapeIds: ["img_2"] });
  });

  it("still lists a deleted shape nobody touched as removed", () => {
    const base = overlayDocument([imageShape()]);
    const preview = mergeablePreviewOf(base, [], [deleteImage]);

    const merged = resolveProposalMergePreview(base, preview);

    expect(collectShapesKeptByMerge(base, merged.afterDocument, preview)).toEqual(new Set());
    expect(buildPendingProposalContent(base, merged.afterDocument, preview).shapes.map((entry) => [entry.change, entry.shape.id]))
      .toEqual([["removed", "img_1"]]);
  });
});

describe("toDisplayProposalHunk", () => {
  it("paints only the changed words of a replace and renames every id, without touching the source", () => {
    const document = baseDocument();
    const content = pending(document, previewOf([replace("p1", "変更後の問題文")]));
    const sourceBefore = structuredClone(content);
    const documentBefore = structuredClone(document);

    const display = toDisplayProposalHunk(content.hunks[0]);

    const removedNodes = (display.removed[0] as { children: InlineNode[] }).children;
    const addedNodes = (display.added[0] as { children: InlineNode[] }).children;
    expect(removedNodes.filter((node) => node.backgroundColor === `var(${AI_PROPOSAL_WORD_HIGHLIGHT.removed}, transparent)`).map(texts1))
      .toEqual(["前"]);
    expect(addedNodes.filter((node) => node.backgroundColor === `var(${AI_PROPOSAL_WORD_HIGHLIGHT.added}, transparent)`).map(texts1))
      .toEqual(["後"]);
    expect(texts(addedNodes)).toBe("変更後の問題文");
    expect(display.added[0].id).toBe(`${AI_PROPOSAL_PREVIEW_ID_PREFIX}p1`);
    expect(display.removed[0].id).toBe(`${AI_PROPOSAL_PREVIEW_ID_PREFIX}p1`);
    expect(content).toEqual(sourceBefore);
    expect(document).toEqual(documentBefore);
  });

  it("keeps a marker color under the highlight, so a marker-only change shows which color it becomes", () => {
    const document = documentOf([{ id: "p1", type: "paragraph", children: [
      { type: "text", text: "前と同じ" },
      { type: "text", text: "強調", backgroundColor: "#fff59d" },
    ] }]);
    const preview = previewOf([{
      operation: "replace",
      summary: "マーカーの色を変える",
      targetId: "p1",
      replacementBlock: { id: "p1", type: "paragraph", children: [
        { type: "text", text: "前と同じ" },
        { type: "text", text: "強調", backgroundColor: "#f8bbd0" },
      ] } as never,
    }]);
    const sourceBefore = structuredClone(preview);
    const content = pending(document, preview);

    const display = toDisplayProposalHunk(content.hunks[0]);
    const removedNodes = (display.removed[0] as { children: InlineNode[] }).children;
    const addedNodes = (display.added[0] as { children: InlineNode[] }).children;

    // 元の色は残し (CSS 変数の既定値として)、差分の印は別の変数で付ける。印の色は部品の CSS が
    // background-image として重ねる。
    expect(removedNodes.map((node) => node.backgroundColor)).toEqual([
      undefined,
      `var(${AI_PROPOSAL_WORD_HIGHLIGHT.removed}, #fff59d)`,
    ]);
    expect(addedNodes.map((node) => node.backgroundColor)).toEqual([
      undefined,
      `var(${AI_PROPOSAL_WORD_HIGHLIGHT.added}, #f8bbd0)`,
    ]);
    expect(preview).toEqual(sourceBefore);
  });

  it("does not paint a pure insertion word by word", () => {
    const content = pending(baseDocument(), previewOf([insertAfter("p1", "ins", "まるごと新しい段落")]));

    const display = toDisplayProposalHunk(content.hunks[0]);

    expect((display.added[0] as { children: InlineNode[] }).children.some((node) => node.backgroundColor)).toBe(false);
  });

  it("re-keys the numbering to the renamed ids so headings and problems keep their numbers", () => {
    const content = pending(baseDocument(), previewOf([insertAfter("prompt_1", "next_prompt", "新しい問題文")]));
    const wholeProblem = pending(baseDocument(), previewOf([{
      operation: "replace",
      summary: "問題を書き換え",
      targetId: "problem_1",
      replacementBlock: problem() as never,
    }]));

    expect(toDisplayProposalHunk(content.hunks[0]).numbering.added.problems.size).toBe(0);
    expect(toDisplayProposalHunk(wholeProblem.hunks[0]).numbering.added.problems.get(`${AI_PROPOSAL_PREVIEW_ID_PREFIX}problem_1`))
      .toBe(7);
  });
});

function texts1(node: InlineNode): string {
  return node.type === "text" ? node.text : node.tex;
}
