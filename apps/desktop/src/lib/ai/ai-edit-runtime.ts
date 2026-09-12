import type { SigmaDocAgentToolName } from "@/lib/ai/sigma-doc-agent-tools";
import { createCurrentLocaleTranslator, type Translate } from "@/lib/i18n";
import type { AiEditSessionDocumentDraft } from "@/lib/ai/sigma-doc-edit-schema";

/** 既定指示は入力欄に入るので、表示言語に連動させる。 */
const tPromptNow = createCurrentLocaleTranslator("prompt");

/**
 * 添付があるときの既定指示。**モデルへ届く文**だが、入力欄に入って利用者が編集できるので
 * 表示言語に連動させる (`ai` 側のクイック操作と同じ扱い)。
 */
export function imageToSigmaDocDefaultInstruction(t: Translate<"prompt"> = tPromptNow): string {
  return t("runtime.imageToSigmaDocDefaultInstruction");
}

export function attachedFileDefaultInstruction(t: Translate<"prompt"> = tPromptNow): string {
  return t("runtime.attachedFileDefaultInstruction");
}

export function getAttachmentDefaultInstruction(
  attachments: readonly { mimeType?: string | null; dataUrl?: string | null }[],
  /**
   * **main プロセスでは省略しないこと。** 既定の `tPromptNow` は `getAppLocale()` を見るが、
   * main には `window` が無いので常に既定ロケール (日本語) を返す。英語 UI の run で
   * 省略すると、英語のプロンプトの中に日本語の既定指示だけが混ざる (code-review 指摘)。
   */
  t: Translate<"prompt"> = tPromptNow,
): string {
  if (attachments.length === 0) {
    return "";
  }
  const imagesOnly = attachments.every((attachment) => (
    attachment.mimeType?.startsWith("image/")
    || attachment.dataUrl?.startsWith("data:image/")
  ));
  return imagesOnly ? imageToSigmaDocDefaultInstruction(t) : attachedFileDefaultInstruction(t);
}

export interface AiEditRunLogEntry {
  kind: "request" | "model" | "tool" | "validation" | "repair";
  message: string;
}

export type AiEditRunPhase =
  | "preparing"
  | "reading"
  | "thinking"
  | "streaming"
  | "validating"
  | "repairing"
  | "complete";

/**
 * Item types surfaced by the Codex app-server during a turn. Mirrors the
 * `item.type` discriminator on `item/started` / `item/completed` notifications.
 * Unknown types collapse to "other".
 */
export type AiEditAgentItemType =
  | "reasoning"
  | "agentMessage"
  | "commandExecution"
  | "fileChange"
  | "mcpToolCall"
  | "imageGeneration"
  | "webSearch"
  | "todoList"
  | "other";

export type AiEditPlanStepStatus = "pending" | "inProgress" | "completed";

/** A single step from the Codex `turn/plan/updated` notification. */
export interface AiEditPlanStep {
  step: string;
  status: AiEditPlanStepStatus;
}

/** A single MCP tool-result PNG preview (e.g. render_visual_edit_session), surfaced in the chat history. */
export interface AiEditRunEventImage {
  /** `data:image/png;base64,...` — ready to use directly as an <img>/background-image source. */
  dataUrl: string;
  /** Original bytes are loaded on demand; chat history stores only the thumbnail. */
  generatedImage?: { runId: string; imageId: string };
}

export interface AiEditRunEvent {
  kind: AiEditRunLogEntry["kind"] | "phase" | "stream" | "error" | "plan" | "activity";
  phase: AiEditRunPhase;
  message: string;
  timestamp: number;
  channel?: "output" | "reasoning";
  delta?: string;
  toolName?: SigmaDocAgentToolName;
  /** For kind "activity": the Codex item type and lifecycle state. */
  itemType?: AiEditAgentItemType;
  itemStatus?: "started" | "completed";
  /** Stable id of the Codex item, so the UI can merge started to completed. */
  itemId?: string;
  /** For itemType "webSearch": the query the agent searched for. Codex only reports the
   * query (no result URLs), so this is the only citable fact about a web search — it is
   * turned into a `webSearch` sourceReference once the run finishes. */
  webSearchQuery?: string;
  /** For kind "plan": the full plan snapshot from turn/plan/updated. */
  planSteps?: AiEditPlanStep[];
  planExplanation?: string;
  /** MCP tool-result PNG previews attached to this event (e.g. an mcpToolCall's render/verification screenshot). */
  images?: AiEditRunEventImage[];
}

// Preview images are convenient for watching what the agent checked, but they
// are also by far the largest thing that can land in an AiEditRunEvent, and
// every event flows through IPC, the in-memory run-controller/session stores,
// and on-disk chat history / audit logs. Capping at the point images are first
// attached to an event keeps all of those downstream copies bounded without
// needing matching cap logic duplicated at each layer.
export const MAX_RUN_PREVIEW_IMAGES_PER_RUN = 8;
export const MAX_RUN_PREVIEW_IMAGE_DATA_URL_LENGTH = 2 * 1024 * 1024; // ~2MB of base64 text.

/**
 * Filters out oversized images and truncates to at most `remaining` entries.
 * Callers track `remaining` as a per-run budget (starting at
 * {@link MAX_RUN_PREVIEW_IMAGES_PER_RUN}) and decrement it by the returned
 * array's length after each call.
 */
export function capRunPreviewImages(
  images: AiEditRunEventImage[] | undefined,
  remaining: number,
): AiEditRunEventImage[] {
  if (!images || images.length === 0 || remaining <= 0) {
    return [];
  }
  return images
    .filter((image) => image.dataUrl.length <= MAX_RUN_PREVIEW_IMAGE_DATA_URL_LENGTH)
    .slice(0, remaining);
}

export interface AiEditRunResult extends AiEditSessionDocumentDraft {
  logs: AiEditRunLogEntry[];
  repaired: boolean;
  changedIds: string[];
  /** "cancelled" marks a run the user stopped mid-flight (ai-edit:cancel); never thrown as a raw error. */
  status?: "draft" | "needsClarification" | "answer" | "cancelled";
  questions?: string[];
  agentThreadId?: string;
  runtime?: "codex-mcp" | "claude-mcp" | "antigravity-mcp";
}

export function buildSigmaDocContextPrompt(t: Translate<"prompt">): string {
  return t("runtime.sigmaDocContext");
}

export function buildMathliveContextPrompt(t: Translate<"prompt">): string {
  return t("runtime.mathliveContext");
}
