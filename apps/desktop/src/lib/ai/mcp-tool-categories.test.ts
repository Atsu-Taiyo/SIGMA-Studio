import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";

import { createSigmaDocMcpServer } from "../../../mcp/sigma-doc-mcp-server-core";
import {
  ALWAYS_AVAILABLE_MCP_TOOL_NAMES,
  inferToolCategoriesForRun,
  MCP_TOOL_CATEGORIES,
  MCP_TOOL_CATEGORY_MAP,
  measureMcpToolExposure,
  toolNamesForCategories,
} from "./mcp-tool-categories";

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
