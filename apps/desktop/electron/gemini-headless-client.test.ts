import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalAiEditChatRoomStore } from "./ai-edit-chat-room-store";
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
  modelListFails?: boolean;
  defaultModel?: string;
  turnTimeoutMs?: number;
  cancelGraceMs?: number;
} = {}): ClientFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-headless-"));
  tempDirs.push(dir);
  const fakeGeminiBin = path.join(dir, "agy");
  const workspaceDir = path.join(dir, "workspace");
  const credsFilePath = path.join(dir, "gemini-home", "oauth_creds.json");
  mkdirSync(workspaceDir, { recursive: true });
  const source = options.binSource ?? FAKE_GEMINI_BIN;
  const modelAwareSource = options.modelListFails || source.includes('includes("models")') ? source : source.replace(
    /^(#![^\n]*\n)/,
    '$1if (process.argv.includes("models")) { console.log("Gemini 3.5 Flash (High)"); process.exit(0); }\n',
  );
  writeFileSync(fakeGeminiBin, modelAwareSource, "utf8");
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
      defaultModel: options.defaultModel ?? "Gemini 3.5 Flash (High)",
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

function startHangingTurn(client: GeminiHeadlessClient, runId: string, resumeSessionId?: string) {
  let announceReady!: () => void;
  const ready = new Promise<void>((resolve) => { announceReady = resolve; });
  const result = client.runTurn({
    instruction: "hang",
    runId,
    resumeSessionId,
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
    }]);
  });

  it("parses current tab-separated models and migrates a retired Flash selection", async () => {
    const { client, dir } = createClient({
      binSource: FAKE_GEMINI_BIN.replace(
        'console.log("Gemini 3.5 Flash (High)");',
        'console.log("Fetching available models...\\ngemini-3.8-flash-high\\tGemini 3.8 Flash (High)\\ngemini-3.8-flash-low\\tGemini 3.8 Flash (Low)");',
      ),
    });
    expect((await client.listModels()).models.map((model) => model.id)).toEqual([
      "gemini-3.8-flash-high", "gemini-3.8-flash-low",
    ]);
    await client.runTurn({ instruction: "hello", model: "Gemini 3.5 Flash (Low)" });
    const { argv } = readFakeCapture(dir);
    expect(argv[argv.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
  });

  it("resolves automatic and retired selections again after the CLI catalog changes", async () => {
    const { client, dir, fakeGeminiBin } = createClient({ defaultModel: "auto" });
    const advertise = (model: string) => writeFileSync(fakeGeminiBin, FAKE_GEMINI_BIN.replace(
      'console.log("Gemini 3.5 Flash (High)");', `console.log(${JSON.stringify(model)});`,
    ));
    advertise("Future Model A");
    await client.runTurn({ instruction: "hello" });
    let argv = readFakeCapture(dir).argv;
    expect(argv).not.toContain("--model");
    advertise("Future Model B");
    await client.runTurn({ instruction: "hello again", model: "Future Model A" });
    argv = readFakeCapture(dir).argv;
    expect(argv).not.toContain("--model");
  });

  it("omits --model when automatic selection has no catalog", async () => {
    const { client, dir } = createClient({ defaultModel: "auto" });
    vi.spyOn(client, "listModels").mockRejectedValue(new Error("offline"));
    await client.runTurn({ instruction: "hello" });
    expect(readFakeCapture(dir).argv).not.toContain("--model");
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

  it("rejects an IDE launcher that prints a version but lacks the headless flags", async () => {
    const { client } = createClient({ binSource: '#!/bin/sh\necho "Antigravity IDE 2.6.0"\n' });
    expect((await client.getStatus()).available).toBe(false);
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
    const { client } = createClient({ writeCreds: false, modelListFails: true, binSource: AUTH_ERROR_BIN });

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

  it("sends a single NDJSON user frame, disables slash expansion and runs in the editor workspace", async () => {
    const { client, dir, workspaceDir } = createClient();
    const instruction = '/model "文章"\n' + '日本語 & %PATH% | '.repeat(12000);
    await client.runTurn({ instruction });
    const capture = readFakeCapture(dir);
    expect(capture.argv).toEqual([
      "--input-format", "stream-json", "--output-format", "stream-json", "--disable-slash-commands",
      "--print-timeout", "480s", "--model", "Gemini 3.5 Flash (High)", "--settings", expect.any(String),
    ]);
    expect(capture.stdin.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(capture.stdin)).toEqual({ event: "user", message: { content: instruction } });
    expect(realpathSync(capture.cwd)).toBe(realpathSync(workspaceDir));
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

  it("streams the reply as it arrives for ordinary editor turns", async () => {
    const { client, dir } = createClient({ binSource: AGY_STREAM_JSON_BIN });
    const deltas: string[] = [];

    const streamed = await client.runTurn({ instruction: "draw", onDelta: (d) => deltas.push(d) });

    // The CLI ends the answer with a newline-only delta and reports the whole text in `result`.
    expect(deltas).toEqual(["前置き。", "<svg/>", "\n"]);
    expect(streamed).toMatchObject({ finalText: "前置き。<svg/>\n", isError: false, sessionId: "conv-1" });
    const argv = readFakeCapture(dir).argv;
    expect(argv.slice(argv.indexOf("--output-format"), argv.indexOf("--output-format") + 2)).toEqual(["--output-format", "stream-json"]);

  });

  it("pairs native tool activity by step index even for DONE-only steps", async () => {
    const toolStep = (state: string, index: number) => `send(${JSON.stringify({ event: "step_update",
      step_update: { step_type: "tool", step_index: index, tool_name: "read_file", state },
    })});`;
    const source = AGY_STREAM_JSON_BIN.replace('if (printArg.includes("FAIL"))',
      [toolStep("ACTIVE", 4), toolStep("ACTIVE", 4), toolStep("DONE", 4), toolStep("DONE", 5), 'if (printArg.includes("FAIL"))'].join("\n"));
    const { client } = createClient({ binSource: source });
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    await client.runTurn({ instruction: "hello", onToolUse, onToolResult });
    expect(onToolUse.mock.calls.map(([tool]) => tool.id)).toEqual(["agy-step-4", "agy-step-5"]);
    expect(onToolResult.mock.calls.map(([tool]) => tool.toolUseId)).toEqual(["agy-step-4", "agy-step-5"]);
  });

  it("reports a subagent launch as one activity carrying the subagents' roles", async () => {
    // agy 1.5.18 の実機の形: サブエージェントの起動は step_type:"subagent" (tool ではない) で届き、
    // 同じ step_index が ACTIVE → DONE と進む。
    const subagentStep = (state: string) => `send(${JSON.stringify({ event: "step_update", step_update: {
      step_type: "subagent", step_index: 2, state, tool_name: "invoke_subagent",
      subagent_info: { subagents: [
        { type_name: "research", role: "類題の調査", initial_prompt: "..." },
        { type_name: "self", initial_prompt: "..." },
      ] },
    } })});`;
    const source = AGY_STREAM_JSON_BIN.replace('if (printArg.includes("FAIL"))',
      [subagentStep("ACTIVE"), subagentStep("DONE"), 'if (printArg.includes("FAIL"))'].join("\n"));
    const { client } = createClient({ binSource: source });
    const onToolUse = vi.fn();
    const onToolResult = vi.fn();
    await client.runTurn({ instruction: "hello", onToolUse, onToolResult });

    expect(onToolUse.mock.calls).toEqual([[{
      id: "agy-step-2",
      name: "invoke_subagent",
      parameters: { description: "類題の調査, self" },
    }]]);
    // DONE は起動し終えただけ (作業は続く) なので、行を完了にしない。
    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("reports an agy stream-json failure as an error result with its message", async () => {
    const { client } = createClient({ binSource: AGY_STREAM_JSON_BIN });
    const result = await client.runTurn({ instruction: "FAIL please" });
    expect(result).toMatchObject({ isError: true, errorMessage: "quota exceeded" });
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

  it("rejects an incomplete stream even when agy exits zero", async () => {
    const source = AGY_STREAM_JSON_BIN.split('send({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS"')[0];
    const { client } = createClient({ binSource: source });
    await expect(client.runTurn({ instruction: "draw" })).rejects.toThrow(/result/);
  });

  it("retains the conversation ID from an active step when the first turn is cancelled", async () => {
    const source = HANG_BIN.slice(0, HANG_BIN.indexOf('send({ type: "init"')) + `
send({ event: "step_update", step_update: { conversation_id: "running-conversation", step_type: "agent_response", text_delta: "fake-gemini-ready" } });
setInterval(() => {}, 1000);`;
    const { client } = createClient({ binSource: source });
    const turn = startHangingTurn(client, "cancel-first-turn");
    try {
      await turn.ready;
      expect(client.cancelRun("cancel-first-turn")).toBe(true);
      expect(await turn.result).toMatchObject({ cancelled: true, sessionId: "running-conversation" });
    } finally {
      client.cancelRun("cancel-first-turn");
    }
  });

  it("keeps the known conversation across cancel, room save and reopen before the CLI announces an ID", async () => {
    const source = HANG_BIN.split("\n").filter((line) => !line.startsWith('send({ type: "init"')).join("\n");
    const { client, dir } = createClient({ binSource: source });
    const turn = startHangingTurn(client, "cancel-continuation", "previous-turn-id");
    try {
      await turn.ready;
      client.cancelRun("cancel-continuation");
      const result = await turn.result;
      expect(result).toMatchObject({ cancelled: true, sessionId: "previous-turn-id" });
      const now = new Date().toISOString();
      const store = new LocalAiEditChatRoomStore(dir);
      await store.saveRoom({ version: 1, id: "room", documentIdentityKey: "file", title: "test", provider: "antigravity",
        agentThreadId: result.sessionId, createdAt: now, updatedAt: now, turns: [] });
      expect(await new LocalAiEditChatRoomStore(dir).listRooms("file")).toMatchObject([{ agentThreadId: "previous-turn-id" }]);
    } finally {
      client.cancelRun("cancel-continuation");
    }
  });

  it("reads the CLI settings from the OS profile even when the shell home differs", async () => {
    const { dir, fakeGeminiBin, workspaceDir } = createClient();
    vi.spyOn(os, "homedir").mockReturnValue(dir);
    const profile = path.join(dir, ".gemini", "antigravity-cli");
    mkdirSync(profile, { recursive: true });
    writeFileSync(path.join(profile, "settings.json"), "{invalid");
    const client = new GeminiHeadlessClient({ geminiBin: fakeGeminiBin, workspaceDir });
    await expect(client.runTurn({ instruction: "hello" })).rejects.toBeInstanceOf(SyntaxError);
  });

  it("uses the authoritative result ID and delivers a final-only response", async () => {
    const source = AGY_STREAM_JSON_BIN.replace('if (printArg.includes("FAIL"))', 'if (true)')
      .replace('status: "ERROR", error: "quota exceeded"', 'status: "SUCCESS", response: "ready"')
      .replace('result: { conversation_id: "conv-1"', 'result: { conversation_id: "final-id"')
      .replace('process.exit(1);','process.exit(0);');
    const { client } = createClient({ binSource: source });
    const onDelta = vi.fn();
    expect(await client.runTurn({ instruction: "hello", onDelta })).toMatchObject({ sessionId: "final-id", finalText: "ready", isError: false });
    expect(onDelta).toHaveBeenCalledExactlyOnceWith("ready");
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
    const fixture = createClient({ writeCreds: false, modelListFails: true, binSource: AUTH_ERROR_BIN });

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
      if (args[1].includes("--input-format")) turnProcess = child;
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

if (process.argv.includes("--help")) {
  console.log("--input-format --output-format --settings");
  process.exit(0);
}

const argv = process.argv.slice(2);
const stdin = fs.readFileSync(0, "utf8");
const prompt = stdin ? JSON.parse(stdin).message.content : "";
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
send({ type: "message", timestamp: "2026-07-02T00:00:00.000Z", role: "user", content: prompt.slice(0, 256) });
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
send({ type: "message", timestamp: "2026-07-02T00:00:00.000Z", role: "assistant", content: prompt.slice(0, 256), delta: true });
send({ type: "result", timestamp: "2026-07-02T00:00:00.000Z", status: "success", stats: {} });
process.exit(0);
`;

// `agy --print --output-format stream-json` (実機確認): `{event: ...}` 形式の行が流れる。
// 返答の断片は step_update.text_delta、終わりは result.response。
const AGY_STREAM_JSON_BIN = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
const argv = process.argv.slice(2);
fs.writeFileSync(path.join(process.cwd(), "..", "fake-capture.json"), JSON.stringify({ argv, env: process.env, cwd: process.cwd() }));
if (argv.includes("models")) { console.log("Gemini 3.5 Flash (High)"); process.exit(0); }
const send = (message) => process.stdout.write(JSON.stringify(message) + "\\n");
const printArg = JSON.parse(fs.readFileSync(0, "utf8")).message.content;
send({ event: "init", conversation_id: "conv-1", init: { cwd: process.cwd(), tools: [] } });
send({ event: "step_update", step_update: { conversation_id: "conv-1", step_index: 0, state: "DONE", step_type: "user_input" } });
if (printArg.includes("FAIL")) {
  send({ event: "result", result: { conversation_id: "conv-1", status: "ERROR", error: "quota exceeded" } });
  process.exit(1);
}
send({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "前置き。" } });
send({ event: "step_update", step_update: { step_index: 1, state: "ACTIVE", step_type: "agent_response", text_delta: "<svg/>" } });
send({ event: "step_update", step_update: { step_index: 1, state: "DONE", step_type: "agent_response", text_delta: "\\n" } });
send({ event: "result", result: { conversation_id: "conv-1", status: "SUCCESS", response: "前置き。<svg/>\\n" } });
process.exit(0);
`;

const HEADLESS_PERMISSION_DENIED_BIN = `#!/usr/bin/env node
if (process.argv.includes("--help")) {
  console.log("--input-format --output-format --settings");
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
if (process.argv.includes("--help")) {
  console.log("--input-format --output-format --settings");
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
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
process.stderr.write("Please run agy to authenticate\\n");
process.exit(41);
`;

// result イベント自体が status:"error" を運ぶケース (モデルエラー等)。
const RESULT_ERROR_BIN = `#!/usr/bin/env node
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: "gsess_err", model: "Gemini 3.5 Flash (High)" });
send({ type: "result", timestamp: "2026-07-02T00:00:00.000Z", status: "error", error: { type: "QuotaError", message: "Quota exceeded for model" }, stats: {} });
process.exit(1);
`;

// result を返さずに落ちるケース。
const EXIT_BIN = `#!/usr/bin/env node
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
process.stderr.write("boom\\n");
setTimeout(() => process.exit(1), 50);
`;

// 応答しないままハングするケース (timeout kill の検証用)。
const HANG_BIN = `#!/usr/bin/env node
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
send({ type: "init", timestamp: "2026-07-02T00:00:00.000Z", session_id: "gsess_hang", model: "Gemini 3.5 Flash (High)" });
send({ type: "message", role: "assistant", delta: true, content: "fake-gemini-ready" });
setInterval(() => {}, 1000);
`;

// HANG_BIN と同じだが SIGTERM を無視する: cancelRun() の SIGKILL エスカレーションのテスト用。
const HANG_IGNORE_SIGTERM_BIN = `#!/usr/bin/env node
if (process.argv.includes("--help")) { console.log("--input-format --output-format --settings"); process.exit(0); }
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
if (process.argv.includes("--help")) {
  fs.appendFileSync(__PROBE_LOG__, "probe\\n");
  process.exit(1);
}
process.exit(1);
`;
