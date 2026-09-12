import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiEditAttachment, AiEditMentionedDocumentContext } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiEditModel, AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import { getDesktopBridge } from "@/lib/desktop-bridge";
import type { SigmaDocument } from "@/features/document";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

export interface CodexAiEditRequest {
  // 既定は "chatgpt" (Codex)。"claude" / "antigravity" は MCP経由でそれぞれのCLIへルーティングする。
  provider?: "chatgpt" | "claude" | "antigravity";
  // Claude / Gemini は MCP ツールで fileId を対象に編集するため、それらのルート時に必須。
  fileId?: string;
  model: AiEditModel;
  reasoningEffort?: AiEditReasoningEffort;
  instruction: string;
  document: SigmaDocument;
  selectedId: string | null;
  references?: AiEditReference[];
  attachments?: AiEditAttachment[];
  mentionedDocuments?: AiEditMentionedDocumentContext[];
  aiResourceIds?: string[];
  agentThreadId?: string | null;
  // 帰属情報 (feedback loop / MCP提案の帰属付けに使う)。すべて任意。
  // chatのroomId・assistant turnId、UIに出すセッションラベル (部屋タイトルや指示の抜粋)。
  roomId?: string;
  turnId?: string;
  sessionLabel?: string;
  onEvent?: (event: AiEditRunEvent) => void;
  /** Invoked synchronously with the underlying IPC runId, before the run resolves, so the caller can cancel it later via cancelAiEditViaDesktopRuntime. */
  onRunId?: (runId: string) => void;
}

export async function runAiEditViaDesktopRuntime(request: CodexAiEditRequest): Promise<AiEditRunResult> {
  const desktop = getDesktopBridge();
  if (!desktop) {
    throw new Error(ta("provider.desktopCodexRequired"));
  }

  const payload = {
    provider: request.provider ?? "chatgpt",
    fileId: request.fileId ?? null,
    model: request.model,
    reasoningEffort: request.reasoningEffort,
    instruction: request.instruction,
    document: request.document,
    selectedId: request.selectedId,
    references: request.references ?? [],
    attachments: request.attachments ?? [],
    mentionedDocuments: request.mentionedDocuments ?? [],
    aiResourceIds: request.aiResourceIds ?? [],
    agentThreadId: request.agentThreadId ?? null,
    roomId: request.roomId,
    turnId: request.turnId,
    sessionLabel: request.sessionLabel,
  };
  const onEvent = (event: unknown) => {
    request.onEvent?.(event as AiEditRunEvent);
  };
  // Only pass a third argument when the caller wants the runId: keeps the
  // call shape identical to before this run() gained an onRunId param for
  // callers (and tests) that don't care about it.
  return (
    request.onRunId
      ? desktop.aiEdit.run(payload, onEvent, request.onRunId)
      : desktop.aiEdit.run(payload, onEvent)
  ) as Promise<AiEditRunResult>;
}

/**
 * Requests cancellation of an in-flight ai-edit:run call. Returns
 * `{ ok: false, cancelled: false }` when running outside the desktop shell or
 * against an older preload build with no aiEdit.cancel, so callers can treat
 * it as a no-op instead of throwing.
 */
export async function cancelAiEditViaDesktopRuntime(runId: string): Promise<{ ok: boolean; cancelled: boolean }> {
  const desktop = getDesktopBridge();
  if (!desktop?.aiEdit.cancel) {
    return { ok: false, cancelled: false };
  }
  return desktop.aiEdit.cancel(runId);
}
