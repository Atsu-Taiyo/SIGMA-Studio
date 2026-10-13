import { randomUUID } from "node:crypto";
import fsPromises from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import type { SigmaDocument } from "@/features/document";
import { createSigmaDocAgentSession, type SigmaDocAgentSession } from "@/lib/ai/sigma-doc-agent-tools";
import { createAiEditSessionDocumentDraft, type AiEditDraft, type SigmaDocMutationOp } from "@/lib/ai/sigma-doc-edit-schema";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import type { MaterialItem } from "@/types/material";
import {
  visualSessionStateFileName,
  visualSessionStateFileSessionSuffix,
  type AiEditRunContextProvider,
} from "../electron/ai-edit-run-context";
import { resolveRunContextDirectory } from "./sigma-doc-mcp-files";
import type {
  StoredVisualEditSession,
  VisualEditSession,
  VisualEditSessionStatePort,
  VisualEditSessionStateTarget,
  VisualEditSessionStateWriteOutcome,
} from "./visual-edit-session-lifecycle";

/**
 * 1 行目は小さな header (世代・run・session)、2 行目が本体。世代を比べるときは先頭だけを読む。
 * 本体には元の文書・作業中の文書・図形操作・確認の状態を入れる。素材一覧と、図形操作ごとの
 * 途中の文書 (operationResults) は大きく、読み戻すときに作り直せるので入れない。
 */
const VISUAL_SESSION_STATE_VERSION = 1;
const HEADER_READ_BYTES = 4096;
const PROVIDERS = ["claude", "chatgpt", "antigravity"] as const;

const HeaderSchema = z.object({
  version: z.literal(VISUAL_SESSION_STATE_VERSION),
  generation: z.number().int().positive(),
  provider: z.enum(PROVIDERS),
  runId: z.string().min(1),
  sessionId: z.string().min(1),
});

type Header = z.infer<typeof HeaderSchema>;

const RecordSchema = z.record(z.string(), z.unknown());

const BodySchema = z.object({
  file: z.looseObject({ fileId: z.string().min(1), revision: z.number().int().nonnegative() }),
  baseDocument: z.unknown(),
  targetId: z.string().nullable(),
  revision: z.number().int().nonnegative(),
  lastPreviewRevision: z.number().int(),
  lastPreviewSource: z.enum(["app-bridge", "svg-fallback", "svg-resource"]).nullable(),
  lastPreviewCode: z.string().nullable(),
  lastRenderFailure: z.object({ revision: z.number().int(), reason: z.string() }).nullable(),
  lastInspection: z.looseObject({
    passed: z.boolean(),
    inspectedRevision: z.number().int(),
    issues: z.array(RecordSchema),
  }).nullable(),
  lastReview: z.looseObject({
    passed: z.boolean(),
    reviewedRevision: z.number().int(),
    previewRevision: z.number().int(),
    issues: z.array(z.string()),
    nextActions: z.array(z.string()),
  }).nullable(),
  visualEvents: z.array(RecordSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
  sourceAnalysis: z.string().optional(),
  plannedShapes: z.array(z.object({ kind: z.string(), purpose: z.string() })).optional(),
  agentSession: z.object({
    draftDocument: z.unknown(),
    selectedId: z.string().nullable(),
    references: z.array(RecordSchema),
    attachments: z.array(RecordSchema),
    mentionedDocuments: z.array(RecordSchema),
    operations: z.array(RecordSchema),
    mutationOperations: z.array(RecordSchema),
    changedIds: z.array(z.string()),
    toolEvents: z.array(RecordSchema),
  }),
});

type PersistedAgentSession = Omit<SigmaDocAgentSession, "baseDocument" | "materials" | "operationResults">;

type PersistedVisualEditSession = Omit<
  VisualEditSession,
  "sessionId" | "agentSession" | "runId" | "provider" | "proposed" | "discarded"
> & { agentSession: PersistedAgentSession };

export interface VisualEditSessionStateFileOptions {
  env: Record<string, string | undefined>;
  /** この MCP サーバーの provider。保存の検索をこの provider の run に限る。 */
  provider(): AiEditRunContextProvider | null;
  /** 読み戻した session の素材一覧。開始時と同じく素材ストアから読む。 */
  loadMaterials(): Promise<MaterialItem[]>;
}

/**
 * run-context ディレクトリの `<provider>-<runId>.<sessionId>.visual-session-state.json` に
 * 未完了の scratch session を保存する。保存先は provider と runId を持つ session に限り、
 * run の終了時に Electron が片付ける。読み書きの失敗はツールの実行を失敗させない。
 */
export function createVisualEditSessionStateFiles(options: VisualEditSessionStateFileOptions): VisualEditSessionStatePort {
  return {
    resolveTarget(session) {
      const directory = resolveRunContextDirectory(options.env);
      const runId = session.runId?.trim();
      if (!directory || !session.provider || !runId) {
        return null;
      }
      return createTarget(path.join(directory, visualSessionStateFileName(session.provider, runId, session.sessionId)));
    },
    serialize: serializeVisualEditSession,
    async load(sessionId) {
      const directory = resolveRunContextDirectory(options.env);
      const provider = options.provider();
      if (!directory || !provider) {
        return null;
      }
      let entries: string[];
      try {
        entries = await fsPromises.readdir(directory);
      } catch {
        return null;
      }
      const sessionSuffix = visualSessionStateFileSessionSuffix(sessionId);
      for (const name of entries) {
        if (!name.startsWith(`${provider}-`) || !name.endsWith(sessionSuffix)) {
          continue;
        }
        const stored = await readStoredSession(path.join(directory, name), sessionId, provider, options);
        if (stored) {
          return stored;
        }
      }
      return null;
    },
  };
}

export function serializeVisualEditSession(session: VisualEditSession, generation: number): string {
  const provider = session.provider;
  const runId = session.runId?.trim();
  if (!provider || !runId) {
    throw new Error("run を特定できない visual edit session は保存しません。");
  }
  const header: Header = {
    version: VISUAL_SESSION_STATE_VERSION,
    generation,
    provider,
    runId,
    sessionId: session.sessionId,
  };
  const { agentSession } = session;
  const body: PersistedVisualEditSession = {
    file: session.file,
    baseDocument: session.baseDocument,
    targetId: session.targetId,
    revision: session.revision,
    lastPreviewRevision: session.lastPreviewRevision,
    lastPreviewSource: session.lastPreviewSource,
    lastPreviewCode: session.lastPreviewCode,
    lastRenderFailure: session.lastRenderFailure,
    lastInspection: session.lastInspection,
    lastReview: session.lastReview,
    visualEvents: session.visualEvents,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    sourceAnalysis: session.sourceAnalysis,
    plannedShapes: session.plannedShapes,
    agentSession: {
      draftDocument: agentSession.draftDocument,
      selectedId: agentSession.selectedId,
      references: agentSession.references,
      attachments: agentSession.attachments,
      mentionedDocuments: agentSession.mentionedDocuments,
      operations: agentSession.operations,
      mutationOperations: agentSession.mutationOperations,
      changedIds: agentSession.changedIds,
      toolEvents: agentSession.toolEvents,
    },
  };
  return `${JSON.stringify(header)}\n${JSON.stringify(body)}`;
}

function createTarget(filePath: string): VisualEditSessionStateTarget {
  return {
    key: filePath,
    readGeneration: async () => (await readHeader(filePath))?.generation ?? null,
    async write(serialized, generation): Promise<VisualEditSessionStateWriteOutcome> {
      const temporaryFilePath = `${filePath}.tmp-${randomUUID()}`;
      try {
        // 世代の確認と rename の間は原子的ではない。同じ session を 2 つのプロセスが同時に
        // 進めることは想定しておらず、終わった turn の古い memory で上書きしないための確認。
        const stored = await readHeader(filePath);
        if (stored && stored.generation >= generation) {
          return "superseded";
        }
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(temporaryFilePath, serialized, "utf8");
        await fsPromises.rename(temporaryFilePath, filePath);
        return "written";
      } catch {
        return "failed";
      } finally {
        await fsPromises.unlink(temporaryFilePath).catch(() => undefined);
      }
    },
    async remove() {
      await fsPromises.unlink(filePath).catch(() => undefined);
    },
  };
}

async function readHeader(filePath: string): Promise<Header | null> {
  let handle: fsPromises.FileHandle | null = null;
  try {
    handle = await fsPromises.open(filePath, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, HEADER_READ_BYTES, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    const newline = text.indexOf("\n");
    if (newline < 0) {
      return null;
    }
    const parsed = HeaderSchema.safeParse(JSON.parse(text.slice(0, newline)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readStoredSession(
  filePath: string,
  sessionId: string,
  provider: AiEditRunContextProvider,
  options: VisualEditSessionStateFileOptions,
): Promise<StoredVisualEditSession | null> {
  let raw: string;
  try {
    raw = await fsPromises.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  const newline = raw.indexOf("\n");
  if (newline < 0) {
    return null;
  }
  let headerJson: unknown;
  let bodyJson: unknown;
  try {
    headerJson = JSON.parse(raw.slice(0, newline));
    bodyJson = JSON.parse(raw.slice(newline + 1));
  } catch {
    return null;
  }
  const header = HeaderSchema.safeParse(headerJson);
  if (!header.success || header.data.sessionId !== sessionId || header.data.provider !== provider) {
    return null;
  }
  if (!BodySchema.safeParse(bodyJson).success) {
    return null;
  }
  const body = bodyJson as PersistedVisualEditSession;
  if (
    !SigmaDocumentSchema.safeParse(body.baseDocument).success
    || !SigmaDocumentSchema.safeParse(body.agentSession.draftDocument).success
  ) {
    return null;
  }

  let materials: MaterialItem[] = [];
  try {
    materials = await options.loadMaterials();
  } catch {
    // 素材一覧は visual session の図形操作では使わない。読めなくても再開は止めない。
  }

  let agentSession: SigmaDocAgentSession;
  try {
    // 開始時 (begin_visual_edit_session) と同じ手順で作り、保存した作業状態を戻す。
    agentSession = createSigmaDocAgentSession({
      document: body.baseDocument,
      selectedId: body.agentSession.selectedId,
      references: body.agentSession.references,
      attachments: body.agentSession.attachments,
      mentionedDocuments: body.agentSession.mentionedDocuments,
      materials,
    });
  } catch {
    return null;
  }
  agentSession.draftDocument = body.agentSession.draftDocument;
  agentSession.operations = body.agentSession.operations;
  agentSession.mutationOperations = body.agentSession.mutationOperations;
  agentSession.changedIds = body.agentSession.changedIds;
  agentSession.toolEvents = body.agentSession.toolEvents;
  agentSession.operationResults = replayOperationResults(
    body.baseDocument,
    body.targetId,
    body.agentSession.operations,
    body.agentSession.mutationOperations,
  );

  return {
    generation: header.data.generation,
    session: {
      sessionId,
      file: body.file,
      baseDocument: body.baseDocument,
      targetId: body.targetId,
      agentSession,
      revision: body.revision,
      lastPreviewRevision: body.lastPreviewRevision,
      lastPreviewSource: body.lastPreviewSource,
      lastPreviewCode: body.lastPreviewCode,
      lastRenderFailure: body.lastRenderFailure,
      lastInspection: body.lastInspection,
      lastReview: body.lastReview,
      visualEvents: body.visualEvents,
      createdAt: body.createdAt,
      updatedAt: body.updatedAt,
      runId: header.data.runId,
      provider: header.data.provider,
      proposed: false,
      discarded: false,
      ...(body.sourceAnalysis !== undefined ? { sourceAnalysis: body.sourceAnalysis } : {}),
      ...(body.plannedShapes !== undefined ? { plannedShapes: body.plannedShapes } : {}),
    },
  };
}

/**
 * 図形操作ごとの途中の文書は保存しない (操作の数だけ文書全体が入る)。visual session では
 * 提案化に使わないが、agent session の形を保つため、保存した操作を元の文書から当て直して作る。
 */
function replayOperationResults(
  baseDocument: SigmaDocument,
  targetId: string | null,
  operations: AiEditDraft[],
  mutationOperations: SigmaDocMutationOp[],
): SigmaDocAgentSession["operationResults"] {
  if (operations.length === 0) {
    return [];
  }
  try {
    return createAiEditSessionDocumentDraft(baseDocument, targetId, {
      summary: "図形編集セッションを再開しました。",
      plan: [],
      operations,
      ...(mutationOperations.length > 0 ? { mutationOperations } : {}),
      warnings: [],
    }).operationResults;
  } catch {
    return [];
  }
}
