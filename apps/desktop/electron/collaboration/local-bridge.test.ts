import { expect, it } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { libraryBridgeAuthority, startSessionBridge } from "./local-bridge";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";
import type { CollaborationSessions } from "./sessions";
it("authenticates loopback reads, rejects browser and malformed tokens, and removes its descriptor on close", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-bridge-"));
  const close = await startSessionBridge({ directory, project: (id: string) => id === "file_test" ? { docId: "doc", content: [] } : undefined } as CollaborationSessions);
  try {
    const { port, token } = JSON.parse(await fs.readFile(path.join(directory, "bridge.json"), "utf8"));
    const read = (authorization: string, origin?: string) => fetch(`http://127.0.0.1:${port}/read`, { method: "POST", headers: { Authorization: `Bearer ${authorization}`, ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ fileId: "file_test" }) });
    expect((await read("é".repeat(64))).status).toBe(403);
    expect((await read(token, "https://example.test")).status).toBe(403);
    expect(await (await read(token)).json()).toEqual({ document: { docId: "doc", content: [] }, revision: 1 });
  } finally { await close(); }
  await expect(fs.access(path.join(directory, "bridge.json"))).rejects.toThrow();
  await fs.rm(directory, { recursive: true, force: true });
});

it("routes MCP library mutations through main authority and fails closed after main exits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-library-bridge-"));
  const directory = path.join(root, "collaboration-v1");
  await fs.mkdir(directory, { recursive: true });
  const main = new LocalSigmaDocStore(root);
  const { file } = await main.createDocument({ title: "original" });
  const originalIds = (await main.getLocalLibrarySnapshot()).files.map(value => value.fileId);
  main.setLibraryAuthority({
    listFiles: async () => [],
    deleteFile: async () => { throw new Error("FORBIDDEN"); },
    createFileFromDocument: async () => { throw new Error("FORBIDDEN"); },
  });
  const close = await startSessionBridge({ directory } as CollaborationSessions, main);
  try {
    const mcp = new LocalSigmaDocStore(root);
    mcp.setLibraryAuthority(libraryBridgeAuthority(root));
    expect(await mcp.listFiles()).toEqual([]);
    await expect(mcp.deleteFile(file.fileId)).rejects.toThrow("SESSION_BRIDGE_UNAVAILABLE");
    await expect(mcp.createDocument({ title: "unauthorized" })).rejects.toThrow("SESSION_BRIDGE_UNAVAILABLE");
    expect((await main.getLocalLibrarySnapshot()).files.map(value => value.fileId)).toEqual(originalIds);
    await fs.writeFile(path.join(directory, "catalog-test.json"), "{}");
    await close();
    await expect(mcp.listFiles()).rejects.toThrow("SESSION_BRIDGE_UNAVAILABLE");
    await expect(mcp.deleteFile(file.fileId)).rejects.toThrow("SESSION_BRIDGE_UNAVAILABLE");
  } finally {
    await close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
