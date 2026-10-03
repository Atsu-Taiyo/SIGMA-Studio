"use client";

import { useSyncExternalStore } from "react";

import { createId } from "@/lib/id";

import {
  addPocketItem,
  removePocketItems,
  restorePocketItems,
  type PocketAddOutcome,
  type PocketItem,
  type PocketRemovedItem,
} from "../model/pocket-items";

/**
 * 直前に外した項目。「元に戻す」が使えるのはこの 1 回分だけで、次に何かを外す・入れると置き換わる。
 * `token` は表示側が「新しい取り外しが起きた」ことを区別するための通し番号 (時刻ではない)。
 */
export interface PocketRemoval {
  readonly token: number;
  readonly removed: readonly PocketRemovedItem[];
}

/** ポケットが利用者に伝える、うまくいかなかった理由。うまくいったときは何も伝えない (カードが増えるのが答え)。 */
export type PocketNoticeKind = "nothing" | "full" | "tooLarge" | "unsupported" | "rejected";

export interface PocketNotice {
  readonly kind: PocketNoticeKind;
  /** 同じ種類が続けて起きても、表示を出し直して時間切れを数え直すための通し番号。 */
  readonly token: number;
}

export interface PocketState {
  readonly items: readonly PocketItem[];
  /** カードの並びを開いているか。畳むと細い帯 (項目があるとき) か非表示 (空のとき)。 */
  readonly expanded: boolean;
  readonly removal: PocketRemoval | null;
  /** 入れた直後の項目。カードを一瞬だけ目立たせ、並びをそこまでスクロールする合図。 */
  readonly justAdded: { readonly id: string; readonly token: number } | null;
  readonly notice: PocketNotice | null;
}

/** 紙面の高さに効く、ポケットの 3 つの姿。 */
export type PocketPhase = "hidden" | "collapsed" | "expanded";

const INITIAL_STATE: PocketState = { items: [], expanded: false, removal: null, justAdded: null, notice: null };

let state: PocketState = INITIAL_STATE;
let sequence = 0;
const listeners = new Set<() => void>();

function commit(next: PocketState): void {
  if (next === state) {
    return;
  }
  state = next;
  listeners.forEach((listener) => listener());
}

export function getPocketState(): PocketState {
  return state;
}

export function subscribePocket(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * ポケットは教材ではなくアプリの作業台なので、教材の保存・共有・履歴のどこにも載らない。
 * このモジュールの変数がレンダラの存続中だけ持つ状態の全てで、タブや教材を切り替えても残る。
 */
export function usePocketState(): PocketState {
  return useSyncExternalStore(subscribePocket, getPocketState, () => INITIAL_STATE);
}

export function getPocketPhase(current: PocketState): PocketPhase {
  if (current.expanded) {
    return "expanded";
  }
  return current.items.length > 0 ? "collapsed" : "hidden";
}

/**
 * 姿 (hidden / collapsed / expanded) だけを購読する。EditorShell は紙面の高さを決めるために
 * これを読むので、通知や直後の強調のような姿が変わらない更新で再描画させない。
 */
export function usePocketPhase(): PocketPhase {
  return useSyncExternalStore(
    subscribePocket,
    () => getPocketPhase(state),
    () => "hidden",
  );
}

/** コピーが書いたクリップボードの内容を末尾へ入れ、並びを開く。入れられなければ理由を返す。 */
export function addToPocket(clip: Readonly<Record<string, string>>, now: number = Date.now()): PocketAddOutcome {
  const outcome = addPocketItem(state.items, clip, { id: createId("pocket"), addedAt: now });
  if (!outcome.ok) {
    return outcome;
  }
  sequence += 1;
  commit({
    ...state,
    items: outcome.items,
    expanded: true,
    removal: null,
    justAdded: { id: outcome.item.id, token: sequence },
    notice: null,
  });
  return outcome;
}

/**
 * うまくいかなかった理由を、並びを開いて見せる。空で隠れているポケットも、ここで姿を現す
 * (ショートカットを押しても何も起きないままにしない)。
 */
export function showPocketNotice(kind: PocketNoticeKind): void {
  sequence += 1;
  commit({ ...state, expanded: true, notice: { kind, token: sequence } });
}

export function dismissPocketNotice(token?: number): void {
  if (!state.notice || (token !== undefined && state.notice.token !== token)) {
    return;
  }
  commit({ ...state, notice: null });
}

export function removeFromPocket(ids: readonly string[]): void {
  const { items, removed } = removePocketItems(state.items, new Set(ids));
  if (removed.length === 0) {
    return;
  }
  sequence += 1;
  commit({ ...state, items, removal: { token: sequence, removed }, justAdded: null });
}

export function clearPocket(): void {
  removeFromPocket(state.items.map((item) => item.id));
}

/** 直前の取り外しを元の位置へ戻す。戻せるものが無ければ何もしない。 */
export function undoPocketRemoval(): void {
  if (!state.removal) {
    return;
  }
  commit({ ...state, items: restorePocketItems(state.items, state.removal.removed), removal: null });
}

/** 「元に戻す」を引っ込める (時間切れ・他の操作)。項目は戻さない。 */
export function dismissPocketRemoval(token?: number): void {
  if (!state.removal || (token !== undefined && state.removal.token !== token)) {
    return;
  }
  commit({ ...state, removal: null });
}

export function setPocketExpanded(expanded: boolean): void {
  if (state.expanded === expanded) {
    return;
  }
  commit({ ...state, expanded });
}

export function togglePocketExpanded(): void {
  setPocketExpanded(!state.expanded);
}

/** テストが各ケースを空の状態から始めるための初期化。製品コードからは呼ばない。 */
export function resetPocketForTests(): void {
  sequence = 0;
  state = INITIAL_STATE;
  listeners.forEach((listener) => listener());
}
