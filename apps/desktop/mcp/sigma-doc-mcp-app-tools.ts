import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { APP_BODY_TOOL_ROUTES, type LegacyBodyToolName } from "@/lib/ai/mcp-tool-profile";
import { parseMarkdownToTextFlowBlocks } from "@/lib/markdown-to-text-flow";

export interface BodyToolImplementation {
  inputSchema: z.ZodRawShape;
  handler: (...args: unknown[]) => unknown;
}

export interface AppBodyToolDefinition {
  name: string;
  config: {
    title: string;
    description: string;
    inputSchema: z.ZodObject<z.ZodRawShape>;
    annotations?: ToolAnnotations;
  };
  handler: (args: Record<string, unknown>, ...extra: unknown[]) => Promise<CallToolResult>;
}

const COMMON_FIELDS = new Set(["fileId", "expectedRevision", "runId", "writeMode", "sourceReferences"]);
const PROPOSAL_GUIDANCE = "First call get_edit_context with fileId/runId and read the current target. Pass expectedRevision and your runId. This creates or updates your pending proposal; it does not apply it. Check data.verification and data.proposal before reporting completion.";

/**
 * App-only transport adapter, inspired by WebMCP's public/implementation split.
 * The existing handlers remain responsible for validation, selection, attribution,
 * concurrency, proposal accumulation and previews. There is no second write path.
 */
export function createAppBodyTools(
  implementations: ReadonlyMap<LegacyBodyToolName, BodyToolImplementation>,
): AppBodyToolDefinition[] {
  const implementation = (name: LegacyBodyToolName): BodyToolImplementation => {
    const tool = implementations.get(name);
    if (!tool) throw new Error(`Missing app body tool implementation: ${name}`);
    return tool;
  };
  const common = Object.fromEntries(Object.entries(implementation("apply_edits").inputSchema)
    .filter(([key]) => COMMON_FIELDS.has(key)));
  const fields = (name: LegacyBodyToolName) => Object.fromEntries(
    Object.entries(implementation(name).inputSchema).filter(([key]) => !COMMON_FIELDS.has(key)),
  );
  const dispatch = async (name: LegacyBodyToolName, args: Record<string, unknown>, extra: unknown[]): Promise<CallToolResult> => {
    const tool = implementation(name);
    // Validate using the original contract before calling its handler. Schema changes
    // therefore reach both profiles and malformed input never reaches the write path.
    const parsed = await z.object(tool.inputSchema).strict().parseAsync(args);
    return await tool.handler(parsed, ...extra) as CallToolResult;
  };
  const editTool = (
    name: string,
    title: string,
    description: string,
    routes: [LegacyBodyToolName, LegacyBodyToolName, ...LegacyBodyToolName[]],
    annotations?: ToolAnnotations,
  ): AppBodyToolDefinition => {
    const choices = routes.map((legacyName) => {
      const route = APP_BODY_TOOL_ROUTES[legacyName];
      if (!("action" in route)) throw new Error(`Missing edit action: ${legacyName}`);
      return z.object({ action: z.literal(route.action), ...fields(legacyName) }).strict();
    });
    // Nest the discriminated union: MCP tools/list requires an object at the root.
    const edit = z.discriminatedUnion("action", [choices[0]!, choices[1]!, ...choices.slice(2)]);
    return {
      name,
      config: {
        title,
        description: `${description} ${PROPOSAL_GUIDANCE}`,
        inputSchema: z.object({
          ...Object.fromEntries(Object.entries(common).filter(([key]) =>
            routes.some((legacyName) => Object.hasOwn(implementation(legacyName).inputSchema, key)))),
          edit,
        }).strict(),
        annotations,
      },
      handler: async ({ edit: input, ...context }, ...extra) => {
        const { action, ...payload } = edit.parse(input);
        const legacyName = routes.find((candidate) => {
          const route = APP_BODY_TOOL_ROUTES[candidate];
          return "action" in route && route.action === action;
        });
        if (!legacyName) throw new Error(`Unknown body edit action: ${String(action)}`);
        return dispatch(legacyName, { ...context, ...payload }, extra);
      },
    };
  };

  const { blocks, ...insertionFields } = fields("insert_body_content");
  if (!blocks) throw new Error("Missing insertion blocks schema");
  const content = z.discriminatedUnion("format", [
    z.object({ format: z.literal("markdown"), markdown: z.string().regex(/\S/u, "Markdown must contain visible text.") }).strict(),
    z.object({ format: z.literal("blocks"), blocks }).strict(),
  ]);

  return [
    {
      name: "insert_content",
      config: {
        title: "本文を挿入",
        description: "Insert new flowing body content after targetId (or END_OF_DOCUMENT); selectedId is a fallback. Prefer content:{format:'markdown',markdown:'...'} for paragraphs, headings, nested lists, fenced code, bold/italic, $...$ and $$...$$ math; escape a literal dollar as \\$. Use content:{format:'blocks',blocks:[...]} for native box styles, explicit formatting or pagination. On whiteboards use insert_shape kind:text instead. For a semantic teaching problem use edit_problem. " + PROPOSAL_GUIDANCE,
        inputSchema: z.object({ ...common, ...insertionFields, content }).strict(),
      },
      handler: async ({ content: input, ...context }, ...extra) => {
        const parsed = content.parse(input);
        const bodyBlocks = parsed.format === "blocks"
          ? parsed.blocks
          : parseMarkdownToTextFlowBlocks(parsed.markdown, { requireMarkdownSyntax: false });
        return dispatch("insert_body_content", { ...context, blocks: bodyBlocks }, extra);
      },
    },
    editTool(
      "edit_text", "既存テキストを編集",
      "Edit existing content with edit.action: patch sends 1-20 replace_text/format_inline operations (prefer exact quote/range or activeSelection; preserves surrounding formatting); update changes one paragraph/heading's text, runs or pagination, preserving unspecified fields; replace_structure supplies a complete same-ID/same-type block only when a structural change cannot use the other actions. Read the complete block before replace_structure; it is not a patch. For new content use insert_content, for problem areas use edit_problem, and for overlays use the dedicated shape/table/graph tools. format_inline also supports selected text/callout shapes.",
      ["apply_edits", "update_rich_content", "replace_block"],
    ),
    editTool(
      "edit_problem", "問題を作成・更新",
      "Create or partially update a semantic teaching problem with edit.action:create/update. create needs prompt and targetId or selectedId; update targets a problem or its inner block and preserves omitted fields and the problem ID. Areas accept existing rich input strings/blocks. Do not add generated numbering or solution headings. Only include answers/solutions/hints when supplied by the source or requested by the user. For update, [] clears lead/solution/hints, null or an empty answerText/answerTex clears the answer; specify only one of answer/answerText/answerTex. pagination:null clears pagination. Body tools are unavailable on whiteboards.",
      ["create_problem_content", "update_problem_content"],
    ),
    editTool(
      "organize_blocks", "本文ブロックを移動・削除",
      "Organize body blocks using edit.action:move/delete and blockIds. move preserves relative order and needs targetId plus position:before/after; END_OF_DOCUMENT with after moves to the end. It does not move blocks between problem areas. delete removes the specified body blocks. Tables, graphs and shapes are overlays and use delete_shapes/update_shape instead.",
      ["move_blocks", "delete_blocks"],
      { destructiveHint: true },
    ),
  ];
}
