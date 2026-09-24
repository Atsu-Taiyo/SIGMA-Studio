import fs from "node:fs/promises";
import path from "node:path";

import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import {
  capRunPreviewImages,
  MAX_RUN_PREVIEW_IMAGES_PER_RUN,
  type AiEditPlanStep,
  type AiEditRunEvent,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";

const ta = createCurrentLocaleTranslator("ai");

const DATA_DIR_NAME = "data";
const AI_CHAT_ROOMS_DIR_NAME = "ai-chat-rooms";
const AI_CHAT_ROOMS_FILE_NAME = "rooms.json";
const MAX_CHAT_ROOMS = 80;
const MAX_TURNS_PER_ROOM = 80;
const MAX_EVENTS_PER_ASSISTANT_TURN = 48;

export interface LocalAiEditChatAttachmentSummary {
  id: string;
  name: string;
  mimeType: string | null;
  width: number | null;
  height: number | null;
  fileSize: number | null;
  dataUrl?: string | null;
  sourceReferenceKey?: string | null;
}

export interface LocalAiEditChatMentionedDocumentSummary {
  id: string;
  fileId: string;
  title: string;
  documentPath: string;
  revision: number;
}

export interface LocalAiEditChatUserTurn {
  id: string;
  role: "user";
  documentIdentityKey: string;
  instruction: string;
  references: AiEditReference[];
  attachments: LocalAiEditChatAttachmentSummary[];
  mentionedDocuments: LocalAiEditChatMentionedDocumentSummary[];
  timestamp: number;
}

export interface LocalAiEditChatAssistantTurn {
  id: string;
  role: "assistant";
  documentIdentityKey: string;
  references: AiEditReference[];
  events: AiEditRunEvent[];
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
  restored: boolean;
}

export type LocalAiEditChatTurn = LocalAiEditChatUserTurn | LocalAiEditChatAssistantTurn;

export type LocalAiProvider = "chatgpt" | "claude" | "antigravity";

export interface LocalAiEditChatRoom {
  version: 1;
  id: string;
  documentIdentityKey: string;
  title: string;
  agentThreadId: string | null;
  provider?: LocalAiProvider;
  createdAt: string;
  updatedAt: string;
  turns: LocalAiEditChatTurn[];
}

interface LocalAiEditChatRoomFile {
  version: 1;
  rooms: LocalAiEditChatRoom[];
}

export class LocalAiEditChatRoomStore {
  private readonly roomsDir: string;
  private readonly roomsFile: string;
  private mutationQueue: Promise<void> = Promise.resolve();

  constructor(userDataPath: string) {
    this.roomsDir = path.join(userDataPath, DATA_DIR_NAME, AI_CHAT_ROOMS_DIR_NAME);
    this.roomsFile = path.join(this.roomsDir, AI_CHAT_ROOMS_FILE_NAME);
  }

  async listRooms(documentIdentityKey?: string | null): Promise<LocalAiEditChatRoom[]> {
    await this.mutationQueue;
    const data = await this.readFile();
    const rooms = data.rooms
      .filter((room) => !documentIdentityKey || room.documentIdentityKey === documentIdentityKey)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return rooms.map(markRoomAsRestored);
  }

  async saveRoom(input: unknown): Promise<{ ok: true; room: LocalAiEditChatRoom } | { ok: false; error: string }> {
    return this.enqueueMutation(async () => {
      const room = normalizeRoom(input);
      if (!room) {
        return { ok: false as const, error: ta("desktop.chatStore.invalidHistory") };
      }

      const data = await this.readFile();
      const nextRoom = prepareRoomForStorage(room);
      const existingIndex = data.rooms.findIndex((item) => item.id === nextRoom.id);
      const rooms = existingIndex >= 0
        ? data.rooms.map((item, index) => (index === existingIndex ? nextRoom : item))
        : [nextRoom, ...data.rooms];
      await this.writeFile({
        version: 1,
        rooms: pruneRooms(rooms),
      });
      return { ok: true as const, room: markRoomAsRestored(nextRoom) };
    });
  }

  async deleteRoom(roomId: string): Promise<{ ok: boolean; error?: string }> {
    return this.enqueueMutation(async () => {
      const normalizedRoomId = roomId.trim();
      if (!normalizedRoomId) {
        return { ok: false, error: ta("desktop.chatStore.missingId") };
      }

      const data = await this.readFile();
      const nextRooms = data.rooms.filter((room) => room.id !== normalizedRoomId);
      await this.writeFile({ version: 1, rooms: nextRooms });
      return { ok: true };
    });
  }

  /** Idempotently removes every conversation owned by an ephemeral document. */
  async deleteRoomsForDocument(documentIdentityKey: string): Promise<{ ok: boolean; deletedRoomIds: string[]; error?: string }> {
    return this.enqueueMutation(async () => {
      const normalizedKey = documentIdentityKey.trim();
      if (!normalizedKey) {
        return { ok: false, deletedRoomIds: [], error: ta("desktop.chatStore.missingId") };
      }
      const data = await this.readFile();
      const deletedRoomIds = data.rooms
        .filter((room) => room.documentIdentityKey === normalizedKey)
        .map((room) => room.id);
      if (deletedRoomIds.length === 0) return { ok: true, deletedRoomIds };
      await this.writeFile({
        version: 1,
        rooms: data.rooms.filter((room) => room.documentIdentityKey !== normalizedKey),
      });
      return { ok: true, deletedRoomIds };
    });
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async readFile(): Promise<LocalAiEditChatRoomFile> {
    try {
      const raw = await fs.readFile(this.roomsFile, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      return normalizeFile(parsed);
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { version: 1, rooms: [] };
      }
      throw error;
    }
  }

  private async writeFile(data: LocalAiEditChatRoomFile): Promise<void> {
    await fs.mkdir(this.roomsDir, { recursive: true });
    const tmpPath = `${this.roomsFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
      await fs.rename(tmpPath, this.roomsFile);
    } finally {
      await fs.rm(tmpPath, { force: true });
    }
  }
}

function normalizeFile(value: unknown): LocalAiEditChatRoomFile {
  if (!isRecord(value)) {
    return { version: 1, rooms: [] };
  }
  const rooms = Array.isArray(value.rooms)
    ? value.rooms.map(normalizeRoom).filter((room): room is LocalAiEditChatRoom => Boolean(room))
    : [];
  return { version: 1, rooms: pruneRooms(rooms) };
}

function normalizeRoom(value: unknown): LocalAiEditChatRoom | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  const documentIdentityKey = asString(value.documentIdentityKey);
  const createdAt = asString(value.createdAt) ?? new Date().toISOString();
  const updatedAt = asString(value.updatedAt) ?? createdAt;
  if (!id || !documentIdentityKey) {
    return null;
  }

  const turns = Array.isArray(value.turns)
    ? value.turns.map(normalizeTurn).filter((turn): turn is LocalAiEditChatTurn => Boolean(turn))
    : [];

  return {
    version: 1,
    id,
    documentIdentityKey,
    // **既定文をここで入れない。** main プロセスは表示言語を知らないので、日本語の
    // 既定文を焼くと英語 UI の履歴一覧にそれがそのまま並ぶ。空のまま渡し、
    // 「名前が付いていない会話」の呼び名は描画側が今の言語で解決する
    // (`isDefaultChatRoomTitle` / `resolveRoomLabel`)。
    title: asString(value.title)?.trim() ?? "",
    agentThreadId: asString(value.agentThreadId) ?? null,
    provider: asProvider(value.provider),
    createdAt,
    updatedAt,
    turns: turns.slice(-MAX_TURNS_PER_ROOM),
  };
}

function normalizeTurn(value: unknown): LocalAiEditChatTurn | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = asString(value.id);
  const role = asString(value.role);
  const documentIdentityKey = asString(value.documentIdentityKey);
  if (!id || !documentIdentityKey) {
    return null;
  }

  if (role === "user") {
    return {
      id,
      role,
      documentIdentityKey,
      instruction: asString(value.instruction) ?? "",
      references: normalizeReferences(value.references, value.reference),
      attachments: normalizeArray(value.attachments).map(normalizeAttachmentSummary),
      mentionedDocuments: normalizeArray(value.mentionedDocuments).map(normalizeMentionedDocumentSummary),
      timestamp: asNumber(value.timestamp) ?? Date.now(),
    };
  }

  if (role === "assistant") {
    return {
      id,
      role,
      documentIdentityKey,
      references: normalizeReferences(value.references, value.reference),
      events: normalizeArray(value.events).slice(-MAX_EVENTS_PER_ASSISTANT_TURN) as AiEditRunEvent[],
      streamText: asString(value.streamText) ?? "",
      reasoningText: asString(value.reasoningText) ?? "",
      planSteps: normalizeArray(value.planSteps) as AiEditPlanStep[],
      planExplanation: asString(value.planExplanation) ?? null,
      startedAt: asNumber(value.startedAt) ?? Date.now(),
      endedAt: asNumber(value.endedAt) ?? null,
      isRunning: false,
      result: isRecord(value.result) ? value.result as unknown as AiEditRunResult : null,
      targetId: asString(value.targetId) ?? null,
      error: asString(value.error) ?? null,
      applied: Boolean(value.applied),
      dismissed: Boolean(value.dismissed),
      restored: Boolean(value.restored),
    };
  }

  return null;
}

function normalizeAttachmentSummary(value: unknown): LocalAiEditChatAttachmentSummary {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id) ?? "attachment",
    name: asString(record.name) ?? ta("desktop.chatStore.attachmentFallback"),
    mimeType: asString(record.mimeType) ?? null,
    width: asNumber(record.width) ?? null,
    height: asNumber(record.height) ?? null,
    fileSize: asNumber(record.fileSize) ?? null,
    dataUrl: asString(record.dataUrl) ?? null,
    sourceReferenceKey: asString(record.sourceReferenceKey) ?? null,
  };
}

function normalizeMentionedDocumentSummary(value: unknown): LocalAiEditChatMentionedDocumentSummary {
  const record = isRecord(value) ? value : {};
  return {
    id: asString(record.id) ?? "sigma-doc",
    fileId: asString(record.fileId) ?? "",
    title: asString(record.title) ?? "SigmaDoc",
    documentPath: asString(record.documentPath) ?? "",
    revision: asNumber(record.revision) ?? 0,
  };
}

// 複数参照導入前の単数 `reference` も references[] へ移行し、本文・数式・図形の
// 既存履歴をすべて保つ。新形式が存在する場合は空配列も含めてそちらを優先する。
function normalizeReferences(value: unknown, legacyValue: unknown): AiEditReference[] {
  if (Array.isArray(value)) {
    return value.filter(isRecord) as unknown as AiEditReference[];
  }
  if (isRecord(legacyValue)) {
    return [legacyValue as unknown as AiEditReference];
  }
  return [];
}

function prepareRoomForStorage(room: LocalAiEditChatRoom): LocalAiEditChatRoom {
  return {
    ...room,
    version: 1,
    turns: room.turns.slice(-MAX_TURNS_PER_ROOM).map((turn) => {
      if (turn.role === "assistant") {
        return {
          ...turn,
          events: capTurnEventImages(turn.events.slice(-MAX_EVENTS_PER_ASSISTANT_TURN)),
          isRunning: false,
          restored: false,
        };
      }
      return turn;
    }),
  };
}

/**
 * Defensive re-cap of preview images (see ai-edit-shared-runner.ts, which
 * already enforces this budget when it first attaches images to an event) so
 * this on-disk chat history can never grow unbounded even if some future
 * caller feeds a turn's events in some other way.
 */
function capTurnEventImages(events: AiEditRunEvent[]): AiEditRunEvent[] {
  let remainingImageBudget = MAX_RUN_PREVIEW_IMAGES_PER_RUN;
  return events.map((event) => {
    if (!event.images || event.images.length === 0) {
      return event;
    }
    const images = capRunPreviewImages(event.images, remainingImageBudget);
    remainingImageBudget -= images.length;
    return images.length > 0 ? { ...event, images } : { ...event, images: undefined };
  });
}

function markRoomAsRestored(room: LocalAiEditChatRoom): LocalAiEditChatRoom {
  return {
    ...room,
    turns: room.turns.map((turn) =>
      turn.role === "assistant"
        ? { ...turn, isRunning: false, restored: true }
        : turn,
    ),
  };
}

function pruneRooms(rooms: LocalAiEditChatRoom[]): LocalAiEditChatRoom[] {
  return rooms
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_CHAT_ROOMS);
}

function normalizeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asProvider(value: unknown): LocalAiProvider | undefined {
  return value === "chatgpt" || value === "claude" || value === "antigravity" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
