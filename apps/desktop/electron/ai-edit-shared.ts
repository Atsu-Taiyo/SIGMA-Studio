import { parseAttachedImageDataUrl, type ParsedAttachedImage } from "./ai-edit-image";
import { SIGMA_DOC_MCP_SERVER_NAME } from "./sigma-studio-mcp-launch";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const te = createCurrentLocaleTranslator("error");

// MCP tools exposed by sigma-studio-local that can create/mutate a pending
// proposal (as opposed to read-only lookups, or visual-edit-session scratch
// steps that only mutate an in-memory session until propose_visual_edit_session
// is called). toolCount should only reflect these so that status is "draft"
// exactly when a proposal may exist for the user to review, and "answer" for
// pure Q&A runs that merely read the document or probed the visual session.
const WRITE_CAPABLE_MCP_TOOL_NAMES = new Set([
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
  "insert_generated_image",
  "update_generated_image",
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
]);

// Claude reports MCP tool_use names with the `mcp__<server>__` prefix it uses
// for tool routing (see DEFAULT_ALLOWED_TOOLS in claude-stream-client.ts).
// Codex reports the plain MCP tool name. Normalize both to the plain name
// before matching so the two providers share one classification.
const MCP_TOOL_NAME_PREFIX_PATTERN = /^mcp__[^_]+(?:-[^_]+)*__/;

// Gemini registers MCP tools as `mcp_<serverName>_<toolName>` with single
// underscores (see Part A5 of the WI-4 plan). Tool names themselves contain
// underscores (insert_body_content), so this must be an exact-prefix strip,
// not a generic single-underscore regex. Derived from the shared MCP server
// name constant (Finding 6) instead of a second hardcoded literal.
const GEMINI_MCP_TOOL_NAME_PREFIX = `mcp_${SIGMA_DOC_MCP_SERVER_NAME}_`;

export function isWriteCapableMcpToolName(name: string | undefined | null): boolean {
  if (typeof name !== "string" || name.length === 0) {
    return false;
  }
  const normalized = name.startsWith(GEMINI_MCP_TOOL_NAME_PREFIX)
    ? name.slice(GEMINI_MCP_TOOL_NAME_PREFIX.length)
    : name.replace(MCP_TOOL_NAME_PREFIX_PATTERN, "");
  return WRITE_CAPABLE_MCP_TOOL_NAMES.has(normalized);
}

export function toCodexImageInputUrls(attachments: AiEditAttachment[] | undefined, maxImages: number): string[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .map((attachment) => parseAttachedImageDataUrl(attachment?.dataUrl ?? ""))
    .filter((image): image is ParsedAttachedImage => image !== null)
    .slice(0, maxImages)
    .map((image) => `data:${image.mimeType};base64,${image.base64}`);
}

export function buildMcpEditRunResult(args: {
  summary: string;
  toolCount: number;
  fallbackAnswerSummary: string;
  fallbackDraftSummary: string;
  nextDocument: AiEditRunResult["nextDocument"];
  agentThreadId: string | undefined;
  runtime: NonNullable<AiEditRunResult["runtime"]>;
}): AiEditRunResult {
  const status = args.toolCount > 0 ? "draft" : "answer";
  return {
    draft: {
      summary: args.summary || (args.toolCount > 0 ? args.fallbackDraftSummary : args.fallbackAnswerSummary),
      plan: [],
      operations: [],
      warnings: [],
    },
    nextDocument: args.nextDocument,
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
    status,
    agentThreadId: args.agentThreadId,
    runtime: args.runtime,
  };
}

/**
 * Result shape for a run the user cancelled mid-flight (ai-edit:cancel). Used
 * by all three providers (claude-edit / gemini-edit / ai-edit) so a
 * cancellation always resolves ai-edit:run cleanly with `status: "cancelled"`
 * instead of rejecting/throwing a raw error the renderer would show as a
 * failure.
 */
export function buildCancelledMcpEditRunResult(args: {
  nextDocument: AiEditRunResult["nextDocument"];
  agentThreadId: string | undefined;
  runtime: NonNullable<AiEditRunResult["runtime"]>;
}): AiEditRunResult {
  return {
    draft: {
      summary: te("electron.aiEdit.cancelledByUser"),
      plan: [],
      operations: [],
      warnings: [],
    },
    nextDocument: args.nextDocument,
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
    status: "cancelled",
    agentThreadId: args.agentThreadId,
    runtime: args.runtime,
  };
}
