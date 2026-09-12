import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runContextDirPath, toolActivityFileName } from "./ai-edit-run-context";
import { buildGeminiEditPrompt, runGeminiEditForIpc } from "./gemini-edit";
import { GeminiResumeUnavailableError } from "./gemini-headless-client";
import type { GeminiHeadlessClient, GeminiRunTurnParams, GeminiStatus, GeminiTurnResult } from "./gemini-headless-client";
import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import type { SigmaDocument } from "@/types/sigma-doc";

const FAKE_DOCUMENT = { docId: "doc_1" } as unknown as SigmaDocument;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeWorkspaceDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "fake-gemini-edit-"));
  tempDirs.push(dir);
  return dir;
}

interface FakeGeminiOptions {
  onTurn?: (params: GeminiRunTurnParams) => void;
  status?: Partial<GeminiStatus>;
  turn?: Partial<GeminiTurnResult>;
  toolUseNames?: string[];
  resumeFailsOnce?: boolean;
  workspaceDir?: string;
  /** getUserDataDir() return value; when set, runGeminiEditForIpc wires up a ToolActivityWatcher. */
  userDataDir?: string;
  /**
   * When set alongside userDataDir, the fake runTurn appends this many JSONL lines to
   * `<runContextDir>/antigravity-<runId>.tool-activity.jsonl` (simulating the shared MCP
   * server's tool-activity logger, see mcp/tool-activity.ts) before resolving, then waits
   * long enough for a short-interval ToolActivityWatcher to have polled at least once.
   */
  toolActivityLines?: Array<{ callId: string; tool: string; status: "started" | "completed" | "failed" }>;
}

function createFakeGemini(options: FakeGeminiOptions = {}): {
  client: GeminiHeadlessClient;
  lastParams: () => GeminiRunTurnParams | null;
  allParams: () => GeminiRunTurnParams[];
} {
  const workspaceDir = options.workspaceDir ?? makeWorkspaceDir();
  const calls: GeminiRunTurnParams[] = [];
  let resumeFailurePending = options.resumeFailsOnce ?? false;
  const client = {
    getWorkspaceDir(): string {
      return workspaceDir;
    },
    getUserDataDir(): string | null {
      return options.userDataDir ?? null;
    },
    async getStatus(): Promise<GeminiStatus> {
      return {
        available: true,
        loggedIn: true,
        geminiBin: "agy",
        configuredGeminiBin: null,
        error: null,
        ...options.status,
      };
    },
    async runTurn(params: GeminiRunTurnParams): Promise<GeminiTurnResult> {
      calls.push(params);
      options.onTurn?.(params);
      if (resumeFailurePending && params.resumeSessionId) {
        resumeFailurePending = false;
        throw new GeminiResumeUnavailableError();
      }
      if (options.toolActivityLines && options.userDataDir && params.runId) {
        const dir = runContextDirPath(options.userDataDir);
        mkdirSync(dir, { recursive: true });
        const filePath = path.join(dir, toolActivityFileName("antigravity", params.runId));
        for (const line of options.toolActivityLines) {
          appendFileSync(filePath, `${JSON.stringify({ ts: Date.now(), runId: params.runId, ...line })}\n`, "utf8");
        }
        // ToolActivityWatcher はポーリング型なので、テストの短いpollIntervalMsが
        // 少なくとも1回発火する時間だけ待ってから応答する。
        await new Promise((resolve) => setTimeout(resolve, 80));
      }
      for (const [index, name] of (options.toolUseNames ?? []).entries()) {
        params.onToolUse?.({ id: `tool_${index}`, name, parameters: {} });
      }
      params.onDelta?.("partial");
      return {
        sessionId: "gsess_test",
        finalText: "編集しました",
        isError: false,
        errorMessage: null,
        blockedToolCount: 0,
        ...options.turn,
      };
    },
  } as unknown as GeminiHeadlessClient;
  return {
    client,
    lastParams: () => calls[calls.length - 1] ?? null,
    allParams: () => calls,
  };
}

describe("buildGeminiEditPrompt", () => {
  it("includes the target fileId, the user instruction, and the MCP server name", () => {
    const prompt = buildGeminiEditPrompt({ locale: "ja", instruction: "三角形を追加して", fileId: "file_abc" });
    expect(prompt).toContain("file_abc");
    expect(prompt).toContain("三角形を追加して");
    expect(prompt).toContain("sigma-studio-local");
  });
});

describe("runGeminiEditForIpc", () => {
  it("rejects with a login hint when gemini is not logged in", async () => {
    const { client } = createFakeGemini({ status: { loggedIn: false } });

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: client,
        payload: { instruction: "edit", fileId: "file_1", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("ログイン");
  });

  it("rejects with an install hint when gemini is unavailable", async () => {
    const { client } = createFakeGemini({ status: { available: false, loggedIn: false, error: "not found" } });

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: client,
        payload: { instruction: "edit", fileId: "file_1", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("not found");
  });

  it("rejects when the fileId is missing", async () => {
    const { client } = createFakeGemini();

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: client,
        payload: { instruction: "edit", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("教材ファイル");
  });

  it("rejects when the document is missing", async () => {
    const { client } = createFakeGemini();

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: client,
        payload: { instruction: "edit", fileId: "file_1" },
        onEvent: () => {},
      }),
    ).rejects.toThrow("ドキュメント");
  });

  it("passes the fileId into the gemini turn instruction", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_xyz", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(fake.lastParams()?.instruction).toContain("file_xyz");
    expect(fake.lastParams()?.instruction).toContain("本文を追加");
  });

  it("threads runId into the prompt so the agent can pass it back on app-context tool calls", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_xyz", document: FAKE_DOCUMENT },
      onEvent: () => {},
      runId: "run_gemini_42",
    });

    expect(fake.lastParams()?.instruction).toContain("run_gemini_42");
    expect(fake.lastParams()?.instruction).toContain("runId");
  });

  it("reuses the passed-in runId for the attachments/<runId> directory instead of minting a fresh one", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "画像を説明して",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        attachments: [
          { id: "a", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
        ],
      },
      onEvent: () => {},
      runId: "run_gemini_attach_1",
    });

    const instruction = fake.lastParams()?.instruction ?? "";
    expect(instruction).toContain("まず get_attached_media の runId に「run_gemini_attach_1」");
    expect(instruction).toContain("Antigravityでは下の @ファイル参照だけに依存しない");
    expect(instruction).toContain("@attachments/run_gemini_attach_1/img-0.png");
  });

  it("returns an antigravity-mcp result with empty operations when a write tool was used", async () => {
    const { client } = createFakeGemini({ toolUseNames: ["mcp_sigma-studio-local_insert_shape"] });
    const events: AiEditRunEvent[] = [];

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: client,
      payload: { instruction: "本文を追加", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: (e) => events.push(e),
    });

    expect(result.runtime).toBe("antigravity-mcp");
    expect(result.draft.operations).toEqual([]);
    expect(result.status).toBe("draft");
    expect(result.agentThreadId).toBe("gsess_test");
    expect(events.some((e) => e.kind === "activity")).toBe(true);
    expect(events.some((e) => e.kind === "stream" && e.delta === "partial")).toBe(true);
  });

  it("returns status answer when no tool was used", async () => {
    const { client } = createFakeGemini();

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: client,
      payload: { instruction: "質問だけ", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("answer");
  });

  it("returns status answer (not draft) when only read-only MCP tools were used", async () => {
    const { client } = createFakeGemini({
      toolUseNames: [
        "mcp_sigma-studio-local_read_local_document",
        "mcp_sigma-studio-local_get_document_outline",
      ],
    });

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: client,
      payload: { instruction: "この教材の構成を教えて", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("answer");
  });

  it("resolves with status cancelled (not an error) when the gemini client reports the turn was cancelled", async () => {
    const { client } = createFakeGemini({ turn: { cancelled: true, finalText: "" } });

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.runtime).toBe("antigravity-mcp");
  });

  it("forwards the runId into the gemini client's runTurn call so it can be cancelled by id", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
      runId: "run_gemini_cancel_test",
    });

    expect(fake.lastParams()?.runId).toBe("run_gemini_cancel_test");
  });

  it("returns status draft when a write-capable MCP tool was used", async () => {
    const { client } = createFakeGemini({
      toolUseNames: [
        "mcp_sigma-studio-local_read_local_document",
        "mcp_sigma-studio-local_edit_problem",
      ],
    });

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: client,
      payload: { instruction: "グラフを追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("draft");
  });

  it("appends the mentionedDocuments hint with count and titles to the prompt", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "この教材を参考に解説を書いて",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        mentionedDocuments: [
          { id: "m1", fileId: "file_other", title: "参考教材A", documentPath: "/a.json", revision: 1, excerpt: "e", document: FAKE_DOCUMENT },
        ],
      },
      onEvent: () => {},
    });

    expect(fake.lastParams()?.instruction).toContain("メンションされた教材が1件あります");
    expect(fake.lastParams()?.instruction).toContain("参考教材A");
  });

  it("makes the original PDF bytes available during the turn and removes the temporary copy afterward", async () => {
    const workspaceDir = makeWorkspaceDir();
    const bytes = Buffer.from("%PDF-1.7\nattachment test");
    const fake = createFakeGemini({ workspaceDir, onTurn: (params) => {
      const reference = params.instruction.split("\n").find((line) => line.startsWith("@attachments/"));
      expect(reference).toMatch(/\.pdf$/);
      expect(readFileSync(path.join(workspaceDir, reference!.slice(1)))).toEqual(bytes);
      expect(params.instruction).toContain("pdf.nextPageStart");
    } });
    await runGeminiEditForIpc({ locale: "ja", gemini: fake.client,
      payload: { fileId: "file_1", document: FAKE_DOCUMENT, attachments: [{
        id: "pdf", name: "worksheet.pdf", mimeType: "application/pdf",
        dataUrl: `data:application/pdf;base64,${bytes.toString("base64")}`,
      }] }, onEvent: () => {},
    });
    expect(fake.allParams()).toHaveLength(1);
    expect(readdirSync(path.join(workspaceDir, "attachments"))).toHaveLength(0);
  });

  it("writes image attachments under workspaceDir/attachments/<runId> and appends @-lines, including PDFs and capping at four", async () => {
    const fake = createFakeGemini();
    const workspaceDir = fake.client.getWorkspaceDir();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "画像多数",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        attachments: [
          { id: "pdf", name: "doc.pdf", mimeType: "application/pdf", dataUrl: "data:application/pdf;base64,PDF" },
          ...Array.from({ length: 6 }, (_, i) => ({
            id: `img${i}`,
            name: `img${i}.png`,
            mimeType: "image/png",
            dataUrl: `data:image/png;base64,${Buffer.from(`IMG${i}`).toString("base64")}`,
          })),
        ],
      },
      onEvent: () => {},
    });

    const instruction = fake.lastParams()?.instruction ?? "";
    expect(instruction).toContain("補助用の添付ファイル参照:");
    const atLines = instruction.split("\n").filter((line) => line.startsWith("@attachments/"));
    expect(atLines).toHaveLength(4);
    expect(atLines[0]).toMatch(/^@attachments\/[^/]+\/pdf-0\.pdf$/);
    expect(atLines[1]).toMatch(/^@attachments\/[^/]+\/img-1\.png$/);

    const attachmentsRoot = path.join(workspaceDir, "attachments");
    expect(readdirSync(attachmentsRoot)).toHaveLength(0);
  });

  it("uses a per-run cwd override for attachments and forwards it to the client's runTurn as workspaceDir", async () => {
    const fake = createFakeGemini();
    const perRunCwd = makeWorkspaceDir();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "画像を説明して",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        attachments: [
          { id: "a", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
        ],
      },
      onEvent: () => {},
      cwd: perRunCwd,
    });

    expect(fake.lastParams()?.workspaceDir).toBe(perRunCwd);
    // 添付ファイルはデフォルトのclient.getWorkspaceDir()ではなく、渡されたcwd配下に書かれる
    // (成功後に削除されるので、削除対象になったこと=このディレクトリに実際に書かれたことを
    // attachmentsルートの存在で確認する)。
    expect(readdirSync(path.join(perRunCwd, "attachments"))).toHaveLength(0);
  });

  it("cleans up attachment files after a failed turn", async () => {
    const fake = createFakeGemini({ turn: { isError: true, errorMessage: "boom" } });
    const workspaceDir = fake.client.getWorkspaceDir();

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: fake.client,
        payload: {
          instruction: "画像を説明して",
          fileId: "file_1",
          document: FAKE_DOCUMENT,
          attachments: [
            { id: "a", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
          ],
        },
        onEvent: () => {},
      }),
    ).rejects.toThrow("boom");

    const attachmentsRoot = path.join(workspaceDir, "attachments");
    expect(readdirSync(attachmentsRoot)).toHaveLength(0);
  });

  it("forwards agentThreadId as resumeSessionId", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "続きをお願い",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        agentThreadId: "gsess_prev",
      },
      onEvent: () => {},
    });

    expect(fake.lastParams()?.resumeSessionId).toBe("gsess_prev");
  });

  it("retries once without resume when the resumed session is unavailable", async () => {
    const fake = createFakeGemini({ resumeFailsOnce: true });
    const events: AiEditRunEvent[] = [];

    const result = await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "続きをお願い",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        agentThreadId: "gsess_prev",
      },
      onEvent: (e) => events.push(e),
    });

    expect(fake.allParams()).toHaveLength(2);
    expect(fake.allParams()[0].resumeSessionId).toBe("gsess_prev");
    expect(fake.allParams()[1].resumeSessionId).toBeNull();
    expect(result.agentThreadId).toBe("gsess_test");
    expect(events.some((e) => e.kind === "repair")).toBe(true);
  });

  it("throws with the turn error message when the turn reports isError", async () => {
    const { client } = createFakeGemini({ turn: { isError: true, errorMessage: "ログインしていません" } });

    await expect(
      runGeminiEditForIpc({ locale: "ja",
        gemini: client,
        payload: { instruction: "edit", fileId: "file_1", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("ログインしていません");
  });

  it("formats and includes the selection reference instead of a bare block id", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: {
        instruction: "この文を書き直して",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        references: [{
          kind: "textSelection",
          targetId: "p_1",
          targetType: "paragraph",
          excerpt: "二次関数の最大値を求めよ",
          selectedText: "二次関数の最大値を求めよ",
          mathTex: [],
        }],
      },
      onEvent: () => {},
    });

    expect(fake.lastParams()?.instruction).toContain("ユーザーの選択コンテキスト:");
    expect(fake.lastParams()?.instruction).toContain("二次関数の最大値を求めよ");
  });

  it("sends the full static guidance on a first turn but slims it down on a resumed turn", async () => {
    const fake = createFakeGemini();

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });
    const firstTurnInstruction = fake.lastParams()?.instruction ?? "";
    expect(firstTurnInstruction).toContain("MCP編集方針:");

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "続けて直して", fileId: "file_1", document: FAKE_DOCUMENT, agentThreadId: "gsess_prev" },
      onEvent: () => {},
    });
    const resumedInstruction = fake.lastParams()?.instruction ?? "";
    expect(resumedInstruction).not.toContain("MCP編集方針:");
    expect(resumedInstruction).toContain("続けて直して");
    expect(resumedInstruction).toContain("厳守事項:");
    expect(resumedInstruction.length).toBeLessThan(firstTurnInstruction.length);
  });

  it("surfaces the shared MCP server's tool-activity JSONL as mcpToolCall activity events (F5: agy print mode has no tool_use protocol)", async () => {
    // Antigravity CLIのprintモードはツールイベントを一切出力しないため (F2/F5)、ツール名は
    // 共有MCPサーバーが書くtool-activity JSONLファイル (mcp/tool-activity.ts) からしか得られない。
    // gemini-edit.ts の ToolActivityWatcher 配線がこのファイルをポーリングし、onToolUseへ変換して
    // ai-edit-shared-runner.ts の「ツール実行中... (name)」activityイベントになることを検証する。
    const userDataDir = mkdtempSync(path.join(tmpdir(), "fake-gemini-userdata-"));
    tempDirs.push(userDataDir);
    const fake = createFakeGemini({
      userDataDir,
      toolActivityLines: [{ callId: "call_1", tool: "insert_shape", status: "started" }],
    });
    const events: AiEditRunEvent[] = [];

    await runGeminiEditForIpc({ locale: "ja",
      gemini: fake.client,
      payload: { instruction: "図形を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: (e) => events.push(e),
      runId: "run_gemini_tool_activity_1",
      toolActivityPollIntervalMs: 20,
    });

    const activityEvents = events.filter((e) => e.kind === "activity" && e.itemType === "mcpToolCall");
    expect(activityEvents.some((e) => e.message.includes("insert_shape"))).toBe(true);
    expect(activityEvents.some((e) => e.itemId === "call_1" && e.itemStatus === "started")).toBe(true);
  });
});
