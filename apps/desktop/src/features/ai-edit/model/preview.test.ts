import { describe, expect, it } from "vitest";

import {
  buildAppliedTurnChangesByTurnId,
  buildInsertedShapePreviewsByTurnId,
  buildRestorableProposalsByTurnId,
  buildSourceReferencesByTurnId,
  classifyStaleMcpProposal,
  dedupeAiSourceReferences,
  deriveAiEditPreviewDiff,
  deriveAiEditPreviewOverlayShapes,
  deriveAiEditPreviewShapeUpdates,
  derivePendingAiProposalLockTargets,
  derivePostApplyHighlightIds,
  describeRevertBlockedReason,
  formatAiProposalProviderLabel,
  groupMcpProposalsForPreview,
  hasBodyAiEditChanges,
  hasOverlayAiEditChanges,
  isOverlayOnlyAiEditPreview,
  resolveMutationOpAssets,
  resolveMutationOpShapeResults,
  resolveOverlayShapeAnchorBlockId,
  summarizeAiEditPreviewChanges,
  type AiEditPreviewState,
  AI_EDIT_CHANGE_NOUN_IDS,
  overlayShapeNoun,
  overlayShapeNounId,
} from "./preview";
import type { AiEditDraft, AiEditSessionDraft, SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import type { OverlayAsset, OverlayShape } from "@/features/document";
import type { DesktopMcpEditProposalProvider, DesktopMcpEditProposalSummary } from "@/types/desktop";
import type { OverlayGeoShape, OverlayTableShape } from "@/features/document";
import type { SigmaDocument } from "@/types/sigma-doc";

function makeProposal(
  overrides: Partial<Omit<DesktopMcpEditProposalSummary, "draft">> & {
    proposalId: string;
    fileId: string;
    targetId: string;
    draftOverrides?: Partial<AiEditSessionDraft>;
  },
): DesktopMcpEditProposalSummary {
  const draft = {
    summary: overrides.summary ?? `draft for ${overrides.targetId}`,
    plan: [`plan ${overrides.targetId}`],
    operations: [
      {
        operation: "insertAfter",
        summary: "op",
        targetId: overrides.targetId,
        insertedBlock: {
          id: `inserted_${overrides.targetId}`,
          type: "paragraph",
          children: [{ type: "text", text: `追加 ${overrides.targetId}` }],
        },
      },
    ],
    warnings: [],
    ...overrides.draftOverrides,
  } as unknown as AiEditSessionDraft;
  return {
    proposalId: overrides.proposalId,
    fileId: overrides.fileId,
    baseRevision: overrides.baseRevision ?? 1,
    baseDocId: "doc_1",
    title: "教材",
    summary: overrides.summary ?? `提案 ${overrides.targetId}`,
    plan: draft.plan,
    warnings: [],
    changedIds: [overrides.targetId],
    provider: overrides.provider ?? null,
    ...(overrides.requestedShapeId ? { requestedShapeId: overrides.requestedShapeId } : {}),
    draft,
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? "2026-06-27T00:00:00.000Z",
    updatedAt: overrides.updatedAt ?? overrides.createdAt ?? "2026-06-27T00:00:00.000Z",
    runId: overrides.runId,
    roomId: overrides.roomId,
    turnId: overrides.turnId,
    sessionLabel: overrides.sessionLabel,
    sourceReferences: overrides.sourceReferences,
    touchedBlocks: overrides.touchedBlocks,
    requestSelection: overrides.requestSelection,
    conflict: overrides.conflict,
    invalidReason: overrides.invalidReason,
    appliedRevision: overrides.appliedRevision,
    appliedDiff: overrides.appliedDiff,
    autoApplied: overrides.autoApplied,
  };
}

function replaceDraftOverrides(targetId: string): Partial<AiEditSessionDraft> {
  return {
    operations: [{
      operation: "replace",
      summary: "置換",
      targetId,
      replacementBlock: {
        id: targetId,
        type: "paragraph",
        children: [{ type: "text", text: `置換 ${targetId}` }],
      },
    }],
  };
}

describe("groupMcpProposalsForPreview", () => {
  it("coalesces pending proposals from the same run matching currentRevision into one preview group (Decision A)", () => {
    const proposals = [
      makeProposal({ proposalId: "p1", fileId: "f1", targetId: "b1", createdAt: "2026-06-27T00:00:01.000Z", provider: "claude", runId: "run1" }),
      makeProposal({ proposalId: "p2", fileId: "f1", targetId: "b2", createdAt: "2026-06-27T00:00:02.000Z", provider: "claude", runId: "run1" }),
    ];

    const { groups, stale } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    const current = groups[0];
    expect(current.draft.operations).toHaveLength(2);
    expect(current.proposalIds).toEqual(["p1", "p2"]);
    expect(current.targetId).toBe("b1");
    expect(current.baseRevision).toBe(1);
    expect(current.providers).toEqual(["claude"]);
    expect(current.runId).toBe("run1");
    expect(current.draft.summary).toContain("提案 b1");
    expect(current.draft.summary).toContain("提案 b2");
    expect(stale).toEqual([]);
  });

  it("splits proposals from different runs into separate groups even at the same baseRevision (Decision B)", () => {
    const proposals = [
      makeProposal({ proposalId: "p1", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z", runId: "run1", sessionLabel: "会話1" }),
      makeProposal({ proposalId: "p2", fileId: "f1", targetId: "b", createdAt: "2026-06-27T00:00:02.000Z", runId: "run2", sessionLabel: "会話2" }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(2);
    const byRun = new Map(groups.map((group) => [group.runId, group]));
    expect(byRun.get("run1")?.proposalIds).toEqual(["p1"]);
    expect(byRun.get("run1")?.sessionLabel).toBe("会話1");
    expect(byRun.get("run2")?.proposalIds).toEqual(["p2"]);
    expect(byRun.get("run2")?.sessionLabel).toBe("会話2");
  });

  it("keeps follow-up runs from one chat room in one decision and exposes the latest turn metadata", () => {
    const proposals = [
      makeProposal({
        proposalId: "p1", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z",
        roomId: "room-1", turnId: "turn-1", runId: "run-1",
      }),
      makeProposal({
        proposalId: "p2", fileId: "f1", targetId: "b", createdAt: "2026-06-27T00:00:02.000Z",
        roomId: "room-1", turnId: "turn-2", runId: "run-2",
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      proposalIds: ["p1", "p2"],
      roomId: "room-1",
      turnId: "turn-2",
      runId: "run-2",
    });
  });

  it("folds proposals with no runId into a single unattributed group instead of one group per proposal", () => {
    const proposals = [
      makeProposal({ proposalId: "p1", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z" }),
      makeProposal({ proposalId: "p2", fileId: "f1", targetId: "b", createdAt: "2026-06-27T00:00:02.000Z" }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].runId).toBeUndefined();
    expect(groups[0].proposalIds).toEqual(["p1", "p2"]);
  });

  it("orders groups by createdAt ascending", () => {
    const proposals = [
      makeProposal({ proposalId: "late", fileId: "f1", targetId: "z", createdAt: "2026-06-27T00:00:09.000Z", runId: "run-late" }),
      makeProposal({ proposalId: "early", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z", runId: "run-early" }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups.map((group) => group.runId)).toEqual(["run-early", "run-late"]);
  });

  it("orders coalesced operations within a run by createdAt", () => {
    const proposals = [
      makeProposal({ proposalId: "late", fileId: "f1", targetId: "z", createdAt: "2026-06-27T00:00:09.000Z", runId: "run1" }),
      makeProposal({ proposalId: "early", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z", runId: "run1" }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups[0].proposalIds).toEqual(["early", "late"]);
    expect(groups[0].draft.operations[0].targetId).toBe("a");
  });

  it("marks a same-run delete followed by an insertion requesting the old id as one shape replacement", () => {
    const oldShape = {
      id: "old_table",
      type: "tableShape",
      x: 210,
      y: 500,
      anchor: { type: "block", blockId: "anchor", dx: 150, dy: 210 },
      props: { w: 420, h: 135, table: {} },
    } as OverlayTableShape;
    const newShape = {
      ...oldShape,
      id: "generated_table",
      x: 0,
      y: 56,
      anchor: { type: "block", blockId: "anchor", dx: 0, dy: 56 },
      props: { w: 460, h: 132, table: {} },
    } as OverlayTableShape;
    const proposals = [
      makeProposal({
        proposalId: "delete",
        fileId: "f1",
        targetId: oldShape.id,
        runId: "run1",
        createdAt: "2026-06-27T00:00:01.000Z",
        draftOverrides: {
          operations: [],
          mutationOperations: [{
            operation: "deleteOverlayShapes",
            summary: "旧表を削除",
            shapeIds: [oldShape.id],
          }],
        },
      }),
      makeProposal({
        proposalId: "insert",
        fileId: "f1",
        targetId: "anchor",
        runId: "run1",
        createdAt: "2026-06-27T00:00:02.000Z",
        requestedShapeId: oldShape.id,
        draftOverrides: {
          operations: [{
            operation: "insertTableShape",
            summary: "新表を挿入",
            targetId: "anchor",
            tableShape: newShape,
          }],
        },
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(["delete", "insert"]);
    expect(groups[0].shapeReplacements).toEqual([{
      removedShapeId: oldShape.id,
      addedShapeId: newShape.id,
    }]);
    const diff = deriveAiEditPreviewDiff(groups, [oldShape]);
    expect(diff.removedShapeIds).toEqual(new Set([oldShape.id]));
    expect(diff.addedShapes[0]?.shape).toMatchObject({
      id: oldShape.id,
      x: oldShape.x,
      y: oldShape.y,
      anchor: oldShape.anchor,
      props: { w: 460, h: 132 },
    });
    expect(deriveAiEditPreviewOverlayShapes(groups[0], [oldShape])).toEqual([diff.addedShapes[0].shape]);
  });

  it("ignores proposals for other files", () => {
    const proposals = [makeProposal({ proposalId: "p1", fileId: "other", targetId: "b1" })];
    expect(groupMcpProposalsForPreview(proposals, "f1", 1)).toEqual({ groups: [], stale: [], current: null });
  });

  it("ignores non-pending proposals", () => {
    const proposals = [makeProposal({ proposalId: "p1", fileId: "f1", targetId: "b1", status: "approved" })];
    expect(groupMcpProposalsForPreview(proposals, "f1", 1)).toEqual({ groups: [], stale: [], current: null });
  });

  it("returns empty when there are no proposals", () => {
    expect(groupMcpProposalsForPreview([], "f1", 1)).toEqual({ groups: [], stale: [], current: null });
  });

  it("returns empty when currentRevision is null, even with pending proposals", () => {
    const proposals = [makeProposal({ proposalId: "p1", fileId: "f1", targetId: "b1", baseRevision: 1 })];
    expect(groupMcpProposalsForPreview(proposals, "f1", null)).toEqual({ groups: [], stale: [], current: null });
  });

  it("separates proposals with a stale baseRevision into the stale list, contributing no groups", () => {
    const proposals = [
      makeProposal({ proposalId: "cur", fileId: "f1", targetId: "b1", baseRevision: 2, createdAt: "2026-06-27T00:00:02.000Z" }),
      makeProposal({
        proposalId: "old",
        fileId: "f1",
        targetId: "b0",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:01.000Z",
        draftOverrides: replaceDraftOverrides("b0"),
      }),
    ];

    const { groups, stale } = groupMcpProposalsForPreview(proposals, "f1", 2);

    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(["cur"]);
    expect(stale).toHaveLength(1);
    expect(stale[0].baseRevision).toBe(1);
    expect(stale[0].currentRevision).toBe(2);
    expect(stale[0].proposalIds).toEqual(["old"]);
    expect(groups[0].draft.operations.some((op) => op.targetId === "b0")).toBe(false);
  });

  it("keeps a touchedBlocks-less insertion applyable after an unrelated revision change", () => {
    const proposal = makeProposal({
      proposalId: "insert",
      fileId: "f1",
      targetId: "anchor",
      baseRevision: 1,
      touchedBlocks: undefined,
      requestSelection: undefined,
    });

    const { groups, stale } = groupMcpProposalsForPreview([proposal], "f1", 2);

    expect(stale).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(["insert"]);
  });

  it("orders multiple stale groups newest first", () => {
    const proposals = [
      makeProposal({ proposalId: "old1", fileId: "f1", targetId: "a", baseRevision: 1, createdAt: "2026-06-27T00:00:01.000Z", draftOverrides: replaceDraftOverrides("a") }),
      makeProposal({ proposalId: "old2", fileId: "f1", targetId: "b", baseRevision: 2, createdAt: "2026-06-27T00:00:05.000Z", draftOverrides: replaceDraftOverrides("b") }),
    ];

    const { stale } = groupMcpProposalsForPreview(proposals, "f1", 99);

    expect(stale.map((group) => group.baseRevision)).toEqual([2, 1]);
  });

  it("classifies a stale proposal with a conflict as 'conflict', regardless of touchedBlocks", () => {
    expect(classifyStaleMcpProposal({ conflict: { blockIds: ["b1"], detectedAtRevision: 5, reason: "content-stale" }, touchedBlocks: [{ id: "b1", baseHash: "h" }] }))
      .toBe("conflict");
    expect(classifyStaleMcpProposal({ conflict: { blockIds: ["b1"], detectedAtRevision: 5 } })).toBe("conflict");
  });

  it("keeps an invalid persisted draft out of preview operations and exposes its rejection reason", () => {
    const invalidReason = "保存済みのAI編集提案が現在の安全な形式に適合しません";
    const proposal = makeProposal({
      proposalId: "invalid",
      fileId: "f1",
      targetId: "b1",
      baseRevision: 1,
      invalidReason,
      conflict: { blockIds: [], detectedAtRevision: 1, reason: "replay-failed" },
      draftOverrides: { operations: [] },
    });

    const result = groupMcpProposalsForPreview([proposal], "f1", 1);
    expect(result.groups).toEqual([]);
    expect(result.stale).toEqual([expect.objectContaining({
      proposalIds: ["invalid"],
      kind: "conflict",
      conflictReason: "replay-failed",
      invalidReason,
    })]);
  });

  it("classifies a stale proposal with touchedBlocks but no conflict as 'pending-auto-rebase'", () => {
    expect(classifyStaleMcpProposal({ touchedBlocks: [{ id: "b1", baseHash: "h" }] })).toBe("pending-auto-rebase");
  });

  it("classifies a stale proposal with neither touchedBlocks nor conflict as 'manual-rebase' (pre-W1 legacy proposal)", () => {
    expect(classifyStaleMcpProposal({})).toBe("manual-rebase");
    expect(classifyStaleMcpProposal({ touchedBlocks: [] })).toBe("manual-rebase");
  });

  it("splits stale proposals at the same baseRevision into separate groups by kind", () => {
    const proposals = [
      makeProposal({
        proposalId: "conflicted",
        fileId: "f1",
        targetId: "a",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:01.000Z",
        touchedBlocks: [{ id: "a", baseHash: "old" }],
        conflict: { blockIds: ["a"], detectedAtRevision: 2, reason: "content-stale" },
        draftOverrides: replaceDraftOverrides("a"),
      }),
      makeProposal({
        proposalId: "pending_rebase",
        fileId: "f1",
        targetId: "b",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:02.000Z",
        touchedBlocks: [{ id: "b", baseHash: "old" }],
        draftOverrides: replaceDraftOverrides("b"),
      }),
      makeProposal({
        proposalId: "legacy",
        fileId: "f1",
        targetId: "c",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:03.000Z",
        draftOverrides: replaceDraftOverrides("c"),
      }),
    ];

    const { stale } = groupMcpProposalsForPreview(proposals, "f1", 2);

    expect(stale).toHaveLength(3);
    const byKind = new Map(stale.map((group) => [group.kind, group]));
    expect(byKind.get("conflict")?.proposalIds).toEqual(["conflicted"]);
    expect(byKind.get("conflict")?.conflictBlockIds).toEqual(["a"]);
    expect(byKind.get("conflict")?.conflictReason).toBe("content-stale");
    expect(byKind.get("pending-auto-rebase")?.proposalIds).toEqual(["pending_rebase"]);
    expect(byKind.get("manual-rebase")?.proposalIds).toEqual(["legacy"]);
    // conflictBlockIds only makes sense for the conflict kind.
    expect(byKind.get("pending-auto-rebase")?.conflictBlockIds).toBeUndefined();
    expect(byKind.get("manual-rebase")?.conflictBlockIds).toBeUndefined();
  });

  it("keeps a run's proposals in ONE preview group across a mid-run revision bump when they carry requestSelection (1 run = 1 card)", () => {
    const requestSelection = { blockIds: ["b1"], hashes: { b1: "hash" }, capturedRevision: 1 };
    const proposals = [
      makeProposal({ proposalId: "p1", fileId: "f1", targetId: "b1", baseRevision: 1, createdAt: "2026-06-27T00:00:01.000Z", runId: "run1", requestSelection }),
      // 人手編集で revision が進んだ後に作られた同一 run の提案。
      makeProposal({ proposalId: "p2", fileId: "f1", targetId: "b2", baseRevision: 3, createdAt: "2026-06-27T00:00:02.000Z", runId: "run1", requestSelection }),
    ];

    const { groups, stale } = groupMcpProposalsForPreview(proposals, "f1", 3);

    expect(stale).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(["p1", "p2"]);
    expect(groups[0].baseRevision).toBe(3);
  });

  it("routes a requestSelection proposal to the stale list only when a conflict was detected", () => {
    const requestSelection = { blockIds: ["b1"], hashes: { b1: "hash" }, capturedRevision: 1 };
    const proposals = [
      makeProposal({
        proposalId: "conflicted",
        fileId: "f1",
        targetId: "b1",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:01.000Z",
        runId: "run1",
        requestSelection,
        conflict: { blockIds: ["b1"], detectedAtRevision: 2 },
      }),
    ];

    const { groups, stale } = groupMcpProposalsForPreview(proposals, "f1", 2);

    expect(groups).toEqual([]);
    expect(stale).toHaveLength(1);
    expect(stale[0].kind).toBe("conflict");
    expect(stale[0].conflictBlockIds).toEqual(["b1"]);
  });

  it("assigns 'manual-rebase' kind to a stale group when no proposal carries touchedBlocks/conflict (legacy default)", () => {
    const proposals = [
      makeProposal({
        proposalId: "old",
        fileId: "f1",
        targetId: "b0",
        baseRevision: 1,
        createdAt: "2026-06-27T00:00:01.000Z",
        draftOverrides: replaceDraftOverrides("b0"),
      }),
    ];

    const { stale } = groupMcpProposalsForPreview(proposals, "f1", 2);

    expect(stale).toHaveLength(1);
    expect(stale[0].kind).toBe("manual-rebase");
  });

  it("collects a unique set of providers in createdAt order within a run", () => {
    const proposals = [
      makeProposal({ proposalId: "p1", fileId: "f1", targetId: "a", createdAt: "2026-06-27T00:00:01.000Z", provider: "claude", runId: "run1" }),
      makeProposal({ proposalId: "p2", fileId: "f1", targetId: "b", createdAt: "2026-06-27T00:00:02.000Z", provider: "claude", runId: "run1" }),
      makeProposal({ proposalId: "p3", fileId: "f1", targetId: "c", createdAt: "2026-06-27T00:00:03.000Z", provider: "chatgpt", runId: "run1" }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups[0].providers).toEqual(["claude", "chatgpt"]);
  });

  it("uses an empty providers array when provider information is unknown", () => {
    const proposals = [makeProposal({ proposalId: "p1", fileId: "f1", targetId: "a", provider: null })];
    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);
    expect(groups[0].providers).toEqual([]);
  });

  it("carries mutationOperations through into the grouped draft, and can produce a mutation-only group", () => {
    const deleteOp: SigmaDocMutationOp = {
      operation: "deleteBlocks",
      summary: "3件のブロックを削除",
      blockIds: ["b1", "b2", "b3"],
    };
    const proposals = [
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "a",
        runId: "run1",
        draftOverrides: { operations: [], mutationOperations: [deleteOp] },
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].draft.operations).toEqual([]);
    expect(groups[0].draft.mutationOperations).toEqual([deleteOp]);
    // No insertAfter/replace operation exists to derive targetId from, so it
    // falls back to the mutation op's own primary affected block.
    expect(groups[0].targetId).toBe("b1");
  });

  it("supplies a current-revision overlay update with no request selection or touched blocks", () => {
    const updateOp: SigmaDocMutationOp = {
      operation: "updateOverlayShape",
      summary: "図形を右へ移動",
      shapeId: "shape_1",
      patch: { x: 160 },
    };
    const proposal = makeProposal({
      proposalId: "shape-update",
      fileId: "f1",
      targetId: "shape_1",
      baseRevision: 2,
      requestSelection: undefined,
      touchedBlocks: undefined,
      draftOverrides: { operations: [], mutationOperations: [updateOp] },
    });

    const { groups, stale } = groupMcpProposalsForPreview([proposal], "f1", 2);

    expect(stale).toEqual([]);
    expect(groups).toHaveLength(1);
    expect(groups[0].proposalIds).toEqual(["shape-update"]);
    expect(groups[0].draft.operations).toEqual([]);
    expect(groups[0].draft.mutationOperations).toEqual([updateOp]);
    expect(groups[0].targetId).toBe("shape_1");
  });

  it("drops a group whose draft has neither operations nor mutationOperations", () => {
    const proposals = [
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "a",
        runId: "run1",
        draftOverrides: { operations: [], mutationOperations: [] },
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);
    expect(groups).toHaveLength(0);
  });

  it("aggregates and dedupes sourceReferences (Phase 1: Agentic RAG) across a run's proposals, keeping the first occurrence", () => {
    const proposals = [
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "a",
        createdAt: "2026-06-27T00:00:01.000Z",
        runId: "run1",
        sourceReferences: [
          { type: "document", fileId: "doc_1", title: "旧教材A" },
          { type: "web", url: "https://example.com/x" },
        ],
      }),
      makeProposal({
        proposalId: "p2",
        fileId: "f1",
        targetId: "b",
        createdAt: "2026-06-27T00:00:02.000Z",
        runId: "run1",
        // Duplicate document ref (no title this time) and a duplicate web ref:
        // both should be dropped in favor of the first occurrence above.
        sourceReferences: [
          { type: "document", fileId: "doc_1" },
          { type: "web", url: "https://example.com/x" },
          { type: "material", materialId: "mat_1", name: "図形素材" },
        ],
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups).toHaveLength(1);
    expect(groups[0].sourceReferences).toEqual([
      { type: "document", fileId: "doc_1", title: "旧教材A" },
      { type: "web", url: "https://example.com/x" },
      { type: "material", materialId: "mat_1", name: "図形素材" },
    ]);
  });

  it("omits sourceReferences entirely (not []) when no proposal in the group has any", () => {
    const proposals = [makeProposal({ proposalId: "p1", fileId: "f1", targetId: "a", runId: "run1" })];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    expect(groups[0].sourceReferences).toBeUndefined();
  });
});

describe("buildSourceReferencesByTurnId", () => {
  it("includes approved proposals so citations survive after apply", () => {
    const result = buildSourceReferencesByTurnId([
      {
        turnId: "turn_1",
        sourceReferences: [{ type: "document", fileId: "doc_1", title: "旧教材" }],
      },
      {
        turnId: "turn_1",
        sourceReferences: [{ type: "web", url: "https://example.com/ref" }],
      },
      {
        turnId: "turn_2",
        sourceReferences: [{ type: "document", fileId: "doc_2" }],
      },
    ]);

    expect(result.get("turn_1")).toEqual([
      { type: "document", fileId: "doc_1", title: "旧教材" },
      { type: "web", url: "https://example.com/ref" },
    ]);
    expect(result.get("turn_2")).toEqual([{ type: "document", fileId: "doc_2" }]);
  });

  it("skips proposals without turnId or sourceReferences", () => {
    const result = buildSourceReferencesByTurnId([
      { turnId: undefined, sourceReferences: [{ type: "document", fileId: "doc_1" }] },
      { turnId: "turn_1", sourceReferences: [] },
      { turnId: "turn_1", sourceReferences: [{ type: "document", fileId: "doc_2", title: "残る" }] },
    ]);

    expect(result.size).toBe(1);
    expect(result.get("turn_1")).toEqual([{ type: "document", fileId: "doc_2", title: "残る" }]);
  });
});

describe("buildInsertedShapePreviewsByTurnId", () => {
  it("combines native insertion drafts into one retained thumbnail per assistant turn", () => {
    const firstShape = rectShape("shape_1", 20, 30, { props: {
      w: 120,
      h: 72,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
      label: "図1",
    } });
    const secondShape = rectShape("shape_2", 180, 30, { props: {
      w: 120,
      h: 72,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
      label: "図2",
    } });
    const result = buildInsertedShapePreviewsByTurnId([
      makeProposal({
        proposalId: "p2",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        createdAt: "2026-06-27T00:00:02.000Z",
        draftOverrides: {
          operations: [{
            operation: "insertOverlayShape",
            summary: "図2を挿入",
            targetId: "b1",
            overlayShape: secondShape,
            assets: {},
          }],
        },
      }),
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        createdAt: "2026-06-27T00:00:01.000Z",
        draftOverrides: {
          operations: [{
            operation: "insertOverlayShape",
            summary: "図1を挿入",
            targetId: "b1",
            overlayShape: firstShape,
            assets: {},
          }],
        },
      }),
    ]);

    expect(result.size).toBe(1);
    expect(result.get("turn_1")?.svg).toContain("図1");
    expect(result.get("turn_1")?.svg).toContain("図2");
    expect(result.get("turn_1")?.width).toBeGreaterThan(300);
  });

  it("skips unattributed and non-shape proposals", () => {
    const result = buildInsertedShapePreviewsByTurnId([
      makeProposal({ proposalId: "no-turn", fileId: "f1", targetId: "b1" }),
      makeProposal({ proposalId: "text", fileId: "f1", targetId: "b1", turnId: "turn_1" }),
    ]);

    expect(result.size).toBe(0);
  });
});

describe("buildRestorableProposalsByTurnId", () => {
  it("keeps every rejected or reverted proposal in a turn as one restorable group", () => {
    const result = buildRestorableProposalsByTurnId([
      { turnId: "turn_1", proposalId: "p1_old", status: "rejected", updatedAt: "2024-01-01T00:00:00.000Z" },
      { turnId: "turn_1", proposalId: "p1_new", status: "reverted", updatedAt: "2024-01-02T00:00:00.000Z" },
      { turnId: "turn_1", proposalId: "p1_applied", status: "approved", updatedAt: "2024-01-03T00:00:00.000Z" },
      { turnId: "turn_2", proposalId: "p2", status: "approved", updatedAt: "2024-01-01T00:00:00.000Z" },
      { turnId: "turn_3", proposalId: "p3", status: "pending", updatedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    expect(result.get("turn_1")).toEqual({ proposalIds: ["p1_old", "p1_new"] });
    expect(result.has("turn_2")).toBe(false);
    expect(result.has("turn_3")).toBe(false);
    expect(result.size).toBe(1);
  });

  it("skips proposals without a turnId", () => {
    const result = buildRestorableProposalsByTurnId([
      { turnId: undefined, proposalId: "p1", status: "rejected", updatedAt: "2024-01-01T00:00:00.000Z" },
    ]);

    expect(result.size).toBe(0);
  });

  it("drops a turn once its latest proposal is applied again (no longer restorable)", () => {
    const result = buildRestorableProposalsByTurnId([
      { turnId: "turn_1", proposalId: "p1", status: "rejected", updatedAt: "2024-01-01T00:00:00.000Z" },
      { turnId: "turn_1", proposalId: "p1", status: "approved", updatedAt: "2024-01-02T00:00:00.000Z" },
    ]);

    expect(result.has("turn_1")).toBe(false);
  });

  it("hides restore while any proposal in the same turn is still pending", () => {
    const result = buildRestorableProposalsByTurnId([
      { turnId: "turn_1", proposalId: "p1", status: "rejected", updatedAt: "2024-01-01T00:00:00.000Z" },
      { turnId: "turn_1", proposalId: "p2", status: "pending", updatedAt: "2024-01-02T00:00:00.000Z" },
    ]);

    expect(result.has("turn_1")).toBe(false);
  });
});

describe("buildAppliedTurnChangesByTurnId", () => {
  it("keeps the exact added nodes from every approved proposal in the turn", () => {
    const result = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        provider: "claude",
        status: "approved",
        appliedRevision: 4,
        summary: "導入文を追加",
      }),
      makeProposal({
        proposalId: "p2",
        fileId: "f1",
        targetId: "b2",
        turnId: "turn_1",
        provider: "claude",
        status: "approved",
        appliedRevision: 4,
        summary: "例題を追加",
      }),
    ], "f1", 4);

    expect(result.get("turn_1")).toMatchObject({
      proposalIds: ["p1", "p2"],
      providers: ["claude"],
      canRevert: true,
    });
    expect(result.get("turn_1")?.diff.body).toEqual([
      {
        change: "added",
        block: {
          id: "inserted_b1",
          type: "paragraph",
          children: [{ type: "text", text: "追加 b1" }],
        },
      },
      {
        change: "added",
        block: {
          id: "inserted_b2",
          type: "paragraph",
          children: [{ type: "text", text: "追加 b2" }],
        },
      },
    ]);
  });

  it("returns every proposal from the shared save revision as the safe rollback batch", () => {
    const result = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "turn-a",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 7,
      }),
      makeProposal({
        proposalId: "turn-b",
        fileId: "f1",
        targetId: "b2",
        turnId: "turn_2",
        status: "approved",
        appliedRevision: 7,
      }),
    ], "f1", 7);

    expect(result.get("turn_1")?.revertProposalIds).toEqual(["turn-a", "turn-b"]);
    expect(result.get("turn_2")?.revertProposalIds).toEqual(["turn-a", "turn-b"]);
  });

  it("Phase 2: still allows revert once the document revision has moved on (main resolves full vs. selective itself)", () => {
    const movedOn = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 4,
      }),
    ], "f1", 5);

    expect(movedOn.get("turn_1")?.canRevert).toBe(true);
    expect(movedOn.get("turn_1")?.revertProposalIds).toEqual(["p1"]);
  });

  it("reverts a turn spread over several save revisions, newest batch first", () => {
    const mixed = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 4,
      }),
      makeProposal({
        proposalId: "p2",
        fileId: "f1",
        targetId: "b2",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 5,
      }),
    ], "f1", 5);

    expect(mixed.get("turn_1")?.canRevert).toBe(true);
    expect(mixed.get("turn_1")?.revertBlockedReason).toBeUndefined();
    expect(mixed.get("turn_1")?.revertProposalIds).toEqual(["p2", "p1"]);
  });

  it("keeps revert available when only some proposals in the turn recorded an appliedRevision", () => {
    const partial = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "legacy",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        // appliedRevision omitted: legacy record, nothing for main to roll back.
      }),
      makeProposal({
        proposalId: "p2",
        fileId: "f1",
        targetId: "b2",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 5,
      }),
    ], "f1", 5);

    expect(partial.get("turn_1")?.canRevert).toBe(true);
    expect(partial.get("turn_1")?.revertProposalIds).toEqual(["p2"]);
    expect(partial.get("turn_1")?.revertBlockedReason).toBeUndefined();
  });

  it("blocks revert only when no proposal in the turn recorded an appliedRevision", () => {
    const missingData = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        // appliedRevision omitted: legacy proposal with nothing for main to revert to.
      }),
    ], "f1", 5);
    expect(missingData.get("turn_1")?.canRevert).toBe(false);
    expect(missingData.get("turn_1")?.revertProposalIds).toEqual([]);
    expect(missingData.get("turn_1")?.revertBlockedReason).toBe("missingData");

    // 教材側のrevisionが未確定なだけのケースは、提案の記録漏れとは別の理由として出す。
    const noRevision = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 4,
      }),
    ], "f1", null);
    expect(noRevision.get("turn_1")?.canRevert).toBe(false);
    expect(noRevision.get("turn_1")?.revertBlockedReason).toBe("unknownRevision");

    const revertable = buildAppliedTurnChangesByTurnId([
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        turnId: "turn_1",
        status: "approved",
        appliedRevision: 4,
      }),
    ], "f1", 4);
    expect(revertable.get("turn_1")?.revertBlockedReason).toBeUndefined();
  });
});

describe("describeRevertBlockedReason", () => {
  it("turns the missingData classification into readable Japanese copy", () => {
    expect(describeRevertBlockedReason("missingData")).toBe(
      "この適用には取り消しに必要な情報が記録されていないため、元に戻せません",
    );
  });

  it("separates a still-loading document revision from a proposal that recorded nothing", () => {
    expect(describeRevertBlockedReason("unknownRevision")).toBe(
      "教材の保存状態を確認できないため、いまは元に戻せません",
    );
  });

  it("falls back to a generic sentence when no classification is available", () => {
    expect(describeRevertBlockedReason(undefined)).toBe("この適用は元に戻せません");
  });
});

describe("dedupeAiSourceReferences", () => {
  it("keeps the first occurrence per fileId/url/materialId key", () => {
    const result = dedupeAiSourceReferences([
      { type: "document", fileId: "doc_1", title: "先勝ち" },
      { type: "document", fileId: "doc_1", title: "後勝ちにはならない" },
      { type: "web", url: "https://example.com/a" },
      { type: "web", url: "https://example.com/a" },
      { type: "material", materialId: "mat_1", name: "素材1" },
    ]);

    expect(result).toEqual([
      { type: "document", fileId: "doc_1", title: "先勝ち" },
      { type: "web", url: "https://example.com/a" },
      { type: "material", materialId: "mat_1", name: "素材1" },
    ]);
  });
});

function makePreview(overrides: {
  operations?: AiEditDraft[];
  mutationOperations?: SigmaDocMutationOp[];
  operationOrder?: AiEditSessionDraft["operationOrder"];
  lockTargets?: boolean;
}): AiEditPreviewState {
  return {
    targetId: "t1",
    draft: {
      summary: "テスト提案",
      plan: ["plan"],
      operations: overrides.operations ?? [],
      warnings: [],
      ...(overrides.operationOrder ? { operationOrder: overrides.operationOrder } : {}),
      ...(overrides.mutationOperations ? { mutationOperations: overrides.mutationOperations } : {}),
    } as unknown as AiEditSessionDraft,
    createdAt: 0,
    proposalIds: ["p1"],
    baseRevision: 1,
    providers: [],
    lockTargets: overrides.lockTargets,
  };
}

const replaceDraft = {
  operation: "replace",
  summary: "置き換え",
  targetId: "b1",
  replacementBlock: { id: "b1", type: "paragraph", children: [] },
} as unknown as AiEditDraft;

const legacyReplaceDraft = {
  // Legacy drafts omit `operation` entirely for replace.
  summary: "置き換え(旧形式)",
  targetId: "b2",
  replacementBlock: { id: "b2", type: "paragraph", children: [] },
} as unknown as AiEditDraft;

const insertAfterDraft = {
  operation: "insertAfter",
  summary: "挿入",
  targetId: "b1",
  insertedBlock: { id: "b3", type: "paragraph", children: [] },
} as unknown as AiEditDraft;

const insertOverlayShapeDraft = {
  operation: "insertOverlayShape",
  summary: "図形挿入",
  targetId: "b1",
  overlayShape: { id: "s1", type: "rectShape" },
  assets: { a1: { id: "a1" } },
} as unknown as AiEditDraft;

const insertTableShapeDraft = {
  operation: "insertTableShape",
  summary: "表挿入",
  targetId: "b1",
  tableShape: { id: "s2", type: "tableShape" },
} as unknown as AiEditDraft;

// Exact support operation emitted by resolveProblemAreaOverlayInsertionTarget
// when insert_shape / insert_table / insert_graph targets an empty problem area.
const emptyAreaOverlayAnchorDraft = {
  operation: "replace",
  summary: "図形の挿入先として問題の問題文に空行を追加しました。",
  targetId: "problem_1",
  replacementBlock: {
    id: "problem_1",
    type: "problem",
    prompt: [{ id: "empty_prompt_anchor", type: "paragraph", children: [] }],
    lead: [], hints: [], solution: [],
  },
} as unknown as AiEditDraft;

const insertGraphShapeDraft = {
  operation: "insertOverlayShape",
  summary: "グラフを挿入しました。",
  targetId: "empty_prompt_anchor",
  overlayShape: { id: "g1", type: "graph2dShape" },
  assets: {},
} as unknown as AiEditDraft;

const deleteBlocksOp: SigmaDocMutationOp = {
  operation: "deleteBlocks",
  summary: "削除",
  blockIds: ["b4", "b5"],
};

const moveBlocksOp: SigmaDocMutationOp = {
  operation: "moveBlocks",
  summary: "移動",
  blockIds: ["b6"],
  targetId: "b1",
  position: "after",
};

const updateOverlayShapeOp: SigmaDocMutationOp = {
  operation: "updateOverlayShape",
  summary: "図形変更",
  shapeId: "s3",
  patch: {},
};

const alignOverlayShapesOp: SigmaDocMutationOp = {
  operation: "alignOverlayShapes",
  summary: "整列",
  shapeIds: ["s4", "s5"],
  mode: "left",
};

const deleteOverlayShapesOp: SigmaDocMutationOp = {
  operation: "deleteOverlayShapes",
  summary: "図形削除",
  shapeIds: ["s6"],
};

describe("isOverlayOnlyAiEditPreview", () => {
  it("routes shape/table inserts and overlay mutations to the overlay approval layer", () => {
    expect(isOverlayOnlyAiEditPreview(makePreview({
      operations: [insertOverlayShapeDraft, insertTableShapeDraft],
      mutationOperations: [updateOverlayShapeOp, alignOverlayShapesOp, deleteOverlayShapesOp],
    }))).toBe(true);
  });

  it("keeps body-only and mixed body/overlay proposals in the inline approval flow", () => {
    expect(isOverlayOnlyAiEditPreview(makePreview({ operations: [replaceDraft] }))).toBe(false);
    expect(isOverlayOnlyAiEditPreview(makePreview({
      operations: [replaceDraft, insertOverlayShapeDraft],
    }))).toBe(false);
    expect(isOverlayOnlyAiEditPreview(makePreview({
      operations: [insertOverlayShapeDraft],
      mutationOperations: [deleteBlocksOp],
    }))).toBe(false);
  });

  it("does not treat an empty proposal as an overlay proposal", () => {
    expect(isOverlayOnlyAiEditPreview(makePreview({}))).toBe(false);
  });

  it.each([
    ["insert_shape", { ...insertOverlayShapeDraft, targetId: "empty_prompt_anchor" } as AiEditDraft],
    ["insert_table", { ...insertTableShapeDraft, targetId: "empty_prompt_anchor" } as AiEditDraft],
    ["insert_graph", insertGraphShapeDraft],
  ])("keeps the real %s empty-area payload in the overlay layer", (_tool, insertDraft) => {
    const preview = makePreview({ operations: [emptyAreaOverlayAnchorDraft, insertDraft] });

    expect(isOverlayOnlyAiEditPreview(preview)).toBe(true);
    expect(hasOverlayAiEditChanges(preview)).toBe(true);
    expect(hasBodyAiEditChanges(preview)).toBe(false);
    expect(deriveAiEditPreviewDiff([preview]).removedBlockIds).toEqual(new Set());
    expect(derivePostApplyHighlightIds(preview).blockIds).toEqual([]);
  });

  it("splits a genuine mixed body and overlay proposal across both display layers", () => {
    const preview = makePreview({ operations: [replaceDraft, insertOverlayShapeDraft] });
    expect(hasOverlayAiEditChanges(preview)).toBe(true);
    expect(hasBodyAiEditChanges(preview)).toBe(true);
  });
});

describe("deriveAiEditPreviewDiff", () => {
  it("marks a replace op's target as removed", () => {
    const diff = deriveAiEditPreviewDiff([makePreview({ operations: [replaceDraft] })]);
    expect(diff.removedBlockIds).toEqual(new Set(["b1"]));
    expect(diff.removedShapeIds.size).toBe(0);
    expect(diff.modifiedShapeIds.size).toBe(0);
    expect(diff.addedShapes).toEqual([]);
  });

  it("treats a legacy replace draft (no `operation` field) the same as an explicit replace", () => {
    const diff = deriveAiEditPreviewDiff([makePreview({ operations: [legacyReplaceDraft] })]);
    expect(diff.removedBlockIds).toEqual(new Set(["b2"]));
  });

  it("does not mark an insertAfter op's target as removed", () => {
    const diff = deriveAiEditPreviewDiff([makePreview({ operations: [insertAfterDraft] })]);
    expect(diff.removedBlockIds.size).toBe(0);
    expect(diff.addedShapes).toEqual([]);
  });

  it("collects insertOverlayShape/insertTableShape drafts as addedShapes with their assets", () => {
    const diff = deriveAiEditPreviewDiff([
      makePreview({ operations: [insertOverlayShapeDraft, insertTableShapeDraft] }),
    ]);
    expect(diff.addedShapes).toEqual([
      { shape: { id: "s1", type: "rectShape" }, assets: { a1: { id: "a1" } } },
      { shape: { id: "s2", type: "tableShape" }, assets: {} },
    ]);
  });

  it("passes the draft shape's coordinates and anchor through untouched", () => {
    // プレビューが座標に触らないことが『提案位置=適用後位置』の前提。ここで
    // 補正を入れると、承認適用 (同じ draft を replay する) とずれる。
    const anchoredShape = {
      id: "s_anchored",
      type: "geo",
      x: 140,
      y: 2100,
      anchor: { type: "block", blockId: "b1", dx: 40, dy: 1800 },
    };
    const diff = deriveAiEditPreviewDiff([makePreview({
      operations: [{
        operation: "insertOverlayShape",
        summary: "図形挿入",
        targetId: "b1",
        overlayShape: anchoredShape,
        assets: {},
      } as unknown as AiEditDraft],
    })]);

    expect(diff.addedShapes[0].shape).toEqual(anchoredShape);
  });

  it("maps deleteBlocks/deleteOverlayShapes to removed ids, and updateOverlayShape/alignOverlayShapes to modified ids", () => {
    const diff = deriveAiEditPreviewDiff([
      makePreview({
        mutationOperations: [deleteBlocksOp, updateOverlayShapeOp, alignOverlayShapesOp, deleteOverlayShapesOp],
      }),
    ]);
    expect(diff.removedBlockIds).toEqual(new Set(["b4", "b5"]));
    expect(diff.removedShapeIds).toEqual(new Set(["s6"]));
    expect(diff.modifiedShapeIds).toEqual(new Set(["s3", "s4", "s5"]));
  });

  it("does not derive any diff treatment from moveBlocks (position-only change)", () => {
    const diff = deriveAiEditPreviewDiff([makePreview({ mutationOperations: [moveBlocksOp] })]);
    expect(diff.removedBlockIds.size).toBe(0);
    expect(diff.modifiedShapeIds.size).toBe(0);
  });

  it("merges diff sets across multiple preview groups", () => {
    const diff = deriveAiEditPreviewDiff([
      makePreview({ operations: [replaceDraft] }),
      makePreview({ mutationOperations: [deleteOverlayShapesOp] }),
    ]);
    expect(diff.removedBlockIds).toEqual(new Set(["b1"]));
    expect(diff.removedShapeIds).toEqual(new Set(["s6"]));
  });

  it("returns empty sets for an empty preview list", () => {
    const diff = deriveAiEditPreviewDiff([]);
    expect(diff.removedBlockIds.size).toBe(0);
    expect(diff.removedShapeIds.size).toBe(0);
    expect(diff.modifiedShapeIds.size).toBe(0);
    expect(diff.addedShapes).toEqual([]);
  });
});

describe("derivePendingAiProposalLockTargets", () => {
  it("does not reserve the text of a body insertion anchor or move destination", () => {
    const insertion = derivePendingAiProposalLockTargets([makePreview({ operations: [insertAfterDraft] })]);
    expect(insertion.blockIds.size).toBe(0);
    const move = derivePendingAiProposalLockTargets([makePreview({ operations: [], mutationOperations: [moveBlocksOp] })]);
    expect(move.blockIds).toEqual(new Set(moveBlocksOp.blockIds));
  });
  it("keeps existing body and overlay targets locked until the proposal is resolved", () => {
    const locks = derivePendingAiProposalLockTargets([
      makePreview({
        operations: [replaceDraft, insertAfterDraft],
        mutationOperations: [deleteBlocksOp, moveBlocksOp, updateOverlayShapeOp, alignOverlayShapesOp, deleteOverlayShapesOp],
      }),
    ]);

    expect(locks.blockIds).toEqual(new Set(["b1", "b4", "b5", "b6"]));
    expect(locks.shapeIds).toEqual(new Set(["s3", "s4", "s5", "s6"]));
  });

  it("does not lock a body anchor for a shape-only insert or its generated empty-area support draft", () => {
    const locks = derivePendingAiProposalLockTargets([
      makePreview({ operations: [emptyAreaOverlayAnchorDraft, insertGraphShapeDraft] }),
    ]);

    expect(locks.blockIds.size).toBe(0);
    expect(locks.shapeIds.size).toBe(0);
  });

  it("allows an explicitly editable web proposal target to change before its freshness check", () => {
    const locks = derivePendingAiProposalLockTargets([
      makePreview({ operations: [replaceDraft], lockTargets: false }),
    ]);

    expect(locks.blockIds.size).toBe(0);
    expect(locks.shapeIds.size).toBe(0);
  });
});

describe("derivePostApplyHighlightIds", () => {
  it("highlights an insertAfter draft's newly inserted block id", () => {
    const highlight = derivePostApplyHighlightIds(makePreview({ operations: [insertAfterDraft] }));
    expect(highlight.blockIds).toEqual(["b3"]);
    expect(highlight.shapeIds).toEqual([]);
  });

  it("highlights a replace draft's (unchanged) target id, since its content just changed in place", () => {
    const highlight = derivePostApplyHighlightIds(makePreview({ operations: [replaceDraft] }));
    expect(highlight.blockIds).toEqual(["b1"]);
  });

  it("highlights insertOverlayShape/insertTableShape drafts' new shape ids", () => {
    const highlight = derivePostApplyHighlightIds(
      makePreview({ operations: [insertOverlayShapeDraft, insertTableShapeDraft] }),
    );
    expect(highlight.shapeIds).toEqual(["s1", "s2"]);
  });

  it("highlights moveBlocks/updateOverlayShape/alignOverlayShapes ids but not deleteBlocks/deleteOverlayShapes", () => {
    const highlight = derivePostApplyHighlightIds(
      makePreview({
        mutationOperations: [moveBlocksOp, updateOverlayShapeOp, alignOverlayShapesOp, deleteBlocksOp, deleteOverlayShapesOp],
      }),
    );
    expect(highlight.blockIds).toEqual(["b6"]);
    expect(highlight.shapeIds).toEqual(["s3", "s4", "s5"]);
  });
});

describe("formatAiProposalProviderLabel", () => {
  const cases: Array<[DesktopMcpEditProposalProvider[], string]> = [
    [["claude"], "Claude"],
    [["chatgpt"], "ChatGPT"],
    [["antigravity"], "Antigravity"],
    [[], "AI"],
    [["claude", "chatgpt"], "AI"],
  ];

  it.each(cases)("maps %j to %s", (providers, expected) => {
    expect(formatAiProposalProviderLabel(providers)).toBe(expected);
  });
});

// --- Overlay-shape update/align previews ---

function rectShape(id: string, x: number, y: number, overrides: Partial<OverlayGeoShape> = {}): OverlayGeoShape {
  return {
    id,
    type: "geo",
    x,
    y,
    rotation: 0,
    props: {
      w: 180,
      h: 96,
      geo: "rectangle",
      fill: "none",
      color: "black",
      labelColor: "black",
      dash: "solid",
      size: "m",
    },
    ...overrides,
  } as OverlayGeoShape;
}

describe("deriveAiEditPreviewOverlayShapes", () => {
  it("returns inserted overlay shapes as the approval target", () => {
    const inserted = rectShape("inserted", 80, 120);
    const preview = makePreview({
      operations: [{
        operation: "insertOverlayShape",
        summary: "図形挿入",
        targetId: "b1",
        overlayShape: inserted,
        assets: {},
      }],
    });

    expect(deriveAiEditPreviewOverlayShapes(preview, [])).toEqual([inserted]);
  });

  it("uses the final sequential after-state for updates and alignment", () => {
    const s1 = rectShape("s1", 10, 0);
    const s2 = rectShape("s2", 20, 0);
    const preview = makePreview({
      mutationOperations: [
        { operation: "updateOverlayShape", summary: "移動", shapeId: "s1", patch: { x: 100 } },
        { operation: "alignOverlayShapes", summary: "左揃え", shapeIds: ["s1", "s2"], mode: "left" },
      ],
    });

    expect(deriveAiEditPreviewOverlayShapes(preview, [s1, s2]).map((shape) => ({ id: shape.id, x: shape.x })))
      .toEqual([{ id: "s1", x: 20 }, { id: "s2", x: 20 }]);
  });

  it("keeps a deleted shape's last visible state for widget placement", () => {
    const shape = rectShape("s1", 25, 40);
    const preview = makePreview({
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["s1"] }],
    });

    expect(deriveAiEditPreviewOverlayShapes(preview, [shape])).toEqual([shape]);
  });
});

function makeDocumentWithShapes(shapes: OverlayGeoShape[]): SigmaDocument {
  return {
    content: [],
    pageLayout: {
      overlay: {
        overlaySnapshot: {
          version: 1,
          shapes,
          assets: {},
        },
      },
    },
  } as unknown as SigmaDocument;
}

describe("resolveOverlayShapeAnchorBlockId", () => {
  it("returns the blockId for a shape directly anchored to a block", () => {
    const shape = rectShape("s1", 0, 0, { anchor: { type: "block", blockId: "b1", dy: 0 } });
    const document = makeDocumentWithShapes([shape]);
    expect(resolveOverlayShapeAnchorBlockId(document, "s1")).toBe("b1");
  });

  it("walks a chain of shape anchors to find the eventual block anchor", () => {
    const parent = rectShape("s1", 0, 0, { anchor: { type: "block", blockId: "b1", dy: 0 } });
    const child = rectShape("s2", 10, 10, { anchor: { type: "shape", shapeId: "s1", dx: 10, dy: 10 } });
    const document = makeDocumentWithShapes([parent, child]);
    expect(resolveOverlayShapeAnchorBlockId(document, "s2")).toBe("b1");
  });

  it("returns undefined when the shape is page-anchored", () => {
    const shape = rectShape("s1", 0, 0, { anchor: { type: "page" } });
    const document = makeDocumentWithShapes([shape]);
    expect(resolveOverlayShapeAnchorBlockId(document, "s1")).toBeUndefined();
  });

  it("returns undefined when the shape has no anchor", () => {
    const shape = rectShape("s1", 0, 0);
    const document = makeDocumentWithShapes([shape]);
    expect(resolveOverlayShapeAnchorBlockId(document, "s1")).toBeUndefined();
  });

  it("returns undefined when the shape doesn't exist", () => {
    const document = makeDocumentWithShapes([]);
    expect(resolveOverlayShapeAnchorBlockId(document, "missing")).toBeUndefined();
  });

  it("returns undefined instead of looping forever on a cyclic shape-anchor chain", () => {
    const a = rectShape("s1", 0, 0, { anchor: { type: "shape", shapeId: "s2", dx: 0, dy: 0 } });
    const b = rectShape("s2", 0, 0, { anchor: { type: "shape", shapeId: "s1", dx: 0, dy: 0 } });
    const document = makeDocumentWithShapes([a, b]);
    expect(resolveOverlayShapeAnchorBlockId(document, "s1")).toBeUndefined();
  });
});

describe("resolveMutationOpAssets", () => {
  const asset = (id: string, src: string): OverlayAsset => ({
    id,
    type: "image",
    props: { w: 1, h: 1, name: `${id}.png`, isAnimated: false, mimeType: "image/png", src, fileSize: 1 },
  });

  it("overlays the replacement assets an updateOverlayShape carries onto the current ones", () => {
    const current = { a: asset("a", "data:image/png;base64,OLD"), b: asset("b", "data:image/png;base64,KEEP") };
    const op: SigmaDocMutationOp = {
      operation: "updateOverlayShape",
      summary: "派生画像を差し替え",
      shapeId: "s1",
      patch: { props: {} },
      assets: { a: asset("a", "data:image/png;base64,NEW") },
    };

    const resolved = resolveMutationOpAssets(op, current);

    expect(resolved.a.props.src).toBe("data:image/png;base64,NEW");
    expect(resolved.b.props.src).toBe("data:image/png;base64,KEEP");
  });

  it("returns the current assets unchanged for an op that carries none", () => {
    const current = { a: asset("a", "data:image/png;base64,OLD") };
    const op: SigmaDocMutationOp = { operation: "updateOverlayShape", summary: "移動", shapeId: "s1", patch: { x: 1 } };

    expect(resolveMutationOpAssets(op, current)).toBe(current);
  });
});

describe("resolveMutationOpShapeResults", () => {
  it("computes the patched shape for updateOverlayShape, using the exact same merge as apply", () => {
    const shape = rectShape("s1", 10, 20, { props: { w: 180, h: 96, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m" } });
    const op: SigmaDocMutationOp = { operation: "updateOverlayShape", summary: "移動", shapeId: "s1", patch: { x: 99 } };

    const results = resolveMutationOpShapeResults(op, [shape]);

    expect(results).toHaveLength(1);
    expect(results![0]).toMatchObject({ id: "s1", x: 99, y: 20 });
  });

  it("preserves the shape's own id/type even if the patch tries to override them", () => {
    const shape = rectShape("s1", 10, 20);
    const op: SigmaDocMutationOp = {
      operation: "updateOverlayShape",
      summary: "改竄",
      shapeId: "s1",
      patch: { id: "hijacked", type: "text", x: 50 },
    };

    const results = resolveMutationOpShapeResults(op, [shape]);

    expect(results).toHaveLength(1);
    expect(results![0].id).toBe("s1");
    expect(results![0].type).toBe("geo");
    expect(results![0].x).toBe(50);
  });

  it("merges patch.props shallowly into the shape's existing props", () => {
    const shape = rectShape("s1", 0, 0, {
      props: { w: 180, h: 96, geo: "rectangle", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m", label: "元" },
    });
    const op: SigmaDocMutationOp = {
      operation: "updateOverlayShape",
      summary: "ラベル変更",
      shapeId: "s1",
      patch: { props: { label: "新" } },
    };

    const results = resolveMutationOpShapeResults(op, [shape]);

    expect(results![0].props).toMatchObject({ label: "新", w: 180, h: 96, color: "black" });
  });

  it("returns null when the shape id is missing from currentShapes", () => {
    const op: SigmaDocMutationOp = { operation: "updateOverlayShape", summary: "移動", shapeId: "missing", patch: { x: 1 } };
    expect(resolveMutationOpShapeResults(op, [rectShape("s1", 0, 0)])).toBeNull();
  });

  it("computes aligned shapes for alignOverlayShapes", () => {
    const s1 = rectShape("s1", 10, 0);
    const s2 = rectShape("s2", 30, 0);
    const op: SigmaDocMutationOp = { operation: "alignOverlayShapes", summary: "左揃え", shapeIds: ["s1", "s2"], mode: "left" };

    const results = resolveMutationOpShapeResults(op, [s1, s2]);

    expect(results).toHaveLength(2);
    expect(results!.map((s) => s.x)).toEqual([10, 10]);
  });

  it("returns null for alignOverlayShapes when any shape id is missing", () => {
    const op: SigmaDocMutationOp = { operation: "alignOverlayShapes", summary: "左揃え", shapeIds: ["s1", "missing"], mode: "left" };
    expect(resolveMutationOpShapeResults(op, [rectShape("s1", 0, 0)])).toBeNull();
  });

  it("returns null for a non-shape-visual op", () => {
    const op: SigmaDocMutationOp = { operation: "deleteBlocks", summary: "削除", blockIds: ["b1"] };
    expect(resolveMutationOpShapeResults(op, [rectShape("s1", 0, 0)])).toBeNull();
  });
});

describe("deriveAiEditPreviewShapeUpdates", () => {
  it("shows the revised asset and geometry for an image inserted earlier in the same draft", () => {
    const image: OverlayShape = { id: "svg_1", type: "image", x: 10, y: 20, rotation: 0, props: { assetId: "asset_1", w: 200, h: 100 } };
    const oldAsset: OverlayAsset = { id: "asset_1", type: "image", props: { w: 200, h: 100, name: "SVG", isAnimated: false, mimeType: "image/svg+xml", src: "OLD", fileSize: 3 } };
    const newAsset = { ...oldAsset, props: { ...oldAsset.props, src: "NEW" } };
    const preview = makePreview({
      operations: [{ operation: "insertOverlayShape", summary: "Insert", targetId: "p_1", overlayShape: image, assets: { asset_1: oldAsset } }],
      mutationOperations: [{ operation: "updateOverlayShape", summary: "Revise", shapeId: image.id, patch: { x: 40 }, assets: { asset_1: newAsset } }],
      operationOrder: [{ kind: "operation", index: 0 }, { kind: "mutation", index: 0 }],
    });
    expect(deriveAiEditPreviewDiff([preview]).addedShapes).toEqual([{ shape: { ...image, x: 40 }, assets: { asset_1: newAsset } }]);
    expect(oldAsset.props.src).toBe("OLD");
    expect(image.x).toBe(10);
    preview.draft.mutationOperations!.push({ operation: "deleteOverlayShapes", summary: "Remove", shapeIds: [image.id] });
    preview.draft.operationOrder!.push({ kind: "mutation", index: 1 });
    expect(deriveAiEditPreviewDiff([preview]).addedShapes).toEqual([]);
  });

  it("derives after-states for update and align ops across previews", () => {
    const s1 = rectShape("s1", 10, 0);
    const s2 = rectShape("s2", 30, 0);
    const updatePreview = makePreview({
      mutationOperations: [{ operation: "updateOverlayShape", summary: "移動", shapeId: "s1", patch: { y: 50 } }],
    });

    const updates = deriveAiEditPreviewShapeUpdates([updatePreview], [s1, s2]);

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ shapeId: "s1", after: { id: "s1", x: 10, y: 50 } });
  });

  it("keeps carrying a replacement asset when a later op touches the same shape again", () => {
    const shape = rectShape("s1", 0, 0);
    const replacement: OverlayAsset = {
      id: "asset_1",
      type: "image",
      props: { w: 1, h: 1, name: "a.png", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,NEW", fileSize: 1 },
    };
    const preview = makePreview({
      mutationOperations: [
        {
          operation: "updateOverlayShape",
          summary: "図を描き直して絵も差し替え",
          shapeId: "s1",
          patch: { props: {} },
          assets: { asset_1: replacement },
        },
        // 絵を運ばない後続の操作 (サイズだけの更新・整列)。呼び出し側は shapeId で
        // 最後の1件へ畳むので、ここで落とすと「新しい図形に古い絵」に逆戻りする。
        { operation: "updateOverlayShape", summary: "大きさだけ変更", shapeId: "s1", patch: { props: { w: 400 } } },
      ],
    });

    const updates = deriveAiEditPreviewShapeUpdates([preview], [shape]);

    expect(updates).toHaveLength(2);
    expect(updates[1].replacedAssets).toEqual({ asset_1: replacement });
  });

  it("carries the replacement assets of an update so the after-state is not drawn with the stored picture", () => {
    const shape = rectShape("s1", 0, 0);
    const replacement: OverlayAsset = {
      id: "asset_1",
      type: "image",
      props: { w: 1, h: 1, name: "a.png", isAnimated: false, mimeType: "image/png", src: "data:image/png;base64,NEW", fileSize: 1 },
    };
    const preview = makePreview({
      mutationOperations: [{
        operation: "updateOverlayShape",
        summary: "派生画像を差し替え",
        shapeId: "s1",
        patch: { props: {} },
        assets: { asset_1: replacement },
      }],
    });

    const updates = deriveAiEditPreviewShapeUpdates([preview], [shape]);

    expect(updates[0].replacedAssets).toEqual({ asset_1: replacement });
  });

  it("threads results sequentially: a later op sees an earlier op's after-state", () => {
    const s1 = rectShape("s1", 10, 0);
    const s2 = rectShape("s2", 20, 0);
    const preview = makePreview({
      mutationOperations: [
        { operation: "updateOverlayShape", summary: "移動", shapeId: "s1", patch: { x: 100 } },
        { operation: "alignOverlayShapes", summary: "左揃え", shapeIds: ["s1", "s2"], mode: "left" },
      ],
    });

    const updates = deriveAiEditPreviewShapeUpdates([preview], [s1, s2]);

    expect(updates).toHaveLength(3); // 1 from the update op + 2 (s1, s2) from the align op
    // If the align op only saw the ORIGINAL s1.x (10, before the update op ran), the min (and
    // thus both aligned shapes' x) would be 10, not 20.
    const [, alignS1, alignS2] = updates;
    expect(alignS1).toMatchObject({ shapeId: "s1", after: { x: 20 } });
    expect(alignS2).toMatchObject({ shapeId: "s2", after: { x: 20 } });
  });

  it("skips ops whose shape id is missing from currentShapes", () => {
    const preview = makePreview({
      mutationOperations: [{ operation: "updateOverlayShape", summary: "移動", shapeId: "missing", patch: { x: 1 } }],
    });

    expect(deriveAiEditPreviewShapeUpdates([preview], [rectShape("s1", 0, 0)])).toEqual([]);
  });

  it("ignores non-shape mutation ops and returns an empty list when there are none", () => {
    const preview = makePreview({ mutationOperations: [deleteBlocksOp, moveBlocksOp] });
    expect(deriveAiEditPreviewShapeUpdates([preview], [rectShape("s1", 0, 0)])).toEqual([]);
  });
});

function ellipseShape(id: string): OverlayGeoShape {
  return rectShape(id, 0, 0, {
    props: {
      w: 96, h: 96, geo: "ellipse", fill: "none", color: "black", labelColor: "black", dash: "solid", size: "m",
    },
  } as Partial<OverlayGeoShape>);
}

function fixtureTableShape(id: string, rowCount: number, columnCount: number): OverlayTableShape {
  return {
    id,
    type: "tableShape",
    x: 0,
    y: 0,
    rotation: 0,
    props: {
      w: 400,
      h: 200,
      table: {
        rows: Array.from({ length: rowCount }, (_, index) => ({ id: `row_${index}` })),
        columns: Array.from({ length: columnCount }, (_, index) => ({ id: `col_${index}` })),
        cells: [],
      },
    },
  } as unknown as OverlayTableShape;
}

describe("summarizeAiEditPreviewChanges", () => {
  it("summarizes a table insert with its dimensions instead of a count", () => {
    const preview = makePreview({
      operations: [{
        operation: "insertTableShape", summary: "表を追加", targetId: "b1", tableShape: fixtureTableShape("t1", 3, 4),
      }],
    });

    expect(summarizeAiEditPreviewChanges(preview)).toEqual(["表(3×4)を挿入"]);
  });

  it("summarizes a single non-table shape insert as an addition", () => {
    const preview = makePreview({
      operations: [{
        operation: "insertOverlayShape", summary: "円を追加", targetId: "b1", overlayShape: ellipseShape("c1"), assets: {},
      }],
    });

    expect(summarizeAiEditPreviewChanges(preview)).toEqual(["円を追加"]);
  });

  it("collapses updates across differently-shaped ids into a generic count", () => {
    const preview = makePreview({
      mutationOperations: [
        { operation: "updateOverlayShape", summary: "移動", shapeId: "rect1", patch: { x: 1 } },
        { operation: "updateOverlayShape", summary: "移動", shapeId: "ellipse1", patch: { x: 2 } },
      ],
    });
    const currentShapes = [rectShape("rect1", 0, 0), ellipseShape("ellipse1")];

    expect(summarizeAiEditPreviewChanges(preview, currentShapes)).toEqual(["図形を2件更新"]);
  });

  it("keeps the specific noun when every updated shape shares the same kind", () => {
    const preview = makePreview({
      mutationOperations: [
        { operation: "updateOverlayShape", summary: "移動", shapeId: "c1", patch: { x: 1 } },
        { operation: "updateOverlayShape", summary: "移動", shapeId: "c2", patch: { x: 2 } },
      ],
    });
    const currentShapes = [ellipseShape("c1"), ellipseShape("c2")];

    expect(summarizeAiEditPreviewChanges(preview, currentShapes)).toEqual(["円を2件更新"]);
  });

  it("names a deleted shape using currentShapes when available", () => {
    const graphShape = { id: "g1", type: "graph2dShape", x: 0, y: 0, rotation: 0, props: {} } as unknown as OverlayGeoShape;
    const preview = makePreview({
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g1"] }],
    });

    expect(summarizeAiEditPreviewChanges(preview, [graphShape])).toEqual(["グラフを削除"]);
  });

  it("falls back to the generic noun when a mutation op's shape can't be resolved", () => {
    const preview = makePreview({
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["missing"] }],
    });

    expect(summarizeAiEditPreviewChanges(preview, [])).toEqual(["図形を削除"]);
  });

  it("excludes a replacement pair's added/removed shapes from the plain insert/delete counts", () => {
    const oldShape = rectShape("old1", 0, 0);
    const newShape = ellipseShape("new1");
    const preview = {
      ...makePreview({
        operations: [{
          operation: "insertOverlayShape", summary: "置き換え", targetId: "b1", overlayShape: newShape, assets: {},
        }],
        mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["old1"] }],
      }),
      shapeReplacements: [{ removedShapeId: "old1", addedShapeId: "new1" }],
    } as AiEditPreviewState;

    expect(summarizeAiEditPreviewChanges(preview, [oldShape])).toEqual(["円を置き換え"]);
  });

  it("summarizes multiple distinct changes as separate lines, in a stable order", () => {
    const preview = makePreview({
      operations: [{
        operation: "insertTableShape", summary: "表を追加", targetId: "b1", tableShape: fixtureTableShape("t1", 2, 2),
      }],
      mutationOperations: [{ operation: "deleteOverlayShapes", summary: "削除", shapeIds: ["g1"] }],
    });
    const graphShape = { id: "g1", type: "graph2dShape", x: 0, y: 0, rotation: 0, props: {} } as unknown as OverlayGeoShape;

    expect(summarizeAiEditPreviewChanges(preview, [graphShape])).toEqual(["表(2×2)を挿入", "グラフを削除"]);
  });

  it("adds a one-line body summary for a plain replace draft", () => {
    expect(summarizeAiEditPreviewChanges(makePreview({ operations: [replaceDraft] }))).toEqual(["本文を更新"]);
  });

  it("adds a one-line body summary for an insertAfter draft", () => {
    expect(summarizeAiEditPreviewChanges(makePreview({ operations: [insertAfterDraft] }))).toEqual(["本文を追加"]);
  });


  it("uses neutral fallback summary 'AIの編集案' when no user summary is provided", () => {
    // When no user-provided summary is available, the fallback should be provider-agnostic
    const proposals = [
      makeProposal({
        proposalId: "p1",
        fileId: "f1",
        targetId: "b1",
        summary: "", // empty summary triggers fallback
        provider: "claude",
      }),
    ];

    const { groups } = groupMcpProposalsForPreview(proposals, "f1", 1);

    // Verify the grouped result uses neutral fallback wording
    expect(groups.length).toBeGreaterThan(0);
    const firstGroup = groups[0];
    const summary = firstGroup.draft.summary;

    // Should be neutral "AIの編集案", NOT provider-specific like "Claudeの編集案"
    expect(summary).toBe("AIの編集案");
    expect(summary).not.toContain("Claude");
    expect(summary).not.toContain("ChatGPT");
    expect(summary).not.toContain("Antigravity");
  });

});

describe("overlayShapeNoun", () => {
  it("never leaks a raw dictionary key for any shape kind", () => {
    // 呼び名の辞書は**複数形つき** (`_one` / `_other`)。`count` を渡し忘れると
    // i18next はどちらの形も選べず、生キー (`change.noun.table`) が画面に出る。
    // ここは「id を足した」ではなく「引き方を間違えた」を捕まえる網。
    const shapes: Array<OverlayShape | undefined> = [
      undefined,
      { id: "s1", type: "geo", props: { geo: "rectangle" } } as unknown as OverlayShape,
      { id: "s2", type: "graph2dShape", props: {} } as unknown as OverlayShape,
      { id: "s3", type: "tableShape", props: {} } as unknown as OverlayShape,
      { id: "s4", type: "text", props: {} } as unknown as OverlayShape,
      { id: "s5", type: "line", props: { kind: "freehand" } } as unknown as OverlayShape,
    ];
    for (const shape of shapes) {
      const noun = overlayShapeNoun(shape);
      expect(noun, `${shape?.type ?? "undefined"}`).not.toContain("change.noun");
      expect(noun.length).toBeGreaterThan(0);
      expect(AI_EDIT_CHANGE_NOUN_IDS).toContain(overlayShapeNounId(shape));
    }
  });
});
