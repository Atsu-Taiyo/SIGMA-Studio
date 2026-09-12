import { beforeEach, describe, expect, it, vi } from "vitest";

import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import type { AiEditReference } from "@/lib/ai/ai-edit-reference";

import { aiRunSessionStore } from "./ai-run-session-store";
import {
  addChatRoom,
  aiChatRoomsStore,
  buildRejectionFeedbackInstruction,
  cancelRun,
  createAiRunAnchor,
  createEmptyChatRoom,
  enqueueFollowUp,
  hydrateChatRoomsFromDisk,
  isSameAiRunTarget,
  mergeQueuedRunParams,
  selectChatRoom,
  startRun,
  submitRejectionFeedback,
  type AiEditChatRoom,
  type AssistantTurn,
  type RunParams,
  type UserTurn,
} from "./ai-run-controller";

// The provider call is fully controllable per-test: each runAiEditViaDesktopRuntime
// invocation returns a promise the test resolves/rejects explicitly.
type Deferred = {
  resolve: (result: AiEditRunResult) => void;
  reject: (error: Error) => void;
  request: {
    instruction: string;
    agentThreadId?: string | null;
    references?: AiEditReference[];
    attachments?: RunParams["turnAttachments"];
    mentionedDocuments?: RunParams["turnMentionedDocuments"];
    aiResourceIds?: string[];
    onRunId?: (runId: string) => void;
    onEvent?: (event: AiEditRunEvent) => void;
  };
};
const pendingRuns: Deferred[] = [];
const cancelledRunIds: string[] = [];

vi.mock("@/lib/ai/codex-ai-edit-client", () => ({
  runAiEditViaDesktopRuntime: vi.fn((request: Deferred["request"]) =>
    new Promise((resolve, reject) => {
      // Mirrors the real desktop bridge: onRunId fires synchronously, before
      // the run settles, so cancelRun() has a runId to act on immediately.
      request.onRunId?.(`runid-${pendingRuns.length}`);
      pendingRuns.push({ resolve, reject, request });
    })),
  cancelAiEditViaDesktopRuntime: vi.fn(async (runId: string) => {
    cancelledRunIds.push(runId);
    return { ok: true, cancelled: true };
  }),
}));

const savedRooms: { id: string; turns: unknown[]; agentThreadId: string | null }[] = [];

vi.mock("@/lib/desktop-bridge", () => ({
  getDesktopBridge: () => ({
    aiEdit: {
      saveChatRoom: (room: { id: string; turns: unknown[]; agentThreadId: string | null }) => {
        savedRooms.push(room);
        return Promise.resolve({ ok: true });
      },
    },
  }),
}));

function makeRunResult(overrides: Partial<AiEditRunResult> = {}): AiEditRunResult {
  return {
    draft: { summary: "done", plan: [], warnings: [], operations: [] },
    nextDocument: {},
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
    ...overrides,
  } as unknown as AiEditRunResult;
}

function makeRunParams(documentId: string, overrides: Partial<RunParams> = {}): RunParams {
  return {
    runDocumentIdentityKey: documentId,
    runAgentThreadId: null,
    runDocument: { version: "2.0", docId: documentId, metadata: { title: "t" }, content: [], outputProfiles: {} } as unknown as RunParams["runDocument"],
    turnReferences: [],
    turnAttachments: [],
    turnMentionedDocuments: [],
    turnProvider: "chatgpt",
    turnAiResourceIds: [],
    turnInstruction: "編集して",
    turnModel: "gpt-5",
    turnReasoningEffort: "medium",
    aiTargetId: "block-1",
    anchor: makeAnchor("block-1", documentId),
    ...overrides,
  };
}

function makeAnchor(
  primaryBlockId: string | null,
  documentId?: string,
  blockIds: string[] = primaryBlockId ? [primaryBlockId] : [],
  shapeIds: string[] = [],
): RunParams["anchor"] {
  return { primaryBlockId, blockIds, shapeIds, ...(documentId ? { documentId } : {}) };
}

function makeReference(targetId: string): AiEditReference {
  return {
    kind: "block",
    targetId,
    targetType: "paragraph",
    excerpt: `抜粋 ${targetId}`,
  };
}

function makeAttachment(id: string): RunParams["turnAttachments"][number] {
  return {
    id,
    name: `${id}.png`,
    mimeType: "image/png",
    dataUrl: "data:image/png;base64,AAAA",
  };
}

function makeMentionedDocument(fileId: string): RunParams["turnMentionedDocuments"][number] {
  return {
    id: `mention_${fileId}`,
    fileId,
    title: `教材 ${fileId}`,
    documentPath: `/docs/${fileId}`,
    revision: 1,
    excerpt: "抜粋",
    document: { version: "2.0", docId: fileId, metadata: { title: "t" }, content: [], outputProfiles: {} } as unknown as RunParams["turnMentionedDocuments"][number]["document"],
  };
}

let seq = 0;
function freshIds() {
  seq += 1;
  return { documentId: `doc-${seq}`, title: `タイトル${seq}` };
}

function addRoom(documentId: string): AiEditChatRoom {
  const room = createEmptyChatRoom(documentId, "テスト教材");
  addChatRoom(room, { makeActive: true });
  return room;
}

async function flushMicrotasks(): Promise<void> {
  // startRun's executeRun continuation chains a couple of awaits; a few
  // microtask turns let it run to completion after the deferred settles.
  for (let i = 0; i < 8; i += 1) {
    await Promise.resolve();
  }
}

beforeEach(() => {
  pendingRuns.length = 0;
  savedRooms.length = 0;
  cancelledRunIds.length = 0;
});

describe("ai-run-controller startRun", () => {
  it("records the user+assistant turns, streams events, and persists the completed turn (survives any component lifecycle)", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    const { userTurnId, assistantTurnId } = startRun(room.id, makeRunParams(documentId));
    expect(userTurnId).not.toBeNull();

    // Turn + session state are live immediately.
    const running = aiChatRoomsStore.getRoom(room.id)!;
    expect(running.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect((running.turns[1] as AssistantTurn).isRunning).toBe(true);
    expect(aiRunSessionStore.getSession(room.id)?.status).toBe("preparing");

    expect(pendingRuns).toHaveLength(1);
    pendingRuns[0].resolve(makeRunResult({ agentThreadId: "thread-xyz" } as Partial<AiEditRunResult>));
    await flushMicrotasks();

    const finished = aiChatRoomsStore.getRoom(room.id)!;
    const assistant = finished.turns.find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    expect(assistant.isRunning).toBe(false);
    expect(assistant.result).not.toBeNull();
    expect(finished.agentThreadId).toBe("thread-xyz");
    expect(aiRunSessionStore.getSession(room.id)?.status).toBe("completed");

    // Room persisted with the completed turn (last save carries the result).
    const lastSave = savedRooms.filter((saved) => saved.id === room.id).at(-1)!;
    expect(lastSave.agentThreadId).toBe("thread-xyz");
    expect(lastSave.turns).toHaveLength(2);
  });

  it("binds the room to the first run's provider and keeps it across later runs", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    expect(aiChatRoomsStore.getRoom(room.id)!.provider).toBeUndefined();

    startRun(room.id, makeRunParams(documentId, { turnProvider: "claude" }));
    expect(aiChatRoomsStore.getRoom(room.id)!.provider).toBe("claude");
    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();

    // A later run on the same room does not change the bound provider, even if a
    // different provider is (somehow) passed.
    startRun(room.id, makeRunParams(documentId, { turnProvider: "chatgpt" }));
    expect(aiChatRoomsStore.getRoom(room.id)!.provider).toBe("claude");
    pendingRuns.at(-1)!.resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("marks the turn and session failed when the provider rejects", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    const { assistantTurnId } = startRun(room.id, makeRunParams(documentId));
    pendingRuns[0].reject(new Error("接続エラー"));
    await flushMicrotasks();

    const assistant = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    expect(assistant.error).toBe("接続エラー");
    expect(assistant.isRunning).toBe(false);
    const session = aiRunSessionStore.getSession(room.id);
    expect(session?.status).toBe("failed");
    expect(session?.error).toBe("接続エラー");
  });

  it("drains a queued follow-up on completion using the room's freshly assigned agentThreadId", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    // First run composed while agentThreadId is still null.
    startRun(room.id, makeRunParams(documentId));
    // Follow-up queued mid-run; its snapshot also has a null thread id.
    const queuedTurnId = enqueueFollowUp(room.id, makeRunParams(documentId, { turnInstruction: "続きもやって" }));

    const queuedTurn = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === queuedTurnId) as UserTurn;
    expect(queuedTurn.queued).toBe(true);

    pendingRuns[0].resolve(makeRunResult({ agentThreadId: "thread-first-run" } as Partial<AiEditRunResult>));
    await flushMicrotasks();

    // The drained dispatch re-resolved the thread id at drain time.
    expect(pendingRuns).toHaveLength(2);
    expect(pendingRuns[1].request.agentThreadId).toBe("thread-first-run");
    expect(pendingRuns[1].request.instruction).toBe("続きもやって");

    // The queued pill cleared and a second assistant turn is running.
    const turns = aiChatRoomsStore.getRoom(room.id)!.turns;
    expect((turns.find((turn) => turn.id === queuedTurnId) as UserTurn).queued).toBe(false);
    expect(turns.filter((turn) => turn.role === "assistant")).toHaveLength(2);
    expect(aiRunSessionStore.getSession(room.id)?.status).toBe("preparing");

    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
    expect(aiRunSessionStore.getSession(room.id)?.status).toBe("completed");
  });

  it("merges queued follow-ups' references/attachments/mentions/skills instead of dropping all but the last", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    startRun(room.id, makeRunParams(documentId));

    const referenceA = makeReference("p_a");
    const referenceB = makeReference("p_b");
    const attachmentA = makeAttachment("att_a");
    const attachmentB = makeAttachment("att_b");
    const mentionA = makeMentionedDocument("file_a");
    const mentionB = makeMentionedDocument("file_b");

    enqueueFollowUp(room.id, makeRunParams(documentId, {
      turnInstruction: "1通目",
      turnReferences: [referenceA],
      turnAttachments: [attachmentA],
      turnMentionedDocuments: [mentionA],
      turnAiResourceIds: ["skill_a"],
    }));
    enqueueFollowUp(room.id, makeRunParams(documentId, {
      turnInstruction: "2通目",
      // referenceA を重複して含む: マージ後は dedupe されて1件になる。
      turnReferences: [referenceA, referenceB],
      turnAttachments: [attachmentB],
      turnMentionedDocuments: [mentionB],
      turnAiResourceIds: ["skill_a", "skill_b"],
    }));

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();

    expect(pendingRuns).toHaveLength(2);
    const drainedRequest = pendingRuns[1].request;
    expect(drainedRequest.instruction).toBe("1通目\n\n2通目");
    expect(drainedRequest.references).toEqual([referenceA, referenceB]);
    expect(drainedRequest.attachments).toEqual([attachmentA, attachmentB]);
    expect(drainedRequest.mentionedDocuments).toEqual([mentionA, mentionB]);
    expect(drainedRequest.aiResourceIds).toEqual(["skill_a", "skill_b"]);

    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("flips queued messages to 未送信 (queueFailed) instead of dispatching them when the run fails", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    startRun(room.id, makeRunParams(documentId));
    const queuedTurnId = enqueueFollowUp(room.id, makeRunParams(documentId, { turnInstruction: "未送信になるはず" }));

    pendingRuns[0].reject(new Error("失敗"));
    await flushMicrotasks();

    expect(pendingRuns).toHaveLength(1); // no auto-retry
    const queuedTurn = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === queuedTurnId) as UserTurn;
    expect(queuedTurn.queued).toBe(false);
    expect(queuedTurn.queueFailed).toBe(true);
  });

  it("lets a subscriber that attaches mid-run (panel remount) observe streaming updates and completion", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    const { assistantTurnId } = startRun(room.id, makeRunParams(documentId));

    // Simulate the remount: the first subscriber (old panel instance) is gone;
    // a new one attaches while the run is still in flight.
    const seen: string[] = [];
    const unsubscribe = aiChatRoomsStore.subscribe(() => {
      const assistant = aiChatRoomsStore.getRoom(room.id)?.turns
        .find((turn) => turn.id === assistantTurnId) as AssistantTurn | undefined;
      if (assistant) {
        seen.push(assistant.isRunning ? `running:${assistant.streamText}` : "done");
      }
    });

    // Stream an event after the new subscriber attached.
    const session = aiRunSessionStore.getSession(room.id)!;
    expect(session.status).toBe("preparing");

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
    unsubscribe();

    expect(seen).toContain("done");
    const assistant = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    expect(assistant.isRunning).toBe(false);
  });

  it("cancelRun forwards the run's underlying desktop IPC runId to cancelAiEditViaDesktopRuntime", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    const { assistantTurnId } = startRun(room.id, makeRunParams(documentId));

    cancelRun(assistantTurnId);
    await flushMicrotasks();

    expect(cancelledRunIds).toEqual(["runid-0"]);

    // The eventual cancelled-status result still lands through the normal
    // success path (main process resolves rather than rejects on cancel).
    pendingRuns[0].resolve(makeRunResult({ status: "cancelled" } as Partial<AiEditRunResult>));
    await flushMicrotasks();
    const assistant = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    expect(assistant.isRunning).toBe(false);
    expect(assistant.result?.status).toBe("cancelled");
  });

  it("merges a tool-result image event onto the same activity row as its started event, keyed by itemId", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    const { assistantTurnId } = startRun(room.id, makeRunParams(documentId));
    const onEvent = pendingRuns[0].request.onEvent!;

    onEvent({
      kind: "activity",
      phase: "streaming",
      message: "ツール実行中... (render_visual_edit_session)",
      itemType: "mcpToolCall",
      itemStatus: "started",
      itemId: "toolu_1",
      timestamp: Date.now(),
    });

    let assistant = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    const activityEvents = assistant.events.filter((event) => event.kind === "activity");
    expect(activityEvents).toHaveLength(1);
    expect(activityEvents[0].itemStatus).toBe("started");
    expect(activityEvents[0].images).toBeUndefined();

    onEvent({
      kind: "activity",
      phase: "streaming",
      message: "ツール実行中... (render_visual_edit_session)",
      itemType: "mcpToolCall",
      itemStatus: "completed",
      itemId: "toolu_1",
      images: [{ dataUrl: "data:image/png;base64,AAAA" }],
      timestamp: Date.now(),
    });

    assistant = aiChatRoomsStore.getRoom(room.id)!.turns
      .find((turn) => turn.id === assistantTurnId) as AssistantTurn;
    const mergedEvents = assistant.events.filter((event) => event.kind === "activity");
    // Same row (merged by itemId), not a second entry.
    expect(mergedEvents).toHaveLength(1);
    expect(mergedEvents[0].itemStatus).toBe("completed");
    expect(mergedEvents[0].images).toEqual([{ dataUrl: "data:image/png;base64,AAAA" }]);

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("cancelRun is a no-op for an unknown turn id or one whose run already settled", async () => {
    cancelRun("no-such-turn");
    await flushMicrotasks();
    expect(cancelledRunIds).toEqual([]);

    const { documentId } = freshIds();
    const room = addRoom(documentId);
    const { assistantTurnId } = startRun(room.id, makeRunParams(documentId));
    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();

    cancelRun(assistantTurnId);
    await flushMicrotasks();
    expect(cancelledRunIds).toEqual([]);
  });
});

describe("ai-run-controller rooms store", () => {
  it("hydrate defaults the active room to the newest, but never clobbers an explicit selection made while loading", () => {
    const { documentId } = freshIds();
    const older = { ...createEmptyChatRoom(documentId, "古い部屋"), updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...createEmptyChatRoom(documentId, "新しい部屋"), updatedAt: "2026-06-01T00:00:00.000Z" };

    // Rooms already known in-session (e.g. created by inline runs).
    addChatRoom(older, { persist: false });
    addChatRoom(newer, { persist: false });

    // The user clicked the OLDER room's widget while listChatRooms was in flight.
    selectChatRoom(documentId, older.id);

    // The async load resolves afterwards: it must keep the explicit selection.
    hydrateChatRoomsFromDisk(documentId, [older, newer]);
    expect(aiChatRoomsStore.getActiveRoomId(documentId)).toBe(older.id);
  });

  it("hydrate picks the newest room as default when nothing was explicitly selected", () => {
    const { documentId } = freshIds();
    const older = { ...createEmptyChatRoom(documentId, "古い部屋"), updatedAt: "2026-01-01T00:00:00.000Z" };
    const newer = { ...createEmptyChatRoom(documentId, "新しい部屋"), updatedAt: "2026-06-01T00:00:00.000Z" };

    hydrateChatRoomsFromDisk(documentId, [older, newer]);
    expect(aiChatRoomsStore.getActiveRoomId(documentId)).toBe(newer.id);
  });

  it("hydrate leaves an in-memory room untouched when the disk copy is stale", () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    startRun(room.id, makeRunParams(documentId));
    const liveTurnCount = aiChatRoomsStore.getRoom(room.id)!.turns.length;
    expect(liveTurnCount).toBe(2);

    // A stale disk snapshot (captured before the run) races back in.
    hydrateChatRoomsFromDisk(documentId, [{ ...room, turns: [] }]);
    expect(aiChatRoomsStore.getRoom(room.id)!.turns).toHaveLength(liveTurnCount);
  });
});

describe("ai-run-controller same-anchor serialization", () => {
  it("queues a second run that targets the same anchor until the first settles", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);
    const sharedAnchor = makeAnchor("shared-block", documentId);

    startRun(roomA.id, makeRunParams(documentId, { anchor: sharedAnchor }));
    expect(pendingRuns).toHaveLength(1);

    const { assistantTurnId: turnB } = startRun(
      roomB.id,
      makeRunParams(documentId, { anchor: sharedAnchor, turnInstruction: "2つ目の指示" }),
    );
    // Room B's turn/session exist immediately, but no second provider call is
    // dispatched yet -- it is waiting behind room A's run on the same anchor.
    expect(aiChatRoomsStore.getRoom(roomB.id)!.turns.map((turn) => turn.role)).toEqual(["user", "assistant"]);
    expect(pendingRuns).toHaveLength(1);
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("waiting");

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();

    // Releasing room A's hold on the anchor dispatches room B's queued run.
    expect(pendingRuns).toHaveLength(2);
    expect(pendingRuns[1].request.instruction).toBe("2つ目の指示");
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("preparing");

    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("completed");
    const assistantB = aiChatRoomsStore.getRoom(roomB.id)!.turns.find((turn) => turn.id === turnB) as AssistantTurn;
    expect(assistantB.isRunning).toBe(false);
  });

  it("queues cross-room runs whose multi-block target sets overlap", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);

    startRun(roomA.id, makeRunParams(documentId, {
      anchor: makeAnchor("block-a", documentId, ["block-a", "block-b"]),
    }));
    startRun(roomB.id, makeRunParams(documentId, {
      anchor: makeAnchor("block-c", documentId, ["block-b", "block-c"]),
    }));

    expect(pendingRuns).toHaveLength(1);
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("waiting");

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
    expect(pendingRuns).toHaveLength(2);
    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("runs disjoint block target sets concurrently, and keeps anchor-less runs unqueued", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);
    const roomC = addRoom(documentId);

    startRun(roomA.id, makeRunParams(documentId, {
      anchor: makeAnchor("block-a", documentId, ["block-a", "block-b"]),
    }));
    startRun(roomB.id, makeRunParams(documentId, {
      anchor: makeAnchor("block-c", documentId, ["block-c", "block-d"]),
    }));
    startRun(roomC.id, makeRunParams(documentId, { anchor: makeAnchor(null, documentId) }));

    expect(pendingRuns).toHaveLength(3);
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("preparing");
    pendingRuns.forEach((pending) => pending.resolve(makeRunResult()));
    await flushMicrotasks();
  });

  it("queues cross-room runs whose shape target sets overlap", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);

    startRun(roomA.id, makeRunParams(documentId, {
      anchor: makeAnchor("placement-a", documentId, [], ["shape-a", "shape-b"]),
    }));
    startRun(roomB.id, makeRunParams(documentId, {
      anchor: makeAnchor("placement-b", documentId, [], ["shape-b", "shape-c"]),
    }));

    expect(pendingRuns).toHaveLength(1);
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("waiting");

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
    expect(pendingRuns).toHaveLength(2);
    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("runs a block run and a disjoint shape run concurrently even when they share a placement block", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);

    startRun(roomA.id, makeRunParams(documentId, {
      anchor: makeAnchor("shared-placement", documentId, ["shared-placement"]),
    }));
    startRun(roomB.id, makeRunParams(documentId, {
      anchor: makeAnchor("shared-placement", documentId, [], ["shape-a"]),
    }));

    expect(pendingRuns).toHaveLength(2);
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("preparing");
    pendingRuns.forEach((pending) => pending.resolve(makeRunResult()));
    await flushMicrotasks();
  });

  it("dequeues a waiting run on cancellation without disturbing the anchor's current holder", async () => {
    const { documentId } = freshIds();
    const roomA = addRoom(documentId);
    const roomB = addRoom(documentId);
    const sharedAnchor = makeAnchor("shared-block", documentId);

    startRun(roomA.id, makeRunParams(documentId, { anchor: sharedAnchor }));
    const { assistantTurnId: turnB } = startRun(roomB.id, makeRunParams(documentId, { anchor: sharedAnchor }));
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("waiting");

    cancelRun(turnB);
    await flushMicrotasks();

    const assistantB = aiChatRoomsStore.getRoom(roomB.id)!.turns.find((turn) => turn.id === turnB) as AssistantTurn;
    expect(assistantB.isRunning).toBe(false);
    expect(assistantB.error).toContain("キャンセル");
    expect(aiRunSessionStore.getSession(roomB.id)?.status).toBe("failed");
    // Cancelling the waiting run must not touch the desktop bridge (there was
    // never an IPC run for it) or disturb room A, which still holds the anchor.
    expect(pendingRuns).toHaveLength(1);
    expect(cancelledRunIds).toEqual([]);

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
    expect(aiRunSessionStore.getSession(roomA.id)?.status).toBe("completed");
  });
});

describe("mergeQueuedRunParams", () => {
  it("concats and dedupes references/attachments/mentions/skills, keeping the last message's other fields", () => {
    const documentId = "doc-merge";
    const merged = mergeQueuedRunParams(
      makeRunParams(documentId, {
        turnInstruction: "先",
        turnReferences: [makeReference("p_1")],
        turnAttachments: [makeAttachment("att_1")],
        turnMentionedDocuments: [makeMentionedDocument("file_1")],
        turnAiResourceIds: ["skill_1"],
        turnModel: "gpt-5-old",
        anchor: makeAnchor("p_1", documentId, ["p_1"], ["shape_1"]),
      }),
      makeRunParams(documentId, {
        turnInstruction: "後",
        turnReferences: [makeReference("p_1"), makeReference("p_2")],
        turnAttachments: [makeAttachment("att_1"), makeAttachment("att_2")],
        turnMentionedDocuments: [makeMentionedDocument("file_1"), makeMentionedDocument("file_2")],
        turnAiResourceIds: ["skill_1", "skill_2"],
        turnModel: "gpt-5-new",
        anchor: makeAnchor("p_2", documentId, ["p_2"], ["shape_2"]),
      }),
    );

    expect(merged.turnInstruction).toBe("先\n\n後");
    expect(merged.turnReferences.map((reference) => reference.targetId)).toEqual(["p_1", "p_2"]);
    expect(merged.turnAttachments.map((attachment) => attachment.id)).toEqual(["att_1", "att_2"]);
    expect(merged.turnMentionedDocuments.map((mention) => mention.fileId)).toEqual(["file_1", "file_2"]);
    expect(merged.turnAiResourceIds).toEqual(["skill_1", "skill_2"]);
    expect(merged.turnModel).toBe("gpt-5-new");
    expect(merged.anchor).toEqual(makeAnchor(
      "p_2",
      documentId,
      ["p_1", "p_2"],
      ["shape_1", "shape_2"],
    ));
  });

  it("clamps merged references and attachments to their limits, prioritizing the latest message's items", () => {
    const documentId = "doc-clamp";
    const manyReferences = Array.from({ length: 6 }, (_, index) => makeReference(`ref_a_${index}`));
    const moreReferences = Array.from({ length: 6 }, (_, index) => makeReference(`ref_b_${index}`));
    const manyAttachments = Array.from({ length: 3 }, (_, index) => makeAttachment(`att_a_${index}`));
    const moreAttachments = Array.from({ length: 3 }, (_, index) => makeAttachment(`att_b_${index}`));

    const merged = mergeQueuedRunParams(
      makeRunParams(documentId, { turnReferences: manyReferences, turnAttachments: manyAttachments }),
      makeRunParams(documentId, { turnReferences: moreReferences, turnAttachments: moreAttachments }),
    );

    expect(merged.turnReferences).toHaveLength(8);
    expect(merged.turnAttachments).toHaveLength(4);
    // The clamp must not silently drop the LAST queued message's items: every
    // reference/attachment from the later message ("ref_b_*"/"att_b_*") survives,
    // and only the oldest items from the earlier message are cut — not the newest.
    expect(merged.turnReferences.map((reference) => reference.targetId)).toEqual([
      "ref_a_4", "ref_a_5", "ref_b_0", "ref_b_1", "ref_b_2", "ref_b_3", "ref_b_4", "ref_b_5",
    ]);
    expect(merged.turnAttachments.map((attachment) => attachment.id)).toEqual([
      "att_a_2", "att_b_0", "att_b_1", "att_b_2",
    ]);
  });
});

describe("buildRejectionFeedbackInstruction", () => {
  it("builds the fixed Japanese template with the reason and joined summaries", () => {
    expect(buildRejectionFeedbackInstruction("数式が違う", ["段落を書き換え", "図形を挿入"])).toBe(
      "ユーザーが提案を却下しました。理由: 数式が違う。対象: 段落を書き換え / 図形を挿入。理由を踏まえて修正した提案を作り直してください。",
    );
  });

  it("falls back to a generic target label when no summaries are given", () => {
    expect(buildRejectionFeedbackInstruction("理由", [])).toBe(
      "ユーザーが提案を却下しました。理由: 理由。対象: 対象の編集案。理由を踏まえて修正した提案を作り直してください。",
    );
  });
});

describe("createAiRunAnchor", () => {
  it("keeps a shape-only run's placement block editable", () => {
    const document = {
      version: "2.0",
      docId: "doc-shape-only",
      metadata: { title: "t" },
      content: [
        { id: "placement", type: "paragraph", children: [{ type: "text", text: "anchor" }] },
      ],
      outputProfiles: {},
    } as RunParams["runDocument"];
    const overlayReference = {
      ...makeReference("placement"),
      overlaySelection: {
        selectedShapeIds: ["shape_1"],
        shapes: [],
        assets: {},
      },
    } satisfies AiEditReference;

    expect(createAiRunAnchor({
      primaryBlockId: "placement",
      documentId: "doc-shape-only",
      document,
      references: [overlayReference],
    })).toEqual({
      primaryBlockId: "placement",
      blockIds: [],
      blockLockTexts: {},
      shapeIds: ["shape_1"],
      documentId: "doc-shape-only",
    });
  });

  it("derives every covered body block and selected shape from the AI context", () => {
    const document = {
      version: "2.0",
      docId: "doc-anchor",
      metadata: { title: "t" },
      content: [
        { id: "p_1", type: "paragraph", children: [{ type: "text", text: "一" }] },
        { id: "p_2", type: "paragraph", children: [{ type: "text", text: "二" }] },
        { id: "p_3", type: "paragraph", children: [{ type: "text", text: "三" }] },
      ],
      outputProfiles: {},
    } as RunParams["runDocument"];
    const selectionReference: AiEditReference = {
      kind: "textSelection",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "一 二 三",
      selectedText: "一 二 三",
      mathTex: [],
      textRange: {
        type: "textRange",
        start: { blockId: "p_1", offset: 0 },
        end: { blockId: "p_3", offset: 1 },
        quote: "一 二 三",
      },
    };
    const overlayReference = {
      ...makeReference("p_2"),
      overlaySelection: {
        selectedShapeIds: ["shape_1"],
        shapes: [],
        assets: {},
      },
    } satisfies AiEditReference;

    expect(createAiRunAnchor({
      primaryBlockId: "p_1",
      documentId: "doc-anchor",
      document,
      references: [selectionReference, overlayReference],
    })).toEqual({
      primaryBlockId: "p_1",
      blockIds: ["p_1", "p_2", "p_3"],
      shapeIds: ["shape_1"],
      blockLockTexts: { p_1: "一", p_2: "二", p_3: "三" },
      blockShimmerScopes: [
        { kind: "text", blockId: "p_1", from: 0, to: 1 },
        { kind: "text", blockId: "p_2", from: 0, to: 1 },
        { kind: "text", blockId: "p_3", from: 0, to: 1 },
      ],
      documentId: "doc-anchor",
    });
  });

  it("does not lock the block at a multi-block selection's zero-offset end boundary", () => {
    const document = {
      version: "2.0",
      docId: "doc-anchor-boundary",
      metadata: { title: "t" },
      content: [
        { id: "p_1", type: "paragraph", children: [{ type: "text", text: "一" }] },
        { id: "p_2", type: "paragraph", children: [{ type: "text", text: "二" }] },
        { id: "p_3", type: "paragraph", children: [{ type: "text", text: "三" }] },
      ],
      outputProfiles: {},
    } as RunParams["runDocument"];

    expect(createAiRunAnchor({
      primaryBlockId: "p_1",
      document,
      references: [{
        kind: "textSelection",
        targetId: "p_1",
        targetType: "paragraph",
        excerpt: "一 二",
        selectedText: "一 二",
        mathTex: [],
        textRange: {
          type: "textRange",
          start: { blockId: "p_1", offset: 0 },
          end: { blockId: "p_3", offset: 0 },
          quote: "一 二",
        },
      }],
    }).blockIds).toEqual(["p_1", "p_2"]);
  });

  it("targets only the selected inline math atom for shimmer", () => {
    const document = {
      version: "2.0",
      docId: "doc-inline-math",
      metadata: { title: "t" },
      content: [{
        id: "p_1",
        type: "paragraph",
        children: [
          { type: "text", text: "前" },
          { type: "mathInline", id: "m_1", tex: "x" },
          { type: "text", text: "後" },
        ],
      }],
      outputProfiles: {},
    } as RunParams["runDocument"];

    expect(createAiRunAnchor({
      primaryBlockId: "p_1",
      document,
      references: [{
        kind: "inlineMath",
        targetId: "p_1",
        targetType: "paragraph",
        excerpt: "x",
        mathInlineId: "m_1",
        tex: "x",
      }],
    }).blockShimmerScopes).toEqual([
      { kind: "inlineMath", blockId: "p_1", mathInlineId: "m_1" },
    ]);
  });
});

function makeSigmaDocument(docId: string): RunParams["runDocument"] {
  return { version: "2.0", docId, metadata: { title: "t" }, content: [], outputProfiles: {} } as unknown as RunParams["runDocument"];
}

describe("submitRejectionFeedback", () => {
  it("skips a blank reason without touching the room", () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    const outcome = submitRejectionFeedback({
      roomId: room.id,
      reason: "   ",
      proposalSummaries: [],
      documentIdentityKey: documentId,
      document: makeSigmaDocument(documentId),
    });

    expect(outcome).toBe("skipped");
    expect(pendingRuns).toHaveLength(0);
  });

  it("skips a room this store has never seen", () => {
    const outcome = submitRejectionFeedback({
      roomId: "no-such-room",
      reason: "理由",
      proposalSummaries: [],
      documentIdentityKey: "doc-x",
      document: makeSigmaDocument("doc-x"),
    });

    expect(outcome).toBe("skipped");
  });

  it("starts a follow-up turn immediately when the room has no live run", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);

    const outcome = submitRejectionFeedback({
      roomId: room.id,
      reason: "数式が元の問題と合っていない",
      proposalSummaries: ["段落の書き換え"],
      documentIdentityKey: documentId,
      document: makeSigmaDocument(documentId),
    });

    expect(outcome).toBe("started");
    expect(pendingRuns).toHaveLength(1);
    expect(pendingRuns[0].request.instruction).toContain("数式が元の問題と合っていない");
    expect(pendingRuns[0].request.instruction).toContain("段落の書き換え");

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();
  });

  it("queues behind a room's in-flight run instead of starting a second one", async () => {
    const { documentId } = freshIds();
    const room = addRoom(documentId);
    startRun(room.id, makeRunParams(documentId));
    expect(pendingRuns).toHaveLength(1);

    const outcome = submitRejectionFeedback({
      roomId: room.id,
      reason: "理由",
      proposalSummaries: [],
      documentIdentityKey: documentId,
      document: makeSigmaDocument(documentId),
    });

    expect(outcome).toBe("queued");
    expect(pendingRuns).toHaveLength(1);

    pendingRuns[0].resolve(makeRunResult());
    await flushMicrotasks();

    expect(pendingRuns).toHaveLength(2);
    expect(pendingRuns[1].request.instruction).toContain("理由: 理由。");
    pendingRuns[1].resolve(makeRunResult());
    await flushMicrotasks();
  });
});

describe("isSameAiRunTarget", () => {
  it("treats different block targets as different locations (parallel fork)", () => {
    expect(isSameAiRunTarget(makeAnchor("para_a"), makeAnchor("para_b"))).toBe(false);
  });

  it("treats the same block target as the same location (queue)", () => {
    expect(isSameAiRunTarget(makeAnchor("para_a"), makeAnchor("para_a"))).toBe(true);
  });

  it("treats overlapping multi-block target sets as the same location", () => {
    expect(isSameAiRunTarget(
      makeAnchor("para_a", undefined, ["para_a", "para_b"]),
      makeAnchor("para_b", undefined, ["para_b", "para_c"]),
    )).toBe(true);
  });

  it("falls back to 'same' (queue) when either side has no explicit target", () => {
    expect(isSameAiRunTarget(makeAnchor(null), makeAnchor("para_a"))).toBe(true);
    expect(isSameAiRunTarget(makeAnchor("para_a"), makeAnchor(null))).toBe(true);
    expect(isSameAiRunTarget(null, makeAnchor("para_a"))).toBe(true);
  });

  it("compares shape selections by intersection", () => {
    expect(isSameAiRunTarget(
      makeAnchor("anchor_a", undefined, [], ["shape_1", "shape_2"]),
      makeAnchor("anchor_b", undefined, [], ["shape_2"]),
    )).toBe(true);
    expect(isSameAiRunTarget(
      makeAnchor("anchor_a", undefined, [], ["shape_1"]),
      makeAnchor("anchor_b", undefined, [], ["shape_3"]),
    )).toBe(false);
  });

  it("does not treat a shape-only placement block as a body target", () => {
    expect(isSameAiRunTarget(
      makeAnchor("anchor_a", undefined, [], ["shape_1"]),
      makeAnchor("anchor_a"),
    )).toBe(false);
    expect(isSameAiRunTarget(
      makeAnchor("anchor_a", undefined, [], ["shape_1"]),
      makeAnchor("para_b"),
    )).toBe(false);
  });

  it("treats disjoint shape runs sharing a placement block as different targets", () => {
    expect(isSameAiRunTarget(
      makeAnchor("shared-placement", undefined, [], ["shape_1"]),
      makeAnchor("shared-placement", undefined, [], ["shape_2"]),
    )).toBe(false);
  });
});
