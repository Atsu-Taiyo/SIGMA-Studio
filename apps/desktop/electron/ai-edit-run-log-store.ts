import fs from "node:fs/promises";
import path from "node:path";

import type { AiEditReference } from "@/lib/ai/ai-edit-reference";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import { resolveDocumentTitle } from "@/lib/document-title";
import {
  capRunPreviewImages,
  MAX_RUN_PREVIEW_IMAGES_PER_RUN,
  type AiEditRunEvent,
  type AiEditRunEventImage,
  type AiEditRunResult,
} from "@/lib/ai/ai-edit-runtime";
import type { AiEditModel, AiEditReasoningEffort } from "@/lib/ai/sigma-doc-edit-schema";
import type { SigmaDocument } from "@/features/document";

const DATA_DIR_NAME = "data";
const AI_EDIT_RUNS_DIR_NAME = "ai-edit-runs";

interface IncomingAiEditLogPayload {
  model?: AiEditModel;
  reasoningEffort?: AiEditReasoningEffort;
  instruction?: string;
  document?: SigmaDocument;
  selectedId?: string | null;
  references?: AiEditReference[];
  attachments?: AiEditAttachment[];
  agentThreadId?: string | null;
}

export interface LocalAiEditRunLogInput {
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "error" | "cancelled";
  payload: unknown;
  events: AiEditRunEvent[];
  result?: AiEditRunResult;
  error?: string;
}

interface LocalAiEditRunLogRecord {
  version: 1;
  runId: string;
  startedAt: string;
  completedAt: string;
  status: "completed" | "error" | "cancelled";
  request: {
    model?: AiEditModel;
    reasoningEffort?: AiEditReasoningEffort;
    instruction: string;
    document?: {
      docId: string;
      title: string;
      contentCount: number;
    };
    selectedId: string | null;
    references: AiEditReference[];
    agentThreadId: string | null;
    attachments: Array<{
      id: string;
      name: string;
      mimeType: string | null;
      width: number | null;
      height: number | null;
      fileSize: number | null;
      kind: "image" | "other";
    }>;
  };
  result?: {
    status: "draft" | "needsClarification" | "answer" | "cancelled";
    summary: string;
    plan: string[];
    warnings: string[];
    questions: string[];
    operationCount: number;
    changedIds: string[];
    agentThreadId: string | null;
    repaired: boolean;
    runtime: "codex-mcp" | "claude-mcp" | "antigravity-mcp" | null;
  };
  error?: string;
  events: Array<{
    kind: AiEditRunEvent["kind"];
    phase: AiEditRunEvent["phase"];
    message: string;
    timestamp: number;
    toolName?: string;
    itemType?: string;
    itemStatus?: string;
    images?: AiEditRunEventImage[];
  }>;
}

export class LocalAiEditRunLogStore {
  private readonly runsDir: string;

  constructor(userDataPath: string) {
    this.runsDir = path.join(userDataPath, DATA_DIR_NAME, AI_EDIT_RUNS_DIR_NAME);
  }

  async appendRun(input: LocalAiEditRunLogInput): Promise<void> {
    await fs.mkdir(this.runsDir, { recursive: true });
    const record = createRunLogRecord(input);
    const filePath = path.join(this.runsDir, `${record.startedAt.slice(0, 10)}.jsonl`);
    await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
  }
}

function createRunLogRecord(input: LocalAiEditRunLogInput): LocalAiEditRunLogRecord {
  const payload = (input.payload ?? {}) as IncomingAiEditLogPayload;
  return {
    version: 1,
    runId: input.runId,
    startedAt: input.startedAt,
    completedAt: input.completedAt,
    status: input.status,
    request: {
      ...(payload.model ? { model: payload.model } : {}),
      ...(payload.reasoningEffort ? { reasoningEffort: payload.reasoningEffort } : {}),
      instruction: typeof payload.instruction === "string" ? payload.instruction.trim() : "",
      ...(payload.document
        ? {
            document: {
              docId: payload.document.docId,
              title: resolveDocumentTitle(payload.document),
              contentCount: payload.document.content.length,
            },
          }
        : {}),
      selectedId: payload.selectedId ?? null,
      references: payload.references ?? [],
      agentThreadId: payload.agentThreadId ?? null,
      attachments: (payload.attachments ?? []).map((attachment) => ({
        id: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType ?? null,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        fileSize: attachment.fileSize ?? null,
        kind: attachment.dataUrl.startsWith("data:image/") ? "image" : "other",
      })),
    },
    ...(input.result ? { result: summarizeResult(input.result) } : {}),
    ...(input.error ? { error: input.error } : {}),
    events: summarizeEventsWithCappedImages(input.events),
  };
}

/**
 * This is a standalone audit log (append-only JSONL, never re-read by the
 * app), so it re-applies the same preview-image budget the shared MCP runner
 * already enforces at emission time (see ai-edit-shared-runner.ts) rather than
 * trusting it — a defensive cap so this log can never bloat unbounded even if
 * a future caller feeds it events some other way.
 */
function summarizeEventsWithCappedImages(
  events: AiEditRunEvent[],
): NonNullable<LocalAiEditRunLogRecord["events"]> {
  let remainingImageBudget = MAX_RUN_PREVIEW_IMAGES_PER_RUN;
  return events.map((event) => {
    const images = capRunPreviewImages(event.images, remainingImageBudget);
    remainingImageBudget -= images.length;
    return {
      kind: event.kind,
      phase: event.phase,
      message: event.message,
      timestamp: event.timestamp,
      ...(event.toolName ? { toolName: event.toolName } : {}),
      ...(event.itemType ? { itemType: event.itemType } : {}),
      ...(event.itemStatus ? { itemStatus: event.itemStatus } : {}),
      ...(images.length > 0 ? { images } : {}),
    };
  });
}

function summarizeResult(result: AiEditRunResult): NonNullable<LocalAiEditRunLogRecord["result"]> {
  return {
    status: result.status ?? "draft",
    summary: result.draft.summary,
    plan: result.draft.plan,
    warnings: result.draft.warnings,
    questions: result.questions ?? [],
    operationCount: result.draft.operations.length,
    changedIds: result.changedIds,
    agentThreadId: result.agentThreadId ?? null,
    repaired: result.repaired,
    runtime: result.runtime ?? null,
  };
}
