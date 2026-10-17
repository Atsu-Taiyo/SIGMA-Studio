import { describe, expect, it } from "vitest";

import { buildSelectiveRevertDocument } from "./selective-revert";
import { mergeProposalDraftsIntoDocument } from "./replay";
import type { SelectiveRevertBatchDraft } from "./contracts";
import {
  findBlock,
  insertTopLevelBlock,
  removeBlockFromDocument,
  updateBlockInDocument,
} from "@/lib/document-tree";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import { ensurePageLayout } from "@/lib/page-layout";
import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayShape } from "@/features/document";
import type { LayoutSectionChildBlock, ParagraphNode, SigmaBlock, SigmaDocument } from "@/features/document";

// buildSelectiveRevertDocument (Phase 2: 選択的revert) の純関数テスト。ファイルIOもproposal
// storeも介さず、before(revertDocument)/バッチdraft/現在ドキュメントの3つだけを与えて、
// 「戻せるか」「戻した結果どうなるか」を検証する。

function paragraph(id: string, text: string): ParagraphNode {
  return { type: "paragraph", id, children: [{ type: "text", text }] };
}

function topLevelDoc(blocks: SigmaBlock[], shapes: OverlayShape[] = []): SigmaDocument {
  const base = ensurePageLayout({
    version: "2.0",
    docId: "doc_selective_revert_test",
    metadata: { title: "選択的revertテスト" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: blocks,
  });
  return parseSigmaDocument({
    ...base,
    pageLayout: {
      ...base.pageLayout!,
      overlay: { overlaySnapshot: { version: 1, assets: {}, shapes } },
    },
  });
}

function getShapes(document: SigmaDocument): OverlayShape[] {
  return document.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
}

function geoShape(id: string, color: string): OverlayShape {
  return {
    id,
    type: "geo",
    x: 10,
    y: 10,
    props: {
      w: 40,
      h: 30,
      geo: "rectangle",
      fill: "none",
      color,
      labelColor: color,
      dash: "solid",
      size: "m",
    },
  };
}

function batch(proposalId: string, draft: AiEditSessionDraft): SelectiveRevertBatchDraft[] {
  return [{ proposalId, draft, source: { toolName: "test_tool", toolArgs: {} } }];
}

/** 「実際に承認したら何が保存されたか」をテスト内で再現するための小さなヘルパー。 */
function applyBatch(revertDocument: SigmaDocument, batchDrafts: SelectiveRevertBatchDraft[]): SigmaDocument {
  const merged = mergeProposalDraftsIntoDocument(revertDocument, batchDrafts);
  expect(merged.failed).toEqual([]);
  return merged.document;
}

describe("buildSelectiveRevertDocument", () => {
  it("reverts a replaced block while an unrelated later edit to another block survives", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1-orig"), paragraph("p2", "p2-orig"), paragraph("p3", "p3-orig")]);
    const draft: AiEditSessionDraft = {
      summary: "p2を書き換えました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p2を書き換えました。",
        targetId: "p2",
        replacementBlock: paragraph("p2", "p2-ai"),
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    const currentDocument = updateBlockInDocument(after, "p3", () => paragraph("p3", "p3-user-edit"));

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect((findBlock(result.document, "p2") as ParagraphNode).children[0]).toEqual({ type: "text", text: "p2-orig" });
    expect((findBlock(result.document, "p3") as ParagraphNode).children[0]).toEqual({ type: "text", text: "p3-user-edit" });
    expect((findBlock(result.document, "p1") as ParagraphNode).children[0]).toEqual({ type: "text", text: "p1-orig" });
  });

  it("removes an AI-inserted block on revert", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")]);
    const draft: AiEditSessionDraft = {
      summary: "本文を追加しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertAfter",
        summary: "本文を追加しました。",
        targetId: "p1",
        insertedBlock: paragraph("p_new", "ai-added"),
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(findBlock(result.document, "p_new")).toBeNull();
    expect(result.document.content.map((block) => block.id)).toEqual(["p1"]);
  });

  it("skips (does not error) when the user already deleted the AI-inserted block themselves", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")]);
    const draft: AiEditSessionDraft = {
      summary: "本文を追加しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertAfter",
        summary: "本文を追加しました。",
        targetId: "p1",
        insertedBlock: paragraph("p_new", "ai-added"),
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    const currentDocument = removeBlockFromDocument(after, "p_new");

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.content.map((block) => block.id)).toEqual(["p1"]);
  });

  it("re-inserts an AI-deleted top-level block immediately after its original preceding sibling", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1"), paragraph("p2", "p2"), paragraph("p3", "p3")]);
    const draft: AiEditSessionDraft = {
      summary: "p2を削除しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "p2を削除しました。", blockIds: ["p2"] }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);
    expect(currentDocument.content.map((block) => block.id)).toEqual(["p1", "p3"]);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.content.map((block) => block.id)).toEqual(["p1", "p2", "p3"]);
  });

  it("falls back to inserting at index 0 when the preceding sibling is also gone", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1"), paragraph("p2", "p2"), paragraph("p3", "p3")]);
    const draft: AiEditSessionDraft = {
      summary: "p2を削除しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "p2を削除しました。", blockIds: ["p2"] }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    // p1 (would-be anchor for reinserting p2) was separately removed by the user, unrelated to this batch.
    const currentDocument = removeBlockFromDocument(after, "p1");
    expect(currentDocument.content.map((block) => block.id)).toEqual(["p3"]);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.document.content.map((block) => block.id)).toEqual(["p2", "p3"]);
  });

  it("restores an updated overlay shape to its pre-apply state", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")], [geoShape("s1", "#0000ff")]);
    const draft: AiEditSessionDraft = {
      summary: "図形の色を変更しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{
        operation: "updateOverlayShape",
        summary: "図形の色を変更しました。",
        shapeId: "s1",
        patch: { props: { color: "#ff0000" } },
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);
    expect((getShapes(currentDocument)[0].props as { color: string }).color).toBe("#ff0000");

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((getShapes(result.document)[0].props as { color: string }).color).toBe("#0000ff");
  });

  it("removes an AI-added overlay shape on revert", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")], []);
    const draft: AiEditSessionDraft = {
      summary: "図形を追加しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertOverlayShape",
        summary: "図形を追加しました。",
        targetId: "p1",
        overlayShape: geoShape("s_new", "#00ff00"),
        assets: {},
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);
    expect(getShapes(currentDocument)).toHaveLength(1);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getShapes(result.document)).toHaveLength(0);
  });

  it("reverts an SVG image converted to shapes: the image and its picture come back, the parts go", () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 50"><rect x="10" y="10" width="30" height="20" fill="none" stroke="#111111" stroke-width="2"/><line x1="50" y1="25" x2="90" y2="25" stroke="#111111" stroke-width="2"/></svg>';
    const image: OverlayShape = { id: "figure", type: "image", x: 20, y: 20, props: { assetId: "figure_asset", w: 100, h: 50 } };
    const base = topLevelDoc([paragraph("p1", "p1")], [geoShape("below", "#0000ff"), image]);
    const asset = { id: "figure_asset", type: "image" as const, props: { w: 100, h: 50, name: "図", mimeType: "image/svg+xml", isAnimated: false, fileSize: svg.length, src: `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}` } };
    const revertDocument = parseSigmaDocument({ ...base, pageLayout: { ...base.pageLayout!, overlay: { overlaySnapshot: { version: 1, shapes: getShapes(base), assets: { figure_asset: asset } } } } });
    const group = { id: "figure", type: "group", x: 20, y: 20, props: { w: 100, h: 50 } } as OverlayShape;
    const parts = [{ ...geoShape("part_rect", "#111111"), parentId: "figure" }, { ...geoShape("part_line", "#111111"), x: 60, parentId: "figure" }] as OverlayShape[];
    const draft: AiEditSessionDraft = {
      summary: "SVG画像を2個の図形に変換", plan: [], warnings: [], operations: [],
      mutationOperations: [{ operation: "replaceOverlayShape", summary: "SVG画像を2個の図形に変換", shapeId: "figure", shapes: [group, ...parts] }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);
    expect(getShapes(currentDocument).map((shape) => shape.id)).toEqual(["below", "figure", "part_rect", "part_line"]);
    expect(currentDocument.pageLayout?.overlay?.overlaySnapshot?.assets.figure_asset).toBeUndefined();

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getShapes(result.document)).toEqual(getShapes(revertDocument));
    expect(result.document.pageLayout?.overlay?.overlaySnapshot?.assets.figure_asset).toEqual(asset);
  });

  it("composes across two saved batches when they are rolled back newest-first", () => {
    // 同じturnが2回の保存に分かれて適用されたケース。UI (EditorShell の revertAppliedProposals)
    // は appliedRevision の降順にバッチを巻き戻す — その順序でしか元の教材へ戻らないことを固定する。
    const originalDocument = topLevelDoc([paragraph("p1", "v0")]);
    const olderDrafts = batch("pr_old", {
      summary: "p1をv1にしました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p1をv1にしました。",
        targetId: "p1",
        replacementBlock: paragraph("p1", "v1"),
      }],
    });
    const afterOlder = applyBatch(originalDocument, olderDrafts);
    const newerDrafts = batch("pr_new", {
      summary: "p1をv2にしました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p1をv2にしました。",
        targetId: "p1",
        replacementBlock: paragraph("p1", "v2"),
      }],
    });
    const afterNewer = applyBatch(afterOlder, newerDrafts);

    const undoNewer = buildSelectiveRevertDocument({
      revertDocument: afterOlder,
      batchDrafts: newerDrafts,
      currentDocument: afterNewer,
    });
    expect(undoNewer.ok).toBe(true);
    if (!undoNewer.ok) return;
    expect((findBlock(undoNewer.document, "p1") as ParagraphNode).children[0]).toEqual({ type: "text", text: "v1" });

    const undoOlder = buildSelectiveRevertDocument({
      revertDocument: originalDocument,
      batchDrafts: olderDrafts,
      currentDocument: undoNewer.document,
    });
    expect(undoOlder.ok).toBe(true);
    if (!undoOlder.ok) return;
    expect((findBlock(undoOlder.document, "p1") as ParagraphNode).children[0]).toEqual({ type: "text", text: "v0" });
  });

  it("refuses the older batch first when a newer batch still sits on top of the same block", () => {
    const originalDocument = topLevelDoc([paragraph("p1", "v0")]);
    const olderDrafts = batch("pr_old", {
      summary: "p1をv1にしました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p1をv1にしました。",
        targetId: "p1",
        replacementBlock: paragraph("p1", "v1"),
      }],
    });
    const afterOlder = applyBatch(originalDocument, olderDrafts);
    const newerDrafts = batch("pr_new", {
      summary: "p1をv2にしました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p1をv2にしました。",
        targetId: "p1",
        replacementBlock: paragraph("p1", "v2"),
      }],
    });
    const afterNewer = applyBatch(afterOlder, newerDrafts);

    expect(buildSelectiveRevertDocument({
      revertDocument: originalDocument,
      batchDrafts: olderDrafts,
      currentDocument: afterNewer,
    })).toEqual({
      ok: false,
      reason: "適用後にAIが変更した箇所へ編集が加えられているため取り消せません。",
    });
  });

  it("refuses when a touched block was edited again after apply", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1"), paragraph("p2", "p2-orig")]);
    const draft: AiEditSessionDraft = {
      summary: "p2を書き換えました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "replace",
        summary: "p2を書き換えました。",
        targetId: "p2",
        replacementBlock: paragraph("p2", "p2-ai"),
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    const currentDocument = updateBlockInDocument(after, "p2", () => paragraph("p2", "p2-user-overwrote-ai"));

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "適用後にAIが変更した箇所へ編集が加えられているため取り消せません。",
    });
  });

  it("refuses when an AI-inserted block was itself edited afterward", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")]);
    const draft: AiEditSessionDraft = {
      summary: "本文を追加しました。",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertAfter",
        summary: "本文を追加しました。",
        targetId: "p1",
        insertedBlock: paragraph("p_new", "ai-added"),
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    const currentDocument = updateBlockInDocument(after, "p_new", () => paragraph("p_new", "user-edited-the-ai-block"));

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result.ok).toBe(false);
  });

  it("refuses when an AI-deleted block was somehow resurrected before revert", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1"), paragraph("p2", "p2"), paragraph("p3", "p3")]);
    const draft: AiEditSessionDraft = {
      summary: "p2を削除しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "p2を削除しました。", blockIds: ["p2"] }],
    };
    const batchDrafts = batch("pr1", draft);
    const after = applyBatch(revertDocument, batchDrafts);
    const currentDocument = insertTopLevelBlock(after, paragraph("p2", "resurrected"), "p1");

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "適用後にAIが変更した箇所へ編集が加えられているため取り消せません。",
    });
  });

  it("refuses a batch containing updatePageLayout, even though it produces no block/shape diff entries", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")]);
    const draft: AiEditSessionDraft = {
      summary: "用紙の向きを変更しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{
        operation: "updatePageLayout",
        summary: "用紙の向きを変更しました。",
        patch: { orientation: "landscape" },
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "ページ設定など、選択的な取り消しに対応していない種類の変更を含む適用のため、この時点からは取り消せません。",
    });
  });

  it("refuses a batch containing setDocumentColumns, even though it produces no block/shape diff entries", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1")]);
    const draft: AiEditSessionDraft = {
      summary: "文書全体を2段組みにしました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{
        operation: "setDocumentColumns",
        summary: "文書全体を2段組みにしました。",
        columnCount: 2,
        columnGapMm: 8,
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "ページ設定など、選択的な取り消しに対応していない種類の変更を含む適用のため、この時点からは取り消せません。",
    });
  });

  it("refuses a batch containing a structural op (moveBlocks) regardless of hashes", () => {
    const revertDocument = topLevelDoc([paragraph("p1", "p1"), paragraph("p2", "p2"), paragraph("p3", "p3")]);
    const draft: AiEditSessionDraft = {
      summary: "p3をp1の前に移動しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{
        operation: "moveBlocks",
        summary: "p3をp1の前に移動しました。",
        blockIds: ["p3"],
        targetId: "p1",
        position: "before",
      }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "ブロックの移動やレイアウト変更を含む適用のため、この時点からは取り消せません。",
    });
  });

  it("refuses a deletion of a block nested inside a layoutSection (not top-level)", () => {
    const nestedChildren: LayoutSectionChildBlock[] = [paragraph("nested_1", "nested-1"), paragraph("nested_2", "nested-2")];
    const revertDocument = topLevelDoc([
      paragraph("p1", "p1"),
      { type: "layoutSection", id: "layout_1", layout: { columnCount: 2, columnGapMm: 8 }, children: nestedChildren },
    ]);
    const draft: AiEditSessionDraft = {
      summary: "入れ子の段落を削除しました。",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "入れ子の段落を削除しました。", blockIds: ["nested_1"] }],
    };
    const batchDrafts = batch("pr1", draft);
    const currentDocument = applyBatch(revertDocument, batchDrafts);

    const result = buildSelectiveRevertDocument({ revertDocument, batchDrafts, currentDocument });
    expect(result).toEqual({
      ok: false,
      reason: "入れ子ブロックの削除を含む適用のため、この時点からは取り消せません。",
    });
  });
});
