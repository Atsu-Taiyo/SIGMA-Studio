// Pure, DOM/React-free scheduler that prevents AI runs with overlapping
// document targets from executing at the same time. Conflicting runs wait in
// arrival order; disjoint runs may execute concurrently, including runs that
// were released from the same blocker.
//
// Deliberately free of any React/store/IPC dependency so the queueing logic is
// exhaustively unit-testable without mounting anything or mocking the desktop
// bridge.

export interface AiRunAnchorQueueTarget {
  documentKey: string;
  blockIds: readonly string[];
  shapeIds: readonly string[];
}

export interface AiRunAnchorQueueItem {
  runKey: string;
  roomId: string;
}

interface AiRunAnchorQueueEntry {
  item: AiRunAnchorQueueItem;
  target: AiRunAnchorQueueTarget;
}

export type AiRunAnchorAcquireResult = "acquired" | "queued";

export function doAiRunAnchorQueueTargetsOverlap(
  current: AiRunAnchorQueueTarget,
  next: AiRunAnchorQueueTarget,
): boolean {
  if (current.documentKey !== next.documentKey) {
    return false;
  }
  return next.blockIds.some((blockId) => current.blockIds.includes(blockId))
    || next.shapeIds.some((shapeId) => current.shapeIds.includes(shapeId));
}

export class AiRunAnchorQueue {
  private activeByRunKey = new Map<string, AiRunAnchorQueueEntry>();
  private pending: AiRunAnchorQueueEntry[] = [];
  private queuedRunKeys = new Set<string>();

  /**
   * Acquires `target` immediately when it does not overlap an active run or
   * an older queued run. Waiting behind an older conflicting queued run keeps
   * FIFO ordering even when that older run is itself blocked by another
   * active target.
   */
  acquire(target: AiRunAnchorQueueTarget, item: AiRunAnchorQueueItem): AiRunAnchorAcquireResult {
    const entry = { target, item };
    const conflictsWithActive = Array.from(this.activeByRunKey.values())
      .some((active) => doAiRunAnchorQueueTargetsOverlap(active.target, target));
    const conflictsWithEarlierPending = this.pending
      .some((pending) => doAiRunAnchorQueueTargetsOverlap(pending.target, target));
    if (!conflictsWithActive && !conflictsWithEarlierPending) {
      this.activeByRunKey.set(item.runKey, entry);
      return "acquired";
    }
    this.pending.push(entry);
    this.queuedRunKeys.add(item.runKey);
    return "queued";
  }

  /** True while `runKey` is waiting rather than actively executing. */
  isQueued(runKey: string): boolean {
    return this.queuedRunKeys.has(runKey);
  }

  /** True while `runKey` is allowed to execute. */
  isActive(runKey: string): boolean {
    return this.activeByRunKey.has(runKey);
  }

  /**
   * Releases an active run and returns every waiting run that is now safe to
   * dispatch. More than one run can become ready when they each overlapped a
   * different part of the released target but are disjoint from one another.
   */
  release(runKey: string): AiRunAnchorQueueItem[] {
    if (!this.activeByRunKey.delete(runKey)) {
      return [];
    }
    return this.activateReadyPending();
  }

  /**
   * Removes a waiting run. Returns null when `runKey` was not queued;
   * otherwise returns any later runs that the cancellation unblocked.
   */
  cancelQueued(runKey: string): AiRunAnchorQueueItem[] | null {
    const index = this.pending.findIndex((entry) => entry.item.runKey === runKey);
    if (index === -1) {
      return null;
    }
    this.pending.splice(index, 1);
    this.queuedRunKeys.delete(runKey);
    return this.activateReadyPending();
  }

  private activateReadyPending(): AiRunAnchorQueueItem[] {
    const ready: AiRunAnchorQueueItem[] = [];
    const stillPending: AiRunAnchorQueueEntry[] = [];

    for (const entry of this.pending) {
      const conflictsWithActive = Array.from(this.activeByRunKey.values())
        .some((active) => doAiRunAnchorQueueTargetsOverlap(active.target, entry.target));
      const conflictsWithEarlierPending = stillPending
        .some((pending) => doAiRunAnchorQueueTargetsOverlap(pending.target, entry.target));
      if (conflictsWithActive || conflictsWithEarlierPending) {
        stillPending.push(entry);
        continue;
      }
      this.activeByRunKey.set(entry.item.runKey, entry);
      this.queuedRunKeys.delete(entry.item.runKey);
      ready.push(entry.item);
    }

    this.pending = stillPending;
    return ready;
  }
}
