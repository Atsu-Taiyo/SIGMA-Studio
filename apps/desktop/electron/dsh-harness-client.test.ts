import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildDshPatch,
  DshHarnessClient,
  isSupportedNodeVersion,
  readDshGatewayConfig,
  SIGMA_AI_DSH_VERSION,
  SIGMA_AI_MODEL,
} from "./dsh-harness-client";
import type { CliChildProcess } from "./cli-spawn";
import type { SigmaStudioMcpLaunchSpec } from "./sigma-studio-mcp-launch";

const TOKEN = "fixture-gateway-token-32-bytes-minimum-length";
const mcp: SigmaStudioMcpLaunchSpec = {
  uiLocale: "ja", execPath: "/app/electron", scriptPath: "/app/mcp.cjs", userDataDir: "/data",
  runContextFile: "/data/run.json", renderBridgeFile: "/data/bridge.json", provider: "sigma",
};

const temporary: string[] = [];
afterEach(() => { for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function fakeBridge(lines: unknown[], capture: { request?: unknown; patch?: unknown; env?: NodeJS.ProcessEnv }) {
  return (_node: string, _bridge: string, env: NodeJS.ProcessEnv) => {
    const child = new EventEmitter() as CliChildProcess & EventEmitter;
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(child, { stdin, stdout, stderr, kill: () => true });
    capture.env = env;
    let raw = "";
    stdin.on("data", (chunk) => {
      raw += chunk;
      if (!raw.includes("\n") || capture.request) return;
      capture.request = JSON.parse(raw);
      capture.patch = JSON.parse(readFileSync((capture.request as { patches: string[] }).patches[0]!, "utf8"));
      for (const line of lines) stdout.write(`${JSON.stringify(line)}\n`);
      stdout.end();
      stderr.end();
      setImmediate(() => child.emit("close", 0));
    });
    stdin.on("end", () => { stdout.end(); stderr.end(); setImmediate(() => child.emit("close", 130)); });
    return child;
  };
}

function client(lines: unknown[], capture: Parameters<typeof fakeBridge>[1], env: Record<string, string> = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "dsh-client-"));
  temporary.push(root);
  return {
    root,
    client: new DshHarnessClient({
      dshHome: path.join(root, "home"), patchDir: path.join(root, "patches"),
      runtimeDirCandidates: () => ["/runtime"],
      env: { PATH: "/usr/bin", SIGMA_AI_GATEWAY_URL: "https://gateway.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN, SIGMA_STUDIO_NODE_BIN: "/opt/node", ELECTRON_RUN_AS_NODE: "1", ...env },
      pathExists: async () => true,
      probeNodeVersion: async () => "24.22.1",
      spawnBridge: fakeBridge(lines, capture),
    }),
  };
}

describe("gateway configuration", () => {
  it("accepts https and loopback http, and normalises to the /v1 base", () => {
    expect(readDshGatewayConfig({ SIGMA_AI_GATEWAY_URL: "https://g.example.test/", SIGMA_AI_GATEWAY_TOKEN: TOKEN })).toEqual({ url: "https://g.example.test/v1", token: TOKEN });
    expect(readDshGatewayConfig({ SIGMA_AI_GATEWAY_URL: "http://127.0.0.1:8787/v1", SIGMA_AI_GATEWAY_TOKEN: TOKEN })?.url).toBe("http://127.0.0.1:8787/v1");
  });
  it("refuses plain http to other hosts, embedded credentials, and missing values", () => {
    expect(readDshGatewayConfig({ SIGMA_AI_GATEWAY_URL: "http://g.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN })).toBeNull();
    expect(readDshGatewayConfig({ SIGMA_AI_GATEWAY_URL: "https://user:pw@g.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN })).toBeNull();
    expect(readDshGatewayConfig({ SIGMA_AI_GATEWAY_URL: "https://g.example.test" })).toBeNull();
    expect(readDshGatewayConfig({})).toBeNull();
  });
});

describe("node requirement", () => {
  it("needs Node 24.9 or later", () => {
    expect(["24.9.0", "v24.22.1", "26.0.0"].map(isSupportedNodeVersion)).toEqual([true, true, true]);
    expect(["24.8.9", "22.18.0", "", null, "garbage"].map(isSupportedNodeVersion)).toEqual([false, false, false, false, false]);
  });
});

describe("dsh composition", () => {
  const patch = buildDshPatch({ gatewayUrl: "https://g.example.test/v1", mcp, systemPrompt: "persona", skillDirs: ["/ws/.agents/skills"] });
  const rows = (patch[0] as { insert: Array<{ id: string; disabled?: boolean; config?: Record<string, unknown> }> }).insert;
  const row = (id: string) => rows.find((entry) => entry.id === id)!;

  it("routes the one allowed model through the gateway without writing the token", () => {
    const provider = (row("llm-pi-ai").config!.providers as Record<string, { apiKeyEnv: string; baseURL: string; models: Array<{ id: string }> }>)["sigma-gateway"]!;
    expect(provider).toMatchObject({ apiKeyEnv: "SIGMA_AI_GATEWAY_TOKEN", baseURL: "https://g.example.test/v1" });
    expect(provider.models.map((model) => model.id)).toEqual([SIGMA_AI_MODEL]);
    expect(JSON.stringify(patch)).not.toContain(TOKEN);
  });
  it("gives a tool-less call no MCP server and no skill tool, and still removes shell and file tools", () => {
    const toolless = buildDshPatch({ gatewayUrl: "https://g.example.test/v1", mcp: null, systemPrompt: "", skillDirs: [] });
    const ids = (toolless[0] as { insert: Array<{ id: string; disabled?: boolean }> }).insert;
    expect(ids.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(["mcp-sigma-studio", "skill", "skill-filesystem", "tool-skill"]));
    expect(ids.filter((entry) => entry.disabled).map((entry) => entry.id)).toEqual(["persistent-bash", "persistent-pwsh", "tool-working-directory", "tool-fs"]);
  });
  it("adds no subagent parts unless subagents are enabled for a run that has tools", () => {
    const ids = (built: unknown[]) => (built[0] as { insert: Array<{ id: string }> }).insert.map((entry) => entry.id);
    const subagentIds = ["subagent", "subagent-spawn", "tool-subagent"];
    const base = { gatewayUrl: "https://g.example.test/v1", systemPrompt: "persona", skillDirs: [] };
    expect(rows.map((entry) => entry.id)).not.toEqual(expect.arrayContaining(subagentIds));
    expect(ids(buildDshPatch({ ...base, mcp, subagents: { enabled: false, maxDepth: 3, maxConcurrent: 5 } })))
      .not.toEqual(expect.arrayContaining(subagentIds));
    // 道具を持たせない問い合わせ (コメントへの返事など) では、有効でも足さない。
    expect(ids(buildDshPatch({ ...base, mcp: null, subagents: { enabled: true, maxDepth: 1, maxConcurrent: 3 } })))
      .not.toEqual(expect.arrayContaining(subagentIds));
  });
  it("mounts the subagent service, backend and tool with the depth and count limits when enabled", () => {
    const enabled = buildDshPatch({
      gatewayUrl: "https://g.example.test/v1", mcp, systemPrompt: "persona", skillDirs: [],
      subagents: { enabled: true, maxDepth: 2, maxConcurrent: 4 },
    });
    const entries = (enabled[0] as { insert: Array<{ id: string; name: string; config?: Record<string, unknown> }> }).insert;
    const entry = (id: string) => entries.find((candidate) => candidate.id === id)!;
    expect(entry("subagent")).toMatchObject({ name: "@deepseek-ai/dsh-subagent", config: { maxActiveSubagents: 4 } });
    expect(entry("subagent-spawn").name).toBe("@deepseek-ai/dsh-subagent-spawn-in-process");
    expect(entry("tool-subagent")).toMatchObject({
      name: "@deepseek-ai/dsh-tool-subagent",
      config: { provider: "spawn", toolName: "subagent", maxDepth: 2 },
    });
    // シェルとファイルの道具は、サブエージェントを足しても外したまま。
    for (const id of ["persistent-bash", "persistent-pwsh", "tool-working-directory", "tool-fs"]) {
      expect((entry(id) as { disabled?: boolean }).disabled).toBe(true);
    }
  });
  it("gives the agent the material MCP server and skills, and removes shell and file tools", () => {
    expect(row("mcp-sigma-studio").config).toMatchObject({
      serverName: "sigma-studio-local", transport: "stdio", command: "/app/electron", args: ["/app/mcp.cjs"], failOnStartupError: true,
      env: { ELECTRON_RUN_AS_NODE: "1", SIGMA_STUDIO_MCP_PROVIDER: "sigma", SIGMA_STUDIO_USER_DATA_DIR: "/data" },
    });
    for (const id of ["persistent-bash", "persistent-pwsh", "tool-working-directory", "tool-fs"]) expect(row(id).disabled).toBe(true);
    expect(row("skill-filesystem").config).toEqual({ includeDefaultRoots: false, watch: false, customSkillDirs: ["/ws/.agents/skills"] });
    expect(row("system-prompt").config).toMatchObject({ personaPrefix: "persona", includeHarnessIdentity: false });
  });
});

describe("status", () => {
  it("is unavailable without a gateway, a runtime, or a usable Node — each with its own reason", async () => {
    const base = { dshHome: "/h", patchDir: "/p", runtimeDirCandidates: () => ["/runtime"] };
    const env = { PATH: "/usr/bin", SIGMA_AI_GATEWAY_URL: "https://g.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN, SIGMA_STUDIO_NODE_BIN: "/opt/node" };
    expect((await new DshHarnessClient({ ...base, env: { PATH: "/usr/bin" } }).getStatus()).unavailableReason).toBe("gateway");
    expect((await new DshHarnessClient({ ...base, env, pathExists: async () => false }).getStatus()).unavailableReason).toBe("runtime");
    expect((await new DshHarnessClient({ ...base, env, pathExists: async () => true, probeNodeVersion: async () => "22.18.0" }).getStatus()).unavailableReason).toBe("node");
    expect(await new DshHarnessClient({ ...base, env, pathExists: async () => true, probeNodeVersion: async () => "24.22.1" }).getStatus())
      .toMatchObject({ available: true, loggedIn: true, model: SIGMA_AI_MODEL, error: null });
  });

  it("is limited to the Pro plan: not entitled, or unable to tell, means unavailable and no turn is started", async () => {
    const base = { dshHome: "/h", patchDir: "/p", runtimeDirCandidates: () => ["/runtime"], pathExists: async () => true, probeNodeVersion: async () => "24.22.1" };
    const env = { PATH: "/usr/bin", SIGMA_AI_GATEWAY_URL: "https://g.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN, SIGMA_STUDIO_NODE_BIN: "/opt/node" };
    let spawned = 0;
    const spawnBridge = () => { spawned += 1; throw new Error("must not start"); };
    for (const entitled of [async () => false, async () => { throw new Error("signed out"); }]) {
      const harness = new DshHarnessClient({ ...base, env, entitled, spawnBridge });
      expect(await harness.getStatus()).toMatchObject({ available: false, unavailableReason: "plan" });
      const turn = await harness.runTurn({
        runId: "r", instruction: "x", images: [], resumeSessionId: null, cwd: "/tmp/never", mcp: null, systemPrompt: "",
        onText: () => {}, onReasoning: () => {}, onToolUse: () => {}, onToolResult: () => {},
      });
      expect(turn).toMatchObject({ isError: true, cancelled: false });
    }
    expect(spawned).toBe(0);
    let asked = 0;
    const pro = new DshHarnessClient({ ...base, env, entitled: async () => { asked += 1; return true; } });
    expect((await pro.getStatus()).available).toBe(true);
    expect((await pro.getStatus()).available).toBe(true);
    expect(asked).toBe(1);
  });
});

describe("a turn", () => {
  const params = (runId: string, cwd: string) => ({
    runId, instruction: "図を入れて", images: [{ mimeType: "image/png" as const, base64: "AAAA", name: "a.png" }],
    resumeSessionId: "session-1", cwd, mcp, systemPrompt: "persona",
  });

  it("sends the request to the bridge, relays its events, and cleans up the per-run composition", async () => {
    const capture: Parameters<typeof fakeBridge>[1] = {};
    const { client: harness, root } = client([
      { type: "session", sessionId: "session-1" },
      { type: "reasoning", text: "考え中" },
      { type: "text", text: "確認します。" },
      { type: "tool-call", id: "c1", name: "mcp__sigma-studio-local__insert_svg_image", arguments: "{\"w\":320}" },
      { type: "tool-result", id: "c1", isError: false, text: "ok", images: [{ mimeType: "image/png", data: "BBBB" }] },
      { type: "text", text: "入れました。" },
      { type: "result", sessionId: "session-1", finalResponse: "入れました。", endReason: { kind: "completed" } },
    ], capture);
    const seen: unknown[] = [];
    const result = await harness.runTurn({
      ...params("run/1", path.join(root, "ws")),
      onText: (text) => seen.push(["text", text]),
      onReasoning: (text) => seen.push(["reasoning", text]),
      onToolUse: (tool) => seen.push(["tool", tool]),
      onToolResult: (toolResult) => seen.push(["result", toolResult]),
    });
    expect(result).toEqual({ finalText: "入れました。", sessionId: "session-1", isError: false, errorMessage: null, cancelled: false });
    expect(seen).toEqual([
      ["reasoning", "考え中"], ["text", "確認します。"],
      ["tool", { id: "c1", name: "mcp__sigma-studio-local__insert_svg_image", input: { w: 320 } }],
      ["result", { toolUseId: "c1", isError: false, images: [{ mimeType: "image/png", base64: "BBBB" }] }],
      ["text", "入れました。"],
    ]);
    expect(capture.request).toMatchObject({
      profile: "sdk-minimal", provider: "sigma-gateway", model: SIGMA_AI_MODEL, sessionId: "session-1",
      content: [{ type: "text", text: "図を入れて" }, { type: "image", data: "AAAA", mimeType: "image/png", name: "a.png" }],
    });
    // 橋渡しへは中継のトークンと最小の環境だけを渡し、Electron 由来の変数は渡さない。
    expect(capture.env).toMatchObject({ SIGMA_AI_GATEWAY_TOKEN: TOKEN, PATH: "/usr/bin" });
    expect(capture.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    expect(readdirSync(path.join(root, "patches"))).toEqual([]);
  });

  it("tells the bridge the subagent tool's name and composes the subagent parts only when subagents are enabled", async () => {
    const noop = { onText: () => {}, onReasoning: () => {}, onToolUse: () => {}, onToolResult: () => {} };
    const done = [{ type: "result", sessionId: "s", finalResponse: "done", endReason: { kind: "completed" } }];
    const composedIds = (capture: Parameters<typeof fakeBridge>[1]) =>
      ((capture.patch as Array<{ insert: Array<{ id: string }> }>)[0]!.insert).map((entry) => entry.id);

    const off: Parameters<typeof fakeBridge>[1] = {};
    const first = client(done, off);
    await first.client.runTurn({ ...params("run-off", path.join(first.root, "ws")), ...noop });
    expect(off.request).not.toHaveProperty("subagentToolName");
    expect(composedIds(off)).not.toContain("tool-subagent");

    const on: Parameters<typeof fakeBridge>[1] = {};
    const second = client(done, on);
    await second.client.runTurn({
      ...params("run-on", path.join(second.root, "ws")), ...noop,
      subagents: { enabled: true, maxDepth: 1, maxConcurrent: 3 },
    });
    expect(on.request).toMatchObject({ subagentToolName: "subagent" });
    expect(composedIds(on)).toEqual(expect.arrayContaining(["subagent", "subagent-spawn", "tool-subagent"]));
  });

  it("reports a provider failure and a truncated answer as errors", async () => {
    for (const [endReason, message] of [[{ kind: "error", message: "AUTH 401" }, "AUTH 401"], [{ kind: "max-tokens" }, "max-tokens"]] as const) {
      const { client: harness, root } = client([{ type: "result", sessionId: "s", finalResponse: "", endReason }], {});
      const result = await harness.runTurn({ ...params("run-2", path.join(root, "ws")), onText() {}, onReasoning() {}, onToolUse() {}, onToolResult() {} });
      expect(result).toMatchObject({ isError: true, errorMessage: message, cancelled: false });
    }
  });

  it("treats a bridge that dies without a result as an error", async () => {
    const { client: harness, root } = client([], {});
    const result = await harness.runTurn({ ...params("run-3", path.join(root, "ws")), onText() {}, onReasoning() {}, onToolUse() {}, onToolResult() {} });
    expect(result.isError).toBe(true);
  });
});

describe("the pinned runtime", () => {
  it("matches the version this client was verified against", () => {
    const manifest = JSON.parse(readFileSync(path.join(__dirname, "../dsh-runtime/package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@deepseek-ai/dsh-sdk-client"]).toBe(SIGMA_AI_DSH_VERSION);
  });
});

describe("stopping and limits", () => {
  const callbacks = { onText: () => {}, onReasoning: () => {}, onToolUse: () => {}, onToolResult: () => {} };
  const turn = (runId: string, cwd: string) => ({ runId, instruction: "x", images: [], resumeSessionId: null, cwd, mcp, systemPrompt: "", ...callbacks });
  const base = (root: string) => ({
    dshHome: path.join(root, "home"), patchDir: path.join(root, "patches"), runtimeDirCandidates: () => ["/runtime"],
    env: { PATH: "/usr/bin", SIGMA_AI_GATEWAY_URL: "https://gateway.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN, SIGMA_STUDIO_NODE_BIN: "/opt/node" },
    pathExists: async () => true,
  });
  const tempRoot = () => { const root = mkdtempSync(path.join(os.tmpdir(), "dsh-client-")); temporary.push(root); return root; };

  it("a stop that arrives while the turn is still being prepared sends nothing to the model", async () => {
    const root = tempRoot();
    let spawned = 0;
    let release!: (version: string) => void;
    const harness = new DshHarnessClient({
      ...base(root),
      probeNodeVersion: () => new Promise<string>((resolve) => { release = resolve; }),
      spawnBridge: () => { spawned += 1; throw new Error("must not start"); },
    });
    const running = harness.runTurn(turn("run-prep", path.join(root, "ws")));
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.cancelRun("run-prep")).toBe(true);
    release("24.22.1");
    expect(await running).toMatchObject({ cancelled: true, isError: false });
    expect(spawned).toBe(0);
  });

  it("remembers a stop that arrives before the turn starts, once", async () => {
    const root = tempRoot();
    const capture: Parameters<typeof fakeBridge>[1] = {};
    const harness = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1",
      spawnBridge: fakeBridge([{ type: "result", sessionId: "s", finalResponse: "done", endReason: { kind: "stop" } }], capture) });
    expect(harness.cancelRun("run-early")).toBe(false);
    expect(await harness.runTurn(turn("run-early", path.join(root, "ws")))).toMatchObject({ cancelled: true });
    expect(capture.request).toBeUndefined();
    // 覚えた中断は 1 回で使い切る。同じ runId の次のターンは普通に走る。
    expect(await harness.runTurn(turn("run-early", path.join(root, "ws")))).toMatchObject({ cancelled: false, finalText: "done" });
    const other = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1",
      spawnBridge: fakeBridge([{ type: "result", sessionId: "s", finalResponse: "done", endReason: { kind: "stop" } }], {}) });
    other.cancelRun("run-forgotten");
    other.forgetRun("run-forgotten");
    expect(await other.runTurn(turn("run-forgotten", path.join(root, "ws")))).toMatchObject({ cancelled: false });
  });

  it("does not reuse one account's plan answer for another account", async () => {
    const root = tempRoot();
    let account: string | null = "pro-user";
    const asked: Array<string | null> = [];
    const harness = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1",
      entitlementAccount: () => account,
      entitled: async () => { asked.push(account); return account === "pro-user"; } });
    expect((await harness.getStatus()).available).toBe(true);
    account = null;
    expect(await harness.getStatus()).toMatchObject({ available: false, unavailableReason: "plan" });
    account = "free-user";
    expect(await harness.getStatus()).toMatchObject({ available: false, unavailableReason: "plan" });
    account = "pro-user";
    expect((await harness.getStatus()).available).toBe(true);
    expect(asked).toEqual(["pro-user", null, "free-user", "pro-user"]);
  });

  it("drops a plan answer when the account changed while it was being asked", async () => {
    const root = tempRoot();
    let account: string | null = "pro-user";
    const harness = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1",
      entitlementAccount: () => account,
      entitled: async () => { account = "free-user"; return true; } });
    expect(await harness.getStatus()).toMatchObject({ available: false, unavailableReason: "plan" });
  });

  it("gives up a turn whose bridge goes silent, and releases the per-run composition", async () => {
    const root = tempRoot();
    const harness = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1", turnIdleTimeoutMs: 30,
      spawnBridge: () => {
        const child = new EventEmitter() as CliChildProcess & EventEmitter;
        const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
        Object.assign(child, { stdin, stdout, stderr, kill: () => true });
        stdin.on("end", () => { stdout.end(); stderr.end(); setImmediate(() => { child.emit("exit", 130); child.emit("close", 130); }); });
        stdin.resume();
        return child;
      } });
    expect(await harness.runTurn(turn("run-silent", path.join(root, "ws")))).toMatchObject({ isError: true, errorMessage: "timeout", cancelled: false });
    expect(readdirSync(path.join(root, "patches"))).toEqual([]);
  });

  it("does not call the model when the material MCP server cannot be started", async () => {
    const root = tempRoot();
    let spawned = 0;
    const harness = new DshHarnessClient({ ...base(root), probeNodeVersion: async () => "24.22.1",
      pathExists: async (target) => target !== "/app/mcp.cjs",
      spawnBridge: () => { spawned += 1; throw new Error("must not start"); } });
    expect(await harness.runTurn(turn("run-nomcp", path.join(root, "ws")))).toMatchObject({ isError: true, cancelled: false });
    expect(spawned).toBe(0);
  });
});
