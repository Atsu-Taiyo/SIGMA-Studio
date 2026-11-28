import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { withAntigravitySessionSettings } from "./gemini-settings-config";
import { buildCliChildEnv, getProcessPathEnv } from "./cli-child-env";

import { createCurrentLocaleTranslator } from "@/lib/i18n";
import { resolveBareBinNames, resolveCliBinForSpawn, spawnCliProcess } from "./cli-spawn";

const te = createCurrentLocaleTranslator("error");

// claude-stream-client.ts と違い、Antigravity CLI は常駐しない (1 turn = 1 spawn)。

export interface GeminiStatus {
  available: boolean;
  loggedIn: boolean;
  geminiBin: string;
  configuredGeminiBin: string | null;
  error: string | null;
}

export interface GeminiModelCatalog {
  models: Array<{
    id: string;
    label: string;
    isDefault?: boolean;
  }>;
}

export interface GeminiToolUse {
  id?: string;
  name?: string;
  parameters?: unknown;
}

export interface GeminiRunTurnParams {
  instruction: string;
  model?: string | null;
  resumeSessionId?: string | null;
  onDelta?: (delta: string) => void;
  /** Enable only the Studio edit workspace's additional MCP and read permissions. */
  editPermissions?: boolean;
  onToolUse?: (tool: GeminiToolUse) => void;
  onToolResult?: (tool: { toolUseId: string; images: [] }) => void;
  /** This run's id; lets {@link GeminiHeadlessClient.cancelRun} kill this spawned turn. */
  runId?: string;
  /**
   * Per-run workspaceDir override: このワークスペースの
   * `agent-workspaces/<workspaceId>/antigravity` ディレクトリ
   * (LocalAiResourceStore.getAgentWorkspaceDir)。省略時はコンストラクタの workspaceDir
   * (workspaceId未解決runのフォールバック固定ディレクトリ)を使う。
   */
  workspaceDir?: string;
}

export interface GeminiTurnResult {
  sessionId: string | null;
  finalText: string;
  isError: boolean;
  errorMessage: string | null;
  blockedToolCount: number;
  /** True when this result came from a user-initiated cancellation rather than a normal completion. */
  cancelled?: boolean;
}

export interface GeminiHeadlessClientOptions {
  workspaceDir: string;
  userDataDir?: string;
  geminiBin?: string | null;
  defaultModel?: string;
  credsFilePath?: string;
  turnTimeoutMs?: number;
  /** Test-only override for the availability probe cache TTL (ms). */
  availabilityCacheMs?: number;
  /** Test-only override for the CLI availability probe timeout (ms). */
  availabilityProbeTimeoutMs?: number;
  /** Test-only override for the SIGTERM->SIGKILL escalation grace period (ms). */
  cancelGraceMs?: number;
}

// 実機で確認した FatalError の exit code (Part A3)。
const EXIT_AUTH_ERROR = 41;
const EXIT_INPUT_ERROR = 42;

const DEFAULT_MODEL = "auto";
const DEFAULT_TURN_TIMEOUT_MS = 1000 * 60 * 8;
const AVAILABILITY_CACHE_MS = 10_000;
const DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS = 3000;
const DEFAULT_CANCEL_GRACE_MS = 3000;

const GEMINI_CHILD_ENV_KEYS = [
  "PATH",
  "Path",
  "HOME",
  "USER",
  "SHELL",
  "TMPDIR",
  "LANG",
  "LANGUAGE",
] as const;
const WINDOWS_GEMINI_CHILD_ENV_KEYS = [
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
// サブスクリプション (Googleアカウント) 認証を上書きしうる env は子プロセスへ渡さない。
// GEMINI_CLI_HOME は Antigravity CLI の共有設定/認証にも影響しうるため触らない。
const FORBIDDEN_CHILD_ENV_KEYS = [
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "GOOGLE_GEMINI_BASE_URL",
  "GEMINI_CLI_HOME",
  "GEMINI_MODEL",
  "GEMINI_SANDBOX",
  "CLOUD_SHELL",
  "GEMINI_CLI_USE_COMPUTE_ADC",
] as const;

type GeminiChildEnv = NodeJS.ProcessEnv & { NODE_ENV: string };

export class GeminiResumeUnavailableError extends Error {
  constructor(message?: string) {
    super(message ?? te("electron.antigravity.resumeUnavailable"));
    this.name = "GeminiResumeUnavailableError";
  }
}

interface AvailabilityCache {
  available: boolean;
  checkedAt: number;
  pathEnv: string | undefined;
  geminiBin: string;
}

interface LoginCache {
  loggedIn: boolean;
  checkedAt: number;
  pathEnv: string | undefined;
  geminiBin: string;
  error: string | null;
  appErrorKey?: "loginStatusTimeout" | "loginRequired";
}

interface GeminiInitEvent {
  session_id?: string;
}

interface GeminiResultEvent {
  status?: string;
  error?: { type?: string; message?: string };
}

export class GeminiHeadlessClient {
  private readonly workspaceDir: string;
  private readonly userDataDir: string | null;
  private readonly defaultModel: string;
  private readonly credsFilePath: string;
  private readonly turnTimeoutMs: number;
  private readonly availabilityCacheMs: number;
  private readonly availabilityProbeTimeoutMs: number;
  private configuredGeminiBin: string | null;
  private resolvedGeminiBin: string | null = null;
  private availableCache: AvailabilityCache | null = null;
  private loginCache: LoginCache | null = null;
  private lastError: string | null = null;
  // 直近の turn が認証エラー (exit 41) だった場合に立てる。getStatus() の loggedIn に反映する。
  private authError: string | null = null;
  private authErrorAt = 0;
  // authError を立てた時点の creds ファイルの mtime (存在しなければ null)。UIはターンを
  // loggedIn ゲートで止めるため、ターミナルで再ログインしてもターンを起動できず authError が
  // 永久に残ってしまう (Finding 2)。getStatus() で creds ファイルの mtime がこれより新しくなって
  // いれば「ターミナルで再ログインした」とみなし authError をクリアする。
  private authErrorCredsMtimeMs: number | null = null;
  // runId -> cancel handle for the in-flight spawned turn; see the analogous
  // field on ClaudeStreamClient for the full rationale.
  private readonly cancelHandles = new Map<string, () => void>();
  private readonly cancelGraceMs: number;

  constructor(options: GeminiHeadlessClientOptions) {
    this.workspaceDir = options.workspaceDir;
    this.userDataDir = options.userDataDir?.trim() || null;
    this.defaultModel = options.defaultModel?.trim() || DEFAULT_MODEL;
    this.credsFilePath = options.credsFilePath ?? defaultCredsFilePath();
    this.turnTimeoutMs = options.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS;
    this.availabilityCacheMs = options.availabilityCacheMs ?? AVAILABILITY_CACHE_MS;
    this.availabilityProbeTimeoutMs =
      options.availabilityProbeTimeoutMs ?? DEFAULT_AVAILABILITY_PROBE_TIMEOUT_MS;
    this.configuredGeminiBin = normalizeBin(options.geminiBin);
    this.cancelGraceMs = options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS;
  }

  getWorkspaceDir(): string {
    return this.workspaceDir;
  }

  getUserDataDir(): string | null {
    return this.userDataDir;
  }

  getConfiguredGeminiBin(): string | null {
    return this.configuredGeminiBin;
  }

  setGeminiBin(geminiBin: string | null): void {
    const next = normalizeBin(geminiBin);
    if (next === this.configuredGeminiBin) {
      return;
    }
    this.authError = null;
    this.configuredGeminiBin = next;
    this.resolvedGeminiBin = null;
    this.availableCache = null;
    this.loginCache = null;
    this.lastError = null;
  }

  async getStatus(): Promise<GeminiStatus> {
    const available = await this.isGeminiAvailable();
    if (!available) {
      return {
        available: false,
        loggedIn: false,
        geminiBin: this.getDisplayGeminiBin(),
        configuredGeminiBin: this.configuredGeminiBin,
        error: this.lastError ?? te("electron.antigravity.commandNotFound"),
      };
    }

    if (this.authError) {
      const currentMtimeMs = this.getCredsFileMtimeMs();
      const reloggedIn =
        currentMtimeMs !== null &&
        (this.authErrorCredsMtimeMs === null || currentMtimeMs > this.authErrorCredsMtimeMs);
      // Keyring-only logins have no file timestamp. Recheck through agy after the cache expires.
      if (reloggedIn || Date.now() - this.authErrorAt >= this.availabilityCacheMs) {
        this.authError = null;
        this.authErrorCredsMtimeMs = null;
      } else {
        return {
          available: true,
          loggedIn: false,
          geminiBin: this.getDisplayGeminiBin(),
          configuredGeminiBin: this.configuredGeminiBin,
          error: te("electron.antigravity.loginRequiredGoogle"),
        };
      }
    }

    const loginStatus = await this.getAntigravityLoginStatus();
    return {
      available: true,
      loggedIn: loginStatus.loggedIn,
      geminiBin: this.getDisplayGeminiBin(),
      configuredGeminiBin: this.configuredGeminiBin,
      error: loginStatus.error,
    };
  }

  /** Reads the account-aware model list directly from the installed `agy`. */
  async listModels(): Promise<GeminiModelCatalog> {
    const available = await this.isGeminiAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.antigravity.commandNotFound"));
    }
    const geminiBin = this.getGeminiBinForSpawn();
    const output = await new Promise<string>((resolve, reject) => {
      const child = spawnCliProcess(geminiBin, ["models"], {
        env: buildGeminiChildEnv(),
        stdio: "pipe",
        windowsHide: true,
      });
      // The real CLI does not need stdin for `models`; closing it also keeps
      // test/compatibility wrappers that read stdin before inspecting argv
      // from waiting forever.
      child.stdin.on("error", () => {});
      child.stdin.end();
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        fn();
      };
      const timeout = setTimeout(() => {
        child.kill();
        finish(() => reject(new Error(te("electron.antigravity.modelListTimeout"))));
      }, 5000);
      child.stdout.on("data", (data: Buffer) => {
        stdout = `${stdout}${data.toString()}`.slice(-256_000);
      });
      child.stderr.on("data", (data: Buffer) => {
        stderr = `${stderr}${data.toString()}`.slice(-32_000);
      });
      child.on("error", (error) => finish(() => reject(error)));
      child.on("close", (code) => finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr.trim() || te("electron.antigravity.modelListFailed")));
        }
      }));
    });
    const models = new Map<string, string>();
    for (const line of output.trim().split(/\r?\n/)) {
      const [id, label] = line.trim().split("\t");
      if (id && !/^Fetching available models\.{0,3}$/i.test(id)) models.set(id, label?.trim() || id);
    }
    return { models: Array.from(models, ([id, label]) => ({ id, label })) };
  }

  async runTurn(params: GeminiRunTurnParams): Promise<GeminiTurnResult> {
    return withAntigravitySessionSettings(
      params.editPermissions ? this.userDataDir : null,
      (settings) => this.spawnTurn(params, settings),
      path.join(path.dirname(this.credsFilePath), "settings.json"),
    );
  }

  private async spawnTurn(params: GeminiRunTurnParams, settings: string): Promise<GeminiTurnResult> {
    const workspaceDir = params.workspaceDir ?? this.workspaceDir;
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const available = await this.isGeminiAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.antigravity.commandNotFound"));
    }

    const requestedModel = params.model?.trim() || this.defaultModel;
    const args = [
      "--input-format", "stream-json",
      "--output-format", "stream-json",
      "--disable-slash-commands",
      "--print-timeout", `${Math.ceil(this.turnTimeoutMs / 1000)}s`,
    ];
    if (requestedModel !== DEFAULT_MODEL) {
      const { models } = await this.listModels().catch(() => ({ models: [] }));
      const family = (name: string) => name.replace(/\d+(?:[.-]\d+)*/g, "#");
      const match = models.find(({ id, label }) => id === requestedModel || label === requestedModel)
        ?? models.find(({ id, label }) => [id, label].some((name) => family(name) === family(requestedModel)));
      if (match || !models.length) args.push("--model", match?.id ?? requestedModel);
    }
    if (params.resumeSessionId) args.push("--conversation", params.resumeSessionId);
    args.push("--settings", settings);
    const geminiBin = this.getGeminiBinForSpawn();

    return new Promise<GeminiTurnResult>((resolve, reject) => {
      const proc = spawnCliProcess(geminiBin, args, {
        cwd: workspaceDir,
        env: buildGeminiChildEnv(),
        stdio: "pipe",
        windowsHide: true,
      });

      // One stdin frame and EOF run one turn, including prompts larger than the OS argv limit.
      proc.stdin.on("error", () => {});
      proc.stdin.end(JSON.stringify({ event: "user", message: { content: params.instruction } }) + "\n");

      let finalText = "";
      let sessionId: string | null = null;
      let resultEvent: GeminiResultEvent | null = null;
      // Current agy uses event envelopes. Older wrappers may return type-tagged records.
      let streamResult: { status: string | null; response: string | null; errorMessage: string | null } | null = null;
      let blockedToolCount = 0;
      let stderrTail: string | null = null;
      const startedTools = new Set<number>();
      let settled = false;
      let cancelRequested = false;

      const timeout = setTimeout(() => {
        finish(() => {
          proc.kill();
          reject(new Error(te("electron.antigravity.responseTimeout")));
        });
      }, this.turnTimeoutMs);

      const finish = (fn: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
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
          proc.kill("SIGTERM");
          const killTimer = setTimeout(() => {
            if (!settled) {
              proc.kill("SIGKILL");
            }
          }, this.cancelGraceMs);
          killTimer.unref?.();
          proc.once("exit", () => clearTimeout(killTimer));
        });
      }

      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (isRecord(message) && typeof message.event === "string") {
          if (message.event === "init") {
            const conversationId = message.conversation_id;
            if (typeof conversationId === "string" && conversationId) {
              sessionId = conversationId;
            }
          } else if (message.event === "step_update" && isRecord(message.step_update)) {
            const step = message.step_update;
            if (!sessionId && typeof step.conversation_id === "string" && step.conversation_id) {
              sessionId = step.conversation_id;
            }
            if (step.step_type === "agent_response" && typeof step.text_delta === "string" && step.text_delta) {
              finalText += step.text_delta;
              params.onDelta?.(step.text_delta);
            }
            // サブエージェントの起動は step_type:"subagent" で届く (tool とは別の種類。1.5.18 の実機で確認)。
            // 進行表示に出すため、役割の名前を description へ詰めてツール呼び出しとして通知する。
            if (step.step_type === "subagent" && typeof step.step_index === "number") {
              const index = step.step_index;
              const id = `agy-step-${index}`;
              if (!startedTools.has(index)) {
                startedTools.add(index);
                params.onToolUse?.({
                  id,
                  name: typeof step.tool_name === "string" && step.tool_name ? step.tool_name : "invoke_subagent",
                  parameters: { description: describeAntigravitySubagents(step.subagent_info) },
                });
              }
              // このステップの DONE は「起動し終えた」で、サブエージェントの作業はその後も続く
              // (実機では起動の約2秒後に DONE になり、その後に教材ツールの呼び出しが続いた)。
              // 完了として知らせると行がすぐ閉じてしまうので、起動に失敗したときだけ閉じる。
              if (step.state === "ERROR") params.onToolResult?.({ toolUseId: id, images: [] });
            }
            if (step.step_type === "tool" && typeof step.step_index === "number" && typeof step.tool_name === "string") {
              const index = step.step_index;
              // The server-side watcher supplies the actual Studio tool inside this wrapper.
              if (params.editPermissions && this.userDataDir && step.tool_name === "call_mcp_tool") return;
              const id = `agy-step-${index}`;
              if (!startedTools.has(index)) {
                startedTools.add(index);
                params.onToolUse?.({ id, name: step.tool_name, parameters: isRecord(step.tool_info) ? step.tool_info.parameters : undefined });
              }
              if (step.state === "DONE" || step.state === "ERROR") params.onToolResult?.({ toolUseId: id, images: [] });
            }
          } else if (message.event === "result" && isRecord(message.result)) {
            const result = message.result;
            if (typeof result.conversation_id === "string" && result.conversation_id) sessionId = result.conversation_id;
            const error = isRecord(result.error) ? result.error : null;
            streamResult = {
              status: typeof result.status === "string" ? result.status : null,
              response: typeof result.response === "string" ? result.response : null,
              errorMessage: typeof result.error === "string" ? result.error : typeof error?.message === "string" ? error.message : null,
            };
          }
          return;
        }
        if (!isRecord(message) || typeof message.type !== "string") {
          return;
        }
        switch (message.type) {
          case "init": {
            const init = message as unknown as GeminiInitEvent;
            if (typeof init.session_id === "string") {
              sessionId = init.session_id;
            }
            return;
          }
          case "message": {
            if (message.role === "assistant" && message.delta === true && typeof message.content === "string") {
              finalText += message.content;
              params.onDelta?.(message.content);
            }
            return;
          }
          case "tool_use": {
            params.onToolUse?.({
              id: typeof message.tool_id === "string" ? message.tool_id : undefined,
              name: typeof message.tool_name === "string" ? message.tool_name : undefined,
              parameters: message.parameters,
            });
            return;
          }
          case "error": {
            if (typeof message.message === "string" && message.message.includes("AGENT_EXECUTION_BLOCKED")) {
              blockedToolCount += 1;
            }
            return;
          }
          case "result": {
            resultEvent = message as unknown as GeminiResultEvent;
            return;
          }
          default:
            return;
        }
      });

      proc.stderr.on("data", (data: Buffer) => {
        const text = data.toString().trim();
        if (text) {
          stderrTail = ((stderrTail ?? "") + text).slice(-4000);
        }
      });

      proc.once("error", (error: Error) => {
        this.availableCache = null;
        finish(() => reject(new Error(te("electron.antigravity.launchFailed", { detail: error.message }))));
      });

      proc.once("close", (code: number | null) => {
        rl.close();
        if (cancelRequested) {
          finish(() =>
            resolve({
              sessionId: sessionId ?? params.resumeSessionId ?? null,
              finalText,
              isError: false,
              errorMessage: null,
              blockedToolCount,
              cancelled: true,
            }),
          );
          return;
        }
        const resumeRequested = Boolean(params.resumeSessionId);

        const diagnostic = streamResult?.errorMessage || stderrTail || "";
        if (code === EXIT_AUTH_ERROR || /^(?:error:\s*)?authentication required\b/im.test(diagnostic)) {
          this.authErrorAt = Date.now();
          this.authError = te("electron.antigravity.loginRequiredGoogle");
          this.authErrorCredsMtimeMs = this.getCredsFileMtimeMs();
          this.loginCache = null;
          finish(() =>
            resolve({
              sessionId,
              finalText,
              isError: true,
              errorMessage: this.authError,
              blockedToolCount,
            }),
          );
          return;
        }

        if (code === EXIT_INPUT_ERROR && resumeRequested) {
          finish(() => reject(new GeminiResumeUnavailableError()));
          return;
        }

        if (streamResult) {
          this.authError = null;
          this.authErrorCredsMtimeMs = null;
          this.loginCache = null;
          const { status, response, errorMessage } = streamResult;
          const deniedPermission = !response?.trim() && !finalText.trim() ? getHeadlessPermissionDeniedAction(stderrTail) : null;
          const isError = code !== 0 || status !== "SUCCESS" || Boolean(deniedPermission);
          if (!isError && response && !finalText) params.onDelta?.(response);
          finish(() =>
            resolve({
              sessionId,
              finalText: response ?? finalText,
              isError,
              errorMessage: deniedPermission ? formatHeadlessPermissionDeniedMessage(deniedPermission)
                : isError ? errorMessage || stderrTail || te("electron.antigravity.editFailed") : null,
              blockedToolCount,
            }),
          );
          return;
        }

        if (resultEvent) {
          this.authError = null;
          this.authErrorCredsMtimeMs = null;
          this.loginCache = null;
          const status = (resultEvent as GeminiResultEvent).status;
          const isError = status === "error";
          const errorMessage = isError
            ? (resultEvent as GeminiResultEvent).error?.message ?? te("electron.antigravity.editFailed")
            : null;
          finish(() =>
            resolve({
              sessionId,
              finalText,
              isError,
              errorMessage,
              blockedToolCount,
            }),
          );
          return;
        }

        if (code === 0) {
          const deniedPermission = getHeadlessPermissionDeniedAction(stderrTail);
          if (deniedPermission) {
            finish(() =>
              resolve({
                sessionId,
                finalText: "",
                isError: true,
                errorMessage: formatHeadlessPermissionDeniedMessage(deniedPermission),
                blockedToolCount,
              }),
            );
            return;
          }
        }

        finish(() =>
          reject(new Error(stderrTail ?? te("electron.antigravity.exitedWithoutResult", { code: code ?? "null" }))),
        );
      });
    });
  }

  /**
   * User-initiated cancellation entry point for the ai-edit:cancel IPC
   * (main.ts's activeAiEditRuns registry). Sends SIGTERM to the turn's
   * process, escalating to SIGKILL after cancelGraceMs if it hasn't exited,
   * and makes the pending runTurn() promise resolve (not reject) with
   * `cancelled: true`. Returns false if no turn with this runId is running.
   */
  cancelRun(runId: string): boolean {
    const handle = this.cancelHandles.get(runId);
    if (!handle) {
      return false;
    }
    handle();
    return true;
  }

  private getCredsFileMtimeMs(): number | null {
    try {
      const stat = fs.statSync(this.credsFilePath);
      return stat.isFile() ? stat.mtimeMs : null;
    } catch {
      return null;
    }
  }

  private async isGeminiAvailable(): Promise<boolean> {
    const now = Date.now();
    const pathEnv = getProcessPathEnv();
    const displayGeminiBin = this.getDisplayGeminiBin();
    // 肯定・否定どちらの結果もTTL内はキャッシュする (Finding 7)。否定結果を無視すると
    // ステータスポーリングのたびに最大7候補×3秒のプローブが再実行されてしまうため。
    // setGeminiBin() 呼び出し時は明示的にキャッシュをクリアするので、bin設定変更は
    // 即座に反映される。
    if (
      this.availableCache &&
      this.availableCache.pathEnv === pathEnv &&
      this.availableCache.geminiBin === displayGeminiBin &&
      now - this.availableCache.checkedAt < this.availabilityCacheMs
    ) {
      if (!this.availableCache.available) {
        this.lastError = this.configuredGeminiBin
          ? te("electron.antigravity.configuredCliNotFound", { binPath: this.configuredGeminiBin })
          : te("electron.antigravity.commandNotFound");
      }
      return this.availableCache.available;
    }

    for (const candidate of this.getGeminiBinCandidates()) {
      const available = await canSpawnGemini(candidate, this.availabilityProbeTimeoutMs);
      if (available) {
        this.resolvedGeminiBin = candidate;
        this.availableCache = { available: true, checkedAt: now, pathEnv, geminiBin: this.getDisplayGeminiBin() };
        this.lastError = null;
        return true;
      }
    }

    this.resolvedGeminiBin = null;
    this.availableCache = { available: false, checkedAt: now, pathEnv, geminiBin: displayGeminiBin };
    this.lastError = this.configuredGeminiBin
      ? te("electron.antigravity.configuredCliNotFound", { binPath: this.configuredGeminiBin })
      : te("electron.antigravity.commandNotFound");
    return false;
  }

  private async getAntigravityLoginStatus(): Promise<{ loggedIn: boolean; error: string | null }> {
    const now = Date.now();
    const pathEnv = getProcessPathEnv();
    const displayGeminiBin = this.getDisplayGeminiBin();
    if (
      this.loginCache &&
      this.loginCache.pathEnv === pathEnv &&
      this.loginCache.geminiBin === displayGeminiBin &&
      now - this.loginCache.checkedAt < this.availabilityCacheMs
    ) {
      return {
        loggedIn: this.loginCache.loggedIn,
        error: this.loginCache.appErrorKey
          ? te(`electron.antigravity.${this.loginCache.appErrorKey}`)
          : this.loginCache.error,
      };
    }

    const result = await canListAntigravityModels(this.getGeminiBinForSpawn());
    this.loginCache = {
      ...result,
      checkedAt: now,
      pathEnv,
      geminiBin: displayGeminiBin,
    };
    return {
      loggedIn: result.loggedIn,
      error: result.appErrorKey
        ? te(`electron.antigravity.${result.appErrorKey}`)
        : result.error,
    };
  }

  private getGeminiBinCandidates(): string[] {
    if (this.configuredGeminiBin) {
      return [this.configuredGeminiBin];
    }
    return getDefaultGeminiBinCandidates();
  }

  private getGeminiBinForSpawn(): string {
    // 設定に残っている裸名と、候補が 1 つも解決しなかったときのフォールバックも PATH 解決へ
    // 載せる。`shell` を「非絶対パスだから」で立てるのをやめたぶん、ここで解決しないと
    // Windows の `.cmd` インストールが ENOENT になる。
    return resolveCliBinForSpawn(
      this.configuredGeminiBin ?? this.resolvedGeminiBin ?? "agy",
      process.platform,
      process.env,
    );
  }

  private getDisplayGeminiBin(): string {
    return this.configuredGeminiBin ?? this.resolvedGeminiBin ?? "agy";
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
  if (trimmed && isLegacyGeminiCliBin(trimmed)) {
    return null;
  }
  return trimmed ? trimmed : null;
}

function isLegacyGeminiCliBin(value: string): boolean {
  const name = path.basename(value).toLowerCase();
  return name === "gemini" || name === "gemini.cmd" || name === "gemini.exe";
}

function defaultCredsFilePath(): string {
  return path.join(os.homedir(), ".gemini", "antigravity-cli", "antigravity-oauth-token");
}

function getHeadlessPermissionDeniedAction(stderr: string | null): string | null {
  if (
    !stderr
    || !/jetski:\s*no output produced/i.test(stderr)
    || !/headless mode cannot prompt/i.test(stderr)
  ) {
    return null;
  }
  return stderr.match(/tool required the ["']([^"']+)["'] permission/i)?.[1]?.toLowerCase() ?? "unknown";
}

function formatHeadlessPermissionDeniedMessage(permission: string): string {
  if (permission === "mcp") {
    return te("electron.antigravity.mcpPermissionDenied");
  }
  if (permission === "read_file") {
    return te("electron.antigravity.contextPermissionDenied");
  }
  return te("electron.antigravity.permissionDenied", { permission });
}

export function getDefaultGeminiBinCandidates(): string[] {
  if (process.platform === "win32") {
    return getDefaultWindowsGeminiBinCandidates();
  }

  const home = process.env.HOME?.trim();
  const candidates = [
    ...(home
      ? [
          path.join(home, ".local", "bin", "agy"),
        ]
      : []),
    "/opt/homebrew/bin/agy",
    "/usr/local/bin/agy",
    "agy",
  ];
  return [...new Set(candidates)];
}

function getDefaultWindowsGeminiBinCandidates(): string[] {
  const userProfile = process.env.USERPROFILE?.trim() || process.env.HOME?.trim();
  const appData = process.env.APPDATA?.trim();
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const candidates = [
    ...(localAppData ? [path.join(localAppData, "agy", "bin", "agy.exe")] : []),
    ...(appData ? [path.join(appData, "npm", "agy.exe"), path.join(appData, "npm", "agy.cmd")] : []),
    ...(userProfile
      ? [
          path.join(userProfile, ".local", "bin", "agy.exe"),
          path.join(userProfile, ".local", "bin", "agy.cmd"),
        ]
      : []),
    "agy.exe",
    "agy.cmd",
    "agy",
  ];
  // 裸名は shell 解決に頼らず自前で PATH/PATHEXT から絶対パスへ引く。`.exe` を `.cmd` より
  // 先に置くのは、shell が要る経路 (`.cmd`) へ落ちる機会そのものを減らすため。
  return resolveBareBinNames([...new Set(candidates)], process.platform, process.env);
}

async function canListAntigravityModels(geminiBin: string): Promise<{
  loggedIn: boolean;
  error: string | null;
  appErrorKey?: "loginStatusTimeout" | "loginRequired";
}> {
  return new Promise((resolve) => {
    let stderrTail = "";
    const child = spawnCliProcess(geminiBin, ["models"], {
      env: buildGeminiChildEnv(),
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    const timeout = setTimeout(() => {
      child.kill();
      resolve({ loggedIn: false, error: null, appErrorKey: "loginStatusTimeout" });
    }, 5000);
    child.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        stderrTail = text.slice(0, 1000);
      }
    });
    child.on("error", (error: Error) => {
      clearTimeout(timeout);
      resolve({ loggedIn: false, error: error.message });
    });
    child.on("exit", (code: number | null) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve({ loggedIn: true, error: null });
        return;
      }
      if (!stderrTail || /please sign in|authentication required/i.test(stderrTail)) {
        resolve({ loggedIn: false, error: null, appErrorKey: "loginRequired" });
      } else {
        resolve({ loggedIn: false, error: stderrTail });
      }
    });
  });
}

function getExtraPathEntries(): string[] {
  return getDefaultGeminiBinCandidates()
    .filter((candidate) => path.isAbsolute(candidate))
    .map((candidate) => path.dirname(candidate));
}

async function canSpawnGemini(geminiBin: string, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const child = spawnCliProcess(geminiBin, ["--help"], {
      env: buildGeminiChildEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let help = "";
    const readHelp = (chunk: Buffer) => { help = (help + chunk.toString()).slice(-64000); };
    child.stdout.on("data", readHelp);
    child.stderr.on("data", readHelp);
    const timeout = setTimeout(() => {
      child.kill();
      resolve(false);
    }, timeoutMs);
    child.on("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      resolve(code === 0 && ["--input-format", "--output-format", "--settings"].every((flag) => help.includes(flag)));
    });
  });
}

export function buildGeminiChildEnv(): GeminiChildEnv {
  const next: GeminiChildEnv = buildCliChildEnv(GEMINI_CHILD_ENV_KEYS, WINDOWS_GEMINI_CHILD_ENV_KEYS, getExtraPathEntries());

  // GEMINI_API_KEY 等 (Part E) はGoogleアカウント認証を上書きしうるため常に除去する。
  for (const key of FORBIDDEN_CHILD_ENV_KEYS) {
    delete next[key];
  }

  // NO_BROWSER: ヘッドレスでキャッシュ済み認証情報が無い場合にブラウザ起動でハングしないための保険。
  // GOOGLE_GENAI_USE_GCA: settings.json の selectedType が空のときにOAuthパスへ寄せる (settings優先は不変)。
  next.NO_BROWSER = "true";
  next.GOOGLE_GENAI_USE_GCA = "true";

  const project = process.env.GOOGLE_CLOUD_PROJECT;
  if (typeof project === "string" && project.length > 0) {
    next.GOOGLE_CLOUD_PROJECT = project;
  } else {
    delete next.GOOGLE_CLOUD_PROJECT;
  }

  return next;
}


/**
 * `step_update.subagent_info.subagents[]` の役割名 (`role`、無ければ `type_name`) を
 * 進行表示用に1行へまとめる。同じステップで複数を起動したときは「、」ではなく ", " で並べる
 * (役割名はモデルが書く文で、言語が決まらないため)。
 */
export function describeAntigravitySubagents(subagentInfo: unknown): string {
  const subagents = isRecord(subagentInfo) && Array.isArray(subagentInfo.subagents) ? subagentInfo.subagents : [];
  return subagents
    .map((subagent) => {
      if (!isRecord(subagent)) {
        return "";
      }
      const role = typeof subagent.role === "string" ? subagent.role.trim() : "";
      const typeName = typeof subagent.type_name === "string" ? subagent.type_name.trim() : "";
      return role || typeName;
    })
    .filter((label) => label.length > 0)
    .join(", ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
