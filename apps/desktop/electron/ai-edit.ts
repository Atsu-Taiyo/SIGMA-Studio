import path from "node:path";
import { CodexGeneratedImageStore } from "./codex-generated-images";
import { CodexImageGenerationRun } from "./codex-image-generation-run";
import { tv } from "@/lib/ai/validation-locale";
import { truncateWebActivityLabel } from "./ai-edit-shared-runner";
import { createTranslator, DEFAULT_LOCALE, type AppLocale } from "@/lib/i18n";
import { formatAiEditReferencesForPrompt, type AiEditReference } from "@/lib/ai/ai-edit-reference";
import {
  buildMcpEditTurnPrompt,
  buildMcpRefusedOperationContinuationPrompt,
  describeRefusedItemType,
  buildMcpEditInvariantGuidance,
  buildMcpWebSearchPrompt,
} from "@/lib/ai/mcp-edit-prompt";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import { buildCancelledMcpEditRunResult, buildMcpEditRunResult, isWriteCapableMcpToolName, toCodexImageInputUrls } from "./ai-edit-shared";
import {
  DEFAULT_AI_EDIT_REASONING_EFFORT,
  DEFAULT_AI_EDIT_MODEL,
  type AiEditModel,
  type AiEditReasoningEffort,
} from "@/lib/ai/sigma-doc-edit-schema";
import {
  getAttachmentDefaultInstruction,
  type AiEditAgentItemType,
  type AiEditPlanStep,
  type AiEditPlanStepStatus,
  type AiEditRunEvent,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";
import type { SigmaDocument } from "@/features/document";
import {
  parseCodexReconnectProgress,
  type CodexAppServerClient,
  type CodexTurnImageInput,
  type CodexTurnInput,
} from "./codex-app-server-client";
import type { AiResourceRunContext } from "./ai-resource-store";
import { enforceVisualLoop, stripVisualLoopExhausted } from "./visual-loop-enforcer";

interface IncomingPayload {
  model?: AiEditModel;
  reasoningEffort?: AiEditReasoningEffort;
  instruction?: string;
  document?: SigmaDocument;
  fileId?: string;
  selectedId?: string | null;
  references?: AiEditReference[];
  attachments?: AiEditAttachment[];
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  agentThreadId?: string | null;
  // 提案の帰属 (electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalAttribution)。
  // ここでは読み取らないが、この同じ payload オブジェクトが ai-edit-run-context.ts の
  // prepareAiEditRunContext にも渡るため、renderer が乗せてくればそのまま実行コンテキストへ
  // 永続化される。
  roomId?: string;
  turnId?: string;
  sessionLabel?: string;
}

// Drops a trailing "-mini" to select the stronger (vision-capable / higher
// quality) variant of the same model family.
function stripMiniSuffix(model: AiEditModel): AiEditModel {
  return model.endsWith("-mini") ? (model.replace(/-mini$/, "") as AiEditModel) : model;
}

function normalizeModel(model: AiEditModel | undefined, hasImage: boolean): AiEditModel {
  if (typeof model !== "string" || model.length === 0) {
    return DEFAULT_AI_EDIT_MODEL;
  }
  if (hasImage) {
    return stripMiniSuffix(model);
  }
  return model;
}

function isValidReasoningEffort(value: unknown): value is AiEditReasoningEffort {
  return typeof value === "string" && value.trim().length > 0;
}

// Keywords that signal a structured/heavier edit (graphs, tables, problems, proofs).
// **これは表示文言ではなく、利用者の指示文に対する照合語彙。** 訳して 1 言語にすると
// もう一方の言語で書かれた指示が全部 trivial 判定になる。日英どちらの語も並べて持つ
// (WI-8 の増減表語彙と同じ扱い)。
const NON_TRIVIAL_EFFORT_KEYWORDS = [
  "グラフ",
  "表",
  "増減",
  "問題",
  "証明",
  "graph",
  "table",
  "solve",
  "problem",
  "proof",
  "variation",
  "monotonic",
];


// Conservative default when the renderer omits an effort: "medium", downgraded
// to "low" only for clearly trivial short instructions. Never upgrades above
// medium (escalation on failure is handled separately).
function inferReasoningEffort(
  instruction: string,
  { hasImage }: { hasImage: boolean },
): AiEditReasoningEffort {
  const trimmed = instruction.trim();
  const lowered = trimmed.toLowerCase();
  const isTrivial =
    trimmed.length < 30 &&
    !hasImage &&
    !NON_TRIVIAL_EFFORT_KEYWORDS.some((keyword) => lowered.includes(keyword.toLowerCase()));
  return isTrivial ? "low" : "medium";
}

const MAX_CODEX_IMAGE_ATTACHMENTS = 4;

/**
 * How many extra turns we spend telling the agent to redo the work with MCP
 * tools after a forbidden operation was refused. Modeled on the visual-review
 * continuation loop (visual-loop-enforcer.ts); kept small because a refusal
 * usually means the agent picked the wrong tool once, not that it is stuck.
 */
export const MAX_REFUSAL_CONTINUATIONS = 2;

/**
 * 拒否された操作の注意書き。**module 直下で解決しない** — 読み込み時の言語で
 * 焼き付いてしまう (`validation-locale.ts` 参照)。表示直前に引く。
 */
export function refusedOperationWarning(): string {
  return tv("run.refusedOperationWarning");
}

function appendRefusedOperationWarning(summary: string): string {
  const trimmed = summary.trim();
  const warning = refusedOperationWarning();
  return trimmed ? `${trimmed}\n\n${warning}` : warning;
}

export async function runAiEditForIpc(args: {
  codex: CodexAppServerClient;
  payload: unknown;
  aiResources?: AiResourceRunContext;
  onEvent: (event: AiEditRunEvent) => void;
  /**
   * This run's id (from ai-edit:run). Told to the agent in the prompt so it
   * can pass it back as the `runId` argument on app-context MCP tool calls.
   * Codex's MCP server is a single app-server process shared by every
   * concurrent Codex run, so without this the server has no way to tell
   * which run-context file (written per-run by main.ts) belongs to this turn.
   */
  runId?: string;
  /** Electron userData path used to read the per-run visual-session status file. */
  userDataPath?: string;
  /** aiWebSearchEnabled設定の現在値 (main.ts が run ごとに読み直して渡す)。 */
  webSearchEnabled?: boolean;
  /** True when ai-edit:cancel was requested between provider turns. */
  isCancelRequested?: () => boolean;
  /**
   * Per-run cwd override: このワークスペースの `agent-workspaces/<workspaceId>/codex`
   * ディレクトリ(LocalAiResourceStore.getAgentWorkspaceDir)。省略時は codexWorkspace
   * (workspaceId未解決runのフォールバック固定ディレクトリ)を使う。
   */
  cwd?: string;
  /**
   * プロンプトと進捗表示を組む言語 (main.ts が run ごとに解決して渡す)。
   * **main には renderer の React context が無い**ので引数で受ける。
   * 教材の中身の言語はこれとは独立 (`prompt.documentLanguagePolicy` を参照)。
   */
  locale?: AppLocale;
}): Promise<AiEditRunResult> {
  const locale = args.locale ?? DEFAULT_LOCALE;
  const tPrompt = createTranslator(locale, "prompt");
  const tAi = createTranslator(locale, "ai");
  const payload = (args.payload ?? {}) as IncomingPayload;
  if (!payload.document) {
    throw new Error(tv("run.missingDocument"));
  }
  const document = payload.document;

  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const hasImage = attachments.some((a) => typeof a?.dataUrl === "string" && a.dataUrl.startsWith("data:image/"));
  const rawInstruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";
  const instruction = rawInstruction || getAttachmentDefaultInstruction(attachments, tPrompt);
  if (instruction.length === 0) {
    throw new Error(tv("run.emptyInstruction"));
  }
  const fileId = typeof payload.fileId === "string" ? payload.fileId.trim() : "";
  if (fileId.length === 0) {
    throw new Error(tv("run.providerNeedsFile", { p0: "Codex" }));
  }
  const model = normalizeModel(payload.model, hasImage);
  // The UI always sends an explicit effort, so this is effectively a fallback:
  // respect a valid incoming value, otherwise infer a conservative default.
  const reasoningEffort = isValidReasoningEffort(payload.reasoningEffort)
    ? payload.reasoningEffort
    : inferReasoningEffort(instruction, { hasImage });
  const references = Array.isArray(payload.references) ? payload.references : [];
  const selectedId = payload.selectedId ?? references[0]?.targetId ?? null;
  const referenceText = references.length > 0 ? formatAiEditReferencesForPrompt(references) : undefined;

  emit(args.onEvent, {
    kind: "phase",
    phase: "preparing",
    message: tv("run.preparing"),
  });

  const status = await args.codex.getStatus();
  if (!status.available) {
    throw new Error(status.error ?? tv("run.commandMissing", { p0: "codex", p1: "Codex CLI" }));
  }
  if (!status.loggedIn) {
    throw new Error(tv("run.codexNotSignedIn"));
  }

  const threadId = await resolveThreadId(
    args.codex,
    payload.agentThreadId ?? null,
    model,
    reasoningEffort,
    args.webSearchEnabled === true,
    locale,
    args.cwd,
  );

  const prompt = buildMcpEditTurnPrompt("codex", {
    toolProfile: "app",
    instruction,
    fileId,
    selectedId,
    referenceText,
    aiResources: args.aiResources,
    mentionedDocuments: payload.mentionedDocuments,
    attachments,
    runId: args.runId,
    webSearchEnabled: args.webSearchEnabled,
  }, locale) + `\n\n${tPrompt("generatedImages.guide")}`;

  emit(args.onEvent, {
    kind: "phase",
    phase: "thinking",
    message: tv("run.providerThinking", { p0: "Codex" }),
  });

  const input: Array<CodexTurnInput | CodexTurnImageInput> = [
    { type: "text", text: prompt, text_elements: [] },
    ...toCodexImageInputUrls(attachments, MAX_CODEX_IMAGE_ATTACHMENTS)
      .map((url): CodexTurnImageInput => ({ type: "image", url })),
  ];

  const generatedImages = args.userDataPath && args.runId ? new CodexGeneratedImageStore(path.join(args.userDataPath, "data")) : null;
  const imageRun = generatedImages && args.runId ? new CodexImageGenerationRun({
    store: generatedImages, runId: args.runId, fileId,
    allowedRoots: [status.codexHome, args.cwd ?? path.join(path.dirname(status.codexHome), "codex-agent-workspace")],
    onEvent: args.onEvent, isCancelled: () => args.isCancelRequested?.() === true,
  }) : null;
  let toolCount = 0;
  let generatedImageProposalCount = 0;
  const runCodexTurn = async (turnInput: Array<CodexTurnInput | CodexTurnImageInput>, turnThreadId: string) => {
    try {
      const turnResult = await args.codex.runTurn({
        threadId: turnThreadId,
        input: turnInput,
        model,
        reasoningEffort: reasoningEffort ?? DEFAULT_AI_EDIT_REASONING_EFFORT,
        runId: args.runId,
        cwd: args.cwd,
        onDelta: (delta) => emit(args.onEvent, {
          kind: "stream",
          phase: "streaming",
          channel: "output",
          message: tv("run.receiving"),
          delta,
        }),
        onNotification: (notification) => {
          const startedTool = getMcpToolCallStartedToolName(notification);
          const imageProposalTools = ["insert_generated_image", "update_generated_image"];
          if (isWriteCapableMcpToolName(startedTool) && !imageProposalTools.includes(startedTool ?? "")) {
            toolCount += 1;
          }
          const item = asRecord(notification.params?.item);
          if (notification.method === "item/completed" && item?.type === "mcpToolCall"
            && imageProposalTools.includes(asString(item.tool) ?? "")
            && item.status === "completed" && !item.error) {
            const result = asRecord(item.result);
            const structured = asRecord(result?.structuredContent);
            if (result?.isError !== true && structured?.ok === true && asRecord(structured.data)?.proposalCreated === true) {
              generatedImageProposalCount += 1;
              toolCount += 1;
            }
          }
          if (!imageRun?.handle(notification, turnThreadId)) emitCodexTurnNotification(args.onEvent, notification);
        },
        // The refused item already opened an activity row via item/started, so
        // reuse its itemId: the UI merges by itemId and the row flips from
        // "実行中..." to the refusal, instead of shimmering for the rest of the run.
        onRefusal: (itemType, itemId) => emit(args.onEvent, {
          kind: "activity",
          phase: "streaming",
          message: tAi("run.refusedOperation", { replace: { operation: describeRefusedItemType(itemType, tPrompt) } }),
          itemType: normalizeCodexItemType(itemType),
          itemStatus: "completed",
          ...(itemId ? { itemId } : {}),
        }),
      });
      await imageRun?.settle(turnResult.cancelled === true);
      return turnResult;
    } catch (error) {
      await imageRun?.settle(true);
      throw error;
    }
  };

  let result = await runCodexTurn(input, threadId);

  // A refused operation must not lose the whole run: the turn already stopped,
  // so hand the agent a MCP-only continuation prompt and let it finish the
  // work. The refusal itself stays a refusal — nothing extra is permitted.
  let refused = (result.refusedItemTypes?.length ?? 0) > 0;
  let refusalContinuations = 0;
  let cancelledBetweenTurns = false;
  while (!result.cancelled && refused && refusalContinuations < MAX_REFUSAL_CONTINUATIONS) {
    if (args.isCancelRequested?.()) {
      // Cancelled in the gap between turns, where cancelByRunId finds no active
      // turn to mark: settle the run as cancelled ourselves (same contract as
      // enforceVisualLoop) so the caller rolls the run's proposals back.
      cancelledBetweenTurns = true;
      break;
    }
    refusalContinuations += 1;
    emit(args.onEvent, {
      kind: "activity",
      phase: "thinking",
      message: tAi("run.continuingAfterRefusal", { replace: { attempt: refusalContinuations, max: MAX_REFUSAL_CONTINUATIONS } }),
    });
    const continuationPrompt = buildMcpRefusedOperationContinuationPrompt(
      result.refusedItemTypes ?? [],
      args.runId,
      tPrompt,
    );
    try {
      result = await runCodexTurn(
        [{ type: "text", text: continuationPrompt, text_elements: [] }],
        threadId,
      );
    } catch {
      emit(args.onEvent, {
        kind: "activity",
        phase: "thinking",
        message: tv("run.continuationFailed"),
      });
      break;
    }
    refused = (result.refusedItemTypes?.length ?? 0) > 0;
  }

  if (!result.cancelled && !args.isCancelRequested?.() && imageRun?.imageIds.size && generatedImageProposalCount === 0) {
    emit(args.onEvent, { kind: "activity", phase: "thinking", message: tv("generatedImage.continuing") });
    result = await runCodexTurn([{
      type: "text", text: `${tPrompt("documentLanguagePolicy")}\n${tPrompt("generatedImages.continue", { replace: { runId: args.runId ?? "", imageIds: [...imageRun.imageIds].join(", ") } })}`,
      text_elements: [],
    }], threadId);
    refused = (result.refusedItemTypes?.length ?? 0) > 0;
  }

  // Sticky across the rest of the run: a refusal we never recovered from stays
  // reported even if later (visual-review) turns succeed at other work.
  let refusalUnresolved = refused;

  if (result.cancelled || cancelledBetweenTurns || args.isCancelRequested?.()) {
    await imageRun?.settle(true);
    emit(args.onEvent, {
      kind: "phase",
      phase: "complete",
      message: tv("run.interruptedByUser"),
    });
    return buildCancelledMcpEditRunResult({
      nextDocument: document,
      agentThreadId: threadId,
      runtime: "codex-mcp",
    });
  }

  const initialResult = buildMcpEditRunResult({
    summary: result.finalText,
    toolCount,
    fallbackAnswerSummary: tv("run.providerAnswered", { p0: "Codex" }),
    fallbackDraftSummary: tv("run.providerDrafted", { p0: "Codex" }),
    nextDocument: document,
    agentThreadId: threadId,
    runtime: "codex-mcp",
  });
  const finalResult = await enforceVisualLoop({
    initialResult,
    userDataPath: args.userDataPath,
    provider: "chatgpt",
    runId: args.runId,
    onEvent: args.onEvent,
    isCancelRequested: args.isCancelRequested,
    runContinuation: async ({ prompt: continuationPrompt, agentThreadId }) => {
      // visual review の続行プロンプトは turn builder を通らないので、ここで出力言語
      // ポリシーを添える。**「モデルへ送る文には必ず付ける」を例外なしにするため**
      // (thread の developerInstructions にも入ってはいるが、入口の不変条件を崩さない)。
      const continuationResult = await runCodexTurn(
        [{ type: "text", text: `${tPrompt("documentLanguagePolicy")}\n${continuationPrompt}`, text_elements: [] }],
        agentThreadId ?? threadId,
      );
      // A forbidden operation attempted during a visual-review continuation is
      // still a refusal the user must be told about.
      refusalUnresolved = refusalUnresolved || (continuationResult.refusedItemTypes?.length ?? 0) > 0;
      if (continuationResult.cancelled) {
        return buildCancelledMcpEditRunResult({
          nextDocument: document,
          agentThreadId: agentThreadId ?? threadId,
          runtime: "codex-mcp",
        });
      }
      return buildMcpEditRunResult({
        summary: continuationResult.finalText,
        toolCount,
        fallbackAnswerSummary: tv("run.providerAnswered", { p0: "Codex" }),
        fallbackDraftSummary: tv("run.providerDrafted", { p0: "Codex" }),
        nextDocument: document,
        agentThreadId: agentThreadId ?? threadId,
        runtime: "codex-mcp",
      });
    },
  });

  if (finalResult.status === "cancelled") {
    await imageRun?.settle(true);
    emit(args.onEvent, {
      kind: "phase",
      phase: "complete",
      message: tv("run.interruptedByUser"),
    });
    return stripVisualLoopExhausted(finalResult);
  }

  emit(args.onEvent, {
    kind: "model",
    phase: "validating",
    message: tv("run.finalOutputReceived"),
  });

  emit(args.onEvent, {
    kind: "phase",
    phase: "complete",
    message: finalResult.exhausted
      ? tv("run.doneVisualReviewFailed")
      : toolCount > 0
        ? tv("run.draftReady")
        : tv("run.answerComplete"),
  });

  if (imageRun?.errors.length) {
    finalResult.draft = { ...finalResult.draft, summary: [finalResult.draft.summary, ...imageRun.errors].filter(Boolean).join("\n\n") };
  }

  // The agent kept hitting refused operations: complete normally (the run and
  // any proposals it did make survive) but say so in the summary.
  if (refusalUnresolved) {
    return stripVisualLoopExhausted({
      ...finalResult,
      draft: {
        ...finalResult.draft,
        summary: appendRefusedOperationWarning(finalResult.draft.summary),
      },
    });
  }

  return stripVisualLoopExhausted(finalResult);
}

async function resolveThreadId(
  codex: CodexAppServerClient,
  requestedThreadId: string | null,
  model: AiEditModel,
  reasoningEffort: AiEditReasoningEffort,
  webSearchEnabled: boolean,
  locale: AppLocale,
  cwd?: string,
): Promise<string> {
  // Web検索ポリシーはスレッドレベルの developerInstructions にも足しておく
  // (turnごとの buildMcpEditTurnPrompt 側にも webSearchEnabled 経由で入る)。
  const t = createTranslator(locale, "prompt");
  const developerInstructions = [buildMcpEditInvariantGuidance(t, "app"), t("generatedImages.guide"),
    ...(webSearchEnabled ? [buildMcpWebSearchPrompt(t)] : []),
  ].join("\n\n");
  if (requestedThreadId) {
    try {
      const resumed = await codex.resumeThread(
        requestedThreadId,
        model,
        reasoningEffort,
        developerInstructions,
        cwd,
      );
      return resumed.threadId;
    } catch {
      // If the UI has a stale thread id, start a fresh app-local thread.
    }
  }

  const thread = await codex.startThread(model, reasoningEffort, developerInstructions, cwd);
  return thread.threadId;
}

function getMcpToolCallStartedToolName(notification: { method: string; params?: Record<string, unknown> }): string | undefined {
  if (notification.method !== "item/started") {
    return undefined;
  }
  const item = asRecord(notification.params?.item);
  if (asString(item?.type) !== "mcpToolCall") {
    return undefined;
  }
  return asString(item?.tool);
}

function emit(
  onEvent: (event: AiEditRunEvent) => void,
  event: Omit<AiEditRunEvent, "timestamp">,
): void {
  onEvent({
    ...event,
    timestamp: Date.now(),
  });
}

/**
 * 進捗ラベル。**Record にまとめると module 読み込み時に解決され**、main プロセスでは
 * 常に既定 (日本語) で焼き付く。キーだけ持ち、出す直前に引く。
 */
/**
 * 進捗ラベルは実行のたびに解決する。モジュール読み込み時に `tv()` を評価すると
 * (旧 `CODEX_ITEM_TYPE_LABELS`)、その時点のロケールが焼き付いて UI を切り替えても
 * 進捗表示だけ元の言語のまま残る。
 */
function codexItemTypeLabel(itemType: AiEditAgentItemType): string {
  return tv(`run.itemType_${itemType}`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function normalizeCodexItemType(type: string | undefined): AiEditAgentItemType {
  switch (type) {
    case "reasoning":
    case "agentMessage":
    case "commandExecution":
    case "fileChange":
    case "mcpToolCall":
    case "imageGeneration":
    case "webSearch":
    case "todoList":
      return type;
    default:
      return "other";
  }
}

function mapCodexPlanStatus(status: unknown): AiEditPlanStepStatus {
  return status === "inProgress" || status === "completed" ? status : "pending";
}

/**
 * Translates raw Codex app-server JSON-RPC notifications into structured
 * {@link AiEditRunEvent}s so the sidebar can show, in real time, what the agent
 * is doing: streamed reasoning, plan updates, and per-item activity
 * (including MCP tool calls against sigma-studio-local).
 */
function emitCodexTurnNotification(
  onEvent: (event: AiEditRunEvent) => void,
  notification: { method: string; params?: Record<string, unknown> },
): void {
  const method = notification.method;
  const params = notification.params ?? {};

  // Transport retry progress. The client keeps the turn alive for these, so
  // show them as activity instead of swallowing them (a run that silently
  // pauses for a reconnect looks like a hang).
  if (method === "error") {
    const reconnect = parseCodexReconnectProgress(asString(asRecord(params.error)?.message));
    if (reconnect) {
      emit(onEvent, {
        kind: "activity",
        phase: "thinking",
        message: tv("run.reconnecting", { p0: reconnect.attempt, p1: reconnect.maxAttempts }),
      });
    }
    return;
  }

  // Streamed reasoning summaries / raw reasoning text → reasoning channel.
  // (item/agentMessage/delta is delivered separately through onDelta.)
  if (method.startsWith("item/reasoning/") && method.endsWith("Delta")) {
    const delta = asString(params.delta);
    if (delta) {
      emit(onEvent, {
        kind: "stream",
        phase: "thinking",
        channel: "reasoning",
        message: tv("run.thinking"),
        delta,
      });
    }
    return;
  }

  // Plan snapshot: turn/plan/updated carries the full plan each time.
  if (method === "turn/plan/updated") {
    const planRaw = Array.isArray(params.plan) ? params.plan : [];
    const planSteps: AiEditPlanStep[] = planRaw
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => Boolean(entry))
      .map((entry) => ({
        step: asString(entry.step) ?? "",
        status: mapCodexPlanStatus(entry.status),
      }))
      .filter((entry) => entry.step.length > 0);
    if (planSteps.length > 0) {
      const explanation = asString(params.explanation);
      emit(onEvent, {
        kind: "plan",
        phase: "thinking",
        message: tv("run.planUpdated"),
        planSteps,
        ...(explanation ? { planExplanation: explanation } : {}),
      });
    }
    return;
  }

  // Item lifecycle → activity feed (merged started→completed by itemId in the UI).
  if (method === "item/started" || method === "item/completed") {
    const item = asRecord(params.item);
    const rawType = asString(item?.type);
    // agentMessage / userMessage are already surfaced via the output stream and
    // the final result, so skip them here to avoid duplicate noise.
    if (rawType === "agentMessage" || rawType === "userMessage") {
      return;
    }
    const itemType = normalizeCodexItemType(rawType);
    const itemId = asString(item?.id) ?? asString(params.itemId);
    const toolName = itemType === "mcpToolCall" ? asString(item?.tool) : undefined;
    // WebSearchThreadItem は必須の query フィールドを持つ (codex app-server
    // generate-json-schema の v2/ItemStartedNotification.json で確認済み)。
    const webSearchQuery = itemType === "webSearch" ? asString(item?.query) : undefined;
    emit(onEvent, {
      kind: "activity",
      phase: itemType === "reasoning" ? "thinking" : "streaming",
      message: webSearchQuery
        ? tv("run.webSearchQuery", { p0: truncateWebActivityLabel(webSearchQuery) })
        : toolName
          ? `${codexItemTypeLabel(itemType)} (${toolName})`
          : codexItemTypeLabel(itemType),
      itemType,
      itemStatus: method === "item/started" ? "started" : "completed",
      ...(itemId ? { itemId } : {}),
      ...(webSearchQuery ? { webSearchQuery } : {}),
    });
    return;
  }
}
