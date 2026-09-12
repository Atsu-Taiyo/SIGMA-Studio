import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { parseAiEditTextRange, resolveAiEditTextRangeBlockIds } from "@/lib/ai/ai-edit-reference";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { computeDocumentBlockHashes } from "@/lib/sigma-doc-block-hash";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import type { SigmaDocument } from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";
import type { LocalSigmaDocStore } from "./local-sigma-doc-store";

const ta = createCurrentLocaleTranslator("ai");

export const SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV = "SIGMA_STUDIO_RUN_CONTEXT_FILE";

const DATA_DIR_NAME = "data";
const RUN_CONTEXT_DIR_NAME = "ai-run-context";

// 実行コンテキストディレクトリの絶対パス。LocalAiEditRunContextStore が内部で使うほか、
// gemini-edit.ts が ToolActivityWatcher の監視対象ディレクトリを組み立てるのにも使う
// (userDataDir から run-context ファイルと同じディレクトリを逆算する)。
export function runContextDirPath(userDataPath: string): string {
  return path.join(userDataPath, DATA_DIR_NAME, RUN_CONTEXT_DIR_NAME);
}

export type AiEditRunContextProvider = "claude" | "chatgpt" | "antigravity";

// runId が渡された場合は provider-runId 単位のファイル名にする (同一providerでの並行実行を
// 分離するため)。省略時は従来どおり provider 単位の静的ファイル名で、これはアプリ起動時に
// MCPサーバー起動設定へ焼き込まれる codex/antigravity (常駐app-server / 固定cwdのプロジェクト
// 設定発見に依存) で今も使われている。
// MCPサーバー側 (sigma-doc-mcp-app-context.ts) が、tool呼び出しに乗ってきたrunIdから
// 同じ規則で per-run ファイル名を逆算できるよう export している。
export function runContextFileName(provider: AiEditRunContextProvider, runId?: string): string {
  if (runId && runId.trim().length > 0) {
    return `${provider}-${sanitizeRunIdForFileName(runId)}.run-context.json`;
  }
  return `${provider}.run-context.json`;
}

// Antigravity CLI (`agy --print`) はツール呼び出しイベントを一切出力しない。共有MCPサーバー
// (mcp/tool-activity.ts) が自分でツール呼び出しをこの名前のJSONLファイルへ記録し、デスクトップ側
// (electron/gemini-tool-activity-watcher.ts) がポーリングしてUIの「ツール実行中...」表示に変換する。
// runContextFileName と同じ命名規則 (runId単位/provider単位の静的ファイル) を流用する。
export function toolActivityFileName(provider: AiEditRunContextProvider, runId?: string): string {
  if (runId && runId.trim().length > 0) {
    return `${provider}-${sanitizeRunIdForFileName(runId)}.tool-activity.jsonl`;
  }
  return `${provider}.tool-activity.jsonl`;
}

// The MCP server writes the current visual-edit-session state here so the Electron
// main process can inspect unfinished sessions after a turn. Keep the same per-run
// naming and sanitization convention as the run-context and tool-activity files.
export function visualSessionsFileName(provider: AiEditRunContextProvider, runId?: string): string {
  if (runId && runId.trim().length > 0) {
    return `${provider}-${sanitizeRunIdForFileName(runId)}.visual-sessions.json`;
  }
  return `${provider}.visual-sessions.json`;
}

function sanitizeRunIdForFileName(runId: string): string {
  const sanitized = runId.trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 200);
  return sanitized.length > 0 ? sanitized : "run";
}

// AiEditAttachment / AiEditMentionedDocumentContext (@/lib/ai/sigma-doc-agent-tools) と
// `satisfies` で結び付けることで、正本の型にフィールドが増えた場合にここが型検査で
// 気付かれずフィールドを落とすことを防ぐ。mentionedDocuments の document はJSON化された
// SigmaDocument (実行コンテキストファイル経由のためRecordとして受ける) なので、
// AiEditMentionedDocumentContext の document(SigmaDocument型)とは別枠で扱う。
export const AiEditAttachmentItemSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  mimeType: z.string().nullable(),
  dataUrl: z.string().min(1).regex(/^data:[^,]+,/, { error: () => ta("desktop.runContext.invalidDataUrl") }),
  width: z.number().optional(),
  height: z.number().optional(),
  fileSize: z.number().optional(),
  sourceReferenceKey: z.string().optional(),
}) satisfies z.ZodType<AiEditAttachment>;

export const AiEditMentionedDocumentItemSchema = z.object({
  id: z.string().min(1),
  fileId: z.string().min(1),
  title: z.string(),
  documentPath: z.string(),
  revision: z.number().int().nonnegative(),
  excerpt: z.string(),
  document: z.record(z.string(), z.unknown()),
}) satisfies z.ZodType<Omit<AiEditMentionedDocumentContext, "document"> & { document: Record<string, unknown> }>;

// 「依頼時の選択範囲」のスナップショット。run開始時 (prepareAiEditRunContext) に、選択されていた
// ブロック/overlay図形の内容ハッシュ (computeDocumentBlockHashes と同じ規則) を記録する。
// 新しい提案はdraftの実上書き対象を衝突判定に使い、この値は旧提案のフォールバックと監査用に残す。
export const AiEditRequestSelectionSchema = z.object({
  blockIds: z.array(z.string().min(1)),
  hashes: z.record(z.string(), z.string()),
  capturedRevision: z.number().int().nonnegative(),
});

export type AiEditRequestSelection = z.infer<typeof AiEditRequestSelectionSchema>;

export const AiEditRunContextSchema = z.object({
  version: z.literal(1),
  runId: z.string().min(1),
  createdAt: z.string().min(1),
  provider: z.enum(["claude", "chatgpt", "antigravity"]),
  fileId: z.string().min(1),
  fileRevision: z.number().int().nonnegative(),
  selectedId: z.string().min(1).nullable(),
  references: z.array(
    z.object({ kind: z.string().min(1), targetId: z.string().min(1) }).catchall(z.unknown()),
  ),
  // 依頼時の選択範囲スナップショット。MCPサーバーが提案作成時に読み出して提案へ記録する。
  // 旧run-contextファイルには存在しないため任意 (その提案は touchedBlocks フォールバックで扱う)。
  requestSelection: AiEditRequestSelectionSchema.optional(),
  attachments: z.array(AiEditAttachmentItemSchema).max(8),
  mentionedDocuments: z.array(AiEditMentionedDocumentItemSchema).max(8),
  // 提案の帰属 (electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalAttribution)
  // を作るためだけの任意フィールド。renderer側がまだこれらを payload に乗せていなくても
  // (今回のバッチの外)、欠けていれば単に省略されるだけで既存の実行コンテキストは壊れない。
  // MCPサーバー (mcp/sigma-doc-mcp-server-core.ts、今回のバッチ外) が提案作成時にこの実行
  // コンテキストを読み込み、resolveProposalAttribution(context) 経由で createProposal に渡す。
  roomId: z.string().min(1).optional(),
  turnId: z.string().min(1).optional(),
  sessionLabel: z.string().min(1).optional(),
});

export type AiEditRunContext = z.infer<typeof AiEditRunContextSchema>;

export type AiEditRunContextLoadResult =
  | { state: "none" }
  | { state: "invalid"; error: string }
  | { state: "ready"; context: AiEditRunContext };

export interface LoadAiEditRunContextOptions {
  /**
   * runId carried on the MCP tool call (see the `runId` argument added to the
   * app-context tools). When both runId and provider are known, the shared
   * MCP server process (Codex app-server / Antigravity) resolves the
   * per-run file `<provider>-<runId>.run-context.json` in the SAME directory
   * as the static provider file baked into its env at startup, instead of
   * that shared static file. This lets concurrent same-provider runs stay
   * correlated even though the MCP server's launch env is fixed once.
   * When runId or provider is missing (older prompts, model forgot the
   * argument, non-app callers), this falls back to the static file so
   * single-run behavior keeps working unchanged.
   */
  runId?: string;
  provider?: AiEditRunContextProvider;
}

function resolveRunContextFilePath(
  env: Record<string, string | undefined>,
  options: LoadAiEditRunContextOptions,
): string | undefined {
  const staticFilePath = env[SIGMA_STUDIO_RUN_CONTEXT_FILE_ENV]?.trim();
  if (!staticFilePath) {
    return undefined;
  }
  const runId = options.runId?.trim();
  if (!runId || !options.provider) {
    return staticFilePath;
  }
  return path.join(path.dirname(staticFilePath), runContextFileName(options.provider, runId));
}

export function loadAiEditRunContext(
  env: Record<string, string | undefined>,
  options: LoadAiEditRunContextOptions = {},
): AiEditRunContextLoadResult {
  const filePath = resolveRunContextFilePath(env, options);
  if (!filePath) {
    return { state: "none" };
  }

  let raw: string;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    if (isEnoent(error)) {
      return { state: "none" };
    }
    return { state: "invalid", error: error instanceof Error ? error.message : ta("desktop.runContext.readFailed") };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    return { state: "invalid", error: error instanceof Error ? error.message : ta("desktop.runContext.jsonReadFailed") };
  }

  const parsed = AiEditRunContextSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return { state: "invalid", error: parsed.error.message };
  }

  return { state: "ready", context: parsed.data };
}

function isEnoent(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && "code" in (error as Record<string, unknown>)
    && (error as { code?: string }).code === "ENOENT";
}

export interface LocalAiEditRunContextStoreOptions {
  /**
   * When set, this store is scoped to a single run (its own file, distinct from
   * every other run of the same provider). Used for providers where the run
   * context file path is threaded per-invocation into the agent CLI (Claude:
   * passed as a `--mcp-config` CLI arg per spawned turn). Providers whose MCP
   * launch config is baked once at app startup (Codex app-server, Antigravity
   * workspace settings) cannot make use of a per-run path yet and keep the
   * legacy static provider-level file by omitting this.
   */
  runId?: string;
}

export class LocalAiEditRunContextStore {
  private readonly runContextFilePath: string;

  constructor(
    userDataPath: string,
    provider: AiEditRunContextProvider,
    options: LocalAiEditRunContextStoreOptions = {},
  ) {
    this.runContextFilePath = path.join(runContextDirPath(userDataPath), runContextFileName(provider, options.runId));
  }

  getRunContextFilePath(): string {
    return this.runContextFilePath;
  }

  async write(context: AiEditRunContext): Promise<void> {
    await fs.mkdir(path.dirname(this.runContextFilePath), { recursive: true });
    const tmpPath = `${this.runContextFilePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(context), "utf8");
    await fs.rename(tmpPath, this.runContextFilePath);
  }

  async clear(): Promise<void> {
    try {
      await fs.unlink(this.runContextFilePath);
    } catch (error) {
      if (!isEnoent(error)) {
        console.warn("実行コンテキストの削除に失敗しました。", error);
      }
    }
  }

  // clear() は無条件に削除する。並行実行中の別runがこのstoreの静的パスへ後から
  // 書き込んでいた場合、無条件clear()はその別runのコンテキストを消してしまう
  // (provider単位で1ファイルを共有するCodex/Antigravityで起こりうる)。
  // クリーンアップ呼び出し元が「自分が書いたrunId」を知っている場合はこちらを使うと、
  // 既に他runの内容に上書きされていたときは何もせずスキップできる。
  async clearIfRunId(expectedRunId: string): Promise<void> {
    let raw: string;
    try {
      raw = await fs.readFile(this.runContextFilePath, "utf8");
    } catch (error) {
      if (!isEnoent(error)) {
        console.warn("実行コンテキストの所有権確認に失敗しました。", error);
      }
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const currentRunId = isRecord(parsed) && typeof parsed.runId === "string" ? parsed.runId : undefined;
    if (currentRunId !== expectedRunId) {
      // 別run (おそらく後から開始した並行run) がこのパスへ上書き済み。触らない。
      return;
    }

    await this.clear();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlausibleSigmaDocument(value: unknown): value is SigmaDocument {
  return SigmaDocumentSchema.safeParse(value).success;
}

// アプリ起動時に、runId単位のrun-contextファイル (<provider>-<runId>.run-context.json) の
// 積み残しを一括で掃除する。前回終了時にクラッシュ等で削除されなかったものが対象。
// provider単位の静的ファイル (<provider>.run-context.json) はこの関数の対象外
// (呼び出し元が個別に clear() している)。
// Antigravity用のtool-activityファイル (<provider>[-<runId>].tool-activity.jsonl) と、MCPが
// 書き出すvisual session statusファイル (<provider>-<runId>.visual-sessions.json) も同様に
// 積み残しうる (ToolActivityWatcher.stop() はper-runファイルをbest-effortで消すが、クラッシュ時は
// 消えない。静的ファイルはwatcherが消さない設計なので、こちらも起動時掃除の対象に含める)。
export async function sweepOrphanPerRunContextFiles(
  userDataPath: string,
  provider: AiEditRunContextProvider,
): Promise<void> {
  const dir = runContextDirPath(userDataPath);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch (error) {
    if (!isEnoent(error)) {
      console.warn("実行コンテキストディレクトリの掃除に失敗しました。", error);
    }
    return;
  }

  const perRunPrefix = `${provider}-`;
  const staticToolActivityName = toolActivityFileName(provider);
  await Promise.all(
    entries
      .filter(
        (name) =>
          (name.startsWith(perRunPrefix) && (
            name.endsWith(".run-context.json")
            || name.endsWith(".tool-activity.jsonl")
            || name.endsWith(".visual-sessions.json")
          )) ||
          name === staticToolActivityName,
      )
      .map((name) =>
        fs.unlink(path.join(dir, name)).catch((error) => {
          if (!isEnoent(error)) {
            console.warn(`孤立した実行コンテキストファイルの削除に失敗しました (${name})。`, error);
          }
        }),
      ),
  );

  // No runs are live when this startup/shutdown sweep runs. All three
  // providers may call it concurrently, so removing the whole directory is
  // safe and idempotent.
  const previewsDir = path.join(dir, "previews");
  await fs.rm(previewsDir, { recursive: true, force: true }).catch((error) => {
    if (!isEnoent(error)) {
      console.warn("孤立したpreviewディレクトリの削除に失敗しました。", error);
    }
  });
}

export interface PrepareAiEditRunContextPayload {
  fileId?: string;
  document?: unknown;
  selectedId?: string | null;
  references?: { kind: string; targetId: string; [key: string]: unknown }[];
  attachments?: AiEditAttachment[];
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  /**
   * 提案の帰属情報 (LocalMcpEditProposalAttribution) 用の任意フィールド。renderer→main の
   * ai-edit:run payload がこれらを含んでいれば実行コンテキストファイルへそのまま永続化され、
   * MCPサーバー (今回のバッチ外) が resolveProposalAttribution() 経由で提案作成時に読み出せる
   * ようになる。renderer側でこれらを実際に payload へ乗せる配線は今回のバッチの対象外。
   */
  roomId?: string;
  turnId?: string;
  sessionLabel?: string;
}

export interface PrepareAiEditRunContextInput {
  provider: AiEditRunContextProvider;
  runContextStore: LocalAiEditRunContextStore;
  sigmaDocStore: LocalSigmaDocStore;
  runId: string;
  payload: PrepareAiEditRunContextPayload;
}

// 個々のitemをschemaでsafeParseし、不正な1件だけを警告付きで除外する。マッチした要素の
// 型はitem schemaの入力型と一致する(satisfiesで正本の型と結び付けている)。
function filterValidItems<T>(items: T[], schema: z.ZodType<unknown>, describeItem: (item: T) => string): T[] {
  const valid: T[] = [];
  for (const item of items) {
    const result = schema.safeParse(item);
    if (result.success) {
      valid.push(item);
    } else {
      console.warn(`実行コンテキストの項目を検証に失敗したため除外しました(${describeItem(item)})。`, result.error.message);
    }
  }
  return valid;
}

/**
 * 「依頼時の選択範囲」を run 開始時にスナップショットする。
 * 選択の出所は payload の selectedId / references (複数可) / references[].overlaySelection の図形ID。
 * textSelection は targetId 1件へ潰さず、textRange が覆う全ブロックを記録する。
 * それぞれ現在ドキュメント上の内容ハッシュを記録する。選択が空 (全文/末尾追加系の依頼) の
 * 場合も blockIds: [] を記録し、スナップショット自体が無いレガシー提案と区別する。
 * ドキュメントが読めないなど計算できない場合のみ null (レガシー扱いに落ちる)。
 */
async function captureRequestSelection(
  sigmaDocStore: LocalSigmaDocStore,
  fileId: string,
  fileRevision: number,
  payload: PrepareAiEditRunContextPayload,
): Promise<AiEditRequestSelection | null> {
  const ids = new Set<string>();
  const push = (value: unknown): void => {
    if (typeof value === "string" && value.trim().length > 0) {
      ids.add(value.trim());
    }
  };
  push(payload.selectedId);
  const textRangeReferences: NonNullable<PrepareAiEditRunContextPayload["references"]> = [];
  for (const reference of payload.references ?? []) {
    const textRange = reference?.kind === "textSelection"
      ? parseAiEditTextRange(reference.textRange)
      : null;
    if (textRange) {
      textRangeReferences.push(reference);
    } else if (reference?.kind === "textSelection") {
      const selectedBlockIds = readNonEmptyStringArray(reference.selectedBlockIds);
      if (selectedBlockIds.length > 0) {
        selectedBlockIds.forEach(push);
      } else {
        push(reference.targetId);
      }
    } else {
      push(reference?.targetId);
    }
    const overlaySelection = reference?.overlaySelection;
    if (isRecord(overlaySelection)) {
      readNonEmptyStringArray(overlaySelection.selectedShapeIds).forEach(push);
      if (Array.isArray(overlaySelection.shapes)) {
        for (const shape of overlaySelection.shapes) {
          if (isRecord(shape)) {
            push(shape.id);
          }
        }
      }
    }
  }

  if (ids.size === 0 && textRangeReferences.length === 0) {
    return { blockIds: [], hashes: {}, capturedRevision: fileRevision };
  }

  let document: SigmaDocument | null;
  if (isPlausibleSigmaDocument(payload.document)) {
    document = payload.document;
  } else {
    try {
      document = await sigmaDocStore.loadDocument(fileId);
    } catch {
      return null;
    }
  }
  if (!document) {
    return null;
  }

  for (const reference of textRangeReferences) {
    const textRange = parseAiEditTextRange(reference.textRange);
    const resolvedBlockIds = textRange
      ? resolveAiEditTextRangeBlockIds(document, textRange)
      : [];
    const fallbackBlockIds = readNonEmptyStringArray(reference.selectedBlockIds);
    const selectedBlockIds = resolvedBlockIds.length > 0
      ? resolvedBlockIds
      : fallbackBlockIds.length > 0
        ? fallbackBlockIds
        : [reference.targetId];
    selectedBlockIds.forEach(push);
  }

  const allHashes = computeDocumentBlockHashes(document);
  const blockIds = [...ids];
  const hashes: Record<string, string> = {};
  for (const id of blockIds) {
    const hash = allHashes[id];
    if (hash !== undefined) {
      hashes[id] = hash;
    }
    // ドキュメント上に存在しないID (例: 選択直後に削除された) はhashesに含めない。
    // 承認時の比較では「記録なし ≠ 現在あり」も「記録あり ≠ 現在なし」も変更として扱われる。
  }
  return { blockIds, hashes, capturedRevision: fileRevision };
}

function readNonEmptyStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim())
    .filter(Boolean))];
}

export async function prepareAiEditRunContext(
  input: PrepareAiEditRunContextInput,
): Promise<() => Promise<void>> {
  const clearStaleContext = async (): Promise<void> => {
    await input.runContextStore.clear();
  };
  const noopCleanup = async (): Promise<void> => {};

  const fileId = input.payload.fileId?.trim();
  if (!fileId) {
    await clearStaleContext();
    return noopCleanup;
  }

  const files = await input.sigmaDocStore.listFiles();
  const file = files.find((item) => item.fileId === fileId);
  if (!file) {
    await clearStaleContext();
    return noopCleanup;
  }

  const sanitizedAttachments = filterValidItems(
    (input.payload.attachments ?? []).slice(0, 8),
    AiEditAttachmentItemSchema,
    (item) => `attachment id=${item.id}`,
  );

  const sanitizedMentionedDocuments = filterValidItems(
    (input.payload.mentionedDocuments ?? []).slice(0, 8),
    AiEditMentionedDocumentItemSchema,
    (item) => `mentionedDocument id=${item.id}`,
  ).map((doc) => ({
    ...doc,
    document: doc.document as unknown as Record<string, unknown>,
  }));

  const roomId = input.payload.roomId?.trim();
  const turnId = input.payload.turnId?.trim();
  const sessionLabel = input.payload.sessionLabel?.trim();
  const requestSelection = await captureRequestSelection(input.sigmaDocStore, fileId, file.revision, input.payload);

  const candidate: unknown = {
    version: 1,
    runId: input.runId,
    createdAt: new Date().toISOString(),
    provider: input.provider,
    fileId,
    fileRevision: file.revision,
    selectedId: input.payload.selectedId?.trim() || null,
    references: input.payload.references ?? [],
    ...(requestSelection ? { requestSelection } : {}),
    attachments: sanitizedAttachments,
    mentionedDocuments: sanitizedMentionedDocuments,
    ...(roomId ? { roomId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(sessionLabel ? { sessionLabel } : {}),
  };

  const parsed = AiEditRunContextSchema.safeParse(candidate);
  if (!parsed.success) {
    console.warn("実行コンテキストの検証に失敗したため書き込みをスキップしました。", parsed.error.message);
    await clearStaleContext();
    return noopCleanup;
  }

  await input.runContextStore.write(parsed.data);
  // clearIfRunId: このstoreが provider 単位の静的パスの場合、cleanup が呼ばれるまでの間に
  // 別の並行runが同じパスへ上書きしている可能性がある。無条件 clear() だとその別runの
  // コンテキストを消してしまうため、書き込んだ runId が今も現在のファイルの中身と一致する
  // ときだけ削除する。runId 別ファイル (Claude) では常に自分のものなので実質無条件clear()と同じ。
  return () => input.runContextStore.clearIfRunId(input.runId);
}
