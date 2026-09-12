import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildClaudeEditPrompt, runClaudeEditForIpc } from "./claude-edit";
import type { ClaudeStreamClient, ClaudeRunTurnParams, ClaudeStatus, ClaudeTurnResult } from "./claude-stream-client";
import { attachedFileDefaultInstruction, type AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import type { SigmaDocument } from "@/types/sigma-doc";
import { runContextDirPath, visualSessionsFileName } from "./ai-edit-run-context";

const FAKE_DOCUMENT = { docId: "doc_1" } as unknown as SigmaDocument;

interface FakeClaudeOptions {
  status?: Partial<ClaudeStatus>;
  turn?: Partial<ClaudeTurnResult>;
  emitToolUse?: boolean;
  toolUseNames?: string[];
  onTurn?: (params: ClaudeRunTurnParams, turnNumber: number) => void | Promise<void>;
}

function createFakeClaude(options: FakeClaudeOptions = {}): {
  client: ClaudeStreamClient;
  lastInstruction: () => string | null;
  lastImages: () => ClaudeRunTurnParams["images"];
  lastMcpConfig: () => unknown;
  lastTurnParams: () => ClaudeRunTurnParams | null;
} {
  let lastInstruction: string | null = null;
  let lastImages: ClaudeRunTurnParams["images"];
  let lastMcpConfig: unknown;
  let lastTurnParams: ClaudeRunTurnParams | null = null;
  let turnNumber = 0;
  const client = {
    async getStatus(): Promise<ClaudeStatus> {
      return {
        available: true,
        running: true,
        loggedIn: true,
        claudeBin: "claude",
        configuredClaudeBin: null,
        account: { apiKeySource: "none" },
        error: null,
        ...options.status,
      };
    },
    async runTurn(params: ClaudeRunTurnParams): Promise<ClaudeTurnResult> {
      turnNumber += 1;
      lastTurnParams = params;
      lastInstruction = params.instruction;
      lastImages = params.images;
      lastMcpConfig = params.mcpConfig;
      await options.onTurn?.(params, turnNumber);
      if (options.emitToolUse) {
        params.onToolUse?.({ id: "tool_1", name: "mcp__sigma-studio-local__insert_body_content" });
      }
      for (const [index, name] of (options.toolUseNames ?? []).entries()) {
        params.onToolUse?.({ id: `tool_${index}`, name });
      }
      params.onDelta?.("partial");
      return {
        sessionId: "sess_test",
        finalText: "編集しました",
        isError: false,
        numTurns: 1,
        permissionDenials: [],
        totalCostUsd: null,
        ...options.turn,
      };
    },
  } as unknown as ClaudeStreamClient;
  return {
    client,
    lastInstruction: () => lastInstruction,
    lastImages: () => lastImages,
    lastMcpConfig: () => lastMcpConfig,
    lastTurnParams: () => lastTurnParams,
  };
}

describe("buildClaudeEditPrompt", () => {
  it("includes the target fileId and the user instruction", () => {
    const prompt = buildClaudeEditPrompt({ locale: "ja", instruction: "三角形を追加して", fileId: "file_abc" });
    expect(prompt).toContain("file_abc");
    expect(prompt).toContain("三角形を追加して");
    expect(prompt).toContain("mcp__sigma-studio-local__");
  });

  it("includes heavy MCP guidance aligned with the in-app tool prompt", () => {
    const prompt = buildClaudeEditPrompt({ locale: "ja", instruction: "画像を教材化して", fileId: "file_abc" });

    expect(prompt).toContain("画像入力時の教材再構成ポリシー");
    expect(prompt).toContain("素材利用ポリシー");
    expect(prompt).toContain("visualConcepts");
    expect(prompt).toContain("visual_insert_shape / insert_shape");
    expect(prompt).toContain("line/polyline/curve");
    expect(prompt).toContain("polylineで近似しない");
    expect(prompt).toContain("円・楕円・円弧を多数点の折れ線で作ってはいけません");
    expect(prompt).toContain("review_visual_edit_session");
    expect(prompt).toContain("目盛り（showTicks）とグリッド（grid）は基本的に不要");
    expect(prompt).not.toContain("draft_insert_shape");
    expect(prompt).not.toContain("draft tool");
    expect(prompt).not.toContain("get_material_catalog");
  });

  it("instructs the look-and-fix loop for the page-context PNG preview", () => {
    const prompt = buildClaudeEditPrompt({ locale: "ja", instruction: "三角形を追加して", fileId: "file_abc" });

    expect(prompt).toContain("ページコンテキスト");
    expect(prompt).toContain("見て直すループ");
    expect(prompt).toContain("previewSummary");
    expect(prompt).toContain("svg-fallback");
    expect(prompt).toContain("render_visual_edit_session");
  });

  it("introduces the app-context tools and hardens the expectedRevision wording", () => {
    const prompt = buildClaudeEditPrompt({ locale: "ja", instruction: "解説を追加して", fileId: "file_abc" });

    expect(prompt).toContain("get_selected_block");
    expect(prompt).toContain("get_attached_media");
    expect(prompt).toContain("get_mentioned_sigma_docs");
    expect(prompt).toContain("expectedRevision");
    expect(prompt).toContain("必須");
    expect(prompt).toContain("revision番号が進んだだけ");
    expect(prompt).toContain("近傍ブロックが変わっただけ");
    expect(prompt).toContain("REVISION_MISMATCH");
    expect(prompt).toContain("conflictBlockIds");
    expect(prompt).not.toContain("commit は既定 (true)");
  });
});

describe("runClaudeEditForIpc", () => {
  it("rejects with a login hint when claude is not logged in", async () => {
    const { client } = createFakeClaude({ status: { loggedIn: false } });

    await expect(
      runClaudeEditForIpc({ locale: "ja",
        claude: client,
        payload: { instruction: "edit", fileId: "file_1", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("ログイン");
  });

  it("rejects when the fileId is missing", async () => {
    const { client } = createFakeClaude();

    await expect(
      runClaudeEditForIpc({ locale: "ja",
        claude: client,
        payload: { instruction: "edit", document: FAKE_DOCUMENT },
        onEvent: () => {},
      }),
    ).rejects.toThrow("教材ファイル");
  });

  it("passes the fileId into the claude turn instruction", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_xyz", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(fake.lastInstruction()).toContain("file_xyz");
    expect(fake.lastInstruction()).toContain("本文を追加");
  });

  it("passes a non-image attachment through app context even when the text instruction is empty", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: {
        instruction: "",
        fileId: "file_xyz",
        document: FAKE_DOCUMENT,
        attachments: [{
          id: "attachment_pdf",
          name: "worksheet.pdf",
          mimeType: "application/pdf",
          dataUrl: "data:application/pdf;base64,JVBERg==",
        }],
      },
      onEvent: () => {},
    });

    expect(fake.lastInstruction()).toContain(attachedFileDefaultInstruction());
    expect(fake.lastInstruction()).toContain("worksheet.pdf");
    expect(fake.lastImages()).toEqual([]);
  });

  it("forwards the raw instruction, references, and explicit skill ids for per-run tool gating", async () => {
    const fake = createFakeClaude();
    const references = [{ kind: "block" as const, targetId: "block_1", targetType: "paragraph", excerpt: "本文" }];

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "これを直して", fileId: "file_xyz", document: FAKE_DOCUMENT, references },
      aiResources: {
        provider: "claude",
        always: [],
        explicit: [{
          id: "official-graph",
          kind: "skill",
          title: "グラフ",
          loadMode: "manual",
          description: "",
          tags: [],
          content: "skill body",
        }],
      },
      onEvent: () => {},
    });

    expect(fake.lastTurnParams()).toMatchObject({
      userInstruction: "これを直して",
      references,
      selectedSkillIds: ["official-graph"],
    });
  });

  it("forwards a per-run mcpConfig override through to the claude client's runTurn call", async () => {
    const fake = createFakeClaude();
    const perRunMcpConfig = {
      mcpServers: {
        "sigma-studio-local": {
          command: "node",
          args: ["/app/dist-electron/sigma-doc-mcp-server.cjs"],
          env: { SIGMA_STUDIO_RUN_CONTEXT_FILE: "/data/ai-run-context/claude-run_42.run-context.json" },
        },
      },
    };

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_xyz", document: FAKE_DOCUMENT },
      onEvent: () => {},
      mcpConfig: perRunMcpConfig,
    });

    expect(fake.lastMcpConfig()).toEqual(perRunMcpConfig);
  });

  it("threads runId into the prompt so the agent can pass it back on app-context tool calls", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_xyz", document: FAKE_DOCUMENT },
      onEvent: () => {},
      runId: "run_claude_42",
    });

    expect(fake.lastInstruction()).toContain("run_claude_42");
    expect(fake.lastInstruction()).toContain("runId");
  });

  it("returns a claude-mcp result with empty operations when a tool was used", async () => {
    const { client } = createFakeClaude({ emitToolUse: true });
    const events: AiEditRunEvent[] = [];

    const result = await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "本文を追加", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: (e) => events.push(e),
    });

    expect(result.runtime).toBe("claude-mcp");
    expect(result.draft.operations).toEqual([]);
    expect(result.status).toBe("draft");
    expect(result.agentThreadId).toBe("sess_test");
    expect(events.some((e) => e.kind === "activity")).toBe(true);
    expect(events.some((e) => e.kind === "stream" && e.delta === "partial")).toBe(true);
  });

  it("parses image attachments into base64 image inputs for the claude turn", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: {
        instruction: "この画像を説明して",
        fileId: "file_1",
        document: FAKE_DOCUMENT,
        attachments: [
          { id: "a", name: "a.png", mimeType: "image/png", dataUrl: "data:image/png;base64,AAAA" },
          { id: "b", name: "b.jpg", mimeType: "image/jpeg", dataUrl: "data:image/jpeg;base64,BBBB" },
        ],
      },
      onEvent: () => {},
    });

    expect(fake.lastImages()).toEqual([
      { mediaType: "image/png", dataBase64: "AAAA" },
      { mediaType: "image/jpeg", dataBase64: "BBBB" },
    ]);
  });

  it("forwards PDFs separately and caps images at four", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
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
            dataUrl: `data:image/png;base64,IMG${i}`,
          })),
        ],
      },
      onEvent: () => {},
    });

    const images = fake.lastImages() ?? [];
    expect(images).toHaveLength(4);
    expect(images.every((img) => img.mediaType === "image/png")).toBe(true);
    expect(images[0].dataBase64).toBe("IMG0");
    expect(fake.lastTurnParams()?.documents).toEqual([{ title: "doc.pdf", dataBase64: "PDF" }]);
  });

  it("returns status answer when no tool was used", async () => {
    const { client } = createFakeClaude({ emitToolUse: false });

    const result = await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "質問だけ", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("answer");
  });

  it("suppresses per-turn completion phases and emits one final phase after visual-loop enforcement", async () => {
    const userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), "sigma-claude-visual-loop-"));
    const runId = "run_claude_visual_loop_phases";
    const statusFile = path.join(runContextDirPath(userDataPath), visualSessionsFileName("claude", runId));
    await fs.mkdir(path.dirname(statusFile), { recursive: true });
    await fs.writeFile(statusFile, JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      sessions: [{
        sessionId: "visual_incomplete",
        targetId: "block_1",
        operationCount: 1,
        revision: 1,
        lastReviewPassed: false,
        proposed: false,
        discarded: false,
      }],
    }), "utf8");

    try {
      const fake = createFakeClaude({
        emitToolUse: true,
        onTurn: async (_params, turnNumber) => {
          if (turnNumber === 2) {
            await fs.writeFile(statusFile, JSON.stringify({
              version: 1,
              updatedAt: new Date().toISOString(),
              sessions: [],
            }), "utf8");
          }
        },
      });
      const events: AiEditRunEvent[] = [];

      const result = await runClaudeEditForIpc({ locale: "ja",
        claude: fake.client,
        payload: { instruction: "図形を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
        onEvent: (event) => events.push(event),
        runId,
        userDataPath,
      });

      const completeEvents = events.filter((event) => event.kind === "phase" && event.phase === "complete");
      expect(completeEvents).toHaveLength(1);
      expect(completeEvents[0]?.message).toBe("編集案を作成しました。プレビューで確認してください。");
      expect(result).not.toHaveProperty("exhausted");
    } finally {
      await fs.rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("returns status answer (not draft) when only read-only MCP tools were used", async () => {
    const { client } = createFakeClaude({
      toolUseNames: [
        "mcp__sigma-studio-local__read_local_document",
        "mcp__sigma-studio-local__get_document_outline",
      ],
    });

    const result = await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "この教材の構成を教えて", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("answer");
  });

  it("resolves with status cancelled (not an error) when the claude client reports the turn was cancelled", async () => {
    const { client } = createFakeClaude({ turn: { cancelled: true, finalText: "" } });

    const result = await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("cancelled");
    expect(result.runtime).toBe("claude-mcp");
  });

  it("forwards the runId into the claude client's runTurn call so it can be cancelled by id", async () => {
    let capturedRunId: string | undefined;
    const client = {
      async getStatus() {
        return { available: true, running: true, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null, account: null, error: null };
      },
      async runTurn(params: ClaudeRunTurnParams) {
        capturedRunId = params.runId;
        return { sessionId: "sess_test", finalText: "ok", isError: false, numTurns: 1, permissionDenials: [], totalCostUsd: null };
      },
    } as unknown as ClaudeStreamClient;

    await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
      runId: "run_claude_cancel_test",
    });

    expect(capturedRunId).toBe("run_claude_cancel_test");
  });

  it("forwards a per-run cwd override through to the claude client's runTurn call", async () => {
    let capturedCwd: string | undefined;
    const client = {
      async getStatus() {
        return { available: true, running: true, loggedIn: true, claudeBin: "claude", configuredClaudeBin: null, account: null, error: null };
      },
      async runTurn(params: ClaudeRunTurnParams) {
        capturedCwd = params.cwd;
        return { sessionId: "sess_test", finalText: "ok", isError: false, numTurns: 1, permissionDenials: [], totalCostUsd: null };
      },
    } as unknown as ClaudeStreamClient;

    await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
      cwd: "/data/agent-workspaces/ws_1/claude",
    });

    expect(capturedCwd).toBe("/data/agent-workspaces/ws_1/claude");
  });

  it("returns status draft when a write-capable MCP tool was used", async () => {
    const { client } = createFakeClaude({
      toolUseNames: [
        "mcp__sigma-studio-local__read_local_document",
        "mcp__sigma-studio-local__insert_content",
      ],
    });

    const result = await runClaudeEditForIpc({ locale: "ja",
      claude: client,
      payload: { instruction: "本文を追加して", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });

    expect(result.status).toBe("draft");
  });

  it("appends the mentionedDocuments hint with count and titles to the prompt", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
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

    expect(fake.lastInstruction()).toContain("メンションされた教材が1件あります");
    expect(fake.lastInstruction()).toContain("参考教材A");
  });

  it("formats and includes the selection reference instead of a bare block id", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
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

    expect(fake.lastInstruction()).toContain("ユーザーの選択コンテキスト:");
    expect(fake.lastInstruction()).toContain("二次関数の最大値を求めよ");
  });

  it("sends the full static guidance on a first turn but slims it down on a resumed turn", async () => {
    const fake = createFakeClaude();

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "本文を追加", fileId: "file_1", document: FAKE_DOCUMENT },
      onEvent: () => {},
    });
    const firstTurnInstruction = fake.lastInstruction();
    expect(firstTurnInstruction).toContain("MCP編集方針:");

    await runClaudeEditForIpc({ locale: "ja",
      claude: fake.client,
      payload: { instruction: "続けて直して", fileId: "file_1", document: FAKE_DOCUMENT, agentThreadId: "sess_test" },
      onEvent: () => {},
    });
    const resumedInstruction = fake.lastInstruction();
    expect(resumedInstruction).not.toContain("MCP編集方針:");
    expect(resumedInstruction).toContain("続けて直して");
    expect(resumedInstruction).toContain("厳守事項:");
    expect((resumedInstruction ?? "").length).toBeLessThan((firstTurnInstruction ?? "").length);
  });
});
