/** The external MCP contract stays stable; app-launched agents use purpose-oriented body tools. */
export type McpToolProfile = "external" | "app";

export const MCP_TOOL_PROFILE_ENV = "SIGMA_STUDIO_MCP_TOOL_PROFILE";

export const APP_BODY_TOOL_ROUTES = {
  insert_body_content: { name: "insert_content" },
  apply_edits: { name: "edit_text", action: "patch" },
  update_rich_content: { name: "edit_text", action: "update" },
  replace_block: { name: "edit_text", action: "replace_structure" },
  create_problem_content: { name: "edit_problem", action: "create" },
  update_problem_content: { name: "edit_problem", action: "update" },
  delete_blocks: { name: "organize_blocks", action: "delete" },
  move_blocks: { name: "organize_blocks", action: "move" },
} as const;

export type LegacyBodyToolName = keyof typeof APP_BODY_TOOL_ROUTES;

export function isLegacyBodyToolName(name: string): name is LegacyBodyToolName {
  return Object.hasOwn(APP_BODY_TOOL_ROUTES, name);
}

/** Use the same mapping for actual tools/list exposure and the provider's execution permissions. */
export function appMcpToolNames(names: readonly string[]): string[] {
  return [...new Set(names.map((name) => isLegacyBodyToolName(name) ? APP_BODY_TOOL_ROUTES[name].name : name))];
}

const LEGACY_TOOL_REFERENCE = new RegExp(`\\b(${Object.keys(APP_BODY_TOOL_ROUTES).join("|")})\\b`, "g");

/** Application-authored prose only. Never rewrite user instructions, document text, or attached resources. */
export function appMcpToolGuidance(text: string): string {
  return text.replace(LEGACY_TOOL_REFERENCE, (name) => {
    if (!isLegacyBodyToolName(name)) return name;
    const route = APP_BODY_TOOL_ROUTES[name];
    return "action" in route ? `${route.name} (edit.action:"${route.action}")` : route.name;
  });
}
