import {
  capRunPreviewImages,
  getAttachmentDefaultInstruction,
  MAX_RUN_PREVIEW_IMAGES_PER_RUN,
  type AiEditRunEvent,
  type AiEditRunEventImage,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";
import { formatAiEditReferencesForPrompt, type AiEditReference } from "@/lib/ai/ai-edit-reference";
import { createTranslator, type AppLocale } from "@/lib/i18n";
import { tv } from "@/lib/ai/validation-locale";
import { buildMcpEditPrompt } from "@/lib/ai/mcp-edit-prompt";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import type { SigmaDocument } from "@/features/document";
import { buildCancelledMcpEditRunResult, buildMcpEditRunResult, isWriteCapableMcpToolName } from "./ai-edit-shared";
import type { AiResourceRunContext } from "./ai-resource-store";

// Shared MCP-edit IPC runner for the CLI-backed providers (Claude / Gemini):
// both provide a document-editing "turn" over an MCP server, gated on a
// login/availability status check, and both assemble the same
// AiEditRunResult shape from a tool-use stream. runClaudeEditForIpc and
// runGeminiEditForIpc used to duplicate ~150 lines of payload validation,
// status gating, phase/stream/activity event emission, write-tool counting,
// and result assembly (Finding 3). Only the provider-specific pieces
// (attachment strategy, client invocation, resume semantics, and turn-level
// error interpretation) are injected via McpEditProviderDescriptor.



/**
 * argv に載るスカラー (`--model <v>` / `--effort <v>` / `--resume <v>` / `--conversation <v>`) は、
 * レンダラから `payload: unknown` のまま流れてくる。
 *
 * 守りたいのは 2 つ。(1) **先頭の `-` を許さない** — CLI のオプションパーサは値の位置にあっても
 * `-` 始まりのトークンを新しいフラグとして読み直すので、`--resume` の値に
 * `--mcp-config={"mcpServers":{...}}` を置くだけで任意のコマンドを MCP サーバーとして起動できる
 * (posix でも成立するので、Windows の cmd エンコードとは独立した穴)。(2) 制御文字と長さ。
 *
 * **文字集合は絞りすぎない**: 実在のモデル ID は `"Gemini 3.5 Flash (High)"` のように空白と
 * 括弧を含む。識別子だけを許すと、ユーザーの選択が黙って既定モデルへ差し替わる。
 * メタ文字そのものの無害化は `cli-spawn.ts` のエンコードが担当する。
 */
const CLI_SCALAR_CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const CLI_SCALAR_MAX_LENGTH = 128;

export function safeCliScalar(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > CLI_SCALAR_MAX_LENGTH || trimmed.startsWith("-")) {
    return null;
  }
  return CLI_SCALAR_CONTROL_CHARACTER.test(trimmed) ? null : trimmed;
}

export type McpEditProvider = "claude" | "antigravity";

export interface McpEditIncomingPayload {
  instruction?: string;
  fileId?: string;
  model?: string;
  reasoningEffort?: string;
  document?: SigmaDocument;
  selectedId?: string | null;
  references?: AiEditReference[];
  attachments?: AiEditAttachment[];
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  agentThreadId?: string;
  // 提案の帰属 (electron/local-sigma-doc-proposal-store.ts の LocalMcpEditProposalAttribution)。
  // ここでは読み取らないが、同じ payload オブジェクトが main.ts 経由で
  // ai-edit-run-context.ts の prepareAiEditRunContext にも渡るため、renderer が乗せてくれば
  // そのまま実行コンテキストへ永続化される。
  roomId?: string;
  turnId?: string;
  sessionLabel?: string;
}


/** Provider-neutral outcome of a single client turn. */
export interface McpEditTurnOutcome {
  finalText: string;
  isError: boolean;
  /** Present when isError, used verbatim (or via loginErrorMessage) as the thrown error. */
  errorMessage: string | null;
  agentThreadId: string | undefined;
  /** Repair-worthy soft-failure count (claude: permissionDenials.length, gemini: blockedToolCount). */
  repairCount: number;
  repairMessage: string | null;
  /** Providers without tool-use events can report writes detected through their side effects. */
  createdProposalCount?: number;
  /** True when the underlying client turn was cancelled by the user (ai-edit:cancel) rather than completing normally. */
  cancelled?: boolean;
}

export interface McpEditProviderDescriptor<TClient> {
  provider: McpEditProvider;
  runtime: NonNullable<AiEditRunResult["runtime"]>;
  /** e.g. "Claude" / "Gemini", used in default Japanese error copy. */
  displayName: string;
  missingFileIdError: string;
  notAvailableFallbackError: string;
  notLoggedInError: string;
  thinkingMessage: string;
  fallbackAnswerSummary: string;
  fallbackDraftSummary: string;

  getStatus(client: TClient): Promise<{ available: boolean; loggedIn: boolean; error: string | null }>;

  /**
   * Prepare attachments (if any) and return the final instruction text to send
   * to the client, plus a cleanup callback invoked in a `finally` after the
   * turn settles (success or failure).
   */
  prepareInstruction(args: {
    client: TClient;
    prompt: string;
    attachments: AiEditAttachment[] | undefined;
    /**
     * Per-run cwd override (このrunのagent-workspacesディレクトリ)。省略時は各clientの
     * 既定ディレクトリを使う。Antigravityは添付ファイルの書き込み先として使う
     * (gemini-edit.ts); Claudeは画像をインライン送信するため未使用。
     */
    cwd?: string;
  }): Promise<{ instruction: string; cleanup?: () => Promise<void> }>;

  /** Run the turn (including any provider-specific resume-fallback retry) and
   * normalize the result to the shared outcome shape. */
  runTurn(args: {
    client: TClient;
    instruction: string;
    /** Original user instruction, before the shared MCP prompt is composed. */
    userInstruction: string;
    references: readonly AiEditReference[];
    selectedSkillIds: readonly string[];
    model: string | null;
    reasoningEffort: string | null;
    agentThreadId: string | undefined;
    fileId: string;
    /**
     * Per-run MCP server launch config override (Claude only for now: its CLI
     * takes `--mcp-config` fresh per spawned turn). Lets each concurrent run
     * point the MCP server at its own run-context file instead of racing on a
     * single provider-level file shared by every run of that provider.
     */
    mcpConfig?: unknown;
    /**
     * aiWebSearchEnabled設定の現在値。Claude はこの値で per-turn の
     * allowed/disallowed tools (WebSearch/WebFetch) を切り替える。Antigravity は
     * CLI 側に対応するトグルがないため未使用 (gemini-headless-client.ts 参照)。
     */
    webSearchEnabled?: boolean;
    onEvent: (event: AiEditRunEvent) => void;
    onDelta: (delta: string) => void;
    /** `input` は tool_use の生の入力 (Claude の WebSearch { query } / WebFetch { url } の activity 表示に使う)。 */
    onToolUse: (tool: { id?: string; name?: string; input?: unknown }) => void;
    /**
     * Fired when a provider's client reports image content from an MCP tool's
     * result (currently Claude only — see ClaudeStreamClient's tool_result
     * parsing). Providers with no such signal simply never call this.
     */
    onToolResult?: (result: { toolUseId?: string; images: AiEditRunEventImage[] }) => void;
    /** This run's id; forwarded to the client's runTurn so ai-edit:cancel can kill this specific spawned turn. */
    runId?: string;
    /** Per-run cwd override; see prepareInstruction's cwd for the full rationale. */
    cwd?: string;
  }): Promise<McpEditTurnOutcome>;
}

export function buildMcpEditPromptForProvider(
  provider: McpEditProvider,
  args: {
    instruction: string;
    fileId: string;
    selectedId?: string | null;
    referenceText?: string;
    aiResources?: AiResourceRunContext;
    mentionedDocuments?: AiEditMentionedDocumentContext[];
    attachments?: AiEditAttachment[];
    runId?: string;
    /** aiWebSearchEnabled設定の現在値。true のときだけ Web検索ポリシー (MCP_WEB_SEARCH_PROMPT) を含める。 */
    webSearchEnabled?: boolean;
    /**
     * True when resuming an existing agentThreadId. Claude/Antigravity are
     * one-shot composed prompts (see buildMcpEditPrompt), so on a resumed
     * turn this drops the ~19KB static guidance already seen earlier in the
     * conversation and sends only the turn-level content.
     */
    isResumedTurn?: boolean;
    /**
     * プロンプトを組む言語。**必須** — 渡し忘れをコンパイル時に落とす。
     */
    locale: AppLocale;
  },
): string {
  return buildMcpEditPrompt({ provider, ...args, toolProfile: "app" });
}

export async function runMcpEditForIpc<TClient>(
  descriptor: McpEditProviderDescriptor<TClient>,
  args: {
    client: TClient;
    payload: unknown;
    aiResources?: AiResourceRunContext;
    onEvent: (event: AiEditRunEvent) => void;
    /** Forwarded verbatim to descriptor.runTurn; see McpEditProviderDescriptor.runTurn. */
    mcpConfig?: unknown;
    /** Suppress this turn's terminal phase; the provider emits one after visual-loop enforcement settles. */
    suppressFinalPhase?: boolean;
    /**
     * This run's id (from ai-edit:run). Told to the agent in the prompt so it
     * can pass it back as the `runId` argument on app-context MCP tool calls,
     * letting a shared MCP server process (Antigravity) resolve the right
     * per-run context file among concurrent runs. Claude additionally gets a
     * fresh --mcp-config per turn (see mcpConfig above), but naming the
     * per-run file after runId is the same convention either way.
     */
    runId?: string;
    /**
     * aiWebSearchEnabled設定の現在値 (main.ts が run ごとに読み直して渡す)。プロンプトの
     * Web検索ポリシー節と、Claude の per-turn ツール許可の両方を切り替える。
     */
    webSearchEnabled?: boolean;
    /**
     * プロンプトを組む言語 (IPC ハンドラが run ごとに解決して渡す)。
     * **必須** — 引き回しの漏れをコンパイル時に落とす。
     */
    locale: AppLocale;
    /**
     * Per-run cwd override (main.tsがLocalAiResourceStore.getAgentWorkspaceDir()で
     * 解決した、このrunのagent-workspacesディレクトリ)。省略時は各clientの既定
     * ディレクトリ(workspaceId未解決runのフォールバック固定ディレクトリ)を使う。
     */
    cwd?: string;
  },
): Promise<AiEditRunResult> {
  const payload = (args.payload ?? {}) as McpEditIncomingPayload;
  const attachments = Array.isArray(payload.attachments) ? payload.attachments : [];
  const rawInstruction = typeof payload.instruction === "string" ? payload.instruction.trim() : "";
  const instruction = rawInstruction || getAttachmentDefaultInstruction(attachments, createTranslator(args.locale, "prompt"));
  if (instruction.length === 0) {
    throw new Error(tv("run.emptyInstruction"));
  }
  const fileId = typeof payload.fileId === "string" ? payload.fileId.trim() : "";
  if (fileId.length === 0) {
    throw new Error(descriptor.missingFileIdError);
  }
  if (!payload.document) {
    throw new Error(tv("run.missingDocument"));
  }

  emit(args.onEvent, { kind: "phase", phase: "preparing", message: tv("run.preparing") });

  const status = await descriptor.getStatus(args.client);
  if (!status.available) {
    throw new Error(status.error ?? descriptor.notAvailableFallbackError);
  }
  if (!status.loggedIn) {
    throw new Error(descriptor.notLoggedInError);
  }

  const prompt = buildMcpEditPromptForProvider(descriptor.provider, {
    instruction,
    fileId,
    selectedId: payload.selectedId ?? null,
    referenceText: Array.isArray(payload.references) && payload.references.length > 0
      ? formatAiEditReferencesForPrompt(payload.references)
      : undefined,
    aiResources: args.aiResources,
    mentionedDocuments: payload.mentionedDocuments,
    attachments,
    runId: args.runId,
    webSearchEnabled: args.webSearchEnabled,
    locale: args.locale,
    isResumedTurn: Boolean(payload.agentThreadId),
  });
  const references = Array.isArray(payload.references) ? payload.references : [];
  const selectedSkillIds = (args.aiResources?.explicit ?? [])
    .filter((item) => item.kind === "skill")
    .map((item) => item.id);

  emit(args.onEvent, { kind: "phase", phase: "thinking", message: descriptor.thinkingMessage });

  const { instruction: fullInstruction, cleanup } = await descriptor.prepareInstruction({
    client: args.client,
    prompt,
    attachments,
    cwd: args.cwd,
  });

  let toolCount = 0;
  // Preview-image bookkeeping (Claude only for now): remember each tool call's
  // name so a later tool_result carrying images can merge onto the same
  // activity row with a message consistent with its "started" row, and cap
  // the total number of images attached across the whole run (see
  // capRunPreviewImages) so a chatty tool never bloats the chat history/log.
  const toolNameByCallId = new Map<string, string>();
  let remainingImageBudget = MAX_RUN_PREVIEW_IMAGES_PER_RUN;
  try {
    const outcome = await descriptor.runTurn({
      client: args.client,
      instruction: fullInstruction,
      userInstruction: instruction,
      references,
      selectedSkillIds,
      model: safeCliScalar(payload.model),
      reasoningEffort: safeCliScalar(payload.reasoningEffort),
      agentThreadId: safeCliScalar(payload.agentThreadId) ?? undefined,
      fileId,
      mcpConfig: args.mcpConfig,
      webSearchEnabled: args.webSearchEnabled,
      onEvent: args.onEvent,
      runId: args.runId,
      cwd: args.cwd,
      onDelta: (delta) => emit(args.onEvent, {
        kind: "stream",
        phase: "streaming",
        channel: "output",
        message: tv("run.receiving"),
        delta,
      }),
      onToolUse: (tool) => {
        if (isWriteCapableMcpToolName(tool.name)) {
          toolCount += 1;
        }
        if (tool.id && tool.name) {
          toolNameByCallId.set(tool.id, tool.name);
        }
        const webActivity = describeWebToolActivity(tool.name, tool.input);
        emit(args.onEvent, {
          kind: "activity",
          phase: "streaming",
          message: webActivity ?? (tool.name ? tv("run.toolRunningNamed", { p0: tool.name }) : tv("run.toolRunning")),
          itemType: webActivity ? "webSearch" : "mcpToolCall",
          itemStatus: "started",
          ...(tool.id ? { itemId: tool.id } : {}),
        });
      },
      onToolResult: (result) => {
        const images = capRunPreviewImages(result.images, remainingImageBudget);
        remainingImageBudget -= images.length;
        const toolName = result.toolUseId ? toolNameByCallId.get(result.toolUseId) : undefined;
        emit(args.onEvent, {
          kind: "activity",
          phase: "streaming",
          message: toolName ? tv("run.toolRunningNamed", { p0: toolName }) : tv("run.toolRunning"),
          itemType: "mcpToolCall",
          itemStatus: "completed",
          ...(result.toolUseId ? { itemId: result.toolUseId } : {}),
          ...(images.length > 0 ? { images } : {}),
        });
      },
    });

    if (outcome.cancelled) {
      if (!args.suppressFinalPhase) {
        emit(args.onEvent, {
          kind: "phase",
          phase: "complete",
          message: tv("run.interruptedByUser"),
        });
      }
      return buildCancelledMcpEditRunResult({
        nextDocument: payload.document,
        agentThreadId: outcome.agentThreadId,
        runtime: descriptor.runtime,
      });
    }

    if (outcome.isError) {
      throw new Error(outcome.errorMessage || tv("run.providerEditFailed", { p0: descriptor.displayName }));
    }

    if (outcome.repairCount > 0 && outcome.repairMessage) {
      emit(args.onEvent, {
        kind: "repair",
        phase: "streaming",
        message: outcome.repairMessage,
      });
    }

    const effectiveToolCount = Math.max(toolCount, outcome.createdProposalCount ?? 0);

    if (!args.suppressFinalPhase) {
      emit(args.onEvent, {
        kind: "phase",
        phase: "complete",
        message: effectiveToolCount > 0 ? tv("run.draftReady") : tv("run.answerComplete"),
      });
    }

    return {
      ...buildMcpEditRunResult({
        summary: outcome.finalText,
        toolCount: effectiveToolCount,
        fallbackAnswerSummary: descriptor.fallbackAnswerSummary,
        fallbackDraftSummary: descriptor.fallbackDraftSummary,
        nextDocument: payload.document,
        agentThreadId: outcome.agentThreadId,
        runtime: descriptor.runtime,
      }),
    };
  } finally {
    await cleanup?.();
  }
}

function emit(
  onEvent: (event: AiEditRunEvent) => void,
  event: Omit<AiEditRunEvent, "timestamp">,
): void {
  onEvent({ ...event, timestamp: Date.now() });
}

const MAX_WEB_ACTIVITY_LABEL_CHARS = 120;

// Claude のネイティブ WebSearch / WebFetch tool_use を、MCPツールと区別して
// 「Web検索: <query>」「Web取得: <url>」の activity 行として表示するためのラベル。
// input のフィールド名は Claude Code の組み込みツール定義に準拠する
// (WebSearch: { query: string } / WebFetch: { url: string, prompt: string })。
// 対象外のツール (MCPツール等) では undefined を返し、既存の汎用ラベルに任せる。
function describeWebToolActivity(name: string | undefined, input: unknown): string | undefined {
  if (name !== "WebSearch" && name !== "WebFetch") {
    return undefined;
  }
  const record = typeof input === "object" && input !== null && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
  if (name === "WebSearch") {
    const query = typeof record?.query === "string" ? record.query.trim() : "";
    return query ? tv("run.webSearchQuery", { p0: truncateWebActivityLabel(query) }) : tv("run.webSearchRunning");
  }
  const url = typeof record?.url === "string" ? record.url.trim() : "";
  return url ? tv("run.webFetchUrl", { p0: truncateWebActivityLabel(url) }) : tv("run.webFetchRunning");
}

export function truncateWebActivityLabel(value: string): string {
  return value.length > MAX_WEB_ACTIVITY_LABEL_CHARS
    ? `${value.slice(0, MAX_WEB_ACTIVITY_LABEL_CHARS)}...`
    : value;
}
