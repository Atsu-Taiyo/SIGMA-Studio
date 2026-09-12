import { useMemo, useSyncExternalStore } from "react";

import { cancelAiEditViaDesktopRuntime, runAiEditViaDesktopRuntime } from "@/lib/ai/codex-ai-edit-client";
import { aiRunSessionStore, type AiRunAnchor } from "@/lib/ai/ai-run-session-store";
import {
  AiRunAnchorQueue,
  doAiRunAnchorQueueTargetsOverlap,
  type AiRunAnchorQueueItem,
  type AiRunAnchorQueueTarget,
} from "@/lib/ai/ai-run-anchor-queue";
import { createCurrentLocaleTranslator, createTranslator, SUPPORTED_LOCALES, type Translate } from "@/lib/i18n";
import { getAiModelPreferences } from "@/lib/ai/ai-model-preferences";
// モデルへ渡す指示文は UI 文言と判断が別なので、別ファイルに切ってある (WI-8 の担当)。
export { buildRejectionFeedbackInstruction } from "@/lib/ai/ai-rejection-prompt";
import { buildRejectionFeedbackInstruction } from "@/lib/ai/ai-rejection-prompt";

/** `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く (解決器は言語ごとに使い回す)。 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/** 呼び出し時点の表示言語で解決する `t` (会話履歴は作った時点の言語で焼く)。 */
const tAiNow = createCurrentLocaleTranslator("ai");
import { getDesktopBridge } from "@/lib/desktop-bridge";
import {
  getAiEditReferenceKey,
  blockToStableReferenceText,
  MAX_AI_EDIT_REFERENCES,
  resolveAiEditTextRangeBlockIds,
  resolveAiEditTextRangeBlockSpans,
  type AiEditReference,
} from "@/lib/ai/ai-edit-reference";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import type { AiEditPlanStep, AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import type { AiProvider } from "@/lib/ai/ai-providers";
import type {
  DesktopAiEditChatAttachmentSummary,
  DesktopAiEditChatMentionedDocumentSummary,
  DesktopAiEditChatRoom,
} from "@/types/desktop";
import type { SigmaDocument } from "@/features/document";
import { findBlock } from "@/lib/document-tree";

// R5 fix: the run lifecycle used to live inside AiEditPanel's component state
// (chatRooms, runSeqByRoomRef, pendingRunParamsRef, ...). AiEditPanel is a
// single component instance in the tree, but its *position* changes between
// the inline "⌘K" host (portaled to <body>) and the docked sidebar (rendered
// in the normal grid flow) -- see EditorShell.renderAiHost's
// `createPortal(host, document.body) : host` branch. React treats a portal
// and a plain element as different types at the same JSX slot, so switching
// between them (e.g. clicking an in-body run widget, which promotes to the
// sidebar) unmounts the old AiEditPanel instance and mounts a fresh one.
//
// Any state needed for a run to keep making progress and eventually
// surface its result correctly -- the chat rooms themselves, and the
// bookkeeping that guards against stale/duplicate runs -- therefore lives at
// module scope here, not in the component. AiEditPanel (whichever instance
// happens to be mounted) subscribes to it like any other external store, so
// a remount just re-subscribes to state that was never lost.
//
// Rendering (JSX, DOM refs, scroll position, composer text, ...) stays in
// AiEditPanel: those are legitimately per-surface concerns and are fine to
// reset/re-derive on every mount.

type UiAgentEvent = AiEditRunEvent & { id: number };

export interface AiEditChatRoom extends Omit<DesktopAiEditChatRoom, "turns"> {
  turns: ChatTurn[];
}

export interface UserTurn {
  id: string;
  role: "user";
  documentIdentityKey: string;
  instruction: string;
  references: AiEditReference[];
  attachments: DesktopAiEditChatAttachmentSummary[];
  mentionedDocuments: DesktopAiEditChatMentionedDocumentSummary[];
  timestamp: number;
  // R3 follow-up-while-running: true while this turn is waiting in the room's
  // queue for the in-flight run to finish. `queueFailed` marks a queued turn
  // that never got dispatched because the run it was waiting behind failed —
  // it stays visible with a resend affordance instead of being dropped.
  queued?: boolean;
  queueFailed?: boolean;
}

export interface AssistantTurn {
  id: string;
  role: "assistant";
  documentIdentityKey: string;
  references: AiEditReference[];
  events: UiAgentEvent[];
  streamText: string;
  reasoningText: string;
  planSteps: AiEditPlanStep[];
  planExplanation: string | null;
  startedAt: number;
  endedAt: number | null;
  isRunning: boolean;
  result: AiEditRunResult | null;
  targetId: string | null;
  error: string | null;
  applied: boolean;
  dismissed: boolean;
  restored?: boolean;
}

export type ChatTurn = UserTurn | AssistantTurn;

const MAX_AGENT_EVENTS = 48;
const MAX_LIVE_STREAM_CHARS = 6000;

function limitLiveStreamText(text: string): string {
  return text.length > MAX_LIVE_STREAM_CHARS ? text.slice(text.length - MAX_LIVE_STREAM_CHARS) : text;
}

// Snapshot of everything a run needs, captured once at submit time. Queued
// follow-ups (R3) replay this later instead of re-reading (possibly since
// mutated) live composer state.
export interface RunParams {
  runDocumentIdentityKey: string;
  runAgentThreadId: string | null;
  runDocument: SigmaDocument;
  turnReferences: AiEditReference[];
  turnAttachments: AiEditAttachment[];
  turnMentionedDocuments: AiEditMentionedDocumentContext[];
  turnProvider: AiProvider;
  turnAiResourceIds: string[];
  turnInstruction: string;
  turnModel: string;
  turnReasoningEffort: AiEditReasoningEffort;
  aiTargetId: string | null;
  anchor: AiRunAnchor;
}

export function createAiRunAnchor({
  primaryBlockId,
  documentId,
  document,
  references,
  blockIds = [],
  shapeIds = [],
  canvas,
  preferredTarget,
}: {
  primaryBlockId: string | null;
  documentId?: string;
  document: SigmaDocument;
  references: readonly AiEditReference[];
  blockIds?: readonly string[];
  shapeIds?: readonly string[];
  canvas?: AiRunAnchor["canvas"];
  preferredTarget?: AiRunAnchor["preferredTarget"];
}): AiRunAnchor {
  const targetBlockIds: string[] = [];
  const targetShapeIds: string[] = [];
  const blockShimmerScopes: AiRunAnchor["blockShimmerScopes"] = [];

  const addBlockId = (blockId: string | null | undefined) => {
    if (blockId && !targetBlockIds.includes(blockId)) {
      targetBlockIds.push(blockId);
    }
  };
  const addShapeId = (shapeId: string | null | undefined) => {
    if (shapeId && !targetShapeIds.includes(shapeId)) {
      targetShapeIds.push(shapeId);
    }
  };
  const addBlockShimmerScope = (scope: NonNullable<AiRunAnchor["blockShimmerScopes"]>[number]) => {
    const key = scope.kind === "block"
      ? `${scope.kind}:${scope.blockId}`
      : scope.kind === "inlineMath"
        ? `${scope.kind}:${scope.blockId}:${scope.mathInlineId}`
        : `${scope.kind}:${scope.blockId}:${scope.from}:${scope.to}`;
    const exists = blockShimmerScopes.some((candidate) => {
      const candidateKey = candidate.kind === "block"
        ? `${candidate.kind}:${candidate.blockId}`
        : candidate.kind === "inlineMath"
          ? `${candidate.kind}:${candidate.blockId}:${candidate.mathInlineId}`
          : `${candidate.kind}:${candidate.blockId}:${candidate.from}:${candidate.to}`;
      return candidateKey === key;
    });
    if (!exists) {
      blockShimmerScopes.push(scope);
    }
  };

  blockIds.forEach((blockId) => {
    addBlockId(blockId);
    addBlockShimmerScope({ kind: "block", blockId });
  });
  shapeIds.forEach(addShapeId);
  for (const reference of references) {
    reference.overlaySelection?.selectedShapeIds.forEach(addShapeId);

    // A plain block reference carrying overlaySelection exists only to give a
    // shape-originated run nearby document context. It is not itself a body
    // target. Explicit body references (including text/math selections) still
    // contribute blocks alongside any selected shapes.
    if (reference.kind === "block" && reference.overlaySelection) {
      continue;
    }

    if (reference.kind === "textSelection") {
      const selectedSpans = reference.textRange
        ? resolveAiEditTextRangeBlockSpans(document, reference.textRange)
        : [];
      const selectedBlockIds = selectedSpans.length > 0
        ? selectedSpans.map((span) => span.blockId)
        : reference.textRange
          ? resolveAiEditTextRangeBlockIds(document, reference.textRange)
          : reference.selectedBlockIds ?? [];
      if (selectedBlockIds.length > 0) {
        selectedBlockIds.forEach(addBlockId);
        if (selectedSpans.length > 0) {
          selectedSpans.forEach((span) => addBlockShimmerScope({ kind: "text", ...span }));
        } else {
          selectedBlockIds.forEach((blockId) => addBlockShimmerScope({ kind: "block", blockId }));
        }
        continue;
      }
    }
    if (reference.kind === "inlineMath") {
      addBlockId(reference.targetId);
      addBlockShimmerScope({
        kind: "inlineMath",
        blockId: reference.targetId,
        mathInlineId: reference.mathInlineId,
      });
      continue;
    }
    addBlockId(reference.targetId);
    addBlockShimmerScope({ kind: "block", blockId: reference.targetId });
  }

  // selectedId remains the runtime's direct edit target when there is no
  // explicit reference. Preserve that established block-target behavior, but
  // do not turn a shape-only context's placement block into a body lock.
  if (targetBlockIds.length === 0 && targetShapeIds.length === 0) {
    addBlockId(primaryBlockId);
    if (primaryBlockId) {
      addBlockShimmerScope({ kind: "block", blockId: primaryBlockId });
    }
  }

  return {
    primaryBlockId,
    blockIds: targetBlockIds,
    shapeIds: targetShapeIds,
    blockLockTexts: Object.fromEntries(targetBlockIds.flatMap((id) => {
      const block = findBlock(document, id);
      return block ? [[id, blockToStableReferenceText(block)]] : [];
    })),
    ...(blockShimmerScopes.length > 0 ? { blockShimmerScopes } : {}),
    ...(canvas ? { canvas } : {}),
    ...(preferredTarget ? { preferredTarget } : {}),
    ...(documentId ? { documentId } : {}),
  };
}

export function resolvePendingAssistantTurns(
  turns: ChatTurn[],
  outcome: "applied" | "dismissed",
  turnIds?: ReadonlySet<string>,
  options?: { includeResolved?: boolean },
): ChatTurn[] {
  return turns.map((turn) =>
    turn.role === "assistant"
      && (options?.includeResolved || (!turn.applied && !turn.dismissed))
      && (!turnIds || turnIds.has(turn.id))
      ? {
          ...turn,
          applied: outcome === "applied",
          dismissed: outcome === "dismissed",
        }
      : turn,
  );
}

// R3 fix: a queued follow-up's RunParams snapshot the room's agentThreadId
// at compose time. If the in-flight run assigns a fresh agentThreadId (e.g.
// the room's very first run, composed while agentThreadId was still null),
// replaying the stale snapshot at dispatch time would make the follow-up
// start a brand-new provider thread and lose the conversation context.
// Re-resolve the room's current agentThreadId at drain time instead, falling
// back to the snapshot only if the room can no longer be found.
export function resolveQueuedRunAgentThreadId(
  rooms: AiEditChatRoom[],
  roomId: string,
  snapshotAgentThreadId: string | null,
): string | null {
  const room = rooms.find((candidate) => candidate.id === roomId);
  return room ? room.agentThreadId : snapshotAgentThreadId;
}

export function sortChatRooms(rooms: AiEditChatRoom[]): AiEditChatRoom[] {
  return rooms.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function createEmptyChatRoom(
  documentIdentityKey: string,
  documentTitle: string | undefined,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): AiEditChatRoom {
  const now = new Date().toISOString();
  return {
    version: 1,
    id: createChatRoomId(),
    documentIdentityKey,
    title: documentTitle?.trim() || getDefaultChatRoomTitle(t),
    agentThreadId: null,
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
}

function createChatRoomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `chat_${crypto.randomUUID()}`;
  }
  return `chat_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function createTurnId(prefix: "u" | "a"): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return `${prefix}_${crypto.randomUUID()}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

/**
 * 会話の既定タイトル。**この文字列は会話ごとに保存される** (D3: 作った時点の言語で焼く)。
 * 保存済みの部屋には別の言語の既定文が入っていることがあるので、
 * 「既定のままか」を判定するときは {@link isDefaultChatRoomTitle} を使うこと。
 * 文字列の直接比較は、言語が違うだけで別物と見なしてしまう。
 */
export function getDefaultChatRoomTitle(t: Translate<"ai"> = DEFAULT_AI_TRANSLATE): string {
  return t("chat.untitledRoom");
}

/**
 * 全ロケールの既定タイトル。**タスクドックは実行中ずっと再描画される**ので、
 * 行ごとにロケール数だけ `getFixedT` を作らないよう 1 度だけ組む。
 */
const DEFAULT_CHAT_ROOM_TITLES: ReadonlySet<string> = new Set(
  SUPPORTED_LOCALES.map((locale) => createTranslator(locale, "ai")("chat.untitledRoom")),
);

/** 保存済みタイトルが「まだ名前が付いていない」状態か。**全ロケールの既定文と照合する。** */
export function isDefaultChatRoomTitle(title: string | undefined | null): boolean {
  const trimmed = title?.trim();
  return !trimmed || DEFAULT_CHAT_ROOM_TITLES.has(trimmed);
}

export function createChatRoomTitle(
  instruction: string,
  documentTitle: string | undefined,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  const fallback = getDefaultChatRoomTitle(t);
  const source = instruction.trim() || documentTitle?.trim() || fallback;
  const firstLine = source.split(/\r?\n/).find((line) => line.trim().length > 0)?.trim() ?? fallback;
  return firstLine.length > 32 ? `${firstLine.slice(0, 32)}...` : firstLine;
}

export function summarizeAttachments(attachments: AiEditAttachment[]): DesktopAiEditChatAttachmentSummary[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    name: attachment.name,
    mimeType: attachment.mimeType ?? null,
    width: attachment.width ?? null,
    height: attachment.height ?? null,
    fileSize: attachment.fileSize ?? null,
    dataUrl: attachment.dataUrl,
    sourceReferenceKey: attachment.sourceReferenceKey ?? null,
  }));
}

export function summarizeMentionedDocuments(
  documents: AiEditMentionedDocumentContext[],
): DesktopAiEditChatMentionedDocumentSummary[] {
  return documents.map((document) => ({
    id: document.id,
    fileId: document.fileId,
    title: document.title,
    documentPath: document.documentPath,
    revision: document.revision,
  }));
}

export function fromDesktopChatRoom(room: DesktopAiEditChatRoom): AiEditChatRoom {
  return {
    ...room,
    turns: room.turns.map((turn) => {
      if (turn.role === "assistant") {
        return {
          ...turn,
          events: turn.events.map((event, index) => ({ ...event, id: index + 1 })),
          isRunning: false,
          restored: true,
        };
      }
      return turn;
    }),
  };
}

export function toDesktopChatRoom(room: AiEditChatRoom): DesktopAiEditChatRoom {
  return {
    ...room,
    turns: room.turns.map((turn) => {
      if (turn.role === "assistant") {
        return {
          ...turn,
          events: turn.events.map(toStoredAiEditEvent),
          isRunning: false,
        };
      }
      return turn;
    }),
  };
}

function toStoredAiEditEvent(event: UiAgentEvent): AiEditRunEvent {
  const storedEvent = { ...event } as AiEditRunEvent & { id?: number };
  delete storedEvent.id;
  return storedEvent;
}

type RoomsListener = () => void;

// ---------------------------------------------------------------------------
// Rooms store: the authoritative in-memory cache of chat rooms, keyed by room
// id. Survives AiEditPanel remounts. Disk (`desktop.aiEdit.listChatRooms`) is
// only consulted to seed rooms this store has not seen yet in this session —
// once a room is known here, this store is the one source of truth for it, so
// a run in flight when the panel remounts is never clobbered by a late disk
// read racing back in with an older snapshot.
class AiChatRoomsStore {
  private rooms = new Map<string, AiEditChatRoom>();
  private activeRoomIdByDocument = new Map<string, string | null>();
  // Which documents have had an explicit active-room selection made (via a
  // focus request or a user click), as opposed to just the load-time default.
  // Needed so the async disk load's "default to the newest room" behavior
  // never clobbers a selection made (or requested) while the load was still
  // in flight — the concrete Bug-3 fix.
  private explicitSelection = new Set<string>();
  private listeners = new Set<RoomsListener>();
  private snapshot: readonly AiEditChatRoom[] = [];

  subscribe = (listener: RoomsListener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): readonly AiEditChatRoom[] => this.snapshot;

  getRoom(roomId: string): AiEditChatRoom | null {
    return this.rooms.get(roomId) ?? null;
  }

  getRoomsForDocument(documentIdentityKey: string): AiEditChatRoom[] {
    return sortChatRooms(this.snapshot.filter((room) => room.documentIdentityKey === documentIdentityKey));
  }

  getActiveRoomId(documentIdentityKey: string): string | null {
    return this.activeRoomIdByDocument.get(documentIdentityKey) ?? null;
  }

  /** Explicit selection: a user click, a new room, or a focus-room request. */
  setActiveRoomId(documentIdentityKey: string, roomId: string | null): void {
    this.explicitSelection.add(documentIdentityKey);
    if (this.activeRoomIdByDocument.get(documentIdentityKey) === roomId) {
      return;
    }
    this.activeRoomIdByDocument.set(documentIdentityKey, roomId);
    this.emit();
  }

  addRoom(room: AiEditChatRoom, options: { makeActive?: boolean } = {}): void {
    this.rooms.set(room.id, room);
    if (options.makeActive) {
      this.explicitSelection.add(room.documentIdentityKey);
      this.activeRoomIdByDocument.set(room.documentIdentityKey, room.id);
    }
    this.emit();
  }

  /**
   * Merges rooms loaded from disk for a document. Any room already known to
   * the store is left untouched (it may already reflect a live run's more
   * recent, unsaved state). If nothing has explicitly selected an active room
   * for this document yet, defaults to the newest room — mirroring the
   * pre-R5 behavior, but only as a default, never an override.
   */
  hydrateDocument(documentIdentityKey: string, loadedRooms: AiEditChatRoom[]): void {
    let changed = false;
    for (const room of loadedRooms) {
      if (!this.rooms.has(room.id)) {
        this.rooms.set(room.id, room);
        changed = true;
      }
    }
    if (!this.explicitSelection.has(documentIdentityKey)) {
      const merged = sortChatRooms(Array.from(this.rooms.values()).filter((room) => room.documentIdentityKey === documentIdentityKey));
      const defaultRoomId = merged[0]?.id ?? null;
      if (this.activeRoomIdByDocument.get(documentIdentityKey) !== defaultRoomId) {
        this.activeRoomIdByDocument.set(documentIdentityKey, defaultRoomId);
        changed = true;
      }
    }
    if (changed) {
      this.emit();
    }
  }

  updateRoom(roomId: string, updater: (room: AiEditChatRoom) => AiEditChatRoom): AiEditChatRoom | null {
    const current = this.rooms.get(roomId);
    if (!current) {
      return null;
    }
    const next = updater(current);
    this.rooms.set(roomId, next);
    this.emit();
    return next;
  }

  private emit(): void {
    this.snapshot = Array.from(this.rooms.values());
    this.listeners.forEach((listener) => listener());
  }
}

export const aiChatRoomsStore = new AiChatRoomsStore();

export function useAiChatRoomsForDocument(documentIdentityKey: string): AiEditChatRoom[] {
  const all = useSyncExternalStore(aiChatRoomsStore.subscribe, aiChatRoomsStore.getSnapshot, aiChatRoomsStore.getSnapshot);
  return useMemo(
    () => sortChatRooms(all.filter((room) => room.documentIdentityKey === documentIdentityKey)),
    [all, documentIdentityKey],
  );
}

export function useAiActiveRoomId(documentIdentityKey: string): string | null {
  return useSyncExternalStore(
    aiChatRoomsStore.subscribe,
    () => aiChatRoomsStore.getActiveRoomId(documentIdentityKey),
    () => aiChatRoomsStore.getActiveRoomId(documentIdentityKey),
  );
}

function saveRoomQuietly(room: AiEditChatRoom): void {
  const desktop = getDesktopBridge();
  if (!desktop?.aiEdit?.saveChatRoom) {
    return;
  }
  desktop.aiEdit.saveChatRoom(toDesktopChatRoom(room)).then((result) => {
    if (!result.ok) {
      console.warn("Failed to save the AI chat history.", result.error);
    }
  }).catch((error) => {
    // Best-effort persistence: a run's progress must never be lost just
    // because a save races with e.g. the app closing. AiEditPanel's own
    // direct room edits (dismiss/retry/rename) surface a historyError; a
    // background run's periodic saves are not worth interrupting the user
    // for, so this just logs.
    console.warn("Failed to save the AI chat history.", error);
  });
}

function updateRoomAndMaybePersist(
  roomId: string,
  updater: (room: AiEditChatRoom) => AiEditChatRoom,
  options: { persist?: boolean } = {},
): AiEditChatRoom | null {
  const next = aiChatRoomsStore.updateRoom(roomId, updater);
  if (next && options.persist !== false) {
    saveRoomQuietly(next);
  }
  return next;
}

let eventSeq = 0;

function appendEventToTurn(roomId: string, turnId: string, event: AiEditRunEvent): void {
  updateRoomAndMaybePersist(roomId, (room) => ({
    ...room,
    turns: room.turns.map((turn) => {
      if (turn.id !== turnId || turn.role !== "assistant") {
        return turn;
      }

      // Plan snapshots replace the stored plan and render separately from the
      // event feed.
      if (event.kind === "plan") {
        return {
          ...turn,
          planSteps: event.planSteps ?? [],
          planExplanation: event.planExplanation ?? null,
        };
      }

      // Reasoning deltas feed the live reasoning paragraph only; they would be
      // redundant as event-feed rows alongside the per-item activity entries.
      if (event.kind === "stream" && event.channel === "reasoning") {
        return event.delta
          ? { ...turn, reasoningText: limitLiveStreamText(`${turn.reasoningText}${event.delta}`) }
          : turn;
      }

      const previous = turn.events[turn.events.length - 1];
      let nextEvents: UiAgentEvent[];
      if (event.kind === "activity" && event.itemId) {
        // Merge item lifecycle: started → completed updates the same row.
        const existingIndex = turn.events.findIndex(
          (item) => item.kind === "activity" && item.itemId === event.itemId,
        );
        if (existingIndex >= 0) {
          nextEvents = turn.events.slice();
          nextEvents[existingIndex] = {
            ...nextEvents[existingIndex],
            ...event,
            id: nextEvents[existingIndex].id,
          };
        } else {
          eventSeq += 1;
          nextEvents = [
            ...turn.events.slice(Math.max(0, turn.events.length - MAX_AGENT_EVENTS + 1)),
            { ...event, id: eventSeq },
          ];
        }
      } else if (
        previous &&
        event.kind === "stream" &&
        previous.kind === "stream" &&
        previous.channel === event.channel
      ) {
        nextEvents = [
          ...turn.events.slice(0, -1),
          { ...previous, ...event, id: previous.id },
        ];
      } else {
        eventSeq += 1;
        nextEvents = [
          ...turn.events.slice(Math.max(0, turn.events.length - MAX_AGENT_EVENTS + 1)),
          { ...event, id: eventSeq },
        ];
      }

      // Output-channel deltas (reasoning is handled above) feed the raw stream view.
      const nextStream =
        event.kind === "stream" && event.delta
          ? limitLiveStreamText(`${turn.streamText}${event.delta}`)
          : turn.streamText;

      return {
        ...turn,
        events: nextEvents,
        streamText: nextStream,
      };
    }),
    updatedAt: new Date().toISOString(),
  }), { persist: false });
}

// Per-room stale-run guard (R1): each room runs its own monotonically
// increasing sequence number, so a run started in room A finishing (or a
// later event arriving) can never be shadowed or corrupted by activity in
// room B, and a panel remount can never invalidate or duplicate an in-flight
// run (there is nothing per-instance left for a remount to reset).
const runSeqByRoom = new Map<string, number>();
// Full request payload for a queued follow-up (R3), keyed by the queued
// user-turn id. The run-session store only tracks lightweight display data
// (instruction text) for queued messages; the actual provider request
// (attachments, resolved reference, model settings, ...) lives here so that
// store stays a plain, provider-agnostic data store.
const pendingRunParams = new Map<string, RunParams>();

// assistantTurnId -> the underlying desktop IPC runId for that turn's
// in-flight ai-edit:run call. Populated via runAiEditViaDesktopRuntime's
// onRunId callback (fired synchronously, before the call resolves) and
// cleared once the run settles either way. This is the id a future stop/
// cancel UI action needs to pass to cancelAiEditViaDesktopRuntime() -- it is
// NOT the same id as assistantTurnId, which is only a UI-level chat-turn key.
const activeAiEditRunIds = new Map<string, string>();

// Cross-room target serialization: two runs whose body-block or overlay-shape
// target sets overlap must never execute concurrently. A conflicting run waits
// in FIFO order with its session status set to "waiting" until all blockers
// finish. The scheduling itself is pure (ai-run-anchor-queue.ts, independently
// unit tested); this map holds what a waiting run needs once it is dispatched.
const anchorRunQueue = new AiRunAnchorQueue();
interface PendingAnchorRun {
  roomId: string;
  params: RunParams;
  assistantTurnId: string;
  isCurrentRun: () => boolean;
}
const pendingAnchorRuns = new Map<string, PendingAnchorRun>();

/**
 * Normalizes an anchor into the target sets used for overlap scheduling.
 * `primaryBlockId` is included for body runs as a legacy/safety fallback, but
 * a shape-only run's primary block is only widget placement and is therefore
 * not a body target. Completely anchor-less runs keep the previous behavior:
 * they bypass the cross-room queue.
 */
function resolveAnchorQueueTarget(anchor: AiRunAnchor): AiRunAnchorQueueTarget | null {
  const blockIds = new Set(anchor.blockIds);
  const shapeIds = Array.from(new Set(anchor.shapeIds));
  if (anchor.primaryBlockId && (blockIds.size > 0 || shapeIds.length === 0)) {
    blockIds.add(anchor.primaryBlockId);
  }
  if (blockIds.size === 0 && shapeIds.length === 0) {
    return null;
  }
  return {
    documentKey: anchor.documentId ?? "",
    blockIds: Array.from(blockIds),
    shapeIds,
  };
}

/**
 * 走行中run のanchorと新しい依頼のanchorが「同一箇所」を指しているかの判定 (別箇所は並列・
 * 同一箇所は直列、の分岐に使う)。本文ブロック集合または図形集合に交差があれば同一箇所と
 * 判定する。どちらかに明示ターゲットが無い依頼 (全文依頼など) は同一扱いに倒す —
 * その場合は従来どおり同じ会話へのフォローアップとしてキューされる。
 */
export function isSameAiRunTarget(current: AiRunAnchor | null | undefined, next: AiRunAnchor): boolean {
  if (!current) {
    return true;
  }
  const currentTarget = resolveAnchorQueueTarget(current);
  const nextTarget = resolveAnchorQueueTarget(next);
  if (!currentTarget || !nextTarget) {
    return true;
  }
  return doAiRunAnchorQueueTargetsOverlap(currentTarget, nextTarget);
}

function dispatchReadyAnchorRuns(items: readonly AiRunAnchorQueueItem[]): void {
  for (const item of items) {
    const pending = pendingAnchorRuns.get(item.runKey);
    pendingAnchorRuns.delete(item.runKey);
    if (!pending) {
      continue;
    }
    aiRunSessionStore.setStatus(pending.roomId, "preparing");
    void executeRun(pending.roomId, pending.params, pending.assistantTurnId, pending.isCurrentRun);
  }
}

/** Releases `assistantTurnId`'s target set and dispatches every FIFO-safe run
 * that is no longer blocked by an overlapping active/older queued run. */
function releaseAnchorAndDispatchNext(assistantTurnId: string): void {
  dispatchReadyAnchorRuns(anchorRunQueue.release(assistantTurnId));
}

function bumpRoomRunSeq(roomId: string): number {
  const next = (runSeqByRoom.get(roomId) ?? 0) + 1;
  runSeqByRoom.set(roomId, next);
  return next;
}

export interface StartRunResult {
  userTurnId: string | null;
  assistantTurnId: string;
}

// AiEditPanel の MAX_AI_EDIT_ATTACHMENTS / MAX_AI_EDIT_MENTIONED_DOCUMENTS と同じ値。
// (コンポーネントモジュールからの import は循環になるため、ここに定数として持つ。)
const MAX_MERGED_ATTACHMENTS = 4;
const MAX_MERGED_MENTIONED_DOCUMENTS = 4;

/**
 * items (時系列順: 古い→新しい) を key で重複排除する。同じ key が複数あれば「最後
 * (=最も新しいメッセージ由来)」の内容を残し、残した要素はその最後の出現位置のまま
 * (=時系列順を保つ)。キューされたフォローアップのマージで新しい方の内容を
 * 優先させたい場合に使う (先勝ちの単純dedupeだと古い方の内容が残ってしまう)。
 */
function dedupeByKeyKeepLatest<T>(items: T[], keyOf: (item: T) => string): T[] {
  const lastIndexByKey = new Map<string, number>();
  items.forEach((item, index) => {
    lastIndexByKey.set(keyOf(item), index);
  });
  const keepIndices = new Set(lastIndexByKey.values());
  return items.filter((_, index) => keepIndices.has(index));
}

/**
 * 上限 max を適用する際、配列の先頭(古い方)ではなく末尾(新しい方)を優先して残す。
 * items は時系列順 (古い→新しい) を前提とし、返り値もその順序のまま。
 */
function capKeepingLatest<T>(items: T[], max: number): T[] {
  return items.length <= max ? items : items.slice(items.length - max);
}

/**
 * キュー済みフォローアップ複数件を1turnへまとめる (R3)。指示文の連結だけでなく、
 * 参照・添付・メンション教材・スキルも key ベースで concat+dedupe して保持する
 * (以前は最後のメッセージのもの以外が捨てられていた)。モデル設定などの残りの
 * フィールドは従来どおり最後のメッセージのスナップショットを使う。
 *
 * 上限 (MAX_AI_EDIT_REFERENCES など) を超える場合は、古い(先に送られた)メッセージ側
 * ではなく最新(=messageParams、最後にキューされたメッセージ)側を優先して残す —
 * 単純に先頭からslice(0, max)すると、最後に送ったメッセージの参照/添付/メンションが
 * 静かに切り捨てられてしまうため (呼び出しは常に merged=これまでの累積(古い),
 * messageParams=次に畳み込む1件(新しい) の順で reduce される)。
 */
export function mergeQueuedRunParams(merged: RunParams, messageParams: RunParams): RunParams {
  return {
    ...messageParams,
    anchor: {
      ...messageParams.anchor,
      blockIds: Array.from(new Set([...merged.anchor.blockIds, ...messageParams.anchor.blockIds])),
      shapeIds: Array.from(new Set([...merged.anchor.shapeIds, ...messageParams.anchor.shapeIds])),
      ...(
        merged.anchor.blockShimmerScopes || messageParams.anchor.blockShimmerScopes
          ? {
              blockShimmerScopes: dedupeByKeyKeepLatest(
                [...(merged.anchor.blockShimmerScopes ?? []), ...(messageParams.anchor.blockShimmerScopes ?? [])],
                (scope) => scope.kind === "block"
                  ? `${scope.kind}:${scope.blockId}`
                  : scope.kind === "inlineMath"
                    ? `${scope.kind}:${scope.blockId}:${scope.mathInlineId}`
                    : `${scope.kind}:${scope.blockId}:${scope.from}:${scope.to}`,
              ),
            }
          : {}
      ),
    },
    turnInstruction: `${merged.turnInstruction}\n\n${messageParams.turnInstruction}`.trim(),
    turnReferences: capKeepingLatest(
      dedupeByKeyKeepLatest(
        [...merged.turnReferences, ...messageParams.turnReferences],
        getAiEditReferenceKey,
      ),
      MAX_AI_EDIT_REFERENCES,
    ),
    turnAttachments: capKeepingLatest(
      dedupeByKeyKeepLatest(
        [...merged.turnAttachments, ...messageParams.turnAttachments],
        (attachment) => attachment.id,
      ),
      MAX_MERGED_ATTACHMENTS,
    ),
    turnMentionedDocuments: capKeepingLatest(
      dedupeByKeyKeepLatest(
        [...merged.turnMentionedDocuments, ...messageParams.turnMentionedDocuments],
        (mentioned) => mentioned.fileId,
      ),
      MAX_MERGED_MENTIONED_DOCUMENTS,
    ),
    turnAiResourceIds: Array.from(new Set([...merged.turnAiResourceIds, ...messageParams.turnAiResourceIds])),
  };
}

/**
 * Runs (or re-runs, for a dequeued follow-up) a single turn against a room.
 * `queuedTurnIds`, when present, means this call is dispatching messages that
 * were queued while the room's previous run was still in flight (R3): those
 * user turns already exist in the transcript (rendered immediately as
 * "queued" when the user sent them), so this call attaches one new assistant
 * turn to them instead of creating another user turn.
 *
 * The turn/session bookkeeping happens synchronously (so callers can use the
 * returned ids immediately, e.g. to scroll to the new turn); the actual
 * provider call and its effects run asynchronously and are entirely
 * self-contained here, so they keep going — and land their result in the
 * right place — no matter what happens to whichever AiEditPanel instance
 * initiated them.
 */
export function startRun(roomId: string, params: RunParams, queuedTurnIds: string[] = []): StartRunResult {
  const startedAt = Date.now();
  const assistantTurnId = createTurnId("a");
  const runSeq = bumpRoomRunSeq(roomId);
  const isCurrentRun = () => runSeqByRoom.get(roomId) === runSeq;
  const anchor = params.anchor;

  const newUserTurnId = queuedTurnIds.length === 0 ? createTurnId("u") : null;
  const newUserTurn: UserTurn | null = newUserTurnId
    ? {
        id: newUserTurnId,
        role: "user",
        documentIdentityKey: params.runDocumentIdentityKey,
        instruction: params.turnInstruction,
        references: params.turnReferences,
        attachments: summarizeAttachments(params.turnAttachments),
        mentionedDocuments: summarizeMentionedDocuments(params.turnMentionedDocuments),
        timestamp: startedAt,
      }
    : null;

  eventSeq += 1;
  const initialAssistantEvent: UiAgentEvent = {
    id: eventSeq,
    kind: "phase",
    phase: "preparing",
    // 画面では `phase` からラベルを引き直すので、これは経路が変わったときの保険。
    message: tAiNow("activity.phase.preparing"),
    timestamp: startedAt,
  };
  const assistantTurn: AssistantTurn = {
    id: assistantTurnId,
    role: "assistant",
    documentIdentityKey: params.runDocumentIdentityKey,
    references: params.turnReferences,
    events: [initialAssistantEvent],
    streamText: "",
    reasoningText: "",
    planSteps: [],
    planExplanation: null,
    startedAt,
    endedAt: null,
    isRunning: true,
    result: null,
    targetId: null,
    error: null,
    applied: false,
    dismissed: false,
    restored: false,
  };

  updateRoomAndMaybePersist(roomId, (room) => ({
    ...room,
    title: room.turns.length === 0
      ? createChatRoomTitle(params.turnInstruction || tAiNow("chat.imageToMaterial"), room.title, tAiNow)
      : room.title,
    // Bind the room to the provider of its first run; later runs keep it (the
    // composer locks the provider once this is set — only reasoning effort
    // stays adjustable) so a conversation never switches providers mid-thread.
    provider: room.provider ?? params.turnProvider,
    turns: [
      ...room.turns.map((turn) => {
        if (turn.role === "user" && queuedTurnIds.includes(turn.id)) {
          return { ...turn, queued: false, queueFailed: false };
        }
        return turn.role === "assistant" && !turn.applied && !turn.dismissed && turn.result
          ? { ...turn, dismissed: true }
          : turn;
      }),
      ...(newUserTurn ? [newUserTurn] : []),
      assistantTurn,
    ],
    updatedAt: new Date(startedAt).toISOString(),
  }));

  aiRunSessionStore.startRun(roomId, {
    runId: assistantTurnId,
    provider: params.turnProvider,
    anchor,
    startedAt,
  });

  // Cross-room target serialization: overlapping body/shape target sets wait;
  // disjoint sets execute concurrently even if their widget placement block
  // happens to be the same.
  const queueTarget = resolveAnchorQueueTarget(anchor);
  const acquireResult = queueTarget
    ? anchorRunQueue.acquire(queueTarget, { runKey: assistantTurnId, roomId })
    : "acquired";
  if (acquireResult === "acquired") {
    void executeRun(roomId, params, assistantTurnId, isCurrentRun);
  } else {
    aiRunSessionStore.setStatus(roomId, "waiting");
    pendingAnchorRuns.set(assistantTurnId, { roomId, params, assistantTurnId, isCurrentRun });
  }

  return { userTurnId: newUserTurnId ?? queuedTurnIds[0] ?? null, assistantTurnId };
}

/** Label surfaced with a run's MCP proposals (`sessionLabel`) and in the AI
 * task dock -- the room's title once it has one (set from the first turn's
 * instruction, see `createChatRoomTitle`), falling back to this turn's own
 * instruction excerpt for the rare case the room lookup fails. */
function resolveRunSessionLabel(roomId: string, params: RunParams): string | undefined {
  const title = aiChatRoomsStore.getRoom(roomId)?.title?.trim();
  if (title) {
    return title;
  }
  const instruction = params.turnInstruction.trim();
  if (!instruction) {
    return undefined;
  }
  return instruction.length > 40 ? `${instruction.slice(0, 40)}...` : instruction;
}

async function executeRun(
  roomId: string,
  params: RunParams,
  assistantTurnId: string,
  isCurrentRun: () => boolean,
): Promise<void> {
  try {
    const nextResult = await runAiEditViaDesktopRuntime({
      provider: params.turnProvider,
      fileId: params.runDocumentIdentityKey,
      model: params.turnModel,
      reasoningEffort: params.turnReasoningEffort,
      instruction: params.turnInstruction,
      document: params.runDocument,
      selectedId: params.aiTargetId,
      references: params.turnReferences,
      roomId,
      turnId: assistantTurnId,
      sessionLabel: resolveRunSessionLabel(roomId, params),
      attachments: params.turnAttachments,
      mentionedDocuments: params.turnMentionedDocuments,
      aiResourceIds: params.turnAiResourceIds,
      agentThreadId: params.runAgentThreadId,
      onRunId: (runId) => {
        activeAiEditRunIds.set(assistantTurnId, runId);
      },
      onEvent: (event) => {
        if (isCurrentRun()) {
          appendEventToTurn(roomId, assistantTurnId, event);
          aiRunSessionStore.appendEvent(roomId, event);
        }
      },
    });
    activeAiEditRunIds.delete(assistantTurnId);
    releaseAnchorAndDispatchNext(assistantTurnId);
    if (!isCurrentRun()) {
      return;
    }

    const endedAt = Date.now();
    // 実行時に選ばれた主targetを正本にする。複数pinの先頭は追加コンテキストであり、
    // 現在選択中のtargetとは限らない (却下理由つき再実行もこのtargetIdを使う)。
    const targetId = params.aiTargetId ?? nextResult.draft.operations[0]?.targetId ?? params.turnReferences[0]?.targetId ?? null;
    updateRoomAndMaybePersist(roomId, (room) => ({
      ...room,
      agentThreadId: nextResult.agentThreadId ?? room.agentThreadId,
      turns: room.turns.map((turn) => {
        if (turn.id !== assistantTurnId || turn.role !== "assistant") {
          return turn;
        }
        return { ...turn, result: nextResult, targetId, endedAt, isRunning: false, restored: false };
      }),
      updatedAt: new Date(endedAt).toISOString(),
    }));
    aiRunSessionStore.completeRun(roomId, { endedAt });
  } catch (error) {
    activeAiEditRunIds.delete(assistantTurnId);
    releaseAnchorAndDispatchNext(assistantTurnId);
    if (!isCurrentRun()) {
      return;
    }
    const errorMessage = error instanceof Error ? error.message : tAiNow("run.failed");
    const endedAt = Date.now();
    appendEventToTurn(roomId, assistantTurnId, { kind: "error", phase: "complete", message: errorMessage, timestamp: endedAt });
    updateRoomAndMaybePersist(roomId, (room) => ({
      ...room,
      turns: room.turns.map((turn) =>
        turn.id === assistantTurnId && turn.role === "assistant"
          ? { ...turn, error: errorMessage, endedAt, isRunning: false, restored: false }
          : turn,
      ),
      updatedAt: new Date(endedAt).toISOString(),
    }));
    aiRunSessionStore.failRun(roomId, errorMessage, { endedAt });
  }

  if (!isCurrentRun()) {
    return;
  }

  // R3: draining the queue only on success (never on failure — a failed run
  // leaves its queued messages visible as "unsent" with a resend affordance
  // instead of silently dropping or auto-retrying them).
  const session = aiRunSessionStore.getSession(roomId);
  if (session?.status === "completed") {
    const drained = aiRunSessionStore.dequeueMessages(roomId);
    if (drained.length > 0) {
      const followUpParams = drained.reduce<RunParams | null>((merged, message) => {
        const messageParams = pendingRunParams.get(message.id);
        pendingRunParams.delete(message.id);
        if (!messageParams) {
          return merged;
        }
        if (!merged) {
          return messageParams;
        }
        return mergeQueuedRunParams(merged, messageParams);
      }, null);
      if (followUpParams) {
        const resolvedFollowUpParams = {
          ...followUpParams,
          runAgentThreadId: resolveQueuedRunAgentThreadId(
            aiChatRoomsStore.getRoomsForDocument(followUpParams.runDocumentIdentityKey),
            roomId,
            followUpParams.runAgentThreadId,
          ),
        };
        startRun(roomId, resolvedFollowUpParams, drained.map((message) => message.id));
      }
    }
  } else if (session?.status === "failed") {
    const drained = aiRunSessionStore.dequeueMessages(roomId);
    if (drained.length > 0) {
      drained.forEach((message) => pendingRunParams.delete(message.id));
      updateRoomAndMaybePersist(roomId, (room) => ({
        ...room,
        turns: room.turns.map((turn) =>
          turn.role === "user" && drained.some((message) => message.id === turn.id)
            ? { ...turn, queued: false, queueFailed: true }
            : turn,
        ),
        updatedAt: new Date().toISOString(),
      }), { persist: false });
    }
  }
}

/**
 * Requests cancellation of an in-flight run started by startRun(), given the
 * assistantTurnId returned from it. This only asks the main process to kill
 * the underlying provider turn (via ai-edit:cancel); it deliberately does not
 * touch chat/session state here -- executeRun's existing success path already
 * lands the resulting `status: "cancelled"` AiEditRunResult and flips
 * isRunning to false once the main process resolves, so there is only one
 * code path that updates the turn instead of two racing writers.
 *
 * No-ops (including when the run already settled, or never got a runId in
 * time) since this is a best-effort stop request, not a state transition.
 *
 * Also handles a run that is currently "waiting" in the same-anchor queue
 * (ai-run-anchor-queue.ts) rather than actually executing yet -- there is no
 * IPC run to cancel in that case, so this dequeues it directly and fails the
 * turn locally instead.
 *
 * Returns the underlying IPC cancel result so a caller that cares whether the
 * request actually landed (e.g. the AI-edit-lock hover "stop" button, which
 * shows a failure message on a rejected/failed cancel) can await it. Existing
 * fire-and-forget callers are free to ignore the returned promise, exactly as
 * before.
 */
export function cancelRun(assistantTurnId: string): Promise<{ ok: boolean; cancelled: boolean }> {
  const runId = activeAiEditRunIds.get(assistantTurnId);
  if (runId) {
    return cancelAiEditViaDesktopRuntime(runId);
  }

  const pending = pendingAnchorRuns.get(assistantTurnId);
  if (!pending) {
    return Promise.resolve({ ok: false, cancelled: false });
  }
  const readyAfterCancellation = anchorRunQueue.cancelQueued(assistantTurnId);
  if (readyAfterCancellation === null) {
    return Promise.resolve({ ok: false, cancelled: false });
  }
  pendingAnchorRuns.delete(assistantTurnId);
  if (!pending.isCurrentRun()) {
    dispatchReadyAnchorRuns(readyAfterCancellation);
    return Promise.resolve({ ok: false, cancelled: false });
  }
  const endedAt = Date.now();
  const message = tAiNow("run.cancelledWhileWaiting");
  appendEventToTurn(pending.roomId, assistantTurnId, { kind: "error", phase: "complete", message, timestamp: endedAt });
  updateRoomAndMaybePersist(pending.roomId, (room) => ({
    ...room,
    turns: room.turns.map((turn) =>
      turn.id === assistantTurnId && turn.role === "assistant"
        ? { ...turn, error: message, endedAt, isRunning: false, restored: false }
        : turn,
    ),
    updatedAt: new Date(endedAt).toISOString(),
  }));
  aiRunSessionStore.failRun(pending.roomId, message, { endedAt });
  dispatchReadyAnchorRuns(readyAfterCancellation);
  return Promise.resolve({ ok: true, cancelled: true });
}

/**
 * Queues a follow-up message behind a room's in-flight run (R3). Renders
 * immediately as a "送信待ち" turn; dispatched automatically (merged with any
 * other queued messages) once the in-flight run settles.
 */
export function enqueueFollowUp(roomId: string, params: RunParams): string {
  const queuedTurnId = createTurnId("u");
  pendingRunParams.set(queuedTurnId, params);
  const queuedUserTurn: UserTurn = {
    id: queuedTurnId,
    role: "user",
    documentIdentityKey: params.runDocumentIdentityKey,
    instruction: params.turnInstruction,
    references: params.turnReferences,
    attachments: summarizeAttachments(params.turnAttachments),
    mentionedDocuments: summarizeMentionedDocuments(params.turnMentionedDocuments),
    timestamp: Date.now(),
    queued: true,
  };
  // Not persisted yet: this is provisional until the run actually starts, at
  // which point `startRun` writes (and persists) it as a normal turn.
  updateRoomAndMaybePersist(roomId, (room) => ({
    ...room,
    turns: [...room.turns, queuedUserTurn],
    updatedAt: new Date().toISOString(),
  }), { persist: false });
  aiRunSessionStore.enqueueMessage(roomId, {
    id: queuedTurnId,
    instruction: params.turnInstruction || tAiNow("chat.attachmentsOnly"),
    createdAt: Date.now(),
  });
  return queuedTurnId;
}

/** Simple room mutations triggered directly by the user (dismiss/retry/resend,
 * proposal-card resolution). These don't need remount-proofing on their own —
 * they only ever run synchronously in response to something the user just did
 * in a currently-mounted panel — but they still go through the shared store so
 * the room list and any other subscriber stay in sync. */
export function updateChatRoom(
  roomId: string,
  updater: (room: AiEditChatRoom) => AiEditChatRoom,
  options: { persist?: boolean } = {},
): AiEditChatRoom | null {
  return updateRoomAndMaybePersist(roomId, updater, options);
}

export function addChatRoom(room: AiEditChatRoom, options: { makeActive?: boolean; persist?: boolean } = {}): void {
  aiChatRoomsStore.addRoom(room, { makeActive: options.makeActive });
  if (options.persist !== false) {
    saveRoomQuietly(room);
  }
}

export function selectChatRoom(documentIdentityKey: string, roomId: string): void {
  aiChatRoomsStore.setActiveRoomId(documentIdentityKey, roomId);
}

export function hydrateChatRoomsFromDisk(documentIdentityKey: string, loadedRooms: AiEditChatRoom[]): void {
  aiChatRoomsStore.hydrateDocument(documentIdentityKey, loadedRooms);
}

// ---------------------------------------------------------------------------
// Rejection feedback loop: a reasoned 破棄 (reject with a reason) should not be
// a dead end -- it feeds a follow-up turn back to the same room/agent thread so
// the next proposal can account for why the previous one was rejected.

export interface RejectionFeedbackParams {
  roomId: string;
  /** The rejected proposal's originating assistant turn, if known -- reused to
   * target the same block/reference the follow-up should refocus on. */
  turnId?: string | null;
  reason: string;
  proposalSummaries: string[];
  documentIdentityKey: string;
  document: SigmaDocument;
}

export type RejectionFeedbackOutcome = "started" | "queued" | "skipped";

function resolveFollowUpModel(provider: AiProvider): string {
  const preferences = getAiModelPreferences();
  if (provider === "claude") {
    return preferences.claudeModel;
  }
  if (provider === "antigravity") {
    return preferences.geminiModel;
  }
  return preferences.model;
}

/**
 * Submits a reasoned rejection as feedback to the room it came from: builds the
 * fixed Japanese instruction template and either starts it immediately (no live
 * run in that room) or queues it behind the room's in-flight run via the
 * existing `enqueueFollowUp` (R3) mechanism -- this never starts a second,
 * concurrent run in a room that already has one.
 *
 * No-ops ("skipped") when the reason is blank or the room is no longer known
 * to this store (e.g. it was never loaded in this session).
 */
export function submitRejectionFeedback(params: RejectionFeedbackParams): RejectionFeedbackOutcome {
  const reason = params.reason.trim();
  if (!reason) {
    return "skipped";
  }
  const room = aiChatRoomsStore.getRoom(params.roomId);
  if (!room) {
    return "skipped";
  }

  const sourceTurn = params.turnId
    ? (room.turns.find((turn) => turn.id === params.turnId && turn.role === "assistant") as AssistantTurn | undefined)
    : undefined;
  const provider = room.provider ?? "chatgpt";

  const runParams: RunParams = {
    runDocumentIdentityKey: params.documentIdentityKey,
    runAgentThreadId: room.agentThreadId,
    runDocument: params.document,
    turnReferences: sourceTurn?.references ?? [],
    turnAttachments: [],
    turnMentionedDocuments: [],
    turnProvider: provider,
    turnAiResourceIds: [],
    turnInstruction: buildRejectionFeedbackInstruction(reason, params.proposalSummaries),
    turnModel: resolveFollowUpModel(provider),
    turnReasoningEffort: getAiModelPreferences().reasoningEffort,
    aiTargetId: sourceTurn?.targetId ?? null,
    anchor: createAiRunAnchor({
      primaryBlockId: sourceTurn?.targetId ?? null,
      documentId: params.documentIdentityKey,
      document: params.document,
      references: sourceTurn?.references ?? [],
    }),
  };

  if (aiRunSessionStore.isRunning(params.roomId)) {
    enqueueFollowUp(params.roomId, runParams);
    return "queued";
  }

  startRun(params.roomId, runParams);
  return "started";
}
