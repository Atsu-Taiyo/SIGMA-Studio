import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
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
  onToolUse?: (tool: GeminiToolUse) => void;
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

const DEFAULT_MODEL = "Gemini 3.5 Flash (High)";
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
      if (reloggedIn) {
        // ターミナルで再ログインし creds ファイルが (再)作成/更新された。UIがloggedInで
        // turnをゲートしているため、次のターン完了を待たずにここでフラグを解除する。
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
      child.on("exit", (code) => finish(() => {
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(stderr.trim() || te("electron.antigravity.modelListFailed")));
        }
      }));
    });
    const models = [...new Set(output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
    return {
      models: models.map((model) => ({
        id: model,
        label: model,
        ...(model === this.defaultModel ? { isDefault: true } : {}),
      })),
    };
  }

  async runTurn(params: GeminiRunTurnParams): Promise<GeminiTurnResult> {
    const workspaceDir = params.workspaceDir ?? this.workspaceDir;
    await fs.promises.mkdir(workspaceDir, { recursive: true });
    const available = await this.isGeminiAvailable();
    if (!available) {
      throw new Error(this.lastError ?? te("electron.antigravity.commandNotFound"));
    }

    const model = params.model?.trim() || this.defaultModel;
    // F3 (実機確認): printモードのstdoutには会話ID(conversation)を含むJSONイベントが流れないため、
    // `--log-file` で指定したログファイルに書かれる行から回収する (resume用のsessionIdとして使う)。
    // このturn専用のファイルにする (runId、無ければ時刻) ことで並行run同士のログが混ざらない。
    const logsDir = path.join(workspaceDir, "logs");
    await fs.promises.mkdir(logsDir, { recursive: true });
    const runFileId = String(params.runId ?? Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");
    const logFilePath = path.join(logsDir, `agy-print-${runFileId}.log`);
    // agy 1.1.x requires the prompt as the string value of --print. An @file
    // value is not expanded into the prompt by Antigravity: it is treated as a
    // request for the agent to read that file, so print mode can finish without
    // ever executing the actual instruction. Pass the instruction itself.
    const args = this.buildSpawnArgs(model, params.resumeSessionId ?? null, logFilePath, params.instruction);
    const geminiBin = this.getGeminiBinForSpawn();

    return new Promise<GeminiTurnResult>((resolve, reject) => {
      const proc = spawnCliProcess(geminiBin, args, {
        cwd: workspaceDir,
        env: buildGeminiChildEnv(),
        stdio: "pipe",
        windowsHide: true,
      });

      // プロンプト本体は --print=<instruction> で渡す。stdinは使わない。
      proc.stdin.on("error", () => {});
      proc.stdin.end();

      let finalText = "";
      let stdoutText = "";
      let sessionId: string | null = null;
      let resultEvent: GeminiResultEvent | null = null;
      let blockedToolCount = 0;
      let stderrTail: string | null = null;
      let sawJsonProtocolEvent = false;
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
        // JSONプロトコル経由 (init イベント) で既にsessionIdが取れていれば上書きしない。
        // 取れていなければ (プレーンテキスト経路含む全てのケース) ログファイルから回収を試みる。
        if (!sessionId) {
          sessionId = readSessionIdFromLogFile(logFilePath);
        }
        // 読み取り後はbest-effortで削除する (reject経路でも削除)。
        void fs.promises.unlink(logFilePath).catch(() => {});
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
      proc.stdout.on("data", (data: Buffer) => {
        stdoutText += data.toString();
      });
      rl.on("line", (line) => {
        let message: unknown;
        try {
          message = JSON.parse(line);
        } catch {
          return;
        }
        if (!isRecord(message) || typeof message.type !== "string") {
          return;
        }
        sawJsonProtocolEvent = true;
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
          stderrTail = text.slice(0, 1000);
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
              sessionId,
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

        if (code === EXIT_AUTH_ERROR) {
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

        if (code === 0 && !sawJsonProtocolEvent) {
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
          this.authError = null;
          this.authErrorCredsMtimeMs = null;
          this.loginCache = null;
          const text = stdoutText.trim();
          if (text) {
            params.onDelta?.(text);
          }
          finish(() =>
            resolve({
              sessionId,
              finalText: text,
              isError: false,
              errorMessage: null,
              blockedToolCount,
            }),
          );
          return;
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

  // aiWebSearchEnabled設定について: agy CLI (1.0.16, --print モード) には Web検索を
  // 有効/無効化できるフラグや設定キーが見当たらない (`agy --help` に該当フラグなし、
  // ~/.gemini/config/config.json にも該当キーなし)。そのためこのプロバイダでは
  // aiWebSearchEnabled はツール実行の可否に影響しない (プロンプトのWeb検索ポリシー節の
  // 出し分けのみ gemini-edit.ts 側で行う)。CLI側にトグルが追加されたらここで配線すること。
  private buildSpawnArgs(
    model: string,
    resumeSessionId: string | null,
    logFilePath: string,
    instruction: string,
  ): string[] {
    // agy 1.1.x requires the prompt as the value of its string-valued --print
    // flag. A trailing positional prompt, stdin-only input, and @file expansion
    // are not supported transports for this mode.
    const args = [
      `--print=${instruction}`,
      "--print-timeout",
      `${Math.max(1, Math.ceil(this.turnTimeoutMs / 60_000))}m`,
      "--model",
      model,
    ];
    if (resumeSessionId) {
      args.push("--conversation", resumeSessionId);
    }
    // F3 (実機確認): printモードのstdoutには会話ID(conversation)を含むJSONイベントが流れない。
    // `--log-file` に指定したこのファイルへ書かれる
    // `printmode.go:179] Print mode: conversation=<uuid>, sending message` という行から
    // resume用のsessionIdを回収する (runTurn の finish() 内で読む)。
    args.push("--log-file", logFilePath);
    return args;
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
  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim() || "";
  return path.join(home, ".gemini", "antigravity-cli", "settings.json");
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
    ...(appData
      ? [
          path.join(appData, "npm", "agy.exe"),
          path.join(appData, "npm", "agy.cmd"),
        ]
      : []),
    ...(localAppData
      ? [
          path.join(localAppData, "agy", "bin", "agy.exe"),
        ]
      : []),
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
      resolve({
        loggedIn: false,
        error: stderrTail || null,
        ...(stderrTail ? {} : { appErrorKey: "loginRequired" as const }),
      });
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
    const child = spawnCliProcess(geminiBin, ["--version"], {
      env: buildGeminiChildEnv(),
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


function readSessionIdFromLogFile(logFilePath: string): string | null {
  try {
    const text = fs.readFileSync(logFilePath, "utf8");
    // 実機の行例: `printmode.go:179] Print mode: conversation=<uuid>, sending message`。
    // IDの文字集合 (実機はUUID) を仮定せず、次のカンマまたは空白までを緩く受け取る。
    const match = text.match(/Print mode: conversation=([^,\s]+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
