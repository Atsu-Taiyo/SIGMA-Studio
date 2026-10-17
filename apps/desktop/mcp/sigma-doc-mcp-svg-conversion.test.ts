import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { normalizeOverlaySnapshot, type OverlayShape } from "@/features/document";
import { collectNonMergeableTargets } from "@/lib/ai/proposal-merge-basis";
import { sampleDocument } from "@/lib/sample-document";
import { AI_SVG_CONVERSION_LINE_SIZES, convertSvgImageShape } from "@/lib/svg-to-sigma";
import { LocalAiEditRunContextStore } from "../electron/ai-edit-run-context";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";
import type { RenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";

/** A hairline, a rectangle and a label: convertible, with one thing the AI's conversion changes (the hairline). */
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 100">'
  + '<line x1="10" y1="20" x2="190" y2="20" stroke="#111111" stroke-width="0.75"/>'
  + '<rect x="20" y="40" width="60" height="30" fill="none" stroke="#111111" stroke-width="2"/>'
  + '<text x="120" y="60" font-size="15" fill="#111111">ラベル</text></svg>';

describe("convert_svg_image", () => {
  let directory: string;
  let store: LocalSigmaDocStore;
  let proposals: LocalMcpEditProposalStore;
  let client: Client;
  let fileId: string;
  let bridgeRequests: Array<{ url: string; body: Record<string, unknown> }>;

  async function connect(deps: RenderVisualPreviewDeps) {
    const server = createSigmaDocMcpServer({ renderVisualPreviewDeps: deps });
    client = new Client({ name: "svg-conversion-test", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
  }

  /** A running app's render bridge, which measures with a fixed text width so its result is recognizable. */
  async function connectWithBridge(answer: "measure" | "fail") {
    const bridgeFile = path.join(directory, "render-bridge.json");
    await fs.writeFile(bridgeFile, JSON.stringify({ version: 1, url: "http://127.0.0.1:9", token: "secret", pid: 1, createdAt: new Date().toISOString() }));
    await connect({
      env: { ...process.env, SIGMA_STUDIO_RENDER_BRIDGE_FILE: bridgeFile },
      loadResvg: async () => null,
      fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        if (!url.endsWith("/convert-svg")) {
          return new Response(JSON.stringify({ ok: false, error: "preview unavailable" }), { status: 502 });
        }
        const body = JSON.parse(String(init?.body)) as { document: Record<string, unknown>; shapeId: string };
        bridgeRequests.push({ url, body });
        expect((init?.headers as Record<string, string>).authorization).toBe("Bearer secret");
        if (answer === "fail") {
          return new Response(JSON.stringify({ ok: false, error: "renderer crashed" }), { status: 502 });
        }
        const snapshot = normalizeOverlaySnapshot((body.document as { pageLayout?: { overlay?: { overlaySnapshot?: unknown } } }).pageLayout?.overlay?.overlaySnapshot);
        const image = snapshot.shapes.find((shape) => shape.id === body.shapeId) as Extract<OverlayShape, { type: "image" }>;
        const conversion = convertSvgImageShape({ image, asset: snapshot.assets[image.props.assetId] }, undefined, undefined,
          () => ({ width: 61, height: 20, baseline: 15 }), { lineSizes: AI_SVG_CONVERSION_LINE_SIZES });
        return new Response(JSON.stringify({ ok: true, conversion }), { status: 200 });
      }) as typeof fetch,
    });
  }

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-svg-convert-mcp-"));
    bridgeRequests = [];
    for (const key of ["SIGMA_STUDIO_DATA_DIR", "SIGMA_STUDIO_RENDER_BRIDGE_FILE", "SIGMA_STUDIO_RUN_CONTEXT_FILE"]) vi.stubEnv(key, undefined);
    vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", directory);
    vi.stubEnv("SIGMA_STUDIO_MCP_PROVIDER", "claude");
    store = new LocalSigmaDocStore(directory);
    await store.initializeWorkspace({ initialDocument: {
      ...structuredClone(sampleDocument), content: [{ id: "p_svg", type: "paragraph", children: [{ type: "text", text: "図の説明" }] }],
    } });
    fileId = (await store.listFiles())[0].fileId;
    proposals = new LocalMcpEditProposalStore(directory);
    const context = new LocalAiEditRunContextStore(directory, "claude", { runId: "convert_run" });
    await context.write({ version: 1, runId: "convert_run", provider: "claude", fileId, fileRevision: 1,
      createdAt: new Date().toISOString(), selectedId: "p_svg", references: [], attachments: [], mentionedDocuments: [], roomId: "convert_room", turnId: "convert_turn" });
    vi.stubEnv("SIGMA_STUDIO_RUN_CONTEXT_FILE", context.getRunContextFilePath());
  });
  afterEach(async () => { await client?.close(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({ name, arguments: { fileId, expectedRevision: 1, runId: "convert_run", ...args } });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    return result.structuredContent as { ok: boolean; data: Record<string, unknown>; error?: string };
  }

  /** The AI draws the figure, then converts it in the same turn: both land in the one pending proposal. */
  async function insertThenConvert() {
    const inserted = await call("insert_svg_image", { targetId: "p_svg", svg: SVG, name: "装置図" });
    expect(inserted.ok, JSON.stringify(inserted)).toBe(true);
    const [pending] = await proposals.listProposals({ status: "pending" });
    const imageId = normalizeOverlaySnapshot((await proposals.loadProposal(pending!.proposalId))!.nextDocument.pageLayout?.overlay?.overlaySnapshot)
      .shapes.find((shape) => shape.type === "image")!.id;
    const converted = await call("convert_svg_image", { shapeId: imageId });
    expect(converted.ok, JSON.stringify(converted)).toBe(true);
    const [record] = await proposals.listProposals({ status: "pending" });
    const proposal = (await proposals.loadProposal(record!.proposalId))!;
    return { imageId, converted: converted.data, proposal };
  }

  it("is a write tool the app counts as an edit, with its usage in its description", async () => {
    await connect({ env: process.env, fetchImpl: fetch, loadResvg: async () => null });
    const tool = (await client.listTools()).tools.find((candidate) => candidate.name === "convert_svg_image")!;
    expect(tool.inputSchema.required).toEqual(expect.arrayContaining(["fileId", "shapeId", "expectedRevision"]));
    for (const phrase of ["図形に変換", "\"estimate\"", "細(1.25)以上に切り上げ", "update_shape", "keptAsSvgCount"]) {
      expect(tool.description).toContain(phrase);
    }
  });

  it("measures with the app's renderer when the render bridge answers", async () => {
    await connectWithBridge("measure");
    const { imageId, converted, proposal } = await insertThenConvert();
    expect(bridgeRequests).toHaveLength(1);
    expect(bridgeRequests[0]!.body.shapeId).toBe(imageId);
    expect(converted.verification).toMatchObject({ validation: { ok: true }, svgConversion: { source: "app-bridge", warnings: [] } });
    expect(converted.toolResult).toMatchObject({ data: { conversion: { measurement: "app", keptAsSvgCount: 0, groupId: imageId } } });
    expect(proposal.summary).not.toContain("推定");
    // One proposal: the insertion, then the replacement of the same image.
    expect(proposal.draft.operations.map((operation) => operation.operation)).toEqual(["insertOverlayShape"]);
    expect(proposal.draft.mutationOperations?.map((operation) => operation.operation)).toEqual(["replaceOverlayShape"]);
    const snapshot = normalizeOverlaySnapshot(proposal.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    expect(snapshot.shapes.find((shape) => shape.id === imageId)?.type).toBe("group");
    expect(snapshot.shapes.filter((shape) => shape.type === "image")).toEqual([]);
    expect(snapshot.shapes.find((shape) => shape.type === "text")).toMatchObject({ props: { w: 61 } });
    // The AI's conversion lifts the hairline.
    expect(snapshot.shapes.flatMap((shape) => (shape.type === "line" || shape.type === "geo" ? [shape.props.size] : []))).toEqual(["s", "m"]);
    // The converted image stays locked while the proposal is pending.
    expect(collectNonMergeableTargets([{ draft: proposal.draft, mergeBasis: proposal.mergeBasis }]).shapeIds).toContain(imageId);
  });

  it("estimates when no app is running, and says so in the result and in the proposal", async () => {
    await connect({ env: { ...process.env, SIGMA_STUDIO_RENDER_BRIDGE_FILE: undefined }, fetchImpl: fetch, loadResvg: async () => null });
    const { converted, proposal } = await insertThenConvert();
    expect(converted.verification).toMatchObject({ svgConversion: { source: "estimate" } });
    const warnings = (converted.verification as { svgConversion: { warnings: string[] } }).svgConversion.warnings;
    expect(warnings.join(" ")).toContain("推定");
    expect(converted.toolResult).toMatchObject({ data: { conversion: { measurement: "estimate" } } });
    expect(String((converted.toolResult as { data: { conversion: { note: string } } }).data.conversion.note)).toContain("図形に変換");
    expect(proposal.summary).toContain("推定");
    const snapshot = normalizeOverlaySnapshot(proposal.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    expect(snapshot.shapes.flatMap((shape) => (shape.type === "line" || shape.type === "geo" ? [shape.props.size] : []))).toEqual(["s", "m"]);
  });

  it("falls back to the estimate when the app cannot convert, with the reason", async () => {
    await connectWithBridge("fail");
    const { converted } = await insertThenConvert();
    expect(bridgeRequests).toHaveLength(1);
    expect(converted.verification).toMatchObject({ svgConversion: { source: "estimate" } });
    expect((converted.verification as { svgConversion: { warnings: string[] } }).svgConversion.warnings.join(" ")).toContain("renderer crashed");
  });

  it("refuses what is not an SVG image, and writes nothing", async () => {
    await connect({ env: process.env, fetchImpl: fetch, loadResvg: async () => null });
    const result = await client.callTool({ name: "convert_svg_image", arguments: { fileId, expectedRevision: 1, runId: "convert_run", shapeId: "no_such_shape" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ ok: false, error: { message: expect.stringContaining("SVG画像") } });
    expect(await proposals.listProposals({ status: "pending" })).toEqual([]);
  });
});
