import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import { collectNonMergeableTargets, computeProposalMergeBasis, type ProposalMergeBasis } from "./proposal-merge-basis";

const paragraph = (id: string, text = `段落 ${id}`) => ({ id, type: "paragraph" as const, children: [{ type: "text" as const, text }] });
const rectangle = (id: string) => ({
  id, type: "geo", x: 0, y: 0,
  props: { w: 40, h: 20, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
});

function baseDocument(): SigmaDocument {
  return {
    ...parseSigmaDocument({
      version: "2.0",
      docId: "doc_non_mergeable",
      metadata: { title: "合成できない対象" },
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
      content: [
        paragraph("p_1"),
        paragraph("p_2"),
        paragraph("p_3"),
        { id: "box_1", type: "boxBlock", styleId: "itembox", title: [{ type: "text", text: "要点" }], blocks: [paragraph("box_p")] },
        { id: "sec_1", type: "layoutSection", layout: { columnCount: 2, columnGapMm: 8 }, children: [paragraph("sec_p")] },
      ],
    }),
    pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: ["s_1", "s_2", "s_3"].map(rectangle), assets: {} } } },
  } as unknown as SigmaDocument;
}

function draftOf(operations: AiEditSessionDraft["operations"], mutationOperations: SigmaDocMutationOp[] = []): AiEditSessionDraft {
  return { summary: "提案", plan: [], warnings: [], operations, ...(mutationOperations.length > 0 ? { mutationOperations } : {}) };
}

const replace = (targetId: string): AiEditSessionDraft["operations"][number] => ({
  operation: "replace", summary: "置換", targetId, replacementBlock: paragraph(targetId, "AI の本文"),
});
const insertAfter = (targetId: string, id: string): AiEditSessionDraft["operations"][number] => ({
  operation: "insertAfter", summary: "挿入", targetId, insertedBlock: paragraph(id, "AI が足した段落"),
});
const sorted = (targets: { blockIds: string[]; shapeIds: string[] }) => ({
  blockIds: [...targets.blockIds].sort(),
  shapeIds: [...targets.shapeIds].sort(),
});

describe("collectNonMergeableTargets", () => {
  const everyKind = draftOf([replace("p_1"), insertAfter("p_2", "p_new")], [
    { operation: "deleteBlocks", summary: "削除", blockIds: ["p_3"] },
    { operation: "moveBlocks", summary: "移動", blockIds: ["box_1"], targetId: "p_1", position: "after" },
    { operation: "updateOverlayShape", summary: "更新", shapeId: "s_1", patch: { x: 10 } },
    { operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s_2"] },
  ]);

  it("returns every existing target a legacy record overwrites, deletes, moves or aligns (not its insert anchors)", () => {
    const aligned = draftOf(everyKind.operations, [
      ...everyKind.mutationOperations!,
      { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_3"], mode: "left" },
    ]);

    expect(sorted(collectNonMergeableTargets([{ draft: aligned }]))).toEqual({
      blockIds: ["box_1", "p_1", "p_3"],
      shapeIds: ["s_1", "s_2", "s_3"],
    });
  });

  it("returns nothing a merge basis covers: replaced, deleted, moved and updated targets with a snapshot", () => {
    const mergeBasis = computeProposalMergeBasis(everyKind, baseDocument());

    expect(collectNonMergeableTargets([{ draft: everyKind, mergeBasis }])).toEqual({ blockIds: [], shapeIds: [] });
  });

  it("returns targets the basis has no snapshot of: the replay would overwrite the human's edit", () => {
    const empty: ProposalMergeBasis = { version: 1, entities: {} };

    expect(sorted(collectNonMergeableTargets([{ draft: everyKind, mergeBasis: empty }]))).toEqual({
      blockIds: ["p_1", "p_3"],
      shapeIds: ["s_1", "s_2"],
    });
  });

  it("treats a replaced block inside a basis block as merged with it", () => {
    const draft = draftOf([replace("box_1"), replace("box_p")]);
    const mergeBasis = computeProposalMergeBasis(draft, baseDocument());

    expect(Object.keys(mergeBasis.entities)).toEqual(["box_1"]);
    expect(collectNonMergeableTargets([{ draft, mergeBasis }])).toEqual({ blockIds: [], shapeIds: [] });
  });

  it("returns aligned shapes and a reconfigured column section unless they are merged units", () => {
    const draft = draftOf([], [
      { operation: "updateOverlayShape", summary: "更新", shapeId: "s_1", patch: { x: 10 } },
      { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_3"], mode: "left" },
      { operation: "updateLayoutSection", summary: "3段", sectionId: "sec_1", columnCount: 3 },
    ]);
    const mergeBasis = computeProposalMergeBasis(draft, baseDocument());

    expect(collectNonMergeableTargets([{ draft, mergeBasis }])).toEqual({ blockIds: ["sec_1"], shapeIds: ["s_3"] });
  });

  it("reads an unusable basis as no basis", () => {
    const broken: ProposalMergeBasis = { version: 1, entities: { p_1: { kind: "block", value: { id: "p_1", type: "paragraph" } as never } } };

    expect(collectNonMergeableTargets([{ draft: draftOf([replace("p_1")]), mergeBasis: broken }])).toEqual({ blockIds: ["p_1"], shapeIds: [] });
  });

  it("adds the old shape of a replacement pair, which the merge cannot keep apart from its replacement", () => {
    const draft = draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s_2"] }]);
    const mergeBasis = computeProposalMergeBasis(draft, baseDocument());

    expect(collectNonMergeableTargets([{ draft, mergeBasis }], [{ removedShapeId: "s_2" }])).toEqual({ blockIds: [], shapeIds: ["s_2"] });
  });
});
