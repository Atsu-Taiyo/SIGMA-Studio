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
    // 橋渡しへは最小の環境と、この turn だけのローカル中継の鍵を渡す。中継のトークンそのものも、
    // Electron 由来の変数も渡さない。
    expect(capture.env).toMatchObject({ PATH: "/usr/bin" });
    expect(capture.env?.SIGMA_AI_GATEWAY_TOKEN).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(capture.env?.SIGMA_AI_GATEWAY_TOKEN).not.toBe(TOKEN);
    expect(capture.env).not.toHaveProperty("ELECTRON_RUN_AS_NODE");
    const provider = ((capture.patch as Array<{ insert: Array<{ config: { providers: Record<string, { baseURL: string }> } }> }>)[0]!.insert[0]!.config.providers)["sigma-gateway"]!;
    expect(provider.baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/u);
    expect(readdirSync(path.join(root, "patches"))).toEqual([]);
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

describe("the gateway, as the turn sees it", () => {
  const callbacks = { onText: () => {}, onReasoning: () => {}, onToolUse: () => {}, onToolResult: () => {} };
  const turn = (runId: string, cwd: string) => ({ runId, instruction: "x", images: [], resumeSessionId: null, cwd, mcp, systemPrompt: "", ...callbacks });
  const tempRoot = () => { const root = mkdtempSync(path.join(os.tmpdir(), "dsh-client-")); temporary.push(root); return root; };
  const base = (root: string) => ({
    dshHome: path.join(root, "home"), patchDir: path.join(root, "patches"), runtimeDirCandidates: () => ["/runtime"],
    env: { PATH: "/usr/bin", SIGMA_AI_GATEWAY_URL: "https://gateway.example.test", SIGMA_AI_GATEWAY_TOKEN: TOKEN, SIGMA_STUDIO_NODE_BIN: "/opt/node" },
    pathExists: async () => true, probeNodeVersion: async () => "24.22.1",
  });
  type Relay = { url: string; token: string };
  /** DSH の代わり。依頼を受け取ったら、渡されたローカル中継へ実際に HTTP で話す。 */
  function httpBridge(script: (relay: Relay) => Promise<unknown[]>) {
    return (_node: string, _bridge: string, env: NodeJS.ProcessEnv) => {
      const child = new EventEmitter() as CliChildProcess & EventEmitter;
      const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
      Object.assign(child, { stdin, stdout, stderr, kill: () => true });
      let raw = "";
      let started = false;
      let ended = false;
      const finish = (code: number) => {
        if (ended) return;
        ended = true;
        stdout.end();
        stderr.end();
        setImmediate(() => { child.emit("exit", code); child.emit("close", code); });
      };
      stdin.on("data", (chunk) => {
        raw += chunk;
        if (!raw.includes("\n") || started) return;
        started = true;
        const request = JSON.parse(raw) as { patches: string[] };
        const patch = JSON.parse(readFileSync(request.patches[0]!, "utf8")) as Array<{ insert: Array<{ config: { providers: Record<string, { baseURL: string }> } }> }>;
        const url = patch[0]!.insert[0]!.config.providers["sigma-gateway"]!.baseURL;
        void script({ url, token: env.SIGMA_AI_GATEWAY_TOKEN! }).then((lines) => {
          if (ended) return;
          for (const line of lines) stdout.write(`${JSON.stringify(line)}\n`);
          finish(0);
        });
      });
      stdin.on("end", () => finish(130));
      return child;
    };
  }
  const chat = (relay: Relay) => fetch(`${relay.url}/chat/completions`, {
    method: "POST", body: JSON.stringify({ messages: [] }), headers: { authorization: `Bearer ${relay.token}`, "content-type": "application/json" },
  });
  const done = [{ type: "result", sessionId: "s", finalResponse: "done", endReason: { kind: "stop" } }];

  it("keeps the gateway token in main, in development too, and reports each response's context size", async () => {
    const root = tempRoot();
    const seen: unknown[] = [];
    const upstream: Array<[string, string | null]> = [];
    const harness = new DshHarnessClient({
      ...base(root),
      fetcher: async (url, init) => {
        upstream.push([String(url), new Headers(init?.headers).get("authorization")]);
        await new Response(init?.body).text();
        return new Response(`data: ${JSON.stringify({ id: "gen-1", choices: [{ delta: {} }], usage: { prompt_tokens: 78000, completion_tokens: 400 } })}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } });
      },
      spawnBridge: httpBridge(async (relay) => {
        await (await chat(relay)).text();
        return done;
      }),
    });
    const result = await harness.runTurn({ ...turn("run-usage", path.join(root, "ws")), onContextUsage: usage => seen.push(usage) });
    expect(result).toMatchObject({ isError: false, finalText: "done" });
    expect(upstream).toEqual([["https://gateway.example.test/v1/chat/completions", `Bearer ${TOKEN}`]]);
    expect(seen).toEqual([{ usedTokens: 78400, windowTokens: 1_048_576 }]);
  });

  it("stops the turn at once when the week's allowance is used up, and says so instead of 'cancelled'", async () => {
    const root = tempRoot();
    let calls = 0;
    const harness = new DshHarnessClient({
      ...base(root),
      fetcher: async (_url, init) => {
        calls += 1;
        await new Response(init?.body).text();
        return Response.json({ error: { code: "USAGE_LIMIT_REACHED", message: "used", resetsAt: "2026-12-05T03:14:00.000Z" } }, { status: 402 });
      },
      // DSH は断られた後も続けようとする。その前に止まること。
      spawnBridge: httpBridge(async (relay) => {
        await (await chat(relay)).text();
        await new Promise(resolve => setTimeout(resolve, 200));
        return done;
      }),
    });
    const result = await harness.runTurn(turn("run-limit", path.join(root, "ws")));
    expect(result).toMatchObject({
      isError: true, cancelled: false, errorMessage: "USAGE_LIMIT_REACHED",
      refusal: { status: 402, code: "USAGE_LIMIT_REACHED", resetsAt: "2026-12-05T03:14:00.000Z" },
    });
    expect(calls).toBe(1);
    expect(readdirSync(path.join(root, "patches"))).toEqual([]);
  });

  it("lets a brief rate limit pass if the agent recovers, and names it if the turn fails", async () => {
    const root = tempRoot();
    const limited = async (_url: unknown, init?: RequestInit) => {
      await new Response(init?.body).text();
      return Response.json({ error: { code: "RATE_LIMITED", message: "slow down" } }, { status: 429, headers: { "retry-after": "60" } });
    };
    const recovered = new DshHarnessClient({ ...base(root), fetcher: limited as typeof fetch,
      spawnBridge: httpBridge(async (relay) => { await (await chat(relay)).text(); return done; }) });
    expect(await recovered.runTurn(turn("run-429-ok", path.join(root, "ws")))).toEqual({ finalText: "done", sessionId: "s", isError: false, errorMessage: null, cancelled: false });

    const failed = new DshHarnessClient({ ...base(root), fetcher: limited as typeof fetch,
      spawnBridge: httpBridge(async (relay) => {
        await (await chat(relay)).text();
        return [{ type: "result", sessionId: "s", finalResponse: "", endReason: { kind: "error", message: "429 slow down" } }];
      }) });
    expect(await failed.runTurn(turn("run-429", path.join(root, "ws")))).toMatchObject({
      isError: true, errorMessage: "429 slow down", refusal: { status: 429, code: "RATE_LIMITED", resetsAt: null },
    });
  });

  it("reads the account's allowance from the gateway, or nothing when the gateway has none to give", async () => {
    const root = tempRoot();
    const seen: unknown[] = [];
    const asked: Array<[string, string | null]> = [];
    let answer: Response = Response.json({ plan: "pro", included: true, weekly: { usedRatio: 0.25, resetsAt: "2026-12-05T03:14:00.000Z", reached: false } });
    const harness = new DshHarnessClient({
      ...base(root), onAccountUsage: usage => seen.push(usage),
      fetcher: async (url, init) => { asked.push([String(url), new Headers(init?.headers).get("authorization")]); return answer.clone(); },
    });
    const usage = await harness.getUsage(1000);
    expect(usage).toMatchObject({ provider: "sigma", state: "available", plan: "pro", observedAt: 1000, windows: [{ kind: "weekly", usedRatio: 0.25 }] });
    expect(asked).toEqual([["https://gateway.example.test/v1/usage", `Bearer ${TOKEN}`]]);
    expect(seen).toEqual([usage]);
    // 使用量を返さない中継 (開発用の代わり) ・読めない応答では、何も覚えさせない。
    answer = new Response(null, { status: 404 });
    expect(await harness.getUsage()).toBeNull();
    answer = Response.json({ object: "list" });
    expect(await harness.getUsage()).toBeNull();
    expect(seen).toHaveLength(1);
    expect(await new DshHarnessClient({ ...base(root), env: { PATH: "/usr/bin" } }).getUsage()).toBeNull();
  });

  it("in a packaged build, asks the gateway whether the plan includes SIGMA AI, and falls back to the plan name only when it cannot answer", async () => {
    const root = tempRoot();
    const account = { authorization: async () => "Bearer account-credential", accountSignal: () => new AbortController().signal };
    const packaged = (fetcher: typeof fetch, entitled: () => Promise<boolean>) => new DshHarnessClient({
      ...base(root), env: { PATH: "/usr/bin" }, packaged: true, gatewayAccount: account, fetcher, entitled,
    });
    const never = async () => { throw new Error("the plan name must not be asked"); };
    // 上位プラン: アプリはプラン名を知らなくても、中継が「含む」と答えれば使える。
    const max = packaged(async () => Response.json({ plan: "max", included: true, weekly: { usedRatio: 0, resetsAt: null, reached: false } }), never);
    expect((await max.getStatus()).unavailableReason).not.toBe("plan");
    const free = packaged(async () => Response.json({ plan: "free", included: false, weekly: null }), never);
    expect((await free.getStatus()).unavailableReason).toBe("plan");
    // 中継が答えないとき (通信不可・使用量を返さない古い中継) は、これまでどおりプラン名で確かめる。
    let asked = 0;
    const old = packaged(async () => new Response(null, { status: 404 }), async () => { asked += 1; return true; });
    expect((await old.getStatus()).unavailableReason).not.toBe("plan");
    expect(asked).toBe(1);
  });
});
