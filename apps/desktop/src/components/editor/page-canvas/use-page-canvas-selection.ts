"use client";
import type { SigmaDocument } from "@/features/document";
import { type SigmaCommentAnchor } from "@/features/document";
import { displayRectToModel } from "@/features/rendering/core";
import type { RefObject } from "react";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import type { OverlayModeStatus,OverlaySelectionSummary } from "../page-overlay-types";
import {
  decideSelectedTargetCommentAnchor,
  decideTextSelectionCleared,
  decideTextSelectionCommentAnchor,
  INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE,
  sameCommentAnchorPopover,
  sameExtensionActionPopover,
  type CommentAnchorCandidateGate,
} from "./comment-anchor-candidate";
import { isCaretOnlyInBlock } from "./caret-only-selection";
import { hasHeldCanvasTextSelection } from "./held-text-selection";
import { findBlockElement,getMathTexFromRange } from "./comment-geometry";
import { ExtensionActionPopoverState } from "./editor-contracts";
import type { PageCanvasSelectionAction,PageCanvasSelectionExtension } from "./editor-extension";
import { readCanvasPageArrangement } from "./page-arrangement-dom";
import type { SelectionCardBounds } from "./SelectionActionPopover";
import {
  createBlockCommentAnchor,
  createTextCommentAnchorFromRange,
  getClosestBlockId,
  getCommentOffsetText,
  getOverlaySelectionActionPopoverPosition,
  getOverlaySelectionControlsCanvasRect,
  getOverlaySelectionPointer,
  getOverlaySelectionTargetBlockId,
  getRangeScreenRect,
  getRangeTargetBlockId,
  getSelectionActionPopoverPosition,
  getSelectionTrailingAnchor,
  isRangeInsideElement,
  sameSelectionActionPopoverPosition,
  type CommentAnchorPopoverState,
  type OverlaySelectionPointer,
  type OverlaySelectionPopoverMeasurement,
  type SelectionActionPopoverPosition,
} from "./popover-anchors";

interface Inputs {
  overlaySelection: OverlaySelectionSummary;
  suppressSelectionActions: boolean;
  pageOverlayEditing: boolean;
  selectionExtension: PageCanvasSelectionExtension | undefined;
  selectedId: string | null;
  document: SigmaDocument;
  bodyOverlayModeStatus: OverlayModeStatus | null;
  overlayCommentAnchor: SigmaCommentAnchor | null;
  canvasRef: RefObject<HTMLDivElement | null>;
  zoom: number;
  isWhiteboard: boolean;
  whiteboardPanX: number;
  whiteboardPanY: number;
  onCommentAnchorCandidateChange: ((anchor: SigmaCommentAnchor | null) => void) | undefined;
  isOverlayEditing: boolean;
  onCommentAnchorRequest: ((anchor: SigmaCommentAnchor, placement?: { left: number; top: number }) => void) | undefined;
  renderSelectionActions: ((anchor: SigmaCommentAnchor) => React.ReactNode) | undefined;
  selectedInlineMath: { id: string; tex: string; blockId?: string; getCanonicalTex?: () => string; } | null;
  totalHeight: number;
  layoutRevision: number;
  /** つまみ (ブロックの掴み手) で `selectedId` のブロックを丸ごと選んでいるか。カーソルだけとは扱わない。 */
  blockHandleSelected?: boolean;
}

const TEXT_SELECTION_ACTION_DEBOUNCE_MS = 120;
/**
 * 図形の選択が変わったとき、これより前のマウス操作は「選んだ操作」とみなさない (キーボードで選んだ)。
 * そのときはマウスの位置ではなく、従来どおり図形の上に置く。
 */
const OVERLAY_SELECTION_POINTER_FRESH_MS = 500;
export function usePageCanvasSelectionActions({ overlaySelection, suppressSelectionActions, pageOverlayEditing, selectionExtension, selectedId, document, bodyOverlayModeStatus, overlayCommentAnchor, canvasRef, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY, onCommentAnchorCandidateChange, isOverlayEditing, onCommentAnchorRequest, renderSelectionActions, selectedInlineMath, totalHeight, layoutRevision, blockHandleSelected = false }: Inputs) {

  const [extensionTextSelectionPopover, setExtensionTextSelectionPopover] = useState<ExtensionActionPopoverState | null>(null);

  const [extensionSelectedTargetPopover, setExtensionSelectedTargetPopover] = useState<ExtensionActionPopoverState | null>(null);

  const [commentTextSelectionPopover, setCommentTextSelectionPopover] = useState<CommentAnchorPopoverState | null>(null);

  const [commentSelectedTargetPopover, setCommentSelectedTargetPopover] = useState<CommentAnchorPopoverState | null>(null);

  const overlaySelectionKey = JSON.stringify([overlaySelection.selectedShapeIds, overlaySelection.region]);

  // 図形を選んだ (動かした) ときのマウスの位置。カードはこの点の近くに出す (`getOverlaySelectionActionPopoverPosition`)。
  const [overlaySelectionPointer, setOverlaySelectionPointer] = useState<OverlaySelectionPointer | null>(null);
  const lastOverlayPointerAtRef = useRef(Number.NEGATIVE_INFINITY);
  useEffect(() => {
    if (!pageOverlayEditing) {
      return;
    }
    const record = (event: PointerEvent) => {
      const canvas = canvasRef.current;
      const target = event.target;
      if (event.button !== 0 || !canvas || !(target instanceof Node) || !canvas.contains(target)) {
        return;
      }
      // カードそのもの (とそこから開くメニュー) を押しても、カードは動かさない。
      if (target instanceof Element && target.closest(".selection-action-popover")) {
        return;
      }
      lastOverlayPointerAtRef.current = performance.now();
      const next = getOverlaySelectionPointer(
        canvas,
        { x: event.clientX, y: event.clientY },
        zoom,
        isWhiteboard ? { x: whiteboardPanX, y: whiteboardPanY } : undefined,
      );
      setOverlaySelectionPointer((current) => (current && current.x === next.x && current.y === next.y ? current : next));
    };
    window.addEventListener("pointerdown", record, true);
    window.addEventListener("pointerup", record, true);
    return () => {
      window.removeEventListener("pointerdown", record, true);
      window.removeEventListener("pointerup", record, true);
    };
  }, [canvasRef, isWhiteboard, pageOverlayEditing, whiteboardPanX, whiteboardPanY, zoom]);
  useLayoutEffect(() => {
    if (performance.now() - lastOverlayPointerAtRef.current > OVERLAY_SELECTION_POINTER_FRESH_MS) {
      setOverlaySelectionPointer(null);
    }
  }, [overlaySelectionKey]);

  const [overlaySelectionPopoverMeasurement, setOverlaySelectionPopoverMeasurement] = useState<OverlaySelectionPopoverMeasurement | null>(null);

  const overlaySelectionPopoverPosition = overlaySelectionPopoverMeasurement?.key === overlaySelectionKey
    ? overlaySelectionPopoverMeasurement.position
    : null;

  const extensionActionPopover = suppressSelectionActions
    ? null
    : (extensionTextSelectionPopover ?? extensionSelectedTargetPopover);

  const commentAnchorPopover = suppressSelectionActions
    ? null
    : (commentTextSelectionPopover ?? commentSelectedTargetPopover);

  const bodySelectionActionPopoverPosition = extensionActionPopover?.position ?? commentAnchorPopover?.position ?? null;

  const bodySelectionActionPopover = bodySelectionActionPopoverPosition
    ? {
        extensionAction: extensionActionPopover?.action ?? null,
        commentAnchor: commentAnchorPopover?.anchor ?? null,
        position: bodySelectionActionPopoverPosition,
        // Keep the following line accessible while committing an inline math edit.
        preferBelow: !selectedInlineMath,
      }
    : null;

  const overlaySelectionExtensionAction = useMemo(() => {
    if (!pageOverlayEditing || !overlaySelectionPopoverPosition || !selectionExtension) {
      return null;
    }

    const targetId =
      getOverlaySelectionTargetBlockId(overlaySelection) ??
      selectedId ??
      document.content[document.content.length - 1]?.id ??
      null;
    return selectionExtension.createAction({
      kind: "overlaySelection",
      targetId,
      selection: overlaySelection,
    });
  }, [document.content, overlaySelection, overlaySelectionPopoverPosition, pageOverlayEditing, selectedId, selectionExtension]);

  const overlaySelectionActionPopover =
    !suppressSelectionActions &&
    bodyOverlayModeStatus?.id !== "overlay.imageCropping" &&
    overlaySelectionPopoverPosition &&
    (overlaySelectionExtensionAction || overlayCommentAnchor)
    ? {
        extensionAction: overlaySelectionExtensionAction,
        commentAnchor: overlayCommentAnchor,
        position: overlaySelectionPopoverPosition,
      }
    : null;

  const selectionActionPopover = bodySelectionActionPopover ?? overlaySelectionActionPopover;

  // 図形の選択ポップオーバーが実際に出ている間だけ、その帯 (と回転ハンドル) を紙面に浮かべる部品が
  // 避ける矩形にする (紙面の座標)。出ていなければ `null`。
  const overlaySelectionPopoverShown = !bodySelectionActionPopover && overlaySelectionActionPopover !== null;
  const [placedCard, setPlacedCard] = useState<{
    position: SelectionActionPopoverPosition;
    rect: { x: number; y: number; w: number; h: number };
  } | null>(null);
  const updateOverlayCardBounds = useCallback(({ left, top, width, height }: SelectionCardBounds) => {
    const canvas = canvasRef.current;
    if (!canvas || !overlaySelectionPopoverPosition || width <= 0 || height <= 0) return;
    const offset = isWhiteboard ? { x: whiteboardPanX, y: whiteboardPanY } : undefined;
    const origin = getOverlaySelectionPointer(canvas, { x: left, y: top }, zoom, offset);
    const scale = Math.max(0.01, zoom / 100);
    const arrangement = readCanvasPageArrangement(canvas);
    const displayed = { left: origin.x, top: origin.y, width: width / scale, height: height / scale };
    const bounds = arrangement ? displayRectToModel(arrangement, displayed) : displayed;
    const rect = { x: bounds.left, y: bounds.top, w: bounds.width, h: bounds.height };
    setPlacedCard((current) => (
      current?.position === overlaySelectionPopoverPosition
      && current.rect.x === rect.x && current.rect.y === rect.y
      && current.rect.w === rect.w && current.rect.h === rect.h
        ? current
        : { position: overlaySelectionPopoverPosition, rect }
    ));
  }, [canvasRef, isWhiteboard, overlaySelectionPopoverPosition, whiteboardPanX, whiteboardPanY, zoom]);
  const selectionControls = useMemo(
    () => overlaySelectionPopoverShown
      ? (placedCard && placedCard.position === overlaySelectionPopoverPosition
          ? placedCard.rect
          : getOverlaySelectionControlsCanvasRect(overlaySelection, zoom, undefined, overlaySelectionPointer))
      : null,
    [overlaySelection, overlaySelectionPointer, overlaySelectionPopoverPosition, overlaySelectionPopoverShown, placedCard, zoom],
  );
  // 値が同じなら同じ矩形を渡す (選択の要約が作り直されても、紙面の浮かぶ部品を作り直さない)。
  const [controlsX, controlsY, controlsW, controlsH] = selectionControls
    ? [selectionControls.x, selectionControls.y, selectionControls.w, selectionControls.h]
    : [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
  const selectionControlsRect = useMemo(
    () => Number.isNaN(controlsX) ? null : { x: controlsX, y: controlsY, w: controlsW, h: controlsH },
    [controlsH, controlsW, controlsX, controlsY],
  );

  useLayoutEffect(() => {
    if (!pageOverlayEditing || (overlaySelection.selectedCount === 0 && !overlaySelection.region)) {
      return;
    }

    let frame = 0;
    const updatePosition = () => {
      frame = 0;
      const nextPosition = getOverlaySelectionActionPopoverPosition(
        canvasRef.current,
        overlaySelection,
        zoom,
        isWhiteboard ? { x: whiteboardPanX, y: whiteboardPanY } : undefined,
        overlaySelectionPointer,
      );
      setOverlaySelectionPopoverMeasurement((currentMeasurement) => (
        currentMeasurement?.key === overlaySelectionKey &&
        sameSelectionActionPopoverPosition(currentMeasurement.position, nextPosition)
          ? currentMeasurement
          : { key: overlaySelectionKey, position: nextPosition }
      ));
    };
    const scheduleUpdate = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(updatePosition);
    };

    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [overlaySelection, overlaySelectionKey, overlaySelectionPointer, pageOverlayEditing, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY, canvasRef]);

  const lastExtensionCandidateKeyRef = useRef<string | null>(null);

  // 2 つの選択 effect が共有する 1 本のゲート。「どちらが親へ通知する権利を持つか」と
  // 「最後に実際に通知した値」をここだけで持つ (comment-anchor-candidate.ts)。
  const commentAnchorCandidateGateRef = useRef<CommentAnchorCandidateGate>(
    INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE,
  );

  // 親のコールバックは identity を deps に入れず ref で読む。EditorShell は描画のたびに
  // 新しい関数を渡すので、deps に入れると effect が毎描画で再 arm される。
  const onCommentAnchorCandidateChangeRef = useRef(onCommentAnchorCandidateChange);

  const isOverlayEditingRef = useRef(isOverlayEditing);

  // ref の更新は layout effect で行う (レンダー中の代入は react-hooks/refs 違反)。
  // paint 前・ユーザー入力の処理前に走るので、選択 effect が読む値は常に最新になる。
  useLayoutEffect(() => {
    onCommentAnchorCandidateChangeRef.current = onCommentAnchorCandidateChange;
    isOverlayEditingRef.current = isOverlayEditing;
  }, [isOverlayEditing, onCommentAnchorCandidateChange]);

  const hasCommentAnchorRequest = !!onCommentAnchorRequest || !!renderSelectionActions;

  const scheduleTextSelectionUpdateRef = useRef<(() => void) | null>(null);

  // テキスト選択が消えた瞬間に 1 つだけ進むカウンタ。候補の所有権がテキスト選択から
  // 選択ブロック側へ戻ったことを下の effect に伝えるためだけに存在する (アイドル中は
  // 遷移が起きないので進まない = 再描画も起きない)。
  const [commentAnchorOwnershipRevision, setCommentAnchorOwnershipRevision] = useState(0);

  useEffect(() => {
    const canExtendSelection = !!selectionExtension;
    const canComment = hasCommentAnchorRequest;
    if (!canExtendSelection && !canComment) {
      return;
    }

    // Selection callbacks may move the editor's block selection and retrigger
    // `selectionchange`; de-dupe by the feature's semantic key to avoid loops.
    const emitExtensionCandidate = (action: PageCanvasSelectionAction | null) => {
      const key = action?.key ?? "null";
      if (lastExtensionCandidateKeyRef.current === key) {
        return;
      }
      lastExtensionCandidateKeyRef.current = key;
      if (action) {
        action.notifyCandidate?.();
      } else {
        selectionExtension?.clearCandidate?.();
      }
    };
    // 選択がある間の通知。anchor が null でも「選択はある」(範囲からコメントアンカーを
    // 作れなかっただけ) なので、所有権はテキスト選択側に残る。
    const emitCommentAnchorCandidate = (anchor: SigmaCommentAnchor | null) => {
      const decision = decideTextSelectionCommentAnchor(commentAnchorCandidateGateRef.current, anchor);
      commentAnchorCandidateGateRef.current = decision.gate;
      if (decision.emit) {
        onCommentAnchorCandidateChangeRef.current?.(anchor);
      }
    };
    // 選択が消えたときは通知せず、所有権だけ選択ターゲット側へ返す (null を挟むと
    // 候補が一瞬消えて戻る)。retain 指定なら所有権も返さない = 候補は保持される。
    const releaseTextSelectionCommentAnchor = () => {
      const decision = decideTextSelectionCleared(commentAnchorCandidateGateRef.current, {
        retainOnClear: !!selectionExtension?.retainCandidateOnTextSelectionClear,
      });
      commentAnchorCandidateGateRef.current = decision.gate;
      if (decision.handOverToSelectedTarget) {
        setCommentAnchorOwnershipRevision((revision) => revision + 1);
      }
    };
    const clearTextSelectionActions = (force = false) => {
      if (!force && hasHeldCanvasTextSelection(canvasRef.current, window.document.activeElement)) return;
      setExtensionTextSelectionPopover((current) => sameExtensionActionPopover(current, null) ? current : null);
      setCommentTextSelectionPopover((current) => sameCommentAnchorPopover(current, null) ? current : null);
      releaseTextSelectionCommentAnchor();
      if (!selectionExtension?.retainCandidateOnTextSelectionClear) {
        emitExtensionCandidate(null);
      }
    };

    let frame = 0;
    let debounceTimeout = 0;
    const updateTextSelectionReference = () => {
      frame = 0;
      if (isOverlayEditingRef.current) {
        clearTextSelectionActions(true);
        return;
      }

      const selection = window.getSelection();
      const canvas = canvasRef.current;
      // The retained atom range contains the last committed data-tex. While its
      // input owns the draft, hand comments/actions to the selected-math path.
      if (canvas?.querySelector(".inline-math-node.editing")) {
        clearTextSelectionActions(true);
        return;
      }
      // Inputs and popovers temporarily replace Chromium's DOM selection. Keep the
      // existing actions while their body range is still held by ProseMirror.
      if (hasHeldCanvasTextSelection(canvas, window.document.activeElement, false)) return;
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !canvas) {
        clearTextSelectionActions();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!isRangeInsideElement(range, canvas)) {
        clearTextSelectionActions();
        return;
      }

      const selectedText = getCommentOffsetText(range).trim();
      const targetId = getRangeTargetBlockId(range, canvas);
      const selectionRect = getRangeScreenRect(range);
      if (!selectedText || !targetId || !selectionRect) {
        clearTextSelectionActions();
        return;
      }

      const mathTex = getMathTexFromRange(range);
      const textRangeAnchor = createTextCommentAnchorFromRange(range, canvas, selectedText, mathTex);
      const textRange = textRangeAnchor?.type === "textRange" ? textRangeAnchor : undefined;
      const extensionAction = selectionExtension?.createAction({
            kind: "textRange",
            targetId,
            selectedText,
            mathTex,
            textRange,
          }) ?? null;
      const commentAnchor = canComment ? textRangeAnchor : null;
      if (!extensionAction && !commentAnchor) {
        clearTextSelectionActions();
        return;
      }

      emitExtensionCandidate(extensionAction);
      emitCommentAnchorCandidate(commentAnchor);
      const position = withSelectionTrailingAnchor(
        getSelectionActionPopoverPosition(selectionRect),
        Array.from(range.getClientRects()),
        canvas,
        getRangeEndRect(range),
      );
      const nextExtensionPopover = extensionAction ? { action: extensionAction, position } : null;
      const nextCommentPopover = commentAnchor ? { anchor: commentAnchor, position } : null;
      setExtensionTextSelectionPopover((current) =>
        sameExtensionActionPopover(current, nextExtensionPopover) ? current : nextExtensionPopover);
      setCommentTextSelectionPopover((current) =>
        sameCommentAnchorPopover(current, nextCommentPopover) ? current : nextCommentPopover);
    };

    const scheduleUpdate = () => {
      if (debounceTimeout) {
        window.clearTimeout(debounceTimeout);
      }
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      debounceTimeout = window.setTimeout(() => {
        debounceTimeout = 0;
        frame = window.requestAnimationFrame(updateTextSelectionReference);
      }, TEXT_SELECTION_ACTION_DEBOUNCE_MS);
    };

    scheduleUpdate();
    // オーバーレイ編集の出入りでテキスト選択を掃除する経路 (下の effect) から呼べるように
    // 公開する。`isOverlayEditing` を deps に戻すとリスナ登録ごと毎回作り直しになる。
    scheduleTextSelectionUpdateRef.current = scheduleUpdate;
    window.document.addEventListener("selectionchange", scheduleUpdate);
    window.document.addEventListener("focusin", scheduleUpdate);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      scheduleTextSelectionUpdateRef.current = null;
      if (debounceTimeout) {
        window.clearTimeout(debounceTimeout);
      }
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      window.document.removeEventListener("selectionchange", scheduleUpdate);
      window.document.removeEventListener("focusin", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [canvasRef, hasCommentAnchorRequest, selectionExtension]);

  // `isOverlayEditing` の変化だけでテキスト選択の再判定を促す。effect の deps から外した
  // 分、クリア経路 (図形編集に入ったらテキスト選択のポップオーバーを消す) をここで担う。
  useEffect(() => {
    scheduleTextSelectionUpdateRef.current?.();
  }, [isOverlayEditing]);

  useLayoutEffect(() => {
    const canExtendSelection = !!selectionExtension;
    const canComment = hasCommentAnchorRequest;
    // 通知の権利はテキスト選択が無いときだけ。あるときに黙るのは、テキスト選択の方が
    // 具体的な候補で、上書きし合うと親の再描画が往復するため (comment-anchor-candidate.ts)。
    const emitCommentAnchorCandidate = (anchor: SigmaCommentAnchor | null) => {
      const decision = decideSelectedTargetCommentAnchor(commentAnchorCandidateGateRef.current, anchor);
      commentAnchorCandidateGateRef.current = decision.gate;
      if (decision.emit) {
        onCommentAnchorCandidateChangeRef.current?.(anchor);
      }
    };
    const applySelectedTargetPopovers = (
      nextExtensionPopover: ExtensionActionPopoverState | null,
      nextCommentPopover: CommentAnchorPopoverState | null,
    ) => {
      setExtensionSelectedTargetPopover((current) =>
        sameExtensionActionPopover(current, nextExtensionPopover) ? current : nextExtensionPopover);
      setCommentSelectedTargetPopover((current) =>
        sameCommentAnchorPopover(current, nextCommentPopover) ? current : nextCommentPopover);
    };
    if ((!canExtendSelection && !canComment) || isOverlayEditing) {
      const frame = window.requestAnimationFrame(() => {
        applySelectedTargetPopovers(null, null);
        emitCommentAnchorCandidate(null);
      });
      return () => window.cancelAnimationFrame(frame);
    }

    let frame = 0;
    const readCaretOnly = () => !blockHandleSelected && isCaretOnlyInBlock(canvasRef.current, selectedId);
    let caretOnlyShown = readCaretOnly();
    const updatePosition = () => {
      frame = 0;
      const canvas = canvasRef.current;
      if (!canvas) {
        applySelectedTargetPopovers(null, null);
        emitCommentAnchorCandidate(null);
        return;
      }

      if (selectedInlineMath) {
        const canonicalTex = selectedInlineMath.getCanonicalTex?.() ?? selectedInlineMath.tex;
        const mathElement = canvas.querySelector<HTMLElement>(
          `.inline-math-node[data-id="${CSS.escape(selectedInlineMath.id)}"]`,
        );
        const targetId =
          selectedInlineMath.blockId ??
          (mathElement ? getClosestBlockId(mathElement, canvas) : undefined) ??
          selectedId ??
          undefined;
        const extensionAction = targetId
          ? selectionExtension?.createAction({
              kind: "inlineMath",
              targetId,
              mathInlineId: selectedInlineMath.id,
              tex: canonicalTex,
            }) ?? null
          : null;
        const commentAnchor: SigmaCommentAnchor | null = targetId && canComment
          ? {
              type: "inlineMath",
              blockId: targetId,
              mathInlineId: selectedInlineMath.id,
              quote: canonicalTex ? `$${canonicalTex}$` : undefined,
              tex: canonicalTex,
            }
          : null;
        const rect = mathElement?.getBoundingClientRect();
        const position = rect ? withSelectionTrailingAnchor(getSelectionActionPopoverPosition(rect), [rect], canvas) : null;
        emitCommentAnchorCandidate(commentAnchor);
        applySelectedTargetPopovers(
          extensionAction && position ? { action: extensionAction, position } : null,
          commentAnchor && position ? { anchor: commentAnchor, position } : null,
        );
        return;
      }

      const commentAnchor = selectedId && canComment
        ? createBlockCommentAnchor(document, selectedId)
        : null;
      emitCommentAnchorCandidate(commentAnchor);
      // カーソルを置いただけ (範囲もブロックの選択もない) なら、何も選んでいないので浮かぶ操作は出さない。
      // 上のコメントの候補 (コメント欄の「コメントを追加」の付け先) は、これまでどおりカーソルのあるブロックを指す。
      caretOnlyShown = readCaretOnly();
      if (caretOnlyShown) {
        applySelectedTargetPopovers(null, null);
        return;
      }

      const blockElement = selectedId ? findBlockElement(canvas, selectedId) : null;
      const extensionAction = selectionExtension?.createAction({
        kind: "block",
        targetId: selectedId,
      }) ?? null;
      const rect = blockElement?.getBoundingClientRect();
      const position = rect ? withSelectionTrailingAnchor(getSelectionActionPopoverPosition(rect), [rect], canvas) : null;
      applySelectedTargetPopovers(
        extensionAction && position ? { action: extensionAction, position } : null,
        commentAnchor && position ? { anchor: commentAnchor, position } : null,
      );
    };
    const scheduleUpdate = () => {
      if (frame) window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(updatePosition);
    };
    // 選んだブロックが同じまま、カーソルだけの状態と変わる/戻ることがある (カーソルのあるブロックを
    // つまみで選び直す、選択を解いてカーソルに戻す)。`selectedId` は動かないので、選択が動いたら
    // 「カーソルだけか」だけを安く読み直し、変わったときだけ位置の測り直しを頼む。
    let recheckFrame = 0;
    const recheckCaretOnly = () => {
      if (selectedInlineMath) return;
      if (recheckFrame) window.cancelAnimationFrame(recheckFrame);
      recheckFrame = window.requestAnimationFrame(() => {
        recheckFrame = 0;
        if (readCaretOnly() !== caretOnlyShown) scheduleUpdate();
      });
    };
    scheduleUpdate();
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    window.document.addEventListener("selectionchange", recheckCaretOnly);
    window.document.addEventListener("focusin", recheckCaretOnly);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      if (recheckFrame) window.cancelAnimationFrame(recheckFrame);
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
      window.document.removeEventListener("selectionchange", recheckCaretOnly);
      window.document.removeEventListener("focusin", recheckCaretOnly);
    };
  }, [blockHandleSelected, commentAnchorOwnershipRevision, document, hasCommentAnchorRequest, isOverlayEditing, selectionExtension, selectedId, selectedInlineMath, totalHeight, layoutRevision, zoom, canvasRef]);
  const onOverlayCardBoundsChange = overlaySelectionPopoverShown ? updateOverlayCardBounds : undefined;
  return { overlaySelectionKey, selectionActionPopover, selectionControlsRect, onOverlayCardBoundsChange };
}

/** 本文の選択の位置に、右下の角 (AI・コメントの入力欄を開く場所) を添える (図形の選択には添えない)。 */
function withSelectionTrailingAnchor(
  position: SelectionActionPopoverPosition,
  lines: readonly DOMRect[],
  canvas: HTMLElement,
  end: DOMRect | null = null,
): SelectionActionPopoverPosition {
  const trailing = getSelectionTrailingAnchor(lines, canvas, end);
  return trailing ? { ...position, trailing } : position;
}

/** 範囲の終わりに置いたカーソルの矩形。要素の境目で終わる範囲などで測れなければ null。 */
function getRangeEndRect(range: Range): DOMRect | null {
  const end = range.cloneRange();
  end.collapse(false);
  const rects = Array.from(end.getClientRects()).filter((rect) => rect.height > 0);
  return rects.at(-1) ?? null;
}
