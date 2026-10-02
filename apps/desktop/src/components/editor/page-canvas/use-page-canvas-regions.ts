"use client";
import {
  enablePageRunningRegion,
  expandMarginsForRunningRegions,
  fitRunningRegionToContent,
  getRunningRegionBoundsMm,
  MM_TO_PX,
  resizeHorizontalMarginsLayout,
  resizeRunningRegionLayout,
  type PageLayout,
  type PageOverlay,
} from "@/features/document";
import { type TextFlowBlock } from "@/features/text-editing";
import type { Translate } from "@/lib/i18n";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback,useEffect,useLayoutEffect,useRef,useState } from "react";
import type { OverlayChangeOptions,PageLayoutChangeOptions } from "../page-overlay-types";
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

  const runningRegionContentHeightRef = useRef<Partial<Record<RunningRegionKind, number>>>({});

  const pageMarginDragRef = useRef<PageMarginDragState | null>(null);

  const dragCleanupRef = useRef<(() => void) | null>(null);
  const cancelLayoutDrag = useCallback(() => {
    dragCleanupRef.current?.();
    dragCleanupRef.current = null;
    runningRegionDragRef.current = null;
    pageMarginDragRef.current = null;
    pageLayoutDraftRef.current = null;
    setPageLayoutDraft(null);
  }, []);
  useLayoutEffect(() => {
    runningRegionContentHeightRef.current = {};
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

  const updateRunningRegionBlocks = useCallback((
    kind: RunningRegionKind,
    nextBlocks: TextFlowBlock[],
  ) => {
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = replacePageRunningRegionTextFlow(
      baseLayout,
      kind,
      nextBlocks,
      tEditorText,
    );
    if (!nextLayout) {
      return;
    }

    onPageLayoutChange(nextLayout);
    setPageLayoutDraft(null);
    pageLayoutDraftRef.current = null;
  }, [layout, onPageLayoutChange, tEditorText]);

  const resizeRunningRegionForContent = useCallback((
    kind: RunningRegionKind,
    contentHeightPx: number,
  ) => {
    const previousContentHeightPx = runningRegionContentHeightRef.current[kind];
    runningRegionContentHeightRef.current[kind] = contentHeightPx;
    const allowShrink = typeof previousContentHeightPx === "number" && contentHeightPx < previousContentHeightPx - 1;
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const nextLayout = fitRunningRegionToContent(baseLayout, kind, contentHeightPx, { allowShrink });
    if (nextLayout === baseLayout) {
      return;
    }

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
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    const bounds = getRunningRegionBoundsMm(baseLayout, kind);
    runningRegionDragRef.current = {
      kind,
      edge,
      startClientY,
      startTopMm: bounds.topMm,
      startBottomMm: bounds.bottomMm,
      baseLayout,
    };

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
  }, [cancelLayoutDrag, layout, onPageLayoutChange, zoom]);

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
    runningRegionEditKind,
    runningRegionOverlayEditing,
    setRunningRegionOverlayEditing,
    runningRegionEditPageNumber,
    horizontalMarginEditPageNumber,
    setRunningRegionEditKind,
    setHorizontalMarginEditPageNumber,
    editRunningRegion,
    enableRunningRegion,
    beginPageMarginDrag,
    runningRegionFocusRequest,
    updateRunningRegionBlocks,
    resizeRunningRegionForContent,
    startRunningRegionDrag,
    startPageMarginDrag,
    updateRunningRegionOverlay
  };
}
