import type { AiProvider } from "@/lib/ai/ai-providers";
import type { CustomFrameTarget } from "@/lib/custom-frame";

/**
 * 枠線を AI と描く「チャット」の状態と、その純粋な読み取り。問題の枠でも箱の枠でも同じ会話で、
 * 違うのは対象 (`CustomFrameTarget`) だけ。会話はダイアログが閉じても続く (ストアが持つ) ので、
 * 画面の state ではなくここへ置く。
 */

/** AI が描いた枠の絵。`normalizeFrameSvg` を通った正規形。 */
export interface FrameChatDrawing {
  svg: string;
  width: number;
  height: number;
}

export interface FrameChatUserTurn {
  id: string;
  role: "user";
  text: string;
  at: number;
}

export type FrameChatAssistantStatus = "running" | "done" | "error" | "cancelled";

export interface FrameChatAssistantTurn {
  id: string;
  role: "assistant";
  status: FrameChatAssistantStatus;
  provider: AiProvider;
  /** 実行中に届いた返答の生テキスト (前置きの一言 + 書きかけの SVG)。終わったら空にする。 */
  streamText: string;
  /** 流れてきた思考の本文。本文を出さないプロバイダ (Antigravity など) では空のまま。 */
  reasoningText: string;
  /** SVG の前後に添えられた一言 (どんな枠にしたか)。 */
  message: string;
  drawing: FrameChatDrawing | null;
  /** 元の絵を直す依頼だった (新しく描く依頼ではない)。 */
  revised: boolean;
  error: string | null;
  startedAt: number;
  /** 返答の最初の断片が届いた時刻。思考が終わって描き始めた目安。 */
  replyStartedAt: number | null;
  endedAt: number | null;
}

export type FrameChatTurn = FrameChatUserTurn | FrameChatAssistantTurn;

export interface FrameChatSession {
  key: string;
  documentIdentityKey: string;
  /** どの問題 (または箱) の枠か。 */
  target: CustomFrameTarget;
  turns: FrameChatTurn[];
  /** 実行中の IPC の runId。中止に使う。 */
  runId: string | null;
  /** 対象の枠として使われた返答。 */
  appliedTurnId: string | null;
}

/** 会話は「どの教材の、どの問題 (箱) の枠か」で分ける。同じ id の問題と箱は別の会話。 */
export function frameChatKey(documentIdentityKey: string | null | undefined, target: CustomFrameTarget): string {
  return `${documentIdentityKey ?? ""}\u0000${target.kind}\u0000${target.id}`;
}

export function isFrameChatRunning(session: FrameChatSession | null | undefined): boolean {
  return session?.runId != null
    || session?.turns.some((turn) => turn.role === "assistant" && turn.status === "running") === true;
}

/** 会話の中で最後に描かれた枠。次の依頼の「元の絵」になる。 */
export function latestFrameChatDrawing(session: FrameChatSession | null | undefined): FrameChatDrawing | null {
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
export function frameChatHistory(session: FrameChatSession | null | undefined): string[] {
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
