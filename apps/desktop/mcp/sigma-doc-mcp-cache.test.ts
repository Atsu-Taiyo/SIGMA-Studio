import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LocalAiRenderBridgeStore, SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV } from "../electron/ai-render-bridge";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import type { OverlayGeoShape } from "@/features/document";
import type { AiEditDraft } from "@/lib/ai/sigma-doc-edit-schema";
import { sampleDocument } from "@/lib/sample-document";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";
import {
  renderDocumentPreview,
  resetDocumentPreviewCache,
  type RenderVisualPreviewDeps,
} from "./sigma-doc-mcp-preview";
import {
  getAllMcpRunStats,
  getMcpRunStats,
  resetMcpRunStats,
  runWithMcpToolStats,
} from "./sigma-doc-mcp-stats";
import { resetDocumentLoadCache } from "./sigma-doc-mcp-store";

const ONE_PIXEL_PNG_BASE64 = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]).toString("base64");

function extractPayload(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
  if (structured.ok === true && structured.data && typeof structured.data === "object") {
    return { ...(structured.data as Record<string, unknown>), ok: true };
  }
  return structured;
}

function createGeoShapeOperation(targetId: string): AiEditDraft {
  const shape: OverlayGeoShape = {
    id: "cache_test_shape",
    type: "geo",
    x: 100,
    y: 100,
    props: {
      w: 80,
      h: 60,
      geo: "rectangle",
      fill: "none",
      color: "#000000",
      labelColor: "#000000",
      dash: "solid",
      size: "m",
    },
  };
  return {
    operation: "insertOverlayShape",
    summary: "キャッシュ検証用の矩形",
    targetId,
    overlayShape: shape,
    assets: {},
  };
}

function bridgeSuccessResponse(): Response {
  return new Response(JSON.stringify({
    ok: true,
    pngBase64: ONE_PIXEL_PNG_BASE64,
    width: 1,
    height: 1,
    capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
    anchorBlockFound: true,
  }), { status: 200, headers: { "content-type": "application/json" } });
}

describe("MCP document and preview caches", () => {
  let userDataDir: string;
  let originalUserDataDir: string | undefined;
  let client: Client;
  let store: LocalSigmaDocStore;
  let fileId: string;
  let firstBlockId: string;
  let bridgeRenderCalls: number;
  let renderVisualPreviewDeps: RenderVisualPreviewDeps;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-cache-"));
    store = new LocalSigmaDocStore(userDataDir);
    await store.initializeWorkspace({ initialDocument: sampleDocument });
    const file = (await store.listFiles())[0];
    const document = file ? await store.loadDocument(file.fileId) : null;
    if (!file || !document?.content[0]) {
      throw new Error("cache test fixture could not be initialized");
    }
    fileId = file.fileId;
    firstBlockId = document.content[0].id;

    originalUserDataDir = process.env.SIGMA_STUDIO_USER_DATA_DIR;
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://cache-test.invalid",
      token: "cache-test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    bridgeRenderCalls = 0;
    renderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => {
        bridgeRenderCalls += 1;
        return bridgeSuccessResponse();
      }) as typeof fetch,
      loadResvg: async () => null,
    };

    resetMcpRunStats();
    resetDocumentLoadCache();
    resetDocumentPreviewCache();
    const server = createSigmaDocMcpServer({ renderVisualPreviewDeps });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "cache-test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  });

  afterEach(async () => {
    await client.close();
    resetMcpRunStats();
    resetDocumentLoadCache();
    resetDocumentPreviewCache();
    if (originalUserDataDir === undefined) {
      delete process.env.SIGMA_STUDIO_USER_DATA_DIR;
    } else {
      process.env.SIGMA_STUDIO_USER_DATA_DIR = originalUserDataDir;
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("reduces three same-revision read tools from three logical disk loads to one", async () => {
    await client.callTool({ name: "get_blocks", arguments: { fileId, blockIds: [firstBlockId] } });
    await client.callTool({ name: "get_document_outline", arguments: { fileId } });
    await client.callTool({ name: "read_local_document", arguments: { fileId } });

    const stats = getMcpRunStats();
    expect(stats.counters).toMatchObject({
      documentDiskLoads: 1,
      documentParses: 1,
      documentCacheMisses: 1,
      documentCacheHits: 2,
    });
    expect(stats.tools.get_blocks?.callCount).toBe(1);
    expect(stats.tools.get_document_outline?.callCount).toBe(1);
    expect(stats.tools.read_local_document?.callCount).toBe(1);
    expect(stats.tools.read_local_document?.totalDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.tools.read_local_document?.maxDurationMs).toBeGreaterThanOrEqual(0);
    expect(stats.tools.read_local_document!.totalDurationMs)
      .toBeGreaterThanOrEqual(stats.tools.read_local_document!.maxDurationMs);
  });

  it("reloads after a committed revision bump and keeps write validation plus preview verification", async () => {
    const before = extractPayload(await client.callTool({
      name: "read_local_document",
      arguments: { fileId, detail: "full" },
    }));
    const beforeDocument = before.document as typeof sampleDocument;
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("fixture document disappeared");
    }
    const nextTitle = "revision 2 のキャッシュ検証教材";
    const saved = await store.saveDocument(fileId, {
      ...document,
      metadata: { ...document.metadata, title: nextTitle },
    }, { expectedRevision: 1 });
    expect(saved).toMatchObject({ ok: true, revision: 2 });

    const after = extractPayload(await client.callTool({
      name: "read_local_document",
      arguments: { fileId, detail: "full" },
    }));
    const afterDocument = after.document as typeof sampleDocument;
    expect(afterDocument.metadata.title).toBe(nextTitle);
    expect(afterDocument.metadata.title).not.toBe(beforeDocument.metadata.title);
    expect(getMcpRunStats().counters).toMatchObject({
      documentDiskLoads: 2,
      documentParses: 2,
      documentCacheMisses: 2,
    });

    const write = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 2,
        writeMode: "dryRun",
        runId: "cache_write_run",
        blocks: ["キャッシュ後も検証される段落"],
      },
    }));
    const verification = write.verification as {
      validation: { ok: boolean; issueCount: number };
      preview: { source: string; previewFile?: string };
    };
    expect(verification.validation).toEqual(expect.objectContaining({ ok: true, issueCount: 0 }));
    expect(verification.preview.source).toBe("app-bridge");
    expect(verification.preview.previewFile).toBeTruthy();
    if (!verification.preview.previewFile) throw new Error("verification previewFile was not returned");
    expect(path.isAbsolute(verification.preview.previewFile)).toBe(true);
    await expect(fs.readFile(verification.preview.previewFile)).resolves.toEqual(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
    expect(getMcpRunStats("cache_write_run").counters.previewBridgeRenders).toBe(1);
  });

  it("reuses an identical block preview and renders again after the committed revision changes", async () => {
    const firstRender = await client.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });
    const firstPayload = extractPayload(firstRender);
    const firstPreviewFile = (firstPayload.preview as { previewFile?: string }).previewFile;
    expect(firstPreviewFile).toBeTruthy();
    if (!firstPreviewFile) throw new Error("block previewFile was not returned");
    expect(path.isAbsolute(firstPreviewFile)).toBe(true);
    await expect(fs.readFile(firstPreviewFile)).resolves.toEqual(Buffer.from(ONE_PIXEL_PNG_BASE64, "base64"));
    await client.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });

    expect(bridgeRenderCalls).toBe(1);
    expect(getMcpRunStats().counters).toMatchObject({
      previewBridgeRenders: 1,
      previewCacheMisses: 1,
      previewCacheHits: 1,
    });

    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("fixture document disappeared");
    }
    const saved = await store.saveDocument(fileId, document, { expectedRevision: 1 });
    expect(saved.ok).toBe(true);
    await client.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });

    expect(bridgeRenderCalls).toBe(2);
    expect(getMcpRunStats().counters).toMatchObject({
      previewBridgeRenders: 2,
      previewCacheMisses: 2,
      previewCacheHits: 1,
    });
  });

  it("does not poison a healthy bridge profile with a transient SVG fallback", async () => {
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("fixture document disappeared");
    }
    let recovered = false;
    let calls = 0;
    const deps: RenderVisualPreviewDeps = {
      env: renderVisualPreviewDeps.env,
      fetchImpl: (async () => {
        calls += 1;
        if (!recovered) {
          throw new Error("transient bridge failure");
        }
        return bridgeSuccessResponse();
      }) as typeof fetch,
      loadResvg: async () => ({ render: () => Buffer.from(ONE_PIXEL_PNG_BASE64, "base64") }),
    };
    const input = {
      document,
      targetId: firstBlockId,
      operations: [createGeoShapeOperation(firstBlockId)],
      cache: {
        storageNamespace: store.getDataDir(),
        fileId,
        revision: 1,
        renderSource: "visual-session" as const,
      },
    };

    const fallback = await renderDocumentPreview(deps, input);
    expect(fallback.source).toBe("svg-fallback");

    recovered = true;
    const healthy = await renderDocumentPreview(deps, input);
    expect(healthy.source).toBe("app-bridge");
    expect(calls).toBe(2);

    await renderDocumentPreview(deps, input);
    expect(calls).toBe(2);
  });

  it("keeps badge text in the preview cache key", async () => {
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("fixture document disappeared");
    }
    resetDocumentPreviewCache();
    bridgeRenderCalls = 0;
    const input = {
      document,
      targetId: firstBlockId,
      operations: [createGeoShapeOperation(firstBlockId)],
      cache: {
        storageNamespace: store.getDataDir(),
        fileId,
        revision: 1,
        renderSource: "visual-session" as const,
      },
    };

    await renderDocumentPreview(renderVisualPreviewDeps, { ...input, badgeText: "K7Q2X" });
    await renderDocumentPreview(renderVisualPreviewDeps, { ...input, badgeText: "R8W3Y" });
    expect(bridgeRenderCalls).toBe(2);
  });

  it("does not reuse a current-proposal preview after that proposal draft changes", async () => {
    const runId = "proposal_cache_run";
    await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 1,
        runId,
        blocks: ["提案previewキャッシュの1回目"],
      },
    });
    resetMcpRunStats();
    resetDocumentPreviewCache();
    bridgeRenderCalls = 0;

    const previewArguments = { fileId, currentProposal: true, runId };
    await client.callTool({ name: "render_block_context", arguments: previewArguments });
    await client.callTool({ name: "render_block_context", arguments: previewArguments });
    expect(bridgeRenderCalls).toBe(1);

    await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 1,
        runId,
        blocks: ["提案previewキャッシュの2回目"],
      },
    });
    const bridgeCallsAfterWriteVerification = bridgeRenderCalls;
    await client.callTool({ name: "render_block_context", arguments: previewArguments });

    expect(bridgeRenderCalls).toBe(bridgeCallsAfterWriteVerification + 1);
    expect(getMcpRunStats(runId).counters.previewCacheHits).toBe(1);
  });

  it("does not cross-hit document or preview entries for two fileIds", async () => {
    const second = await store.createFileFromDocument({ document: sampleDocument });
    resetMcpRunStats();
    resetDocumentLoadCache();
    resetDocumentPreviewCache();

    await client.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });
    await client.callTool({
      name: "render_block_context",
      arguments: { fileId: second.file.fileId, blockId: firstBlockId },
    });

    expect(bridgeRenderCalls).toBe(2);
    expect(getMcpRunStats().counters).toMatchObject({
      documentDiskLoads: 2,
      documentCacheMisses: 2,
      documentCacheHits: 0,
      previewBridgeRenders: 2,
      previewCacheMisses: 2,
      previewCacheHits: 0,
    });
  });

  it("does not cross-hit document or preview entries across two store dataDirs", async () => {
    const copyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-cache-copy-"));
    const secondUserDataDir = path.join(copyRoot, "user-data");
    let secondClient: Client | null = null;
    try {
      await fs.cp(userDataDir, secondUserDataDir, { recursive: true });
      const secondStore = new LocalSigmaDocStore(secondUserDataDir);
      const secondFile = (await secondStore.listFiles())[0];
      const secondDocument = secondFile ? await secondStore.loadDocument(secondFile.fileId) : null;
      if (!secondFile || !secondDocument) {
        throw new Error("copied cache fixture could not be loaded");
      }
      expect(secondFile.fileId).toBe(fileId);
      expect(secondFile.revision).toBe(1);

      const secondTitle = "別 dataDir の同一ID教材";
      const secondDocumentPath = path.join(
        secondStore.getDataDir(),
        secondFile.documentPath ?? path.join("documents", `${encodeURIComponent(secondFile.fileId)}.sigmadoc.json`),
      );
      await fs.writeFile(secondDocumentPath, JSON.stringify({
        ...secondDocument,
        metadata: { ...secondDocument.metadata, title: secondTitle },
      }, null, 2), "utf8");
      const libraryPath = path.join(secondStore.getDataDir(), "library.json");
      const libraryIsNewest = new Date(Date.now() + 1_000);
      await fs.utimes(libraryPath, libraryIsNewest, libraryIsNewest);

      process.env.SIGMA_STUDIO_USER_DATA_DIR = secondUserDataDir;
      const secondServer = createSigmaDocMcpServer({ renderVisualPreviewDeps });
      const [secondClientTransport, secondServerTransport] = InMemoryTransport.createLinkedPair();
      secondClient = new Client({ name: "second-cache-test-client", version: "0.0.0" });
      await Promise.all([
        secondClient.connect(secondClientTransport),
        secondServer.connect(secondServerTransport),
      ]);
      process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

      resetMcpRunStats();
      resetDocumentLoadCache();
      resetDocumentPreviewCache();
      bridgeRenderCalls = 0;

      const firstRead = extractPayload(await client.callTool({
        name: "read_local_document",
        arguments: { fileId, detail: "full" },
      }));
      const secondRead = extractPayload(await secondClient.callTool({
        name: "read_local_document",
        arguments: { fileId, detail: "full" },
      }));
      const firstTitle = ((firstRead.document as typeof sampleDocument).metadata.title);
      expect((secondRead.document as typeof sampleDocument).metadata.title).toBe(secondTitle);
      expect(firstTitle).not.toBe(secondTitle);

      await client.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });
      await secondClient.callTool({ name: "render_block_context", arguments: { fileId, blockId: firstBlockId } });

      expect(bridgeRenderCalls).toBe(2);
      expect(getMcpRunStats().counters).toMatchObject({
        documentDiskLoads: 2,
        documentCacheMisses: 2,
        previewBridgeRenders: 2,
        previewCacheMisses: 2,
        previewCacheHits: 0,
      });
    } finally {
      process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
      await secondClient?.close();
      await fs.rm(copyRoot, { recursive: true, force: true });
    }
  });

  it("evicts the least recently used parsed document after the eighth entry", async () => {
    const fileIds = [fileId];
    for (let index = 1; index < 9; index += 1) {
      const created = await store.createFileFromDocument({
        document: {
          ...sampleDocument,
          metadata: { ...sampleDocument.metadata, title: `LRU教材${index}` },
        },
      });
      fileIds.push(created.file.fileId);
    }
    resetMcpRunStats();
    resetDocumentLoadCache();

    for (const currentFileId of fileIds) {
      await client.callTool({ name: "read_local_document", arguments: { fileId: currentFileId } });
    }
    await client.callTool({ name: "read_local_document", arguments: { fileId: fileIds[0] } });

    expect(getMcpRunStats().counters).toMatchObject({
      documentDiskLoads: 10,
      documentParses: 10,
      documentCacheMisses: 10,
      documentCacheHits: 0,
    });
  });

  it("keeps tool timings and lower-level counters isolated by runId", async () => {
    for (const runId of ["parallel_run_a", "parallel_run_b"]) {
      await client.callTool({
        name: "insert_body_content",
        arguments: {
          fileId,
          targetId: "END_OF_DOCUMENT",
          expectedRevision: 1,
          writeMode: "dryRun",
          runId,
          blocks: [`${runId}の検証用段落`],
        },
      });
    }

    const runA = getMcpRunStats("parallel_run_a");
    const runB = getMcpRunStats("parallel_run_b");
    expect(runA.tools.insert_body_content?.callCount).toBe(1);
    expect(runB.tools.insert_body_content?.callCount).toBe(1);
    expect(runA.counters).toMatchObject({
      documentDiskLoads: 1,
      documentCacheMisses: 1,
      previewBridgeRenders: 1,
    });
    expect(runB.counters).toMatchObject({
      documentDiskLoads: 0,
      documentCacheHits: 1,
      previewBridgeRenders: 1,
    });
  });

  it("attributes sessionId-only visual tools to the visual session's originating runId", async () => {
    const runId = "visual_session_stats_run";
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: firstBlockId, expectedRevision: 1, runId },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    resetMcpRunStats();

    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });

    expect(getMcpRunStats(runId).tools.render_visual_edit_session?.callCount).toBe(1);
    expect(getMcpRunStats().tools.render_visual_edit_session).toBeUndefined();
  });

  it("keeps only the 50 most recently used run stats buckets", async () => {
    for (let index = 0; index < 55; index += 1) {
      await runWithMcpToolStats(`stats_tool_${index}`, `stats_run_${index}`, async () => undefined);
    }

    const allStats = getAllMcpRunStats();
    expect(allStats).toHaveLength(50);
    expect(allStats.some((stats) => stats.runId === "stats_run_0")).toBe(false);
    expect(allStats.some((stats) => stats.runId === "stats_run_4")).toBe(false);
    expect(allStats.some((stats) => stats.runId === "stats_run_5")).toBe(true);
    expect(allStats.some((stats) => stats.runId === "stats_run_54")).toBe(true);
  });
});
