import { describe, expect, it } from "vitest";

import { AiRunAnchorQueue, type AiRunAnchorQueueTarget } from "./ai-run-anchor-queue";

function target(
  blockIds: string[] = [],
  shapeIds: string[] = [],
  documentKey = "doc-1",
): AiRunAnchorQueueTarget {
  return { documentKey, blockIds, shapeIds };
}

function item(runKey: string) {
  return { runKey, roomId: `room-${runKey}` };
}

describe("AiRunAnchorQueue", () => {
  it("acquires a target immediately when nothing overlaps it", () => {
    const queue = new AiRunAnchorQueue();

    expect(queue.acquire(target(["block-1"]), item("run-1"))).toBe("acquired");
    expect(queue.isActive("run-1")).toBe(true);
    expect(queue.isQueued("run-1")).toBe(false);
  });

  it("queues overlapping block target sets", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-a", "block-b"]), item("run-1"));

    expect(queue.acquire(target(["block-b", "block-c"]), item("run-2"))).toBe("queued");
    expect(queue.isQueued("run-2")).toBe(true);
  });

  it("runs disjoint block target sets concurrently", () => {
    const queue = new AiRunAnchorQueue();

    expect(queue.acquire(target(["block-a"]), item("run-1"))).toBe("acquired");
    expect(queue.acquire(target(["block-b"]), item("run-2"))).toBe("acquired");
    expect(queue.isActive("run-2")).toBe(true);
  });

  it("queues overlapping shape target sets", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target([], ["shape-1", "shape-2"]), item("run-1"));

    expect(queue.acquire(target([], ["shape-2", "shape-3"]), item("run-2"))).toBe("queued");
  });

  it("runs a block target and a disjoint shape target concurrently", () => {
    const queue = new AiRunAnchorQueue();

    expect(queue.acquire(target(["placement-block"]), item("run-1"))).toBe("acquired");
    expect(queue.acquire(target([], ["shape-1"]), item("run-2"))).toBe("acquired");
  });

  it("does not conflict across documents", () => {
    const queue = new AiRunAnchorQueue();

    expect(queue.acquire(target(["block-1"], [], "doc-a"), item("run-1"))).toBe("acquired");
    expect(queue.acquire(target(["block-1"], [], "doc-b"), item("run-2"))).toBe("acquired");
  });

  it("dispatches conflicting waiters in FIFO order", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-1"]), item("run-1"));
    queue.acquire(target(["block-1"]), item("run-2"));
    queue.acquire(target(["block-1"]), item("run-3"));

    expect(queue.release("run-1")).toEqual([item("run-2")]);
    expect(queue.isActive("run-2")).toBe(true);
    expect(queue.isQueued("run-3")).toBe(true);

    expect(queue.release("run-2")).toEqual([item("run-3")]);
    expect(queue.release("run-3")).toEqual([]);
  });

  it("dispatches multiple newly-unblocked disjoint runs concurrently", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-a", "block-b"]), item("run-1"));
    queue.acquire(target(["block-a"]), item("run-2"));
    queue.acquire(target(["block-b"]), item("run-3"));

    expect(queue.release("run-1")).toEqual([item("run-2"), item("run-3")]);
    expect(queue.isActive("run-2")).toBe(true);
    expect(queue.isActive("run-3")).toBe(true);
  });

  it("does not let a later conflicting run overtake an older blocked waiter", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-a"]), item("run-a"));
    queue.acquire(target(["block-c"]), item("run-c"));
    queue.acquire(target(["block-a", "block-c"]), item("run-older"));
    queue.acquire(target(["block-a"]), item("run-later"));

    expect(queue.release("run-a")).toEqual([]);
    expect(queue.isQueued("run-later")).toBe(true);
    expect(queue.release("run-c")).toEqual([item("run-older")]);
    expect(queue.release("run-older")).toEqual([item("run-later")]);
  });

  it("cancels a waiting run and dispatches any later run it alone blocked", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-a"]), item("run-a"));
    queue.acquire(target(["block-c"]), item("run-c"));
    queue.acquire(target(["block-a", "block-c"]), item("run-cancelled"));
    queue.acquire(target(["block-a"]), item("run-ready"));
    expect(queue.release("run-a")).toEqual([]);

    expect(queue.cancelQueued("run-cancelled")).toEqual([item("run-ready")]);
    expect(queue.isQueued("run-cancelled")).toBe(false);
    expect(queue.isActive("run-ready")).toBe(true);
  });

  it("release and cancelQueued are no-ops for active, already-cancelled, or unknown runs", () => {
    const queue = new AiRunAnchorQueue();
    queue.acquire(target(["block-1"]), item("run-1"));
    queue.acquire(target(["block-1"]), item("run-2"));

    expect(queue.release("run-2")).toEqual([]);
    expect(queue.cancelQueued("run-1")).toBeNull();
    expect(queue.cancelQueued("run-2")).toEqual([]);
    expect(queue.cancelQueued("run-2")).toBeNull();
    expect(queue.release("no-such-run")).toEqual([]);
    expect(queue.isActive("run-1")).toBe(true);
  });
});
