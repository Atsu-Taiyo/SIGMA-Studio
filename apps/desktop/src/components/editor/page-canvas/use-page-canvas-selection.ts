"use client";
import type { SigmaDocument } from "@/features/document";
import { type SigmaCommentAnchor } from "@/features/document";
import type { RefObject } from "react";
import { useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
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
import { findBlockElement,getMathTexFromRange } from "./comment-geometry";
import { ExtensionActionPopoverState } from "./editor-contracts";
import type { PageCanvasSelectionAction,PageCanvasSelectionExtension } from "./editor-extension";
import {
  createBlockCommentAnchor,
  createTextCommentAnchorFromRange,
  getClosestBlockId,
  getOverlaySelectionActionPopoverPosition,
  getOverlaySelectionControlsCanvasRect,
  getOverlaySelectionTargetBlockId,
  getRangeScreenRect,
  getRangeTargetBlockId,
  getSelectionActionPopoverPosition,
  isRangeInsideElement,
  sameSelectionActionPopoverPosition,
  type CommentAnchorPopoverState,
  type OverlaySelectionPopoverMeasurement,
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
  onCommentAnchorRequest: ((anchor: SigmaCommentAnchor) => void) | undefined;
  renderSelectionActions: ((anchor: SigmaCommentAnchor) => React.ReactNode) | undefined;
  selectedInlineMath: { id: string; tex: string; blockId?: string; } | null;
  totalHeight: number;
  /** 描いた図形の選択ポップオーバーの幅 (画面の px)。測る前は見積もり。 */
  overlayPopoverWidthPx?: number;
}

const TEXT_SELECTION_ACTION_DEBOUNCE_MS = 120;
export function usePageCanvasSelectionActions({ overlaySelection, suppressSelectionActions, pageOverlayEditing, selectionExtension, selectedId, document, bodyOverlayModeStatus, overlayCommentAnchor, canvasRef, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY, onCommentAnchorCandidateChange, isOverlayEditing, onCommentAnchorRequest, renderSelectionActions, selectedInlineMath, totalHeight, overlayPopoverWidthPx }: Inputs) {

  const [extensionTextSelectionPopover, setExtensionTextSelectionPopover] = useState<ExtensionActionPopoverState | null>(null);

  const [extensionSelectedTargetPopover, setExtensionSelectedTargetPopover] = useState<ExtensionActionPopoverState | null>(null);

  const [commentTextSelectionPopover, setCommentTextSelectionPopover] = useState<CommentAnchorPopoverState | null>(null);

  const [commentSelectedTargetPopover, setCommentSelectedTargetPopover] = useState<CommentAnchorPopoverState | null>(null);

  const overlaySelectionKey = JSON.stringify([overlaySelection.selectedShapeIds, overlaySelection.region]);

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
  const selectionControls = useMemo(
    () => overlaySelectionPopoverShown
      ? getOverlaySelectionControlsCanvasRect(overlaySelection, zoom, overlayPopoverWidthPx)
      : null,
    [overlayPopoverWidthPx, overlaySelection, overlaySelectionPopoverShown, zoom],
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
  }, [overlaySelection, overlaySelectionKey, pageOverlayEditing, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY, canvasRef]);

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
    const clearTextSelectionActions = () => {
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
        clearTextSelectionActions();
        return;
      }

      const selection = window.getSelection();
      const canvas = canvasRef.current;
      if (!selection || selection.rangeCount === 0 || selection.isCollapsed || !canvas) {
        clearTextSelectionActions();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!isRangeInsideElement(range, canvas)) {
        clearTextSelectionActions();
        return;
      }

      const selectedText = selection.toString().trim();
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
      const position = getSelectionActionPopoverPosition(selectionRect);
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

    const frame = window.requestAnimationFrame(() => {
      const canvas = canvasRef.current;
      if (!canvas) {
        applySelectedTargetPopovers(null, null);
        emitCommentAnchorCandidate(null);
        return;
      }

      if (selectedInlineMath) {
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
              tex: selectedInlineMath.tex,
            }) ?? null
          : null;
        const commentAnchor: SigmaCommentAnchor | null = targetId && canComment
          ? {
              type: "inlineMath",
              blockId: targetId,
              mathInlineId: selectedInlineMath.id,
              quote: selectedInlineMath.tex ? `$${selectedInlineMath.tex}$` : undefined,
              tex: selectedInlineMath.tex,
            }
          : null;
        const rect = mathElement?.getBoundingClientRect();
        const position = rect ? getSelectionActionPopoverPosition(rect) : null;
        emitCommentAnchorCandidate(commentAnchor);
        applySelectedTargetPopovers(
          extensionAction && position ? { action: extensionAction, position } : null,
          commentAnchor && position ? { anchor: commentAnchor, position } : null,
        );
        return;
      }

      const blockElement = selectedId ? findBlockElement(canvas, selectedId) : null;
      const extensionAction = selectionExtension?.createAction({
        kind: "block",
        targetId: selectedId,
      }) ?? null;
      const commentAnchor = selectedId && canComment
        ? createBlockCommentAnchor(document, selectedId)
        : null;
      const rect = blockElement?.getBoundingClientRect();
      const position = rect ? getSelectionActionPopoverPosition(rect) : null;
      emitCommentAnchorCandidate(commentAnchor);
      applySelectedTargetPopovers(
        extensionAction && position ? { action: extensionAction, position } : null,
        commentAnchor && position ? { anchor: commentAnchor, position } : null,
      );
    });

    return () => window.cancelAnimationFrame(frame);
  }, [commentAnchorOwnershipRevision, document, hasCommentAnchorRequest, isOverlayEditing, selectionExtension, selectedId, selectedInlineMath, totalHeight, zoom, canvasRef]);
  return { overlaySelectionKey, selectionActionPopover, selectionControlsRect };
}
