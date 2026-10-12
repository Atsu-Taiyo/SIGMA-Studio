"use client";

import { useEffect, useState } from "react";

const BODY_EDITOR_SELECTOR = ".text-flow-editor";

/**
 * 本文の選択を持ったまま、本文の外の入力欄 (ツールバーの文字サイズ・行間・色の HEX・書体の検索など)
 * へフォーカスが移ったとき、その本文エディタの root を返す。
 *
 * 入力欄はブラウザの選択そのものを自分の中へ移すので、本文の選択は画面から消える — 何に効くのかが
 * 見えないまま値を打つことになる。ProseMirror は状態選択を保っているので、移っている間は
 * `HeldBodySelectionOverlay` がそこから描き直す。本文エディタへフォーカスが戻れば (ネイティブの
 * 選択が見えるので) 外す。入力欄から入力欄へ移る間は持ち続ける。
 */
export function useChromeHeldBodySelection(): HTMLElement | null {
  const [heldEditor, setHeldEditor] = useState<HTMLElement | null>(null);

  useEffect(() => {
    const handleFocusIn = (event: FocusEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(BODY_EDITOR_SELECTOR)) {
        setHeldEditor(null);
        return;
      }
      const previous = event.relatedTarget instanceof Element
        ? event.relatedTarget.closest<HTMLElement>(BODY_EDITOR_SELECTOR)
        : null;
      if (previous) {
        setHeldEditor(previous);
      }
    };
    window.document.addEventListener("focusin", handleFocusIn, true);
    return () => window.document.removeEventListener("focusin", handleFocusIn, true);
  }, []);

  return heldEditor;
}
