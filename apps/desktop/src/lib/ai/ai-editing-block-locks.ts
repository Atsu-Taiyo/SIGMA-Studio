import { useMemo, useSyncExternalStore } from "react";

import { aiChatRoomsStore, cancelRun } from "@/lib/ai/ai-run-controller";
import {
  aiRunSessionStore,
  type AiRunBlockShimmerScope,
  type AiRunSession,
  type AiRunStatus,
} from "@/lib/ai/ai-run-session-store";
import type { AiProvider } from "@/lib/ai/ai-providers";

// Derives, from the run-session store's live state, which blocks and overlay
// shapes are currently "owned" by an in-flight AI run and must not be
// hand-edited until that run finishes (or is stopped) -- the AI-edit lock
// feature.
//
// Deliberately lives outside any React component: run state (and therefore
// lock state) must survive AiEditPanel being unmounted/remounted when it is
// promoted from the inline "⌘K" host to the docked sidebar (see the R5 note
// atop ai-run-controller.ts) -- exactly the reason ai-run-session-store and
// aiChatRoomsStore themselves are module-scope singletons rather than
// component state.
//
// Scope, per the approved design:
// - Every live session locks its own targets: "preparing" (submitted, provider
//   call not yet in flight), "waiting" (queued behind an overlapping run, see
//   ai-run-anchor-queue.ts) and "running". `waiting` is included because the
//   user already handed those targets over: letting them be rewritten while the
//   run sits in the FIFO queue would have the AI act on content that no longer
//   matches the instruction. ("applying" is in ACTIVE_AI_RUN_STATUSES but is
//   never actually set; the apply write window is guarded by the shell instead.)
// - These per-target locks are the ONLY AI edit lock. There is deliberately no
//   document-wide lock during a run: everything the user did not hand to the AI
//   stays editable, and a run that edits outside its own anchor is reconciled at
//   approval time by the per-block content-hash freshness check
//   (findProposalFreshnessConflictIds) plus the stale-proposal UI.
// - Runs started from an external CLI session (not visible to this
//   renderer's aiRunSessionStore) are out of scope entirely; there is no
//   run-session entry for them to derive a lock from.
// - A TTL backstop (10 minutes from when the run started) clears the lock
//   even if the run's status update is somehow never delivered, so a target
//   can never be stuck locked forever. Correctness of concurrent edits after
//   that point is left to the existing conflict-detection mechanism, not this
//   module.
// - Target set: `AiRunAnchor.blockIds` and `AiRunAnchor.shapeIds` are complete
//   target identities. `blockShimmerScopes` + `blockLockTexts` reserve only the
//   selected fragment of a body block. Legacy anchors retain whole-block locks.

/** Backstop: a lock older than this clears itself even if the owning run was
 * never observed to leave a locking status (e.g. a crashed provider process
 * that never reports back). */
export const AI_EDIT_BLOCK_LOCK_TTL_MS = 10 * 60 * 1000;

/** Run statuses that own their anchor's targets. See the scope note above. */
const AI_EDIT_LOCKING_RUN_STATUSES: ReadonlySet<AiRunStatus> = new Set<AiRunStatus>([
  "preparing",
  "waiting",
  "running",
]);

export type AiEditingLockTarget =
  | { kind: "block"; blockId: string }
  | { kind: "shape"; shapeId: string };

export interface AiEditingLock {
  documentId: string;
  target: AiEditingLockTarget;
  provider: AiProvider | null;
  /** The assistantTurnId identifying the run -- the same id `cancelRun()` and
   * `aiRunSessionStore` key on. */
  runId: string;
  roomId: string;
  /** When this lock started (approximated by the run's own start time -- the
   * preparing→running handoff happens within the same run and is at most a
   * couple of seconds, negligible against the 10-minute TTL). Used for the
   * TTL backstop. */
  lockedAt: number;
  /** True only for the body block that owns the run's single stop widget. */
  isPrimaryAnchor: boolean;
  /** Exact fragments to shimmer inside this body block. Undefined keeps legacy whole-block behavior. */
  blockShimmerScopes?: AiRunBlockShimmerScope[];
  blockLockText?: string;
}

/** `AiEditingLock` plus a human-readable label for the owning run, shown in
 * the hover-stop button / blocked-edit status message. Resolved separately
 * from the pure derivation below since it depends on `aiChatRoomsStore`. */
export interface AiEditingLockWithLabel extends AiEditingLock {
  sessionLabel: string | null;
}

/**
 * Pure derivation: which targets (text-flow blocks or overlay shapes) are
 * locked right now, given the run-session store's snapshot and the current
 * time. No timers, no external stores -- directly unit-testable.
 */
export function deriveAiEditingLocks(
  sessions: ReadonlyMap<string, AiRunSession>,
  now: number,
): AiEditingLock[] {
  const locks: AiEditingLock[] = [];
  for (const session of sessions.values()) {
    if (!AI_EDIT_LOCKING_RUN_STATUSES.has(session.status)) {
      continue;
    }
    const documentId = session.anchor?.documentId;
    if (!documentId || !session.runId) {
      continue;
    }
    const lockedAt = session.startedAt ?? now;
    if (now - lockedAt >= AI_EDIT_BLOCK_LOCK_TTL_MS) {
      continue;
    }

    const anchor = session.anchor;
    for (const blockId of anchor?.blockIds ?? []) {
      const blockShimmerScopes = anchor?.blockShimmerScopes?.filter((scope) => scope.blockId === blockId);
      locks.push({
        documentId,
        target: { kind: "block", blockId },
        provider: session.provider,
        runId: session.runId,
        roomId: session.roomId,
        lockedAt,
        isPrimaryAnchor: blockId === anchor?.primaryBlockId,
        ...(anchor?.blockShimmerScopes ? { blockShimmerScopes } : {}),
        ...(anchor?.blockLockTexts?.[blockId] !== undefined ? { blockLockText: anchor.blockLockTexts[blockId] } : {}),
      });
    }
    for (const shapeId of anchor?.shapeIds ?? []) {
      locks.push({
        documentId,
        target: { kind: "shape", shapeId },
        provider: session.provider,
        runId: session.runId,
        roomId: session.roomId,
        lockedAt,
        isPrimaryAnchor: false,
      });
    }
  }
  return locks;
}

type Listener = () => void;

/**
 * Reactive wrapper around `deriveAiEditingLocks`: recomputes whenever the
 * run-session store or the chat-rooms store (for labels) emits, and also
 * schedules its own recompute at the next lock's TTL expiry so a lock clears
 * on schedule even if nothing else happens to trigger a recompute in the
 * meantime (e.g. a hung run that stops emitting events).
 */
class AiEditingLockStore {
  private listeners = new Set<Listener>();
  private snapshot: readonly AiEditingLockWithLabel[] = [];
  private unsubscribeSession: (() => void) | null = null;
  private unsubscribeRooms: (() => void) | null = null;
  private expiryTimer: ReturnType<typeof setTimeout> | null = null;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    this.ensureStarted();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) {
        this.stop();
      }
    };
  };

  getSnapshot = (): readonly AiEditingLockWithLabel[] => this.snapshot;

  private ensureStarted(): void {
    if (this.unsubscribeSession) {
      return;
    }
    this.unsubscribeSession = aiRunSessionStore.subscribe(this.recompute);
    this.unsubscribeRooms = aiChatRoomsStore.subscribe(this.recompute);
    this.recompute();
  }

  private stop(): void {
    this.unsubscribeSession?.();
    this.unsubscribeSession = null;
    this.unsubscribeRooms?.();
    this.unsubscribeRooms = null;
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
  }

  private recompute = (): void => {
    const now = Date.now();
    const locks = deriveAiEditingLocks(aiRunSessionStore.getSnapshot(), now);
    this.snapshot = locks.map((lock) => ({
      ...lock,
      sessionLabel: aiChatRoomsStore.getRoom(lock.roomId)?.title?.trim() || null,
    }));
    this.scheduleNextExpiry(locks, now);
    this.emit();
  };

  private scheduleNextExpiry(locks: readonly AiEditingLock[], now: number): void {
    if (this.expiryTimer !== null) {
      clearTimeout(this.expiryTimer);
      this.expiryTimer = null;
    }
    if (locks.length === 0) {
      return;
    }
    const nextExpiryAt = Math.min(...locks.map((lock) => lock.lockedAt + AI_EDIT_BLOCK_LOCK_TTL_MS));
    const delay = Math.max(0, nextExpiryAt - now);
    this.expiryTimer = setTimeout(this.recompute, delay);
  }

  private emit(): void {
    this.listeners.forEach((listener) => listener());
  }
}

const aiEditingLockStore = new AiEditingLockStore();

/** Text-flow-facing projection of a lock: the shape TextFlowEditor and
 * ai-edit-lock-extension.ts already consumed before shape-kind locks
 * existed, unchanged, so neither needs to know the target is now a
 * discriminated union. */
export interface AiEditingBlockLock {
  documentId: string;
  blockId: string;
  provider: AiProvider | null;
  runId: string;
  roomId: string;
  lockedAt: number;
  isPrimaryAnchor: boolean;
  blockShimmerScopes?: AiRunBlockShimmerScope[];
  blockLockText?: string;
}

export interface AiEditingBlockLockWithLabel extends AiEditingBlockLock {
  sessionLabel: string | null;
}

/** Overlay-canvas-facing projection of a lock, for shape-kind locks. */
export interface AiEditingShapeLock {
  documentId: string;
  shapeId: string;
  provider: AiProvider | null;
  runId: string;
  roomId: string;
  lockedAt: number;
}

export interface AiEditingShapeLockWithLabel extends AiEditingShapeLock {
  sessionLabel: string | null;
}

function toBlockLock(lock: AiEditingLockWithLabel): AiEditingBlockLockWithLabel | null {
  if (lock.target.kind !== "block") {
    return null;
  }
  return {
    documentId: lock.documentId,
    blockId: lock.target.blockId,
    provider: lock.provider,
    runId: lock.runId,
    roomId: lock.roomId,
    lockedAt: lock.lockedAt,
    isPrimaryAnchor: lock.isPrimaryAnchor,
    ...(lock.blockShimmerScopes ? { blockShimmerScopes: lock.blockShimmerScopes } : {}),
    ...(lock.blockLockText !== undefined ? { blockLockText: lock.blockLockText } : {}),
    sessionLabel: lock.sessionLabel,
  };
}

function toShapeLock(lock: AiEditingLockWithLabel): AiEditingShapeLockWithLabel | null {
  if (lock.target.kind !== "shape") {
    return null;
  }
  return {
    documentId: lock.documentId,
    shapeId: lock.target.shapeId,
    provider: lock.provider,
    runId: lock.runId,
    roomId: lock.roomId,
    lockedAt: lock.lockedAt,
    sessionLabel: lock.sessionLabel,
  };
}

/** Back-compat entry point kept for the existing unit tests / callers that
 * only cared about block-kind locks before shape-kind locks existed. Prefer
 * `deriveAiEditingLocks` for new code that needs to see both kinds. */
export function deriveAiEditingBlockLocks(
  sessions: ReadonlyMap<string, AiRunSession>,
  now: number,
): AiEditingBlockLock[] {
  return deriveAiEditingLocks(sessions, now)
    .filter((lock) => lock.target.kind === "block")
    .map((lock) => {
      const target = lock.target as Extract<AiEditingLockTarget, { kind: "block" }>;
      return {
        documentId: lock.documentId,
        blockId: target.blockId,
        provider: lock.provider,
        runId: lock.runId,
        roomId: lock.roomId,
        lockedAt: lock.lockedAt,
        isPrimaryAnchor: lock.isPrimaryAnchor,
        ...(lock.blockShimmerScopes ? { blockShimmerScopes: lock.blockShimmerScopes } : {}),
        ...(lock.blockLockText !== undefined ? { blockLockText: lock.blockLockText } : {}),
      };
    });
}

/** All AI-edit locks currently held for `documentId`'s text-flow blocks
 * (empty array outside a live run, or when `documentId` is null/undefined). */
export function useAiEditingBlockLocks(documentId: string | null | undefined): readonly AiEditingBlockLockWithLabel[] {
  const all = useSyncExternalStore(
    aiEditingLockStore.subscribe,
    aiEditingLockStore.getSnapshot,
    aiEditingLockStore.getSnapshot,
  );
  return useMemo(() => {
    if (!documentId) {
      return [];
    }
    const result: AiEditingBlockLockWithLabel[] = [];
    for (const lock of all) {
      if (lock.documentId !== documentId) {
        continue;
      }
      const blockLock = toBlockLock(lock);
      if (blockLock) {
        result.push(blockLock);
      }
    }
    return result;
  }, [all, documentId]);
}

/** All AI-edit locks currently held for `documentId`'s overlay shapes (empty
 * array outside a live run, or when `documentId` is null/undefined). */
export function useAiEditingShapeLocks(documentId: string | null | undefined): readonly AiEditingShapeLockWithLabel[] {
  const all = useSyncExternalStore(
    aiEditingLockStore.subscribe,
    aiEditingLockStore.getSnapshot,
    aiEditingLockStore.getSnapshot,
  );
  return useMemo(() => {
    if (!documentId) {
      return [];
    }
    const result: AiEditingShapeLockWithLabel[] = [];
    for (const lock of all) {
      if (lock.documentId !== documentId) {
        continue;
      }
      const shapeLock = toShapeLock(lock);
      if (shapeLock) {
        result.push(shapeLock);
      }
    }
    return result;
  }, [all, documentId]);
}

/**
 * Requests that the run holding `lock` stop, so its target unlocks. Best
 * effort: mirrors `cancelRun`'s own semantics (a no-op if the run already
 * settled) and simply reports whether the desktop bridge accepted the
 * cancellation request -- the lock itself always clears reactively via the
 * run-session store once the run's status actually changes, not as a direct
 * effect of this call.
 *
 * Takes just the runId (not a full lock object) so callers that only carry a
 * thinner projection (see `AiEditLockInfo` in ai-edit-lock-extension.ts, or
 * the overlay-shape stop button's own minimal lock shape) can call this
 * directly.
 */
export async function requestAiEditLockStop(lock: { runId: string }): Promise<{ ok: boolean }> {
  try {
    const result = await cancelRun(lock.runId);
    return { ok: result?.ok ?? false };
  } catch {
    return { ok: false };
  }
}
