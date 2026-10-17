import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildMcpEditPrompt } from "@/lib/ai/mcp-edit-prompt";
import { createSigmaDocMcpServer, SIGMA_DOC_MCP_SERVER_INSTRUCTIONS } from "./sigma-doc-mcp-server-core";

/**
 * AIへの指示の置き場所 (docs/mcp-local-app.md「AIへの指示の置き場所」)。
 * server instructions は素性だけ、ツール固有の使い方はそのツールの説明、
 * ツールをまたぐ方針はアプリのプロンプトに1回だけ置く。
 */
describe("MCP guidance placement", () => {
  let userDataDir: string;
  let client: Client;
  let tools: Tool[];
  let instructions: string;

  beforeAll(async () => {
    userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-mcp-guidance-"));
    vi.stubEnv("SIGMA_STUDIO_USER_DATA_DIR", userDataDir);
    const server = createSigmaDocMcpServer();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    client = new Client({ name: "guidance-placement", version: "0" });
    await client.connect(clientTransport);
    tools = (await client.listTools()).tools;
    instructions = client.getInstructions() ?? "";
  });

  afterAll(async () => {
    await client.close();
    vi.unstubAllEnvs();
    await fs.rm(userDataDir, { recursive: true, force: true });
  });

  const descriptionOf = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";

  it("keeps the server instructions to the server's identity", () => {
    expect(instructions).toBe(SIGMA_DOC_MCP_SERVER_INSTRUCTIONS);
    // Claude Code は先頭約4,000字だけを載せ、Codex は各ツールの説明の前に毎回付ける。
    expect(instructions.length).toBeLessThan(300);
    expect(instructions).toContain("SigmaDoc JSONが正本");
    for (const rule of ["insert_svg_image", "expectedRevision", "REVISION_MISMATCH", "targetId", "verification", "overlay図形", "insert_shape"]) {
      expect(instructions).not.toContain(rule);
    }
  });

  it("keeps tool-specific usage in the tool descriptions", () => {
    const svg = descriptionOf("insert_svg_image");
    for (const phrase of [
      "xmlnsと正のviewBox", "表示属性(fill/stroke等)", "class", "pattern・filter", "TeXは解釈されない",
      "白黒基調・透明背景", "w:hの比はviewBoxに合わせます", "本文は回り込みません",
      "verification.previewのPNGを必ず実見", "update_svg_image", "update_shapeのx/y/w/h", "render_block_contextまたはrender_page",
      // 部品ごとに編集したい図もSVGで描き、「図形に変換」で分解する。分解される書き方の要点もここが持つ。
      "部品ごとに編集したい図もこのツールで描き", "convert_svg_imageで線・図形・文字・数式に分解", "曲線はM…Q…を1本ずつ",
      "円弧はQで近似", "線のstrokeと同じ色の標準marker(三角・V字・丸)", "stroke-widthは0.75/1.25/2/3/5", "部品はupdate_svg_imageでは直せないのでupdate_shape",
    ]) {
      expect(svg).toContain(phrase);
    }
    expect(svg).not.toContain("部品ごとに個別編集する図形だけinsert_shape");
    const shape = descriptionOf("insert_shape");
    expect(shape).toContain("部品ごとに編集したい場合もinsert_svg_image(SVG1枚)で描いてください");
    expect(shape).not.toContain("部品ごとに個別編集する図形、");
    expect(shape).toContain("polylineで近似しないでください");
    expect(shape).toContain("wがテキストの折り返し幅");
    expect(shape).toContain("高さは内容から導出されるのでhは指定できません");
    expect(descriptionOf("update_page_layout")).toContain("用紙方向・本文領域・余白");
    expect(descriptionOf("update_table")).toContain("cellPatches");
  });

  it("does not repeat tool-specific usage in the first-turn app prompt", () => {
    const prompt = buildMcpEditPrompt({
      locale: "ja", provider: "claude", instruction: "図を入れて", fileId: "file_1", runId: "run_1",
    });
    for (const phrase of [
      "w:hの比はviewBox", "本文は回り込", "xmlnsと正のviewBox", "hは指定できません", "ページ設定ツール方針", "cellPatches",
      "Sigma Studio のローカル教材を読み書きするMCPサーバー",
    ]) {
      expect(prompt).not.toContain(phrase);
    }
  });
});
