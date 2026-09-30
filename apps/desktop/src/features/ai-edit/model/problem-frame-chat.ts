import type { AiProvider } from "@/lib/ai/ai-providers";

/**
 * 問題の枠線を AI と描く「チャット」の状態と、その純粋な読み取り。
 * 会話はダイアログが閉じても続く (ストアが持つ) ので、画面の state ではなくここへ置く。
 */

/** AI が描いた枠の絵。`normalizeFrameSvg` を通った正規形。 */
export interface ProblemFrameChatDrawing {
  svg: string;
  width: number;
  height: number;
}

export interface ProblemFrameChatUserTurn {
  id: string;
  role: "user";
  text: string;
  at: number;
}

export type ProblemFrameChatAssistantStatus = "running" | "done" | "error" | "cancelled";

export interface ProblemFrameChatAssistantTurn {
  id: string;
  role: "assistant";
  status: ProblemFrameChatAssistantStatus;
  provider: AiProvider;
  /** 実行中に届いた返答の生テキスト (前置きの一言 + 書きかけの SVG)。終わったら空にする。 */
  streamText: string;
  /** 流れてきた思考の本文。本文を出さないプロバイダ (Antigravity など) では空のまま。 */
  reasoningText: string;
  /** SVG の前後に添えられた一言 (どんな枠にしたか)。 */
  message: string;
  drawing: ProblemFrameChatDrawing | null;
  /** 元の絵を直す依頼だった (新しく描く依頼ではない)。 */
  revised: boolean;
  error: string | null;
  startedAt: number;
  /** 返答の最初の断片が届いた時刻。思考が終わって描き始めた目安。 */
  replyStartedAt: number | null;
  endedAt: number | null;
}

export type ProblemFrameChatTurn = ProblemFrameChatUserTurn | ProblemFrameChatAssistantTurn;

export interface ProblemFrameChatSession {
  key: string;
  documentIdentityKey: string;
  problemId: string;
  turns: ProblemFrameChatTurn[];
  /** 実行中の IPC の runId。中止に使う。 */
  runId: string | null;
  /** 問題の枠として使われた返答。 */
  appliedTurnId: string | null;
}

/** 会話は「どの教材の、どの問題の枠か」で分ける。 */
export function problemFrameChatKey(documentIdentityKey: string | null | undefined, problemId: string): string {
  return `${documentIdentityKey ?? ""}\u0000${problemId}`;
}

export function isProblemFrameChatRunning(session: ProblemFrameChatSession | null | undefined): boolean {
  return session?.runId != null
    || session?.turns.some((turn) => turn.role === "assistant" && turn.status === "running") === true;
}

/** 会話の中で最後に描かれた枠。次の依頼の「元の絵」になる。 */
export function latestProblemFrameDrawing(session: ProblemFrameChatSession | null | undefined): ProblemFrameChatDrawing | null {
  const turns = session?.turns ?? [];
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    if (turn.role === "assistant" && turn.drawing) {
      return turn.drawing;
    }
  }
  return null;
}

/** これまでにユーザーが出した要望 (古い順)。次の実行へ文脈として渡す。 */
export function problemFrameChatHistory(session: ProblemFrameChatSession | null | undefined): string[] {
  return (session?.turns ?? []).flatMap((turn) => (turn.role === "user" ? [turn.text] : []));
}

const SVG_OPEN = /<svg[\s>]/i;
const PARTIAL_SVG_OPEN = /<(?:s|sv|svg)?$/i;

/**
 * 流れてくる返答を「一言」と「描いている SVG」に分ける。SVG のコードそのものは
 * 画面へ出さず、書き進んだ量だけ見せる。`<svg` の書きかけ (`<sv`) も一言に混ぜない。
 */
export function splitStreamedFrameReply(raw: string): { message: string; drawingChars: number } {
  const start = raw.search(SVG_OPEN);
  const beforeSvg = start >= 0 ? raw.slice(0, start) : raw.replace(PARTIAL_SVG_OPEN, "");
  const message = beforeSvg.replace(/```[a-zA-Z0-9_-]*\s*$/, "").replace(/```[a-zA-Z0-9_-]*/g, "").trim();
  return { message, drawingChars: start >= 0 ? raw.length - start : 0 };
}
