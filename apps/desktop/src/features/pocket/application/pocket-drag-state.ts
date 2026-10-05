"use client";

import { useSyncExternalStore } from "react";

/**
 * ドラッグ中のチップ。ポインタの位置と、いま指している場所が受けてくれるか。
 * 動かすたびに変わるので、チップの並び (`pocket-store`) とは別にして、ドラッグの見た目
 * (ゴースト) だけが描き直されるようにする。
 */
export interface PocketDragState {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  /** 指している場所がドロップを受けるか。受けない場所では、ゴーストを薄くして知らせる。 */
  readonly accepted: boolean;
}

let state: PocketDragState | null = null;
const listeners = new Set<() => void>();

export function getPocketDragState(): PocketDragState | null {
  return state;
}

export function setPocketDragState(next: PocketDragState | null): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function usePocketDragState(): PocketDragState | null {
  return useSyncExternalStore(subscribe, getPocketDragState, () => null);
}
