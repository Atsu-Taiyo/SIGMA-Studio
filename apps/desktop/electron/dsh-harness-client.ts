// 内蔵AI (SIGMA AI) の実行クライアント。
//
// エージェントの実体は DeepSeek Harness (dsh)。モデルは DeepSeek を OpenRouter 経由で使い、
// 鍵はアプリに持たせず中継 (apps/web/ai-gateway) にだけ置く。ここが担当するのは次の 3 つ:
//   1. dsh の実行環境 (apps/desktop/dsh-runtime) と、それを動かす本物の Node を見つける。
//   2. run ごとに dsh の構成 (cordis patch) を書く。モデルの経路と、教材を編集する
//      MCP サーバー (sigma-studio-local) の起動方法だけを載せ、dsh 既定のシェルや
//      ファイル操作ツールは外す (編集は MCP ツールだけで行わせる)。
//   3. 橋渡しプロセス (dsh-runtime/bridge.mjs) を起動して、イベントを run へ流す。
//
// dsh は Electron 内蔵の Node では起動できない (内部モジュールへ触るネイティブ部品が
// 特定の実行環境にしか対応しない) ので、橋渡しは必ず本物の Node で動かす。

import fs from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";

import { getProcessPathEnv } from "./cli-child-env";
import { startDshGatewaySession, type DshGatewayAccount } from "./dsh-gateway-session";
import { spawnCliProcess, type CliChildProcess } from "./cli-spawn";
import { buildSigmaStudioMcpEnv, SIGMA_DOC_MCP_SERVER_NAME, type SigmaStudioMcpLaunchSpec } from "./sigma-studio-mcp-launch";
import type { AiSubagentPolicy } from "@/lib/ai/subagent-settings";

/** 内蔵AIが使うモデル (OpenRouter の ID)。中継の許可リストと揃える。 */
export const SIGMA_AI_MODEL = "deepseek/deepseek-v4.1-flash-1017";
export const SIGMA_AI_MODEL_LABEL = "DeepSeek V4.1 Flash";
/** dsh の構成で使う経路名。中継を指す OpenAI Chat Completions 互換の経路。 */
export const SIGMA_AI_DSH_PROVIDER = "sigma-gateway";
/** 動作を確認した dsh の版。実行環境 (dsh-runtime/package.json) の固定と揃える。 */
export const SIGMA_AI_DSH_VERSION = "0.2.1-rc.5";
/** dsh がモデルに見せる、サブエージェントを起動するツールの名前。橋渡しもこの名前で結果を預かる。 */
export const SIGMA_AI_SUBAGENT_TOOL_NAME = "subagent";

export const SIGMA_AI_GATEWAY_URL_ENV = "SIGMA_AI_GATEWAY_URL";
export const SIGMA_AI_GATEWAY_TOKEN_ENV = "SIGMA_AI_GATEWAY_TOKEN";
export const SIGMA_AI_NODE_BIN_ENV = "SIGMA_STUDIO_NODE_BIN";
export const SIGMA_AI_RUNTIME_DIR_ENV = "SIGMA_STUDIO_DSH_RUNTIME_DIR";

const PACKAGED_GATEWAY_URL = "https://sigma-studio-ai-gateway.sigma-studio-experiment.workers.dev/v1";
const MIN_NODE_VERSION = [24, 9, 0] as const;
const MODEL_CONTEXT_WINDOW = 1_048_576;
const MODEL_MAX_OUTPUT_TOKENS = 32_768;
const MCP_TOOL_CALL_TIMEOUT_MS = 180_000;
const INITIALIZE_TIMEOUT_MS = 90_000;
const NODE_PROBE_TIMEOUT_MS = 10_000;
// 橋渡しは stdin が閉じると SDK の終了処理 (shutdown 1 秒 → stdin EOF 6 秒 → SIGTERM 3 秒 → 強制終了)
// で dsh を畳む。それより先に橋渡しを殺すと dsh が孤児で残るので、その合計より長く待つ。
const CANCEL_KILL_GRACE_MS = 15_000;
// 橋渡しから何も届かないまま待つ上限。上流が応答の途中で止まっても、実行と構成ファイルを手放す。
// 教材ツール 1 回の上限 (MCP_TOOL_CALL_TIMEOUT_MS) とモデルの長い思考より十分長くする。
const TURN_IDLE_TIMEOUT_MS = 10 * 60_000;
// 開始前に届いた中断を覚えておく件数の上限。
const MAX_REMEMBERED_CANCELS = 64;
const STDERR_TAIL_CHARS = 4_000;

/** 環境変数の写し。テストから最小の集合を渡せるよう、NODE_ENV を必須にしない形で受ける。 */
export type DshEnvironment = Readonly<Record<string, string | undefined>>;

/** プランの確認結果を覚えておく時間。プランの変更は 1 分以内に反映される。 */
const ENTITLEMENT_CACHE_MS = 60_000;

export type DshUnavailableReason = "gateway" | "runtime" | "node" | "plan";

export interface DshHarnessStatus {
  available: boolean;
  /** 既存プロバイダと同じ形に合わせる。内蔵AIにログインは無いので available と同じ。 */
  loggedIn: boolean;
  model: string;
  modelLabel: string;
  unavailableReason: DshUnavailableReason | null;
  error: string | null;
}

export interface DshGatewayConfig {
  url: string;
  token: string;
}

export interface DshImageInput {
  mimeType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  base64: string;
  name?: string;
}

export interface DshRunTurnParams {
  runId: string;
  instruction: string;
  images: DshImageInput[];
  /** dsh のセッション ID。続きの会話ではこれを渡して履歴を引き継ぐ。 */
  resumeSessionId: string | null;
  cwd: string;
  /** 教材の MCP サーバー。null なら道具を一切持たせない (本文を返すだけの一回きりの問い合わせ)。 */
  mcp: SigmaStudioMcpLaunchSpec | null;
  systemPrompt: string;
  /**
   * サブエージェントの扱い。有効なときだけ、dsh のサブエージェントの部品を構成に足す
   * (buildDshPatch)。道具を持たせない問い合わせ (mcp: null) では常に足さない。
   */
  subagents?: AiSubagentPolicy;
  onText: (text: string) => void;
  onReasoning: (text: string) => void;
  onToolUse: (tool: { id: string; name: string; input: unknown }) => void;
  onToolResult: (result: { toolUseId: string; isError: boolean; images: Array<{ mimeType: string; base64: string }> }) => void;
}

export interface DshRunTurnResult {
  finalText: string;
  sessionId: string | null;
  isError: boolean;
  errorMessage: string | null;
  cancelled: boolean;
  /** 続きの会話 (resumeSessionId) を開けなかった。呼び出し側は新しい会話としてやり直す。 */
  resumeFailed?: boolean;
}

export interface DshHarnessClientOptions {
  /** dsh のセッション履歴などを置く場所 (userData 配下)。 */
  dshHome: string;
  /** run ごとの構成ファイルを書く場所 (userData 配下)。 */
  patchDir: string;
  /** dsh-runtime を探す候補 (前から順に試す)。 */
  runtimeDirCandidates: () => string[];
  env?: DshEnvironment;
  platform?: NodeJS.Platform;
  packaged?: boolean;
  gatewayAccount?: DshGatewayAccount | null;
  /**
   * 内蔵AIを使ってよい利用者か (Pro プラン)。省略すると確かめない。
   * 中継の利用料はこちらの負担なので、アプリ側の入口でも止める。失敗 (未サインイン・通信不可) は不可として扱う。
   */
  entitled?: () => Promise<boolean>;
  /**
   * いまサインインしているアカウント (未サインインは null)。プランの確認結果はこの値にひも付けて覚え、
   * サインアウトやアカウントの切り替えの後に、前のアカウントの結果を使い回さない。
   */
  entitlementAccount?: () => string | null;
  /** テスト用: 橋渡しから何も届かないまま待つ上限。 */
  turnIdleTimeoutMs?: number;
  /** テスト用の差し替え。 */
  spawnBridge?: (nodeBin: string, bridgePath: string, env: NodeJS.ProcessEnv, cwd: string) => CliChildProcess;
  probeNodeVersion?: (nodeBin: string) => Promise<string | null>;
  pathExists?: (target: string) => Promise<boolean>;
}

interface ResolvedRuntime {
  runtimeDir: string;
  bridgePath: string;
  nodeBin: string;
}

type RuntimeResolution =
  | { ok: true; runtime: ResolvedRuntime }
  | { ok: false; reason: DshUnavailableReason; detail: string };

export function parseNodeVersion(value: string | null | undefined): [number, number, number] | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)/u.exec((value ?? "").trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function isSupportedNodeVersion(value: string | null | undefined): boolean {
  const version = parseNodeVersion(value);
  if (!version) return false;
  for (let index = 0; index < MIN_NODE_VERSION.length; index += 1) {
    if (version[index] !== MIN_NODE_VERSION[index]) return version[index] > MIN_NODE_VERSION[index];
  }
  return true;
}

/** 中継の設定を環境変数から読む。URL は https (開発時のループバックだけ http) に限る。 */
export function readDshGatewayConfig(env: DshEnvironment): DshGatewayConfig | null {
  const rawUrl = env[SIGMA_AI_GATEWAY_URL_ENV]?.trim();
  const token = env[SIGMA_AI_GATEWAY_TOKEN_ENV]?.trim();
  if (!rawUrl || !token) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.username || url.password || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    return null;
  }
  // dsh へ渡すのは OpenAI 互換の基底 URL (`.../v1`)。末尾のスラッシュは落とす。
  const base = url.href.replace(/\/+$/u, "");
  return { url: /\/v1$/u.test(base) ? base : `${base}/v1`, token };
}

/**
 * dsh の構成 (cordis patch)。JSON は YAML の部分集合なので JSON で書く。
 * 鍵は書かない — 経路は環境変数名 (`apiKeyEnv`) だけを持ち、値は橋渡しの環境で渡す。
 */
export function buildDshPatch(args: {
  gatewayUrl: string;
  mcp: SigmaStudioMcpLaunchSpec | null;
  systemPrompt: string;
  /** 公式スキル・利用者のスキルが置かれたディレクトリ (run の作業ディレクトリ配下)。 */
  skillDirs: string[];
  /**
   * サブエージェントの扱い。有効で、道具を持たせる実行 (mcp あり) のときだけ部品を足す。
   * 無効・未指定なら何も足さない (sdk-minimal はサブエージェントの部品を持たないので、道具ごと無い)。
   */
  subagents?: AiSubagentPolicy;
}): unknown[] {
  const disabled = (id: string, name: string) => ({ id, name, disabled: true });
  return [{
    insert: [
      {
        id: "llm-pi-ai",
        name: "@deepseek-ai/dsh-llm-pi-ai",
        config: {
          providers: {
            [SIGMA_AI_DSH_PROVIDER]: {
              apiKeyEnv: SIGMA_AI_GATEWAY_TOKEN_ENV,
              displayName: "SIGMA AI",
              api: "openai-completions",
              baseURL: args.gatewayUrl,
              // 中継 (OpenRouter) は OpenAI そのものではないので、役割名と出力上限の
              // フィールドを互換側へ寄せる。
              compat: { supportsDeveloperRole: false, maxTokensField: "max_tokens" },
              models: [{
                id: SIGMA_AI_MODEL,
                name: SIGMA_AI_MODEL_LABEL,
                contextWindow: MODEL_CONTEXT_WINDOW,
                maxTokens: MODEL_MAX_OUTPUT_TOKENS,
                input: ["text", "image"],
              }],
            },
          },
        },
      },
      ...(args.mcp ? [{
        id: "mcp-sigma-studio",
        name: "@deepseek-ai/dsh-mcp-client",
        config: {
          serverName: SIGMA_DOC_MCP_SERVER_NAME,
          transport: "stdio",
          command: args.mcp.execPath,
          args: [args.mcp.scriptPath],
          env: buildSigmaStudioMcpEnv(args.mcp),
          toolCallTimeoutMs: MCP_TOOL_CALL_TIMEOUT_MS,
          // 編集ツールが無いまま走ると「回答だけして何も直さない」になるので、起動で落とす。
          failOnStartupError: true,
        },
      }] : []),
      // 教材の編集は MCP ツールだけで行う。dsh 既定のシェル・ファイル・作業ディレクトリの
      // ツールは外す (利用者のファイルへ触る経路を作らない)。
      disabled("persistent-bash", "@deepseek-ai/dsh-tool-bash-persistent"),
      disabled("persistent-pwsh", "@deepseek-ai/dsh-tool-pwsh-persistent"),
      disabled("tool-working-directory", "@deepseek-ai/dsh-tool-working-directory"),
      disabled("tool-fs", "@deepseek-ai/dsh-tool-fs"),
      // スキルは dsh の `skill` ツールで読ませる (ファイルを直接読むツールは無い)。
      // 既定の探索先 (利用者の ~/.agents など) は見ず、アプリが用意した場所だけを渡す。
      // 道具を持たせない問い合わせ (mcp: null) では、スキルも読ませない。
      ...(args.mcp ? [
        { id: "skill", name: "@deepseek-ai/dsh-skill" },
        {
          id: "skill-filesystem",
          name: "@deepseek-ai/dsh-skill-filesystem",
          config: { includeDefaultRoots: false, watch: false, customSkillDirs: args.skillDirs },
        },
        { id: "tool-skill", name: "@deepseek-ai/dsh-tool-skill" },
      ] : []),
      // サブエージェント: 受け付けの窓口 (同時に動かす数を強制)、同じプロセスで子を動かす実体、
      // モデルに見せる `subagent` ツール (入れ子の深さを強制) の 3 つを足す。子は親と同じ道具
      // (教材の MCP ツールと skill) を持ち、会話は引き継がない。dsh 0.2.1-rc.5 の実機で、
      // 深さの超過は "subagent depth N exceeds maxDepth M"、数の超過は "subagent limit reached" の
      // エラーとしてモデルへ返ることを確認した。
      ...(args.mcp && args.subagents?.enabled ? [
        { id: "subagent", name: "@deepseek-ai/dsh-subagent", config: { maxActiveSubagents: args.subagents.maxConcurrent } },
        { id: "subagent-spawn", name: "@deepseek-ai/dsh-subagent-spawn-in-process" },
        {
          id: "tool-subagent",
          name: "@deepseek-ai/dsh-tool-subagent",
          config: { provider: "spawn", toolName: SIGMA_AI_SUBAGENT_TOOL_NAME, maxDepth: args.subagents.maxDepth },
        },
      ] : []),
      {
        id: "system-prompt",
        name: "@deepseek-ai/dsh-system-prompt",
        config: {
          includeHarnessIdentity: false,
          includeRuntimeContext: false,
          personaPrefix: args.systemPrompt,
        },
      },
    ],
  }];
}

function defaultProbeNodeVersion(nodeBin: string): Promise<string | null> {
  return new Promise((resolve) => {
    let child: CliChildProcess;
    try {
      // 子プロセスの起動は cli-spawn.ts の入口だけを通す (cli-spawn-boundary.test.ts)。
      // Electron から継承した ELECTRON_RUN_AS_NODE などで結果が変わらないよう、最小の環境で聞く。
      child = spawnCliProcess(nodeBin, ["-p", "process.versions.node"], {
        env: { PATH: getProcessPathEnv() } as unknown as NodeJS.ProcessEnv,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), NODE_PROBE_TIMEOUT_MS);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stdin.end();
    child.once("error", () => { clearTimeout(timer); resolve(null); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code === 0 ? stdout.trim() : null); });
  });
}

async function defaultPathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

export class DshHarnessClient {
  private readonly options: DshHarnessClientOptions;
  private readonly env: DshEnvironment;
  private readonly platform: NodeJS.Platform;
  private readonly activeRuns = new Map<string, { child: CliChildProcess | null; cancelled: boolean }>();
  private readonly nodeVersionCache = new Map<string, Promise<string | null>>();
  private entitlement: { value: boolean; at: number; account: string | null } | null = null;
  /** 開始前 (子プロセスを起こす前) に届いた中断。次にその runId を始めるときに使い切る。 */
  private readonly cancelledBeforeStart = new Set<string>();

  constructor(options: DshHarnessClientOptions) {
    this.options = options;
    this.env = options.env ?? process.env;
    this.platform = options.platform ?? process.platform;
  }

  private getGatewayConfig(): DshGatewayConfig | null {
    return readDshGatewayConfig(this.env);
  }

  async getStatus(): Promise<DshHarnessStatus> {
    const base = { model: SIGMA_AI_MODEL, modelLabel: SIGMA_AI_MODEL_LABEL };
    const unavailable = (reason: DshUnavailableReason, error: string): DshHarnessStatus => ({
      ...base, available: false, loggedIn: false, unavailableReason: reason, error,
    });
    if (this.options.packaged ? !this.options.gatewayAccount : !this.getGatewayConfig()) {
      return unavailable("gateway", this.options.packaged ? "" : `${SIGMA_AI_GATEWAY_URL_ENV} / ${SIGMA_AI_GATEWAY_TOKEN_ENV}`);
    }
    const resolution = await this.resolveRuntime();
    if (!resolution.ok) {
      return unavailable(resolution.reason, resolution.detail);
    }
    if (!(await this.isEntitled())) {
      return unavailable("plan", "");
    }
    return { ...base, available: true, loggedIn: true, unavailableReason: null, error: null };
  }

  /** プランの確認。結果は短い間だけ覚え、状態を聞かれるたびにサーバーへ問い合わせない。 */
  private async isEntitled(): Promise<boolean> {
    const check = this.options.entitled;
    if (!check) return true;
    const account = this.options.entitlementAccount?.() ?? null;
    const now = Date.now();
    const cached = this.entitlement;
    if (cached && cached.account === account && now - cached.at < ENTITLEMENT_CACHE_MS) return cached.value;
    let value = false;
    try {
      value = await check();
    } catch {
      value = false;
    }
    // 問い合わせている間にアカウントが変わったら、その答えは別の人のもの。使わず、覚えもしない。
    if ((this.options.entitlementAccount?.() ?? null) !== account) return false;
    this.entitlement = { value, at: now, account };
    return value;
  }

  private async nodeCandidates(runtimeDir: string): Promise<string[]> {
    const executable = this.platform === "win32" ? "node.exe" : "node";
    const bundled = path.join(runtimeDir, "node", this.platform === "win32" ? "" : "bin", executable);
    if (this.options.packaged) return [bundled];
    const explicit = this.env[SIGMA_AI_NODE_BIN_ENV]?.trim();
    const candidates = [
      ...(explicit ? [explicit] : []),
      bundled,
    ];
    for (const directory of getProcessPathEnv(this.env as NodeJS.ProcessEnv).split(path.delimiter).filter(Boolean)) {
      candidates.push(path.join(directory, executable));
    }
    return [...new Set(candidates)];
  }

  private probeNodeVersion(nodeBin: string): Promise<string | null> {
    let cached = this.nodeVersionCache.get(nodeBin);
    if (!cached) {
      cached = (this.options.probeNodeVersion ?? defaultProbeNodeVersion)(nodeBin);
      this.nodeVersionCache.set(nodeBin, cached);
    }
    return cached;
  }

  async resolveRuntime(): Promise<RuntimeResolution> {
    const exists = this.options.pathExists ?? defaultPathExists;
    const explicitDir = this.options.packaged ? undefined : this.env[SIGMA_AI_RUNTIME_DIR_ENV]?.trim();
    const directories = [...(explicitDir ? [explicitDir] : []), ...this.options.runtimeDirCandidates()];
    let runtimeDir: string | null = null;
    for (const directory of directories) {
      const installed = await exists(path.join(directory, "bridge.mjs"))
        && await exists(path.join(directory, "node_modules", "@deepseek-ai", "dsh-sdk-client", "package.json"));
      if (installed) {
        runtimeDir = directory;
        break;
      }
    }
    if (!runtimeDir) {
      return { ok: false, reason: "runtime", detail: directories.join(", ") };
    }
    let seen: string | null = null;
    for (const nodeBin of await this.nodeCandidates(runtimeDir)) {
      if (!path.isAbsolute(nodeBin) || !await exists(nodeBin)) continue;
      const version = await this.probeNodeVersion(nodeBin);
      if (isSupportedNodeVersion(version)) {
        return { ok: true, runtime: { runtimeDir, bridgePath: path.join(runtimeDir, "bridge.mjs"), nodeBin } };
      }
      seen ??= version ? `${nodeBin} (${version})` : null;
    }
    return { ok: false, reason: "node", detail: seen ?? "node" };
  }

  cancelRun(runId: string): boolean {
    const entry = this.activeRuns.get(runId);
    if (!entry) {
      // まだ始まっていない (準備中の別の経路・次のターンの前)。始めるときに止められるよう覚える。
      this.cancelledBeforeStart.add(runId);
      if (this.cancelledBeforeStart.size > MAX_REMEMBERED_CANCELS) {
        this.cancelledBeforeStart.delete(this.cancelledBeforeStart.values().next().value as string);
      }
      return false;
    }
    entry.cancelled = true;
    const child = entry.child;
    // 準備中 (子プロセスを起こす前) なら、runTurn が次の区切りで気づいて起こさずに返す。
    if (!child) return true;
    // stdin を閉じると橋渡しが dsh を畳んで終了する。応じなければ止める。
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), CANCEL_KILL_GRACE_MS);
    timer.unref?.();
    child.once("exit", () => clearTimeout(timer));
    return true;
  }

  /** この runId に覚えていた「開始前の中断」を捨てる (実行が終わった後の掃除)。 */
  forgetRun(runId: string): void {
    this.cancelledBeforeStart.delete(runId);
  }

  /**
   * アプリ終了時に、走っている橋渡しと dsh を残さない。橋渡しが dsh を畳み終えるまで
   * (上限つきで) 待つ。待たずに終了すると dsh が孤児になり、構成ファイルも残る。
   */
  async dispose(timeoutMs = CANCEL_KILL_GRACE_MS + 1_000): Promise<void> {
    const exits = [...this.activeRuns.entries()].map(([runId, entry]) => {
      const child = entry.child;
      this.cancelRun(runId);
      return child ? new Promise<void>((resolve) => { child.once("close", () => resolve()); }) : Promise.resolve();
    });
    if (exits.length === 0) return;
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.all(exits),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]);
    if (timer) clearTimeout(timer);
  }

  async runTurn(params: DshRunTurnParams): Promise<DshRunTurnResult> {
    // 最初の await より前に登録する。準備 (実行環境の確認・プランの問い合わせ・構成の書き出し) の
    // 間に届いた中断を取りこぼすと、止めたはずの依頼がモデルへ送られて提案が残る。
    const entry: { child: CliChildProcess | null; cancelled: boolean } = {
      child: null,
      cancelled: this.cancelledBeforeStart.delete(params.runId),
    };
    this.activeRuns.set(params.runId, entry);
    const cancelledResult = (): DshRunTurnResult => ({
      finalText: "", sessionId: params.resumeSessionId, isError: false, errorMessage: null, cancelled: true,
    });
    const cleanup: { patchPath?: string; closeGateway?: () => void } = {};
    try {
      return await this.runRegisteredTurn(params, entry, cancelledResult, cleanup);
    } finally {
      if (this.activeRuns.get(params.runId) === entry) this.activeRuns.delete(params.runId);
      cleanup.closeGateway?.();
      if (cleanup.patchPath) await fs.rm(cleanup.patchPath, { force: true }).catch(() => {});
    }
  }

  private async runRegisteredTurn(
    params: DshRunTurnParams,
    entry: { child: CliChildProcess | null; cancelled: boolean },
    cancelledResult: () => DshRunTurnResult,
    cleanup: { patchPath?: string; closeGateway?: () => void },
  ): Promise<DshRunTurnResult> {
    if (entry.cancelled) return cancelledResult();
    const productionAccount = this.options.packaged ? this.options.gatewayAccount : null;
    const developmentGateway = this.options.packaged ? null : this.getGatewayConfig();
    const accountSignal = productionAccount?.accountSignal();
    const resolution = await this.resolveRuntime();
    if ((!productionAccount && !developmentGateway) || !resolution.ok || !(await this.isEntitled()) || accountSignal?.aborted) {
      if (entry.cancelled) return cancelledResult();
      const status = await this.getStatus();
      return { finalText: "", sessionId: params.resumeSessionId, isError: true, errorMessage: status.error, cancelled: false };
    }
    const { runtime } = resolution;
    // 教材の MCP サーバーを起こせないと、dsh は道具が無いまま起動を続け、編集せずに答えてしまう。
    // 起こす相手が無いことはここで分かるので、モデルへ送る前に止める。
    if (params.mcp) {
      const exists = this.options.pathExists ?? defaultPathExists;
      if (!(await exists(params.mcp.execPath)) || !(await exists(params.mcp.scriptPath))) {
        return { finalText: "", sessionId: params.resumeSessionId, isError: true, errorMessage: "The material MCP server is missing.", cancelled: false };
      }
    }

    const turnGateway = productionAccount && accountSignal
      ? await startDshGatewaySession(PACKAGED_GATEWAY_URL, {
        authorization: () => productionAccount.authorization(),
        accountSignal: () => accountSignal,
      })
      : null;
    if (turnGateway) cleanup.closeGateway = turnGateway.close;
    const gateway = turnGateway ?? developmentGateway;
    if (!gateway) return { finalText: "", sessionId: params.resumeSessionId, isError: true, errorMessage: "SIGMA AI gateway unavailable", cancelled: false };

    await fs.mkdir(this.options.patchDir, { recursive: true });
    await fs.mkdir(this.options.dshHome, { recursive: true });
    await fs.mkdir(params.cwd, { recursive: true });
    const patchPath = path.join(this.options.patchDir, `${params.runId.replace(/[^A-Za-z0-9_-]/gu, "_")}.cordis.yml`);
    await fs.writeFile(patchPath, JSON.stringify(buildDshPatch({
      gatewayUrl: gateway.url,
      mcp: params.mcp,
      systemPrompt: params.systemPrompt,
      skillDirs: [path.join(params.cwd, ".agents", "skills")],
      subagents: params.subagents,
    })), { encoding: "utf8", mode: 0o600 });
    cleanup.patchPath = patchPath;
    if (entry.cancelled) return cancelledResult();

    const request = {
      profile: "sdk-minimal",
      patches: [patchPath],
      dshHome: this.options.dshHome,
      cwd: params.cwd,
      provider: SIGMA_AI_DSH_PROVIDER,
      model: SIGMA_AI_MODEL,
      maxTokens: MODEL_MAX_OUTPUT_TOKENS,
      initializeTimeoutMs: INITIALIZE_TIMEOUT_MS,
      ...(params.resumeSessionId ? { sessionId: params.resumeSessionId } : {}),
      // 橋渡しは、この名前のツールの結果を子が終わるまで預かる (進行表示の行を早く閉じない)。
      ...(params.mcp && params.subagents?.enabled ? { subagentToolName: SIGMA_AI_SUBAGENT_TOOL_NAME } : {}),
      content: [
        { type: "text", text: params.instruction },
        ...params.images.map(image => ({ type: "image", data: image.base64, mimeType: image.mimeType, ...(image.name ? { name: image.name } : {}) })),
      ],
    };

    // 橋渡しへ渡す環境: PATH などの最小限と、中継のトークンだけ。Electron 由来の変数
    // (ELECTRON_RUN_AS_NODE など) は渡さない — 橋渡しも dsh も本物の Node で動く。
    const bridgeEnv = {
      PATH: getProcessPathEnv(this.env as NodeJS.ProcessEnv),
      ...(this.env.HOME ? { HOME: this.env.HOME } : {}),
      ...(this.env.USERPROFILE ? { USERPROFILE: this.env.USERPROFILE } : {}),
      ...(this.env.SystemRoot ? { SystemRoot: this.env.SystemRoot } : {}),
      ...(this.env.TMPDIR ? { TMPDIR: this.env.TMPDIR } : {}),
      ...(this.env.TEMP ? { TEMP: this.env.TEMP } : {}),
      ...(this.env.LANG ? { LANG: this.env.LANG } : {}),
      [SIGMA_AI_GATEWAY_TOKEN_ENV]: gateway.token,
    } as unknown as NodeJS.ProcessEnv;

    const child = this.options.spawnBridge
      ? this.options.spawnBridge(runtime.nodeBin, runtime.bridgePath, bridgeEnv, runtime.runtimeDir)
      : spawnCliProcess(runtime.nodeBin, [runtime.bridgePath], { cwd: runtime.runtimeDir, env: bridgeEnv, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    entry.child = child;
    // 起こしている間に中断が届いていたら、依頼を書かずに畳む。
    if (entry.cancelled) {
      child.stdin.end();
      child.kill("SIGKILL");
      return cancelledResult();
    }

    let sessionId: string | null = params.resumeSessionId;
    let finalText = "";
    let lastText = "";
    let errorMessage: string | null = null;
    let settled = false;
    let resumeFailed = false;
    let stderrTail = "";

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin.on("error", () => { /* 橋渡しが先に終わったときの EPIPE は exit 側で扱う。 */ });

    let idleTimedOut = false;
    const idleLimit = this.options.turnIdleTimeoutMs ?? TURN_IDLE_TIMEOUT_MS;
    let idleTimer: NodeJS.Timeout | undefined;
    const touch = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleTimedOut = true;
        child.stdin.end();
        const kill = setTimeout(() => child.kill("SIGKILL"), CANCEL_KILL_GRACE_MS);
        kill.unref?.();
        child.once("exit", () => clearTimeout(kill));
      }, idleLimit);
      idleTimer.unref?.();
    };
    touch();

    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      touch();
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      switch (event.type) {
        case "session":
          if (typeof event.sessionId === "string") sessionId = event.sessionId;
          break;
        case "text":
          if (typeof event.text === "string") {
            lastText = event.text;
            params.onText(event.text);
          }
          break;
        case "reasoning":
          if (typeof event.text === "string") params.onReasoning(event.text);
          break;
        case "tool-call": {
          let input: unknown = undefined;
          try {
            input = typeof event.arguments === "string" && event.arguments ? JSON.parse(event.arguments) : undefined;
          } catch {
            input = undefined;
          }
          params.onToolUse({ id: String(event.id ?? ""), name: String(event.name ?? ""), input });
          break;
        }
        case "tool-result":
          params.onToolResult({
            toolUseId: String(event.id ?? ""),
            isError: event.isError === true,
            images: Array.isArray(event.images)
              ? event.images.flatMap((image) => {
                  const record = image as { mimeType?: unknown; data?: unknown };
                  return typeof record?.mimeType === "string" && typeof record.data === "string"
                    ? [{ mimeType: record.mimeType, base64: record.data }]
                    : [];
                })
              : [],
          });
          break;
        case "result": {
          settled = true;
          if (typeof event.sessionId === "string") sessionId = event.sessionId;
          finalText = typeof event.finalResponse === "string" ? event.finalResponse : "";
          const endReason = event.endReason as { kind?: unknown; message?: unknown } | undefined;
          if (endReason?.kind === "error") {
            errorMessage = typeof endReason.message === "string" ? endReason.message : "error";
          } else if (endReason?.kind === "max-tokens") {
            errorMessage = "max-tokens";
          }
          break;
        }
        case "error":
          settled = true;
          errorMessage = typeof event.message === "string" ? event.message : "error";
          if (event.code === "RESUME_FAILED") resumeFailed = true;
          break;
        default:
          break;
      }
    });

    child.stdin.write(`${JSON.stringify(request)}\n`);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("error", (error) => {
        errorMessage ??= error.message;
        resolve(null);
      });
      child.once("close", code => resolve(code));
    });
    if (idleTimer) clearTimeout(idleTimer);

    if (entry.cancelled) {
      return { finalText: finalText || lastText, sessionId, isError: false, errorMessage: null, cancelled: true };
    }
    if (idleTimedOut) {
      return { finalText: finalText || lastText, sessionId, isError: true, errorMessage: "timeout", cancelled: false };
    }
    if (!settled && !errorMessage) {
      errorMessage = stderrTail.trim() || `bridge exited with code ${exitCode ?? "unknown"}`;
    }
    return {
      finalText: finalText || lastText,
      sessionId,
      isError: errorMessage !== null,
      errorMessage,
      cancelled: false,
      ...(resumeFailed ? { resumeFailed: true } : {}),
    };
  }
}
