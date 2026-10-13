import { randomUUID } from "node:crypto";
import { withSharedReadScope } from "../electron/collaboration/proposal-context";

import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import type { BodyImplementationName, BodyToolImplementation } from "./sigma-doc-mcp-app-tools";
import { ToolOutputEnvelopeSchema } from "./sigma-doc-mcp-response";
import { recordDocumentRead } from "./sigma-doc-mcp-source-ledger";
import { runWithMcpToolStats } from "./sigma-doc-mcp-stats";
import type { ToolActivityLogger } from "./tool-activity";

const READ_ONLY_TOOL_NAMES = new Set([
  "get_problem_solution",
  "search_problems",
  "get_local_app_status", "list_edit_proposals", "get_edit_proposal", "list_local_documents",
  "read_local_document", "get_edit_context", "get_document_outline", "get_block", "get_blocks", "search_document",
  "search_library", "validate_local_document", "list_materials", "get_material", "render_block_context", "render_page",
  "get_selected_block", "get_insertion_candidates", "get_neighbor_blocks", "get_active_reference",
  "get_attached_media", "get_mentioned_sigma_docs", "list_generated_images", "get_image_reference",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set([
  "delete_ai_resource", "delete_shapes", "visual_remove_shape", "discard_visual_edit_session",
  "delete_local_document", "delete_local_folder",
]);
const IDEMPOTENT_TOOL_NAMES = new Set([
  ...READ_ONLY_TOOL_NAMES,
  "update_ai_settings",
]);

function annotationsForTool(name: string): ToolAnnotations {
  return {
    readOnlyHint: READ_ONLY_TOOL_NAMES.has(name),
    destructiveHint: DESTRUCTIVE_TOOL_NAMES.has(name),
    idempotentHint: IDEMPOTENT_TOOL_NAMES.has(name),
    openWorldHint: false,
  };
}

interface ToolRegistrationConfig<InputSchema> {
  title?: string;
  description?: string;
  inputSchema?: InputSchema;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
}

export interface McpToolRegistrarOptions {
  activityLogger: ToolActivityLogger;
  activeRunId?: () => string | undefined;
  visualSessionRunId: (sessionId: string) => string | undefined;
}

/**
 * Publishes tools and instruments calls at the transport boundary. Body-edit
 * implementations are only retained for the public body tools to dispatch to; the
 * registrar never creates another editing or proposal path and never replaces
 * methods on the SDK server.
 */
export function createMcpToolRegistrar(server: McpServer, options: McpToolRegistrarOptions) {
  const { activityLogger, visualSessionRunId } = options;
  const bodyImplementations = new Map<BodyImplementationName, BodyToolImplementation>();

  /**
   * Retains a validated body-edit handler without publishing it. The public body tools
   * (insert_content / edit_text / edit_problem / organize_blocks) call it after their own
   * registration has attributed and instrumented the call.
   */
  function registerBodyImplementation<InputSchema extends z.ZodRawShape>(
    name: BodyImplementationName,
    inputSchema: InputSchema,
    handler: ToolCallback<InputSchema>,
  ): void {
    if (!Object.values(inputSchema).every((schema) => schema instanceof z.ZodType)) {
      throw new Error(`Expected a raw input shape for ${name}`);
    }
    bodyImplementations.set(name, {
      inputSchema,
      // Forwarding erases the SDK callback's request-context argument type.
      handler: handler as (...handlerArgs: unknown[]) => CallToolResult | Promise<CallToolResult>,
    });
  }

  function registerTool<InputSchema extends z.ZodRawShape | z.ZodType | undefined = undefined>(
    name: string,
    config: ToolRegistrationConfig<InputSchema>,
    handler: ToolCallback<InputSchema>,
  ): RegisteredTool {
    // The public entry retains schema-based callback inference. Only forwarding needs
    // argument erasure because the SDK callback also includes its request context.
    const invoke = handler as (...handlerArgs: unknown[]) => CallToolResult | Promise<CallToolResult>;

    const wrappedHandler = async (...handlerArgs: unknown[]): Promise<CallToolResult> => {
      const callId = randomUUID();
      const firstArg = handlerArgs[0];
      const toolArgs = isRecord(firstArg) ? firstArg : null;
      const explicitRunId = typeof toolArgs?.runId === "string" ? toolArgs.runId.trim() || undefined : undefined;
      const sessionId = typeof toolArgs?.sessionId === "string" ? toolArgs.sessionId : undefined;
      const runId = explicitRunId ?? (sessionId ? visualSessionRunId(sessionId) : undefined) ?? options.activeRunId?.();
      // Read provenance is collected here. Only its intersection with library-search
      // hits is later exposed as a proposal source reference.
      if (READ_ONLY_TOOL_NAMES.has(name) && typeof toolArgs?.fileId === "string") {
        recordDocumentRead(runId, toolArgs.fileId);
      }
      activityLogger({ callId, tool: name, runId, status: "started" });
      const result = await runWithMcpToolStats(name, runId, async () => {
        try {
          const result = await withSharedReadScope(runId, READ_ONLY_TOOL_NAMES.has(name), async () => invoke(...handlerArgs));
          activityLogger({ callId, tool: name, runId, status: "completed" });
          return result;
        } catch (error) {
          activityLogger({ callId, tool: name, runId, status: "failed" });
          throw error;
        }
      });
      assertToolOutputEnvelope(name, result);
      return result;
    };

    return server.registerTool(name, {
      ...config,
      annotations: {
        ...annotationsForTool(name),
        ...(isRecord(config.annotations) ? config.annotations : {}),
      },
    }, wrappedHandler as ToolCallback<InputSchema>);
  }

  return { registerTool, registerBodyImplementation, bodyImplementations };
}

/**
 * tools/list には outputSchema を載せない。宣言すると全ツールに同じ定義が複製され、
 * クライアントは structuredContent を必須として検証する。応答の共通形式はここで確かめる:
 * SDK が outputSchema の宣言時に行っていた検査と同じく、エラー以外の応答で形が崩れていれば
 * ツールエラーとして返る。
 */
function assertToolOutputEnvelope(name: string, result: CallToolResult): void {
  if (result.isError) return;
  if (!result.structuredContent) {
    throw new Error(`Output validation error: Tool ${name} returned no structured content`);
  }
  const parsed = ToolOutputEnvelopeSchema.safeParse(result.structuredContent);
  if (!parsed.success) {
    throw new Error(`Output validation error: Invalid structured content for tool ${name}: ${parsed.error.message}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
