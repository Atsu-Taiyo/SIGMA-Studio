import fs from "node:fs/promises";
import { tv } from "@/lib/ai/validation-locale";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildVisualLoopContinuationPrompt,
  enforceVisualLoop,
  visualLoopExhaustedWarning,
  visualLoopPartialWarning,
  readIncompleteVisualSessions,
  type VisualSessionStatusSnapshot,
} from "./visual-loop-enforcer";
import { runContextDirPath, visualSessionsFileName } from "./ai-edit-run-context";
import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import { sampleDocument } from "@/lib/sample-document";

const tempDirs: string[] = [];

async function createUserDataDir(): Promise<string> {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-visual-loop-"));
  tempDirs.push(userDataPath);
  return userDataPath;
}

async function writeStatusFile(
  userDataPath: string,
  provider: "claude" | "chatgpt" | "antigravity",
  runId: string,
  contents: unknown,
): Promise<void> {
  const directory = runContextDirPath(userDataPath);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, visualSessionsFileName(provider, runId)),
    JSON.stringify(contents),
    "utf8",
  );
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("readIncompleteVisualSessions", () => {
  it("returns only sessions with operations that are neither proposed nor discarded", async () => {
    const userDataPath = await createUserDataDir();
    const incomplete: VisualSessionStatusSnapshot = {
      sessionId: "visual_incomplete",
      targetId: "block_1",
      operationCount: 2,
      revision: 2,
      lastReviewPassed: false,
      proposed: false,
      discarded: false,
    };
    await writeStatusFile(userDataPath, "chatgpt", "run_1", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [
        incomplete,
        { ...incomplete, sessionId: "visual_empty", operationCount: 0 },
        { ...incomplete, sessionId: "visual_proposed", proposed: true },
        { ...incomplete, sessionId: "visual_discarded", discarded: true },
      ],
    });

    await expect(readIncompleteVisualSessions(userDataPath, "chatgpt", "run_1")).resolves.toEqual([incomplete]);
  });

  it("returns an empty list for a missing file or malformed JSON", async () => {
    const userDataPath = await createUserDataDir();

    await expect(readIncompleteVisualSessions(userDataPath, "claude", "missing")).resolves.toEqual([]);

    const directory = runContextDirPath(userDataPath);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, visualSessionsFileName("claude", "broken")),
      "{not-json",
      "utf8",
    );
    await expect(readIncompleteVisualSessions(userDataPath, "claude", "broken")).resolves.toEqual([]);
  });
});

describe("buildVisualLoopContinuationPrompt", () => {
  const sessions: VisualSessionStatusSnapshot[] = [{
    sessionId: "visual_123",
    targetId: "block_1",
    operationCount: 1,
    revision: 1,
    lastReviewPassed: false,
    proposed: false,
    discarded: false,
  }];

  it("contains the required continuation steps and runId", () => {
    const prompt = buildVisualLoopContinuationPrompt(sessions, "chatgpt", "run_123");

    expect(prompt).toContain("visual edit session visual_123");
    expect(prompt).toContain("render_visual_edit_session");
    expect(prompt).toContain("previewFile");
    expect(prompt).toContain("view_image");
    expect(prompt).toContain("inspect_visual_edit_session");
    expect(prompt).toContain("review_visual_edit_session");
    expect(prompt).toContain("propose_visual_edit_session");
    expect(prompt).toContain("discard_visual_edit_session");
    expect(prompt).toContain("run_123");
  });

  it("mentions view_image only for ChatGPT", () => {
    expect(buildVisualLoopContinuationPrompt(sessions, "claude", "run_claude")).not.toContain("view_image");
    expect(buildVisualLoopContinuationPrompt(sessions, "antigravity", "run_gemini")).not.toContain("view_image");
  });

  it.each(["claude", "antigravity"] as const)(
    "starts a fresh visual session for %s instead of rendering the old session",
    (provider) => {
      const prompt = buildVisualLoopContinuationPrompt(sessions, provider, `run_${provider}`);

      expect(prompt).toContain("begin_visual_edit_session");
      expect(prompt).not.toContain("visual_123");
      expect(prompt).not.toMatch(/render_visual_edit_session[^\n]*visual_123/);
    },
  );
});

describe("visual-session status snapshots", () => {
  it("treats a rewritten status file as a full snapshot and removes old incomplete entries", async () => {
    const userDataPath = await createUserDataDir();
    const oldSession: VisualSessionStatusSnapshot = {
      sessionId: "visual_old",
      targetId: "block_1",
      operationCount: 1,
      revision: 1,
      lastReviewPassed: false,
      proposed: false,
      discarded: false,
    };
    const newSession = { ...oldSession, sessionId: "visual_new", targetId: "block_2" };

    await writeStatusFile(userDataPath, "claude", "run_rewritten", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [oldSession],
    });
    await writeStatusFile(userDataPath, "claude", "run_rewritten", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [newSession],
    });

    await expect(readIncompleteVisualSessions(userDataPath, "claude", "run_rewritten"))
      .resolves.toEqual([newSession]);
  });
});

function createRunResult(status: "draft" | "answer"): AiEditRunResult {
  return {
    draft: {
      summary: `${status} summary`,
      plan: [],
      operations: [],
      warnings: [],
    },
    nextDocument: sampleDocument,
    operationResults: [],
    logs: [],
    repaired: false,
    changedIds: [],
    status,
    agentThreadId: "thread_visual_loop",
    runtime: "codex-mcp",
  };
}

function incompleteSession(): VisualSessionStatusSnapshot {
  return {
    sessionId: "visual_incomplete",
    targetId: "block_1",
    operationCount: 1,
    revision: 1,
    lastReviewPassed: false,
    proposed: false,
    discarded: false,
  };
}

describe("enforceVisualLoop", () => {
  it.each([
    { status: "draft" as const, warning: visualLoopPartialWarning() },
    { status: "answer" as const, warning: visualLoopExhaustedWarning() },
  ])("appends the %s-specific exhaustion warning", async ({ status, warning }) => {
    const userDataPath = await createUserDataDir();
    await writeStatusFile(userDataPath, "chatgpt", "run_exhausted", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [incompleteSession()],
    });
    const events: AiEditRunEvent[] = [];

    const result = await enforceVisualLoop({
      initialResult: createRunResult(status),
      userDataPath,
      provider: "chatgpt",
      runId: "run_exhausted",
      onEvent: (event) => events.push(event),
      runContinuation: async () => createRunResult(status),
    });

    expect(result.exhausted).toBe(true);
    expect(result.status).toBe(status);
    expect(result.draft.summary).toContain(warning);
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビューが未完了のため続行します (1/3)",
      }),
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビュー未合格のまま終了しました",
      }),
    ]));
  });

  it("keeps the current result and appends the warning when a continuation fails", async () => {
    const userDataPath = await createUserDataDir();
    await writeStatusFile(userDataPath, "chatgpt", "run_failed", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [incompleteSession()],
    });
    const initialResult = createRunResult("draft");
    const events: AiEditRunEvent[] = [];
    let continuationCalls = 0;

    const result = await enforceVisualLoop({
      initialResult,
      userDataPath,
      provider: "chatgpt",
      runId: "run_failed",
      onEvent: (event) => events.push(event),
      runContinuation: async () => {
        continuationCalls += 1;
        throw new Error("continuation failed");
      },
    });

    expect(continuationCalls).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(result.status).toBe("draft");
    expect(result.draft.summary).toContain(initialResult.draft.summary);
    expect(result.draft.summary).toContain(visualLoopPartialWarning());
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビューの継続ターンに失敗しました",
      }),
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビュー未合格のまま終了しました",
      }),
    ]));
  });

  it("treats a continuation transport error as success when all sessions were proposed", async () => {
    const userDataPath = await createUserDataDir();
    const runId = "run_proposed_before_transport_error";
    await writeStatusFile(userDataPath, "chatgpt", runId, {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [incompleteSession()],
    });
    const events: AiEditRunEvent[] = [];

    const result = await enforceVisualLoop({
      initialResult: createRunResult("answer"),
      userDataPath,
      provider: "chatgpt",
      runId,
      onEvent: (event) => events.push(event),
      runContinuation: async () => {
        await writeStatusFile(userDataPath, "chatgpt", runId, {
          version: 1,
          updatedAt: new Date().toISOString(),
          sessions: [{ ...incompleteSession(), proposed: true }],
        });
        throw new Error("tail transport error after proposal");
      },
    });

    expect(result.exhausted).toBe(false);
    expect(result.status).toBe("draft");
    expect(result.draft.summary).not.toContain(visualLoopExhaustedWarning());
    expect(result.draft.summary).not.toContain(visualLoopPartialWarning());
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビューの継続ターンに失敗しました",
      }),
    ]));
    expect(events).not.toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: "activity",
        message: "視覚レビュー未合格のまま終了しました",
      }),
    ]));
  });

  it("returns a cancelled result without starting a continuation when cancellation was requested between turns", async () => {
    const userDataPath = await createUserDataDir();
    await writeStatusFile(userDataPath, "chatgpt", "run_inter_turn_cancel", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [incompleteSession()],
    });
    const initialResult = createRunResult("draft");
    let continuationCalls = 0;

    const result = await enforceVisualLoop({
      initialResult,
      userDataPath,
      provider: "chatgpt",
      runId: "run_inter_turn_cancel",
      onEvent: () => {},
      isCancelRequested: () => true,
      runContinuation: async () => {
        continuationCalls += 1;
        return createRunResult("draft");
      },
    });

    expect(continuationCalls).toBe(0);
    expect(result.status).toBe("cancelled");
    expect(result.exhausted).toBe(false);
    expect(result.draft.summary).toBe(tv("run.interruptedByUser"));
  });

  it("returns a cancelled result when cancellation is requested while continuation resolves", async () => {
    const userDataPath = await createUserDataDir();
    await writeStatusFile(userDataPath, "chatgpt", "run_resolve_cancel", {
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [incompleteSession()],
    });
    let cancelRequested = false;
    let continuationCalls = 0;

    const result = await enforceVisualLoop({
      initialResult: createRunResult("draft"),
      userDataPath,
      provider: "chatgpt",
      runId: "run_resolve_cancel",
      onEvent: () => {},
      isCancelRequested: () => cancelRequested,
      runContinuation: async () => {
        continuationCalls += 1;
        cancelRequested = true;
        return createRunResult("answer");
      },
    });

    expect(continuationCalls).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.exhausted).toBe(false);
    expect(result.draft.summary).toBe(tv("run.interruptedByUser"));
  });
});
