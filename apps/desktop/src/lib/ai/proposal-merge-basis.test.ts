import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";

import { collectNonMergeableTargets, computeProposalMergeBasis, type ProposalMergeBasis } from "./proposal-merge-basis";
import { replayProposalDraftMerging } from "./proposal-replay";

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

  it("returns what a legacy record's approval compares by hash: overwritten, deleted, reconfigured and aligned targets", () => {
    const aligned = draftOf(everyKind.operations, [
      ...everyKind.mutationOperations!,
      { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_3"], mode: "left" },
      { operation: "updateLayoutSection", summary: "3段", sectionId: "sec_1", columnCount: 3 },
    ]);

    // 移動 (box_1) は中身を上書きしないので、旧レコードの承認も比べない (人の編集は移動先で残る)。挿入の目印も比べない。
    expect(sorted(collectNonMergeableTargets([{ draft: aligned }]))).toEqual({
      blockIds: ["p_1", "p_3", "sec_1"],
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

  describe("a graph and the label shapes it owns", () => {
    const graph = (labelIds: Record<string, string>) => ({
      id: "graph_1", type: "graph2dShape", x: 0, y: 0, rotation: 0,
      props: {
        boundsMode: "plot", w: 300, h: 180, axisLabelTextShapeIds: labelIds,
        spec: { kind: "cartesian", title: "", width: 364, height: 232, viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" }, axes: { grid: false, showX: true, showY: true, xLabel: "x" }, curves: [], points: [] },
      },
    });
    const label = (id: string, x: number) => ({
      id, type: "text", x, y: 200, rotation: 0,
      props: { w: 40, h: 16, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text: "x" }] }] },
    });
    const withShapes = (shapes: unknown[]): SigmaDocument => ({
      ...baseDocument(),
      pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes, assets: {} } } },
    } as unknown as SigmaDocument);
    const shapeIdsOf = (document: SigmaDocument) => (document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? []).map((shape) => shape.id);
    // update_graph がラベルを作り直す形: 古いラベルを消し、グラフの持ち主を新しいラベルへ付け替え、新しいラベルを足す。
    const relabel: AiEditSessionDraft = {
      summary: "軸名を直す", plan: [], warnings: [],
      operations: [{ operation: "insertOverlayShape", summary: "新しいラベル", targetId: "p_1", overlayShape: label("label_x2", 20) as never, assets: {} }],
      mutationOperations: [
        { operation: "deleteOverlayShapes", summary: "古いラベル", shapeIds: ["label_x"] },
        { operation: "updateOverlayShape", summary: "持ち主", shapeId: "graph_1", patch: { props: { axisLabelTextShapeIds: { x: "label_x2" } } } as never },
      ],
      operationOrder: [{ kind: "mutation", index: 0 }, { kind: "operation", index: 0 }, { kind: "mutation", index: 1 }],
    };

    it("would leave an edited old label orphaned next to its replacement, so the graph and its labels are not mergeable", () => {
      const base = withShapes([graph({ x: "label_x" }), label("label_x", 10)]);
      const mergeBasis = computeProposalMergeBasis(relabel, base);

      // R4: 人が古いラベルを動かした文書へ合成 replay すると、編集は削除に勝って古いラベルが残り、
      // 持ち主のいないラベルが新しいラベルと二重に並ぶ。だからこの組は合成させずロックする。
      const replayed = replayProposalDraftMerging(withShapes([graph({ x: "label_x" }), label("label_x", 99)]), relabel, mergeBasis);
      expect(shapeIdsOf(replayed.nextDocument)).toEqual(["graph_1", "label_x", "label_x2"]);
      expect(replayed.report.editBeatsDelete).toEqual(["#label_x"]);

      expect(sorted(collectNonMergeableTargets([{ draft: relabel, mergeBasis }]))).toEqual({ blockIds: [], shapeIds: ["graph_1", "label_x"] });
    });

    it("keeps a graph the AI deletes together with its labels out of the merge", () => {
      const draft = draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["graph_1"] }]);
      const mergeBasis = computeProposalMergeBasis(draft, withShapes([graph({ x: "label_x" }), label("label_x", 10)]));

      expect(sorted(collectNonMergeableTargets([{ draft, mergeBasis }]))).toEqual({ blockIds: [], shapeIds: ["graph_1", "label_x"] });
    });
  });

  it("adds the old shape of a replacement pair, which the merge cannot keep apart from its replacement", () => {
    const draft = draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s_2"] }]);
    const mergeBasis = computeProposalMergeBasis(draft, baseDocument());

    expect(collectNonMergeableTargets([{ draft, mergeBasis }], [{ removedShapeId: "s_2" }])).toEqual({ blockIds: [], shapeIds: ["s_2"] });
  });
});
