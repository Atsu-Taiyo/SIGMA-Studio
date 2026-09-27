import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { type SigmaDocument, inlineNodesToPlainText } from "@/features/document";
import { findBlock } from "@/lib/document-tree";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import { SigmaDocumentSchema } from "@/lib/sigma-doc-schema";
import { MCP_TOOL_CATEGORIES, MCP_TOOL_CATEGORY_MAP, measureMcpToolExposure, toolNamesForCategories } from "@/lib/ai/mcp-tool-categories";
import { APP_BODY_TOOL_ROUTES, appMcpToolNames, MCP_TOOL_PROFILE_ENV, type McpToolProfile } from "@/lib/ai/mcp-tool-profile";
import { LocalAiEditRunContextStore } from "../electron/ai-edit-run-context";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";

const initialDocument: SigmaDocument = {
  ...sampleDocument,
  metadata: { ...sampleDocument.metadata, styleUnits: { fontSize: "pt" } },
  pageLayout: getDefaultPageLayout(),
  content: [
    { type: "paragraph", id: "p_1", children: [{ type: "text", text: "Before text", marks: ["bold"], fontSize: 14 }] },
    { type: "paragraph", id: "p_2", children: [{ type: "text", text: "Neighbor" }] },
  ],
};

describe("app MCP body tool profile", () => {
  let userDataDir: string;
  let store: LocalSigmaDocStore;
  let proposals: LocalMcpEditProposalStore;
  let fileId: string;
  const clients: Client[] = [];

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-app-mcp-"));
    for (const key of ["SIGMA_STUDIO_DATA_DIR", "SIGMA_STUDIO_RUN_CONTEXT_FILE", "SIGMA_STUDIO_RENDER_BRIDGE_FILE", MCP_TOOL_PROFILE_ENV]) {
      vi.stubEnv(key, undefined);
    }
    vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", userDataDir);
    vi.stubEnv("SIGMA_STUDIO_MCP_PROVIDER", "chatgpt");
    store = new LocalSigmaDocStore(userDataDir);
    await store.initializeWorkspace({ initialDocument: structuredClone(initialDocument) });
    fileId = (await store.listFiles())[0]!.fileId;
    proposals = new LocalMcpEditProposalStore(userDataDir);
    const contextStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    vi.stubEnv("SIGMA_STUDIO_RUN_CONTEXT_FILE", contextStore.getRunContextFilePath());
    for (const runId of ["run_a", "run_b"]) {
      await new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId }).write({
        version: 1, runId, provider: "chatgpt", fileId, fileRevision: 1,
        createdAt: new Date().toISOString(), selectedId: "p_1", references: [],
        attachments: [], mentionedDocuments: [], roomId: `room_${runId}`, turnId: `turn_${runId}`,
      });
    }
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) await client.close();
    vi.unstubAllEnvs();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function connect(toolProfile?: McpToolProfile): Promise<Client> {
    const server = createSigmaDocMcpServer({
      toolProfile,
      renderVisualPreviewDeps: { env: process.env, fetchImpl: fetch, loadResvg: async () => null },
    });
    const client = new Client({ name: "app-profile-test", version: "1" });
    clients.push(client);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  const context = (runId = "run_a") => ({ fileId, runId, expectedRevision: 1 });

  async function call(client: Client, name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { ...context(), ...args } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: true });
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  }

  async function pending(runId = "run_a") {
    const records = await proposals.listProposals({ status: "pending" });
    const record = records.find((proposal) => proposal.runId === runId);
    expect(record).toBeDefined();
    const proposal = await proposals.loadProposal(record!.proposalId);
    expect(proposal).toMatchObject({ runId, roomId: `room_${runId}`, status: "pending" });
    expect(SigmaDocumentSchema.safeParse(proposal!.nextDocument).success).toBe(true);
    return proposal!;
  }

  it("reduces actual tools/list schemas while retaining the external contract and matching app permissions", async () => {
    const externalClient = await connect();
    const appClient = await connect("app");
    const external = (await externalClient.listTools()).tools;
    const app = (await appClient.listTools()).tools;
    expect(external.map((tool) => tool.name).sort()).toEqual(
      MCP_TOOL_CATEGORIES.flatMap((category) => MCP_TOOL_CATEGORY_MAP[category]).sort(),
    );
    expect(app.map((tool) => tool.name).sort()).toEqual(appMcpToolNames(external.map((tool) => tool.name)).sort());
    expect(app).toHaveLength(external.length - 4);
    expect(appMcpToolNames(toolNamesForCategories(MCP_TOOL_CATEGORIES)).sort()).toEqual(app.map((tool) => tool.name).sort());
    for (const name of Object.keys(APP_BODY_TOOL_ROUTES)) {
      expect(app.some((tool) => tool.name === name)).toBe(false);
    }
    const legacyBytes = measureMcpToolExposure(external, ["本文編集"]);
    const appBytes = measureMcpToolExposure(app, ["本文編集"], "app");
    expect(appBytes.selection.serializedSchemaBytes).toBeLessThan(legacyBytes.selection.serializedSchemaBytes);
    expect(appBytes.fullExposure.serializedSchemaBytes).toBeLessThan(legacyBytes.fullExposure.serializedSchemaBytes);
    console.info("MCP tools/list comparison", { external: legacyBytes, app: appBytes });
    const editSchema = app.find((tool) => tool.name === "edit_text")!.inputSchema;
    expect(editSchema.required).toEqual(expect.arrayContaining(["fileId", "expectedRevision", "edit"]));
    const edit = editSchema.properties!.edit as { oneOf: Array<{ required: string[] }> };
    expect(edit.oneOf).toHaveLength(3);
    expect(edit.oneOf[0]!.required).toEqual(expect.arrayContaining(["action", "operations"]));
    expect(app.find((tool) => tool.name === "organize_blocks")!.annotations).toMatchObject({ destructiveHint: true, readOnlyHint: false });
    for (const tool of app) expect(tool.outputSchema).toBeDefined();
    // Hidden legacy endpoints are not callable through the app's MCP transport.
    expect((await appClient.callTool({ name: "delete_blocks", arguments: { ...context(), blockIds: ["p_1"] } })).isError).toBe(true);
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
  });

  it("selects the app profile from the launch environment without changing the default external profile", async () => {
    vi.stubEnv(MCP_TOOL_PROFILE_ENV, "app");
    expect((await (await connect()).listTools()).tools.map((tool) => tool.name)).toContain("insert_content");
    expect((await (await connect("external")).listTools()).tools.map((tool) => tool.name)).toContain("insert_body_content");
  });

  it("converts Markdown into canonical math/lists and accumulates native blocks without writing the saved document", async () => {
    const client = await connect("app");
    const savedBefore = await store.loadDocument(fileId);
    const result = await call(client, "insert_content", {
      targetId: "END_OF_DOCUMENT",
      sourceReferences: [{ type: "web", url: "https://example.invalid/reference", title: "Reference" }],
      content: { format: "markdown", markdown: "## Heading\n\nConsider $x^2$ and \\$5.\n\n- First\n  - Nested" },
    });
    expect(result).toMatchObject({ proposalCreated: true, verification: { validation: { ok: true } } });
    await call(client, "insert_content", {
      targetId: "END_OF_DOCUMENT",
      content: { format: "blocks", blocks: [{ type: "boxBlock", id: "native_box", styleId: "doublebox", blocks: ["Box content"] }] },
    });
    const proposal = await pending();
    expect(proposal.sourceReferences).toContainEqual({ type: "web", url: "https://example.invalid/reference", title: "Reference" });
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(1);
    expect(proposal.nextDocument.content.some((block) => block.type === "heading")).toBe(true);
    const body = proposal.nextDocument.content.find((block) => block.type === "paragraph" && block.id !== "p_1" && block.id !== "p_2");
    expect(body).toMatchObject({ children: expect.arrayContaining([expect.objectContaining({ type: "mathInline", tex: "x^2", display: "inline" })]) });
    expect(body?.type === "paragraph" ? inlineNodesToPlainText(body.children) : "").toContain("$5");
    expect(proposal.nextDocument.content.some((block) => block.type === "list")).toBe(true);
    expect(findBlock(proposal.nextDocument, "native_box")).toMatchObject({ type: "boxBlock", styleId: "doublebox" });
    expect(await store.loadDocument(fileId)).toEqual(savedBefore);
  });

  it("routes patch, formatting, paragraph update and structural replacement into the same proposal", async () => {
    const client = await connect("app");
    await call(client, "edit_text", { edit: { action: "patch", operations: [{
      op: "replace_text", target: { type: "text", blockId: "p_1", text: "Before" }, replacement: "After",
    }] } });
    expect(findBlock((await pending()).nextDocument, "p_1")).toMatchObject({
      children: [{ type: "text", text: "After text", marks: ["bold"], fontSize: 14 }],
    });
    await call(client, "edit_text", { edit: { action: "patch", operations: [{
      op: "format_inline", target: { type: "block", blockId: "p_1" }, style: { fontSizePt: 18 },
    }] } });
    await call(client, "edit_text", { edit: { action: "update", blockId: "p_1", pagination: { break: true } } });
    const current = findBlock((await pending()).nextDocument, "p_1")!;
    await call(client, "edit_text", { edit: { action: "replace_structure", blockId: "p_1", block: { ...current, align: "center" } } });
    const proposal = await pending();
    expect(findBlock(proposal.nextDocument, "p_1")).toMatchObject({ align: "center", pagination: { break: true }, children: [{ text: "After text", fontSize: 18, marks: ["bold"] }] });
    expect(findBlock(proposal.nextDocument, "p_2")).toEqual(initialDocument.content[1]);
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(1);
  });

  it("creates and partially updates problems, then moves and deletes body blocks", async () => {
    const client = await connect("app");
    await call(client, "edit_problem", { edit: { action: "create", id: "problem_1", targetId: "p_1", prompt: ["Solve."], solution: ["Keep this solution."] } });
    await call(client, "edit_problem", { edit: { action: "update", targetId: "problem_1", prompt: ["Solve again."] } });
    const beforeMove = findBlock((await pending()).nextDocument, "problem_1");
    expect(JSON.stringify(beforeMove)).toContain("Keep this solution.");
    expect(JSON.stringify(beforeMove)).toContain("Solve again.");
    await call(client, "organize_blocks", { edit: { action: "move", blockIds: ["p_2"], targetId: "p_1", position: "before" } });
    await call(client, "organize_blocks", { edit: { action: "delete", blockIds: ["p_1"] } });
    expect((await pending()).nextDocument.content.map((block) => block.id)).toEqual(["p_2", "problem_1"]);
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(1);
  });

  it("preserves per-run attribution and dryRun semantics", async () => {
    const client = await connect("app");
    await call(client, "edit_text", { writeMode: "dryRun", edit: { action: "update", blockId: "p_1", text: "Dry run" } });
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
    await call(client, "edit_text", { edit: { action: "update", blockId: "p_1", text: "Agent A" } });
    await call(client, "edit_text", { runId: "run_b", edit: { action: "update", blockId: "p_2", text: "Agent B" } });
    expect(findBlock((await pending("run_a")).nextDocument, "p_2")).toEqual(initialDocument.content[1]);
    expect(findBlock((await pending("run_b")).nextDocument, "p_1")).toEqual(initialDocument.content[0]);
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(2);
  });

  it("rejects stale targets and malformed action payloads without saving a proposal", async () => {
    const client = await connect("app");
    for (const [name, args] of [
      ["edit_text", { edit: { action: "patch", operations: [] } }],
      ["edit_problem", { edit: { action: "create", targetId: "p_1" } }],
      ["organize_blocks", { edit: { action: "move", blockIds: ["p_1"] } }],
      ["organize_blocks", { edit: { action: "delete", blockIds: ["p_1"], targetId: "p_2" } }],
      ["insert_content", { content: { format: "markdown", markdown: " ", blocks: ["Invalid mixed input"] } }],
    ] as const) {
      expect((await client.callTool({ name, arguments: { ...context(), ...args } })).isError).toBe(true);
    }
    const failed = await client.callTool({ name: "edit_text", arguments: {
      ...context(), expectedRevision: 999,
      edit: { action: "update", blockId: "p_1", text: "Stale" },
    } });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({ ok: false, error: { code: "REVISION_MISMATCH", retryable: true } });
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
  });

  it("does not publish a partially successful patch batch", async () => {
    const client = await connect("app");
    const savedBefore = await store.loadDocument(fileId);
    const result = await client.callTool({ name: "edit_text", arguments: {
      ...context(),
      edit: { action: "patch", operations: [
        { op: "replace_text", target: { type: "text", blockId: "p_1", text: "Before" }, replacement: "After" },
        { op: "replace_text", target: { type: "text", blockId: "p_2", text: "Does not exist" }, replacement: "Never applied" },
      ] },
    } });
    expect(result.isError).toBe(true);
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
    expect(await store.loadDocument(fileId)).toEqual(savedBefore);
  });
});
