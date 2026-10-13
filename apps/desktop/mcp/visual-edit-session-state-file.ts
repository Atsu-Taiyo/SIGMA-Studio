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
  VISUAL_SESSION_STATE_FILE_SUFFIX,
  visualSessionStateFileName,
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
 * 1 行目は小さな header (世代・run・session)、2 行目が本体。世代はファイル名にも入れ、header と照合する。
 * 本体には元の文書・作業中の文書・図形操作・確認の状態を入れる。素材一覧と、図形操作ごとの
 * 途中の文書 (operationResults) は大きく、読み戻すときに作り直せるので入れない。
 */
const VISUAL_SESSION_STATE_VERSION = 1;
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
 * 未完了の scratch session を run-context ディレクトリへ世代ごとのファイルで保存する。
 *
 * - `<provider>-<runId>.<sessionId>.g<世代>.visual-session-state.json`: その世代の状態。
 *   書きかけを見せないよう一時ファイルに書いてから、同じ名前が無いときだけ作れる hard link で
 *   公開する。同じ世代を別のプロセスが先に公開していれば、上書きせず先を越されたと返す
 *   (プロセスをまたいだ比較更新。lock を使わないので、止まったプロセスに妨げられない)。
 * - `<provider>-<runId>.<sessionId>.terminal.visual-session-state.json`: 提案化・破棄の目印。
 *   これがある session は読み戻さず、書き足しもしない。
 *
 * 読み戻すのは呼び出し元の run の一番新しい世代だけ (壊れていれば古い世代へは戻らない)。
 * 保存先は provider と runId を持つ session に限り、run の終了時に Electron が片付ける。
 * 読み書きの失敗は例外にせず、結果として返す。
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
    async load(sessionId, runId) {
      const directory = resolveRunContextDirectory(options.env);
      const provider = options.provider();
      const owner = runId.trim();
      if (!directory || !provider || !owner) {
        return null;
      }
      // 別の run の session は、sessionId を渡されても読まない (ファイル名と header の両方で照合する)。
      const files = sessionFiles(path.join(directory, visualSessionStateFileName(provider, owner, sessionId)));
      if (await fileExists(files.terminal)) {
        return null;
      }
      const [latest] = await files.generations();
      if (latest === undefined) {
        return null;
      }
      return readStoredSession(files.generation(latest), latest, sessionId, provider, owner, options);
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
  const files = sessionFiles(filePath);
  return {
    key: filePath,
    async readGeneration() {
      const [latest] = await files.generations();
      return latest ?? null;
    },
    isRetired: () => fileExists(files.terminal),
    async write(serialized, generation): Promise<VisualEditSessionStateWriteOutcome> {
      if (await fileExists(files.terminal)) {
        // 別のプロセスが提案化・破棄した。古い memory で書き足さない。
        return "superseded";
      }
      const published = files.generation(generation);
      const temporaryFilePath = files.temporary();
      try {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(temporaryFilePath, serialized, "utf8");
        try {
          // 同じ名前が既にあれば失敗する (原子的)。その世代は別のプロセスが先に公開した。
          await fsPromises.link(temporaryFilePath, published);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "EEXIST") {
            return "superseded";
          }
          throw error;
        }
      } catch {
        // 書けなかった変更より古い状態を、別のプロセスが最新として読み戻さないよう消す。
        await files.removeGenerations((existing) => existing < generation);
        return "failed";
      } finally {
        await fsPromises.unlink(temporaryFilePath).catch(() => undefined);
      }
      const [latest] = await files.generations();
      if (latest !== undefined && latest > generation) {
        // 古い世代を片付けた後に、この世代を作り直してしまった。最新は別のプロセスの世代。
        await fsPromises.unlink(published).catch(() => undefined);
        return "superseded";
      }
      await files.removeGenerations((existing) => existing < generation);
      return "written";
    },
    clear: () => files.removeGenerations(() => true),
    async retire() {
      // 目印を先に置く。消す途中で止まっても、残った世代を読み戻させない。
      try {
        await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
        await fsPromises.writeFile(files.terminal, "", "utf8");
      } catch {
        // 目印を置けなくても、run の状態ファイルの終了の記録で読み戻しを止める。
      }
      await files.removeGenerations(() => true);
    },
  };
}

/**
 * 1 session のファイル群。名前は `<provider>-<runId>.<sessionId>.<種類>.visual-session-state.json` で
 * 揃え、run の片付けと起動時の掃除 (末尾 `.visual-session-state.json`) で一緒に消えるようにする。
 */
function sessionFiles(filePath: string) {
  const base = filePath.endsWith(VISUAL_SESSION_STATE_FILE_SUFFIX)
    ? filePath.slice(0, -VISUAL_SESSION_STATE_FILE_SUFFIX.length)
    : filePath;
  const directory = path.dirname(base);
  const generationPrefix = `${path.basename(base)}.g`;
  const generations = async (): Promise<number[]> => {
    let entries: string[];
    try {
      entries = await fsPromises.readdir(directory);
    } catch {
      return [];
    }
    return entries
      .filter((name) => name.startsWith(generationPrefix) && name.endsWith(VISUAL_SESSION_STATE_FILE_SUFFIX))
      .map((name) => name.slice(generationPrefix.length, -VISUAL_SESSION_STATE_FILE_SUFFIX.length))
      .filter((digits) => /^[1-9]\d*$/.test(digits))
      .map(Number)
      .sort((left, right) => right - left);
  };
  const generation = (value: number) => `${base}.g${value}${VISUAL_SESSION_STATE_FILE_SUFFIX}`;
  return {
    terminal: `${base}.terminal${VISUAL_SESSION_STATE_FILE_SUFFIX}`,
    temporary: () => `${base}.tmp-${randomUUID()}${VISUAL_SESSION_STATE_FILE_SUFFIX}`,
    generation,
    generations,
    async removeGenerations(shouldRemove: (generation: number) => boolean): Promise<void> {
      await Promise.all((await generations())
        .filter(shouldRemove)
        .map((value) => fsPromises.unlink(generation(value)).catch(() => undefined)));
    },
  };
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fsPromises.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readStoredSession(
  filePath: string,
  generation: number,
  sessionId: string,
  provider: AiEditRunContextProvider,
  runId: string,
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
  if (
    !header.success
    || header.data.sessionId !== sessionId
    || header.data.provider !== provider
    || header.data.runId !== runId
    || header.data.generation !== generation
  ) {
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
