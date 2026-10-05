import { describe, expect, it } from "vitest";

import type { SigmaDocument } from "@/features/document";
import type { AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { findBlock, updateBlockInDocument } from "@/lib/document-tree";
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

  it("always returns aligned shapes and a reconfigured column section, even when they are merged units too", () => {
    const draft = draftOf([], [
      { operation: "updateOverlayShape", summary: "更新", shapeId: "s_1", patch: { x: 10 } },
      { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_3"], mode: "left" },
      { operation: "updateLayoutSection", summary: "3段", sectionId: "sec_1", columnCount: 3 },
    ]);
    const mergeBasis = computeProposalMergeBasis(draft, baseDocument());

    // 整列・段組み設定は合成後の単位に素のまま当たるので、人が直した値を黙って上書きする (下の契約テスト)。
    expect(collectNonMergeableTargets([{ draft, mergeBasis }])).toEqual({ blockIds: ["sec_1"], shapeIds: ["s_1", "s_3"] });
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

/**
 * 契約: 保留中の提案の対象を人が直したとき、承認の合成 replay がその編集を残すか、そうでなければ
 * `collectNonMergeableTargets` がその対象を返して紙面がロックする (承認も比べる)。どちらでもない組
 * (人の編集が黙って消える) を作らない。replay の規則が変わってロックが外れたら、ここが落ちる (R4)。
 */
describe("contract: a human edit of a pending target survives the merge or the target stays locked", () => {
  const geo = (id: string, x: number, extra: Record<string, unknown> = {}) => ({
    id, type: "geo", x, y: 0,
    props: { w: 40, h: 20, geo: "rectangle", fill: "none", color: "#111111", labelColor: "#111111", dash: "solid", size: "m" },
    ...extra,
  });
  const graphShape = {
    id: "graph_1", type: "graph2dShape", x: 0, y: 300, rotation: 0,
    props: {
      boundsMode: "plot", w: 300, h: 180, axisLabelTextShapeIds: { x: "label_x" },
      spec: { kind: "cartesian", title: "", width: 364, height: 232, viewBox: { xMin: "-5", xMax: "5", yMin: "-3", yMax: "3" }, axes: { grid: false, showX: true, showY: true, xLabel: "x" }, curves: [], points: [] },
    },
  };
  const labelShape = (id: string) => ({
    id, type: "text", x: 320, y: 400, rotation: 0,
    props: { w: 40, h: 16, color: "#111111", size: "m", blocks: [{ type: "paragraph", id: `${id}_p`, children: [{ type: "text", text: "x" }] }] },
  });
  const shapes = [
    geo("s_1", 0), geo("s_2", 100),
    { id: "g", type: "group", x: 10, y: 0, props: { w: 90, h: 20 } }, geo("m_1", 10, { parentId: "g" }), geo("m_2", 60, { parentId: "g" }),
    geo("h", 200), geo("d", 200, { anchor: { type: "shape", shapeId: "h", dx: 0, dy: 30 } }),
    graphShape, labelShape("label_x"),
  ];
  const base = (): SigmaDocument => ({
    ...baseDocument(),
    pageLayout: { overlay: { overlaySnapshot: { version: 1, shapes: structuredClone(shapes), assets: {} } } },
  } as unknown as SigmaDocument);
  const shapesOf = (document: SigmaDocument) => document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
  const shapeIn = (document: SigmaDocument, id: string) => shapesOf(document).find((shape) => shape.id === id) as Record<string, unknown> | undefined;
  const editShape = (id: string, patch: Record<string, unknown>) => (document: SigmaDocument): SigmaDocument => ({
    ...document,
    pageLayout: {
      ...document.pageLayout,
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes: shapesOf(document).map((shape) => (shape.id === id ? { ...shape, ...patch } : shape)) } },
    },
  } as unknown as SigmaDocument);
  const editBlockText = (id: string, text: string) => (document: SigmaDocument): SigmaDocument => (
    updateBlockInDocument(document, id, (block) => ({ ...block, children: [{ type: "text", text }] } as never))
  );
  const blockText = (document: SigmaDocument, id: string) => JSON.stringify(findBlock(document, id) ?? null);
  const relabel: AiEditSessionDraft = {
    summary: "軸名", plan: [], warnings: [],
    operations: [{ operation: "insertOverlayShape", summary: "新ラベル", targetId: "p_1", overlayShape: labelShape("label_x2") as never, assets: {} }],
    mutationOperations: [
      { operation: "deleteOverlayShapes", summary: "旧ラベル", shapeIds: ["label_x"] },
      { operation: "updateOverlayShape", summary: "持ち主", shapeId: "graph_1", patch: { props: { axisLabelTextShapeIds: { x: "label_x2" } } } as never },
    ],
    operationOrder: [{ kind: "mutation", index: 0 }, { kind: "operation", index: 0 }, { kind: "mutation", index: 1 }],
  };

  const cases: Array<{
    name: string;
    draft: AiEditSessionDraft;
    target: { kind: "block" | "shape"; id: string };
    edit: (document: SigmaDocument) => SigmaDocument;
    kept: (result: SigmaDocument) => boolean;
  }> = [
    {
      name: "a replaced block",
      draft: draftOf([replace("p_1")]),
      target: { kind: "block", id: "p_1" }, edit: editBlockText("p_1", "人の追記つき 段落 p_1"),
      kept: (result) => blockText(result, "p_1").includes("人の追記"),
    },
    {
      name: "a replaced block inside a replaced box",
      draft: draftOf([replace("box_1"), replace("box_p")]),
      target: { kind: "block", id: "box_p" }, edit: editBlockText("box_p", "人の追記つき 段落 box_p"),
      kept: (result) => blockText(result, "box_p").includes("人の追記"),
    },
    {
      name: "a deleted block",
      draft: draftOf([], [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p_2"] }]),
      target: { kind: "block", id: "p_2" }, edit: editBlockText("p_2", "人が直した p_2"),
      kept: (result) => blockText(result, "p_2").includes("人が直した"),
    },
    {
      name: "a moved block",
      draft: draftOf([], [{ operation: "moveBlocks", summary: "移動", blockIds: ["p_3"], targetId: "p_1", position: "after" }]),
      target: { kind: "block", id: "p_3" }, edit: editBlockText("p_3", "人が直した p_3"),
      kept: (result) => blockText(result, "p_3").includes("人が直した"),
    },
    {
      name: "a reconfigured column section the draft also replaces",
      draft: draftOf([replace("sec_p")], [{ operation: "updateLayoutSection", summary: "間隔", sectionId: "sec_1", columnGapMm: 12 }]),
      target: { kind: "block", id: "sec_1" },
      edit: (document) => updateBlockInDocument(document, "sec_1", (block) => ({ ...block, layout: { columnCount: 2, columnGapMm: 4 } } as never)),
      kept: (result) => (findBlock(result, "sec_1") as { layout?: { columnGapMm?: number } } | null)?.layout?.columnGapMm === 4,
    },
    {
      name: "a column section the draft both replaces and reconfigures (the setting is applied over the merge)",
      draft: draftOf([{
        operation: "replace", summary: "段組みを書き換え", targetId: "sec_1",
        replacementBlock: { id: "sec_1", type: "layoutSection", layout: { columnCount: 2, columnGapMm: 8 }, children: [paragraph("sec_p", "AI の段の本文")] } as never,
      }], [{ operation: "updateLayoutSection", summary: "間隔", sectionId: "sec_1", columnGapMm: 12 }]),
      target: { kind: "block", id: "sec_1" },
      edit: (document) => updateBlockInDocument(document, "sec_1", (block) => ({ ...block, layout: { columnCount: 2, columnGapMm: 4 } } as never)),
      kept: (result) => (findBlock(result, "sec_1") as { layout?: { columnGapMm?: number } } | null)?.layout?.columnGapMm === 4,
    },
    {
      name: "an updated shape",
      draft: draftOf([], [{ operation: "updateOverlayShape", summary: "色", shapeId: "s_1", patch: { props: { color: "#ff0000" } } as never }]),
      target: { kind: "shape", id: "s_1" }, edit: editShape("s_1", { x: 77 }),
      kept: (result) => shapeIn(result, "s_1")?.x === 77,
    },
    {
      name: "a deleted shape",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s_2"] }]),
      target: { kind: "shape", id: "s_2" }, edit: editShape("s_2", { x: 177 }),
      kept: (result) => shapeIn(result, "s_2")?.x === 177,
    },
    {
      name: "an aligned shape",
      draft: draftOf([], [{ operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_2"], mode: "left" }]),
      target: { kind: "shape", id: "s_2" }, edit: editShape("s_2", { x: 150 }),
      kept: (result) => shapeIn(result, "s_2")?.x === 150,
    },
    {
      name: "an aligned shape the draft also updates (review: the alignment overwrites the human's axis)",
      draft: draftOf([], [
        { operation: "updateOverlayShape", summary: "色", shapeId: "s_2", patch: { props: { color: "#ff0000" } } as never },
        { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["s_1", "s_2"], mode: "left" },
      ]),
      target: { kind: "shape", id: "s_2" }, edit: editShape("s_2", { x: 150 }),
      kept: (result) => shapeIn(result, "s_2")?.x === 150,
    },
    {
      name: "a member of a group the AI deletes (review: the deletion cascades to the members)",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g"] }]),
      target: { kind: "shape", id: "m_1" },
      edit: editShape("m_1", { props: { ...(shapes[3] as { props: object }).props, color: "#00aa00" } }),
      kept: (result) => (shapeIn(result, "m_1")?.props as { color?: string } | undefined)?.color === "#00aa00",
    },
    {
      name: "a shape anchored to a shape the AI deletes (the deletion cascades through the anchor)",
      draft: draftOf([], [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["h"] }]),
      target: { kind: "shape", id: "d" },
      edit: editShape("d", { props: { ...(shapes[6] as { props: object }).props, color: "#00aa00" } }),
      kept: (result) => (shapeIn(result, "d")?.props as { color?: string } | undefined)?.color === "#00aa00",
    },
    {
      name: "an owned label of a graph the AI relabels",
      draft: relabel,
      target: { kind: "shape", id: "label_x" }, edit: editShape("label_x", { x: 399 }),
      kept: (result) => shapeIn(result, "label_x")?.x === 399
        && Object.values((shapeIn(result, "graph_1")?.props as { axisLabelTextShapeIds?: Record<string, string> }).axisLabelTextShapeIds ?? {}).includes("label_x"),
    },
  ];

  it.each(cases)("$name", ({ draft, target, edit, kept }) => {
    const document = base();
    const mergeBasis = computeProposalMergeBasis(draft, document);
    const targets = collectNonMergeableTargets([{ draft, mergeBasis }], [], shapesOf(document));
    const locked = (target.kind === "block" ? targets.blockIds : targets.shapeIds).includes(target.id);
    let survived: boolean;
    try {
      survived = kept(replayProposalDraftMerging(edit(document), draft, mergeBasis).nextDocument);
    } catch {
      survived = true; // 適用できない = 競合として知らせる (黙って消えない)
    }

    expect({ locked, survived }).not.toEqual({ locked: false, survived: false });
  });
});
