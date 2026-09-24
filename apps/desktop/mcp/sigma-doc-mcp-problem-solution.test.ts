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
  const solution = { solutions: [{ type: "author", content: "synthetic private answer" }] };
  const getProblemSolution = vi.fn().mockResolvedValue({ ok: true, solution });
  server = createAiRenderBridgeServer({ token: "local-test-token", getProblemSolution,
    renderPageContext: vi.fn(), renderSvg: vi.fn(), parseDocument: (value) => value });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing address");
  const url = `http://127.0.0.1:${address.port}`;
  const bridgeStore = new LocalAiRenderBridgeStore(root);
  await bridgeStore.write({ version: 1, url, token: "local-test-token", pid: process.pid, createdAt: new Date().toISOString() });
  vi.stubEnv(SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV, bridgeStore.getBridgeFilePath());
  vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", root);
  const unauthorized = await fetch(`${url}/problem-solution`, { method: "POST", body: '{"problemId":"123"}' });
  expect(unauthorized.status).toBe(401);
  expect(getProblemSolution).not.toHaveBeenCalled();
  const mcp = createSigmaDocMcpServer({ toolProfile: "app" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "solution-test", version: "1" });
  await mcp.connect(serverTransport);
  await client.connect(clientTransport);
  const tool = (await client.listTools()).tools.find((value) => value.name === "get_problem_solution");
  expect(tool?.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
  const response = await client.callTool({ name: "get_problem_solution", arguments: { problemId: "123" } });
  expect(response.structuredContent).toMatchObject({ ok: true, data: { problemId: "123", solution } });
  expect(getProblemSolution).toHaveBeenCalledExactlyOnceWith({ problemId: "123" });
  expect((await client.callTool({ name: "get_problem_solution", arguments: { problemId: "../secret" } })).isError).toBe(true);
  expect(getProblemSolution).toHaveBeenCalledTimes(1);
  getProblemSolution.mockRejectedValue(new Error("private exception must not escape"));
  const failed = await client.callTool({ name: "get_problem_solution", arguments: { problemId: "123" } });
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain("private exception");
  const persisted = await fs.readFile(bridgeStore.getBridgeFilePath(), "utf8");
  expect(persisted).not.toContain("synthetic private answer");
  await bridgeStore.clear();
  expect((await client.callTool({ name: "get_problem_solution", arguments: { problemId: "123" } })).isError).toBe(true);
});
