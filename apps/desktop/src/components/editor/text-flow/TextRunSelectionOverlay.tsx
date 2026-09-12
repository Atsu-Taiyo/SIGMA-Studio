"use client";

import { useEffect, useState } from "react";

import { setCustomHighlight, TEXT_RUN_SPAN_HIGHLIGHT_NAME } from "./custom-highlight";
import {
  mergeSelectionHighlightRects,
  type SelectionHighlightRect,
} from "./selection-highlight-rects";
import { getTextRunSpanPaintModel, subscribeTextRunSpan } from "./text-run-span";
import {
  getBoxFragmentSelectionRanges,
  subscribeBoxFragmentSelection,
} from "./box-fragment-selection";

/**
 * 本文チャンクを跨ぐ選択の描画。Chromium はフォーカスの無い contenteditable の
 * ::selection を描かないので、各ユニットの担当範囲の DOM Range を CSS Custom Highlight API
 * (`::highlight(text-run-span)`) に登録し、ブラウザにグリフの背後 (ネイティブ選択と同じ層)
 * で描かせる。fixed レイヤー + multiply の矩形帯は、有彩色文字の暗転・隣接行の帯の重なり縞・
 * overlay 図形への被さりが構造的に消えないため廃止した (色は custom-highlight.ts が持つ)。
 *
 * Highlight が何も描かない空行 (テキストを持たない <br>) だけは、従来の矩形レイヤーで
 * 「選択された改行」の印を補完する。クラスは図形混在選択 (`HeldBodySelectionOverlay`) と
 * 同じ — チャンク境界で見た目が割れないように。
 */
export function TextRunSelectionOverlay() {
  const [rects, setRects] = useState<readonly SelectionHighlightRect[]>([]);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      const model = getTextRunSpanPaintModel();
      setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, [
        ...model.ranges,
        ...getBoxFragmentSelectionRanges(),
      ]);
      const next = mergeSelectionHighlightRects(model.emptyLineRects);
      setRects((current) => (sameRects(current, next) ? current : next));
    };
    const schedule = () => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(update);
    };

    update();
    const unsubscribe = subscribeTextRunSpan(schedule);
    const unsubscribeBoxFragments = subscribeBoxFragmentSelection(schedule);
    // Highlight の Range は live なのでスクロールには自動で追従する。ここで追い直すのは
    // 空行の印 (fixed の矩形) だけ。
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    return () => {
      unsubscribe();
      unsubscribeBoxFragments();
      window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      setCustomHighlight(TEXT_RUN_SPAN_HIGHLIGHT_NAME, []);
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

function sameRects(
  left: readonly SelectionHighlightRect[],
  right: readonly SelectionHighlightRect[],
): boolean {
  return left.length === right.length && left.every((rect, index) => (
    rect.left === right[index].left
    && rect.top === right[index].top
    && rect.width === right[index].width
    && rect.height === right[index].height
  ));
}
