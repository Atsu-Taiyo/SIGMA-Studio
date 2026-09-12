import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOverlaySnapshot } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { getDefaultPageLayout } from "@/lib/page-layout";
import { LocalAiEditRunContextStore } from "../electron/ai-edit-run-context";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";
import { createDefaultRenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";

const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100"><rect width="200" height="100" fill="#ef4444"/><text x="10" y="30">面積</text></svg>';

describe("SVG image MCP proposals", () => {
  let directory: string;
  let store: LocalSigmaDocStore;
  let proposals: LocalMcpEditProposalStore;
  let client: Client;
  let fileId: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-svg-mcp-"));
    for (const key of ["SIGMA_STUDIO_DATA_DIR", "SIGMA_STUDIO_RENDER_BRIDGE_FILE", "SIGMA_STUDIO_RUN_CONTEXT_FILE"]) vi.stubEnv(key, undefined);
    vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", directory);
    vi.stubEnv("SIGMA_STUDIO_MCP_PROVIDER", "chatgpt");
    store = new LocalSigmaDocStore(directory);
    await store.initializeWorkspace({ initialDocument: {
      ...structuredClone(sampleDocument), content: [{ id: "p_svg", type: "paragraph", children: [{ type: "text", text: "SVGの説明" }] }],
    } });
    fileId = (await store.listFiles())[0].fileId;
    proposals = new LocalMcpEditProposalStore(directory);
    const context = new LocalAiEditRunContextStore(directory, "chatgpt", { runId: "svg_run" });
    await context.write({ version: 1, runId: "svg_run", provider: "chatgpt", fileId, fileRevision: 1,
      createdAt: new Date().toISOString(), selectedId: "p_svg", references: [], attachments: [], mentionedDocuments: [], roomId: "svg_room", turnId: "svg_turn" });
    vi.stubEnv("SIGMA_STUDIO_RUN_CONTEXT_FILE", context.getRunContextFilePath());
    const server = createSigmaDocMcpServer({ toolProfile: "app" });
    client = new Client({ name: "svg-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
  });
  afterEach(async () => { await client.close(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { fileId, expectedRevision: 1, runId: "svg_run", ...args } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ ok: true });
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  }

  it("exposes insert/update, persists SVG only in the pending proposal, returns a PNG, and revises that proposal", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["insert_svg_image", "update_svg_image"]));
    const before = await store.loadDocument(fileId);
    const inserted = await call("insert_svg_image", { targetId: "p_svg", svg, w: 200 });
    expect(inserted.proposalCreated).toBe(true);
    expect(inserted.verification).toMatchObject({ validation: { ok: true } });
    const resvg = await createDefaultRenderVisualPreviewDeps().loadResvg();
    const preview = (inserted.verification as { preview: { source: string; previewFile?: string } }).preview;
    if (resvg) {
      expect(preview.source).not.toBe("none");
      expect(preview.previewFile).toBeTruthy();
      const bytes = await fs.readFile(preview.previewFile!);
      expect([...bytes.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
    }
    expect(await store.loadDocument(fileId)).toEqual(before);
    const records = await proposals.listProposals({ status: "pending" });
    expect(records).toHaveLength(1);
    const first = (await proposals.loadProposal(records[0].proposalId))!;
    const firstSnapshot = normalizeOverlaySnapshot(first.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    const shape = firstSnapshot.shapes.at(-1)!;
    expect(shape.type).toBe("image");
    const updated = await call("update_svg_image", { shapeId: shape.id, svg: svg.replace('#ef4444', '#2563eb') });
    expect(updated.verification).toMatchObject({ validation: { ok: true } });
    const remaining = await proposals.listProposals({ status: "pending" });
    expect(remaining).toHaveLength(1);
    const revised = (await proposals.loadProposal(remaining[0].proposalId))!;
    const snapshot = normalizeOverlaySnapshot(revised.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    expect(snapshot.shapes).toEqual(firstSnapshot.shapes);
    expect(Object.keys(snapshot.assets)).toHaveLength(1);
    expect(Buffer.from(Object.values(snapshot.assets)[0].props.src.split(',')[1], 'base64').toString()).toContain('#2563eb');
    expect(await store.loadDocument(fileId)).toEqual(before);
    // Exercise the desktop persistence boundary with the document produced by the proposal.
    await store.saveDocument(fileId, revised.nextDocument, { expectedRevision: 1 });
    const saved = (await store.loadDocument(fileId))!;
    expect(normalizeOverlaySnapshot(saved.pageLayout?.overlay?.overlaySnapshot)).toEqual(snapshot);
  });

  it("supports an empty whiteboard and dryRun without saving a proposal", async () => {
    const document = (await store.loadDocument(fileId))!;
    await store.saveDocument(fileId, { ...document, content: [], pageLayout: getDefaultPageLayout("whiteboard") }, { expectedRevision: 1 });
    const result = await call("insert_svg_image", { targetId: "CANVAS", expectedRevision: 2, writeMode: "dryRun", svg });
    expect(result.verification).toMatchObject({ validation: { ok: true } });
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
  });

  it("rejects dangerous SVG and missing placement without writing proposals", async () => {
    for (const args of [{ svg, selectedId: undefined }, { targetId: "p_svg", svg: svg.replace('<rect', '<rect onload="alert(1)"') }]) {
      const result = await client.callTool({ name: "insert_svg_image", arguments: { fileId, expectedRevision: 1, ...args } });
      expect(result.structuredContent).toMatchObject({ ok: false });
    }
    expect(await proposals.listProposals({ status: "pending" })).toHaveLength(0);
  });
});
