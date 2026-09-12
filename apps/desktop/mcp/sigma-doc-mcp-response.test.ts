import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { SigmaValidationError } from "@/features/document";
import {
  ToolOutputEnvelopeSchema,
  formatZodErrorForTool,
  jsonResultWithContent,
  toolErrorResult,
  withToolErrorHandling,
} from "./sigma-doc-mcp-response";

function envelope(result: CallToolResult) {
  const payload = ToolOutputEnvelopeSchema.parse(result.structuredContent);
  expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify(payload) });
  return payload;
}

describe("MCP response envelope", () => {
  it("preserves payload data, follow-up guidance, and media order for both client formats", async () => {
    const media: CallToolResult["content"] = [
      { type: "image", mimeType: "image/png", data: "aW1hZ2U=" },
      { type: "resource_link", uri: "file:///preview.png", name: "preview" },
    ];
    const result = await withToolErrorHandling(async () => jsonResultWithContent({
      ok: true, message: "Ready", count: 2, proposal: { proposalId: "p1" }, instructionForAgent: "Review the preview",
    }, media));
    expect(envelope(result)).toEqual({
      ok: true, message: "Ready", data: { count: 2, proposal: { proposalId: "p1" } }, nextAction: "Review the preview",
    });
    expect(result.content.slice(1)).toEqual(media);
    expect(result.isError).toBeUndefined();
  });

  it("reports a completed quality check separately from a failed tool execution", async () => {
    const result = await withToolErrorHandling(async () => ({
      ok: false, needsRevision: true, inspection: { issues: ["overlap"] },
    }));
    expect(envelope(result)).toEqual({
      ok: true,
      message: "品質確認を実行しました。",
      data: { passed: false, needsRevision: true, inspection: { issues: ["overlap"] } },
      nextAction: "issues/nextActionsに従って修正し、再度確認してください。",
    });
    expect(result.isError).toBeUndefined();
  });

  it("retains failure details and lets an explicit error override quality-check fields", async () => {
    const payload = { ok: false, error: "対象が見つかりません", needsRevision: true, fileId: "file" };
    const result = await withToolErrorHandling(async () => payload);
    expect(envelope(result)).toMatchObject({
      ok: false, error: { code: "NOT_FOUND", message: payload.error, retryable: true, details: payload },
    });
    expect(result.isError).toBe(true);
  });

  it("uses the nested tool diagnostic when no top-level error string exists", async () => {
    const result = await withToolErrorHandling(async () => ({
      ok: false, message: "generic", toolResult: { message: "targetIdを指定してください" },
    }));
    expect(envelope(result).error).toMatchObject({ code: "TARGET_REQUIRED", message: "targetIdを指定してください" });
  });

  it("enforces mutually exclusive success and failure envelopes", () => {
    expect(ToolOutputEnvelopeSchema.safeParse({ ok: true, message: "done" }).success).toBe(false);
    expect(ToolOutputEnvelopeSchema.safeParse({ ok: false, data: {} }).success).toBe(false);
    expect(ToolOutputEnvelopeSchema.safeParse({ ok: true, message: "done", data: {}, error: {} }).success).toBe(false);
  });
});

describe("MCP error classification", () => {
  it.each([
    ["revisionが一致しません", "REVISION_MISMATCH", true],
    ["編集対象が指定されていません", "TARGET_REQUIRED", true],
    ["対象が見つかりません", "NOT_FOUND", true],
    ["previewを生成できません", "PREVIEW_UNAVAILABLE", false],
    ["SigmaDoc形式が不正です", "DOCUMENT_INVALID", true],
    ["Permission denied", "PERMISSION_DENIED", false],
    ["入力値が不正です", "INVALID_INPUT", true],
    ["セッションが完了していません", "INVALID_SESSION_STATE", true],
    ["unexpected failure", "TOOL_FAILED", false],
  ])("classifies %s", (message, code, retryable) => {
    const result = toolErrorResult(new Error(message));
    expect(envelope(result).error).toMatchObject({ code, message, retryable, nextAction: expect.any(String) });
    expect(result.isError).toBe(true);
  });

  it.each([
    ["ページ設定の変更では古いrevisionを自動調整できないため", "現在のpageLayoutを読み直し"],
    ["対象ブロックが編集されているため", "error.details.conflictBlocks"],
  ])("retains specific recovery advice for %s", (reason, guidance) => {
    const result = toolErrorResult(new Error(`revisionが一致しません。${reason} (現在: 42)`));
    const action = envelope(result).error?.nextAction;
    expect(action).toContain(guidance);
    expect(action).toContain("expectedRevision: 42");
  });

  it("translates domain validation codes and does not expose developer-only messages", () => {
    const result = toolErrorResult(new SigmaValidationError("unsafeFontFamily", "developer-only detail"));
    const payload = envelope(result);
    expect(payload.error?.message).not.toContain("developer-only detail");
    expect(payload.error?.message).toBe("このフォント指定は使用できません。");
  });

  it("formats bounded, field-addressable Zod errors and handles non-Error throws", async () => {
    const error = new z.ZodError(Array.from({ length: 12 }, (_, index) => ({
      code: "custom", path: ["items", index, "value"], message: "bad value",
    })));
    const result = await withToolErrorHandling(async () => { throw error; });
    expect(envelope(result).error?.code).toBe("INVALID_INPUT");
    expect(formatZodErrorForTool(error).split(" / ")).toHaveLength(10);
    expect(formatZodErrorForTool(error)).toContain("items.9.value: bad value");
    expect(formatZodErrorForTool(error)).not.toContain("items.10.value");
    expect(formatZodErrorForTool(new z.ZodError([]))).toBe("入力値が不正です。");
    const unknown = await withToolErrorHandling(async () => { throw null; });
    expect(envelope(unknown).error?.message).toBe("MCPツールの実行に失敗しました。");
  });
});
