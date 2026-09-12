import { appMcpToolNames, type McpToolProfile } from "./mcp-tool-profile";

export const MCP_TOOL_CATEGORIES = [
  "文書探索",
  "教材管理",
  "本文編集",
  "ページ・段組み",
  "図形",
  "表",
  "グラフ",
  "visual edit",
  "素材",
  "AI設定・アプリ文脈",
] as const;

export type McpToolCategory = (typeof MCP_TOOL_CATEGORIES)[number];

/**
 * Public sigma-studio-local tools grouped by the user task that needs them.
 * The MCP contract test intentionally compares this map with its independently
 * pinned DOCUMENTED_TOOL_NAMES list so a newly registered tool cannot silently
 * skip staged exposure.
 */
export const MCP_TOOL_CATEGORY_MAP = {
  "文書探索": [
    "get_active_reference",
    "get_block",
    "get_blocks",
    "get_edit_context",
    "get_document_outline",
    "get_insertion_candidates",
    "get_mentioned_sigma_docs",
    "get_neighbor_blocks",
    "get_selected_block",
    "list_local_documents",
    "read_local_document",
    "render_block_context",
    "render_page",
    "search_document",
    "search_library",
    "validate_local_document",
  ],
  "教材管理": [
    "create_local_document",
    "create_local_folder",
    "delete_local_document",
    "delete_local_folder",
    "update_local_document",
    "update_local_folder",
  ],
  "本文編集": [
    "apply_edits",
    "create_problem_content",
    "delete_blocks",
    "insert_body_content",
    "move_blocks",
    "replace_block",
    "update_problem_content",
    "update_rich_content",
  ],
  "ページ・段組み": [
    "update_column_layout",
    "update_page_layout",
  ],
  "図形": [
    "align_shapes",
    "delete_shapes",
    "insert_shape",
    "insert_generated_image",
    "update_generated_image",
    "insert_svg_image",
    "update_svg_image",
    "update_shape",
  ],
  "表": [
    "insert_table",
    "update_table",
  ],
  "グラフ": [
    "insert_graph",
    "insert_graph3d",
    "update_graph",
    "update_graph3d",
  ],
  "visual edit": [
    "begin_visual_edit_session",
    "discard_visual_edit_session",
    "inspect_visual_edit_session",
    "propose_visual_edit_session",
    "render_visual_edit_session",
    "review_visual_edit_session",
    "visual_insert_shape",
    "visual_remove_shape",
    "visual_replace_shape",
  ],
  "素材": [
    "get_image_reference",
    "list_generated_images",
    "get_attached_media",
    "get_material",
    "insert_material",
    "list_materials",
  ],
  "AI設定・アプリ文脈": [
    "delete_ai_resource",
    "get_edit_proposal",
    "get_local_app_status",
    "list_edit_proposals",
    "list_all_pending_proposals",
    "save_ai_resource",
    "update_ai_settings",
    "withdraw_current_edit_proposal",
    "withdraw_edit_proposal",
  ],
} as const satisfies Record<McpToolCategory, readonly string[]>;

export type McpToolName = (typeof MCP_TOOL_CATEGORY_MAP)[McpToolCategory][number];

/** Proposal lifecycle remains available even when its owning category was not inferred. */
export const ALWAYS_AVAILABLE_MCP_TOOL_NAMES = [
  "get_edit_proposal",
  "list_edit_proposals",
  "list_all_pending_proposals",
  "validate_local_document",
  "withdraw_current_edit_proposal",
  "withdraw_edit_proposal",
] as const satisfies readonly McpToolName[];

export interface McpToolInferenceReference {
  kind?: string;
  targetType?: string;
  excerpt?: string;
  selectedText?: string;
  tex?: string;
  mathTex?: readonly string[];
  overlaySelection?: {
    shapes?: ReadonlyArray<{ type?: string }>;
  };
}

export interface InferToolCategoriesForRunArgs {
  instruction: string;
  references?: readonly (McpToolInferenceReference | string)[];
  selectedSkillIds?: readonly string[];
}

const CATEGORY_KEYWORD_PATTERNS: ReadonlyArray<{
  category: Exclude<McpToolCategory, "文書探索">;
  pattern: RegExp;
  also?: readonly McpToolCategory[];
}> = [
  {
    category: "教材管理",
    pattern: /教材.{0,6}(作成|作って|作る|新規|削除|移動|名前|改名|整理|名.{0,2}(変|変更))|ファイル.{0,6}(作成|作って|作る|削除|移動|名前|改名|整理|CRUD)|フォルダ|folder|(?:file|document).{0,8}(create|delete|move|rename|organize|CRUD)|library management/i,
  },
  {
    category: "AI設定・アプリ文脈",
    pattern: /AI設定|AIリソース|自動承認|Web検索|スキル|プロンプト|agent settings|ai settings|resource|skill|prompt/i,
  },
  {
    category: "グラフ",
    // Mirrors the graph-context precedent in mcp-edit-prompt.ts.
    pattern: /グラフ|graph|放物線|関数|曲線|数直線|座標/i,
  },
  {
    category: "表",
    pattern: /増減表|対応表|表(?!現|示|情|面)|table|tabular/i,
  },
  {
    category: "素材",
    pattern: /svg|挿絵|素材|添付|画像|写真|スクリーンショット|メディア|material|attachment|image|photo|screenshot|media/i,
    also: ["visual edit", "図形"],
  },
  {
    category: "図形",
    pattern: /図形|図解|模式図|矢印|補助線|三角形|四角形|長方形|多角形|円弧|円(?!周率)|楕円|吹き出し|shape|diagram|arrow|triangle|rectangle|polygon|circle|ellipse|callout/i,
    also: ["visual edit"],
  },
  {
    category: "visual edit",
    pattern: /visual[ _-]?edit|プレビュー|見ながら|忠実.{0,4}再現|配置.{0,4}(調整|修正)|重なり|はみ出し|preview|reconstruct/i,
  },
  {
    category: "ページ・段組み",
    pattern: /ページ|段組み?|改ページ|余白|紙面|レイアウト|page|column|layout/i,
  },
  {
    category: "本文編集",
    pattern: /本文|文章|段落|見出し|箇条書き|問題文|問題|解答|解説|ヒント|数式|誤字|校正|言い換え|書き直|テキスト|並べ替え|順序.{0,3}(変更|移動)|paragraph|heading|body|problem|answer|explanation|proof|formula|text|reorder/i,
  },
];

const DOCUMENT_EXPLORATION_PATTERN = /探して|検索|調べ|確認|読み取|読んで|一覧|概要|構成|どこ|find|search|inspect|read|list|outline/i;
const GENERIC_MUTATION_PATTERN = /直して|修正|変更|編集|追加|作成|挿入|削除|移動|置換|更新|edit|fix|change|add|create|insert|delete|move|replace|update/i;

const BODY_TARGET_TYPE_PATTERN = /paragraph|heading|problem|solution|explanation|hint|list|math|box|rich/i;
const PAGE_TARGET_TYPE_PATTERN = /section|layout|page|column/i;

const SKILL_CATEGORY_RULES: ReadonlyArray<{
  pattern: RegExp;
  categories: readonly McpToolCategory[];
}> = [
  {
    pattern: /^(official-graph|sigma-graph-editing)$/i,
    categories: ["グラフ", "図形", "visual edit"],
  },
  {
    pattern: /^(official-image-material|sigma-image-material-reconstruction)$/i,
    categories: ["本文編集", "図形", "表", "グラフ", "visual edit", "素材"],
  },
  {
    pattern: /graph|plot|coordinate|グラフ|座標/i,
    categories: ["グラフ", "図形", "visual edit"],
  },
  {
    pattern: /image|material|photo|screenshot|reconstruct|画像|素材|再現/i,
    categories: ["本文編集", "図形", "表", "グラフ", "visual edit", "素材"],
  },
  { pattern: /table|表/i, categories: ["表"] },
  { pattern: /shape|diagram|figure|図形|図解/i, categories: ["図形", "visual edit"] },
  { pattern: /layout|page|column|レイアウト|ページ|段組/i, categories: ["ページ・段組み"] },
  { pattern: /text|body|problem|本文|文章|問題/i, categories: ["本文編集"] },
  { pattern: /setting|prompt|resource|設定|プロンプト/i, categories: ["AI設定・アプリ文脈"] },
];

/**
 * Returns staged tool categories for one run. A category is only narrowed when
 * the instruction, selected reference type/content, or selected skill gives a
 * positive signal; otherwise all categories are returned to avoid blocking an
 * unrecognized task. Document exploration is present in every narrowed run.
 */
export function inferToolCategoriesForRun({
  instruction,
  references = [],
  selectedSkillIds = [],
}: InferToolCategoriesForRunArgs): McpToolCategory[] {
  const inferred = new Set<McpToolCategory>(["文書探索"]);
  let hasConfidentSignal = false;
  let hasUnknownSelectedSkill = false;

  const referenceTexts: string[] = [];
  for (const reference of references) {
    if (typeof reference === "string") {
      referenceTexts.push(reference);
      continue;
    }
    referenceTexts.push([
      reference.excerpt,
      reference.selectedText,
      reference.tex,
      ...(reference.mathTex ?? []),
    ].filter(Boolean).join(" "));

    const targetType = reference.targetType ?? "";
    if (/graph2d/i.test(targetType)) {
      inferred.add("グラフ");
      hasConfidentSignal = true;
    } else if (/table/i.test(targetType)) {
      inferred.add("表");
      hasConfidentSignal = true;
    } else if (BODY_TARGET_TYPE_PATTERN.test(targetType)) {
      inferred.add("本文編集");
      hasConfidentSignal = true;
    } else if (PAGE_TARGET_TYPE_PATTERN.test(targetType)) {
      inferred.add("ページ・段組み");
      hasConfidentSignal = true;
    }

    for (const shape of reference.overlaySelection?.shapes ?? []) {
      if (shape.type === "graph2dShape") {
        inferred.add("グラフ");
      } else if (shape.type === "tableShape") {
        inferred.add("表");
      } else if (shape.type === "image") {
        inferred.add("素材");
        inferred.add("図形");
        inferred.add("visual edit");
      } else if (shape.type) {
        inferred.add("図形");
        inferred.add("visual edit");
      }
      hasConfidentSignal = hasConfidentSignal || Boolean(shape.type);
    }
  }

  const searchableText = `${instruction}\n${referenceTexts.join("\n")}`;
  for (const rule of CATEGORY_KEYWORD_PATTERNS) {
    if (!rule.pattern.test(searchableText)) {
      continue;
    }
    inferred.add(rule.category);
    for (const category of rule.also ?? []) {
      inferred.add(category);
    }
    hasConfidentSignal = true;
  }
  if (DOCUMENT_EXPLORATION_PATTERN.test(searchableText)) {
    hasConfidentSignal = true;
  }

  for (const skillId of selectedSkillIds) {
    const matchingRules = SKILL_CATEGORY_RULES.filter((rule) => rule.pattern.test(skillId));
    if (matchingRules.length === 0) {
      hasUnknownSelectedSkill = true;
      continue;
    }
    hasConfidentSignal = true;
    for (const rule of matchingRules) {
      for (const category of rule.categories) {
        inferred.add(category);
      }
    }
  }

  const hasOnlyExploration = inferred.size === 1;
  const ambiguousMutation = hasOnlyExploration && GENERIC_MUTATION_PATTERN.test(searchableText);
  if (!hasConfidentSignal || hasUnknownSelectedSkill || ambiguousMutation) {
    return [...MCP_TOOL_CATEGORIES];
  }
  return MCP_TOOL_CATEGORIES.filter((category) => inferred.has(category));
}

/** Always adds document exploration and proposal/verification tools. */
export function toolNamesForCategories(categories: readonly McpToolCategory[]): McpToolName[] {
  const selectedCategories = new Set<McpToolCategory>(["文書探索", ...categories]);
  const names = new Set<McpToolName>();
  for (const category of MCP_TOOL_CATEGORIES) {
    if (!selectedCategories.has(category)) {
      continue;
    }
    for (const name of MCP_TOOL_CATEGORY_MAP[category]) {
      names.add(name);
    }
  }
  for (const name of ALWAYS_AVAILABLE_MCP_TOOL_NAMES) {
    names.add(name);
  }
  return [...names];
}

export interface McpToolSchemaLike {
  name: string;
}

export interface McpToolExposureMeasurement {
  selection: {
    categories: McpToolCategory[];
    toolCount: number;
    serializedSchemaBytes: number;
  };
  fullExposure: {
    toolCount: number;
    serializedSchemaBytes: number;
  };
}

/** Pure size/count comparison over the tool schemas returned by MCP listTools. */
export function measureMcpToolExposure(
  tools: readonly McpToolSchemaLike[],
  categories: readonly McpToolCategory[],
  profile: McpToolProfile = "external",
): McpToolExposureMeasurement {
  const effectiveCategories = new Set<McpToolCategory>(["文書探索", ...categories]);
  const names = toolNamesForCategories(categories);
  const selectedNameSet = new Set<string>(profile === "app" ? appMcpToolNames(names) : names);
  const selectedTools = tools.filter((tool) => selectedNameSet.has(tool.name));
  return {
    selection: {
      categories: MCP_TOOL_CATEGORIES.filter((category) => effectiveCategories.has(category)),
      toolCount: selectedTools.length,
      serializedSchemaBytes: serializedUtf8Bytes(selectedTools),
    },
    fullExposure: {
      toolCount: tools.length,
      serializedSchemaBytes: serializedUtf8Bytes(tools),
    },
  };
}

function serializedUtf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
