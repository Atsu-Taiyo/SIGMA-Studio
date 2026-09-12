import { ipcMain } from "electron";

import { cancelAiSkillDraftCodexRun, generateAiSkillDraft, type AiSkillDraftRequest } from "../ai-skill-draft";
import { LocalAiResourceStore } from "../ai-resource-store";
import type { ClaudeStreamClient } from "../claude-stream-client";
import type { CodexAppServerClient } from "../codex-app-server-client";
import type { GeminiHeadlessClient } from "../gemini-headless-client";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

// 同じ形の別レジストリ: AI設定「スキル」編集画面の「AIで下書き」(ai-skill-draft:generate)用。
// ai-edit:run とはツール構成もプロバイダクライアントの使い方も別系統なので、レジストリも
// 混ぜずに分けている。ai-skill-draft:cancel がここを引いて対応するclientのcancelRun /
// cancelAiSkillDraftCodexRun (Codexだけこのファイル内で自前管理) を呼ぶ。
const activeAiSkillDraftRuns = new Map<string, { provider: AiProvider; cancel: () => boolean }>();

function parseAiSkillDraftPayload(payload: unknown): AiSkillDraftRequest | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const provider = record.provider === "claude" || record.provider === "antigravity" ? record.provider : "chatgpt";
  const prompt = typeof record.prompt === "string" ? record.prompt : "";
  const contextRaw = typeof record.context === "object" && record.context !== null ? record.context as Record<string, unknown> : {};
  return {
    provider,
    prompt,
    context: {
      title: typeof contextRaw.title === "string" ? contextRaw.title : "",
      description: typeof contextRaw.description === "string" ? contextRaw.description : "",
      currentContent: typeof contextRaw.currentContent === "string" ? contextRaw.currentContent : "",
    },
  };
}

export interface RegisterAiResourcesIpcDeps {
  localAiResourceStore: LocalAiResourceStore;
  claudeStreamClient: ClaudeStreamClient;
  codexAppServerClient: CodexAppServerClient;
  geminiSkillDraftClient: GeminiHeadlessClient;
}

export function registerAiResourcesIpc(deps: RegisterAiResourcesIpcDeps): void {
  const { localAiResourceStore, claudeStreamClient, codexAppServerClient, geminiSkillDraftClient } = deps;

  function restartAiRuntimes(): void {
    codexAppServerClient.dispose();
    claudeStreamClient.dispose();
  }

  ipcMain.handle("ai-resources:get-tree", async () => {
    return localAiResourceStore.getTree();
  });

  ipcMain.handle("ai-resources:read-file", async (_event, resourceId: unknown) => {
    return localAiResourceStore.readFile(typeof resourceId === "string" ? resourceId : "");
  });

  // runtimeChanged がtrueのとき(=AGENTS.md/CLAUDE.md/skills投影ファイルが実際に書き換わった
  // とき)だけAIランタイムを再起動する。プロンプト注入だけで届くワークスペースリソースの保存や
  // 内容が変わらない保存で、温まったcodex app-serverや実行中のClaudeターンを殺さないため。
  ipcMain.handle("ai-resources:save-file", async (_event, input: unknown) => {
    const { resource, content, runtimeChanged } = await localAiResourceStore.saveFile(
      input as Parameters<LocalAiResourceStore["saveFile"]>[0],
    );
    if (runtimeChanged) {
      restartAiRuntimes();
    }
    return { resource, content };
  });

  ipcMain.handle("ai-resources:save-instruction", async (_event, input: unknown) => {
    const { resource, content, runtimeChanged } = await localAiResourceStore.saveInstruction(
      input as Parameters<LocalAiResourceStore["saveInstruction"]>[0],
    );
    if (runtimeChanged) {
      restartAiRuntimes();
    }
    return { resource, content };
  });

  ipcMain.handle("ai-resources:create-skill", async (_event, input: unknown) => {
    const { resource, content, runtimeChanged } = await localAiResourceStore.createSkill(
      input as Parameters<LocalAiResourceStore["createSkill"]>[0],
    );
    if (runtimeChanged) {
      restartAiRuntimes();
    }
    return { resource, content };
  });

  ipcMain.handle("ai-resources:delete", async (_event, resourceId: unknown) => {
    const { runtimeChanged } = await localAiResourceStore.deleteResource(typeof resourceId === "string" ? resourceId : "");
    if (runtimeChanged) {
      restartAiRuntimes();
    }
    return { ok: true };
  });

  ipcMain.handle("ai-resources:set-enabled", async (_event, resourceId: unknown, enabled: unknown) => {
    if (typeof resourceId !== "string" || !resourceId) {
      throw new Error(ta("desktop.resource.resourceIdRequired"));
    }
    const { resource, runtimeChanged } = await localAiResourceStore.setResourceEnabled(resourceId, enabled === true);
    if (runtimeChanged) {
      restartAiRuntimes();
    }
    return resource;
  });

  // スキル編集画面の「AIで下書き」。既存の ai-edit:run (MCPツール経由・チャットUI用) とは
  // 別系統: ツールなしの一回きりのCLI呼び出しでMarkdown本文を1つだけ生成して返す。
  // ai-edit:run と同じrunIdパターン(preloadが同期発行→event.senderでdelta配信→invoke結果は
  // 最終確定テキスト)でストリーミングとキャンセルに対応する。
  ipcMain.handle("ai-skill-draft:generate", async (event, runId: unknown, payload: unknown) => {
    if (typeof runId !== "string" || !runId) {
      return { ok: false, error: ta("desktop.resource.invalidRequest") };
    }
    const request = parseAiSkillDraftPayload(payload);
    if (!request) {
      return { ok: false, error: ta("desktop.resource.invalidRequest") };
    }
    activeAiSkillDraftRuns.set(runId, {
      provider: request.provider,
      cancel: () => {
        if (request.provider === "claude") {
          return claudeStreamClient.cancelRun(runId);
        }
        if (request.provider === "antigravity") {
          return geminiSkillDraftClient.cancelRun(runId);
        }
        return cancelAiSkillDraftCodexRun(runId);
      },
    });
    try {
      return await generateAiSkillDraft(
        request,
        {
          claude: claudeStreamClient,
          geminiSkillDraft: geminiSkillDraftClient,
          codex: codexAppServerClient,
        },
        runId,
        (delta) => event.sender.send(`ai-skill-draft:event:${runId}`, { kind: "delta", text: delta }),
      );
    } finally {
      activeAiSkillDraftRuns.delete(runId);
    }
  });

  ipcMain.handle("ai-skill-draft:cancel", async (_event, runIdArg: unknown) => {
    const runId = typeof runIdArg === "string" ? runIdArg.trim() : "";
    if (!runId) {
      return { ok: false, cancelled: false };
    }
    const entry = activeAiSkillDraftRuns.get(runId);
    if (!entry) {
      return { ok: true, cancelled: false };
    }
    const cancelled = entry.cancel();
    return { ok: true, cancelled };
  });
}
