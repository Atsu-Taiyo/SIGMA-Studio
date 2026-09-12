import { afterEach, describe, expect, it, vi } from "vitest";

import { runAiEditViaDesktopRuntime } from "@/lib/ai/codex-ai-edit-client";
import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import { DEFAULT_AI_EDIT_MODEL, DEFAULT_AI_EDIT_REASONING_EFFORT } from "@/lib/ai/sigma-doc-edit-schema";
import type { SigmaDocument } from "@/types/sigma-doc";
import { setAppLocale } from "@/lib/i18n";

describe("runAiEditViaDesktopRuntime", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    setAppLocale("ja");
  });

  it("routes AI edit runs through desktopAPI.aiEdit", async () => {
    const document = createDocument();
    const emitted: AiEditRunEvent = {
      kind: "phase",
      phase: "thinking",
      message: "計画中...",
      timestamp: 123,
    };
    const result: AiEditRunResult = {
      draft: {
        summary: "編集案を作成しました。",
        plan: ["選択段落を確認する"],
        operations: [],
        warnings: [],
      },
      nextDocument: document,
      operationResults: [],
      logs: [],
      repaired: false,
      changedIds: [],
      agentThreadId: "thread_codex_1",
      runtime: "codex-mcp",
    };
    const run = vi.fn(async (_payload: unknown, onEvent: (event: unknown) => void) => {
      onEvent(emitted);
      return result;
    });
    const fetch = vi.fn();

    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("window", {
      desktopAPI: {
        aiEdit: { run },
      },
    });

    const events: AiEditRunEvent[] = [];
    await expect(runAiEditViaDesktopRuntime({
      model: DEFAULT_AI_EDIT_MODEL,
      reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
      instruction: "補足を追加して",
      document,
      selectedId: "p_1",
      agentThreadId: "thread_codex_0",
      onEvent: (event) => events.push(event),
    })).resolves.toBe(result);

    expect(run).toHaveBeenCalledWith({
      provider: "chatgpt",
      fileId: null,
      model: DEFAULT_AI_EDIT_MODEL,
      reasoningEffort: DEFAULT_AI_EDIT_REASONING_EFFORT,
      instruction: "補足を追加して",
      document,
      selectedId: "p_1",
      references: [],
      attachments: [],
      mentionedDocuments: [],
      aiResourceIds: [],
      agentThreadId: "thread_codex_0",
    }, expect.any(Function));
    expect(events).toEqual([emitted]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards provider and fileId when routing to Claude", async () => {
    const document = createDocument();
    const run = vi.fn(async () => ({
      draft: { summary: "Claude", plan: [], operations: [], warnings: [] },
      nextDocument: document,
      operationResults: [],
      logs: [],
      repaired: false,
      changedIds: [],
      runtime: "claude-mcp" as const,
    }));
    vi.stubGlobal("window", { desktopAPI: { aiEdit: { run } } });

    await runAiEditViaDesktopRuntime({
      provider: "claude",
      fileId: "file_abc",
      model: "claude-opus-4-8",
      instruction: "本文を追加して",
      document,
      selectedId: "p_1",
    });

    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "claude", fileId: "file_abc", model: "claude-opus-4-8" }),
      expect.any(Function),
    );
  });

  it("does not fall back to a hosted route outside the desktop runtime", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);

    await expect(runAiEditViaDesktopRuntime({
      model: DEFAULT_AI_EDIT_MODEL,
      instruction: "補足を追加して",
      document: createDocument(),
      selectedId: "p_1",
    })).rejects.toThrow("デスクトップ版のCodex Agent");

    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports the desktop-only boundary in English after a locale switch", async () => {
    setAppLocale("en");
    await expect(runAiEditViaDesktopRuntime({
      model: DEFAULT_AI_EDIT_MODEL,
      instruction: "Add context",
      document: createDocument(),
      selectedId: "p_1",
    })).rejects.toThrow("Run AI edits from Codex Agent in the desktop app.");
  });
});

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_ai_edit_api_client_test",
    metadata: { title: "AI Edit API Client Test" },
    content: [
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "元の本文" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}
