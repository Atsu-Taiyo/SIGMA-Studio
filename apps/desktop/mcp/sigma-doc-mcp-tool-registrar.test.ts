import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { createMcpToolRegistrar, type McpToolRegistrarOptions } from "./sigma-doc-mcp-tool-registrar";
import { withToolErrorHandling } from "./sigma-doc-mcp-response";
import {
  clearSourceLedgerForTests,
  collectUsedSourceReferences,
  recordLibrarySearchHits,
} from "./sigma-doc-mcp-source-ledger";
import { getMcpRunStats, resetMcpRunStats } from "./sigma-doc-mcp-stats";

const servers: McpServer[] = [];
const clients: Client[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const server of servers.splice(0)) await server.close();
  clearSourceLedgerForTests();
  resetMcpRunStats();
});

function createRegistrar(overrides: Partial<McpToolRegistrarOptions> = {}) {
  const server = new McpServer({ name: "registrar-test", version: "1" });
  servers.push(server);
  const options = {
    toolProfile: "external" as const,
    profileGuidance: (description: string) => description,
    activityLogger: vi.fn(),
    visualSessionRunId: vi.fn(() => "session-run"),
    ...overrides,
  };
  return { server, options, ...createMcpToolRegistrar(server, options) };
}

async function connect(server: McpServer): Promise<Client> {
  const client = new Client({ name: "registrar-test", version: "1" });
  clients.push(client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

const successfulResult = () => withToolErrorHandling(async () => ({ ok: true, value: "preserved" }));

describe("MCP tool registration", () => {
  it("publishes tools in declaration order with default and explicit annotations", async () => {
    const { server, registerTool } = createRegistrar({ profileGuidance: (text) => `profile: ${text}` });
    const originalRegisterTool = server.registerTool;
    registerTool("read_local_document", { description: "read", inputSchema: {} }, successfulResult);
    registerTool("delete_local_document", { description: "delete", inputSchema: {} }, successfulResult);
    registerTool("update_ai_settings", {
      description: "settings",
      inputSchema: {},
      annotations: { destructiveHint: true, openWorldHint: true },
    }, successfulResult);

    const client = await connect(server);
    const { tools } = await client.listTools();
    expect(server.registerTool).toBe(originalRegisterTool);
    expect(tools.map(({ name }) => name)).toEqual([
      "read_local_document", "delete_local_document", "update_ai_settings",
    ]);
    expect(tools.map(({ description }) => description)).toEqual(["profile: read", "profile: delete", "profile: settings"]);
    expect(tools.map(({ annotations }) => annotations)).toEqual([
      { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    ]);
    expect(tools.every((tool) => tool.outputSchema?.properties?.ok)).toBe(true);
  });

  it("retains hidden app implementations without executing or publishing them", async () => {
    const { server, registerTool, bodyImplementations, options } = createRegistrar({ toolProfile: "app" });
    const inputSchema = { fileId: z.string() };
    const implementation = vi.fn(successfulResult);
    const registration = registerTool("apply_edits", { inputSchema }, implementation);
    registerTool("visible", { inputSchema: {} }, successfulResult);

    expect(registration).toBeUndefined();
    expect(bodyImplementations.get("apply_edits")).toEqual({ inputSchema, handler: implementation });
    expect(implementation).not.toHaveBeenCalled();
    expect(options.activityLogger).not.toHaveBeenCalled();
    expect((await (await connect(server)).listTools()).tools.map(({ name }) => name)).toEqual(["visible"]);
  });

  it("rejects an app body implementation whose schema cannot supply alias fields", () => {
    const { registerTool, bodyImplementations } = createRegistrar({ toolProfile: "app" });
    expect(() => registerTool("apply_edits", { inputSchema: z.object({}) }, successfulResult))
      .toThrow("Expected a raw input shape for apply_edits");
    expect(bodyImplementations.size).toBe(0);
  });
});

describe("MCP call instrumentation", () => {
  it.each([
    { runId: " explicit-run ", sessionId: "session", expectedRun: "explicit-run", sessionLookups: 0 },
    { runId: " ", sessionId: "session", expectedRun: "session-run", sessionLookups: 1 },
    { runId: undefined, sessionId: "session", expectedRun: "session-run", sessionLookups: 1 },
    { runId: undefined, sessionId: undefined, expectedRun: undefined, sessionLookups: 0 },
  ])("attributes calls to $expectedRun while forwarding unmodified parsed input", async ({ runId, sessionId, expectedRun, sessionLookups }) => {
    const { server, registerTool, options } = createRegistrar();
    const handler = vi.fn<(...args: unknown[]) => ReturnType<typeof successfulResult>>(successfulResult);
    registerTool("read_local_document", {
      inputSchema: { runId: z.string().optional(), sessionId: z.string().optional(), count: z.number().default(3) },
    }, handler);
    const client = await connect(server);
    const input = { ...(runId === undefined ? {} : { runId }), ...(sessionId ? { sessionId } : {}) };
    const result = await client.callTool({ name: "read_local_document", arguments: input });

    expect(result.structuredContent).toEqual({ ok: true, message: "MCPツールを実行しました。", data: { value: "preserved" } });
    expect(handler.mock.calls[0]?.[0]).toEqual({ ...input, count: 3 });
    expect(handler.mock.calls[0]?.[1]).toEqual(expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(options.visualSessionRunId).toHaveBeenCalledTimes(sessionLookups);
    expect(options.activityLogger).toHaveBeenNthCalledWith(1, {
      callId: expect.any(String), tool: "read_local_document", runId: expectedRun, status: "started",
    });
    expect(options.activityLogger).toHaveBeenNthCalledWith(2, {
      callId: expect.any(String), tool: "read_local_document", runId: expectedRun, status: "completed",
    });
    expect(getMcpRunStats(expectedRun).tools.read_local_document.callCount).toBe(1);
  });

  it("records only recognized read calls as source usage before execution begins", async () => {
    const sourcesAtStart: unknown[] = [];
    const { server, registerTool } = createRegistrar({
      activityLogger: (event) => {
        if (event.status === "started") sourcesAtStart.push(collectUsedSourceReferences(event.runId, "current"));
      },
    });
    const inputSchema = { fileId: z.string(), runId: z.string() };
    registerTool("update_local_document", { inputSchema }, successfulResult);
    registerTool("read_local_document", { inputSchema }, successfulResult);
    recordLibrarySearchHits("run", [{ fileId: "source", title: "Source document" }]);
    const client = await connect(server);
    const args = { fileId: "source", runId: "run" };
    await client.callTool({ name: "update_local_document", arguments: args });
    await client.callTool({ name: "read_local_document", arguments: args });
    expect(sourcesAtStart).toEqual([[], [{ type: "document", fileId: "source", title: "Source document" }]]);
  });

  it("distinguishes thrown failures from a completed call returning a domain error", async () => {
    const { server, registerTool, options } = createRegistrar();
    registerTool("throws", { inputSchema: {} }, async () => { throw new Error("execution failed"); });
    registerTool("returns_error", { inputSchema: {} }, () => withToolErrorHandling(async () => ({ ok: false, error: "対象が見つかりません" })));
    const client = await connect(server);
    expect((await client.callTool({ name: "throws", arguments: {} })).isError).toBe(true);
    expect((await client.callTool({ name: "returns_error", arguments: {} })).isError).toBe(true);
    expect(vi.mocked(options.activityLogger).mock.calls.map(([event]) => [event.tool, event.status])).toEqual([
      ["throws", "started"], ["throws", "failed"], ["returns_error", "started"], ["returns_error", "completed"],
    ]);
    expect(getMcpRunStats().tools.throws.callCount).toBe(1);
    expect(getMcpRunStats().tools.returns_error.callCount).toBe(1);
  });
});
