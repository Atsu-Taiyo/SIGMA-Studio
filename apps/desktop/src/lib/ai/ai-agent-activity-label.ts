import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";

/** `t` を省略したときの解決器。**呼び出し時点の表示言語**で引く (解決器は言語ごとに使い回す)。 */
const DEFAULT_AI_TRANSLATE = createCurrentLocaleTranslator("ai");

/**
 * 進捗ラベルを出す MCP ツール名。
 *
 * **キーは MCP 契約そのものなので絶対に変えない** (`docs/mcp-local-app.md` の
 * 公開ツール名と 1:1)。文言は `ai.activity.tool.<toolName>` が持つ。ここに配列で
 * 持っているのは、辞書に無いツール名を検査で落とせるようにするため。
 */
export const ACTIVITY_LABEL_TOOL_NAMES = [
  "draft_insert_body_content",
  "draft_create_problem_content",
  "draft_update_problem_content",
  "draft_insert_table",
  "draft_insert_shape",
  "draft_insert_graph",
  "draft_insert_graph3d",
  "draft_update_graph3d",
  "draft_insert_text_block",
  "draft_create_problem",
  "draft_update_problem_answer",
  "draft_insert_overlay_shape",
  "draft_insert_material",
  "draft_insert_table_shape",
  "draft_insert_graph_shape",
  "draft_attach_image_asset",
  "draft_validate",
  "update_page_layout",
  "read_block",
  "read_document_outline",
  "list_materials",
  "get_material",
  "update_column_layout",
] as const;

const ACTIVITY_LABEL_TOOL_NAME_SET: ReadonlySet<string> = new Set(ACTIVITY_LABEL_TOOL_NAMES);

/** 辞書に文言がある実行フェーズ。型の union が広がっても実行時に生キーを出さないための網。 */
export const ACTIVITY_PHASE_IDS = [
  "preparing", "reading", "thinking", "streaming", "validating", "repairing", "complete",
] as const;

const ACTIVITY_PHASES: ReadonlySet<string> = new Set(ACTIVITY_PHASE_IDS);

const UUID_PATTERN = /\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/gi;
const DRAFT_TOOL_PATTERN = /\bdraft_[a-z_]+\b/g;
const BLOCK_ID_PATTERN = /\b(block|target|shape)[-_ ]?id[:\s]+[^\s,.、。]+/gi;

function stripTechnicalDetail(message: string): string {
  return message
    .replace(UUID_PATTERN, "")
    .replace(DRAFT_TOOL_PATTERN, "")
    .replace(BLOCK_ID_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** 辞書を引くのは**知っているツール名のときだけ**。未知の名前で生キーを出さない。 */
function toolLabel(tool: string, t: Translate<"ai">): string | null {
  return ACTIVITY_LABEL_TOOL_NAME_SET.has(tool)
    ? (t(`activity.tool.${tool}` as never) as unknown as string)
    : null;
}

function labelForToolMessage(message: string, t: Translate<"ai">): string | null {
  const separator = message.indexOf(":");
  if (separator < 0) {
    return toolLabel(message.trim(), t);
  }

  const tool = message.slice(0, separator).trim();
  const detail = stripTechnicalDetail(message.slice(separator + 1));
  const label = toolLabel(tool, t);
  if (label) {
    return label;
  }

  // ここだけは辞書ではなくエージェントが書いた文をそのまま出す (実行時のデータ)。
  if (detail.length > 0 && detail.length <= 48 && !detail.includes("SigmaDoc")) {
    return detail;
  }

  return t("activity.editing");
}

/** `t` の既定が日本語なのは、既存の呼び出しとテストの期待を変えないため。 */
export function formatAgentActivityLabel(
  event: Pick<AiEditRunEvent, "kind" | "message" | "phase" | "itemType">,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  if (event.kind === "activity") {
    return event.message.trim() || t("activity.processing");
  }

  if (event.kind === "tool" || event.kind === "repair") {
    return labelForToolMessage(event.message, t) ?? t("activity.editing");
  }

  if (event.kind === "validation") {
    return t("activity.validating");
  }

  if (event.kind === "plan") {
    return t("activity.planning");
  }

  if (event.kind === "phase") {
    // **`t()` は見つからないとキー文字列を返す** (truthy)。`||` で繋ぐと後ろの
    // フォールバックへ絶対に落ちず、知らない phase で生キーが画面に出る。
    // 知っている phase かを先に確かめる。
    return ACTIVITY_PHASES.has(event.phase)
      ? (t(`activity.phase.${event.phase}` as never) as unknown as string)
      : (stripTechnicalDetail(event.message) || t("activity.processing"));
  }

  if (event.kind === "stream") {
    return event.phase === "thinking" ? t("activity.phase.thinking") : t("activity.receiving");
  }

  if (event.kind === "error") {
    return t("activity.error");
  }

  const cleaned = stripTechnicalDetail(event.message);
  return cleaned || t("activity.processing");
}

export function summarizeRunningActivity(
  events: ReadonlyArray<Pick<AiEditRunEvent, "kind" | "message" | "phase" | "itemType">>,
  t: Translate<"ai"> = DEFAULT_AI_TRANSLATE,
): string {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.kind === "stream") {
      continue;
    }
    const label = formatAgentActivityLabel(event, t);
    if (label) {
      return label;
    }
  }
  return t("activity.phase.thinking");
}
