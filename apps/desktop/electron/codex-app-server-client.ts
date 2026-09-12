import { createCurrentLocaleTranslator, type AppLocale } from "@/lib/i18n";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { buildCliChildEnv, getProcessPathEnv } from "./cli-child-env";

import { resolveBareBinNames, resolveCliBinForSpawn, spawnCliProcess, type CliChildProcess } from "./cli-spawn";

import { SIGMA_DOC_MCP_SERVER_NAME } from "./sigma-studio-mcp-launch";

const te = createCurrentLocaleTranslator("error");

// Fallback developer instructions used when a caller does not pass its own.
// The AI-edit flow passes its own MCP-native developer instructions instead
// (ai-edit.ts always calls startThread/resumeThread with an explicit
// developerInstructions argument), so this fallback is currently dead code
// for that flow; kept for any future caller that omits its own instructions.
const DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS = [
  "You are embedded inside Sigma Studio.",
  "You may call MCP tools exposed by the sigma-studio-local server to read and edit the local teaching material.",
  "Use read-only shell commands only to read a selected skill's SKILL.md and its referenced files. Never read or edit teaching-material files directly on disk, and never use connectors.",
  "Only use web search if the app has explicitly enabled it for this session.",
].join("\n");

interface JsonRpcResponse {
  id: number | string;
  result?: unknown;
  error?: {
    code?: number;
    message?: string;
  };
}

interface JsonRpcNotification {
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcServerRequest {
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

interface AvailabilityCache {
  available: boolean;
  checkedAt: number;
  pathEnv: string | undefined;
  codexBin: string;
}

interface ActiveTurn {
  threadId: string;
  turnId: string;
  finalText: string;
  onDelta?: (delta: string) => void;
  onNotification?: (notification: JsonRpcNotification) => void;
  resolve: (value: CodexTurnResult) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
  interrupted: boolean;
  /** Forbidden item types this turn attempted; refused (never executed) but reported to the caller. */
  refusedItemTypes: string[];
  onRefusal?: (itemType: string, itemId?: string) => void;
  /**
   * This run's id (from ai-edit:run), threaded in by the caller alongside the
   * turnId Codex itself assigns. Codex's app-server protocol has no concept of
   * our app-level runId, so this is the key the cancellation registry
   * (main.ts's activeAiEditRuns) uses to find and interrupt this turn without
   * needing to know its Codex-assigned turnId.
   */
  runId?: string;
}

export interface CodexAppServerClientOptions {
  codexHome: string;
  codexWorkspace?: string;
  codexBin?: string;
  configToml: string;
  /** Initial aiWebSearchEnabled value; gates the "webSearch" item type in FORBIDDEN_ITEM_TYPES handling. Defaults to false when omitted. */
  webSearchEnabled?: boolean;
  /**
   * Rebuilds configToml for a new webSearchEnabled value, using the same
   * CodexAgentConfigInput the caller used at construction time. Required for
   * {@link CodexAppServerClient.setWebSearchEnabled} to actually rewrite
   * config.toml on a runtime setting change; if omitted, setWebSearchEnabled()
   * only updates the in-memory FORBIDDEN_ITEM_TYPES gate.
   */
  buildConfigToml?: (webSearchEnabled: boolean, uiLocale: AppLocale) => string;
  /** config.toml に焼く表示言語の初期値。{@link CodexAppServerClient.setUiLocale} で差し替える。 */
  uiLocale: AppLocale;
}

export interface CodexAccountSummary {
  type: string;
  email?: string;
  planType?: string;
}

export interface CodexStatus {
  available: boolean;
  running: boolean;
  loggedIn: boolean;
  codexHome: string;
  codexBin: string;
  configuredCodexBin: string | null;
  account: CodexAccountSummary | null;
  error: string | null;
}

export interface CodexReasoningEffortOption {
  id: string;
  description?: string;
}

export interface CodexModelOption {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
  defaultReasoningEffort?: string;
  supportedReasoningEfforts?: CodexReasoningEffortOption[];
}

export interface CodexModelCatalog {
  models: CodexModelOption[];
}

export interface CodexLoginResult {
  ok: boolean;
  authUrl?: string;
  loginId?: string;
  error?: string;
}

export interface CodexTurnInput {
  type: "text";
  text: string;
  text_elements: [];
}

export interface CodexTurnImageInput {
  type: "image";
  url: string;
}

export interface CodexRunTurnParams {
  threadId: string;
  input: Array<CodexTurnInput | CodexTurnImageInput>;
  model?: string | null;
  reasoningEffort?: string | null;
  /** Overrides {@link DEFAULT_CODEX_RUN_TURN_TIMEOUT_MS} for this turn only. */
  timeoutMs?: number;
  onDelta?: (delta: string) => void;
  onNotification?: (notification: JsonRpcNotification) => void;
  /**
   * Called when the agent attempted a forbidden operation and it was refused.
   * The run itself keeps going (the caller may resume it), so the caller is
   * responsible for surfacing the refusal in its activity log. `itemId` is the
   * refused item's id when the app-server sent one, so the caller can close out
   * the activity row it already opened for that item.
   */
  onRefusal?: (itemType: string, itemId?: string) => void;
  /** This run's id; lets {@link CodexAppServerClient.cancelByRunId} find and interrupt this turn. */
  runId?: string;
  /**
   * Per-run cwd override: このワークスペースの `agent-workspaces/<workspaceId>/codex`
   * ディレクトリ(LocalAiResourceStore.getAgentWorkspaceDir)。省略時はコンストラクタの
   * codexWorkspace(workspaceId未解決runのフォールバック固定ディレクトリ)を使う。
   * app-serverプロセス自体のspawn cwdはこれに関係なく常にcodexWorkspace(start()参照)。
   */
  cwd?: string | null;
}

export interface CodexThreadResult {
  threadId: string;
}

export interface CodexTurnResult {
  threadId: string;
  turnId: string;
  finalText: string;
  /** True when this result came from a user-initiated cancellation rather than a normal completion. */
  cancelled?: boolean;
  /**
   * Forbidden item types the agent attempted during this turn. Present only
   * when at least one was refused; the operations themselves never ran.
   */
  refusedItemTypes?: string[];
}

const CLIENT_INFO = {
  name: "sigma-studio",
  title: "Sigma Studio",
  version: "0.1.0",
};

// "webSearch" はこの Set に含めず、handleNotification 側で webSearchEnabled
// (aiWebSearchEnabled設定) に応じて動的に禁止判定する。
const FORBIDDEN_ITEM_TYPES = new Set([
  "fileChange",
  "collabAgentToolCall",
]);

// Codex reports SSE retry progress as an `error` notification whose message is
// "Reconnecting... <attempt>/<max>" (codex core/src/responses_retry.rs). It is a
// progress report, not a terminal failure: the turn keeps running and completes
// normally once a retry succeeds. Treating it as terminal used to abort whole
// runs mid-flight.
const TRANSIENT_RECONNECT_MESSAGE_PATTERN = /^\s*Reconnecting\.\.\.\s*(\d+)\s*\/\s*(\d+)/i;

export interface CodexReconnectProgress {
  attempt: number;
  maxAttempts: number;
}

/** Parses a "Reconnecting... N/M" progress message, or null when the message is a real error. */
export function parseCodexReconnectProgress(message: string | undefined): CodexReconnectProgress | null {
  if (typeof message !== "string") {
    return null;
  }
  const match = TRANSIENT_RECONNECT_MESSAGE_PATTERN.exec(message);
  if (!match) {
    return null;
  }
  const attempt = Number.parseInt(match[1], 10);
  const maxAttempts = Number.parseInt(match[2], 10);
  if (!Number.isFinite(attempt) || !Number.isFinite(maxAttempts)) {
    return null;
  }
  return { attempt, maxAttempts };
}

// The MCP visual-editing loop (begin/visual_insert_shape/render/inspect/review/commit)
// can involve many sequential tool calls with render round-trips; 8 minutes was too
// short and aborted legitimate long-running turns. Precision over speed: give turns
// generous headroom rather than tuning this down again later.
const DEFAULT_CODEX_RUN_TURN_TIMEOUT_MS = 1000 * 60 * 30;

const CODEX_WORKSPACE_DIR_NAME = "codex-agent-workspace";
const CODEX_AVAILABILITY_CACHE_MS = 10_000;
const CODEX_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
] as const;
const WINDOWS_CODEX_CHILD_ENV_KEYS = [
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

export type CodexChildEnv = NodeJS.ProcessEnv & { NODE_ENV: string };

export class CodexAppServerClient extends EventEmitter {
  private readonly codexHome: string;
  private readonly codexWorkspace: string;
  // setWebSearchEnabled() が config.toml の内容を差し替えるため readonly にしない。
  // start() → prepareCodexAgentDirs() が spawn 前に毎回この値を config.toml へ書き出す。
  private configToml: string;
  // 現在有効な aiWebSearchEnabled 値。handleNotification の webSearch item 禁止判定に使う。
  private webSearchEnabled: boolean;
  private readonly buildConfigToml: ((webSearchEnabled: boolean, uiLocale: AppLocale) => string) | null;
  private uiLocale: AppLocale;
  private configuredCodexBin: string | null;
  private resolvedCodexBin: string | null = null;
  private proc: CliChildProcess | null = null;
  private rl: readline.Interface | null = null;
  private nextId = 1;
  private initialized = false;
  private startPromise: Promise<void> | null = null;
  private availableCache: AvailabilityCache | null = null;
  private lastError: string | null = null;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly activeTurns = new Map<string, ActiveTurn>();
  // runId -> turnId, so cancelByRunId() can find the active turn without the
  // caller needing to know Codex's own turnId (only known after turn/start
  // resolves). Kept in sync with activeTurns in completeTurn()/rejectAll().
  private readonly activeTurnsByRunId = new Map<string, string>();
  private readonly queuedTurnNotifications = new Map<string, JsonRpcNotification[]>();
  private readonly queuedTurnNotificationTimers = new Map<string, NodeJS.Timeout>();
  private readonly queuedServerRequests = new Map<string, JsonRpcServerRequest[]>();
  private readonly queuedServerRequestTimers = new Map<string, NodeJS.Timeout>();

  constructor(options: CodexAppServerClientOptions) {
    super();
    this.codexHome = options.codexHome;
    this.codexWorkspace = options.codexWorkspace ?? path.join(path.dirname(options.codexHome), CODEX_WORKSPACE_DIR_NAME);
    this.configToml = options.configToml;
    this.webSearchEnabled = options.webSearchEnabled === true;
    this.uiLocale = options.uiLocale;
    this.buildConfigToml = options.buildConfigToml ?? null;
    this.configuredCodexBin = normalizeCodexBin(options.codexBin);
  }

  getCodexHome(): string {
    return this.codexHome;
  }

  getConfiguredCodexBin(): string | null {
    return this.configuredCodexBin;
  }

  /**
   * Resolves the codex binary this client would spawn, reusing the same
   * candidate-probing + caching logic as ensureStarted()/getStatus(). Exposed
   * for the one-shot `codex exec` skill-draft generator (ai-skill-draft.ts),
   * which spawns its own short-lived process outside the app-server JSON-RPC
   * protocol but still wants "whatever codex binary this app already found"
   * instead of re-implementing candidate discovery.
   */
  async resolveCodexBinForSpawn(): Promise<string> {
    await this.isCodexAvailable();
    return this.getCodexBinForSpawn();
  }

  setCodexBin(codexBin: string | null): void {
    const next = normalizeCodexBin(codexBin);
    if (next === this.configuredCodexBin) {
      return;
    }
    this.configuredCodexBin = next;
    this.resolvedCodexBin = null;
    this.availableCache = null;
    this.lastError = null;
    this.dispose();
    this.emit("statusChanged");
  }

  /**
   * aiWebSearchEnabled設定の実行時変更を反映する。config.toml は app-server の
   * spawn 前にしか読まれないため、setCodexBin と同じ「dispose して次の呼び出しで
   * 再spawn」戦略をとる。ただし実行中の turn があるときは dispose すると turn が
   * 巻き添えで落ちるので、設定値だけ差し替えて lazily 適用する:
   * すでに実行中の turn には一切適用されず、次に process が dispose/respawn された
   * 後の新しい turn からconfig値が効く。webSearchEnabled フィールド (item 禁止判定)
   * は即時反映される。
   */
  setWebSearchEnabled(enabled: boolean): void {
    if (enabled === this.webSearchEnabled) {
      return;
    }
    this.webSearchEnabled = enabled;
    this.rebuildConfigToml();
  }

  /**
   * 表示言語の実行時変更を反映する。**`setWebSearchEnabled` と同型**。
   *
   * Codex だけは常駐 app-server が spawn 前の config.toml しか読まないため、
   * ここで伝えないと **MCP サーバー (別プロセス) が返す検証フィードバックだけ
   * 元の言語のまま**アプリ再起動まで残る。Claude / Antigravity は turn ごとに
   * 設定を渡し直すので伝搬不要。
   */
  setUiLocale(locale: AppLocale): void {
    if (locale === this.uiLocale) {
      return;
    }
    this.uiLocale = locale;
    this.rebuildConfigToml();
  }

  /**
   * config.toml に焼かれた値 (表示言語など) が外で変わったときに呼ぶ。
   *
   * Codex だけは常駐 app-server が spawn 前の config.toml しか読まないため、
   * **これを呼ばないと言語切り替えが MCP サーバーへ永久に届かない** (Claude /
   * Antigravity は turn ごとに設定を渡し直すので不要)。webSearch と同じく、
   * 実行中の turn は巻き添えにせず、次の spawn から効く。
   */
  rebuildConfigToml(): void {
    if (this.buildConfigToml) {
      this.configToml = this.buildConfigToml(this.webSearchEnabled, this.uiLocale);
    }
    if (this.activeTurns.size === 0) {
      this.dispose();
    }
  }

  async getStatus(): Promise<CodexStatus> {
    const available = await this.isCodexAvailable();
    if (!available) {
      return {
        available: false,
        running: false,
        loggedIn: false,
        codexHome: this.codexHome,
        codexBin: this.getDisplayCodexBin(),
        configuredCodexBin: this.configuredCodexBin,
        account: null,
        error: this.lastError ?? te("electron.codexClient.commandNotFound"),
      };
    }

    try {
      await this.ensureStarted();
      const result = await this.request<{ account?: unknown; requiresOpenaiAuth?: boolean }>("account/read", { refreshToken: false }, 8000);
      const account = normalizeAccount(result.account);
      return {
        available: true,
        running: Boolean(this.proc),
        loggedIn: Boolean(account),
        codexHome: this.codexHome,
        codexBin: this.getDisplayCodexBin(),
        configuredCodexBin: this.configuredCodexBin,
        account,
        error: null,
      };
    } catch (error) {
      return {
        available: true,
        running: Boolean(this.proc),
        loggedIn: false,
        codexHome: this.codexHome,
        codexBin: this.getDisplayCodexBin(),
        configuredCodexBin: this.configuredCodexBin,
        account: null,
        error: error instanceof Error ? error.message : te("electron.codexClient.statusFailed"),
      };
    }
  }

  /**
   * Reads the model catalog from the running Codex app-server. This is the
   * same account/runtime-aware list Codex surfaces to its own model picker,
   * including each model's currently supported reasoning efforts.
   */
  async listModels(): Promise<CodexModelCatalog> {
    await this.ensureStarted();
    const models: CodexModelOption[] = [];
    const seenCursors = new Set<string>();
    let cursor: string | null = null;

    for (let page = 0; page < 20; page += 1) {
      const result: Record<string, unknown> = await this.request<Record<string, unknown>>(
        "model/list",
        { cursor, limit: 100, includeHidden: false },
        15000,
      );
      const data = Array.isArray(result.data) ? result.data : [];
      for (const value of data) {
        const option = normalizeCodexModelOption(value);
        if (option && !models.some((candidate) => candidate.id === option.id)) {
          models.push(option);
        }
      }

      const nextCursor: string | null = typeof result.nextCursor === "string" && result.nextCursor.trim()
        ? result.nextCursor
        : null;
      if (!nextCursor || seenCursors.has(nextCursor)) {
        break;
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return { models };
  }

  async login(): Promise<CodexLoginResult> {
    try {
      await this.ensureStarted();
      const result = await this.request<Record<string, unknown>>(
        "account/login/start",
        { type: "chatgpt", codexStreamlinedLogin: true },
        15000,
      );
      if (typeof result.authUrl !== "string") {
        return { ok: false, error: te("electron.codexClient.loginUrlFailed") };
      }
      return {
        ok: true,
        authUrl: result.authUrl,
        loginId: typeof result.loginId === "string" ? result.loginId : undefined,
      };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : te("electron.codexClient.loginStartFailed"),
      };
    }
  }

  async logout(): Promise<{ ok: boolean }> {
    await this.ensureStarted();
    await this.request("account/logout", undefined, 8000);
    this.emit("statusChanged");
    return { ok: true };
  }

  async startThread(
    model?: string | null,
    reasoningEffort?: string | null,
    developerInstructions?: string | null,
    cwd?: string | null,
  ): Promise<CodexThreadResult> {
    await this.ensureStarted();
    const resolvedCwd = cwd ?? this.codexWorkspace;
    await fs.mkdir(resolvedCwd, { recursive: true });
    const result = await this.request<Record<string, unknown>>("thread/start", {
      model: model ?? undefined,
      reasoningEffort: reasoningEffort ?? undefined,
      cwd: resolvedCwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      ephemeral: false,
      developerInstructions: developerInstructions ?? DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    });
    const thread = getRecord(result.thread);
    const threadId = typeof thread?.id === "string" ? thread.id : null;
    if (!threadId) {
      throw new Error(te("electron.codexClient.threadStartFailed"));
    }
    return { threadId };
  }

  async resumeThread(
    threadId: string,
    model?: string | null,
    reasoningEffort?: string | null,
    developerInstructions?: string | null,
    cwd?: string | null,
  ): Promise<CodexThreadResult> {
    await this.ensureStarted();
    const resolvedCwd = cwd ?? this.codexWorkspace;
    await fs.mkdir(resolvedCwd, { recursive: true });
    const result = await this.request<Record<string, unknown>>("thread/resume", {
      threadId,
      model: model ?? undefined,
      reasoningEffort: reasoningEffort ?? undefined,
      cwd: resolvedCwd,
      approvalPolicy: "never",
      sandbox: "read-only",
      developerInstructions: developerInstructions ?? DEFAULT_CODEX_DEVELOPER_INSTRUCTIONS,
    });
    const thread = getRecord(result.thread);
    const resumedThreadId = typeof thread?.id === "string" ? thread.id : threadId;
    return { threadId: resumedThreadId };
  }

  async runTurn(params: CodexRunTurnParams): Promise<CodexTurnResult> {
    await this.ensureStarted();
    const resolvedCwd = params.cwd ?? this.codexWorkspace;
    await fs.mkdir(resolvedCwd, { recursive: true });
    const result = await this.request<Record<string, unknown>>("turn/start", {
      threadId: params.threadId,
      input: params.input,
      cwd: resolvedCwd,
      approvalPolicy: "never",
      sandboxPolicy: { type: "readOnly", networkAccess: false },
      ...(params.model ? { model: params.model } : {}),
      ...(params.reasoningEffort ? { reasoningEffort: params.reasoningEffort } : {}),
    }, 15000);
    const turn = getRecord(result.turn);
    const turnId = typeof turn?.id === "string" ? turn.id : null;
    if (!turnId) {
      throw new Error(te("electron.codexClient.turnStartFailed"));
    }

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Route through completeTurn so the timeout does the same bookkeeping
        // as every other terminal path (activeTurnsByRunId, queued
        // notifications/requests). This is the only safety net left for a
        // connection that reconnects forever, so it must not leak state.
        this.completeTurn(turnId, new Error(te("electron.codexClient.responseTimeout")));
      }, params.timeoutMs ?? DEFAULT_CODEX_RUN_TURN_TIMEOUT_MS);
      this.activeTurns.set(turnId, {
        threadId: params.threadId,
        turnId,
        finalText: "",
        onDelta: params.onDelta,
        onNotification: params.onNotification,
        onRefusal: params.onRefusal,
        resolve,
        reject,
        timeout,
        interrupted: false,
        refusedItemTypes: [],
        runId: params.runId,
      });
      if (params.runId) {
        this.activeTurnsByRunId.set(params.runId, turnId);
      }
      this.flushQueuedTurnNotifications(turnId);
      this.flushQueuedServerRequests(turnId);
    });
  }

  async interruptTurn(threadId: string): Promise<void> {
    await this.request("turn/interrupt", { threadId }, 5000).catch(() => undefined);
  }

  /**
   * User-initiated cancellation entry point for the ai-edit:cancel IPC
   * (main.ts's activeAiEditRuns registry). Sends turn/interrupt (best-effort;
   * failures are swallowed the same as refuseForbiddenItem does) and resolves
   * the pending runTurn() promise immediately with a cancelled result instead
   * of waiting for turn/completed, which may arrive late or not at all. Any
   * notification that does arrive afterward for this turnId finds no active
   * turn and is queued/discarded by the existing queueTurnNotification TTL
   * (15s), so it never resurfaces once forgotten here.
   */
  cancelByRunId(runId: string): boolean {
    const turnId = this.activeTurnsByRunId.get(runId);
    if (!turnId) {
      return false;
    }
    const active = this.activeTurns.get(turnId);
    if (!active) {
      this.activeTurnsByRunId.delete(runId);
      return false;
    }
    if (active.interrupted) {
      // A refusal interrupt is already in flight (refuseForbiddenItem awaits
      // the turn/interrupt round-trip). Settle the promise as cancelled here
      // anyway; whichever completion runs second finds no active turn and is a
      // no-op, so the user's cancel is never silently dropped.
      this.completeTurnCancelled(turnId);
      return true;
    }
    active.interrupted = true;
    void this.interruptTurn(active.threadId);
    this.completeTurnCancelled(turnId);
    return true;
  }

  dispose(): void {
    this.rejectAll(new Error(te("electron.codexClient.serverDisposed")));
    this.rl?.close();
    this.rl = null;
    const proc = this.proc;
    this.proc = null;
    proc?.kill();
    this.initialized = false;
    this.startPromise = null;
  }

  private async ensureStarted(): Promise<void> {
    if (this.initialized && this.proc) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async start(): Promise<void> {
    const available = await this.isCodexAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.codexClient.commandNotFound"));
    }

    await this.prepareCodexAgentDirs();
    const codexBin = this.getCodexBinForSpawn();
    const proc = spawnCliProcess(codexBin, ["app-server"], {
      cwd: this.codexWorkspace,
      env: buildCodexChildEnv(this.codexHome),
      stdio: "pipe",
      windowsHide: true,
    });
    this.proc = proc;

    proc.once("error", (error: Error) => {
      this.availableCache = null;
      this.handleProcessFailure(proc, new Error(te("electron.codexClient.serverLaunchFailed", { detail: error.message })));
    });
    proc.once("exit", () => {
      this.handleProcessFailure(proc, new Error(te("electron.codexClient.serverExited")));
    });
    proc.stdin.on("error", (error: Error) => {
      this.handleProcessFailure(proc, new Error(te("electron.codexClient.serverWriteFailed", { detail: error.message })));
    });
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        this.lastError = text.slice(0, 1000);
      }
    });

    this.rl = readline.createInterface({ input: proc.stdout });
    this.rl.on("line", (line) => this.handleLine(line));

    await this.request("initialize", {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: true },
    }, 15000, false);
    this.sendNotification("initialized", {});
    this.initialized = true;
    this.emit("statusChanged");
  }

  private async prepareCodexAgentDirs(): Promise<void> {
    if (path.resolve(this.codexHome) === path.resolve(this.codexWorkspace)) {
      throw new Error(te("electron.codexClient.directoriesMustDiffer"));
    }
    await fs.mkdir(this.codexHome, { recursive: true });
    await fs.writeFile(path.join(this.codexHome, "config.toml"), this.configToml, "utf8");
    // codexWorkspace は永続領域: LocalAiResourceStore.syncToRuntimeTargets() が
    // AGENTS.md / .agents/skills/** をここへ同期し、ai-edit:run はプロバイダ起動前に
    // 同期を済ませる (main.ts)。ここで中身を消すと、その turn 用のAIリソースが
    // 消えてしまう (#168 で意図的に削除された挙動の再発なので復活させない)。
    await fs.mkdir(this.codexWorkspace, { recursive: true });
  }

  private async isCodexAvailable(): Promise<boolean> {
    const now = Date.now();
    const pathEnv = getProcessPathEnv();
    const displayCodexBin = this.getDisplayCodexBin();
    if (
      this.availableCache?.available &&
      this.availableCache.pathEnv === pathEnv &&
      this.availableCache.codexBin === displayCodexBin &&
      now - this.availableCache.checkedAt < CODEX_AVAILABILITY_CACHE_MS
    ) {
      return true;
    }

    for (const candidate of this.getCodexBinCandidates()) {
      const available = await canSpawnCodex(candidate, this.codexHome);
      if (available) {
        this.resolvedCodexBin = candidate;
        this.availableCache = { available: true, checkedAt: now, pathEnv, codexBin: this.getDisplayCodexBin() };
        this.lastError = null;
        return true;
      }
    }

    this.resolvedCodexBin = null;
    this.availableCache = { available: false, checkedAt: now, pathEnv, codexBin: this.getDisplayCodexBin() };
    this.lastError = this.configuredCodexBin
      ? te("electron.codexClient.configuredCliNotFound", { binPath: this.configuredCodexBin })
      : te("electron.codexClient.commandNotFound");
    return false;
  }

  private getCodexBinCandidates(): string[] {
    if (this.configuredCodexBin) {
      return [this.configuredCodexBin];
    }
    return getDefaultCodexBinCandidates();
  }

  private getCodexBinForSpawn(): string {
    // 設定に残っている裸名と、候補が 1 つも解決しなかったときのフォールバックも PATH 解決へ
    // 載せる。`shell` を「非絶対パスだから」で立てるのをやめたぶん、ここで解決しないと
    // Windows の `.cmd` インストールが ENOENT になる。
    return resolveCliBinForSpawn(
      this.configuredCodexBin ?? this.resolvedCodexBin ?? "codex",
      process.platform,
      process.env,
    );
  }

  private getDisplayCodexBin(): string {
    return this.configuredCodexBin ?? this.resolvedCodexBin ?? "codex";
  }

  private request<T = unknown>(
    method: string,
    params: unknown,
    timeoutMs = 30000,
    requireInitialized = true,
  ): Promise<T> {
    if (requireInitialized && (!this.proc || !this.initialized)) {
      return Promise.reject(new Error(te("electron.codexClient.serverNotStarted")));
    }
    if (!this.proc) {
      return Promise.reject(new Error(te("electron.codexClient.serverProcessMissing")));
    }

    const id = this.nextId++;
    const message = params === undefined
      ? { method, id }
      : { method, id, params };
    const proc = this.proc;

    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(te("electron.codexClient.requestTimeout", { method })));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      const rejectRequest = (error: Error) => {
        if (!this.pending.has(id)) {
          return;
        }
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      };
      try {
        proc.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
          if (error) {
            rejectRequest(error);
          }
        });
      } catch (error) {
        rejectRequest(error instanceof Error ? error : new Error(te("electron.codexClient.requestFailed")));
      }
    });
  }

  private sendNotification(method: string, params: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  private handleProcessFailure(proc: CliChildProcess, error: Error): void {
    if (this.proc !== proc) {
      return;
    }
    this.lastError = error.message;
    this.proc = null;
    this.initialized = false;
    this.rl?.close();
    this.rl = null;
    this.rejectAll(error);
    this.emit("statusChanged");
  }

  private handleLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }

    if (isRecord(message) && "id" in message && typeof message.method === "string") {
      this.handleServerRequest(message as unknown as JsonRpcServerRequest);
      return;
    }
    if (isRecord(message) && "id" in message && !("method" in message)) {
      this.handleResponse(message as unknown as JsonRpcResponse);
      return;
    }
    if (isRecord(message) && typeof message.method === "string") {
      this.handleNotification(message as unknown as JsonRpcNotification);
    }
  }

  private handleResponse(message: JsonRpcResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error(message.error.message ?? te("electron.codexClient.requestFailed")));
    } else {
      pending.resolve(message.result);
    }
  }

  // MCP ツール承認 elicitation は sigma-studio-local に限り自動許可する。それ以外の
  // server request にはエラーを返し、app-server が応答待ちでハングしないようにする。
  private handleServerRequest(request: JsonRpcServerRequest): void {
    const params = request.params ?? {};
    // turnId ゲートより先に処理する: elicitation の turnId は optional で、
    // turn/start 応答前に届くと queue timeout が承認拒否として扱われてしまうため。
    if (request.method === "mcpServer/elicitation/request") {
      const serverName = typeof params.serverName === "string" ? params.serverName : null;
      if (serverName === SIGMA_DOC_MCP_SERVER_NAME) {
        this.respondResult(request.id, { action: "accept", content: null, _meta: null });
      } else {
        this.respondError(
          request.id,
          `MCP elicitation is only auto-approved for ${SIGMA_DOC_MCP_SERVER_NAME}: ${serverName ?? "unknown"}`,
        );
      }
      return;
    }

    const turnId = getTurnIdFromParams(params);
    if (!turnId) {
      this.respondError(request.id, "Codex app-server request did not include a turnId.");
      return;
    }

    const active = this.activeTurns.get(turnId);
    if (!active) {
      this.queueServerRequest(turnId, request);
      return;
    }

    this.respondError(request.id, `Unsupported Codex app-server request: ${request.method}`);
  }

  private handleNotification(notification: JsonRpcNotification): void {
    if (notification.method === "account/login/completed" || notification.method === "account/updated") {
      this.emit("statusChanged");
      return;
    }

    const params = notification.params ?? {};
    const turn = getRecord(params.turn);
    const turnId = typeof params.turnId === "string"
      ? params.turnId
      : typeof turn?.id === "string"
        ? turn.id
        : null;
    if (!turnId) {
      return;
    }
    const active = this.activeTurns.get(turnId);
    if (!active) {
      this.queueTurnNotification(turnId, notification);
      return;
    }

    active.onNotification?.(notification);

    if (notification.method === "item/agentMessage/delta") {
      const delta = typeof params.delta === "string" ? params.delta : "";
      active.finalText += delta;
      active.onDelta?.(delta);
      return;
    }

    if (notification.method === "item/started" || notification.method === "item/completed") {
      const item = getRecord(params.item);
      const type = typeof item?.type === "string" ? item.type : "";
      const itemId = typeof item?.id === "string" ? item.id : typeof params.itemId === "string" ? params.itemId : undefined;
      if (FORBIDDEN_ITEM_TYPES.has(type)) {
        void this.refuseForbiddenItem(active, type, itemId);
        return;
      }
      // webSearch は aiWebSearchEnabled設定が無効のときだけ禁止する。
      // なお runTurn() は sandboxPolicy { type:"readOnly", networkAccess:false } を送るが、
      // Codexのnative web_searchツールはローカルsandbox内のシェルコマンドではなく
      // モデル側/Codexバックエンド側で実行されると理解しており、ローカルsandboxの
      // networkAccess:false では遮断されないはず (公式ドキュメントでの裏取りはできて
      // いない未検証の理解。web検索が有効なのに動かない場合はここを疑うこと)。
      if (type === "webSearch" && !this.webSearchEnabled) {
        void this.refuseForbiddenItem(active, type, itemId);
        return;
      }
      if (notification.method === "item/completed" && type === "agentMessage" && typeof item?.text === "string") {
        active.finalText = item.text;
      }
      return;
    }

    if (notification.method === "error") {
      // We already decided this turn's outcome in refuseForbiddenItem(), which
      // owns the completion once its turn/interrupt round-trip finishes. Any
      // error the server emits about the interruption is expected noise.
      if (active.interrupted) {
        return;
      }
      const error = getRecord(params.error);
      const message = typeof error?.message === "string" ? error.message : undefined;
      if (parseCodexReconnectProgress(message)) {
        // Retry still in flight — including the last attempt, which is exactly
        // the one most likely to succeed after the longest backoff. Codex
        // reports genuine exhaustion with its own terminal message
        // ("exceeded retry limit, last status: …" / response_too_many_failed_attempts),
        // which falls through to completeTurn below. The notification was
        // already forwarded to onNotification above so the caller can show the
        // reconnect in its activity log; the runTurn timeout is the safety net
        // if the connection never comes back.
        return;
      }
      this.completeTurn(turnId, new Error(message ?? te("electron.codexClient.turnFailed")));
      return;
    }

    if (notification.method === "turn/completed") {
      const status = typeof turn?.status === "string" ? turn.status : "completed";
      if (status !== "completed") {
        if (active.interrupted) {
          // We interrupted this turn ourselves after refusing a forbidden
          // operation; the aborted completion that follows is expected and
          // must not turn the refusal into a run-killing error.
          return;
        }
        const error = getRecord(turn?.error);
        this.completeTurn(
          turnId,
          new Error(typeof error?.message === "string" ? error.message : te("electron.codexClient.turnIncomplete")),
        );
        return;
      }
      this.completeTurn(turnId);
    }
  }

  /**
   * Refuses a forbidden operation without killing the run: the operation is
   * still never executed (FORBIDDEN_ITEM_TYPES is unchanged), but instead of
   * rejecting runTurn() we interrupt the turn and resolve it, recording the
   * refused item type so the caller can tell the agent to continue with MCP
   * tools only. The interrupt is awaited because the caller starts a
   * continuation turn on the same thread right after.
   */
  private async refuseForbiddenItem(active: ActiveTurn, itemType: string, itemId?: string): Promise<void> {
    if (!active.refusedItemTypes.includes(itemType)) {
      active.refusedItemTypes.push(itemType);
      try {
        active.onRefusal?.(itemType, itemId);
      } catch {
        // Activity logging must never be able to strand the turn: without this
        // guard a throwing callback would skip the interrupt below and leave
        // the runTurn promise pending until its timeout.
      }
    }
    // More forbidden items can arrive while turn/interrupt is in flight; record
    // them (above) but only interrupt and complete the turn once.
    if (active.interrupted) {
      return;
    }
    active.interrupted = true;
    await this.interruptTurn(active.threadId);
    this.completeTurn(active.turnId);
  }

  private completeTurn(turnId: string, error?: Error): void {
    const active = this.activeTurns.get(turnId);
    if (!active) {
      return;
    }
    clearTimeout(active.timeout);
    this.activeTurns.delete(turnId);
    if (active.runId) {
      this.activeTurnsByRunId.delete(active.runId);
    }
    this.clearQueuedTurnNotifications(turnId);
    this.clearQueuedServerRequests(turnId);
    if (error) {
      active.reject(error);
      return;
    }
    active.resolve({
      threadId: active.threadId,
      turnId: active.turnId,
      finalText: active.finalText,
      ...(active.refusedItemTypes.length > 0 ? { refusedItemTypes: [...active.refusedItemTypes] } : {}),
    });
  }

  /** Same bookkeeping as completeTurn(), but resolves (never rejects) with a cancelled result. */
  private completeTurnCancelled(turnId: string): void {
    const active = this.activeTurns.get(turnId);
    if (!active) {
      return;
    }
    clearTimeout(active.timeout);
    this.activeTurns.delete(turnId);
    if (active.runId) {
      this.activeTurnsByRunId.delete(active.runId);
    }
    this.clearQueuedTurnNotifications(turnId);
    this.clearQueuedServerRequests(turnId);
    active.resolve({
      threadId: active.threadId,
      turnId: active.turnId,
      finalText: active.finalText,
      cancelled: true,
      ...(active.refusedItemTypes.length > 0 ? { refusedItemTypes: [...active.refusedItemTypes] } : {}),
    });
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
    this.activeTurnsByRunId.clear();
    for (const [turnId, active] of this.activeTurns) {
      clearTimeout(active.timeout);
      active.reject(error);
      this.activeTurns.delete(turnId);
    }
    this.queuedTurnNotifications.clear();
    for (const timeout of this.queuedTurnNotificationTimers.values()) {
      clearTimeout(timeout);
    }
    this.queuedTurnNotificationTimers.clear();
    for (const queued of this.queuedServerRequests.values()) {
      for (const request of queued) {
        this.respondError(request.id, error.message);
      }
    }
    this.queuedServerRequests.clear();
    for (const timeout of this.queuedServerRequestTimers.values()) {
      clearTimeout(timeout);
    }
    this.queuedServerRequestTimers.clear();
  }

  private queueTurnNotification(turnId: string, notification: JsonRpcNotification): void {
    const queued = this.queuedTurnNotifications.get(turnId) ?? [];
    if (queued.length >= 50) {
      queued.shift();
    }
    queued.push(notification);
    this.queuedTurnNotifications.set(turnId, queued);
    if (!this.queuedTurnNotificationTimers.has(turnId)) {
      const timeout = setTimeout(() => {
        this.clearQueuedTurnNotifications(turnId);
      }, 15000);
      timeout.unref?.();
      this.queuedTurnNotificationTimers.set(turnId, timeout);
    }
  }

  private flushQueuedTurnNotifications(turnId: string): void {
    const queued = this.queuedTurnNotifications.get(turnId);
    if (!queued) {
      return;
    }
    this.clearQueuedTurnNotifications(turnId);
    for (const notification of queued) {
      this.handleNotification(notification);
    }
  }

  private clearQueuedTurnNotifications(turnId: string): void {
    this.queuedTurnNotifications.delete(turnId);
    const timeout = this.queuedTurnNotificationTimers.get(turnId);
    if (timeout) {
      clearTimeout(timeout);
      this.queuedTurnNotificationTimers.delete(turnId);
    }
  }

  private queueServerRequest(turnId: string, request: JsonRpcServerRequest): void {
    const queued = this.queuedServerRequests.get(turnId) ?? [];
    queued.push(request);
    this.queuedServerRequests.set(turnId, queued);
    if (!this.queuedServerRequestTimers.has(turnId)) {
      const timeout = setTimeout(() => {
        const stale = this.queuedServerRequests.get(turnId) ?? [];
        for (const item of stale) {
          this.respondError(item.id, "Codex app-server tool request timed out before the turn became active.");
        }
        this.clearQueuedServerRequests(turnId);
      }, 15000);
      timeout.unref?.();
      this.queuedServerRequestTimers.set(turnId, timeout);
    }
  }

  private flushQueuedServerRequests(turnId: string): void {
    const queued = this.queuedServerRequests.get(turnId);
    if (!queued) {
      return;
    }
    this.clearQueuedServerRequests(turnId);
    for (const request of queued) {
      this.handleServerRequest(request);
    }
  }

  private clearQueuedServerRequests(turnId: string): void {
    this.queuedServerRequests.delete(turnId);
    const timeout = this.queuedServerRequestTimers.get(turnId);
    if (timeout) {
      clearTimeout(timeout);
      this.queuedServerRequestTimers.delete(turnId);
    }
  }

  private respondResult(id: number | string, result: unknown): void {
    this.proc?.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  private respondError(id: number | string, message: string, code = -32000): void {
    this.proc?.stdin.write(`${JSON.stringify({ id, error: { code, message } })}\n`);
  }
}

function getTurnIdFromParams(params: Record<string, unknown>): string | null {
  const turn = getRecord(params.turn);
  return typeof params.turnId === "string"
    ? params.turnId
    : typeof turn?.id === "string"
      ? turn.id
      : null;
}

function normalizeAccount(value: unknown): CodexAccountSummary | null {
  const account = getRecord(value);
  if (!account || typeof account.type !== "string") {
    return null;
  }
  return {
    type: account.type,
    ...(typeof account.email === "string" ? { email: account.email } : {}),
    ...(typeof account.planType === "string" ? { planType: account.planType } : {}),
  };
}

function normalizeCodexModelOption(value: unknown): CodexModelOption | null {
  const model = getRecord(value);
  if (!model || model.hidden === true) {
    return null;
  }
  const id = typeof model.model === "string" && model.model.trim()
    ? model.model.trim()
    : typeof model.id === "string" && model.id.trim()
      ? model.id.trim()
      : "";
  if (!id) {
    return null;
  }
  const advertisedReasoningEfforts = Array.isArray(model.supportedReasoningEfforts)
    ? model.supportedReasoningEfforts
    : null;
  const supportedReasoningEfforts = (advertisedReasoningEfforts ?? [])
    .flatMap((value: unknown): CodexReasoningEffortOption[] => {
      const effort = getRecord(value);
      const effortId = typeof effort?.reasoningEffort === "string" ? effort.reasoningEffort.trim() : "";
      if (!effortId) {
        return [];
      }
      return [{
        id: effortId,
        ...(typeof effort?.description === "string" && effort.description.trim()
          ? { description: effort.description.trim() }
          : {}),
      }];
    });
  return {
    id,
    label: typeof model.displayName === "string" && model.displayName.trim()
      ? model.displayName.trim()
      : id,
    ...(typeof model.description === "string" && model.description.trim()
      ? { description: model.description.trim() }
      : {}),
    ...(typeof model.isDefault === "boolean" ? { isDefault: model.isDefault } : {}),
    ...(typeof model.defaultReasoningEffort === "string" && model.defaultReasoningEffort.trim()
      ? { defaultReasoningEffort: model.defaultReasoningEffort.trim() }
      : {}),
    ...(advertisedReasoningEfforts ? { supportedReasoningEfforts } : {}),
  };
}

function normalizeCodexBin(value: string | null | undefined): string | null {
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

function getDefaultCodexBinCandidates(): string[] {
  if (process.platform === "win32") {
    return getDefaultWindowsCodexBinCandidates();
  }

  const home = process.env.HOME?.trim();
  const candidates = [
    ...(home
      ? [
          path.join(home, "Library", "pnpm", "bin", "codex"),
          path.join(home, ".local", "bin", "codex"),
          path.join(home, ".npm-global", "bin", "codex"),
          path.join(home, ".bun", "bin", "codex"),
        ]
      : []),
    "/opt/homebrew/bin/codex",
    "/usr/local/bin/codex",
    "codex",
  ];
  return [...new Set(candidates)];
}

function getDefaultWindowsCodexBinCandidates(): string[] {
  const userProfile = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const appData = process.env.APPDATA?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const programData = process.env.PROGRAMDATA?.trim();
  const candidates = [
    ...(appData
      ? [
          path.join(appData, "npm", "codex.exe"),
          path.join(appData, "npm", "codex.cmd"),
        ]
      : []),
    ...(localAppData
      ? [
          path.join(localAppData, "pnpm", "codex.exe"),
          path.join(localAppData, "pnpm", "codex.cmd"),
          path.join(localAppData, "Microsoft", "WindowsApps", "codex.exe"),
        ]
      : []),
    ...(userProfile
      ? [
          path.join(userProfile, ".local", "bin", "codex.exe"),
          path.join(userProfile, ".local", "bin", "codex.cmd"),
          path.join(userProfile, ".bun", "bin", "codex.exe"),
          path.join(userProfile, ".bun", "bin", "codex.cmd"),
          path.join(userProfile, "scoop", "shims", "codex.exe"),
          path.join(userProfile, "scoop", "shims", "codex.cmd"),
        ]
      : []),
    ...(programData
      ? [
          path.join(programData, "chocolatey", "bin", "codex.exe"),
          path.join(programData, "chocolatey", "bin", "codex.cmd"),
        ]
      : []),
    "codex.exe",
    "codex.cmd",
    "codex",
  ];
  // 裸名は shell 解決に頼らず自前で PATH/PATHEXT から絶対パスへ引く。`.exe` を `.cmd` より
  // 先に置くのは、shell が要る経路 (`.cmd`) へ落ちる機会そのものを減らすため。
  return resolveBareBinNames([...new Set(candidates)], process.platform, process.env);
}

function getExtraPathEntries(): string[] {
  return getDefaultCodexBinCandidates()
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.dirname(candidate));
}

async function canSpawnCodex(codexBin: string, codexHome: string): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawnCliProcess(codexBin, ["--version"], {
      env: buildCodexChildEnv(codexHome),
      stdio: "ignore",
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 3000);
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

export function buildCodexChildEnv(codexHome: string): CodexChildEnv {
  const next: CodexChildEnv = buildCliChildEnv(CODEX_CHILD_ENV_KEYS, WINDOWS_CODEX_CHILD_ENV_KEYS, getExtraPathEntries());

  next.CODEX_HOME = codexHome;
  next.CODEX_SQLITE_HOME = codexHome;
  return next;
}


function getRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
