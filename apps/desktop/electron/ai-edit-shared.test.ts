import { describe, expect, it } from "vitest";

import { buildCancelledMcpEditRunResult, buildMcpEditRunResult, isWriteCapableMcpToolName, toCodexImageInputUrls } from "./ai-edit-shared";

describe("isWriteCapableMcpToolName", () => {
  it("treats proposal-creating tools as write-capable, for both plain and claude-prefixed names", () => {
    for (const name of [
      "insert_content",
      "edit_text",
      "edit_problem",
      "organize_blocks",
      "apply_edits",
      "insert_body_content",
      "create_problem_content",
      "update_rich_content",
      "update_problem_content",
      "replace_block",
      "delete_blocks",
      "move_blocks",
      "insert_table",
      "update_table",
      "insert_shape",
      "update_shape",
      "align_shapes",
      "delete_shapes",
      "insert_graph",
      "update_graph",
      "insert_graph3d",
      "update_graph3d",
      "insert_material",
      "propose_visual_edit_session",
    ]) {
      expect(isWriteCapableMcpToolName(name)).toBe(true);
      expect(isWriteCapableMcpToolName(`mcp__sigma-studio-local__${name}`)).toBe(true);
      expect(isWriteCapableMcpToolName(`mcp_sigma-studio-local_${name}`)).toBe(true);
    }
  });

  it("treats read-only tools and visual-session scratch steps (pre-commit) as not write-capable", () => {
    for (const name of [
      "read_local_document",
      "get_document_outline",
      "get_block",
      "list_edit_proposals",
      "list_materials",
      "get_material",
      "list_local_documents",
      "validate_local_document",
      "begin_visual_edit_session",
      "visual_insert_shape",
      "visual_replace_shape",
      "visual_remove_shape",
      "render_visual_edit_session",
      "inspect_visual_edit_session",
      "review_visual_edit_session",
      "discard_visual_edit_session",
      "get_selected_block",
      "get_active_reference",
    ]) {
      expect(isWriteCapableMcpToolName(name)).toBe(false);
      expect(isWriteCapableMcpToolName(`mcp__sigma-studio-local__${name}`)).toBe(false);
      expect(isWriteCapableMcpToolName(`mcp_sigma-studio-local_${name}`)).toBe(false);
    }
  });

  it("returns false for undefined/null/empty names", () => {
    expect(isWriteCapableMcpToolName(undefined)).toBe(false);
    expect(isWriteCapableMcpToolName(null)).toBe(false);
    expect(isWriteCapableMcpToolName("")).toBe(false);
  });

  it("does not strip gemini tool names with a generic single-underscore regex (exact prefix only)", () => {
    // tool names themselves contain underscores (insert_body_content), so a naive
    // single-underscore strip would mangle them; only the exact gemini MCP prefix
    // (mcp_sigma-studio-local_) may be removed.
    expect(isWriteCapableMcpToolName("mcp_sigma-studio-local_insert_body_content")).toBe(true);
    expect(isWriteCapableMcpToolName("mcp_other-server_insert_body_content")).toBe(false);
  });
});

describe("toCodexImageInputUrls", () => {
  it("keeps only the claude-allowlisted image mime types (png/jpeg/gif/webp) and drops others such as svg", () => {
    const attachments = [
      { id: "a", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
      { id: "b", name: "b.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,BBBB" },
      { id: "c", name: "c.webp", mimeType: "image/webp", dataUrl: "data:image/webp;base64,CCCC" },
      { id: "d", name: "d.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,DDDD" },
    ];

    const urls = toCodexImageInputUrls(attachments, 4);

    expect(urls).toEqual([
      "data:image/png;base64,AAAA",
      "data:image/webp;base64,CCCC",
    ]);
  });

  it("caps the number of images at the given max", () => {
    const attachments = Array.from({ length: 6 }, (_, i) => ({
      id: `img${i}`,
      name: `img${i}.png`,
      mimeType: "image/png",
      dataUrl: `data:image/png;base64,IMG${i}`,
    }));

    expect(toCodexImageInputUrls(attachments, 4)).toHaveLength(4);
  });

  it("returns an empty array for non-array input", () => {
    expect(toCodexImageInputUrls(undefined, 4)).toEqual([]);
  });
});

describe("buildMcpEditRunResult", () => {
  it("returns status draft with the summary when toolCount > 0", () => {
    const document = { docId: "doc_1" } as unknown as Parameters<typeof buildMcpEditRunResult>[0]["nextDocument"];
    const result = buildMcpEditRunResult({
      summary: "編集しました",
      toolCount: 1,
      fallbackAnswerSummary: "応答しました",
      fallbackDraftSummary: "編集案を作成しました",
      nextDocument: document,
      agentThreadId: "thread_1",
      runtime: "claude-mcp",
    });

    expect(result.status).toBe("draft");
    expect(result.draft.summary).toBe("編集しました");
    expect(result.draft.operations).toEqual([]);
    expect(result.nextDocument).toBe(document);
    expect(result.runtime).toBe("claude-mcp");
  });

  it("returns status answer with the fallback answer summary when toolCount is 0 and no summary text", () => {
    const document = { docId: "doc_1" } as unknown as Parameters<typeof buildMcpEditRunResult>[0]["nextDocument"];
    const result = buildMcpEditRunResult({
      summary: "",
      toolCount: 0,
      fallbackAnswerSummary: "応答しました",
      fallbackDraftSummary: "編集案を作成しました",
      nextDocument: document,
      agentThreadId: undefined,
      runtime: "codex-mcp",
    });

    expect(result.status).toBe("answer");
    expect(result.draft.summary).toBe("応答しました");
  });

  it("accepts runtime: antigravity-mcp", () => {
    const document = { docId: "doc_1" } as unknown as Parameters<typeof buildMcpEditRunResult>[0]["nextDocument"];
    const result = buildMcpEditRunResult({
      summary: "編集しました",
      toolCount: 1,
      fallbackAnswerSummary: "応答しました",
      fallbackDraftSummary: "編集案を作成しました",
      nextDocument: document,
      agentThreadId: "gsess_1",
      runtime: "antigravity-mcp",
    });

    expect(result.runtime).toBe("antigravity-mcp");
  });
});

describe("buildCancelledMcpEditRunResult", () => {
  it("returns status cancelled without throwing, preserving the document/thread the run had reached", () => {
    const document = { docId: "doc_1" } as unknown as Parameters<typeof buildCancelledMcpEditRunResult>[0]["nextDocument"];
    const result = buildCancelledMcpEditRunResult({
      nextDocument: document,
      agentThreadId: "thread_1",
      runtime: "codex-mcp",
    });

    expect(result.status).toBe("cancelled");
    expect(result.nextDocument).toBe(document);
    expect(result.agentThreadId).toBe("thread_1");
    expect(result.runtime).toBe("codex-mcp");
    expect(result.draft.operations).toEqual([]);
    expect(result.draft.summary.length).toBeGreaterThan(0);
  });
});
