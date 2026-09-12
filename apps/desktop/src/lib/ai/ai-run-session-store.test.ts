import { beforeEach, describe, expect, it, vi } from "vitest";

import { aiRunSessionStore, isAiRunStatusActive } from "@/lib/ai/ai-run-session-store";

describe("isAiRunStatusActive", () => {
  it("treats preparing/running/applying as active and the rest as settled", () => {
    expect(isAiRunStatusActive("preparing")).toBe(true);
    expect(isAiRunStatusActive("running")).toBe(true);
    expect(isAiRunStatusActive("applying")).toBe(true);
    expect(isAiRunStatusActive("completed")).toBe(false);
    expect(isAiRunStatusActive("failed")).toBe(false);
    expect(isAiRunStatusActive("idle")).toBe(false);
    expect(isAiRunStatusActive(null)).toBe(false);
    expect(isAiRunStatusActive(undefined)).toBe(false);
  });
});

describe("aiRunSessionStore", () => {
  beforeEach(() => {
    // The store is a module singleton; drain any session left over from a
    // previous test so cases don't leak into each other.
    for (const roomId of Array.from(aiRunSessionStore.getSnapshot().keys())) {
      aiRunSessionStore.resetSession(roomId);
    }
  });

  it("reports a room with no session yet as not running", () => {
    expect(aiRunSessionStore.isRunning("room-1")).toBe(false);
    expect(aiRunSessionStore.getSession("room-1")).toBeNull();
  });

  it("tracks a run from start through completion", () => {
    aiRunSessionStore.startRun("room-1", {
      runId: "run-1",
      provider: "chatgpt",
      anchor: {
        primaryBlockId: "block-1",
        blockIds: ["block-1", "block-2"],
        shapeIds: ["shape-1"],
      },
    });
    expect(aiRunSessionStore.isRunning("room-1")).toBe(true);
    expect(aiRunSessionStore.getSession("room-1")).toMatchObject({
      runId: "run-1",
      provider: "chatgpt",
      status: "preparing",
      anchor: {
        primaryBlockId: "block-1",
        blockIds: ["block-1", "block-2"],
        shapeIds: ["shape-1"],
      },
    });

    aiRunSessionStore.appendEvent("room-1", { kind: "phase", phase: "reading", message: "reading", timestamp: 1 });
    expect(aiRunSessionStore.getSession("room-1")?.status).toBe("running");
    expect(aiRunSessionStore.getSession("room-1")?.events).toHaveLength(1);

    aiRunSessionStore.appendEvent("room-1", {
      kind: "stream",
      phase: "streaming",
      message: "",
      timestamp: 2,
      channel: "output",
      delta: "hello ",
    });
    aiRunSessionStore.appendEvent("room-1", {
      kind: "stream",
      phase: "streaming",
      message: "",
      timestamp: 3,
      channel: "output",
      delta: "world",
    });
    expect(aiRunSessionStore.getSession("room-1")?.streamText).toBe("hello world");

    aiRunSessionStore.completeRun("room-1", { endedAt: 100 });
    expect(aiRunSessionStore.isRunning("room-1")).toBe(false);
    const session = aiRunSessionStore.getSession("room-1");
    expect(session?.status).toBe("completed");
    expect(session?.endedAt).toBe(100);
    expect(session?.runId).toBeNull();
  });

  it("keeps two rooms' runs fully independent", () => {
    aiRunSessionStore.startRun("room-a", { runId: "run-a", provider: "chatgpt" });
    aiRunSessionStore.startRun("room-b", { runId: "run-b", provider: "claude" });

    aiRunSessionStore.appendEvent("room-a", { kind: "phase", phase: "reading", message: "a", timestamp: 1 });
    aiRunSessionStore.failRun("room-b", "boom", { endedAt: 5 });

    expect(aiRunSessionStore.isRunning("room-a")).toBe(true);
    expect(aiRunSessionStore.isRunning("room-b")).toBe(false);
    expect(aiRunSessionStore.getSession("room-a")?.events).toHaveLength(1);
    expect(aiRunSessionStore.getSession("room-b")?.error).toBe("boom");
  });

  it("marks a failed run's status and preserves the error", () => {
    aiRunSessionStore.startRun("room-1", { runId: "run-1", provider: "chatgpt" });
    aiRunSessionStore.failRun("room-1", "something broke", { endedAt: 42 });
    const session = aiRunSessionStore.getSession("room-1");
    expect(session?.status).toBe("failed");
    expect(session?.error).toBe("something broke");
    expect(session?.endedAt).toBe(42);
    expect(session?.runId).toBeNull();
  });

  it("queues and dequeues follow-up messages in FIFO order", () => {
    aiRunSessionStore.startRun("room-1", { runId: "run-1", provider: "chatgpt" });
    aiRunSessionStore.enqueueMessage("room-1", { id: "m1", instruction: "first", createdAt: 1 });
    aiRunSessionStore.enqueueMessage("room-1", { id: "m2", instruction: "second", createdAt: 2 });

    expect(aiRunSessionStore.getSession("room-1")?.queuedMessages).toHaveLength(2);

    const drained = aiRunSessionStore.dequeueMessages("room-1");
    expect(drained.map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(aiRunSessionStore.getSession("room-1")?.queuedMessages).toHaveLength(0);
    // Draining twice returns nothing the second time.
    expect(aiRunSessionStore.dequeueMessages("room-1")).toEqual([]);
  });

  it("starting a new run preserves messages queued while the previous run was settling", () => {
    aiRunSessionStore.startRun("room-1", { runId: "run-1", provider: "chatgpt" });
    aiRunSessionStore.enqueueMessage("room-1", { id: "m1", instruction: "queued", createdAt: 1 });
    aiRunSessionStore.completeRun("room-1", { endedAt: 10 });
    // A follow-up run for the same room starts (e.g. the auto-dispatched queue drain).
    aiRunSessionStore.startRun("room-1", { runId: "run-2", provider: "chatgpt" });
    expect(aiRunSessionStore.getSession("room-1")?.queuedMessages).toHaveLength(1);
  });

  it("notifies subscribers on every mutation and stops after unsubscribe", () => {
    const listener = vi.fn();
    const unsubscribe = aiRunSessionStore.subscribe(listener);
    aiRunSessionStore.startRun("room-1", { runId: "run-1", provider: "chatgpt" });
    aiRunSessionStore.completeRun("room-1");
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    aiRunSessionStore.startRun("room-1", { runId: "run-3", provider: "chatgpt" });
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it("resetSession removes the room entirely", () => {
    aiRunSessionStore.startRun("room-1", { runId: "run-1", provider: "chatgpt" });
    aiRunSessionStore.resetSession("room-1");
    expect(aiRunSessionStore.getSession("room-1")).toBeNull();
  });
});
