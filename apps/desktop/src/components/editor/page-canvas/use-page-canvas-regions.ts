"use client";
import {
  captureRunningRegionFitBase,
  clearRunningRegionPageContents,
  enablePageRunningRegion,
  expandMarginsForRunningRegions,
  fitRunningRegionToEditedContent,
  getRunningRegionBoundsMm,
  MM_TO_PX,
  resizeHorizontalMarginsLayout,
  resizeRunningRegionLayout,
  setRunningRegionPageContentEnabled,
  setRunningRegionPageRange,
  setRunningRegionShownOnPage,
  type PageLayout,
  type PageOverlay,
  type RunningRegionFitBase,
  type RunningRegionPageRange,
} from "@/features/document";
import { type TextFlowBlock } from "@/features/text-editing";
import type { Translate } from "@/lib/i18n";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
import { flushSync } from "react-dom";
import { FLUSH_OVERLAY_CHANGES_EVENT, type OverlayChangeOptions, type PageLayoutChangeOptions } from "../page-overlay-types";
import { replacePageRunningRegionTextFlow } from "./running-region-text-model";
import type {
  PageMarginDragState,
  PageMarginEdge,
  RunningRegionDragState,
  RunningRegionEdge,
  RunningRegionKind,
} from "./types";

interface Inputs {
  documentId: string;
  onRunningRegionEditingChange: ((kind: "header" | "footer" | null) => void) | undefined;
  onSelect: (blockId: string | null) => void;
  onPageLayoutChange: (layout: PageLayout, options?: PageLayoutChangeOptions) => void;
  layout: PageLayout;
  tEditorText: Translate<"editor">;
  zoom: number;
}

export function usePageCanvasRunningRegions({ documentId, onRunningRegionEditingChange, onSelect, onPageLayoutChange, layout, tEditorText, zoom }: Inputs) {
  const layoutRef = useRef(layout);
  useLayoutEffect(() => { layoutRef.current = layout; }, [layout]);

  const [pageLayoutDraft, setPageLayoutDraft] = useState<PageLayout | null>(null);

  // A different canonical document must never display the preceding drag draft.
  // Reset during render so no old draft is committed while effect cleanup detaches listeners.
  const [draftDocumentId, setDraftDocumentId] = useState(documentId);
  if (draftDocumentId !== documentId) {
    setDraftDocumentId(documentId);
    setPageLayoutDraft(null);
  }

  const pageLayoutDraftRef = useRef<PageLayout | null>(null);

  const [runningRegionEditKind, setRunningRegionEditKind] = useState<RunningRegionKind | null>(null);

  const [runningRegionEditPageNumber, setRunningRegionEditPageNumber] = useState(1);

  const [runningRegionOverlayEditing, setRunningRegionOverlayEditing] = useState(false);

  const [runningRegionFocusRequest, setRunningRegionFocusRequest] = useState(0);

  const [horizontalMarginEditPageNumber, setHorizontalMarginEditPageNumber] = useState<number | null>(null);

  const runningRegionDragRef = useRef<RunningRegionDragState | null>(null);

  /** いまドラッグしている帯の辺。辺の横に寸法を出すために描画へ渡す。 */
  const [runningRegionResize, setRunningRegionResize] = useState<{ kind: RunningRegionKind; edge: RunningRegionEdge } | null>(null);

  /**
   * 編集中の帯ごとの「利用者が決めた大きさ」。`expectedHeightMm` は自動で伸縮させた後の高さで、
   * 帯がそれと違う高さになっていたら (ドラッグ・ページ設定・元に戻す)、その大きさを新しい基準にする。
   */
  const runningRegionFitRef = useRef<Partial<Record<RunningRegionKind, RunningRegionFitBase & { expectedHeightMm: number }>>>({});

  const pageMarginDragRef = useRef<PageMarginDragState | null>(null);

  const dragCleanupRef = useRef<(() => void) | null>(null);
  const cancelLayoutDrag = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    runningRegionDragRef.current = null;
    pageMarginDragRef.current = null;
    pageLayoutDraftRef.current = null;
    setPageLayoutDraft(null);
    setRunningRegionResize(null);
  }, []);
  useLayoutEffect(() => {
    runningRegionFitRef.current = {};
    return () => {
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      runningRegionDragRef.current = null;
      pageMarginDragRef.current = null;
      pageLayoutDraftRef.current = null;
    };
  }, [documentId]);

  useEffect(() => {
    onRunningRegionEditingChange?.(runningRegionEditKind);
    if (runningRegionEditKind) {
      onSelect(null);
    }
  }, [onRunningRegionEditingChange, onSelect, runningRegionEditKind]);

  const editRunningRegion = useCallback((kind: RunningRegionKind | null, pageNumber = 1) => {
    // 編集に入り直すたびに基準を取り直す。前の編集の中身の高さを持ち越すと、描き終わる前の
    // 空の帯を測った値を「中身が減った」と読み、引き伸ばした帯を縮めてしまう。
    runningRegionFitRef.current = {};
    setRunningRegionOverlayEditing(false);
    setRunningRegionEditKind(kind);
    if (kind) {
      setRunningRegionEditPageNumber(pageNumber);
      setRunningRegionFocusRequest((current) => current + 1);
      setHorizontalMarginEditPageNumber(null);
    }
  }, []);

  const enableRunningRegion = useCallback((kind: RunningRegionKind, pageNumber = 1) => {
    onPageLayoutChange(expandMarginsForRunningRegions(enablePageRunningRegion(layout, kind)));
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
    editRunningRegion(kind, pageNumber);
  }, [editRunningRegion, layout, onPageLayoutChange]);

  /** そのページだけ帯を出す/出さない。ページ数は、いまより先の古い印を片付けるのに使う。 */
  const setRunningRegionShownOnPageAt = useCallback((
    kind: RunningRegionKind,
    pageNumber: number,
    shown: boolean,
    totalPages: number,
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = setRunningRegionShownOnPage(baseLayout, kind, pageNumber, shown, totalPages);
    if (nextLayout === baseLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  /** 「すべて/先頭ページのみ/先頭以外」のまとまりで、どのページに出すかを決める。 */
  const setRunningRegionPageRangeFor = useCallback((kind: RunningRegionKind, range: RunningRegionPageRange) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = setRunningRegionPageRange(baseLayout, kind, range);
    if (nextLayout === baseLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  /** ページ専用の中身をすべてやめて、共通の中身に戻す。 */
  const clearRunningRegionPageContentsFor = useCallback((kind: RunningRegionKind) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = clearRunningRegionPageContents(baseLayout, kind);
    if (nextLayout === baseLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  /** そのページだけ中身を変える/共通に戻す。 */
  const setRunningRegionPageContentAt = useCallback((
    kind: RunningRegionKind,
    pageNumber: number,
    enabled: boolean,
    totalPages: number,
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = setRunningRegionPageContentEnabled(baseLayout, kind, pageNumber, enabled, totalPages);
    if (nextLayout === baseLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  const updateRunningRegionBlocks = useCallback((
    kind: RunningRegionKind,
    nextBlocks: TextFlowBlock[],
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    // いま編集しているページがページ専用の中身を持っていれば、その文字だけを書き換える。
    const nextLayout = replacePageRunningRegionTextFlow(
      baseLayout,
      kind,
      nextBlocks,
      tEditorText,
      runningRegionEditPageNumber,
    );
    if (!nextLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange, runningRegionEditPageNumber, tEditorText]);

  const resizeRunningRegionForContent = useCallback((
    kind: RunningRegionKind,
    contentHeightPx: number,
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const region = baseLayout[kind];
    const fit = runningRegionFitRef.current[kind];
    if (!fit || !region || Math.abs(region.heightMm - fit.expectedHeightMm) > 0.01) {
      // 編集の始まり、または利用者が帯の大きさを変えた直後。いまの大きさが利用者の選んだもの。
      const base = captureRunningRegionFitBase(baseLayout, kind, contentHeightPx);
      runningRegionFitRef.current[kind] = base ? { ...base, expectedHeightMm: base.heightMm } : undefined;
      return;
    }

    const nextLayout = fitRunningRegionToEditedContent(baseLayout, kind, contentHeightPx, fit);
    if (nextLayout === baseLayout) {
      return;
    }

    fit.expectedHeightMm = nextLayout[kind]?.heightMm ?? fit.expectedHeightMm;
    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  const updateRunningRegionOverlay = useCallback((
    kind: RunningRegionKind,
    nextOverlay: PageOverlay,
    options?: OverlayChangeOptions,
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const enabledLayout = expandMarginsForRunningRegions(enablePageRunningRegion(baseLayout, kind));
    const region = enabledLayout[kind];
    if (!region) {
      return;
    }

    onPageLayoutChange(
      {
        ...enabledLayout,
        [kind]: {
          ...region,
          overlay: nextOverlay,
        },
      },
      options,
    );
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange]);

  const beginRunningRegionDrag = useCallback((
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    startClientY: number,
  ) => {
    cancelLayoutDrag();
    // Commit the running canvas before the resize preview replaces it. Otherwise a delayed
    // anchor save can overwrite the compensated coordinates halfway through the band drag.
    flushSync(() => window.dispatchEvent(new Event(FLUSH_OVERLAY_CHANGES_EVENT)));
    const baseLayout = pageLayoutDraftRef.current ?? layoutRef.current;
    const bounds = getRunningRegionBoundsMm(baseLayout, kind);
    runningRegionDragRef.current = {
      kind,
      edge,
      startClientY,
      startTopMm: bounds.topMm,
      startBottomMm: bounds.bottomMm,
      baseLayout,
    };
    setRunningRegionResize({ kind, edge });

    const ownedDrag = runningRegionDragRef.current;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = runningRegionDragRef.current;
      if (!drag || drag !== ownedDrag) {
        return;
      }

      const deltaMm = ((moveEvent.clientY - drag.startClientY) / (zoom / 100)) / MM_TO_PX;
      const nextLayout = resizeRunningRegionLayout(drag, deltaMm);
      pageLayoutDraftRef.current = nextLayout;
      setPageLayoutDraft(nextLayout);
    };

    const handlePointerUp = () => {
      if (runningRegionDragRef.current !== ownedDrag) return;
      const nextLayout = pageLayoutDraftRef.current;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      runningRegionDragRef.current = null;
      if (nextLayout) {
        onPageLayoutChange(nextLayout);
      }
      pageLayoutDraftRef.current = null;
      setPageLayoutDraft(null);
      setRunningRegionResize(null);

    };

    const handlePointerCancel = () => {
      if (runningRegionDragRef.current === ownedDrag) cancelLayoutDrag();
    };
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }, [cancelLayoutDrag, onPageLayoutChange, zoom]);

  const startRunningRegionDrag = useCallback((
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    beginRunningRegionDrag(kind, edge, event.clientY);
  }, [beginRunningRegionDrag]);

  const beginPageMarginDrag = useCallback((edge: PageMarginEdge, startClientX: number) => {
    cancelLayoutDrag();
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    pageMarginDragRef.current = {
      edge,
      startClientX,
      startLeftMm: baseLayout.marginsMm.left,
      startRightMm: baseLayout.marginsMm.right,
      baseLayout,
    };

    const ownedDrag = pageMarginDragRef.current;
    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = pageMarginDragRef.current;
      if (!drag || drag !== ownedDrag) {
        return;
      }

      const deltaMm = ((moveEvent.clientX - drag.startClientX) / (zoom / 100)) / MM_TO_PX;
      const nextLayout = resizeHorizontalMarginsLayout(drag, deltaMm);
      pageLayoutDraftRef.current = nextLayout;
      setPageLayoutDraft(nextLayout);
    };

    const handlePointerUp = () => {
      if (pageMarginDragRef.current !== ownedDrag) return;
      const nextLayout = pageLayoutDraftRef.current;
      dragCleanupRef.current?.();
      dragCleanupRef.current = null;
      pageMarginDragRef.current = null;
      if (nextLayout) {
        onPageLayoutChange(nextLayout);
      }
      pageLayoutDraftRef.current = null;
      setPageLayoutDraft(null);

    };

    const handlePointerCancel = () => {
      if (pageMarginDragRef.current === ownedDrag) cancelLayoutDrag();
    };
    dragCleanupRef.current = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
  }, [cancelLayoutDrag, layout, onPageLayoutChange, zoom]);

  const startPageMarginDrag = useCallback((edge: PageMarginEdge, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    beginPageMarginDrag(edge, event.clientX);
  }, [beginPageMarginDrag]);

  useEffect(() => {
    if (!runningRegionEditKind) {
      return;
    }

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        editRunningRegion(null);
      }
    };

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [editRunningRegion, runningRegionEditKind]);
  return {
    pageLayoutDraft,
    runningRegionResize,
    runningRegionEditKind,
    runningRegionOverlayEditing,
    setRunningRegionOverlayEditing,
    runningRegionEditPageNumber,
    horizontalMarginEditPageNumber,
    setRunningRegionEditKind,
    setHorizontalMarginEditPageNumber,
    editRunningRegion,
    enableRunningRegion,
    setRunningRegionShownOnPageAt,
    setRunningRegionPageRangeFor,
    setRunningRegionPageContentAt,
    clearRunningRegionPageContentsFor,
    beginPageMarginDrag,
    runningRegionFocusRequest,
    updateRunningRegionBlocks,
    resizeRunningRegionForContent,
    startRunningRegionDrag,
    startPageMarginDrag,
    updateRunningRegionOverlay
  };
}
