// 内蔵AI (SIGMA AI) の編集実行。
//
// エージェントは DeepSeek Harness (dsh)、モデルは中継経由の DeepSeek。Claude / Antigravity と
// 同じ共有ランナー (ai-edit-shared-runner.ts) に乗せるので、プロンプトの組み立て・書き込み
// ツールの数え方・目視確認ループ・結果の形は他のプロバイダと同じになる。
// 違いは dsh-harness-client.ts の中 (起動する相手と、教材を触れる道具が MCP だけなこと)。

import type { AppLocale } from "@/lib/i18n";
import { createTranslator } from "@/lib/i18n";
import { tv } from "@/lib/ai/validation-locale";
import type { AiEditRunEvent, AiEditRunResult } from "@/lib/ai/ai-edit-runtime";
import type { AiEditAttachment } from "@/lib/ai/sigma-doc-agent-tools";
import type { AiSubagentPolicy } from "@/lib/ai/subagent-settings";
import { parseAttachedImageDataUrl } from "./ai-edit-image";
import { runMcpEditForIpc, type McpEditProviderDescriptor } from "./ai-edit-shared-runner";
import type { AiResourceRunContext } from "./ai-resource-store";
import type { DshHarnessClient, DshHarnessStatus, DshImageInput } from "./dsh-harness-client";
import type { SigmaStudioMcpLaunchSpec } from "./sigma-studio-mcp-launch";
import { enforceVisualLoop, stripVisualLoopExhausted } from "./visual-loop-enforcer";

export const SIGMA_AI_DISPLAY_NAME = "SIGMA AI";
const MAX_SIGMA_IMAGE_ATTACHMENTS = 4;

function buildSigmaImages(attachments: AiEditAttachment[] | undefined): DshImageInput[] {
  if (!Array.isArray(attachments)) return [];
  return attachments
    .flatMap((attachment) => {
      const image = parseAttachedImageDataUrl(attachment.dataUrl ?? "");
      return image ? [{ mimeType: image.mimeType, base64: image.base64, name: attachment.name }] : [];
    })
    .slice(0, MAX_SIGMA_IMAGE_ATTACHMENTS);
}

/** 利用できない理由を、利用者へ見せる文にする (設定の変数名などの詳細は添えるだけ)。 */
export function describeSigmaUnavailable(status: DshHarnessStatus): string {
  const base = status.unavailableReason === "plan"
    ? tv("run.sigmaPlanRequired")
    : status.unavailableReason === "gateway"
    ? tv("run.sigmaGatewayMissing")
    : status.unavailableReason === "node"
      ? tv("run.sigmaNodeMissing")
      : tv("run.sigmaRuntimeMissing");
  return status.error ? `${base} (${status.error})` : base;
}

function describeTurnError(message: string | null): string {
  if (message === "max-tokens") return tv("run.sigmaOutputTruncated");
  if (message === "timeout") return tv("run.sigmaTimedOut");
  if (message && /\b(AUTH|401|403|UNAUTHORIZED)\b/u.test(message)) return tv("run.sigmaGatewayRejected");
  return message || tv("run.providerEditFailed", { p0: SIGMA_AI_DISPLAY_NAME });
}

/** 続きの会話を開けなかった (履歴が消えた・版が変わった)。全文の指示で新しい会話としてやり直す合図。 */
class SigmaResumeFailedError extends Error {
  constructor() {
    super("SIGMA AI could not resume the previous session.");
    this.name = "SigmaResumeFailedError";
  }
}

function buildSigmaDescriptor(
  images: DshImageInput[],
  systemPrompt: string,
  isCancelRequested: (() => boolean) | undefined,
): McpEditProviderDescriptor<DshHarnessClient> {
  return {
    provider: "sigma",
    runtime: "sigma-mcp",
    displayName: SIGMA_AI_DISPLAY_NAME,
    missingFileIdError: tv("run.providerNeedsFile", { p0: SIGMA_AI_DISPLAY_NAME }),
    notAvailableFallbackError: tv("run.sigmaRuntimeMissing"),
    notLoggedInError: tv("run.sigmaGatewayMissing"),
    thinkingMessage: tv("run.providerThinking", { p0: SIGMA_AI_DISPLAY_NAME }),
    fallbackAnswerSummary: tv("run.providerAnswered", { p0: SIGMA_AI_DISPLAY_NAME }),
    fallbackDraftSummary: tv("run.providerDrafted", { p0: SIGMA_AI_DISPLAY_NAME }),

    async getStatus(client) {
      const status = await client.getStatus();
      return {
        available: status.available,
        loggedIn: status.loggedIn,
        error: status.available ? null : describeSigmaUnavailable(status),
      };
    },

    async prepareInstruction({ prompt }) {
      // 画像は run の入力として別に渡す (DshRunTurnParams.images) ので、本文は足さない。
      return { instruction: prompt };
    },

    async runTurn({ client, instruction, agentThreadId, mcpConfig, subagents, runId, cwd, onEvent, onDelta, onToolUse, onToolResult }) {
      if (!runId || !cwd || !mcpConfig) {
        return {
          finalText: "", isError: true, errorMessage: tv("run.sigmaRuntimeMissing"),
          agentThreadId, repairCount: 0, repairMessage: null,
        };
      }
      // 中断はターンの合間にも届く (最初のターンの前・再開に失敗した後のやり直しの前)。
      // 送る前に確かめ、止められた依頼をモデルへ送らない。
      if (isCancelRequested?.()) {
        return {
          finalText: "", isError: false, errorMessage: null,
          agentThreadId, repairCount: 0, repairMessage: null, cancelled: true,
        };
      }
      let emittedText = false;
      const result = await client.runTurn({
        runId,
        instruction,
        images,
        resumeSessionId: agentThreadId ?? null,
        cwd,
        mcp: mcpConfig as SigmaStudioMcpLaunchSpec,
        systemPrompt,
        subagents,
        // dsh は 1 ステップぶんの本文をまとめて通知する。ステップの区切りが読めるよう改行を挟む。
        onText: (text) => {
          onDelta(emittedText ? `\n\n${text}` : text);
          emittedText = true;
        },
        onReasoning: (text) => onEvent({
          kind: "stream", phase: "thinking", channel: "reasoning",
          message: tv("run.thinking"), delta: `${text}\n`, timestamp: Date.now(),
        }),
        onToolUse: tool => onToolUse(tool),
        onToolResult: result => onToolResult?.({
          toolUseId: result.toolUseId,
          images: result.images.map(image => ({ dataUrl: `data:${image.mimeType};base64,${image.base64}` })),
        }),
      });

      if (result.resumeFailed) throw new SigmaResumeFailedError();
      if (result.cancelled) {
        return {
          finalText: result.finalText, isError: false, errorMessage: null,
          agentThreadId: result.sessionId ?? undefined, repairCount: 0, repairMessage: null, cancelled: true,
        };
      }
      return {
        finalText: result.finalText,
        isError: result.isError,
        errorMessage: result.isError ? describeTurnError(result.errorMessage) : null,
        agentThreadId: result.sessionId ?? undefined,
        repairCount: 0,
        repairMessage: null,
      };
    },
  };
}

export async function runSigmaEditForIpc(args: {
  sigma: DshHarnessClient;
  payload: unknown;
  aiResources?: AiResourceRunContext;
  onEvent: (event: AiEditRunEvent) => void;
  /** この run の MCP サーバー起動仕様 (run ごとの実行コンテキストファイルを指す)。 */
  mcp: SigmaStudioMcpLaunchSpec;
  runId: string;
  userDataPath?: string;
  locale: AppLocale;
  isCancelRequested?: () => boolean;
  cwd: string;
  /**
   * サブエージェント設定から決めた内蔵AIの扱い。有効なときだけ dsh の構成にサブエージェントの
   * 部品を足し (深さと同時に動かす数は dsh が強制する)、プロンプトに方針の節を出す。
   */
  subagents?: AiSubagentPolicy;
}): Promise<AiEditRunResult> {
  const payload = (args.payload ?? {}) as { attachments?: AiEditAttachment[] };
  const images = buildSigmaImages(payload.attachments);
  const systemPrompt = createTranslator(args.locale, "prompt")("turn.assistantIntro");

  const runTurn = async (turnPayload: unknown, turnImages: DshImageInput[]): Promise<AiEditRunResult> => {
    try {
      return await runTurnOnce(turnPayload, turnImages);
    } catch (error) {
      if (!(error instanceof SigmaResumeFailedError) || !isRecord(turnPayload)) throw error;
      // 続きを開けなかったら、会話の ID を外して最初の依頼と同じ全文の指示で 1 度だけやり直す。
      // 短い続きの指示のまま新しい会話で走らせると、基本の指示も履歴も無いまま編集してしまう。
      const fresh = { ...turnPayload };
      delete fresh.agentThreadId;
      return runTurnOnce(fresh, turnImages);
    }
  };
  const runTurnOnce = (turnPayload: unknown, turnImages: DshImageInput[]) =>
    runMcpEditForIpc(buildSigmaDescriptor(turnImages, systemPrompt, args.isCancelRequested), {
      client: args.sigma,
      payload: turnPayload,
      aiResources: args.aiResources,
      locale: args.locale,
      onEvent: args.onEvent,
      suppressFinalPhase: true,
      mcpConfig: args.mcp,
      // 内蔵AIに Web 検索の道具は無い。方針の節を出すと「検索した」と書かれるので常に切る。
      webSearchEnabled: false,
      subagents: args.subagents,
      runId: args.runId,
      cwd: args.cwd,
    });

  try {
    return await runAllTurns();
  } finally {
    // この run に覚えていた「開始前の中断」を残さない。
    args.sigma.forgetRun(args.runId);
  }

  async function runAllTurns(): Promise<AiEditRunResult> {
  const initialResult = await runTurn(args.payload, images);
  const finalResult = await enforceVisualLoop({
    initialResult,
    userDataPath: args.userDataPath,
    provider: "sigma",
    runId: args.runId,
    onEvent: args.onEvent,
    isCancelRequested: args.isCancelRequested,
    runContinuation: ({ prompt, agentThreadId }) => runTurn({
      ...(isRecord(args.payload) ? args.payload : {}),
      instruction: prompt,
      agentThreadId,
      attachments: [],
    }, []),
  });

  args.onEvent({
    kind: "phase",
    phase: "complete",
    message: finalResult.status === "cancelled"
      ? tv("run.interruptedByUser")
      : finalResult.exhausted
        ? tv("run.doneVisualReviewFailed")
        : finalResult.status === "draft"
          ? tv("run.draftReady")
          : tv("run.answerComplete"),
    timestamp: Date.now(),
  });
  return stripVisualLoopExhausted(finalResult);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
