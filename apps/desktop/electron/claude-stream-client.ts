import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { buildCliChildEnv, getProcessPathEnv } from "./cli-child-env";

import { resolveBareBinNames, resolveCliBinForSpawn, spawnCliProcess, type CliChildProcess } from "./cli-spawn";

import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import { inferToolCategoriesForRun, toolNamesForCategories } from "@/lib/ai/mcp-tool-categories";
import { appMcpToolNames } from "@/lib/ai/mcp-tool-profile";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

// Claude Code (Claude) を stream-json モードで駆動するクライアント。
// gemini-headless-client.ts と同じく1 turn = 1 spawn: 複数のチャットルームが同時に
// turnを実行できるよう、プロセスやターン状態をクライアント単位で共有しない
// (以前は常駐プロセス+単一 activeTurn を共有しており、2つ目のturnを弾いていた
// うえ、ルームをまたいで会話コンテキストが混ざる欠陥もあった)。会話の継続は
// Codex/Geminiと同様、呼び出し側が前回turnの session_id を resumeSessionId として
// 渡し直す `--resume` に一本化する。

interface ClaudeInitEvent {
  session_id?: string;
  apiKeySource?: string;
  model?: string;
}

interface ClaudeResultEvent {
  subtype?: string;
  is_error?: boolean;
  result?: string;
  session_id?: string;
  total_cost_usd?: number;
  num_turns?: number;
  permission_denials?: unknown[];
}

interface AvailabilityCache {
  available: boolean;
  checkedAt: number;
  pathEnv: string | undefined;
  claudeBin: string;
}

export interface ClaudeToolUse {
  id?: string;
  name?: string;
  input?: unknown;
}

/** A tool_result's image content blocks (e.g. an MCP tool's PNG preview), keyed by the originating tool_use id. */
export interface ClaudeToolResult {
  toolUseId?: string;
  images: Array<{ dataUrl: string }>;
}

export interface ClaudeStreamClientOptions {
  claudeConfigDir: string;
  mcpConfig: unknown;
  claudeBin?: string;
  defaultModel?: string;
  allowedTools?: string;
  disallowedTools?: string[];
  /** Test-only override for the CLI availability probe timeout (ms). */
  availabilityProbeTimeoutMs?: number;
  /** Test-only override for the maximum interval without a stdout event (ms). */
  turnIdleTimeoutMs?: number;
  /** Test-only override for the absolute maximum turn duration (ms). */
  turnMaxTimeoutMs?: number;
  /** Test-only override for the SIGTERM->SIGKILL escalation grace period (ms). */
  cancelGraceMs?: number;
}

export interface ClaudeAccountSummary {
  apiKeySource: string;
}

export interface ClaudeStatus {
  available: boolean;
  running: boolean;
  loggedIn: boolean;
  claudeBin: string;
  configuredClaudeBin: string | null;
  account: ClaudeAccountSummary | null;
  error: string | null;
}

export interface ClaudeModelCatalog {
  models: Array<{
    id: string;
    label: string;
    description?: string;
    isDefault?: boolean;
    defaultReasoningEffort?: string;
    supportedReasoningEfforts?: Array<{ id: string; description?: string }>;
  }>;
}

export interface ClaudeImageInput {
  mediaType: string;
  dataBase64: string;
}

export interface ClaudePdfInput {
  title: string;
  dataBase64: string;
}

export interface ClaudeRunTurnParams {
  instruction: string;
  /** Full prompts contain every tool name, so gating must use the original user instruction instead. */
  userInstruction?: string;
  /** Selected editor references used to infer table/graph/shape/body context. */
  references?: readonly AiEditReference[];
  /** Explicitly selected Studio skill ids used to widen the task categories. */
  selectedSkillIds?: readonly string[];
  images?: ClaudeImageInput[];
  documents?: ClaudePdfInput[];
  model?: string | null;
  reasoningEffort?: string | null;
  /**
   * Per-turn override for the `--mcp-config` payload, replacing the client's
   * constructor-time default. Since Claude is 1-turn-per-spawn and the MCP
   * config is passed as a CLI arg (not a shared file), this is the channel
   * concurrent turns use to each point the MCP server at their own run-context
   * file instead of racing on a single provider-level file.
   */
  mcpConfig?: unknown;
  /** Previous turn's `sessionId` (same room/thread) to resume via `claude --resume`. */
  resumeSessionId?: string | null;
  /**
   * Per-run cwd override: このワークスペースの `agent-workspaces/<workspaceId>/claude`
   * ディレクトリ(LocalAiResourceStore.getAgentWorkspaceDir)。省略時はコンストラクタの
   * claudeConfigDir(workspaceId未解決runのフォールバック固定ディレクトリ)を使う。
   */
  cwd?: string;
  /**
   * aiWebSearchEnabled設定の現在値 (main.ts が run ごとに読み直して渡す)。true のとき
   * だけこの turn の spawn args で WebSearch / WebFetch を許可する。未指定 (undefined)
   * は従来どおり不許可 (この turn ではWeb検索できない)。Bash / Write / Edit / Task は
   * この設定に関係なく常に不許可。
   */
  webSearchEnabled?: boolean;
  onDelta?: (delta: string) => void;
  onAssistantText?: (text: string) => void;
  onToolUse?: (tool: ClaudeToolUse) => void;
  /** Fired for each `tool_result` (stream-json `type:"user"` message) that carries image content blocks, e.g. an MCP tool's PNG preview. */
  onToolResult?: (result: ClaudeToolResult) => void;
  onSystemInit?: (init: { sessionId: string | null; apiKeySource: string | null }) => void;
  /** This run's id; lets {@link ClaudeStreamClient.cancelRun} kill this spawned turn. */
  runId?: string;
}

export interface ClaudeTurnResult {
  sessionId: string | null;
  finalText: string;
  isError: boolean;
  numTurns: number;
  permissionDenials: unknown[];
  totalCostUsd: number | null;
  /** True when this result came from a user-initiated cancellation rather than a normal completion. */
  cancelled?: boolean;
}

// MCPツールはrunごとに推論したカテゴリを列挙する。Skill/Read を許可することで、
// cwd(claude-agent-home)の投影先 .claude/skills と
// ~/.claude/skills (ユーザー個人skill)をclaude自身のネイティブskill探索・本文読み込みに
// 委ねる(claude --help / 実バイナリのstrings確認: ビルトインtool名は "Skill"。SKILL.md
// 本体はSkillツールが読むが、supporting files(references/等)を読ませるためReadも許可する)。
const DEFAULT_ALLOWED_TOOLS = "Skill Read";
const FULL_EXPOSURE_ALLOWED_TOOLS = "mcp__sigma-studio-local__* Skill Read";
const SIGMA_MCP_TOOL_PREFIX = "mcp__sigma-studio-local__";
const DEFAULT_DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task"];
const DEFAULT_MODEL = "sonnet";

const CLAUDE_AVAILABILITY_CACHE_MS = 10_000;
const DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS = 3000;
const TURN_IDLE_TIMEOUT_MS = 1000 * 60 * 8;
const TURN_MAX_TIMEOUT_MS = 1000 * 60 * 30;
const DEFAULT_CANCEL_GRACE_MS = 3000;
const CLAUDE_HELP_TIMEOUT_MS = 5000;

const CLAUDE_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
] as const;
const WINDOWS_CLAUDE_CHILD_ENV_KEYS = [
  "APPDATA",
  "ComSpec",
  "LOCALAPPDATA",
  "PATHEXT",
  "PROGRAMDATA",
  "SystemRoot",
  "TEMP",
  "TMP",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "WINDIR",
] as const;
// サブスクリプション認証を上書きして API 課金を発生させる env は子プロセスへ絶対に渡さない。
const FORBIDDEN_CHILD_ENV_KEYS = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"] as const;

type ClaudeChildEnv = NodeJS.ProcessEnv & { NODE_ENV: string };

export class ClaudeStreamClient extends EventEmitter {
  private readonly claudeConfigDir: string;
  private readonly mcpConfig: unknown;
  private readonly defaultModel: string;
  private readonly allowedToolsOverride: string | null;
  private readonly disallowedTools: string[];
  private configuredClaudeBin: string | null;
  private resolvedClaudeBin: string | null = null;
  private availableCache: AvailabilityCache | null = null;
  private lastError: string | null = null;
  private lastApiKeySource: string | null = null;
  // init は未ログインでも apiKeySource:"none" を返すため、ログイン判定は turn の
  // result(is_error + "Not logged in") で確定する。一度検知したら getStatus に反映する。
  private authError: string | null = null;
  // ルームごとに同時実行される turn を隔離するため、1 turn = 1 プロセスで spawn する
  // (gemini-headless-client.ts と同じ方針)。会話の継続は呼び出し側が resumeSessionId
  // (前回 turn の sessionId) を渡し直すことで `--resume` により行う。dispose() は
  // アプリ終了時などに残っている全プロセスを止められるよう、生存中のプロセスを追跡する。
  private readonly activeProcs = new Set<CliChildProcess>();
  // runId -> cancel handle for the in-flight spawned turn, so ai-edit:cancel
  // (main.ts's activeAiEditRuns registry) can kill this specific turn's
  // process without touching any other concurrent turn. Populated at the top
  // of runTurn() when the caller passes a runId, removed once the turn settles.
  private readonly cancelHandles = new Map<string, () => void>();
  private readonly availabilityProbeTimeoutMs: number;
  private readonly turnIdleTimeoutMs: number;
  private readonly turnMaxTimeoutMs: number;
  private readonly cancelGraceMs: number;

  constructor(options: ClaudeStreamClientOptions) {
    super();
    this.claudeConfigDir = options.claudeConfigDir;
    this.mcpConfig = options.mcpConfig;
    this.defaultModel = options.defaultModel?.trim() || DEFAULT_MODEL;
    this.allowedToolsOverride = options.allowedTools?.trim() || null;
    this.disallowedTools = options.disallowedTools ?? DEFAULT_DISALLOWED_TOOLS;
    this.configuredClaudeBin = normalizeBin(options.claudeBin);
    this.availabilityProbeTimeoutMs =
      options.availabilityProbeTimeoutMs ?? DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS;
    this.turnIdleTimeoutMs = options.turnIdleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
    this.turnMaxTimeoutMs = options.turnMaxTimeoutMs ?? TURN_MAX_TIMEOUT_MS;
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  }

  getConfiguredClaudeBin(): string | null {
    return this.configuredClaudeBin;
  }

  setClaudeBin(claudeBin: string | null): void {
    const next = normalizeBin(claudeBin);
    if (next === this.configuredClaudeBin) {
      return;
    }
    this.configuredClaudeBin = next;
    this.resolvedClaudeBin = null;
    this.availableCache = null;
    this.lastError = null;
    this.dispose();
    this.emit("statusChanged");
  }

  async getStatus(): Promise<ClaudeStatus> {
    const available = await this.isClaudeAvailable();
    if (!available) {
      return {
        available: false,
        running: false,
        loggedIn: false,
        claudeBin: this.getDisplayClaudeBin(),
        configuredClaudeBin: this.configuredClaudeBin,
        account: null,
        error: this.lastError ?? te("electron.claudeClient.commandNotFound"),
      };
    }

    // init は未ログインでも apiKeySource:"none" を返し、かつ stdin入力前は出ないため、
    // ここで turn を起動して login 判定はしない。available + 直近 turn の authError で判定する
    // (楽観的に loggedIn=true、実際の turn が auth エラーを返したら authError がフラグして反映)。
    return {
      available: true,
      running: this.activeProcs.size > 0,
      loggedIn: this.authError === null,
      claudeBin: this.getDisplayClaudeBin(),
      configuredClaudeBin: this.configuredClaudeBin,
      account: this.authError === null && this.lastApiKeySource ? { apiKeySource: this.lastApiKeySource } : null,
      error: this.authError ? te("electron.claudeClient.loginRequired") : null,
    };
  }

  /**
   * Claude Code does not expose a model-catalog RPC. Its documented `--model`
   * help text does advertise aliases that always resolve to the latest model
   * in each family, so read those aliases from the installed CLI instead of
   * freezing versioned model ids in the renderer.
   */
  async listModels(): Promise<ClaudeModelCatalog> {
    const available = await this.isClaudeAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.claudeClient.commandNotFound"));
    }
    const claudeBin = this.getClaudeBinForSpawn();
    const help = await new Promise<string>((resolve, reject) => {
      const child = spawnCliProcess(claudeBin, ["--help"], {
        env: buildClaudeChildEnv(),
        stdio: "pipe",
        windowsHide: true,
      });
      let output = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(te("electron.claudeClient.modelListTimeout"))));
      }, CLAUDE_HELP_TIMEOUT_MS);
      child.stdout.on("data", (data: Buffer) => {
        output = `${output}${data.toString()}`.slice(-256_000);
      });
      child.stderr.on("data", (data: Buffer) => {
        output = `${output}${data.toString()}`.slice(-256_000);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("exit", (code) => finish(() => {
        if (code === 0) {
          resolve(output);
        } else {
          reject(new Error(output.trim() || te("electron.claudeClient.modelListFailed")));
        }
      }));
    });
    const advertisedAliases = parseClaudeModelAliasesFromHelp(help);
    const aliases = advertisedAliases.length > 0 ? advertisedAliases : ["opus", "sonnet", "haiku"];
    return {
      models: aliases.map((alias) => ({
        id: alias,
        label: alias === "sonnet" ? "Claude Sonnet 5" : `Claude ${alias.charAt(0).toUpperCase()}${alias.slice(1)} (latest)`,
        description: te("electron.claudeClient.latestModelAlias"),
        ...(alias === "sonnet" ? { isDefault: true } : {}),
        defaultReasoningEffort: "low",
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"].map((id) => ({ id })),
      })),
    };
  }

  async runTurn(params: ClaudeRunTurnParams): Promise<ClaudeTurnResult> {
    const available = await this.isClaudeAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.claudeClient.commandNotFound"));
    }

    const cwd = params.cwd ?? this.claudeConfigDir;
    await fs.mkdir(cwd, { recursive: true });
    const model = params.model?.trim() || this.defaultModel;
    const claudeBin = this.getClaudeBinForSpawn();
    const allowedTools = this.allowedToolsForRun(params);
    const args = this.buildSpawnArgs(
      model,
      params.resumeSessionId ?? null,
      params.mcpConfig,
      allowedTools,
      params.webSearchEnabled === true,
      params.reasoningEffort,
    );
    const proc = spawnCliProcess(claudeBin, args, {
      cwd,
      env: buildClaudeChildEnv(),
      stdio: "pipe",
      windowsHide: true,
    });
    this.activeProcs.add(proc);

    let sessionId: string | null = null;
    let finalText = "";
    let stderrTail: string | null = null;
    let settled = false;
    let cancelRequested = false;

    return new Promise<ClaudeTurnResult>((resolve, reject) => {
      let idleTimeout: NodeJS.Timeout | null = null;
      let maxTimeout: NodeJS.Timeout | null = null;
      let processExited = false;
      proc.once("exit", () => {
        processExited = true;
      });

      const clearTurnTimeouts = () => {
        if (idleTimeout) {
          clearTimeout(idleTimeout);
          idleTimeout = null;
        }
        if (maxTimeout) {
          clearTimeout(maxTimeout);
          maxTimeout = null;
        }
      };
      const terminateWithEscalation = () => {
        proc.kill("SIGTERM");
        const killTimer = setTimeout(() => {
          if (!processExited) {
            proc.kill("SIGKILL");
          }
        }, this.cancelGraceMs);
        killTimer.unref?.();
        proc.once("exit", () => clearTimeout(killTimer));
      };
      const rejectForTimeout = (message: string) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTurnTimeouts();
        if (params.runId) {
          this.cancelHandles.delete(params.runId);
        }
        if (proc.stdin.writable) {
          proc.stdin.end();
        }
        terminateWithEscalation();
        reject(new Error(message));
      };
      const resetIdleTimeout = () => {
        if (settled) {
          return;
        }
        if (idleTimeout) {
          clearTimeout(idleTimeout);
        }
        idleTimeout = setTimeout(() => {
          idleTimeout = null;
          rejectForTimeout(te("electron.claudeClient.idleTimeout"));
        }, this.turnIdleTimeoutMs);
      };
      resetIdleTimeout();
      maxTimeout = setTimeout(() => {
        maxTimeout = null;
        rejectForTimeout(te("electron.claudeClient.maxTimeout"));
      }, this.turnMaxTimeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTurnTimeouts();
        if (params.runId) {
          this.cancelHandles.delete(params.runId);
        }
        fn();
      };

      if (params.runId) {
        this.cancelHandles.set(params.runId, () => {
          if (settled || cancelRequested) {
            return;
          }
          cancelRequested = true;
          clearTurnTimeouts();
          terminateWithEscalation();
        });
      }

      proc.once("error", (error: Error) => {
        this.availableCache = null;
        this.activeProcs.delete(proc);
        finish(() => reject(new Error(te("electron.claudeClient.launchFailed", { detail: error.message }))));
      });
      proc.stdin.on("error", () => {
        // プロンプト送信前にプロセスが終了する等のEPIPEはcloseハンドラ側で処理する。
      });
      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          stderrTail = text.slice(0, 1000);
          this.lastError = stderrTail;
        }
      });

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        resetIdleTimeout();
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message) || typeof message.type !== "string") {
          return;
        }

        switch (message.type) {
          case "system": {
            if (message.subtype === "init") {
              const init = message as unknown as ClaudeInitEvent;
              if (typeof init.session_id === "string") {
                sessionId = init.session_id;
              }
              if (typeof init.apiKeySource === "string") {
                this.lastApiKeySource = init.apiKeySource;
              }
              params.onSystemInit?.({ sessionId, apiKeySource: this.lastApiKeySource });
            }
            return;
          }
          case "assistant": {
            const inner = getRecord(message.message);
            const content = Array.isArray(inner?.content) ? inner?.content : [];
            for (const part of content) {
              if (!isRecord(part)) {
                continue;
              }
              if (part.type === "text" && typeof part.text === "string") {
                finalText += part.text;
                params.onAssistantText?.(part.text);
              } else if (part.type === "tool_use") {
                params.onToolUse?.({
                  id: typeof part.id === "string" ? part.id : undefined,
                  name: typeof part.name === "string" ? part.name : undefined,
                  input: part.input,
                });
              }
            }
            return;
          }
          case "user": {
            // Claude echoes MCP tool results back as a stream-json `type:"user"`
            // message whose content is one or more `tool_result` blocks. Most
            // carry only text, but tools that attach PNG previews (e.g.
            // render_visual_edit_session) include `image` blocks alongside it —
            // surface those so the chat history can show what the agent checked.
            const inner = getRecord(message.message);
            const content = Array.isArray(inner?.content) ? inner?.content : [];
            for (const part of content) {
              if (!isRecord(part) || part.type !== "tool_result") {
                continue;
              }
              const toolUseId = typeof part.tool_use_id === "string" ? part.tool_use_id : undefined;
              const blocks = Array.isArray(part.content) ? part.content : [];
              const images: Array<{ dataUrl: string }> = [];
              for (const block of blocks) {
                if (!isRecord(block) || block.type !== "image") {
                  continue;
                }
                const source = getRecord(block.source);
                const data = typeof source?.data === "string" ? source.data : null;
                if (!data || source?.type !== "base64") {
                  continue;
                }
                const mediaType = typeof source?.media_type === "string" ? source.media_type : "image/png";
                images.push({ dataUrl: `data:${mediaType};base64,${data}` });
              }
              if (images.length > 0) {
                params.onToolResult?.({ toolUseId, images });
              }
            }
            return;
          }
          case "stream_event": {
            const event = getRecord(message.event);
            const delta = getRecord(event?.delta);
            if (delta?.type === "text_delta" && typeof delta.text === "string") {
              params.onDelta?.(delta.text);
            }
            return;
          }
          case "result": {
            const result = message as unknown as ClaudeResultEvent;
            if (typeof result.session_id === "string") {
              sessionId = result.session_id;
            }
            const resolvedText = typeof result.result === "string" && result.result.length > 0
              ? result.result
              : finalText;
            if (result.is_error && isAuthErrorMessage(resolvedText)) {
              this.authError = te("electron.claudeClient.loginRequired");
              this.emit("statusChanged");
            } else if (!result.is_error) {
              this.authError = null;
            }
            finish(() =>
              resolve({
                sessionId,
                finalText: resolvedText,
                isError: Boolean(result.is_error),
                numTurns: typeof result.num_turns === "number" ? result.num_turns : 0,
                permissionDenials: Array.isArray(result.permission_denials) ? result.permission_denials : [],
                totalCostUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : null,
              }),
            );
            return;
          }
          default:
            return;
        }
      });

      proc.once("close", () => {
        rl.close();
        this.activeProcs.delete(proc);
        if (cancelRequested) {
          finish(() =>
            resolve({
              sessionId,
              finalText,
              isError: false,
              numTurns: 0,
              permissionDenials: [],
              totalCostUsd: null,
              cancelled: true,
            }),
          );
          return;
        }
        finish(() => reject(new Error(stderrTail ?? te("electron.claudeClient.exitedWithoutResult"))));
      });

      const content: unknown[] = [{ type: "text", text: params.instruction }];
      for (const img of params.images ?? []) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.dataBase64 },
        });
      }
      for (const document of params.documents ?? []) {
        content.push({
          type: "document",
          title: document.title,
          source: { type: "base64", media_type: "application/pdf", data: document.dataBase64 },
        });
      }
      const inputMessage = {
        type: "user",
        message: {
          role: "user",
          content,
        },
      };
      try {
        proc.stdin.write(`${JSON.stringify(inputMessage)}\n`, (error) => {
          if (error) {
            finish(() => reject(new Error(te("electron.claudeClient.writeFailedWithDetail", { detail: error.message }))));
          }
        });
      } catch (error) {
        finish(() =>
          reject(error instanceof Error ? error : new Error(te("electron.claudeClient.writeFailed"))),
        );
      }
    });
  }

  /**
   * User-initiated cancellation entry point for the ai-edit:cancel IPC
   * (main.ts's activeAiEditRuns registry). Sends SIGTERM to the turn's
   * process, escalating to SIGKILL after cancelGraceMs if it hasn't exited,
   * and makes the pending runTurn() promise resolve (not reject) with
   * `cancelled: true`. Returns false if no turn with this runId is running
   * (already settled, or never started with a runId).
   */
  cancelRun(runId: string): boolean {
    const handle = this.cancelHandles.get(runId);
    if (!handle) {
      return false;
    }
    handle();
    return true;
  }

  /** アプリ終了やbin切り替え時に、実行中の全turnプロセスを止める。 */
  dispose(): void {
    for (const proc of this.activeProcs) {
      if (proc.stdin.writable) {
        proc.stdin.end();
      }
      proc.kill();
    }
    this.activeProcs.clear();
  }

  private buildSpawnArgs(
    model: string,
    resumeSessionId: string | null,
    mcpConfigOverride?: unknown,
    baseAllowedTools = DEFAULT_ALLOWED_TOOLS,
    webSearchEnabled = false,
    reasoningEffort?: string | null,
  ): string[] {
    // Web検索が有効な turn では WebSearch / WebFetch を許可リストへ追加し、不許可リスト
    // から取り除く。baseAllowedTools / this.disallowedTools はこのturn用に解決済みで、
    // 変異させず、per-turn の配列/文字列をここで組み立てる。--allowedTools は
    // 「Comma or space-separated list of tool names」(claude --help で確認) を1引数で
    // 受け取れるため、空白区切りの1文字列として渡す。Bash / Write / Edit / Task は
    // webSearchEnabled に関係なく常に不許可のまま残す (WebSearch/WebFetch だけを外す)。
    const allowedTools = webSearchEnabled
      ? `${baseAllowedTools} WebSearch WebFetch`
      : baseAllowedTools;
    const disallowedTools = webSearchEnabled
      ? this.disallowedTools.filter((tool) => tool !== "WebSearch" && tool !== "WebFetch")
      : this.disallowedTools;
    const args = [
      "--print",
      "--verbose",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--mcp-config",
      JSON.stringify(mcpConfigOverride ?? this.mcpConfig),
      "--strict-mcp-config",
      "--permission-mode",
      "dontAsk",
      "--allowedTools",
      allowedTools,
    ];
    if (disallowedTools.length > 0) {
      args.push("--disallowedTools", ...disallowedTools);
    }
    args.push("--model", model);
    if (reasoningEffort?.trim()) {
      args.push("--effort", reasoningEffort.trim());
    }
    if (resumeSessionId) {
      args.push("--resume", resumeSessionId);
    }
    return args;
  }

  private allowedToolsForRun(params: ClaudeRunTurnParams): string {
    if (this.allowedToolsOverride) {
      return this.allowedToolsOverride;
    }
    if (process.env.SIGMA_AI_TOOL_GATING?.trim().toLowerCase() === "off") {
      return FULL_EXPOSURE_ALLOWED_TOOLS;
    }
    const categories = inferToolCategoriesForRun({
      instruction: params.userInstruction ?? params.instruction,
      references: params.references ?? [],
      selectedSkillIds: params.selectedSkillIds ?? [],
    });
    const mcpTools = appMcpToolNames(toolNamesForCategories(categories))
      .map((name) => `${SIGMA_MCP_TOOL_PREFIX}${name}`)
      .join(" ");
    return `${mcpTools} ${DEFAULT_ALLOWED_TOOLS}`;
  }

  private async isClaudeAvailable(): Promise<boolean> {
    const now = Date.now();
    const pathEnv = getProcessPathEnv();
    const displayClaudeBin = this.getDisplayClaudeBin();
    // 肯定結果のみキャッシュ (Codex と同じ方針)。否定はキャッシュせず、claude を後から
    // インストールした場合に即座に再検出できるようにする。
    if (
      this.availableCache?.available &&
      this.availableCache.pathEnv === pathEnv &&
      this.availableCache.claudeBin === displayClaudeBin &&
      now - this.availableCache.checkedAt < CLAUDE_AVAILABILITY_CACHE_MS
    ) {
      return true;
    }

    for (const candidate of this.getClaudeBinCandidates()) {
      const available = await canSpawnClaude(candidate, this.availabilityProbeTimeoutMs);
      if (available) {
        this.resolvedClaudeBin = candidate;
        this.availableCache = { available: true, checkedAt: now, pathEnv, claudeBin: this.getDisplayClaudeBin() };
        this.lastError = null;
        return true;
      }
    }

    this.resolvedClaudeBin = null;
    this.availableCache = { available: false, checkedAt: now, pathEnv, claudeBin: this.getDisplayClaudeBin() };
    this.lastError = this.configuredClaudeBin
      ? te("electron.claudeClient.configuredCliNotFound", { binPath: this.configuredClaudeBin })
      : te("electron.claudeClient.commandNotFound");
    return false;
  }

  private getClaudeBinCandidates(): string[] {
    if (this.configuredClaudeBin) {
      return [this.configuredClaudeBin];
    }
    return getDefaultClaudeBinCandidates();
  }

  private getClaudeBinForSpawn(): string {
    // 設定に残っている裸名と、候補が 1 つも解決しなかったときのフォールバックも PATH 解決へ
    // 載せる。`shell` を「非絶対パスだから」で立てるのをやめたぶん、ここで解決しないと
    // Windows の `.cmd` インストールが ENOENT になる。
    return resolveCliBinForSpawn(
      this.configuredClaudeBin ?? this.resolvedClaudeBin ?? "claude",
      process.platform,
      process.env,
    );
  }

  private getDisplayClaudeBin(): string {
    return this.configuredClaudeBin ?? this.resolvedClaudeBin ?? "claude";
  }
}

function normalizeBin(value: string | null | undefined): string | null {
  let trimmed = value?.trim();
  if (
    trimmed &&
    trimmed.length >= 2 &&
    ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    trimmed = trimmed.slice(1, -1).trim();
  }
  return trimmed ? trimmed : null;
}

export function getDefaultClaudeBinCandidates(): string[] {
  if (process.platform === "win32") {
    return getDefaultWindowsClaudeBinCandidates();
  }

  const home = process.env.HOME?.trim();
  const candidates = [
    ...(home
      ? [
          path.join(home, ".local", "bin", "claude"),
          path.join(home, "Library", "pnpm", "bin", "claude"),
          path.join(home, ".npm-global", "bin", "claude"),
          path.join(home, ".bun", "bin", "claude"),
        ]
      : []),
    "/opt/homebrew/bin/claude",
    "/usr/local/bin/claude",
    "claude",
  ];
  return [...new Set(candidates)];
}

function getDefaultWindowsClaudeBinCandidates(): string[] {
  const userProfile = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const appData = process.env.APPDATA?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const candidates = [
    ...(appData
      ? [
          path.join(appData, "npm", "claude.exe"),
          path.join(appData, "npm", "claude.cmd"),
        ]
      : []),
    ...(localAppData
      ? [
          path.join(localAppData, "pnpm", "claude.exe"),
          path.join(localAppData, "pnpm", "claude.cmd"),
          path.join(localAppData, "Microsoft", "WindowsApps", "claude.exe"),
        ]
      : []),
    ...(userProfile
      ? [
          path.join(userProfile, ".local", "bin", "claude.exe"),
          path.join(userProfile, ".local", "bin", "claude.cmd"),
          path.join(userProfile, ".bun", "bin", "claude.exe"),
          path.join(userProfile, ".bun", "bin", "claude.cmd"),
        ]
      : []),
    "claude.exe",
    "claude.cmd",
    "claude",
  ];
  // 裸名は shell 解決に頼らず自前で PATH/PATHEXT から絶対パスへ引く。`.exe` を `.cmd` より
  // 先に置くのは、shell が要る経路 (`.cmd`) へ落ちる機会そのものを減らすため。
  return resolveBareBinNames([...new Set(candidates)], process.platform, process.env);
}

function getExtraPathEntries(): string[] {
  return getDefaultClaudeBinCandidates()
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.dirname(candidate));
}

async function canSpawnClaude(claudeBin: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawnCliProcess(claudeBin, ["--version"], {
      env: buildClaudeChildEnv(),
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

export function buildClaudeChildEnv(): ClaudeChildEnv {
  const next: ClaudeChildEnv = buildCliChildEnv(CLAUDE_CHILD_ENV_KEYS, WINDOWS_CLAUDE_CHILD_ENV_KEYS, getExtraPathEntries());

  // CLAUDE_CONFIG_DIR は設定しない。ユーザー既定の ~/.claude (= サブスクのログイン情報) を
  // そのまま使うため。隔離ディレクトリを指すとログイン情報が見えず "Not logged in" になる。
  // サブスク認証をAPIキーで上書きさせない (誤って課金させない) ための念押し。
  for (const key of FORBIDDEN_CHILD_ENV_KEYS) {
    delete next[key];
  }
  return next;
}


function isAuthErrorMessage(text: string): boolean {
  return /not logged in|\/login|please log ?in|unauthorized|authenticate|invalid api key|credit balance/i.test(text);
}

export function parseClaudeModelAliasesFromHelp(help: string): string[] {
  const modelOption = help.match(/--model\s+<model>[\s\S]{0,900}?Provide an alias[\s\S]{0,500}?or a model's full name/i)?.[0] ?? "";
  const aliases = [...modelOption.matchAll(/['"`]([a-z][a-z0-9-]*)['"`]/gi)]
    .map((match) => match[1].toLowerCase())
    .filter((alias) => !alias.startsWith("claude-"));
  return [...new Set(aliases)];
}

function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
