import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isSigmaValidationError } from "@/features/document";
import { formatValidationError } from "@/lib/validation-text";

export const ToolOutputEnvelopeSchema = z.object({
  ok: z.boolean().describe("ツール処理が成功した場合true。品質検査の不合格は実行成功なのでtrueです。"),
  message: z.string().optional().describe("成功結果の短い説明。"),
  data: z.record(z.string(), z.unknown()).optional().describe("成功時の型付き結果本体。"),
  nextAction: z.string().optional().describe("AIが次に行うべき確認・修正。"),
  error: z.object({
    code: z.enum([
      "INVALID_INPUT",
      "REVISION_MISMATCH",
      "TARGET_REQUIRED",
      "NOT_FOUND",
      "INVALID_SESSION_STATE",
      "PREVIEW_UNAVAILABLE",
      "DOCUMENT_INVALID",
      "PERMISSION_DENIED",
      "TOOL_FAILED",
    ]),
    message: z.string(),
    retryable: z.boolean(),
    nextAction: z.string(),
    details: z.unknown().optional(),
  }).strict().optional().describe("失敗時の分類済みエラー。"),
}).strict().superRefine((value, context) => {
  if (value.ok && (!value.message || value.data === undefined || value.error !== undefined)) {
    context.addIssue({ code: "custom", message: "成功応答にはmessage/dataが必要で、errorは指定できません。" });
  }
  if (!value.ok && (value.error === undefined || value.data !== undefined)) {
    context.addIssue({ code: "custom", message: "失敗応答にはerrorが必要で、dataは指定できません。" });
  }
});

export type JsonObject = Record<string, unknown>;

export interface JsonResultWithContent {
  payload: JsonObject;
  extraContent: CallToolResult["content"];
}

function jsonResult(payload: JsonObject, extraContent: CallToolResult["content"] = [], isError = false): CallToolResult {
  return {
    content: [
      {
        type: "text",
        // Not pretty-printed on purpose: this text duplicates structuredContent for clients that
        // don't read structuredContent, and indenting it materially inflates token usage across
        // every tool call for no readability benefit an agent actually uses.
        text: JSON.stringify(payload),
      },
      ...extraContent,
    ],
    structuredContent: payload,
    ...(isError ? { isError: true } : {}),
  };
}

export function jsonResultWithContent(payload: JsonObject, extraContent: CallToolResult["content"]): JsonResultWithContent {
  return { payload, extraContent };
}

type ToolErrorCode = NonNullable<z.infer<typeof ToolOutputEnvelopeSchema>["error"]>["code"];

function classifyToolError(message: string): { code: ToolErrorCode; retryable: boolean; nextAction: string } {
  if (message.includes("revisionが一致しません") || message.includes("対象教材のrevisionが変わって")) {
    if (message.includes("ページ設定の変更では古いrevisionを自動調整できないため")) {
      const currentRevisionMatch = message.match(/現在:\s*(\d+)/);
      const currentRevision = currentRevisionMatch?.[1] ?? "最新のrevision";
      return {
        code: "REVISION_MISMATCH",
        retryable: true,
        nextAction: `read_local_document(detail:"summary")またはget_document_outlineで現在のpageLayoutを読み直し、expectedRevision: ${currentRevision} で再試行してください。`,
      };
    }
    // ブロック粒度の緩和判定 (reconcileStaleExpectedRevision) が「対象ブロック自体が
    // 変更されていた」と判定した場合の専用メッセージ。無関係な編集で単純にrevisionだけ
    // 進んだ場合 (下のフォールバック) とnextActionを変える: 単純な再読込ではなく、
    // 競合ブロックの現在の内容 (error.details.conflictBlocks) を踏まえて編集を作り直す必要がある。
    if (message.includes("対象ブロックが編集されているため")) {
      const currentRevisionMatch = message.match(/現在:\s*(\d+)/);
      const currentRevision = currentRevisionMatch?.[1] ?? "最新のrevision";
      return {
        code: "REVISION_MISMATCH",
        retryable: true,
        nextAction: `error.details.conflictBlocksで対象ブロックの現在の内容を確認し、その内容を踏まえて編集を作り直した上で、expectedRevision: ${currentRevision} で再試行してください。`,
      };
    }
    return { code: "REVISION_MISMATCH", retryable: true, nextAction: "read_local_document(detail:\"summary\")で最新revisionを取得し、内容を確認して再試行してください。" };
  }
  if (message.includes("編集対象が指定されていません") || message.includes("targetIdを指定")) {
    return { code: "TARGET_REQUIRED", retryable: true, nextAction: "get_document_outlineまたはget_insertion_candidatesでtargetIdを確認して再試行してください。" };
  }
  if (message.includes("見つかりません") || message.includes("見つかりませんでした")) {
    return { code: "NOT_FOUND", retryable: true, nextAction: "対象IDを読み取りツールで確認し直してください。" };
  }
  if (message.includes("preview") && (message.includes("生成でき") || message.includes("利用でき"))) {
    return { code: "PREVIEW_UNAVAILABLE", retryable: false, nextAction: "render bridgeの状態を確認し、利用できない場合はその事実をユーザーへ報告してください。" };
  }
  if (message.includes("検証") || message.includes("SigmaDoc形式")) {
    return { code: "DOCUMENT_INVALID", retryable: true, nextAction: "error.detailsのvalidation issueを修正して再試行してください。" };
  }
  if (message.includes("権限") || message.toLowerCase().includes("permission denied") || message.includes("許可されていません")) {
    return { code: "PERMISSION_DENIED", retryable: false, nextAction: "権限設定を確認し、必要な許可をユーザーへ依頼してください。" };
  }
  if (message.includes("入力値が不正") || message.includes("必須") || message.includes("必要です") || message.includes("指定してください")) {
    return { code: "INVALID_INPUT", retryable: true, nextAction: "toolのinputSchemaとエラーで示されたfieldを修正して再試行してください。" };
  }
  if (message.includes("実行されていません") || message.includes("合格していない") || message.includes("セッション")) {
    return { code: "INVALID_SESSION_STATE", retryable: true, nextAction: "メッセージで示されたvisual edit手順を実行してから再試行してください。" };
  }
  return { code: "TOOL_FAILED", retryable: false, nextAction: "同じ呼び出しを無限に繰り返さず、メッセージと実行状況をユーザーへ報告してください。" };
}

function errorResult(message: string, details?: unknown): CallToolResult {
  const classification = classifyToolError(message);
  return jsonResult({
    ok: false,
    error: {
      code: classification.code,
      message,
      retryable: classification.retryable,
      nextAction: classification.nextAction,
      ...(details === undefined ? {} : { details }),
    },
  }, [], true);
}

function normalizeToolPayload(payload: JsonObject): { payload: JsonObject; isError: boolean } {
  if (payload.ok === false) {
    const isQualityResult = payload.needsRevision !== undefined || payload.inspection !== undefined || payload.review !== undefined;
    if (isQualityResult && payload.error === undefined) {
      const message = payload.message;
      const data = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "ok" && key !== "message"));
      return {
        payload: {
          ok: true,
          message: typeof message === "string" ? message : "品質確認を実行しました。",
          data: { passed: false, ...data },
          nextAction: "issues/nextActionsに従って修正し、再度確認してください。",
        },
        isError: false,
      };
    }
    const message = typeof payload.error === "string"
      ? payload.error
      : isRecord(payload.toolResult) && typeof payload.toolResult.message === "string"
        ? payload.toolResult.message
        : typeof payload.message === "string" ? payload.message : "MCPツールの実行に失敗しました。";
    const classification = classifyToolError(message);
    return {
      payload: {
        ok: false,
        error: {
          code: classification.code,
          message,
          retryable: classification.retryable,
          nextAction: classification.nextAction,
          details: payload,
        },
      },
      isError: true,
    };
  }

  const message = payload.message;
  const instructionForAgent = payload.instructionForAgent;
  const data = Object.fromEntries(Object.entries(payload).filter(([key]) => (
    key !== "ok" && key !== "message" && key !== "instructionForAgent"
  )));
  return {
    payload: {
      ok: true,
      message: typeof message === "string" ? message : "MCPツールを実行しました。",
      data,
      ...(typeof instructionForAgent === "string" ? { nextAction: instructionForAgent } : {}),
    },
    isError: false,
  };
}

// Exported for a focused unit test: every tool's own input schema is validated by the MCP SDK
// before our handler runs (producing the SDK's own tool-input error), and every draft/mutation
// tool call already funnels internal ZodErrors through sigma-doc-agent-tools.ts's own
// formatToolError (also fixed to list all issues, not just the first) before returning a normal
// ok:false result — so this branch is a defensive fallback for any other ZodError thrown directly
// out of a tool handler (e.g. loadDocumentForFile hitting a corrupted on-disk document) rather
// than something easily exercised end-to-end through the current tool surface.
/** `field.path: reason` for up to 10 issues, joined with " / " so a bad-input error is actionable
 * without dumping the full raw ZodError. */
export function formatZodErrorForTool(error: z.ZodError): string {
  if (error.issues.length === 0) {
    return "入力値が不正です。";
  }
  const issueLines = error.issues
    .slice(0, 10)
    .map((issue) => `${issue.path.length > 0 ? issue.path.join(".") : "(root)"}: ${issue.message}`)
    .join(" / ");
  return `入力値が不正です: ${issueLines}`;
}

export async function withToolErrorHandling(callback: () => Promise<JsonObject | JsonResultWithContent>): Promise<CallToolResult> {
  try {
    const result = await callback();
    if (isJsonResultWithContent(result)) {
      const normalized = normalizeToolPayload(result.payload);
      return jsonResult(normalized.payload, result.extraContent, normalized.isError);
    }
    const normalized = normalizeToolPayload(result);
    return jsonResult(normalized.payload, [], normalized.isError);
  } catch (error) {
    return toolErrorResult(error);
  }
}

export function toolErrorResult(error: unknown): CallToolResult {
  if (error instanceof z.ZodError) return errorResult(formatZodErrorForTool(error));
  // `features/document` はコードだけを投げる (最下層は文言を持たない)。ここで
  // 解決しないと、開発者向けの英語 message がそのまま AI へ返る。
  // **3 プロバイダの AI 編集はこの MCP 経路を通る**ので、ここが本番の出口。
  // `commitSigmaDocMutation` の catch では拾えない (引数の評価中に投げるものがある)。
  if (isSigmaValidationError(error)) {
    return errorResult(formatValidationError(error));
  }
  return errorResult(error instanceof Error ? error.message : "MCPツールの実行に失敗しました。");
}

export function isJsonResultWithContent(value: JsonObject | JsonResultWithContent): value is JsonResultWithContent {
  return isRecord(value) && isRecord(value.payload) && Array.isArray(value.extraContent);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
