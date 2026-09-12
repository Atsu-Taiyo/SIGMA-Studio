"use client";

import { useEffect, useState } from "react";

import { getBodyTextRangeSelection } from "../overlay-canvas/body-text-selection";
import {
  HELD_BODY_SELECTION_HIGHLIGHT_NAME,
  setCustomHighlight,
} from "../text-flow/custom-highlight";
import {
  collectRangeEmptyLineRects,
  collectRangeLineEndFillRects,
  isNativeBodySelectionVisible,
  mergeSelectionHighlightRects,
  shouldPaintHeldBodySelection,
  type SelectionHighlightRect,
} from "../text-flow/selection-highlight-rects";

/**
 * 図形を選んでいる間、フォーカスを失った本文の選択を描き直す。
 *
 * Chromium はフォーカスの無い contenteditable の選択をそもそも描かない。混在選択 (本文の
 * 範囲 + 図形) では、本文側が選ばれていることが画面から読めないと「図形しかコピーされない」
 * ように見えるので、保持している間だけこちらで描く。描き方は跨ぎ選択と同じ CSS Custom
 * Highlight (`::highlight(held-body-selection)`) — ブラウザがグリフの背後に描くため、
 * 有彩色文字の暗転や図形上への被さりが起きない。空行 (テキストを持たない <br>) だけは
 * Highlight が何も描かないので、従来の矩形レイヤーで印を補完する。
 *
 * Highlight はテキストしか塗らないため、数式アトムの選択背景は保持中のエディタに付ける
 * `data-held-body-selection` 属性 + PM の状態選択由来の `text-selected` 装飾が描く
 * (globals.css の対の規則)。
 *
 * 本文エディタがフォーカスを持っている間はネイティブ `::selection` が出るので重ねない。
 * チャンク跨ぎ選択中は `TextRunSelectionOverlay` が描くので、こちらは出さない。
 *
 * **ProseMirror の装飾では描けない**。装飾を出し入れするには transaction が要るが、
 * フォーカスの無いエディタに transaction を流すと PM が DOM 選択を自分の持つ選択へ
 * 同期し直し、その場で範囲が畳まれる (実測: 図形が選ばれた 3 フレーム後に collapsed)。
 * 見せるための仕掛けが見せたいものを壊すので、PM の外から Highlight として描く。
 */
export function HeldBodySelectionOverlay({ active }: { active: boolean }) {
  // 保持していない間は載せない (マウント自体を親が切る)。effect の中で「消す」を
  // 書かずに済み、選択が無い間はリスナーも走らない。
  return active ? <HeldBodySelectionRects /> : null;
}

function HeldBodySelectionRects() {
  const [rects, setRects] = useState<readonly SelectionHighlightRect[]>([]);

  useEffect(() => {
    let frame = 0;
    let markedEditor: Element | null = null;
    const markHeldEditor = (element: Element | null) => {
      if (markedEditor === element) {
        return;
      }
      markedEditor?.removeAttribute("data-held-body-selection");
      element?.setAttribute("data-held-body-selection", "");
      markedEditor = element;
    };
    const update = () => {
      const held = collectHeldBodySelection();
      setCustomHighlight(HELD_BODY_SELECTION_HIGHLIGHT_NAME, held ? [held.range] : []);
      markHeldEditor(held?.editorElement ?? null);
      // 空行の印に加えて、行末の塗り (ブロック末尾の改行タブ・折返し空白) も補完する。
      // ネイティブ ::selection はどちらも塗るが Highlight は塗らないため、保持へ切り替わる
      // 瞬間に段落末のタブが消えて見えるのを防ぐ (跨ぎ選択と同じ補完)。
      const next = held
        ? mergeSelectionHighlightRects([
          ...collectRangeEmptyLineRects(held.range),
          ...collectRangeLineEndFillRects(held.range, { continuesBeyondRange: false }),
        ])
        : [];
      setRects((current) => (sameRects(current, next) ? current : next));
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };

    update();
    // スクロールは capture で拾う (紙面はページのスクロール容器の中にある)。Highlight の
    // Range は live なので追い直すのは空行の印 (fixed の矩形) だけ。
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    window.document.addEventListener("selectionchange", schedule);
    window.document.addEventListener("focusin", schedule, true);
    window.document.addEventListener("focusout", schedule, true);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.document.removeEventListener("selectionchange", schedule);
      window.document.removeEventListener("focusin", schedule, true);
      window.document.removeEventListener("focusout", schedule, true);
      setCustomHighlight(HELD_BODY_SELECTION_HIGHLIGHT_NAME, []);
      markHeldEditor(null);
    };
  }, []);

  if (rects.length === 0) {
    return null;
  }

  return (
    <div className="text-flow-held-selection-layer" aria-hidden="true">
      {rects.map((rect, index) => (
        <div
          key={`${rect.left},${rect.top},${index}`}
          className="text-flow-held-selection"
          style={{ left: rect.left, top: rect.top, width: rect.width, height: rect.height }}
        />
      ))}
    </div>
  );
}

function collectHeldBodySelection(): { editorElement: Element; range: Range } | null {
  const range = getBodyTextRangeSelection(window.document);
  if (!range) {
    return null;
  }
  if (!shouldPaintHeldBodySelection({
    nativeSelectionVisible: isNativeBodySelectionVisible(range, window.document.activeElement),
    multiEditorTextRunSpan: Boolean(
      window.document.querySelector(".text-flow-editor[data-text-run-span]"),
    ),
  })) {
    return null;
  }
  const container = range.commonAncestorContainer;
  const element = container instanceof Element ? container : container.parentElement;
  const editorElement = element?.closest(".text-flow-editor") ?? null;
  return editorElement ? { editorElement, range } : null;
}

function sameRects(
  left: readonly SelectionHighlightRect[],
  right: readonly SelectionHighlightRect[],
): boolean {
  return left.length === right.length && left.every((rect, index) => (
    rect.left === right[index].left &&
    rect.top === right[index].top &&
    rect.width === right[index].width &&
    rect.height === right[index].height
  ));
}
