import { describe, expect, it, vi } from "vitest";

import {
  aiActiveRunBlockedMessage,
  aiDocumentWriteInProgressMessage,
  aiPendingProposalBlockedMessage,
  buildAiTextFlowEditPolicy,
  type AiEditLockInfo,
} from "./edit-lock-adapter";

describe("buildAiTextFlowEditPolicy", () => {
  it("keeps a fragment editable outside its range until a pending replacement owns the whole block", () => {
    const live: AiEditLockInfo = {
      blockId: "p", runId: "r", sessionLabel: null, isPrimaryAnchor: true,
      blockLockText: "前対象後", blockShimmerScopes: [{ kind: "text", blockId: "p", from: 1, to: 3 }],
    };
    const input = { liveLocks: [live], pendingBlockIds: [], onRequestStop: async () => ({ ok: true }) };
    expect(buildAiTextFlowEditPolicy(input).guards[0].contentReservations).toEqual([
      { baselineText: "前対象後", ranges: [{ from: 1, to: 3 }], inlineMathIds: [] },
    ]);
    expect(buildAiTextFlowEditPolicy({ ...input, pendingBlockIds: ["p"] }).guards[0].contentReservations).toBeUndefined();
  });

  it("unions multiple run reservations instead of dropping the earlier run", () => {
    const live: AiEditLockInfo = {
      blockId: "p", runId: "r1", sessionLabel: null, isPrimaryAnchor: true,
      blockLockText: "前対象後", blockShimmerScopes: [{ kind: "text", blockId: "p", from: 0, to: 1 }],
    };
    const policy = buildAiTextFlowEditPolicy({
      liveLocks: [live, { ...live, runId: "r2", blockShimmerScopes: [{ kind: "text", blockId: "p", from: 3, to: 4 }] }],
      pendingBlockIds: [], onRequestStop: async () => ({ ok: true }),
    });
    expect(policy.guards[0].contentReservations).toHaveLength(2);
  });
  it("keeps exact live-run ranges and reserves pending blocks without locking the document", async () => {
    const liveLock: AiEditLockInfo = {
      blockId: "body-1",
      runId: "run-1",
      sessionLabel: "解説を修正",
      isPrimaryAnchor: true,
      blockShimmerScopes: [
        { kind: "text", blockId: "body-1", from: 2, to: 5 },
        { kind: "inlineMath", blockId: "body-1", mathInlineId: "math-1" },
      ],
    };
    const onRequestStop = vi.fn(async () => ({ ok: true }));

    const policy = buildAiTextFlowEditPolicy({
      liveLocks: [liveLock],
      pendingBlockIds: ["body-1", "body-2"],
      onRequestStop,
    });

    expect(policy.guards).toHaveLength(2);
    expect(policy.guards[0]).toMatchObject({
      blockId: "body-1",
      guardId: "run-1",
      isPrimaryActionTarget: true,
      blockedMessage: aiActiveRunBlockedMessage(),
      highlight: true,
      highlightScopes: liveLock.blockShimmerScopes,
      action: {
        label: "AIを停止して編集",
        busyLabel: "停止しています…",
        title: "AIを停止して編集(解説を修正)",
      },
    });
    expect(policy.guards[1]).toMatchObject({
      blockId: "body-2",
      guardId: "ai-pending-body-2",
      blockedMessage: aiPendingProposalBlockedMessage(),
      highlight: false,
    });
    expect(policy.guards[1].action).toBeUndefined();
    // A live run owns its own anchor, never the rest of the document.
    expect(policy.lockAll).toBeUndefined();

    await policy.guards[0].action?.request();
    expect(onRequestStop).toHaveBeenCalledWith(liveLock);
  });

  it("keeps an empty explicit shimmer scope lock-only and omits lockAll outside the write window", () => {
    const policy = buildAiTextFlowEditPolicy({
      liveLocks: [{
        blockId: "body-1",
        runId: "run-1",
        sessionLabel: null,
        isPrimaryAnchor: false,
        blockShimmerScopes: [],
      }],
      pendingBlockIds: [],
      onRequestStop: async () => ({ ok: true }),
    });

    expect(policy.guards[0]).toMatchObject({
      blockId: "body-1",
      highlight: false,
      highlightScopes: [],
      action: { title: "AIを停止して編集" },
    });
    expect(policy.lockAll).toBeUndefined();
  });

  it("locks the whole document only while an approval write is replacing it", () => {
    const policy = buildAiTextFlowEditPolicy({
      liveLocks: [],
      pendingBlockIds: [],
      documentWriteInProgress: true,
      onRequestStop: async () => ({ ok: true }),
    });

    expect(policy.lockAll).toMatchObject({
      guardId: "ai-document-write-in-progress",
      blockedMessage: aiDocumentWriteInProgressMessage(),
      highlight: false,
    });
  });

  it("reserves only the pending proposal's own blocks while awaiting a decision", () => {
    const policy = buildAiTextFlowEditPolicy({
      liveLocks: [],
      pendingBlockIds: ["body-7"],
      onRequestStop: async () => ({ ok: true }),
    });

    expect(policy.lockAll).toBeUndefined();
    expect(policy.guards).toHaveLength(1);
    expect(policy.guards[0]).toMatchObject({
      blockId: "body-7",
      blockedMessage: aiPendingProposalBlockedMessage(),
    });
  });
});
