import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createSigmaDocMcpServer } from "../../../mcp/sigma-doc-mcp-server-core";
import { OFFICIAL_SKILL_DEFINITIONS } from "../../../electron/ai-resource-store";
import type { OverlayShape } from "@/features/document";
import {
  ALWAYS_AVAILABLE_MCP_TOOL_NAMES,
  categoriesToAllowAfterDenial,
  inferToolCategoriesForRun,
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_CATEGORY_MAP,
  measureMcpToolExposure,
  toolNamesForCategories,
  type McpToolName,
} from "./mcp-tool-categories";
import { appMcpToolNames } from "./mcp-tool-profile";

/**
 * Tools that edit a shape of each overlay type once it is on the page, read from the MCP handlers:
 * update_shape refuses tables and 2D graphs (they have their own update tool), and an image's
 * source is replaced by the SVG or generated-image tool. Selecting a shape and asking to change it
 * must allow every tool in its row. A new shape type fails the typecheck here until it gets a row.
 */
const SHAPE_EDITING_TOOLS = {
  group: ["update_shape", "delete_shapes", "align_shapes"],
  geo: ["update_shape", "delete_shapes", "align_shapes"],
  arc: ["update_shape", "delete_shapes", "align_shapes"],
  arrow: ["update_shape", "delete_shapes", "align_shapes"],
  line: ["update_shape", "delete_shapes", "align_shapes"],
  text: ["update_shape", "delete_shapes", "align_shapes"],
  callout: ["update_shape", "delete_shapes", "align_shapes"],
  chartShape: ["update_shape", "delete_shapes", "align_shapes"],
  image: ["update_shape", "update_svg_image", "update_generated_image", "delete_shapes", "align_shapes"],
  graph2dShape: ["update_graph", "delete_shapes", "align_shapes"],
  graph3dShape: ["update_graph3d", "update_shape", "delete_shapes", "align_shapes"],
  tableShape: ["update_table", "delete_shapes", "align_shapes"],
} as const satisfies Record<OverlayShape["type"], readonly McpToolName[]>;

function allowedAppToolsForRun(args: Parameters<typeof inferToolCategoriesForRun>[0]): string[] {
  return appMcpToolNames(toolNamesForCategories(inferToolCategoriesForRun(args)));
}

function selectedShapeReference(type: string) {
  return { kind: "block", targetType: `overlayShape:${type}`, overlaySelection: { shapes: [{ type }] } };
}

describe("MCP tool category inference", () => {
  it("always includes document exploration and narrows graph instructions", () => {
    expect(inferToolCategoriesForRun({
      instruction: "二次関数のグラフを追加して",
      references: [],
      selectedSkillIds: [],
    })).toEqual(["文書探索", "グラフ"]);
  });

  it("uses selected reference types even when the instruction is generic", () => {
    expect(inferToolCategoriesForRun({
      instruction: "これを直して",
      references: [{ targetType: "tableShape", excerpt: "増減" }],
      selectedSkillIds: [],
    })).toEqual(["文書探索", "表"]);
  });

  it("treats body-block reordering as body editing and exposes move_blocks", () => {
    const categories = inferToolCategoriesForRun({
      instruction: "問題2を問題1の前へ移動して",
      references: [],
      selectedSkillIds: [],
    });

    expect(categories).toEqual(["文書探索", "本文編集"]);
    expect(MCP_TOOL_CATEGORY_MAP["本文編集"]).toContain("move_blocks");
    expect(MCP_TOOL_CATEGORY_MAP["ページ・段組み"]).not.toContain("move_blocks");
    expect(toolNamesForCategories(categories)).toContain("move_blocks");
  });

  it("exposes only app-owned library CRUD for document and folder management requests", () => {
    const categories = inferToolCategoriesForRun({
      instruction: "教材ファイルを作成してフォルダへ移動して",
      references: [],
      selectedSkillIds: [],
    });

    expect(categories).toEqual(["文書探索", "教材管理"]);
    expect(toolNamesForCategories(categories)).toEqual(expect.arrayContaining([
      "create_local_document",
      "update_local_document",
      "delete_local_document",
      "create_local_folder",
      "update_local_folder",
      "delete_local_folder",
    ]));
    expect(toolNamesForCategories(categories)).not.toContain("insert_body_content");
  });

  it("expands official skill selections to the categories their workflows need", () => {
    expect(inferToolCategoriesForRun({
      instruction: "教材を整えて",
      references: [],
      selectedSkillIds: ["official-graph"],
    })).toEqual(["文書探索", "図形", "グラフ", "visual edit"]);

    expect(inferToolCategoriesForRun({
      instruction: "この画像を再構成して",
      references: [],
      selectedSkillIds: ["official-image-material"],
    })).toEqual(["文書探索", "本文編集", "図形", "表", "グラフ", "visual edit", "素材"]);
  });

  it("opens the SVG image tools for any request that mentions a figure or illustration", () => {
    for (const instruction of [
      "この問題に図を追加して",
      "解説にイラストを入れて",
      "フローチャートを描いて",
      "斜面の絵を入れてほしい",
      "Add a diagram to problem 2",
    ]) {
      const categories = inferToolCategoriesForRun({ instruction, references: [], selectedSkillIds: [] });
      expect(toolNamesForCategories(categories), instruction).toEqual(expect.arrayContaining([
        "insert_svg_image",
        "update_svg_image",
      ]));
    }
    // 「図書」のような無関係な語だけでは、図形カテゴリを足さない。
    expect(inferToolCategoriesForRun({ instruction: "図書館の紹介文を書き直して", references: [], selectedSkillIds: [] }))
      .toEqual(["文書探索", "本文編集"]);
  });

  it("recognises every official skill instead of exposing all tools", () => {
    for (const { id } of OFFICIAL_SKILL_DEFINITIONS) {
      const categories = inferToolCategoriesForRun({ instruction: "", references: [], selectedSkillIds: [id] });
      expect(categories, id).not.toEqual([...MCP_TOOL_CATEGORIES]);
    }
    expect(inferToolCategoriesForRun({ instruction: "", references: [], selectedSkillIds: ["official-svg-figure"] }))
      .toEqual(["文書探索", "図形", "visual edit", "素材"]);
  });

  it("falls back to all categories for uncertain instructions or unknown selected skills", () => {
    expect(inferToolCategoriesForRun({
      instruction: "いい感じに直して",
      references: [],
      selectedSkillIds: [],
    })).toEqual([...MCP_TOOL_CATEGORIES]);

    expect(inferToolCategoriesForRun({
      instruction: "本文を直して",
      references: [],
      selectedSkillIds: ["skill-domain-specific-workflow"],
    })).toEqual([...MCP_TOOL_CATEGORIES]);
  });

  it("opens the 3D graph tools for requests about solids", () => {
    // 実際に拒否された依頼: 段落を選んだまま「円柱」の「円」で図形だけが開き、insert_graph3d が無かった。
    expect(allowedAppToolsForRun({
      instruction: "3dで三角錐と円柱の共通部分を可視化して",
      references: [{ kind: "block", targetType: "paragraph", excerpt: "次の立体について考える。" }],
      selectedSkillIds: [],
    })).toEqual(expect.arrayContaining(["insert_graph3d", "update_graph3d"]));

    for (const instruction of [
      "３Ｄで表示して問題文も直して",
      "立体の問題文を直して",
      "空間図形の問題に図を入れて",
      "三次元の問題文を直して",
      "円錐の問題文を直して",
      "四角錐の問題文を直して",
      "三角柱の問題文を直して",
      "正四面体と立方体と直方体の問題を作って",
      "球の体積の問題を作って",
      "回転体の問題を作って",
      "断面の問題を作って",
      "正八面体の図を入れて",
      "六面体の問題文を直して",
      "十二面体と二十面体の問題を作って",
      "錐体の問題文を直して",
      "展開図の問題を作って",
      "Fix the problem about a sphere, a cone and a cylinder",
      "Fix the problem about a tetrahedron, an octahedron and a torus",
    ]) {
      const args = { instruction, references: [], selectedSkillIds: [] };
      // 本文の語で絞り込まれた run でも、立体の語があれば3Dグラフのツールが入る。
      expect(inferToolCategoriesForRun(args), instruction).not.toEqual([...MCP_TOOL_CATEGORIES]);
      expect(allowedAppToolsForRun(args), instruction)
        .toEqual(expect.arrayContaining(["insert_graph3d", "update_graph3d"]));
    }
  });

  it("never narrows a run on a solid-figure word alone", () => {
    // 「球」は地球・球技・電球にも当たる。そこから絞り込むと、本文編集の依頼で本文のツールが拒否される。
    expect(inferToolCategoriesForRun({ instruction: "球技大会のお知らせを書いて", references: [], selectedSkillIds: [] }))
      .toEqual([...MCP_TOOL_CATEGORIES]);
    expect(inferToolCategoriesForRun({ instruction: "球を3Dで描いて", references: [], selectedSkillIds: [] }))
      .toEqual([...MCP_TOOL_CATEGORIES]);
    // 探索の語と汎用の変更の語だけの依頼は全カテゴリのまま (立体の語で「探索だけではない」と数えない)。
    expect(inferToolCategoriesForRun({ instruction: "地球の説明を確認して修正して", references: [], selectedSkillIds: [] }))
      .toEqual([...MCP_TOOL_CATEGORIES]);
  });

  it("allows updating a selected 3D graph from a generic instruction", () => {
    // 実際に拒否された依頼: 3D グラフを選んで「コレをアップデートしてみて」。
    expect(allowedAppToolsForRun({
      instruction: "コレをアップデートしてみて",
      references: [selectedShapeReference("graph3dShape")],
      selectedSkillIds: [],
    })).toContain("update_graph3d");
  });

  it("allows every tool that edits the selected shape, for every overlay shape type", () => {
    for (const [type, tools] of Object.entries(SHAPE_EDITING_TOOLS)) {
      const allowed = allowedAppToolsForRun({
        instruction: "コレをアップデートしてみて",
        references: [selectedShapeReference(type)],
        selectedSkillIds: [],
      });
      expect(allowed, type).toEqual(expect.arrayContaining([...tools]));
    }
  });

  it("lists every shape-editing tool of the shape, table, and graph categories in the shape table", () => {
    const tabulated = new Set<string>(Object.values(SHAPE_EDITING_TOOLS).flat());
    const editingTools = (["図形", "表", "グラフ"] as const)
      .flatMap((category) => MCP_TOOL_CATEGORY_MAP[category])
      .filter((name) => !name.startsWith("insert_"));

    expect(editingTools.filter((name) => !tabulated.has(name))).toEqual([]);
  });
});

describe("categoriesToAllowAfterDenial", () => {
  it("allows only the category of the refused tool, by its app-profile or external name", () => {
    expect(categoriesToAllowAfterDenial(["insert_graph3d"])).toEqual(["グラフ"]);
    expect(categoriesToAllowAfterDenial(["edit_text", "insert_table"])).toEqual(["本文編集", "表"]);
    expect(categoriesToAllowAfterDenial(["apply_edits"])).toEqual(["本文編集"]);
  });

  it("never opens library management or AI settings, and ignores unknown tools", () => {
    expect(categoriesToAllowAfterDenial(["update_ai_settings", "save_ai_resource", "delete_local_document"])).toEqual([]);
    expect(categoriesToAllowAfterDenial(["no_such_tool", ""])).toEqual([]);

    for (const category of MCP_TOOL_CATEGORIES) {
      const expected = category === "教材管理" || category === "AI設定・アプリ文脈" ? [] : [category];
      for (const name of appMcpToolNames(MCP_TOOL_CATEGORY_MAP[category])) {
        expect(categoriesToAllowAfterDenial([name]), name).toEqual(expected);
      }
    }
  });
});

describe("toolNamesForCategories", () => {
  it("adds document exploration and proposal/verification tools to a selection", () => {
    const names = toolNamesForCategories(["表"]);

    expect(names).toEqual(expect.arrayContaining([...MCP_TOOL_CATEGORY_MAP["文書探索"]]));
    expect(names).toEqual(expect.arrayContaining([...MCP_TOOL_CATEGORY_MAP["表"]]));
    expect(names).toEqual(expect.arrayContaining([...ALWAYS_AVAILABLE_MCP_TOOL_NAMES]));
    expect(names).not.toContain("insert_graph");
    expect(names).not.toContain("update_ai_settings");
  });
});

describe("measureMcpToolExposure", () => {
  it("reports real MCP tool count and serialized schema bytes for staged vs full exposure", async () => {
    const server = createSigmaDocMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "tool-measurement-test", version: "0.0.0" });
    await Promise.all([
      client.connect(clientTransport),
      server.connect(serverTransport),
    ]);

    try {
      const tools = (await client.listTools()).tools;
      const measurement = measureMcpToolExposure(tools, ["文書探索", "グラフ"]);

      console.info("[mcp-tool-exposure]", JSON.stringify(measurement));
      expect(measurement.selection.toolCount).toBe(toolNamesForCategories(["グラフ"]).length);
      expect(measurement.selection.toolCount).toBeLessThan(measurement.fullExposure.toolCount);
      expect(measurement.selection.serializedSchemaBytes).toBeLessThan(
        measurement.fullExposure.serializedSchemaBytes,
      );
    } finally {
      await client.close();
    }
  });
});
