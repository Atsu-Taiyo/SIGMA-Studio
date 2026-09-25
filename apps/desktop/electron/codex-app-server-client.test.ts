import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { CodexAppServerClient, parseCodexReconnectProgress } from "./codex-app-server-client";

const tempDirs: string[] = [];

interface ClientFixture {
  client: CodexAppServerClient;
  dir: string;
  codexHome: string;
  codexWorkspace: string;
  fakeCodexBin: string;
}

interface FakeCapture {
  processCwd: string;
  threadCwd?: string;
  resumeCwd?: string;
  turnCwd?: string;
  env: Record<string, string | undefined>;
}

const TEST_CONFIG_TOML = [
  'approval_policy = "never"',
  'sandbox_mode = "read-only"',
  'web_search = "disabled"',
  "",
  "[tools]",
  "view_image = true",
  "",
  "[mcp_servers.sigma-studio-local]",
  'command = "/path/to/electron"',
  'args = ["/path/to/sigma-doc-mcp-server.cjs"]',
  "",
].join("\n");

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("CodexAppServerClient", () => {
  it("initializes the app-server and reads account status", async () => {
    const { client } = createClient();

    const status = await client.getStatus();
    client.dispose();

    expect(status.available).toBe(true);
    expect(status.running).toBe(true);
    expect(status.loggedIn).toBe(true);
    expect(status.account).toEqual({
      type: "chatgpt",
      email: "teacher@example.com",
      planType: "plus",
    });
  });

  it("lists runtime models with each model's supported reasoning efforts", async () => {
    const { client } = createClient();

    const catalog = await client.listModels();
    client.dispose();

    expect(catalog.models).toEqual([
      {
        id: "gpt-runtime-default",
        label: "GPT Runtime Default",
        description: "Current default",
        isDefault: true,
        defaultReasoningEffort: "high",
        supportedReasoningEfforts: [
          { id: "low", description: "Fast" },
          { id: "high", description: "Deep" },
        ],
      },
      {
        id: "gpt-runtime-next",
        label: "GPT Runtime Next",
        isDefault: false,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [{ id: "max", description: "Maximum" }],
      },
    ]);
  });

  it("matches turn responses and streams deltas", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const deltas: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "通常turn", text_elements: [] }],
      onDelta: (delta) => deltas.push(delta),
    });
    client.dispose();

    expect(result.threadId).toBe(thread.threadId);
    expect(result.turnId).toBe("turn_1");
    expect(result.finalText).toBe("FINAL_TEXT");
    expect(deltas.join("")).toContain('"summary":"ok"');
  });

  it("passes reasoning effort to threads and turns", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test", "high");
    const resumed = await client.resumeThread("thread_saved", "gpt-test", "xhigh");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      reasoningEffort: "xhigh",
      input: [{ type: "text", text: "EFFORT", text_elements: [] }],
    });
    client.dispose();

    expect(thread.threadId).toBe("thread_1_high");
    expect(resumed.threadId).toBe("thread_saved_xhigh");
    expect(result.finalText).toBe("EFFORT:xhigh");
  });

  it("writes the exact configToml passed in options to CODEX_HOME/config.toml", async () => {
    const { client, codexHome } = createClient();

    await client.startThread("gpt-test");
    client.dispose();

    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(TEST_CONFIG_TOML);
  });

  it("completes a turn normally when the app-server reports an mcpToolCall item (MCP tools are allowed)", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const notifications: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "MCP_TOOL", text_elements: [] }],
      onNotification: (notification) => notifications.push(notification.method),
    });
    client.dispose();

    expect(result.finalText).toBe("MCP_FINAL");
    expect(notifications).toContain("item/started");
  });

  it("auto-approves MCP tool elicitation requests for sigma-studio-local", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "ELICIT_SIGMA", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("APPROVED");
  });

  it("rejects MCP tool elicitation requests from servers other than sigma-studio-local", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "ELICIT_OTHER", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("OTHER_REJECTED");
  });

  it("rejects MCP tool elicitation requests without a serverName", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "ELICIT_NO_SERVER", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("NO_SERVER_REJECTED");
  });

  it("auto-approves elicitation requests that arrive before the turn/start response", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "ELICIT_EARLY", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("EARLY_APPROVED");
  });

  it("responds with an unsupported error to unknown server requests during an active turn", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "UNKNOWN_REQUEST", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("UNKNOWN_REJECTED");
  });

  it("preserves pre-existing files in the dedicated workspace across start", async () => {
    // codexWorkspace persists across (re)spawns: LocalAiResourceStore.syncToRuntimeTargets()
    // materializes AGENTS.md / .agents/skills/** into it, and ai-edit:run syncs those AI
    // resources *before* the provider runs (main.ts). Wiping the workspace on start would
    // delete that turn's AI resources. See #168, which deliberately removed the wipe.
    const { client, codexWorkspace } = createClient();
    try {
      mkdirSync(codexWorkspace, { recursive: true });
      writeFileSync(path.join(codexWorkspace, "AGENTS.md"), "synced agent resources", "utf8");

      await client.startThread("gpt-test");

      expect(existsSync(path.join(codexWorkspace, "AGENTS.md"))).toBe(true);
      expect(readFileSync(path.join(codexWorkspace, "AGENTS.md"), "utf8")).toBe("synced agent resources");
    } finally {
      client.dispose();
    }
  });

  it("uses an empty dedicated workspace cwd and filters inherited environment variables", async () => {
    const secretKey = "SECRET_FOR_CODEX_APP_SERVER_CLIENT_TEST";
    const previousSecret = process.env[secretKey];
    const previousRustLog = process.env.RUST_LOG;
    const previousLocale = process.env.LC_CODEX_CLIENT_TEST;
    process.env[secretKey] = "should-not-leak";
    process.env.RUST_LOG = "debug";
    process.env.LC_CODEX_CLIENT_TEST = "ja_JP.UTF-8";
    const { client, dir, codexHome, codexWorkspace } = createClient();
    try {
      const thread = await client.startThread("gpt-test");
      await client.resumeThread("thread_saved", "gpt-test");
      await client.runTurn({
        threadId: thread.threadId,
        model: "gpt-test",
        input: [{ type: "text", text: "通常turn", text_elements: [] }],
      });

      const capture = readFakeCapture(dir);
      expect(realpathSync(capture.processCwd)).toBe(realpathSync(codexWorkspace));
      expect(capture.threadCwd).toBe(codexWorkspace);
      expect(capture.resumeCwd).toBe(codexWorkspace);
      expect(capture.turnCwd).toBe(codexWorkspace);
      expect(capture.env.CODEX_HOME).toBe(codexHome);
      expect(capture.env.CODEX_SQLITE_HOME).toBe(codexHome);
      expect(capture.env[secretKey]).toBeUndefined();
      expect(capture.env.RUST_LOG).toBeUndefined();
      expect(capture.env.LC_CODEX_CLIENT_TEST).toBe("ja_JP.UTF-8");
      if (process.env.PATH) {
        expect(capture.env.PATH?.startsWith(process.env.PATH)).toBe(true);
        expect(capture.env.PATH).toContain(path.join(process.env.HOME ?? "", "Library", "pnpm", "bin"));
      }
      expect(codexWorkspace).not.toBe(codexHome);
    } finally {
      restoreEnv(secretKey, previousSecret);
      restoreEnv("RUST_LOG", previousRustLog);
      restoreEnv("LC_CODEX_CLIENT_TEST", previousLocale);
      client.dispose();
    }
  });

  it("uses a per-run cwd override on thread/start, thread/resume, and turn/start when provided (workspace-scoped agent directory)", async () => {
    const { client, dir, codexWorkspace } = createClient();
    const perRunCwd = path.join(dir, "agent-workspaces", "ws_1", "codex");
    try {
      const thread = await client.startThread("gpt-test", null, null, perRunCwd);
      await client.resumeThread("thread_saved", "gpt-test", null, null, perRunCwd);
      await client.runTurn({
        threadId: thread.threadId,
        model: "gpt-test",
        input: [{ type: "text", text: "通常turn", text_elements: [] }],
        cwd: perRunCwd,
      });

      const capture = readFakeCapture(dir);
      expect(capture.threadCwd).toBe(perRunCwd);
      expect(capture.resumeCwd).toBe(perRunCwd);
      expect(capture.turnCwd).toBe(perRunCwd);
      // app-serverプロセス自体のspawn cwdは、per-run cwdに関係なく常にcodexWorkspaceのまま。
      expect(realpathSync(capture.processCwd)).toBe(realpathSync(codexWorkspace));
      expect(existsSync(perRunCwd)).toBe(true);
    } finally {
      client.dispose();
    }
  });

  it("falls back to codexWorkspace on thread/start, thread/resume, and turn/start when no per-run cwd is given", async () => {
    const { client, dir, codexWorkspace } = createClient();
    try {
      const thread = await client.startThread("gpt-test");
      await client.resumeThread("thread_saved", "gpt-test");
      await client.runTurn({
        threadId: thread.threadId,
        model: "gpt-test",
        input: [{ type: "text", text: "通常turn", text_elements: [] }],
      });

      const capture = readFakeCapture(dir);
      expect(capture.threadCwd).toBe(codexWorkspace);
      expect(capture.resumeCwd).toBe(codexWorkspace);
      expect(capture.turnCwd).toBe(codexWorkspace);
    } finally {
      client.dispose();
    }
  });

  it("handles notifications emitted immediately after the turn/start response", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "IMMEDIATE", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("IMMEDIATE_TEXT");
  });

  it("does not interrupt read-only command execution used to load a skill", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const refusals: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "READ_SKILL", text_elements: [] }],
      onRefusal: (itemType) => refusals.push(itemType),
    });
    client.dispose();

    expect(result.finalText).toBe("SKILL_READ_FINAL");
    expect(result.refusedItemTypes).toBeUndefined();
    expect(refusals).toEqual([]);
  });

  it("delivers native image generation notifications without interrupting the turn", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const notifications: string[] = [];
    try {
      const result = await client.runTurn({ threadId: thread.threadId, input: [{ type: "text", text: "IMAGE_GENERATION", text_elements: [] }],
        onNotification: (notification) => { notifications.push(notification.method); },
      });
      expect(result.refusedItemTypes).toBeUndefined();
      expect(result.finalText).toBe("IMAGE_READY");
      expect(notifications).toEqual(expect.arrayContaining(["item/started", "item/completed", "turn/completed"]));
    } finally { client.dispose(); }
  });

  it("refuses forbidden operations without rejecting the turn", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const refusals: Array<[string, string | undefined]> = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "FORBIDDEN", text_elements: [] }],
      onRefusal: (itemType, itemId) => refusals.push([itemType, itemId]),
    });
    client.dispose();

    expect(result.refusedItemTypes).toEqual(["fileChange"]);
    expect(result.finalText).toBe("PARTIAL");
    // itemId は呼び出し側が既に開いた活動行を閉じるために必要。
    expect(refusals).toEqual([["fileChange", "item_file_1"]]);
  });

  it("records every distinct forbidden item type attempted while the interrupt is in flight", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const refusals: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "FORBIDDEN_MULTI", text_elements: [] }],
      onRefusal: (itemType) => refusals.push(itemType),
    });
    client.dispose();

    expect(result.refusedItemTypes).toEqual(["fileChange", "collabAgentToolCall"]);
    expect(refusals).toEqual(["fileChange", "collabAgentToolCall"]);
  });

  it("cancels a turn even while a refusal interrupt is still in flight", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    let refusalStarted = false;
    const runTurnPromise = client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "FORBIDDEN_SLOW_INTERRUPT", text_elements: [] }],
      runId: "run_cancel_during_refusal",
      onRefusal: () => { refusalStarted = true; },
    });

    await vi.waitFor(() => expect(refusalStarted).toBe(true));
    expect(client.cancelByRunId("run_cancel_during_refusal")).toBe(true);

    const result = await runTurnPromise;
    client.dispose();

    expect(result.cancelled).toBe(true);
    expect(result.refusedItemTypes).toEqual(["fileChange"]);
  });

  it("still interrupts and settles the turn when the refusal activity callback throws", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    // FORBIDDEN_ABORTED は turn/interrupt を受けるまで何も返さないので、
    // コールバックが例外を投げて interrupt が飛ばないとturnは永久に未解決になる。
    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "FORBIDDEN_ABORTED", text_elements: [] }],
      timeoutMs: 3000,
      onRefusal: () => {
        throw new Error("renderer window was destroyed");
      },
    });
    client.dispose();

    expect(result.refusedItemTypes).toEqual(["fileChange"]);
  });

  it("resolves (not rejects) when the interrupted turn reports a non-completed status afterwards", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "FORBIDDEN_ABORTED", text_elements: [] }],
    });
    client.dispose();

    expect(result.refusedItemTypes).toEqual(["fileChange"]);
    expect(result.turnId).toBe("turn_1");
  });

  it("refuses webSearch items once when web search is disabled (default)", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const refusals: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "WEBSEARCH", text_elements: [] }],
      onRefusal: (itemType) => refusals.push(itemType),
    });
    client.dispose();

    // item/started と item/completed の両方が禁止判定に入るが、拒否は1回だけ記録する。
    expect(result.refusedItemTypes).toEqual(["webSearch"]);
    expect(refusals).toEqual(["webSearch"]);
  });

  it("keeps the turn alive while the app-server reports a retryable reconnect", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");
    const errorNotifications: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "RECONNECT_THEN_OK", text_elements: [] }],
      onNotification: (notification) => {
        if (notification.method === "error") {
          errorNotifications.push(String(notification.params?.error));
        }
      },
    });
    client.dispose();

    expect(result.finalText).toBe("RECONNECT_FINAL");
    expect(result.refusedItemTypes).toBeUndefined();
    // 再接続中であることは活動ログ用に呼び出し側へ通知される (黙って握り潰さない)。
    expect(errorNotifications).toHaveLength(1);
  });

  it("rejects only on the app-server's own retry-limit error, not on the last reconnect attempt", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    // "Reconnecting... 5/5" is the last attempt being made, not the failure;
    // codex reports exhaustion with a separate terminal error.
    await expect(client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "RECONNECT_EXHAUSTED", text_elements: [] }],
    })).rejects.toThrow("exceeded retry limit, last status: 500");
    client.dispose();
  });

  it("still rejects non-transient turn errors", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    await expect(client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "TURN_ERROR", text_elements: [] }],
    })).rejects.toThrow("upstream exploded");
    client.dispose();
  });

  it("falls back to a Japanese message when a turn error carries no message", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    await expect(client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "TURN_ERROR_EMPTY", text_elements: [] }],
    })).rejects.toThrow("Codex turnでエラーが発生しました。");
    client.dispose();
  });

  it("allows webSearch items when web search is enabled", async () => {
    const { client } = createClient({ webSearchEnabled: true });
    const thread = await client.startThread("gpt-test");
    const notifications: string[] = [];

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "WEBSEARCH", text_elements: [] }],
      onNotification: (notification) => notifications.push(notification.method),
    });
    client.dispose();

    expect(result.finalText).toBe("WEBSEARCH_FINAL");
    expect(notifications).toContain("item/started");
  });

  it("setWebSearchEnabled(true) lets a previously-forbidden webSearch item through", async () => {
    const { client } = createClient();
    client.setWebSearchEnabled(true);
    const thread = await client.startThread("gpt-test");

    const result = await client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "WEBSEARCH", text_elements: [] }],
    });
    client.dispose();

    expect(result.finalText).toBe("WEBSEARCH_FINAL");
  });

  it("setWebSearchEnabled rebuilds config.toml via buildConfigToml and rewrites it on the next spawn", async () => {
    const { client, codexHome } = createClient({
      webSearchEnabled: false,
      buildConfigToml: (enabled) => (enabled ? 'web_search = "live"\n' : TEST_CONFIG_TOML),
    });

    await client.startThread("gpt-test");
    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe(TEST_CONFIG_TOML);

    // アイドル時 (activeTurns なし) の設定変更: dispose → 次の呼び出しで再spawnし、
    // 新しい configToml が書き出される。
    client.setWebSearchEnabled(true);
    await client.startThread("gpt-test");
    client.dispose();

    expect(readFileSync(path.join(codexHome, "config.toml"), "utf8")).toBe('web_search = "live"\n');
  });

  it("cancels an active turn by runId and resolves with a cancelled result instead of rejecting", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    const runTurnPromise = client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "HANG", text_elements: [] }],
      runId: "run_cancel_1",
    });

    // A busy runner may take longer than a fixed delay to register turn/start.
    // False means no turn was touched; stop as soon as cancellation is accepted.
    await vi.waitFor(() => expect(client.cancelByRunId("run_cancel_1")).toBe(true));

    const result = await runTurnPromise;
    client.dispose();

    expect(result.cancelled).toBe(true);
    expect(result.threadId).toBe(thread.threadId);
  });

  it("cancelByRunId is idempotent and returns false for an unknown or already-settled run", async () => {
    const { client } = createClient();
    const thread = await client.startThread("gpt-test");

    expect(client.cancelByRunId("nope")).toBe(false);

    const runTurnPromise = client.runTurn({
      threadId: thread.threadId,
      model: "gpt-test",
      input: [{ type: "text", text: "HANG", text_elements: [] }],
      runId: "run_cancel_2",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(client.cancelByRunId("run_cancel_2")).toBe(true);
    // Second cancel on the same runId: turn already completed/removed, so this
    // is a no-op rather than throwing or resolving twice.
    expect(client.cancelByRunId("run_cancel_2")).toBe(false);

    const result = await runTurnPromise;
    client.dispose();

    expect(result.cancelled).toBe(true);
  });

  it("can restart after the app-server process crashes", async () => {
    const { client } = createClient();

    await expect(client.startThread("crash")).rejects.toThrow("終了");
    const statusAfterRestart = await client.getStatus();
    client.dispose();

    expect(statusAfterRestart.running).toBe(true);
    expect(statusAfterRestart.loggedIn).toBe(true);
  });

  it("rejects startup promptly when app-server spawn fails after the availability probe", async () => {
    const { client } = createClient({}, SELF_DELETING_CODEX_BIN);

    await expect(client.startThread("gpt-test")).rejects.toThrow("起動できませんでした");
    client.dispose();
  });

  it("reprobes Codex availability after an unavailable result", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-app-server-"));
    tempDirs.push(dir);
    const fakeCodexBin = path.join(dir, "codex");
    const client = new CodexAppServerClient({
      codexHome: path.join(dir, "codex-home"),
      codexBin: fakeCodexBin,
      configToml: TEST_CONFIG_TOML,
      uiLocale: "ja",
    });

    const unavailable = await client.getStatus();
    expect(unavailable.available).toBe(false);

    writeFileSync(fakeCodexBin, FAKE_CODEX_BIN, "utf8");
    chmodSync(fakeCodexBin, 0o755);

    const available = await client.getStatus();
    client.dispose();

    expect(available.available).toBe(true);
    expect(available.loggedIn).toBe(true);
  });

  it("accepts quoted configured Codex binary paths", async () => {
    const { client, fakeCodexBin } = createClient();

    client.setCodexBin(`"${fakeCodexBin}"`);
    const status = await client.getStatus();
    client.dispose();

    expect(status.available).toBe(true);
    expect(status.codexBin).toBe(fakeCodexBin);
    expect(status.configuredCodexBin).toBe(fakeCodexBin);
  });

  it("finds Codex in the pnpm home bin when no explicit binary is configured", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-app-server-"));
    tempDirs.push(dir);
    const oldHome = process.env.HOME;
    const oldPath = process.env.PATH;
    const fakeCodexDir = path.join(dir, "Library", "pnpm", "bin");
    const fakeCodexBin = path.join(fakeCodexDir, "codex");
    mkdirSync(fakeCodexDir, { recursive: true });
    writeFileSync(fakeCodexBin, FAKE_CODEX_BIN, "utf8");
    chmodSync(fakeCodexBin, 0o755);
    process.env.HOME = dir;
    process.env.PATH = path.dirname(process.execPath);

    const client = new CodexAppServerClient({
      codexHome: path.join(dir, "codex-home"),
      configToml: TEST_CONFIG_TOML,
      uiLocale: "ja",
    });

    try {
      const status = await client.getStatus();

      expect(status.available).toBe(true);
      expect(status.codexBin).toBe(fakeCodexBin);
      expect(status.configuredCodexBin).toBeNull();
    } finally {
      client.dispose();
      restoreEnv("HOME", oldHome);
      restoreEnv("PATH", oldPath);
    }
  });
});

describe("parseCodexReconnectProgress", () => {
  it("parses the app-server reconnect progress message", () => {
    expect(parseCodexReconnectProgress("Reconnecting... 2/5")).toEqual({ attempt: 2, maxAttempts: 5 });
  });

  it("tolerates surrounding whitespace and casing variations", () => {
    expect(parseCodexReconnectProgress("  reconnecting...  10 / 12  extra")).toEqual({ attempt: 10, maxAttempts: 12 });
  });

  it("returns null for real errors and for non-string input", () => {
    expect(parseCodexReconnectProgress("upstream exploded")).toBeNull();
    expect(parseCodexReconnectProgress("Reconnecting...")).toBeNull();
    expect(parseCodexReconnectProgress("failed after Reconnecting... 2/5")).toBeNull();
    expect(parseCodexReconnectProgress(undefined)).toBeNull();
  });
});

function createClient(
  optionOverrides: Partial<ConstructorParameters<typeof CodexAppServerClient>[0]> = {},
  binSource = FAKE_CODEX_BIN,
): ClientFixture {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-codex-app-server-"));
  tempDirs.push(dir);
  const fakeCodexBin = path.join(dir, "codex");
  const codexHome = path.join(dir, "codex-home");
  const codexWorkspace = path.join(dir, "codex-agent-workspace");
  writeFileSync(fakeCodexBin, binSource, "utf8");
  chmodSync(fakeCodexBin, 0o755);

  return {
    dir,
    codexHome,
    codexWorkspace,
    fakeCodexBin,
    client: new CodexAppServerClient({
      codexHome,
      codexBin: fakeCodexBin,
      configToml: TEST_CONFIG_TOML,
      uiLocale: "ja",
      ...optionOverrides,
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

const FAKE_CODEX_BIN = `#!/usr/bin/env node
const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");

if (process.argv.includes("--version")) {
  console.log("codex-fake 1.0.0");
  process.exit(0);
}

if (!process.argv.includes("app-server")) {
  process.exit(2);
}

const rl = readline.createInterface({ input: process.stdin });
let threadCounter = 0;
let turnCounter = 0;
// FORBIDDEN_ABORTED: 実サーバーと同じく turn/interrupt を受けてから
// 非completedの turn/completed を送るため、直近turnを覚えておく。
let abortOnInterrupt = null;
// FORBIDDEN_SLOW_INTERRUPT: turn/interrupt の応答を遅らせて、拒否の割り込み中に
// ユーザーがキャンセルする窓を再現する。
let slowInterrupt = false;
const pendingServerRequests = new Map();

function sendServerRequest(id, method, params, onResponse) {
  pendingServerRequests.set(id, onResponse);
  send({ id, method, params });
}
const capturePath = process.env.CODEX_HOME ? path.join(process.env.CODEX_HOME, "..", "fake-capture.json") : null;
const capture = {
  processCwd: process.cwd(),
  env: process.env,
};

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function writeCapture(patch) {
  if (!capturePath) {
    return;
  }
  Object.assign(capture, patch);
  fs.writeFileSync(capturePath, JSON.stringify(capture, null, 2));
}

writeCapture({});

rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === undefined) {
    const waiter = pendingServerRequests.get(message.id);
    if (waiter) {
      pendingServerRequests.delete(message.id);
      waiter(message);
    }
    return;
  }
  if (message.method === "initialized") {
    return;
  }

  if (message.method === "initialize") {
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "account/read") {
    send({
      id: message.id,
      result: {
        requiresOpenaiAuth: false,
        account: { type: "chatgpt", email: "teacher@example.com", planType: "plus" },
      },
    });
    return;
  }

  if (message.method === "account/login/start") {
    send({ id: message.id, result: { authUrl: "https://example.com/login", loginId: "login_1" } });
    send({ method: "account/login/completed", params: {} });
    return;
  }

  if (message.method === "account/logout") {
    send({ id: message.id, result: {} });
    return;
  }

  if (message.method === "model/list") {
    if (message.params && message.params.cursor === "page_2") {
      send({
        id: message.id,
        result: {
          data: [{
            id: "catalog-next",
            model: "gpt-runtime-next",
            displayName: "GPT Runtime Next",
            description: "",
            hidden: false,
            isDefault: false,
            defaultReasoningEffort: "max",
            supportedReasoningEfforts: [{ reasoningEffort: "max", description: "Maximum" }],
          }],
          nextCursor: null,
        },
      });
      return;
    }
    send({
      id: message.id,
      result: {
        data: [{
          id: "catalog-default",
          model: "gpt-runtime-default",
          displayName: "GPT Runtime Default",
          description: "Current default",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "high",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        }],
        nextCursor: "page_2",
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    if (message.params && message.params.model === "crash") {
      process.exit(0);
      return;
    }
    writeCapture({
      threadCwd: message.params && message.params.cwd,
    });
    threadCounter += 1;
    const effortSuffix = message.params && message.params.reasoningEffort ? "_" + message.params.reasoningEffort : "";
    send({ id: message.id, result: { thread: { id: "thread_" + threadCounter + effortSuffix } } });
    return;
  }

  if (message.method === "thread/resume") {
    writeCapture({ resumeCwd: message.params && message.params.cwd });
    const effortSuffix = message.params && message.params.reasoningEffort ? "_" + message.params.reasoningEffort : "";
    send({ id: message.id, result: { thread: { id: message.params.threadId + effortSuffix } } });
    return;
  }

  if (message.method === "turn/start") {
    writeCapture({ turnCwd: message.params && message.params.cwd });
    turnCounter += 1;
    const turnId = "turn_" + turnCounter;
    const firstInput = message.params.input && message.params.input[0];
    const text = firstInput && firstInput.text ? firstInput.text : "";
    const completeTurn = (finalText) => {
      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: finalText } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
    };
    if (text.includes("ELICIT_EARLY")) {
      sendServerRequest(901, "mcpServer/elicitation/request", {
        threadId: message.params.threadId,
        turnId,
        serverName: "sigma-studio-local",
        mode: "form",
        message: "MCP tool call approval",
        requestedSchema: { type: "object", properties: {} },
      }, (response) => {
        const accepted = !response.error && response.result && response.result.action === "accept";
        completeTurn(accepted ? "EARLY_APPROVED" : "EARLY_WRONG_RESPONSE");
      });
      send({ id: message.id, result: { turn: { id: turnId } } });
      return;
    }
    send({ id: message.id, result: { turn: { id: turnId } } });
    if (text.includes("ELICIT_SIGMA")) {
      sendServerRequest(900, "mcpServer/elicitation/request", {
        threadId: message.params.threadId,
        turnId,
        serverName: "sigma-studio-local",
        mode: "form",
        message: "MCP tool call approval",
        requestedSchema: { type: "object", properties: {} },
      }, (response) => {
        const accepted = !response.error && response.result && response.result.action === "accept";
        completeTurn(accepted ? "APPROVED" : "SIGMA_WRONG_RESPONSE");
      });
      return;
    }
    if (text.includes("ELICIT_OTHER")) {
      sendServerRequest(902, "mcpServer/elicitation/request", {
        threadId: message.params.threadId,
        turnId,
        serverName: "codex_apps",
        mode: "form",
        message: "MCP tool call approval",
        requestedSchema: { type: "object", properties: {} },
      }, (response) => {
        completeTurn(response.error ? "OTHER_REJECTED" : "OTHER_WRONG_RESPONSE");
      });
      return;
    }
    if (text.includes("ELICIT_NO_SERVER")) {
      sendServerRequest(904, "mcpServer/elicitation/request", {
        threadId: message.params.threadId,
        turnId,
        mode: "form",
        message: "MCP tool call approval",
        requestedSchema: { type: "object", properties: {} },
      }, (response) => {
        completeTurn(response.error ? "NO_SERVER_REJECTED" : "NO_SERVER_WRONG_RESPONSE");
      });
      return;
    }
    if (text.includes("UNKNOWN_REQUEST")) {
      sendServerRequest(903, "item/commandExecution/requestApproval", {
        threadId: message.params.threadId,
        turnId,
      }, (response) => {
        const rejected = response.error && String(response.error.message || "").includes("Unsupported");
        completeTurn(rejected ? "UNKNOWN_REJECTED" : "UNKNOWN_WRONG_RESPONSE");
      });
      return;
    }
    if (text.includes("EFFORT")) {
      const finalText = "EFFORT:" + (message.params.reasoningEffort || "none");
      send({ method: "item/agentMessage/delta", params: { turnId, delta: finalText } });
      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: finalText } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
      return;
    }
    if (text.includes("IMMEDIATE")) {
      send({ method: "item/agentMessage/delta", params: { turnId, delta: "IMMEDIATE_DELTA" } });
      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "IMMEDIATE_TEXT" } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
      return;
    }
    if (text.includes("HANG")) {
      // Never responds; used by cancellation tests so the turn stays pending
      // until the client explicitly interrupts it.
      return;
    }
    if (text.includes("MCP_TOOL")) {
      send({
        method: "item/started",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: {
            id: "item_mcp_1",
            type: "mcpToolCall",
            status: "inProgress",
            server: "sigma-studio-local",
            tool: "insert_shape",
          },
        },
      });
      send({
        method: "item/completed",
        params: {
          threadId: message.params.threadId,
          turnId,
          item: {
            id: "item_mcp_1",
            type: "mcpToolCall",
            status: "completed",
            server: "sigma-studio-local",
            tool: "insert_shape",
          },
        },
      });
      send({ method: "item/agentMessage/delta", params: { turnId, delta: "MCP_FINAL" } });
      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "MCP_FINAL" } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
      return;
    }
    setTimeout(() => {
      if (text.includes("READ_SKILL")) {
        send({ method: "item/started", params: { turnId, item: { id: "item_cmd_read", type: "commandExecution" } } });
        send({ method: "item/completed", params: { turnId, item: { id: "item_cmd_read", type: "commandExecution" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "SKILL_READ_FINAL" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (text.includes("FORBIDDEN_ABORTED")) {
        abortOnInterrupt = { turnId: turnId, threadId: message.params.threadId };
        send({ method: "item/started", params: { turnId, item: { type: "fileChange" } } });
        return;
      }
      if (text.includes("FORBIDDEN_SLOW_INTERRUPT")) {
        slowInterrupt = true;
        send({ method: "item/started", params: { turnId, item: { id: "item_file_slow", type: "fileChange" } } });
        return;
      }
      if (text.includes("IMAGE_GENERATION")) {
        send({ method: "item/started", params: { turnId, item: { id: "image_1", type: "imageGeneration", status: "in_progress", result: "" } } });
        send({ method: "item/completed", params: { turnId, item: { id: "image_1", type: "imageGeneration", status: "completed", result: "iVBORw0KGgo=" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "IMAGE_READY" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (text.includes("FORBIDDEN_MULTI")) {
        send({ method: "item/started", params: { turnId, item: { id: "item_file_1", type: "fileChange" } } });
        send({ method: "item/started", params: { turnId, item: { id: "item_agent_1", type: "collabAgentToolCall" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "PARTIAL" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (text.includes("FORBIDDEN")) {
        send({ method: "item/started", params: { turnId, item: { id: "item_file_1", type: "fileChange" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "PARTIAL" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (text.includes("RECONNECT_THEN_OK")) {
        send({ method: "error", params: { turnId, error: { message: "Reconnecting... 2/5" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "RECONNECT_FINAL" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      if (text.includes("RECONNECT_EXHAUSTED")) {
        send({ method: "error", params: { turnId, error: { message: "Reconnecting... 5/5" } } });
        send({ method: "error", params: { turnId, error: { message: "exceeded retry limit, last status: 500" } } });
        return;
      }
      if (text.includes("TURN_ERROR_EMPTY")) {
        send({ method: "error", params: { turnId, error: {} } });
        return;
      }
      if (text.includes("TURN_ERROR")) {
        send({ method: "error", params: { turnId, error: { message: "upstream exploded" } } });
        return;
      }
      if (text.includes("WEBSEARCH")) {
        send({ method: "item/started", params: { turnId, item: { id: "item_ws_1", type: "webSearch", query: "二次関数 最新指導要領" } } });
        send({ method: "item/completed", params: { turnId, item: { id: "item_ws_1", type: "webSearch", query: "二次関数 最新指導要領" } } });
        send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "WEBSEARCH_FINAL" } } });
        send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
        return;
      }
      send({ method: "item/agentMessage/delta", params: { turnId, delta: '{"summary":"ok",' } });
      send({ method: "item/agentMessage/delta", params: { turnId, delta: '"plan":["p"],"warnings":[]}' } });
      send({ method: "item/completed", params: { turnId, item: { type: "agentMessage", text: "FINAL_TEXT" } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: turnId, status: "completed" } } });
    }, 5);
    return;
  }

  if (message.method === "turn/interrupt") {
    if (slowInterrupt) {
      slowInterrupt = false;
      setTimeout(() => send({ id: message.id, result: {} }), 200);
      return;
    }
    send({ id: message.id, result: {} });
    if (abortOnInterrupt) {
      const aborted = abortOnInterrupt;
      abortOnInterrupt = null;
      send({
        method: "turn/completed",
        params: {
          threadId: aborted.threadId,
          turn: { id: aborted.turnId, status: "aborted", error: { message: "turn aborted" } },
        },
      });
    }
    return;
  }

  send({ id: message.id, error: { message: "Unknown method: " + message.method } });
});
`;

const SELF_DELETING_CODEX_BIN = `#!/usr/bin/env node
const fs = require("node:fs");

if (process.argv.includes("--version")) {
  fs.unlinkSync(process.argv[1]);
  console.log("codex-fake 1.0.0");
  process.exit(0);
}

process.exit(2);
`;
