import { describe, expect, it } from "vitest";
import { sampleDocument } from "@/lib/sample-document";
import { ensurePageLayout } from "@/lib/page-layout";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import { type AiEditSessionDraft } from "@/lib/ai/sigma-doc-edit-schema";
import type { ParagraphNode, ProblemNode, SigmaDocument } from "@/features/document";
import {
  canForceApplyProposalConflict,
  collectConflictSensitiveBlockIds,
  collectTouchedBlockIds,
  findConflictingBlockIds,
  findProposalFreshnessConflict,
  findProposalFreshnessConflictIds,
  findRequestSelectionConflictIds,
  shouldAutoApplyProposal,
} from "./freshness";
import { replayProposalDraft } from "./replay";
import {
  SOLE_BLOCK_ID,
  deleteBlockDraft,
  paragraphDocument,
  P_YOTTE_ID,
  P_SOURCE_NOTE_ID,
  replaceParagraphDraft,
} from "../../tests/fixtures/proposal-document";

describe("findRequestSelectionConflictIds / findProposalFreshnessConflictIds", () => {
  it("allows force apply only for content-stale conflicts", () => {
    expect(canForceApplyProposalConflict({ blockIds: ["b1"], reason: "content-stale" })).toBe(true);
    expect(canForceApplyProposalConflict({ blockIds: ["b1"], reason: "anchor-missing" })).toBe(false);
    expect(canForceApplyProposalConflict({ blockIds: ["asset_1"], reason: "asset-collision" })).toBe(false);
    expect(canForceApplyProposalConflict({ blockIds: ["b1"], reason: "replay-failed" })).toBe(false);
  });

  it("reports no conflict when the request selection is empty (unselected request)", () => {
    expect(findRequestSelectionConflictIds(
      { blockIds: [], hashes: {}, capturedRevision: 1 },
      { block_a: "hash_a" },
    )).toEqual([]);
  });

  it("reports no conflict when every selected id still has the captured hash", () => {
    expect(findRequestSelectionConflictIds(
      { blockIds: ["block_a"], hashes: { block_a: "hash_a" }, capturedRevision: 1 },
      { block_a: "hash_a", block_b: "hash_b_changed" },
    )).toEqual([]);
  });

  it("reports changed, deleted, and newly-created selected ids as conflicts", () => {
    expect(findRequestSelectionConflictIds(
      {
        blockIds: ["block_changed", "block_deleted", "block_created"],
        hashes: { block_changed: "old", block_deleted: "old" },
        capturedRevision: 1,
      },
      { block_changed: "new", block_created: "new" },
    )).toEqual(["block_changed", "block_deleted", "block_created"]);
  });

  it("checks the actual overwrite target instead of an unchanged request selection", () => {
    const conflictIds = findProposalFreshnessConflictIds(
      {
        baseRevision: 1,
        requestSelection: { blockIds: ["block_sel"], hashes: { block_sel: "same" }, capturedRevision: 1 },
        touchedBlocks: [{ id: "block_other", baseHash: "old" }],
        draft: replaceParagraphDraft("block_other", "AIの本文"),
      },
      { block_sel: "same", block_other: "new" },
      99,
    );
    expect(conflictIds).toEqual(["block_other"]);
    expect(findProposalFreshnessConflict(
      {
        baseRevision: 1,
        requestSelection: { blockIds: ["block_sel"], hashes: { block_sel: "same" }, capturedRevision: 1 },
        touchedBlocks: [{ id: "block_other", baseHash: "old" }],
        draft: replaceParagraphDraft("block_other", "AIの本文"),
      },
      { block_sel: "same", block_other: "new" },
      99,
    )).toEqual({ blockIds: ["block_other"], reason: "content-stale" });
  });

  it("does not call an additive insertion a conflict when its selection or anchor text changed", () => {
    const insertion: AiEditSessionDraft = {
      summary: "段落を追加しました。",
      plan: ["段落を追加しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "段落を追加しました。",
        targetId: "block_anchor",
        insertedBlock: { type: "paragraph", id: "block_new", children: [{ type: "text", text: "追加" }] },
      }],
      warnings: [],
    };
    expect(findProposalFreshnessConflictIds(
      {
        baseRevision: 1,
        requestSelection: { blockIds: ["block_sel"], hashes: { block_sel: "old_selection" }, capturedRevision: 1 },
        touchedBlocks: [
          { id: "block_anchor", baseHash: "old_anchor" },
          { id: "block_new", baseHash: null },
        ],
        draft: insertion,
      },
      { block_sel: "new_selection", block_anchor: "new_anchor" },
      2,
    )).toEqual([]);
  });

  it("uses only anchor existence for an insertion without touchedBlocks", () => {
    const insertion: AiEditSessionDraft = {
      summary: "段落を追加しました。",
      plan: ["段落を追加しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "段落を追加しました。",
        targetId: "block_anchor",
        insertedBlock: { type: "paragraph", id: "block_new", children: [{ type: "text", text: "追加" }] },
      }],
      warnings: [],
    };
    const proposal = {
      baseRevision: 1,
      requestSelection: {
        blockIds: ["unrelated_selection"],
        hashes: { unrelated_selection: "old_selection" },
        capturedRevision: 1,
      },
      draft: insertion,
    };

    // Unrelated selection drift and anchor text drift are both additive-safe.
    expect(findProposalFreshnessConflictIds(
      proposal,
      { unrelated_selection: "new_selection", block_anchor: "new_anchor_text" },
      2,
    )).toEqual([]);

    // The explicit insert contract is structural: the external anchor must exist.
    expect(findProposalFreshnessConflictIds(
      proposal,
      { unrelated_selection: "new_selection" },
      2,
    )).toEqual(["block_anchor"]);
    expect(findProposalFreshnessConflict(
      proposal,
      { unrelated_selection: "new_selection" },
      2,
    )).toEqual({ blockIds: ["block_anchor"], reason: "anchor-missing" });
  });

  it("treats an external shape anchor as a required insert dependency", () => {
    const currentDocument = ensurePageLayout(paragraphDocument(["block_anchor"]));
    const draft: AiEditSessionDraft = {
      summary: "親図形にラベルを追加しました。",
      plan: ["親図形にラベルを追加しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "ラベルを追加しました。",
        targetId: "block_anchor",
        overlayShape: {
          id: "shape_child",
          type: "geo",
          x: 30,
          y: 20,
          anchor: { type: "shape", shapeId: "shape_parent", dx: 20, dy: 10 },
          props: {
            w: 80,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflict(
      { baseRevision: 1, draft, touchedBlocks: [] },
      computeDocumentBlockHashes(currentDocument),
      2,
      currentDocument,
    )).toEqual({ blockIds: ["shape_parent"], reason: "anchor-missing" });
  });

  it("does not require a shape anchor that an earlier operation creates in the same draft", () => {
    const currentDocument = ensurePageLayout(paragraphDocument(["block_anchor"]));
    const geoProps = {
      w: 80,
      h: 30,
      geo: "rectangle" as const,
      fill: "none" as const,
      color: "black",
      labelColor: "black",
      dash: "solid" as const,
      size: "m" as const,
    };
    const draft: AiEditSessionDraft = {
      summary: "親子図形を追加しました。",
      plan: ["親子図形を追加しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "親図形を追加しました。",
        targetId: "block_anchor",
        overlayShape: {
          id: "shape_parent",
          type: "geo",
          x: 10,
          y: 10,
          anchor: { type: "block", blockId: "block_anchor", dx: 0, dy: 0 },
          props: geoProps,
        },
        assets: {},
      }, {
        operation: "insertOverlayShape",
        summary: "子図形を追加しました。",
        targetId: "block_anchor",
        overlayShape: {
          id: "shape_child",
          type: "geo",
          x: 20,
          y: 20,
          anchor: { type: "shape", shapeId: "shape_parent", dx: 10, dy: 10 },
          props: geoProps,
        },
        assets: {},
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflict(
      { baseRevision: 1, draft, touchedBlocks: [] },
      computeDocumentBlockHashes(currentDocument),
      2,
      currentDocument,
    )).toBeNull();
  });

  it("does not require a block anchor created inside an earlier replacement in the same draft", () => {
    const currentDocument = ensurePageLayout({
      ...paragraphDocument([]),
      content: [{
        type: "problem",
        id: "problem_anchor_parent",
        tags: [],
        lead: [],
        prompt: [],
        answer: { type: "math", expected: "" },
        solution: [],
        hints: [],
      }],
    });
    const replacementProblem: ProblemNode = {
      type: "problem",
      id: "problem_anchor_parent",
      tags: [],
      lead: [],
      prompt: [],
      answer: { type: "math", expected: "" },
      solution: [{
        type: "paragraph",
        id: "replacement_child_anchor",
        children: [{ type: "text", text: "図1" }],
      }],
      hints: [],
    };
    const draft: AiEditSessionDraft = {
      summary: "問題と図形を更新しました。",
      plan: ["問題と図形を更新しました。"],
      operations: [{
        operation: "replace",
        summary: "問題を更新しました。",
        targetId: replacementProblem.id,
        replacementBlock: replacementProblem,
      }, {
        operation: "insertOverlayShape",
        summary: "図形を追加しました。",
        targetId: "replacement_child_anchor",
        overlayShape: {
          id: "replacement_child_shape",
          type: "geo",
          x: 10,
          y: 10,
          anchor: { type: "block", blockId: "replacement_child_anchor", dx: 0, dy: 0 },
          props: {
            w: 80,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflict(
      {
        baseRevision: 1,
        draft,
        touchedBlocks: [
          { id: "problem_anchor_parent", baseHash: computeDocumentBlockHashes(currentDocument).problem_anchor_parent },
          { id: "replacement_child_anchor", baseHash: null },
          { id: "replacement_child_shape", baseHash: null },
        ],
      },
      computeDocumentBlockHashes(currentDocument),
      1,
      currentDocument,
    )).toBeNull();
    expect(() => replayProposalDraft(currentDocument, draft)).not.toThrow();
  });

  it("still reports an external block anchor missing after a replacement", () => {
    const currentDocument = paragraphDocument(["problem_anchor_parent"]);
    const draft: AiEditSessionDraft = {
      summary: "問題と図形を更新しました。",
      plan: ["問題と図形を更新しました。"],
      operations: [{
        operation: "replace",
        summary: "本文を更新しました。",
        targetId: "problem_anchor_parent",
        replacementBlock: {
          type: "paragraph",
          id: "problem_anchor_parent",
          children: [{ type: "text", text: "更新後" }],
        },
      }, {
        operation: "insertOverlayShape",
        summary: "図形を追加しました。",
        targetId: "missing_external_anchor",
        overlayShape: {
          id: "missing_anchor_shape",
          type: "geo",
          x: 10,
          y: 10,
          anchor: { type: "block", blockId: "missing_external_anchor", dx: 0, dy: 0 },
          props: {
            w: 80,
            h: 30,
            geo: "rectangle",
            fill: "none",
            color: "black",
            labelColor: "black",
            dash: "solid",
            size: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflict(
      {
        baseRevision: 1,
        draft,
        touchedBlocks: [{
          id: "problem_anchor_parent",
          baseHash: computeDocumentBlockHashes(currentDocument).problem_anchor_parent,
        }],
      },
      computeDocumentBlockHashes(currentDocument),
      1,
      currentDocument,
    )).toEqual({ blockIds: ["missing_external_anchor"], reason: "anchor-missing" });
  });

  it("classifies an occupied inserted block ID as replay-failed, not anchor-missing", () => {
    const currentDocument = paragraphDocument(["block_anchor", "block_inserted"]);
    const draft: AiEditSessionDraft = {
      summary: "本文を追記しました。",
      plan: ["本文を追記しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "本文を追記しました。",
        targetId: "block_anchor",
        insertedBlock: {
          type: "paragraph",
          id: "block_inserted",
          children: [{ type: "text", text: "AI insert" }],
        },
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflict(
      { baseRevision: 1, draft, touchedBlocks: [] },
      computeDocumentBlockHashes(currentDocument),
      2,
      currentDocument,
    )).toEqual({ blockIds: ["block_inserted"], reason: "replay-failed" });
  });

  it("reports a non-identical overlay asset collision as a freshness conflict", () => {
    const base = ensurePageLayout(sampleDocument);
    const existingAsset = {
      id: "asset_shared",
      type: "image" as const,
      props: {
        w: 120,
        h: 80,
        name: "existing.png",
        isAnimated: false as const,
        mimeType: "image/png",
        src: "data:image/png;base64,OLD",
        fileSize: 3,
      },
    };
    const currentDocument: SigmaDocument = {
      ...base,
      pageLayout: {
        ...base.pageLayout!,
        overlay: {
          ...base.pageLayout?.overlay,
          overlaySnapshot: { version: 1, shapes: [], assets: { asset_shared: existingAsset } },
        },
      },
    };
    const draft: AiEditSessionDraft = {
      summary: "画像を挿入しました。",
      plan: ["画像を挿入しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "画像を挿入しました。",
        targetId: SOLE_BLOCK_ID,
        overlayShape: {
          id: "shape_new",
          type: "image",
          x: 10,
          y: 10,
          props: { assetId: "asset_shared", w: 120, h: 80 },
        },
        assets: {
          asset_shared: {
            ...existingAsset,
            props: { ...existingAsset.props, src: "data:image/png;base64,NEW" },
          },
        },
      }],
      warnings: [],
    };

    expect(findProposalFreshnessConflictIds(
      { baseRevision: 1, draft, touchedBlocks: [] },
      computeDocumentBlockHashes(currentDocument),
      2,
      currentDocument,
    )).toEqual(["asset_shared"]);
    expect(findProposalFreshnessConflict(
      { baseRevision: 1, draft, touchedBlocks: [] },
      computeDocumentBlockHashes(currentDocument),
      2,
      currentDocument,
    )).toEqual({ blockIds: ["asset_shared"], reason: "asset-collision" });
  });

  it("findProposalFreshnessConflictIds: with draft, requestSelection drift outside sensitiveDraftIds → no conflict", () => {
    const draft: AiEditSessionDraft = {
      summary: "selAとselBを書き換えました。",
      plan: ["selAとselBを書き換えました。"],
      operations: [
        {
          operation: "replace",
          summary: "selAを書き換えました。",
          targetId: "selA",
          replacementBlock: {
            type: "paragraph",
            id: "selA",
            children: [{ type: "text", text: "AI A" }],
          },
        },
        {
          operation: "replace",
          summary: "selBを書き換えました。",
          targetId: "selB",
          replacementBlock: {
            type: "paragraph",
            id: "selB",
            children: [{ type: "text", text: "AI B" }],
          },
        },
      ],
      warnings: [],
    };
    const proposal = {
      baseRevision: 1,
      requestSelection: {
        blockIds: ["selA", "selB", "selC"],
        hashes: { selA: "oldA", selB: "oldB", selC: "oldC" },
        capturedRevision: 1,
      },
      // selBのbaseHashが欠けているためrequestSelection fallbackを通す。
      touchedBlocks: [{ id: "selA", baseHash: "oldA" }],
      draft,
    };

    expect(findProposalFreshnessConflictIds(
      proposal,
      { selA: "oldA", selB: "oldB", selC: "newC" },
      2,
    )).toEqual([]);
  });

  it("findProposalFreshnessConflictIds: with draft, requestSelection drift in sensitiveDraftIds → conflict", () => {
    const draft: AiEditSessionDraft = {
      summary: "selAとselBを書き換えました。",
      plan: ["selAとselBを書き換えました。"],
      operations: [
        {
          operation: "replace",
          summary: "selAを書き換えました。",
          targetId: "selA",
          replacementBlock: {
            type: "paragraph",
            id: "selA",
            children: [{ type: "text", text: "AI A" }],
          },
        },
        {
          operation: "replace",
          summary: "selBを書き換えました。",
          targetId: "selB",
          replacementBlock: {
            type: "paragraph",
            id: "selB",
            children: [{ type: "text", text: "AI B" }],
          },
        },
      ],
      warnings: [],
    };
    const proposal = {
      baseRevision: 1,
      requestSelection: {
        blockIds: ["selA", "selB", "selC"],
        hashes: { selA: "oldA", selB: "oldB", selC: "oldC" },
        capturedRevision: 1,
      },
      touchedBlocks: [{ id: "selA", baseHash: "oldA" }],
      draft,
    };

    expect(findProposalFreshnessConflictIds(
      proposal,
      { selA: "newA", selB: "oldB", selC: "oldC" },
      2,
    )).toEqual(["selA"]);
  });

  it("findProposalFreshnessConflictIds: legacy record with no draft → still compares all requestSelection ids", () => {
    expect(findProposalFreshnessConflictIds(
      {
        baseRevision: 1,
        requestSelection: {
          blockIds: ["selA", "selB", "selC"],
          hashes: { selA: "oldA", selB: "oldB", selC: "oldC" },
          capturedRevision: 1,
        },
      },
      { selA: "oldA", selB: "oldB", selC: "newC" },
      2,
    )).toEqual(["selC"]);
  });

  it("falls back to touchedBlocks for legacy proposals without requestSelection", () => {
    const legacy = {
      baseRevision: 1,
      touchedBlocks: [{ id: "block_other", baseHash: "old" }],
    };
    expect(findProposalFreshnessConflictIds(legacy, { block_other: "new" }, 2)).toEqual(["block_other"]);
    // Same revision → legacy path treats it as fresh without hashing.
    expect(findProposalFreshnessConflictIds(legacy, { block_other: "new" }, 1)).toEqual([]);
  });
});

describe("shouldAutoApplyProposal", () => {
  const pendingVerified = { status: "pending" as const, verification: { validationOk: true }, baseRevision: 3 };

  it("returns true when the setting is on, proposal is pending+verified, and revisions match", () => {
    expect(shouldAutoApplyProposal({ settingEnabled: true, proposal: pendingVerified, currentRevision: 3 })).toBe(true);
  });

  it("returns false when the setting is off", () => {
    expect(shouldAutoApplyProposal({ settingEnabled: false, proposal: pendingVerified, currentRevision: 3 })).toBe(false);
  });

  it("returns false when the proposal is not pending", () => {
    expect(
      shouldAutoApplyProposal({
        settingEnabled: true,
        proposal: { ...pendingVerified, status: "approved" },
        currentRevision: 3,
      }),
    ).toBe(false);
  });

  it("returns false when verification is missing or not ok", () => {
    expect(
      shouldAutoApplyProposal({
        settingEnabled: true,
        proposal: { ...pendingVerified, verification: undefined },
        currentRevision: 3,
      }),
    ).toBe(false);
    expect(
      shouldAutoApplyProposal({
        settingEnabled: true,
        proposal: { ...pendingVerified, verification: { validationOk: false } },
        currentRevision: 3,
      }),
    ).toBe(false);
  });

  it("returns false when baseRevision does not match the current file revision (stale proposal)", () => {
    expect(shouldAutoApplyProposal({ settingEnabled: true, proposal: pendingVerified, currentRevision: 4 })).toBe(false);
  });
});

describe("collectTouchedBlockIds", () => {
  it("returns the replace target as the sole touched id", () => {
    expect(collectTouchedBlockIds(replaceParagraphDraft(P_YOTTE_ID, "新しい本文"))).toEqual([P_YOTTE_ID]);
  });

  it("returns both the insertAfter anchor and the newly inserted block id", () => {
    const draft: AiEditSessionDraft = {
      summary: "段落を追加しました。",
      plan: ["段落を追加しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "段落を追加しました。",
        targetId: P_YOTTE_ID,
        insertedBlock: { type: "paragraph", id: "p_new_inserted", children: [{ type: "text", text: "追加" }] } satisfies ParagraphNode,
      }],
      warnings: [],
    };
    expect(collectTouchedBlockIds(draft)).toEqual([P_YOTTE_ID, "p_new_inserted"]);
  });

  it("returns deleteBlocks targets", () => {
    expect(collectTouchedBlockIds(deleteBlockDraft(P_YOTTE_ID))).toEqual([P_YOTTE_ID]);
  });

  it("returns moveBlocks targets plus the destination anchor, deduped", () => {
    const draft: AiEditSessionDraft = {
      summary: "移動しました。",
      plan: ["移動しました。"],
      operations: [],
      warnings: [],
      mutationOperations: [{
        operation: "moveBlocks",
        summary: "移動しました。",
        blockIds: [P_YOTTE_ID],
        targetId: P_SOURCE_NOTE_ID,
        position: "after",
      }],
    };
    expect(collectTouchedBlockIds(draft)).toEqual([P_YOTTE_ID, P_SOURCE_NOTE_ID]);
  });

  it("dedupes an id referenced by multiple operations", () => {
    const draft: AiEditSessionDraft = {
      summary: "更新しました。",
      plan: ["更新しました。"],
      operations: [],
      warnings: [],
      mutationOperations: [
        { operation: "updateOverlayShape", summary: "更新1", shapeId: "shape_1", patch: {} },
        { operation: "alignOverlayShapes", summary: "整列", shapeIds: ["shape_1", "shape_2"], mode: "left" },
      ],
    };
    expect(collectTouchedBlockIds(draft)).toEqual(["shape_1", "shape_2"]);
  });
});

describe("collectConflictSensitiveBlockIds", () => {
  it("includes overwrite/delete targets but not additive insertion anchors", () => {
    const insertion: AiEditSessionDraft = {
      summary: "段落を追加しました。",
      plan: ["段落を追加しました。"],
      operations: [{
        operation: "insertAfter",
        summary: "段落を追加しました。",
        targetId: P_YOTTE_ID,
        insertedBlock: { type: "paragraph", id: "p_new", children: [{ type: "text", text: "追加" }] },
      }],
      warnings: [],
    };
    const calloutInsertion: AiEditSessionDraft = {
      summary: "吹き出しを追加しました。",
      plan: ["吹き出しを追加しました。"],
      operations: [{
        operation: "insertOverlayShape",
        summary: "吹き出しを追加しました。",
        targetId: P_YOTTE_ID,
        overlayShape: {
          id: "callout_new",
          type: "callout",
          x: 20,
          y: 80,
          rotation: 0,
          anchor: { type: "block", blockId: P_YOTTE_ID, dx: 20, dy: 80, reserveSpace: true },
          props: {
            w: 320,
            h: 68,
            radius: 18,
            tail: {
              baseStart: { x: 44, y: 68 },
              baseEnd: { x: 84, y: 68 },
              tip: { x: 64, y: 96 },
            },
            blocks: [{ type: "paragraph", id: "local_sigma_doc_proposal_store_test_53", children: [] }],
            color: "#111111",
            size: "m",
            dash: "solid",
            strokeWidth: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };
    const legacyAnchorSupport: AiEditSessionDraft = {
      summary: "空の解答欄へ吹き出しを追加しました。",
      plan: ["吹き出しを追加しました。"],
      operations: [{
        operation: "replace",
        summary: "図形の挿入先として問題の解答に空行を追加しました。",
        targetId: "problem_empty_solution",
        replacementBlock: {
          type: "problem",
          id: "problem_empty_solution",
          tags: [],
          lead: [],
          prompt: [{ type: "paragraph", id: "prompt_existing", children: [{ type: "text", text: "問題" }] }],
          solution: [{ type: "paragraph", id: "answer_anchor", children: [] }],
          hints: [],
        },
      }, {
        operation: "insertOverlayShape",
        summary: "吹き出しを追加しました。",
        targetId: "answer_anchor",
        overlayShape: {
          id: "callout_legacy",
          type: "callout",
          x: 20,
          y: 80,
          rotation: 0,
          anchor: { type: "block", blockId: "answer_anchor", dx: 20, dy: 80, reserveSpace: true },
          props: {
            w: 320,
            h: 68,
            radius: 18,
            tail: {
              baseStart: { x: 44, y: 68 },
              baseEnd: { x: 84, y: 68 },
              tip: { x: 64, y: 96 },
            },
            blocks: [{ type: "paragraph", id: "local_sigma_doc_proposal_store_test_54", children: [] }],
            color: "#111111",
            size: "m",
            dash: "solid",
            strokeWidth: "m",
          },
        },
        assets: {},
      }],
      warnings: [],
    };

    expect(collectConflictSensitiveBlockIds(insertion)).toEqual([]);
    expect(collectConflictSensitiveBlockIds(calloutInsertion)).toEqual([]);
    expect(collectConflictSensitiveBlockIds(legacyAnchorSupport)).toEqual([]);
    expect(collectConflictSensitiveBlockIds(replaceParagraphDraft(P_YOTTE_ID, "置換"))).toEqual([P_YOTTE_ID]);
    expect(collectConflictSensitiveBlockIds(deleteBlockDraft(P_YOTTE_ID))).toEqual([P_YOTTE_ID]);
  });
});

describe("findConflictingBlockIds", () => {
  it("returns an empty array when every touched hash still matches", () => {
    const hashes = computeDocumentBlockHashes(sampleDocument);
    const touched = [{ id: P_YOTTE_ID, baseHash: hashes[P_YOTTE_ID] }];
    expect(findConflictingBlockIds(touched, hashes)).toEqual([]);
  });

  it("reports ids whose current hash differs from baseHash, including missing-now ids", () => {
    const hashes = computeDocumentBlockHashes(sampleDocument);
    const touched = [
      { id: P_YOTTE_ID, baseHash: "stale-hash" },
      { id: P_SOURCE_NOTE_ID, baseHash: hashes[P_SOURCE_NOTE_ID] },
      { id: "deleted_since", baseHash: "was-here" },
    ];
    expect(findConflictingBlockIds(touched, hashes)).toEqual([P_YOTTE_ID, "deleted_since"]);
  });

  it("treats baseHash: null as matching only when the id still does not exist", () => {
    const hashes = computeDocumentBlockHashes(sampleDocument);
    const stillMissing = [{ id: "not_yet_created", baseHash: null }];
    expect(findConflictingBlockIds(stillMissing, hashes)).toEqual([]);

    const nowExists = [{ id: P_YOTTE_ID, baseHash: null }];
    expect(findConflictingBlockIds(nowExists, hashes)).toEqual([P_YOTTE_ID]);
  });
});

describe("shouldAutoApplyProposal (conflict gate)", () => {
  it("returns false when the proposal has a recorded conflict, even if revisions match", () => {
    expect(
      shouldAutoApplyProposal({
        settingEnabled: true,
        proposal: {
          status: "pending",
          verification: { validationOk: true },
          baseRevision: 3,
          conflict: { blockIds: ["p_yotte"], detectedAtRevision: 3 },
        },
        currentRevision: 3,
      }),
    ).toBe(false);
  });
});
