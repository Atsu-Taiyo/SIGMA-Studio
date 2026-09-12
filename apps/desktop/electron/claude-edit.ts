import type { AppLocale } from "@/lib/i18n";
import { tv } from "@/lib/ai/validation-locale";
import {
  type AiEditRunEvent,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { parseAttachedFileDataUrl, parseAttachedImageDataUrl } from "./ai-edit-image";
import {
  buildMcpEditPromptForProvider,
  runMcpEditForIpc,
  type McpEditProviderDescriptor,
} from "./ai-edit-shared-runner";
import type { AiResourceRunContext } from "./ai-resource-store";
import type { ClaudeImageInput, ClaudePdfInput, ClaudeStreamClient } from "./claude-stream-client";
import { enforceVisualLoop, stripVisualLoopExhausted } from "./visual-loop-enforcer";

const MAX_CLAUDE_IMAGE_ATTACHMENTS = 4;

function buildClaudeImages(attachments: AiEditAttachment[] | undefined): ClaudeImageInput[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .map((attachment) => parseAttachedImageDataUrl(attachment.dataUrl ?? ""))
    .filter((image): image is NonNullable<ReturnType<typeof parseAttachedImageDataUrl>> => image !== null)
    .map((image) => ({ mediaType: image.mimeType, dataBase64: image.base64 }))
    .slice(0, MAX_CLAUDE_IMAGE_ATTACHMENTS);
}

function buildClaudeDocuments(attachments: AiEditAttachment[] | undefined): ClaudePdfInput[] {
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((attachment) => {
    const file = parseAttachedFileDataUrl(attachment.dataUrl ?? "");
    if (file?.mimeType !== "application/pdf") return [];
    return [{ title: attachment.name, dataBase64: file.base64 }];
  }).slice(0, 4);
}

// Claude は MCP サーバー (sigma-studio-local) のツールでドキュメントを編集する。
// 編集は pending proposal として保存され、デスクトップ側のインラインプレビューで承認される。
export function buildClaudeEditPrompt(args: {
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
  return buildMcpEditPromptForProvider("claude", args);
}

function buildClaudeDescriptor(images: ClaudeImageInput[], documents: ClaudePdfInput[]): McpEditProviderDescriptor<ClaudeStreamClient> {
  return {
    provider: "claude",
    runtime: "claude-mcp",
    displayName: "Claude",
    missingFileIdError: tv("run.providerNeedsFile", { p0: "Claude" }),
    notAvailableFallbackError: tv("run.commandMissing", { p0: "claude", p1: "Claude Code" }),
    notLoggedInError: tv("run.claudeNotSignedIn"),
    thinkingMessage: tv("run.providerThinking", { p0: "Claude" }),
    fallbackAnswerSummary: tv("run.providerAnswered", { p0: "Claude" }),
    fallbackDraftSummary: tv("run.providerDrafted", { p0: "Claude" }),

    async getStatus(client) {
      return client.getStatus();
    },

    async prepareInstruction({ prompt }) {
      // Claude receives image and PDF attachments inline as base64 alongside the turn
      // (`images` / `documents` on ClaudeRunTurnParams), unlike Gemini's @-file references,
      // so the prompt text itself needs no attachment lines and there is no
      // on-disk cleanup to run afterward.
      return { instruction: prompt };
    },

    async runTurn({ client, instruction, userInstruction, references, selectedSkillIds, model, reasoningEffort, agentThreadId, mcpConfig, webSearchEnabled, runId, cwd, onDelta, onToolUse, onToolResult }) {
      const result = await client.runTurn({
        instruction,
        userInstruction,
        references,
        selectedSkillIds,
        images,
        documents,
        model,
        reasoningEffort,
        mcpConfig,
        resumeSessionId: agentThreadId ?? null,
        webSearchEnabled,
        runId,
        cwd,
        onDelta,
        onToolUse,
        onToolResult,
      });

      if (result.cancelled) {
        return {
          finalText: result.finalText,
          isError: false,
          errorMessage: null,
          agentThreadId: result.sessionId ?? undefined,
          repairCount: 0,
          repairMessage: null,
          cancelled: true,
        };
      }

      if (!result.isError) {
        return {
          finalText: result.finalText,
          isError: false,
          errorMessage: null,
          agentThreadId: result.sessionId ?? undefined,
          repairCount: result.permissionDenials.length,
          repairMessage: result.permissionDenials.length > 0
            ? tv("run.operationsBlocked", { p0: result.permissionDenials.length })
            : null,
        };
      }

      const loginErrorDetected = Boolean(
        result.finalText && /not logged in|\/login|authenticate|unauthorized/i.test(result.finalText),
      );
      return {
        finalText: result.finalText,
        isError: true,
        errorMessage: loginErrorDetected
          ? tv("run.claudeNotSignedIn")
          : (result.finalText || tv("run.providerEditFailed", { p0: "Claude" })),
        agentThreadId: result.sessionId ?? undefined,
        repairCount: 0,
        repairMessage: null,
      };
    },
  };
}

export async function runClaudeEditForIpc(args: {
  claude: ClaudeStreamClient;
  payload: unknown;
  aiResources?: AiResourceRunContext;
  onEvent: (event: AiEditRunEvent) => void;
  /** Per-run `--mcp-config` override; see ClaudeRunTurnParams.mcpConfig. */
  mcpConfig?: unknown;
  /** aiWebSearchEnabled設定の現在値; see ClaudeRunTurnParams.webSearchEnabled. */
  webSearchEnabled?: boolean;
  /** This run's id; told to the agent so it can pass it back as the app-context tools' `runId` argument. */
  runId?: string;
  /** Electron userData path used to read the per-run visual-session status file. */
  userDataPath?: string;
  /** プロンプトを組む言語 (IPC ハンドラが run ごとに解決して渡す)。**必須。** */
  locale: AppLocale;
  /** True when ai-edit:cancel was requested between provider turns. */
  isCancelRequested?: () => boolean;
  /** Per-run cwd override; see ClaudeRunTurnParams.cwd. */
  cwd?: string;
}): Promise<AiEditRunResult> {
  const payload = (args.payload ?? {}) as { attachments?: AiEditAttachment[] };
  const images = buildClaudeImages(payload.attachments);
  const documents = buildClaudeDocuments(payload.attachments);

  const runTurn = (turnPayload: unknown, turnImages: ClaudeImageInput[], turnDocuments: ClaudePdfInput[] = []) =>
    runMcpEditForIpc(buildClaudeDescriptor(turnImages, turnDocuments), {
      client: args.claude,
      payload: turnPayload,
      aiResources: args.aiResources,
      locale: args.locale,
      onEvent: args.onEvent,
      suppressFinalPhase: true,
      mcpConfig: args.mcpConfig,
      webSearchEnabled: args.webSearchEnabled,
      runId: args.runId,
      cwd: args.cwd,
    });

  const initialResult = await runTurn(args.payload, images, documents);
  const finalResult = await enforceVisualLoop({
    initialResult,
    userDataPath: args.userDataPath,
    provider: "claude",
    runId: args.runId,
    onEvent: args.onEvent,
    isCancelRequested: args.isCancelRequested,
    runContinuation: ({ prompt, agentThreadId }) => runTurn({
      ...(isRecord(args.payload) ? args.payload : {}),
      instruction: prompt,
      agentThreadId,
      attachments: [],
    }, []),
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

function emit(
  onEvent: (event: AiEditRunEvent) => void,
  event: Omit<AiEditRunEvent, "timestamp">,
): void {
  onEvent({ ...event, timestamp: Date.now() });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
