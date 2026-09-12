import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import * as cliSpawn from "./cli-spawn";

import {
  buildGeminiChildEnv,
  GeminiHeadlessClient,
  GeminiResumeUnavailableError,
  getDefaultGeminiBinCandidates,
} from "./gemini-headless-client";

const tempDirs: string[] = [];

interface ClientFixture {
  client: GeminiHeadlessClient;
  dir: string;
  workspaceDir: string;
  credsFilePath: string;
  fakeGeminiBin: string;
}

interface FakeCapture {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: string;
  prompt: string;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createClient(options: {
  binSource?: string;
  writeCreds?: boolean;
  turnTimeoutMs?: number;
  cancelGraceMs?: number;
} = {}): ClientFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
  tempDirs.push(dir);
  const fakeGeminiBin = path.join(dir, "agy");
  const workspaceDir = path.join(dir, "workspace");
  const credsFilePath = path.join(dir, "gemini-home", "oauth_creds.json");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(fakeGeminiBin, options.binSource ?? FAKE_GEMINI_BIN, "utf8");
  chmodSync(fakeGeminiBin, 0o755);
  if (options.writeCreds !== false) {
    mkdirSync(path.dirname(credsFilePath), { recursive: true });
    writeFileSync(credsFilePath, JSON.stringify({ access_token: "x" }), "utf8");
  }

  return {
    dir,
    workspaceDir,
    credsFilePath,
    fakeGeminiBin,
    client: new GeminiHeadlessClient({
      workspaceDir,
      geminiBin: fakeGeminiBin,
      defaultModel: "Gemini 3.5 Flash (High)",
      credsFilePath,
      turnTimeoutMs: options.turnTimeoutMs,
      availabilityProbeTimeoutMs: 10_000,
      cancelGraceMs: options.cancelGraceMs,
    }),
  };
}

function readFakeCapture(dir: string): FakeCapture {
  return JSON.parse(readFileSync(path.join(dir, "fake-capture.json"), "utf8")) as FakeCapture;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}

function startHangingTurn(client: GeminiHeadlessClient, runId: string) {
  let announceReady!: () => void;
  const ready = new Promise<void>((resolve) => { announceReady = resolve; });
  const result = client.runTurn({
    instruction: "hang",
    runId,
    onDelta: (delta) => {
      if (delta === "fake-gemini-ready") announceReady();
    },
  });
  // Availability alone may take up to 10s. Wait for the actual child to install
  // its signal handler, rather than cancelling as soon as spawn registers it.
  let readinessTimer!: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    readinessTimer = setTimeout(() => reject(new Error("Fake Gemini did not announce readiness.")), 15_000);
  });
  const endedBeforeReady = result.then(() => { throw new Error("Fake Gemini exited before announcing readiness."); });
  return {
    result,
    ready: Promise.race([ready, deadline, endedBeforeReady]).finally(() => clearTimeout(readinessTimer)),
  };
}

describe("buildGeminiChildEnv", () => {
  it("strips api-key/vertex/base-url/cli-home env vars that could bypass Google-account auth", () => {
    const forbidden = [
      "GEMINI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENAI_USE_VERTEXAI",
      "GOOGLE_GEMINI_BASE_URL",
      "GEMINI_CLI_HOME",
      "GEMINI_MODEL",
      "GEMINI_SANDBOX",
      "CLOUD_SHELL",
      "GEMINI_CLI_USE_COMPUTE_ADC",
    ];
    const previous = new Map(forbidden.map((key) => [key, process.env[key]]));
    for (const key of forbidden) {
      process.env[key] = "should-not-leak";
    }
    try {
      const env = buildGeminiChildEnv();
      for (const key of forbidden) {
        expect(env[key], key).toBeUndefined();
      }
    } finally {
      for (const [key, value] of previous) {
        restoreEnv(key, value);
      }
    }
  });

  it("sets NO_BROWSER and GOOGLE_GENAI_USE_GCA and keeps PATH/HOME", () => {
    const env = buildGeminiChildEnv();

    expect(env.NO_BROWSER).toBe("true");
    expect(env.GOOGLE_GENAI_USE_GCA).toBe("true");
    expect(env.PATH ?? env.Path).toBeTruthy();
    if (process.env.HOME) {
      expect(env.HOME).toBe(process.env.HOME);
    }
  });

  it("passes through GOOGLE_CLOUD_PROJECT when present and omits it otherwise", () => {
    const previous = process.env.GOOGLE_CLOUD_PROJECT;
    try {
      process.env.GOOGLE_CLOUD_PROJECT = "my-workspace-project";
      expect(buildGeminiChildEnv().GOOGLE_CLOUD_PROJECT).toBe("my-workspace-project");
      delete process.env.GOOGLE_CLOUD_PROJECT;
      expect(buildGeminiChildEnv().GOOGLE_CLOUD_PROJECT).toBeUndefined();
    } finally {
      restoreEnv("GOOGLE_CLOUD_PROJECT", previous);
    }
  });

  it("does not leak arbitrary parent env vars", () => {
    const secretKey = "SECRET_FOR_GEMINI_HEADLESS_CLIENT_TEST";
    const previous = process.env[secretKey];
    process.env[secretKey] = "should-not-leak";
    try {
      expect(buildGeminiChildEnv()[secretKey]).toBeUndefined();
    } finally {
      restoreEnv(secretKey, previous);
    }
  });
});

describe("getDefaultGeminiBinCandidates", () => {
  it("includes the bare agy command and absolute install candidates", () => {
    const candidates = getDefaultGeminiBinCandidates();

    expect(candidates).toContain("agy");
    expect(candidates).not.toContain("gemini");
    expect(candidates.some((candidate) => /(^|[/\\])gemini(\.cmd|\.exe)?$/i.test(candidate))).toBe(false);
    expect(candidates.some((candidate) => path.isAbsolute(candidate))).toBe(true);
    expect(new Set(candidates).size).toBe(candidates.length);
  });
});

describe("GeminiHeadlessClient", () => {
  it("lists models advertised by the installed Antigravity CLI", async () => {
    const { client } = createClient();

    const catalog = await client.listModels();

    expect(catalog.models).toEqual([{
      id: "Gemini 3.5 Flash (High)",
      label: "Gemini 3.5 Flash (High)",
      isDefault: true,
    }]);
  });

  it("ignores a configured legacy gemini CLI binary path", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
    tempDirs.push(dir);
    const client = new GeminiHeadlessClient({
      workspaceDir: path.join(dir, "workspace"),
      geminiBin: path.join(dir, "gemini"),
      credsFilePath: path.join(dir, "oauth_creds.json"),
    });

    expect(client.getConfiguredGeminiBin()).toBeNull();
  });

  it("getStatus reports available and loggedIn when the binary works and the creds file exists", async () => {
    const { client } = createClient();

    const status = await client.getStatus();

    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.error).toBeNull();
  });

  it("getStatus reports unavailable when the agy binary is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
    tempDirs.push(dir);
    const client = new GeminiHeadlessClient({
      workspaceDir: path.join(dir, "workspace"),
      geminiBin: path.join(dir, "agy"),
      credsFilePath: path.join(dir, "oauth_creds.json"),
    });

    const status = await client.getStatus();

    expect(status.available).toBe(false);
    expect(status.loggedIn).toBe(false);
  });

  it("getStatus reports loggedIn:false when agy cannot list models", async () => {
    const { client } = createClient({ writeCreds: false, binSource: AUTH_ERROR_BIN });

    const status = await client.getStatus();

    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
  });

  it("caches an unavailable probe result within the TTL instead of reprobing on every getStatus call", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
    tempDirs.push(dir);
    const fakeGeminiBin = path.join(dir, "agy");
    const credsFilePath = path.join(dir, "oauth_creds.json");
    writeFileSync(credsFilePath, "{}", "utf8");
    const client = new GeminiHeadlessClient({
      workspaceDir: path.join(dir, "workspace"),
      geminiBin: fakeGeminiBin,
      credsFilePath,
      availabilityCacheMs: 60_000,
    });

    const unavailable = await client.getStatus();
    expect(unavailable.available).toBe(false);

    // The binary now exists, but the negative result should still be served
    // from cache within the TTL (Finding 7) instead of reprobing every call.
    writeFileSync(fakeGeminiBin, FAKE_GEMINI_BIN, "utf8");
    chmodSync(fakeGeminiBin, 0o755);

    const stillCached = await client.getStatus();
    expect(stillCached.available).toBe(false);
  });

  it("reprobes availability once the negative-cache TTL has elapsed", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
    tempDirs.push(dir);
    const fakeGeminiBin = path.join(dir, "agy");
    const credsFilePath = path.join(dir, "oauth_creds.json");
    writeFileSync(credsFilePath, "{}", "utf8");
    const client = new GeminiHeadlessClient({
      workspaceDir: path.join(dir, "workspace"),
      geminiBin: fakeGeminiBin,
      credsFilePath,
      availabilityCacheMs: 20,
    });

    const unavailable = await client.getStatus();
    expect(unavailable.available).toBe(false);

    writeFileSync(fakeGeminiBin, FAKE_GEMINI_BIN, "utf8");
    chmodSync(fakeGeminiBin, 0o755);
    await new Promise((resolve) => setTimeout(resolve, 30));

    const available = await client.getStatus();
    expect(available.available).toBe(true);
    expect(available.loggedIn).toBe(true);
  });

  it("spawns the availability probe only once for repeated getStatus calls within the TTL when the bin is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
    tempDirs.push(dir);
    const probeLogPath = path.join(dir, "probe-calls.log");
    const fakeGeminiBin = path.join(dir, "agy");
    const credsFilePath = path.join(dir, "oauth_creds.json");
    writeFileSync(credsFilePath, "{}", "utf8");
    writeFileSync(
      fakeGeminiBin,
      COUNTING_UNAVAILABLE_BIN.replace("__PROBE_LOG__", JSON.stringify(probeLogPath)),
      "utf8",
    );
    chmodSync(fakeGeminiBin, 0o755);
    const client = new GeminiHeadlessClient({
      workspaceDir: path.join(dir, "workspace"),
      geminiBin: fakeGeminiBin,
      credsFilePath,
      availabilityCacheMs: 60_000,
    });

    await client.getStatus();
    await client.getStatus();
    await client.getStatus();

    expect(readFileSync(probeLogPath, "utf8").trim().split("\n").filter(Boolean)).toHaveLength(1);
  });

  it("spawns agy with the instruction as the print value, flags, and the requested cwd", async () => {
    const { client, dir, workspaceDir } = createClient();

    await client.runTurn({ instruction: "hello", model: "Gemini 3.5 Flash (Low)" });
    const capture = readFakeCapture(dir);

    expect(capture.argv[0]).toBe("--print=hello");
    expect(capture.argv.slice(1, 5)).toEqual([
      "--print-timeout",
      "8m",
      "--model",
      "Gemini 3.5 Flash (Low)",
    ]);
    const logFileIndex = capture.argv.indexOf("--log-file");
    expect(logFileIndex).toBeGreaterThanOrEqual(0);
    expect(typeof capture.argv[logFileIndex + 1]).toBe("string");
    expect(capture.argv[logFileIndex + 1].length).toBeGreaterThan(0);
    expect(capture.argv).not.toContain("--dangerously-skip-permissions");
    expect(realpathSync(capture.cwd)).toBe(realpathSync(workspaceDir));
  });

  it("passes the instruction through verbatim on posix, with no shell escaping applied", async () => {
    // macOS / Linux は `shell: false` 固定なので、Windows 用のクォートやキャレットが 1 文字でも
    // 混ざったら値が壊れる。「エスケープが posix 経路へ漏れていない」ことの直接の確認。
    const { client, dir } = createClient();
    const instruction = 'say "hi" & echo %PATH% | cat ^ (x) !';

    await client.runTurn({ instruction, model: "Gemini 3.5 Flash (Low)" });

    expect(readFakeCapture(dir).argv[0]).toBe(`--print=${instruction}`);
  });

  it("keeps a multi-line instruction intact on posix", async () => {
    // Windows の `.cmd` 経路では改行が表現できず理由付きで失敗するが、posix では従来どおり通る。
    const { client, dir } = createClient();
    const instruction = "line1\nline2\nline3";

    await client.runTurn({ instruction, model: "Gemini 3.5 Flash (Low)" });

    expect(readFakeCapture(dir).argv[0]).toBe(`--print=${instruction}`);
  });

  it("spawns with a per-run workspaceDir override instead of the constructor workspaceDir when provided, and creates the directory", async () => {
    const { client, dir, workspaceDir } = createClient();
    const perRunWorkspaceDir = path.join(dir, "custom-ws");

    await client.runTurn({ instruction: "hello", workspaceDir: perRunWorkspaceDir });

    // FAKE_GEMINI_BIN writes fake-capture.json to `<spawn cwd>/../fake-capture.json`, and both
    // workspaceDir and perRunWorkspaceDir share `dir` as their parent, so this still resolves.
    const capture = readFakeCapture(dir);
    expect(realpathSync(capture.cwd)).toBe(realpathSync(perRunWorkspaceDir));
    expect(realpathSync(perRunWorkspaceDir)).not.toBe(realpathSync(workspaceDir));
  });

  it("passes the complete instruction as the print value without using stdin", async () => {
    const { client, dir } = createClient();
    const dangerousInstruction = 'line one\nline two "quoted" \'quoted\' & echo injected | rm -rf / < in > out';

    await client.runTurn({ instruction: dangerousInstruction, model: "Gemini 3.5 Flash (Low)" });
    const capture = readFakeCapture(dir);

    expect(capture.stdin).toBe("");
    expect(capture.prompt).toBe(dangerousInstruction);
    expect(capture.argv[0]).toBe(`--print=${dangerousInstruction}`);
    expect(capture.argv[0]).not.toMatch(/^--print=@/);
  });

  it("uses the default model when the turn does not specify one", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "hello" });
    const capture = readFakeCapture(dir);

    const modelIndex = capture.argv.indexOf("--model");
    expect(capture.argv[modelIndex + 1]).toBe("Gemini 3.5 Flash (High)");
  });

  it("appends --conversation only when a resume session id is given", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "turn one" });
    expect(readFakeCapture(dir).argv).not.toContain("--conversation");

    await client.runTurn({ instruction: "turn two", resumeSessionId: "gsess_known" });
    const argv = readFakeCapture(dir).argv;
    const resumeIndex = argv.indexOf("--conversation");
    expect(resumeIndex).toBeGreaterThanOrEqual(0);
    expect(argv[resumeIndex + 1]).toBe("gsess_known");
  });

  it("spawns with the filtered child env (no GEMINI_API_KEY leak, NO_BROWSER set)", async () => {
    const previousApiKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = "sk-should-not-leak";
    const { client, dir } = createClient();
    try {
      await client.runTurn({ instruction: "capture env" });
      const capture = readFakeCapture(dir);

      expect(capture.env.GEMINI_API_KEY).toBeUndefined();
      expect(capture.env.NO_BROWSER).toBe("true");
      expect(capture.env.GOOGLE_GENAI_USE_GCA).toBe("true");
    } finally {
      restoreEnv("GEMINI_API_KEY", previousApiKey);
    }
  });

  it("captures the session id from init and accumulates assistant delta chunks into finalText", async () => {
    const { client } = createClient();
    const deltas: string[] = [];

    const result = await client.runTurn({ instruction: "hello world", onDelta: (d) => deltas.push(d) });

    expect(result.sessionId).toMatch(/^gsess_/);
    expect(result.finalText).toBe("ECHO:hello world");
    expect(result.isError).toBe(false);
    expect(deltas.join("")).toBe("ECHO:hello world");
    expect(deltas.length).toBeGreaterThan(1);
  });

  it("reports tool_use events to onToolUse with name/id/parameters", async () => {
    const { client } = createClient();
    const tools: Array<{ name?: string; id?: string; parameters?: unknown }> = [];

    await client.runTurn({ instruction: "please TOOL now", onToolUse: (tool) => tools.push(tool) });

    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("mcp_sigma-studio-local_insert_graph");
    expect(tools[0].id).toBe("req-1");
    expect(tools[0].parameters).toEqual({ targetId: "b1" });
  });

  it("counts AGENT_EXECUTION_BLOCKED warning events as blocked tools without failing the turn", async () => {
    const { client } = createClient();

    const result = await client.runTurn({ instruction: "trigger BLOCKED tool" });

    expect(result.isError).toBe(false);
    expect(result.blockedToolCount).toBe(1);
  });

  it("skips non-JSON stdout lines and unknown event types, and ignores stderr noise", async () => {
    const { client } = createClient();

    const result = await client.runTurn({ instruction: "noise tolerant" });

    expect(result.isError).toBe(false);
    expect(result.finalText).toBe("ECHO:noise tolerant");
  });

  it("recovers the conversation id from --log-file when the CLI streams no JSON events at all (F2/F3: real print-mode stdout is plain text only)", async () => {
    const { client } = createClient({ binSource: PLAIN_TEXT_NO_JSON_BIN });

    const result = await client.runTurn({ instruction: "hello" });

    expect(result.isError).toBe(false);
    expect(result.finalText).toContain("プレーンテキストの応答です。");
    expect(result.sessionId).toBe("conv-plain-12345678");
  });

  it("reports a headless MCP permission denial from stderr as an error even when agy exits successfully", async () => {
    const { client } = createClient({ binSource: HEADLESS_PERMISSION_DENIED_BIN });

    const result = await client.runTurn({ instruction: "edit with MCP" });

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("MCPツール実行が権限設定で拒否");
    expect(result.finalText).toBe("");
  });

  it("reports a headless preview read denial separately from an MCP permission denial", async () => {
    const { client } = createClient({ binSource: HEADLESS_READ_PERMISSION_DENIED_BIN });

    const result = await client.runTurn({ instruction: "inspect preview" });

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("AI実行コンテキストを読む権限");
    expect(result.errorMessage).not.toContain("MCPツール実行");
    expect(result.finalText).toBe("");
  });

  it("maps exit code 41 to a login error and flips getStatus loggedIn to false despite the creds file", async () => {
    const { client } = createClient({ binSource: AUTH_ERROR_BIN });

    const result = await client.runTurn({ instruction: "hi" });
    const status = await client.getStatus();

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("ログイン");
    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.error).toContain("ログイン");
  });

  it("clears the auth-error flag after a successful turn", async () => {
    const fixture = createClient({ binSource: AUTH_ERROR_BIN });

    await fixture.client.runTurn({ instruction: "hi" });
    expect((await fixture.client.getStatus()).loggedIn).toBe(false);

    writeFileSync(fixture.fakeGeminiBin, FAKE_GEMINI_BIN, "utf8");
    await fixture.client.runTurn({ instruction: "hi again" });

    expect((await fixture.client.getStatus()).loggedIn).toBe(true);
  });

  it("clears the auth-error flag once the user re-logs in via terminal (creds file mtime advances), without requiring a new turn", async () => {
    // Regression for Finding 2: exit-41 authError could previously only clear via a
    // completed turn, but the UI gates turns on loggedIn -> permanent logged-out
    // deadlock until app restart. getStatus() must self-heal once it observes that
    // the creds file was (re)written after the authError was recorded.
    const fixture = createClient({ writeCreds: false, binSource: AUTH_ERROR_BIN });

    await fixture.client.runTurn({ instruction: "hi" });
    const loggedOut = await fixture.client.getStatus();
    expect(loggedOut.loggedIn).toBe(false);
    expect(loggedOut.error).toContain("ログイン");

    // Simulate the user running `agy` in a terminal and logging in with Google.
    await new Promise((resolve) => setTimeout(resolve, 5));
    mkdirSync(path.dirname(fixture.credsFilePath), { recursive: true });
    writeFileSync(fixture.credsFilePath, JSON.stringify({ access_token: "reloggedin" }), "utf8");
    writeFileSync(fixture.fakeGeminiBin, FAKE_GEMINI_BIN, "utf8");

    const status = await fixture.client.getStatus();
    expect(status.loggedIn).toBe(true);
    expect(status.error).toBeNull();
  });

  it("surfaces a result error event as isError with the error message", async () => {
    const { client } = createClient({ binSource: RESULT_ERROR_BIN });

    const result = await client.runTurn({ instruction: "hi" });

    expect(result.isError).toBe(true);
    expect(result.errorMessage).toContain("Quota exceeded");
  });

  it("rejects with GeminiResumeUnavailableError when a resumed turn exits with the input-error code", async () => {
    const { client } = createClient();

    await expect(
      client.runTurn({ instruction: "resume me", resumeSessionId: "gsess_unknown" }),
    ).rejects.toBeInstanceOf(GeminiResumeUnavailableError);
  });

  it("rejects a non-resumed turn that exits without a result event", async () => {
    const { client } = createClient({ binSource: EXIT_BIN });

    await expect(client.runTurn({ instruction: "hi" })).rejects.toThrow();
  });

  it("kills the process and rejects when the turn times out", async () => {
    const { client } = createClient({ binSource: HANG_BIN, turnTimeoutMs: 300 });

    await expect(client.runTurn({ instruction: "hang" })).rejects.toThrow("タイムアウト");
  });

  it("cancels an in-flight turn via cancelRun and resolves with cancelled: true", async () => {
    const { client } = createClient({ binSource: HANG_BIN });
    const runId = "run_gemini_cancel_1";
    const turn = startHangingTurn(client, runId);
    try {
      await turn.ready;
      expect(client.cancelRun(runId)).toBe(true);
      const result = await turn.result;
      expect(result.cancelled).toBe(true);
      expect(result.isError).toBe(false);
    } finally {
      client.cancelRun(runId);
      await turn.result.catch(() => undefined);
    }
  }, 20000);

  it("cancelRun returns false for an unknown runId", async () => {
    const { client } = createClient();

    expect(client.cancelRun("no-such-run")).toBe(false);
  });

  it("escalates to SIGKILL when the process ignores SIGTERM past the cancel grace period", async () => {
    const { client, workspaceDir } = createClient({ binSource: HANG_IGNORE_SIGTERM_BIN, cancelGraceMs: 500 });
    const spawn = cliSpawn.spawnCliProcess;
    let turnProcess: ReturnType<typeof spawn> | undefined;
    vi.spyOn(cliSpawn, "spawnCliProcess").mockImplementation((...args) => {
      const child = spawn(...args);
      if (args[1].some((argument) => argument.startsWith("--print="))) turnProcess = child;
      return child;
    });
    const runId = "run_gemini_cancel_2";
    const turn = startHangingTurn(client, runId);
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await turn.ready;
      expect(client.cancelRun(runId)).toBe(true);
      const deadline = new Promise<never>((_, reject) => {
        cancellationTimer = setTimeout(() => reject(new Error("Gemini cancellation did not escalate.")), 3000);
      });
      const result = await Promise.race([turn.result, deadline]);
      expect(result.cancelled).toBe(true);
      expect(readFileSync(path.join(workspaceDir, "fake-sigterm-seen"), "utf8")).toBe("SIGTERM");
      expect(turnProcess?.signalCode).toBe("SIGKILL");
    } finally {
      clearTimeout(cancellationTimer);
      client.cancelRun(runId);
      turnProcess?.kill("SIGKILL");
      await turn.result.catch(() => undefined);
    }
  }, 20000);
});

// 実機の gemini headless を模す: stream-json イベントを stdout に流し、
// アシスタント本文は delta:true の message チャンクのみで届く (result にテキストは無い)。
const FAKE_GEMINI_BIN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("0.49.0");
  process.exit(0);
}

const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const printArg = argv.find((arg) => arg.startsWith("--print="));
const printValue = printArg ? printArg.slice("--print=".length) : "";
const prompt = printValue.startsWith("@") ? fs.readFileSync(printValue.slice(1), "utf8") : (printValue || stdin);
fs.writeFileSync(path.join(process.cwd(), "..", "fake-capture.json"), JSON.stringify({
  argv,
  env: process.env,
  cwd: process.cwd(),
  stdin,
  prompt,
}, null, 2));

function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }

if (argv.includes("models")) {
  console.log("Gemini 3.5 Flash (High)");
  process.exit(0);
}

const resumeIndex = argv.indexOf("--conversation");
if (resumeIndex >= 0 && argv[resumeIndex + 1] === "gsess_unknown") {
  process.stderr.write("Error: session not found\\n");
  process.exit(42);
}
const sessionId = resumeIndex >= 0 ? argv[resumeIndex + 1] : "gsess_" + process.pid;

send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: sessionId, model: "Gemini 3.5 Flash (High)" });
send({ type: "message", timestamp: "2026-07-02T00:00:00.000Z", role: "user", content: prompt });
process.stdout.write("this line is not json\\n");
send({ type: "some_future_event", value: 1 });
process.stderr.write("[WARNING] user hook noise\\n");
if (prompt.includes("TOOL")) {
  send({ type: "tool_use", timestamp: "2026-07-02T00:00:00.000Z", tool_name: "mcp_sigma-studio-local_insert_graph", tool_id: "req-1", parameters: { targetId: "b1" } });
  send({ type: "tool_result", timestamp: "2026-07-02T00:00:00.000Z", tool_id: "req-1", status: "success", output: "ok" });
}
if (prompt.includes("BLOCKED")) {
  send({ type: "error", timestamp: "2026-07-02T00:00:00.000Z", severity: "warning", message: "Tool execution blocked: AGENT_EXECUTION_BLOCKED" });
}
send({ type: "message", timestamp: "2026-07-02T00:00:00.000Z", role: "assistant", content: "ECHO:", delta: true });
send({ type: "message", timestamp: "2026-07-02T00:00:00.000Z", role: "assistant", content: prompt, delta: true });
send({ type: "result", timestamp: "2026-07-02T00:00:00.000Z", status: "success", stats: {} });
process.exit(0);
`;

// F2 (実機確認): printモードのstdoutは最終応答のプレーンテキストのみで、コードが期待するJSON
// イベント (init/message/tool_use/result) は一切流れない。F3: 会話IDは --log-file に書かれる
// `printmode.go:179] Print mode: conversation=<uuid>, sending message` の行から回収する。
const PLAIN_TEXT_NO_JSON_BIN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("0.49.0");
  process.exit(0);
}

const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const printArg = argv.find((arg) => arg.startsWith("--print="));
const printValue = printArg ? printArg.slice("--print=".length) : "";
const prompt = printValue.startsWith("@") ? fs.readFileSync(printValue.slice(1), "utf8") : (printValue || stdin);
fs.writeFileSync(path.join(process.cwd(), "..", "fake-capture.json"), JSON.stringify({
  argv,
  env: process.env,
  cwd: process.cwd(),
  stdin,
  prompt,
}, null, 2));

const logFileIndex = argv.indexOf("--log-file");
const logFilePath = argv[logFileIndex + 1];
fs.writeFileSync(
  logFilePath,
  "I0706 12:00:00.000000 1 printmode.go:179] Print mode: conversation=conv-plain-12345678, sending message\\n",
);

process.stdout.write("プレーンテキストの応答です。\\n");
process.exit(0);
`;

const HEADLESS_PERMISSION_DENIED_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("1.1.5");
  process.exit(0);
}
if (process.argv.includes("models")) {
  console.log("gemini-3.5-flash-low");
  process.exit(0);
}
process.stderr.write('jetski: no output produced — a tool required the "mcp" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
process.exit(0);
`;

const HEADLESS_READ_PERMISSION_DENIED_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) {
  console.log("1.1.5");
  process.exit(0);
}
if (process.argv.includes("models")) {
  console.log("gemini-3.5-flash-low");
  process.exit(0);
}
process.stderr.write('jetski: no output produced — a tool required the "read_file" permission that headless mode cannot prompt for, so it was auto-denied.\\n');
process.exit(0);
`;

// 未ログインの実機挙動 (live probe): stdout に JSON を出さず、stderr にヒント、exit 41。
const AUTH_ERROR_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.49.0"); process.exit(0); }
process.stderr.write("Please run agy to authenticate\\n");
process.exit(41);
`;

// result イベント自体が status:"error" を運ぶケース (モデルエラー等)。
const RESULT_ERROR_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.49.0"); process.exit(0); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: "gsess_err", model: "Gemini 3.5 Flash (High)" });
send({ type: "result", timestamp: "2026-07-02T00:00:00.000Z", status: "error", error: { type: "QuotaError", message: "Quota exceeded for model" }, stats: {} });
process.exit(1);
`;

// result を返さずに落ちるケース。
const EXIT_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.49.0"); process.exit(0); }
process.stderr.write("boom\\n");
setTimeout(() => process.exit(1), 50);
`;

// 応答しないままハングするケース (timeout kill の検証用)。
const HANG_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.49.0"); process.exit(0); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: "gsess_hang", model: "Gemini 3.5 Flash (High)" });
send({ type: "message", role: "assistant", delta: true, content: "fake-gemini-ready" });
setInterval(() => {}, 1000);
`;

// HANG_BIN と同じだが SIGTERM を無視する: cancelRun() の SIGKILL エスカレーションのテスト用。
const HANG_IGNORE_SIGTERM_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("0.49.0"); process.exit(0); }
const fs = require("node:fs");
const path = require("node:path");
process.on("SIGTERM", () => fs.writeFileSync(path.join(process.cwd(), "fake-sigterm-seen"), "SIGTERM"));
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: "gsess_hang2", model: "Gemini 3.5 Flash (High)" });
send({ type: "message", role: "assistant", delta: true, content: "fake-gemini-ready" });
setInterval(() => {}, 1000);
`;

// --version 呼び出しのたびに1行ログして常に失敗するバイナリ (Finding 7: 否定キャッシュがTTL内に
// プローブ回数を1回に抑えることを検証するため)。
const COUNTING_UNAVAILABLE_BIN = `#!/usr/bin/env node
const fs = require("node:fs");
if (process.argv.includes("--version")) {
  fs.appendFileSync(__PROBE_LOG__, "probe\\n");
  process.exit(1);
}
process.exit(1);
`;
