"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import type { SigmaCommentAnchor } from "@/features/document";
import { useT } from "@/lib/i18n/react";

import type { PageCanvasSelectionAction } from "./editor-extension";
import { SELECTION_ACTION_POPOVER_MARGIN, type SelectionActionPopoverPosition } from "./popover-anchors";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface SelectionActionPopoverState {
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  position: SelectionActionPopoverPosition;
}

/**
 * 選択範囲の近くに浮かぶ操作バー。
 *
 * 中に何が並ぶか (書式・図形の操作・AI・コメント) で幅が大きく変わるので、位置は描画後の実寸で
 * 決める。`position.left` は幅を見積もった端の位置で、選択範囲の中心 `centerX` に実寸の半分を
 * 引いて置き直し、画面の端に収める。
 */
export function SelectionActionPopover({
  popover,
  onCommentAnchorRequest,
  renderSelectionActions,
  onWidthChange,
}: {
  popover: SelectionActionPopoverState;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor) => void;
  /** 実寸の幅 (画面の px)。紙面に浮かべる部品が、このポップオーバーを避けるのに使う。 */
  onWidthChange?: (widthPx: number) => void;
}) {
  const tEditorText = useT("editor");
  const rootRef = useRef<HTMLDivElement>(null);
  const { position, extensionAction, commentAnchor } = popover;
  const [left, setLeft] = useState(position.left);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const place = () => {
      const width = root.offsetWidth;
      onWidthChange?.(width);
      const center = position.centerX ?? position.left + width / 2;
      const maxLeft = Math.max(SELECTION_ACTION_POPOVER_MARGIN, window.innerWidth - width - SELECTION_ACTION_POPOVER_MARGIN);
      const next = Math.min(maxLeft, Math.max(SELECTION_ACTION_POPOVER_MARGIN, center - width / 2));
      setLeft((current) => (Math.abs(current - next) < 0.5 ? current : next));
    };
    place();
    window.addEventListener("resize", place);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", place);
    }
    const observer = new ResizeObserver(place);
    observer.observe(root);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [onWidthChange, position.centerX, position.left]);

  const commentLabel = tEditorText("pageCanvas.addComment");
  return (
    <div
      ref={rootRef}
      className="selection-action-popover"
      style={{ left: `${left}px`, top: `${position.top}px` }}
      onMouseDown={(event) => {
        // ボタンを押しても本文の選択とフォーカスを奪わない。ただし入力欄とスライダーは対象外:
        // React のイベントはポータルの親へも伝わるので、色パレット (ポータルに出る) のスライダーが
        // ドラッグできず、色作成ダイアログの数値欄もクリックで入力できなくなる。
        if (event.target instanceof Element && event.target.closest("input, textarea, select")) {
          return;
        }
        event.preventDefault();
      }}
    >
      {extensionAction?.render(position)}
      {commentAnchor && renderSelectionActions?.(commentAnchor)}
      {commentAnchor && onCommentAnchorRequest && (
        <button
          type="button"
          className="selection-action-labeled"
          title={commentLabel}
          aria-label={commentLabel}
          onClick={(event) => {
            event.stopPropagation();
            onCommentAnchorRequest(commentAnchor);
          }}
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
          <span>{tEditorText("pageCanvas.commentShort")}</span>
        </button>
      )}
    </div>
  );
}
