"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";

import type { SigmaCommentAnchor } from "@/features/document";
import { useT } from "@/lib/i18n/react";

import type { PageCanvasSelectionAction } from "./editor-extension";
import {
  placeSelectionTrailingActions,
  SELECTION_ACTION_POPOVER_MARGIN,
  type SelectionActionPopoverPosition,
  type SelectionTrailingAnchor,
  type SelectionTrailingPlacement,
} from "./popover-anchors";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

/** 右下のチップが選択の上へ回ったとき、書式の帯と重ならないよう空ける間隔 (画面の px)。 */
const TRAILING_TOOLS_GAP = 6;

export interface SelectionActionPopoverState {
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  position: SelectionActionPopoverPosition;
}

/**
 * 選択範囲の近くに浮かぶ操作。
 *
 * 本文の選択 (`position.trailing` がある) では 2 つに分ける: 書式などの編集操作は選択の上の帯、
 * AI への依頼とコメントは選んだところの右下のチップ。上の帯 1 本にまとめると、打っている行の
 * 1 行上を AI・コメントが隠して普段の編集の邪魔になる。図形の選択は帯 1 本のまま (回転ハンドル・
 * 承認バーとの避け合いを帯の位置で決めているため)。
 *
 * 中に何が並ぶかで幅が大きく変わるので、位置は描画後の実寸で決める。
 */
export function SelectionActionPopover({
  popover,
  onCommentAnchorRequest,
  renderSelectionActions,
  onWidthChange,
}: {
  popover: SelectionActionPopoverState;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  /** `placement` は押したチップの位置 (画面座標)。コメントの入力欄をそこに開ける。 */
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
  /** 実寸の幅 (画面の px)。紙面に浮かべる部品が、このポップオーバーを避けるのに使う。 */
  onWidthChange?: (widthPx: number) => void;
}) {
  const { position, extensionAction, commentAnchor } = popover;
  const trailing = position.trailing;
  const tools = extensionAction?.renderTools?.();

  if (!trailing) {
    return (
      <SelectionActionBand position={position} onWidthChange={onWidthChange}>
        {tools}
        {extensionAction?.render?.(position)}
        <CommentActions
          anchor={commentAnchor}
          renderSelectionActions={renderSelectionActions}
          onCommentAnchorRequest={onCommentAnchorRequest}
        />
      </SelectionActionBand>
    );
  }

  return (
    <SelectionTrailingActions
      position={position}
      trailing={trailing}
      tools={tools}
      extensionAction={extensionAction}
      commentAnchor={commentAnchor}
      renderSelectionActions={renderSelectionActions}
      onCommentAnchorRequest={onCommentAnchorRequest}
    />
  );
}

function SelectionTrailingActions({
  position,
  trailing,
  tools,
  extensionAction,
  commentAnchor,
  renderSelectionActions,
  onCommentAnchorRequest,
}: {
  position: SelectionActionPopoverPosition;
  trailing: SelectionTrailingAnchor;
  tools: ReactNode;
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
}) {
  const toolsRef = useRef<HTMLDivElement>(null);
  const chipRef = useRef<HTMLDivElement>(null);
  // 測る前は、角にそのまま置いた見積もり (下に収まる前提)。
  const [placement, setPlacement] = useState<SelectionTrailingPlacement>(() => ({
    left: trailing.right,
    top: trailing.bottom,
    placement: "below",
  }));

  useIsomorphicLayoutEffect(() => {
    const chip = chipRef.current;
    if (!chip) {
      return;
    }
    const place = () => {
      const next = placeSelectionTrailingActions(trailing, { width: chip.offsetWidth, height: chip.offsetHeight });
      // 上へ回したときは、同じく選択の上にある書式の帯をさらに越える。
      const toolsRect = toolsRef.current?.getBoundingClientRect();
      if (next.placement === "above" && toolsRect && toolsRect.height > 0
        && next.top < toolsRect.bottom && next.top + chip.offsetHeight > toolsRect.top
        && next.left < toolsRect.right && next.left + chip.offsetWidth > toolsRect.left) {
        next.top = Math.max(SELECTION_ACTION_POPOVER_MARGIN, toolsRect.top - TRAILING_TOOLS_GAP - chip.offsetHeight);
      }
      setPlacement((current) => (
        Math.abs(current.left - next.left) < 0.5 && Math.abs(current.top - next.top) < 0.5 && current.placement === next.placement
          ? current
          : next
      ));
    };
    place();
    window.addEventListener("resize", place);
    if (typeof ResizeObserver === "undefined") {
      return () => window.removeEventListener("resize", place);
    }
    const observer = new ResizeObserver(place);
    observer.observe(chip);
    if (toolsRef.current) {
      observer.observe(toolsRef.current);
    }
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [trailing]);

  const chipPosition = { left: placement.left, top: placement.top };
  const feature = extensionAction?.render?.(chipPosition);
  const hasComment = Boolean(commentAnchor && (renderSelectionActions || onCommentAnchorRequest));
  return (
    <>
      {tools && (
        <SelectionActionBand position={position} bandRef={toolsRef} variant="tools">
          {tools}
        </SelectionActionBand>
      )}
      {(feature || hasComment) && (
        <div
          ref={chipRef}
          className="selection-action-popover selection-action-popover--trailing"
          data-placement={placement.placement}
          style={{ left: `${placement.left}px`, top: `${placement.top}px` }}
          onMouseDown={keepEditorSelection}
        >
          {feature}
          <CommentActions
            anchor={commentAnchor}
            placement={chipPosition}
            renderSelectionActions={renderSelectionActions}
            onCommentAnchorRequest={onCommentAnchorRequest}
          />
        </div>
      )}
    </>
  );
}

/** 選択の上に中央寄せで置く帯。`position.left` は幅の見積もりなので、実寸で置き直す。 */
function SelectionActionBand({
  position,
  bandRef,
  variant,
  onWidthChange,
  children,
}: {
  position: SelectionActionPopoverPosition;
  bandRef?: RefObject<HTMLDivElement | null>;
  variant?: "tools";
  onWidthChange?: (widthPx: number) => void;
  children: ReactNode;
}) {
  const ownRef = useRef<HTMLDivElement>(null);
  const rootRef = bandRef ?? ownRef;
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
  }, [onWidthChange, position.centerX, position.left, rootRef]);

  return (
    <div
      ref={rootRef}
      className={variant ? `selection-action-popover selection-action-popover--${variant}` : "selection-action-popover"}
      style={{ left: `${left}px`, top: `${position.top}px` }}
      onMouseDown={keepEditorSelection}
    >
      {children}
    </div>
  );
}

function CommentActions({
  anchor,
  placement,
  renderSelectionActions,
  onCommentAnchorRequest,
}: {
  anchor: SigmaCommentAnchor | null;
  placement?: { left: number; top: number };
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
}) {
  const tEditorText = useT("editor");
  if (!anchor) {
    return null;
  }
  const commentLabel = tEditorText("pageCanvas.addComment");
  return (
    <>
      {renderSelectionActions?.(anchor)}
      {onCommentAnchorRequest && (
        <button
          type="button"
          className="selection-action-labeled"
          title={commentLabel}
          aria-label={commentLabel}
          onClick={(event) => {
            event.stopPropagation();
            onCommentAnchorRequest(anchor, placement);
          }}
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
          <span>{tEditorText("pageCanvas.commentShort")}</span>
        </button>
      )}
    </>
  );
}

/**
 * ボタンを押しても本文の選択とフォーカスを奪わない。ただし入力欄とスライダーは対象外:
 * React のイベントはポータルの親へも伝わるので、色パレット (ポータルに出る) のスライダーが
 * ドラッグできず、色作成ダイアログの数値欄もクリックで入力できなくなる。
 */
function keepEditorSelection(event: ReactMouseEvent<HTMLDivElement>) {
  if (event.target instanceof Element && event.target.closest("input, textarea, select")) {
    return;
  }
  event.preventDefault();
}
