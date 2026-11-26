"use client";

import { MessageSquarePlus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";

import type { SigmaCommentAnchor } from "@/features/document";
import { useT } from "@/lib/i18n/react";

import type { PageCanvasSelectionAction } from "./editor-extension";
import {
  getSelectionFollowUpAnchor,
  placeSelectionTrailingActions,
  SELECTION_ACTION_POINTER_OFFSET,
  SELECTION_ACTION_POPOVER_MARGIN,
  type SelectionActionPopoverPosition,
  type SelectionTrailingAnchor,
  type SelectionTrailingPlacement,
} from "./popover-anchors";

/** カードと選んだ文の間の隙間 (画面の px)。 */
const SELECTION_ACTION_CARD_GAP = 8;

const useIsomorphicLayoutEffect = typeof window !== "undefined" ? useLayoutEffect : useEffect;

export interface SelectionActionPopoverState {
  extensionAction: PageCanvasSelectionAction | null;
  commentAnchor: SigmaCommentAnchor | null;
  position: SelectionActionPopoverPosition;
  preferBelow?: boolean;
}

export type SelectionCardBounds = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

/**
 * 選択範囲の近くに浮かぶ操作。書式などの編集操作と、AI への依頼・コメントを帯 1 本に
 * 並べる (本文・画像・図形で同じ)。横 1 本の帯ではなく、段に分けた縦長のカードにする。
 * 本文の選択では選んだ文の下に、図形の選択では選んだときのマウスの右下に置く (マウスの位置が
 * 分からない — キーボードで選んだ — ときは選択の上、回転ハンドルの上)。
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
  onBoundsChange,
}: {
  popover: SelectionActionPopoverState;
  renderSelectionActions?: (anchor: SigmaCommentAnchor) => ReactNode;
  /** `placement` は押した部品の位置 (画面座標)。コメントの入力欄をその下に開ける。 */
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void;
  /** 折り返し後のカードの位置と実寸 (画面の px)。 */
  onBoundsChange?: (bounds: SelectionCardBounds) => void;
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
    // 書式や図形の操作を段に分けた縦長のカードにする (横 1 本に並べると長くなりすぎる)。
    <SelectionActionBand
      position={position}
      preferBelow={popover.preferBelow ?? Boolean(trailing)}
      onBoundsChange={trailing ? undefined : onBoundsChange}
    >
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

/**
 * 選択に中央寄せで置く縦長のカード。`position.pointer` (図形をマウスで選んだ) があれば、その点の右下に置き、
 * 下・右に収まらなければ点の上・左へ回す。拡大して図形の上下が画面の外にあっても、カードは手元に出る。
 * それ以外は`position.left` は幅の見積もりなので、実寸で置き直す。
 * 帯 1 本の高さの見積もり (`position.top`) では選んだものに重なるので、実寸の高さで置き直す。
 * 既定は選択の上で、上に収まらなければ選択の下へ回す。`preferBelow` (本文の選択) では逆に
 * 選択の下を先に使い、表示域の下端を越えるときだけ上へ回す — 上に出すと、選んだ文の前の行を隠す。
 * 上下どちらにも収まらないときは、カードを表示域の端に寄せて操作できるようにする。
 */
function SelectionActionBand({
  position,
  preferBelow = false,
  onBoundsChange,
  children,
}: {
  position: SelectionActionPopoverPosition;
  preferBelow?: boolean;
  onBoundsChange?: (bounds: SelectionCardBounds) => void;
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
      const viewportRect = viewport?.getBoundingClientRect();
      const minTop = viewportRect ? Math.max(SELECTION_ACTION_POPOVER_MARGIN, viewportRect.top + SELECTION_ACTION_POPOVER_MARGIN) : SELECTION_ACTION_POPOVER_MARGIN;
      const viewportBottom = Math.min(window.innerHeight, viewportRect?.bottom ?? window.innerHeight);
      const maxBottom = viewportBottom - SELECTION_ACTION_POPOVER_MARGIN;
      const anchor = position.anchor;
      const pointer = position.pointer;
      const width = root.offsetWidth;
      const height = root.offsetHeight;
      const placeCard = (left: number, top: number, avoidThrough?: number) => {
        const visibleTop = Math.max(minTop, Math.min(top, maxBottom - height));
        const occupiedHeight = Math.max(height, Math.min(avoidThrough ?? visibleTop, viewportBottom) - visibleTop);
        setLeft(left);
        setTop(visibleTop);
        onBoundsChange?.({ left, top: visibleTop, width, height: occupiedHeight });
      };
      if (pointer) {
        const below = pointer.y + SELECTION_ACTION_POINTER_OFFSET.y;
        const above = pointer.y - SELECTION_ACTION_POINTER_OFFSET.y - height;
        const nextTop = below + height <= maxBottom || above < minTop ? below : above;
        const right = pointer.x + SELECTION_ACTION_POINTER_OFFSET.x;
        const maxRight = window.innerWidth - SELECTION_ACTION_POPOVER_MARGIN;
        const nextLeft = Math.max(
          SELECTION_ACTION_POPOVER_MARGIN,
          right + width <= maxRight ? right : Math.min(maxRight - width, pointer.x - SELECTION_ACTION_POINTER_OFFSET.x - width),
        );
        placeCard(nextLeft, nextTop);
        return;
      }
      let top = position.top;
      let avoidThrough: number | undefined;
      if (anchor) {
        const above = anchor.top - anchor.clearance - height;
        const below = anchor.bottom + SELECTION_ACTION_CARD_GAP;
        if (preferBelow) {
          top = below + height <= maxBottom || above < minTop ? below : above;
        } else {
          top = above >= minTop ? above : below;
        }
        // キーボード選択では、カードの移動後も回転ハンドルまで避ける。
        if (top === above) avoidThrough = anchor.top;
      }
      const center = position.centerX ?? position.left + width / 2;
      const maxLeft = Math.max(SELECTION_ACTION_POPOVER_MARGIN, window.innerWidth - width - SELECTION_ACTION_POPOVER_MARGIN);
      const next = Math.min(maxLeft, Math.max(SELECTION_ACTION_POPOVER_MARGIN, center - width / 2));
      placeCard(next, top, avoidThrough);
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
  }, [onBoundsChange, position.anchor, position.centerX, position.left, position.pointer, position.top, preferBelow]);

  return (
    <div
      ref={rootRef}
      className="selection-action-popover selection-action-popover--card"
      style={{ left: `${left}px`, top: `${top}px` }}
      onPointerDown={keepEditorSelection}
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
          className="selection-action-icon"
          title={commentLabel}
          aria-label={commentLabel}
          onClick={(event) => {
            event.stopPropagation();
            onCommentAnchorRequest(anchor, placement);
          }}
        >
          <MessageSquarePlus size={16} aria-hidden="true" />
        </button>
      )}
    </>
  );
}

/**
 * ボタンを押しても本文の選択とフォーカスを奪わない。ただし入力欄とスライダーは対象外:
 * カードでは pointerdown の時点で既定の動作を止め、click の前に本文の選択が縮むのを防ぐ。
 * React のイベントはポータルの親へも伝わるので、色パレット (ポータルに出る) のスライダーが
 * ドラッグできず、色作成ダイアログの数値欄もクリックで入力できなくなる。
 */
function keepEditorSelection(event: ReactMouseEvent<HTMLDivElement>) {
  if (event.target instanceof Element && event.target.closest("input, textarea, select")) {
    return;
  }
  event.preventDefault();
}
