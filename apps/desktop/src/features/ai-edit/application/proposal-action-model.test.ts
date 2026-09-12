import { describe, expect, it } from "vitest";

import type {
  AiEditPreviewState,
  StaleMcpProposalGroup,
} from "../model/preview";
import {
  buildAiProposalApplyContext,
  deriveAiProposalApprovedFileFeedback,
  deriveAiProposalApplyDecision,
  deriveAiProposalBusyGuardFeedback,
  deriveAiProposalDismissEffects,
  deriveAiProposalResolutionTargets,
  deriveAiStaleProposalDiscardEffects,
  normalizeAiProposalIds,
  sameProposalIdSet,
  selectPrimaryAiProposalIdForRevert,
  selectSequentialAiRevertProposalIds,
} from "./proposal-action-model";
import { aiDocumentWriteInProgressMessage } from "../adapters/tiptap/edit-lock-adapter";

function previewGroup(
  proposalIds: string[],
  options: { roomId?: string; turnId?: string; summary?: string } = {},
): AiEditPreviewState {
  return {
    targetId: proposalIds[0] ?? "",
    draft: {
      summary: options.summary ?? proposalIds.join(","),
      plan: [],
      operations: [],
      warnings: [],
    },
    createdAt: 0,
    proposalIds,
    baseRevision: 1,
    providers: [],
    roomId: options.roomId,
    turnId: options.turnId,
  };
}

function staleGroup(
  proposalIds: string[],
  roomId?: string,
  turnId?: string,
): StaleMcpProposalGroup {
  return {
    baseRevision: 1,
    currentRevision: 2,
    proposalIds,
    providers: [],
    summary: proposalIds.join(","),
    createdAt: 0,
    roomId,
    turnId,
    kind: "manual-rebase",
  };
}

describe("sameProposalIdSet", () => {
  it("matches the same proposal IDs regardless of order", () => {
    expect(sameProposalIdSet(["proposal-1", "proposal-2"], ["proposal-2", "proposal-1"])).toBe(true);
  });

  it("rejects different lengths and different members", () => {
    expect(sameProposalIdSet(["proposal-1"], ["proposal-1", "proposal-2"])).toBe(false);
    expect(sameProposalIdSet(["proposal-1", "proposal-2"], ["proposal-1", "proposal-3"])).toBe(false);
  });

  it("matches two empty collections", () => {
    expect(sameProposalIdSet([], [])).toBe(true);
  });

  it("preserves the historical same-length/member-set behavior for duplicate input", () => {
    expect(sameProposalIdSet(
      ["proposal-1", "proposal-2", "proposal-2"],
      ["proposal-1", "proposal-1", "proposal-2"],
    )).toBe(true);
  });
});

describe("AI proposal apply decisions", () => {
  it("turns the busy guard into visible status feedback instead of a silent no-op", () => {
    // 通知は関数の中で必ず起きる。呼び出し側が status 更新を書き忘れても
    // 「押したのに何も起きない」へ戻れないことが、この関数の存在理由。
    const notified: string[] = [];
    expect(deriveAiProposalBusyGuardFeedback(
      true,
      aiDocumentWriteInProgressMessage(),
      (message) => notified.push(message),
    )).toEqual({
      statusMessage: aiDocumentWriteInProgressMessage(),
      outcome: { ok: false, reason: "他の操作が進行中です" },
    });
    expect(notified).toEqual([aiDocumentWriteInProgressMessage()]);

    // 実行中でなければ通知もせず、呼び出し側は通常処理へ進む。
    expect(deriveAiProposalBusyGuardFeedback(
      false,
      aiDocumentWriteInProgressMessage(),
      (message) => notified.push(message),
    )).toBeNull();
    expect(notified).toEqual([aiDocumentWriteInProgressMessage()]);
  });

  it("does not paint a cross-file approval and reports the affected教材 by name", () => {
    expect(deriveAiProposalApprovedFileFeedback({
      approvedFileId: "file-other",
      currentFileId: "file-active",
      approvedDocumentTitle: "三角関数",
      activeDocumentStatusMessage: "編集案を適用しました",
    })).toEqual({
      kind: "report-other-document",
      statusMessage: "別の教材『三角関数』にAI編集を適用しました",
    });

    expect(deriveAiProposalApprovedFileFeedback({
      approvedFileId: "file-active",
      currentFileId: "file-active",
      approvedDocumentTitle: "三角関数",
      activeDocumentStatusMessage: "編集案を適用しました",
    })).toEqual({
      kind: "paint-active-document",
      statusMessage: "編集案を適用しました",
    });
  });

  it("captures the exact preview group and every fully requested resolution group", () => {
    const exact = previewGroup(["proposal-1", "proposal-2"], {
      roomId: "room-current",
      turnId: "turn-current",
    });
    const unrelated = previewGroup(["proposal-3"], { roomId: "room-unrelated" });
    const stale = staleGroup(["proposal-stale"], "room-stale", "turn-stale");

    const context = buildAiProposalApplyContext(
      ["proposal-2", "proposal-1", "proposal-stale"],
      [exact, unrelated],
      [stale],
    );

    expect(context.previewGroup).toBeUndefined();
    expect(context.requestedGroups).toEqual([exact, stale]);

    const exactOnly = buildAiProposalApplyContext(
      ["proposal-2", "proposal-1"],
      [exact],
      [],
    );
    expect(exactOnly.previewGroup).toBe(exact);
  });

  it("keeps partially failed groups unresolved and reports only actually applied IDs", () => {
    const first = previewGroup(["proposal-1"], {
      roomId: "room-1",
      turnId: "turn-1",
    });
    const second = previewGroup(["proposal-2"], {
      roomId: "room-2",
      turnId: "turn-2",
    });
    const context = buildAiProposalApplyContext(
      ["proposal-1", "proposal-2"],
      [first, second],
      [],
    );

    const decision = deriveAiProposalApplyDecision(
      ["proposal-1", "proposal-2"],
      [{ proposalId: "proposal-2", error: "競合" }],
      context,
    );

    expect(decision.appliedProposalIds).toEqual(["proposal-1"]);
    expect(decision.failedProposalIds).toEqual(new Set(["proposal-2"]));
    expect(decision.resolvedTargets).toEqual([
      { roomId: "room-1", turnId: "turn-1" },
    ]);
    expect(decision.shouldUseLegacyResolutionFallback).toBe(false);
    expect(decision.statusMessage).toBe(
      "一部の編集案を適用できませんでした (1件): 競合",
    );
    expect(decision.outcome).toEqual({
      ok: false,
      reason: "一部の編集案を適用できませんでした (1件): 競合",
    });
  });

  it("clears explicit targets only after full success and preserves legacy fallback rules", () => {
    const explicitTargets = [{ roomId: "room-1", turnId: "turn-1" }];
    const emptyContext = buildAiProposalApplyContext(
      ["legacy"],
      [],
      [],
    );

    const successful = deriveAiProposalApplyDecision(
      ["legacy"],
      [],
      emptyContext,
      { force: true, resolutionTargets: explicitTargets },
    );
    expect(successful.resolvedTargets).toBe(explicitTargets);
    expect(successful.shouldUseLegacyResolutionFallback).toBe(false);
    expect(successful.statusMessage).toBe(
      "AIの提案を優先して上書きしました",
    );
    expect(successful.outcome).toEqual({ ok: true });

    const failed = deriveAiProposalApplyDecision(
      ["legacy"],
      [{ proposalId: "legacy", error: "失敗" }],
      emptyContext,
      { resolutionTargets: explicitTargets },
    );
    expect(failed.resolvedTargets).toEqual([]);
    expect(failed.shouldUseLegacyResolutionFallback).toBe(false);

    const fallbackDisabled = deriveAiProposalApplyDecision(
      ["legacy"],
      [],
      emptyContext,
      { disableLegacyResolutionFallback: true },
    );
    expect(fallbackDisabled.shouldUseLegacyResolutionFallback).toBe(false);
  });
});

describe("AI proposal rejection effects", () => {
  it("fixes normal dismiss side effects to status, clear, then feedback", () => {
    const effects = deriveAiProposalDismissEffects(
      previewGroup(["proposal-1"], {
        roomId: "room-1",
        turnId: "turn-1",
        summary: "本文を修正",
      }),
      { rejectedCount: 1, failedCount: 0 },
      "  意図と違う  ",
    );

    expect(effects).toEqual([
      { type: "status", message: "AI編集案を閉じました" },
      {
        type: "clearPreview",
        outcome: "dismissed",
        targets: [{ roomId: "room-1", turnId: "turn-1" }],
      },
      {
        type: "submitFeedback",
        roomId: "room-1",
        turnId: "turn-1",
        reason: "意図と違う",
        proposalSummaries: ["本文を修正"],
      },
    ]);
  });

  it("does not clear or submit feedback after a partial rejection failure", () => {
    expect(deriveAiProposalDismissEffects(
      previewGroup(["proposal-1"], { roomId: "room-1" }),
      { rejectedCount: 1, failedCount: 1 },
      "理由",
    )).toEqual([{
      type: "status",
      message: "一部の編集案を閉じられませんでした",
    }]);
    expect(deriveAiProposalDismissEffects(
      previewGroup(["proposal-1"], { roomId: "room-1" }),
      "busy",
      "理由",
    )).toEqual([]);
  });

  it("fixes stale discard side effects to status then targeted clear", () => {
    expect(deriveAiStaleProposalDiscardEffects(
      staleGroup(["proposal-1"], "room-1", "turn-1"),
      { rejectedCount: 1, failedCount: 0 },
    )).toEqual([
      { type: "status", message: "編集案を破棄しました" },
      {
        type: "clearPreview",
        outcome: "dismissed",
        targets: [{ roomId: "room-1", turnId: "turn-1" }],
      },
    ]);
    expect(deriveAiStaleProposalDiscardEffects(
      staleGroup(["proposal-1"], "room-1", "turn-1"),
      { rejectedCount: 0, failedCount: 1 },
    )).toEqual([{
      type: "status",
      message: "編集案を破棄できませんでした",
    }]);
  });
});

describe("AI proposal history decisions", () => {
  it("normalizes IDs without reordering and deduplicates resolution targets", () => {
    expect(normalizeAiProposalIds([
      "proposal-2",
      "",
      "proposal-1",
      "proposal-2",
    ])).toEqual(["proposal-2", "proposal-1"]);

    expect(deriveAiProposalResolutionTargets([
      {
        proposalId: "proposal-1",
        roomId: "room-1",
        turnId: "turn-1",
      },
      {
        proposalId: "proposal-2",
        roomId: "room-1",
        turnId: "turn-1",
      },
      {
        proposalId: "proposal-3",
        roomId: "room-3",
        turnId: "turn-3",
      },
    ], ["proposal-1", "proposal-2"])).toEqual([
      { roomId: "room-1", turnId: "turn-1" },
    ]);
  });

  it("prefers an approved proposal at the active revision for revert", () => {
    const proposals = [
      {
        proposalId: "proposal-1",
        status: "approved" as const,
        appliedRevision: 4,
      },
      {
        proposalId: "proposal-2",
        status: "approved" as const,
        appliedRevision: 5,
      },
      {
        proposalId: "proposal-3",
        status: "rejected" as const,
        appliedRevision: 5,
      },
    ];

    expect(selectPrimaryAiProposalIdForRevert(
      proposals,
      ["proposal-1", "proposal-2", "proposal-3"],
      5,
    )).toBe("proposal-2");
    expect(selectPrimaryAiProposalIdForRevert(
      proposals,
      ["proposal-1", "proposal-2"],
      99,
    )).toBe("proposal-1");
    expect(selectPrimaryAiProposalIdForRevert(
      [],
      ["legacy-proposal"],
      5,
    )).toBe("legacy-proposal");
  });
});

describe("selectSequentialAiRevertProposalIds", () => {
  it("returns one entry point per shared save revision, newest batch first", () => {
    const proposals = [
      { proposalId: "old-a", status: "approved" as const, appliedRevision: 4 },
      { proposalId: "old-b", status: "approved" as const, appliedRevision: 4 },
      { proposalId: "new-a", status: "approved" as const, appliedRevision: 7 },
    ];

    expect(selectSequentialAiRevertProposalIds(
      proposals,
      ["old-a", "old-b", "new-a"],
      7,
    )).toEqual(["new-a", "old-a"]);
  });

  it("skips proposals that are no longer approved or never recorded a revision", () => {
    const proposals = [
      { proposalId: "reverted", status: "reverted" as const, appliedRevision: 9 },
      { proposalId: "legacy", status: "approved" as const, appliedRevision: undefined },
      { proposalId: "live", status: "approved" as const, appliedRevision: 5 },
    ];

    expect(selectSequentialAiRevertProposalIds(
      proposals,
      ["reverted", "legacy", "live"],
      5,
    )).toEqual(["live"]);
  });

  it("still hands main a single id when nothing revertable is known, so it can answer why", () => {
    expect(selectSequentialAiRevertProposalIds(
      [{ proposalId: "legacy", status: "approved" as const, appliedRevision: undefined }],
      ["legacy"],
      5,
    )).toEqual(["legacy"]);
    expect(selectSequentialAiRevertProposalIds([], ["unknown"], 5)).toEqual(["unknown"]);
    expect(selectSequentialAiRevertProposalIds([], [], 5)).toEqual([]);
  });
});
