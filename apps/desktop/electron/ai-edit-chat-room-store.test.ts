import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalAiEditChatRoomStore, type LocalAiEditChatRoom } from "./ai-edit-chat-room-store";

describe("LocalAiEditChatRoomStore", () => {
  let userDataDir: string;
  let store: LocalAiEditChatRoomStore;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "ai-edit-chat-room-store-"));
    store = new LocalAiEditChatRoomStore(userDataDir);
  });

  afterEach(async () => {
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("saves rooms and restores assistant turns as history", async () => {
    const room = createRoom("room_1", "file_1", "thread_1");
    const result = await store.saveRoom(room);

    expect(result.ok).toBe(true);
    const rooms = await store.listRooms("file_1");

    expect(rooms).toHaveLength(1);
    expect(rooms[0]).toMatchObject({
      id: "room_1",
      documentIdentityKey: "file_1",
      agentThreadId: "thread_1",
      title: "二次関数の問題を作る",
    });
    expect(rooms[0].turns[1]).toMatchObject({
      role: "assistant",
      isRunning: false,
      restored: true,
    });
  });

  it("filters rooms by document identity and lists newest first", async () => {
    await store.saveRoom(createRoom("old_room", "file_1", "thread_old", "2026-06-08T00:00:00.000Z"));
    await store.saveRoom(createRoom("other_file_room", "file_2", "thread_other", "2026-06-08T01:00:00.000Z"));
    await store.saveRoom(createRoom("new_room", "file_1", "thread_new", "2026-06-08T02:00:00.000Z"));

    const rooms = await store.listRooms("file_1");

    expect(rooms.map((room) => room.id)).toEqual(["new_room", "old_room"]);
  });

  it("keeps a selected-shape thumbnail in the restored user turn", async () => {
    const room = createRoom("room_preview", "file_1", "thread_preview");
    const userTurn = room.turns[0];
    if (userTurn?.role !== "user") {
      throw new Error("user turn fixture is missing");
    }
    userTurn.attachments = [{
      id: "overlay_preview_1",
      name: "選択図形プレビュー-1件.png",
      mimeType: "image/png",
      width: 320,
      height: 192,
      fileSize: 128,
      dataUrl: "data:image/png;base64,AAAA",
      sourceReferenceKey: "block:p_1:::overlay:shape_1",
    }];

    await store.saveRoom(room);
    const restored = await store.listRooms("file_1");
    const restoredUserTurn = restored[0]?.turns[0];

    expect(restoredUserTurn).toMatchObject({
      role: "user",
      attachments: [{
        id: "overlay_preview_1",
        name: "選択図形プレビュー-1件.png",
        dataUrl: "data:image/png;base64,AAAA",
        sourceReferenceKey: "block:p_1:::overlay:shape_1",
      }],
    });
  });

  it("migrates a legacy single overlay reference so its historical preview survives", async () => {
    const legacyRoom = createRoom("room_legacy_overlay", "file_1", "thread_legacy");
    const legacyReference = {
      kind: "block",
      targetId: "p_1",
      targetType: "paragraph",
      excerpt: "図形の挿入先",
      overlaySelection: {
        selectedShapeIds: ["shape_1"],
        shapes: [{
          id: "shape_1",
          type: "geo",
          x: 10,
          y: 20,
          props: {
            w: 80,
            h: 60,
            geo: "rectangle",
            fill: "none",
            color: "#111111",
            fillColor: "#ffffff",
            labelColor: "#111111",
            dash: "solid",
            size: "m",
          },
        }],
        assets: {},
      },
    };
    const rawRoom = structuredClone(legacyRoom) as unknown as { turns: Array<Record<string, unknown>> };
    delete rawRoom.turns[0].references;
    rawRoom.turns[0].reference = legacyReference;
    const roomsDir = path.join(userDataDir, "data", "ai-chat-rooms");
    await fs.mkdir(roomsDir, { recursive: true });
    await fs.writeFile(
      path.join(roomsDir, "rooms.json"),
      `${JSON.stringify({ version: 1, rooms: [rawRoom] })}\n`,
      "utf8",
    );

    const restored = await store.listRooms("file_1");
    const restoredUserTurn = restored[0]?.turns[0];

    expect(restoredUserTurn).toMatchObject({
      role: "user",
      references: [{
        targetId: "p_1",
        overlaySelection: { selectedShapeIds: ["shape_1"] },
      }],
    });
  });

  it("serializes parallel room saves without losing history", async () => {
    const rooms = Array.from({ length: 20 }, (_, index) => (
      createRoom(`parallel_${index}`, "file_1", `thread_${index}`, new Date(index * 1000).toISOString())
    ));

    const results = await Promise.all(rooms.map((room) => store.saveRoom(room)));
    const restored = await store.listRooms("file_1");

    expect(results.every((result) => result.ok)).toBe(true);
    expect(restored).toHaveLength(20);
    expect(new Set(restored.map((room) => room.id))).toEqual(new Set(rooms.map((room) => room.id)));
  });

  it("deletes every room for one ephemeral document without touching other documents", async () => {
    await store.saveRoom(createRoom("room_a1", "file_a", "thread_a1"));
    await store.saveRoom(createRoom("room_b", "file_b", "thread_b"));
    await store.saveRoom(createRoom("room_a2", "file_a", "thread_a2"));

    await expect(store.deleteRoomsForDocument("file_a")).resolves.toEqual({
      ok: true,
      deletedRoomIds: ["room_a2", "room_a1"],
    });
    await expect(store.listRooms()).resolves.toMatchObject([{ id: "room_b", documentIdentityKey: "file_b" }]);
    await expect(store.deleteRoomsForDocument("file_a")).resolves.toEqual({ ok: true, deletedRoomIds: [] });
  });
});

function createRoom(
  id: string,
  documentIdentityKey: string,
  agentThreadId: string,
  updatedAt = "2026-06-08T00:00:00.000Z",
): LocalAiEditChatRoom {
  return {
    version: 1,
    id,
    documentIdentityKey,
    title: "二次関数の問題を作る",
    agentThreadId,
    createdAt: "2026-06-08T00:00:00.000Z",
    updatedAt,
    turns: [
      {
        id: `${id}_user`,
        role: "user",
        documentIdentityKey,
        instruction: "二次関数の問題を作る",
        references: [],
        attachments: [],
        mentionedDocuments: [],
        timestamp: 1,
      },
      {
        id: `${id}_assistant`,
        role: "assistant",
        documentIdentityKey,
        references: [],
        events: [{
          kind: "phase",
          phase: "thinking",
          message: "編集中...",
          timestamp: 2,
        }],
        streamText: "",
        reasoningText: "",
        planSteps: [],
        planExplanation: null,
        startedAt: 2,
        endedAt: 3,
        isRunning: true,
        result: null,
        targetId: "p_1",
        error: null,
        applied: false,
        dismissed: false,
        restored: false,
      },
    ],
  };
}
