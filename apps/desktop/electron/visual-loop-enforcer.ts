import { tv } from "@/lib/ai/validation-locale";
import fs from "node:fs/promises";
import path from "node:path";

import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import {
  runContextDirPath,
  visualSessionsFileName,
  type AiEditRunContextProvider,
} from "./ai-edit-run-context";
import type { VisualSessionStatusSnapshot } from "./visual-session-status";

export type { VisualSessionStatusSnapshot } from "./visual-session-status";

export const MAX_VISUAL_LOOP_CONTINUATIONS = 3;

/** 表示直前に解決する。module 直下で解決すると読み込み時の言語で焼き付く。 */
export function visualLoopExhaustedWarning(): string {
  return tv("visualLoop.visualLoopExhaustedWarning");
}

export function visualLoopPartialWarning(): string {
  return tv("visualLoop.visualLoopPartialWarning");
}

/**
 * Reads the MCP server's best-effort per-run visual-session status file.
 * Missing or malformed status is intentionally treated as "no sessions" so
 * observability failure never turns a completed AI run into an error.
 */
export async function readIncompleteVisualSessions(
  userDataPath: string,
  provider: AiEditRunContextProvider,
  runId: string,
): Promise<VisualSessionStatusSnapshot[]> {
  const trimmedUserDataPath = userDataPath.trim();
  const trimmedRunId = runId.trim();
  if (!trimmedUserDataPath || !trimmedRunId) {
    return [];
  }

  const filePath = path.join(
    runContextDirPath(trimmedUserDataPath),
    visualSessionsFileName(provider, trimmedRunId),
  );

  let raw: string;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
    return [];
  }

  return parsed.sessions.filter(isVisualSessionStatusSnapshot).filter(
    (session) => session.operationCount > 0 && !session.proposed && !session.discarded,
  );
}

export function buildVisualLoopContinuationPrompt(
  sessions: readonly VisualSessionStatusSnapshot[],
  provider: AiEditRunContextProvider,
  runId: string,
): string {
  const sessionIds = sessions.map((session) => session.sessionId).join(", ");

  /**
   * 手順の**番号は本文に書かない**。同じ手順が 2 つのバリアントで別の番号を持つため
   * (再開版は 4./5./6.、続行版は 3./4./5.)、番号込みで訳すと同じ文が二重に増え、
   * 訳し分けたときに番号だけずれる。番号は並び順から機械的に振る。
   */
  const numbered = (steps: readonly string[]): string[] =>
    steps.map((step, index) => `${index + 1}. ${step}`);

  if (provider !== "chatgpt") {
    return [
      tv("visualLoop.restartIntro"),
      tv("visualLoop.restartWhyNewSession"),
      tv("visualLoop.restartWhatToDo"),
      tv("visualLoop.stepsHeader"),
      ...numbered([
        tv("visualLoop.restartStepBegin"),
        tv("visualLoop.restartStepRedoShapes"),
        tv("visualLoop.restartStepRender"),
        tv("visualLoop.stepInspectAndReview"),
        tv("visualLoop.stepFixIssues"),
        tv("visualLoop.stepPropose"),
      ]),
      tv("visualLoop.discardFallback"),
      tv("visualLoop.passRunId", { p0: runId }),
    ].join("\n");
  }

  return [
    tv("visualLoop.continueIntro", { p0: sessionIds }),
    tv("visualLoop.stepsHeader"),
    ...numbered([
      tv("visualLoop.continueStepRender"),
      tv("visualLoop.continueStepViewImage"),
      tv("visualLoop.stepInspectAndReview"),
      tv("visualLoop.stepFixIssues"),
      tv("visualLoop.stepPropose"),
    ]),
    tv("visualLoop.discardFallback"),
    tv("visualLoop.passRunId", { p0: runId }),
  ].join("\n");
}

export function appendVisualLoopWarning(
  summary: string,
  status?: AiEditRunResult["status"],
): string {
  const trimmedSummary = summary.trim();
  const warning = status === "draft"
    ? visualLoopPartialWarning()
    : visualLoopExhaustedWarning();
  return trimmedSummary
    ? `${trimmedSummary}\n\n${warning}`
    : warning;
}

export interface VisualLoopContinuationRequest {
  prompt: string;
  agentThreadId: string | undefined;
}

export type VisualLoopEnforcedResult<T extends AiEditRunResult> = T & {
  exhausted: boolean;
};

/** Remove enforcement-only metadata before returning a result to the renderer. */
export function stripVisualLoopExhausted<T extends AiEditRunResult>(result: VisualLoopEnforcedResult<T>): T {
  const rendererResult = { ...result };
  delete (rendererResult as { exhausted?: boolean }).exhausted;
  return rendererResult as T;
}

/**
 * Runs the provider-neutral continuation policy after one provider turn.
 * Provider adapters supply the actual resumed turn so cancellation and
 * client-specific session semantics remain in their existing modules.
 */
export async function enforceVisualLoop<T extends AiEditRunResult>(args: {
  initialResult: T;
  userDataPath?: string;
  provider: AiEditRunContextProvider;
  runId?: string;
  onEvent: (event: AiEditRunEvent) => void;
  /** True when ai-edit:cancel was requested between provider turns. */
  isCancelRequested?: () => boolean;
  runContinuation: (request: VisualLoopContinuationRequest) => Promise<T>;
}): Promise<VisualLoopEnforcedResult<T>> {
  let result = args.initialResult;
  if (result.status === "cancelled" || !args.userDataPath || !args.runId) {
    return { ...result, exhausted: false };
  }

  let incompleteSessions = await readIncompleteVisualSessions(args.userDataPath, args.provider, args.runId);
  let continuationCount = 0;
  let hadDraft = result.status === "draft";
  let exhausted = false;

  while (incompleteSessions.length > 0 && continuationCount < MAX_VISUAL_LOOP_CONTINUATIONS) {
    if (args.isCancelRequested?.()) {
      return {
        ...buildCancelledVisualLoopResult(result),
        exhausted: false,
      };
    }

    continuationCount += 1;
    emit(args.onEvent, {
      kind: "activity",
      phase: "thinking",
      message: tv("visualLoop.continuingReview", { p0: continuationCount, p1: MAX_VISUAL_LOOP_CONTINUATIONS }),
    });

    try {
      const continuationResult = await args.runContinuation({
        prompt: buildVisualLoopContinuationPrompt(incompleteSessions, args.provider, args.runId),
        agentThreadId: result.agentThreadId,
      });
      if (args.isCancelRequested?.()) {
        return {
          ...buildCancelledVisualLoopResult(continuationResult),
          exhausted: false,
        };
      }
      result = continuationResult;
    } catch {
      emit(args.onEvent, {
        kind: "activity",
        phase: "thinking",
        message: tv("visualLoop.continuationTurnFailed"),
      });
      incompleteSessions = await readIncompleteVisualSessions(args.userDataPath, args.provider, args.runId);
      if (incompleteSessions.length === 0) {
        // The provider may have completed the proposal before a tail transport
        // error discarded the continuation result.
        hadDraft = true;
      } else {
        exhausted = true;
      }
      break;
    }
    if (result.status === "cancelled") {
      return { ...result, exhausted: false };
    }
    hadDraft = hadDraft || result.status === "draft";
    incompleteSessions = await readIncompleteVisualSessions(args.userDataPath, args.provider, args.runId);
  }

  exhausted = exhausted || incompleteSessions.length > 0;
  if (exhausted) {
    const finalStatus = hadDraft || result.status === "draft" ? "draft" : result.status;
    emit(args.onEvent, {
      kind: "activity",
      phase: "complete",
      message: tv("visualLoop.endedWithoutPassing"),
    });
    return {
      ...result,
      status: finalStatus,
      draft: {
        ...result.draft,
        summary: appendVisualLoopWarning(result.draft.summary, finalStatus),
      },
      exhausted: true,
    } as VisualLoopEnforcedResult<T>;
  }

  // A later resumed turn can be classified as an answer even though an
  // earlier turn used a write-capable MCP tool. Preserve the aggregate status.
  if (hadDraft && result.status !== "draft") {
    return { ...result, status: "draft", exhausted: false } as VisualLoopEnforcedResult<T>;
  }
  return { ...result, exhausted: false };
}

function buildCancelledVisualLoopResult<T extends AiEditRunResult>(result: T): T {
  return {
    ...result,
    draft: {
      ...result.draft,
      summary: tv("run.interruptedByUser"),
      plan: [],
      operations: [],
      warnings: [],
    },
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
    status: "cancelled",
  } as T;
}

function emit(
  onEvent: (event: AiEditRunEvent) => void,
  event: Omit<AiEditRunEvent, "timestamp">,
): void {
  onEvent({ ...event, timestamp: Date.now() });
}

function isVisualSessionStatusSnapshot(value: unknown): value is VisualSessionStatusSnapshot {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.sessionId === "string"
    && (typeof value.targetId === "string" || value.targetId === null)
    && typeof value.operationCount === "number"
    && Number.isFinite(value.operationCount)
    && typeof value.revision === "number"
    && Number.isFinite(value.revision)
    && (typeof value.lastReviewPassed === "boolean" || value.lastReviewPassed === null)
    && typeof value.proposed === "boolean"
    && typeof value.discarded === "boolean";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
