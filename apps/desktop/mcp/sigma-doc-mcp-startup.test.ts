import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it, vi } from "vitest";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";

it("reports a failed optional index warmup without rejecting server startup", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "sigma-mcp-startup-"));
  vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", directory);
  vi.spyOn(LocalMcpEditProposalStore.prototype, "warmIndex").mockRejectedValueOnce(new Error("private filesystem path"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const server = createSigmaDocMcpServer();
  const client = new Client({ name: "startup-test", version: "1" });
  try {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    expect((await client.listTools()).tools.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith("[sigma:mcp] Proposal index warmup failed; the next read will retry.");
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private filesystem path");
  } finally {
    await client.close(); await server.close();
    vi.restoreAllMocks(); vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  }
});
