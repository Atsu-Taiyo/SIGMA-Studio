"use client";

import { useEffect, useRef } from "react";

import { createOverlayPayloadFromClipboard } from "@/components/editor/overlay-canvas/clipboard-overlay-payload";
import type { PageCanvasExternalDrop } from "@/components/editor/page-canvas/editor-extension";
import type { OverlayActionRequestInput } from "@/components/editor/page-overlay-types";
import { clearTextRunSpanOnOutsidePointerDown } from "@/components/editor/text-flow/text-run-span";
import {
  dropPocketItem,
  isPocketDrag,
  registerPocketPageHost,
  type PocketItem,
  type PocketPagePoint,
  type PocketScreenRect,
} from "@/features/pocket";

/**
 * ポケットのカードをドラッグして紙面へ落としたときの受け口。
 * 座標の変換は紙面 (`PageCanvasEditor`) が済ませて渡すので、ここは何を起こすかだけを決める。
 */
export const POCKET_PAGE_DROP: PageCanvasExternalDrop = {
  accepts: isPocketDrag,
  drop: (dataTransfer, location) => {
    void dropPocketItem(dataTransfer, location);
  },
};

/**
 * いま選ばれている図形と文章の範囲の、画面での外接矩形。ポケットへ入れた部分が飛んでいく元の位置。
 * 図形は選ばれた印 (`.selected`) のある要素、文章は DOM の選択範囲から取る。どちらも無ければ null。
 */
export function measureSelectionRect(): PocketScreenRect | null {
  const rects: DOMRect[] = Array.from(document.querySelectorAll<HTMLElement>(".overlay-shape.selected"))
    .map((element) => element.getBoundingClientRect());
  const selection = window.getSelection();
  if (selection && !selection.isCollapsed && selection.rangeCount > 0) {
    rects.push(selection.getRangeAt(0).getBoundingClientRect());
  }
  const visible = rects.filter((rect) => rect.width > 0 && rect.height > 0);
  if (visible.length === 0) {
    return null;
  }
  const left = Math.min(...visible.map((rect) => rect.left));
  const top = Math.min(...visible.map((rect) => rect.top));
  const right = Math.max(...visible.map((rect) => rect.right));
  const bottom = Math.max(...visible.map((rect) => rect.bottom));
  return { left, top, width: right - left, height: bottom - top };
}

interface PocketPageHostPorts {
  /** 本文を持たない紙面 (ホワイトボード) か。本文のコピーを貼る場所が無いので、図形として置く。 */
  bodyless: boolean;
  /** 置き場所を指定しない挿入 (クリック) の置き場所。紙面の見えている範囲の中央。無ければ null。 */
  getViewportCenter: () => PocketPagePoint | null;
  requestOverlayAction: (request: OverlayActionRequestInput) => void;
}

/**
 * ポケットの項目を紙面 (オーバーレイ) へ置く窓口を、編集画面の間だけ登録する。
 *
 * 置くのは次の 2 つ。それ以外 (紙の本文へ貼るもの) は false を返し、ポケットが本文のキャレットへ
 * 通常の貼り付けと同じ経路で入れる。
 * - 図形だけの項目を、落とされた場所へ (場所の指定が無いクリックは ⌘V と同じ位置に任せる)。
 * - ホワイトボードでは本文のコピー (文章・ブロック・数式) も、文章の図形 (オーバーレイ) として。
 */
export function usePocketPageHost(ports: PocketPageHostPorts): void {
  const portsRef = useRef(ports);
  useEffect(() => {
    portsRef.current = ports;
  }, [ports]);

  useEffect(() => registerPocketPageHost({
    placeOnPage: (item: PocketItem, point: PocketPagePoint | null): boolean => {
      const { bodyless, getViewportCenter, requestOverlayAction } = portsRef.current;
      const shapesOnly = item.preview.kind === "shapes";
      if (shapesOnly ? point === null : !bodyless) {
        return false;
      }
      const payload = createOverlayPayloadFromClipboard(item.clip);
      const centerAt = point ?? getViewportCenter();
      if (!payload || !centerAt) {
        return false;
      }
      // ホワイトボードは、パンで原点より左上 (負の座標) も見える。見えている場所へ置いたものを紙の範囲へ
      // 押し戻すと画面の外へ出るので、ホワイトボードでは押し戻さない (紙の上へ落としたときは従来どおり)。
      requestOverlayAction({
        type: "pasteShapes",
        payload,
        centerAt: { x: centerAt.x, y: centerAt.y },
        unbounded: bodyless,
      });
      return true;
    },
    // 落とした位置は、そこをクリックしたのと同じ扱いにする。複数のブロックにまたがる選択が残っていると、
    // 貼り付けは落とした位置ではなく、その選択を置き換える形で入ってしまう。
    beforePlaceCaret: clearTextRunSpanOnOutsidePointerDown,
    getSelectionRect: measureSelectionRect,
  }), []);
}
