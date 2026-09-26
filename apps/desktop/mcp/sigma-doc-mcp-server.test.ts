import fs from "node:fs/promises";
import { createTranslator } from "@/lib/i18n";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  createSigmaDocMcpServer,
  deriveVisualPreviewCode,
  flushVisualSessionStatusWritesForTests,
  formatZodErrorForTool,
  getVisualSessionStatusCacheSizesForTests,
  inspectShapeBasics,
  requireReadyOverview,
  type VisualInspectionIssue,
} from "./sigma-doc-mcp-server-core";
import { createDefaultRenderVisualPreviewDeps, type RenderVisualPreviewDeps } from "./sigma-doc-mcp-preview";
import {
  LocalAiEditRunContextStore,
  visualSessionsFileName,
  type AiEditRunContext,
} from "../electron/ai-edit-run-context";
import { LocalMaterialStore } from "../electron/local-material-store";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { LocalAiRenderBridgeStore, SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV } from "../electron/ai-render-bridge";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { groupMcpProposalsForPreview } from "@/components/editor/ai-edit-preview-types";
import {
  getOverlayTextBlocksLabelText,
  overlayTextBlocksToInlineNodes,
  inlineNodesToPlainText,
  normalizeOverlaySnapshot,
  type Graph3DSpec,
  type OverlayShape,
} from "@/features/document";
import { createSigmaDocAgentSession, executeSigmaDocAgentDraftTool } from "@/lib/ai/sigma-doc-agent-tools";
import {
  createAiEditSessionDocumentDraft,
  getInvalidAiOverlayAssetIdsInDocument,
  type AiEditSessionDraft,
} from "@/lib/ai/sigma-doc-edit-schema";
import { getGraph3DPreviewSourceHash } from "@/features/drawing";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";
import { MCP_TOOL_CATEGORIES, MCP_TOOL_CATEGORY_MAP } from "@/lib/ai/mcp-tool-categories";
import { findBlock } from "@/lib/document-tree";
import { describeLedgerSchemaFailure } from "@/lib/library-schema";
import { getDefaultPageLayout, getPageMetrics } from "@/lib/page-layout";
import { sampleDocument } from "@/lib/sample-document";
import { parseSigmaDocument } from "@/lib/sigma-doc-schema";
import type { DesktopMcpEditProposalSummary } from "@/types/desktop";
import type { SigmaBlock, SigmaDocument } from "@/types/sigma-doc";

const ENV_KEYS = [
  "SIGMA_STUDIO_DATA_DIR",
  "SIGMA_STUDIO_USER_DATA_DIR",
  "SIGMA_STUDIO_RUN_CONTEXT_FILE",
  "SIGMA_STUDIO_MCP_PROVIDER",
  SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV,
] as const;

const PNG_MAGIC_BYTES = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

describe("requireReadyOverview", () => {
  it("throws a readable ledger schema failure with violation paths", () => {
    expect(() => requireReadyOverview({
      state: "ledger-schema-error",
      failure: {
        libraryPath: "/tmp/sigma/library.json",
        expectedVersion: 4,
        actualVersion: 3,
        violations: [{
          path: "workspaces[0].kind",
          reason: { kind: "forbiddenField" as const, field: "kind" },
          expected: null,
          received: "\"cloud\"",
        }],
      },
    })).toThrow(
      "教材ライブラリの索引 (/tmp/sigma/library.json) が現行スキーマに合っていません。期待バージョン 4 / 実際 3。違反 1 件: workspaces[0].kind (期待 (フィールドが存在しないこと) / 実際 \"cloud\")",
    );
  });
});

async function saveAtCurrentRevision(
  store: LocalSigmaDocStore,
  fileId: string,
  document: SigmaDocument,
) {
  const file = (await store.listFiles()).find((item) => item.fileId === fileId);
  if (!file) {
    throw new Error(`test fixture file missing for ${fileId}`);
  }
  return store.saveDocument(fileId, document, { expectedRevision: file.revision });
}

// Pins the public tool contract consumed by docs/mcp-local-app.md and the
// external Codex-import tooling. Public contract is intentionally versioned by exact names.
const DOCUMENTED_TOOL_NAMES = [
  "get_problem_solution",
  "align_shapes",
  "apply_edits",
  "begin_visual_edit_session",
  "propose_visual_edit_session",
  "create_local_document",
  "create_local_folder",
  "create_problem_content",
  "delete_ai_resource",
  "delete_blocks",
  "delete_local_document",
  "delete_local_folder",
  "delete_shapes",
  "discard_visual_edit_session",
  "get_active_reference",
  "get_image_reference",
  "list_generated_images",
  "get_attached_media",
  "get_block",
  "get_blocks",
  "get_edit_context",
  "get_document_outline",
  "get_edit_proposal",
  "get_insertion_candidates",
  "get_local_app_status",
  "get_material",
  "get_mentioned_sigma_docs",
  "get_neighbor_blocks",
  "get_selected_block",
  "insert_body_content",
  "insert_graph",
  "insert_graph3d",
  "insert_material",
  "insert_shape",
  "insert_generated_image",
  "update_generated_image",
  "insert_svg_image",
  "update_svg_image",
  "insert_table",
  "inspect_visual_edit_session",
  "list_edit_proposals",
  "list_all_pending_proposals",
  "list_local_documents",
  "list_materials",
  "move_blocks",
  "read_local_document",
  "render_block_context",
  "render_page",
  "render_visual_edit_session",
  "review_visual_edit_session",
  "save_ai_resource",
  "search_document",
  "search_library",
  "update_ai_settings",
  "update_column_layout",
  "update_local_document",
  "update_local_folder",
  "replace_block",
  "update_graph",
  "update_graph3d",
  "update_page_layout",
  "update_problem_content",
  "update_rich_content",
  "update_shape",
  "update_table",
  "validate_local_document",
  "visual_insert_shape",
  "visual_remove_shape",
  "visual_replace_shape",
  "withdraw_current_edit_proposal",
  "withdraw_edit_proposal",
];

function extractPayload(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent: Record<string, unknown> }).structuredContent;
  if (structured.ok === true && structured.data && typeof structured.data === "object") {
    return {
      ...(structured.data as Record<string, unknown>),
      ok: true,
      message: structured.message,
      ...(structured.nextAction === undefined ? {} : { nextAction: structured.nextAction }),
    };
  }
  if (structured.ok === false && structured.error && typeof structured.error === "object") {
    const error = structured.error as Record<string, unknown>;
    const details = error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {};
    return {
      ...details,
      ok: false,
      error: error.message,
      errorCode: error.code,
      retryable: error.retryable,
      nextAction: error.nextAction,
      errorDetails: error.details,
    };
  }
  return structured;
}

// Parses the `## 公開ツール` section of docs/mcp-local-app.md and returns the
// backticked tool names listed there (one per bullet, e.g. "- `get_block` - ...").
// Used to assert docs/server parity so documentation drift fails CI instead of
// silently going stale.
async function readPublicToolNamesFromDocs(): Promise<string[]> {
  const docsPath = path.join(__dirname, "..", "..", "..", "docs", "mcp-local-app.md");
  const raw = await fs.readFile(docsPath, "utf8");
  const sectionMatch = raw.match(/^## 公開ツール\n([\s\S]*?)\n## /m);
  if (!sectionMatch) {
    throw new Error("docs/mcp-local-app.md: could not find the '## 公開ツール' section");
  }
  const section = sectionMatch[1] ?? "";
  const names: string[] = [];
  for (const line of section.split("\n")) {
    // ツール名には数字が入りうる (insert_graph3d)。ここを [a-z_]+ のままにすると、
    // 3Dツールの行が「docsに無い」と読まれて照合が黙って緩む。
    const match = line.match(/^- `([a-z0-9_]+)`/);
    if (match) {
      names.push(match[1]!);
    }
  }
  if (names.length === 0) {
    throw new Error("docs/mcp-local-app.md: found no backticked tool names in the '## 公開ツール' section");
  }
  return names.sort();
}

// describe.skipIf needs the answer synchronously at collection time, so resolve
// resvg availability via top-level await instead of an async beforeAll.
const resvgAvailable = (await createDefaultRenderVisualPreviewDeps().loadResvg()) !== null;

describe("sigma-doc-mcp-server integration", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-server-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await flushVisualSessionStatusWritesForTests();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function getFileId(): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  async function listProposalFiles(): Promise<string[]> {
    try {
      return await fs.readdir(path.join(userDataDir, "data", "proposals"));
    } catch {
      return [];
    }
  }

  // Simulates a human renderer-side edit to a single paragraph, replacing its text and saving
  // directly through the store (bypassing the MCP tools). Returns the resulting revision. Each
  // saveDocument() call also writes the doc-block-hashes sidecar for that new revision (see
  // electron/local-sigma-doc-store.ts), which is what lets the MCP server's block-hash
  // reconciliation compare "did this specific block change" across revisions.
  async function editParagraphAndSave(fileId: string, blockId: string, newText: string): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error(`test fixture document missing for ${fileId}`);
    }
    const block = findBlock(document, blockId);
    if (!block || block.type !== "paragraph") {
      throw new Error(`expected a paragraph block for ${blockId}`);
    }
    (block as unknown as { children: unknown[] }).children = [{ type: "text", text: newText }];
    const result = await saveAtCurrentRevision(store, fileId, document);
    if (!result.ok || result.revision === undefined) {
      throw new Error(`failed to save test edit to ${blockId}: ${result.error ?? "unknown error"}`);
    }
    return result.revision;
  }

  it("smoke: exposes the expected tools and reports the temp userDataPath", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);
    expect(toolNames).toContain("list_local_documents");
    expect(toolNames).toContain("insert_body_content");
    expect(toolNames).toContain("propose_visual_edit_session");

    const status = await client.callTool({ name: "get_local_app_status", arguments: {} });
    const payload = extractPayload(status);
    expect(payload.userDataPath).toBe(userDataDir);
  });

  it("manages app-owned documents and folders without accepting filesystem paths", async () => {
    const store = new LocalSigmaDocStore(userDataDir);
    const initialOverview = await store.getWorkspaceOverview();
    if (initialOverview.state !== "ready") {
      throw new Error(initialOverview.state === "ledger-schema-error"
        ? describeLedgerSchemaFailure(initialOverview.failure, createTranslator("ja", "workspace"))
        : initialOverview.error);
    }
    const workspaceId = initialOverview.overview.activeWorkspaceId;

    const createdFolder = extractPayload(await client.callTool({
      name: "create_local_folder",
      arguments: { workspaceId, name: "一次関数" },
    }));
    expect(createdFolder.ok).toBe(true);
    const folderId = (createdFolder.folder as { id: string }).id;

    const createdDocument = extractPayload(await client.callTool({
      name: "create_local_document",
      arguments: { workspaceId, folderId, title: "確認用教材" },
    }));
    expect(createdDocument.ok).toBe(true);
    expect(createdDocument).not.toHaveProperty("path");
    const createdFile = createdDocument.file as { fileId: string; revision: number; folderId: string | null };
    expect(createdFile.folderId).toBe(folderId);

    const updatedDocument = extractPayload(await client.callTool({
      name: "update_local_document",
      arguments: {
        fileId: createdFile.fileId,
        expectedRevision: createdFile.revision,
        title: "名前変更後",
        folderId: null,
      },
    }));
    expect(updatedDocument.ok).toBe(true);
    expect(updatedDocument.file).toMatchObject({
      fileId: createdFile.fileId,
      title: "名前変更後",
      folderId: null,
      revision: createdFile.revision + 1,
    });

    const updatedFolder = extractPayload(await client.callTool({
      name: "update_local_folder",
      arguments: { workspaceId, folderId, name: "一次関数（旧）" },
    }));
    expect(updatedFolder.folder).toMatchObject({ id: folderId, name: "一次関数（旧）" });

    const deletedDocument = extractPayload(await client.callTool({
      name: "delete_local_document",
      arguments: { fileId: createdFile.fileId, expectedRevision: createdFile.revision + 1 },
    }));
    expect(deletedDocument).toMatchObject({ ok: true, deletedFileId: createdFile.fileId });

    const containedDocument = extractPayload(await client.callTool({
      name: "create_local_document",
      arguments: { workspaceId, folderId, title: "フォルダと一緒に削除" },
    }));
    expect(containedDocument.ok).toBe(true);
    const containedFileId = (containedDocument.file as { fileId: string }).fileId;

    const deletedFolder = extractPayload(await client.callTool({
      name: "delete_local_folder",
      arguments: { workspaceId, folderId },
    }));
    expect(deletedFolder).toMatchObject({ ok: true, deletedFolderId: folderId });
    expect((await store.listFiles()).some((item) => item.fileId === createdFile.fileId)).toBe(false);
    expect((await store.listFiles()).some((item) => item.fileId === containedFileId)).toBe(false);
    expect(await store.loadDocument(containedFileId)).toBeNull();
  });

  it("rejects stale revisions for app-owned document updates and deletes", async () => {
    const fileId = await getFileId();
    const file = (await new LocalSigmaDocStore(userDataDir).listFiles()).find((item) => item.fileId === fileId)!;

    for (const name of ["update_local_document", "delete_local_document"] as const) {
      const result = extractPayload(await client.callTool({
        name,
        arguments: {
          fileId,
          expectedRevision: file.revision + 1,
          ...(name === "update_local_document" ? { title: "競合する名前" } : {}),
        },
      }));
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("revisionが一致しません");
    }
  });

  it("exposes decision guidance, examples, and ambiguous argument semantics in tool metadata", async () => {
    const tools = (await client.listTools()).tools;
    const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
    const schemaOf = (name: string) => JSON.stringify(tools.find((tool) => tool.name === name)?.inputSchema ?? {});
    const propertiesOf = (name: string) => (
      tools.find((tool) => tool.name === name)?.inputSchema.properties as
        | Record<string, { description?: string }>
        | undefined
    ) ?? {};

    expect(descriptionOf("insert_body_content")).toContain("update_rich_content");
    expect(descriptionOf("insert_body_content")).toContain("その段落IDをtargetIdにしてareaを省略");
    expect(descriptionOf("insert_body_content")).toContain("例:");
    expect(descriptionOf("insert_body_content")).toContain("boxBlock");
    expect(descriptionOf("insert_body_content")).toContain("pagination");
    expect(schemaOf("insert_body_content")).toContain("boxBlock");
    expect(schemaOf("insert_body_content")).toContain("keepWithNext");
    for (const styleId of [
      "fancybox",
      "itembox",
      "tcolorbox",
      "tcolorbox-note",
      "doublebox",
      "shadebox",
      "leftbar",
      "dashedbox",
      "ruledbox",
      "screenbox",
      "ovalbox",
      "cornerbox",
    ]) {
      expect(schemaOf("insert_body_content")).toContain(styleId);
    }
    expect(descriptionOf("replace_block")).toContain("fallback");
    expect(descriptionOf("apply_edits")).toContain("replace_text");
    expect(descriptionOf("apply_edits")).toContain("copy-with");
    expect(schemaOf("apply_edits")).toContain("replace_text");
    expect(schemaOf("apply_edits")).toContain("quote");
    expect(descriptionOf("insert_table")).toContain("n+1個");
    expect(descriptionOf("update_shape")).toContain("型付き引数");
    expect(descriptionOf("update_page_layout")).toContain("部分更新");
    expect(descriptionOf("update_page_layout")).toContain("段組み、ヘッダー、フッターは保持");
    expect(descriptionOf("begin_visual_edit_session")).toContain("手順:");
    expect(descriptionOf("get_attached_media")).toContain("resource content");

    expect(propertiesOf("insert_body_content").targetId?.description).toContain("END_OF_DOCUMENT");
    expect(propertiesOf("insert_shape").targetId?.description).toContain("CANVAS");
    expect(propertiesOf("insert_table").targetId?.description).toContain("CANVAS");
    expect(propertiesOf("insert_graph").targetId?.description).toContain("CANVAS");
    expect(propertiesOf("insert_graph3d").targetId?.description).toContain("CANVAS");
    // 3Dは2Dと語彙が違う。単位・座標系・使い分け・作り直し禁止をdescriptionだけで判断できること。
    expect(descriptionOf("insert_graph3d")).toContain("zUp");
    expect(descriptionOf("insert_graph3d")).toContain("ラジアン");
    expect(descriptionOf("insert_graph3d")).toContain("TeX");
    expect(descriptionOf("insert_graph3d")).toContain("insert_graph");
    expect(descriptionOf("insert_graph3d")).toContain("update_graph3d");
    expect(descriptionOf("update_graph3d")).toContain("保持");
    expect(descriptionOf("update_graph3d")).toContain("作り直");
    expect(propertiesOf("insert_graph3d").preset?.description).toContain("revolution");
    expect((propertiesOf("insert_graph3d").preset as { enum?: string[] } | undefined)?.enum).toEqual([
      "revolution",
      "surface",
      "tricylinder",
      "sphereTetrahedron",
      "blank",
    ]);
    expect(schemaOf("insert_graph3d")).toContain("sphereTetrahedron");
    expect(schemaOf("insert_graph3d")).toContain("solidOfRevolution");
    // 描かれない入力は語彙に出さない (cutsとsection/inequality region)。propertyとして
    // 出ていないことを見る (descriptionの散文で「受け取りません」と書くのは許す)。
    expect(schemaOf("insert_graph3d")).not.toContain("\"cuts\"");
    expect(schemaOf("insert_graph3d")).not.toContain("\"inequality\"");
    expect(schemaOf("update_graph3d")).not.toContain("\"cuts\"");
    expect(propertiesOf("insert_body_content").writeMode?.description).toContain("dryRun");
    expect(propertiesOf("update_rich_content")).toHaveProperty("pagination");
    expect(propertiesOf("update_problem_content")).toHaveProperty("pagination");
    expect(propertiesOf("insert_shape").kind?.description).toContain("polyline");
    expect(propertiesOf("insert_shape").rotationDeg?.description).toContain("度");
    expect(propertiesOf("insert_shape").startAngleDeg?.description).toContain("度");
    expect(propertiesOf("insert_shape").startAngleDeg?.description).toContain("90°=下");
    expect(propertiesOf("insert_shape").endAngleDeg?.description).toContain("時計回り");
    expect(propertiesOf("insert_shape").x?.description).toContain("(x+r, y+r)");
    expect(propertiesOf("insert_shape").y?.description).toContain("(x+rx, y+ry)");
    expect(propertiesOf("insert_shape").r?.description).toContain("バウンディングボックス左上");
    expect(propertiesOf("insert_shape").w?.description).toContain("折り返し幅");
    expect(propertiesOf("insert_shape").h?.description).toContain("kind:textの高さは内容から導出されるので指定できません");
    // The removed props are gone from the surface entirely: an agent that never sees them cannot
    // spend a turn asking for a box that fits itself to its content.
    expect(propertiesOf("insert_shape")).not.toHaveProperty("maxWidth");
    expect(propertiesOf("insert_material").rotationDeg?.description).toContain("度");
    expect(propertiesOf("update_shape").rotationDeg?.description).toContain("度");
    expect(propertiesOf("update_page_layout").customSizeMm?.description).toContain("mm");
    expect(propertiesOf("update_shape")).not.toHaveProperty("autoSize");
    expect(propertiesOf("update_shape")).not.toHaveProperty("maxWidth");
    expect(propertiesOf("update_shape").h?.description).toContain("textの高さは内容から導出されるので指定できません");
    expect(propertiesOf("insert_table").intervalSigns?.description).toContain("n+1個");
    expect(propertiesOf("insert_table").grid?.description).toContain("borderStyle");
    for (const name of [
      "create_local_document",
      "update_local_document",
      "delete_local_document",
      "create_local_folder",
      "update_local_folder",
      "delete_local_folder",
    ]) {
      const properties = propertiesOf(name);
      expect(properties).not.toHaveProperty("path");
      expect(properties).not.toHaveProperty("filePath");
      expect(properties).not.toHaveProperty("directoryPath");
    }
  });

  it("publishes MCP safety annotations for read, write, and destructive tools", async () => {
    const tools = (await client.listTools()).tools;
    const byName = (name: string) => tools.find((tool) => tool.name === name)!;

    expect(byName("get_block").annotations).toMatchObject({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    expect(byName("insert_body_content").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName("delete_blocks").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName("delete_local_document").annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    });
    expect(byName("update_rich_content").annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: false,
    });
    expect(byName("update_ai_settings").annotations).toMatchObject({
      readOnlyHint: false,
      idempotentHint: true,
    });
  });

  it("publishes a common machine-readable output schema for every tool", async () => {
    const tools = (await client.listTools()).tools;
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} must publish outputSchema`).toMatchObject({
        type: "object",
        properties: {
          ok: expect.any(Object),
          data: expect.any(Object),
          error: expect.any(Object),
        },
        required: expect.arrayContaining(["ok"]),
      });
    }
  });

  it("returns the common success and actionable error envelopes", async () => {
    const status = await client.callTool({ name: "get_local_app_status", arguments: {} });
    expect(status.structuredContent).toMatchObject({
      ok: true,
      message: expect.any(String),
      data: { userDataPath: userDataDir },
    });

    const fileId = await getFileId();
    const failed = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 999, blocks: ["本文"] },
    });
    expect(failed.isError).toBe(true);
    expect(failed.structuredContent).toMatchObject({
      ok: false,
      error: {
        code: "REVISION_MISMATCH",
        retryable: true,
        nextAction: expect.any(String),
      },
    });
  });

  it("exposes exactly the documented public tool set", async () => {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    expect(toolNames).toEqual([...DOCUMENTED_TOOL_NAMES].sort());
  });

  it("categorizes every documented public tool exactly once", () => {
    const categorizedNames = MCP_TOOL_CATEGORIES.flatMap((category) => MCP_TOOL_CATEGORY_MAP[category]);

    for (const name of DOCUMENTED_TOOL_NAMES) {
      expect(
        categorizedNames.filter((categorizedName) => categorizedName === name),
        `expected documented tool ${name} in exactly one MCP category`,
      ).toHaveLength(1);
    }
    expect([...categorizedNames].sort()).toEqual([...DOCUMENTED_TOOL_NAMES].sort());
  });

  it("keeps tool-like names in official skills within the public MCP contract", async () => {
    const commonToolLikeWords = new Set([
      "expected_revision",
      "file_id",
      "math_inline",
      "run_id",
      "selected_id",
      "sigma_doc",
      "source_references",
      "target_id",
      "write_mode",
    ]);
    const officialSkillPaths = [
      path.join(__dirname, "..", "electron", "official-skills", "sigma-graph-editing", "SKILL.md"),
      path.join(__dirname, "..", "electron", "official-skills", "sigma-image-material-reconstruction", "SKILL.md"),
    ];

    for (const skillPath of officialSkillPaths) {
      const content = await fs.readFile(skillPath, "utf8");
      const toolLikeTokens = [...content.matchAll(/\b[a-z]+(?:_[a-z]+)+\b/g)].map((match) => match[0]);
      const unknownNames = [...new Set(toolLikeTokens)].filter((name) =>
        !DOCUMENTED_TOOL_NAMES.includes(name as (typeof DOCUMENTED_TOOL_NAMES)[number])
        && !commonToolLikeWords.has(name));

      expect(unknownNames, `${path.relative(process.cwd(), skillPath)} mentions unknown tool-like names`).toEqual([]);
    }
  });

  it("exposes exactly the tool set listed under docs/mcp-local-app.md's 公開ツール section", async () => {
    const toolsFromDocs = await readPublicToolNamesFromDocs();
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();

    // Set-equality both ways so a tool added/removed on either side (server or docs)
    // fails CI instead of silently drifting.
    expect(new Set(toolNames)).toEqual(new Set(toolsFromDocs));
  });

  it("exposes an optional runId parameter on every app-context tool's inputSchema", async () => {
    const appContextToolNames = [
      "get_selected_block",
      "get_insertion_candidates",
      "get_neighbor_blocks",
      "get_active_reference",
      "get_attached_media",
      "get_mentioned_sigma_docs",
    ];
    const tools = await client.listTools();
    for (const name of appContextToolNames) {
      const tool = tools.tools.find((item) => item.name === name);
      expect(tool, `expected tool ${name} to be registered`).toBeTruthy();
      const properties = tool!.inputSchema.properties as Record<string, unknown> | undefined;
      expect(properties?.runId, `expected ${name} inputSchema to declare runId`).toBeTruthy();
      expect(tool!.inputSchema.required ?? []).not.toContain("runId");
      if (name === "get_attached_media") {
        expect(properties?.attachmentId).toBeTruthy();
        expect(properties?.pageStart).toMatchObject({ type: "integer", minimum: 1 });
      }
    }
  });

  it("exposes an optional runId parameter on every write tool's inputSchema", async () => {
    const writeToolNames = [
      "insert_material",
      "insert_body_content",
      "create_problem_content",
      "update_problem_content",
      "insert_table",
      "insert_shape",
      "insert_graph",
      "insert_graph3d",
      "replace_block",
      "update_rich_content",
      "update_table",
      "update_graph",
      "update_graph3d",
      "delete_blocks",
      "move_blocks",
      "update_page_layout",
      "update_shape",
      "update_column_layout",
      "align_shapes",
      "delete_shapes",
      "begin_visual_edit_session",
    ];
    const tools = await client.listTools();
    for (const name of writeToolNames) {
      const tool = tools.tools.find((item) => item.name === name);
      expect(tool, `expected tool ${name} to be registered`).toBeTruthy();
      const inputSchema = tool!.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
        anyOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
        oneOf?: Array<{ properties?: Record<string, unknown>; required?: string[] }>;
      };
      const variants = inputSchema.anyOf ?? inputSchema.oneOf ?? [inputSchema];
      for (const variant of variants) {
        expect(
          variant.properties?.runId,
          `expected every ${name} inputSchema variant to declare runId: ${JSON.stringify(inputSchema)}`,
        ).toBeTruthy();
        expect(variant.required ?? []).not.toContain("runId");
      }
    }
  });

  it("rejects insert_body_content missing expectedRevision as an MCP tool-input error", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, blocks: ["新しい段落"] },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("expectedRevision");

    expect(await listProposalFiles()).toHaveLength(0);
  });

  it("rejects insert_body_content with a mismatched expectedRevision via the ok:false payload channel", async () => {
    // expectedRevision:999 has never existed, so the doc-block-hashes sidecar has no entry for
    // it either — the block-hash reconciliation (sigma-doc-mcp-server-core.ts's
    // reconcileStaleExpectedRevision) falls back to the plain REVISION_MISMATCH here, same as
    // before this feature existed. targetId is required so this exercises the revision check
    // specifically, not the separate "no explicit target" error (the tool runs the session
    // first now, so a request that fails both checks would otherwise report the target error).
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 999, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe("REVISION_MISMATCH");
    expect(String((payload as { error?: string }).error)).toContain("revisionが一致しません");
    expect(payload.conflictBlockIds).toBeUndefined();
    expect(await listProposalFiles()).toHaveLength(0);
  });

  it("accepts insert_body_content with a matching expectedRevision and creates a pending proposal", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.proposalCreated).toBe(true);
    expect((payload.proposal as { baseRevision?: number }).baseRevision).toBe(1);

    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    expect(files.find((file) => file.fileId === fileId)?.revision).toBe(1);
  });

  describe("stale expectedRevision block-hash reconciliation", () => {
    it("accepts a write whose expectedRevision is stale because of an unrelated block edit", async () => {
      const fileId = await getFileId();
      // revision 1 has no doc-block-hashes sidecar entry (initializeWorkspace doesn't write one,
      // only saveDocument does), so two real saves are needed before a stale expectedRevision can
      // be reconciled against a recorded hash table.
      const staleRevision = await editParagraphAndSave(fileId, "p_yotte", "(unrelated edit #1)");
      const currentRevision = await editParagraphAndSave(fileId, "p_ab_point_intro", "(unrelated edit #2)");
      expect(currentRevision).toBe(staleRevision + 1);

      const result = await client.callTool({
        name: "update_rich_content",
        arguments: { fileId, blockId: "p_source_note", text: "AIによる更新", expectedRevision: staleRevision },
      });
      const payload = extractPayload(result);
      expect(payload.ok).toBe(true);
      expect(payload.proposalCreated).toBe(true);
      // The accepted proposal is rebased onto the *current* revision, not the stale
      // expectedRevision the caller passed in.
      expect((payload.proposal as { baseRevision?: number }).baseRevision).toBe(currentRevision);
      expect(payload.revisionReconciliation).toMatchObject({
        expectedRevision: staleRevision,
        acceptedAtRevision: currentRevision,
      });
      expect(String((payload.toolResult as { message?: string }).message)).toContain("expectedRevision");
    });

    it("rejects with REVISION_MISMATCH and conflict details when the touched block itself changed", async () => {
      const fileId = await getFileId();
      const staleRevision = await editParagraphAndSave(fileId, "p_yotte", "(unrelated edit)");
      // This time the intervening edit touches the exact block our write targets.
      const currentRevision = await editParagraphAndSave(fileId, "p_source_note", "(人間が編集済み)");
      expect(currentRevision).toBe(staleRevision + 1);

      const result = await client.callTool({
        name: "update_rich_content",
        arguments: { fileId, blockId: "p_source_note", text: "AIによる上書き", expectedRevision: staleRevision },
      });
      const payload = extractPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.errorCode).toBe("REVISION_MISMATCH");
      expect(payload.retryable).toBe(true);
      expect(String((payload as { error?: string }).error)).toContain("対象ブロックが編集されているため");
      expect(payload.conflictBlockIds).toEqual(["p_source_note"]);
      const conflictBlocks = payload.conflictBlocks as Array<{ id: string; kind: string; block?: { children?: unknown[] } }>;
      expect(conflictBlocks).toHaveLength(1);
      expect(conflictBlocks[0]).toMatchObject({ id: "p_source_note", kind: "block" });
      // The current (post-human-edit) content is included, not the stale content the AI last saw.
      expect(JSON.stringify(conflictBlocks[0]?.block)).toContain("人間が編集済み");
      expect(String(payload.nextAction)).toContain(String(currentRevision));
      expect(await listProposalFiles()).toHaveLength(0);
    });

    it("falls back to the plain REVISION_MISMATCH error when the sidecar has no entry for expectedRevision", async () => {
      const fileId = await getFileId();
      const currentRevision = await editParagraphAndSave(fileId, "p_yotte", "(bump past revision 1)");

      // expectedRevision:1 is the file's very first revision, created by initializeWorkspace
      // without ever going through saveDocument, so no sidecar entry for "1" exists — this must
      // behave exactly like the pre-existing sidecar-unavailable case, not the relaxed one.
      const result = await client.callTool({
        name: "update_rich_content",
        arguments: { fileId, blockId: "p_source_note", text: "AIによる更新", expectedRevision: 1 },
      });
      const payload = extractPayload(result);
      expect(payload.ok).toBe(false);
      expect(payload.errorCode).toBe("REVISION_MISMATCH");
      expect(String((payload as { error?: string }).error)).toBe(
        `revisionが一致しません。現在: ${currentRevision}, expectedRevision: 1`,
      );
      expect(payload.conflictBlockIds).toBeUndefined();
      expect(payload.conflictBlocks).toBeUndefined();
      expect(await listProposalFiles()).toHaveLength(0);
    });
  });

  it("stamps the pending proposal with the provider from SIGMA_STUDIO_MCP_PROVIDER", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect((payload.proposal as { provider?: string }).provider).toBe("claude");
  });

  it("stamps the pending proposal with provider null when SIGMA_STUDIO_MCP_PROVIDER is unset", async () => {
    delete process.env.SIGMA_STUDIO_MCP_PROVIDER;
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect((payload.proposal as { provider?: string | null }).provider).toBeNull();
  });

  it("stamps the pending proposal with provider null when SIGMA_STUDIO_MCP_PROVIDER is garbage", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "not-a-provider";
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect((payload.proposal as { provider?: string | null }).provider).toBeNull();
  });

  it("attributes the pending proposal with runId/roomId/turnId/sessionLabel when the passed runId matches the run-context file", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const fileId = await getFileId();
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_mine" });
    await perRunStore.write({
      version: 1,
      runId: "run_mine",
      createdAt: new Date().toISOString(),
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_1",
      turnId: "turn_1",
      sessionLabel: "セッションA",
    });

    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"], runId: "run_mine" },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ runId?: string; roomId?: string; turnId?: string; sessionLabel?: string }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.runId).toBe("run_mine");
    expect(proposals[0]?.roomId).toBe("room_1");
    expect(proposals[0]?.turnId).toBe("turn_1");
    expect(proposals[0]?.sessionLabel).toBe("セッションA");
  });

  it("records the run context's requestSelection (依頼時の選択範囲) on the pending proposal", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const fileId = await getFileId();
    const requestSelection = {
      blockIds: ["p_yotte"],
      hashes: { p_yotte: "hash_of_p_yotte" },
      capturedRevision: 1,
    };
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_sel" });
    await perRunStore.write({
      version: 1,
      runId: "run_sel",
      createdAt: new Date().toISOString(),
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: "p_yotte",
      references: [],
      requestSelection,
      attachments: [],
      mentionedDocuments: [],
    });

    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"], runId: "run_sel" },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ requestSelection?: unknown }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.requestSelection).toEqual(requestSelection);
  });

  it("attributes the pending proposal with only runId when the passed runId does not match the loaded run-context file", async () => {
    // No SIGMA_STUDIO_MCP_PROVIDER: resolveWriteAttribution cannot derive the per-run file
    // name, so it falls back to reading the static run-context file regardless of the passed
    // runId. That static file belongs to a different run (stale/other), so the mismatch guard
    // must record only the caller's own runId instead of borrowing the stale file's roomId.
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const fileId = await getFileId();
    await staticStore.write({
      version: 1,
      runId: "run_context_owner",
      createdAt: new Date().toISOString(),
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_stale",
    });

    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"], runId: "run_caller" },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ runId?: string; roomId?: string }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.runId).toBe("run_caller");
    expect(proposals[0]?.roomId).toBeUndefined();
  });

  it("creates the pending proposal with no attribution fields when neither runId nor a run-context file is present", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ runId?: string; roomId?: string; turnId?: string; sessionLabel?: string }>;
    expect(proposals).toHaveLength(1);
    expect(proposals[0]?.runId).toBeUndefined();
    expect(proposals[0]?.roomId).toBeUndefined();
    expect(proposals[0]?.turnId).toBeUndefined();
    expect(proposals[0]?.sessionLabel).toBeUndefined();
  });

  it("persists a shape proposal before its slow preview render finishes, without making it auto-applicable early", async () => {
    await client.close();
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    process.env[SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV] = bridgeStore.getBridgeFilePath();

    let releaseRender!: () => void;
    let markRenderStarted!: () => void;
    const renderGate = new Promise<void>((resolve) => {
      releaseRender = resolve;
    });
    const renderStarted = new Promise<void>((resolve) => {
      markRenderStarted = resolve;
    });
    const server = createSigmaDocMcpServer({
      renderVisualPreviewDeps: {
        env: process.env,
        fetchImpl: (async () => {
          markRenderStarted();
          await renderGate;
          return new Response(JSON.stringify({
            ok: true,
            pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
            width: 10,
            height: 10,
            capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 10, h: 10 } },
            anchorBlockFound: true,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        loadResvg: async () => null,
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "early-proposal-test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const fileId = await getFileId();
    const call = client.callTool({
      name: "insert_shape",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        id: "early_visible_shape",
        kind: "rectangle",
        x: 100,
        y: 120,
        expectedRevision: 1,
      },
    });

    await renderStarted;
    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const beforeRenderCompletes = await proposalStore.findLatestPendingProposalForFile(fileId);
    expect(beforeRenderCompletes?.verification).toEqual({ validationOk: false });

    releaseRender();
    const result = extractPayload(await call);
    expect(result.ok).toBe(true);
    const verified = await proposalStore.findLatestPendingProposalForFile(fileId);
    expect(verified?.verification).toEqual({ validationOk: true, previewSource: "app-bridge" });
  });

  it("updates an unapproved inserted shape through the same room aggregate without exposing proposalId", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    const fileId = await getFileId();
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_aggregate" });
    await perRunStore.write({
      version: 1,
      runId: "run_aggregate",
      createdAt: new Date().toISOString(),
      provider: "chatgpt",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_aggregate",
      turnId: "turn_aggregate",
    });

    const inserted = extractPayload(await client.callTool({
      name: "insert_shape",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        id: "pending_shape",
        kind: "rectangle",
        x: 100,
        y: 120,
        expectedRevision: 1,
        runId: "run_aggregate",
      },
    }));
    expect(inserted.ok).toBe(true);
    expect(inserted.proposal).not.toHaveProperty("proposalId");

    const updated = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "pending_shape",
        x: 180,
        expectedRevision: 1,
        runId: "run_aggregate",
      },
    }));
    expect(updated.ok).toBe(true);
    expect(updated.proposal).not.toHaveProperty("proposalId");

    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const pending = await proposalStore.listProposals({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.draft.operations).toHaveLength(1);
    expect(pending[0]?.draft.mutationOperations).toHaveLength(1);
    expect(pending[0]?.history).toEqual([expect.objectContaining({ action: "revised" })]);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, runId: "run_aggregate", detail: "full" },
    }));
    expect(detail.proposal).not.toHaveProperty("proposalId");

    const deleted = extractPayload(await client.callTool({
      name: "delete_shapes",
      arguments: { fileId, shapeIds: ["pending_shape"], expectedRevision: 1, runId: "run_aggregate" },
    }));
    expect(deleted.ok).toBe(true);
    expect(deleted.proposalWithdrawn).toBe(true);
    expect(await proposalStore.listProposals({ status: "pending" })).toHaveLength(0);
  });

  it("keeps a reused problem-prompt id when delete_blocks is followed by create_problem_content in the same run", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    const fileId = await getFileId();
    const documentStore = new LocalSigmaDocStore(userDataDir);
    const document = await documentStore.loadDocument(fileId);
    if (!document) {
      throw new Error("test fixture document missing");
    }
    const saved = await saveAtCurrentRevision(documentStore, fileId, {
      ...document,
      content: [
        ...document.content,
        { type: "paragraph", id: "extra_p1", children: [{ type: "text", text: "図を見て面積を求めよ。" }] },
      ],
    });
    if (!saved.ok || saved.revision === undefined) {
      throw new Error(`failed to seed source paragraph: ${saved.error ?? "unknown error"}`);
    }
    const revision = saved.revision;
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_problem_conversion" });
    await perRunStore.write({
      version: 1,
      runId: "run_problem_conversion",
      createdAt: new Date().toISOString(),
      provider: "chatgpt",
      fileId,
      fileRevision: revision,
      selectedId: "extra_p1",
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_problem_conversion",
      turnId: "turn_problem_conversion",
    });

    const deleted = extractPayload(await client.callTool({
      name: "delete_blocks",
      arguments: {
        fileId,
        blockIds: ["extra_p1"],
        expectedRevision: revision,
        runId: "run_problem_conversion",
      },
    }));
    expect(deleted.ok).toBe(true);

    const created = extractPayload(await client.callTool({
      name: "create_problem_content",
      arguments: {
        fileId,
        id: "problem_from_paragraph",
        targetId: "problem_complex_square_product_range",
        prompt: [{ id: "extra_p1", type: "paragraph", text: "図を見て面積を求めよ。" }],
        answerTex: "2\\pi",
        expectedRevision: revision,
        runId: "run_problem_conversion",
      },
    }));
    expect(created.ok).toBe(true);

    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const summaries = await proposalStore.listProposals({ status: "pending" });
    expect(summaries).toHaveLength(1);
    const proposal = await proposalStore.loadProposal(summaries[0]!.proposalId);
    expect(proposal?.draft.operationOrder).toEqual([
      { kind: "mutation", index: 0 },
      { kind: "operation", index: 0 },
    ]);
    expect(proposal?.nextDocument.content.some((block) => block.id === "extra_p1")).toBe(false);
    expect(findBlock(proposal!.nextDocument, "extra_p1")).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "図を見て面積を求めよ。" }],
    });

    const persistedDocument = await documentStore.loadDocument(fileId);
    if (!persistedDocument) {
      throw new Error("document missing before proposal replay");
    }
    const replayed = createAiEditSessionDocumentDraft(persistedDocument, null, proposal!.draft).nextDocument;
    expect(findBlock(replayed, "extra_p1")).toMatchObject({
      type: "paragraph",
      children: [{ type: "text", text: "図を見て面積を求めよ。" }],
    });
  });

  it("splits math prose into adjacent body blocks within one room proposal", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    const fileId = await getFileId();
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_structural_split" });
    await perRunStore.write({
      version: 1,
      runId: "run_structural_split",
      createdAt: new Date().toISOString(),
      provider: "chatgpt",
      fileId,
      fileRevision: 1,
      selectedId: "p_ab_param_formula",
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_structural_split",
      turnId: "turn_structural_split",
    });

    const updated = extractPayload(await client.callTool({
      name: "update_rich_content",
      arguments: {
        fileId,
        blockId: "p_ab_param_formula",
        runs: [{
          type: "math",
          id: "ai_split_prefix_math",
          tex: String.raw`\begin{aligned}\frac{a^k+(k-1)b^k}{k}&\geqq ab^{k-1}\end{aligned}`,
        }],
        expectedRevision: 1,
        runId: "run_structural_split",
      },
    }));
    expect(updated.ok).toBe(true);

    const inserted = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId,
        targetId: "p_ab_param_formula",
        blocks: [
          {
            type: "paragraph",
            id: "ai_reason_left",
            align: "left",
            runs: [
              "よって，両辺を ",
              { type: "math", id: "ai_reason_k", tex: "k" },
              " 倍すると，",
            ],
          },
          {
            type: "paragraph",
            id: "ai_conclusion_math",
            align: "center",
            runs: [{
              type: "math",
              id: "ai_conclusion_math_run",
              tex: String.raw`a^k+(k-1)b^k\geqq kab^{k-1}`,
            }],
          },
        ],
        expectedRevision: 1,
        runId: "run_structural_split",
      },
    }));
    expect(inserted.ok).toBe(true);

    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const pending = await proposalStore.listProposals({ status: "pending" });
    expect(pending).toHaveLength(1);
    expect(pending[0]?.history).toEqual([expect.objectContaining({ action: "revised" })]);

    const storedProposal = pending[0]
      ? await proposalStore.loadProposal(pending[0].proposalId)
      : null;
    const nextDocument = storedProposal?.nextDocument;
    expect(nextDocument).toBeDefined();
    if (!nextDocument) {
      throw new Error("structural split proposal is missing nextDocument");
    }

    expect(findBlock(nextDocument, "p_ab_param_formula")).toMatchObject({
      type: "paragraph",
      children: [{
        type: "mathInline",
        id: "ai_split_prefix_math",
      }],
    });
    expect(findBlock(nextDocument, "ai_reason_left")).toMatchObject({
      type: "paragraph",
      align: "left",
      children: [
        { type: "text", text: "よって，両辺を " },
        { type: "mathInline", id: "ai_reason_k", tex: "k" },
        { type: "text", text: " 倍すると，" },
      ],
    });
    expect(findBlock(nextDocument, "ai_conclusion_math")).toMatchObject({
      type: "paragraph",
      children: [{
        type: "mathInline",
        id: "ai_conclusion_math_run",
      }],
    });

    const problem = findBlock(nextDocument, "problem_complex_square_product_range");
    expect(problem?.type).toBe("problem");
    if (!problem || problem.type !== "problem") {
      throw new Error("test fixture problem is missing");
    }
    const prefixIndex = problem.solution.findIndex((block) => block.id === "p_ab_param_formula");
    expect(problem.solution.slice(prefixIndex, prefixIndex + 3).map((block) => block.id)).toEqual([
      "p_ab_param_formula",
      "ai_reason_left",
      "ai_conclusion_math",
    ]);
  });

  it("rejects begin_visual_edit_session missing expectedRevision as an MCP tool-input error", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>)[0]?.text ?? "";
    expect(text).toContain("expectedRevision");
  });

  it("accepts propose_visual_edit_session when the revision advanced only via an unrelated edit during the session", async () => {
    const fileId = await getFileId();
    // Bump past revision 1 first so begin_visual_edit_session's captured revision has a
    // doc-block-hashes sidecar entry (revision 1 itself, from initializeWorkspace, has none).
    const beginRevision = await editParagraphAndSave(fileId, "p_yotte", "(setup edit)");

    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "p_source_note", expectedRevision: beginRevision },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;

    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });
    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });

    // A human edits a different paragraph (not the session's anchor) while the session was open.
    const currentRevision = await editParagraphAndSave(fileId, "p_ab_point_intro", "(unrelated edit while session was open)");
    expect(currentRevision).toBe(beginRevision + 1);

    const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(proposalResult.ok).toBe(true);
    expect(proposalResult.proposalCreated).toBe(true);
    // Rebased onto the current revision, not the stale one captured at begin.
    expect((proposalResult.proposal as { baseRevision?: number }).baseRevision).toBe(currentRevision);
    expect(proposalResult.revisionReconciliation).toMatchObject({
      expectedRevision: beginRevision,
      acceptedAtRevision: currentRevision,
    });
  });

  it("rejects propose_visual_edit_session with conflict details when the anchor block itself changed after begin", async () => {
    const fileId = await getFileId();
    const beginRevision = await editParagraphAndSave(fileId, "p_yotte", "(setup edit)");

    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "p_source_note", expectedRevision: beginRevision },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;

    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });
    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });

    // A human edits the exact paragraph the visual session anchored its new shape to.
    await editParagraphAndSave(fileId, "p_source_note", "(人間が編集済み)");

    const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(proposalResult.ok).toBe(false);
    expect(proposalResult.errorCode).toBe("REVISION_MISMATCH");
    expect(proposalResult.retryable).toBe(true);
    expect(String((proposalResult as { error?: string }).error)).toContain("対象ブロックが編集されているため");
    expect(proposalResult.conflictBlockIds).toEqual(["p_source_note"]);
    expect(await listProposalFiles()).toHaveLength(0);
  });

  it("turns a visual edit session into a pending proposal when the revision is unchanged", async () => {
    const fileId = await getFileId();
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;

    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });
    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });

    const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(proposalResult.ok).toBe(true);
    expect(proposalResult.proposalCreated).toBe(true);
    expect((proposalResult.proposal as { baseRevision?: number }).baseRevision).toBe(1);
  });

  it("stamps propose_visual_edit_session proposals with the provider from SIGMA_STUDIO_MCP_PROVIDER", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "antigravity";
    const fileId = await getFileId();
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;

    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });
    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });

    const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    expect((proposalResult.proposal as { provider?: string }).provider).toBe("antigravity");
  });

  it("attributes propose_visual_edit_session proposals with the runId passed to begin_visual_edit_session", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    const fileId = await getFileId();
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_visual" });
    await perRunStore.write({
      version: 1,
      runId: "run_visual",
      createdAt: new Date().toISOString(),
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      roomId: "room_visual",
    });

    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId: "run_visual" },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;

    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });
    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });

    const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    const proposal = proposalResult.proposal as { runId?: string; roomId?: string };
    expect(proposal.runId).toBe("run_visual");
    expect(proposal.roomId).toBe("room_visual");
  });
});

describe("sigma-doc-mcp-server new read/write tools", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-server-newtools-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await flushVisualSessionStatusWritesForTests();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function getFileId(): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  async function getOnlyPendingProposal() {
    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const proposals = await proposalStore.listProposals({ status: "pending" });
    expect(proposals).toHaveLength(1);
    const proposal = await proposalStore.loadProposal(proposals[0]!.proposalId);
    if (!proposal) {
      throw new Error("pending proposal file missing");
    }
    return proposal;
  }

  async function listProposalFiles(): Promise<string[]> {
    try {
      return await fs.readdir(path.join(userDataDir, "data", "proposals"));
    } catch {
      return [];
    }
  }

  async function readCurrentProposalNextDocument(fileId: string): Promise<SigmaDocument> {
    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const draft = (detail.proposal as { draft: AiEditSessionDraft }).draft;
    const document = await new LocalSigmaDocStore(userDataDir).loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    return createAiEditSessionDocumentDraft(document, null, draft).nextDocument;
  }

  async function editParagraphAndSave(fileId: string, blockId: string, newText: string): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error(`test fixture document missing for ${fileId}`);
    }
    const block = findBlock(document, blockId);
    if (!block || block.type !== "paragraph") {
      throw new Error(`expected a paragraph block for ${blockId}`);
    }
    (block as unknown as { children: unknown[] }).children = [{ type: "text", text: newText }];
    const result = await saveAtCurrentRevision(store, fileId, document);
    if (!result.ok || result.revision === undefined) {
      throw new Error(`failed to save test edit to ${blockId}: ${result.error ?? "unknown error"}`);
    }
    return result.revision;
  }

  // Seeds an extra top-level paragraph (and, if requested, an overlay rectangle) directly into
  // storage (bypassing the proposal flow) so delete_blocks/move_blocks/update_shape/align_shapes/
  // delete_shapes have something pre-existing to target. Returns the new revision.
  async function seedExtraParagraphAndShape(fileId: string, withShape: boolean): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const documentWithParagraph = {
      ...document,
      content: [
        ...document.content,
        { type: "paragraph" as const, id: "extra_p1", children: [{ type: "text" as const, text: "追加した段落" }] },
      ],
    };

    let nextDocument = documentWithParagraph;
    if (withShape) {
      // Build real, schema-valid overlay shapes through the same production code path
      // insert_shape uses, rather than hand-writing OverlayShape JSON (which is easy to get
      // subtly wrong against isValidOverlaySnapshot's strict shape validators).
      const session = createSigmaDocAgentSession({ document: documentWithParagraph, selectedId: "extra_p1" });
      const shapeA = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
        targetId: "extra_p1",
        id: "extra_shape_a",
        kind: "rectangle",
        x: 40,
        y: 400,
      });
      const shapeB = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
        targetId: "extra_p1",
        id: "extra_shape_b",
        kind: "rectangle",
        x: 200,
        y: 460,
      });
      if (!shapeA.ok || !shapeB.ok) {
        throw new Error(`failed to seed overlay shapes: ${shapeA.message} / ${shapeB.message}`);
      }
      nextDocument = session.draftDocument;
    }

    const result = await saveAtCurrentRevision(store, fileId, nextDocument);
    if (!result.ok) {
      throw new Error(result.error ?? "failed to seed document");
    }
    const files = await store.listFiles();
    return files.find((file) => file.fileId === fileId)?.revision ?? -1;
  }

  async function seedColumnLayoutDocument(fileId: string, withLayoutSection = false): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const columnBlocks: SigmaBlock[] = withLayoutSection
      ? [{
          type: "layoutSection",
          id: "column_section_1",
          layout: { columnCount: 2, columnGapMm: 7 },
          children: [
            { type: "paragraph", id: "p_col_1", children: [{ type: "text", text: "段組み本文1" }] },
            { type: "paragraph", id: "p_col_2", children: [{ type: "text", text: "段組み本文2" }] },
          ],
        }]
      : [
          { type: "paragraph", id: "p_col_1", children: [{ type: "text", text: "段組み本文1" }] },
          { type: "paragraph", id: "p_col_2", children: [{ type: "text", text: "段組み本文2" }] },
          { type: "paragraph", id: "p_col_3", children: [{ type: "text", text: "段組み本文3" }] },
        ];
    const nextDocument: SigmaDocument = {
      ...document,
      pageLayout: {
        ...getDefaultPageLayout(),
        preset: "B5",
        orientation: "landscape",
        pageSize: { widthMm: 257, heightMm: 182 },
        marginsMm: { top: 11, right: 12, bottom: 13, left: 14 },
      },
      content: [...document.content, ...columnBlocks],
    };
    const result = await saveAtCurrentRevision(store, fileId, nextDocument);
    if (!result.ok || result.revision === undefined) {
      throw new Error(result.error ?? "failed to seed column layout document");
    }
    return result.revision;
  }

  async function seedTextShape(fileId: string, fixed = false, kind: "text" | "callout" = "text"): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const session = createSigmaDocAgentSession({
      document,
      selectedId: "problem_complex_square_product_range",
    });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "problem_complex_square_product_range",
      id: "text_for_update",
      kind,
      x: 40,
      y: 400,
      text: "短い",
      ...(fixed ? { w: 120 } : {}),
    });
    if (!result.ok) {
      throw new Error(`failed to seed text shape: ${result.message}`);
    }
    const saved = await saveAtCurrentRevision(store, fileId, session.draftDocument);
    if (!saved.ok || saved.revision === undefined) {
      throw new Error(`failed to save text shape: ${saved.error ?? "unknown error"}`);
    }
    return saved.revision;
  }

  async function seedTableAndGraph(fileId: string): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const session = createSigmaDocAgentSession({
      document,
      selectedId: "problem_complex_square_product_range",
    });
    const table = executeSigmaDocAgentDraftTool(session, "draft_insert_table", {
      targetId: "problem_complex_square_product_range",
      id: "table_for_update",
      cells: [["x", "y"], ["1", "2"]],
    });
    const graph = executeSigmaDocAgentDraftTool(session, "draft_insert_graph", {
      targetId: "problem_complex_square_product_range",
      id: "graph_for_update",
      axes: { xLabel: "x", yLabel: "y" },
      curves: [{ id: "curve_before", expr: "x", label: "y=x" }],
      showFormulaLabels: true,
    });
    if (!table.ok || !graph.ok) {
      throw new Error(`failed to seed table/graph: ${table.message} / ${graph.message}`);
    }
    const result = await saveAtCurrentRevision(store, fileId, session.draftDocument);
    if (!result.ok) {
      throw new Error(result.error ?? "failed to seed table/graph");
    }
    const files = await store.listFiles();
    return files.find((file) => file.fileId === fileId)?.revision ?? -1;
  }

  // Directly mutates an existing tableShape's `props.table` in storage (bypassing the proposal
  // flow, like editParagraphAndSave does for a paragraph) so tests can simulate a user's manual
  // column-width/row-height resize (or grid/defaultCellStyle customization) that a subsequent
  // update_table content-mode edit must NOT reset. Returns the resulting revision.
  async function mutateTableShapeInStorage(
    fileId: string,
    shapeId: string,
    mutate: (table: Record<string, unknown>) => void,
  ): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const overlaySnapshot = document.pageLayout?.overlay?.overlaySnapshot as
      | { shapes: Array<Record<string, unknown>> }
      | undefined;
    const shape = overlaySnapshot?.shapes.find((item) => item.id === shapeId);
    if (!shape) {
      throw new Error(`table shape not found: ${shapeId}`);
    }
    const props = shape.props as Record<string, unknown>;
    mutate(props.table as Record<string, unknown>);
    const result = await saveAtCurrentRevision(store, fileId, document);
    if (!result.ok || result.revision === undefined) {
      throw new Error(`failed to mutate table shape ${shapeId}: ${result.error ?? "unknown error"}`);
    }
    return result.revision;
  }

  // Seeds a polyline and an arrow overlay shape (via the same production draft_insert_shape path
  // seedExtraParagraphAndShape uses for rectangles) so update_shape geometry tests have real,
  // schema-valid line/arrow shapes to target.
  async function seedLineAndArrowShapes(fileId: string): Promise<number> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const documentWithParagraph = {
      ...document,
      content: [
        ...document.content,
        { type: "paragraph" as const, id: "extra_p_geo", children: [{ type: "text" as const, text: "図形用の段落" }] },
      ],
    };
    const session = createSigmaDocAgentSession({ document: documentWithParagraph, selectedId: "extra_p_geo" });
    const line = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "extra_p_geo",
      id: "extra_line_a",
      kind: "polyline",
      points: [{ x: 40, y: 500 }, { x: 100, y: 520 }, { x: 160, y: 500 }],
    });
    const arrow = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "extra_p_geo",
      id: "extra_arrow_a",
      kind: "arrow",
      start: { x: 40, y: 560 },
      end: { x: 160, y: 560 },
    });
    const rectangle = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", {
      targetId: "extra_p_geo",
      id: "extra_rect_geo",
      kind: "rectangle",
      x: 40,
      y: 620,
    });
    if (!line.ok || !arrow.ok || !rectangle.ok) {
      throw new Error(`failed to seed line/arrow shapes: ${line.message} / ${arrow.message} / ${rectangle.message}`);
    }
    const result = await saveAtCurrentRevision(store, fileId, session.draftDocument);
    if (!result.ok) {
      throw new Error(result.error ?? "failed to seed line/arrow shapes");
    }
    const files = await store.listFiles();
    return files.find((file) => file.fileId === fileId)?.revision ?? -1;
  }

  // update_table/update_shape produce `updateOverlayShape` mutation ops, which live under
  // draft.mutationOperations (not draft.operations — that array is for the AiEditDraft family,
  // see sigma-doc-edit-schema.ts's AiEditSessionDraftSchema comment). Reads the first such op's
  // patch back out of a just-created proposal via get_edit_proposal(detail:"full").
  async function getProposalUpdateOverlayShapePatch(fileId: string): Promise<Record<string, unknown>> {
    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const mutationOperations = (detail.proposal as { draft: { mutationOperations?: Array<Record<string, unknown>> } })
      .draft.mutationOperations ?? [];
    const op = mutationOperations.find((item) => item.operation === "updateOverlayShape");
    if (!op) {
      throw new Error("no updateOverlayShape mutation op found on proposal");
    }
    return op.patch as Record<string, unknown>;
  }

  it("read_local_document returns a summary by default and full SigmaDoc only on request", async () => {
    const fileId = await getFileId();
    const summary = extractPayload(await client.callTool({
      name: "read_local_document",
      arguments: { fileId },
    }));
    expect(summary.ok).toBe(true);
    expect(summary.summary).toBeDefined();
    expect(summary).not.toHaveProperty("document");

    const full = extractPayload(await client.callTool({
      name: "read_local_document",
      arguments: { fileId, detail: "full" },
    }));
    expect(full.ok).toBe(true);
    expect((full.document as { content: unknown[] }).content.length).toBeGreaterThan(0);
  });

  it("keeps the estimated blockRects out of get_edit_context and only returns them from get_document_outline", async () => {
    const fileId = await getFileId();

    // blockRects はトップレベルブロック1件につき7フィールドあり、outline と同規模になる。
    // 図形の絶対座標を決めるときにしか使わないので、毎 run の起点になる読み取りには載せない。
    const editContext = extractPayload(await client.callTool({
      name: "get_edit_context",
      arguments: { fileId, targetId: sampleDocument.content[0]!.id },
    }));
    const contextSummary = (editContext.context as { summary: Record<string, unknown> }).summary;
    expect(contextSummary.blockRects).toBeUndefined();
    expect(contextSummary.outline).toBeDefined();

    const read = extractPayload(await client.callTool({
      name: "read_local_document",
      arguments: { fileId },
    }));
    expect((read.summary as Record<string, unknown>).blockRects).toBeUndefined();

    const outline = extractPayload(await client.callTool({
      name: "get_document_outline",
      arguments: { fileId },
    }));
    expect((outline.summary as Record<string, unknown>).blockRects).toBeDefined();
  });

  it("get_edit_context bundles the current revision, target block, neighbors, and outline", async () => {
    const fileId = await getFileId();
    const targetId = sampleDocument.content[0]!.id;
    const payload = extractPayload(await client.callTool({
      name: "get_edit_context",
      arguments: { fileId, targetId },
    }));

    expect(payload.ok).toBe(true);
    expect(payload.revision).toBe(1);
    const context = payload.context as {
      targetId: string;
      target: { kind: string; block: { id: string } };
      neighbors: { current: { id: string } };
      summary: { outline: unknown; pageLayout: unknown };
    };
    expect(context.targetId).toBe(targetId);
    expect(context.target).toMatchObject({ kind: "block", block: { id: targetId } });
    expect(context.neighbors.current.id).toBe(targetId);
    expect(context.summary.outline).toBeDefined();
    expect(context.summary.pageLayout).toBeDefined();
  });

  it("get_edit_context restores a multi-block text range and multiple references from runId", async () => {
    const fileId = await getFileId();
    const runId = "run_multi_selection";
    const staticRunContextStore = new LocalAiEditRunContextStore(userDataDir, "claude");
    const perRunContextStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId });
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticRunContextStore.getRunContextFilePath();
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    await perRunContextStore.write({
      version: 1,
      runId,
      createdAt: "2026-07-15T00:00:00.000Z",
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: "p_ab_point_intro",
      references: [{
        kind: "textSelection",
        targetId: "p_ab_point_intro",
        targetType: "paragraph",
        excerpt: "選択範囲",
        selectedText: "辺 AB 上の点から、よってまで",
        mathTex: ["AB"],
        textRange: {
          type: "textRange",
          start: { blockId: "p_ab_point_intro", offset: 0 },
          end: { blockId: "p_ab_product_formula", offset: 0 },
          quote: "辺 AB 上の点から、よってまで",
        },
      }, {
        kind: "block",
        targetId: "p_xy_define",
        targetType: "paragraph",
        excerpt: "別の参照",
      }],
      attachments: [],
      mentionedDocuments: [],
    });

    const payload = extractPayload(await client.callTool({
      name: "get_edit_context",
      arguments: { fileId, runId },
    }));

    expect(payload.ok).toBe(true);
    const context = payload.context as {
      targetId: string;
      selection: {
        runId: string;
        references: Array<{ selectedText?: string }>;
        referenceContexts: Array<{ blockIds: string[] }>;
        blockIds: string[];
        blocks: Array<{ id: string; block: { id: string } }>;
      };
    };
    const expectedBlockIds = [
      "p_ab_point_intro",
      "p_ab_param_formula",
      "p_yotte",
      "p_xy_define",
    ];
    expect(context.targetId).toBe("p_ab_point_intro");
    expect(context.selection.runId).toBe(runId);
    expect(context.selection.references).toHaveLength(2);
    expect(context.selection.references[0]?.selectedText).toBe("辺 AB 上の点から、よってまで");
    expect(context.selection.referenceContexts[0]?.blockIds).toEqual(expectedBlockIds.slice(0, 3));
    expect(context.selection.referenceContexts[1]?.blockIds).toEqual(["p_xy_define"]);
    expect(context.selection.blockIds).toEqual(expectedBlockIds);
    expect(context.selection.blocks.map((block) => block.id)).toEqual(expectedBlockIds);
    expect(context.selection.blocks.map((block) => block.block.id)).toEqual(expectedBlockIds);
  });

  it("rejects insert_body_content when neither targetId nor selectedId is given (no silent last-block fallback)", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload.ok).toBe(false);
    expect(String((payload as { error?: string }).error)).toContain("編集対象が指定されていません");
  });

  it("accepts insert_body_content with targetId:\"END_OF_DOCUMENT\" to explicitly append at the end", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.proposalCreated).toBe(true);
  });

  it("write-tool success responses carry changeSummary/documentSummary instead of the full draft/document", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload).not.toHaveProperty("draft");
    expect(payload).toHaveProperty("changeSummary");
    expect(payload).toHaveProperty("documentSummary");
    expect((payload.changeSummary as { operationSummaries: unknown[] }).operationSummaries).toHaveLength(1);
    expect(payload.documentSummary).toMatchObject({ blockCount: 2 });
    // The proposal echoed back must not carry the full nextDocument (the largest token sink).
    expect(payload.proposal).not.toHaveProperty("nextDocument");
  });

  it("write-tool success responses carry a verification field (validation + preview, source:none when no render bridge is configured)", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });
    const payload = extractPayload(result);
    expect(payload.ok).toBe(true);
    const verification = payload.verification as { validation: { ok: boolean; issues: string[]; issueCount: number }; preview: { source: string; warnings: string[] } };
    expect(verification.validation).toEqual({ ok: true, issues: [], issueCount: 0 });
    // No SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV is configured in this describe block's env, and a
    // plain text write has no overlay shape for the svg-fallback path to draw either, so preview
    // must degrade to source:"none" without failing the write itself.
    expect(verification.preview.source).toBe("none");
    expect(payload).toHaveProperty("nextAction");
    // No image content block when there is nothing to render.
    const imageBlocks = (result.content as Array<{ type: string }>).filter((block) => block.type === "image");
    expect(imageBlocks).toHaveLength(0);
  });

  it("search_document finds a match in the problem prompt text with an excerpt", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "search_document",
      arguments: { fileId, query: "複素数平面" },
    }));
    expect(result.ok).toBe(true);
    expect(result.totalMatches).toBeGreaterThan(0);
    const matches = result.matches as Array<{ blockId: string; field: string; excerpt: string }>;
    expect(matches.some((match) => match.blockId === "p_problem_statement")).toBe(true);
    expect(matches[0]?.excerpt).toContain("複素数平面");
  });

  async function createExtraLibraryDocument(title: string, content: SigmaBlock[]): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = parseSigmaDocument({
      version: "2.0",
      docId: `doc_${title}`,
      metadata: { title },
      content,
      outputProfiles: { student: {}, teacher: {}, answerBook: {} },
    });
    const { file } = await store.createFileFromDocument({ document });
    return file.fileId;
  }

  it("search_library finds a match in a document other than one specified via excludeFileId", async () => {
    const currentFileId = await getFileId();
    const otherFileId = await createExtraLibraryDocument("過去教材", [
      { type: "paragraph", id: "p_other", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    const result = extractPayload(await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId },
    }));

    expect(result.ok).toBe(true);
    const documents = result.documents as Array<{ fileId: string }>;
    expect(documents.some((doc) => doc.fileId === otherFileId)).toBe(true);
    expect(documents.some((doc) => doc.fileId === currentFileId)).toBe(false);
  });

  it("cites a searched-then-read document even when the model omits sourceReferences", async () => {
    const currentFileId = await getFileId();
    const otherFileId = await createExtraLibraryDocument("参照した過去教材", [
      { type: "paragraph", id: "p_other", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId, runId: "run_cite" },
    });
    await client.callTool({
      name: "get_blocks",
      arguments: { fileId: otherFileId, blockIds: ["p_other"], runId: "run_cite" },
    });

    // モデルは sourceReferences を一切指定しない。それでもチップが出るのが受入基準。
    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId: currentFileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"], runId: "run_cite" },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ sourceReferences?: Array<{ type: string; fileId?: string; title?: string }> }>;
    expect(proposals[0]?.sourceReferences).toEqual([
      { type: "document", fileId: otherFileId, title: "参照した過去教材" },
    ]);
  });

  it("does not cite a search hit that was never read", async () => {
    const currentFileId = await getFileId();
    await createExtraLibraryDocument("ヒットしただけの教材", [
      { type: "paragraph", id: "p_unread", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId, runId: "run_unread" },
    });

    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId: currentFileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"], runId: "run_unread" },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ sourceReferences?: unknown }>;
    expect(proposals[0]?.sourceReferences).toBeUndefined();
  });

  it("keeps the blockId the model supplied when folding it with the ledger's citation", async () => {
    const currentFileId = await getFileId();
    const otherFileId = await createExtraLibraryDocument("blockId付きで挙がる教材", [
      { type: "paragraph", id: "p_block", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId, runId: "run_blockid" },
    });
    await client.callTool({
      name: "get_blocks",
      arguments: { fileId: otherFileId, blockIds: ["p_block"], runId: "run_blockid" },
    });

    await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId: currentFileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 1,
        blocks: ["新しい段落"],
        runId: "run_blockid",
        sourceReferences: [{ type: "document", fileId: otherFileId, blockId: "p_block" }],
      },
    });

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ sourceReferences?: Array<{ fileId?: string; blockId?: string; title?: string }> }>;
    // 台帳側の title と、モデルが補足した blockId の両方が1件に残ること。
    expect(proposals[0]?.sourceReferences).toEqual([
      { type: "document", fileId: otherFileId, title: "blockId付きで挙がる教材", blockId: "p_block" },
    ]);
  });

  it("cites the ledger even when the model omits runId on the write tool", async () => {
    const currentFileId = await getFileId();
    const otherFileId = await createExtraLibraryDocument("書き込みでrunId省略", [
      { type: "paragraph", id: "p_norunid", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    await staticStore.write({
      version: 1,
      runId: "run_norunid",
      createdAt: new Date().toISOString(),
      provider: "chatgpt",
      fileId: currentFileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    });

    await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId, runId: "run_norunid" },
    });
    await client.callTool({
      name: "get_blocks",
      arguments: { fileId: otherFileId, blockIds: ["p_norunid"], runId: "run_norunid" },
    });

    // 書き込みツールでは runId を省略する。run-context から実 runId が解決されるので、
    // 台帳の引用も一緒に付いてこなければならない。
    await client.callTool({
      name: "insert_body_content",
      arguments: { fileId: currentFileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["新しい段落"] },
    });

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ sourceReferences?: Array<{ fileId?: string }> }>;
    expect(proposals[0]?.sourceReferences?.map((reference) => reference.fileId)).toEqual([otherFileId]);
  });

  it("folds the ledger citation and the model's own declaration into one chip", async () => {
    const currentFileId = await getFileId();
    const otherFileId = await createExtraLibraryDocument("両方から挙がる教材", [
      { type: "paragraph", id: "p_both", children: [{ type: "text", text: "複素数平面上の点を図示する。" }] },
    ]);

    await client.callTool({
      name: "search_library",
      arguments: { query: "複素数平面", excludeFileId: currentFileId, runId: "run_both" },
    });
    await client.callTool({
      name: "get_blocks",
      arguments: { fileId: otherFileId, blockIds: ["p_both"], runId: "run_both" },
    });

    // モデルが title 無しで同じ教材を申告しても、enrich→dedupe の順で1件に畳まれる。
    const result = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId: currentFileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 1,
        blocks: ["新しい段落"],
        runId: "run_both",
        sourceReferences: [{ type: "document", fileId: otherFileId }],
      },
    }));
    expect(result.ok).toBe(true);

    const listed = extractPayload(await client.callTool({ name: "list_edit_proposals", arguments: {} }));
    const proposals = listed.proposals as Array<{ sourceReferences?: Array<{ fileId?: string }> }>;
    expect(proposals[0]?.sourceReferences).toHaveLength(1);
  });

  it("search_library scope:'problems' returns problem-shaped hits with prompt/tags in the excerpt", async () => {
    await createExtraLibraryDocument("問題教材", [
      {
        type: "problem",
        id: "problem_coords",
        tags: ["座標平面"],
        lead: [],
        prompt: [{ type: "paragraph", id: "p_prompt", children: [{ type: "text", text: "座標平面上の点Aの座標を求めよ。" }] }],
        solution: [],
        hints: [],
      },
    ]);

    const result = extractPayload(await client.callTool({
      name: "search_library",
      arguments: { query: "座標平面", scope: "problems" },
    }));

    expect(result.ok).toBe(true);
    expect(result.scope).toBe("problems");
    const documents = result.documents as Array<{ matches: Array<{ blockId: string; blockType: string; areaPath: string; excerpt: string }> }>;
    const match = documents.flatMap((doc) => doc.matches).find((item) => item.blockId === "problem_coords");
    expect(match).toBeDefined();
    expect(match?.blockType).toBe("problem");
    expect(match?.areaPath).toMatch(/^problem_\d+$/);
    expect(match?.excerpt).toContain("座標平面上の点A");
    expect(match?.excerpt).toContain("座標平面");
  });

  it("skips a corrupt/unparseable document file without failing the whole search_library call", async () => {
    const corruptFileId = await createExtraLibraryDocument("壊れた教材", [
      { type: "paragraph", id: "p_corrupt", children: [{ type: "text", text: "検索対象キーワード" }] },
    ]);
    const goodFileId = await createExtraLibraryDocument("無事な教材", [
      { type: "paragraph", id: "p_good", children: [{ type: "text", text: "検索対象キーワード" }] },
    ]);
    const documentPath = path.join(
      userDataDir,
      "data",
      "documents",
      `${encodeURIComponent(corruptFileId)}.sigmadoc.json`,
    );
    await fs.writeFile(documentPath, "{ this is not valid JSON", "utf8");

    const result = extractPayload(await client.callTool({
      name: "search_library",
      arguments: { query: "検索対象キーワード" },
    }));

    expect(result.ok).toBe(true);
    const documents = result.documents as Array<{ fileId: string }>;
    expect(documents.some((doc) => doc.fileId === goodFileId)).toBe(true);
    expect(documents.some((doc) => doc.fileId === corruptFileId)).toBe(false);
  });

  it("get_blocks returns a light view by default and the full block only with includeFull:true", async () => {
    const fileId = await getFileId();
    const light = extractPayload(await client.callTool({
      name: "get_blocks",
      arguments: { fileId, blockIds: ["p_problem_statement", "does_not_exist"] },
    }));
    const lightBlocks = light.blocks as Array<Record<string, unknown>>;
    expect(lightBlocks[0]).toMatchObject({ blockId: "p_problem_statement", found: true, type: "paragraph" });
    expect(lightBlocks[0]).not.toHaveProperty("block");
    expect(lightBlocks[1]).toMatchObject({ blockId: "does_not_exist", found: false });

    const full = extractPayload(await client.callTool({
      name: "get_blocks",
      arguments: { fileId, blockIds: ["p_problem_statement"], includeFull: true },
    }));
    const fullBlocks = full.blocks as Array<Record<string, unknown>>;
    expect(fullBlocks[0]).toHaveProperty("block");
    expect((fullBlocks[0].block as { id: string }).id).toBe("p_problem_statement");
  });

  it("replace_block replaces an existing block in place via a pending proposal", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "replace_block",
      arguments: {
        fileId,
        blockId: "p_source_note",
        block: { type: "paragraph", id: "p_source_note", children: [{ type: "text", text: "更新済みの出典" }] },
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);
  });

  it("update_rich_content preserves the paragraph identity while replacing typed runs", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_rich_content",
      arguments: {
        fileId,
        blockId: "p_source_note",
        runs: ["更新後 ", { type: "math", id: "ai_math_updated", tex: "x^2" }],
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operation = ((detail.proposal as { draft: { operations: Array<Record<string, unknown>> } }).draft.operations[0]);
    const replacement = operation.replacementBlock as { id: string; type: string; children: Array<Record<string, unknown>> };
    expect(replacement).toMatchObject({ id: "p_source_note", type: "paragraph" });
    expect(replacement.children).toContainEqual(expect.objectContaining({ type: "mathInline", id: "ai_math_updated", tex: "x^2" }));
  });

  it("apply_edits copy-with replaces only the text delta and inherits the existing inline style", async () => {
    const fileId = await getFileId();
    const documentStore = new LocalSigmaDocStore(userDataDir);
    const document = await documentStore.loadDocument(fileId);
    const block = document ? findBlock(document, "p_source_note") : null;
    if (!document || !block || block.type !== "paragraph") {
      throw new Error("paragraph fixture missing");
    }
    block.children = [{
      type: "text",
      text: "変更前の本文",
      marks: ["bold"],
      color: "#123456",
      fontFamily: 'ui-serif, "Yu Mincho", serif',
      fontSize: 14,
    }];
    const saved = await saveAtCurrentRevision(documentStore, fileId, document);
    if (!saved.ok || saved.revision === undefined) {
      throw new Error(saved.error ?? "failed to seed styled paragraph");
    }

    const result = extractPayload(await client.callTool({
      name: "apply_edits",
      arguments: {
        fileId,
        operations: [{
          op: "replace_text",
          target: {
            type: "range",
            blockId: "p_source_note",
            from: 0,
            to: 3,
            quote: "変更前",
          },
          replacement: "更新後",
        }],
        expectedRevision: saved.revision,
      },
    }));
    expect(result.ok).toBe(true);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operation = (detail.proposal as { draft: { operations: Array<Record<string, unknown>> } })
      .draft.operations[0];
    const replacement = operation.replacementBlock as Extract<SigmaBlock, { type: "paragraph" }>;
    expect(inlineNodesToPlainText(replacement.children)).toBe("更新後の本文");
    expect(replacement.children).toEqual([{
      type: "text",
      text: "更新後の本文",
      marks: ["bold"],
      color: "#123456",
      fontFamily: 'ui-serif, "Yu Mincho", serif',
      fontSize: 14,
    }]);
  });

  it("apply_edits formats the active text selection without rewriting its content", async () => {
    const fileId = await getFileId();
    const documentStore = new LocalSigmaDocStore(userDataDir);
    const document = await documentStore.loadDocument(fileId);
    const block = document ? findBlock(document, "p_source_note") : null;
    if (!block || block.type !== "paragraph") {
      throw new Error("paragraph fixture missing");
    }
    const originalText = inlineNodesToPlainText(block.children);
    expect(originalText.length).toBeGreaterThanOrEqual(2);

    const runId = "run_format_selection";
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId });
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    await perRunStore.write({
      version: 1,
      runId,
      createdAt: "2026-08-18T00:00:00.000Z",
      provider: "chatgpt",
      fileId,
      fileRevision: 1,
      selectedId: "p_source_note",
      references: [{
        kind: "textSelection",
        targetId: "p_source_note",
        targetType: "paragraph",
        excerpt: originalText.slice(0, 2),
        selectedText: originalText.slice(0, 2),
        mathTex: [],
        textRange: {
          type: "textRange",
          start: { blockId: "p_source_note", offset: 0 },
          end: { blockId: "p_source_note", offset: 2 },
          quote: originalText.slice(0, 2),
        },
      }],
      attachments: [],
      mentionedDocuments: [],
    });

    const result = extractPayload(await client.callTool({
      name: "apply_edits",
      arguments: {
        fileId,
        runId,
        operations: [{
          op: "format_inline",
          target: { type: "activeSelection" },
          style: {
            fontFamilyToken: "mincho",
            fontSizePt: 14,
            boxed: { enabled: true, variant: "double", tone: "blue" },
          },
        }],
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, runId, detail: "full" },
    }));
    const operation = (detail.proposal as { draft: { operations: Array<Record<string, unknown>> } })
      .draft.operations[0];
    const replacement = operation.replacementBlock as Extract<SigmaBlock, { type: "paragraph" }>;
    expect(inlineNodesToPlainText(replacement.children)).toBe(originalText);
    expect(replacement.children[0]).toMatchObject({
      fontSize: 14,
      marks: expect.arrayContaining(["boxed"]),
      boxedVariant: "double",
      boxedTone: "blue",
    });
  });

  it("apply_edits formats every selected overlay text shape while preserving its content", async () => {
    const fileId = await getFileId();
    const documentStore = new LocalSigmaDocStore(userDataDir);
    const document = await documentStore.loadDocument(fileId);
    if (!document) {
      throw new Error("document fixture missing");
    }
    const seedSession = createSigmaDocAgentSession({
      document,
      selectedId: "problem_complex_square_product_range",
    });
    for (const [id, text, y] of [["format_text_a", "図形A", 400], ["format_text_b", "図形B", 460]] as const) {
      const inserted = executeSigmaDocAgentDraftTool(seedSession, "draft_insert_shape", {
        targetId: "problem_complex_square_product_range",
        id,
        kind: "text",
        x: 40,
        y,
        text,
      });
      if (!inserted.ok) {
        throw new Error(inserted.message);
      }
    }
    const saved = await saveAtCurrentRevision(documentStore, fileId, seedSession.draftDocument);
    if (!saved.ok || saved.revision === undefined) {
      throw new Error(saved.error ?? "failed to seed overlay text shapes");
    }

    const selectedShapes = normalizeOverlaySnapshot(
      seedSession.draftDocument.pageLayout?.overlay?.overlaySnapshot,
    ).shapes.filter((shape) => shape.id === "format_text_a" || shape.id === "format_text_b");
    const runId = "run_format_overlay_selection";
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    const staticStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId });
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticStore.getRunContextFilePath();
    await perRunStore.write({
      version: 1,
      runId,
      createdAt: "2026-08-18T00:00:00.000Z",
      provider: "chatgpt",
      fileId,
      fileRevision: saved.revision,
      selectedId: "problem_complex_square_product_range",
      references: [{
        kind: "block",
        targetId: "problem_complex_square_product_range",
        targetType: "problem",
        excerpt: "",
        overlaySelection: {
          selectedShapeIds: ["format_text_a", "format_text_b"],
          shapes: selectedShapes,
          assets: {},
        },
      }],
      attachments: [],
      mentionedDocuments: [],
    });

    const result = extractPayload(await client.callTool({
      name: "apply_edits",
      arguments: {
        fileId,
        runId,
        operations: [{
          op: "format_inline",
          target: { type: "overlaySelection" },
          style: {
            fontFamilyToken: "mincho",
            fontSizePt: 16,
            boxed: { enabled: true, variant: "double" },
          },
        }],
        expectedRevision: saved.revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);

    const nextDocument = await readCurrentProposalNextDocument(fileId);
    const formattedShapes = normalizeOverlaySnapshot(nextDocument.pageLayout?.overlay?.overlaySnapshot).shapes
      .filter((shape) => shape.id === "format_text_a" || shape.id === "format_text_b");
    expect(formattedShapes).toHaveLength(2);
    for (const shape of formattedShapes) {
      expect(shape.type).toBe("text");
      if (shape.type !== "text") continue;
      expect(getOverlayTextBlocksLabelText(shape.props.blocks)).toBe(shape.id === "format_text_a" ? "図形A" : "図形B");
      expect(overlayTextBlocksToInlineNodes(shape.props.blocks)[0]).toMatchObject({
        fontSize: 16,
        marks: expect.arrayContaining(["boxed"]),
        boxedVariant: "double",
      });
    }
  });

  it("update_rich_content can update pagination without rewriting paragraph content", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_rich_content",
      arguments: {
        fileId,
        blockId: "p_source_note",
        pagination: { break: true, keepTogether: true, keepWithNext: true },
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operation = ((detail.proposal as { draft: { operations: Array<Record<string, unknown>> } }).draft.operations[0]);
    expect(operation.replacementBlock).toMatchObject({
      id: "p_source_note",
      pagination: { break: true, keepTogether: true, keepWithNext: true },
    });
  });

  it("update_problem_content updates prompt without requiring a full problem replacement", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_problem_content",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        prompt: [{ id: "ai_prompt_updated", text: "更新後の問題文" }],
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);
  });

  it("writeMode:dryRun validates a write without creating a proposal", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_rich_content",
      arguments: {
        fileId,
        blockId: "p_source_note",
        text: "dry run",
        writeMode: "dryRun",
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(false);
    expect(result.proposal).toBeNull();
    const proposals = extractPayload(await client.callTool({
      name: "list_edit_proposals",
      arguments: { status: "pending" },
    }));
    expect(proposals.proposals).toEqual([]);
  });

  it("update_page_layout partially updates page settings and preserves unspecified fields", async () => {
    const fileId = await getFileId();
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document?.pageLayout) {
      throw new Error("test fixture page layout missing");
    }
    document.pageLayout.flow = { type: "columns", columnCount: 2, columnGapMm: 11 };
    const previousLayout = structuredClone(document.pageLayout);
    const saved = await saveAtCurrentRevision(store, fileId, document);
    expect(saved.ok).toBe(true);

    const outline = extractPayload(await client.callTool({
      name: "get_document_outline",
      arguments: { fileId },
    }));
    expect((outline.summary as { pageLayout?: unknown }).pageLayout).toMatchObject({
      preset: previousLayout.preset,
      orientation: previousLayout.orientation,
      marginsMm: previousLayout.marginsMm,
      flow: previousLayout.flow,
    });

    const result = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: {
        fileId,
        orientation: "landscape",
        marginsMm: { right: 24 },
        expectedRevision: saved.revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);
    expect((result.changeSummary as { revisionInfo?: { changedIds?: string[] } }).revisionInfo?.changedIds).toEqual([]);
    const preview = (result.verification as { preview: { source: string } }).preview;
    if (resvgAvailable) {
      expect(preview.source).not.toBe("none");
    }

    const proposal = await getOnlyPendingProposal();
    expect(proposal.nextDocument.pageLayout).toMatchObject({
      preset: previousLayout.preset,
      orientation: "landscape",
      marginsMm: {
        top: previousLayout.marginsMm.top,
        right: 24,
        bottom: previousLayout.marginsMm.bottom,
        left: previousLayout.marginsMm.left,
      },
      flow: previousLayout.flow,
    });
    expect(proposal.nextDocument.pageLayout?.header).toEqual(previousLayout.header);
    expect(proposal.nextDocument.pageLayout?.footer).toEqual(previousLayout.footer);
  });

  it("update_page_layout accepts a custom preset and dimensions", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: {
        fileId,
        preset: "custom",
        customSizeMm: { widthMm: 160, heightMm: 240 },
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);

    const proposal = await getOnlyPendingProposal();
    expect(proposal.nextDocument.pageLayout).toMatchObject({
      preset: "custom",
      orientation: "portrait",
      pageSize: { widthMm: 160, heightMm: 240 },
    });
  });

  it("update_page_layout rejects margins that erase the minimum body height", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: {
        fileId,
        marginsMm: { top: 280 },
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(false);
    // 文面は `shape.validation.pageMarginTooTall` に一本化した (以前は同じ趣旨の
    // 注意書きが二重に並んでいた)。
    expect(String(result.error)).toContain("上下の余白は本文を30mm以上残すように");
    expect(await new LocalMcpEditProposalStore(userDataDir).listProposals({ status: "pending" })).toEqual([]);
  });

  it("update_page_layout requires expectedRevision and at least one page field", async () => {
    const fileId = await getFileId();
    const missingRevision = await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, orientation: "landscape" },
    });
    expect(missingRevision.isError).toBe(true);
    expect((missingRevision.content as Array<{ text?: string }>)[0]?.text).toContain("expectedRevision");

    const missingPatch = await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, expectedRevision: 1 },
    });
    expect(missingPatch.isError).toBe(true);
    expect((missingPatch.content as Array<{ text?: string }>)[0]?.text).toContain("いずれかを指定");

    const customSizeWithoutCustomPreset = await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, preset: "A4", customSizeMm: { widthMm: 200 }, expectedRevision: 1 },
    });
    expect(customSizeWithoutCustomPreset.isError).toBe(true);
    expect((customSizeWithoutCustomPreset.content as Array<{ text?: string }>)[0]?.text).toContain("customSizeMmはpreset");
  });

  it("update_page_layout rejects a recorded stale revision and succeeds after re-reading the fresh revision", async () => {
    const fileId = await getFileId();
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document?.pageLayout) {
      throw new Error("test fixture page layout missing");
    }

    // Record a real historical revision, then make a concurrent page-setting change. Before the
    // updatePageLayout guard, changedIds/touchedIds were both empty, so reconciliation compared an
    // empty hash set and incorrectly accepted this stale expectedRevision.
    const recorded = await saveAtCurrentRevision(store, fileId, document);
    expect(recorded.ok).toBe(true);
    document.pageLayout.marginsMm.left = 23;
    const concurrent = await saveAtCurrentRevision(store, fileId, document);
    expect(concurrent.ok).toBe(true);
    expect(concurrent.revision).toBe(recorded.revision! + 1);

    const staleResult = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, orientation: "landscape", expectedRevision: recorded.revision },
    }));
    expect(staleResult.ok).toBe(false);
    expect(staleResult.errorCode).toBe("REVISION_MISMATCH");
    expect(staleResult.currentRevision).toBe(concurrent.revision);
    expect(String(staleResult.error)).toContain("現在のページ設定を読み直し");
    expect(await new LocalMcpEditProposalStore(userDataDir).listProposals({ status: "pending" })).toEqual([]);

    const freshResult = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, orientation: "landscape", expectedRevision: concurrent.revision },
    }));
    expect(freshResult.ok).toBe(true);
    expect(freshResult.proposalCreated).toBe(true);
    expect((freshResult.proposal as { baseRevision?: number }).baseRevision).toBe(concurrent.revision);

    const proposal = await getOnlyPendingProposal();
    expect(proposal.nextDocument.pageLayout).toMatchObject({
      orientation: "landscape",
      marginsMm: { left: 23 },
    });
  });

  it("update_page_layout supports dryRun without creating a proposal", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: {
        fileId,
        preset: "B5",
        marginsMm: { left: 20 },
        writeMode: "dryRun",
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(false);
    expect(result.proposal).toBeNull();
    expect((result.verification as { validation: { ok: boolean } }).validation.ok).toBe(true);
    expect(await new LocalMcpEditProposalStore(userDataDir).listProposals({ status: "pending" })).toEqual([]);
  });

  it("rejects invalid variation-table cardinality before looking up the target shape", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "missing_table",
        kind: "variation",
        criticalPoints: ["0"],
        intervalSigns: ["+"],
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(String(result.error)).toContain("2個必要");
  });

  it("rejects a parametric graph curve without yExpr", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "update_graph",
      arguments: {
        fileId,
        shapeId: "missing_graph",
        curves: [{ id: "curve_1", expr: "cos(t)", mode: "parametric" }],
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("INVALID_INPUT");
    expect(String(result.error)).toContain("yExpr");
  });

  it("update_table and update_graph apply typed updates to existing overlay shapes", async () => {
    const fileId = await getFileId();
    const revision = await seedTableAndGraph(fileId);

    const table = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        kind: "plain",
        cells: [["更新", "後"], [3, 4]],
        expectedRevision: revision,
      },
    }));
    expect(table.ok).toBe(true);
    expect((table.verification as { validation: { ok: boolean } }).validation.ok).toBe(true);

    const graph = extractPayload(await client.callTool({
      name: "update_graph",
      arguments: {
        fileId,
        shapeId: "graph_for_update",
        axes: { xLabel: "t", yLabel: "s" },
        curves: [{ id: "curve_after", expr: "x^2", label: "s=t^2" }],
        showFormulaLabels: true,
        expectedRevision: revision,
      },
    }));
    expect(graph.ok).toBe(true);
    expect((graph.verification as { validation: { ok: boolean } }).validation.ok).toBe(true);
  });

  it("update_graph recreates axis and formula labels with valid ownership maps", async () => {
    const fileId = await getFileId();
    let revision = await seedTableAndGraph(fileId);
    const store = new LocalSigmaDocStore(userDataDir);
    const before = await store.loadDocument(fileId);
    if (!before) {
      throw new Error("seeded document missing");
    }
    const beforeShapes = before?.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const beforeGraph = beforeShapes.find((shape) => shape.id === "graph_for_update");
    expect(beforeGraph?.type).toBe("graph2dShape");
    if (!beforeGraph || beforeGraph.type !== "graph2dShape") {
      throw new Error("seeded graph missing");
    }
    const oldLabelIds = new Set([
      ...Object.values(beforeGraph.props.axisLabelTextShapeIds ?? {}),
      ...Object.values(beforeGraph.props.labelTextShapeIdsByCurveId ?? {}),
      ...(beforeGraph.props.labelTextShapeIds ?? []),
    ]);
    const editedLabelTextById = new Map([
      [beforeGraph.props.axisLabelTextShapeIds?.x, "edited x"],
      [beforeGraph.props.labelTextShapeIdsByCurveId?.curve_before, "edited formula"],
    ].filter((entry): entry is [string, string] => typeof entry[0] === "string"));
    for (const shape of beforeShapes) {
      const text = editedLabelTextById.get(shape.id);
      if (shape.type !== "text" || text === undefined) {
        continue;
      }
      shape.props.blocks = [{ type: "paragraph", id: `p_${shape.id}`, children: [{ type: "text", text }] }];
    }
    const savedEdit = await saveAtCurrentRevision(store, fileId, before);
    expect(savedEdit.ok).toBe(true);
    revision = savedEdit.revision ?? revision;

    const result = extractPayload(await client.callTool({
      name: "update_graph",
      arguments: {
        fileId,
        shapeId: "graph_for_update",
        title: "更新後のグラフ",
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);

    const stored = await new LocalMcpEditProposalStore(userDataDir).findLatestPendingProposalForFile(fileId);
    const nextShapes = stored?.nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const nextGraph = nextShapes.find((shape) => shape.id === "graph_for_update");
    expect(nextGraph?.type).toBe("graph2dShape");
    if (!nextGraph || nextGraph.type !== "graph2dShape") {
      throw new Error("updated graph missing");
    }

    const xLabelId = nextGraph.props.axisLabelTextShapeIds?.x;
    const yLabelId = nextGraph.props.axisLabelTextShapeIds?.y;
    const formulaLabelId = nextGraph.props.labelTextShapeIdsByCurveId?.curve_before;
    expect(xLabelId).toBeDefined();
    expect(yLabelId).toBeDefined();
    expect(formulaLabelId).toBeDefined();
    expect(nextGraph.props.labelTextShapeIds).toEqual([formulaLabelId]);
    expect(nextGraph.props.spec.title).toBe("更新後のグラフ");
    expect(nextGraph.props.spec.axes.xLabel).toBe("");
    expect(nextGraph.props.spec.axes.yLabel).toBe("");

    const labelsById = new Map(nextShapes.map((shape) => [shape.id, shape]));
    const xLabel = xLabelId ? labelsById.get(xLabelId) : undefined;
    const yLabel = yLabelId ? labelsById.get(yLabelId) : undefined;
    const formulaLabel = formulaLabelId ? labelsById.get(formulaLabelId) : undefined;
    expect(xLabel?.type).toBe("text");
    expect(yLabel?.type).toBe("text");
    expect(formulaLabel?.type).toBe("text");
    if (xLabel?.type !== "text" || yLabel?.type !== "text" || formulaLabel?.type !== "text") {
      throw new Error("recreated graph labels missing");
    }
    expect(getOverlayTextBlocksLabelText(xLabel.props.blocks)).toBe("edited x");
    expect(getOverlayTextBlocksLabelText(yLabel.props.blocks)).toBe("y");
    expect(getOverlayTextBlocksLabelText(formulaLabel.props.blocks)).toBe("edited formula");
    for (const label of [xLabel, yLabel, formulaLabel]) {
      expect(label.anchor).toMatchObject({ type: "shape", shapeId: nextGraph.id });
      expect(oldLabelIds.has(label.id)).toBe(false);
    }
    for (const oldLabelId of oldLabelIds) {
      expect(labelsById.has(oldLabelId)).toBe(false);
    }
  });

  it("update_table content-mode edit (cells only) preserves a pre-existing fixed column width/row height/grid/defaultCellStyle", async () => {
    const fileId = await getFileId();
    await seedTableAndGraph(fileId);
    const revision = await mutateTableShapeInStorage(fileId, "table_for_update", (table) => {
      (table.columns as Array<Record<string, unknown>>)[0].width = { mode: "fixed", value: 123 };
      (table.rows as Array<Record<string, unknown>>)[1].height = { mode: "fixed", value: 61 };
      const grid = table.grid as Record<string, unknown>;
      grid.borderColor = "#ff00ff";
      grid.borderWidth = 3;
      const defaultCellStyle = table.defaultCellStyle as Record<string, unknown>;
      defaultCellStyle.backgroundColor = "#eeeeee";
      defaultCellStyle.color = "#123456";
    });

    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        // Only `cells` is re-specified — width/height/grid/defaultCellStyle are NOT, so the
        // content-mode rebuild must inherit them from the existing table instead of resetting
        // them to hard-coded auto/fr defaults.
        cells: [["a", "b"], ["c", "d"]],
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const table = ((patch.props as Record<string, unknown>).table) as Record<string, unknown>;

    expect((table.columns as Array<Record<string, unknown>>)[0].width).toEqual({ mode: "fixed", value: 123 });
    expect((table.rows as Array<Record<string, unknown>>)[1].height).toEqual({ mode: "fixed", value: 61 });
    expect((table.grid as Record<string, unknown>).borderColor).toBe("#ff00ff");
    expect((table.grid as Record<string, unknown>).borderWidth).toBe(3);
    expect((table.defaultCellStyle as Record<string, unknown>).backgroundColor).toBe("#eeeeee");
    expect((table.defaultCellStyle as Record<string, unknown>).color).toBe("#123456");
  });

  it("update_table cellPatches replaces exactly one cell's content and leaves every other cell/column/row/grid/style untouched", async () => {
    const fileId = await getFileId();
    await seedTableAndGraph(fileId);
    const revision = await mutateTableShapeInStorage(fileId, "table_for_update", (table) => {
      (table.columns as Array<Record<string, unknown>>)[0].width = { mode: "fixed", value: 90 };
      (table.rows as Array<Record<string, unknown>>)[0].height = { mode: "fixed", value: 40 };
    });
    const store = new LocalSigmaDocStore(userDataDir);
    const before = await store.loadDocument(fileId);
    const beforeShape = ((before?.pageLayout?.overlay?.overlaySnapshot as unknown as { shapes: Array<Record<string, unknown>> })
      .shapes.find((item) => item.id === "table_for_update"))!;
    const beforeTable = (beforeShape.props as Record<string, unknown>).table as Record<string, unknown>;

    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        cellPatches: [{ row: 0, col: 1, content: "patched" }],
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const afterTable = ((patch.props as Record<string, unknown>).table) as Record<string, unknown>;

    // Columns/rows/grid/defaultCellStyle are byte-for-byte identical — no rebuild happened.
    expect(afterTable.columns).toEqual(beforeTable.columns);
    expect(afterTable.rows).toEqual(beforeTable.rows);
    expect(afterTable.grid).toEqual(beforeTable.grid);
    expect(afterTable.defaultCellStyle).toEqual(beforeTable.defaultCellStyle);

    const beforeCells = beforeTable.cells as Array<Record<string, unknown>>;
    const afterCells = afterTable.cells as Array<Record<string, unknown>>;
    const targetColumnId = (beforeTable.columns as Array<Record<string, unknown>>)[1]!.id;
    const targetRowId = (beforeTable.rows as Array<Record<string, unknown>>)[0]!.id;
    expect(afterCells).toHaveLength(beforeCells.length);
    for (let index = 0; index < beforeCells.length; index += 1) {
      const beforeCell = beforeCells[index]!;
      const afterCell = afterCells[index]!;
      if (beforeCell.rowId === targetRowId && beforeCell.columnId === targetColumnId) {
        expect(afterCell.content).not.toEqual(beforeCell.content);
        const paragraph = (afterCell.content as Array<Record<string, unknown>>)[0] as { children: Array<{ text?: string }> };
        expect(paragraph.children.some((child) => child.text === "patched")).toBe(true);
      } else {
        expect(afterCell).toEqual(beforeCell);
      }
    }
  });

  it("update_table w/h-only path preserves table content and only changes shape size", async () => {
    const fileId = await getFileId();
    const revision = await seedTableAndGraph(fileId);
    const store = new LocalSigmaDocStore(userDataDir);
    const before = await store.loadDocument(fileId);
    const beforeShape = ((before?.pageLayout?.overlay?.overlaySnapshot as unknown as { shapes: Array<Record<string, unknown>> })
      .shapes.find((item) => item.id === "table_for_update"))!;
    const beforeTable = (beforeShape.props as Record<string, unknown>).table;

    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        w: 400,
        h: 200,
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const props = patch.props as Record<string, unknown>;
    expect(props.w).toBe(400);
    expect(props.h).toBe(200);
    // w/h-only means the table content is carried over completely untouched.
    expect(props.table).toEqual(beforeTable);
  });

  it("update_table with ONLY grid style preserves all cells/columns/rows and just changes the border (no 1x1 collapse)", async () => {
    const fileId = await getFileId();
    const revision = await seedTableAndGraph(fileId);
    const before = await loadStoredTable(fileId, "table_for_update");

    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: { fileId, shapeId: "table_for_update", grid: { borderWidth: 3 }, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const table = ((patch.props as Record<string, unknown>).table) as Record<string, unknown>;

    // No rebuild: columns/rows/cells identical (this is the regression the collapse-to-1x1 bug hit).
    expect(table.columns).toEqual(before.columns);
    expect(table.rows).toEqual(before.rows);
    expect(table.cells).toEqual(before.cells);
    expect((table.cells as unknown[]).length).toBe((before.cells as unknown[]).length);
    // Only the requested grid field changed; other grid fields inherited from the existing table.
    expect((table.grid as Record<string, unknown>).borderWidth).toBe(3);
    expect((table.grid as Record<string, unknown>).borderColor).toBe((before.grid as Record<string, unknown>).borderColor);
  });

  it("update_table with {cellPatches, grid} patches the cell AND keeps every other cell (no collapse)", async () => {
    const fileId = await getFileId();
    const revision = await seedTableAndGraph(fileId);
    const before = await loadStoredTable(fileId, "table_for_update");

    const result = extractPayload(await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        cellPatches: [{ row: 0, col: 1, content: "patched" }],
        grid: { borderWidth: 5 },
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const table = ((patch.props as Record<string, unknown>).table) as Record<string, unknown>;

    expect(table.columns).toEqual(before.columns);
    expect(table.rows).toEqual(before.rows);
    expect((table.grid as Record<string, unknown>).borderWidth).toBe(5);

    const beforeCells = before.cells as Array<Record<string, unknown>>;
    const afterCells = table.cells as Array<Record<string, unknown>>;
    expect(afterCells).toHaveLength(beforeCells.length);
    const targetColumnId = (before.columns as Array<Record<string, unknown>>)[1]!.id;
    const targetRowId = (before.rows as Array<Record<string, unknown>>)[0]!.id;
    for (let index = 0; index < beforeCells.length; index += 1) {
      const beforeCell = beforeCells[index]!;
      const afterCell = afterCells[index]!;
      if (beforeCell.rowId === targetRowId && beforeCell.columnId === targetColumnId) {
        const paragraph = (afterCell.content as Array<Record<string, unknown>>)[0] as { children: Array<{ text?: string }> };
        expect(paragraph.children.some((child) => child.text === "patched")).toBe(true);
      } else {
        expect(afterCell).toEqual(beforeCell);
      }
    }
  });

  it("update_table rejects a cellPatches entry with no content (required-content schema, avoids silent wipe)", async () => {
    const fileId = await getFileId();
    const revision = await seedTableAndGraph(fileId);
    // `content` is required on a cellPatches entry, so the MCP SDK rejects this at the input-schema
    // layer (same channel as the missing-expectedRevision case above).
    const result = await client.callTool({
      name: "update_table",
      arguments: {
        fileId,
        shapeId: "table_for_update",
        cellPatches: [{ row: 0, col: 0 }],
        expectedRevision: revision,
      },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as Array<{ text?: string }>).map((item) => item.text ?? "").join("\n");
    expect(text).toContain("content");
  });

  it("delete_blocks removes a top-level block and move_blocks reorders top-level blocks", async () => {
    const fileId = await getFileId();
    const revision = await seedExtraParagraphAndShape(fileId, false);

    const deleteResult = extractPayload(await client.callTool({
      name: "delete_blocks",
      arguments: { fileId, blockIds: ["extra_p1"], expectedRevision: revision },
    }));
    expect(deleteResult.ok).toBe(true);
    expect(deleteResult.proposalCreated).toBe(true);
    expect((deleteResult.documentSummary as { blockCount: number }).blockCount).toBe(1);

    const moveResult = extractPayload(await client.callTool({
      name: "move_blocks",
      arguments: {
        fileId,
        blockIds: ["extra_p1"],
        targetId: "problem_complex_square_product_range",
        position: "before",
        expectedRevision: revision,
      },
    }));
    expect(moveResult.ok).toBe(true);
    expect(moveResult.proposalCreated).toBe(true);
  });

  it("move_blocks accepts targetId:\"END_OF_DOCUMENT\" to move a block to the end", async () => {
    const fileId = await getFileId();
    const revision = await seedExtraParagraphAndShape(fileId, false);

    const result = extractPayload(await client.callTool({
      name: "move_blocks",
      arguments: {
        fileId,
        blockIds: ["problem_complex_square_product_range"],
        targetId: "END_OF_DOCUMENT",
        position: "after",
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
  });

  it("update_column_layout sets document columns without changing page preset or margins", async () => {
    const fileId = await getFileId();
    const revision = await seedColumnLayoutDocument(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_column_layout",
      arguments: {
        fileId,
        scope: "document",
        columnCount: 2,
        columnGapMm: 6,
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);
    expect((result.documentSummary as { changedIds: string[] }).changedIds).toEqual([]);
    expect(result.verification).toMatchObject({
      validation: { ok: true },
      preview: { source: expect.any(String) },
    });

    const nextDocument = await readCurrentProposalNextDocument(fileId);
    expect(nextDocument.pageLayout).toMatchObject({
      preset: "B5",
      orientation: "landscape",
      pageSize: { widthMm: 257, heightMm: 182 },
      marginsMm: { top: 11, right: 12, bottom: 13, left: 14 },
      flow: { columnCount: 2, columnGapMm: 6 },
    });
  });

  it("update_column_layout returns validation and a PNG preview when the render bridge is available", async () => {
    await client.close();
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: 1,
      createdAt: new Date().toISOString(),
    });
    process.env[SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV] = bridgeStore.getBridgeFilePath();
    const png = Buffer.from(PNG_MAGIC_BYTES);
    let renderRequest: { targetId?: unknown; focus?: { pageIndex?: unknown } } | null = null;
    const server = createSigmaDocMcpServer({
      renderVisualPreviewDeps: {
        env: process.env,
        fetchImpl: (async (_input, init) => {
          renderRequest = JSON.parse(String(init?.body)) as typeof renderRequest;
          return new Response(JSON.stringify({
            ok: true,
            pngBase64: png.toString("base64"),
            width: 10,
            height: 10,
            capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 10, h: 10 } },
            anchorBlockFound: true,
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        loadResvg: async () => null,
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "column-preview-test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

    const fileId = await getFileId();
    const result = await client.callTool({
      name: "update_column_layout",
      arguments: { fileId, scope: "document", columnCount: 2, expectedRevision: 1, writeMode: "dryRun" },
    });
    const payload = extractPayload(result);
    expect(payload.verification).toMatchObject({
      validation: { ok: true },
      preview: { source: "app-bridge" },
    });
    expect(renderRequest).toMatchObject({ targetId: expect.any(String), focus: { pageIndex: 0 } });
    const images = (result.content as Array<{ type: string; data?: string; mimeType?: string }>)
      .filter((item) => item.type === "image");
    expect(images).toHaveLength(1);
    expect(images[0]?.mimeType).toBe("image/png");
    expect(Buffer.from(images[0]!.data!, "base64")).toEqual(png);
  });

  it("update_column_layout wraps blocks and the resulting layoutSection appears in get_document_outline", async () => {
    const fileId = await getFileId();
    const revision = await seedColumnLayoutDocument(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_column_layout",
      arguments: {
        fileId,
        scope: "blocks",
        blockIds: ["p_col_1", "p_col_2"],
        columnCount: 2,
        columnGapMm: 5,
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect((result.documentSummary as { changedIds: string[] }).changedIds).toEqual(["p_col_1", "p_col_2"]);

    const nextDocument = await readCurrentProposalNextDocument(fileId);
    const layoutSection = nextDocument.content.find((block) => block.type === "layoutSection");
    expect(layoutSection).toMatchObject({
      type: "layoutSection",
      layout: { columnCount: 2, columnGapMm: 5 },
      children: [{ id: "p_col_1" }, { id: "p_col_2" }],
    });

    const store = new LocalSigmaDocStore(userDataDir);
    const saved = await saveAtCurrentRevision(store, fileId, nextDocument);
    expect(saved.ok).toBe(true);
    const outline = extractPayload(await client.callTool({
      name: "get_document_outline",
      arguments: { fileId },
    }));
    expect((outline.summary as { outline: Array<{ id: string; type: string; title: string }> }).outline)
      .toContainEqual(expect.objectContaining({ id: layoutSection?.id, type: "layoutSection", title: "2段組" }));
  });

  it("update_column_layout unwraps an existing layoutSection", async () => {
    const fileId = await getFileId();
    const revision = await seedColumnLayoutDocument(fileId, true);

    const result = extractPayload(await client.callTool({
      name: "update_column_layout",
      arguments: {
        fileId,
        scope: "section",
        sectionId: "column_section_1",
        unwrap: true,
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect((result.documentSummary as { changedIds: string[] }).changedIds).toEqual(["column_section_1"]);

    const nextDocument = await readCurrentProposalNextDocument(fileId);
    expect(nextDocument.content.some((block) => block.id === "column_section_1")).toBe(false);
    expect(nextDocument.content.slice(-2).map((block) => block.id)).toEqual(["p_col_1", "p_col_2"]);
  });

  it("update_column_layout rejects a stale expectedRevision for document scope without reconciliation", async () => {
    const fileId = await getFileId();
    const staleRevision = await seedColumnLayoutDocument(fileId);
    const currentRevision = await editParagraphAndSave(fileId, "p_col_3", "人間が編集した本文");
    expect(currentRevision).toBe(staleRevision + 1);

    const result = extractPayload(await client.callTool({
      name: "update_column_layout",
      arguments: {
        fileId,
        scope: "document",
        columnCount: 3,
        expectedRevision: staleRevision,
      },
    }));
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe("REVISION_MISMATCH");
    expect(String(result.error)).toBe(
      `revisionが一致しません。現在: ${currentRevision}, expectedRevision: ${staleRevision}`,
    );
    expect(result.revisionReconciliation).toBeUndefined();
  });

  it("update_column_layout supports dryRun without creating a proposal", async () => {
    const fileId = await getFileId();
    const revision = await seedColumnLayoutDocument(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_column_layout",
      arguments: {
        fileId,
        scope: "document",
        columnCount: 2,
        writeMode: "dryRun",
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(false);
    expect(result.proposal).toBeNull();
    expect(await listProposalFiles()).toEqual([]);
  });

  it("update_shape/align_shapes/delete_shapes operate on existing overlay shapes via pending proposals", async () => {
    const fileId = await getFileId();
    const revision = await seedExtraParagraphAndShape(fileId, true);

    const updateResult = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_shape_a", color: "#ff0000", expectedRevision: revision },
    }));
    expect(updateResult.ok).toBe(true);
    expect(updateResult.proposalCreated).toBe(true);

    const alignResult = extractPayload(await client.callTool({
      name: "align_shapes",
      arguments: { fileId, shapeIds: ["extra_shape_a", "extra_shape_b"], mode: "left", expectedRevision: revision },
    }));
    expect(alignResult.ok).toBe(true);

    const deleteResult = extractPayload(await client.callTool({
      name: "delete_shapes",
      arguments: { fileId, shapeIds: ["extra_shape_b"], expectedRevision: revision },
    }));
    expect(deleteResult.ok).toBe(true);
  });

  it("update_shape converts text input to blocks and remeasures the text shape height", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        text: "あいうえおかきくけこ",
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const props = patch.props as Record<string, unknown>;
    const blocks = props.blocks as Array<{ children?: Array<{ type?: string; text?: string }> }>;

    expect(props).not.toHaveProperty("text");
    expect(props).not.toHaveProperty("w");
    expect(blocks[0]?.children?.[0]).toMatchObject({ type: "text", text: "あいうえおかきくけこ" });
    // One line of content is one line of box. Wrapping is the editor's to measure; this process
    // has no DOM and only keeps the stored height from being shorter than the content's own lines.
    expect(props).toMatchObject({ h: 16 });
  });

  it.each(["text", "callout"] as const)("update_shape overrides existing %s inline sizes instead of reporting an invisible size change", async (kind) => {
    const fileId = await getFileId();
    await seedTextShape(fileId, false, kind);
    const store = new LocalSigmaDocStore(userDataDir);
    const document = (await store.loadDocument(fileId))!;
    const shape = document.pageLayout!.overlay!.overlaySnapshot!.shapes.find((item) => item.id === "text_for_update")!;
    if (shape.type !== "text" && shape.type !== "callout") throw new Error("expected text shape");
    shape.props.blocks = [{ type: "paragraph", id: "sized_run", children: [
      { type: "text", text: "短い", fontSize: 9, fontFamily: "serif", marks: ["bold"] },
    ] }];
    const saved = await saveAtCurrentRevision(store, fileId, document);
    const result = extractPayload(await client.callTool({ name: "update_shape", arguments: {
      fileId, shapeId: shape.id, fontSize: 18, expectedRevision: saved.revision,
    } }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    expect(patch.props).toMatchObject({ fontSize: 18, blocks: [{ children: [
      { text: "短い", fontSize: 18, fontFamily: "serif", marks: ["bold"] },
    ] }] });
  });

  it("update_shape remeasures the text height after a fontSize change", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        fontSize: 18,
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);

    // Bigger glyphs make a taller line, so the stored floor rises with them.
    expect(patch.props).toMatchObject({ fontSize: 18, h: 24 });
  });

  it("update_shape converts tex input to block math and remeasures it", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        tex: "x^2+1",
        expectedRevision: revision,
      },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const blocks = (patch.props as { blocks: Array<{ children?: Array<{ type?: string; tex?: string }> }> }).blocks;

    expect(patch.props).not.toHaveProperty("tex");
    expect(blocks[0]?.children?.[0]).toMatchObject({ type: "mathInline", tex: "x^2+1" });
    // A formula is one line here too: how tall its box really is depends on the rendered glyphs,
    // which only the editor can measure.
    expect(patch.props).toMatchObject({ h: 16 });
  });

  it("update_shape re-measures the height at the stored width and leaves the width alone", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId, true);

    const fixedResult = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        text: "あいうえおかきくけこ",
        fontSize: 18,
        expectedRevision: revision,
      },
    }));
    expect(fixedResult.ok).toBe(true);
    const fixedPatch = await getProposalUpdateOverlayShapePatch(fileId);
    // The width belongs to whoever set it; only the derived height follows the new content.
    expect(fixedPatch.props).not.toHaveProperty("w");
    expect(fixedPatch.props).toMatchObject({ fontSize: 18 });
    expect(typeof (fixedPatch.props as { h?: unknown }).h).toBe("number");
  });

  it("update_shape takes the wrap width from w", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId);

    const fixedResult = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        w: 125,
        expectedRevision: revision,
      },
    }));
    expect(fixedResult.ok).toBe(true);
    const fixedPatch = await getProposalUpdateOverlayShapePatch(fileId);

    expect(fixedPatch.props).toMatchObject({ w: 125 });
  });

  /**
   * The height is a cache of what the editor measured, so a caller naming one is asking for a
   * number that will be overwritten. Refused rather than accepted and dropped, which is how the
   * rest of this tool treats a prop that does not apply.
   */
  it("update_shape refuses a height on a text shape", async () => {
    const fileId = await getFileId();
    const revision = await seedTextShape(fileId);

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "text_for_update",
        h: 50,
        expectedRevision: revision,
      },
    }));

    expect(result.ok).toBe(false);
    expect(String(result.error ?? "")).toContain("h");
  });

  it("converts MCP shape angles from degrees to overlay radians", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "insert_shape",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        kind: "arc",
        x: 100,
        y: 120,
        r: 40,
        rotationDeg: 90,
        startAngleDeg: 30,
        endAngleDeg: 150,
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operations = (detail.proposal as { draft: { operations: Array<Record<string, unknown>> } }).draft.operations;
    const operation = operations.find((item) => item.operation === "insertOverlayShape");
    expect(operation).toBeDefined();
    const shape = operation!.overlayShape as { rotation: number; props: { startAngle: number; endAngle: number } };
    expect(shape.rotation).toBeCloseTo(Math.PI / 2);
    expect(shape.props.startAngle).toBeCloseTo(Math.PI / 6);
    expect(shape.props.endAngle).toBeCloseTo((Math.PI * 5) / 6);
  });

  it("insert_shape creates one rich-text callout with three independent tail points", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "insert_shape",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        kind: "callout",
        x: 100,
        y: 120,
        w: 180,
        h: 72,
        text: "式を確認",
        cornerRadius: 28,
        tailBaseStart: { x: 0, y: 36 },
        tailBaseEnd: { x: 110, y: 72 },
        tailTip: { x: 220, y: 110 },
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operations = (detail.proposal as { draft: { operations: Array<Record<string, unknown>> } }).draft.operations;
    const insertOperations = operations.filter((item) => item.operation === "insertOverlayShape");
    expect(insertOperations).toHaveLength(1);

    const shape = insertOperations[0]!.overlayShape as {
      type: string;
      props: {
        blocks: Array<{ children?: Array<{ type?: string; text?: string }> }>;
        radius: number;
        tail: { baseStart: { x: number; y: number }; baseEnd: { x: number; y: number }; tip: { x: number; y: number } };
      };
    };
    expect(shape.type).toBe("callout");
    expect(shape.props.radius).toBe(28);
    expect(shape.props.blocks[0]?.children?.[0]).toMatchObject({ type: "text", text: "式を確認" });
    expect(shape.props.tail).toEqual({
      baseStart: { x: 0, y: 36 },
      baseEnd: { x: 110, y: 72 },
      tip: { x: 220, y: 110 },
    });
  });

  it("converts insert_material additional rotation from degrees to overlay radians", async () => {
    const fileId = await getFileId();
    const material = await new LocalMaterialStore(userDataDir).createMaterial({
      name: "回転素材",
      transformPolicy: { scale: true, rotate: true },
      content: {
        blocks: [],
        overlaySnapshot: {
          version: 1,
          assets: {},
          shapes: [{
            id: "material_shape",
            type: "geo",
            x: 0,
            y: 0,
            rotation: Math.PI / 6,
            props: {
              w: 80,
              h: 40,
              geo: "rectangle",
              fill: "none",
              color: "black",
              labelColor: "black",
              dash: "solid",
              size: "m",
            },
          }],
        },
      },
    });
    const result = extractPayload(await client.callTool({
      name: "insert_material",
      arguments: {
        fileId,
        targetId: "problem_complex_square_product_range",
        materialId: material.id,
        rotationDeg: 90,
        expectedRevision: 1,
      },
    }));
    expect(result.ok).toBe(true);

    const detail = extractPayload(await client.callTool({
      name: "get_edit_proposal",
      arguments: { fileId, detail: "full" },
    }));
    const operations = (detail.proposal as { draft: { operations: Array<Record<string, unknown>> } }).draft.operations;
    const operation = operations.find((item) => item.operation === "insertOverlayShape");
    expect(operation).toBeDefined();
    const shape = operation!.overlayShape as { rotation: number };
    expect(shape.rotation).toBeCloseTo((Math.PI * 2) / 3);
  });

  it("converts update_shape rotation from degrees to overlay radians", async () => {
    const fileId = await getFileId();
    const revision = await seedExtraParagraphAndShape(fileId, true);
    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_shape_a", rotationDeg: 135, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);

    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    expect(patch.rotation).toBeCloseTo((Math.PI * 3) / 4);
  });

  // Builds the exact line/arrow shape insert_shape would produce for the given ABSOLUTE geometry,
  // via the same production draft path insert_shape uses. Used to assert insert/update coordinate
  // parity: update_shape must normalize absolute coords to the same local-origin form.
  async function insertShapeReferenceShape(
    fileId: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const session = createSigmaDocAgentSession({ document, selectedId: "extra_p_geo" });
    const result = executeSigmaDocAgentDraftTool(session, "draft_insert_shape", { targetId: "extra_p_geo", ...args });
    if (!result.ok) {
      throw new Error(`reference insert_shape failed: ${result.message}`);
    }
    const shapes = (session.draftDocument.pageLayout?.overlay?.overlaySnapshot as unknown as { shapes: Array<Record<string, unknown>> }).shapes;
    return shapes.find((shape) => shape.id === (args.id as string))!;
  }

  async function loadStoredOverlayShape(fileId: string, shapeId: string): Promise<Record<string, unknown>> {
    const store = new LocalSigmaDocStore(userDataDir);
    const document = await store.loadDocument(fileId);
    const shapes = (document?.pageLayout?.overlay?.overlaySnapshot as unknown as { shapes: Array<Record<string, unknown>> } | undefined)?.shapes ?? [];
    const shape = shapes.find((item) => item.id === shapeId);
    if (!shape) {
      throw new Error(`stored overlay shape not found: ${shapeId}`);
    }
    return shape;
  }

  async function loadStoredTable(fileId: string, shapeId: string): Promise<Record<string, unknown>> {
    const shape = await loadStoredOverlayShape(fileId, shapeId);
    return (shape.props as Record<string, unknown>).table as Record<string, unknown>;
  }

  it("update_shape on a line normalizes ABSOLUTE points to local origin, shifts the anchor by delta, and matches insert_shape geometry", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    const before = await loadStoredOverlayShape(fileId, "extra_line_a");
    const beforeAnchor = before.anchor as { dx: number; dy: number };
    const absolutePoints = [{ x: 60, y: 600 }, { x: 120, y: 640 }, { x: 180, y: 600 }];

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_line_a", points: absolutePoints, closed: false, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const props = patch.props as Record<string, unknown>;

    // Origin normalization: x/y = first absolute point, props.points relative to it.
    expect(patch.x).toBe(60);
    expect(patch.y).toBe(600);
    expect(props.points).toEqual([{ x: 0, y: 0 }, { x: 60, y: 40 }, { x: 120, y: 0 }]);
    expect(props.closed).toBe(false);
    // Block anchor recomputed by DELTA from the shape's old position (NOT overwritten with abs y/x).
    const anchor = patch.anchor as { type: string; blockId: string; dx: number; dy: number };
    expect(anchor.type).toBe("block");
    expect(anchor.blockId).toBe("extra_p_geo");
    expect(anchor.dx).toBe(beforeAnchor.dx + (60 - (before.x as number)));
    expect(anchor.dy).toBe(beforeAnchor.dy + (600 - (before.y as number)));
    // Other existing props are NOT in the patch (preserved via patchShape's shallow merge).
    expect(props).not.toHaveProperty("color");
    expect(props).not.toHaveProperty("dash");

    // GEOMETRY parity (x/y, relative points): insert_shape given the SAME absolute points produces
    // the same local-origin geometry. Anchor convention legitimately differs (update deltas from
    // the existing anchor; insert has none and is corrected by reanchor-on-save), so it is not
    // compared here.
    const reference = await insertShapeReferenceShape(fileId, { id: "ref_line", kind: "polyline", points: absolutePoints });
    const refProps = reference.props as Record<string, unknown>;
    expect(reference.x).toBe(patch.x);
    expect(reference.y).toBe(patch.y);
    expect(refProps.points).toEqual(props.points);
  });

  it("update_shape echoing a line's existing absolute points back PRESERVES its position (anchor unchanged)", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    const before = await loadStoredOverlayShape(fileId, "extra_line_a");
    const beforeAnchor = before.anchor as Record<string, unknown>;
    const beforePoints = (before.props as { points: Array<{ x: number; y: number }> }).points;
    // Reconstruct the current ABSOLUTE points and echo them back unchanged.
    const absolutePoints = beforePoints.map((p) => ({ x: (before.x as number) + p.x, y: (before.y as number) + p.y }));

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_line_a", points: absolutePoints, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    expect(patch.x).toBe(before.x);
    expect(patch.y).toBe(before.y);
    // Zero delta → the anchor is byte-for-byte the existing one (no drop by blockTop).
    expect(patch.anchor).toEqual(beforeAnchor);
  });

  it("update_shape on an arrow normalizes ABSOLUTE start/end to start-origin, shifts the anchor by delta, and matches insert_shape geometry", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    const before = await loadStoredOverlayShape(fileId, "extra_arrow_a");
    const beforeAnchor = before.anchor as { dx: number; dy: number };
    const absStart = { x: 70, y: 700 };
    const absEnd = { x: 220, y: 730 };

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_arrow_a", start: absStart, end: absEnd, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const props = patch.props as Record<string, unknown>;

    expect(patch.x).toBe(70);
    expect(patch.y).toBe(700);
    expect(props.start).toEqual({ x: 0, y: 0 });
    expect(props.end).toEqual({ x: 150, y: 30 });
    const anchor = patch.anchor as { dx: number; dy: number };
    expect(anchor.dx).toBe(beforeAnchor.dx + (70 - (before.x as number)));
    expect(anchor.dy).toBe(beforeAnchor.dy + (700 - (before.y as number)));

    const reference = await insertShapeReferenceShape(fileId, { id: "ref_arrow", kind: "arrow", start: absStart, end: absEnd });
    const refProps = reference.props as Record<string, unknown>;
    expect(reference.x).toBe(patch.x);
    expect(reference.y).toBe(patch.y);
    expect(refProps.start).toEqual(props.start);
    expect(refProps.end).toEqual(props.end);
  });

  it("update_shape on an arrow with ONLY end supplied reconstructs the existing absolute start", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    // Seeded arrow: start abs {40,560}, end abs {160,560}. Existing start must be preserved.
    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_arrow_a", end: { x: 300, y: 600 }, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    const props = patch.props as Record<string, unknown>;

    // Origin stays at the existing absolute start {40,560}; end recomputed relative to it.
    expect(patch.x).toBe(40);
    expect(patch.y).toBe(560);
    expect(props.start).toEqual({ x: 0, y: 0 });
    expect(props.end).toEqual({ x: 260, y: 40 });
  });

  it("update_shape with ONLY closed on a line leaves coordinates/anchor untouched", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_line_a", closed: true, expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    expect(patch.x).toBeUndefined();
    expect(patch.y).toBeUndefined();
    expect(patch.anchor).toBeUndefined();
    expect((patch.props as Record<string, unknown>).closed).toBe(true);
    expect((patch.props as Record<string, unknown>).points).toBeUndefined();
  });

  it("update_shape changes ONLY an endpoint marker (arrowheadEnd) and preserves position/points/color/other end", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);
    const before = await loadStoredOverlayShape(fileId, "extra_line_a");

    const result = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_line_a", arrowheadEnd: "arrow", expectedRevision: revision },
    }));
    expect(result.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);

    // 差分更新: patch には端点マーカーだけが載り、位置・点列・anchor には触れない
    // (delete+insert の作り直しではないので他プロパティが既定値へリセットされることもない)。
    expect(patch.x).toBeUndefined();
    expect(patch.y).toBeUndefined();
    expect(patch.anchor).toBeUndefined();
    const props = patch.props as Record<string, unknown>;
    expect(props).toEqual({ arrowheadEnd: "arrow" });

    // 適用後の after-state でも位置・長さ・色・反対端が保持されることを、提案レコードの
    // nextDocument (get_edit_proposal は返さないためストアから直接読む) で確認する。
    const stored = await new LocalMcpEditProposalStore(userDataDir).findLatestPendingProposalForFile(fileId);
    const nextShapes = stored?.nextDocument.pageLayout?.overlay?.overlaySnapshot?.shapes ?? [];
    const after = nextShapes.find((shape) => shape.id === "extra_line_a") as Record<string, unknown> | undefined;
    expect(after).toBeDefined();
    const afterProps = after!.props as Record<string, unknown>;
    const beforeProps = before.props as Record<string, unknown>;
    expect(afterProps.arrowheadEnd).toBe("arrow");
    expect(afterProps.arrowheadStart).toEqual(beforeProps.arrowheadStart);
    expect(afterProps.points).toEqual(beforeProps.points);
    expect(afterProps.color).toEqual(beforeProps.color);
    expect(after!.x).toBe(before.x);
    expect(after!.y).toBe(before.y);
    expect(after!.anchor).toEqual(before.anchor);
  });

  it("update_shape accepts arrowheadStart on an arrow and rejects arrowheads on a shape without endpoint markers", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);

    const onArrow = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_arrow_a", arrowheadStart: "dot", expectedRevision: revision },
    }));
    expect(onArrow.ok).toBe(true);
    const patch = await getProposalUpdateOverlayShapePatch(fileId);
    expect(patch.props).toEqual({ arrowheadStart: "dot" });

    const onRectangle = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: { fileId, shapeId: "extra_rect_geo", arrowheadEnd: "arrow", expectedRevision: revision },
    }));
    expect(onRectangle.ok).toBe(false);
    expect(String(onRectangle.error)).toContain("arrowheadStart/arrowheadEnd");
  });

  it("update_shape rejects points/closed on a shape that isn't a line, and start/end on a shape that isn't an arrow", async () => {
    const fileId = await getFileId();
    const revision = await seedLineAndArrowShapes(fileId);

    const pointsOnRectangle = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "extra_rect_geo",
        points: [{ x: 0, y: 0 }, { x: 10, y: 10 }],
        expectedRevision: revision,
      },
    }));
    expect(pointsOnRectangle.ok).toBe(false);
    expect(String(pointsOnRectangle.error)).toContain("line");

    const startEndOnLine = extractPayload(await client.callTool({
      name: "update_shape",
      arguments: {
        fileId,
        shapeId: "extra_line_a",
        start: { x: 0, y: 0 },
        expectedRevision: revision,
      },
    }));
    expect(startEndOnLine.ok).toBe(false);
    expect(String(startEndOnLine.error)).toContain("arrow");
  });

  it("reports an invalid replace_block payload with a readable field-path message via formatToolError, not a raw ZodError dump", async () => {
    const fileId = await getFileId();
    const result = await client.callTool({
      name: "replace_block",
      arguments: {
        fileId,
        blockId: "p_source_note",
        block: { type: "not_a_real_block_type" },
        expectedRevision: 1,
      },
    });
    expect(result.isError).toBe(true);
    const content = result.content as Array<{ type: string; text?: string }>;
    const message = content
      .filter((item): item is { type: "text"; text: string } => item.type === "text")
      .map((item) => item.text)
      .join("\n");
    expect(message).toContain("block");
    expect(message).not.toContain("[object Object]");
  });

  it("get_document_outline lists overlay shapes (id/type/description/anchorBlockId) alongside the block outline", async () => {
    const fileId = await getFileId();
    await seedExtraParagraphAndShape(fileId, true);

    const result = extractPayload(await client.callTool({
      name: "get_document_outline",
      arguments: { fileId },
    }));
    expect(result.ok).toBe(true);
    const summary = result.summary as { overlayShapeCount: number; overlayShapes: Array<Record<string, unknown>> };
    expect(summary.overlayShapeCount).toBe(2);
    const shapeIds = summary.overlayShapes.map((shape) => shape.id);
    expect(shapeIds).toEqual(expect.arrayContaining(["extra_shape_a", "extra_shape_b"]));
    const shapeA = summary.overlayShapes.find((shape) => shape.id === "extra_shape_a");
    expect(shapeA).toMatchObject({ id: "extra_shape_a", type: "geo", anchorBlockId: "extra_p1" });
    expect(typeof shapeA?.description).toBe("string");
  });

  it("delete_blocks reports an actionable error (pointing to delete_shapes) when the id is an overlay shape, not a body block", async () => {
    const fileId = await getFileId();
    const revision = await seedExtraParagraphAndShape(fileId, true);

    const result = extractPayload(await client.callTool({
      name: "delete_blocks",
      arguments: { fileId, blockIds: ["extra_shape_a"], expectedRevision: revision },
    }));
    expect(result.ok).toBe(false);
    const message = String((result.toolResult as { message?: string })?.message ?? "");
    expect(message).toContain("delete_shapes");
    expect(message).toContain("overlay図形");
  });
});

describe("render_block_context / render_page", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-server-blockcontext-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    await flushVisualSessionStatusWritesForTests();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function getFileId(): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  it("degrades to source:none without failing when blockId is a plain text block and no render bridge is configured", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId, blockId: "p_source_note" },
    }));
    expect(result.ok).toBe(false);
    expect((result.preview as { source?: string })?.source).toBe("none");
    expect(String(result.error)).toContain("previewを生成できませんでした");
  });

  it("render_page requires exactly one of pageNumber and blockId", async () => {
    const fileId = await getFileId();
    for (const arguments_ of [
      { fileId },
      { fileId, pageNumber: 1, blockId: "p_source_note" },
    ]) {
      const result = extractPayload(await client.callTool({ name: "render_page", arguments: arguments_ }));
      expect(result.ok).toBe(false);
      expect(String(result.error)).toContain("pageNumberまたはblockIdのどちらか一方");
    }
  });

  it("render_page returns a full-page PNG and pagination metadata by pageNumber or blockId", async () => {
    await client.close();
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://render-page.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    process.env[SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV] = bridgeStore.getBridgeFilePath();

    const requests: Array<Record<string, unknown>> = [];
    const server = createSigmaDocMcpServer({
      renderVisualPreviewDeps: {
        env: process.env,
        fetchImpl: (async (_url, init) => {
          const request = JSON.parse(String(init?.body)) as Record<string, unknown>;
          requests.push(request);
          const targetId = request.targetId;
          const pageIndex = targetId ? 2 : ((request.focus as { pageIndex: number }).pageIndex);
          return new Response(JSON.stringify({
            ok: true,
            pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
            width: 800,
            height: 1100,
            capture: { pageIndex, cropRect: { x: 0, y: 0, w: 800, h: 1100 } },
            anchorBlockFound: Boolean(targetId),
            totalPages: 4,
            blockIds: targetId ? [targetId, "p_split"] : ["p_page_2", "p_split"],
            splitBlockIds: ["p_split"],
          }), { status: 200, headers: { "content-type": "application/json" } });
        }) as typeof fetch,
        loadResvg: async () => null,
      },
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "render-page-test-client", version: "0.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const fileId = await getFileId();

    const byPage = extractPayload(await client.callTool({
      name: "render_page",
      arguments: { fileId, pageNumber: 2, profile: "student" },
    }));
    expect(byPage.ok).toBe(true);
    expect(byPage.page).toEqual({
      pageNumber: 2,
      totalPages: 4,
      profile: "student",
      blockIds: ["p_page_2", "p_split"],
      splitBlockIds: ["p_split"],
    });
    expect(path.isAbsolute((byPage.preview as { previewFile: string }).previewFile)).toBe(true);
    expect(requests[0]).toMatchObject({
      targetId: null,
      captureMode: "page",
      profile: "student",
      focus: { pageIndex: 1 },
    });

    const byBlock = extractPayload(await client.callTool({
      name: "render_page",
      arguments: { fileId, blockId: "p_source_note", profile: "answerBook" },
    }));
    expect(byBlock.ok).toBe(true);
    expect(byBlock.page).toMatchObject({
      pageNumber: 3,
      totalPages: 4,
      profile: "answerBook",
      blockIds: ["p_source_note", "p_split"],
      splitBlockIds: ["p_split"],
    });
    expect(requests[1]).toMatchObject({
      targetId: "p_source_note",
      captureMode: "page",
      profile: "answerBook",
      focus: { preferTargetPage: true },
    });

    const insertResult = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: {
        fileId,
        targetId: "END_OF_DOCUMENT",
        expectedRevision: 1,
        blocks: ["render_pageで確認する未承認の段落"],
      },
    }));
    expect(insertResult.ok).toBe(true);
    const changedId = (insertResult.documentSummary as { changedIds: string[] }).changedIds[0];
    requests.length = 0;

    const proposalPage = extractPayload(await client.callTool({
      name: "render_page",
      arguments: { fileId, blockId: changedId, currentProposal: true },
    }));
    expect(proposalPage.ok).toBe(true);
    expect(requests[0]).toMatchObject({
      targetId: changedId,
      captureMode: "page",
      profile: "teacher",
    });
    expect(JSON.stringify(requests[0]?.document)).toContain(changedId);
  });

  it("errors helpfully when neither blockId nor the current proposal is requested", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId },
    }));
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("対象を特定できません");
  });

  it("errors when the current proposal does not exist", async () => {
    const fileId = await getFileId();
    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId, currentProposal: true },
    }));
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("作業案が見つかりません");
  });

  it("resolves the target block from a proposal's changedIds and reapplies its draft to the current document", async () => {
    const fileId = await getFileId();
    const insertResult = extractPayload(await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["render_block_context用の新しい段落"] },
    }));
    expect(insertResult.ok).toBe(true);
    const changedId = (insertResult.documentSummary as { changedIds: string[] }).changedIds[0];
    expect(changedId).toBeTruthy();

    // No render bridge is configured, so this still degrades to source:none, but it must resolve
    // the current proposal and pick a real, existing block —
    // proving the draft was actually reapplied rather than left unresolved.
    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId, currentProposal: true },
    }));
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).not.toContain("提案が見つかりません");
    expect(String((result as { error?: string }).error)).not.toContain("対象を特定できません");
    expect((result.preview as { source?: string })?.source).toBe("none");
  });

  it.skipIf(!resvgAvailable)("renders a page-layout-only current proposal without requiring changed block ids", async () => {
    const fileId = await getFileId();
    const updateResult = extractPayload(await client.callTool({
      name: "update_page_layout",
      arguments: { fileId, orientation: "landscape", marginsMm: { left: 22 }, expectedRevision: 1 },
    }));
    expect(updateResult.ok).toBe(true);
    expect((updateResult.documentSummary as { changedIds?: string[] }).changedIds).toEqual([]);

    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId, currentProposal: true },
    }));
    expect(result.ok).toBe(true);
    expect((result.preview as { source?: string }).source).toBe("svg-fallback");
    expect(result.error).toBeUndefined();
  });

  it("does not resolve another file's current proposal", async () => {
    const fileId = await getFileId();
    await client.callTool({
      name: "insert_body_content",
      arguments: { fileId, targetId: "END_OF_DOCUMENT", expectedRevision: 1, blocks: ["別教材チェック用の段落"] },
    });
    const otherFile = await new LocalSigmaDocStore(userDataDir).createDocument();

    const result = extractPayload(await client.callTool({
      name: "render_block_context",
      arguments: { fileId: otherFile.file.fileId, currentProposal: true },
    }));
    expect(result.ok).toBe(false);
    expect(String((result as { error?: string }).error)).toContain("現在の作業案が見つかりません");
  });
});

describe("formatZodErrorForTool", () => {
  it("formats every issue as 'path: message', capped at 10, instead of a raw ZodError dump", () => {
    const schema = z.object({ a: z.string(), b: z.number(), c: z.boolean() });
    const parsed = schema.safeParse({ a: 1, b: "not a number", c: "not a boolean" });
    expect(parsed.success).toBe(false);
    if (parsed.success) {
      return;
    }

    const message = formatZodErrorForTool(parsed.error);
    expect(message).toContain("入力値が不正です");
    expect(message).toContain("a:");
    expect(message).toContain("b:");
    expect(message).toContain("c:");
    expect(message.split(" / ")).toHaveLength(3);
  });
});

describe("sigma-doc-mcp-server context tools", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;
  let runContextStore: LocalAiEditRunContextStore;
  let fileId: string;
  let firstBlockId: string;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-context-tools-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });
    const files = await sigmaDocStore.listFiles();
    fileId = files[0]!.fileId;
    const document = await sigmaDocStore.loadDocument(fileId);
    firstBlockId = document!.content[0]!.id;

    runContextStore = new LocalAiEditRunContextStore(userDataDir, "claude");

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = runContextStore.getRunContextFilePath();

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  function baseContext(overrides: Partial<AiEditRunContext> = {}): AiEditRunContext {
    return {
      version: 1,
      runId: "run_1",
      createdAt: "2026-07-02T00:00:00.000Z",
      provider: "claude",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
      ...overrides,
    };
  }

  it("get_selected_block returns hasAppContext:false without a run-context file", async () => {
    const result = await client.callTool({ name: "get_selected_block", arguments: {} });
    expect(result.isError).toBeFalsy();
    const payload = extractPayload(result);
    expect(payload.ok).toBe(true);
    expect(payload.hasAppContext).toBe(false);
    expect(String(payload.message)).toContain("アプリの実行コンテキスト");
  });

  it("get_selected_block returns hasAppContext:true with the selected block when a run context exists", async () => {
    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const result = await client.callTool({ name: "get_selected_block", arguments: {} });
    const payload = extractPayload(result);
    expect(payload.hasAppContext).toBe(true);
    expect(payload.fileId).toBe(fileId);
    expect(payload.revisionMatched).toBe(true);
    expect((payload.data as { block: { id?: string } }).block.id).toBe(firstBlockId);
  });

  it("get_selected_block resolves app context from a provider:\"chatgpt\" run context file", async () => {
    const chatgptRunContextStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    await chatgptRunContextStore.write(baseContext({ provider: "chatgpt", selectedId: firstBlockId }));
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = chatgptRunContextStore.getRunContextFilePath();
    try {
      const result = await client.callTool({ name: "get_selected_block", arguments: {} });
      const payload = extractPayload(result);
      expect(payload.hasAppContext).toBe(true);
      expect(payload.fileId).toBe(fileId);
      expect((payload.data as { block: { id?: string } }).block.id).toBe(firstBlockId);
    } finally {
      process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = runContextStore.getRunContextFilePath();
    }
  });

  it("get_attached_media returns PNG as image content and SVG as resource content", async () => {
    await runContextStore.write(baseContext({
      attachments: [
        { id: "att_png", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
        { id: "att_svg", name: "a.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,AAAA" },
      ],
    }));
    const result = await client.callTool({ name: "get_attached_media", arguments: {} });
    const imageContent = (result.content as Array<{ type: string }>).filter((item) => item.type === "image");
    const resourceContent = (result.content as Array<{ type: string }>).filter((item) => item.type === "resource");
    expect(imageContent).toHaveLength(1);
    expect(resourceContent).toHaveLength(1);

    const payload = extractPayload(result);
    const attachments = (payload.data as {
      attachments: Array<{ id: string; imageContentIncluded: boolean; contentIncluded: boolean }>;
    }).attachments;
    expect(attachments.find((item) => item.id === "att_png")?.imageContentIncluded).toBe(true);
    expect(attachments.find((item) => item.id === "att_svg")?.imageContentIncluded).toBe(false);
    expect(attachments.find((item) => item.id === "att_svg")?.contentIncluded).toBe(true);
  });

  it("get_selected_block resolves the per-run context file when runId is passed, ignoring the static file", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    // The static file (baked into env at startup) belongs to a stale/other run.
    await runContextStore.write(baseContext({ runId: "run_static_stale", selectedId: "does_not_exist" }));

    // This run's own per-run file lives alongside the static one.
    const perRunStore = new LocalAiEditRunContextStore(userDataDir, "claude", { runId: "run_mine" });
    await perRunStore.write(baseContext({ runId: "run_mine", selectedId: firstBlockId }));

    const result = await client.callTool({
      name: "get_selected_block",
      arguments: { runId: "run_mine" },
    });
    const payload = extractPayload(result);
    expect(payload.hasAppContext).toBe(true);
    expect((payload.data as { block: { id?: string } }).block.id).toBe(firstBlockId);
  });

  it("get_selected_block falls back to the static file when runId is omitted (model forgot the argument)", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    await runContextStore.write(baseContext({ runId: "run_static", selectedId: firstBlockId }));

    const result = await client.callTool({ name: "get_selected_block", arguments: {} });
    const payload = extractPayload(result);
    expect(payload.hasAppContext).toBe(true);
    expect((payload.data as { block: { id?: string } }).block.id).toBe(firstBlockId);
  });

  it("get_selected_block returns hasAppContext:false when runId is passed but no per-run file exists (never silently reads the wrong run's static file)", async () => {
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "claude";
    await runContextStore.write(baseContext({ runId: "run_static", selectedId: firstBlockId }));

    const result = await client.callTool({
      name: "get_selected_block",
      arguments: { runId: "run_never_written" },
    });
    const payload = extractPayload(result);
    expect(payload.hasAppContext).toBe(false);
  });

  it("re-reads the run-context file on every call instead of caching", async () => {
    const document = await new LocalSigmaDocStore(userDataDir).loadDocument(fileId);
    const secondBlockId = document!.content[1]?.id ?? firstBlockId;

    await runContextStore.write(baseContext({ selectedId: firstBlockId }));
    const first = extractPayload(await client.callTool({ name: "get_selected_block", arguments: {} }));
    expect((first.data as { block: { id?: string } }).block.id).toBe(firstBlockId);

    await runContextStore.write(baseContext({ selectedId: secondBlockId }));
    const second = extractPayload(await client.callTool({ name: "get_selected_block", arguments: {} }));
    expect((second.data as { block: { id?: string } }).block.id).toBe(secondBlockId);
  });
});

describe("render_visual_edit_session", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-render-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
  });

  afterEach(async () => {
    await client.close();
    await flushVisualSessionStatusWritesForTests();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function connectClient(renderVisualPreviewDeps?: RenderVisualPreviewDeps): Promise<void> {
    const server = createSigmaDocMcpServer({ renderVisualPreviewDeps });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  }

  async function getFileId(): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  async function beginSessionWithShape(): Promise<string> {
    const fileId = await getFileId();
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    return sessionId;
  }

  async function configureVisualRunContext(
    provider: AiEditRunContext["provider"],
    runId: string,
    fileId: string,
  ): Promise<void> {
    const staticRunContextStore = new LocalAiEditRunContextStore(userDataDir, provider);
    const runContextStore = new LocalAiEditRunContextStore(userDataDir, provider, { runId });
    await runContextStore.write({
      version: 1,
      runId,
      createdAt: new Date().toISOString(),
      provider,
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    });
    process.env.SIGMA_STUDIO_MCP_PROVIDER = provider;
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticRunContextStore.getRunContextFilePath();
  }

  describe("figure-insertion loop cross-provider consistency", () => {
    it.skipIf(!resvgAvailable).each([["chatgpt"], ["claude"], ["antigravity"]] as const)(
      "runs begin→insert→render→inspect→review→propose and yields a groupable proposal for provider %s",
      async (provider) => {
        process.env.SIGMA_STUDIO_MCP_PROVIDER = provider;
        await connectClient();
        const fileId = await getFileId();
        const store = new LocalSigmaDocStore(userDataDir);
        const filesBefore = await store.listFiles();
        const revision = filesBefore.find((file) => file.fileId === fileId)?.revision ?? 1;

        const begin = extractPayload(await client.callTool({
          name: "begin_visual_edit_session",
          arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: revision },
        }));
        const sessionId = (begin.session as { sessionId: string }).sessionId;

        await client.callTool({
          name: "visual_insert_shape",
          arguments: { sessionId, kind: "rectangle", x: 100, y: 100 },
        });

        const renderResult = await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
        const renderPayload = extractPayload(renderResult);
        expect(renderPayload.ok).toBe(true);
        const contentBlocks = renderResult.content as Array<{ type: string; mimeType?: string; data?: string }>;
        const imageBlocks = contentBlocks.filter((block) => block.type === "image");
        expect(imageBlocks).toHaveLength(1);
        expect(imageBlocks[0]?.mimeType).toBe("image/png");
        const pngBytes = Buffer.from(imageBlocks[0]!.data!, "base64");
        expect(Array.from(pngBytes.subarray(0, 8))).toEqual(PNG_MAGIC_BYTES);

        const inspection = extractPayload(await client.callTool({
          name: "inspect_visual_edit_session",
          arguments: { sessionId },
        }));
        expect(inspection.ok).toBe(true);

        const review = extractPayload(await client.callTool({
          name: "review_visual_edit_session",
          arguments: {
            sessionId,
            verdict: "pass",
            score: 96,
            previewCode: deriveVisualPreviewCode(sessionId, 1),
            sourceImageSummary: "元画像の要約",
            previewSummary: "previewの要約",
          },
        }));
        expect(review.ok).toBe(true);

        const proposalResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
          arguments: { sessionId },
        }));
        expect(proposalResult.ok).toBe(true);
        expect(proposalResult.proposalCreated).toBe(true);
        const proposal = proposalResult.proposal as { provider?: string; baseRevision?: number };
        expect(proposal.provider).toBe(provider);
        expect(proposal.baseRevision).toBe(revision);

        const listResult = extractPayload(await client.callTool({
          name: "list_edit_proposals",
          arguments: { status: "pending" },
        }));
        expect(listResult.proposals).toEqual([expect.not.objectContaining({ proposalId: expect.anything() })]);
        const detail = extractPayload(await client.callTool({
          name: "get_edit_proposal",
          arguments: { fileId, detail: "full" },
        }));
        const proposals = [detail.proposal as DesktopMcpEditProposalSummary];

        const currentGroup = groupMcpProposalsForPreview(proposals, fileId, revision);
        expect(currentGroup.current).not.toBeNull();
        expect(currentGroup.current?.providers).toEqual([provider]);
        expect(currentGroup.stale).toHaveLength(0);

        // A pure insertion remains applicable after an unrelated revision bump.
        // Main-process freshness validation checks the external anchor's existence
        // instead of treating revision drift as an implicit content conflict.
        const rebasedGroup = groupMcpProposalsForPreview(proposals, fileId, revision + 1);
        expect(rebasedGroup.current).not.toBeNull();
        expect(rebasedGroup.current?.providers).toEqual([provider]);
        expect(rebasedGroup.stale).toHaveLength(0);
      },
    );
  });

  it.skipIf(!resvgAvailable)(
    "Red-A: falls back to an svg-fallback PNG image block with no svg content block when no bridge is configured",
    async () => {
      await connectClient();
      const sessionId = await beginSessionWithShape();

      const result = await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
      const payload = extractPayload(result);
      expect(payload.ok).toBe(true);
      expect((payload.preview as { format?: string }).format).toBe("png");
      expect((payload.preview as { source?: string }).source).toBe("svg-fallback");

      const contentBlocks = result.content as Array<{ type: string; mimeType?: string; data?: string }>;
      const imageBlocks = contentBlocks.filter((block) => block.type === "image");
      expect(imageBlocks).toHaveLength(1);
      expect(imageBlocks[0]?.mimeType).toBe("image/png");
      const pngBytes = Buffer.from(imageBlocks[0]!.data!, "base64");
      expect(Array.from(pngBytes.subarray(0, 8))).toEqual(PNG_MAGIC_BYTES);
      expect(contentBlocks.some((block) => block.mimeType === "image/svg+xml")).toBe(false);
    },
  );

  it("Red-B: uses a fake app-render-bridge and receives document/targetId/focus", async () => {
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    const receivedBodies: Array<{ document?: unknown; targetId?: unknown; focus?: unknown; badgeText?: unknown }> = [];
    const onePixelPngBase64 = Buffer.from(PNG_MAGIC_BYTES).toString("base64");

    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async (_input, init) => {
        receivedBodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({
          ok: true,
          pngBase64: onePixelPngBase64,
          width: 1,
          height: 1,
          capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
          anchorBlockFound: true,
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      loadResvg: async () => null,
    };

    await connectClient(deps);
    const sessionId = await beginSessionWithShape();
    const result = await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    const payload = extractPayload(result);

    expect(payload.ok).toBe(true);
    expect((payload.preview as { source?: string }).source).toBe("app-bridge");
    expect(receivedBodies).toHaveLength(1);
    expect(receivedBodies[0]?.document).toBeTruthy();
    expect(receivedBodies[0]?.targetId).toBeTruthy();
    expect(receivedBodies[0]?.focus).toBeTruthy();
    expect(receivedBodies[0]?.badgeText).toMatch(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  });

  it("writes render_visual_edit_session output to an absolute previewFile", async () => {
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const png = Buffer.from(PNG_MAGIC_BYTES);
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: true,
        pngBase64: png.toString("base64"),
        width: 1,
        height: 1,
        capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
        anchorBlockFound: true,
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      loadResvg: async () => null,
    };

    await connectClient(deps);
    const sessionId = await beginSessionWithShape();
    const result = await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    const payload = extractPayload(result);
    const preview = payload.preview as { previewFile?: string; source?: string };
    expect(preview.source).toBe("app-bridge");
    expect(preview.previewFile).toBeTruthy();
    if (!preview.previewFile) throw new Error("previewFile was not returned");
    expect(path.isAbsolute(preview.previewFile)).toBe(true);
    await expect(fs.readFile(preview.previewFile)).resolves.toEqual(Buffer.from(PNG_MAGIC_BYTES));
    expect(JSON.stringify(payload)).not.toContain(deriveVisualPreviewCode(sessionId, 1));
  });

  it("omits inline preview image content for a ChatGPT run while returning previewFile", async () => {
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    const staticRunContextStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt");
    const runContextStore = new LocalAiEditRunContextStore(userDataDir, "chatgpt", { runId: "run_chatgpt_visual" });
    const fileId = await getFileId();
    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    await runContextStore.write({
      version: 1,
      runId: "run_chatgpt_visual",
      createdAt: new Date().toISOString(),
      provider: "chatgpt",
      fileId,
      fileRevision: 1,
      selectedId: null,
      references: [],
      attachments: [],
      mentionedDocuments: [],
    });
    process.env.SIGMA_STUDIO_MCP_PROVIDER = "chatgpt";
    process.env.SIGMA_STUDIO_RUN_CONTEXT_FILE = staticRunContextStore.getRunContextFilePath();

    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: true,
        pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
        width: 1,
        height: 1,
        capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
        anchorBlockFound: true,
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      loadResvg: async () => null,
    };
    await connectClient(deps);
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId: "run_chatgpt_visual" },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    await client.callTool({ name: "visual_insert_shape", arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 } });

    const result = await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    const payload = extractPayload(result);
    expect((payload.preview as { previewFile?: string }).previewFile).toBeTruthy();
    expect((result.content as Array<{ type: string }>).filter((item) => item.type === "image")).toHaveLength(0);
    expect(String(payload.message)).toContain("view_image");
  });

  it("writes per-run visual session status through review, propose, and discard", async () => {
    const provider = "claude" as const;
    const runId = "run_visual_status";
    const fileId = await getFileId();
    await configureVisualRunContext(provider, runId, fileId);

    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://render-bridge.test",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });
    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => new Response(JSON.stringify({
        ok: true,
        pngBase64: Buffer.from(PNG_MAGIC_BYTES).toString("base64"),
        width: 1,
        height: 1,
        capture: { pageIndex: 0, cropRect: { x: 0, y: 0, w: 1, h: 1 } },
        anchorBlockFound: true,
      }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch,
      loadResvg: async () => null,
    };
    await connectClient(deps);

    const statusPath = path.join(userDataDir, "data", "ai-run-context", visualSessionsFileName(provider, runId));
    const renameSpy = vi.spyOn(fs, "rename");
    type SessionStatus = {
      sessionId: string;
      operationCount: number;
      lastReviewPassed: boolean | null;
      proposed: boolean;
      discarded: boolean;
    };
    type StatusFile = { sessions: SessionStatus[] };
    async function waitForSessionStatus(
      sessionId: string,
      predicate: (status: SessionStatus) => boolean,
    ): Promise<SessionStatus> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          const statusFile = JSON.parse(await fs.readFile(statusPath, "utf8")) as StatusFile;
          const status = statusFile.sessions.find((item) => item.sessionId === sessionId);
          if (status && predicate(status)) {
            return status;
          }
        } catch {
          // The status writer is intentionally asynchronous and best-effort.
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`visual session status did not reach the expected state: ${sessionId}`);
    }

    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    await client.callTool({ name: "inspect_visual_edit_session", arguments: { sessionId } });

    const failedReview = extractPayload(await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "needs_revision",
        score: 40,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
        issues: ["位置を修正してください"],
      },
    }));
    expect(failedReview.ok).toBe(true);
    expect(failedReview.passed).toBe(false);
    const afterFailedReview = await waitForSessionStatus(
      sessionId,
      (status) => status.operationCount > 0
        && status.lastReviewPassed === false
        && status.proposed === false
        && status.discarded === false,
    );
    expect(afterFailedReview.lastReviewPassed).toBe(false);

    await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 96,
        previewCode: deriveVisualPreviewCode(sessionId, 1),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    });
    await client.callTool({ name: "propose_visual_edit_session", arguments: { sessionId } });
    const afterPropose = await waitForSessionStatus(sessionId, (status) => status.proposed === true);
    expect(afterPropose.discarded).toBe(false);

    const discardBegin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId },
    }));
    const discardedSessionId = (discardBegin.session as { sessionId: string }).sessionId;
    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId: discardedSessionId, kind: "rectangle", x: 160, y: 160, r: 20 },
    });
    const discardResult = extractPayload(await client.callTool({
      name: "discard_visual_edit_session",
      arguments: { sessionId: discardedSessionId },
    }));
    expect(discardResult.ok).toBe(true);
    const afterDiscard = await waitForSessionStatus(sessionId, (status) => status.proposed === true);
    expect(afterDiscard.proposed).toBe(true);
    await waitForSessionStatus(discardedSessionId, (status) => status.discarded === true);

    const statusRenames = renameSpy.mock.calls.filter(([, destination]) => String(destination) === statusPath);
    expect(statusRenames.length).toBeGreaterThan(0);
    expect(statusRenames.every(([source]) => path.dirname(String(source)) === path.dirname(statusPath))).toBe(true);
    expect(statusRenames.every(([source]) => String(source).startsWith(`${statusPath}.tmp-`))).toBe(true);
    const statusDirectoryEntries = await fs.readdir(path.dirname(statusPath));
    expect(statusDirectoryEntries.filter((entry) => entry.startsWith(`${path.basename(statusPath)}.tmp-`))).toEqual([]);
    renameSpy.mockRestore();
  });

  it("records an expired visual session as discarded before pruning it", async () => {
    const provider = "claude" as const;
    const runId = "run_visual_expired";
    const fileId = await getFileId();
    await configureVisualRunContext(provider, runId, fileId);
    await connectClient();

    const statusPath = path.join(userDataDir, "data", "ai-run-context", visualSessionsFileName(provider, runId));
    const startedAt = Date.now();
    vi.useFakeTimers({ now: startedAt });
    let sessionId = "";
    try {
      const begin = extractPayload(await client.callTool({
        name: "begin_visual_edit_session",
        arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId },
      }));
      sessionId = (begin.session as { sessionId: string }).sessionId;
      vi.setSystemTime(startedAt + 60 * 60 * 1000 + 1);

      const discardResult = extractPayload(await client.callTool({
        name: "discard_visual_edit_session",
        arguments: { sessionId },
      }));
      expect(discardResult.ok).toBe(false);
    } finally {
      vi.useRealTimers();
    }

    let discardedStatus: { sessionId: string; discarded: boolean } | undefined;
    for (let attempt = 0; attempt < 100 && !discardedStatus; attempt += 1) {
      try {
        const statusFile = JSON.parse(await fs.readFile(statusPath, "utf8")) as {
          sessions: Array<{ sessionId: string; discarded: boolean }>;
        };
        discardedStatus = statusFile.sessions.find((status) => status.sessionId === sessionId && status.discarded);
      } catch {
        // The status writer is intentionally asynchronous and best-effort.
      }
      if (!discardedStatus) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }

    expect(discardedStatus).toEqual(expect.objectContaining({ sessionId, discarded: true }));
  });

  it("bounds terminal and pending visual session status caches", async () => {
    const provider = "claude" as const;
    const fileId = await getFileId();
    const terminalRunId = "run_visual_terminal_cache";
    await configureVisualRunContext(provider, terminalRunId, fileId);
    await connectClient();

    const terminalSessionIds: string[] = [];
    for (let index = 0; index < 201; index += 1) {
      const begin = extractPayload(await client.callTool({
        name: "begin_visual_edit_session",
        arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId: terminalRunId },
      }));
      const sessionId = (begin.session as { sessionId: string }).sessionId;
      terminalSessionIds.push(sessionId);
      const discard = extractPayload(await client.callTool({
        name: "discard_visual_edit_session",
        arguments: { sessionId },
      }));
      expect(discard.ok).toBe(true);
    }

    const terminalStatusPath = path.join(
      userDataDir,
      "data",
      "ai-run-context",
      visualSessionsFileName(provider, terminalRunId),
    );
    let terminalStatusFile: { sessions: Array<{ sessionId: string; discarded: boolean }> } | undefined;
    for (let attempt = 0; attempt < 300 && !terminalStatusFile; attempt += 1) {
      try {
        const statusFile = JSON.parse(await fs.readFile(terminalStatusPath, "utf8")) as {
          sessions: Array<{ sessionId: string; discarded: boolean }>;
        };
        if (
          statusFile.sessions.length === 200
          && !statusFile.sessions.some((status) => status.sessionId === terminalSessionIds[0])
          && statusFile.sessions.some((status) => status.sessionId === terminalSessionIds[200] && status.discarded)
        ) {
          terminalStatusFile = statusFile;
        }
      } catch {
        // The status writer is intentionally asynchronous and best-effort.
      }
      if (!terminalStatusFile) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(terminalStatusFile?.sessions).toHaveLength(200);
    expect(getVisualSessionStatusCacheSizesForTests().terminal).toBe(200);

    const pendingRunIds = Array.from({ length: 201 }, (_, index) => `run_visual_pending_cache_${index}`);
    for (const runId of pendingRunIds) {
      await configureVisualRunContext(provider, runId, fileId);
    }
    for (const runId of pendingRunIds) {
      await client.callTool({
        name: "begin_visual_edit_session",
        arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1, runId },
      });
    }
    const visualStatusDirectory = path.join(userDataDir, "data", "ai-run-context");
    let allPendingStatusFilesWritten = false;
    for (let attempt = 0; attempt < 500 && !allPendingStatusFilesWritten; attempt += 1) {
      try {
        const entries = new Set(await fs.readdir(visualStatusDirectory));
        allPendingStatusFilesWritten = pendingRunIds.every((runId) =>
          entries.has(visualSessionsFileName(provider, runId)),
        );
      } catch {
        // The status writer is intentionally asynchronous and best-effort.
      }
      if (!allPendingStatusFilesWritten) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    expect(allPendingStatusFilesWritten).toBe(true);
    expect(getVisualSessionStatusCacheSizesForTests().pending).toBe(0);
  }, 30_000);

  it("Red-C: delivers a badged SVG resource so image-less review and proposal can proceed when both the app bridge and resvg are unavailable", async () => {
    const deps: RenderVisualPreviewDeps = {
      env: {},
      fetchImpl: (async () => {
        throw new Error("fetch should not be called without a bridge file");
      }) as unknown as typeof fetch,
      loadResvg: async () => null,
    };
    await connectClient(deps);
    const sessionId = await beginSessionWithShape();

    const renderRaw = await client.callTool({
      name: "render_visual_edit_session",
      arguments: { sessionId },
    });
    const renderResult = extractPayload(renderRaw);
    expect(renderResult.ok).toBe(true);
    expect((renderResult.preview as { source?: string })?.source).toBe("none");
    expect((renderResult.preview as { format?: string })?.format).toBe("svg");

    const previewCode = deriveVisualPreviewCode(sessionId, 1);
    const svgResources = (renderRaw.content as Array<{ type: string; resource?: { mimeType?: string; text?: string } }>)
      .filter((block) => block.type === "resource" && block.resource?.mimeType === "image/svg+xml");
    expect(svgResources).toHaveLength(1);
    expect(svgResources[0]?.resource?.text).toContain(previewCode);
    // The review code must be readable only from the preview artifact, never
    // leaked into the machine-readable payload (self-report anti-cheat).
    expect(JSON.stringify(renderResult)).not.toContain(previewCode);

    const inspection = extractPayload(await client.callTool({
      name: "inspect_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(inspection.ok).toBe(true);

    const reviewResult = extractPayload(await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 100,
        previewCode,
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    }));
    expect(reviewResult.ok).toBe(true);

    const commitResult = extractPayload(await client.callTool({
      name: "propose_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(commitResult.ok).toBe(true);
    expect(commitResult.proposalCreated).toBe(true);
  });

  it("does not mark a preview fresh for a revision bumped by a concurrent visual_insert_shape during the render round-trip", async () => {
    // Regression: session.revision must be captured BEFORE the render
    // round-trip (not read afterward), otherwise a visual_insert_shape that
    // races with an in-flight render_visual_edit_session call would let its
    // (unreviewed) new revision ride through on the OLD render's success.
    const releaseFetchHolder: { current: (() => void) | null } = { current: null };
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetchHolder.current = resolve;
    });

    // A bridge file must be present (state:"ready") for renderViaAppBridge to
    // call fetchImpl at all; only its network call is faked here.
    const bridgeStore = new LocalAiRenderBridgeStore(userDataDir);
    await bridgeStore.write({
      version: 1,
      url: "http://127.0.0.1:1",
      token: "test-token",
      pid: process.pid,
      createdAt: new Date().toISOString(),
    });

    const deps: RenderVisualPreviewDeps = {
      env: { [SIGMA_STUDIO_RENDER_BRIDGE_FILE_ENV]: bridgeStore.getBridgeFilePath() },
      fetchImpl: (async () => {
        // Simulate an in-flight bridge round-trip: fail (so the code falls
        // back to svg) only after the concurrent visual_insert_shape below
        // has had a chance to run and bump session.revision.
        await fetchGate;
        throw new Error("simulated bridge round-trip failure");
      }) as unknown as typeof fetch,
      loadResvg: createDefaultRenderVisualPreviewDeps().loadResvg,
    };
    await connectClient(deps);
    const sessionId = await beginSessionWithShape();

    const renderPromise = client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });

    // Let the render call actually start (and call fetchImpl) before racing
    // a second mutation against the same session.
    await new Promise((resolve) => setTimeout(resolve, 10));
    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 200, y: 200, r: 20 },
    });
    releaseFetchHolder.current?.();

    const renderResult = extractPayload(await renderPromise);
    expect(renderResult.ok).toBe(true);
    expect(String(renderResult.message)).toContain("新しい変更");
    expect(String(renderResult.message)).toContain("render_visual_edit_session");
    expect((renderResult.session as { lastPreviewRevision?: number }).lastPreviewRevision).toBe(-1);
    expect((renderResult.session as { lastPreviewSource?: string | null }).lastPreviewSource).toBeNull();

    // The preview covers the revision from BEFORE the concurrent insert, so
    // review/proposal creation against the CURRENT (post-insert) revision must still be
    // rejected as stale.
    const reviewResult = extractPayload(await client.callTool({
      name: "review_visual_edit_session",
      arguments: {
        sessionId,
        verdict: "pass",
        score: 100,
        previewCode: deriveVisualPreviewCode(sessionId, 2),
        sourceImageSummary: "元画像の要約",
        previewSummary: "previewの要約",
      },
    }));
    expect(reviewResult.ok).toBe(false);
    expect(String(reviewResult.error)).toContain("render_visual_edit_session");
  });

  it("Red-D: inspectShapeBasics reports anchor_missing_block for a shape anchored to a nonexistent block", async () => {
    // The public visual-session MCP tools always validate targetId against the document
    // before a shape can be created (see resolveOverlayInsertionTarget/getTargetId), so this
    // state cannot be reached end-to-end through the tool surface. Unit-test the defensive
    // check directly instead of faking an unreachable integration path.
    const fileId = await getFileId();
    const document = await new LocalSigmaDocStore(userDataDir).loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }

    const shape = {
      id: "shape_orphan",
      type: "geo" as const,
      x: 100,
      y: 100,
      anchor: { type: "block" as const, blockId: "block_does_not_exist", dy: 0 },
      props: {
        w: 80,
        h: 60,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "#000000",
        labelColor: "#000000",
        dash: "solid" as const,
        size: "m" as const,
      },
    };

    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, document);
    expect(issues.some((issue) => issue.code === "anchor_missing_block" && issue.severity === "error")).toBe(true);

    const validShapeIssues: VisualInspectionIssue[] = [];
    inspectShapeBasics({ ...shape, anchor: undefined }, validShapeIssues, document);
    expect(validShapeIssues.some((issue) => issue.code === "anchor_missing_block")).toBe(false);
  });

  it("uses the document's own (non-A4) page metrics instead of a hardcoded A4 size for outside_page_x/crosses_page_boundary", async () => {
    // B4 portrait is wider and taller than A4 (~971x1376px vs ~794x1123px).
    // A shape placed between the A4 and B4 page edges must NOT be flagged as
    // outside_page_x/crosses_page_boundary once inspectShapeBasics derives
    // page size from draftDocument.pageLayout via getPageMetrics instead of
    // the hardcoded A4_PAGE_PX.
    const fileId = await getFileId();
    const document = await new LocalSigmaDocStore(userDataDir).loadDocument(fileId);
    if (!document) {
      throw new Error("document missing");
    }
    const b4Document = {
      ...document,
      pageLayout: {
        ...getDefaultPageLayout(),
        ...document.pageLayout,
        preset: "B4" as const,
        orientation: "portrait" as const,
        pageSize: { widthMm: 257, heightMm: 364 },
      },
    };

    const shape = {
      id: "shape_wide",
      type: "geo" as const,
      x: 850,
      y: 1050,
      props: {
        w: 80,
        h: 60,
        geo: "rectangle" as const,
        fill: "none" as const,
        color: "#000000",
        labelColor: "#000000",
        dash: "solid" as const,
        size: "m" as const,
      },
    };

    const b4Issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, b4Issues, b4Document);
    expect(b4Issues.some((issue) => issue.code === "outside_page_x")).toBe(false);
    expect(b4Issues.some((issue) => issue.code === "crosses_page_boundary")).toBe(false);

    const a4Issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, a4Issues, document);
    expect(a4Issues.some((issue) => issue.code === "outside_page_x")).toBe(true);
  });

  it("keeps existing inspect checks (too_small, outside_page_x) passing alongside the new anchor check", async () => {
    await connectClient();
    const fileId = await getFileId();
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    await client.callTool({
      name: "visual_insert_shape",
      arguments: {
        sessionId,
        kind: "rectangle",
        start: { x: 100, y: 100 },
        end: { x: 101, y: 101 },
      },
    });

    const inspection = extractPayload(await client.callTool({
      name: "inspect_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(inspection.ok).toBe(true);
    expect(inspection.passed).toBe(false);
    const issues = (inspection.inspection as { issues: Array<{ code: string }> }).issues;
    expect(issues.some((issue) => issue.code === "too_small")).toBe(true);
    expect(issues.some((issue) => issue.code === "anchor_missing_block")).toBe(false);
  });
});

function geoShapeForInspection(overrides: Partial<{ x: number; y: number; opacity: number; w: number; h: number; fontSize: number }> = {}): OverlayShape {
  const { fontSize, w, h, ...shapeOverrides } = overrides;
  return {
    id: "inspect_shape",
    type: "geo",
    x: 0,
    y: 0,
    props: {
      w: w ?? 80,
      h: h ?? 60,
      geo: "rectangle",
      fill: "none",
      color: "#000000",
      labelColor: "#000000",
      dash: "solid",
      size: "m",
      ...(fontSize === undefined ? {} : { fontSize }),
    },
    ...shapeOverrides,
  } as unknown as OverlayShape;
}

describe("inspectShapeBasics: page-overflow auto-fail and normalization warnings", () => {
  const pagePxSize = getPageMetrics(sampleDocument.pageLayout).page;

  it("auto-fails with shape_outside_page (error) when a shape does not overlap the page at all", () => {
    const shape = geoShapeForInspection({ x: -100000, y: 100 });
    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, sampleDocument);
    expect(issues.some((issue) => issue.code === "shape_outside_page" && issue.severity === "error")).toBe(true);
  });

  it("auto-fails with shape_mostly_outside_page (error) when more than half of a shape's width is off the page", () => {
    // width 200, only 20px overlaps the page on the right edge -> 90% outside horizontally.
    const shape = geoShapeForInspection({ x: pagePxSize.widthPx - 20, y: 100, w: 200 });
    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, sampleDocument);
    expect(issues.some((issue) => issue.code === "shape_mostly_outside_page" && issue.severity === "error")).toBe(true);
    expect(issues.some((issue) => issue.code === "shape_outside_page")).toBe(false);
  });

  it("does not auto-fail a shape that only slightly crosses the page edge (<=50% outside)", () => {
    // width 80, 60px overlaps the page (25% outside horizontally) -> below the 50% auto-fail threshold.
    const shape = geoShapeForInspection({ x: pagePxSize.widthPx - 60, y: 100, w: 80 });
    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, sampleDocument);
    expect(issues.some((issue) => issue.code === "shape_outside_page")).toBe(false);
    expect(issues.some((issue) => issue.code === "shape_mostly_outside_page")).toBe(false);
  });

  it("warns (does not error, does not mutate) on oversized dimensions, out-of-range opacity, and out-of-range fontSize", () => {
    const shape = geoShapeForInspection({ x: 50, y: 50, opacity: 1.5, w: 5000, fontSize: 200 });
    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, sampleDocument);

    expect(issues.find((issue) => issue.code === "oversized_dimension")?.severity).toBe("warning");
    expect(issues.find((issue) => issue.code === "opacity_out_of_range")?.severity).toBe("warning");
    expect(issues.find((issue) => issue.code === "font_size_out_of_range")?.severity).toBe("warning");
    // Normalization is warning-only guidance; the tool must not silently clamp the shape.
    expect(shape.opacity).toBe(1.5);
    expect((shape as { props: { w: number } }).props.w).toBe(5000);
  });

  it("does not warn about opacity/fontSize when they are within range", () => {
    const shape = geoShapeForInspection({ x: 50, y: 50, opacity: 0.8 });
    const issues: VisualInspectionIssue[] = [];
    inspectShapeBasics(shape, issues, sampleDocument);
    expect(issues.some((issue) => issue.code === "opacity_out_of_range")).toBe(false);
    expect(issues.some((issue) => issue.code === "oversized_dimension")).toBe(false);
    expect(issues.some((issue) => issue.code === "font_size_out_of_range")).toBe(false);
  });
});

describe("review_visual_edit_session gating", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-review-gate-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function getFileId(): Promise<string> {
    const store = new LocalSigmaDocStore(userDataDir);
    const files = await store.listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  async function beginRenderedInspectedSession(): Promise<string> {
    const fileId = await getFileId();
    const begin = extractPayload(await client.callTool({
      name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
    }));
    const sessionId = (begin.session as { sessionId: string }).sessionId;
    await client.callTool({
      name: "visual_insert_shape",
      arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
    });
    await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
    const inspection = extractPayload(await client.callTool({
      name: "inspect_visual_edit_session",
      arguments: { sessionId },
    }));
    expect(inspection.ok).toBe(true);
    return sessionId;
  }

  it.skipIf(!resvgAvailable)(
    "fails even with verdict:'pass' and score:100 when issues is non-empty (score cannot buy a pass)",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const review = extractPayload(await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 100,
          previewCode: deriveVisualPreviewCode(sessionId, 1),
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
          issues: ["ラベルの位置がずれている"],
        },
      }));
      expect(review.ok).toBe(true);
      expect(review.passed).toBe(false);
      expect((review.review as { passed: boolean }).passed).toBe(false);
    },
  );

  it.skipIf(!resvgAvailable)(
    "requires previewCode and rejects a code that does not match the rendered revision",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const correctCode = deriveVisualPreviewCode(sessionId, 1);
      const wrongCode = correctCode === "ZZZZZ" ? "YYYYY" : "ZZZZZ";
      const review = extractPayload(await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 100,
          previewCode: wrongCode,
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      }));
      expect(review.ok).toBe(true);
      expect((review.review as { passed: boolean }).passed).toBe(false);
      expect(JSON.stringify(review)).not.toContain(correctCode);
      expect(JSON.stringify(review)).toContain("view_image");
    },
  );

  it.skipIf(!resvgAvailable)(
    "rejects review_visual_edit_session when the required previewCode is omitted",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const result = await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 100,
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain("previewCode");
    },
  );

  it.skipIf(!resvgAvailable)(
    "validates previewCode as five uppercase unambiguous characters",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const result = await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 100,
          previewCode: "AA0aa",
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      });
      expect(result.isError).toBe(true);
      expect((result.content as Array<{ text?: string }>)[0]?.text).toContain("previewCode");
    },
  );

  it.skipIf(!resvgAvailable)(
    "passes with a low self-reported score as long as verdict:'pass', issues is empty, inspection passed, and render is fresh",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const review = extractPayload(await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 10,
          previewCode: deriveVisualPreviewCode(sessionId, 1),
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      }));
      expect(review.ok).toBe(true);
      expect((review.review as { passed: boolean; score: number }).passed).toBe(true);
      expect((review.review as { passed: boolean; score: number }).score).toBe(10);
    },
  );

  it.skipIf(!resvgAvailable)(
    "fails when verdict is 'needs_revision' even with an empty issues list and a high score",
    async () => {
      const sessionId = await beginRenderedInspectedSession();
      const review = extractPayload(await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "needs_revision",
          score: 100,
          previewCode: deriveVisualPreviewCode(sessionId, 1),
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      }));
      expect(review.ok).toBe(true);
      expect(review.passed).toBe(false);
    },
  );

  it.skipIf(!resvgAvailable)(
    "fails when inspect_visual_edit_session has not been run for the current revision, even with verdict:'pass', no issues, and score:100",
    async () => {
      const fileId = await getFileId();
      const begin = extractPayload(await client.callTool({
        name: "begin_visual_edit_session",
      arguments: { fileId, targetId: "problem_complex_square_product_range", expectedRevision: 1 },
      }));
      const sessionId = (begin.session as { sessionId: string }).sessionId;
      await client.callTool({
        name: "visual_insert_shape",
        arguments: { sessionId, kind: "rectangle", x: 100, y: 100, r: 40 },
      });
      await client.callTool({ name: "render_visual_edit_session", arguments: { sessionId } });
      // inspect_visual_edit_session deliberately not called for this revision.

      const review = extractPayload(await client.callTool({
        name: "review_visual_edit_session",
        arguments: {
          sessionId,
          verdict: "pass",
          score: 100,
          previewCode: deriveVisualPreviewCode(sessionId, 1),
          sourceImageSummary: "元画像の要約",
          previewSummary: "previewの要約",
        },
      }));
      expect(review.ok).toBe(true);
      expect(review.passed).toBe(false);
      expect((review.review as { passed: boolean }).passed).toBe(false);
    },
  );
});

describe("save_ai_resource / delete_ai_resource / update_ai_settings", () => {
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-self-config-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;

    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  });

  afterEach(async () => {
    await client.close();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  it("save_ai_resource creates then updates a skill", async () => {
    const created = extractPayload(await client.callTool({
      name: "save_ai_resource",
      arguments: { kind: "skill", name: "geometry-tips", body: "# first\n" },
    }));
    expect(created.ok).toBe(true);
    expect((created.resource as { kind: string }).kind).toBe("skill");
    const skillPath = path.join(userDataDir, "data", "ai-agent-config", "skills", "geometry-tips", "SKILL.md");
    await expect(fs.readFile(skillPath, "utf8")).resolves.toContain("first");

    await client.callTool({
      name: "save_ai_resource",
      arguments: { kind: "skill", name: "geometry-tips", body: "# second\n" },
    });
    await expect(fs.readFile(skillPath, "utf8")).resolves.toContain("second");
  });

  it("save_ai_resource fails validation for an empty name (MCP tool-input error)", async () => {
    const result = await client.callTool({
      name: "save_ai_resource",
      arguments: { kind: "skill", name: "", body: "x" },
    });
    expect(result.isError).toBe(true);
  });

  it("save_ai_resource fails validation for a name that normalizes to empty (e.g. only symbols)", async () => {
    const result = extractPayload(await client.callTool({
      name: "save_ai_resource",
      arguments: { kind: "skill", name: "###", body: "x" },
    }));
    expect(result.ok).toBe(false);
  });

  it("save_ai_resource rejects updating an unknown instruction name", async () => {
    const result = extractPayload(await client.callTool({
      name: "save_ai_resource",
      arguments: { kind: "instruction", name: "not-a-real-instruction", body: "x" },
    }));
    expect(result.ok).toBe(false);
  });

  it("delete_ai_resource removes a skill created via save_ai_resource", async () => {
    await client.callTool({ name: "save_ai_resource", arguments: { kind: "skill", name: "temp-skill", body: "x" } });
    const skillPath = path.join(userDataDir, "data", "ai-agent-config", "skills", "temp-skill", "SKILL.md");
    await expect(fs.access(skillPath)).resolves.toBeUndefined();

    const deleted = extractPayload(await client.callTool({
      name: "delete_ai_resource",
      arguments: { kind: "skill", name: "temp-skill" },
    }));
    expect(deleted.ok).toBe(true);
    await expect(fs.access(skillPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("delete_ai_resource fails for a name that doesn't exist", async () => {
    const result = extractPayload(await client.callTool({
      name: "delete_ai_resource",
      arguments: { kind: "skill", name: "does-not-exist" },
    }));
    expect(result.ok).toBe(false);
  });

  it("update_ai_settings partially updates settings.json and reports resolved values", async () => {
    const result = extractPayload(await client.callTool({
      name: "update_ai_settings",
      arguments: { aiWebSearchEnabled: false },
    })) as { ok: boolean; settings: { aiAutoApplyVerifiedProposals: boolean; aiWebSearchEnabled: boolean } };

    expect(result.ok).toBe(true);
    expect(result.settings.aiWebSearchEnabled).toBe(false);
    expect(result.settings.aiAutoApplyVerifiedProposals).toBe(false);

    const raw = JSON.parse(await fs.readFile(path.join(userDataDir, "data", "settings.json"), "utf8")) as Record<string, unknown>;
    expect(raw.aiWebSearchEnabled).toBe(false);
  });

  it("update_ai_settings fails when called with no fields", async () => {
    const result = extractPayload(await client.callTool({ name: "update_ai_settings", arguments: {} }));
    expect(result.ok).toBe(false);
  });
});

describe("insert_graph3d / update_graph3d", () => {
  const GRAPH3D_RUN_ID = "run_graph3d";
  let userDataDir: string;
  let originalEnv: Record<string, string | undefined>;
  let client: Client;

  beforeEach(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-graph3d-"));
    const sigmaDocStore = new LocalSigmaDocStore(userDataDir);
    await sigmaDocStore.initializeWorkspace({ initialDocument: sampleDocument });

    originalEnv = {};
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
      delete process.env[key];
    }
    process.env.SIGMA_STUDIO_USER_DATA_DIR = userDataDir;
  });

  afterEach(async () => {
    await client.close();
    await flushVisualSessionStatusWritesForTests();
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  async function connectClient(renderVisualPreviewDeps?: RenderVisualPreviewDeps): Promise<void> {
    const server = createSigmaDocMcpServer({ renderVisualPreviewDeps });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);
  }

  async function getFileId(): Promise<string> {
    const files = await new LocalSigmaDocStore(userDataDir).listFiles();
    const fileId = files[0]?.fileId;
    if (!fileId) {
      throw new Error("test fixture file missing");
    }
    return fileId;
  }

  async function loadPendingProposal(): Promise<{ nextDocument: SigmaDocument }> {
    const proposalStore = new LocalMcpEditProposalStore(userDataDir);
    const summaries = await proposalStore.listProposals({ status: "pending" });
    const proposal = summaries[0] ? await proposalStore.loadProposal(summaries[0].proposalId) : null;
    if (!proposal) {
      throw new Error("expected a pending proposal");
    }
    return proposal;
  }

  function graph3DShapesOf(document: SigmaDocument): OverlayShape[] {
    return normalizeOverlaySnapshot(document.pageLayout?.overlay?.overlaySnapshot)
      .shapes.filter((shape) => shape.type === "graph3dShape");
  }

  async function insertRevolution(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const fileId = await getFileId();
    return extractPayload(await client.callTool({
      name: "insert_graph3d",
      arguments: {
        fileId,
        targetId: "p_source_note",
        preset: "revolution",
        expectedRevision: 1,
        // 同じrunの作業案を土台に続きのツールが動く (insert→updateの実際の流れ)。
        runId: GRAPH3D_RUN_ID,
        ...overrides,
      },
    }));
  }

  it("inserts exactly one graph3dShape and reports a valid document", async () => {
    await connectClient();

    const result = await insertRevolution();

    expect(result.ok).toBe(true);
    expect(result.proposalCreated).toBe(true);
    expect((result.verification as { validation: { ok: boolean } }).validation.ok).toBe(true);
    const proposal = await loadPendingProposal();
    expect(graph3DShapesOf(proposal.nextDocument)).toHaveLength(1);
  });

  it("keeps the insertion successful when nothing can rasterize the figure", async () => {
    await connectClient({
      env: {},
      fetchImpl: async () => {
        throw new Error("no bridge in this test");
      },
      loadResvg: async () => null,
    });

    const result = await insertRevolution();

    expect(result.ok).toBe(true);
    const preview3d = (result.verification as { preview3d?: { source: string; warnings: string[] } }).preview3d;
    expect(preview3d?.source).toBe("none");
    expect(preview3d?.warnings.length).toBeGreaterThan(0);
    const shape = graph3DShapesOf((await loadPendingProposal()).nextDocument)[0] as {
      props: { previewAssetId?: string };
    };
    // 絵が無いのは欠落であって失敗ではない。図形自体は入り、アプリが開いた時にWebGLが描き直す。
    expect(shape.props.previewAssetId).toBeUndefined();
  });

  it("rejects update_graph3d that changes nothing", async () => {
    await connectClient();
    expect((await insertRevolution({ id: "graph3d_mcp" })).ok).toBe(true);
    const fileId = await getFileId();

    const result = extractPayload(await client.callTool({
      name: "update_graph3d",
      arguments: { fileId, shapeId: "graph3d_mcp", expectedRevision: 1, runId: GRAPH3D_RUN_ID },
    }));

    expect(result.ok).toBe(false);
  });

  it("updates the spec in place while keeping id and position", async () => {
    await connectClient();
    expect((await insertRevolution({ id: "graph3d_mcp", x: 120, y: 200 })).ok).toBe(true);
    const fileId = await getFileId();

    const result = extractPayload(await client.callTool({
      name: "update_graph3d",
      arguments: {
        fileId,
        shapeId: "graph3d_mcp",
        camera: { position: { x: 4, y: -4, z: 3 } },
        expectedRevision: 1,
        runId: GRAPH3D_RUN_ID,
      },
    }));

    expect(result.ok).toBe(true);
    const shape = graph3DShapesOf((await loadPendingProposal()).nextDocument)[0] as {
      id: string;
      x: number;
      y: number;
      props: { spec: { camera: { position: { x: number } } } };
    };
    expect(shape.id).toBe("graph3d_mcp");
    expect(shape.x).toBe(120);
    expect(shape.y).toBe(200);
    expect(shape.props.spec.camera.position).toEqual({ x: 4, y: -4, z: 3 });
  });

  describe.skipIf(!resvgAvailable)("with a rasterizer available", () => {
    it("does not draw the figure for a dryRun", async () => {
      await connectClient();

      const result = await insertRevolution({ writeMode: "dryRun" });

      expect(result.ok).toBe(true);
      expect(result.proposalCreated).toBe(false);
      // 同じ呼び出しがproposalなら "provided" になる (下のテストが実物のPNGを確かめている)。
      // 何も保存しない実行のために、WebGL無しの描画とラスタライズの時間を払わない。
      expect((result.toolResult as { data: { preview: { source: string } } }).data.preview.source).toBe("none");
      expect((result.verification as { preview3d?: unknown }).preview3d).toBeUndefined();
    });

    it("carries a real PNG into the proposal and draws it in the overlay SVG", async () => {
      await connectClient();

      const result = await insertRevolution({ id: "graph3d_mcp" });

      expect(result.ok).toBe(true);
      expect((result.verification as { preview3d: { source: string } }).preview3d.source).toBe("resvg");
      const nextDocument = (await loadPendingProposal()).nextDocument;
      const snapshot = normalizeOverlaySnapshot(nextDocument.pageLayout?.overlay?.overlaySnapshot);
      const shape = snapshot.shapes.find((item) => item.id === "graph3d_mcp") as {
        props: { previewAssetId?: string; previewSourceHash?: string; spec: Graph3DSpec };
      };
      expect(shape.props.previewAssetId).toBe("asset_graph3d_preview_graph3d_mcp");
      expect(shape.props.previewSourceHash).toBe(getGraph3DPreviewSourceHash(shape.props.spec));
      expect(snapshot.assets[shape.props.previewAssetId!]?.props.src).toMatch(/^data:image\/png;base64,/);
      expect(getInvalidAiOverlayAssetIdsInDocument(nextDocument)).toEqual([]);

      // ヘッドレスな書き出し (印刷・PDF・公開ビューア) に実物が出ること。
      const svg = exportOverlaySvg(snapshot.shapes, snapshot.assets) ?? "";
      expect(svg).toContain("<image");
      expect(svg).toContain("data:image/png;base64,");
      expect(svg).not.toContain(">3D<");
    });

    it("replaces the derived PNG and the source hash when the spec changes", async () => {
      await connectClient();
      expect((await insertRevolution({ id: "graph3d_mcp" })).ok).toBe(true);
      const before = normalizeOverlaySnapshot(
        (await loadPendingProposal()).nextDocument.pageLayout?.overlay?.overlaySnapshot,
      );
      const beforeShape = before.shapes.find((item) => item.id === "graph3d_mcp") as {
        props: { previewAssetId?: string; previewSourceHash?: string };
      };
      const fileId = await getFileId();

      const result = extractPayload(await client.callTool({
        name: "update_graph3d",
        arguments: {
          fileId,
          shapeId: "graph3d_mcp",
          objects: [{ id: "sphere", kind: "primitive", primitive: "sphere", center: { x: "0", y: "0", z: "0" }, size: { x: "2", y: "2", z: "2" } }],
          expectedRevision: 1,
          runId: GRAPH3D_RUN_ID,
        },
      }));

      expect(result.ok).toBe(true);
      const after = normalizeOverlaySnapshot(
        (await loadPendingProposal()).nextDocument.pageLayout?.overlay?.overlaySnapshot,
      );
      const afterShape = after.shapes.find((item) => item.id === "graph3d_mcp") as {
        props: { previewAssetId?: string; previewSourceHash?: string; spec: Graph3DSpec };
      };
      expect(afterShape.props.previewAssetId).toBe(beforeShape.props.previewAssetId);
      expect(afterShape.props.previewSourceHash).toBe(getGraph3DPreviewSourceHash(afterShape.props.spec));
      expect(afterShape.props.previewSourceHash).not.toBe(beforeShape.props.previewSourceHash);
      // 図が変われば絵も変わる。同じidに古い絵が残っていたら、specだけが新しい嘘の状態になる。
      expect(after.assets[afterShape.props.previewAssetId!]?.props.src)
        .not.toBe(before.assets[beforeShape.props.previewAssetId!]?.props.src);
      expect(getInvalidAiOverlayAssetIdsInDocument((await loadPendingProposal()).nextDocument)).toEqual([]);
    });
  });
});
