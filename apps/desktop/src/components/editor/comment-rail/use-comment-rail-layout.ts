"use client";

import { useLayoutEffect, useMemo, useState } from "react";
import type { RefObject } from "react";

import {
  classifyAnchorPlacement,
  unionRect,
  type CommentAnchorPlacement,
  type Rect,
} from "./anchor-placement";
import { shouldCompactCommentRail } from "./rail-fit";

/** イベントで拾えない配置換え (フォントの読み込み・画像の読み込みなど) を拾う保険。 */
const POLL_MS = 400;

export interface CommentRailLayout {
  /** 小さなアイコンだけの並びにするか。 */
  compact: boolean;
  /** 各スレッドの対象が、いま見えている本文のどこにあるか。 */
  placements: Record<string, CommentAnchorPlacement>;
  /** 本文での並び順 (上から下)。測れたスレッドだけ。 */
  documentOrder: string[];
  /** カードの一覧が、窓の上下にはみ出して続いているか。縁を薄れさせて続きを知らせる。 */
  listMore: { above: boolean; below: boolean };
}

const INITIAL: CommentRailLayout = { compact: false, placements: {}, documentOrder: [], listMore: { above: false, below: false } };

function readRect(rect: DOMRect): Rect {
  return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
}

function findAnchorElements(canvas: HTMLElement, threadId: string): HTMLElement[] {
  const escaped = CSS.escape(threadId);
  return Array.from(canvas.querySelectorAll<HTMLElement>(
    `[data-comment-thread-id="${escaped}"], [data-comment-thread-ids~="${escaped}"]`,
  ));
}

interface Inputs {
  /** 並べ方を測るスレッド。 */
  threadIds: readonly string[];
  /** 本文のキャンバス (スクロールする窓)。 */
  canvasRef: RefObject<HTMLElement | null>;
  /** カードの一覧 (スクロールする窓)。一覧を出していないときは null。 */
  listRef: RefObject<HTMLElement | null>;
  /** スクロールしない無限キャンバスでは、見えている位置が並び順にならず、用紙も無い。 */
  whiteboard: boolean;
}

/**
 * 右上に浮かぶカードの並びの置き方を決める値を、本文の側から測る。
 * - 用紙の右にカードを置く余白が足りるか (足りなければアイコンだけにする)
 * - 各コメントの対象の位置 (本文の並びに揃える・見えている対象のカードへ追従する)
 * 位置が動く出来事 (スクロール・大きさの変化・本文の変更) ごとに次のフレームで測り直し、
 * 値が変わったときだけ状態を更新する。
 */
export function useCommentRailLayout({ threadIds, canvasRef, listRef, whiteboard }: Inputs): CommentRailLayout {
  const [layout, setLayout] = useState<CommentRailLayout>(INITIAL);
  const idsKey = useMemo(() => threadIds.join("\n"), [threadIds]);

  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let frame = 0;
    const measure = () => {
      frame = 0;
      const list = listRef.current;
      const canvasRect = readRect(canvas.getBoundingClientRect());
      // 用紙は本文のキャンバスの中の .page-canvas。ページが縦に並ぶので、右端はどれも同じ。
      const paper = whiteboard ? null : canvas.querySelector<HTMLElement>(".page-canvas");
      const compact = shouldCompactCommentRail({
        canvasRight: canvasRect.right,
        canvasWidth: canvasRect.right - canvasRect.left,
        paperRight: paper ? paper.getBoundingClientRect().right : null,
      });

      const placements: Record<string, CommentAnchorPlacement> = {};
      const ordered: Array<{ id: string; top: number }> = [];
      for (const threadId of idsKey ? idsKey.split("\n") : []) {
        const anchorRect = unionRect(findAnchorElements(canvas, threadId).map((element) => readRect(element.getBoundingClientRect())));
        placements[threadId] = classifyAnchorPlacement(anchorRect, canvasRect);
        if (anchorRect) ordered.push({ id: threadId, top: anchorRect.top - canvasRect.top + canvas.scrollTop });
      }
      const next: CommentRailLayout = {
        compact,
        placements,
        documentOrder: whiteboard ? [] : ordered.sort((a, b) => a.top - b.top).map((entry) => entry.id),
        listMore: {
          above: Boolean(list && list.scrollTop > 1),
          below: Boolean(list && list.scrollTop + list.clientHeight < list.scrollHeight - 1),
        },
      };
      setLayout((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    };
    const schedule = () => {
      if (!frame) frame = window.requestAnimationFrame(measure);
    };

    schedule();
    const resizeObserver = typeof ResizeObserver !== "undefined" ? new ResizeObserver(schedule) : null;
    resizeObserver?.observe(canvas);
    if (listRef.current) resizeObserver?.observe(listRef.current);
    // 本文の編集で対象が動く。属性の変更は拾わない (ハイライトの付け外しで測り直し続けないため)。
    const mutationObserver = typeof MutationObserver !== "undefined" ? new MutationObserver(schedule) : null;
    mutationObserver?.observe(canvas, { childList: true, subtree: true, characterData: true });
    // スクロールは伝播しないので、捕捉の段階で拾う (本文・カードの一覧どちらも)。
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const poll = window.setInterval(schedule, POLL_MS);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.clearInterval(poll);
    };
  }, [canvasRef, idsKey, listRef, whiteboard]);

  return layout;
}
