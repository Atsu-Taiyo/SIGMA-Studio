"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { SigmaCommentAnchor } from "@/features/document";
import { useT } from "@/lib/i18n/react";

import type { PageCanvasSelectionAction } from "./editor-extension";
import {
  getSelectionFollowUpAnchor,
  placeSelectionTrailingActions,
  SELECTION_ACTION_POPOVER_MARGIN,
  type SelectionActionPopoverPosition,
  type SelectionTrailingAnchor,
  type SelectionTrailingPlacement,
} from "./popover-anchors";

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface SelectionActionPopoverState {
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  position: SelectionActionPopoverPosition;
}

/**
 * 選択範囲の近くに浮かぶ操作。書式などの編集操作と、AI への依頼・コメントを選択の上の帯 1 本に
 * 並べる (本文・画像・図形で同じ)。
 *
 * 本文の選択 (`position.trailing` がある) では、帯から開く AI・コメントの入力欄を選んだところの
 * すぐ下に開く — 帯の真下に開くと、選んだ文を隠す。数式だけ・ブロックを丸ごと選んだときは
 * 書式の帯が無いので、AI・コメントは選んだところの右下に小さなチップで出す。カーソルを置いただけの
 * ときは何も選んでいないので、この部品自体を出さない (`use-page-canvas-selection.ts`)。
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
  /** `placement` は押した部品の位置 (画面座標)。コメントの入力欄をその下に開ける。 */
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
  /** 実寸の幅 (画面の px)。紙面に浮かべる部品が、このポップオーバーを避けるのに使う。 */
  onWidthChange?: (widthPx: number) => void;
}) {
  const { position, extensionAction, commentAnchor } = popover;
  const trailing = position.trailing;
  const tools = extensionAction?.renderTools?.();

  if (trailing && !tools) {
    return (
      <SelectionTrailingActions
        trailing={trailing}
        extensionAction={extensionAction}
        commentAnchor={commentAnchor}
        renderSelectionActions={renderSelectionActions}
        onCommentAnchorRequest={onCommentAnchorRequest}
      />
    );
  }

  const followUp = trailing ? getSelectionFollowUpAnchor(trailing) : undefined;
  return (
    // 紙面に浮かべる部品が避けるのは図形の選択の帯だけ (`getOverlaySelectionControlsCanvasRect`)。
    <SelectionActionBand position={position} onWidthChange={trailing ? undefined : onWidthChange}>
      {tools}
      {extensionAction?.render?.(followUp ?? position)}
      <CommentActions
        anchor={commentAnchor}
        placement={followUp}
        renderSelectionActions={renderSelectionActions}
        onCommentAnchorRequest={onCommentAnchorRequest}
      />
    </SelectionActionBand>
  );
}

function SelectionTrailingActions({
  trailing,
  extensionAction,
  commentAnchor,
  renderSelectionActions,
  onCommentAnchorRequest,
}: {
  trailing: SelectionTrailingAnchor;
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
}) {
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
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [trailing]);

  const chipPosition = { left: placement.left, top: placement.top };
  const feature = extensionAction?.render?.(chipPosition);
  const hasComment = Boolean(commentAnchor && (renderSelectionActions || onCommentAnchorRequest));
  if (!feature && !hasComment) {
    return null;
  }
  return (
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
  );
}

/** 選択の上に中央寄せで置く帯。`position.left` は幅の見積もりなので、実寸で置き直す。 */
function SelectionActionBand({
  position,
  onWidthChange,
  children,
}: {
  position: SelectionActionPopoverPosition;
  onWidthChange?: (widthPx: number) => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [left, setLeft] = useState(position.left);
  const [top, setTop] = useState(position.top);

  useIsomorphicLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) {
      return;
    }
    const place = () => {
      const viewport = root.closest<HTMLElement>(".editor-canvas");
      const minTop = viewport ? Math.max(SELECTION_ACTION_POPOVER_MARGIN, viewport.getBoundingClientRect().top + SELECTION_ACTION_POPOVER_MARGIN) : SELECTION_ACTION_POPOVER_MARGIN;
      setTop(Math.max(minTop, position.top));
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
    const viewport = root.closest<HTMLElement>(".editor-canvas");
    if (viewport) observer.observe(viewport);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
    };
  }, [onWidthChange, position.centerX, position.left, position.top]);

  return (
    <div
      ref={rootRef}
      className="selection-action-popover"
      style={{ left: `${left}px`, top: `${top}px` }}
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
