import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, expect, it, vi } from "vitest";
import { createAiRenderBridgeServer, LocalAiRenderBridgeStore, SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV } from "../electron/ai-render-bridge";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";

let root: string;
let server: Server;
let client: Client;
afterEach(async () => {
  await client?.close();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (root) await fs.rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
});

it("serves private reference JSON through authenticated main bridge and the real MCP contract", async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-solution-"));
  const search = { ok: true, results: [{ id: 123, problem_tex: "synthetic private answer", has_solution: true }] };
  const searchProblems = vi.fn().mockResolvedValue({ ok: true, search });
  server = createAiRenderBridgeServer({ token: "local-test-token", searchProblems,
    renderPageContext: vi.fn(), renderSvg: vi.fn(), parseDocument: (value) => value });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  const bridgeStore = new LocalAiRenderBridgeStore(root);
  await bridgeStore.write({ version: 1, url, token: "local-test-token", pid: process.pid, createdAt: new Date().toISOString() });
  vi.stubEnv(SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV, bridgeStore.getBridgeFilePath());
  vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", root);
  const unauthorized = await fetch(`${url}/problem-search`, { method: "POST", body: '{"limit":5}' });
  expect(unauthorized.status).toBe(401);
  expect(searchProblems).not.toHaveBeenCalled();
  const mcp = createSigmaDocMcpServer({ toolProfile: "app" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "solution-test", version: "1" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const tool = (await client.listTools()).tools.find((value) => value.name === "search_problems");
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  const response = await client.callTool({ name: "search_problems", arguments: { category: "整数", sort: "likes", limit: 5 } });
  expect(response.structuredContent).toMatchObject({ ok: true, data: { search } });
  expect(searchProblems).toHaveBeenCalledExactlyOnceWith({ category: "整数", sort: "likes", limit: 5 });
  expect((await client.callTool({ name: "search_problems", arguments: { limit: 51 } })).isError).toBe(true);
  expect(searchProblems).toHaveBeenCalledTimes(1);
  searchProblems.mockRejectedValue(new Error("private exception must not escape"));
  const failed = await client.callTool({ name: "search_problems", arguments: { category: "整数", sort: "likes", limit: 5 } });
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("private exception");
  const persisted = await fs.readFile(bridgeStore.getBridgeFilePath(), "utf8");
  expect(persisted).not.toContain("synthetic private answer");
  await bridgeStore.clear();
  expect((await client.callTool({ name: "search_problems", arguments: { category: "整数", sort: "likes", limit: 5 } })).isError).toBe(true);
});
