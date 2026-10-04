import { describe, expect, it } from "vitest";

import type { AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";
import {
  deriveAppliedDocumentDiff,
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
