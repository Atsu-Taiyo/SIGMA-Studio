import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { MCP_TOOL_CATEGORIES, toolNamesForCategories } from "@/lib/ai/mcp-tool-categories";
import { appMcpToolNames } from "@/lib/ai/mcp-tool-profile";
import { ClaudeStreamClient, parseClaudeModelAliasesFromHelp } from "./claude-stream-client";

const tempDirs: string[] = [];

interface ClientFixture {
  client: ClaudeStreamClient;
  dir: string;
  claudeConfigDir: string;
  fakeClaudeBin: string;
}

interface FakeCapture {
  argv: string[];
  env: Record<string, string | undefined>;
  pid: number;
  cwd: string;
}

const MCP_CONFIG = {
  mcpServers: {
    "sigma-studio-local": { command: "node", args: ["/tmp/sigma-doc-mcp-server.cjs"] },
  },
};

const ALL_STAGED_ALLOWED_TOOLS = [
  ...appMcpToolNames(toolNamesForCategories(MCP_TOOL_CATEGORIES)).map((name) => `mcp__sigma-studio-local__${name}`),
  "Skill",
  "Read",
].join(" ");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ClaudeStreamClient", () => {
  it("reports available and logged in optimistically without spawning a turn", async () => {
    const { client } = createClient();

    const status = await client.getStatus();
    client.dispose();

    expect(status.available).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.error).toBeNull();
  });

  it("reads latest model aliases advertised by the installed Claude CLI", async () => {
    const { client } = createClient();

    const catalog = await client.listModels();
    client.dispose();

    expect(catalog.models.map((model) => model.id)).toEqual(["fable", "opus", "sonnet"]);
    expect(catalog.models.find((model) => model.id === "sonnet")?.isDefault).toBe(true);
    expect(catalog.models.find((model) => model.id === "sonnet")?.label).toBe("Claude Sonnet 5");
  });

  it("parses wrapped --model help without treating the full model example as an alias", () => {
    expect(parseClaudeModelAliasesFromHelp([
      "--model <model> Model for the current session. Provide an alias for the latest model",
      "  (e.g. 'fable', 'opus', or 'sonnet') or a model's full name",
      "  (e.g. 'claude-fable-5').",
    ].join("\n"))).toEqual(["fable", "opus", "sonnet"]);
  });

  it("reports unavailable when the claude binary is missing", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: path.join(dir, "claude"),
    });

    const status = await client.getStatus();
    client.dispose();

    expect(status.available).toBe(false);
    expect(status.loggedIn).toBe(false);
  });

  it("runs a turn, accumulates assistant text, and terminates on the result event", async () => {
    const { client } = createClient();

    const result = await client.runTurn({ instruction: "hello world" });
    client.dispose();

    expect(result.finalText).toBe("ECHO:hello world");
    expect(result.isError).toBe(false);
    expect(result.permissionDenials).toEqual([]);
    expect(result.sessionId).toMatch(/^sess_/);
  });

  it("treats the turn timeout as an idle timeout and keeps an active long turn alive", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    writeFileSync(fakeClaudeBin, PROGRESS_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      turnIdleTimeoutMs: 500,
      turnMaxTimeoutMs: 2000,
    });

    const result = await client.runTurn({ instruction: "long active turn" });
    client.dispose();

    expect(result.finalText).toBe("ACTIVE_DONE");
    expect(result.isError).toBe(false);
  });

  it("enforces an absolute turn limit even while stdout progress continues", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    writeFileSync(fakeClaudeBin, CONTINUOUS_PROGRESS_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      turnIdleTimeoutMs: 200,
      turnMaxTimeoutMs: 450,
      cancelGraceMs: 100,
    });

    await expect(client.runTurn({ instruction: "keep emitting" }))
      .rejects.toThrow("処理時間が上限に達した");
    client.dispose();
  });

  it("times out a turn that stops emitting stdout events", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    writeFileSync(fakeClaudeBin, HANG_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      turnIdleTimeoutMs: 100,
    });

    await expect(client.runTurn({ instruction: "hang please" }))
      .rejects.toThrow("一定時間応答がなかった");
    client.dispose();
  });

  it("escalates an idle timeout to SIGKILL when Claude ignores SIGTERM", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    writeFileSync(fakeClaudeBin, HANG_IGNORE_SIGTERM_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      turnIdleTimeoutMs: 100,
      turnMaxTimeoutMs: 1000,
      cancelGraceMs: 100,
    });

    await expect(client.runTurn({ instruction: "hang past timeout" }))
      .rejects.toThrow("一定時間応答がなかった");
    await new Promise((resolve) => setTimeout(resolve, 200));
    const status = await client.getStatus();
    client.dispose();

    expect(status.running).toBe(false);
  });

  it("spawns with a per-run cwd override instead of claudeConfigDir when provided, and creates the directory", async () => {
    const { client, dir, claudeConfigDir } = createClient();
    const perRunCwd = path.join(dir, "agent-workspaces", "ws_1", "claude");

    await client.runTurn({ instruction: "hello world", cwd: perRunCwd });
    client.dispose();

    // FAKE_CLAUDE_BIN writes fake-capture.json to `<spawn cwd>/../fake-capture.json`.
    const capture = readFakeCapture(path.dirname(perRunCwd));
    expect(realpathSync(capture.cwd)).toBe(realpathSync(perRunCwd));
    expect(perRunCwd).not.toBe(claudeConfigDir);
  });

  it("sends image content blocks alongside the text block when images are provided", async () => {
    const { client, dir } = createClient();

    await client.runTurn({
      instruction: "describe this",
      images: [
        { mediaType: "image/png", dataBase64: "AAAA" },
        { mediaType: "image/jpeg", dataBase64: "BBBB" },
      ],
    });
    const message = JSON.parse(readFileSync(path.join(dir, "fake-last-message.json"), "utf8")) as {
      message: { content: Array<Record<string, unknown>> };
    };
    client.dispose();

    const content = message.message.content;
    expect(content[0]).toEqual({ type: "text", text: "describe this" });
    expect(content.slice(1)).toEqual([
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "BBBB" } },
    ]);
  });

  it("sends PDF document blocks alongside images and forwards the selected Fable model", async () => {
    const { client, dir } = createClient();
    await client.runTurn({
      instruction: "Read the worksheet",
      model: "claude-fable-5-1",
      images: [{ mediaType: "image/png", dataBase64: "AAAA" }],
      documents: [{ title: "worksheet.pdf", dataBase64: "JVBERg==" }],
    });
    client.dispose();
    const message = JSON.parse(readFileSync(path.join(dir, "fake-last-message.json"), "utf8"));
    expect(message.message.content).toEqual([
      { type: "text", text: "Read the worksheet" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
      { type: "document", title: "worksheet.pdf", source: { type: "base64", media_type: "application/pdf", data: "JVBERg==" } },
    ]);
    expect(readFakeCapture(dir).argv).toContain("claude-fable-5-1");
  });

  it("sends only a text block when no images are provided", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "text only" });
    const message = JSON.parse(readFileSync(path.join(dir, "fake-last-message.json"), "utf8")) as {
      message: { content: unknown[] };
    };
    client.dispose();

    expect(message.message.content).toEqual([{ type: "text", text: "text only" }]);
  });

  it("streams text_delta chunks to onDelta", async () => {
    const { client } = createClient();
    const deltas: string[] = [];

    await client.runTurn({ instruction: "please DELTA now", onDelta: (d) => deltas.push(d) });
    client.dispose();

    expect(deltas.join("")).toContain("DELTA_CHUNK");
  });

  it("parses image content blocks out of a tool_result (stream-json type:\"user\") into onToolResult", async () => {
    const { client } = createClient();
    const results: Array<{ toolUseId?: string; images: Array<{ dataUrl: string }> }> = [];

    await client.runTurn({ instruction: "please TOOL_RESULT_IMAGE now", onToolResult: (result) => results.push(result) });
    client.dispose();

    expect(results).toEqual([
      { toolUseId: "toolu_123", images: [{ dataUrl: "data:image/png;base64,IMGDATA" }] },
    ]);
  });

  it("does not call onToolResult for a tool_result with only text content", async () => {
    const { client } = createClient();
    const results: unknown[] = [];

    await client.runTurn({ instruction: "please TOOL_RESULT_NO_IMAGE now", onToolResult: (result) => results.push(result) });
    client.dispose();

    expect(results).toEqual([]);
  });

  it("never leaks ANTHROPIC_API_KEY and uses the default claude config (no CLAUDE_CONFIG_DIR override)", async () => {
    const previousApiKey = process.env.ANTHROPIC_API_KEY;
    const secretKey = "SECRET_FOR_CLAUDE_STREAM_CLIENT_TEST";
    const previousSecret = process.env[secretKey];
    const previousLocale = process.env.LC_CLAUDE_CLIENT_TEST;
    process.env.ANTHROPIC_API_KEY = "sk-should-not-leak";
    process.env[secretKey] = "should-not-leak";
    process.env.LC_CLAUDE_CLIENT_TEST = "ja_JP.UTF-8";

    const { client, dir } = createClient();
    try {
      await client.runTurn({ instruction: "capture env" });
      const capture = readFakeCapture(dir);

      expect(capture.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(capture.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      expect(capture.env[secretKey]).toBeUndefined();
      expect(capture.env.CLAUDE_CONFIG_DIR).toBeUndefined();
      expect(capture.env.LC_CLAUDE_CLIENT_TEST).toBe("ja_JP.UTF-8");
    } finally {
      restoreEnv("ANTHROPIC_API_KEY", previousApiKey);
      restoreEnv(secretKey, previousSecret);
      restoreEnv("LC_CLAUDE_CLIENT_TEST", previousLocale);
      client.dispose();
    }
  });

  it("reports logged out when a turn result is a not-logged-in auth error", async () => {
    const { client } = createClient(AUTH_ERROR_RESULT_BIN);

    const turn = await client.runTurn({ instruction: "hi" });
    const status = await client.getStatus();
    client.dispose();

    expect(turn.isError).toBe(true);
    expect(status.loggedIn).toBe(false);
    expect(status.error).toContain("ログイン");
  });

  it("rejects a turn when the process exits without responding", async () => {
    const { client } = createClient(EXIT_BIN);

    await expect(client.runTurn({ instruction: "hi" })).rejects.toThrow();
    client.dispose();
  });

  it("passes the required permission and mcp flags to claude", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "flags", model: "claude-sonnet-4-6" });
    const capture = readFakeCapture(dir);
    client.dispose();

    const argv = capture.argv;
    expect(argv).toContain("--print");
    expect(argv).toContain("--input-format");
    expect(argv).toContain("stream-json");
    expect(argv).toContain("--output-format");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("dontAsk");
    expect(argv).toContain("--allowedTools");
    expect(argv).toContain(ALL_STAGED_ALLOWED_TOOLS);
    expect(argv).toContain("--disallowedTools");
    expect(argv).toContain("Bash");
    expect(argv).toContain("--model");
    expect(argv).toContain("claude-sonnet-4-6");
    const mcpConfigIndex = argv.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(argv[mcpConfigIndex + 1])).toEqual(MCP_CONFIG);
  });

  it("keeps WebSearch/WebFetch disallowed by default (webSearchEnabled omitted)", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "no web" });
    const capture = readFakeCapture(dir);
    client.dispose();

    const argv = capture.argv;
    const allowedTools = argv[argv.indexOf("--allowedTools") + 1];
    expect(allowedTools).toBe(ALL_STAGED_ALLOWED_TOOLS);
    const disallowed = argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--model"));
    expect(disallowed).toEqual(["Bash", "Write", "Edit", "WebFetch", "WebSearch", "Task"]);
  });

  it("allows WebSearch/WebFetch for a turn with webSearchEnabled: true, keeping Bash/Write/Edit/Task disallowed", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "with web", webSearchEnabled: true });
    const capture = readFakeCapture(dir);
    client.dispose();

    const argv = capture.argv;
    const allowedTools = argv[argv.indexOf("--allowedTools") + 1];
    expect(allowedTools).toBe(`${ALL_STAGED_ALLOWED_TOOLS} WebSearch WebFetch`);
    const disallowed = argv.slice(argv.indexOf("--disallowedTools") + 1, argv.indexOf("--model"));
    expect(disallowed).toEqual(["Bash", "Write", "Edit", "Task"]);
  });

  it("treats webSearchEnabled: false the same as omitted (web tools disallowed)", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "web off", webSearchEnabled: false });
    const capture = readFakeCapture(dir);
    client.dispose();

    const argv = capture.argv;
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(ALL_STAGED_ALLOWED_TOOLS);
    expect(argv).toContain("WebSearch");
    expect(argv).toContain("WebFetch");
  });

  it("narrows MCP tools from the original user instruction instead of the composed prompt", async () => {
    const { client, dir } = createClient();

    await client.runTurn({
      instruction: "full prompt mentioning insert_graph, insert_table, and every other tool",
      userInstruction: "二次関数のグラフを追加して",
    });
    const capture = readFakeCapture(dir);
    client.dispose();

    const allowedTools = capture.argv[capture.argv.indexOf("--allowedTools") + 1];
    expect(allowedTools).toContain("mcp__sigma-studio-local__insert_graph");
    expect(allowedTools).toContain("mcp__sigma-studio-local__search_document");
    expect(allowedTools).toContain("mcp__sigma-studio-local__get_edit_proposal");
    expect(allowedTools).not.toContain("mcp__sigma-studio-local__insert_table");
    expect(allowedTools).not.toContain("mcp__sigma-studio-local__*");
  });

  it("restores wildcard MCP exposure when SIGMA_AI_TOOL_GATING=off", async () => {
    const previous = process.env.SIGMA_AI_TOOL_GATING;
    process.env.SIGMA_AI_TOOL_GATING = "off";
    try {
      const { client, dir } = createClient();
      await client.runTurn({ instruction: "本文を直して" });
      const capture = readFakeCapture(dir);
      client.dispose();

      expect(capture.argv[capture.argv.indexOf("--allowedTools") + 1])
        .toBe("mcp__sigma-studio-local__* Skill Read");
    } finally {
      restoreEnv("SIGMA_AI_TOOL_GATING", previous);
    }
  });

  it("uses a per-turn mcpConfig override instead of the constructor default when provided", async () => {
    const { client, dir } = createClient();
    const perRunConfig = {
      mcpServers: {
        "sigma-studio-local": { command: "node", args: ["/tmp/sigma-doc-mcp-server.cjs"], env: { SIGMA_STUDIO_RUN_CONTEXT_FILE: "/data/ai-run-context/claude-run_123.run-context.json" } },
      },
    };

    await client.runTurn({ instruction: "flags", mcpConfig: perRunConfig });
    const capture = readFakeCapture(dir);
    client.dispose();

    const mcpConfigIndex = capture.argv.indexOf("--mcp-config");
    expect(mcpConfigIndex).toBeGreaterThanOrEqual(0);
    expect(JSON.parse(capture.argv[mcpConfigIndex + 1])).toEqual(perRunConfig);
  });

  it("falls back to the constructor default mcpConfig when no per-turn override is given", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "no override" });
    const capture = readFakeCapture(dir);
    client.dispose();

    const mcpConfigIndex = capture.argv.indexOf("--mcp-config");
    expect(JSON.parse(capture.argv[mcpConfigIndex + 1])).toEqual(MCP_CONFIG);
  });

  it("spawns a fresh process per turn, and resumes via --resume when a sessionId is passed back", async () => {
    const { client, dir } = createClient();

    const first = await client.runTurn({ instruction: "turn one" });
    const second = await client.runTurn({ instruction: "turn two", resumeSessionId: first.sessionId });
    const capture = readFakeCapture(dir);
    client.dispose();

    // Every turn is its own process (this is what makes concurrent turns from
    // different chat rooms safe), so pids differ even though the fake binary
    // echoes back the same sessionId for --resume calls.
    expect(second.finalText).toBe("ECHO:turn two");
    expect(capture.argv).toContain("--resume");
    expect(capture.argv).toContain(first.sessionId);
  });

  it("does not pass --resume on a fresh turn with no prior session", async () => {
    const { client, dir } = createClient();

    await client.runTurn({ instruction: "turn one" });
    const capture = readFakeCapture(dir);
    client.dispose();

    expect(capture.argv).not.toContain("--resume");
  });

  it("uses the requested model and effort for each turn independently", async () => {
    const { client, dir } = createClient();

    const first = await client.runTurn({ instruction: "turn one", model: "claude-opus-4-8" });
    const second = await client.runTurn({
      instruction: "turn two",
      model: "claude-sonnet-5",
      reasoningEffort: "high",
    });
    const capture = readFakeCapture(dir);
    client.dispose();

    expect(first.finalText).toBe("ECHO:turn one");
    expect(second.finalText).toBe("ECHO:turn two");
    expect(capture.argv).toContain("claude-sonnet-5");
    expect(capture.argv.slice(capture.argv.indexOf("--effort"), capture.argv.indexOf("--effort") + 2))
      .toEqual(["--effort", "high"]);
  });

  it("runs two turns concurrently without one blocking or corrupting the other", async () => {
    const { client } = createClient();

    const [first, second] = await Promise.all([
      client.runTurn({ instruction: "room A" }),
      client.runTurn({ instruction: "room B" }),
    ]);
    client.dispose();

    expect(first.finalText).toBe("ECHO:room A");
    expect(second.finalText).toBe("ECHO:room B");
    expect(first.sessionId).not.toBe(second.sessionId);
  });

  it("cancels an in-flight turn via cancelRun and resolves with cancelled: true", async () => {
    const { client } = createClient(HANG_BIN);
    // Warm the availability cache first so the timed wait below only has to
    // cover spawn + cancel-handle registration, not the `claude --version` probe.
    await client.getStatus();

    const runTurnPromise = client.runTurn({ instruction: "hang please", runId: "run_claude_cancel_1" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    const cancelled = client.cancelRun("run_claude_cancel_1");
    expect(cancelled).toBe(true);

    const result = await runTurnPromise;
    client.dispose();

    expect(result.cancelled).toBe(true);
    expect(result.isError).toBe(false);
  }, 20000);

  it("cancelRun returns false for an unknown runId", async () => {
    const { client } = createClient();

    expect(client.cancelRun("no-such-run")).toBe(false);
    client.dispose();
  });

  it("escalates to SIGKILL when the process ignores SIGTERM past the cancel grace period", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    writeFileSync(fakeClaudeBin, HANG_IGNORE_SIGTERM_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      cancelGraceMs: 150,
    });
    await client.getStatus();

    const runTurnPromise = client.runTurn({ instruction: "hang please", runId: "run_claude_cancel_2" });
    await new Promise((resolve) => setTimeout(resolve, 200));
    client.cancelRun("run_claude_cancel_2");

    const result = await runTurnPromise;
    client.dispose();

    expect(result.cancelled).toBe(true);
  }, 20000);

  it("reprobes availability after an unavailable result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
    tempDirs.push(dir);
    const fakeClaudeBin = path.join(dir, "claude");
    const client = new ClaudeStreamClient({
      claudeConfigDir: path.join(dir, "claude-home"),
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
    });

    const unavailable = await client.getStatus();
    expect(unavailable.available).toBe(false);

    writeFileSync(fakeClaudeBin, FAKE_CLAUDE_BIN, "utf8");
    chmodSync(fakeClaudeBin, 0o755);

    const available = await client.getStatus();
    client.dispose();

    expect(available.available).toBe(true);
    expect(available.loggedIn).toBe(true);
  });
});

function createClient(binSource = FAKE_CLAUDE_BIN): ClientFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-claude-stream-"));
  tempDirs.push(dir);
  const fakeClaudeBin = path.join(dir, "claude");
  const claudeConfigDir = path.join(dir, "claude-home");
  writeFileSync(fakeClaudeBin, binSource, "utf8");
  chmodSync(fakeClaudeBin, 0o755);

  return {
    dir,
    claudeConfigDir,
    fakeClaudeBin,
    client: new ClaudeStreamClient({
      claudeConfigDir,
      mcpConfig: MCP_CONFIG,
      claudeBin: fakeClaudeBin,
      defaultModel: "claude-opus-4-8",
      availabilityProbeTimeoutMs: 10_000,
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

// 実機の claude を模す: stream-json モードでは stdin に最初のメッセージが来るまで
// system/init を出さない (init を startup で出さないのが重要 — デッドロック退行検知のため)。
const FAKE_CLAUDE_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("claude-fake 2.1.195 (Claude Code)");
  process.exit(0);
}
if (process.argv.includes("--help")) {
  console.log("--model <model> Model for the current session. Provide an alias for the latest model (e.g. 'fable', 'opus', or 'sonnet') or a model's full name (e.g. 'claude-fable-5').");
  process.exit(0);
}
if (!process.argv.includes("stream-json")) {
  process.exit(2);
}

const capturePath = path.join(process.cwd(), "..", "fake-capture.json");
fs.writeFileSync(capturePath, JSON.stringify({
  argv: process.argv.slice(2),
  env: process.env,
  pid: process.pid,
  cwd: process.cwd(),
}, null, 2));

function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const sessionId = "sess_" + process.pid;

let initSent = false;
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  fs.writeFileSync(path.join(process.cwd(), "..", "fake-last-message.json"), JSON.stringify(msg));
  if (!initSent) {
    initSent = true;
    send({ type: "system", subtype: "init", session_id: sessionId, apiKeySource: "none", model: "claude-opus-4-8" });
  }
  const text = (msg && msg.message && msg.message.content && msg.message.content[0] && msg.message.content[0].text) || "";
  if (text.includes("DELTA")) {
    send({ type: "stream_event", event: { delta: { type: "text_delta", text: "DELTA_CHUNK" } } });
  }
  if (text.includes("TOOL_RESULT_IMAGE")) {
    send({
      type: "user",
      message: {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "toolu_123",
            content: [
              { type: "text", text: "検証OK" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: "IMGDATA" } },
            ],
          },
        ],
      },
    });
  }
  if (text.includes("TOOL_RESULT_NO_IMAGE")) {
    send({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_999", content: [{ type: "text", text: "OK" }] }],
      },
    });
  }
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "ECHO:" + text }] }, session_id: sessionId });
  send({ type: "result", subtype: "success", is_error: false, result: "ECHO:" + text, session_id: sessionId, total_cost_usd: 0.01, num_turns: 1, permission_denials: [] });
});
`;

// 未ログイン: init は apiKeySource:"none" で出るが result が is_error + "Not logged in"。
const AUTH_ERROR_RESULT_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "sess_auth", apiKeySource: "none", model: "claude-opus-4-8" });
  send({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Not logged in · Please run /login" }] }, session_id: "sess_auth" });
  send({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: "sess_auth", num_turns: 1, permission_denials: [] });
});
`;

// Each stdout gap stays below the idle timeout, while total turn time exceeds it.
const PROGRESS_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "sess_progress", apiKeySource: "none", model: "claude-opus-4-8" });
  setTimeout(() => send({ type: "stream_event", event: { delta: { type: "text_delta", text: "step1" } } }), 200);
  setTimeout(() => send({ type: "stream_event", event: { delta: { type: "text_delta", text: "step2" } } }), 400);
  setTimeout(() => send({ type: "stream_event", event: { delta: { type: "text_delta", text: "step3" } } }), 600);
  setTimeout(() => send({ type: "result", subtype: "success", is_error: false, result: "ACTIVE_DONE", session_id: "sess_progress", num_turns: 1, permission_denials: [] }), 800);
});
`;

const CONTINUOUS_PROGRESS_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "sess_continuous", apiKeySource: "none", model: "claude-opus-4-8" });
  setInterval(() => send({ type: "stream_event", event: { delta: { type: "text_delta", text: "." } } }), 50);
});
`;

// spawn は成功するが、turn の入力後に result を返さずプロセスが落ちるケース。
const EXIT_BIN = `#!/usr/bin/env node
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
process.stderr.write("boom\\n");
setTimeout(() => process.exit(1), 50);
`;

// init だけ返してハングし続ける (result を出さない): cancelRun() のテスト用。
// SIGTERM はトラップしないため、通常のkillでNodeプロセスとして終了する。
const HANG_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "sess_hang", apiKeySource: "none", model: "claude-opus-4-8" });
});
`;

// HANG_BIN と同じだが SIGTERM を無視する: cancelRun() の SIGKILL エスカレーションのテスト用。
const HANG_IGNORE_SIGTERM_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
if (process.argv.includes("--version")) { console.log("claude-fake 2.1.195"); process.exit(0); }
if (!process.argv.includes("stream-json")) { process.exit(2); }
process.on("SIGTERM", () => {});
function send(message) { process.stdout.write(JSON.stringify(message) + "\\n"); }
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", () => {
  send({ type: "system", subtype: "init", session_id: "sess_hang2", apiKeySource: "none", model: "claude-opus-4-8" });
});
`;
