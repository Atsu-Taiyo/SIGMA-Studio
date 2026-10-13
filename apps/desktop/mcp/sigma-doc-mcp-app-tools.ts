import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { parseMarkdownToTextFlowBlocks } from "@/lib/markdown-to-text-flow";

/**
 * The body-edit implementations behind the four public body tools, keyed by their
 * internal names, with the public tool (and edit.action) that reaches each one.
 * The internal names are never published as MCP tools.
 */
export const BODY_IMPLEMENTATION_ROUTES = {
  insert_body_content: { name: "insert_content" },
  apply_edits: { name: "edit_text", action: "patch" },
  update_rich_content: { name: "edit_text", action: "update" },
  replace_block: { name: "edit_text", action: "replace_structure" },
  create_problem_content: { name: "edit_problem", action: "create" },
  update_problem_content: { name: "edit_problem", action: "update" },
  delete_blocks: { name: "organize_blocks", action: "delete" },
  move_blocks: { name: "organize_blocks", action: "move" },
} as const;

export type BodyImplementationName = keyof typeof BODY_IMPLEMENTATION_ROUTES;

export function isBodyImplementationName(name: string): name is BodyImplementationName {
  return Object.hasOwn(BODY_IMPLEMENTATION_ROUTES, name);
}

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
 * Public body-tool adapter, inspired by WebMCP's public/implementation split.
 * The implementations remain responsible for validation, selection, attribution,
 * concurrency, proposal accumulation and previews. There is no second write path.
 */
export function createAppBodyTools(
  implementations: ReadonlyMap<BodyImplementationName, BodyToolImplementation>,
): AppBodyToolDefinition[] {
  const implementation = (name: BodyImplementationName): BodyToolImplementation => {
    const tool = implementations.get(name);
    if (!tool) throw new Error(`Missing app body tool implementation: ${name}`);
    return tool;
  };
  const common = Object.fromEntries(Object.entries(implementation("apply_edits").inputSchema)
    .filter(([key]) => COMMON_FIELDS.has(key)));
  const fields = (name: BodyImplementationName) => Object.fromEntries(
    Object.entries(implementation(name).inputSchema).filter(([key]) => !COMMON_FIELDS.has(key)),
  );
  const dispatch = async (name: BodyImplementationName, args: Record<string, unknown>, extra: unknown[]): Promise<CallToolResult> => {
    const tool = implementation(name);
    // Validate using the implementation's own contract before calling its handler, so
    // malformed input never reaches the write path.
    const parsed = await z.object(tool.inputSchema).strict().parseAsync(args);
    return await tool.handler(parsed, ...extra) as CallToolResult;
  };
  const editTool = (
    name: string,
    title: string,
    description: string,
    routes: [BodyImplementationName, BodyImplementationName, ...BodyImplementationName[]],
    annotations?: ToolAnnotations,
  ): AppBodyToolDefinition => {
    const choices = routes.map((implementationName) => {
      const route = BODY_IMPLEMENTATION_ROUTES[implementationName];
      if (!("action" in route)) throw new Error(`Missing edit action: ${implementationName}`);
      return z.object({ action: z.literal(route.action), ...fields(implementationName) }).strict();
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
            routes.some((implementationName) => Object.hasOwn(implementation(implementationName).inputSchema, key)))),
          edit,
        }).strict(),
        annotations,
      },
      handler: async ({ edit: input, ...context }, ...extra) => {
        const { action, ...payload } = edit.parse(input);
        const implementationName = routes.find((candidate) => {
          const route = BODY_IMPLEMENTATION_ROUTES[candidate];
          return "action" in route && route.action === action;
        });
        if (!implementationName) throw new Error(`Unknown body edit action: ${String(action)}`);
        return dispatch(implementationName, { ...context, ...payload }, extra);
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
