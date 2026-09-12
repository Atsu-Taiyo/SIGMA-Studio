import { useSyncExternalStore } from "react";

import type { AiEditPlanStep, AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import type { AiProvider } from "@/lib/ai/ai-providers";

// Single source of truth for AI-edit run lifecycle state, keyed by chat room id.
// AiEditPanel (both the docked sidebar and the inline "⌘K"-style launcher) and any
// other surface (e.g. a future room switcher badge, or the R2 in-body anchoring
// work) read run status/logs from here instead of holding their own component
// state, so a room's status can never look "stopped" in one view while it is
// still actually running according to another.
//
// This module intentionally knows nothing about SigmaDoc/provider request
// payloads (attachments, mentioned documents, model settings, ...). Callers that
// need to replay a queued follow-up keep the full request payload themselves,
// keyed by the same queued-message id that is registered here via
// `enqueueMessage`. That keeps this store trivially unit-testable and reusable
// from any surface.

// "waiting": queued behind another live run that targets the same anchor block
// (same-anchor serialization — see ai-run-anchor-queue.ts). No provider call is
// in flight yet; the run starts for real once the blocking run reaches a
// terminal state and the anchor queue hands it over.
export type AiRunStatus = "idle" | "preparing" | "waiting" | "running" | "applying" | "completed" | "failed";

/**
 * The exact body fragment that should visually shimmer for an AI run.
 * `blockIds` remains the scheduling boundary. With `blockLockTexts`, these
 * scopes also narrow edit protection to the referenced text or math atom.
 */
export type AiRunBlockShimmerScope =
  | { kind: "block"; blockId: string }
  | { kind: "text"; blockId: string; from: number; to: number }
  | { kind: "inlineMath"; blockId: string; mathInlineId: string };

/**
 * Opaque anchor describing both where a run is displayed and every document
 * target it owns while running. `primaryBlockId` is only the placement/follow-up
 * anchor for the single run widget. `blockIds` and `shapeIds` are the complete
 * scheduling targets; `blockShimmerScopes` and `blockLockTexts` narrow the
 * body-side display and edit protection to the explicit AI context.
 *
 * `canvas` carries the inline launcher's anchor point captured at run start (in
 * VIEWPORT pixels, not canvas coordinates, despite the field name — the
 * in-body anchor layer (R2) converts it via the page canvas element at render
 * time, the same way `EditorShell.syncInlineRunAnchorCanvas` already does for
 * the legacy inline run overlay). `documentId` records which open document the
 * run was started against, so a UI surface iterating every session (which are
 * NOT scoped to a single document) can tell whether a given session's anchor
 * even applies to the document currently on screen. `preferredTarget` lets
 * overlay-originated runs keep the target block for follow-up context while
 * positioning the visible widget at the selected figure. A mixed AI context
 * may contain both body blocks and overlay shapes; neither target set excludes
 * the other.
 */
export interface AiRunAnchor {
  primaryBlockId: string | null;
  blockIds: string[];
  shapeIds: string[];
  /** Exact visual targets. Omitted by legacy anchors, which shimmer all of `blockIds`. */
  blockShimmerScopes?: AiRunBlockShimmerScope[];
  /** Run-start plain text for rebasing reserved text ranges after unrelated edits. */
  blockLockTexts?: Record<string, string>;
  canvas?: { left: number; top: number };
  preferredTarget?: "block" | "canvas";
  documentId?: string;
}

export interface AiRunQueuedMessage {
  id: string;
  instruction: string;
  createdAt: number;
}

export interface AiRunSession {
  roomId: string;
  runId: string | null;
  provider: AiProvider | null;
  status: AiRunStatus;
  events: AiEditRunEvent[];
  streamText: string;
  planSteps: AiEditPlanStep[];
  error: string | null;
  startedAt: number | null;
  endedAt: number | null;
  anchor: AiRunAnchor | null;
  queuedMessages: AiRunQueuedMessage[];
}

const MAX_SESSION_EVENTS = 48;
const MAX_SESSION_STREAM_CHARS = 6000;

export const ACTIVE_AI_RUN_STATUSES: readonly AiRunStatus[] = ["preparing", "waiting", "running", "applying"];

export function isAiRunStatusActive(status: AiRunStatus | null | undefined): boolean {
  return !!status && (ACTIVE_AI_RUN_STATUSES as readonly string[]).includes(status);
}

type Listener = () => void;

function createIdleSession(roomId: string): AiRunSession {
  return {
    roomId,
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
  };
}

class AiRunSessionStore {
  private sessions = new Map<string, AiRunSession>();
  private listeners = new Set<Listener>();
  private snapshot: ReadonlyMap<string, AiRunSession> = new Map();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ReadonlyMap<string, AiRunSession> => {
    return this.snapshot;
  };

  getSession(roomId: string): AiRunSession | null {
    return this.sessions.get(roomId) ?? null;
  }

  isRunning(roomId: string): boolean {
    return isAiRunStatusActive(this.sessions.get(roomId)?.status);
  }

  startRun(
    roomId: string,
    params: { runId: string; provider: AiProvider; anchor?: AiRunAnchor | null; startedAt?: number },
  ): void {
    const current = this.sessions.get(roomId);
    this.write(roomId, {
      ...createIdleSession(roomId),
      runId: params.runId,
      provider: params.provider,
      status: "preparing",
      startedAt: params.startedAt ?? Date.now(),
      anchor: params.anchor ?? null,
      // Preserve any messages that were queued while the previous run for this
      // room was still settling.
      queuedMessages: current?.queuedMessages ?? [],
    });
  }

  setStatus(roomId: string, status: AiRunStatus): void {
    this.update(roomId, { status });
  }

  appendEvent(roomId: string, event: AiEditRunEvent): void {
    this.update(roomId, (session) => {
      const nextEvents = [...session.events, event].slice(-MAX_SESSION_EVENTS);
      const nextStream =
        event.kind === "stream" && event.channel !== "reasoning" && event.delta
          ? `${session.streamText}${event.delta}`.slice(-MAX_SESSION_STREAM_CHARS)
          : session.streamText;
      const nextPlanSteps = event.kind === "plan" ? event.planSteps ?? [] : session.planSteps;
      const nextStatus: AiRunStatus = session.status === "preparing" ? "running" : session.status;
      return { events: nextEvents, streamText: nextStream, planSteps: nextPlanSteps, status: nextStatus };
    });
  }

  completeRun(roomId: string, options: { endedAt?: number } = {}): void {
    this.update(roomId, { status: "completed", endedAt: options.endedAt ?? Date.now(), runId: null });
  }

  failRun(roomId: string, error: string, options: { endedAt?: number } = {}): void {
    this.update(roomId, { status: "failed", error, endedAt: options.endedAt ?? Date.now(), runId: null });
  }

  resetSession(roomId: string): void {
    if (!this.sessions.has(roomId)) {
      return;
    }
    this.sessions.delete(roomId);
    this.emit();
  }

  enqueueMessage(roomId: string, message: AiRunQueuedMessage): void {
    this.update(roomId, (session) => ({ queuedMessages: [...session.queuedMessages, message] }));
  }

  /** Removes and returns all queued messages for a room (FIFO order). */
  dequeueMessages(roomId: string): AiRunQueuedMessage[] {
    const session = this.sessions.get(roomId);
    if (!session || session.queuedMessages.length === 0) {
      return [];
    }
    const queued = session.queuedMessages;
    this.update(roomId, { queuedMessages: [] });
    return queued;
  }

  clearQueuedMessages(roomId: string): void {
    this.update(roomId, { queuedMessages: [] });
  }

  private ensure(roomId: string): AiRunSession {
    const existing = this.sessions.get(roomId);
    if (existing) {
      return existing;
    }
    const created = createIdleSession(roomId);
    this.sessions.set(roomId, created);
    return created;
  }

  private update(roomId: string, patch: Partial<AiRunSession> | ((session: AiRunSession) => Partial<AiRunSession>)): void {
    const current = this.ensure(roomId);
    const delta = typeof patch === "function" ? patch(current) : patch;
    this.write(roomId, { ...current, ...delta });
  }

  private write(roomId: string, session: AiRunSession): void {
    this.sessions.set(roomId, session);
    this.emit();
  }

  private emit(): void {
    this.snapshot = new Map(this.sessions);
    this.listeners.forEach((listener) => listener());
  }
}

export const aiRunSessionStore = new AiRunSessionStore();

/** Subscribes to the full session map. Re-renders whenever any room's run state changes. */
export function useAiRunSessions(): ReadonlyMap<string, AiRunSession> {
  return useSyncExternalStore(aiRunSessionStore.subscribe, aiRunSessionStore.getSnapshot, aiRunSessionStore.getSnapshot);
}

/** Convenience hook for a single room; returns null when the room has no session yet. */
export function useAiRunSession(roomId: string | null | undefined): AiRunSession | null {
  const sessions = useAiRunSessions();
  return roomId ? sessions.get(roomId) ?? null : null;
}
