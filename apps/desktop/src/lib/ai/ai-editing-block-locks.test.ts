import { describe, expect, it } from "vitest";

import { AI_EDIT_BLOCK_LOCK_TTL_MS, deriveAiEditingBlockLocks, deriveAiEditingLocks } from "@/lib/ai/ai-editing-block-locks";
import type { AiRunAnchor, AiRunSession } from "@/lib/ai/ai-run-session-store";

function anchor(
  primaryBlockId: string | null,
  blockIds: string[] = primaryBlockId ? [primaryBlockId] : [],
  shapeIds: string[] = [],
): AiRunAnchor {
  return { primaryBlockId, blockIds, shapeIds, documentId: "doc-1" };
}

function makeSession(overrides: Partial<AiRunSession> & { roomId: string }): AiRunSession {
  return {
    runId: null,
    provider: null,
    status: "idle",
    events: [],
    streamText: "",
    planSteps: [],
    error: null,
    startedAt: null,
    endedAt: null,
    anchor: null,
    queuedMessages: [],
    ...overrides,
  };
}

describe("deriveAiEditingBlockLocks", () => {
  it("locks the anchor block of a running session", () => {
    const now = 1_000_000;
    const sessions = new Map([
      [
        "room-1",
        makeSession({
          roomId: "room-1",
          status: "running",
          runId: "turn-1",
          startedAt: now - 1000,
          anchor: anchor("block-1"),
        }),
      ],
    ]);

    const locks = deriveAiEditingBlockLocks(sessions, now);

    expect(locks).toEqual([
      {
        documentId: "doc-1",
        blockId: "block-1",
        provider: null,
        runId: "turn-1",
        roomId: "room-1",
        lockedAt: now - 1000,
        isPrimaryAnchor: true,
      },
    ]);
  });

  // Submitted-but-not-yet-started runs reserve their target too: with no
  // document-wide lock left, a target left editable while the run sits in the
  // FIFO queue would have the AI act on content the instruction no longer matches.
  it.each(["preparing", "waiting"] as const)("locks the anchor block of a %s session", (status) => {
    const now = 1_000_000;
    const sessions = new Map([
      [
        "room-1",
        makeSession({
          roomId: "room-1",
          status,
          runId: "turn-1",
          startedAt: now,
          anchor: anchor("block-1"),
        }),
      ],
    ]);

    expect(deriveAiEditingBlockLocks(sessions, now)).toMatchObject([{ blockId: "block-1", runId: "turn-1" }]);
  });

  it("does not lock completed/failed sessions", () => {
    const now = 1_000_000;
    const runAnchor = anchor("block-1");
    const sessions = new Map([
      ["room-completed", makeSession({ roomId: "room-completed", status: "completed", runId: null, startedAt: now, anchor: runAnchor })],
      ["room-failed", makeSession({ roomId: "room-failed", status: "failed", runId: null, startedAt: now, anchor: runAnchor })],
    ]);

    expect(deriveAiEditingBlockLocks(sessions, now)).toEqual([]);
  });

  it("ignores a running session with no anchor block (untargeted run)", () => {
    const now = 1_000_000;
    const sessions = new Map([
      ["room-1", makeSession({ roomId: "room-1", status: "running", runId: "t1", startedAt: now, anchor: anchor(null) })],
    ]);

    expect(deriveAiEditingBlockLocks(sessions, now)).toEqual([]);
  });

  it("expires a lock once the TTL backstop has elapsed, even if the session is still reported as running", () => {
    const startedAt = 0;
    const runAnchor = anchor("block-1");
    const sessions = new Map([
      ["room-1", makeSession({ roomId: "room-1", status: "running", runId: "t1", startedAt, anchor: runAnchor })],
    ]);

    expect(deriveAiEditingBlockLocks(sessions, AI_EDIT_BLOCK_LOCK_TTL_MS - 1)).toHaveLength(1);
    expect(deriveAiEditingBlockLocks(sessions, AI_EDIT_BLOCK_LOCK_TTL_MS)).toEqual([]);
  });

  it("locks multiple independent rooms' anchor blocks at once", () => {
    const now = 1_000_000;
    const sessions = new Map([
      ["room-1", makeSession({ roomId: "room-1", status: "running", runId: "t1", startedAt: now, anchor: anchor("block-1") })],
      ["room-2", makeSession({ roomId: "room-2", status: "running", runId: "t2", startedAt: now, anchor: anchor("block-2") })],
    ]);

    const locks = deriveAiEditingBlockLocks(sessions, now);
    expect(locks.map((lock) => lock.blockId).sort()).toEqual(["block-1", "block-2"]);
  });

  it("does not lock the placement block when a run targets only overlay shapes", () => {
    const now = 1_000_000;
    const sessions = new Map([
      [
        "room-1",
        makeSession({
          roomId: "room-1",
          status: "running",
          runId: "t1",
          startedAt: now,
          anchor: anchor("block-1", [], ["shape-1"]),
        }),
      ],
    ]);

    expect(deriveAiEditingBlockLocks(sessions, now)).toEqual([]);
  });
});

describe("deriveAiEditingLocks", () => {
  it("locks every block in a multi-block run", () => {
    const now = 1_000_000;
    const sessions = new Map([
      [
        "room-1",
        makeSession({
          roomId: "room-1",
          status: "running",
          runId: "t1",
          startedAt: now,
          anchor: anchor("block-1", ["block-1", "block-2"]),
        }),
      ],
    ]);

    const locks = deriveAiEditingLocks(sessions, now);
    expect(locks).toHaveLength(2);
    expect(locks.map((lock) => lock.target)).toEqual([
      { kind: "block", blockId: "block-1" },
      { kind: "block", blockId: "block-2" },
    ]);
    expect(locks.map((lock) => lock.isPrimaryAnchor)).toEqual([true, false]);
  });

  it("locks all body blocks and overlay shapes in one mixed run", () => {
    const now = 1_000_000;
    const sessions = new Map([
      ["room-1", makeSession({
        roomId: "room-1",
        status: "running",
        runId: "t1",
        startedAt: now,
        anchor: anchor("block-1", ["block-1", "block-2"], ["shape-1", "shape-2"]),
      })],
    ]);

    const locks = deriveAiEditingLocks(sessions, now);
    expect(locks.map((lock) => lock.target)).toEqual([
      { kind: "block", blockId: "block-1" },
      { kind: "block", blockId: "block-2" },
      { kind: "shape", shapeId: "shape-1" },
      { kind: "shape", shapeId: "shape-2" },
    ]);
  });

  it.each(["completed", "failed"] as const)("releases every target when the run becomes %s", (status) => {
    const now = 1_000_000;
    const sessions = new Map([
      ["room-1", makeSession({
        roomId: "room-1",
        status,
        runId: null,
        startedAt: now,
        anchor: anchor("block-1", ["block-1", "block-2"], ["shape-1"]),
      })],
    ]);

    expect(deriveAiEditingLocks(sessions, now)).toEqual([]);
  });

  it("expires mixed locks past the TTL backstop", () => {
    const startedAt = 0;
    const runAnchor = anchor("block-1", ["block-1"], ["shape-1"]);
    const sessions = new Map([
      ["room-1", makeSession({ roomId: "room-1", status: "running", runId: "t1", startedAt, anchor: runAnchor })],
    ]);

    expect(deriveAiEditingLocks(sessions, AI_EDIT_BLOCK_LOCK_TTL_MS - 1)).toHaveLength(2);
    expect(deriveAiEditingLocks(sessions, AI_EDIT_BLOCK_LOCK_TTL_MS)).toEqual([]);
  });
});
