import { describe, expect, it } from "vitest";

import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";
import {
  deriveAppliedDocumentDiff,
  derivePendingDocumentDiff,
  mergeAppliedDocumentDiffs,
} from "./applied-document-diff";

function documentWith(text: string, shapes: OverlayShape[] = []): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_1",
    metadata: { title: "教材" },
    outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    content: [{ id: "p1", type: "paragraph", children: [{ type: "text", text }] }],
    pageLayout: {
      overlay: {
        overlaySnapshot: { version: 1, shapes, assets: {} },
      },
    },
  } as SigmaDocument;
}

describe("deriveAppliedDocumentDiff", () => {
  it("returns the real before/after body nodes and inserted graph", () => {
    const graph = {
      id: "graph_1",
      type: "graph2dShape",
      x: 10,
      y: 20,
      rotation: 0,
      props: { w: 240, h: 160, graph: { xAxis: {}, yAxis: {}, functions: [] } },
    } as never;
    const before = documentWith("変更前");
    const after = documentWith("変更後", [graph]);
    const draft = {
      summary: "説明文には使わない",
      plan: [],
      warnings: [],
      operations: [
        {
          summary: "本文を置換",
          targetId: "p1",
          replacementBlock: after.content[0],
        },
        {
          operation: "insertOverlayShape",
          summary: "グラフを追加",
          targetId: "p1",
          overlayShape: graph,
          assets: {},
        },
      ],
    } as AiEditSessionDraft;

    const diff = deriveAppliedDocumentDiff(before, after, [draft]);

    expect(diff.body.map((entry) => [entry.change, entry.block])).toEqual([
      ["removed", before.content[0]],
      ["added", after.content[0]],
    ]);
    expect(diff.shapes).toEqual([{ change: "added", shape: graph }]);
  });

  it("does not expose an implementation-only overlay anchor paragraph as a body diff", () => {
    const before = documentWith("");
    const after = documentWith("");
    const draft = {
      summary: "図形を追加",
      plan: [],
      warnings: [],
      operations: [
        {
          operation: "replace",
          summary: "図形の挿入先として問題のpromptに空行を追加しました。",
          targetId: "p1",
          replacementBlock: after.content[0],
        },
        {
          operation: "insertOverlayShape",
          summary: "図形を追加",
          targetId: "p1",
          overlayShape: { id: "shape_1", type: "geo" },
          assets: {},
        },
      ],
    } as unknown as AiEditSessionDraft;

    expect(deriveAppliedDocumentDiff(before, after, [draft]).body).toEqual([]);
  });

  it("deduplicates shared endpoint snapshots across proposals", () => {
    const before = documentWith("前");
    const after = documentWith("後");
    const diff = {
      body: [
        { change: "removed" as const, block: before.content[0] },
        { change: "added" as const, block: after.content[0] },
      ],
      shapes: [],
    };

    expect(mergeAppliedDocumentDiffs([diff, diff])).toEqual(diff);
  });
});

describe("derivePendingDocumentDiff", () => {
  it("takes the removed side from the current document and the added side from the draft", () => {
    const current = documentWith("現在の本文");
    const replacement = { id: "p1", type: "paragraph", children: [{ type: "text", text: "提案後の本文" }] };
    const draft = {
      summary: "本文を提案",
      plan: [],
      warnings: [],
      operations: [{ operation: "replace", summary: "置換", targetId: "p1", replacementBlock: replacement }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff([draft], current);

    expect(diff.body).toEqual([
      { change: "removed", block: current.content[0] },
      { change: "added", block: replacement },
    ]);
  });

  it("resolves deleteBlocks ids against the current document", () => {
    const current = documentWith("削除される本文");
    const draft = {
      summary: "削除",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "deleteBlocks", summary: "削除", blockIds: ["p1"] }],
    } as unknown as AiEditSessionDraft;

    expect(derivePendingDocumentDiff([draft], current).body).toEqual([
      { change: "removed", block: current.content[0] },
    ]);
  });

  it("falls back to the same current shape on both sides when no post-state is given (can't tell what changed, but shows it was touched)", () => {
    const shape = { id: "shape_1", type: "geo", x: 0, y: 0, rotation: 0, props: { w: 10, h: 10 } } as never;
    const current = documentWith("本文");
    const draft = {
      summary: "図形を更新",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "更新", shapeId: "shape_1", patch: { x: 20 } }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff([draft], current, [shape]);
    expect(diff.shapes).toEqual([
      { change: "removed", shape },
      { change: "added", shape },
    ]);
  });

  it("shows update/align shape ops' post-state (post patch/alignment) on the added side when provided", () => {
    const before = { id: "shape_1", type: "geo", x: 0, y: 0, rotation: 0, props: { w: 10, h: 10 } } as never;
    const after = { id: "shape_1", type: "geo", x: 20, y: 0, rotation: 0, props: { w: 10, h: 10 } } as never;
    const current = documentWith("本文");
    const draft = {
      summary: "図形を更新",
      plan: [],
      warnings: [],
      operations: [],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "更新", shapeId: "shape_1", patch: { x: 20 } }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff([draft], current, [before], new Map([["shape_1", after]]));
    expect(diff.shapes).toEqual([
      { change: "removed", shape: before },
      { change: "added", shape: after },
    ]);
  });

  it("shows the shape being replaced as removed when an insert is actually part of a replacement pair", () => {
    const oldShape = { id: "shape_old", type: "geo", x: 0, y: 0, rotation: 0, props: { w: 10, h: 10 } } as never;
    const newShape = { id: "shape_new", type: "geo", x: 0, y: 0, rotation: 0, props: { w: 20, h: 20 } } as never;
    const current = documentWith("本文");
    const draft = {
      summary: "図形を置き換え",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertOverlayShape",
        summary: "置き換え後の図形を挿入",
        targetId: "p1",
        overlayShape: newShape,
        assets: {},
      }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff(
      [draft],
      current,
      [oldShape],
      undefined,
      [{ removedShapeId: "shape_old", addedShapeId: "shape_new" }],
    );
    expect(diff.shapes).toEqual([
      { change: "removed", shape: oldShape },
      { change: "added", shape: newShape },
    ]);
  });

  it("uses the real post-apply overlay shape for a replacement preview when available", () => {
    const oldShape = {
      id: "shape_old",
      type: "geo",
      x: 48,
      y: 72,
      rotation: Math.PI / 6,
      opacity: 0.4,
      props: { w: 80, h: 40 },
    } as OverlayShape;
    const temporaryShape = {
      id: "shape_temporary",
      type: "geo",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 120, h: 60 },
    } as OverlayShape;
    const postApplyShape = {
      ...temporaryShape,
      id: "shape_old",
      x: 48,
      y: 72,
      rotation: Math.PI / 6,
      opacity: 0.4,
    } as unknown as OverlayShape;
    const current = documentWith("本文");
    const draft = {
      summary: "図形を置き換え",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertOverlayShape",
        summary: "置き換え後の図形を挿入",
        targetId: "p1",
        overlayShape: temporaryShape,
        assets: {},
      }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff(
      [draft],
      current,
      [oldShape],
      new Map([["shape_old", postApplyShape]]),
      [{ removedShapeId: "shape_old", addedShapeId: "shape_temporary" }],
    );

    expect(diff.shapes).toEqual([
      { change: "removed", shape: oldShape },
      { change: "added", shape: postApplyShape },
    ]);
  });

  it("uses the real post-apply table shape for a replacement preview when available", () => {
    const oldShape = {
      id: "table_old",
      type: "tableShape",
      x: 24,
      y: 36,
      rotation: Math.PI / 15,
      opacity: 0.65,
      props: { w: 180, h: 90, table: { rows: [] } },
    } as unknown as OverlayShape;
    const temporaryShape = {
      id: "table_temporary",
      type: "tableShape",
      x: 0,
      y: 0,
      rotation: 0,
      props: { w: 220, h: 120, table: { rows: [] } },
    } as unknown as OverlayShape;
    const postApplyShape = {
      ...temporaryShape,
      id: "table_old",
      x: 24,
      y: 36,
      rotation: Math.PI / 15,
      opacity: 0.65,
    } as OverlayShape;
    const current = documentWith("本文");
    const draft = {
      summary: "表を置き換え",
      plan: [],
      warnings: [],
      operations: [{
        operation: "insertTableShape",
        summary: "置き換え後の表を挿入",
        targetId: "p1",
        tableShape: temporaryShape,
      }],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff(
      [draft],
      current,
      [oldShape],
      new Map([["table_old", postApplyShape]]),
      [{ removedShapeId: "table_old", addedShapeId: "table_temporary" }],
    );

    expect(diff.shapes).toEqual([
      { change: "removed", shape: oldShape },
      { change: "added", shape: postApplyShape },
    ]);
  });

  it("does not surface an overlay-anchor support paragraph as a pending body diff", () => {
    const current = documentWith("");
    const draft = {
      summary: "図形を追加",
      plan: [],
      warnings: [],
      operations: [
        {
          operation: "replace",
          summary: "図形の挿入先として問題のpromptに空行を追加しました。",
          targetId: "p1",
          replacementBlock: current.content[0],
        },
        {
          operation: "insertOverlayShape",
          summary: "図形を追加",
          targetId: "p1",
          overlayShape: { id: "shape_1", type: "geo" },
          assets: {},
        },
      ],
    } as unknown as AiEditSessionDraft;

    const diff = derivePendingDocumentDiff([draft], current);
    expect(diff.body).toEqual([]);
    expect(diff.shapes).toEqual([{ change: "added", shape: { id: "shape_1", type: "geo" } }]);
  });
});
