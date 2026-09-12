import { createCanvas } from "@napi-rs/canvas";
import { CodexGeneratedImageStore } from "./codex-generated-images";
import { createTranslator } from "@/lib/i18n";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MAX_REFUSAL_CONTINUATIONS, runAiEditForIpc } from "./ai-edit";
import type {
  CodexAppServerClient,
  CodexRunTurnParams,
  CodexStatus,
  CodexThreadResult,
  CodexTurnResult,
} from "./codex-app-server-client";
import { attachedFileDefaultInstruction, imageToSigmaDocDefaultInstruction } from "@/lib/ai/ai-edit-runtime";
import { buildMcpRefusedOperationContinuationPrompt, buildMcpEditInvariantGuidance } from "@/lib/ai/mcp-edit-prompt";
import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import type { SigmaDocument } from "@/types/sigma-doc";
import { runContextDirPath, visualSessionsFileName } from "./ai-edit-run-context";

/** プロンプトの既存アサートは日本語のまま維持する (locale を明示する)。 */
const tJa = createTranslator("ja", "prompt");

type NotificationHandler = NonNullable<CodexRunTurnParams["onNotification"]>;

type FakeTurnOutcome = string | Omit<CodexTurnResult, "threadId" | "turnId">;

interface FakeTurnBehavior {
  (params: CodexRunTurnParams): Promise<FakeTurnOutcome> | FakeTurnOutcome;
}

function createFakeCodex({
  turn,
  startThread,
  resumeThread,
  status,
}: {
  turn: FakeTurnBehavior;
  startThread?: (model?: string | null, reasoningEffort?: string | null, developerInstructions?: string | null) => Promise<CodexThreadResult>;
  resumeThread?: (threadId: string) => Promise<CodexThreadResult>;
  status?: Partial<CodexStatus>;
}): CodexAppServerClient {
  const codex = {
    getStatus: async (): Promise<CodexStatus> => ({
      available: true,
      running: true,
      loggedIn: true,
      codexHome: "/tmp/codex-home",
      codexBin: "codex",
      configuredCodexBin: null,
      account: { type: "chatgpt", email: "teacher@example.com" },
      error: null,
      ...status,
    }),
    startThread: startThread ?? (async () => ({ threadId: "thread_1" })),
    resumeThread: resumeThread ?? (async (threadId: string) => ({ threadId })),
    runTurn: async (params: CodexRunTurnParams): Promise<CodexTurnResult> => {
      const outcome = await turn(params);
      if (typeof outcome === "string") {
        return { threadId: params.threadId, turnId: "turn_1", finalText: outcome };
      }
      return { threadId: params.threadId, turnId: "turn_1", ...outcome };
    },
  };
  return codex as unknown as CodexAppServerClient;
}

function createDocument(): SigmaDocument {
  return {
    version: "2.0",
    docId: "doc_ai_edit_ipc_mcp_test",
    metadata: { title: "AI edit IPC MCP test" },
    content: [
      {
        type: "paragraph",
        id: "p_1",
        children: [{ type: "text", text: "本文" }],
      },
    ],
    outputProfiles: {
      student: { showSolutions: false, showHints: false },
      teacher: { showSolutions: true, showHints: true },
      answerBook: { onlySolutions: true, includeAnswers: true },
    },
  };
}

function mcpToolCallItem(id: string, tool: string) {
  return { id, type: "mcpToolCall", server: "sigma-studio-local", tool };
}

const visualLoopTempDirs: string[] = [];

async function createIncompleteVisualSessionStatus(): Promise<{
  userDataPath: string;
  runId: string;
}> {
  const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-edit-visual-loop-"));
  visualLoopTempDirs.push(userDataPath);
  const runId = "run_ai_edit_visual_exhausted";
  const directory = runContextDirPath(userDataPath);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, visualSessionsFileName("chatgpt", runId)),
    JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{
        sessionId: "visual_ai_edit_incomplete",
        targetId: "block_1",
        operationCount: 1,
        revision: 1,
        lastReviewPassed: false,
        proposed: false,
        discarded: false,
      }],
    }),
    "utf8",
  );
  return { userDataPath, runId };
}

afterEach(async () => {
  await Promise.all(visualLoopTempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("runAiEditForIpc", () => {
  it("returns a codex-mcp draft result without mutating the source document on the happy path", async () => {
    const document = createDocument();
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_shape") } });
        params.onNotification?.({ method: "item/completed", params: { item: mcpToolCallItem("item_1", "insert_shape") } });
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_2", "insert_table") } });
        params.onNotification?.({ method: "item/completed", params: { item: mcpToolCallItem("item_2", "insert_table") } });
        return "編集を完了しました。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "図形と表を追加して",
        document,
        fileId: "file_1",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    });

    expect(result.runtime).toBe("codex-mcp");
    expect(result.status).toBe("draft");
    expect(result.draft.summary).toBe("編集を完了しました。");
    expect(result.draft.operations).toEqual([]);
    expect(result.nextDocument).toBe(document);
    expect(document.content).toHaveLength(1);
    expect(result.agentThreadId).toBe("thread_1");
    expect(capturedParams[0]).not.toHaveProperty("outputSchema");
    expect(capturedParams[0]).not.toHaveProperty("dynamicToolHandler");
  });

  it("resolves with status cancelled (not an error) when the codex client reports the turn was cancelled", async () => {
    const document = createDocument();
    const codex = {
      getStatus: async (): Promise<CodexStatus> => ({
        available: true,
        running: true,
        loggedIn: true,
        codexHome: "/tmp/codex-home",
        codexBin: "codex",
        configuredCodexBin: null,
        account: { type: "chatgpt", email: "teacher@example.com" },
        error: null,
      }),
      startThread: async () => ({ threadId: "thread_cancelled" }),
      resumeThread: async (threadId: string) => ({ threadId }),
      runTurn: async (params: CodexRunTurnParams): Promise<CodexTurnResult> => ({
        threadId: params.threadId,
        turnId: "turn_cancelled",
        finalText: "",
        cancelled: true,
      }),
    } as unknown as CodexAppServerClient;

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "図形を追加して", document, fileId: "file_1", selectedId: "p_1" },
      onEvent: () => undefined,
      runId: "run_codex_cancel_test",
    });

    expect(result.status).toBe("cancelled");
    expect(result.runtime).toBe("codex-mcp");
    expect(result.nextDocument).toBe(document);
  });

  it("threads runId into the prompt so the agent can pass it back on app-context tool calls", async () => {
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        return "編集を完了しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "図形を追加して",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
      runId: "run_codex_123",
    });

    const textInput = capturedParams[0]?.input.find((item) => item.type === "text");
    expect(textInput && "text" in textInput ? textInput.text : undefined).toContain("run_codex_123");
    expect(textInput && "text" in textInput ? textInput.text : undefined).toContain("runId");
    // Also forwarded as a structured runTurn param (not just in the prompt
    // text), so CodexAppServerClient.cancelByRunId can find this turn.
    expect(capturedParams[0]?.runId).toBe("run_codex_123");
  });

  it("returns status answer when no mcpToolCall item is emitted", async () => {
    const codex = createFakeCodex({
      turn: async () => "SigmaDocは教材の正本として保存するJSON形式です。",
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "SigmaDocって何？",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    });

    expect(result.status).toBe("answer");
    expect(result.draft.operations).toEqual([]);
  });

  it("returns status answer (not draft) when only read-only mcpToolCall items are emitted", async () => {
    const codex = createFakeCodex({
      turn: async (params) => {
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "read_local_document") } });
        params.onNotification?.({ method: "item/completed", params: { item: mcpToolCallItem("item_1", "read_local_document") } });
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_2", "get_document_outline") } });
        return "教材の構成を確認しました。特に変更は不要です。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "この教材の構成を教えて",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    });

    expect(result.status).toBe("answer");
    expect(result.draft.operations).toEqual([]);
  });

  it("returns status draft when a write-capable mcpToolCall item is emitted", async () => {
    const codex = createFakeCodex({
      turn: async (params) => {
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "read_local_document") } });
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_2", "insert_content") } });
        return "本文を追加しました。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "本文を追加して",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    });

    expect(result.status).toBe("draft");
  });

  it("uses a visual-review failure completion message when the enforced loop is exhausted", async () => {
    const document = createDocument();
    const { userDataPath, runId } = await createIncompleteVisualSessionStatus();
    const events: AiEditRunEvent[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_shape") } });
        return "図形の編集を試みました。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "図形を追加して",
        document,
        fileId: "file_1",
      },
      onEvent: (event) => events.push(event),
      runId,
      userDataPath,
    });

    const completeEvent = events.find(
      (event) => event.kind === "phase" && event.phase === "complete" && event.message.includes("視覚レビュー"),
    );
    expect(completeEvent?.message).toBe("応答が完了しました。視覚レビューは未合格です。");
    expect(events.some((event) => event.message === "編集案を作成しました。プレビューで確認してください。")).toBe(false);
    expect(result.draft.summary).toContain("一部の図形編集は視覚レビュー未合格のため提案化されていません。");
  });

  it("keeps the run going with an MCP-only continuation turn after a forbidden operation is refused", async () => {
    const events: AiEditRunEvent[] = [];
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        if (capturedParams.length === 1) {
          params.onNotification?.({ method: "item/started", params: { item: { id: "item_cmd_1", type: "commandExecution" } } });
          params.onRefusal?.("commandExecution", "item_cmd_1");
          return { finalText: "", refusedItemTypes: ["commandExecution"] };
        }
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_body_content") } });
        return "本文を追加しました。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: (event) => events.push(event),
      runId: "run_refusal_1",
    });

    expect(capturedParams).toHaveLength(2);
    const continuationInput = capturedParams[1]?.input.find((item) => item.type === "text");
    expect(continuationInput && "text" in continuationInput ? continuationInput.text : "")
      .toBe(buildMcpRefusedOperationContinuationPrompt(["commandExecution"], "run_refusal_1", tJa));
    expect(result.status).toBe("draft");
    expect(result.draft.summary).toBe("本文を追加しました。");
    expect(result.draft.summary).not.toContain("許可されていない");
    // 拒否は黙って握り潰さず、活動ログに残す。
    const refusalActivity = events.findLast(
      (event) => event.kind === "activity" && event.itemType === "commandExecution",
    );
    expect(refusalActivity?.message).toBe("ローカルコマンドの実行は許可されていないため拒否しました");
    expect(refusalActivity?.itemStatus).toBe("completed");
    // 同じitemIdで閉じるので、item/startedで開いた「実行中...」行が回りっぱなしにならない。
    expect(refusalActivity?.itemId).toBe("item_cmd_1");
  });

  it("gives up after the refusal continuation budget and warns in the summary instead of failing", async () => {
    const events: AiEditRunEvent[] = [];
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        params.onRefusal?.("commandExecution");
        params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem(`item_${capturedParams.length}`, "insert_body_content") } });
        return { finalText: "シェルが使えませんでした。", refusedItemTypes: ["commandExecution"] };
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: (event) => events.push(event),
    });

    expect(capturedParams).toHaveLength(1 + MAX_REFUSAL_CONTINUATIONS);
    expect(result.status).toBe("draft");
    expect(result.draft.summary).toContain("シェルが使えませんでした。");
    expect(result.draft.summary).toContain("一部の操作は許可されていないため実行しませんでした。");
    expect(events.some((event) => event.kind === "phase" && event.phase === "complete")).toBe(true);
  });

  it("labels every refused operation type, falling back to the raw type for unknown ones", async () => {
    const events: AiEditRunEvent[] = [];
    let call = 0;
    const codex = createFakeCodex({
      turn: async (params) => {
        call += 1;
        params.onRefusal?.(call === 1 ? "imageGeneration" : "somethingNew");
        return { finalText: "拒否されました。", refusedItemTypes: ["imageGeneration"] };
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "画像を作って", document: createDocument(), fileId: "file_1" },
      onEvent: (event) => events.push(event),
    });

    const messages = events.filter((event) => event.kind === "activity").map((event) => event.message);
    expect(messages).toContain("画像生成は許可されていないため拒否しました");
    expect(messages).toContain("この操作 (somethingNew)は許可されていないため拒否しました");
    expect(events.find((event) => event.message === "この操作 (somethingNew)は許可されていないため拒否しました")?.itemType)
      .toBe("other");
  });

  it("stops the refusal continuation loop when cancellation is requested between turns", async () => {
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        params.onRefusal?.("commandExecution");
        return { finalText: "中断されました。", refusedItemTypes: ["commandExecution"] };
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
      isCancelRequested: () => true,
    });

    expect(capturedParams).toHaveLength(1);
    // ターン間のキャンセルは cancelByRunId が捕まえられないので、ここで cancelled として確定させる。
    expect(result.status).toBe("cancelled");
    expect(result.draft.summary).toBe("ユーザーの操作により中断しました。");
  });

  it("reports a refusal that happens inside a visual-review continuation turn", async () => {
    const { userDataPath, runId } = await createIncompleteVisualSessionStatus();
    let call = 0;
    const codex = createFakeCodex({
      turn: async (params) => {
        call += 1;
        if (call === 1) {
          params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_shape") } });
          return "図形の編集を試みました。";
        }
        params.onRefusal?.("commandExecution", `item_cmd_${call}`);
        return { finalText: "続きを試みました。", refusedItemTypes: ["commandExecution"] };
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "図形を追加して", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
      runId,
      userDataPath,
    });

    expect(call).toBeGreaterThan(1);
    expect(result.draft.summary).toContain("一部の操作は許可されていないため実行しませんでした。");
  });

  it("keeps the refused turn's result when the continuation turn itself throws", async () => {
    const events: AiEditRunEvent[] = [];
    let call = 0;
    const codex = createFakeCodex({
      turn: async (params) => {
        call += 1;
        if (call === 1) {
          params.onRefusal?.("commandExecution");
          params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_body_content") } });
          return { finalText: "途中まで作りました。", refusedItemTypes: ["commandExecution"] };
        }
        throw new Error("transport died");
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("draft");
    expect(result.draft.summary).toContain("途中まで作りました。");
    expect(result.draft.summary).toContain("一部の操作は許可されていないため実行しませんでした。");
    expect(events.some((event) => event.message === "拒否後の継続ターンに失敗しました")).toBe(true);
  });

  it("returns a cancelled result when the refusal continuation turn is cancelled", async () => {
    let call = 0;
    const codex = createFakeCodex({
      turn: async (params) => {
        call += 1;
        if (call === 1) {
          params.onRefusal?.("commandExecution");
          return { finalText: "", refusedItemTypes: ["commandExecution"] };
        }
        return { finalText: "", cancelled: true };
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
    });

    expect(call).toBe(2);
    expect(result.status).toBe("cancelled");
  });

  it("surfaces a retryable reconnect as an activity row instead of failing the run", async () => {
    const events: AiEditRunEvent[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        params.onNotification?.({ method: "error", params: { error: { message: "Reconnecting... 2/5" } } });
        return "再接続後に完了しました。";
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "グラフを書いて", document: createDocument(), fileId: "file_1" },
      onEvent: (event) => events.push(event),
    });

    expect(result.status).toBe("answer");
    expect(events.some((event) => event.kind === "activity" && event.message === "接続を再確立しています (2/5)")).toBe(true);
  });

  it("rejects with a Japanese error when fileId is missing or blank", async () => {
    const codex = createFakeCodex({ turn: async () => "ok" });

    await expect(runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "補足を追加して",
        document: createDocument(),
        fileId: "  ",
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    })).rejects.toThrow("Codexでの編集には教材ファイルが必要です。");

    await expect(runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "補足を追加して",
        document: createDocument(),
        selectedId: "p_1",
      },
      onEvent: () => undefined,
    })).rejects.toThrow("Codexでの編集には教材ファイルが必要です。");
  });

  it("preserves login/availability gating", async () => {
    const unavailableCodex = createFakeCodex({
      turn: async () => "ok",
      status: { available: false, error: "`codex` コマンドが見つかりません。" },
    });
    await expect(runAiEditForIpc({ locale: "ja",
      codex: unavailableCodex,
      payload: { instruction: "編集して", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
    })).rejects.toThrow("`codex` コマンドが見つかりません。");

    const loggedOutCodex = createFakeCodex({
      turn: async () => "ok",
      status: { loggedIn: false },
    });
    await expect(runAiEditForIpc({ locale: "ja",
      codex: loggedOutCodex,
      payload: { instruction: "編集して", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
    })).rejects.toThrow("ログインしていません");
  });

  it("fills the image reconstruction instruction and caps images at 4 for image-only payloads", async () => {
    const runPrompts: string[] = [];
    let capturedInput: CodexRunTurnParams["input"] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedInput = params.input;
        const text = params.input.find((item) => item.type === "text");
        runPrompts.push(text && "text" in text ? text.text : "");
        return "画像から本文を再構成しました。";
      },
    });

    const attachments = Array.from({ length: 6 }, (_, index) => ({
      id: `att_${index}`,
      name: `worksheet_${index}.png`,
      mimeType: "image/png",
      dataUrl: "data:image/png;base64,AAA",
      width: 640,
      height: 480,
      fileSize: 1024,
    }));

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
        attachments,
      },
      onEvent: () => undefined,
    });

    expect(runPrompts[0]).toContain(imageToSigmaDocDefaultInstruction());
    const imageInputs = capturedInput.filter((item) => item.type === "image");
    expect(imageInputs).toHaveLength(4);
    expect(result.status).toBe("answer");
  });

  it("accepts an arbitrary attachment without typed instruction and tells Codex to fetch its content", async () => {
    let capturedInput: CodexRunTurnParams["input"] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedInput = params.input;
        return "PDFを確認しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "",
        document: createDocument(),
        fileId: "file_1",
        attachments: [{
          id: "att_pdf",
          name: "worksheet.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERg==",
        }],
      },
      onEvent: () => undefined,
    });

    const text = capturedInput.find((item) => item.type === "text");
    expect(text && "text" in text ? text.text : "").toContain(attachedFileDefaultInstruction());
    expect(text && "text" in text ? text.text : "").toContain("worksheet.pdf");
    expect(capturedInput.filter((item) => item.type === "image")).toHaveLength(0);
  });

  it("resumes a thread, falls back to a fresh start on resume failure, and sends the shared invariant guidance as developerInstructions", async () => {
    const developerInstructionsSeen: Array<string | null | undefined> = [];
    const codex = createFakeCodex({
      turn: async () => "ok",
      resumeThread: async () => {
        throw new Error("stale thread");
      },
      startThread: async (_model, _effort, developerInstructions) => {
        developerInstructionsSeen.push(developerInstructions);
        return { threadId: "thread_fresh" };
      },
    });

    const result = await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "編集して",
        document: createDocument(),
        fileId: "file_1",
        agentThreadId: "thread_stale",
      },
      onEvent: () => undefined,
    });

    expect(result.agentThreadId).toBe("thread_fresh");
    expect(developerInstructionsSeen[0]).toBe([buildMcpEditInvariantGuidance(tJa, "app"), tJa("generatedImages.guide")].join("\n\n"));
  });

  it("maps mcpToolCall/plan/reasoning notifications to run events and tolerates unknown item types", async () => {
    const events: AiEditRunEvent[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        const onNotification = params.onNotification as NotificationHandler;
        onNotification({ method: "item/reasoning/textDelta", params: { delta: "考え中" } });
        onNotification({
          method: "turn/plan/updated",
          params: { plan: [{ step: "図形を追加する", status: "inProgress" }] },
        });
        onNotification({ method: "item/started", params: { item: mcpToolCallItem("item_1", "insert_shape") } });
        onNotification({ method: "item/started", params: { item: { id: "item_x", type: "somethingNew" } } });
        return "完了しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "図形を追加して",
        document: createDocument(),
        fileId: "file_1",
      },
      onEvent: (event) => events.push(event),
    });

    const activity = events.find((event) => event.kind === "activity" && event.itemType === "mcpToolCall");
    expect(activity?.message).toBe("ツール実行中... (insert_shape)");
    expect(activity?.itemId).toBe("item_1");
    expect(events.some((event) => event.kind === "plan")).toBe(true);
    expect(events.some((event) => event.kind === "stream" && event.channel === "reasoning")).toBe(true);
    expect(events.some((event) => event.itemType === "other")).toBe(true);
  });

  it("only forwards claude/codex-allowlisted image mime types to the codex turn, dropping svg attachments", async () => {
    let capturedInput: CodexRunTurnParams["input"] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedInput = params.input;
        return "画像を確認しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "この画像を教材化して",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
        attachments: [
          { id: "png", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
          { id: "svg", name: "b.svg", mimeType: "image/svg+xml", dataUrl: "data:image/svg+xml;base64,BBBB" },
          { id: "webp", name: "c.webp", mimeType: "image/webp", dataUrl: "data:image/webp;base64,CCCC" },
        ],
      },
      onEvent: () => undefined,
    });

    const imageInputs = capturedInput.filter((item) => item.type === "image") as Array<{ type: "image"; url: string }>;
    expect(imageInputs.map((item) => item.url)).toEqual([
      "data:image/png;base64,AAAA",
      "data:image/webp;base64,CCCC",
    ]);
  });

  it("appends the mentionedDocuments hint with count and titles to the turn prompt", async () => {
    const runPrompts: string[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        const text = params.input.find((item) => item.type === "text");
        runPrompts.push(text && "text" in text ? text.text : "");
        return "確認しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "この教材を参考に解説を書いて",
        document: createDocument(),
        fileId: "file_1",
        selectedId: "p_1",
        mentionedDocuments: [
          { id: "m1", fileId: "file_other", title: "参考教材A", documentPath: "/a.json", revision: 1, excerpt: "e", document: createDocument() },
        ],
      },
      onEvent: () => undefined,
    });

    expect(runPrompts[0]).toContain("メンションされた教材が1件あります");
    expect(runPrompts[0]).toContain("参考教材A");
  });

  it("formats and includes the selection reference instead of a bare block id", async () => {
    const runPrompts: string[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        const text = params.input.find((item) => item.type === "text");
        runPrompts.push(text && "text" in text ? text.text : "");
        return "確認しました。";
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "この文を書き直して",
        document: createDocument(),
        fileId: "file_1",
        references: [{
          kind: "textSelection",
          targetId: "p_1",
          targetType: "paragraph",
          excerpt: "二次関数の最大値を求めよ",
          selectedText: "二次関数の最大値を求めよ",
          mathTex: [],
        }],
      },
      onEvent: () => undefined,
    });

    expect(runPrompts[0]).toContain("ユーザーの選択コンテキスト:");
    expect(runPrompts[0]).toContain("二次関数の最大値を求めよ");
  });

  it("forwards a per-run cwd override to startThread and runTurn", async () => {
    const startThreadCwds: Array<string | null | undefined> = [];
    const capturedParams: CodexRunTurnParams[] = [];
    const codex = createFakeCodex({
      turn: async (params) => {
        capturedParams.push(params);
        return "ok";
      },
      startThread: async (_model, _effort, _developerInstructions, cwd?: string | null) => {
        startThreadCwds.push(cwd);
        return { threadId: "thread_cwd_test" };
      },
    });

    await runAiEditForIpc({ locale: "ja",
      codex,
      payload: { instruction: "編集して", document: createDocument(), fileId: "file_1" },
      onEvent: () => undefined,
      cwd: "/data/agent-workspaces/ws_1/codex",
    });

    expect(startThreadCwds[0]).toBe("/data/agent-workspaces/ws_1/codex");
    expect(capturedParams[0]?.cwd).toBe("/data/agent-workspaces/ws_1/codex");
  });

  it("rejects when the turn fails", async () => {
    const codex = createFakeCodex({
      turn: async (params) => {
        params.onNotification?.({
          method: "error",
          params: { error: { message: "Codex turnでエラーが発生しました。" } },
        });
        throw new Error("Codex turnでエラーが発生しました。");
      },
    });

    await expect(runAiEditForIpc({ locale: "ja",
      codex,
      payload: {
        instruction: "編集して",
        document: createDocument(),
        fileId: "file_1",
      },
      onEvent: () => undefined,
    })).rejects.toThrow("Codex turnでエラーが発生しました。");
  });
});

describe("Codex image generation in AI chat", () => {
  it("does not report a failed generated image write as a draft", async () => {
    const codex = createFakeCodex({ turn: async (params) => {
      params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("insert", "insert_generated_image") } });
      params.onNotification?.({ method: "item/completed", params: { item: { ...mcpToolCallItem("insert", "insert_generated_image"), status: "completed", result: { isError: true, structuredContent: { ok: false } } } } });
      return "画像を挿入できませんでした。";
    } });
    const result = await runAiEditForIpc({ codex, payload: { document: createDocument(), fileId: "file_1", instruction: "画像を挿入して" }, onEvent: () => {} });
    expect(result.status).toBe("answer");
  });

  it("imports before continuing and counts the generated image insertion as a proposal", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-image-run-"));
    visualLoopTempDirs.push(userDataPath);
    const runId = "image-run";
    const store = new CodexGeneratedImageStore(path.join(userDataPath, "data"));
    const events: AiEditRunEvent[] = [];
    let turns = 0;
    const codex = createFakeCodex({ turn: async (params) => {
      turns += 1;
      if (turns === 1) {
        const item = { type: "imageGeneration", id: "native-image", status: "completed", result: createCanvas(32, 16).toBuffer("image/png").toString("base64") };
        params.onNotification?.({ method: "item/completed", params: { turnId: "turn_1", item } });
        return "画像を生成しました。";
      }
      const records = await store.list(runId);
      expect(records).toHaveLength(1);
      expect(params.input[0]).toMatchObject({ text: expect.stringContaining(records[0].imageId) });
      params.onNotification?.({ method: "item/started", params: { item: mcpToolCallItem("insert", "insert_generated_image") } });
      params.onNotification?.({ method: "item/completed", params: { item: { ...mcpToolCallItem("insert", "insert_generated_image"), status: "completed", result: { structuredContent: { ok: true, data: { proposalCreated: true } } } } } });
      return "生成画像の挿入案を作成しました。";
    } });
    const result = await runAiEditForIpc({ codex, userDataPath, runId, locale: "ja", payload: { document: createDocument(), fileId: "file_1", instruction: "挿絵を生成して挿入して" }, onEvent: (event) => events.push(event) });
    expect(turns).toBe(2);
    expect(result.status).toBe("draft");
    const image = events.find((event) => event.images?.length)?.images?.[0];
    expect(image?.generatedImage).toMatchObject({ runId });
    expect(result.nextDocument).toEqual(createDocument());
  });

  it("does not continue or keep images when cancellation arrives as the turn completes", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-image-cancel-"));
    visualLoopTempDirs.push(userDataPath);
    let cancelled = false;
    let turns = 0;
    const codex = createFakeCodex({ turn: async (params) => {
      turns += 1;
      params.onNotification?.({ method: "item/completed", params: { turnId: "turn_1", item: { type: "imageGeneration", id: "native-image", status: "completed", result: createCanvas(32, 16).toBuffer("image/png").toString("base64") } } });
      cancelled = true;
      return "";
    } });
    const result = await runAiEditForIpc({ codex, userDataPath, runId: "cancel-run", isCancelRequested: () => cancelled, payload: { document: createDocument(), fileId: "file_1", instruction: "画像を生成して" }, onEvent: () => {} });
    expect(result.status).toBe("cancelled");
    expect(turns).toBe(1);
    expect(await new CodexGeneratedImageStore(path.join(userDataPath, "data")).list("cancel-run")).toEqual([]);
  });

  it("reports native image failure without automatically generating again", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-ai-image-fail-"));
    visualLoopTempDirs.push(userDataPath);
    let turns = 0;
    const codex = createFakeCodex({ turn: async (params) => {
      turns += 1;
      params.onNotification?.({ method: "item/completed", params: { turnId: "turn_1", item: { type: "imageGeneration", id: "native-image", status: "failed", failure: { code: "rate_limit" }, result: "" } } });
      return "画像を生成できませんでした。";
    } });
    const result = await runAiEditForIpc({ codex, userDataPath, runId: "fail-run", payload: { document: createDocument(), fileId: "file_1", instruction: "画像を生成して" }, onEvent: () => {} });
    expect(turns).toBe(1);
    expect(result.draft.summary).toContain("生成画像を取り込めませんでした");
  });
});
