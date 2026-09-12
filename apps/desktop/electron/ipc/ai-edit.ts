import { CodexGeneratedImageStore } from "../codex-generated-images";
import { app, ipcMain } from "electron";

import type { AiEditRunEvent } from "@/lib/ai/ai-edit-runtime";
import { toAiResourceProvider } from "@/lib/ai/ai-providers";
import type { SigmaDocument } from "@/features/document";

import { setValidationLocale } from "@/lib/ai/validation-locale";
import { createTranslator } from "@/lib/i18n";
import { resolveDesktopPromptLocale } from "../desktop-settings";
import { runAiEditForIpc } from "../ai-edit";
import { LocalAiEditChatRoomStore } from "../ai-edit-chat-room-store";
import { resolveAiEditProvider, type AiEditProvider } from "../ai-edit-provider";
import { LocalAiEditRunContextStore, prepareAiEditRunContext } from "../ai-edit-run-context";
import { LocalAiEditRunLogStore } from "../ai-edit-run-log-store";
import type { LocalAiRenderBridgeStore } from "../ai-render-bridge";
import { LocalAiResourceStore } from "../ai-resource-store";
import { buildClaudeMcpConfig } from "../claude-mcp-config";
import { runClaudeEditForIpc } from "../claude-edit";
import type { ClaudeStreamClient } from "../claude-stream-client";
import type { CodexAppServerClient } from "../codex-app-server-client";
import { isAiWebSearchEnabled, readDesktopSettingsSync } from "../desktop-settings";
import { runGeminiEditForIpc } from "../gemini-edit";
import type { GeminiHeadlessClient } from "../gemini-headless-client";
import { buildGeminiWorkspaceSettings, writeGeminiWorkspaceSettings } from "../gemini-settings-config";
import type { LocalMcpEditProposalStore } from "../local-sigma-doc-proposal-store";
import { LocalSigmaDocStore } from "../local-sigma-doc-store";

// Cancellation registry for in-flight ai-edit:run calls, keyed by the same
// runId used for that run's run-context files (see runEditWithRunContext
// below). Populated right after resolveAiEditProvider() in the ai-edit:run
// handler, removed in its finally block once the run settles either way.
// ai-edit:cancel looks a runId up here and delegates to the matching
// provider client's own cancel method (each client resolves its pending
// runTurn() promise with a `cancelled: true` result instead of rejecting).
const activeAiEditRuns = new Map<string, { provider: AiEditProvider; cancel: () => boolean }>();
// A stop request can arrive between provider turns, when there is no child
// process/app-server turn for the provider cancel method to interrupt.
const cancelRequestedAiEditRuns = new Set<string>();

function getExplicitAiResourceIds(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) {
    return [];
  }
  const value = (payload as { aiResourceIds?: unknown }).aiResourceIds;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
}

function getFileIdForAiResources(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const value = (payload as { fileId?: unknown }).fileId;
  return typeof value === "string" ? value.trim() : "";
}

function getRoomIdForProposalLifecycle(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) {
    return "";
  }
  const value = (payload as { roomId?: unknown }).roomId;
  return typeof value === "string" ? value.trim() : "";
}

export interface RegisterAiEditIpcDeps {
  userDataPath: string;
  dataDir: string;
  localSigmaDocStore: LocalSigmaDocStore;
  localAiResourceStore: LocalAiResourceStore;
  localAiEditRunLogStore: LocalAiEditRunLogStore;
  localAiEditChatRoomStore: LocalAiEditChatRoomStore;
  localMcpProposalStore: LocalMcpEditProposalStore;
  localChatgptRunContextStore: LocalAiEditRunContextStore;
  localGeminiRunContextStore: LocalAiEditRunContextStore;
  localAiRenderBridgeStore: LocalAiRenderBridgeStore;
  claudeStreamClient: ClaudeStreamClient;
  codexAppServerClient: CodexAppServerClient;
  geminiHeadlessClient: GeminiHeadlessClient;
  resolveMcpServerScriptPath: () => string;
  pendingRenderDocuments: Map<string, SigmaDocument>;
}

export function registerAiEditIpc(deps: RegisterAiEditIpcDeps): void {
  const {
    userDataPath,
    dataDir,
    localSigmaDocStore,
    localAiResourceStore,
    localAiEditRunLogStore,
    localAiEditChatRoomStore,
    localMcpProposalStore,
    localChatgptRunContextStore,
    localGeminiRunContextStore,
    localAiRenderBridgeStore,
    claudeStreamClient,
    codexAppServerClient,
    geminiHeadlessClient,
    resolveMcpServerScriptPath,
    pendingRenderDocuments,
  } = deps;

  ipcMain.handle("ai-edit:generated-image", async (_event, runId: unknown, imageId: unknown) => {
    if (typeof runId !== "string" || typeof imageId !== "string" || runId.length > 256) return { dataUrl: null };
    try {
      const record = await new CodexGeneratedImageStore(dataDir).get(runId, imageId);
      return { dataUrl: record?.image.dataUrl ?? null };
    } catch {
      return { dataUrl: null };
    }
  });

  // ワークスペースAIリソース(AI設定ダイアログの「ワークスペース」タブで保存した指示・skill)を
  // buildRunContext へ渡すために、このturnの編集対象fileIdから逆引きする。fileId未指定/未知
  // の場合はnull(グローバルリソースのみが対象になる)。
  async function resolveWorkspaceIdForFile(fileId: string): Promise<string | null> {
    if (!fileId) {
      return null;
    }
    try {
      const files = await localSigmaDocStore.listFiles();
      return files.find((file) => file.fileId === fileId)?.workspaceId ?? null;
    } catch {
      return null;
    }
  }

  // runContextStores は provider ごとに1〜2個渡される:
  // - Claude: 呼び出し元 (per-runId) storeを1個だけ (--mcp-configで直接指すため静的ファイルは不要)。
  // - Codex/Antigravity: 起動時にMCPサーバー設定へ焼き込んだ静的provider storeと、
  //   このrunだけの per-runId store の2個。静的storeへは引き続き書き込むことで、
  //   エージェントがプロンプトのrunId引数を渡し忘れた場合のフォールバックを維持しつつ、
  //   per-runId storeへの書き込みでtool呼び出しにrunIdが乗ったときに正しいrunのコンテキストを
  //   MCPサーバーが解決できるようにする (sigma-doc-mcp-app-context.ts 側の解決ロジック)。
  async function runEditWithRunContext<TArgs extends { payload: unknown }, TResult>(
    provider: "claude" | "chatgpt" | "antigravity",
    runContextStores: LocalAiEditRunContextStore[],
    args: TArgs & { runId: string },
    run: (args: TArgs) => Promise<TResult>,
  ): Promise<TResult> {
    const cleanups: Array<() => Promise<void>> = [];
    for (const runContextStore of runContextStores) {
      try {
        const cleanup = await prepareAiEditRunContext({
          provider,
          runContextStore,
          sigmaDocStore: localSigmaDocStore,
          runId: args.runId,
          payload: (args.payload ?? {}) as Parameters<typeof prepareAiEditRunContext>[0]["payload"],
        });
        cleanups.push(cleanup);
      } catch (error) {
        console.warn("AI実行コンテキストの準備に失敗しました。コンテキストなしで続行します。", error);
        // prepare が例外を投げた場合、前回実行の run-context ファイルが残っている可能性がある。
        // MCPサーバーが古いコンテキストを提供しないよう、ベストエフォートで削除しておく。
        await runContextStore.clear();
      }
    }
    try {
      return await run(args);
    } finally {
      for (const cleanup of cleanups) {
        await cleanup();
      }
    }
  }

  ipcMain.handle("ai-edit:run", async (event, runId: string, payload: unknown) => {
    const events: AiEditRunEvent[] = [];
    const startedAt = new Date().toISOString();
    const emitAiEditEvent = (e: AiEditRunEvent) => {
      events.push(e);
      event.sender.send(`ai-edit:event:${runId}`, e);
    };

    const provider = resolveAiEditProvider(payload);
    const proposalRoomId = getRoomIdForProposalLifecycle(payload);
    const proposalFileId = getFileIdForAiResources(payload);
    let proposalSnapshotId: string | null = null;
    if (proposalRoomId && proposalFileId) {
      try {
        proposalSnapshotId = await localMcpProposalStore.beginProposalRunSnapshot(proposalRoomId, proposalFileId);
      } catch (error) {
        console.warn("AI提案runの開始状態を保存できませんでした。", error);
      }
    }
    activeAiEditRuns.set(runId, {
      provider,
      cancel: () => {
        if (provider === "claude") {
          return claudeStreamClient.cancelRun(runId);
        }
        if (provider === "antigravity") {
          return geminiHeadlessClient.cancelRun(runId);
        }
        return codexAppServerClient.cancelByRunId(runId);
      },
    });
    cancelRequestedAiEditRuns.delete(runId);

    // aiWebSearchEnabled は turn 間でも変わりうる設定なので、起動時スナップショット
    // (desktopSettings) ではなく run ごとに読み直す (検証済み自動承認の
    // runAutoApplyCheck と同じ per-request 読み直し方針)。
    // 設定は run ごとに 1 度だけ読む (Web検索の可否と表示言語の両方をここから取る)。
    const runSettings = readDesktopSettingsSync(dataDir);
    const webSearchEnabled = isAiWebSearchEnabled(runSettings);
    // プロンプトを組む言語も run ごとに読み直す (設定はturn間で変わりうる)。**main には
    // renderer の React context が無い**ので、ここで解決して各 provider へ引き回す。
    // 教材の中身の言語はこれとは独立で、`prompt.documentLanguagePolicy` が文書に従わせる。
    const locale = runSettings.uiLocale ?? resolveDesktopPromptLocale(dataDir, app.getLocale());
    const ta = createTranslator(locale, "ai");
    // main プロセスと、この run で組み立てる検証メッセージの言語をここで固定する
    // (`window` が無いので `getAppLocale()` は使えない)。
    setValidationLocale(locale);
    // ワークスペースAIリソース(AI設定「ワークスペース」タブの指示・skill)はこのturnの編集対象
    // fileIdが属するワークスペースにだけ組み込む。fileId未指定/未知ならグローバルのみ。
    const workspaceIdForAiResources = await resolveWorkspaceIdForFile(getFileIdForAiResources(payload));

    try {
      // このrunのcwd: workspaceIdForAiResourcesが解決できていれば、そのワークスペース専用の
      // agent-workspaces/<ws>/<provider> (グローバル∪ワークスペースのリソースが投影される)、
      // 解決できなければ従来どおりの固定フォールバックディレクトリ(グローバルのみ)を使う。
      const aiResourceProvider = toAiResourceProvider(provider);
      // Only the runtime target(s) this run's provider×workspace actually
      // reads need to be fresh; syncToRuntimeTargets() itself is differential
      // (skips fs work entirely when nothing changed since the last sync for
      // that target), so this also keeps every ai-edit:run call cheap on the
      // common no-op path.
      await localAiResourceStore.syncToRuntimeTargets({
        providers: [aiResourceProvider],
        workspaceIds: [workspaceIdForAiResources],
      });
      const agentWorkspaceDir = localAiResourceStore.getAgentWorkspaceDir(aiResourceProvider, workspaceIdForAiResources);
      const result = provider === "claude"
        ? await (async () => {
            // Claude is 1-turn-per-spawn and takes its MCP config as a
            // `--mcp-config` CLI arg per turn (not a shared static file), so
            // unlike Codex/Antigravity it can get a genuinely per-run
            // run-context file: build both from the same runId here.
            const claudeRunContextStore = new LocalAiEditRunContextStore(userDataPath, "claude", { runId });
            return runEditWithRunContext(
              "claude",
              [claudeRunContextStore],
              {
                claude: claudeStreamClient,
                aiResources: await localAiResourceStore.buildRunContext("claude", getExplicitAiResourceIds(payload), workspaceIdForAiResources),
                payload,
                runId,
                userDataPath,
                webSearchEnabled,
                locale,
                isCancelRequested: () => cancelRequestedAiEditRuns.has(runId),
                cwd: agentWorkspaceDir,
                mcpConfig: buildClaudeMcpConfig({
                  uiLocale: locale,
                  execPath: process.execPath,
                  scriptPath: resolveMcpServerScriptPath(),
                  userDataDir: userDataPath,
                  runContextFile: claudeRunContextStore.getRunContextFilePath(),
                  renderBridgeFile: localAiRenderBridgeStore.getBridgeFilePath(),
                  provider: "claude",
                }),
                onEvent: emitAiEditEvent,
              },
              runClaudeEditForIpc,
            );
          })()
        : provider === "antigravity"
        ? await (async () => {
            // ワークスペース専用ディレクトリにもMCP起動設定(mcp_config.json)を書く。
            // フォールバックディレクトリ向けの起動時書き込み(geminiAgentWorkspaceDir)とは別に、
            // このrunのcwdになるディレクトリにも同じ入力で冪等に書く(毎run書いてよい)。
            await writeGeminiWorkspaceSettings(
              agentWorkspaceDir,
              buildGeminiWorkspaceSettings({
                execPath: process.execPath,
                scriptPath: resolveMcpServerScriptPath(),
                userDataDir: userDataPath,
                runContextFile: localGeminiRunContextStore.getRunContextFilePath(),
                renderBridgeFile: localAiRenderBridgeStore.getBridgeFilePath(),
                provider: "antigravity",
                uiLocale: locale,
              }),
            ).catch((error) => {
              console.warn("Antigravity MCP設定の書き込みに失敗しました。", error);
            });
            return runEditWithRunContext(
              "antigravity",
              // Antigravity's MCP server config is written to a workspace-level
              // mcp_config.json once at startup pointing at the static
              // localGeminiRunContextStore file, so that file keeps being
              // written as the runId-argument fallback. The per-runId store
              // alongside it is what lets the MCP server resolve THIS run's
              // context when the agent passes runId back on tool calls.
              [localGeminiRunContextStore, new LocalAiEditRunContextStore(userDataPath, "antigravity", { runId })],
              {
                gemini: geminiHeadlessClient,
                aiResources: await localAiResourceStore.buildRunContext("antigravity", getExplicitAiResourceIds(payload), workspaceIdForAiResources),
                payload,
                runId,
                userDataPath,
                webSearchEnabled,
                locale,
                isCancelRequested: () => cancelRequestedAiEditRuns.has(runId),
                cwd: agentWorkspaceDir,
                onEvent: emitAiEditEvent,
              },
              runGeminiEditForIpc,
            );
          })()
        : await runEditWithRunContext(
            "chatgpt",
            // Same shared-MCP-server shape as Antigravity above: Codex's
            // app-server config is baked once at startup with the static
            // localChatgptRunContextStore file, kept as the fallback, plus a
            // per-runId store this Codex turn's tool calls can be resolved to.
            [localChatgptRunContextStore, new LocalAiEditRunContextStore(userDataPath, "chatgpt", { runId })],
            {
              codex: codexAppServerClient,
              aiResources: await localAiResourceStore.buildRunContext("codex", getExplicitAiResourceIds(payload), workspaceIdForAiResources),
              payload,
              runId,
              userDataPath,
              webSearchEnabled,
              locale,
              isCancelRequested: () => cancelRequestedAiEditRuns.has(runId),
              cwd: agentWorkspaceDir,
              onEvent: emitAiEditEvent,
            },
            runAiEditForIpc,
          );
      if (proposalSnapshotId) {
        if (result.status === "cancelled") {
          await localMcpProposalStore.rollbackProposalRunSnapshot(proposalSnapshotId);
        } else {
          localMcpProposalStore.completeProposalRunSnapshot(proposalSnapshotId);
        }
      }
      // Web検索はMCPツールではないためMCPサーバー側の参照台帳に載らない。run のイベント列
      // だけが「何を検索したか」を知っているので、ここで提案へ後付けする (URLはCodexから
      // 取得できないため検索語のまま出典にする)。
      await appendWebSearchSourceReferences(localMcpProposalStore, runId, events);
      await localAiEditRunLogStore.appendRun({
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: result.status === "cancelled" ? "cancelled" : "completed",
        payload,
        events,
        result,
      }).catch((error) => {
        console.warn("Failed to write AI edit run log", error);
      });
      return result;
    } catch (error) {
      if (proposalSnapshotId) {
        try {
          await localMcpProposalStore.rollbackProposalRunSnapshot(proposalSnapshotId);
        } catch (rollbackError) {
          console.warn("失敗したAI提案runを開始前の状態へ戻せませんでした。", rollbackError);
        }
      }
      await localAiEditRunLogStore.appendRun({
        runId,
        startedAt,
        completedAt: new Date().toISOString(),
        status: "error",
        payload,
        events,
        error: error instanceof Error ? error.message : ta("desktop.aiEditFailed"),
      }).catch((logError) => {
        console.warn("Failed to write AI edit run log", logError);
      });
      throw error;
    } finally {
      activeAiEditRuns.delete(runId);
      cancelRequestedAiEditRuns.delete(runId);
    }
  });

  ipcMain.handle("ai-edit:cancel", async (_event, runIdArg: unknown) => {
    const runId = typeof runIdArg === "string" ? runIdArg.trim() : "";
    if (!runId) {
      return { ok: false, cancelled: false };
    }
    const entry = activeAiEditRuns.get(runId);
    if (!entry) {
      // Already completed, already cancelled, or unknown runId: not an error,
      // just nothing to do.
      return { ok: true, cancelled: false };
    }
    cancelRequestedAiEditRuns.add(runId);
    const cancelled = entry.cancel();
    return { ok: true, cancelled };
  });

  ipcMain.handle("ai-edit:list-chat-rooms", async (_event, documentIdentityKey?: unknown) => {
    return localAiEditChatRoomStore.listRooms(
      typeof documentIdentityKey === "string" ? documentIdentityKey : null,
    );
  });

  ipcMain.handle("ai-edit:save-chat-room", async (_event, room: unknown) => {
    return localAiEditChatRoomStore.saveRoom(room);
  });

  ipcMain.handle("ai-edit:delete-chat-room", async (_event, roomId: unknown) => {
    return localAiEditChatRoomStore.deleteRoom(typeof roomId === "string" ? roomId : "");
  });

  ipcMain.handle("ai-render:get-document", async (_event, renderId: unknown) => {
    if (typeof renderId !== "string") {
      return null;
    }
    return pendingRenderDocuments.get(renderId) ?? null;
  });
}

/**
 * run の活動イベントから Web検索の検索語を拾い、その run が作った提案へ参照元として追記する。
 *
 * Codex の webSearch item は query しか通知しない (v2/ItemStartedNotification.json) ため、
 * 開ける URL は作れない。開けないものをリンクに見せると嘘になるので、`webSearch` 種別の
 * まま「Web検索: <語句>」として残す。提案が 1 件も無い run (回答のみ) では何もしない。
 */
export async function appendWebSearchSourceReferences(
  localMcpProposalStore: LocalMcpEditProposalStore,
  runId: string,
  events: AiEditRunEvent[],
): Promise<void> {
  // 検索語はモデルが決める外部由来文字列なので、件数と長さの両方を切る。1 run に何十回も
  // 検索されたケースで提案レコードが肥大し、チップ行が延々と伸びるのを防ぐ。
  const MAX_WEB_SEARCH_REFERENCES = 5;
  const MAX_WEB_SEARCH_QUERY_LENGTH = 120;
  const queries: string[] = [];
  for (const event of events) {
    const query = event.webSearchQuery?.trim().slice(0, MAX_WEB_SEARCH_QUERY_LENGTH);
    if (query && !queries.includes(query)) {
      queries.push(query);
    }
    if (queries.length >= MAX_WEB_SEARCH_REFERENCES) {
      break;
    }
  }
  if (queries.length === 0) {
    return;
  }
  try {
    await localMcpProposalStore.appendSourceReferencesForRun(
      runId,
      queries.map((query) => ({ type: "webSearch" as const, query })),
    );
  } catch (error) {
    // 参照元は補助情報。追記に失敗しても run の結果そのものは壊さない。
    console.warn("Web検索の参照元を提案へ追記できませんでした。", error);
  }
}
