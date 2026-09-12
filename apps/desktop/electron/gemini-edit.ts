import type { AppLocale } from "@/lib/i18n";
import { tv } from "@/lib/ai/validation-locale";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import {
  type AiEditRunEvent,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { runContextDirPath } from "./ai-edit-run-context";
import { parseAttachedFileDataUrl, type ParsedAttachedFile } from "./ai-edit-image";
import {
  buildMcpEditPromptForProvider,
  runMcpEditForIpc,
  type McpEditProviderDescriptor,
} from "./ai-edit-shared-runner";
import type { AiResourceRunContext } from "./ai-resource-store";
import { GeminiResumeUnavailableError, type GeminiHeadlessClient } from "./gemini-headless-client";
import { ToolActivityWatcher } from "./gemini-tool-activity-watcher";
import { LocalMcpEditProposalStore } from "./local-sigma-doc-proposal-store";
import { enforceVisualLoop, stripVisualLoopExhausted } from "./visual-loop-enforcer";

const MAX_GEMINI_FILE_ATTACHMENTS = 4;

const MIME_TO_EXTENSION: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
};

interface WrittenAttachment {
  relativePath: string;
}

async function writeAttachments(
  workspaceDir: string,
  runId: string,
  attachments: AiEditAttachment[] | undefined,
): Promise<WrittenAttachment[]> {
  if (!Array.isArray(attachments)) {
    return [];
  }
  const images = attachments
    .map((attachment) => parseAttachedFileDataUrl(attachment.dataUrl ?? ""))
    .filter((image): image is ParsedAttachedFile => image !== null && image.mimeType in MIME_TO_EXTENSION)
    .slice(0, MAX_GEMINI_FILE_ATTACHMENTS);
  if (images.length === 0) {
    return [];
  }

  const runDirRelative = path.join("attachments", runId);
  const runDirAbsolute = path.join(workspaceDir, runDirRelative);
  await fs.mkdir(runDirAbsolute, { recursive: true });

  const written: WrittenAttachment[] = [];
  for (const [index, image] of images.entries()) {
    const extension = MIME_TO_EXTENSION[image.mimeType] ?? "bin";
    const fileName = `${image.mimeType === "application/pdf" ? "pdf" : "img"}-${index}.${extension}`;
    await fs.writeFile(path.join(runDirAbsolute, fileName), Buffer.from(image.base64, "base64"));
    written.push({ relativePath: path.join(runDirRelative, fileName) });
  }
  return written;
}

async function cleanupAttachmentDir(workspaceDir: string, runId: string): Promise<void> {
  await fs.rm(path.join(workspaceDir, "attachments", runId), { recursive: true, force: true });
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join("/");
}

function formatAttachmentInstruction(writtenAttachments: WrittenAttachment[], runId: string): string[] {
  if (writtenAttachments.length === 0) {
    return [];
  }
  return [
    tv("run.antigravityAttachedImages", { p0: runId }),
    tv("run.attachmentReferences"),
    ...writtenAttachments.map((image) => `@${toPosixPath(image.relativePath)}`),
  ];
}

// Antigravity CLI は MCP サーバー (sigma-studio-local) のツールでドキュメントを編集する。
// 編集は pending proposal として保存され、デスクトップ側のインラインプレビューで承認される。
export function buildGeminiEditPrompt(args: {
  instruction: string;
  fileId: string;
  selectedId?: string | null;
  referenceText?: string;
  aiResources?: AiResourceRunContext;
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  isResumedTurn?: boolean;
  /** プロンプトを組む言語。**必須** — 渡し忘れをコンパイル時に落とす (mcp-edit-prompt.ts 参照)。 */
  locale: AppLocale;
}): string {
  return buildMcpEditPromptForProvider("antigravity", args);
}

function buildGeminiDescriptor(
  runId: string,
  toolActivityPollIntervalMs?: number,
): McpEditProviderDescriptor<GeminiHeadlessClient> {
  return {
    provider: "antigravity",
    runtime: "antigravity-mcp",
    displayName: "Antigravity",
    missingFileIdError: tv("run.providerNeedsFile", { p0: "Antigravity" }),
    notAvailableFallbackError: tv("run.commandMissing", { p0: "agy", p1: "Antigravity CLI" }),
    notLoggedInError: tv("run.antigravityNotSignedIn"),
    thinkingMessage: tv("run.providerThinking", { p0: "Antigravity" }),
    fallbackAnswerSummary: tv("run.providerAnswered", { p0: "Antigravity" }),
    fallbackDraftSummary: tv("run.providerDrafted", { p0: "Antigravity" }),

    async getStatus(client) {
      return client.getStatus();
    },

    async prepareInstruction({ client, prompt, attachments, cwd }) {
      const workspaceDir = cwd ?? client.getWorkspaceDir();
      const writtenAttachments = await writeAttachments(workspaceDir, runId, attachments);
      const instruction = writtenAttachments.length > 0
        ? [prompt, ...formatAttachmentInstruction(writtenAttachments, runId)].join("\n")
        : prompt;
      return {
        instruction,
        cleanup: () => cleanupAttachmentDir(workspaceDir, runId),
      };
    },

    async runTurn({ client, instruction, model, agentThreadId, fileId, runId, cwd, onEvent, onDelta, onToolUse, onToolResult }) {
      const proposalStore = createProposalStore(client);
      const beforeProposalCount = proposalStore ? await countPendingProposals(proposalStore, fileId) : null;

      // F5 (実機確認): Antigravity CLI にはツール名を得る手段がない (printモードはツールイベントを
      // 一切出力せず、transcript.jsonlにもツール名は載らない)。そこで共有MCPサーバー
      // (mcp/tool-activity.ts) が自分でツール呼び出しをJSONLへ記録し、この watcher がポーリングして
      // onToolUse/onToolResult に変換する (ai-edit-shared-runner.ts が「ツール実行中... (name)」の
      // activityイベントと書き込みツール数カウントに変換してくれる)。
      const userDataDir = typeof client.getUserDataDir === "function" ? client.getUserDataDir() : null;
      const watcher = userDataDir && runId
        ? new ToolActivityWatcher({
            runContextDir: runContextDirPath(userDataDir),
            runId,
            pollIntervalMs: toolActivityPollIntervalMs,
            onActivity: (event) => {
              if (event.status === "started") {
                onToolUse({ id: event.callId, name: event.tool });
              } else {
                onToolResult?.({ toolUseId: event.callId, images: [] });
              }
            },
          })
        : null;
      watcher?.start();

      let turn: Awaited<ReturnType<typeof runTurnWithResumeFallback>>;
      try {
        turn = await runTurnWithResumeFallback(
          client,
          {
            instruction,
            model,
            resumeSessionId: agentThreadId ?? null,
            runId,
            workspaceDir: cwd,
            onDelta,
            onToolUse,
          },
          onEvent,
        );
      } finally {
        await watcher?.stop();
      }

      if (turn.cancelled) {
        return {
          finalText: turn.finalText,
          isError: false,
          errorMessage: null,
          agentThreadId: turn.sessionId ?? undefined,
          repairCount: 0,
          repairMessage: null,
          cancelled: true,
        };
      }
      const afterProposalCount = proposalStore ? await countPendingProposals(proposalStore, fileId) : null;
      const createdProposalCount = beforeProposalCount === null || afterProposalCount === null
        ? undefined
        : Math.max(0, afterProposalCount - beforeProposalCount);

      return {
        finalText: turn.finalText,
        isError: turn.isError,
        errorMessage: turn.isError ? (turn.errorMessage || tv("run.providerEditFailed", { p0: "Antigravity" })) : null,
        agentThreadId: turn.sessionId ?? undefined,
        repairCount: turn.blockedToolCount,
        repairMessage: turn.blockedToolCount > 0
          ? tv("run.operationsBlocked", { p0: turn.blockedToolCount })
          : null,
        createdProposalCount,
      };
    },
  };
}

const proposalStoreCache = new WeakMap<GeminiHeadlessClient, LocalMcpEditProposalStore | null>();

function createProposalStore(client: GeminiHeadlessClient): LocalMcpEditProposalStore | null {
  if (proposalStoreCache.has(client)) {
    return proposalStoreCache.get(client) ?? null;
  }
  const userDataDir = typeof client.getUserDataDir === "function" ? client.getUserDataDir() : null;
  const store = userDataDir ? new LocalMcpEditProposalStore(userDataDir) : null;
  proposalStoreCache.set(client, store);
  return store;
}

async function countPendingProposals(store: LocalMcpEditProposalStore, fileId: string): Promise<number> {
  const proposals = await store.listProposals({ status: "pending" });
  return proposals.filter((proposal) => proposal.fileId === fileId).length;
}

export async function runGeminiEditForIpc(args: {
  gemini: GeminiHeadlessClient;
  payload: unknown;
  aiResources?: AiResourceRunContext;
  onEvent: (event: AiEditRunEvent) => void;
  /**
   * This run's id (from ai-edit:run). Reused (instead of minting a fresh
   * randomUUID here) so the attachments/<runId> directory name matches the
   * runId the agent is told in the prompt and the per-run run-context file
   * name main.ts writes — one id identifies the run across all three.
   */
  runId?: string;
  /**
   * aiWebSearchEnabled設定の現在値。Antigravityではプロンプトの Web検索ポリシー節の
   * 出し分けにだけ使う: agy CLI (--print) にはWeb検索を有効/無効化できるフラグ・設定が
   * 見当たらないため (gemini-headless-client.ts の buildSpawnArgs コメント参照)、
   * ツール実行の可否そのものはこの設定では制御できない。
   */
  webSearchEnabled?: boolean;
  /** Test-only override for ToolActivityWatcher's poll interval (see gemini-tool-activity-watcher.ts). */
  toolActivityPollIntervalMs?: number;
  /** Electron userData path used to read the per-run visual-session status file. */
  userDataPath?: string;
  /** プロンプトを組む言語 (IPC ハンドラが run ごとに解決して渡す)。**必須。** */
  locale: AppLocale;
  /** True when ai-edit:cancel was requested between provider turns. */
  isCancelRequested?: () => boolean;
  /** Per-run workspaceDir override; see GeminiRunTurnParams.workspaceDir. */
  cwd?: string;
}): Promise<AiEditRunResult> {
  const runId = args.runId?.trim() || randomUUID();
  const runTurn = (turnPayload: unknown) =>
    runMcpEditForIpc(buildGeminiDescriptor(runId, args.toolActivityPollIntervalMs), {
      client: args.gemini,
      payload: turnPayload,
      aiResources: args.aiResources,
      locale: args.locale,
      onEvent: args.onEvent,
      suppressFinalPhase: true,
      webSearchEnabled: args.webSearchEnabled,
      runId,
      cwd: args.cwd,
    });

  const initialResult = await runTurn(args.payload);
  const finalResult = await enforceVisualLoop({
    initialResult,
    userDataPath: args.userDataPath,
    provider: "antigravity",
    runId,
    onEvent: args.onEvent,
    isCancelRequested: args.isCancelRequested,
    runContinuation: ({ prompt, agentThreadId }) => runTurn({
      ...(isRecord(args.payload) ? args.payload : {}),
      instruction: prompt,
      agentThreadId,
      attachments: [],
    }),
  });

  if (finalResult.status === "cancelled") {
    emit(args.onEvent, {
      kind: "phase",
      phase: "complete",
      message: tv("run.interruptedByUser"),
    });
    return stripVisualLoopExhausted(finalResult);
  }

  emit(args.onEvent, {
    kind: "phase",
    phase: "complete",
    message: finalResult.exhausted
      ? tv("run.doneVisualReviewFailed")
      : finalResult.status === "draft"
        ? tv("run.draftReady")
        : tv("run.answerComplete"),
  });

  return stripVisualLoopExhausted(finalResult);
}

async function runTurnWithResumeFallback(
  gemini: GeminiHeadlessClient,
  params: Parameters<GeminiHeadlessClient["runTurn"]>[0],
  onEvent: (event: AiEditRunEvent) => void,
) {
  try {
    return await gemini.runTurn(params);
  } catch (error) {
    if (error instanceof GeminiResumeUnavailableError && params.resumeSessionId) {
      emit(onEvent, {
        kind: "repair",
        phase: "thinking",
        message: tv("run.sessionResumeFailed"),
      });
      return gemini.runTurn({ ...params, resumeSessionId: null });
    }
    throw error;
  }
}

function emit(
  onEvent: (event: AiEditRunEvent) => void,
  event: Omit<AiEditRunEvent, "timestamp">,
): void {
  onEvent({ ...event, timestamp: Date.now() });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
