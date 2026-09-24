import { existsSync, mkdtempSync, rmSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const APP_ROOT = path.resolve(__dirname, "../..");

test("Electron authenticates to the Worker and serves solutions through its bundled MCP", async () => {
  test.skip(!existsSync(path.join(APP_ROOT, "out/index.html")), "Build the desktop renderer first");
  const profile = mkdtempSync(path.join(os.tmpdir(), "sigma-solution-electron-"));
  const key = "synthetic-electron-key-not-a-real-secret";
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.SIGMA_STUDIO_DEV_SERVER_URL;
  env.SIGMA_STUDIO_USER_DATA_DIR = profile;
  env.SIGMA_API_KEY = "ignored-upstream-secret";
  env.SIGMA_COLLABORATION_URL = "https://worker.example";
  env.SIGMA_SUPABASE_URL = "https://auth.example";
  env.SIGMA_SUPABASE_ANON_KEY = "sb_publishable_synthetic";
  let app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
  const client = new Client({ name: "solution-electron-smoke", version: "1" });
  try {
    await app.firstWindow();
    const encrypted = await app.evaluate(({ safeStorage }, key) => {
      const tokens = { access_token: key, refresh_token: "unused", expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, user: { id: "synthetic-user" } };
      return safeStorage.encryptString(JSON.stringify(tokens)).toString("base64");
    }, key);
    mkdirSync(path.join(profile, "collaboration-v1"), { recursive: true });
    writeFileSync(path.join(profile, "collaboration-v1", "auth.enc"), encrypted);
    await app.close();
    app = await electron.launch({ args: [APP_ROOT], cwd: APP_ROOT, env });
    const page = await app.firstWindow();
    await page.waitForFunction(() => Boolean(window.desktopAPI));
    expect(await app.evaluate(() => process.env.SIGMA_API_KEY)).toBeUndefined();
    // Mock only the remote service. Real Electron main, authenticated HTTP bridge,
    // packaged MCP process and MCP transport remain in the exercised path.
    await app.evaluate((_electron, expectedKey) => {
      const original = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        if (String(input) !== "https://worker.example/integrations/juken/problems/test-123/solution") {
          return original(input, init);
        }
        if (new Headers(init?.headers).get("Authorization") !== `Bearer ${expectedKey}`
          || init?.method !== "GET" || init?.redirect !== "error" || init?.cache !== "no-store") {
          return Response.json({ error: "incorrect request" }, { status: 403 });
        }
        return Response.json({ solutions: [{ type: "editorial", content: "synthetic-private-solution-marker" }] });
      };
    }, key);
    const bridgeFile = path.join(profile, "data", "ai-run-context", "render-bridge.json");
    await expect.poll(() => existsSync(bridgeFile)).toBe(true);
    const execPath = await app.evaluate(() => process.execPath);
    await client.connect(new StdioClientTransport({
      command: execPath,
      args: [path.join(APP_ROOT, "dist-electron", "sigma-doc-mcp-server.cjs")],
      env: {
        PATH: process.env.PATH ?? "", HOME: os.homedir(), ELECTRON_RUN_AS_NODE: "1",
        SIGMA_STUDIO_USER_DATA_DIR: profile,
        SIGMA_STUDIO_RENDER_BRIDGE_FILE: bridgeFile,
        SIGMA_STUDIO_MCP_TOOL_PROFILE: "app",
      },
      stderr: "pipe",
    }));
    const result = await client.callTool({ name: "get_problem_solution", arguments: { problemId: "test-123" } });
    expect(result.structuredContent).toMatchObject({ ok: true, data: {
      problemId: "test-123", solution: { solutions: [{ type: "editorial", content: "synthetic-private-solution-marker" }] },
    } });
    expect(JSON.stringify(result)).not.toContain(key);
    // Neither the key nor the fetched answer should be persisted by this path.
    for (const entry of readdirSync(path.join(profile, "data"), { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const content = readFileSync(path.join(entry.parentPath, entry.name)).toString("utf8");
      expect(content.includes(key)).toBe(false);
      expect(content.includes("synthetic-private-solution-marker")).toBe(false);
    }
  } finally {
    await client.close();
    await app.close();
    rmSync(profile, { recursive: true, force: true });
    expect(existsSync(profile)).toBe(false);
  }
});
