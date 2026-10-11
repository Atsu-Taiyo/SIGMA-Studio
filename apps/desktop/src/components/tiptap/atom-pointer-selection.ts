import type { Editor } from "@tiptap/core";

/**
 * 数式などの原子ノード (contenteditable=false) の上で押したドラッグを、編集面の選択追跡へ渡す口。
 *
 * 原子ノードの押下はノードビューが受ける (動かさずに離せば数式を編集で開く)。ドラッグの選択まで
 * ノードビューが自前で伸ばすと、自分の編集面の中でしか伸ばせない — 紙面の本文はユニットごとに
 * 別の編集面なので、数式から押し始めた選択だけが隣のユニット (問題文・次のチャンク) へ届かない。
 * 編集面をまたぐ追跡を持つ側 (本文の連なり) がここへ登録し、ノードビューは登録があればそちらへ
 * 任せる。登録の無い編集面 (表のセル・図形の文字など) では、ノードビューが従来どおり自分で伸ばす。
 */
export interface AtomPointerSelectionRequest {
  /** 原子ノードの上の mousedown。 */
  event: MouseEvent;
  /** 原子ノードの手前と後ろの位置。押した原子が必ず範囲に入るよう、起点はこのどちらかに置く。 */
  from: number;
  to: number;
  /** 動かさずに離したとき (クリック)。 */
  onClick: () => void;
}

/** ドラッグを引き受けたら true。 */
export type AtomPointerSelectionStarter = (request: AtomPointerSelectionRequest) => boolean;

const starters = new WeakMap<Editor, AtomPointerSelectionStarter>();

/** 編集面の追跡を登録する。戻り値で外す。 */
export function registerAtomPointerSelectionStarter(
  editor: Editor,
  starter: AtomPointerSelectionStarter,
): () => void {
  starters.set(editor, starter);
  return () => {
    if (starters.get(editor) === starter) {
      starters.delete(editor);
    }
  };
}

export function startAtomPointerSelection(editor: Editor, request: AtomPointerSelectionRequest): boolean {
  return starters.get(editor)?.(request) ?? false;
}
