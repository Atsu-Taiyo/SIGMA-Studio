import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import { spawnCliProcess } from "./cli-spawn";
import { buildCodexChildEnv, type CodexAppServerClient } from "./codex-app-server-client";
import type { ClaudeStreamClient } from "./claude-stream-client";
import type { GeminiHeadlessClient } from "./gemini-headless-client";
import { AI_FRAME_DRAWING, normalizeFrameSvg } from "@/features/document/problem-custom-frame";
import { parseSkillFile, SKILL_CONTENT_MAX_LENGTH } from "@/lib/ai/skill-frontmatter";
import type { AiProvider } from "@/lib/ai/ai-providers";
import { createCurrentLocaleTranslator } from "@/lib/i18n";

const ta = createCurrentLocaleTranslator("ai");

// スキル編集画面の「AIで下書き」機能: ユーザーの一言の要望から、スキル本文
// (SKILL.mdのMarkdown本文、frontmatterなし)をワンショットで生成する。
//
// 意図的にMCPツールを一切経由しない (ユーザー要件: 新規MCPツールを追加しない/MCPサーバーに
// 触れない)。各プロバイダの「ツールなし1回きりのCLI呼び出し」として実装する:
// - Claude: 常設の claudeStreamClient を再利用しつつ、この呼び出しだけ mcpConfig を
//   空({mcpServers:{}})に差し替えて渡す(runTurnはmcpConfigをper-turn引数として受け取れる)。
// - Antigravity (agy): 常設の geminiHeadlessClient とは別の GeminiHeadlessClient を、
//   MCP設定ファイル(mcp_config.json)が書かれていない専用workspaceDirで構築して使う
//   (agyはワークスペース単位でMCPサーバーを解決するため、cwdを変えるだけでMCPなしにできる)。
// - Codex: 常設の codexAppServerClient (MCP同梱configで常駐するJSON-RPCサーバー)は使わず、
//   `codex exec --ignore-user-config` でconfig.toml(MCPサーバー定義はここにある)の読み込み
//   自体を止めた、素の一回きりのサブプロセスを立てる。認証(CODEX_HOME/auth.json)は
//   ignore-user-configでも読まれる(`codex exec --help`で確認済み)ため、既存クライアントの
//   codexHomeをそのまま渡してログイン状態を共有する。
//
// ストリーミング/キャンセルは呼び出し元(main.tsのai-skill-draft:generate/:cancel)が渡す
// 共通の runId で統一する。Claude/Antigravityは既存クライアントのrunTurn({runId, onDelta})に
// そのまま乗せる(client側がrunId→プロセスを管理しているので、main.tsからは
// client.cancelRun(runId)を呼ぶだけでよい)。Codexだけはこのファイルが直接spawnした
// 使い捨てプロセスなので、下の activeCodexDraftProcs で runId→child processを自前管理し、
// cancelAiSkillDraftCodexRun()をmain.tsのキャンセル分岐から呼べるようexportする。

export const AI_SKILL_DRAFT_TIMEOUT_MS = 120_000;
/**
 * A frame is drawn in the background while the reader does something else, often with a thinking
 * model (Antigravity's Flash at high effort took over 90 s). Longer than the skill draft, which
 * someone is waiting on.
 */
export const AI_PROBLEM_FRAME_TIMEOUT_MS = 300_000;

export interface AiSkillDraftContext {
  title: string;
  description: string;
  /** 既存のスキル本文。空文字なら新規作成として扱う。 */
  currentContent: string;
  /**
   * `problemFrame` のチャットで、これまでにユーザーが出した要望 (古い順)。会話そのものは
   * プロバイダ側に持たせず (呼び出しごとに新しい一回きりの実行)、必要な文脈だけをこの形で渡す。
   */
  history?: string[];
}

export interface AiSkillDraftRequest {
  provider: AiProvider;
  /** ユーザーが入力した「何をしてほしいか」の一言。 */
  prompt: string;
  context: AiSkillDraftContext;
  /**
   * 何を下書きするか。省略はスキル本文。`problemFrame` は問題の枠線の絵 (SVG 1枚) で、
   * 「ツールなし・一回きり」という呼び出しの形がそのまま使えるので同じ経路に乗せる。
   * このとき `context.currentContent` は改訂元の SVG。
   */
  purpose?: "skill" | "problemFrame";
  /**
   * 使うモデル。省略時は各プロバイダの既定。呼び出し側 (UI) が「AI設定で選んだモデル」を渡し、
   * 画面に出した名前と実際に走るモデルを一致させる。
   */
  model?: string;
  /** 推論の強さ (Claude の `--effort` / Codex の `model_reasoning_effort`)。省略は各プロバイダの既定。 */
  reasoningEffort?: string;
}

export type AiSkillDraftResult =
  | {
      ok: true;
      text: string;
      /** `problemFrame`: SVG に添えて返ってきた一言 (どんな枠にしたか)。無ければ含めない。 */
      message?: string;
    }
  | {
      ok: false;
      error: string;
      /** `problemFrame`: 絵は無かったが、モデルが文章で返した内容 (会話として見せる)。 */
      message?: string;
    };

/** 思考・返答それぞれの断片の届け先。 */
export interface AiSkillDraftStreamHandlers {
  onDelta?: (delta: string) => void;
  /** 思考の断片。プロバイダが本文を出すもの (Claude の要約・Codex の推論要約) だけ届く。 */
  onReasoning?: (delta: string) => void;
}

export interface AiSkillDraftDeps {
  claude: ClaudeStreamClient;
  /** 専用workspaceDir(MCP設定なし)で構築済みのAntigravityクライアント。 */
  geminiSkillDraft: GeminiHeadlessClient;
  codex: CodexAppServerClient;
}

export async function generateAiSkillDraft(
  request: AiSkillDraftRequest,
  deps: AiSkillDraftDeps,
  /** 呼び出し元(main.ts)が発行した、この生成を一意に識別するID。キャンセル(ai-skill-draft:cancel)
   * はこのrunIdで対象プロセス/turnを引き当てる。 */
  runId: string,
  /** ストリーミング用のraw delta通知。サニタイズ前のモデル出力の断片がそのまま渡る
   * (最終的な整形済みテキストは戻り値のtext)。 */
  onDelta?: (delta: string) => void,
  /** 思考の断片の通知 (対応するプロバイダだけ)。 */
  onReasoning?: (delta: string) => void,
): Promise<AiSkillDraftResult> {
  const userPrompt = request.prompt.trim();
  if (!userPrompt) {
    return { ok: false, error: ta("desktop.skillDraft.instructionRequired") };
  }

  const model = request.model?.trim() || undefined;
  const reasoningEffort = normalizeReasoningEffort(request.reasoningEffort);
  const isProblemFrame = request.purpose === "problemFrame";
  const fullPrompt = isProblemFrame
    ? buildProblemFrameDrawingPrompt(userPrompt, request.context.currentContent, request.context.history)
    : buildSkillDraftPrompt(userPrompt, request.context);
  // Thinking and live streaming are for the frame chat, which shows them. The skill editor keeps its
  // one-shot call as it was: it only appends the reply, and asking the CLIs for more would change
  // what they are run with for nothing.
  const options: AiSkillDraftRunOptions = {
    model,
    reasoningEffort,
    onDelta,
    timeoutMs: isProblemFrame ? AI_PROBLEM_FRAME_TIMEOUT_MS : AI_SKILL_DRAFT_TIMEOUT_MS,
    ...(isProblemFrame ? { onReasoning, streamOutput: true } : {}),
  };

  try {
    const rawText = await (request.provider === "claude"
      ? generateWithClaude(deps.claude, fullPrompt, runId, options)
      : request.provider === "antigravity"
      ? generateWithGemini(deps.geminiSkillDraft, fullPrompt, runId, options)
      : generateWithCodex(deps.codex, fullPrompt, runId, options));
    const text = isProblemFrame ? sanitizeProblemFrameDrawing(rawText) : sanitizeSkillDraftText(rawText);
    const message = isProblemFrame ? extractProblemFrameReplyMessage(rawText) : "";
    if (!text) {
      return {
        ok: false,
        error: ta("desktop.skillDraft.emptyResponse"),
        ...(message ? { message } : {}),
      };
    }
    return { ok: true, text, ...(message ? { message } : {}) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : ta("desktop.skillDraft.failed") };
  }
}

export function buildSkillDraftPrompt(userPrompt: string, context: AiSkillDraftContext): string {
  const title = context.title.trim();
  const description = context.description.trim();
  const currentContent = context.currentContent.trim();

  const sections = [
    "あなたは数学教材エディタ「Sigma Studio」で使う「スキル」の下書きを書くアシスタントです。",
    "スキルとは、教材編集を行うAIエージェントに繰り返し守らせたい手順・ルール・知識をMarkdownで書いた、再利用可能なAIへの指示書です。",
    "",
    "## このスキルの現在の情報",
    `- スキル名: ${title || "(未設定)"}`,
    `- 説明: ${description || "(未設定)"}`,
  ];

  if (currentContent) {
    sections.push(
      "",
      "## 現在のスキルの内容",
      "以下はこのスキルに既に書かれている内容です。ゼロから書き直すのではなく、ユーザーの要望に沿ってこの内容を改訂してください。",
      "",
      currentContent,
    );
  }

  sections.push(
    "",
    "## ユーザーの要望",
    userPrompt,
    "",
    "## 出力ルール(必ず守ってください)",
    "- 出力はスキル本文のMarkdownそのものだけにしてください。",
    "- frontmatter(`---`で囲まれたYAMLブロック)は含めないでください。",
    "- 出力全体をコードフェンス(```)で囲まないでください。",
    "- 前置き・確認・後書きなどの余計な文章は書かず、スキル本文だけを出力してください。",
    "- 特別な指示がない限り日本語で書いてください。",
    "- ツールは一切使用しないでください。ファイルの読み書き・コマンド実行・検索などを行わず、このプロンプトに書かれた情報だけをもとにテキストを生成してください。",
  );

  return sections.join("\n");
}

const PROBLEM_FRAME_HISTORY_LIMIT = 8;
const PROBLEM_FRAME_HISTORY_ITEM_MAX_LENGTH = 400;

export function buildProblemFrameDrawingPrompt(userPrompt: string, currentSvg: string, history: readonly string[] = []): string {
  const { width, height, slice } = AI_FRAME_DRAWING;
  const sections = [
    "あなたは数学教材エディタ「Sigma Studio」で、問題を囲む枠線の絵をSVGで描くアシスタントです。",
    "",
    "## 枠線の仕組み (必ず守ってください)",
    `- キャンバスは viewBox="0 0 ${width} ${height}" の長方形です。ルート要素は <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}"> にしてください。`,
    `- アプリはこの絵を縦横3×3の9つに切り、四隅(各 ${slice}×${slice})は形を保ったまま、四辺は問題の大きさに合わせて引き伸ばして使います。中央は文章が入るので何も描かないでください。`,
    `- したがって、飾りは四隅の ${slice}×${slice} の中に収めてください。四辺(隅と隅のあいだ)は、端から端まで届く単純な直線や帯だけにしてください。点線・模様・文字を辺に描くと、引き伸ばされて崩れます。`,
    "- 背景は透明にしてください(背景の塗りつぶしは描かない)。紙に印刷されるので、読みやすさを損なわない落ち着いた色を選んでください。",
    "- 文字(<text>)、画像、外部ファイルの参照、スクリプト、フィルター、フォントは使わないでください。図形(path, rect, circle, line, polygon)と単色・線形グラデーションだけを使ってください。",
    "- 枠の外周を線が切れないよう、線は viewBox の内側(端から線幅の半分以上内側)に描いてください。",
  ];
  if (currentSvg.trim()) {
    sections.push(
      "",
      "## 現在の枠線",
      "以下は今の枠線のSVGです。細かな修正の要望なら、ゼロから描き直さずこれを改訂してください。まったく別のデザインを求められたときは、描き直してかまいません。",
      "",
      currentSvg.trim(),
    );
  }
  const earlier = history
    .map((entry) => entry.trim().slice(0, PROBLEM_FRAME_HISTORY_ITEM_MAX_LENGTH))
    .filter(Boolean)
    .slice(-PROBLEM_FRAME_HISTORY_LIMIT);
  if (earlier.length > 0) {
    sections.push(
      "",
      "## これまでのユーザーの要望 (古い順)",
      "同じ会話の続きです。以前の要望も踏まえ、最新の要望に沿って描いてください。",
      ...earlier.map((entry, index) => `${index + 1}. ${entry}`),
    );
  }
  sections.push(
    "",
    earlier.length > 0 ? "## 最新のユーザーの要望" : "## ユーザーの要望",
    userPrompt,
    "",
    "## 出力ルール",
    "- 最初に、どんな枠にしたかを日本語で1〜2文だけ書いてください。そのあとにSVGのコードを1つだけ続けてください。",
    "- SVGはコードフェンスで囲まず、<svg ...> から </svg> までをそのまま書いてください。SVGのあとに文章は書かないでください。",
    "- ツールは一切使用しないでください。ファイルの読み書き・コマンド実行・検索などを行わず、このプロンプトの情報だけをもとに出力してください。",
  );
  return sections.join("\n");
}

const PROBLEM_FRAME_REPLY_MESSAGE_MAX_LENGTH = 400;

/**
 * モデルの返答から、SVG の前後に添えられた文章だけを取り出す (チャットの吹き出し用)。
 * コードフェンスの記号は落とす。SVG が無ければ返答全体が文章。
 */
export function extractProblemFrameReplyMessage(raw: string): string {
  const start = raw.search(/<svg[\s>]/i);
  const closeIndex = raw.toLowerCase().lastIndexOf("</svg>");
  const outside = start < 0
    ? raw
    : `${raw.slice(0, start)}\n${closeIndex >= 0 ? raw.slice(closeIndex + "</svg>".length) : ""}`;
  return outside
    .replace(/```[a-zA-Z0-9_-]*/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, PROBLEM_FRAME_REPLY_MESSAGE_MAX_LENGTH);
}

const REASONING_EFFORT_PATTERN = /^[a-z][a-z0-9_-]{1,15}$/;

function normalizeReasoningEffort(value: string | undefined): string | undefined {
  const effort = value?.trim().toLowerCase();
  return effort && REASONING_EFFORT_PATTERN.test(effort) ? effort : undefined;
}

/** モデルの出力から SVG 1枚だけを取り出す。描けていなければ空文字。 */
export function sanitizeProblemFrameDrawing(raw: string): string {
  const result = normalizeFrameSvg(raw);
  return result.ok ? result.svg : "";
}

/**
 * モデルの出力をスキル本文として使える形へ整える:
 * - 応答全体を囲むコードフェンスがあれば剥がす
 * - frontmatterブロックがあれば取り除く (parseSkillFile と同じ規則)
 * - 前後の空白を整理し、最大文字数に収める
 */
export function sanitizeSkillDraftText(raw: string, maxLength: number = SKILL_CONTENT_MAX_LENGTH): string {
  let text = raw.replace(/\r\n/g, "\n").trim();
  text = stripSurroundingCodeFence(text).trim();
  text = parseSkillFile(text).body.trim();
  if (text.length > maxLength) {
    text = text.slice(0, maxLength);
  }
  return text;
}

function stripSurroundingCodeFence(text: string): string {
  const match = /^```[a-zA-Z0-9_-]*\n([\s\S]*)\n```$/.exec(text.trim());
  return match ? match[1] : text;
}

interface AiSkillDraftRunOptions extends AiSkillDraftStreamHandlers {
  model?: string;
  reasoningEffort?: string;
  /** Ask the CLI for its incremental output (Antigravity prints nothing until the end otherwise). */
  streamOutput?: boolean;
  /** How long the run may take before it is cancelled. */
  timeoutMs: number;
}

async function generateWithClaude(
  claude: ClaudeStreamClient,
  fullPrompt: string,
  runId: string,
  options: AiSkillDraftRunOptions,
): Promise<string> {
  // 思考を見せたい呼び出しだけ要約の表示を求める。このフラグを知らない古い CLI は起動時に
  // 「unknown option」で落ちるので、その場合だけ思考なしでもう一度走らせる。
  if (options.onReasoning) {
    try {
      return await runClaudeDraft(claude, fullPrompt, runId, options, true);
    } catch (error) {
      if (!(error instanceof Error) || !/thinking-display/i.test(error.message)) {
        throw error;
      }
    }
  }
  return runClaudeDraft(claude, fullPrompt, runId, options, false);
}

async function runClaudeDraft(
  claude: ClaudeStreamClient,
  fullPrompt: string,
  runId: string,
  { model, reasoningEffort, onDelta, onReasoning, timeoutMs }: AiSkillDraftRunOptions,
  showThinking: boolean,
): Promise<string> {
  // クライアントのcancelRunはタイムアウトでもユーザー中止でも同じcancelled:trueを返すため、
  // どちらだったかをここで覚えてメッセージを出し分ける。
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    claude.cancelRun(runId);
  }, timeoutMs);
  try {
    const result = await claude.runTurn({
      instruction: fullPrompt,
      // 空のmcpServersを渡し、このturnだけMCPツールを一切与えない(常設クライアントの
      // 既定mcpConfigはsigma-studio-localサーバーを含むため、明示的に上書きする)。
      mcpConfig: { mcpServers: {} },
      runId,
      onDelta,
      ...(model ? { model } : {}),
      ...(reasoningEffort ? { reasoningEffort } : {}),
      ...(showThinking ? { thinkingDisplay: "summarized" as const, onThinkingDelta: onReasoning } : {}),
    });
    if (result.cancelled) {
      throw new Error(timedOut ? ta("desktop.skillDraft.timedOut") : ta("desktop.skillDraft.cancelled"));
    }
    if (result.isError || !result.finalText.trim()) {
      throw new Error(result.finalText.trim() || ta("desktop.skillDraft.providerFailed", { provider: "Claude" }));
    }
    return result.finalText;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

async function generateWithGemini(
  gemini: GeminiHeadlessClient,
  fullPrompt: string,
  runId: string,
  { model, onDelta, streamOutput, timeoutMs }: AiSkillDraftRunOptions,
): Promise<string> {
  // generateWithClaudeと同じ理由で、タイムアウト起因のcancelを区別する。
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    gemini.cancelRun(runId);
  }, timeoutMs);
  try {
    // print モードは本文が終了時まで出ないので、途中経過を見せるために stream-json で起動する。
    // (Antigravity の CLI は思考の本文を出さないので、届くのは返答の断片だけ。)
    const result = await gemini.runTurn({
      instruction: fullPrompt,
      runId,
      onDelta,
      ...(streamOutput ? { streamOutput: true } : {}),
      ...(model ? { model } : {}),
    });
    if (result.cancelled) {
      throw new Error(timedOut ? ta("desktop.skillDraft.timedOut") : ta("desktop.skillDraft.cancelled"));
    }
    if (result.isError || !result.finalText.trim()) {
      throw new Error(result.errorMessage ?? ta("desktop.skillDraft.providerFailed", { provider: "Antigravity" }));
    }
    return result.finalText;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

// runId -> このCodex一回きり生成の子プロセスのハンドル。codexAppServerClient (常設app-server
// JSON-RPC、別のturn管理を持つ) とは別系統: このファイルが直接spawnしたプロセスなので、
// キャンセルもこのファイル内で完結させる。cancelAiSkillDraftCodexRun() を通じて
// main.tsのai-skill-draft:cancelから叩けるようexportする。markCancelled() は
// generateWithCodex のclose handlerに「タイムアウトではなくユーザーキャンセルだった」ことを
// 伝える(エラーメッセージの出し分け用)。
const activeCodexDraftProcs = new Map<string, { proc: ReturnType<typeof spawnCliProcess>; markCancelled: () => void }>();

/** SIGTERMで止め、猶予時間内に終了しなければSIGKILLへ昇格する(タイムアウト/ユーザーキャンセル共通)。 */
function killCodexDraftProcess(proc: ReturnType<typeof spawnCliProcess>, graceMs = 3000): void {
  try {
    proc.kill("SIGTERM");
  } catch {
    // already exited
  }
  const killTimer = setTimeout(() => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
  }, graceMs);
  killTimer.unref?.();
}

/** ai-skill-draft:cancel のCodex分岐から呼ばれるユーザーキャンセル処理。 */
export function cancelAiSkillDraftCodexRun(runId: string): boolean {
  const entry = activeCodexDraftProcs.get(runId);
  if (!entry) {
    return false;
  }
  entry.markCancelled();
  return true;
}

export interface CodexExecJsonLineResult {
  /** この行が完了したagent_messageアイテムを運んでいれば、そのテキスト。 */
  agentMessageText: string | null;
  /** この行が完了した reasoning アイテム (推論の要約) を運んでいれば、そのテキスト。無ければキー自体を持たない。 */
  reasoningText?: string;
  /** この行がエラー系イベントであれば、人間可読なメッセージへのベストエフォート変換。 */
  failureMessage: string | null;
}

/**
 * `codex exec --json` の1行(JSONL)をパースする。
 *
 * codex-cli 0.143.0で実機確認した限り、1turnにつき概ね次のイベント列が届く:
 *   {"type":"thread.started","thread_id":"..."}
 *   {"type":"turn.started"}
 *   {"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{...}}
 *
 * 重要な発見: このJSONLプロトコルには、テキストの部分差分(delta)イベントが存在しない
 * (常設app-server用のJSON-RPCプロトコルにある `item/agentMessage/delta` 通知
 * — codex-app-server-client.ts 参照 — とは別物で、execの `--json` にはその相当機能がない)。
 * agent_messageの全文は `item.completed` の1行にまとめて届く。そのため、このexecベースの
 * ワンショット呼び出しで実現できる「ストリーミング」は、その1行が届いた時点で即座に
 * onDeltaを1回呼ぶこと(プロセス終了を待って`--output-last-message`ファイルを読むより早い)
 * が上限であり、それ以上細かい進捗イベントは提供されない。
 *
 * 失敗時は代わりに次のような行が届く(`-m` に無効なモデル名を渡して実機確認):
 *   {"type":"item.completed","item":{"id":"item_0","type":"error","message":"..."}}
 *   {"type":"error","message":"{\"type\":\"error\",\"status\":400,\"error\":{...}}"}
 *   {"type":"turn.failed","error":{"message":"{...}"}}
 */
export function parseCodexExecJsonLine(line: string): CodexExecJsonLineResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return { agentMessageText: null, failureMessage: null };
  }
  let event: unknown;
  try {
    event = JSON.parse(trimmed);
  } catch {
    return { agentMessageText: null, failureMessage: null };
  }
  if (typeof event !== "object" || event === null) {
    return { agentMessageText: null, failureMessage: null };
  }
  const record = event as Record<string, unknown>;
  if (record.type === "item.completed" && typeof record.item === "object" && record.item !== null) {
    const item = record.item as Record<string, unknown>;
    if (item.type === "agent_message" && typeof item.text === "string") {
      return { agentMessageText: item.text, failureMessage: null };
    }
    if (item.type === "reasoning" && typeof item.text === "string" && item.text.trim()) {
      return { agentMessageText: null, failureMessage: null, reasoningText: item.text };
    }
    if (item.type === "error" && typeof item.message === "string") {
      return { agentMessageText: null, failureMessage: unwrapCodexErrorMessage(item.message) };
    }
  }
  if (record.type === "error" && typeof record.message === "string") {
    return { agentMessageText: null, failureMessage: unwrapCodexErrorMessage(record.message) };
  }
  if (record.type === "turn.failed" && typeof record.error === "object" && record.error !== null) {
    const errorObj = record.error as Record<string, unknown>;
    if (typeof errorObj.message === "string") {
      return { agentMessageText: null, failureMessage: unwrapCodexErrorMessage(errorObj.message) };
    }
  }
  return { agentMessageText: null, failureMessage: null };
}

/**
 * 上流(OpenAI API)のエラーは `message` フィールドの中にさらにJSON文字列として埋め込まれて
 * 届く(実機確認: `{"type":"error","status":400,"error":{"type":"invalid_request_error",
 * "message":"..."}}`)。可能なら最も内側の人間可読メッセージへ展開し、失敗すれば生の文字列を
 * そのまま使う。
 */
function unwrapCodexErrorMessage(message: string): string {
  try {
    const parsed = JSON.parse(message) as { error?: { message?: unknown } };
    const inner = parsed?.error?.message;
    if (typeof inner === "string" && inner) {
      return inner;
    }
  } catch {
    // JSONではない。生の文字列をそのまま使う。
  }
  return message;
}

async function generateWithCodex(
  codex: CodexAppServerClient,
  fullPrompt: string,
  runId: string,
  { model, reasoningEffort, onDelta, onReasoning, timeoutMs }: AiSkillDraftRunOptions,
): Promise<string> {
  const codexBin = await codex.resolveCodexBinForSpawn();
  const codexHome = codex.getCodexHome();
  // 常設の codexWorkspace (app-server用、他タスクのファイルが置かれうる) とは別の、
  // この一回きりの生成専用のディレクトリを使う。
  const workspaceDir = path.join(path.dirname(codexHome), "codex-skill-draft-workspace");
  await fs.mkdir(workspaceDir, { recursive: true });
  const outputFile = path.join(workspaceDir, `output-${Date.now()}-${crypto.randomUUID()}.txt`);

  const args = [
    "exec",
    // config.toml (MCPサーバー定義・web_search設定等が書かれている) を一切読み込まない。
    // 認証(auth.json)はCODEX_HOME経由でこのフラグでも読まれる(`codex exec --help`で確認済み)。
    "--ignore-user-config",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    // JSONL進捗イベントを標準出力に流す。parseCodexExecJsonLine のコメント参照:
    // agent_messageの全文が1行にまとめて届くだけでdeltaは無いが、プロセス終了と
    // --output-last-message ファイルの読み取りを待つより早くonDeltaを呼べる。
    "--json",
    "-C",
    workspaceDir,
    // JSONイベントからも全文が取れるが、フォーマット差異(将来のcodex-cliバージョン等)への
    // フォールバックとして引き続き書かせておく。
    "--output-last-message",
    outputFile,
    ...(model ? ["--model", model] : []),
    ...(reasoningEffort ? ["-c", `model_reasoning_effort="${reasoningEffort}"`] : []),
    // 推論の要約を出させる (出るのは各推論の完了時に1項目ずつ)。思考を見せたい呼び出しだけ。
    ...(onReasoning ? ["-c", 'model_reasoning_summary="auto"'] : []),
  ];

  return new Promise<string>((resolve, reject) => {
    const proc = spawnCliProcess(codexBin, args, {
      cwd: workspaceDir,
      env: buildCodexChildEnv(codexHome),
      stdio: "pipe",
      windowsHide: true,
    });
    let settled = false;
    let stderrTail = "";
    let cancelledByUser = false;
    let latestAgentMessageText: string | null = null;
    let structuredFailureMessage: string | null = null;

    activeCodexDraftProcs.set(runId, {
      proc,
      markCancelled: () => {
        cancelledByUser = true;
        killCodexDraftProcess(proc);
      },
    });

    const finish = (fn: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      activeCodexDraftProcs.delete(runId);
      fn();
    };

    const timeout = setTimeout(() => {
      finish(() => {
        killCodexDraftProcess(proc);
        reject(new Error(ta("desktop.skillDraft.timedOut")));
      });
    }, timeoutMs);

    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      const { agentMessageText, failureMessage, reasoningText } = parseCodexExecJsonLine(line);
      if (reasoningText) {
        onReasoning?.(reasoningText);
      }
      if (agentMessageText !== null) {
        latestAgentMessageText = agentMessageText;
        onDelta?.(agentMessageText);
      }
      if (failureMessage !== null) {
        structuredFailureMessage = failureMessage;
      }
    });
    rl.once("close", () => rl.removeAllListeners());

    proc.stdin.on("error", () => {
      // プロンプト送信前にプロセスが終了した場合のEPIPEはclose側で処理する。
    });
    proc.stderr.on("data", (data: Buffer) => {
      const text = data.toString().trim();
      if (text) {
        stderrTail = text.slice(0, 1000);
      }
    });
    proc.once("error", (error: Error) => {
      finish(() => reject(new Error(ta("desktop.skillDraft.codexLaunchFailed", { reason: error.message }))));
    });
    proc.once("close", (code: number | null) => {
      finish(() => {
        void (async () => {
          try {
            if (cancelledByUser) {
              reject(new Error(ta("desktop.skillDraft.cancelled")));
              return;
            }
            if (code === 0 && latestAgentMessageText && latestAgentMessageText.trim()) {
              resolve(latestAgentMessageText);
              return;
            }
            // JSONイベントから全文が取れなかった場合の後方互換フォールバック。
            let text = "";
            try {
              text = await fs.readFile(outputFile, "utf8");
            } catch {
              // 出力ファイルが無い(異常終了等)。stderrへフォールバックする。
            }
            if (code === 0 && text.trim()) {
              resolve(text);
              return;
            }
            reject(new Error(structuredFailureMessage || stderrTail || ta("desktop.skillDraft.codexExitFailed", {
              code: code ?? "null",
            })));
          } finally {
            void fs.unlink(outputFile).catch(() => {});
          }
        })();
      });
    });

    try {
      proc.stdin.write(fullPrompt, (error) => {
        if (error) {
          finish(() => reject(new Error(ta("desktop.skillDraft.codexWriteFailedWithReason", { reason: error.message }))));
        }
      });
      proc.stdin.end();
    } catch (error) {
      finish(() => reject(error instanceof Error ? error : new Error(ta("desktop.skillDraft.codexWriteFailed"))));
    }
  });
}
