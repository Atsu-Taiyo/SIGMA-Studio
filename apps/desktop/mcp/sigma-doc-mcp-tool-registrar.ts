import { randomUUID } from "node:crypto";
import { withSharedReadScope } from "../electron/collaboration/proposal-context";

import type { McpServer, RegisteredTool, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { isLegacyBodyToolName, type LegacyBodyToolName, type McpToolProfile } from "@/lib/ai/mcp-tool-profile";
import type { BodyToolImplementation } from "./sigma-doc-mcp-app-tools";
import { ToolOutputEnvelopeSchema } from "./sigma-doc-mcp-response";
import { recordDocumentRead } from "./sigma-doc-mcp-source-ledger";
import { runWithMcpToolStats } from "./sigma-doc-mcp-stats";
import type { ToolActivityLogger } from "./tool-activity";

const READ_ONLY_TOOL_NAMES = new Set([
  "get_local_app_status", "list_edit_proposals", "get_edit_proposal", "list_all_pending_proposals", "list_local_documents",
  "read_local_document", "get_edit_context", "get_document_outline", "get_block", "get_blocks", "search_document",
  "search_library", "validate_local_document", "list_materials", "get_material", "render_block_context", "render_page",
  "get_selected_block", "get_insertion_candidates", "get_neighbor_blocks", "get_active_reference",
  "get_attached_media", "get_mentioned_sigma_docs", "list_generated_images", "get_image_reference",
]);
const DESTRUCTIVE_TOOL_NAMES = new Set([
  "delete_ai_resource", "delete_blocks", "delete_shapes", "visual_remove_shape", "discard_visual_edit_session",
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
  toolProfile: McpToolProfile;
  profileGuidance: (description: string) => string;
  activityLogger: ToolActivityLogger;
  activeRunId?: () => string | undefined;
  visualSessionRunId: (sessionId: string) => string | undefined;
}

/**
 * Publishes the selected tool profile and instruments calls at the transport boundary.
 * App body aliases reuse the original validated handlers; the registrar never creates
 * another editing or proposal path and never replaces methods on the SDK server.
 */
export function createMcpToolRegistrar(server: McpServer, options: McpToolRegistrarOptions) {
  const { toolProfile, profileGuidance, activityLogger, visualSessionRunId } = options;
  const bodyImplementations = new Map<LegacyBodyToolName, BodyToolImplementation>();

  function registerTool<InputSchema extends z.ZodRawShape | z.ZodType | undefined = undefined>(
    name: string,
    config: ToolRegistrationConfig<InputSchema>,
    handler: ToolCallback<InputSchema>,
  ): RegisteredTool | undefined {
    // The public entry retains schema-based callback inference. Only forwarding needs
    // argument erasure because the SDK callback also includes its request context.
    const invoke = handler as (...handlerArgs: unknown[]) => CallToolResult | Promise<CallToolResult>;
    if (toolProfile === "app" && isLegacyBodyToolName(name)) {
      if (!isRecord(config.inputSchema)
        || !Object.values(config.inputSchema).every((schema) => schema instanceof z.ZodType)) {
        throw new Error(`Expected a raw input shape for ${name}`);
      }
      bodyImplementations.set(name, { inputSchema: config.inputSchema as z.ZodRawShape, handler: invoke });
      return;
    }

    const wrappedHandler = async (...handlerArgs: unknown[]): Promise<CallToolResult> => {
      const callId = randomUUID();
      const firstArg = handlerArgs[0];
      const toolArgs = isRecord(firstArg) ? firstArg : null;
      const explicitRunId = typeof toolArgs?.runId === "string" ? toolArgs.runId.trim() || undefined : undefined;
      const sessionId = typeof toolArgs?.sessionId === "string" ? toolArgs.sessionId : undefined;
      const runId = explicitRunId ?? (sessionId ? visualSessionRunId(sessionId) : undefined) ?? options.activeRunId?.();
      // Read provenance is collected here for every profile. Only its intersection
      // with library-search hits is later exposed as a proposal source reference.
      if (READ_ONLY_TOOL_NAMES.has(name) && typeof toolArgs?.fileId === "string") {
        recordDocumentRead(runId, toolArgs.fileId);
      }
      activityLogger({ callId, tool: name, runId, status: "started" });
      return runWithMcpToolStats(name, runId, async () => {
        try {
          const result = await withSharedReadScope(runId, READ_ONLY_TOOL_NAMES.has(name), async () => invoke(...handlerArgs));
          activityLogger({ callId, tool: name, runId, status: "completed" });
          return result;
        } catch (error) {
          activityLogger({ callId, tool: name, runId, status: "failed" });
          throw error;
        }
      });
    };

    return server.registerTool(name, {
      ...config,
      ...(typeof config.description === "string" ? { description: profileGuidance(config.description) } : {}),
      outputSchema: ToolOutputEnvelopeSchema,
      annotations: {
        ...annotationsForTool(name),
        ...(isRecord(config.annotations) ? config.annotations : {}),
      },
    }, wrappedHandler as ToolCallback<InputSchema>);
  }

  return { registerTool, bodyImplementations };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
