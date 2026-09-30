import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeOverlaySnapshot } from "@/features/document";
import { sampleDocument } from "@/lib/sample-document";
import { LocalAiEditRunContextStore } from "../electron/ai-edit-run-context";
import { LocalSigmaDocStore } from "../electron/local-sigma-doc-store";
import { LocalMcpEditProposalStore } from "../electron/local-sigma-doc-proposal-store";
import { createSigmaDocMcpServer } from "./sigma-doc-mcp-server-core";

/**
 * 公式スキルの本文にある例を、実際のMCPツール(app profile)へ渡して受理されることを確かめる。
 * スキルの例が古いschemaのまま残ると、モデルはその例をなぞって失敗するため。
 */
const SKILLS_ROOT = path.join(__dirname, "..", "electron", "official-skills");

async function fences(skill: string, language: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(SKILLS_ROOT, skill, "SKILL.md"), "utf8");
  return [...raw.matchAll(new RegExp("```" + language + "\\n([\\s\\S]*?)```", "g"))].map((match) => match[1]!.trim());
}

describe("official skill examples against the app-profile MCP tools", () => {
  let directory: string;
  let store: LocalSigmaDocStore;
  let proposals: LocalMcpEditProposalStore;
  let client: Client;
  let fileId: string;

  beforeEach(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-skill-examples-"));
    for (const key of ["SIGMA_STUDIO_DATA_DIR", "SIGMA_STUDIO_RENDER_BRIDGE_FILE", "SIGMA_STUDIO_RUN_CONTEXT_FILE"]) vi.stubEnv(key, undefined);
    vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", directory);
    vi.stubEnv("SIGMA_STUDIO_MCP_PROVIDER", "chatgpt");
    store = new LocalSigmaDocStore(directory);
    await store.initializeWorkspace({ initialDocument: {
      ...structuredClone(sampleDocument),
      content: [{ id: "p_skill", type: "paragraph", children: [{ type: "text", text: "スキルの例を確かめる段落" }] }],
    } });
    fileId = (await store.listFiles())[0].fileId;
    proposals = new LocalMcpEditProposalStore(directory);
    const context = new LocalAiEditRunContextStore(directory, "chatgpt", { runId: "skill_run" });
    await context.write({ version: 1, runId: "skill_run", provider: "chatgpt", fileId, fileRevision: 1,
      createdAt: new Date().toISOString(), selectedId: "p_skill", references: [], attachments: [], mentionedDocuments: [], roomId: "skill_room", turnId: "skill_turn" });
    vi.stubEnv("SIGMA_STUDIO_RUN_CONTEXT_FILE", context.getRunContextFilePath());
    const server = createSigmaDocMcpServer({ toolProfile: "app" });
    client = new Client({ name: "skill-examples", version: "1" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(a), server.connect(b)]);
  });
  afterEach(async () => { await client.close(); vi.unstubAllEnvs(); await fs.rm(directory, { recursive: true, force: true }); });

  async function call(name: string, args: Record<string, unknown>) {
    const result = await client.callTool({
      name,
      arguments: { fileId, expectedRevision: 1, runId: "skill_run", writeMode: "dryRun", ...args },
    });
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    expect(result.structuredContent, JSON.stringify(result)).toMatchObject({ ok: true });
    return (result.structuredContent as { data: Record<string, unknown> }).data;
  }

  it("exposes every tool the skills name", async () => {
    const names = new Set((await client.listTools()).tools.map((tool) => tool.name));
    for (const name of [
      "insert_content", "edit_text", "edit_problem", "organize_blocks",
      "insert_svg_image", "update_svg_image", "insert_shape", "update_shape", "align_shapes", "delete_shapes",
      "insert_table", "update_table", "insert_graph", "update_graph", "insert_graph3d", "update_graph3d",
      "update_page_layout", "update_column_layout", "insert_material", "list_materials", "get_material",
      "search_library", "get_edit_context", "get_document_outline", "get_blocks", "search_document",
    ]) {
      expect(names.has(name), name).toBe(true);
    }
    // 外部MCP名は app profile では出ない。スキルがそれを書くとモデルは呼べない。
    for (const legacy of ["insert_body_content", "create_problem_content", "apply_edits"]) {
      expect(names.has(legacy), legacy).toBe(false);
    }
  });

  it("accepts the SVG figures shipped in sigma-svg-figure and inserts them as one image each", async () => {
    const figures = await fences("sigma-svg-figure", "svg");
    expect(figures.length).toBeGreaterThanOrEqual(2);
    for (const svg of figures) {
      const data = await call("insert_svg_image", { targetId: "p_skill", svg, w: 320, name: "スキルの例" });
      expect(data.verification).toMatchObject({ validation: { ok: true } });
    }
  });

  it("accepts the graph example in sigma-graph-editing", async () => {
    const [graph] = await fences("sigma-graph-editing", "json");
    const data = await call("insert_graph", { targetId: "p_skill", ...JSON.parse(graph!) });
    expect(data.verification).toMatchObject({ validation: { ok: true } });
  });

  it("accepts the variation-table example in sigma-table-editing", async () => {
    const [table] = await fences("sigma-table-editing", "json");
    const data = await call("insert_table", { targetId: "p_skill", ...JSON.parse(table!) });
    expect(data.verification).toMatchObject({ validation: { ok: true } });
  });

  it("accepts the block shapes described in sigma-body-authoring and sigma-problem-authoring", async () => {
    const data = await call("insert_content", {
      targetId: "p_skill",
      content: {
        format: "blocks",
        blocks: [
          { type: "paragraph", id: "ai_p_1", runs: ["式 ", { type: "math", id: "ai_m_1", tex: "x^2+1" }, "を考える。"] },
          { type: "heading", level: 2, text: "見出し" },
          { type: "list", listType: "ordered", markerStyle: "paren", items: ["一つ目", "二つ目"] },
          { type: "boxBlock", styleId: "itembox", title: "ポイント", blocks: [{ type: "paragraph", id: "ai_box_p", text: "囲みの本文" }] },
          { type: "codeBlock", language: "python", text: "print(1)" },
          { type: "paragraph", id: "ai_p_break", text: "次のページから", pagination: { break: true } },
        ],
      },
    });
    expect(data.verification).toMatchObject({ validation: { ok: true } });

    const problem = await call("edit_problem", {
      edit: {
        action: "create",
        targetId: "p_skill",
        prompt: [
          "次の問いに答えよ。",
          { type: "list", listType: "ordered", markerStyle: "paren", items: [
            { runs: ["方程式 ", { type: "math", id: "ai_pm_1", tex: "x^2-4=0" }, " を解け。"] },
            "不等式を解け。",
          ] },
        ],
        answerTex: "x=\\pm 2",
      },
    });
    expect(problem.verification).toMatchObject({ validation: { ok: true } });
  });

  it("keeps the placement facts sigma-svg-figure relies on", async () => {
    // 書き込みは提案として保存し、SVGの画像shapeと表示サイズを取り出す。
    const [svg] = await fences("sigma-svg-figure", "svg");
    const result = await client.callTool({
      name: "insert_svg_image",
      arguments: { fileId, expectedRevision: 1, runId: "skill_run", targetId: "p_skill", svg, name: "配置の確認" },
    });
    expect(result.structuredContent).toMatchObject({ ok: true });
    const [record] = await proposals.listProposals({ status: "pending" });
    const proposal = (await proposals.loadProposal(record!.proposalId))!;
    const snapshot = normalizeOverlaySnapshot(proposal.nextDocument.pageLayout?.overlay?.overlaySnapshot);
    const image = snapshot.shapes.at(-1)!;
    expect(image.type).toBe("image");
    if (image.type !== "image") return;
    // wを省略すると、viewBox幅(320)と480の小さいほうになり、縦横比は viewBox のまま。
    expect(image.props.w).toBe(320);
    expect(image.props.h).toBeCloseTo(220, 5);
    expect(image.anchor).toMatchObject({ type: "block", blockId: "p_skill" });
  });
});
