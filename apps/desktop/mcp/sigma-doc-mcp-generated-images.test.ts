import { createCanvas } from "@napi-rs/canvas";
import { CodexGeneratedImageStore } from "../electron/codex-generated-images";
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

function imageBytes(color: string): Buffer {
  const canvas = createCanvas(64, 32);
  const context = canvas.getContext("2d"); context.fillStyle = color; context.fillRect(0, 0, 64, 32);
  return canvas.toBuffer("image/png");
}

describe("generated image MCP proposals", () => {
  let directory: string;
  let store: LocalSigmaDocStore;
  let proposals: LocalMcpEditProposalStore;
  let client: Client;
  let fileId: string;
  let images: CodexGeneratedImageStore;
  let imageId: string;
  let nextImageId: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-generated-mcp-"));
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
    images = new CodexGeneratedImageStore(store.getDataDir());
    const scope = { runId: "svg_run", fileId, threadId: "thread_1", turnId: "turn_1", itemId: "image_1" };
    imageId = (await images.register(scope, imageBytes("red"))).imageId;
    nextImageId = (await images.register({ ...scope, itemId: "image_2" }, imageBytes("blue"))).imageId;
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

  it("lists native results and creates an embedded, previewable pending image proposal without editing the document", async () => {
    const listed = await call("list_generated_images", {});
    expect(listed.images).toEqual(expect.arrayContaining([expect.objectContaining({ imageId, width: 64, height: 32 })]));
    const before = await store.loadDocument(fileId);
    const inserted = await call("insert_generated_image", { targetId: "p_svg", imageId, w: 200 });
    expect(inserted.proposalCreated).toBe(true);
    expect(inserted.verification).toMatchObject({ validation: { ok: true } });
    const records = await proposals.listProposals({ status: "pending" });
    expect(records).toHaveLength(1);
    const first = (await proposals.loadProposal(records[0].proposalId))!;
    const snapshot = normalizeOverlaySnapshot(first.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    expect(snapshot.shapes.at(-1)).toMatchObject({ type: "image", props: { w: 200, h: 100 } });
    expect(Object.values(snapshot.assets)[0].props).toMatchObject({ mimeType: "image/png", fileSize: imageBytes("red").length });
    expect(await store.loadDocument(fileId)).toEqual(before);
    // A later read of the same native completion cannot create a second shape.
    await call("insert_generated_image", { targetId: "p_svg", imageId, w: 200 });
    const again = (await proposals.loadProposal(records[0].proposalId))!;
    expect(normalizeOverlaySnapshot(again.nextDocument.pageLayout?.overlay?.overlaySnapshot).shapes).toEqual(snapshot.shapes);
    // Pending and saved documents keep the original even after scratch results disappear.
    await images.removeRun("svg_run");
    await store.saveDocument(fileId, again.nextDocument, { expectedRevision: 1 });
    expect(normalizeOverlaySnapshot((await store.loadDocument(fileId))!.pageLayout?.overlay?.overlaySnapshot)).toEqual(snapshot);
  });

  it("exports a pending image as a reference and replaces it without changing geometry", async () => {
    await call("insert_generated_image", { targetId: "p_svg", imageId, x: 100, y: 120, w: 200 });
    const record = (await proposals.listProposals({ status: "pending" }))[0];
    const first = (await proposals.loadProposal(record.proposalId))!;
    const original = normalizeOverlaySnapshot(first.nextDocument.pageLayout?.overlay?.overlaySnapshot).shapes.at(-1)!;
    const reference = await call("get_image_reference", { shapeId: original.id });
    expect(await fs.readFile(reference.filePath as string)).toEqual(imageBytes("red"));
    await call("update_generated_image", { shapeId: original.id, imageId: nextImageId });
    const updated = (await proposals.loadProposal(record.proposalId))!;
    const snapshot = normalizeOverlaySnapshot(updated.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    expect(snapshot.shapes.at(-1)).toEqual(original);
    expect(Object.values(snapshot.assets)[0].props.src).toBe(`data:image/png;base64,${imageBytes("blue").toString("base64")}`);
    await store.saveDocument(fileId, updated.nextDocument, { expectedRevision: 1 });
    expect(normalizeOverlaySnapshot((await store.loadDocument(fileId))!.pageLayout?.overlay?.overlaySnapshot)).toEqual(snapshot);
  });

  it("supports empty whiteboard dry runs without a proposal", async () => {
    const document = (await store.loadDocument(fileId))!;
    await store.saveDocument(fileId, { ...document, content: [], pageLayout: getDefaultPageLayout("whiteboard") }, { expectedRevision: 1 });
    const result = await call("insert_generated_image", { targetId: "CANVAS", imageId, expectedRevision: 2, writeMode: "dryRun" });
    expect(result.verification).toMatchObject({ validation: { ok: true } });
    expect(await proposals.listProposals({ status: "pending" })).toEqual([]);
  });

  it("keeps an oversized original available for preview without creating a proposal", async () => {
    // Isolate the proposal boundary from the independently tested image decoder.
    const large = await images.register({ runId: "svg_run", fileId, threadId: "t", turnId: "u", itemId: "large" }, imageBytes("red"));
    const get = vi.spyOn(CodexGeneratedImageStore.prototype, "get");
    get.mockResolvedValue({ ...large, image: { ...large.image, fileSize: 2 * 1024 * 1024 + 1 } });
    const result = await client.callTool({ name: "insert_generated_image", arguments: { fileId, runId: "svg_run", imageId: large.imageId, targetId: "p_svg", expectedRevision: 1 } });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("2 MiB");
    get.mockRestore();
    expect(await images.get("svg_run", large.imageId)).not.toBeNull();
    expect(await proposals.listProposals({ status: "pending" })).toEqual([]);
  });

  it("rejects absent run ownership, cross-run/cross-document images, unknown IDs and missing targets", async () => {
    const foreign = await images.register({ runId: "another_run", fileId, threadId: "t", turnId: "u", itemId: "i" }, imageBytes("green"));
    const wrongDocument = await images.register({ runId: "svg_run", fileId: "another_file", threadId: "t", turnId: "u", itemId: "i" }, imageBytes("green"));
    for (const args of [
      { imageId }, { imageId, runId: "missing" }, { imageId: foreign.imageId },
      { imageId: wrongDocument.imageId }, { imageId: "f".repeat(64) }, { imageId: "../auth.json" },
    ]) {
      const result = await client.callTool({ name: "insert_generated_image", arguments: {
        fileId, expectedRevision: 1, runId: "svg_run", ...(args.runId || args.imageId !== imageId ? { targetId: "p_svg" } : {}), ...args,
      } });
      expect(result.isError, JSON.stringify(result)).toBe(true);
    }
    expect(await proposals.listProposals({ status: "pending" })).toEqual([]);
  });
});
