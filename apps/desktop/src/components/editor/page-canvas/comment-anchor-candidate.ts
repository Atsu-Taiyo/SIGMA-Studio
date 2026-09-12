/**
 * コメント候補アンカーを親へ通知してよいかの判定。
 *
 * 通知元は 2 つある — テキスト選択を見張る経路と、選択中のブロック/数式を見る経路。両者が
 * 1 つの `onCommentAnchorCandidateChange` を叩くので、所有権を決めずに de-dupe だけ挟むと
 * 「テキスト選択なし → null」と「ブロック選択あり → anchor」が交互に通知され、親の再描画が
 * 自分自身を再実行する無限ループになる (実測: 待機中に TextFlowEditor が毎秒 650 回描画)。
 *
 * 規則は 2 つだけ:
 *   1. 所有権 — テキスト選択が生きている間はテキスト選択側が持つ。無いときは選択ターゲット側。
 *   2. 最終 de-dupe — 実際に親へ渡した最後の値と同じなら通知しない。
 *
 * 判定を DOM から切り離した純関数にしてあるので、往復の有無をユニットテストで固定できる。
 */
import { getCommentAnchorCandidateKey, type SigmaCommentAnchor } from "@/features/document";
import type { CommentAnchorPopoverState, SelectionActionPopoverPosition } from "./popover-anchors";

export interface CommentAnchorCandidateGate {
  /** 実際に親へ渡した最後のキー。まだ 1 度も渡していなければ null。 */
  readonly emittedKey: string | null;
  /** テキスト選択が生きているか。真実を知っているのはテキスト選択側の経路だけ。 */
  readonly textSelectionActive: boolean;
}

export interface CommentAnchorCandidateDecision {
  readonly emit: boolean;
  readonly gate: CommentAnchorCandidateGate;
  /**
   * テキスト選択が終わって通知権が選択ターゲット側へ戻ったか。呼び出し側はこれを見て
   * 選択ターゲット側の再評価を促す。`retainOnClear` のときは false — 保持したい候補を
   * 選択ターゲット側に上書きさせないため。
   */
  readonly handOverToSelectedTarget: boolean;
}

export const INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE: CommentAnchorCandidateGate = {
  emittedKey: null,
  textSelectionActive: false,
};

/**
 * 通知の de-dupe に使う候補アンカーのキー。引用文は入れない — 本文を 1 文字打つたびに
 * 引用が変わるので、入れると「同じ段落を指したまま」でも毎回通知が飛ぶ。
 */
export function commentAnchorCandidateKey(anchor: SigmaCommentAnchor | null): string {
  return getCommentAnchorCandidateKey(anchor);
}

/**
 * テキスト選択がある状態での通知判定。
 *
 * `anchor` が null でも「選択はある」— 範囲の端がブロックに解決できずコメントアンカーを
 * 作れなかっただけ。所有権はテキスト選択側に残す (ここで手放すと、選択したままなのに
 * 選択ブロックの候補が割り込む)。
 */
export function decideTextSelectionCommentAnchor(
  gate: CommentAnchorCandidateGate,
  anchor: SigmaCommentAnchor | null,
): CommentAnchorCandidateDecision {
  const key = commentAnchorCandidateKey(anchor);
  if (gate.emittedKey === key) {
    return { emit: false, gate: { ...gate, textSelectionActive: true }, handOverToSelectedTarget: false };
  }
  return {
    emit: true,
    gate: { emittedKey: key, textSelectionActive: true },
    handOverToSelectedTarget: false,
  };
}

/**
 * テキスト選択が消えたときの判定。
 *
 * ここでは **通知しない**。null を挟んでから選択ブロックの候補を出すと、候補が一瞬消えて
 * 戻る (ポップオーバーが点滅する)。所有権だけ返し、次に出す値は選択ターゲット側に決めさせる。
 * 選択が元々無かったとき (アイドル中の定期チェック) は所有権の移動も起きない — これを
 * 毎回起こしていたのが自己再レンダーループの本体だった。
 */
export function decideTextSelectionCleared(
  gate: CommentAnchorCandidateGate,
  options: { retainOnClear?: boolean } = {},
): CommentAnchorCandidateDecision {
  if (!gate.textSelectionActive) {
    return { emit: false, gate, handOverToSelectedTarget: false };
  }
  // AI ピン留め中は選択を解いても候補を保持する (retainCandidateOnTextSelectionClear)。
  // 所有権を返すと選択ターゲット側が自分の候補で上書きしてしまうので、返さない。
  if (options.retainOnClear) {
    return {
      emit: false,
      gate: { ...gate, textSelectionActive: false },
      handOverToSelectedTarget: false,
    };
  }
  return {
    emit: false,
    gate: { ...gate, textSelectionActive: false },
    handOverToSelectedTarget: true,
  };
}

/**
 * 選択ブロック / 選択数式の経路からの通知判定。テキスト選択が生きている間は黙る
 * (テキスト選択の方が具体的な候補なので、そちらが所有権を持つ)。
 */
export function decideSelectedTargetCommentAnchor(
  gate: CommentAnchorCandidateGate,
  anchor: SigmaCommentAnchor | null,
): CommentAnchorCandidateDecision {
  if (gate.textSelectionActive) {
    return { emit: false, gate, handOverToSelectedTarget: false };
  }
  const key = commentAnchorCandidateKey(anchor);
  if (gate.emittedKey === key) {
    return { emit: false, gate, handOverToSelectedTarget: false };
  }
  return { emit: true, gate: { ...gate, emittedKey: key }, handOverToSelectedTarget: false };
}

export interface ExtensionActionPopoverLike {
  action: { key: string };
  position: SelectionActionPopoverPosition;
}

/**
 * 位置は端数まで一致を求めない。スクロールやズームの丸めで 0.2px 動いただけの再計算を
 * 「変化」として state に流すと、親まで再描画が伝播する。
 */
export function samePopoverPosition(
  a: SelectionActionPopoverPosition,
  b: SelectionActionPopoverPosition,
): boolean {
  return Math.round(a.left) === Math.round(b.left) && Math.round(a.top) === Math.round(b.top);
}

export function sameExtensionActionPopover(
  current: ExtensionActionPopoverLike | null,
  next: ExtensionActionPopoverLike | null,
): boolean {
  if (current === next) {
    return true;
  }
  if (!current || !next) {
    return false;
  }
  return current.action.key === next.action.key && samePopoverPosition(current.position, next.position);
}

export function sameCommentAnchorPopover(
  current: CommentAnchorPopoverState | null,
  next: CommentAnchorPopoverState | null,
): boolean {
  if (current === next) {
    return true;
  }
  if (!current || !next) {
    return false;
  }
  return commentAnchorCandidateKey(current.anchor) === commentAnchorCandidateKey(next.anchor)
    && samePopoverPosition(current.position, next.position);
}
