"use client";
import { createColumnRuleStyle } from "@/features/rendering/adapters";

import { ColumnRuleLines, PageColumnRules } from "@/features/rendering/adapters/react";
import { ColumnRuleDialog } from "./ColumnRuleDialog";

import { resolveColumnCommandState } from "./page-canvas/column-command-state";
import { canInsertManualBreakAtBlock } from "./page-canvas/manual-break-context";

import { ProblemNumberingProvider } from "./text-flow/ProblemNumberingContext";
import { getProblemNumberMap } from "@/lib/problem-numbering";
import  {
  BLOCK_HIT_PROBE_INSET_PX,
  canvasLayoutScale,
  getClientOverlayPointOnCanvas,
  getClientOverlayPointOnPage,
  getPagePointerContext,
  getSelectionScopedBlockIds,
  hitTestTopLevelBlock,
} from "./page-canvas/pointer-targets";


import  {
  ChevronRight,
  ClipboardPaste,
  Columns3,
  Copy,
  CornerDownRight,
  GripVertical,
  Heading,
  Maximize,
  MessageSquarePlus,
  Minus,
  MoreHorizontal,
  PackagePlus,
  Plus,
  Settings2,
  Trash2,
} from "lucide-react";
import dynamic from "next/dynamic";
import type  {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import  {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";

import { beginLayoutColumnResize } from "./layout-column-resize";
import { BlockEditor } from "@/components/editor/BlockEditor";
import { CommentThreadsPanel, type CommentThreadsPanelProps } from "@/components/editor/CommentThreadsPanel";
import { EditorExtensionProvider, useEditorExtensions, type EditorExtensionContextValue } from "@/components/editor/editor-extension-context";
import { KEYBOARD_ZOOM_STEP } from "@/components/editor/editor-shell/constants";
import { activatePageBreakMarkerOnClick, activatePageBreakMarkerOnMouseDown } from "@/components/editor/page-break-marker";
import { PageRunningRegionView } from "@/components/editor/PageRunningRegionView";
import { ProblemSettingsDialog } from "@/components/editor/ProblemSettingsDialog";
import  {
  cancelCaretKeeperWindow,
  finishCaretKeeperWindow,
  flushPendingCaret,
  focusCaretAddress,
  requestCaret,
  requestCaretKeeperReanchor,
  setFragmentTables,
  startCaretKeeperWindow,
  subscribeCaretKeeperTarget,
  subscribeCaretSurfaceMount,
} from "@/components/editor/text-flow/caret-router";
import { scrollElementIntoCanvasView } from "@/components/editor/text-flow/caret-scroll";
import { mergeLargePasteDeferredBlockIds } from "@/components/editor/text-flow/large-text-paste";
import { shouldRestoreTextFlowSelectionAfterChange } from "@/components/editor/text-flow/text-run-replacement";
import  {
  clearTextRunSpanOnOutsidePointerDown,
  getFocusedTextRunUnitIds,
  isMultiEditorTextRunSpan,
  startLocalColumnPointerSelection,
  type TextRunScopeContainer,
} from "@/components/editor/text-flow/text-run-span";
import { TextRunSelectionOverlay } from "@/components/editor/text-flow/TextRunSelectionOverlay";
import  {
  REQUEST_BOX_SETTINGS_EVENT,
  REQUEST_TEXT_PAGE_BREAK_EVENT,
  TextFlowEditor,
  type TextFlowBodyBlockCommandRequest,
  type TextFlowBoundaryDeleteRequest,
  type TextFlowBoxFragmentSourceLayout,
  type TextFlowChangeContext,
  type TextFlowHeadingCommandRequest,
  type TextFlowMaterialInsertRequest,
  type TextFlowProblemCommandRequest,
  type TextFlowReplaceOptions,
  type TextPageBreakRequestDetail,
} from "@/components/editor/TextFlowEditor";
import type { TextFlowChangeDecorationState } from "@/components/tiptap/change-decoration";
import  {
  BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
  blockSpaceAfterPx,
  enablePageRunningRegion,
  ensurePageLayout,
  estimateBlockHeightPx,
  expandMarginsForRunningRegions,
  fitRunningRegionToContent,
  getPageMetrics,
  getRunningRegionBoundsMm,
  getRunningRegionOverlaySize,
  isWhiteboardPageLayout,
  MM_TO_PX,
  mmToPx,
  normalizeOverlaySnapshot,
  PAGE_GAP_PX,
  resizeHorizontalMarginsLayout,
  resizeRunningRegionLayout,
  roundHalfMm,
  type LayoutSectionNode,
  type PageLayout,
  type PageMetrics,
  type PageOverlay,
  type PageRunningRegion,
  type ProblemAreaBlock,
  type ProblemAreaKind,
  type ProblemNode,
  type RichBlock,
  type SigmaBlock,
  type SigmaCommentAnchor,
  type SigmaCommentThread,
  type SigmaDocument,
  type SigmaTableSpec,
} from "@/features/document";
import { getShapeBounds, hitTestShape } from "@/features/drawing";
import  {
  getSafeProblemAreaMinHeightPx,
  createIndependentColumnLayout,
  getVisibleOverlayShapes,
  type OverlayPreviewStackLayer,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import { EDITOR_ZOOM_CHANGE_EVENT } from "@/features/rendering/adapters/editor-zoom-event";
import  {
  bodyTextFlowBlockContainsId,
  canInsertManualPageBreakAfterBlock,
  caretAddressAtBlockEdge,
  collectBoxBlocksById,
  findTopLevelBlock,
  getCommentThreadsSyncKey,
  getLayoutSectionColumns,
  getLayoutSectionColumnWidths,
  getNestedPageBreakBeforeIds,
  getNestedPageBreakBeforeKinds,
  getNextTopLevelTextFlowBlockId,
  getPageBreakBeforeIds,
  getProblemNumberFontSize,
  getTextFlowBreakGapSyncKey,
  getTextFlowColumnLayoutsSyncKey,
  getTextFlowFragmentLayoutsSyncKey,
  isBodyContextMenuBlock,
  isColumnWrapTargetBlock,
  isProblemAreaKind,
  isTextFlowBlock,
  resolveTextFlowBoundaryDelete,
  setBlockBreakBefore,
  setBlockSpaceAfter,
  setLayoutSectionColumnCount,
  setLayoutSectionColumns,
  type PageBreakMarkerKind,
  type TextFlowBlock,
  type TextFlowSelectionBookmark,
} from "@/features/text-editing";
import { indexDragAnchors, indexDragUnits, type BlockDragMoveRequest } from "@/lib/block-drag-move";
import  {
  cornerBoxReferenceHeightStyleVars,
} from "@/lib/box-blocks";
import { getCommentThreadsForBlock, getCommentThreadsForOverlayShape, visibleCommentThreads } from "@/lib/comments";
import  {
  collectBlocksById,
  createEmptyProblemAreaAnchorBlock,
  createParagraph,
  findBlock,
  findContainingBoxBlock,
  findContainingLayoutSection,
  type EditableBlock,
} from "@/lib/document-tree";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import { getSupportedOverlayImageFilesFromDataTransfer, hasSupportedOverlayImageData } from "@/lib/overlay-image-files";
import { countPerformanceEvent, measurePerformance } from "@/lib/performance";
import { getProblemFrameChromePaddingPx, getProblemFrameStyleId, problemFrameClassName } from "@/lib/problem-frame";
import { formatProblemNumber } from "@/lib/problem-numbering";
import { isInsertTextShapeAtCursorShortcut } from "@/shortcuts/editor-shortcuts";
import type { MaterialItem } from "@/types/material";
import { createCameraDragAutoScrollPanBy } from "./drag-auto-scroll";
import  {
  measureBlockTops,
  reanchorAfterDeletion,
  resolveShapeAnchorPositions,
  resolveShapesPosition,
  type BlockExtent,
  type MeasuredBlock,
} from "./overlay-canvas/anchor";
import type { OverlayShapeDecoration } from "./overlay-canvas/editor-extension";
import { attachUnanchoredShapesToMeasuredBlocks } from "./overlay-canvas/reanchor-model";
import type  {
  OverlayAsset,
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayTool,
} from "./overlay-canvas/types";
import { createResolvedOverlayView, type OverlayIdentityCache, type ResolvedOverlayView } from "./overlay-canvas/view-cache";
import { OverlayShapeReadOnlyView } from "./OverlayCanvasEditorClient";
import { buildAppliedGapIndex } from "./page-canvas/applied-gaps";
import  {
  blockHitProbeColumnLeftPx,
  EMPTY_BLOCK_AFFORDANCE_HOVER,
  resolveBlockAffordanceHover,
  resolveBlockAffordancePointerOwner,
  resolveBlockInsertButtonLane,
  resolveStationaryBlockAffordanceRefresh,
  sameBlockAffordanceHover,
  type BlockAffordanceHover,
  type BlockInsertPoint,
  type BlockSpaceAfterTarget,
  type TopLevelBlockBox,
} from "./page-canvas/block-affordances";
import { measureDragUnitPieces, pointHitsLayoutColumnResizeHandle, type DragIndex } from "./page-canvas/block-drag-dom";
import  {
  emptyProblemAreaEditorBlockId,
  hasBreakBefore,
  isProblemFrameArea,
  PROBLEM_AREA_ORDER,
  problemAreaDraftKey,
  shouldShowProblemArea,
} from "./page-canvas/block-ops";
import { shouldHandleBlockSelectionDelete } from "./page-canvas/block-selection-keyboard-policy";
import { shouldKeepBlockSelectionOnPagePointerDown } from "./page-canvas/block-selection-pointer-policy";
import { resolveBodyPointerRoute } from "./page-canvas/body-pointer-routing";
import { resolveBodyTextFlowTransition } from "./page-canvas/body-text-flow-transition";
import  {
  findEditableElementUnderPoint,
  focusUnderlyingEditorAtPoint,
  selectUnderlyingEditorRange,
  type ClientPoint,
  type OverlayPreviewPointerHandoff,
} from "./page-canvas/caret-focus";
import  {
  computeColumnUnitLayouts,
  getColumnBreakBeforeBlockIdForContextMenu,
  getPageIndexForY,
  measureLocalColumnContextMenuLayout,
  type LocalColumnContextMenuLayout,
} from "./page-canvas/column-layout";
import  {
  decideSelectedTargetCommentAnchor,
  decideTextSelectionCleared,
  decideTextSelectionCommentAnchor,
  INITIAL_COMMENT_ANCHOR_CANDIDATE_GATE,
  sameCommentAnchorPopover,
  sameExtensionActionPopover,
  type CommentAnchorCandidateGate,
} from "./page-canvas/comment-anchor-candidate";
import type { PageCanvasEditorExtension, PageCanvasInlineContent, PageCanvasSelectionAction } from "./page-canvas/editor-extension";
import { getColumnContentAnchor, type ColumnContentAnchor } from "./page-canvas/extension-placement";
import  {
  canMeasureIncrementally,
  MAX_CONSECUTIVE_INCREMENTAL_MEASURES,
  resolveMeasureScope,
  type FlowMeasurement,
} from "./page-canvas/incremental-layout";
import { getProblemAfterInlineContent, splitTextFlowBlocksByInlineContent } from "./page-canvas/inline-content-composition";
import  {
  sameBlockExtentMap,
  sameEditorBoxBlockFragmentLayouts,
  sameGapMap,
  sameMeasuredBlockMap,
  sameNullableNumber,
  sameNumberMap,
  samePageMetrics,
  sameProblemAreaColumnLayouts,
  sameProblemAreaFrameFragmentLayouts,
  sameTextFlowBlockLayouts,
  sameTextFlowBoxFragmentSourceLayouts,
  sameUnitLayouts,
} from "./page-canvas/layout-equality";
import  {
  calculateReserveSpaceGaps,
  measureBoxLayoutSectionSideNotes,
  measureFlowBlocks,
  type LineMeasureCache,
} from "./page-canvas/layout-measure";
import { resolveOverlayBleed } from "./page-canvas/overlay-bleed";
import { formatMm } from "./page-canvas/page-layout-format";
import  {
  detectGapOscillation,
  gapMapSignature,
} from "./page-canvas/pagination-decisions";
import  {
  getCanvasPointerPoint,
  getPageDoubleTapHit,
  getWhiteboardPointerPoint,
  isPageBodyPoint,
  isPageDoubleTap,
  type PageDoubleTapCandidate,
} from "./page-canvas/pointer-model";
import  {
  createBlockCommentAnchor,
  createTextCommentAnchorFromRange,
  getClosestBlockId,
  getContextMenuPosition,
  getOverlaySelectionActionPopoverPosition,
  getOverlaySelectionTargetBlockId,
  getRangeScreenRect,
  getRangeTargetBlockId,
  getSelectionActionPopoverPosition,
  isRangeInsideElement,
  sameSelectionActionPopoverPosition,
  type CommentAnchorPopoverState,
  type OverlaySelectionPopoverMeasurement,
} from "./page-canvas/popover-anchors";

import  {
  getHiddenOptionalProblemAreas,
  getOptionalProblemAreaBlockIdPrefix,
  OPTIONAL_PROBLEM_AREAS,
  resolveProblemAreaTransition,
} from "./page-canvas/problem-area-model";

import  {
  buildRenderUnits,
  getFlowLayoutStyle,
  getFlowUnitStyle,
  getLayoutSectionColumnCount,
  getLayoutSectionColumnGapPx,
  getPageColumnSideNoteOffsetPx,
  getProblemAreaSideNoteOffsetPx,
  getProblemAreaUnitGapKey,
  getSingleColumnProblemLayoutSectionMinHeightMm,
  getTextFlowColumnBlockLayouts,
  pickTextFlowBoxFragmentSourceLayouts,
  pickTextFlowColumnBlockLayouts,
  pickUnitBreakGaps,
  pickUnitCommentThreads,
  reconcileRenderUnits,
} from "./page-canvas/render-units";
import { pageRunningRegionToTextFlowBlocks, replacePageRunningRegionTextFlow } from "./page-canvas/running-region-text-model";
import { computeSingleColumnLayouts, measureSingleColumnLayoutInput } from "./page-canvas/single-column-layout";
export { getBlockPaginationGapCarrier } from "./page-canvas/single-column-layout";
import { SpaceAfterDragSession } from "./page-canvas/space-after-drag-session";
import { waitForSpaceAfterCommitPaint } from "./page-canvas/space-after-commit-paint";
import { resolveSpaceAfterDragPx, resolveSpaceAfterPreviewCohort, type SpaceAfterPreviewCohort } from "./page-canvas/space-after-preview";
import { carryChunkBoundaryState, getChunkBoundaryState, type DocumentChunkBoundaryState } from "./page-canvas/text-run-chunking";
import { assignTextRunGroupIds, type TextRunGroupAssignment } from "./page-canvas/text-run-groups";
import type  {
  EditorBoxBlockFragmentLayout,
  FlowUnitLayout,
  PageMarginDragState,
  PageMarginEdge,
  ProblemAreaColumnLayout,
  ProblemAreaFrameFragmentLayout,
  RenderUnit,
  RunningRegionDragState,
  RunningRegionEdge,
  RunningRegionKind,
} from "./page-canvas/types";
import { useBlockDrag } from "./page-canvas/use-block-drag";
import { publishLayoutSnapshot, type PageLayoutSnapshot } from "./page-canvas/layout-snapshot";
import { isTextFlowMeasurementReady, TEXT_FLOW_MEASUREMENT_READY } from "./text-flow/measurement-revision";
import  {
  createInitialVisiblePageRange,
  getVisiblePageIndexes,
  resolvePageVisibilityWindow,
  sameVisiblePageRange,
  type VisiblePageRange,
} from "./page-canvas/virtualization";
import { getWhiteboardBackgroundStyle } from "./page-canvas/whiteboard-background";
import { WhiteboardBackgroundControl } from "./page-canvas/WhiteboardBackgroundControl";
import type  {
  OverlayActionRequest,
  OverlayActionRequestInput,
  OverlayArrangeAction,
  OverlayChangeOptions,
  OverlayCommandRequest,
  OverlayImageRequest,
  OverlayModeStatus,
  OverlaySelectionSummary,
  OverlaySelectPointRequest,
  PageLayoutChangeOptions,
} from "./page-overlay-types";
import { PageRunningRegionOverlay } from "./PageRunningRegionOverlay";
import  {
  beginBlockSpaceAfterPreview,
  endBlockSpaceAfterPreview,
  registerBlockSpaceAfterPreviewRoot,
  setBlockSpaceAfterPreviewDeltaPx,
} from "./text-flow/block-space-after-preview";

const OverlayCanvasEditor = dynamic(() => import("./OverlayCanvasEditorClient"), {
  ssr: false,
  loading: () => <div className="overlay-canvas-loading" aria-hidden="true" />,
});

const PAGE_DOUBLE_TAP_MS = 450;
const PAGE_DOUBLE_TAP_DISTANCE_PX = 28;
const TEXT_SELECTION_ACTION_DEBOUNCE_MS = 120;
/** Delay before resuming layout measurement after camera movement. */
const WHITEBOARD_ZOOM_SETTLE_MS = 160;
const BODY_MODE_OVERLAY_HIT_MARGIN = 8;
const BODY_MODE_OPEN_STROKE_HIT_MARGIN = 14;
const EMPTY_INLINE_CONTENT_BY_TARGET_ID = new Map<string, readonly PageCanvasInlineContent[]>();
/** 初回描画で「前回のユニット」を指すための固定の空配列。 */
const EMPTY_RENDER_UNITS: readonly RenderUnit[] = [];
const LARGE_PASTE_UNITS_PER_FRAME = 1;
const LARGE_PASTE_PRIORITY_UNIT_RADIUS = 1;
/** Typing in any of these means the key belongs to the field, not to the selected block. */
const BLOCK_SELECTION_KEY_IGNORE_SELECTOR = "input, textarea, select, math-field, [contenteditable='true']";
/** Pressing the handle or its menu is part of the selection, not a click away from it. */
const BLOCK_SELECTION_KEEP_SELECTOR = ".page-block-handle, .page-block-space-handle, .page-context-menu, .problem-context-menu";
/** Overlay targets which manipulate an existing shape selection in overlay mode. */
const OVERLAY_SELECTION_KEEP_SELECTOR = "[data-overlay-shape-id], .overlay-selection-box";
/** The handle tracks the block's height but stays grabbable on one line and never runs a page long. */
const BLOCK_HANDLE_MIN_HEIGHT_PX = 20;
const BLOCK_HANDLE_MAX_HEIGHT_PX = 48;

interface BlockHandleSelection {
  ids: string[];
  boxes: TopLevelBlockBox[];
}

const EMPTY_BLOCK_SELECTION: BlockHandleSelection = { ids: [], boxes: [] };

/** 1 構造あたりの再ページ割りの上限。超えたら最後に採用した gap で固定する。 */
const MAX_PAGINATION_PASSES = 8;

interface ExtensionActionPopoverState {
  action: PageCanvasSelectionAction;
  position: { left: number; top: number };
}

export interface PageCanvasEditorProps {
  document: SigmaDocument;
  selectedId: string | null;
  selectedInlineMath: { id: string; tex: string; blockId?: string } | null;
  commentThreads?: SigmaCommentThread[];
  activeCommentThreadId?: string | null;
  highlightedCommentThreadId?: string | null;
  showComments?: boolean;
  commentPanel?: Omit<CommentThreadsPanelProps, "document" | "candidateTop" | "panelHeight" | "pendingTop" | "threadPositions">;
  overlaySelection: OverlaySelectionSummary;
  overlayCommentAnchor?: SigmaCommentAnchor | null;
  /**
   * 描画されたページ総数が変わったときの通知。
   *
   * 真値は `layoutViewState.pageCount` だけで、EditorShell はこれを持っていない。
   * DOM の `data-page-count` から読み戻すのは派生の逆流なので prop で上げる。
   */
  onPageCountChange?: (pageCount: number) => void;
  /** Reports the current DOM-measured body geometry for destructive paper conversion. */
  onMeasuredBlockRectsChange?: (blockRects: ReadonlyMap<string, MeasuredBlock>) => void;
  /**
   * 本文を覆う面（Word風の Backstage など）が出ている間 true。
   *
   * ここが window の **capture** リスナーなのが効いていて、覆っている側が window
   * capture で stopPropagation() しても、同じ window に付いた別の capture リスナーは
   * 止まらない（止められるのは stopImmediatePropagation だけで、それは他人の
   * リスナーを巻き添えにする）。`inert` も window レベルのリスナーには効かない。
   * したがって EditorShell の handleCommandShortcut / handleInlineShortcut と同じく、
   * フラグを受け取って自分で降りる必要がある。
   */
  shortcutsSuppressed?: boolean;
  /** Optional desktop features composed around the reusable page editor. */
  editorExtensions?: EditorExtensionContextValue;
  /** Optional feature presentation layered into the reusable page editor. */
  pageExtension?: PageCanvasEditorExtension;
  fontSize: number;
  zoom: number;
  whiteboardPanX?: number;
  whiteboardPanY?: number;
  /** 錨の基準になる `.whiteboard-page-canvas` を EditorShell へ渡す。 */
  onWhiteboardViewportChange?: (element: HTMLDivElement | null) => void;
  /** パンは差分で渡す。絶対値だと 1 フレームに複数回動いたとき古い値へ足し込んでしまう。 */
  onWhiteboardPanBy?: (dx: number, dy: number) => void;
  /**
   * 倍率の変更を EditorShell へ委ねる。クランプも錨もあちらの `applyZoom` が持つので、
   * ここでは「いくつにしたいか」だけを渡す (二重にクランプしない)。リボンの ± と同じく
   * 更新関数で渡せるので、再レンダー前に 2 回押しても 1 段ぶん落ちない。
   */
  onWhiteboardZoomRequest?: (nextZoom: number | ((current: number) => number)) => void;
  onWhiteboardCameraReset?: () => void;
  historyRevision: number;
  onSelect: (blockId: string | null) => void;
  onChange: (
    blockId: string,
    updater: (block: SigmaBlock | ProblemAreaBlock) => SigmaBlock | ProblemAreaBlock,
    context?: TextFlowChangeContext,
  ) => void;
  onDelete: (blockId: string) => void;
  /** Removes body blocks wherever they live, without emptying their text first. */
  onDeleteBlocks?: (blockIds: string[]) => void;
  /** Adds an empty paragraph next to a top-level block, or at the end when the anchor is null. */
  onInsertBodyBlock?: (anchorBlockId: string | null, position: "before" | "after") => void;
  /** グリップのドラッグ (Notion 風のブロック移動・段組化)。 */
  onMoveBlocks?: (request: BlockDragMoveRequest) => void;
  /** ⌥⇧↑/↓ で前後の兄弟と入れ替える。 */
  onMoveBlocksByStep?: (unitIds: string[], direction: "up" | "down") => void;
  onCopyBlock: (blockId: string) => void;
  onPasteBlock?: (blockId: string, position: "before" | "after") => void;
  canPasteProblem?: boolean;
  onWrapBlockInColumns?: (blockIds: string[], columnCount: number) => void;
  onUnwrapColumns?: (sectionId: string) => void;
  onResizeLayoutColumns?: (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => void;
  onBlockSpaceAfterChange?: (blockId: string, spaceAfterPx: number) => void;
  onDuplicate: (blockId: string) => void;
  onMove: (blockId: string, direction: "up" | "down") => void;
  onAddProblemBlock: (problemId: string, area: ProblemAreaKind, block: RichBlock) => void;
  onReplaceTextFlow: (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    context?: TextFlowChangeContext,
    options?: TextFlowReplaceOptions,
  ) => void;
  onPageLayoutChange: (layout: PageLayout, options?: PageLayoutChangeOptions) => void;
  onOverlayChange: (overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayImagesRequest: (files: File[], point?: OverlayPoint) => void;
  materials?: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest & { origin: OverlayPoint }) => void;
  onMaterialSaveRequest?: (targetBlockId?: string | null) => void;
  onSelectionMaterialSaveRequest?: (blockIds: string[]) => void;
  onProblemCommand?: (request: TextFlowProblemCommandRequest) => boolean;
  onBodyBlockCommand?: (request: TextFlowBodyBlockCommandRequest) => boolean;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  /** Signals a content deletion so figures anchored to removed blocks can re-anchor and move up. */
  pendingDeletion: { revision: number; deletedIds: string[] } | null;
  /** Persists an automatic re-anchor without adding a separate undo entry (folds into the deletion). */
  onReanchorOverlay: (overlay: PageOverlay) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  onOverlayEditingChange?: (editing: boolean) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
  onRunningRegionEditingChange?: (kind: "header" | "footer" | null) => void;
  onCommentAnchorRequest?: (anchor: SigmaCommentAnchor) => void;
  onCommentAnchorCandidateChange?: (anchor: SigmaCommentAnchor | null) => void;
  onCommentThreadSelect?: (threadId: string) => void;
  suppressSelectionActions?: boolean;
  /**
   * `"paged"` renders the canvas for output rather than for editing: every page is
   * materialized (no windowing) and the editing chrome is suppressed in CSS. The
   * geometry-producing code paths are deliberately untouched, because the PDF is a
   * clone of this DOM — see docs/pdf-parity-architecture.md.
   */
  presentation?: "edit" | "paged";
}

function PageCanvasEditorImpl({
  document,
  selectedId,
  selectedInlineMath,
  commentThreads = [],
  activeCommentThreadId = null,
  highlightedCommentThreadId = null,
  showComments = true,
  commentPanel,
  overlaySelection,
  overlayCommentAnchor = null,
  shortcutsSuppressed = false,
  onPageCountChange,
  onMeasuredBlockRectsChange,
  editorExtensions,
  pageExtension,
  fontSize,
  zoom,
  whiteboardPanX = 0,
  whiteboardPanY = 0,
  onWhiteboardViewportChange,
  onWhiteboardPanBy,
  onWhiteboardZoomRequest,
  onWhiteboardCameraReset,
  historyRevision,
  onSelect,
  onChange,
  onDelete,
  onDeleteBlocks,
  onInsertBodyBlock,
  onMoveBlocks,
  onMoveBlocksByStep,
  onCopyBlock,
  onPasteBlock,
  canPasteProblem = false,
  onWrapBlockInColumns,
  onUnwrapColumns,
  onResizeLayoutColumns,
  onBlockSpaceAfterChange,
  onDuplicate,
  onMove,
  onAddProblemBlock,
  onReplaceTextFlow,
  onPageLayoutChange,
  onOverlayChange,
  onOverlayImagesRequest,
  materials = [],
  onMaterialInsert,
  onMaterialSaveRequest,
  onSelectionMaterialSaveRequest,
  onProblemCommand,
  onBodyBlockCommand,
  onHeadingCommand,
  pendingDeletion,
  onReanchorOverlay,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  onOverlayEditingChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
  onRunningRegionEditingChange,
  onCommentAnchorRequest,
  onCommentAnchorCandidateChange,
  onCommentThreadSelect,
  suppressSelectionActions = false,
  presentation = "edit",
}: PageCanvasEditorProps) {
  const tEditorText = useT("editor");
  const isPagedRender = presentation === "paged";
    countPerformanceEvent("PageCanvasEditor.render");
  const mathFractionSizing = (document.metadata.mathFractionSizing || 'uniform') as "uniform" | "texDefault";
  const pageDocument = useMemo(() => ensurePageLayout(document), [document]);
  // 「いまの本文」を読むだけのコールバックが打鍵のたびに作り直されないよう、内容は ref で渡す。
  // ここを deps に入れると、memo 済みの本文ユニット全部に新しい関数が流れて memo が無効になる。
  const pageContentRef = useRef(pageDocument.content);
  useLayoutEffect(() => {
    pageContentRef.current = pageDocument.content;
  }, [pageDocument.content]);
  const layout = pageDocument.pageLayout!;
  const isWhiteboard = isWhiteboardPageLayout(layout);
  const [textRunDocumentId] = useState(() => createId("text_run_document"));
  const [pageLayoutDraft, setPageLayoutDraft] = useState<PageLayout | null>(null);
  const pageLayoutDraftRef = useRef<PageLayout | null>(null);
  const visibleLayout = pageLayoutDraft ?? layout;
  const overlay = useMemo(() => layout.overlay ?? {}, [layout.overlay]);
  const metrics = useMemo(() => getPageMetrics(visibleLayout), [visibleLayout]);
  const isColumnFlow = metrics.flow.columnCount > 1;
  const problemNumbers = useMemo(() => getProblemNumberMap(pageDocument.content), [pageDocument.content]);
  // 前回のユニット。打鍵のたびに `buildRenderUnits` は新しい配列を作るので、中身が変わって
  // いないユニットは前回のオブジェクトを使い回す (下流の memo が効くのはこれが前提)。
  const previousUnitsRef = useRef<readonly RenderUnit[]>(EMPTY_RENDER_UNITS);
  // 前回のチャンク境界 (= 各本文ユニットの先頭ブロック id)。これを渡すことで、先頭に 1 行
  // 足しただけで以降のユニット id が全部ずれる (= key が変わって作り直される) のを防ぐ。
  // undo で本文が丸ごと戻ったときは、もう存在しないアンカーが落ちるだけで自然に整う。
  // docId を添えるのは、印刷プレビューのステージが同じインスタンスで別の教材を描くため
  // (テンプレート複製の教材はブロック id が一致しうる → 前の教材の境界が効いてしまう)。
  const previousChunksRef = useRef<DocumentChunkBoundaryState | null>(null);
  const [largePasteHydration, setLargePasteHydration] = useState<{
    deferredBlockIds: ReadonlySet<string>;
    hydratedUnitIds: ReadonlySet<string>;
  } | null>(null);
  const largePasteCaretKeeperActiveRef = useRef(false);
  const units = useMemo(
    /* eslint-disable react-hooks/refs -- 前回の描画結果を引き継ぐための読み取り。書き込みは
       下の layout effect でのみ行う (レンダー中に書くと捨てられたレンダーの結果が残る)。 */
    () => {
      const previousUnits = previousChunksRef.current?.docId === pageDocument.docId ? previousUnitsRef.current : EMPTY_RENDER_UNITS;
      const nextUnits = reconcileRenderUnits(
        previousUnits,
        buildRenderUnits(
          pageDocument.content,
          carryChunkBoundaryState(previousChunksRef.current, pageDocument.docId),
          // フォーカス中のユニットの境界は小チャンク併合で動かさない。跨ぎ選択の IME 合成は
          // compositionstart で他ユニットの担当分だけ先に削除するため、前のチャンクが min を
          // 割った併合が合成中のエディタの key を消し、unmount で IME セッションごと落ちる。
          getFocusedTextRunUnitIds(),
          pageDocument.metadata.headingNumbering,
        ),
      );
      return nextUnits;
    },
    /* eslint-enable react-hooks/refs */
    [pageDocument.content, pageDocument.docId, pageDocument.metadata.headingNumbering],
  );
  const textRunGroupByUnitId = useMemo(
    () => assignTextRunGroupIds(units, textRunDocumentId),
    [textRunDocumentId, units],
  );
  /**
   * ブロック id -> そのブロックを持つユニットの文書順。断片の複製は自分が何番目のユニットの
   * 続きなのかを知らないので、ここで渡す (順番が無いと上下移動の行き先になれない)。
   */
  const unitOrderByBlockId = useMemo(() => {
    const orders = new Map<string, number>();
    for (const unit of units) {
      const order = textRunGroupByUnitId.get(unit.id)?.order;
      if (order === undefined || !("blocks" in unit)) {
        continue;
      }
      for (const block of unit.blocks) {
        orders.set(block.id, order);
      }
    }
    return orders;
  }, [textRunGroupByUnitId, units]);
  useLayoutEffect(() => {
    previousUnitsRef.current = units;
    previousChunksRef.current = {
      docId: pageDocument.docId,
      state: getChunkBoundaryState(
        units.flatMap((unit) => unit.type === "textFlow" ? [unit.id] : []),
      ),
    };
  }, [pageDocument.docId, units]);
  const hydrateLargePasteUnits = useCallback((unitIds: readonly string[]) => {
    setLargePasteHydration((current) => {
      if (!current) {
        return current;
      }
      const pendingUnitIds = unitIds.filter((unitId) => !current.hydratedUnitIds.has(unitId));
      if (pendingUnitIds.length === 0) {
        return current;
      }
      countPerformanceEvent("PageCanvasEditor.largePaste.unitHydrated");
      return {
        ...current,
        hydratedUnitIds: new Set([...current.hydratedUnitIds, ...pendingUnitIds]),
      };
    });
  }, [setLargePasteHydration]);
  const hydrateLargePasteUnit = useCallback((unitId: string) => {
    hydrateLargePasteUnits([unitId]);
  }, [hydrateLargePasteUnits]);
  const prioritizeLargePasteCaretUnit = useCallback((blockId: string) => {
    const targetIndex = units.findIndex((unit) => (
      unit.type === "textFlow" && unit.blocks.some((block) => block.id === blockId)
    ));
    if (targetIndex < 0) {
      return;
    }
    const priorityUnitIds = units
      .slice(
        Math.max(0, targetIndex - LARGE_PASTE_PRIORITY_UNIT_RADIUS),
        targetIndex + LARGE_PASTE_PRIORITY_UNIT_RADIUS + 1,
      )
      .flatMap((unit) => unit.type === "textFlow" ? [unit.id] : []);
    hydrateLargePasteUnits(priorityUnitIds);
  }, [hydrateLargePasteUnits, units]);
  useEffect(
    () => subscribeCaretKeeperTarget(prioritizeLargePasteCaretUnit),
    [prioritizeLargePasteCaretUnit],
  );
  useLayoutEffect(() => {
    if (largePasteHydration) {
      requestCaretKeeperReanchor();
    }
  }, [largePasteHydration]);
  useEffect(() => {
    if (!largePasteHydration) {
      return;
    }
    const pendingUnitIds = units.flatMap((unit) => (
      unit.type === "textFlow"
      && !largePasteHydration.hydratedUnitIds.has(unit.id)
      && unit.blocks.every((block) => largePasteHydration.deferredBlockIds.has(block.id))
        ? [unit.id]
        : []
    ));
    const frameId = window.requestAnimationFrame(() => {
      if (pendingUnitIds.length === 0) {
        setLargePasteHydration(null);
        countPerformanceEvent("PageCanvasEditor.largePaste.hydrationComplete");
        return;
      }
      for (const unitId of pendingUnitIds.slice(0, LARGE_PASTE_UNITS_PER_FRAME)) {
        hydrateLargePasteUnit(unitId);
      }
    });
    return () => window.cancelAnimationFrame(frameId);
  }, [hydrateLargePasteUnit, largePasteHydration, units]);
  useEffect(() => {
    if (largePasteHydration !== null || !largePasteCaretKeeperActiveRef.current) {
      return;
    }
    finishCaretKeeperWindow();
  }, [largePasteHydration]);
  useEffect(() => () => {
    if (largePasteCaretKeeperActiveRef.current) {
      largePasteCaretKeeperActiveRef.current = false;
      cancelCaretKeeperWindow();
    }
  }, []);
  const inlineContentByTargetId = pageExtension?.inlineContentByTargetId
    ?? EMPTY_INLINE_CONTENT_BY_TARGET_ID;
  const inlineContentTargetIds = useMemo(
    () => new Set(inlineContentByTargetId.keys()),
    [inlineContentByTargetId],
  );
  const textFlowChangeDecorationState = pageExtension?.textFlowChangeDecorationState;
  const overlayShapeClassNames = pageExtension?.overlayShapeClassNames;
  const resolveOverlayPresentation = pageExtension?.resolveOverlayPresentation;
  const selectionExtension = pageExtension?.selection;
  const [overlayEditing, setOverlayEditing] = useState(false);
  const [bodyOverlayModeStatus, setBodyOverlayModeStatus] = useState<OverlayModeStatus | null>(null);
  const [overlayBackgroundLayerElement, setOverlayBackgroundLayerElement] = useState<HTMLDivElement | null>(null);
  const [shortcutOverlayActionRequest, setShortcutOverlayActionRequest] = useState<OverlayActionRequest | null>(null);
  const [selectPointRequest, setSelectPointRequest] = useState<OverlaySelectPointRequest | null>(null);
  const [extensionTextSelectionPopover, setExtensionTextSelectionPopover] = useState<ExtensionActionPopoverState | null>(null);
  const [extensionSelectedTargetPopover, setExtensionSelectedTargetPopover] = useState<ExtensionActionPopoverState | null>(null);
  const [commentTextSelectionPopover, setCommentTextSelectionPopover] = useState<CommentAnchorPopoverState | null>(null);
  const [commentSelectedTargetPopover, setCommentSelectedTargetPopover] = useState<CommentAnchorPopoverState | null>(null);
  const overlaySelectionKey = overlaySelection.selectedShapeIds.join("\u0000");
  const overlayDestructiveSelectionCountRef = useRef(overlaySelection.selectedCount);
  const [overlaySelectionPopoverMeasurement, setOverlaySelectionPopoverMeasurement] = useState<OverlaySelectionPopoverMeasurement | null>(null);
  const [whiteboardTextRepaint, setWhiteboardTextRepaint] = useState<{
    revision: number;
    bounds: OverlayBounds;
  } | null>(null);
  const [blockAffordance, setBlockAffordance] = useState<BlockAffordanceHover>(EMPTY_BLOCK_AFFORDANCE_HOVER);
  /**
   * 掴んでいる下端つまみ。描画用の state と、ポインタハンドラが読む ref の 2 本立て。
   *
   * **px は state に持たない**。移動量は `block-space-after-preview` のストアが CSS の
   * custom property 1 本として運び、追従するブロックとつまみが transform で読む。ここに
   * 持つと pointermove ごとに 8000 行の紙面が丸ごと再レンダーされる (それが「ポインタに
   * 追いつかず、まとめて瞬間移動する」の直接の原因だった)。掴んだ瞬間に 1 回だけ決まる
   * 追従集合 (cohort) だけを持つ。
   */
  const [spaceAfterDrag, setSpaceAfterDrag] = useState<{
    target: BlockSpaceAfterTarget;
    /** 殻ごと動かすユニット。中のブロックへの印はストア経由で各編集面が付ける。 */
    followerUnitIds: ReadonlySet<string>;
  } | null>(null);
  const spaceAfterSessionRef = useRef(new SpaceAfterDragSession());
  /** 直近にホバー解決した位置。文書が変わった後につまみを置き直すのに使う。 */
  const lastAffordancePointRef = useRef<{ x: number; y: number } | null>(null);
  const lastAffordanceLayoutRevisionRef = useRef(0);
  /** 下余白コミットの再計測予約。通常の本文更新も下の coalesced effect で再計測する。 */
  const spaceAfterHoverRefreshRef = useRef(false);
  // Ids and their measured boxes move together: both are captured when the handle is clicked,
  // so the outline can never point at a block the selection no longer holds.
  const [blockSelection, setBlockSelection] = useState<BlockHandleSelection>(EMPTY_BLOCK_SELECTION);
  const blockSelectionAnchorRef = useRef<string | null>(null);
  const [bodyContextMenu, setBodyContextMenu] = useState<BodyContextMenuState | null>(null);
  const [problemContextMenu, setProblemContextMenu] = useState<ProblemContextMenuState | null>(null);
  const [problemSettingsId, setProblemSettingsId] = useState<string | null>(null);
  const [runningRegionEditKind, setRunningRegionEditKind] = useState<RunningRegionKind | null>(null);
  const [runningRegionEditPageNumber, setRunningRegionEditPageNumber] = useState(1);
  const [runningRegionOverlayEditing, setRunningRegionOverlayEditing] = useState(false);
  const [runningRegionFocusRequest, setRunningRegionFocusRequest] = useState(0);
  const [horizontalMarginEditPageNumber, setHorizontalMarginEditPageNumber] = useState<number | null>(null);
  const [problemAreaHeightDrafts, setProblemAreaHeightDrafts] = useState<Record<string, number>>({});
  const [columnRuleTarget, setColumnRuleTarget] = useState<{ sectionId: string; blockId: string } | null>(null);
  const columnRuleSection = columnRuleTarget ? findBlock(pageDocument, columnRuleTarget.sectionId) : null;
  const requestColumnRuleSettings = useCallback((sectionId: string, blockId: string) => {
    setColumnRuleTarget({ sectionId, blockId });
  }, []);
  const closeColumnRuleSettings = () => {
    setColumnRuleTarget(null);
    if (columnRuleTarget) {
      onSelect(columnRuleTarget.blockId);
      scheduleTextBlockFocus(pageContentRef.current, columnRuleTarget.blockId, "end");
    }
  };
  const requestBoxSettings = useCallback((boxId: string) => {
    window.dispatchEvent(new CustomEvent(REQUEST_BOX_SETTINGS_EVENT, {
      detail: { boxId },
    }));
  }, []);
  const requestBoxTitleEdit = useCallback((boxId: string) => {
    window.dispatchEvent(new CustomEvent(REQUEST_BOX_SETTINGS_EVENT, {
      detail: { boxId, focusTitle: true },
    }));
  }, []);
  const deleteBoxFromContextMenu = useCallback((boxId: string) => {
    onDelete(boxId);
    onSelect(null);
  }, [onDelete, onSelect]);
  const runningRegionDragRef = useRef<RunningRegionDragState | null>(null);
  const problemAreaResizeRef = useRef<ProblemAreaResizeState | null>(null);
  const problemAreaHeightDraftsRef = useRef<Record<string, number>>({});
  const runningRegionContentHeightRef = useRef<Partial<Record<RunningRegionKind, number>>>({});
  const pageMarginDragRef = useRef<PageMarginDragState | null>(null);
  const pageDoubleTapRef = useRef<PageDoubleTapCandidate | null>(null);
  const selectPointRequestIdRef = useRef(0);
  const lastPagePointerPointRef = useRef<OverlayPoint | null>(null);
  const overlayPreviewPointerHandoffRef = useRef<OverlayPreviewPointerHandoff | null>(null);
  const hasOverlayRequest = !!overlayCommandRequest || !!overlayImageRequest || !!overlayActionRequest;
  // ホワイトボードには本文面がない。preview から editor へ押下を引き継ぐのではなく、
  // 常設の編集面が図形と空白の pointer interaction を直接所有する。
  const pageOverlayEditing = isWhiteboard || overlayEditing || (hasOverlayRequest && !runningRegionEditKind);
  const activeRunningRegionOverlayEditing = runningRegionOverlayEditing && !!runningRegionEditKind;
  const isOverlayEditing = pageOverlayEditing || activeRunningRegionOverlayEditing;
  const handleBodyOverlayModeStatusChange = useCallback((status: OverlayModeStatus) => {
    setBodyOverlayModeStatus(status);
    onOverlayModeStatusChange?.(status);
  }, [onOverlayModeStatusChange]);
  useEffect(() => {
    overlayDestructiveSelectionCountRef.current = overlaySelection.selectedCount;
  }, [overlaySelection.selectedCount]);
  const handleOverlaySelectedCountChange = useCallback((count: number) => {
    overlayDestructiveSelectionCountRef.current = count;
  }, []);
  const handleOverlaySelectionSummaryChange = useCallback((summary: OverlaySelectionSummary) => {
    overlayDestructiveSelectionCountRef.current = summary.selectedCount;
    onOverlaySelectionSummaryChange?.(summary);
  }, [onOverlaySelectionSummaryChange]);
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
  const displayedCommentThreads = useMemo(
    () => showComments ? visibleCommentThreads(commentThreads, { activeThreadId: activeCommentThreadId }) : [],
    [activeCommentThreadId, commentThreads, showComments],
  );
  const [commentThreadPositions, setCommentThreadPositions] = useState<Record<string, number>>({});
  const [pendingCommentTop, setPendingCommentTop] = useState<number | null>(null);
  const [candidateCommentTop, setCandidateCommentTop] = useState<number | null>(null);
  const contextMenuProblem = problemContextMenu
    ? findBlock(pageDocument, problemContextMenu.problemId)
    : null;
  const contextMenuProblemNode = contextMenuProblem?.type === "problem" ? contextMenuProblem : null;
  const problemSettingsBlock = problemSettingsId
    ? findBlock(pageDocument, problemSettingsId)
    : null;
  const problemSettingsProblem = problemSettingsBlock?.type === "problem" ? problemSettingsBlock : null;
  const contextMenuHiddenAreas = contextMenuProblemNode ? getHiddenOptionalProblemAreas(contextMenuProblemNode) : [];
  const contextMenuBlock = bodyContextMenu ? findBlock(pageDocument, bodyContextMenu.blockId) : null;
  const activeBodyContextMenu = bodyContextMenu && contextMenuBlock && isBodyContextMenuBlock(contextMenuBlock)
    ? bodyContextMenu
    : null;
  const contextMenuLayoutSection = activeBodyContextMenu
    ? findContainingLayoutSection(pageDocument, activeBodyContextMenu.blockId)
    : null;
  const contextMenuBox = activeBodyContextMenu
    ? findContainingBoxBlock(pageDocument, activeBodyContextMenu.blockId)
    : null;
  const contextMenuLayoutSectionBox = contextMenuLayoutSection
    ? findContainingBoxBlock(pageDocument, contextMenuLayoutSection.id)
    : null;
  const contextMenuBoxLayoutSection =
    contextMenuBox && contextMenuLayoutSectionBox?.id === contextMenuBox.id
      ? contextMenuLayoutSection
      : null;
  const effectiveContextMenuLayoutSection = contextMenuBox
    ? contextMenuBoxLayoutSection
    : contextMenuLayoutSection;
  const canWrapContextMenuBlockInColumns =
    !!activeBodyContextMenu &&
    !!onWrapBlockInColumns &&
    !effectiveContextMenuLayoutSection &&
    !!contextMenuBlock &&
    isColumnWrapTargetBlock(contextMenuBlock) &&
    resolveColumnCommandState(pageDocument, activeBodyContextMenu.blockId).enabled &&
    activeBodyContextMenu.selectionBlockIds.every((blockId) => {
      const block = findBlock(pageDocument, blockId);
      return !!block && isColumnWrapTargetBlock(block)
        && resolveColumnCommandState(pageDocument, blockId).enabled;
    });
  const canEditContextMenuColumns = !!activeBodyContextMenu && !!effectiveContextMenuLayoutSection
    && resolveColumnCommandState(pageDocument, activeBodyContextMenu.blockId).enabled;
  const canInsertContextMenuBreak = !!activeBodyContextMenu
    && canInsertManualBreakAtBlock(pageDocument, activeBodyContextMenu.blockId)
    && canInsertManualPageBreakAfterBlock(pageDocument.content, activeBodyContextMenu.blockId);
  const contextMenuBreaksToColumn = resolveContextMenuBreaksToColumn(isColumnFlow, contextMenuLayoutSection);
  const problemContextMenuLayoutSection = problemContextMenu?.breakBlockId
    ? findContainingLayoutSection(pageDocument, problemContextMenu.breakBlockId)
    : null;
  const problemContextMenuBox = problemContextMenu?.breakBlockId
    ? findContainingBoxBlock(pageDocument, problemContextMenu.breakBlockId)
    : null;
  const problemContextMenuLayoutSectionBox = problemContextMenuLayoutSection
    ? findContainingBoxBlock(pageDocument, problemContextMenuLayoutSection.id)
    : null;
  const problemContextMenuBoxLayoutSection =
    problemContextMenuBox && problemContextMenuLayoutSectionBox?.id === problemContextMenuBox.id
      ? problemContextMenuLayoutSection
      : null;
  const effectiveProblemContextMenuLayoutSection = problemContextMenuBox
    ? problemContextMenuBoxLayoutSection
    : problemContextMenuLayoutSection;
  const canInsertProblemContextMenuBreak = !!problemContextMenu?.breakBlockId
    && canInsertManualBreakAtBlock(pageDocument, problemContextMenu.breakBlockId)
    && canInsertManualPageBreakAfterBlock(pageDocument.content, problemContextMenu.breakBlockId);
  const problemContextMenuBreaksToColumn = resolveContextMenuBreaksToColumn(isColumnFlow, problemContextMenuLayoutSection);
  const problemContextMenuBlock = problemContextMenu?.breakBlockId
    ? findBlock(pageDocument, problemContextMenu.breakBlockId)
    : null;
  const canWrapProblemContextMenuBlockInColumns =
    !!problemContextMenu?.breakBlockId &&
    problemContextMenu.area !== "prompt" &&
    !!onWrapBlockInColumns &&
    !effectiveProblemContextMenuLayoutSection &&
    !!problemContextMenuBlock &&
    isColumnWrapTargetBlock(problemContextMenuBlock) &&
    resolveColumnCommandState(pageDocument, problemContextMenu.breakBlockId).enabled &&
    problemContextMenu.selectionBlockIds.every((blockId) => {
      const block = findBlock(pageDocument, blockId);
      return !!block && isColumnWrapTargetBlock(block)
        && resolveColumnCommandState(pageDocument, blockId).enabled;
    });
  const canEditProblemContextMenuColumns =
    problemContextMenu?.area !== "prompt" &&
    !!problemContextMenu?.breakBlockId &&
    !!effectiveProblemContextMenuLayoutSection
    && resolveColumnCommandState(pageDocument, problemContextMenu.breakBlockId).enabled;

  const marginTopPx = metrics.margins.topPx;
  const pageWidthPx = metrics.page.widthPx;
  const pageHeightPx = metrics.page.heightPx;
  const contentWidthPx = metrics.content.widthPx;
  const contentHeightPx = metrics.content.heightPx;
  const bodyVerticalSnapGuides = useMemo(() => getBodyVerticalSnapGuides(metrics), [metrics]);

  // --- Pagination: measure the continuous flow and place page-break gaps. ---
  const flowRef = useRef<HTMLDivElement | null>(null);
  const [flowElement, setFlowElement] = useState<HTMLDivElement | null>(null);
  const setFlowRef = useCallback((node: HTMLDivElement | null) => {
    flowRef.current = node;
    setFlowElement((current) => current === node ? current : node);
  }, []);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  // Feature layers need the current element reactively; handlers and
  // measurement code continue to use the imperative ref.
  const [canvasElement, setCanvasElement] = useState<HTMLDivElement | null>(null);
  const setCanvasRef = useCallback((node: HTMLDivElement | null) => {
    canvasRef.current = node;
    setCanvasElement((current) => current === node ? current : node);
  }, []);
  const stackRef = useRef<HTMLDivElement | null>(null);
  const [stackElement, setStackElement] = useState<HTMLDivElement | null>(null);
  const extensionPortalRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pageExtension?.portal?.onReady?.(extensionPortalRef.current);
    return () => pageExtension?.portal?.onReady?.(null);
  }, [pageExtension?.portal]);


  // The stack is painted through a transform so that zoom cannot change the layout, and
  // a transform leaves no footprint — the scroll area would be the unscaled size. These
  // publish the stack's own (untransformed) size so `.page-mode` can reserve the scaled
  // space. `offsetWidth`/`offsetHeight` are unaffected by the transform, which is exactly
  // why this needs no knowledge of the stack's padding.
  const setStackRef = useCallback((node: HTMLDivElement | null) => {
    stackRef.current = node;
    setStackElement((current) => current === node ? current : node);
  }, []);

  useEffect(() => {
    const stack = stackElement;
    const mode = stack?.parentElement;
    if (!stack || !mode || typeof ResizeObserver === "undefined") {
      return;
    }
    const publish = () => {
      mode.style.setProperty("--page-stack-natural-height", `${stack.offsetHeight}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [stackElement]);
  const layoutInput = useMemo(() => ({
    documentId: pageDocument.docId, content: pageDocument.content, geometry: metrics, zoom, fontSize,
  }), [pageDocument.docId, pageDocument.content, metrics, zoom, fontSize]);
  const [layoutViewState, setLayoutViewState] = useState<PageLayoutSnapshot>(() => createInitialPageLayoutSnapshot(pageHeightPx));
  const {
    blockRects,
    boxLayoutSectionSideNoteLayouts,
    boxBlockFragmentLayouts,
    boxFragmentSourceLayouts,
    frameFragmentLayouts,
    gaps,
    paginationMarkerLayouts,
    pageCount,
    problemAreaColumnLayouts,
    textFlowBlockLayouts,
    totalHeight,
    unitLayouts,
  } = layoutViewState;
  useLayoutEffect(() => {
    requestCaretKeeperReanchor();
  }, [layoutViewState]);
  // ページ総数の真値はここ (layoutViewState) にしかない。Word風のステータスバーが
  // 「ページ N / M」を出すので上へ通知する。pageCount は数値なので、値が変わった
  // ときだけ発火する (毎レイアウトで呼ばない)。
  useEffect(() => {
    onPageCountChange?.(pageCount);
  }, [onPageCountChange, pageCount]);
  useLayoutEffect(() => {
    onMeasuredBlockRectsChange?.(blockRects);
  }, [blockRects, onMeasuredBlockRectsChange]);
  const {
    flowInlineContentByTargetId,
    columnInlineContentAnchors,
  } = useMemo(() => {
    const flowContent = new Map<string, readonly PageCanvasInlineContent[]>();
    const columnContent: Array<ColumnContentAnchor & {
      targetId: string;
      items: readonly PageCanvasInlineContent[];
    }> = [];

    for (const [targetId, items] of inlineContentByTargetId) {
      const anchor = getColumnContentAnchor(blockRects.get(targetId), metrics.content.widthPx);
      if (!anchor) {
        flowContent.set(targetId, items);
        continue;
      }

      // Extension content inserted as a sibling into a CSS column flow can be
      // laid out at the start of the next column, so host it in page coordinates.
      columnContent.push({ ...anchor, targetId, items });
    }

    return {
      flowInlineContentByTargetId: flowContent,
      columnInlineContentAnchors: columnContent,
    };
  }, [blockRects, inlineContentByTargetId, metrics.content.widthPx]);
  const boxBlocksById = useMemo(() => collectBoxBlocksById(pageDocument.content), [pageDocument.content]);
  // Top-level text blocks (paragraphs, headings, lists) can also be split into
  // clipped fragments when they are taller than a page/column, so their
  // continuation previews need to resolve the source block too.
  const topLevelTextBlocksById = useMemo(() => {
    const map = new Map<string, TextFlowBlock>();
    for (const block of pageDocument.content) {
      if (isTextFlowBlock(block)) {
        map.set(block.id, block);
      }
    }
    return map;
  }, [pageDocument.content]);
  const problemAreaFlowBlocksById = useMemo(() => {
    const map = new Map<string, {
      block: TextFlowBlock;
      problemId: string;
      area: ProblemAreaKind;
    }>();
    for (const unit of units) {
      if (unit.type !== "problemArea") {
        continue;
      }
      for (const block of unit.blocks) {
        map.set(block.id, {
          block,
          problemId: unit.problem.id,
          area: unit.area,
        });
      }
    }
    return map;
  }, [units]);
  const unitTextFlowBlocksById = useMemo(() => {
    const map = new Map<string, TextFlowBlock>();
    for (const unit of units) {
      if (!("blocks" in unit)) {
        continue;
      }
      for (const block of unit.blocks) {
        map.set(block.id, block);
      }
    }
    return map;
  }, [units]);
  const editorBoxBlockFragments = useMemo(
    () => Object.values(boxBlockFragmentLayouts).flat(),
    [boxBlockFragmentLayouts],
  );
  /**
   * 箱の続きプレビューにキャレットを戻すためのブックマーク。
   *
   * **記録は常に ref へ**。プレビューが 1 つも無いときに state を動かすと、誰も読まない値の
   * ために打鍵のたびに紙面全体が再描画される。一方で「箱があふれた最初の打鍵」こそこの機構が
   * 効いてほしい瞬間なので、プレビューが 0→1 になった時点で ref の値を state へ持ち上げる。
   */
  // ページ割りが決めた断片の並びをルーターへ渡す。キャレットの宛先はこの表だけで決まる。
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const unpublish = canvas ? publishLayoutSnapshot(canvas, layoutViewState) : undefined;
    setFragmentTables(layoutViewState.boxFragmentSourceLayouts, layoutViewState.boxBlockFragmentLayouts);
    return unpublish;
  }, [layoutViewState]);
  /**
   * 今この瞬間、断片へ分割されて描かれているブロックの id。
   *
   * 分割されたブロックの見た目 (正本のクリップ・続きの位置と高さ・その下の本文の位置) は
   * **ページ割りの答えそのもの**なので、内容の変化だけを先に描くと「新しい内容 × 古い
   * ページ割り」というどちらでもない状態がそのまま 1〜2 フレーム描かれる。打鍵経路が
   * この集合に触るときだけ、描く前にページ割りを取り直す (`paginateBeforePaintRef`)。
   */
  const fragmentedBlockIdsRef = useRef<ReadonlySet<string>>(new Set());
  useLayoutEffect(() => {
    fragmentedBlockIdsRef.current = new Set(Object.keys(boxFragmentSourceLayouts));
  }, [boxFragmentSourceLayouts]);
  /** 次のレイアウトフェーズで、遅延ではなく同期でページ割りを取り直す予約。 */
  const paginateBeforePaintRef = useRef(false);
  /**
   * この編集が「ページを跨ぎうるブロック」に触るか。
   *
   * - 既に分割されているブロックを含むユニットの編集: どこを打っても分割位置が動く。
   * - 箱の中の編集: まだ分割されていなくても、この打鍵が分割の始まりになりうる。
   *
   * 箱の外の普通の段落はここに入らない (伸びた分だけ下へ動いて終わり、往復が無い)。
   */
  const editTouchesPageSplitBlock = useCallback((
    previousIds: readonly string[],
    nextBlocks: readonly TextFlowBlock[],
    activeBlockId?: string | null,
  ) => {
    const fragmented = fragmentedBlockIdsRef.current;
    if (previousIds.some((id) => fragmented.has(id))) {
      return true;
    }
    if (!activeBlockId) {
      return false;
    }
    return nextBlocks.some((block) => (
      block.type === "boxBlock"
      && (block.id === activeBlockId || bodyTextFlowBlockContainsId(block, activeBlockId))
    ));
  }, []);

  const layoutViewStateRef = useRef(layoutViewState);
  const [scrollVisiblePageRange, setVisiblePageRange] = useState<VisiblePageRange>(
    () => createInitialVisiblePageRange(),
  );
  // Output renders materialize every page: the PDF is cut from this DOM, so a
  // windowed canvas would silently drop pages and every shape anchored to them.
  const visiblePageRange = useMemo<VisiblePageRange>(
    () => (isPagedRender
      ? { start: 0, end: Math.max(0, pageCount - 1), overscan: 0 }
      : scrollVisiblePageRange),
    [isPagedRender, pageCount, scrollVisiblePageRange],
  );
  const overlayRef = useRef(overlay);
  // Block geometry (canvas coords). `latestMeasureRef` is updated on every
  // recompute (including ResizeObserver, between renders); `prevMeasureRef` is
  // snapshotted only in the per-render layout effect, so it still holds the
  // PRE-deletion geometry when a deletion render's re-anchor effect runs.
  const latestMeasureRef = useRef<Map<string, BlockExtent>>(new Map());
  const prevMeasureRef = useRef<Map<string, BlockExtent>>(new Map());
  // Persists intrinsic line-box measurements across recomputes so that only
  // blocks whose size/zoom changed pay the cost of re-measuring (see
  // `measureFlowBlocks`). Survives every keystroke; self-prunes deleted blocks.
  const lineMeasureCacheRef = useRef<LineMeasureCache>(new Map());
  const fontRevisionRef = useRef(0);
  const onReanchorOverlayRef = useRef(onReanchorOverlay);
  const lastHandledDeletionRef = useRef(0);
  const [bleed, setBleed] = useState({ x: 0, top: 0 });
  const previousBleedRef = useRef(bleed);
  const recomputeFrameRef = useRef<number | null>(null);
  /** 直近の gap マップ署名 (最大 4)。往復は隣接 2 パスの比較では見えないので履歴で見る。 */
  const paginationSignatureHistoryRef = useRef<string[]>([]);
  const paginationPassCountRef = useRef(0);
  /** 振動 or パス上限で固定した gap マップ。入力が変わるまでこれを使い続ける。 */
  const frozenPaginationGapsRef = useRef<Record<string, number> | null>(null);
  /** ガードが見ている入力。これが変わったら履歴もパス数も固定も無効になる。 */
  const paginationInputRef = useRef<RenderUnit[] | null>(null);
  /**
   * 次の recompute で測り直す範囲。
   *
   * 打鍵で位置が動くのは打った場所より下だけなので、そのユニット以降だけ測れば足りる。
   * ズーム・余白・フォント・undo のように紙面全体が動く変化は `fullDirty` にする
   * (`resolveMeasureStartUnitId` が知らない id を見つけたときも安全側で全体に倒れる)。
   */
  const dirtyUnitIdsRef = useRef<Set<string>>(new Set());
  const fullMeasureDirtyRef = useRef(true);
  /** 直近に見た紙面の幅。幅が変わったときだけ全ブロックを測り直す。 */
  const flowWidthRef = useRef<number | null>(null);
  /**
   * 前回**成功した**パスの文書全体の計測。測り直さないブロックの出どころ。
   *
   * `docId` を添えるのは、印刷プレビューのステージ (`PagedRenderSurface`) が key 無しで同じ
   * インスタンスに別の教材を流し込むため。そこでは `historyRevision`/`zoom`/`fontSize` が定数で
   * 紙面設定も同じことがあり、構造変化として検出されない — docId を見ないと前の教材の幾何で
   * ページ割りと図形アンカーを解いてしまう (WI-8 のチャンク境界と同じ罠)。
   */
  const previousMeasurementRef = useRef<{
    appliedSpacerSignature: string;
    docId: string;
    marginTopPx: number;
    measurement: FlowMeasurement;
    zoomFactor: number;
  } | null>(null);
  /** 増分計測を続けた回数。誤差の累積を切るために一定回数で全体計測へ戻す。 */
  const incrementalMeasureRunRef = useRef(0);
  /** 前回の計測を採ったときの描画ユニット。並びが変われば汚れの申告が無くても全体を測る。 */
  const unitsAtLastMeasureRef = useRef<readonly RenderUnit[] | null>(null);
  const markFullMeasureDirty = useCallback((reason = "other") => {
    countPerformanceEvent(`PageCanvasEditor.fullDirty.${reason}`);
    fullMeasureDirtyRef.current = true;
  }, []);
  const markUnitMeasureDirty = useCallback((unitId: string | null | undefined) => {
    if (!unitId) {
      countPerformanceEvent("PageCanvasEditor.fullDirty.noUnitId");
      fullMeasureDirtyRef.current = true;
      return;
    }
    dirtyUnitIdsRef.current.add(unitId);
  }, []);
  /** 同期計測が今の幅で測り終えた印。ResizeObserver の初回通知を空振りさせるために使う。 */
  const flowWidthMeasuredBySyncRef = useRef(false);
  const flowResizeObserverRef = useRef<ResizeObserver | null>(null);
  const observedFlowUnitsRef = useRef<Set<Element>>(new Set());
  const pageWindowScrollRef = useRef({ scrollTop: 0, timestamp: 0 });
  /** 観測対象のフローユニットを差分で合わせる。要素の増減以外では何もしない。 */
  const scheduleRecomputeRef = useRef<(updatePrevMeasure?: boolean) => void>(() => {});
  const syncObservedFlowUnits = useCallback(() => {
    const observer = flowResizeObserverRef.current;
    const flow = flowRef.current;
    if (!observer || !flow) {
      return;
    }
    const observed = observedFlowUnitsRef.current;
    const present = new Set<Element>(flow.querySelectorAll("[data-flow-unit-id]"));
    for (const element of present) {
      if (!observed.has(element)) {
        observer.observe(element);
        observed.add(element);
      }
    }
    for (const element of observed) {
      if (!present.has(element)) {
        observer.unobserve(element);
        observed.delete(element);
      }
    }
  }, []);
  const commentLayoutKey = useMemo(() => JSON.stringify({
    candidateAnchor: commentPanel?.candidateAnchor ?? null,
    pendingAnchor: commentPanel?.pendingAnchor ?? null,
    threads: commentPanel?.threads.map((thread) => [thread.id, thread.anchor, thread.resolved]) ?? [],
    totalHeight,
    zoom,
  }), [commentPanel?.candidateAnchor, commentPanel?.pendingAnchor, commentPanel?.threads, totalHeight, zoom]);

  useLayoutEffect(() => {
    if (!showComments || !commentPanel) {
      return;
    }

    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    let frame = 0;
    const updatePositions = () => {
      frame = 0;
      const nextPositions: Record<string, number> = {};
      for (const thread of commentPanel.threads) {
        const top = measureCommentThreadTop(canvas, thread, zoom);
        if (top !== null) {
          nextPositions[thread.id] = top;
        }
      }

      setCommentThreadPositions((current) => sameNumberMap(current, nextPositions) ? current : nextPositions);
      const nextPendingTop = commentPanel.pendingAnchor ? measureCommentAnchorTop(canvas, commentPanel.pendingAnchor, zoom) : null;
      const nextCandidateTop = commentPanel.candidateAnchor ? measureCommentAnchorTop(canvas, commentPanel.candidateAnchor, zoom) : null;
      setPendingCommentTop((current) => sameNullableNumber(current, nextPendingTop) ? current : nextPendingTop);
      setCandidateCommentTop((current) => sameNullableNumber(current, nextCandidateTop) ? current : nextCandidateTop);
    };

    const scheduleUpdate = () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      frame = window.requestAnimationFrame(updatePositions);
    };

    scheduleUpdate();
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    resizeObserver.observe(canvas);
    window.addEventListener("resize", scheduleUpdate);
    window.addEventListener("scroll", scheduleUpdate, true);
    return () => {
      if (frame) {
        window.cancelAnimationFrame(frame);
      }
      resizeObserver.disconnect();
      window.removeEventListener("resize", scheduleUpdate);
      window.removeEventListener("scroll", scheduleUpdate, true);
    };
  }, [commentLayoutKey, commentPanel, showComments, zoom]);

  useLayoutEffect(() => {
    if (!pageOverlayEditing || overlaySelection.selectedCount === 0) {
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
  }, [overlaySelection, overlaySelectionKey, pageOverlayEditing, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY]);

  useLayoutEffect(() => {
    layoutViewStateRef.current = layoutViewState;
  }, [layoutViewState]);

  useLayoutEffect(() => {
    overlayRef.current = overlay;
  }, [overlay]);

  useLayoutEffect(() => {
    onReanchorOverlayRef.current = onReanchorOverlay;
  }, [onReanchorOverlay]);

  // A shape inserted by AI or an importer may omit its body anchor. As soon as
  // the body is measurable (and therefore visible), attach it to nearby text.
  // The anchor line is an overlay control, so this repair never reserves flow
  // height or changes pagination.
  useLayoutEffect(() => {
    const snapshot = overlayRef.current.overlaySnapshot;
    if (isWhiteboard || !snapshot || layoutViewState.blockRects.size === 0) {
      return;
    }

    const normalized = normalizeOverlaySnapshot(snapshot);
    const nextShapes = attachUnanchoredShapesToMeasuredBlocks(
      normalized.shapes,
      Array.from(layoutViewState.blockRects.values()),
      pageHeightPx + PAGE_GAP_PX,
    );
    if (nextShapes === normalized.shapes) {
      return;
    }

    const nextOverlay: PageOverlay = {
      ...overlayRef.current,
      overlaySnapshot: { ...normalized, shapes: nextShapes },
      updatedAt: new Date().toISOString(),
    };
    overlayRef.current = nextOverlay;
    onReanchorOverlayRef.current(nextOverlay);
  }, [isWhiteboard, layoutViewState.blockRects, overlay.overlaySnapshot, pageHeightPx]);

  // When a content block is deleted, re-anchor figures glued to it and move them
  // UP by the deleted content's height (mirror of how a newline pushes them
  // down). Declared ABOVE the recompute layout effect so prevMeasureRef still
  // holds the PRE-deletion geometry; the live DOM here is already reflowed (POST).
  useLayoutEffect(() => {
    if (!pendingDeletion || pendingDeletion.revision === lastHandledDeletionRef.current) {
      return;
    }
    lastHandledDeletionRef.current = pendingDeletion.revision;

    const flow = flowRef.current;
    const snapshot = overlayRef.current.overlaySnapshot;
    if (!flow || !snapshot) {
      return;
    }

    const deleted = new Set(pendingDeletion.deletedIds);
    const normalized = normalizeOverlaySnapshot(snapshot);
    const affected = normalized.shapes.some(
      (shape) => shape.anchor?.type === "block" && deleted.has(shape.anchor.blockId),
    );
    if (!affected) {
      return;
    }

    // Re-anchoring may land on any block a figure could have been anchored to,
    // including ones nested inside a list or a box block — not just the blocks
    // pagination flows between.
    const { anchorable } = measureFlowBlocks(flow, zoom / 100, marginTopPx, lineMeasureCacheRef.current);
    const { shapes: reanchoredShapes, changed } = reanchorAfterDeletion(
      normalized.shapes,
      deleted,
      prevMeasureRef.current,
      anchorable,
    );
    if (!changed) {
      return;
    }
    const nextShapes = resolveShapeAnchorPositions(reanchoredShapes);

    onReanchorOverlayRef.current({
      overlaySnapshot: { ...normalized, shapes: nextShapes },
      updatedAt: new Date().toISOString(),
    });
    // Fire only on a new deletion; zoom/margin are read from the current closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageWidthPx, pendingDeletion]);

  /**
   * `"measured"` — the measurement was adopted.
   * `"skipped"` — the DOM still showed content this render has moved past; nothing was written and
   *               the caller should try again after paint.
   * `"unavailable"` — there was nothing to measure yet (no flow element); retrying changes nothing.
   */
  const recomputeLayout = useCallback((): "measured" | "skipped" | "unavailable" => {
    const flow = flowRef.current;
    if (!flow) {
      return "unavailable";
    }

    const zoomFactor = zoom / 100;
    const pageStride = pageHeightPx + PAGE_GAP_PX;
    const incrementalEligible = canMeasureIncrementally(units, isColumnFlow);
    const measuredAppliedGaps = incrementalEligible ? buildAppliedGapIndex(flow) : null;
    const appliedSpacerSignature = measuredAppliedGaps
      ? gapMapSignature(Object.fromEntries(measuredAppliedGaps.spacerHeightByBlockId))
      : "";

    // 測り直す範囲を決める。前回の計測がそのまま使えるのは「同じズーム・同じ余白で、
    // 汚れたユニットより上」のブロックだけ。
    const carried = previousMeasurementRef.current;
    const reusablePrevious = carried
      && carried.docId === pageDocument.docId
      && carried.zoomFactor === zoomFactor
      && carried.marginTopPx === marginTopPx
      // Spacers can commit before ResizeObserver marks their unit dirty. Mixing
      // cached block tops with the new DOM gaps makes natural positions depend
      // on the previous pagination output, sometimes suppressing manual breaks.
      && carried.appliedSpacerSignature === appliedSpacerSignature
      // 増分は「前回との差」を見るので、持ち越した値の誤差 (1px 未満の丸め) がそのまま次の
      // 基準になる。一定回数ごとに全部測り直して、累積を切る。
      && incrementalMeasureRunRef.current < MAX_CONSECUTIVE_INCREMENTAL_MEASURES
      ? carried.measurement
      : null;
    // Acknowledge the exact content revision, rather than adopting a stale
    // measurement after an arbitrary number of retries. Completion is event driven.
    if (!isTextFlowMeasurementReady(flow)) return "skipped";
    const scope = resolveMeasureScope({
      dirtyUnitIds: dirtyUnitIdsRef.current,
      fullDirty: fullMeasureDirtyRef.current,
      hasPrevious: reusablePrevious !== null,
      incrementalEligible,
      unitsChangedSinceMeasure: unitsAtLastMeasureRef.current !== units,
      units,
    });
    countPerformanceEvent(`PageCanvasEditor.measure.${scope.kind}`);
    const measurement = measurePerformance(
      "PageCanvasEditor.measureFlowBlocks",
      () => measureFlowBlocks(flow, zoomFactor, marginTopPx, lineMeasureCacheRef.current, {
        scope,
        previous: reusablePrevious,
      }),
    );
    const { anchorable, rects: blockCanvasRects, extents } = measurement;

    latestMeasureRef.current = extents;
    // 採用したパスだけが「次に持ち越せる計測」になる。ここより後で捨てるパス (ページ割りの
    // 振動ガードによる `skipped`) は、この時点の計測自体は実際に採ったものなので持ち越して
    // よい。捨てたのはページ割りの答えであって幾何ではない。
    previousMeasurementRef.current = { appliedSpacerSignature, docId: pageDocument.docId, marginTopPx, measurement, zoomFactor };
    unitsAtLastMeasureRef.current = units;
    incrementalMeasureRunRef.current = scope.kind === "all" ? 0 : incrementalMeasureRunRef.current + 1;
    fullMeasureDirtyRef.current = false;
    dirtyUnitIdsRef.current = new Set();
    const normalizedOverlaySnapshot = overlayRef.current.overlaySnapshot
      ? normalizeOverlaySnapshot(overlayRef.current.overlaySnapshot)
      : null;
    const reserveSpaceGaps = calculateReserveSpaceGaps(normalizedOverlaySnapshot?.shapes ?? []);

    let textPageCount = 1;
    let nextGaps = layoutViewStateRef.current.gaps;
    let nextLayouts: Record<string, FlowUnitLayout> = {};
    let nextBlockLayouts: Record<string, TextFlowColumnBlockLayout> = {};
    let nextBoxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]> = {};
    let nextBoxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout> = {};
    let nextFrameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]> = {};
    let nextMarkerLayouts: Record<string, FlowUnitLayout> = {};
    let nextAreaLayouts: Record<string, ProblemAreaColumnLayout> = {};

    if (isColumnFlow) {
      const columnLayouts = measurePerformance(
        "PageCanvasEditor.computeColumnUnitLayouts",
        () => computeColumnUnitLayouts(
          flow,
          units,
          metrics,
          pageHeightPx,
          PAGE_GAP_PX,
          zoomFactor,
          reserveSpaceGaps,
        ),
      );
      nextLayouts = columnLayouts.layouts;
      nextBlockLayouts = columnLayouts.blockLayouts;
      nextBoxBlockFragmentLayouts = columnLayouts.boxBlockFragmentLayouts;
      nextBoxFragmentSourceLayouts = columnLayouts.boxFragmentSourceLayouts;
      nextFrameFragmentLayouts = columnLayouts.frameFragmentLayouts;
      nextMarkerLayouts = columnLayouts.markerLayouts;
      nextAreaLayouts = columnLayouts.nestedColumnLayouts;
      nextGaps = {};
      textPageCount = columnLayouts.pageCount;
    } else {
      const singleColumnInput = measureSingleColumnLayoutInput({
        content: pageDocument.content,
        flow,
        units,
        metrics,
        pageHeightPx,
        pageStride,
        zoomFactor,
        marginTopPx,
        contentHeightPx,
        reserveSpaceGaps,
        measurement,
        measuredAppliedGaps,
      });

      // DOM から読んだ「今そこにある gap」と state の gap が食い違うパスは、まだ描画が
      // コミットに追いついていない。ここで採用すると 2 つの出典が混ざり、同じ文書に
      // 自己整合なレイアウトが 2 つできる (2px / 1 ページのずれ)。捨てて次のパスに任せる —
      // 既存の staleMeasurementSkipped と同型で、別カウンタ・別上限。
      // 「DOM の gap と state の gap が食い違うパスを捨てる」案 (spec の (c)) は入れていない。
      // 判定の入力である `topNat` は既に **DOM から読んだ** 適用済み gap だけで作られており、
      // state と混ざる余地が無い ＝ 捨てる理由が無い。実測では捨てる側の害だけが出た:
      // 最後のパスが捨てられるとページ割りが古いまま残り (continuous-pagination が落ちる)、
      // 捨てたぶんを自分で再予約すると recompute が 60Hz で回り続けた (アイドル 3 秒で 181 回)。

      // 固定中は「gap だけ前の答え・レイアウトは今の答え」という混ざり方を避けるため、
      // パスごと捨てる。固定は入力か構造が変わった時点で解除される。
      if (frozenPaginationGapsRef.current && paginationInputRef.current === units) {
        return "skipped";
      }

      const singleColumnLayouts = computeSingleColumnLayouts(singleColumnInput);
      nextBoxBlockFragmentLayouts = singleColumnLayouts.boxBlockFragmentLayouts;
      nextBoxFragmentSourceLayouts = singleColumnLayouts.boxFragmentSourceLayouts;
      nextFrameFragmentLayouts = singleColumnLayouts.frameFragmentLayouts;
      nextAreaLayouts = singleColumnLayouts.areaLayouts;

      nextGaps = singleColumnLayouts.gaps;
      // ガードは「同じ入力が違う答えを出し続ける」ことだけを見る。入力 (= 本文の構成) が
      // 変われば署名が変わるのは当たり前なので、履歴もパス数も固定もここで捨てる。
      // これが無いと、打鍵し続けるだけでパス上限に達し、gap が空のまま凍る。
      if (paginationInputRef.current !== units) {
        paginationInputRef.current = units;
        paginationSignatureHistoryRef.current = [];
        paginationPassCountRef.current = 0;
        frozenPaginationGapsRef.current = null;
      }
      // 不動点ガード。決定規則を gap-free 入力に固定してもなお往復する入力が残り得るので、
      // 署名の履歴で往復を検出したら「最初に現れた側」= 直前に採用した gap で固定する。
      // 固定は構造が変わるまで続く (下の layout effect で履歴ごとクリアする)。
      {
        // 読み戻しが state と食い違っていたパスは「DOM がまだ追いついていない」だけで、
        // 往復の証拠にはならない。証拠を汚すと、普通に打鍵しているだけで振動と誤判定して
        // gap を凍らせてしまう (実測: 60 行入力で誤発火し、改ページの spacer が消えた)。
        const signature = gapMapSignature(nextGaps);
        const verdict = detectGapOscillation(paginationSignatureHistoryRef.current, signature);
        // 収束したパスは「回り続けている」証拠にならない。数えると、画像やフォントが
        // 落ち着くたびに走る外部トリガだけで上限に達し、既に安定したレイアウトを凍らせる。
        paginationPassCountRef.current = verdict === "stable" ? 0 : paginationPassCountRef.current + 1;
        if (verdict === "oscillating" || paginationPassCountRef.current > MAX_PAGINATION_PASSES) {
          countPerformanceEvent("PageCanvasEditor.paginationOscillation");
          // 直前に採用した状態 (gap もレイアウトもページ数も同じパス由来) をそのまま残す。
          frozenPaginationGapsRef.current = layoutViewStateRef.current.gaps;
          return "skipped";
        }
        paginationSignatureHistoryRef.current = [
          ...paginationSignatureHistoryRef.current.slice(-3),
          signature,
        ];
      }
      textPageCount = singleColumnLayouts.pageCount;
    }

    const nextBoxLayoutSectionSideNoteLayouts = measureBoxLayoutSectionSideNotes(
      flow,
      zoomFactor,
      nextBoxFragmentSourceLayouts,
    );

    // The page count must also cover overlay figures, which can sit below the
    // last text block (or on a page that has no text at all). Without this a
    // figure-only region would have no backing sheet and get clipped away.
    // ページ数もはみ出し量も同じ「解決済み図形」から出る。以前は同じ引数で
    // `resolveShapesPosition` を 2 回呼んでいて、図形の多い文書では recompute の
    // 定数倍がそのまま倍になっていた。
    let maxShapeBottom = 0;
    // Calculate overflow for out-of-page shapes. Horizontal bleed is applied
    // symmetrically so the centered page never shifts beneath the pointer.
    let minShapeLeft = 0;
    let minShapeTop = 0;
    let maxShapeRight = 0;
    if (normalizedOverlaySnapshot) {
      const resolved = resolveShapesPosition(normalizedOverlaySnapshot.shapes, blockCanvasRects, reserveSpaceGaps);
      for (const shape of resolved) {
        if (shape.hidden) {
          continue;
        }
        const bounds = getShapeBounds(shape);
        maxShapeBottom = Math.max(maxShapeBottom, bounds.y + bounds.h);
        if (bounds.x < 0) {
          minShapeLeft = Math.min(minShapeLeft, bounds.x);
        }
        if (bounds.y < 0) {
          minShapeTop = Math.min(minShapeTop, bounds.y);
        }
        const shapeRight = bounds.x + bounds.w;
        if (shapeRight > pageWidthPx) {
          maxShapeRight = Math.max(maxShapeRight, shapeRight - pageWidthPx);
        }
      }
    }
    const nextBleed = resolveOverlayBleed({
      left: -minShapeLeft,
      right: maxShapeRight,
      top: -minShapeTop,
    });
    setBleed((current) => (
      current.x === nextBleed.x && current.top === nextBleed.top
        ? current
        : nextBleed
    ));

    const shapePageCount = maxShapeBottom > pageHeightPx
      ? Math.ceil((maxShapeBottom - pageHeightPx) / pageStride) + 1
      : 1;
    const nextPageCount = Math.max(textPageCount, shapePageCount);

    const nextTotalHeight = (nextPageCount - 1) * pageStride + pageHeightPx;
    setLayoutViewState((current) => {
      if (
        current.input === layoutInput &&
        current.fontRevision === fontRevisionRef.current &&
        current.pageCount === nextPageCount &&
        current.totalHeight === nextTotalHeight &&
        sameUnitLayouts(current.boxLayoutSectionSideNoteLayouts, nextBoxLayoutSectionSideNoteLayouts) &&
        sameEditorBoxBlockFragmentLayouts(current.boxBlockFragmentLayouts, nextBoxBlockFragmentLayouts) &&
        sameTextFlowBoxFragmentSourceLayouts(current.boxFragmentSourceLayouts, nextBoxFragmentSourceLayouts) &&
        sameProblemAreaFrameFragmentLayouts(current.frameFragmentLayouts, nextFrameFragmentLayouts) &&
        sameGapMap(current.gaps, nextGaps) &&
        sameUnitLayouts(current.unitLayouts, nextLayouts) &&
        sameTextFlowBlockLayouts(current.textFlowBlockLayouts, nextBlockLayouts) &&
        sameUnitLayouts(current.paginationMarkerLayouts, nextMarkerLayouts) &&
        sameProblemAreaColumnLayouts(current.problemAreaColumnLayouts, nextAreaLayouts) &&
        sameMeasuredBlockMap(current.blockRects, blockCanvasRects) &&
        sameBlockExtentMap(current.blockExtents, extents)
      ) {
        return current;
      }

      const next: PageLayoutSnapshot = {
        input: layoutInput,
        fontRevision: fontRevisionRef.current,
        blockAnchorable: anchorable,
        blockExtents: extents,
        blockRects: blockCanvasRects,
        boxLayoutSectionSideNoteLayouts: nextBoxLayoutSectionSideNoteLayouts,
        boxBlockFragmentLayouts: nextBoxBlockFragmentLayouts,
        boxFragmentSourceLayouts: nextBoxFragmentSourceLayouts,
        frameFragmentLayouts: nextFrameFragmentLayouts,
        gaps: nextGaps,
        paginationMarkerLayouts: nextMarkerLayouts,
        pageCount: nextPageCount,
        problemAreaColumnLayouts: nextAreaLayouts,
        revision: current.revision + 1,
        textFlowBlockLayouts: nextBlockLayouts,
        totalHeight: nextTotalHeight,
        unitLayouts: nextLayouts,
      };
      layoutViewStateRef.current = next;
      return next;
    });
    return "measured";
  }, [layoutInput, zoom, marginTopPx, pageHeightPx, contentHeightPx, isColumnFlow, metrics, units, pageDocument.content, pageDocument.docId, pageWidthPx]);

  // 再ページ割り 1 回ぶんの実測。打鍵ごとに rAF で走るので、ここが 1 フレームを超えると
  // そのまま入力の詰まりになる (perf-probe の typing フェーズがこの measure を見る)。
  const recompute = useCallback(
    (): "measured" | "skipped" | "unavailable" =>
      measurePerformance("PageCanvasEditor.recompute", recomputeLayout),
    [recomputeLayout],
  );
  // A queued frame can outlive a zoom/document commit. It must measure the DOM
  // with that commit's inputs, never the scale/content captured when scheduled.
  const recomputeRef = useRef(recompute);
  useLayoutEffect(() => {
    recomputeRef.current = recompute;
  }, [recompute]);


  useLayoutEffect(() => {
    const previousBleed = previousBleedRef.current;
    previousBleedRef.current = bleed;

    const canvas = canvasRef.current;
    const scroller = canvas?.closest<HTMLElement>(".editor-canvas");
    if (!canvas || !scroller) {
      return;
    }

    const parsedZoom = Number.parseFloat(
      getComputedStyle(canvas).getPropertyValue("--editor-zoom"),
    );
    const zoomScale = Number.isFinite(parsedZoom) ? parsedZoom : 1;
    const dX = bleed.x - previousBleed.x;
    const dTop = bleed.top - previousBleed.top;

    if (scroller.scrollWidth > scroller.clientWidth) {
      scroller.scrollLeft = Math.max(0, scroller.scrollLeft + dX * zoomScale);
    }
    scroller.scrollTop = Math.max(0, scroller.scrollTop + dTop * zoomScale);
  }, [bleed]);

  // `--editor-zoom` scales the page stack with a transform, so nothing downstream is re-laid out
  // and `ResizeObserver` stays silent. Canvases that must match the painted resolution (the live
  // 3D view) learn about the new scale here.
  useEffect(() => {
    globalThis.dispatchEvent?.(new CustomEvent(EDITOR_ZOOM_CHANGE_EVENT, { detail: { zoom } }));
  }, [zoom]);

  const scheduleRecompute = useCallback((updatePrevMeasure = false) => {
    // 予約の「性格」は凍結の前に記録する。ここを後回しにすると、凍結中に来た打鍵経路の
    // 予約 (updatePrevMeasure = true) が握り潰され、解凍後の計測で `prevMeasureRef` が
    // 更新されない = 削除レンダーのアンカー再解決が古い baseline を見る。
    // 下端つまみを掴んでいる間はページ割りを凍らせる。プレビューは平行移動なので寸法は
    // 変わらず ResizeObserver は鳴らないが、フォントの遅延ロードのような外因はここへ来る。
    // ドラッグ中に答えが変わると、後続ブロックが「別のページへ一気に移る」ように見える。
    if (!spaceAfterSessionRef.current.requestRecompute(updatePrevMeasure)) return;
    if (recomputeFrameRef.current !== null) {
      window.cancelAnimationFrame(recomputeFrameRef.current);
    }
    recomputeFrameRef.current = window.requestAnimationFrame(() => {
      recomputeFrameRef.current = null;
      countPerformanceEvent("PageCanvasEditor.deferredRecompute");
      // A skipped (stale) measurement leaves the baseline alone too — updating it from a
      // measurement we refused to adopt would drift every anchored shape. No retry is scheduled
      // from here: the render that made the measurement stale commits its own layout effect.
      // The pending flag is cleared either way, so it cannot leak into a later ResizeObserver or
      // fonts.ready run — those must never touch `prevMeasureRef`.
      if (spaceAfterSessionRef.current.consumeBaselineRefresh(recomputeRef.current() === "measured")) {
        prevMeasureRef.current = latestMeasureRef.current;
      }
    });
  }, []);
  useLayoutEffect(() => {
    scheduleRecomputeRef.current = scheduleRecompute;
  }, [scheduleRecompute]);

  useEffect(() => {
    if (!flowElement) return;
    const onReady = (event: Event) => {
      const unitId = event.target instanceof HTMLElement
        ? event.target.closest<HTMLElement>("[data-flow-unit-id]")?.dataset.flowUnitId : undefined;
      markUnitMeasureDirty(unitId);
      scheduleRecomputeRef.current();
    };
    flowElement.addEventListener(TEXT_FLOW_MEASUREMENT_READY, onReady);
    return () => flowElement.removeEventListener(TEXT_FLOW_MEASUREMENT_READY, onReady);
  }, [flowElement, markUnitMeasureDirty]);

  /**
   * ドラッグ中に凍らせていた再計測を解く。
   *
   * `force` はコミットした側で立てる — 確定した余白は実際に紙面の寸法を変えるので、
   * 凍結中に予約が来ていなくても必ず 1 回測り直す。
   */
  const thawSpaceAfterRecompute = useCallback((force = false) => {
    if (!spaceAfterSessionRef.current.resumeRecompute(force)) return;
    markFullMeasureDirty("spaceAfterDragEnd");
    scheduleRecomputeRef.current();
  }, [markFullMeasureDirty]);

  /**
   * 下端つまみのプレビューを即座に畳んで元へ戻す。文書には **書かない**。
   *
   * Escape・pointercancel (別ウィンドウへ移った / タッチのキャンセル)・アンマウントの受け口。
   * pointercancel にコミット側 (`handlePointerUp`) を貼っていた頃は、キャンセルが確定に
   * なっていた。
   */
  const cancelBlockSpaceAfterDrag = useCallback(() => {
    spaceAfterSessionRef.current.cancel();
    endBlockSpaceAfterPreview();
    setSpaceAfterDrag(null);
    thawSpaceAfterRecompute();
  }, [thawSpaceAfterRecompute]);
  const cancelBlockSpaceAfterDragRef = useRef(cancelBlockSpaceAfterDrag);
  useLayoutEffect(() => {
    cancelBlockSpaceAfterDragRef.current = cancelBlockSpaceAfterDrag;
  }, [cancelBlockSpaceAfterDrag]);

  /**
   * 確定した余白が本文の面に **乗ったその瞬間** にプレビューを外す。
   *
   * コミットは React の props を通って ProseMirror の面まで運ばれるが、面がノードの
   * `--sigma-doc-space-after` を書き戻すのは commit のレイアウトフェーズより後 (実測で
   * 1 フレーム遅れる)。継ぎ目で描かれてはいけない中間状態が 2 つある:
   *
   * - 早すぎる解除 → 「余白 0 × 平行移動なし」= ドラッグ前の位置へ 1 フレーム戻る。
   * - 遅すぎる解除 → 「余白あり × 平行移動あり」= 2 倍下がったフレームが 1 枚出る。
   *
   * どちらも避けるには、**余白が DOM に書かれたのと同じ描画前のタイミング**で外すしかない。
   * MutationObserver のコールバックは書き換えた task の直後 (microtask) に走り、そのフレーム
   * の描画より前なので、そこで外せば、どちらの中間状態も一度も描かれない。rAF 側は
   * 保険 (コミットが弾かれた / 面が無い) の打ち切りだけを担う。
   */
  const releaseSpaceAfterPreviewWhenPainted = useCallback(() => {
    waitForSpaceAfterCommitPaint(spaceAfterSessionRef.current, {
      getCanvas: () => canvasRef.current,
      getFlow: () => flowRef.current,
      onFinished: (owned, painted) => {
        if (painted) {
          // つまみは「動かしている辺」そのもの。ホバーの取り直し (次のポインタ移動) を待つと、
          // 1 フレームだけ元の下端へ跳ね返って見える。
          //
          // 足すのは **まだドラッグ前の下端を指しているとき だけ**。待っている間にホバーが
          // 取り直されていれば、その値は既に確定後の下端なので、そこへさらに足すとつまみが
          // 2 倍下に residual として残る。
          setBlockAffordance((current) => (
            current.spaceAfter?.blockId === owned.blockId
            && Math.abs(current.spaceAfter.bottom - owned.bottomBefore) < 0.5
              ? {
                ...current,
                spaceAfter: {
                  ...current.spaceAfter,
                  bottom: current.spaceAfter.bottom + owned.deltaPx,
                  spaceAfterPx: owned.px,
                },
              }
              : current
          ));
        }
        endBlockSpaceAfterPreview();
        setSpaceAfterDrag(null);
        // 確定ぶんは寸法を変えたので、凍結を解いて測り直す。
        thawSpaceAfterRecompute(true);
      },
    });
  }, [thawSpaceAfterRecompute]);
  const releaseSpaceAfterPreviewWhenPaintedRef = useRef(releaseSpaceAfterPreviewWhenPainted);
  useLayoutEffect(() => {
    releaseSpaceAfterPreviewWhenPaintedRef.current = releaseSpaceAfterPreviewWhenPainted;
  }, [releaseSpaceAfterPreviewWhenPainted]);

  // Tracks the layout-structural inputs from the previous render so we can tell
  // a pure text edit (typing) apart from a change that reshapes the page.
  const structuralRecomputeDepsRef = useRef<{
    metrics: typeof metrics;
    zoom: number;
    fontSize: number;
    historyRevision: number;
    overlay: PageOverlay | undefined;
  } | null>(null);

  useLayoutEffect(() => {
    // 予約はこのフェーズで必ず使い切る。持ち越すと、無関係な次のレンダーが同期計測を背負う。
    const paginateBeforePaint = paginateBeforePaintRef.current;
    paginateBeforePaintRef.current = false;
    const previous = structuralRecomputeDepsRef.current;
    const structuralChanged =
      !previous ||
      !samePageMetrics(previous.metrics, metrics) ||
      previous.zoom !== zoom ||
      previous.fontSize !== fontSize ||
      previous.historyRevision !== historyRevision ||
      previous.overlay !== document.pageLayout?.overlay;
    structuralRecomputeDepsRef.current = {
      metrics,
      zoom,
      fontSize,
      historyRevision,
      overlay: document.pageLayout?.overlay,
    };

    if (structuralChanged) {
      // 掴んだままズーム・余白・用紙・フォント・undo が動いた。ドラッグの起点 (px と拡大率) は
      // pointerdown で固定しているので、続行すると換算が合わない値をコミットしてしまう。
      // 可逆な側 = 破棄に倒す。
      if (spaceAfterSessionRef.current.isFrozen) {
        cancelBlockSpaceAfterDragRef.current();
      }
      // 構造 (ズーム・余白・フォント・undo) が変われば前の署名列は無意味になる。
      paginationInputRef.current = null;
      paginationSignatureHistoryRef.current = [];
      paginationPassCountRef.current = 0;
      frozenPaginationGapsRef.current = null;
      // First mount or a layout-reshaping change (zoom, margins/page size, font,
      // undo/redo, overlay): recompute synchronously before paint so the page
      // doesn't flash an un-paginated frame.
      countPerformanceEvent("PageCanvasEditor.syncRecompute");
      // 紙面を作り直す変化 (ズーム・余白・用紙・フォント・undo/redo・図形) では前回の
      // 計測を持ち越さない。
      markFullMeasureDirty("structural");
      lineMeasureCacheRef.current.clear();
      if (recompute() !== "measured") {
        // Nothing was adopted, so the baseline must not move either — updating it from a
        // measurement we refused would drift every anchored shape.
        //
        // No retry is scheduled from here on purpose: an extra deferred pass lands in whatever
        // transient the page is in and paints a layout that matches neither the before nor the
        // after state (observed in the two-column fixture). The next render's layout effect and
        // the ResizeObserver both recompute anyway, which is how this recovered before the guard.
        return;
      }
      // Snapshot THIS render's measurement as the pre-deletion baseline. Only the
      // per-render layout effect updates prevMeasureRef (recompute alone, e.g. via
      // ResizeObserver between renders, must not), so on a deletion render the
      // re-anchor effect (declared above) still sees the prior render's geometry.
      prevMeasureRef.current = latestMeasureRef.current;
      // ResizeObserver の初回通知は「今の幅」を報告するだけで、この同期計測が既にその幅で
      // 測り終えている。印を立てておかないと、開くたびに全体計測がもう 1 回走る。
      //
      // 幅の数値をここで先に入れることはできない: ResizeObserver が渡すのは content box、
      // `getBoundingClientRect()` は border box で、`.page-flow` は padding を持つので
      // 値が一致しない (実測で不一致のまま全体計測が走っていた)。初回だけ「記録はするが
      // 汚さない」と決める。
      //
      // 印を立てるのは **実際に採用できたときだけ**。上の early return (採用しなかった場合)
      // では ResizeObserver が復旧経路として働くことを当てにしているので、そこは塞がない。
      flowWidthMeasuredBySyncRef.current = true;
    } else if (paginateBeforePaint && recompute() === "measured") {
      // 分割されたブロックに触った打鍵。ここだけは描く前にページ割りを取り直す。
      //
      // 遅延させると「新しい内容 × 古いページ割り」が 1〜2 フレーム描かれる: 箱がページ
      // 下端をはみ出し、その下の本文が 1 行ぶん下がってから戻り、キャレットも 1 行だけ
      // 跳ねる。普通のブロックにはこの往復が無い (伸びた分だけ下へ動いて終わる) ので、
      // 「箱の外と同じ挙動」にするにはここを揃えるしかない。undo/redo の同期計測
      // (上の structural 分岐) と同じ手で、同じ理由。
      //
      // 計測が採用されなかったときは従来どおり遅延パスへ落ちる (下の else と同じ)。
      countPerformanceEvent("PageCanvasEditor.fragmentSyncRecompute");
      prevMeasureRef.current = latestMeasureRef.current;
    } else {
      // Pure content edit (typing): let the keystroke paint immediately and bring
      // pagination up to date just after, coalescing rapid keystrokes into one
      // recompute per frame. The deferred run refreshes prevMeasureRef itself.
      scheduleRecompute(true);
    }
  }, [document.pageLayout?.overlay, fontSize, historyRevision, markFullMeasureDirty, metrics, recompute, scheduleRecompute, units, zoom]);

  // Webfonts land after the first layout and shift blocks by a pixel or two. That does
  // not always change the flow's own size, so the ResizeObserver below can miss it — and
  // the block rects captured before it stay in use, leaving anchored shapes resolved
  // against positions the text no longer occupies.
  useEffect(() => {
    // `document` is the SigmaDocument prop in this component — reach the DOM explicitly.
    const fonts = typeof window === "undefined" ? undefined : window.document.fonts;
    if (!fonts) {
      return;
    }
    let cancelled = false;
    // フォントが載ると紙面全体が数 px ずれる。ユニットの高さが変わらない差し替え (グリフの
    // 位置だけ動く) は ResizeObserver では拾えないので、ここで全体計測に倒す。
    const remeasure = () => {
      if (cancelled) {
        return;
      }
      // A previously registered font can finish loading without changing size.
      // Repeated notifications coalesce in scheduleRecompute, not by font count.
      fontRevisionRef.current += 1;
      lineMeasureCacheRef.current.clear();
      markFullMeasureDirty();
      // `scheduleRecompute` は打鍵のたびに identity が変わるので ref 越しに呼ぶ。deps に
      // 入れるとこの effect が毎打鍵で貼り直され、解決済みの `fonts.ready` が毎回 then を
      // 走らせて「全体を測り直せ」が立ちっぱなしになる (増分計測が一度も効かない)。
      scheduleRecomputeRef.current();
    };
    void fonts.ready.then(remeasure).catch(() => undefined);
    // `fonts.ready` は読み込みが再開すると別の promise に差し替わる。後から要求される字体
    // (数式フォント等) を取りこぼさないよう、完了イベントも購読しておく。
    fonts.addEventListener?.("loadingdone", remeasure);
    return () => {
      cancelled = true;
      fonts.removeEventListener?.("loadingdone", remeasure);
    };
  }, [markFullMeasureDirty]);

  // ResizeObserver は 1 個だけ作って使い回す。`units` を deps に入れていたときは打鍵の
  // たびに disconnect → 再生成 → 全ユニット再 observe が走っていた。
  useEffect(() => {
    if (!flowElement || typeof ResizeObserver === "undefined") {
      return;
    }
    // コールバックは ref 越しに呼ぶ。`scheduleRecompute` は打鍵のたびに identity が
    // 変わるので、deps に入れると observer ごと作り直しになり「1 個に固定する」意味が消える。
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const target = entry.target;
        if (target === flowElement || !(target instanceof HTMLElement)) {
          // 紙面の**幅**が変われば行が折り返し直るので全ブロックを測り直す。高さだけの変化は
          // 「下の内容が動いた結果」であって原因ではない — その原因 (打鍵・ユニットの伸縮) は
          // 別途 dirty に入っているので、ここで全体に倒すと増分計測が毎回無効になる。
          const width = entry.contentRect.width;
          if (flowWidthRef.current === null && flowWidthMeasuredBySyncRef.current) {
            // 初回通知。直前の同期計測がこの幅で測り終えているので、記録だけして汚さない。
            flowWidthRef.current = width;
            flowWidthMeasuredBySyncRef.current = false;
            continue;
          }
          if (flowWidthRef.current === null || Math.abs(flowWidthRef.current - width) > 0.5) {
            flowWidthRef.current = width;
            markFullMeasureDirty("flowWidth");
          }
          continue;
        }
        markUnitMeasureDirty(target.getAttribute("data-flow-unit-id"));
      }
      scheduleRecomputeRef.current();
    });
    observer.observe(flowElement);
    flowResizeObserverRef.current = observer;
    observedFlowUnitsRef.current = new Set();
    syncObservedFlowUnits();
    return () => {
      observer.disconnect();
      flowResizeObserverRef.current = null;
      observedFlowUnitsRef.current = new Set();
    };
  }, [flowElement, markFullMeasureDirty, markUnitMeasureDirty, syncObservedFlowUnits]);

  // ユニットの増減にだけ反応して差分を observe/unobserve する。
  useEffect(() => {
    syncObservedFlowUnits();
  }, [syncObservedFlowUnits, units]);

  // 保留中の recompute を取り消すのは unmount のときだけ。ResizeObserver の cleanup に
  // 相乗りさせていたときは、`units` が変わるたびに保留 rAF が巻き添えで消えていた。
  useEffect(() => () => {
    if (recomputeFrameRef.current !== null) {
      window.cancelAnimationFrame(recomputeFrameRef.current);
      recomputeFrameRef.current = null;
    }
  }, []);

  /**
   * 描く紙の窓。**レイアウトフェーズで**決める。
   *
   * ページ数が増えた瞬間 (箱や段落がページ境界を越えた打鍵) に、増えたページを rAF まで
   * 待って描いていたので、「本文は次のページの位置へ動いたのに、その紙がまだ無い」
   * フレームが 1 枚描かれていた — 本文が台紙の灰色の上に浮いて見える。ページ数は
   * `layoutViewState` と同じコミットで決まっているので、窓もそこで揃える。
   * スクロール・リサイズは従来どおり rAF で間引く。
   */
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const scroller = canvas?.closest<HTMLElement>(".editor-canvas");
    if (!canvas || !scroller) {
      const resolution = resolvePageVisibilityWindow({
        measurement: null,
        pageCount,
        pageGapPx: PAGE_GAP_PX,
        pageHeightPx,
        previousScrollSample: pageWindowScrollRef.current,
        zoomScale: zoom / 100,
      });
      setVisiblePageRange((current) => {
        return sameVisiblePageRange(current, resolution.range)
          ? current
          : resolution.range;
      });
      return;
    }

    let frameId = 0;
    const updateRange = () => {
      frameId = 0;
      const now = typeof performance === "undefined" ? Date.now() : performance.now();
      const canvasRect = canvas.getBoundingClientRect();
      const viewportRect = scroller.getBoundingClientRect();
      const resolution = resolvePageVisibilityWindow({
        measurement: {
          canvasTop: canvasRect.top,
          scrollTop: scroller.scrollTop,
          timestamp: now,
          viewportBottom: viewportRect.bottom,
          viewportTop: viewportRect.top,
        },
        pageCount,
        pageGapPx: PAGE_GAP_PX,
        pageHeightPx,
        previousScrollSample: pageWindowScrollRef.current,
        zoomScale: zoom / 100,
      });
      pageWindowScrollRef.current = resolution.scrollSample;
      setVisiblePageRange((current) => (
        sameVisiblePageRange(current, resolution.range)
          ? current
          : resolution.range
      ));
    };
    const scheduleUpdate = () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(updateRange);
    };

    // 初回 (= ページ数・ページ高さ・ズームが変わった直後) だけは間引かずに解く。
    updateRange();
    scroller.addEventListener("scroll", scheduleUpdate, { passive: true });
    window.addEventListener("resize", scheduleUpdate);
    return () => {
      if (frameId) {
        window.cancelAnimationFrame(frameId);
      }
      scroller.removeEventListener("scroll", scheduleUpdate);
      window.removeEventListener("resize", scheduleUpdate);
    };
  }, [pageCount, pageHeightPx, zoom]);

  useEffect(() => {
    if (!hasOverlayRequest) {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      if (runningRegionEditKind) {
        setRunningRegionOverlayEditing(true);
      } else {
        setOverlayEditing(true);
      }
    }, 0);
    return () => window.clearTimeout(timeoutId);
  }, [hasOverlayRequest, runningRegionEditKind]);

  const onOverlayEditingChangeRef = useRef(onOverlayEditingChange);

  useEffect(() => {
    onOverlayEditingChangeRef.current = onOverlayEditingChange;
  }, [onOverlayEditingChange]);

  useEffect(() => {
    onRunningRegionEditingChange?.(runningRegionEditKind);
    if (runningRegionEditKind) {
      onSelect(null);
    }
  }, [onRunningRegionEditingChange, onSelect, runningRegionEditKind]);

  useEffect(() => {
    onOverlayEditingChangeRef.current?.(isOverlayEditing);
  }, [isOverlayEditing]);

  const pageStyle = {
    "--page-width": `${pageWidthPx}px`,
    "--page-height": `${pageHeightPx}px`,
    "--page-gap": `${PAGE_GAP_PX}px`,
    "--page-margin-top": `${metrics.margins.topPx}px`,
    "--page-margin-right": `${metrics.margins.rightPx}px`,
    "--page-margin-bottom": `${metrics.margins.bottomPx}px`,
    "--page-margin-left": `${metrics.margins.leftPx}px`,
    "--page-column-count": String(metrics.flow.columnCount),
    "--page-column-gap": `${metrics.flow.columnGapPx}px`,
    "--page-column-width": `${metrics.flow.columnWidthPx}px`,
    "--editor-font-size": `${fontSize}pt`,
    "--editor-zoom": String(isWhiteboard ? 1 : zoom / 100),
  } as CSSProperties;
  const visiblePageIndexes = useMemo(() => getVisiblePageIndexes(
    visiblePageRange,
    pageCount,
    [
      runningRegionEditKind ? runningRegionEditPageNumber : null,
      horizontalMarginEditPageNumber,
    ].filter((pageNumber): pageNumber is number => typeof pageNumber === "number"),
  ), [horizontalMarginEditPageNumber, pageCount, runningRegionEditKind, runningRegionEditPageNumber, visiblePageRange]);
  // Carried across renders (stable, not a ref so it is safe to read in useMemo).
  // Lets the overlay view reuse unchanged shape object identities so memoized
  // shape views (and their katex / graph rendering) don't re-run when typing
  // doesn't move a figure.
  const [overlayIdentityCache] = useState<OverlayIdentityCache>(() => new Map());
  const reserveSpaceGaps = useMemo(
    () => calculateReserveSpaceGaps(
      overlay.overlaySnapshot ? normalizeOverlaySnapshot(overlay.overlaySnapshot).shapes : [],
    ),
    [overlay.overlaySnapshot],
  );
  const overlayView = useMemo(
    () => measurePerformance("PageCanvasEditor.createResolvedOverlayView", () => createResolvedOverlayView(
      overlay,
      isWhiteboard ? new Map() : blockRects,
      {
        canvasHeight: isWhiteboard ? 20000 : totalHeight,
        canvasWidth: isWhiteboard ? 20000 : pageWidthPx,
        pageGapPx: isWhiteboard ? 0 : PAGE_GAP_PX,
        pageHeightPx: isWhiteboard ? 20000 : pageHeightPx,
        revision: layoutViewState.revision,
        reserveSpaceGaps,
      },
      overlayIdentityCache,
    )),
    [blockRects, isWhiteboard, layoutViewState.revision, overlay, overlayIdentityCache, pageHeightPx, pageWidthPx, reserveSpaceGaps, totalHeight],
  );
  const overlayPresentation = useMemo(
    () => resolveOverlayPresentation?.({
      overlayShapes: overlay.overlaySnapshot?.shapes ?? [],
      overlayAssets: overlay.overlaySnapshot?.assets ?? {},
      blockRects,
      blockGaps: reserveSpaceGaps,
      contentWidthPx: metrics.content.widthPx,
      pageWidthPx,
      pageHeightPx,
    }),
    [blockRects, metrics.content.widthPx, overlay.overlaySnapshot?.assets, overlay.overlaySnapshot?.shapes, pageHeightPx, pageWidthPx, reserveSpaceGaps, resolveOverlayPresentation],
  );
  const pinnedOverlayShapeIds = overlaySelection.selectedShapeIds;
  const visibleBodyHitShapes = useMemo(
    () => [
      ...getVisibleOverlayShapes(overlayView, "background", visiblePageRange, pinnedOverlayShapeIds),
      ...getVisibleOverlayShapes(overlayView, "foreground", visiblePageRange, pinnedOverlayShapeIds),
    ],
    // `overlaySelectionKey` intentionally collapses the selection array to primitive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overlaySelectionKey, overlayView, visiblePageRange],
  );
  // Same reason: the pointer handler needs the selected ids, but taking the array itself as a
  // dependency would hand it a new identity on every render.
  const routableOverlayShapeIds = useMemo(
    () => pinnedOverlayShapeIds,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [overlaySelectionKey],
  );

  const nextSelectPointRequestId = useCallback(() => {
    selectPointRequestIdRef.current += 1;
    return Date.now() * 1000 + selectPointRequestIdRef.current;
  }, []);

  const requestShortcutOverlayAction = useCallback((request: OverlayActionRequestInput) => {
    setShortcutOverlayActionRequest({
      id: nextSelectPointRequestId(),
      ...request,
    } as OverlayActionRequest);
  }, [nextSelectPointRequestId]);

  useEffect(() => {
    const handleShortcutKeyDown = (event: KeyboardEvent) => {
      if (!isInsertTextShapeAtCursorShortcut(event) || runningRegionEditKind || shortcutsSuppressed) {
        return;
      }

      const point = lastPagePointerPointRef.current;
      if (!point) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      setOverlayEditing(true);
      requestShortcutOverlayAction({ type: "insertTextAtPoint", point });
    };

    window.addEventListener("keydown", handleShortcutKeyDown, true);
    return () => window.removeEventListener("keydown", handleShortcutKeyDown, true);
  }, [requestShortcutOverlayAction, runningRegionEditKind, shortcutsSuppressed]);

  // 座標変換はポインタイベントの中でしか呼ばれない。ページ数や寸法を deps に入れると
  // ページ割りのたびに識別子が変わり、これに依存する `handleMaterialInsert` 経由で
  // memo 済みの本文ユニットが全部描き直される。値は ref から「その瞬間の最新」を読む。
  const pageGeometryRef = useRef({ metrics, pageCount, pageHeightPx });
  useLayoutEffect(() => {
    pageGeometryRef.current = { metrics, pageCount, pageHeightPx };
  }, [metrics, pageCount, pageHeightPx]);
  const whiteboardGeometryRef = useRef({ isWhiteboard, whiteboardPanX, whiteboardPanY, zoom });
  useLayoutEffect(() => {
    whiteboardGeometryRef.current = { isWhiteboard, whiteboardPanX, whiteboardPanY, zoom };
  }, [isWhiteboard, whiteboardPanX, whiteboardPanY, zoom]);
  const getOverlayPointFromClient = useCallback((clientX: number, clientY: number): OverlayPoint | null => {
    const whiteboardGeometry = whiteboardGeometryRef.current;
    if (whiteboardGeometry.isWhiteboard) {
      const bounds = canvasRef.current?.getBoundingClientRect();
      if (!bounds) {
        return null;
      }
      return getWhiteboardPointerPoint({
        canvasRect: bounds,
        clientX,
        clientY,
        panX: whiteboardGeometry.whiteboardPanX,
        panY: whiteboardGeometry.whiteboardPanY,
        zoom: whiteboardGeometry.zoom,
      });
    }
    return getClientOverlayPointOnPage({
      canvas: canvasRef.current,
      clientX,
      clientY,
      metrics: pageGeometryRef.current.metrics,
      pageCount: pageGeometryRef.current.pageCount,
      pageHeightPx: pageGeometryRef.current.pageHeightPx,
    });
  }, []);

  const getOverflowOverlayPointFromClient = useCallback((clientX: number, clientY: number): OverlayPoint | null => (
    getClientOverlayPointOnCanvas({
      canvas: canvasRef.current,
      clientX,
      clientY,
      metrics: pageGeometryRef.current.metrics,
    })
  ), []);

  const handleMaterialInsert = useCallback((request: TextFlowMaterialInsertRequest) => {
    const origin = getOverlayPointFromClient(request.screenPoint.x, request.screenPoint.y);
    if (!origin) {
      return;
    }
    onMaterialInsert?.({
      ...request,
      origin,
    });
  }, [getOverlayPointFromClient, onMaterialInsert]);

  // Hovering a block reveals a handle in the left margin (click to select the whole block,
  // Delete to remove it) and, near a block edge, the line that inserts a paragraph there.
  // Both live in a pointer-events:none layer, so only the two small controls take clicks.
  const blockAffordancesEnabled = !isPagedRender && !isOverlayEditing && !runningRegionEditKind;

  /**
   * 掴む単位の索引 (箱の中の段落・リストの項目まで)。打鍵のたびに引き直すが O(ブロック数) で、
   * 描画の外 (ホバー・ドラッグ) からしか読まない。
   */
  const dragIndex = useMemo<DragIndex>(() => ({
    units: indexDragUnits(pageDocument.content),
    anchors: indexDragAnchors(pageDocument.content),
  }), [pageDocument.content]);
  // ドラッグはイベント時に最新を読む。render 中に ref を書かず、commit 後に同期する。
  const dragIndexRef = useRef(dragIndex);
  const pageDocumentRef = useRef(pageDocument);
  const blockSelectionIdsRef = useRef<readonly string[]>([]);
  useLayoutEffect(() => {
    dragIndexRef.current = dragIndex;
    pageDocumentRef.current = pageDocument;
  }, [dragIndex, pageDocument]);
  const ghostLayerRef = useRef<HTMLDivElement | null>(null);

  const columnProbeClientX = useCallback((clientX: number): number => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return clientX;
    }
    const canvasRect = canvas.getBoundingClientRect();
    const scale = canvasLayoutScale(canvas);
    const probeColumnLeftPx = blockHitProbeColumnLeftPx(
      {
        contentLeftPx: metrics.margins.leftPx,
        columnCount: metrics.flow.columnCount,
        columnWidthPx: metrics.flow.columnWidthPx,
        columnGapPx: metrics.flow.columnGapPx,
      },
      (clientX - canvasRect.left) / scale,
    );
    return canvasRect.left + (probeColumnLeftPx + BLOCK_HIT_PROBE_INSET_PX) * scale;
  }, [metrics]);

  const blockDrag = useBlockDrag({
    getCanvas: () => canvasRef.current,
    getGhostLayer: () => ghostLayerRef.current,
    getDocument: () => pageDocumentRef.current,
    getIndex: () => dragIndexRef.current,
    getSelectedUnitIds: () => blockSelectionIdsRef.current,
    getColumnProbeClientX: columnProbeClientX,
    onCommit: (request) => {
      onMoveBlocks?.(request);
      setBlockSelection(EMPTY_BLOCK_SELECTION);
      setBlockAffordance(EMPTY_BLOCK_AFFORDANCE_HOVER);
      setBodyContextMenu(null);
      setProblemContextMenu(null);
    },
  });

  const resolveBlockAffordanceAtPoint = useCallback((clientX: number, clientY: number): BlockAffordanceHover => {
    const canvas = canvasRef.current;
    if (!canvas || pointHitsLayoutColumnResizeHandle(canvas, clientX, clientY)) {
      return EMPTY_BLOCK_AFFORDANCE_HOVER;
    }
    return resolveBlockAffordanceHover(
      hitTestTopLevelBlock(
        canvas,
        pageDocumentRef.current,
        dragIndexRef.current,
        clientX,
        clientY,
        metrics,
      ),
      toCanvasPoint(canvas, clientX, clientY),
    );
  }, [metrics]);

  const updateBlockAffordanceHover = useCallback((clientX: number, clientY: number, target?: EventTarget | null) => {
    // 下端つまみを掴んでいる間はホバー解決を凍結する。ポインタがブロックから離れた瞬間に
    // affordance が空になり、掴んでいるつまみごと unmount されるのを防ぐ。
    const canvas = canvasRef.current;
    const pointerOwner = resolveBlockAffordancePointerOwner({
      dragging: spaceAfterSessionRef.current.isDragging || blockDrag.isDragging(),
      targetIsAffordance: target instanceof Element && !!target.closest(".page-block-affordance-layer"),
      hitsColumnDivider: !!canvas && pointHitsLayoutColumnResizeHandle(canvas, clientX, clientY),
    });
    // 表示中のグリップ／つまみ自身が最前面なら、その上に居る間は現在の解決を保つ。
    // ドラッグ中も同じ: control が unmount されると pointer capture ごと消える。
    if (pointerOwner === "frozen") {
      return;
    }
    // アフォーダンスが無い場所から直接入ったときだけ、実 DOM の 12px 境界矩形が勝つ。
    if (pointerOwner === "divider") {
      lastAffordancePointRef.current = { x: clientX, y: clientY };
      setBlockAffordance((current) => (
        current === EMPTY_BLOCK_AFFORDANCE_HOVER ? current : EMPTY_BLOCK_AFFORDANCE_HOVER
      ));
      return;
    }
    // 書き込み後の取り直しは「次にホバーが動くまで」で十分。ここを通ったら予約は消化済み。
    spaceAfterHoverRefreshRef.current = false;
    if (!blockAffordancesEnabled || !canvas) {
      setBlockAffordance((current) => (
        current === EMPTY_BLOCK_AFFORDANCE_HOVER ? current : EMPTY_BLOCK_AFFORDANCE_HOVER
      ));
      return;
    }

    lastAffordancePointRef.current = { x: clientX, y: clientY };
    const next = resolveBlockAffordanceAtPoint(clientX, clientY);
    setBlockAffordance((current) => (sameBlockAffordanceHover(current, next) ? current : next));
  }, [blockAffordancesEnabled, blockDrag, resolveBlockAffordanceAtPoint]);

  const updateLastPagePointerPoint = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    lastPagePointerPointRef.current = getOverlayPointFromClient(event.clientX, event.clientY);
    updateBlockAffordanceHover(event.clientX, event.clientY, event.target);
  }, [getOverlayPointFromClient, updateBlockAffordanceHover]);

  /**
   * 掴んだ瞬間に「何が追従するか」を 1 回だけ決める。
   *
   * ドラッグ中はページ割りを凍らせるので、この答えは離すまで変わらない。実測 (`blockRects`)
   * は今まさに描かれている紙面そのものなので、ページ段組・局所段組・問題エリア段組の
   * どれでも同じ 1 つの判定で済む。
   */
  const resolveBlockSpaceAfterCohort = useCallback((blockId: string): SpaceAfterPreviewCohort => (
    resolveSpaceAfterPreviewCohort({
      units: units.map((unit) => ({ id: unit.id, blockIds: getFlowUnitBlockIds(unit) })),
      blockRects: layoutViewStateRef.current.blockRects,
      pageStride: pageHeightPx + PAGE_GAP_PX,
      draggedBlockId: blockId,
    })
  ), [pageHeightPx, units]);

  /**
   * ブロックの下端を掴んで下余白を伸ばす。
   *
   * ドラッグ中は **紙面の寸法を一切変えない**。追従するブロック (掴んだブロックより下で、
   * 同じページ・同じ段にあるもの) は `transform: translateY()` で平行移動するだけで、値は
   * `block-space-after-preview` のストアが custom property 1 本として運ぶ。つまり
   * pointermove 1 回のコストは `setProperty` 1 回きり — React 再レンダーも ProseMirror の
   * transaction も 0。寸法が変わらないので ResizeObserver も鳴らず、再ページ割りの連鎖が
   * そもそも起きない。
   *
   * 文書には離した時に 1 回だけ書く (ドラッグ中に書くと同期キーが変わって `setContent` が
   * 走り、キャレットと選択が飛ぶ)。
   */
  const startBlockSpaceAfterResize = useCallback((
    target: BlockSpaceAfterTarget,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    // `preventDefault` はここでは呼ばない — pointerdown を止めると互換の mouse イベントごと
    // 消えてダブルクリックの取り消しが効かなくなる。フォーカスと選択を動かさないのは
    // `onMouseDown` 側 (既存のブロックグリップと同じ形)。
    event.stopPropagation();

    // 掴み直し (前のドラッグが pointerup を取り逃していた等) は前のドラッグを畳んでから。
    // 上書きすると前の `handlePointerUp` が新しいドラッグの値をコミットしてしまう。
    spaceAfterSessionRef.current.resetForStart();

    // 起点は **いま文書が持っている値**。ホバーの値は前回のコミット後に取り直されていない
    // ことがあり、そこから足すと 2 回目のドラッグで紙面が前の値まで巻き戻る。
    const currentBlock = collectBlocksById(pageDocument.content).get(target.blockId);
    const startPx = currentBlock ? blockSpaceAfterPx(currentBlock) : target.spaceAfterPx;
    const zoomFactor = zoom / 100;
    const cohort = resolveBlockSpaceAfterCohort(target.blockId);
    // ハンドラは全部この 1 つの状態を閉じ込めて読む。ref 越しに読むと、掴み直しや破棄で
    // ref が差し替わった後に古いハンドラが新しいドラッグを畳んでしまう。
    const drag = {
      target,
      startClientY: event.clientY,
      startPx,
      px: startPx,
      clientY: event.clientY,
      zoomFactor,
      frame: null as number | null,
      stop,
    };

    /** 1 フレームに 1 回だけ、溜めた clientY からプレビュー値を出して custom property を書く。 */
    function applyPreviewFrame() {
      drag.frame = null;
      const next = resolveSpaceAfterDragPx({
        startPx: drag.startPx,
        startClientY: drag.startClientY,
        clientY: drag.clientY,
        zoomFactor: drag.zoomFactor,
      });
      if (next === drag.px) {
        return;
      }
      drag.px = next;
      // ここが pointermove 1 回あたりの全コスト。
      setBlockSpaceAfterPreviewDeltaPx(next - drag.startPx);
    }

    function handlePointerMove(moveEvent: PointerEvent) {
      // 溜めるだけ。ポインタは 1 フレームに何度も来るので、描く仕事は rAF 1 回に畳む。
      drag.clientY = moveEvent.clientY;
      if (drag.frame !== null) {
        return;
      }
      drag.frame = window.requestAnimationFrame(applyPreviewFrame);
    }

    function handleKeyDown(keyEvent: KeyboardEvent) {
      if (keyEvent.key !== "Escape") {
        return;
      }
      keyEvent.preventDefault();
      keyEvent.stopPropagation();
      cancelBlockSpaceAfterDragRef.current();
    }

    /** ドラッグを畳む。アンマウントで途中終了したときもここを通す (予約とリスナを残さない)。 */
    function stop() {
      if (drag.frame !== null) {
        window.cancelAnimationFrame(drag.frame);
        drag.frame = null;
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
      window.removeEventListener("pointercancel", handlePointerCancel);
      window.removeEventListener("keydown", handleKeyDown, true);
      // プレビューはここでは外さない。確定を待ってから、同じレイアウトフェーズで外す
      // (先に外すと「戻ってから下がる」フレームが 1 枚描かれる)。破棄側は
      // `cancelBlockSpaceAfterDrag` が即座に外す。
    }

    /**
     * ポインタが失われた (別ウィンドウへ、タッチのキャンセル)。**破棄** であって確定ではない。
     * ここに `handlePointerUp` を貼っていた頃は、キャンセルが文書への書き込みになっていた。
     */
    function handlePointerCancel() {
      cancelBlockSpaceAfterDragRef.current();
    }

    function handlePointerUp(upEvent: PointerEvent) {
      if (!spaceAfterSessionRef.current.release(drag)) {
        // 既に畳まれている (Escape / pointercancel / 掴み直し)。何も確定しない。
        return;
      }

      // 確定値は **離した位置** から出し直す。rAF の間引きに任せると、最後の pointermove の
      // 次のフレームが来る前に離した速いドラッグで、動かした分がまるごと落ちる。
      drag.clientY = upEvent.clientY;
      drag.px = resolveSpaceAfterDragPx({
        startPx: drag.startPx,
        startClientY: drag.startClientY,
        clientY: drag.clientY,
        zoomFactor: drag.zoomFactor,
      });
      // 確定するまでは平行移動が見た目を担う。ここを飛ばすと、離した瞬間だけ元へ戻る。
      setBlockSpaceAfterPreviewDeltaPx(drag.px - drag.startPx);

      if (drag.px === drag.startPx) {
        // 動いていない (クリックだけ)。文書は触らず、プレビューだけ畳む。
        endBlockSpaceAfterPreview();
        setSpaceAfterDrag(null);
        thawSpaceAfterRecompute();
        return;
      }

      spaceAfterHoverRefreshRef.current = true;
      spaceAfterSessionRef.current.beginCommit({
        blockId: drag.target.blockId,
        px: drag.px,
        deltaPx: drag.px - drag.startPx,
        bottomBefore: drag.target.bottom,
      });
      if (onBlockSpaceAfterChange) onBlockSpaceAfterChange(drag.target.blockId, drag.px);
      else onChange(drag.target.blockId, (block) => setBlockSpaceAfter(block, drag.px));
      // プレビューはここでは外さない。確定した余白が実際に描かれたフレームまで待ってから
      // 外す (コミットが弾かれても数フレームで必ず畳む)。
      releaseSpaceAfterPreviewWhenPaintedRef.current();
    }

    spaceAfterSessionRef.current.start(drag);
    // 順序が意味を持つ: 先に cohort をストアへ渡して各面へ印を配り (PM transaction 1 本)、
    // その後で React に 1 レンダーだけさせる。以後ドラッグが終わるまでどちらも動かない。
    beginBlockSpaceAfterPreview({ blockId: target.blockId, followerBlockIds: cohort.followerBlockIds });
    setSpaceAfterDrag({ target, followerUnitIds: new Set(cohort.followerUnitIds) });
    // ポインタを掴んでおく。掴まないと、離した位置に `pointerup` を止める別の UI (コメントの
    // ドックなど) があるだけで window までイベントが届かず、ドラッグが終われなくなる。
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // 取れなくても window のリスナで拾えるので続行する。
    }
    window.addEventListener("pointermove", handlePointerMove, { passive: true });
    window.addEventListener("pointerup", handlePointerUp);
    window.addEventListener("pointercancel", handlePointerCancel);
    // capture で拾う: 本文やポップオーバーが Escape を先に食べても、掴んでいる間はこちらが勝つ。
    window.addEventListener("keydown", handleKeyDown, true);
  }, [onBlockSpaceAfterChange, onChange, pageDocument.content, resolveBlockSpaceAfterCohort, thawSpaceAfterRecompute, zoom]);

  /** キーボードからの微調整。ドラッグでは出せない 1px 刻みをここで出す。 */
  const adjustBlockSpaceAfter = useCallback((blockId: string, deltaPx: number) => {
    spaceAfterHoverRefreshRef.current = true;
    if (onBlockSpaceAfterChange) {
      const block = findBlock(pageDocument, blockId);
      if (block) onBlockSpaceAfterChange(blockId, blockSpaceAfterPx(block) + deltaPx);
    } else {
      onChange(blockId, (block) => setBlockSpaceAfter(block, blockSpaceAfterPx(block) + deltaPx));
    }
  }, [onBlockSpaceAfterChange, onChange, pageDocument]);

  // 掴んだままアンマウントされたときの後始末。ストアは紙面ごとではなくモジュール単位なので、
  // ここで畳まないとプレビューの印と平行移動が残り続ける。
  useEffect(() => () => {
    cancelBlockSpaceAfterDragRef.current();
  }, []);

  // 平行移動を運ぶ custom property の書き込み先。`.page-stack` の `transform: scale()` の
  // **内側**なので、canvas px のまま書けばズームは自動で乗る。
  useEffect(() => {
    if (!canvasElement) {
      return;
    }
    return registerBlockSpaceAfterPreviewRoot(canvasElement);
  }, [canvasElement]);

  // 文書更新後に、静止中のポインタから singleton affordance を取り直す。Enter / Backspace /
  // 貼り付け / 通常入力のどれも行高と改ページ位置を変え得るため、space-after 操作だけを
  // 特別扱いすると座標が古いまま残る。React 更新後の rAF へ集約し、1 文書更新につき最大1回、
  // 寸法が確定した DOM を測る (pointermove 中の再レンダーは増やさない)。
  useEffect(() => {
    const previousRevision = lastAffordanceLayoutRevisionRef.current;
    const revision = layoutViewState.revision;
    lastAffordanceLayoutRevisionRef.current = revision;
    const point = lastAffordancePointRef.current;
    if (!point || revision <= previousRevision || spaceAfterSessionRef.current.isDragging) return;
    const frame = window.requestAnimationFrame(() => {
      spaceAfterHoverRefreshRef.current = false;
      const next = resolveBlockAffordanceAtPoint(point.x, point.y);
      setBlockAffordance((current) => resolveStationaryBlockAffordanceRefresh({
        previousRevision,
        revision,
        point,
        current,
        next,
      }).hover);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [layoutViewState.revision, resolveBlockAffordanceAtPoint]);

  const resetBlockSpaceAfter = useCallback((blockId: string) => {
    spaceAfterHoverRefreshRef.current = true;
    if (onBlockSpaceAfterChange) onBlockSpaceAfterChange(blockId, 0);
    else onChange(blockId, (block) => setBlockSpaceAfter(block, 0));
  }, [onBlockSpaceAfterChange, onChange]);

  const selectBlockWithHandle = useCallback((blockId: string, extend: boolean) => {
    const canvas = canvasRef.current;
    const measure = (ids: string[]): TopLevelBlockBox[] => (canvas
      ? ids.flatMap((id) => {
        const info = dragIndex.units.get(id);
        return info ? measureDragUnitPieces(canvas, id, info.type).map(({ box }) => ({ id, ...box })) : [];
      })
      : []);
    setBlockSelection((current) => {
      const selected = new Set(extend ? current.ids : []);
      if (extend && selected.has(blockId)) selected.delete(blockId);
      else selected.add(blockId);
      const ids = [...dragIndex.units.keys()].filter((id) => selected.has(id));
      blockSelectionAnchorRef.current = blockId;
      return { ids, boxes: measure(ids) };
    });
    setBodyContextMenu(null);
    setProblemContextMenu(null);
    onSelect(blockId);
    // Without dropping the caret the next Delete would go to ProseMirror, not the block.
    const active = window.document.activeElement;
    if (active instanceof HTMLElement && active.isContentEditable) {
      active.blur();
    }
    window.getSelection()?.removeAllRanges();
  }, [dragIndex, onSelect]);

  const insertBodyBlockAtPoint = useCallback((insertPoint: BlockInsertPoint) => {
    onInsertBodyBlock?.(insertPoint.anchorBlockId, insertPoint.position);
    setBlockSelection(EMPTY_BLOCK_SELECTION);
    setBlockAffordance(EMPTY_BLOCK_AFFORDANCE_HOVER);
  }, [onInsertBodyBlock]);

  // A selection whose blocks no longer exist (an AI edit landed, undo ran) is dropped on the
  // spot rather than left drawing an outline over whatever moved into that position.
  const activeBlockSelection = useMemo(() => (
    blockSelection.ids.every((id) => dragIndex.units.has(id))
      ? blockSelection
      : EMPTY_BLOCK_SELECTION
  ), [blockSelection, dragIndex]);
  useEffect(() => {
    blockSelectionIdsRef.current = activeBlockSelection.ids;
  }, [activeBlockSelection]);

  // 掴んでいる間は掴んだ相手に固定する (ホバー解決は凍結済み)。つまみ自体は「動かしている辺」
  // だが、追従は CSS (`[data-dragging]` の translate) がやるので **ここは動かさない** —
  // 毎フレーム `top` を書き換えると、そのたびに紙面全体が React で再レンダーされる。
  const spaceAfterHandle = spaceAfterDrag?.target ?? blockAffordance.spaceAfter;
  const visibleBlockHandles = useMemo(
    () => blockAffordance.handle ? [blockAffordance.handle] : [],
    [blockAffordance.handle],
  );
  const visibleSpaceAfterHandles = useMemo(
    () => spaceAfterDrag ? [spaceAfterDrag.target] : spaceAfterHandle ? [spaceAfterHandle] : [],
    [spaceAfterDrag, spaceAfterHandle],
  );
  const insertButtonLane = resolveBlockInsertButtonLane(blockAffordance);
  /**
   * 殻ごと平行移動するユニット。問題枠・サイドノート・問題番号は殻が持っているので、
   * 中身だけ動かすと枠が置き去りになる。殻を動かすユニットの中身には印を付けない
   * (二重に translate されるのを構造的に防ぐ = cohort が保証している)。
   */
  const spaceAfterFollowerUnitIds = spaceAfterDrag?.followerUnitIds ?? EMPTY_SPACE_AFTER_FOLLOWER_UNITS;
  const spaceAfterFollowerUnitClass = (unitId: string): string => (
    spaceAfterFollowerUnitIds.has(unitId) ? BLOCK_SPACE_AFTER_FOLLOWER_CLASS : ""
  );

  // Clearing on the canvas' own mousedown is not enough: ProseMirror stops the event inside
  // the text, so a click on another block would leave the previous one selected. The capture
  // phase runs before any editor sees it, so every click on the page lands here first.
  useEffect(() => {
    if (activeBlockSelection.ids.length === 0) {
      return;
    }

    const clearOnPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest(BLOCK_SELECTION_KEEP_SELECTOR)) {
        return;
      }
      // Left presses inside the page need geometry-aware overlay hit testing. The page capture
      // handler below decides whether this is a shape selection or a normal click-away.
      if (event.button === 0 && target instanceof Element && target.closest(".page-stack")) {
        return;
      }
      setBlockSelection(EMPTY_BLOCK_SELECTION);
    };

    window.document.addEventListener("pointerdown", clearOnPointerDown, true);
    return () => window.document.removeEventListener("pointerdown", clearOnPointerDown, true);
  }, [activeBlockSelection.ids.length]);

  useEffect(() => {
    if (activeBlockSelection.ids.length === 0) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setBlockSelection(EMPTY_BLOCK_SELECTION);
        return;
      }
      if (event.key !== "Delete" && event.key !== "Backspace") {
        return;
      }
      if (!shouldHandleBlockSelectionDelete({
        defaultPrevented: event.defaultPrevented,
        activeElement: canvasRef.current?.ownerDocument.activeElement ?? null,
        hasOverlayDestructiveSelection: overlayDestructiveSelectionCountRef.current > 0,
      })) {
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement
        && (target.isContentEditable || target.closest(BLOCK_SELECTION_KEY_IGNORE_SELECTOR))
      ) {
        return;
      }

      event.preventDefault();
      onDeleteBlocks?.(activeBlockSelection.ids);
      setBlockSelection(EMPTY_BLOCK_SELECTION);
      setBlockAffordance(EMPTY_BLOCK_AFFORDANCE_HOVER);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [activeBlockSelection, onDeleteBlocks]);

  // グリップ選択のままキーボードで動かしたあと、選択の面を新しい位置で測り直すための予約。
  const blockSelectionRefreshRef = useRef(false);

  // ⌥⇧↑/↓: キャレットのあるブロック (またはグリップで選んだブロック) を前後の兄弟と入れ替える。
  // ProseMirror より先に取る (capture)。⌥⇧+矢印は本文では単語選択に使っていない。
  useEffect(() => {
    if (!onMoveBlocksByStep || !blockAffordancesEnabled) {
      return;
    }
    const handleKeyDown = (event: KeyboardEvent) => {
      if (
        !event.altKey || !event.shiftKey || event.metaKey || event.ctrlKey
        || (event.key !== "ArrowUp" && event.key !== "ArrowDown")
        || event.defaultPrevented
      ) {
        return;
      }
      const direction = event.key === "ArrowUp" ? "up" : "down";
      const selected = blockSelectionIdsRef.current;
      let unitIds: string[] = [];
      if (selected.length > 0) {
        unitIds = [...selected];
      } else {
        const canvas = canvasRef.current;
        const active = canvas?.ownerDocument.activeElement;
        if (!canvas || !(active instanceof HTMLElement) || !active.isContentEditable || !canvas.contains(active)) {
          return;
        }
        if (active.closest(".page-running-editor-band, .overlay-canvas-editor, .page-overlay-layer")) {
          return;
        }
        const selection = canvas.ownerDocument.getSelection();
        const node = selection?.anchorNode;
        const element = node instanceof Element ? node : node?.parentElement ?? null;
        let host = element?.closest<HTMLElement>("[data-sigma-doc-id]") ?? null;
        while (host && !dragIndexRef.current.units.has(host.getAttribute("data-sigma-doc-id") ?? "")) {
          host = host.parentElement?.closest<HTMLElement>("[data-sigma-doc-id]") ?? null;
        }
        const id = host?.getAttribute("data-sigma-doc-id");
        if (!id) {
          return;
        }
        unitIds = [id];
      }
      event.preventDefault();
      event.stopPropagation();
      onMoveBlocksByStep(unitIds, direction);
      if (selected.length > 0) {
        // 動かした後の箱は次の描画で測り直す (`blockSelectionRefreshRef`)。
        blockSelectionRefreshRef.current = true;
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [blockAffordancesEnabled, onMoveBlocksByStep]);

  useEffect(() => {
    if (!blockSelectionRefreshRef.current) {
      return;
    }
    blockSelectionRefreshRef.current = false;
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      setBlockSelection((current) => {
        if (current.ids.length === 0) {
          return current;
        }
        const boxes = current.ids.flatMap((id) => {
          const info = dragIndexRef.current.units.get(id);
          return info ? measureDragUnitPieces(canvas, id, info.type).map(({ box }) => ({ id, ...box })) : [];
        });
        return { ids: current.ids, boxes };
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [pageDocument.content]);

  const requestBodyOverlayImages = useCallback((files: File[], point?: OverlayPoint) => {
    if (runningRegionEditKind || files.length === 0) {
      return;
    }

    setOverlayEditing(true);
    onOverlayImagesRequest(files, point);
  }, [onOverlayImagesRequest, runningRegionEditKind]);

  useEffect(() => {
    const handleImagePaste = (event: ClipboardEvent) => {
      if (runningRegionEditKind || !event.clipboardData) {
        return;
      }

      const point = lastPagePointerPointRef.current;
      if (!shouldHandlePageImagePaste(event.target, canvasRef.current, point)) {
        return;
      }

      const files = getSupportedOverlayImageFilesFromDataTransfer(event.clipboardData);
      if (files.length === 0) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      requestBodyOverlayImages(files, point ?? undefined);
    };

    window.addEventListener("paste", handleImagePaste, true);
    return () => window.removeEventListener("paste", handleImagePaste, true);
  }, [requestBodyOverlayImages, runningRegionEditKind]);

  const handlePageDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (runningRegionEditKind || !hasSupportedOverlayImageData(event.dataTransfer)) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, [runningRegionEditKind]);

  const handlePageDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (runningRegionEditKind) {
      return;
    }

    const files = getSupportedOverlayImageFilesFromDataTransfer(event.dataTransfer);
    if (files.length === 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    requestBodyOverlayImages(files, getOverlayPointFromClient(event.clientX, event.clientY) ?? undefined);
  }, [getOverlayPointFromClient, requestBodyOverlayImages, runningRegionEditKind]);

  const requestOverlayPreviewSelection = useCallback((
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    startCrop: boolean,
    focusTextOnMiss = true,
    startMarquee = false,
    dragEndScreenPoint?: ClientPoint,
    targetShapeId?: string,
  ) => {
    if (bounds.width <= 0 || bounds.height <= 0) {
      return;
    }

    const toCanvasPoint = (screenX: number, screenY: number) => {
      if (isWhiteboard) {
        return getWhiteboardPointerPoint({
          canvasRect: bounds,
          clientX: screenX,
          clientY: screenY,
          panX: whiteboardPanX,
          panY: whiteboardPanY,
          zoom,
        });
      }
      // Paper-mode hit testing and the editor handoff share page coordinates.
      return getCanvasPointerPoint({
        canvasRect: bounds,
        clientX: screenX,
        clientY: screenY,
        metrics,
      });
    };
    const point = toCanvasPoint(clientX, clientY);
    const dragEndPoint = dragEndScreenPoint
      ? toCanvasPoint(dragEndScreenPoint.x, dragEndScreenPoint.y)
      : null;
    if (!point) {
      return;
    }

    setOverlayEditing(true);
    setSelectPointRequest({
      id: nextSelectPointRequestId(),
      point,
      screenPoint: {
        x: clientX,
        y: clientY,
      },
      dragEndPoint: dragEndPoint ?? undefined,
      startCrop,
      focusTextOnMiss,
      startMarquee,
      targetShapeId,
    });
  }, [isWhiteboard, metrics, nextSelectPointRequestId, whiteboardPanX, whiteboardPanY, zoom]);

  const startOverlayPreviewPointerHandoff = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    bounds: DOMRect,
    targetShapeId?: string,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const handoff: OverlayPreviewPointerHandoff = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      start,
      latest: start,
      cleanup: () => undefined,
    };

    const finish = () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerUp, true);
      if (overlayPreviewPointerHandoffRef.current === handoff) {
        overlayPreviewPointerHandoffRef.current = null;
      }
    };
    const forwardPointerUp = (nativeEvent: PointerEvent) => {
      handoff.latest = { x: nativeEvent.clientX, y: nativeEvent.clientY };
      requestOverlayPreviewSelection(bounds, handoff.start.x, handoff.start.y, false, true, false, handoff.latest, targetShapeId);
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      finish();
    };
    const isHandoffPointerEvent = (nativeEvent: PointerEvent) => (
      nativeEvent.pointerId === handoff.pointerId ||
      (nativeEvent.pointerType === "mouse" && handoff.pointerType === "mouse")
    );
    function handleWindowPointerMove(nativeEvent: PointerEvent) {
      if (!isHandoffPointerEvent(nativeEvent)) {
        return;
      }

      handoff.latest = { x: nativeEvent.clientX, y: nativeEvent.clientY };
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
    }
    function handleWindowPointerUp(nativeEvent: PointerEvent) {
      if (!isHandoffPointerEvent(nativeEvent)) {
        return;
      }

      forwardPointerUp(nativeEvent);
    }

    handoff.cleanup = finish;
    overlayPreviewPointerHandoffRef.current?.cleanup();
    overlayPreviewPointerHandoffRef.current = handoff;
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerUp, true);

    flushSync(() => {
      setOverlayEditing(true);
    });
  }, [requestOverlayPreviewSelection]);

  /**
   * 紙面の本文モードでは到達しない。図形を掴む経路は `handlePagePointerDownCapture` の
   * JS ヒットテストが所有する。ホワイトボードも同じ capture 経路を使うが、AI ロック中など
   * DOM 側が明示的にポインタを受けるプレビュー要素のフォールバックとして残す。
   */
  const handleOverlayPreviewPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    const bounds = isWhiteboard
      ? canvasRef.current?.getBoundingClientRect()
      : event.currentTarget.getBoundingClientRect();
    if (bounds) {
      startOverlayPreviewPointerHandoff(event, bounds);
    }
  }, [isWhiteboard, startOverlayPreviewPointerHandoff]);

  const handleOverlayPreviewDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    const bounds = isWhiteboard
      ? canvasRef.current?.getBoundingClientRect()
      : event.currentTarget.getBoundingClientRect();
    if (bounds) {
      requestOverlayPreviewSelection(
        bounds,
        event.clientX,
        event.clientY,
        true,
      );
    }
  }, [isWhiteboard, requestOverlayPreviewSelection]);

  const handleSelectPointHandled = useCallback((requestId: number, hitShape: boolean) => {
    const handledRequest = selectPointRequest?.id === requestId ? selectPointRequest : null;

    setSelectPointRequest((current) => current?.id === requestId ? null : current);
    if (!hitShape) {
      setOverlayEditing(false);
      onSelect(null);
      if (handledRequest?.screenPoint && handledRequest.focusTextOnMiss !== false) {
        focusUnderlyingEditorAtPoint(handledRequest.screenPoint);
      }
    }
  }, [onSelect, selectPointRequest]);

  const handleOverlayActionHandled = useCallback((requestId: number) => {
    setShortcutOverlayActionRequest((current) => current?.id === requestId ? null : current);
    onOverlayActionHandled(requestId);
  }, [onOverlayActionHandled]);

  const handleRequestTextMode = useCallback((screenPoint?: ClientPoint) => {
    setOverlayEditing(false);
    onSelect(null);

    if (screenPoint) {
      focusUnderlyingEditorAtPoint(screenPoint);
    }
  }, [onSelect]);

  /**
   * 図形を掴まなかったマーキーを本文の範囲選択として引き継ぐ。本文の上で始まったドラッグに
   * 限る — 紙の余白での空振りマーキーまで本文モードへ落とすと、図形モードの選び直しが要る。
   */
  const handleRequestTextSelection = useCallback((screenStart: ClientPoint, screenEnd: ClientPoint) => {
    if (!findEditableElementUnderPoint(screenStart)) {
      return;
    }

    setOverlayEditing(false);
    onSelect(null);
    selectUnderlyingEditorRange(screenStart, screenEnd);
  }, [onSelect]);

  const handleTextFlowChange = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    if (context?.deferredPasteBlockIds && context.deferredPasteBlockIds.length > 0) {
      countPerformanceEvent("PageCanvasEditor.largePaste.started");
      startCaretKeeperWindow();
      largePasteCaretKeeperActiveRef.current = true;
      const hydrationUnits = previousUnitsRef.current.flatMap((unit) => unit.type === "textFlow"
        ? [{ id: unit.id, blockIds: unit.blocks.map((block) => block.id) }]
        : []);
      setLargePasteHydration((current) => ({
        deferredBlockIds: mergeLargePasteDeferredBlockIds(
          current,
          hydrationUnits,
          context.deferredPasteBlockIds ?? [],
        ),
        hydratedUnitIds: new Set(),
      }));
    }
    // 本文ユニットの id は先頭ブロックの id (`text-run-chunking.ts`)。打鍵で位置が動くのは
    // このユニット以降だけなので、次の計測はここから始めれば足りる。
    markUnitMeasureDirty(previousIds[0]);
    const selection = context?.selection;
    if (selection && shouldRestoreTextFlowSelectionAfterChange(previousIds, nextBlocks, selection, context)) {
      requestCaret(selection);
    }
    // 段組みでは新しいブロックの位置を decoration (次の計測の答え) が決める。遅延計測に
    // 載せると「配置の無いブロック」が 1〜2 フレーム描かれ、その間の打鍵でブラウザ自身の
    // キャレット追従が紙面を 1 ページ目の原点 (潰れた編集面 root) へ飛ばす。新しいブロック
    // が生まれる編集だけ、分割ブロックと同じく描く前にページ割りを取り直す。
    const beforePaint = context?.deferredPasteBlockIds !== undefined
      || editTouchesPageSplitBlock(previousIds, nextBlocks, activeBlockId)
      || hasNewTopLevelBlockIds(previousIds, nextBlocks)
      || previousIds.some((id) => !nextBlocks.some((block) => block.id === id))
      // Removing a line above a page spacer changes both the natural flow and
      // the spacer. Commit those together so the next page never jumps up for a frame.
      || Object.keys(layoutViewStateRef.current.gaps).length > 0;
    if (beforePaint) {
      paginateBeforePaintRef.current = true;
    }
    // 同期でページ割りを取り直す打鍵は、描画も遅らせない。transition に載せると
    // ProseMirror が書いた DOM だけが先に 1 フレーム描かれ、同期計測の意味が消える。
    onReplaceTextFlow(previousIds, nextBlocks, context, beforePaint ? { immediateRender: true } : undefined);
  }, [editTouchesPageSplitBlock, markUnitMeasureDirty, onReplaceTextFlow, setLargePasteHydration]);

  const updateProblemAreaBlocks = useCallback((
    problemId: string,
    area: ProblemAreaKind,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    // 問題エリアと段組みセクションは、1 つの編集がまわりのユニットの配置まで動かす
    // (エリアの高さ・段の割り付け・枠の分割)。どこが動くかを id で言い切れないので、
    // 増分計測には載せず全体を測り直す — 安全側 (`incremental-layout.ts` の等価性が前提)。
    markFullMeasureDirty();
    if (editTouchesPageSplitBlock(previousIds, nextBlocks, activeBlockId)) {
      paginateBeforePaintRef.current = true;
    }
    const selection = context?.selection;
    const transition = resolveBodyTextFlowTransition(pageContentRef.current, {
      scope: "problemArea",
      targetId: problemId,
      area,
      previousIds,
      nextBlocks,
    });
    if (selection && shouldRestoreTextFlowSelectionAfterChange(previousIds, nextBlocks, selection, context)) {
      requestCaret(selection);
    }
    onChange(transition.targetId, transition.reduce, context);
  }, [editTouchesPageSplitBlock, markFullMeasureDirty, onChange]);

  const updateLayoutSectionBlocks = useCallback((
    sectionId: string,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    // 問題エリアと同じ理由で全体を測り直す (段組みは 1 ブロックの変化が段全体に波及する)。
    markFullMeasureDirty();
    const selection = context?.selection;
    const transition = resolveBodyTextFlowTransition(pageContentRef.current, {
      scope: "layoutSection",
      targetId: sectionId,
      previousIds,
      nextBlocks,
    });
    if (selection && shouldRestoreTextFlowSelectionAfterChange(previousIds, nextBlocks, selection, context)) {
      requestCaret(selection);
    }
    onChange(transition.targetId, transition.reduce, context);
  }, [markFullMeasureDirty, onChange]);

  // 描き直しが落ち着いてから 1 回だけ配る。2 rAF 待つのは、断片の複製がマウントされて
  // レイアウトが確定するまで宛先が決まらないため。
  useLayoutEffect(() => {
    let secondFrame = 0;
    const firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => flushPendingCaret());
    });
    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
    };
  }, [pageDocument.content]);

  const clearProblemArea = useCallback((problemId: string, area: ProblemAreaKind) => {
    const transition = resolveProblemAreaTransition(problemId, {
      type: "clearOptionalArea",
      area,
    });
    onChange(transition.targetId, transition.reduce);
  }, [onChange]);

  const showProblemArea = useCallback((problemId: string, area: ProblemAreaKind) => {
    const transition = resolveProblemAreaTransition(problemId, {
      type: "showOptionalArea",
      area,
      emptyBlockId: createId(getOptionalProblemAreaBlockIdPrefix(area)),
    });
    onChange(transition.targetId, transition.reduce);
  }, [onChange]);

  const startProblemAreaResize = useCallback((
    problem: ProblemNode,
    area: ProblemAreaKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => {
    event.preventDefault();
    event.stopPropagation();

    if (area === "lead") {
      return;
    }

    const areaElement = event.currentTarget.closest<HTMLElement>(".problem-area-flow-unit");
    if (!areaElement) {
      return;
    }

    const zoomFactor = zoom / 100;
    const startHeightMm = areaElement.getBoundingClientRect().height / zoomFactor / MM_TO_PX;
    const key = problemAreaDraftKey(problem.id, area);
    problemAreaResizeRef.current = {
      problemId: problem.id,
      area,
      startClientY: event.clientY,
      startHeightMm,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = problemAreaResizeRef.current;
      if (!drag) {
        return;
      }

      const deltaMm = ((moveEvent.clientY - drag.startClientY) / zoomFactor) / MM_TO_PX;
      const nextHeightMm = Math.max(0, roundHalfMm(drag.startHeightMm + deltaMm));
      const nextDrafts = { ...problemAreaHeightDraftsRef.current, [key]: nextHeightMm };
      problemAreaHeightDraftsRef.current = nextDrafts;
      setProblemAreaHeightDrafts(nextDrafts);
    };

    const handlePointerUp = () => {
      const drag = problemAreaResizeRef.current;
      problemAreaResizeRef.current = null;
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);

      const nextHeightMm = drag ? problemAreaHeightDraftsRef.current[key] : undefined;
      const rest = { ...problemAreaHeightDraftsRef.current };
      delete rest[key];
      problemAreaHeightDraftsRef.current = rest;
      setProblemAreaHeightDrafts(rest);

      if (drag && typeof nextHeightMm === "number") {
        const transition = resolveProblemAreaTransition(drag.problemId, {
          type: "setMinHeight",
          area: drag.area,
          minHeightMm: nextHeightMm,
        });
        onChange(transition.targetId, transition.reduce);
      }
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [onChange, zoom]);

  const handleTextFlowFocusChange = useCallback((focused: boolean) => {
    if (focused && runningRegionEditKind) {
      setRunningRegionOverlayEditing(false);
      setRunningRegionEditKind(null);
    }
    if (focused && horizontalMarginEditPageNumber !== null) {
      setHorizontalMarginEditPageNumber(null);
    }

    if (!isColumnFlow) {
      return;
    }

  }, [horizontalMarginEditPageNumber, isColumnFlow, runningRegionEditKind]);

  const handleTextFlowBoundaryDelete = useCallback((request: TextFlowBoundaryDeleteRequest) => {
    const deletion = resolveTextFlowBoundaryDelete(pageContentRef.current, request);
    if (!deletion) {
      return false;
    }

    if (deletion.previousIds.length > 0 || deletion.nextBlocks.length > 0) {
      // 境界の削除は 2 つのユニットを繋ぐので、上流側の高さも変わる。「打った場所より下だけ」
      // では言い切れないので全体を測り直す。
      markFullMeasureDirty();
      onReplaceTextFlow(deletion.previousIds, deletion.nextBlocks);
    }
    onSelect(deletion.focusBlockId);
    scheduleTextBlockFocus(pageContentRef.current, deletion.focusBlockId, deletion.focusPosition);
    return true;
  }, [markFullMeasureDirty, onReplaceTextFlow, onSelect]);

  const updateBreakBefore = useCallback((blockId: string, enabled: boolean) => {
    onChange(blockId, (block) => setBlockBreakBefore(block, enabled));
  }, [onChange]);

  const removeBreakBefore = useCallback((blockId: string) => {
    updateBreakBefore(blockId, false);
  }, [updateBreakBefore]);
  const markerRemoveHandler = isPagedRender ? undefined : removeBreakBefore;

  const updateLayoutSectionColumnCount = useCallback((sectionId: string, columnCount: number) => {
    onChange(sectionId, (block) => setLayoutSectionColumnCount(block, columnCount, () => createParagraph("")));
  }, [onChange]);

  // Shared by both the body and problem context menus (the latter reuses it for breaks placed
  // on blocks inside a problem's prompt/hints/solution area): flips the manual break on/off for
  // whichever block a menu's "改ページ/改段 を挿入・解除" item targets. `blockId` need not be
  // top-level — `getNextTopLevelTextFlowBlockId` simply returns null for a nested block, so the
  // break is set directly on the clicked block itself, which is the correct behavior there.
  const applyContextMenuBreak = useCallback((
    target: { blockId: string; breakTargetBlockId: string | null; nextBreakBefore: boolean },
    enabled: boolean | undefined,
    closeMenu: () => void,
  ) => {
    const nextBreakBefore = enabled ?? target.nextBreakBefore;
    if (nextBreakBefore && !canInsertManualBreakAtBlock(pageDocument, target.blockId)) {
      closeMenu();
      return;
    }
    if (nextBreakBefore && !canInsertManualPageBreakAfterBlock(pageDocument.content, target.blockId)) {
      closeMenu();
      return;
    }
    if (!nextBreakBefore && target.breakTargetBlockId) {
      updateBreakBefore(target.breakTargetBlockId, false);
      onSelect(target.breakTargetBlockId);
      scheduleTextBlockFocus(pageContentRef.current, target.breakTargetBlockId, "start");
      closeMenu();
      return;
    }

    const documentNextBlockId = nextBreakBefore
      ? getNextTopLevelTextFlowBlockId(pageDocument.content, target.blockId)
      : null;
    const fallbackBlockId = nextBreakBefore
      ? documentNextBlockId ?? target.blockId
      : target.blockId;
    const detail: TextPageBreakRequestDetail = {
      blockId: target.blockId,
      enabled: nextBreakBefore,
      documentNextBlockId,
    };
    window.dispatchEvent(new CustomEvent(REQUEST_TEXT_PAGE_BREAK_EVENT, { detail }));
    if (detail.handled) {
      if (detail.focusBlockId) {
        onSelect(detail.focusBlockId);
        scheduleTextBlockFocus(pageContentRef.current, detail.focusBlockId, detail.focusPosition ?? "start");
      }
      closeMenu();
      return;
    }

    updateBreakBefore(fallbackBlockId, nextBreakBefore);
    if (fallbackBlockId !== target.blockId) {
      onSelect(fallbackBlockId);
      scheduleTextBlockFocus(pageContentRef.current, fallbackBlockId, "start");
    }
    closeMenu();
  }, [onSelect, pageDocument, updateBreakBefore]);

  const applyBodyContextMenuBreak = useCallback((enabled?: boolean) => {
    if (!bodyContextMenu) {
      return;
    }
    applyContextMenuBreak(bodyContextMenu, enabled, () => setBodyContextMenu(null));
  }, [applyContextMenuBreak, bodyContextMenu]);

  const applyProblemContextMenuBreak = useCallback((enabled?: boolean) => {
    if (!problemContextMenu?.breakBlockId) {
      return;
    }
    applyContextMenuBreak(
      {
        blockId: problemContextMenu.breakBlockId,
        breakTargetBlockId: problemContextMenu.breakTargetBlockId,
        nextBreakBefore: problemContextMenu.nextBreakBefore,
      },
      enabled,
      () => setProblemContextMenu(null),
    );
  }, [applyContextMenuBreak, problemContextMenu]);

  const openProblemActionMenu = useCallback((
    problemId: string,
    area: ProblemAreaKind,
    anchor: HTMLElement,
  ) => {
    const rect = anchor.getBoundingClientRect();
    const menuWidth = 220;
    const margin = 8;
    onSelect(problemId);
    setBodyContextMenu(null);
    setProblemContextMenu({
      problemId,
      area,
      left: Math.max(margin, Math.min(rect.right - menuWidth, window.innerWidth - menuWidth - margin)),
      top: Math.max(margin, Math.min(rect.bottom + 6, window.innerHeight - margin)),
      breakBlockId: null,
      selectionBlockIds: [],
      breakTargetBlockId: null,
      nextBreakBefore: true,
    });
  }, [onSelect]);

  /**
   * Opens the body block menu. Shared by the right-click handler and the block handle, so
   * both routes land on the same menu with the same items for the same block.
   */
  const openBodyContextMenu = useCallback((request: {
    blockId: string;
    clientX: number;
    clientY: number;
    paginationBlockId?: string | null;
    localColumnLayout?: LocalColumnContextMenuLayout | null;
    /** The element the pointer was over, when there was one — scopes a multi-block selection. */
    target?: Element | null;
  }) => {
    const canvas = canvasRef.current;
    const paginationBlockId = request.paginationBlockId ?? null;
    const breakTargetBlockId = paginationBlockId
      ?? getColumnBreakBeforeBlockIdForContextMenu({
        blockId: request.blockId,
        blocks: pageDocument.content,
        units,
        isColumnFlow,
        metrics,
        pageStridePx: pageHeightPx + PAGE_GAP_PX,
        blockRects,
        paginationMarkerLayouts,
        textFlowBlockLayouts,
        unitLayouts,
        problemAreaColumnLayouts,
        localColumnContextMenuLayout: request.localColumnLayout ?? null,
      });
    const breakTargetBlock = breakTargetBlockId ? findBlock(pageDocument, breakTargetBlockId) : null;
    const hasBreakTarget = !!breakTargetBlock
      && isBodyContextMenuBlock(breakTargetBlock)
      && hasBreakBefore(breakTargetBlock);

    onSelect(request.blockId);
    setBodyContextMenu({
      blockId: request.blockId,
      selectionBlockIds: canvas
        ? getSelectionScopedBlockIds(request.target ?? null, canvas, request.blockId)
        : [request.blockId],
      breakTargetBlockId: hasBreakTarget ? breakTargetBlockId : null,
      nextBreakBefore: !hasBreakTarget,
      ...getContextMenuPosition(request.clientX, request.clientY),
    });
    setProblemContextMenu(null);
  }, [
    blockRects,
    isColumnFlow,
    metrics,
    onSelect,
    pageDocument,
    pageHeightPx,
    paginationMarkerLayouts,
    problemAreaColumnLayouts,
    textFlowBlockLayouts,
    unitLayouts,
    units,
  ]);

  const handlePageContextMenu = useCallback((event: ReactMouseEvent<HTMLElement>) => {
    if (isOverlayEditing) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const canvas = canvasRef.current;
    const problemAreaElement = target?.closest<HTMLElement>("[data-problem-area]") ?? null;
    const problemId = problemAreaElement?.closest("[data-problem-id]")?.getAttribute("data-problem-id") ?? null;
    const problemAreaValue = problemAreaElement?.getAttribute("data-problem-area") ?? null;
    const problemArea = isProblemAreaKind(problemAreaValue) ? problemAreaValue : null;

    const targetBlockId = target && canvas ? getClosestBlockId(target, canvas) : null;
    const paginationMarker = target?.closest("[data-page-break-marker]");
    const paginationBlockId = paginationMarker?.getAttribute("data-page-break-block-id") ?? null;
    const localColumnContextMenuLayout = measureLocalColumnContextMenuLayout(target, zoom / 100);

    // Every problem area (lead/prompt/hints/solution) shows the same problem menu — 改ページ/
    // 改段 insert+release live in it too now, so no area needs the old body-menu bypass.
    if (problemId && problemArea) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(problemId);
      setBodyContextMenu(null);

      const breakBlockId = paginationBlockId ?? targetBlockId;
      const breakTargetBlockId = breakBlockId
        ? paginationBlockId ?? getColumnBreakBeforeBlockIdForContextMenu({
          blockId: breakBlockId,
          blocks: pageDocument.content,
          units,
          isColumnFlow,
          metrics,
          pageStridePx: pageHeightPx + PAGE_GAP_PX,
          blockRects,
          paginationMarkerLayouts,
          textFlowBlockLayouts,
          unitLayouts,
          problemAreaColumnLayouts,
          localColumnContextMenuLayout,
        })
        : null;
      const breakTargetBlock = breakTargetBlockId ? findBlock(pageDocument, breakTargetBlockId) : null;
      const hasBreakTarget = !!breakTargetBlock && isBodyContextMenuBlock(breakTargetBlock) && hasBreakBefore(breakTargetBlock);

      setProblemContextMenu({
        problemId,
        area: problemArea,
        left: event.clientX,
        top: event.clientY,
        breakBlockId,
        selectionBlockIds: breakBlockId
          ? (canvas ? getSelectionScopedBlockIds(target, canvas, breakBlockId) : [breakBlockId])
          : [],
        breakTargetBlockId: hasBreakTarget ? breakTargetBlockId : null,
        nextBreakBefore: !hasBreakTarget,
      });
      return;
    }

    const blockId = paginationBlockId ?? targetBlockId ?? selectedId;
    if (!blockId) {
      setProblemContextMenu(null);
      setBodyContextMenu(null);
      return;
    }

    const block = findBlock(pageDocument, blockId);
    if (!block || !isBodyContextMenuBlock(block)) {
      setProblemContextMenu(null);
      setBodyContextMenu(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    openBodyContextMenu({
      blockId,
      clientX: event.clientX,
      clientY: event.clientY,
      paginationBlockId,
      localColumnLayout: localColumnContextMenuLayout,
      target,
    });
  }, [
    isOverlayEditing,
    isColumnFlow,
    blockRects,
    metrics,
    onSelect,
    openBodyContextMenu,
    paginationMarkerLayouts,
    pageDocument,
    pageHeightPx,
    problemAreaColumnLayouts,
    selectedId,
    textFlowBlockLayouts,
    unitLayouts,
    units,
    zoom,
  ]);

  /**
   * The handle is the pointer-driven twin of right-clicking the block: it selects, then opens
   * the very same menu — the problem menu for a problem, the body menu for everything else.
   */
  const openBlockHandleMenu = useCallback((blockId: string, handleElement: HTMLElement) => {
    const unit = findBlock(pageDocument, blockId);
    if (!unit) {
      return;
    }
    // リストの項目にはメニューが無い。項目を含むリストのメニューを出す。
    const block = unit.type === "listItem"
      ? (() => {
        const ownerId = dragIndex.units.get(blockId)?.container.ownerId ?? null;
        return ownerId ? findBlock(pageDocument, ownerId) : null;
      })()
      : unit;
    if (!block || block.type === "listItem") {
      return;
    }

    if (block.type === "problem") {
      const area = PROBLEM_AREA_ORDER.find((candidate) => shouldShowProblemArea(block, candidate));
      if (area) {
        openProblemActionMenu(block.id, area, handleElement);
      }
      return;
    }

    const rect = handleElement.getBoundingClientRect();
    openBodyContextMenu({ blockId: block.id, clientX: rect.right, clientY: rect.top });
  }, [dragIndex, openBodyContextMenu, openProblemActionMenu, pageDocument]);

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

  const updateBodyOverlay = useCallback((nextOverlay: PageOverlay, options?: OverlayChangeOptions) => {
    const overlayLayer = window.document.querySelector<HTMLElement>(".overlay-canvas-editor") ??
      overlayBackgroundLayerElement ??
      window.document.querySelector<HTMLElement>(".page-overlay-background-layer");
    const materialized = materializeEmptyProblemAreaOverlayAnchors(
      nextOverlay,
      pageDocument,
      overlayLayer,
      pageWidthPx,
      totalHeight,
      flowElement,
    );
    for (const addition of materialized.additions) {
      onAddProblemBlock(addition.problemId, addition.area, addition.block);
    }
    onOverlayChange(materialized.overlay, options);
  }, [flowElement, onAddProblemBlock, onOverlayChange, overlayBackgroundLayerElement, pageDocument, pageWidthPx, totalHeight]);

  const beginRunningRegionDrag = useCallback((
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    startClientY: number,
  ) => {
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

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = runningRegionDragRef.current;
      if (!drag) {
        return;
      }

      const deltaMm = ((moveEvent.clientY - drag.startClientY) / (zoom / 100)) / MM_TO_PX;
      const nextLayout = resizeRunningRegionLayout(drag, deltaMm);
      pageLayoutDraftRef.current = nextLayout;
      setPageLayoutDraft(nextLayout);
    };

    const handlePointerUp = () => {
      const nextLayout = pageLayoutDraftRef.current;
      runningRegionDragRef.current = null;
      if (nextLayout) {
        onPageLayoutChange(nextLayout);
      }
      pageLayoutDraftRef.current = null;
      setPageLayoutDraft(null);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [layout, onPageLayoutChange, zoom]);

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
    const baseLayout = pageLayoutDraftRef.current ?? layout;
    pageMarginDragRef.current = {
      edge,
      startClientX,
      startLeftMm: baseLayout.marginsMm.left,
      startRightMm: baseLayout.marginsMm.right,
      baseLayout,
    };

    const handlePointerMove = (moveEvent: PointerEvent) => {
      const drag = pageMarginDragRef.current;
      if (!drag) {
        return;
      }

      const deltaMm = ((moveEvent.clientX - drag.startClientX) / (zoom / 100)) / MM_TO_PX;
      const nextLayout = resizeHorizontalMarginsLayout(drag, deltaMm);
      pageLayoutDraftRef.current = nextLayout;
      setPageLayoutDraft(nextLayout);
    };

    const handlePointerUp = () => {
      const nextLayout = pageLayoutDraftRef.current;
      pageMarginDragRef.current = null;
      if (nextLayout) {
        onPageLayoutChange(nextLayout);
      }
      pageLayoutDraftRef.current = null;
      setPageLayoutDraft(null);
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }, [layout, onPageLayoutChange, zoom]);

  const startPageMarginDrag = useCallback((edge: PageMarginEdge, event: ReactPointerEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    beginPageMarginDrag(edge, event.clientX);
  }, [beginPageMarginDrag]);

  const handlePagePointerDownCapture = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }

    // ホワイトボードは常設の OverlayCanvasEditor が shape/空白の押下を直接所有する。
    // paper 用の preview → editor handoff は capture 層から呼ばない。
    if (isWhiteboard) {
      return;
    }

    // A click does not guarantee a preceding pointermove. Keep the exact click position so a
    // keyboard edit can re-resolve its affordance after the next committed layout revision.
    lastAffordancePointRef.current = { x: event.clientX, y: event.clientY };

    const target = event.target instanceof Element ? event.target : null;
    const overlayPoint = !isOverlayEditing && !runningRegionEditKind
      ? getOverflowOverlayPointFromClient(event.clientX, event.clientY)
      : null;
    const hitShape = overlayPoint ? getTopmostBodyModeOverlayHit(visibleBodyHitShapes, overlayPoint) : null;
    const bodyPointerRoute = resolveBodyPointerRoute({
      hitShapeId: hitShape?.id ?? null,
      selectedShapeIds: routableOverlayShapeIds,
      // 透過は「下の本文を触らせるため」の規約なので、下に本文があるときだけ効かせる。用紙の外に
      // はみ出したオブジェクトも余白のオブジェクトも、ここが false になって素のクリックで掴める。
      // 図形に当たっていない押下では経路が本文で確定するので、その分の走査は省く。
      pointerOverBodyText: hitShape
        ? !!findEditableElementUnderPoint({ x: event.clientX, y: event.clientY })
        : false,
      modifiers: {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        meta: event.metaKey,
        shift: event.shiftKey,
      },
    });
    if (activeBlockSelection.ids.length > 0 && !shouldKeepBlockSelectionOnPagePointerDown({
      isBlockSelectionControl: !!target?.closest(BLOCK_SELECTION_KEEP_SELECTOR),
      isOverlayEditing,
      isOverlaySelectionTarget: !!target?.closest(OVERLAY_SELECTION_KEEP_SELECTOR),
      hitShapeId: hitShape?.id ?? null,
      bodyPointerRoute,
    })) {
      setBlockSelection(EMPTY_BLOCK_SELECTION);
    }

    if (isOverlayEditing) {
      return;
    }

    if (!target?.closest(".ProseMirror")) {
      const activeElement = canvasRef.current?.ownerDocument.activeElement;
      if (activeElement instanceof HTMLElement && activeElement.classList.contains("ProseMirror")) {
        const ownerWindow = activeElement.ownerDocument.defaultView ?? window;
        const startPoint = { x: event.clientX, y: event.clientY };
        ownerWindow.addEventListener("pointerup", (upEvent) => {
          const moved = Math.hypot(upEvent.clientX - startPoint.x, upEvent.clientY - startPoint.y) > 3;
          if (!moved && activeElement.ownerDocument.activeElement === activeElement) {
            activeElement.blur();
          }
        }, { once: true });
      }
    }
    if (target?.closest(".page-running-direct-editor, .page-context-menu, .problem-context-menu, .selection-action-popover")) {
      return;
    }

    const targetIsLayoutControl = !!target?.closest(".page-margin-ruler, .page-running-edge");
    const point = getPagePointerContext({
      canvas: canvasRef.current,
      clientX: event.clientX,
      clientY: event.clientY,
      metrics,
      pageCount,
      pageHeightPx,
    });

    if (!targetIsLayoutControl && point && isPageBodyPoint(point, metrics)) {
      if (runningRegionEditKind) {
        editRunningRegion(null);
      }
      if (horizontalMarginEditPageNumber !== null) {
        setHorizontalMarginEditPageNumber(null);
      }
    }

    if (targetIsLayoutControl) {
      return;
    }

    if (
      !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey
      && !hitShape
      && !target?.closest(".ProseMirror")
    ) {
      // ページ余白 (エディタ外) への素のクリックは跨ぎ選択の解除。単一エディタの「余白
      // クリックで選択解除」に合わせる。click イベントは跨ぎドラッグでも共通祖先で発火して
      // 区別できない (section の onClick ガード) ため、経路はドラッグと衝突しない
      // pointerdown に置く。図形ヒットは除外 — 図形操作中は本文選択を保持する契約。
      clearTextRunSpanOnOutsidePointerDown();
    }

    if (!runningRegionEditKind && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) {
      const canvas = canvasRef.current;
      // `resolveBodyPointerRoute` が経路の唯一の出典。ここは修飾キーなしの枝なので、実質
      // 「当たった図形が選択済みか」だけが効く。Ctrl/Cmd は下の枝が同じ規約で拾う。
      if (canvas && hitShape && bodyPointerRoute === "overlayShape") {
        pageDoubleTapRef.current = null;
        startOverlayPreviewPointerHandoff(event, canvas.getBoundingClientRect(), hitShape.id);
        return;
      }
      if (hitShape) {
        // 透過するのは本文へのポインタだけ。ページ余白やヘッダー帯に置かれた図形の上では
        // `getPageDoubleTapHit` が margin / runningRegion を返すので、そのまま落とすと図形を
        // ダブルクリックしただけで余白ドラッグやヘッダー編集が始まってしまう。候補を捨てて
        // ページ側のダブルタップ操作には渡さない。
        pageDoubleTapRef.current = null;
      }
    }

    if (event.ctrlKey || event.metaKey) {
      const canvas = canvasRef.current;
      if (!canvas) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      // 図形に当たった Ctrl/Cmd クリックは、その図形を掴む要求として渡す。
      //
      // 掴んだ id を渡さずマーキーだけを要求すると、オーバーレイが載った後にもう一度
      // 当たり判定をやり直すことになる。ところが載った瞬間に図形は動く (本文モードの
      // プレビューと編集面ではブリードの分だけ座標系が違う) ので、押した場所には既に
      // 図形が無く、選択されないままマーキーが開いたままになる —「本文を選んだまま
      // Cmd+クリックで図形を足す」が 2 クリック必要だったのはこれが理由。
      // 何にも当たっていない Ctrl/Cmd ドラッグは従来どおりマーキー。
      requestOverlayPreviewSelection(
        canvas.getBoundingClientRect(),
        event.clientX,
        event.clientY,
        false,
        false,
        hitShape === null,
        undefined,
        hitShape?.id,
      );
      return;
    }

    const hit = point ? getPageDoubleTapHit(point, visibleLayout, metrics) : null;
    if (!hit) {
      pageDoubleTapRef.current = null;
      return;
    }

    const previous = pageDoubleTapRef.current;
    const current: PageDoubleTapCandidate = {
      hit,
      timeStamp: event.timeStamp,
      clientX: event.clientX,
      clientY: event.clientY,
    };
    const isDoubleTap = isPageDoubleTap(
      previous,
      current,
      PAGE_DOUBLE_TAP_MS,
      PAGE_DOUBLE_TAP_DISTANCE_PX,
    );

    pageDoubleTapRef.current = current;

    if (!isDoubleTap) {
      return;
    }

    pageDoubleTapRef.current = null;
    event.preventDefault();
    event.stopPropagation();

    if (hit.type === "runningRegion") {
      if (visibleLayout[hit.kind]?.enabled) {
        editRunningRegion(hit.kind, hit.pageNumber);
      } else {
        enableRunningRegion(hit.kind, hit.pageNumber);
      }
      return;
    }

    editRunningRegion(null);
    setHorizontalMarginEditPageNumber(hit.pageNumber);
    beginPageMarginDrag(hit.edge, event.clientX);
  }, [
    activeBlockSelection.ids.length,
    beginPageMarginDrag,
    editRunningRegion,
    enableRunningRegion,
    getOverflowOverlayPointFromClient,
    horizontalMarginEditPageNumber,
    isOverlayEditing,
    metrics,
    pageCount,
    pageHeightPx,
    requestOverlayPreviewSelection,
    routableOverlayShapeIds,
    runningRegionEditKind,
    startOverlayPreviewPointerHandoff,
    visibleBodyHitShapes,
    isWhiteboard,
    visibleLayout,
  ]);

  useEffect(() => {
    if (!problemContextMenu && !bodyContextMenu) {
      return;
    }

    const closeMenu = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".problem-context-menu, .page-context-menu")) {
        return;
      }
      setProblemContextMenu(null);
      setBodyContextMenu(null);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setProblemContextMenu(null);
        setBodyContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", closeMenu);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeMenu);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [bodyContextMenu, problemContextMenu]);

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
  const hasCommentAnchorRequest = !!onCommentAnchorRequest;
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
  }, [hasCommentAnchorRequest, selectionExtension]);

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
  }, [
    commentAnchorOwnershipRevision,
    document,
    hasCommentAnchorRequest,
    isOverlayEditing,
    selectionExtension,
    selectedId,
    selectedInlineMath,
    totalHeight,
    zoom,
  ]);

  // Whiteboard pan/zoom handlers
  const whiteboardPanStartRef = useRef<{ x: number; y: number } | null>(null);
  const whiteboardPanningRef = useRef(false);

  /**
   * 紙面 (`.a4-page-sheet`) に敷く下地。
   *
   * **倍率は 100 固定**。ホワイトボードの切り出しは紙面 1 CSS px = ワールド 1px になるよう
   * 用紙サイズを決めており、画面のズームは `--editor-zoom` の transform で紙ごと拡大される。
   * ここで画面倍率を掛けると紙の中だけ二重にスケールされてマス目の大きさが狂う。
   * inline は個別プロパティで渡す — `background` ショートハンドにすると
   * `.a4-page-sheet` の `background: #ffffff` を巻き添えで消してしまう。
   */
  const sheetBackgroundStyle = useMemo(() => {
    const pattern = getWhiteboardBackgroundStyle({
      background: visibleLayout.background,
      zoom: 100,
      panX: 0,
      panY: 0,
    });
    if (!pattern) {
      return null;
    }

    return {
      ...pattern,
      // 既定の `padding-box` だと、用紙の 1px ボーダーぶんパターンだけが内側へずれる。
      // 図形は用紙のボーダーボックス原点から置かれるので、そのままではマス目が図形に対して
      // ちょうど 1px 右下へずれた紙が出る (切り出し原点をセルへ寄せた意味が消える)。
      backgroundOrigin: "border-box" as const,
      // Chromium の印刷ダイアログは「背景のグラフィック」が既定 OFF で、これが無いと
      // ブラウザ印刷で下地だけ落ちた紙になる (Electron の PDF 書き出しは printBackground:true
      // なので無事だが、web の /print からの印刷は素通りする)。
      // ここに置くのはパターンがあるときだけ — 用紙全体に付けると紙モードの印刷で
      // 影やボーダーまで刷られてしまう。
      printColorAdjust: "exact" as const,
    };
  }, [visibleLayout.background]);

  // しきい値で「描かない」を決めるので CSS 変数の算術では書けない (whiteboard-background.ts のコメント)。
  const whiteboardBackgroundStyle = useMemo(() => getWhiteboardBackgroundStyle({
    background: visibleLayout.background,
    zoom,
    panX: whiteboardPanX,
    panY: whiteboardPanY,
  }), [visibleLayout.background, zoom, whiteboardPanX, whiteboardPanY]);

  // ホイールとズーム倍率は EditorShell の単一カメラ経路が持つ。ここに実装を戻さないこと:
  // React の `onWheel` はルートへ passive で張られるため `preventDefault()` が効かず、
  // 加えて EditorShell の capture リスナに先に食われて到達しない。
  const setWhiteboardViewportRef = useCallback((node: HTMLDivElement | null) => {
    setCanvasRef(node);
    onWhiteboardViewportChange?.(node);
  }, [onWhiteboardViewportChange, setCanvasRef]);

  const whiteboardDragAutoScrollPanBy = useMemo(
    () => onWhiteboardPanBy ? createCameraDragAutoScrollPanBy(onWhiteboardPanBy) : undefined,
    [onWhiteboardPanBy],
  );

  useEffect(() => {
    if (!isWhiteboard || !canvasElement) {
      return;
    }

    const timeout = window.setTimeout(() => {
      const scale = Math.max(zoom / 100, 0.01);
      setWhiteboardTextRepaint((current) => ({
        revision: (current?.revision ?? 0) + 1,
        bounds: {
          x: -whiteboardPanX / scale,
          y: -whiteboardPanY / scale,
          w: canvasElement.clientWidth / scale,
          h: canvasElement.clientHeight / scale,
        },
      }));
    }, WHITEBOARD_ZOOM_SETTLE_MS);

    return () => window.clearTimeout(timeout);
  }, [canvasElement, isWhiteboard, whiteboardPanX, whiteboardPanY, zoom]);

  const handleWhiteboardMouseDown = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.button !== 1) {
      // Only middle button to start panning
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    whiteboardPanStartRef.current = { x: event.clientX, y: event.clientY };
    whiteboardPanningRef.current = true;
  }, []);

  const handleWhiteboardPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented || event.target !== event.currentTarget) {
      return;
    }

    setOverlayEditing(false);
    onSelect(null);
  }, [onSelect]);

  const handleWhiteboardMouseMove = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (!whiteboardPanningRef.current || !whiteboardPanStartRef.current) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const dx = event.clientX - whiteboardPanStartRef.current.x;
    const dy = event.clientY - whiteboardPanStartRef.current.y;
    whiteboardPanStartRef.current = { x: event.clientX, y: event.clientY };
    onWhiteboardPanBy?.(dx, dy);
  }, [onWhiteboardPanBy]);

  const handleWhiteboardMouseUp = useCallback(() => {
    whiteboardPanningRef.current = false;
    whiteboardPanStartRef.current = null;
  }, []);

  if (isWhiteboard) {
    return (
      <section className="page-mode whiteboard-mode" style={pageStyle}>
        <div className="page-stack whiteboard-page-stack">
          <div
            tabIndex={0}
            className="page-canvas whiteboard-page-canvas"
            ref={setWhiteboardViewportRef}
            style={{
              "--whiteboard-pan-x": `${whiteboardPanX}px`,
              "--whiteboard-pan-y": `${whiteboardPanY}px`,
              "--whiteboard-zoom": `${zoom / 100}`,
              "--whiteboard-canvas-width": "20000px",
              "--whiteboard-canvas-height": "20000px",
            } as CSSProperties}
            onContextMenuCapture={handlePageContextMenu}
            onDragOver={handlePageDragOver}
            onDrop={handlePageDrop}
            onPointerMove={updateLastPagePointerPoint}
            onPointerDownCapture={handlePagePointerDownCapture}
            onPointerDown={handleWhiteboardPointerDown}
            onMouseDown={handleWhiteboardMouseDown}
            onMouseMove={handleWhiteboardMouseMove}
            onMouseUp={handleWhiteboardMouseUp}
            onMouseLeave={handleWhiteboardMouseUp}
          >
            <div className="whiteboard-background" style={whiteboardBackgroundStyle ?? undefined} />
            <div className="whiteboard-canvas page-overlay-layer editing">
              <OverlayCanvasEditor
                key="overlay-canvas"
                externalRevision={historyRevision}
                documentId={document.docId}
                overlay={overlay}
                canvasWidth={20000}
                canvasHeight={20000}
                bleedValues={{ x: 0, top: 0 }}
                imageInsertAreaWidth={20000}
                imageInsertAreaHeight={20000}
                blockAnchorScopeElement={null}
                bodyBlockRects={null}
                bodyAnchorableBlocks={null}
                visiblePageRange={null}
                textRepaint={whiteboardTextRepaint}
                pageHeightPx={20000}
                pageGapPx={0}
                showAnchorHandles={false}
                autoScrollPanBy={whiteboardDragAutoScrollPanBy}
                autoScrollViewportElement={canvasElement}
                syncBlockAnchors={false}
                verticalSnapGuides={[]}
                commandRequest={runningRegionEditKind ? null : overlayCommandRequest}
                imageRequest={runningRegionEditKind ? null : overlayImageRequest}
                actionRequest={runningRegionEditKind ? null : shortcutOverlayActionRequest ?? overlayActionRequest}
                arrangeShortcutLabels={overlayArrangeShortcutLabels}
                acceptsStylePreview={!runningRegionEditKind}
                selectPointRequest={selectPointRequest}
                backgroundLayerElement={overlayBackgroundLayerElement}
                onCommandHandled={onOverlayCommandHandled}
                onImageHandled={onOverlayImageHandled}
                onActionHandled={handleOverlayActionHandled}
                onSelectPointHandled={handleSelectPointHandled}
                onRequestTextMode={handleRequestTextMode}
                onModeStatusChange={handleBodyOverlayModeStatusChange}
                onSelectionSummaryChange={handleOverlaySelectionSummaryChange}
                onSelectedCountChange={handleOverlaySelectedCountChange}
                onActiveToolChange={onOverlayActiveToolChange}
                onMaterialSaveRequest={onMaterialSaveRequest ? () => onMaterialSaveRequest() : undefined}
                onChange={updateBodyOverlay}
                editPolicy={editorExtensions?.overlayEditPolicy}
                shapeDecorations={editorExtensions?.overlayShapeDecorations}
                diffShapeClassNames={overlayShapeClassNames}
              />
              <OverlayPreview
                resolvedView={overlayView}
                visiblePageRange={{ start: -999, end: 9999, overscan: 0 }}
                stackLayer="all"
                renderShapes={false}
                ghostShapes={overlayPresentation?.ghostShapes}
                pinnedShapeIds={pinnedOverlayShapeIds}
                commentThreads={displayedCommentThreads}
                highlightedCommentThreadId={highlightedCommentThreadId}
              />
              {overlayPresentation?.floatingContent}
            </div>
            <div className="whiteboard-canvas-controls">
            {/* コミットの土台は draft ではなく `layout`。ルーラーのドラッグ中など
                プレビュー用の draft が生きている状態で押されたら、それを一緒に
                確定させてしまう (他の onPageLayoutChange 呼び出しも layout 基準)。 */}
            <WhiteboardBackgroundControl
              value={layout.background ?? "dots"}
              onChange={(background) => onPageLayoutChange(
                { ...layout, background },
                { silent: true },
              )}
            />
            <div className="whiteboard-zoom-controls">
              <button
                type="button"
                aria-label={tEditorText("pageCanvas.zoomOut")}
                title={tEditorText("pageCanvas.zoomOut")}
                onClick={() => onWhiteboardZoomRequest?.((current) => current - KEYBOARD_ZOOM_STEP)}
              >
                <Minus size={14} />
              </button>
              <output>{Math.round(zoom)}%</output>
              <button
                type="button"
                aria-label={tEditorText("pageCanvas.zoomIn")}
                title={tEditorText("pageCanvas.zoomIn")}
                onClick={() => onWhiteboardZoomRequest?.((current) => current + KEYBOARD_ZOOM_STEP)}
              >
                <Plus size={14} />
              </button>
              <button
                type="button"
                className="whiteboard-reset-button"
                aria-label={tEditorText("pageCanvas.resetView")}
                title={tEditorText("pageCanvas.resetView")}
                onClick={() => onWhiteboardCameraReset?.()}
              >
                <Maximize size={14} />
                <span>{tEditorText("pageCanvas.reset")}</span>
              </button>
            </div>
            </div>
          </div>
        </div>
        {selectionActionPopover && (
          <div
            className="selection-action-popover"
            style={{
              left: `${selectionActionPopover.position.left}px`,
              top: `${selectionActionPopover.position.top}px`,
            }}
            onMouseDown={(event) => event.preventDefault()}
          >
            {selectionActionPopover.extensionAction?.render(selectionActionPopover.position)}
            {selectionActionPopover.commentAnchor && onCommentAnchorRequest && (
              <button
                type="button"
                title={tEditorText("pageCanvas.addComment")}
                aria-label={tEditorText("pageCanvas.addComment")}
                onClick={(event) => {
                  event.stopPropagation();
                  const anchor = selectionActionPopover.commentAnchor;
                  if (anchor) onCommentAnchorRequest(anchor);
                }}
              >
                <MessageSquarePlus size={16} aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </section>
    );
  }

  return (
    <ProblemNumberingProvider numbers={problemNumbers}>
    <EditorExtensionProvider value={editorExtensions}>
      <TextRunSelectionOverlay />
      <section
        className={`page-mode${isPagedRender ? " paged-render" : ""}`}
        style={pageStyle}
        data-overlay-editing={isOverlayEditing ? "true" : "false"}
        data-paged-render={isPagedRender ? "true" : undefined}
        onClick={() => {
          // 跨ぎドラッグは mousedown/mouseup のターゲットが別エディタになり、click は
          // 共通祖先 (ここ) で発火する。そのまま選択解除すると、跨ぎ選択が確定した瞬間に
          // selectedId が消えてリボンの書式ボタンが全部 disabled になる (選択ブロックは
          // アンカー側の mousedown で選ばれている) ので、span が生きている間は保つ。
          if (!isMultiEditorTextRunSpan()) {
            onSelect(null);
          }
        }}
      >
      <div
        ref={setStackRef}
        className={`page-stack ${showComments && commentPanel ? "comments-visible" : ""}`}
        style={{
          '--overlay-bleed-x': `${bleed.x}px`,
          '--overlay-bleed-top': `${bleed.top}px`,
        } as React.CSSProperties}
        onPointerDownCapture={handlePagePointerDownCapture}
      >
        <div
          className="page-canvas"
          ref={setCanvasRef}
          style={{ height: `${totalHeight}px` }}
          data-page-count={pageCount}
          data-page-height={pageHeightPx}
          data-page-stride={pageHeightPx + PAGE_GAP_PX}
          onContextMenuCapture={handlePageContextMenu}
          onDragOver={handlePageDragOver}
          onDrop={handlePageDrop}
          onPointerMove={updateLastPagePointerPoint}
          onPointerLeave={() => {
            if (!blockDrag.isDragging()) {
              lastAffordancePointRef.current = null;
              setBlockAffordance(EMPTY_BLOCK_AFFORDANCE_HOVER);
            }
          }}
          onMouseDown={(event) => {
            if (event.button === 0 && !isOverlayEditing) {
              setProblemContextMenu(null);
              setBodyContextMenu(null);
              setBlockSelection(EMPTY_BLOCK_SELECTION);
              onSelect(null);
            }
          }}
        >
          <div className="page-backdrop" aria-hidden="true">
            {visiblePageIndexes.map((index) => (
              <div
                className="a4-page-sheet"
                key={index}
                style={{ top: `${index * (pageHeightPx + PAGE_GAP_PX)}px`, ...sheetBackgroundStyle }}
              >
                <ColumnGuides metrics={metrics} />
                <PageColumnRules metrics={metrics} />
                {!(runningRegionEditKind === "header" && index + 1 === runningRegionEditPageNumber) && (
                  <PageRunningRegionView
                    region={visibleLayout.header}
                    kind="header"
                    title={pageDocument.metadata.title}
                    pageNumber={index + 1}
                    totalPages={pageCount}
                    metrics={metrics}
                    mathFractionSizing={mathFractionSizing}
                  />
                )}
                {!(runningRegionEditKind === "footer" && index + 1 === runningRegionEditPageNumber) && (
                  <PageRunningRegionView
                    region={visibleLayout.footer}
                    kind="footer"
                    title={pageDocument.metadata.title}
                    pageNumber={index + 1}
                    totalPages={pageCount}
                    metrics={metrics}
                    mathFractionSizing={mathFractionSizing}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="page-overlay-background-layer" ref={setOverlayBackgroundLayerElement} aria-hidden="true">
            {!pageOverlayEditing && (
              <OverlayPreview
                resolvedView={overlayView}
                visiblePageRange={visiblePageRange}
                stackLayer="background"
                pinnedShapeIds={pinnedOverlayShapeIds}
                commentThreads={displayedCommentThreads}
                highlightedCommentThreadId={highlightedCommentThreadId}
                diffShapeClassNames={overlayShapeClassNames}
                shapeDecorations={editorExtensions?.overlayShapeDecorations}
                onPointerDown={handleOverlayPreviewPointerDown}
                onDoubleClick={handleOverlayPreviewDoubleClick}
              />
            )}
          </div>

          {!pageOverlayEditing && (
            <div className="page-layout-controls" aria-label={tEditorText("running.controlsAria")}>
              {runningRegionEditKind && (
                <div className="page-layout-mode-chip">
                  {tEditorText("running.editing", { replace: {
                    region: tEditorText(runningRegionEditKind === "header" ? "running.header" : "running.footer"),
                  } })}
                </div>
              )}
              {visiblePageIndexes.map((index) => (
                <RunningRegionControls
                  key={`running-region-controls-${index}`}
                  marginEditing={horizontalMarginEditPageNumber === index + 1}
                  layout={visibleLayout}
                  metrics={metrics}
                  pageTopPx={index * (pageHeightPx + PAGE_GAP_PX)}
                  pageNumber={index + 1}
                  editingKind={runningRegionEditKind}
                  editingPageNumber={runningRegionEditPageNumber}
                  focusRequest={runningRegionFocusRequest}
                  historyRevision={historyRevision}
                  onEdit={editRunningRegion}
                  onBlocksChange={updateRunningRegionBlocks}
                  onContentHeightChange={resizeRunningRegionForContent}
                  onEdgePointerDown={startRunningRegionDrag}
                  onMarginPointerDown={startPageMarginDrag}
                  overlayCommandRequest={runningRegionEditKind ? overlayCommandRequest : null}
                  overlayImageRequest={runningRegionEditKind ? overlayImageRequest : null}
                  overlayActionRequest={runningRegionEditKind ? overlayActionRequest : null}
                  overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
                  runningRegionOverlayEditing={activeRunningRegionOverlayEditing}
                  onRunningRegionOverlayEditingChange={setRunningRegionOverlayEditing}
                  onRunningRegionOverlayChange={updateRunningRegionOverlay}
                  onOverlayCommandHandled={onOverlayCommandHandled}
                  onOverlayImageHandled={onOverlayImageHandled}
                  onOverlayActionHandled={onOverlayActionHandled}
                  onOverlayModeStatusChange={onOverlayModeStatusChange}
                  onOverlaySelectionSummaryChange={handleOverlaySelectionSummaryChange}
                  onOverlayActiveToolChange={onOverlayActiveToolChange}
                />
              ))}
            </div>
          )}

          <div className="box-layout-section-side-note-layer">
            {Object.entries(boxLayoutSectionSideNoteLayouts).map(([sectionId, noteLayout]) => {
              const section = findBlock(pageDocument, sectionId);
              if (!section || section.type !== "layoutSection") {
                return null;
              }
              return (
                <div
                  key={`box-layout-section-side-note-${sectionId}`}
                  className={`box-layout-section-side-note-anchor ${selectedId === sectionId ? "selected" : ""}`}
                  data-box-layout-section-side-note={sectionId}
                  style={{
                    ...getFlowLayoutStyle(noteLayout),
                    "--problem-area-page-x": `${getPageColumnSideNoteOffsetPx(
                      noteLayout.x,
                      noteLayout.x,
                      metrics,
                    )}px`,
                  } as CSSProperties}
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(sectionId);
                  }}
                >
                  <div className="layout-section-side-note">
                    <span>{tEditorText("block.columns", { replace: { columns: getLayoutSectionColumnCount(section) } })}</span>
                  </div>
                </div>
              );
            })}
          </div>

          <div
            className={`page-flow ${isColumnFlow ? "columns-active" : ""}`}
            ref={setFlowRef}
          >
            {isColumnFlow && Object.entries(paginationMarkerLayouts).map(([blockId, markerLayout]) => (
              <div
                key={`page-break-marker-${blockId}`}
                className="page-flow-page-break-marker"
                style={getFlowLayoutStyle(markerLayout)}
              >
                <PageBreakMarker blockId={blockId} kind="columnBreak" onRemove={markerRemoveHandler} />
              </div>
            ))}
            {units.map((unit) =>
              unit.type === "textFlow" ? (
                <div
                  key={`text-flow-${isColumnFlow ? "column-" : ""}${unit.renderKey ?? unit.id}`}
                  className={`${isColumnFlow ? "page-flow-unit" : ""} ${spaceAfterFollowerUnitClass(unit.id)}`.trim() || undefined}
                  data-flow-unit-id={unit.id}
                  data-text-run-group={textRunGroupByUnitId.get(unit.id)?.groupId}
                  style={getFlowUnitStyle(unit, isColumnFlow, unitLayouts, metrics)}
                >
                  {largePasteHydration
                    && !largePasteHydration.hydratedUnitIds.has(unit.id)
                    && unit.blocks.every((block) => largePasteHydration.deferredBlockIds.has(block.id)) ? (
                      <DeferredLargePasteTextFlowUnit
                        blocks={unit.blocks}
                        breakGapPx={isColumnFlow ? 0 : gaps[unit.blocks[0]?.id ?? ""] ?? 0}
                        onVisible={hydrateLargePasteUnit}
                        unitId={unit.id}
                      />
                    ) : (
                      <TextFlowWithInlineContent
                        blocks={unit.blocks}
                        headingNumbers={unit.headingNumbers}
                        selectedId={selectedId}
                        textRunGroupId={textRunGroupByUnitId.get(unit.id)?.groupId}
                        textRunOrder={textRunGroupByUnitId.get(unit.id)?.order}
                        textRunUnitId={unit.id}
                        textRunScopeId="document"
                        mathFractionSizing={mathFractionSizing}
                        commentThreads={displayedCommentThreads}
                        activeCommentThreadId={activeCommentThreadId}
                        highlightedCommentThreadId={highlightedCommentThreadId}
                        historyRevision={historyRevision}
                        breakGaps={isColumnFlow ? undefined : gaps}
                        paginationBeforeIds={[
                          ...(isColumnFlow ? [] : getPageBreakBeforeIds(unit.blocks)),
                          ...getNestedPageBreakBeforeIds(unit.blocks),
                        ]}
                        paginationMarkerKind={resolvePageBreakMarkerKind(isColumnFlow)}
                        paginationMarkerKinds={getNestedPageBreakBeforeKinds(unit.blocks, isColumnFlow ? "columnBreak" : "pageBreak")}
                        columnFlowBlockLayouts={isColumnFlow ? getTextFlowColumnBlockLayouts(unit, textFlowBlockLayouts) : undefined}
                        boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(unit.blocks, boxFragmentSourceLayouts)}
                        showPlaceholder={!isColumnFlow && units[0]?.type === "textFlow" && unit.id === units[0].id}
                        onSelect={onSelect}
                        onCommentThreadSelect={onCommentThreadSelect}
                        onChange={handleTextFlowChange}
                        onFocusChange={handleTextFlowFocusChange}
                        onBoundaryDelete={handleTextFlowBoundaryDelete}
                        materials={materials}
                        onMaterialInsert={handleMaterialInsert}
                        enableSelectionFormatMenu={false}
                        enableProblemCommands
                        onProblemCommand={onProblemCommand}
                        onBodyBlockCommand={onBodyBlockCommand}
                        enableHeadingCommands
                        onHeadingCommand={onHeadingCommand}
                        inlineContentByTargetId={flowInlineContentByTargetId}
                        changeDecorationState={textFlowChangeDecorationState}
                      />
                    )}
                </div>
              ) : unit.type === "layoutSection" || unit.type === "problemLayoutSection" ? (
                <LayoutSectionFlowUnit
                  key={isColumnFlow ? `column-${unit.id}` : unit.id}
                  unit={unit}
                  textRunAssignment={textRunGroupByUnitId.get(unit.id)}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  isColumnFlow={isColumnFlow}
                  gaps={gaps}
                  columnLayout={problemAreaColumnLayouts[unit.id]}
                  boxFragmentSourceLayouts={boxFragmentSourceLayouts}
                  layoutStyle={getFlowUnitStyle(unit, isColumnFlow, unitLayouts, metrics)}
                  spaceAfterFollowerClass={spaceAfterFollowerUnitClass(unit.id)}
                  pageColumnGapPx={metrics.flow.columnGapPx}
                  pageColumnGapMm={metrics.flow.columnGapMm}
                  pageContentHeightPx={metrics.content.heightPx}
                  sideNoteOffsetPx={getProblemAreaSideNoteOffsetPx(unit, isColumnFlow, unitLayouts, metrics)}
                  onSelect={onSelect}
                  onChange={updateLayoutSectionBlocks}
                  onLayoutChange={(sectionId, updater) => onChange(sectionId, updater)}
                  onResizeColumns={onResizeLayoutColumns}
                  onRemoveBreak={markerRemoveHandler}
                  commentThreads={displayedCommentThreads}
                  activeCommentThreadId={activeCommentThreadId}
                  highlightedCommentThreadId={highlightedCommentThreadId}
                  onCommentThreadSelect={onCommentThreadSelect}
                  materials={materials}
                  onMaterialInsert={handleMaterialInsert}
                  onHeadingCommand={onHeadingCommand}
                  inlineContentByTargetId={flowInlineContentByTargetId}
                  changeDecorationState={textFlowChangeDecorationState}
                />
              ) : unit.type === "problemArea" ? (
                <ProblemAreaFlowUnit
                  key={isColumnFlow ? `column-${unit.id}` : unit.id}
                  unit={unit}
                  textRunAssignment={textRunGroupByUnitId.get(unit.id)}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  isColumnFlow={isColumnFlow}
                  gaps={gaps}
                  boxFragmentSourceLayouts={boxFragmentSourceLayouts}
                  columnFlowBlockLayouts={isColumnFlow ? pickTextFlowColumnBlockLayouts(unit.blocks, textFlowBlockLayouts) : undefined}
                  frameFragments={frameFragmentLayouts[unit.id]}
                  layoutStyle={getFlowUnitStyle(unit, isColumnFlow, unitLayouts, metrics)}
                  spaceAfterFollowerClass={spaceAfterFollowerUnitClass(unit.id)}
                  sideNoteOffsetPx={getProblemAreaSideNoteOffsetPx(unit, isColumnFlow, unitLayouts, metrics, textFlowBlockLayouts)}
                  draftMinHeightMm={problemAreaHeightDrafts[problemAreaDraftKey(unit.problem.id, unit.area)]}
                  pageContentHeightPx={metrics.content.heightPx}
                  onSelect={onSelect}
                  onChange={updateProblemAreaBlocks}
                  onRemoveBreak={markerRemoveHandler}
                  onResizeStart={startProblemAreaResize}
                  onActionMenuOpen={openProblemActionMenu}
                  inlineContentByTargetId={flowInlineContentByTargetId}
                  afterInlineContent={getProblemAfterInlineContent(
                    unit.problem.id,
                    unit.isLastProblemArea,
                    flowInlineContentByTargetId,
                  )}
                  commentThreads={displayedCommentThreads}
                  activeCommentThreadId={activeCommentThreadId}
                  highlightedCommentThreadId={highlightedCommentThreadId}
                  onCommentThreadSelect={onCommentThreadSelect}
                  materials={materials}
                  onMaterialInsert={handleMaterialInsert}
                  changeDecorationState={textFlowChangeDecorationState}
                />
              ) : (
                <div
                  id={unit.block.id}
                  data-page-block=""
                  data-flow-unit-id={unit.id}
                  className={`${isColumnFlow ? "page-flow-unit" : ""} ${spaceAfterFollowerUnitClass(unit.id)}`.trim() || undefined}
                  key={isColumnFlow ? `column-${unit.id}` : unit.block.id}
                  style={getFlowUnitStyle(unit, isColumnFlow, unitLayouts, metrics) ??
                    (gaps[unit.block.id] ? { marginTop: `${gaps[unit.block.id]}px` } : undefined)}
                >
                  {!isColumnFlow && hasBreakBefore(unit.block) && (
                    <PageBreakMarker blockId={unit.block.id} onRemove={markerRemoveHandler} />
                  )}
                  <BlockEditor
                    block={unit.block}
                    selectedId={selectedId}
                    historyRevision={historyRevision}
                    onSelect={onSelect}
                    onChange={onChange}
                    onDelete={onDelete}
                    onDuplicate={onDuplicate}
                    onMove={onMove}
                    onAddProblemBlock={onAddProblemBlock}
                  />
                  <BlockCommentBackground
                    threads={getCommentThreadsForBlock(displayedCommentThreads, unit.block.id)}
                    activeThreadId={highlightedCommentThreadId}
                  />
                </div>
              ),
            )}
          </div>

          {/*
            下端つまみのドラッグ中、この層に印は付かない。断片は「ページ (段) をまたいだ続き」
            なので、掴んだブロックと同じページ・同じ段には原理的に存在しない = 追従集合に
            入らない (`resolveSpaceAfterPreviewCohort`)。
          */}
          {editorBoxBlockFragments.length > 0 && (
            <div className="page-box-fragment-layer">
              {editorBoxBlockFragments.map((fragment) => {
                const problemAreaSource = problemAreaFlowBlocksById.get(fragment.blockId);
                const block = boxBlocksById.get(fragment.blockId)
                  ?? topLevelTextBlocksById.get(fragment.blockId)
                  ?? problemAreaSource?.block
                  ?? unitTextFlowBlocksById.get(fragment.blockId);
                return block ? (
                  <EditorBoxBlockFragmentPreview
                    textRunOrder={unitOrderByBlockId.get(fragment.blockId)}
                    key={`${fragment.blockId}:${fragment.fragmentIndex}`}
                    block={block}
                    fragment={fragment}
                    historyRevision={historyRevision}
                    selectedId={selectedId}
                    onSelect={onSelect}
                    changeDecorationState={textFlowChangeDecorationState}
                    pagedRender={isPagedRender}
                    paginationMarkerKind={resolvePageBreakMarkerKind(isColumnFlow)}
                    fragmentPageIndex={getPageIndexForY(fragment.y, pageHeightPx + PAGE_GAP_PX)}
                  />
                ) : null;
              })}
            </div>
          )}

          {!isPagedRender && <div className="page-block-drag-ghost-layer" ref={ghostLayerRef} aria-hidden="true" />}
          {!isPagedRender && (blockAffordancesEnabled || activeBlockSelection.boxes.length > 0 || blockDrag.session) && (
            <div className="page-block-affordance-layer">
              {blockDrag.session?.sources.map((source, index) => (
                <div
                  key={`block-drag-source-${index}`}
                  className="page-block-drag-source-veil"
                  aria-hidden="true"
                  style={{
                    top: `${source.top}px`,
                    left: `${source.left}px`,
                    width: `${Math.max(0, source.right - source.left)}px`,
                    height: `${Math.max(0, source.bottom - source.top)}px`,
                  }}
                />
              ))}
              {blockDrag.session?.resolution && (
                <div
                  className="page-block-drop-line"
                  data-orientation={blockDrag.session.resolution.indicator.orientation}
                  data-target-kind={blockDrag.session.resolution.target.kind}
                  aria-hidden="true"
                  style={blockDrag.session.resolution.indicator.orientation === "horizontal"
                    ? {
                      top: `${blockDrag.session.resolution.indicator.top}px`,
                      left: `${blockDrag.session.resolution.indicator.left}px`,
                      width: `${blockDrag.session.resolution.indicator.width}px`,
                    }
                    : {
                      top: `${blockDrag.session.resolution.indicator.top}px`,
                      left: `${blockDrag.session.resolution.indicator.left}px`,
                      height: `${blockDrag.session.resolution.indicator.height}px`,
                    }}
                />
              )}
              {activeBlockSelection.boxes.map((box, pieceIndex) => (
                <div
                  key={`block-selection-${box.id}-${pieceIndex}`}
                  className="page-block-selection-outline"
                  aria-hidden="true"
                  style={{
                    top: `${box.top}px`,
                    left: `${box.left}px`,
                    width: `${box.right - box.left}px`,
                    height: `${box.bottom - box.top}px`,
                  }}
                />
              ))}
              {/* The mapped values are frozen hover snapshots. These callbacks run only after a
                  pointer/key event; none of the referenced handlers is invoked during render. */}
              {/* eslint-disable react-hooks/refs */}
              {blockAffordancesEnabled && onDeleteBlocks && visibleBlockHandles.map((handle) => (
                <button
                  key={`block-handle-${handle.blockId}`}
                  type="button"
                  className={`page-block-handle ${activeBlockSelection.ids.includes(handle.blockId) ? "selected" : ""}`}
                  data-block-id={handle.blockId}
                  style={{
                    top: `${handle.top}px`,
                    left: `${handle.left}px`,
                    height: `${Math.max(BLOCK_HANDLE_MIN_HEIGHT_PX, Math.min(handle.bottom - handle.top, BLOCK_HANDLE_MAX_HEIGHT_PX))}px`,
                  }}
                  aria-label={tEditorText("pageCanvas.selectBlock")}
                  title={tEditorText("pageCanvas.selectBlockHint")}
                  onMouseDown={(event) => {
                    // Keep the canvas handler from clearing the selection this click creates.
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerDown={(event) => {
                    if (onMoveBlocks) {
                      blockDrag.handlePointerDown(event, handle.blockId);
                    }
                  }}
                  onClick={(event) => {
                    event.stopPropagation();
                    // ドラッグして離した直後の click は「ドラッグの終わり」。選択もメニューも要らない。
                    if (blockDrag.consumeClickSuppression()) {
                      return;
                    }
                    selectBlockWithHandle(handle.blockId, event.shiftKey);
                    // Shift-click is still building a range; the menu would only get in the way.
                    if (!event.shiftKey) {
                      openBlockHandleMenu(handle.blockId, event.currentTarget);
                    }
                  }}
                >
                  <GripVertical size={14} aria-hidden="true" />
                </button>
              ))}
              {blockAffordancesEnabled && visibleSpaceAfterHandles.map((handle) => (
                <button
                  key={`block-space-${handle.blockId}`}
                  type="button"
                  className="page-block-space-handle"
                  // 問題エリアの左ガターには問題番号・サイドノート・エリア高さハンドルが同居する。
                  // 1 レーン外へ寄せて重なりを構造的に避ける。
                  data-gutter-lane={handle.insideProblemArea ? "problem" : undefined}
                  data-dragging={spaceAfterDrag ? "true" : undefined}
                  data-block-id={handle.blockId}
                  style={{
                    top: `${handle.bottom}px`,
                    left: `${handle.left}px`,
                  }}
                  aria-label={tEditorText("pageCanvas.spaceAfter")}
                  title={tEditorText("pageCanvas.spaceAfterHint")}
                  onMouseDown={(event) => {
                    // フォーカスと本文選択を動かさない (キャレットが飛ばない)。pointerdown 側で
                    // 止めるとダブルクリックごと消えるので、既存のグリップと同じくここで止める。
                    event.preventDefault();
                    event.stopPropagation();
                  }}
                  onPointerDown={(event) => startBlockSpaceAfterResize(handle, event)}
                  onClick={(event) => event.stopPropagation()}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    resetBlockSpaceAfter(handle.blockId);
                  }}
                  onKeyDown={(event) => {
                    // ドラッグでは出しにくい 1px 刻み。Shift で 10px、Backspace/Delete で 0 に戻す。
                    const step = event.shiftKey ? 10 : 1;
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      event.stopPropagation();
                      adjustBlockSpaceAfter(handle.blockId, event.key === "ArrowDown" ? step : -step);
                      return;
                    }
                    if (event.key === "Backspace" || event.key === "Delete") {
                      event.preventDefault();
                      event.stopPropagation();
                      resetBlockSpaceAfter(handle.blockId);
                    }
                  }}
                />
              ))}
              {/* eslint-enable react-hooks/refs */}
              {blockAffordancesEnabled && blockAffordance.insertPoint && onInsertBodyBlock && (
                <div
                  className="page-block-insert-line"
                  style={{
                    top: `${blockAffordance.insertPoint.top}px`,
                    left: `${blockAffordance.insertPoint.left}px`,
                    width: `${blockAffordance.insertPoint.width}px`,
                  }}
                >
                  <button
                    type="button"
                    className="page-block-insert-button"
                    // 下端つまみと同じ辺に出るときは 1 レーン外へ逃がす。重なると後から描かれる
                    // こちらが必ず上に乗り、つまみを掴めなくなる (問題・囲み枠の直前のブロック)。
                    data-lane={insertButtonLane === "default" ? undefined : insertButtonLane}
                    aria-label={tEditorText("pageCanvas.addBodyHere")}
                    title={tEditorText("pageCanvas.addBodyHere")}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                    }}
                    onClick={(event) => {
                      event.stopPropagation();
                      if (blockAffordance.insertPoint) {
                        insertBodyBlockAtPoint(blockAffordance.insertPoint);
                      }
                    }}
                  >
                    <Plus size={12} aria-hidden="true" />
                  </button>
                </div>
              )}
            </div>
          )}

          <div className={`page-overlay-layer ${pageOverlayEditing ? "editing" : ""}`}>
            {pageOverlayEditing ? (
              <>
                <OverlayCanvasEditor
                  key="overlay-canvas"
                  externalRevision={historyRevision}
                  documentId={document.docId}
                  overlay={overlay}
                  canvasWidth={pageWidthPx}
                  canvasHeight={totalHeight}
                  bleedValues={bleed}
                  imageInsertAreaWidth={contentWidthPx}
                  imageInsertAreaHeight={contentHeightPx}
                  blockAnchorScopeElement={flowElement}
                  bodyBlockRects={blockRects}
                  bodyAnchorableBlocks={layoutViewState.blockAnchorable}
                  visiblePageRange={visiblePageRange}
                  pageHeightPx={pageHeightPx}
                  pageGapPx={PAGE_GAP_PX}
                  verticalSnapGuides={bodyVerticalSnapGuides}
                  commandRequest={runningRegionEditKind ? null : overlayCommandRequest}
                  imageRequest={runningRegionEditKind ? null : overlayImageRequest}
                  actionRequest={runningRegionEditKind ? null : shortcutOverlayActionRequest ?? overlayActionRequest}
                  arrangeShortcutLabels={overlayArrangeShortcutLabels}
                  acceptsStylePreview={!runningRegionEditKind}
                  selectPointRequest={selectPointRequest}
                  backgroundLayerElement={overlayBackgroundLayerElement}
                  onCommandHandled={onOverlayCommandHandled}
                  onImageHandled={onOverlayImageHandled}
                  onActionHandled={handleOverlayActionHandled}
                  onSelectPointHandled={handleSelectPointHandled}
                  onRequestTextMode={handleRequestTextMode}
                  onRequestTextSelection={handleRequestTextSelection}
                  onModeStatusChange={handleBodyOverlayModeStatusChange}
                  onSelectionSummaryChange={handleOverlaySelectionSummaryChange}
                  onSelectedCountChange={handleOverlaySelectedCountChange}
                  onActiveToolChange={onOverlayActiveToolChange}
                  onMaterialSaveRequest={onMaterialSaveRequest ? () => onMaterialSaveRequest() : undefined}
                  onChange={updateBodyOverlay}
                  editPolicy={editorExtensions?.overlayEditPolicy}
                  shapeDecorations={editorExtensions?.overlayShapeDecorations}
                  diffShapeClassNames={overlayShapeClassNames}
                />
                <OverlayPreview
                  resolvedView={overlayView}
                  visiblePageRange={visiblePageRange}
                  stackLayer="all"
                  renderShapes={false}
                  pinnedShapeIds={pinnedOverlayShapeIds}
                  commentThreads={displayedCommentThreads}
                  highlightedCommentThreadId={highlightedCommentThreadId}
                  ghostShapes={overlayPresentation?.ghostShapes}
                />
              </>
            ) : (
              <OverlayPreview
                resolvedView={overlayView}
                visiblePageRange={visiblePageRange}
                stackLayer="foreground"
                pinnedShapeIds={pinnedOverlayShapeIds}
                commentThreads={displayedCommentThreads}
                highlightedCommentThreadId={highlightedCommentThreadId}
                diffShapeClassNames={overlayShapeClassNames}
                shapeDecorations={editorExtensions?.overlayShapeDecorations}
                ghostShapes={overlayPresentation?.ghostShapes}
                onPointerDown={handleOverlayPreviewPointerDown}
                onDoubleClick={handleOverlayPreviewDoubleClick}
              />
            )}
            {columnInlineContentAnchors.map((anchor) => (
              <div
                key={`${pageExtension?.columnAnchor?.keyPrefix ?? "column-extension"}-${anchor.targetId}`}
                className={pageExtension?.columnAnchor?.className}
                {...pageExtension?.columnAnchor?.getDataAttributes?.(anchor.targetId)}
                style={{
                  left: `${anchor.left}px`,
                  top: `${anchor.top}px`,
                  width: `${anchor.width}px`,
                }}
              >
                <InlineContentStack items={anchor.items} />
              </div>
            ))}
            {overlayPresentation?.floatingContent}
          </div>
          {showComments && commentPanel && (
            <div className="page-comment-gutter">
              <CommentThreadsPanel
                {...commentPanel}
                document={document}
                candidateTop={candidateCommentTop}
                panelHeight={totalHeight}
                pendingTop={pendingCommentTop}
                threadPositions={commentThreadPositions}
              />
            </div>
          )}
          {pageExtension?.renderCanvasLayer?.({
            document,
            blockRects,
            inlineContentTargetIds,
            canvasElement,
          })}
          {pageExtension?.portal && (
            <div ref={extensionPortalRef} className={pageExtension.portal.className} />
          )}
        </div>
      </div>
      {selectionActionPopover && (
        <div
          className="selection-action-popover"
          style={{
            left: `${selectionActionPopover.position.left}px`,
            top: `${selectionActionPopover.position.top}px`,
          }}
          onMouseDown={(event) => event.preventDefault()}
        >
          {selectionActionPopover.extensionAction?.render(selectionActionPopover.position)}
          {selectionActionPopover.commentAnchor && onCommentAnchorRequest && (
            <button
              type="button"
              title={tEditorText("pageCanvas.addComment")}
              aria-label={tEditorText("pageCanvas.addComment")}
              onClick={(event) => {
                event.stopPropagation();
                const anchor = selectionActionPopover.commentAnchor;
                if (anchor) {
                  onCommentAnchorRequest(anchor);
                }
              }}
            >
              <MessageSquarePlus size={16} aria-hidden="true" />
            </button>
          )}
        </div>
      )}
      {problemContextMenu && (
        <div
          className="problem-context-menu"
          role="menu"
          aria-label={tEditorText("pageCanvas.problemActions")}
          style={{
            left: `${problemContextMenu.left}px`,
            top: `${problemContextMenu.top}px`,
          }}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          {contextMenuProblemNode && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProblemSettingsId(contextMenuProblemNode.id);
                setProblemContextMenu(null);
              }}
            >
              <Settings2 size={15} />
              <span>{tEditorText("pageMenu.problemSettings")}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCopyBlock(problemContextMenu.problemId);
              setProblemContextMenu(null);
            }}
          >
            <Copy size={15} />
            <span>{tEditorText("pageMenu.problemCopy")}</span>
          </button>
          {canPasteProblem && onPasteBlock && (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPasteBlock(problemContextMenu.problemId, "before");
                  setProblemContextMenu(null);
                }}
              >
                <ClipboardPaste size={15} />
                <span>{tEditorText("pageMenu.problemPasteBefore")}</span>
              </button>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  onPasteBlock(problemContextMenu.problemId, "after");
                  setProblemContextMenu(null);
                }}
              >
                <ClipboardPaste size={15} />
                <span>{tEditorText("pageMenu.problemPasteAfter")}</span>
              </button>
            </>
          )}
          {onMaterialSaveRequest && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onMaterialSaveRequest(problemContextMenu.problemId);
                setProblemContextMenu(null);
              }}
            >
              <PackagePlus size={15} />
              {/* Explicitly scoped: the shared block items below carry their own
                  block-scoped "素材に追加", so the two must not read the same. */}
              <span>{tEditorText("pageMenu.problemSaveAsMaterial")}</span>
            </button>
          )}
          {problemContextMenu.breakBlockId && (
            <BlockContextMenuItems
              targetBlockId={problemContextMenu.breakBlockId}
              selectionBlockIds={problemContextMenu.selectionBlockIds}
              layoutSection={effectiveProblemContextMenuLayoutSection}
              canWrapInColumns={canWrapProblemContextMenuBlockInColumns}
              canEditColumns={canEditProblemContextMenuColumns}
              onColumnRuleSettings={requestColumnRuleSettings}
              breakKind={problemContextMenuBreaksToColumn ? "columnBreak" : "pageBreak"}
              showInsertBreak={canInsertProblemContextMenuBreak}
              showRemoveBreak={!!problemContextMenu.breakTargetBlockId}
              onWrapBlockInColumns={onWrapBlockInColumns}
              onUnwrapColumns={onUnwrapColumns}
              onColumnCountChange={updateLayoutSectionColumnCount}
              onMaterialSaveRequest={onMaterialSaveRequest}
              onSelectionMaterialSaveRequest={onSelectionMaterialSaveRequest}
              boxId={problemContextMenuBox?.id}
              onBoxTitleEditRequest={requestBoxTitleEdit}
              onBoxSettingsRequest={requestBoxSettings}
              onBoxCopy={onCopyBlock}
              onBoxDelete={deleteBoxFromContextMenu}
              onInsertBreak={() => applyProblemContextMenuBreak(true)}
              onRemoveBreak={() => applyProblemContextMenuBreak(false)}
              onClose={() => setProblemContextMenu(null)}
            />
          )}
          {contextMenuHiddenAreas.map((hiddenArea) => (
            <button
              key={hiddenArea}
              type="button"
              role="menuitem"
              onClick={() => {
                showProblemArea(problemContextMenu.problemId, hiddenArea);
                setProblemContextMenu(null);
              }}
            >
              <Plus size={15} />
              <span>{tEditorText("pageMenu.addArea", { replace: { area: problemAreaLabel(hiddenArea, tEditorText) } })}</span>
            </button>
          ))}
          {OPTIONAL_PROBLEM_AREAS.includes(problemContextMenu.area) && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                clearProblemArea(problemContextMenu.problemId, problemContextMenu.area);
                setProblemContextMenu(null);
              }}
            >
              <Trash2 size={15} />
              <span>{tEditorText("pageMenu.deleteArea", { replace: { area: problemAreaLabel(problemContextMenu.area, tEditorText) } })}</span>
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="danger"
            onClick={() => {
              onDelete(problemContextMenu.problemId);
              setProblemContextMenu(null);
            }}
          >
            <Trash2 size={15} />
            <span>{tEditorText("pageMenu.deleteProblem")}</span>
          </button>
        </div>
      )}
      {problemSettingsProblem && (
        <ProblemSettingsDialog
          problem={problemSettingsProblem}
          onChange={(updater) => {
            onChange(problemSettingsProblem.id, (block) => (
              block.type === "problem" ? updater(block) : block
            ));
          }}
          onClose={() => setProblemSettingsId(null)}
        />
      )}
      {columnRuleSection?.type === "layoutSection" && (
        <ColumnRuleDialog key={columnRuleSection.id} section={columnRuleSection}
          onClose={closeColumnRuleSettings}
          onApply={columnRule => onChange(columnRuleSection.id, block => block.type === "layoutSection"
            ? { ...block, layout: { ...block.layout, columnRule } } : block)} />
      )}
      {activeBodyContextMenu && (
        <div
          className="page-context-menu"
          role="menu"
          aria-label={tEditorText("pageCanvas.bodyActions")}
          style={{
            left: `${activeBodyContextMenu.left}px`,
            top: `${activeBodyContextMenu.top}px`,
          }}
          onContextMenu={(event) => event.preventDefault()}
          onMouseDown={(event) => event.stopPropagation()}
        >
          <BlockContextMenuItems
            targetBlockId={activeBodyContextMenu.blockId}
            selectionBlockIds={activeBodyContextMenu.selectionBlockIds}
            layoutSection={effectiveContextMenuLayoutSection}
            canWrapInColumns={canWrapContextMenuBlockInColumns}
            canEditColumns={canEditContextMenuColumns}
            onColumnRuleSettings={requestColumnRuleSettings}
            breakKind={contextMenuBreaksToColumn ? "columnBreak" : "pageBreak"}
            showInsertBreak={canInsertContextMenuBreak}
            showRemoveBreak={!!activeBodyContextMenu.breakTargetBlockId}
            onWrapBlockInColumns={onWrapBlockInColumns}
            onUnwrapColumns={onUnwrapColumns}
            onColumnCountChange={updateLayoutSectionColumnCount}
            onMaterialSaveRequest={onMaterialSaveRequest}
            onSelectionMaterialSaveRequest={onSelectionMaterialSaveRequest}
            boxId={contextMenuBox?.id}
            onBoxTitleEditRequest={requestBoxTitleEdit}
            onBoxSettingsRequest={requestBoxSettings}
            onBoxCopy={onCopyBlock}
            onBoxDelete={deleteBoxFromContextMenu}
            onInsertBreak={() => applyBodyContextMenuBreak(true)}
            onRemoveBreak={() => applyBodyContextMenuBreak(false)}
            onClose={() => setBodyContextMenu(null)}
          />
          {onDeleteBlocks && (
            <button
              type="button"
              role="menuitem"
              className="danger"
              onClick={() => {
                onDeleteBlocks(
                  activeBodyContextMenu.selectionBlockIds.length > 1
                    ? activeBodyContextMenu.selectionBlockIds
                    : [activeBodyContextMenu.blockId],
                );
                setBodyContextMenu(null);
              }}
            >
              <Trash2 size={15} />
              <span>
                {activeBodyContextMenu.selectionBlockIds.length > 1
                  ? tEditorText("pageMenu.deleteSelection")
                  : bodyBlockDeleteLabel(contextMenuBlock, tEditorText)}
              </span>
            </button>
          )}
        </div>
      )}
      </section>
    </EditorExtensionProvider>
    </ProblemNumberingProvider>
  );
}

/** 前回に無かったトップレベルブロック id を含むか (= 段組みで配置がまだ無いブロックが生まれる編集か)。 */
function hasNewTopLevelBlockIds(previousIds: readonly string[], nextBlocks: readonly TextFlowBlock[]): boolean {
  const known = new Set(previousIds);
  return nextBlocks.some((block) => !known.has(block.id));
}

/**
 * 大量 paste の未 hydrate unit。40 個前後のブロックを 1 つの概算矩形として扱うので、
 * 初回ページ割りが触る DOM は「全段落」ではなく「unit 数」に留まる。
 */
function DeferredLargePasteTextFlowUnit({
  blocks,
  breakGapPx,
  onVisible,
  unitId,
}: {
  blocks: TextFlowBlock[];
  breakGapPx: number;
  onVisible: (unitId: string) => void;
  unitId: string;
}) {
  const elementRef = useRef<HTMLDivElement | null>(null);
  const estimatedHeight = useMemo(
    () => blocks.reduce((height, block) => height + estimateBlockHeightPx(block), 0),
    [blocks],
  );

  useEffect(() => {
    const element = elementRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisible(unitId);
        observer.disconnect();
      }
    }, { rootMargin: "100% 0px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [onVisible, unitId]);

  return (
    <div
      ref={elementRef}
      id={unitId}
      data-page-block={unitId}
      data-sigma-doc-id={unitId}
      data-large-paste-deferred="true"
      aria-hidden="true"
      style={{
        height: `${Math.max(1, estimatedHeight)}px`,
        marginTop: breakGapPx > 0 ? `${breakGapPx}px` : undefined,
      }}
    />
  );
}

function TextFlowWithInlineContent({
  blocks,
  selectedId,
  mathFractionSizing,
  placeholder,
  showPlaceholder = true,
  singleBlock = false,
  historyRevision,
  breakGaps,
  paginationBeforeIds,
  paginationMarkerKind,
  paginationMarkerKinds,
  paginationMarkerLayouts,
  columnFlowBlockLayouts,
  boxFragmentSourceLayouts,
  headingNumbers = {},
  syncFocusedContent = false,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onFocusChange,
  onSelect,
  onCommentThreadSelect,
  onChange,
  onBoundaryDelete,
  materials,
  onMaterialInsert,
  enableSelectionFormatMenu = true,
  enableBoxCommands = true,
  enableProblemCommands = false,
  onProblemCommand,
  onBodyBlockCommand,
  onHeadingCommand,
  enableHeadingCommands = false,
  inlineContentByTargetId,
  changeDecorationState,
  textRunGroupId,
  textRunOrder,
  textRunUnitId,
  textRunScopeId,
  textRunScopeContainer,
  textRunPreserveEmpty = false,
}: {
  blocks: TextFlowBlock[];
  selectedId: string | null;
  mathFractionSizing: "uniform" | "texDefault";
  placeholder?: string;
  showPlaceholder?: boolean;
  singleBlock?: boolean;
  historyRevision: number;
  breakGaps?: Record<string, number>;
  paginationBeforeIds?: string[];
  paginationMarkerKind?: PageBreakMarkerKind;
  paginationMarkerKinds?: Record<string, PageBreakMarkerKind>;
  paginationMarkerLayouts?: Record<string, TextFlowColumnBlockLayout>;
  columnFlowBlockLayouts?: Record<string, TextFlowColumnBlockLayout>;
  boxFragmentSourceLayouts?: Record<string, TextFlowBoxFragmentSourceLayout>;
  headingNumbers?: Readonly<Record<string, string>>;
  syncFocusedContent?: boolean;
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onFocusChange?: (
    focused: boolean,
    blockIds: string[],
    activeBlockId?: string | null,
    selection?: TextFlowSelectionBookmark | null,
  ) => void;
  onSelect: (blockId: string | null) => void;
  onCommentThreadSelect?: (threadId: string) => void;
  onChange: (
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onBoundaryDelete?: (request: TextFlowBoundaryDeleteRequest) => boolean;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  enableSelectionFormatMenu?: boolean;
  enableBoxCommands?: boolean;
  enableProblemCommands?: boolean;
  onProblemCommand?: (request: TextFlowProblemCommandRequest) => boolean;
  onBodyBlockCommand?: (request: TextFlowBodyBlockCommandRequest) => boolean;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  enableHeadingCommands?: boolean;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  changeDecorationState?: TextFlowChangeDecorationState;
  textRunGroupId?: string;
  textRunOrder?: number;
  textRunUnitId?: string;
  textRunScopeId?: string;
  textRunScopeContainer?: TextRunScopeContainer;
  textRunPreserveEmpty?: boolean;
}) {
  const { textFlowEditPolicy } = useEditorExtensions();
  const parts = useMemo(
    () => splitTextFlowBlocksByInlineContent(blocks, inlineContentByTargetId),
    [blocks, inlineContentByTargetId],
  );
  // ここがユニット局所化の関門。下の TextFlowEditor は memo なので、**このユニットに関係する
  // 分だけ**を、値が変わらない限り同じ参照で渡す。ページ全体の gap やコメント一覧をそのまま
  // 渡すと、他のページが 1mm 動いただけで全ユニットが描き直される。
  const unitBreakGaps = pickUnitBreakGaps(blocks, breakGaps);
  const unitBreakGapsKey = getTextFlowBreakGapSyncKey(unitBreakGaps);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBreakGaps = useMemo(() => unitBreakGaps, [unitBreakGapsKey]);
  const unitCommentThreads = pickUnitCommentThreads(blocks, commentThreads);
  const unitCommentThreadsKey = getCommentThreadsSyncKey(unitCommentThreads);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableCommentThreads = useMemo(() => unitCommentThreads, [unitCommentThreadsKey]);
  const paginationBeforeIdsKey = paginationBeforeIds === undefined ? null : paginationBeforeIds.join("\u0000");
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationBeforeIds = useMemo(() => paginationBeforeIds, [paginationBeforeIdsKey]);
  const paginationMarkerKindsKey = JSON.stringify(paginationMarkerKinds ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationMarkerKinds = useMemo(() => paginationMarkerKinds, [paginationMarkerKindsKey]);
  const paginationMarkerLayoutsKey = getTextFlowColumnLayoutsSyncKey(paginationMarkerLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stablePaginationMarkerLayouts = useMemo(() => paginationMarkerLayouts, [paginationMarkerLayoutsKey]);
  const columnFlowBlockLayoutsKey = getTextFlowColumnLayoutsSyncKey(columnFlowBlockLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableColumnFlowBlockLayouts = useMemo(() => columnFlowBlockLayouts, [columnFlowBlockLayoutsKey]);
  const boxFragmentSourceLayoutsKey = getTextFlowFragmentLayoutsSyncKey(boxFragmentSourceLayouts);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stableBoxFragmentSourceLayouts = useMemo(() => boxFragmentSourceLayouts, [boxFragmentSourceLayoutsKey]);

  if (parts.length === 1 && parts[0].type === "blocks") {
    return (
      <TextFlowEditor
        blocks={blocks}
        selectedId={selectedId}
        mathFractionSizing={mathFractionSizing}
        placeholder={placeholder}
        showPlaceholder={showPlaceholder}
        singleBlock={singleBlock}
        historyRevision={historyRevision}
        breakGaps={stableBreakGaps}
        paginationBeforeIds={stablePaginationBeforeIds}
        paginationMarkerKind={paginationMarkerKind}
        paginationMarkerKinds={stablePaginationMarkerKinds}
        paginationMarkerLayouts={stablePaginationMarkerLayouts}
        columnFlowBlockLayouts={stableColumnFlowBlockLayouts}
        boxFragmentSourceLayouts={stableBoxFragmentSourceLayouts}
        headingNumbers={headingNumbers}
        syncFocusedContent={syncFocusedContent}
        commentThreads={stableCommentThreads}
        activeCommentThreadId={activeCommentThreadId}
        highlightedCommentThreadId={highlightedCommentThreadId}
        onCommentThreadSelect={onCommentThreadSelect}
        onFocusChange={onFocusChange}
        onSelect={onSelect}
        onChange={onChange}
        onBoundaryDelete={onBoundaryDelete}
        materials={materials}
        onMaterialInsert={onMaterialInsert}
        enableSelectionFormatMenu={enableSelectionFormatMenu}
        enableBoxCommands={enableBoxCommands}
        enableProblemCommands={enableProblemCommands}
        onProblemCommand={onProblemCommand}
        onBodyBlockCommand={onBodyBlockCommand}
        enableHeadingCommands={enableHeadingCommands}
        onHeadingCommand={onHeadingCommand}
        changeDecorationState={changeDecorationState}
        editPolicy={textFlowEditPolicy}
        textRunGroupId={textRunGroupId}
        textRunOrder={(textRunOrder ?? 0) * 1000}
        textRunUnitId={`${textRunUnitId ?? blocks[0]?.id ?? textRunGroupId}:0`}
        textRunScopeId={textRunScopeId}
        textRunScopeContainer={textRunScopeContainer}
        textRunPreserveEmpty={textRunPreserveEmpty}
      />
    );
  }

  return (
    <>
      {parts.map((part, index) =>
        part.type === "blocks" ? (
          <TextFlowEditor
            key={part.key}
            blocks={part.blocks}
            selectedId={selectedId}
            mathFractionSizing={mathFractionSizing}
            placeholder={placeholder}
            showPlaceholder={showPlaceholder}
            singleBlock={singleBlock}
            historyRevision={historyRevision}
            breakGaps={stableBreakGaps}
            paginationBeforeIds={paginationBeforeIds?.filter((id) => part.blocks.some((block) => bodyTextFlowBlockContainsId(block, id)))}
            paginationMarkerKind={paginationMarkerKind}
            paginationMarkerKinds={paginationMarkerKinds}
            paginationMarkerLayouts={pickTextFlowColumnBlockLayouts(part.blocks, paginationMarkerLayouts)}
            columnFlowBlockLayouts={pickTextFlowColumnBlockLayouts(part.blocks, columnFlowBlockLayouts)}
            boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(part.blocks, boxFragmentSourceLayouts)}
            headingNumbers={headingNumbers}
            syncFocusedContent={syncFocusedContent}
            commentThreads={stableCommentThreads}
            activeCommentThreadId={activeCommentThreadId}
            highlightedCommentThreadId={highlightedCommentThreadId}
            onCommentThreadSelect={onCommentThreadSelect}
            onFocusChange={onFocusChange}
            onSelect={onSelect}
            onChange={onChange}
            onBoundaryDelete={onBoundaryDelete}
            materials={materials}
            onMaterialInsert={onMaterialInsert}
            enableSelectionFormatMenu={enableSelectionFormatMenu}
            enableBoxCommands={enableBoxCommands}
            enableProblemCommands={enableProblemCommands}
            onProblemCommand={onProblemCommand}
            onBodyBlockCommand={onBodyBlockCommand}
            enableHeadingCommands={enableHeadingCommands}
            onHeadingCommand={onHeadingCommand}
            changeDecorationState={changeDecorationState}
            editPolicy={textFlowEditPolicy}
            textRunGroupId={textRunGroupId}
            textRunOrder={(textRunOrder ?? 0) * 1000 + index}
            textRunUnitId={`${textRunUnitId ?? part.key}:${index}`}
            textRunScopeId={textRunScopeId}
            textRunScopeContainer={textRunScopeContainer}
            textRunPreserveEmpty={textRunPreserveEmpty}
          />
        ) : (
          <InlineContentStack
            key={part.key}
            items={part.items}
          />
        ),
      )}
    </>
  );
}

function InlineContentStack({ items }: { items: readonly PageCanvasInlineContent[] }) {
  return (
    <>
      {items.map((item) => <Fragment key={item.key}>{item.content}</Fragment>)}
    </>
  );
}

/** Replica projections have no SigmaDoc write capability. */
function ignoreFragmentProjectionChange() {}

function EditorBoxBlockFragmentPreview({
  textRunOrder,
  block,
  fragment,
  historyRevision,
  selectedId,
  onSelect,
  changeDecorationState,
  pagedRender,
  fragmentPageIndex,
  paginationMarkerKind,
}: {
  block: TextFlowBlock;
  fragment: EditorBoxBlockFragmentLayout;
  historyRevision: number;
  selectedId: string | null;
  onSelect: (blockId: string | null) => void;
  changeDecorationState?: TextFlowChangeDecorationState;
  pagedRender: boolean;
  fragmentPageIndex: number;
  paginationMarkerKind: PageBreakMarkerKind;
  /** この複製が続きを見せているブロックを持つユニットの文書順。 */
  textRunOrder?: number;
}) {
  const { textFlowEditPolicy } = useEditorExtensions();
  const viewportRef = useRef<HTMLDivElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(block.type !== "codeBlock");
  const shouldRenderContent = pagedRender || block.type !== "codeBlock" || isNearViewport;
  useEffect(() => {
    if (pagedRender || block.type !== "codeBlock" || isNearViewport) {
      return;
    }
    const viewport = viewportRef.current;
    if (!viewport || typeof IntersectionObserver !== "function") {
      setIsNearViewport(true);
      return;
    }
    // external canvas editors の viewport culling と同じ発想。ただし shape/store は持ち込まず、固定寸法の
    // continuation viewport は残したまま、重い ProseMirror の複製だけを画面近傍で生成する。
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setIsNearViewport(true);
      }
    }, { rootMargin: "1200px 0px" });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [block.type, isNearViewport, pagedRender]);
  // カリングされている複製へキャレットを配る必要が出たら、ルーターが「その複製を出して
  // ほしい」とだけ知らせてくる。出した瞬間に登録され、ルーターが予約を消化する。
  useEffect(() => subscribeCaretSurfaceMount((wanted) => {
    if (
      wanted.kind === "fragmentReplica"
      && wanted.blockId === fragment.blockId
      && wanted.fragmentIndex === fragment.fragmentIndex
    ) {
      setIsNearViewport(true);
    }
  }), [fragment.blockId, fragment.fragmentIndex]);
  const selected = selectedId === block.id
    || (block.type === "boxBlock" && bodyTextFlowBlockContainsId(block, selectedId));
  const viewportStyle: CSSProperties = {
    left: `${fragment.x}px`,
    top: `${fragment.y}px`,
    width: `${fragment.width}px`,
    height: `${fragment.height}px`,
  };
  const editorStyle = {
    minHeight: `${fragment.totalHeight}px`,
    transform: `translateY(-${fragment.sourceOffsetY}px)`,
    ...cornerBoxReferenceHeightStyleVars(fragment.totalHeight),
  } as CSSProperties;

  return (
    <div
      ref={viewportRef}
      className={`editor-box-fragment-viewport ${selected ? "selected" : ""}`}
      data-box-source-id={fragment.blockId}
      data-box-fragment-index={fragment.fragmentIndex}
      data-paged-code-fragment={pagedRender && block.type === "codeBlock" ? "" : undefined}
      data-fragment-page-index={pagedRender && block.type === "codeBlock" ? fragmentPageIndex : undefined}
      style={viewportStyle}
      onClick={(event) => event.stopPropagation()}
    >
      {shouldRenderContent && (
        <div className="editor-box-fragment-editor" style={editorStyle}>
          {pagedRender && block.type === "codeBlock"
            ? null
            : (
              <TextFlowEditor
                blocks={[block]}
                selectedId={selectedId}
                historyRevision={historyRevision}
                showPlaceholder={false}
                paginationBeforeIds={getNestedPageBreakBeforeIds([block])}
                paginationMarkerKind={paginationMarkerKind}
                paginationMarkerKinds={getNestedPageBreakBeforeKinds([block], paginationMarkerKind)}
                syncFocusedContent
                onSelect={onSelect}
                // FragmentEditSession routes all edits to the source flow.
                onChange={ignoreFragmentProjectionChange}
                materials={[]}
                enableBoxCommands={false}
                readOnlyBoxTitle
                changeDecorationState={changeDecorationState}
                editPolicy={textFlowEditPolicy}
                boxFragmentReplicaId={fragment.blockId}
                boxFragmentReplicaIndex={fragment.fragmentIndex}
                textRunOrder={textRunOrder}
              />
            )}
        </div>
      )}
    </div>
  );
}

function ColumnGuides({ metrics }: { metrics: PageMetrics }) {
  if (metrics.flow.columnCount <= 1 || metrics.flow.columnRule) {
    return null;
  }

  return (
    <div className="page-column-guides" aria-hidden="true">
      {Array.from({ length: metrics.flow.columnCount - 1 }, (_, index) => {
        const left = metrics.margins.leftPx +
          (index + 1) * metrics.flow.columnWidthPx +
          index * metrics.flow.columnGapPx +
          metrics.flow.columnGapPx / 2;

        return <span key={index} style={{ left: `${left}px` }} />;
      })}
    </div>
  );
}

function getBodyVerticalSnapGuides(metrics: PageMetrics): number[] {
  const values: number[] = [];
  const addValue = (value: number) => {
    if (!Number.isFinite(value)) {
      return;
    }
    if (!values.some((current) => Math.abs(current - value) < 0.001)) {
      values.push(value);
    }
  };
  const contentLeft = metrics.margins.leftPx;
  const contentRight = metrics.page.widthPx - metrics.margins.rightPx;

  addValue(contentLeft);
  addValue(contentRight);

  if (metrics.flow.columnCount > 1) {
    const columnStep = metrics.flow.columnWidthPx + metrics.flow.columnGapPx;
    for (let index = 0; index < metrics.flow.columnCount; index += 1) {
      const columnLeft = contentLeft + index * columnStep;
      addValue(columnLeft);
      addValue(columnLeft + metrics.flow.columnWidthPx);
    }
  }

  return values;
}

function RunningRegionControls({
  marginEditing,
  layout,
  metrics,
  pageTopPx,
  pageNumber,
  editingKind,
  editingPageNumber,
  focusRequest,
  historyRevision,
  onEdit,
  onBlocksChange,
  onContentHeightChange,
  onEdgePointerDown,
  onMarginPointerDown,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  runningRegionOverlayEditing,
  onRunningRegionOverlayEditingChange,
  onRunningRegionOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  marginEditing: boolean;
  layout: PageLayout;
  metrics: PageMetrics;
  pageTopPx: number;
  pageNumber: number;
  editingKind: RunningRegionKind | null;
  editingPageNumber: number;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  onEdgePointerDown: (
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onMarginPointerDown: (
    edge: PageMarginEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  runningRegionOverlayEditing: boolean;
  onRunningRegionOverlayEditingChange: (editing: boolean) => void;
  onRunningRegionOverlayChange: (
    kind: RunningRegionKind,
    overlay: PageOverlay,
    options?: OverlayChangeOptions,
  ) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditorText = useT("editor");
  return (
    <div className="page-layout-control-sheet" style={{ top: `${pageTopPx}px` }}>
      {marginEditing && (
        <div
          className="page-content-guide"
          style={{
            top: `${metrics.margins.topPx}px`,
            left: `${metrics.margins.leftPx}px`,
            width: `${metrics.content.widthPx}px`,
            height: `${metrics.content.heightPx}px`,
          }}
        />
      )}
      {marginEditing && (
        <PageMarginRuler
          layout={layout}
          metrics={metrics}
          onMarginPointerDown={onMarginPointerDown}
        />
      )}
      <RunningRegionBand
        kind="header"
        label={tEditorText("running.header")}
        region={layout.header}
        metrics={metrics}
        layout={layout}
        pageNumber={pageNumber}
        editing={editingKind === "header" && pageNumber === editingPageNumber}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onBlocksChange={onBlocksChange}
        onContentHeightChange={onContentHeightChange}
        onEdgePointerDown={onEdgePointerDown}
        overlayCommandRequest={overlayCommandRequest}
        overlayImageRequest={overlayImageRequest}
        overlayActionRequest={overlayActionRequest}
        overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
        overlayEditing={runningRegionOverlayEditing && editingKind === "header"}
        onOverlayEditingChange={onRunningRegionOverlayEditingChange}
        onOverlayChange={onRunningRegionOverlayChange}
        onOverlayCommandHandled={onOverlayCommandHandled}
        onOverlayImageHandled={onOverlayImageHandled}
        onOverlayActionHandled={onOverlayActionHandled}
        onOverlayModeStatusChange={onOverlayModeStatusChange}
        onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
        onOverlayActiveToolChange={onOverlayActiveToolChange}
      />
      <RunningRegionBand
        kind="footer"
        label={tEditorText("running.footer")}
        region={layout.footer}
        metrics={metrics}
        layout={layout}
        pageNumber={pageNumber}
        editing={editingKind === "footer" && pageNumber === editingPageNumber}
        focusRequest={focusRequest}
        historyRevision={historyRevision}
        onEdit={onEdit}
        onBlocksChange={onBlocksChange}
        onContentHeightChange={onContentHeightChange}
        onEdgePointerDown={onEdgePointerDown}
        overlayCommandRequest={overlayCommandRequest}
        overlayImageRequest={overlayImageRequest}
        overlayActionRequest={overlayActionRequest}
        overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
        overlayEditing={runningRegionOverlayEditing && editingKind === "footer"}
        onOverlayEditingChange={onRunningRegionOverlayEditingChange}
        onOverlayChange={onRunningRegionOverlayChange}
        onOverlayCommandHandled={onOverlayCommandHandled}
        onOverlayImageHandled={onOverlayImageHandled}
        onOverlayActionHandled={onOverlayActionHandled}
        onOverlayModeStatusChange={onOverlayModeStatusChange}
        onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
        onOverlayActiveToolChange={onOverlayActiveToolChange}
      />
    </div>
  );
}

function PageMarginRuler({
  layout,
  metrics,
  onMarginPointerDown,
}: {
  layout: PageLayout;
  metrics: PageMetrics;
  onMarginPointerDown: (
    edge: PageMarginEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
}) {
  const tEditor = useT("editor");
  return (
    <div className="page-margin-ruler" aria-label={tEditor("pageCanvas.marginRuler")}>
      <div
        className="page-margin-ruler-track"
        style={{
          left: `${metrics.margins.leftPx}px`,
          right: `${metrics.margins.rightPx}px`,
        }}
      />
      <button
        type="button"
        className="page-margin-ruler-handle left"
        style={{ left: `${metrics.margins.leftPx}px` }}
        aria-label={tEditor("pageCanvas.marginLeft")}
        title={tEditor("pageCanvas.marginLeft")}
        onPointerDown={(event) => onMarginPointerDown("left", event)}
      >
        <span>{formatMm(layout.marginsMm.left)}mm</span>
      </button>
      <button
        type="button"
        className="page-margin-ruler-handle right"
        style={{ right: `${metrics.margins.rightPx}px` }}
        aria-label={tEditor("pageCanvas.marginRight")}
        title={tEditor("pageCanvas.marginRight")}
        onPointerDown={(event) => onMarginPointerDown("right", event)}
      >
        <span>{formatMm(layout.marginsMm.right)}mm</span>
      </button>
    </div>
  );
}

function LayoutColumnResizeHandle({
  sectionId,
  dividerIndex,
  left,
  label,
  onCommit,
}: {
  sectionId: string;
  dividerIndex: number;
  left: string;
  label: string;
  onCommit: (leftWidth: number, rightWidth: number) => void;
}) {
  const resizeCleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanupRef.current?.(), []);
  return (
    <button
      type="button"
      className="layout-section-column-resize-handle"
      data-layout-section-id={sectionId}
      data-divider-index={dividerIndex}
      style={{ left }}
      aria-label={label}
      onPointerDown={(event) => {
        resizeCleanupRef.current?.();
        resizeCleanupRef.current = beginLayoutColumnResize(event, event.currentTarget, dividerIndex, onCommit);
      }}
    />
  );
}

function LayoutSectionFlowUnit({
  unit,
  textRunAssignment,
  selectedId,
  mathFractionSizing,
  historyRevision,
  isColumnFlow,
  gaps,
  columnLayout,
  boxFragmentSourceLayouts,
  layoutStyle,
  spaceAfterFollowerClass,
  pageColumnGapPx,
  pageColumnGapMm,
  pageContentHeightPx,
  sideNoteOffsetPx,
  onSelect,
  onChange,
  onLayoutChange,
  onResizeColumns,
  onRemoveBreak,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onCommentThreadSelect,
  materials,
  onMaterialInsert,
  onHeadingCommand,
  inlineContentByTargetId,
  changeDecorationState,
}: {
  unit: Extract<RenderUnit, { type: "layoutSection" | "problemLayoutSection" }>;
  textRunAssignment?: TextRunGroupAssignment;
  selectedId: string | null;
  mathFractionSizing: "uniform" | "texDefault";
  historyRevision: number;
  isColumnFlow: boolean;
  gaps: Record<string, number>;
  columnLayout: ProblemAreaColumnLayout | undefined;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  layoutStyle: CSSProperties | undefined;
  /** 下端つまみのドラッグ中、このユニットを殻ごと平行移動させる印 (該当しなければ空文字)。 */
  spaceAfterFollowerClass: string;
  pageColumnGapPx: number;
  pageColumnGapMm: number;
  pageContentHeightPx: number;
  sideNoteOffsetPx: number | undefined;
  onSelect: (blockId: string | null) => void;
  onChange: (
    sectionId: string,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onLayoutChange: (sectionId: string, updater: (block: SigmaBlock | ProblemAreaBlock) => SigmaBlock | ProblemAreaBlock) => void;
  onResizeColumns?: (sectionId: string, dividerIndex: number, leftWidth: number, rightWidth: number) => void;
  onRemoveBreak?: (blockId: string) => void;
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onCommentThreadSelect?: (threadId: string) => void;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  onHeadingCommand?: (request: TextFlowHeadingCommandRequest) => boolean;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  changeDecorationState?: TextFlowChangeDecorationState;
}) {
  const tEditor = useT("editor");
  const selected = selectedId === unit.section.id || unit.blocks.some((block) => block.id === selectedId);
  const isProblemAreaSection = unit.type === "problemLayoutSection";
  const problemAreaMinHeightMm = getSingleColumnProblemLayoutSectionMinHeightMm(unit, isColumnFlow);
  // memo 済みの本文エディタへ渡るので identity を固定する。跨ぎコピーが段組セクションを
  // 組み直すのに使う (このユニットの doc には段落しか入っていない)。
  const sectionId = unit.section.id;
  const sectionLayout = unit.section.layout;
  // 問題エリアの中の段組は、段組の外側に問題エリアがある (外側 → 内側の順)。
  const problemFrameSource = unit.type === "problemLayoutSection" ? unit : null;
  const problemFrameProblem = problemFrameSource?.problem;
  const problemFrameArea = problemFrameSource?.area;
  const scopeContainer = useMemo<TextRunScopeContainer>(
    () => [
      ...(problemFrameProblem && problemFrameArea
        ? [{
            kind: "problemArea" as const,
            id: problemFrameProblem.id,
            area: problemFrameArea,
            template: problemFrameProblem,
          }]
        : []),
      { kind: "layoutSection" as const, id: sectionId, layout: sectionLayout },
    ],
    [problemFrameArea, problemFrameProblem, sectionId, sectionLayout],
  );
  const columnCount = getLayoutSectionColumnCount(unit.section);
  const columnGapPx = getLayoutSectionColumnGapPx(unit.section, pageColumnGapMm, pageColumnGapPx);
  const columnFlowActive = columnCount > 1 && columnLayout != null;
  const gapStyle = !isColumnFlow && gaps[unit.id] ? { marginTop: `${gaps[unit.id]}px` } : undefined;
  const problemAreaMinHeightPx = getSafeProblemAreaMinHeightPx(
    problemAreaMinHeightMm,
    pageContentHeightPx,
  );
  const style = {
    ...(layoutStyle ?? gapStyle),
    minHeight: problemAreaMinHeightPx > 0 ? `${problemAreaMinHeightPx}px` : undefined,
    ...(isColumnFlow && typeof sideNoteOffsetPx === "number" ? { "--problem-area-page-x": `${sideNoteOffsetPx}px` } : {}),
  } as CSSProperties;
  const columnStyle = columnFlowActive
    ? ({
        "--layout-section-column-flow-height": `${columnLayout!.totalHeightPx}px`,
        "--layout-section-column-gap": `${columnLayout!.columnGapPx}px`,
      } as CSSProperties)
    : undefined;
  const blockById = useMemo(() => new Map(unit.blocks.map((block) => [block.id, block] as const)), [unit.blocks]);
  const columnBlocks = useMemo(() => getLayoutSectionColumns(unit.section).map((column) => (
    column.flatMap((block) => {
      const editable = blockById.get(block.id);
      return editable ? [editable] : [];
    })
  )), [blockById, unit.section]);
  const columnWidths = useMemo(
    () => getLayoutSectionColumnWidths(unit.section, columnBlocks.length),
    [columnBlocks.length, unit.section],
  );
  const columnPresentation = createIndependentColumnLayout(columnWidths, `${columnGapPx}px`);
  const independentColumnStyle = {
    ...createColumnRuleStyle(unit.section.layout.columnRule),
    gridTemplateColumns: columnPresentation.gridTemplateColumns,
    columnGap: columnPresentation.columnGap,
  };

  // memo 済みの本文エディタへ渡るので、段組みごとのハンドラは identity を固定する。
  const handleSectionChange = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    onChange(unit.section.id, previousIds, nextBlocks, activeBlockId, context);
  }, [onChange, unit.section.id]);

  return (
    <section
      id={unit.section.id}
      data-page-block=""
      data-sigma-doc-id={unit.section.id}
      data-sigma-doc-type="layoutSection"
      data-layout-section-id={unit.section.id}
      data-problem-area={isProblemAreaSection ? unit.area : undefined}
      data-problem-id={isProblemAreaSection ? unit.problem.id : undefined}
      data-flow-unit-id={unit.id}
      className={`layout-section-flow-unit ${selected ? "selected" : ""} ${isColumnFlow ? "page-flow-unit" : ""} ${isProblemAreaSection ? "in-problem-area" : ""} ${spaceAfterFollowerClass}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(unit.section.id);
      }}
    >
      {isProblemAreaSection && unit.showAreaSideNote && (
        <div className="problem-area-side-note">
          <span>{problemAreaSideLabel(unit.area, unit.problemNumber, tEditor)}</span>
        </div>
      )}
      <div className="layout-section-side-note">
        <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
      </div>
      {!isColumnFlow && hasBreakBefore(unit.section) && (
        <PageBreakMarker blockId={unit.section.id} onRemove={onRemoveBreak} />
      )}
      <div
        className="layout-section-paper-body with-independent-layout-columns"
        style={columnStyle}
      >
        <div className="layout-section-independent-columns" style={independentColumnStyle} onMouseDownCapture={startLocalColumnPointerSelection}>
          <ColumnRuleLines rule={unit.section.layout.columnRule} dividers={columnPresentation.dividers} />
          {columnBlocks.map((blocks, columnIndex) => (
            <Fragment key={unit.section.layout.columnStartIds?.[columnIndex] ?? blocks[0]?.id ?? columnIndex}>
              <div className="layout-section-independent-column" data-layout-column-index={columnIndex}>
                <TextFlowWithInlineContent
                  blocks={blocks}
                  headingNumbers={unit.headingNumbers}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  breakGaps={undefined}
                  paginationBeforeIds={getNestedPageBreakBeforeIds(blocks)}
                  paginationMarkerKind={resolvePageBreakMarkerKind(columnCount > 1 || isColumnFlow)}
                  paginationMarkerKinds={getNestedPageBreakBeforeKinds(blocks, resolvePageBreakMarkerKind(columnCount > 1 || isColumnFlow))}
                  paginationMarkerLayouts={undefined}
                  columnFlowBlockLayouts={columnFlowActive ? columnLayout!.blockLayouts : undefined}
                  boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(blocks, boxFragmentSourceLayouts)}
                  commentThreads={commentThreads}
                  activeCommentThreadId={activeCommentThreadId}
                  highlightedCommentThreadId={highlightedCommentThreadId}
                  placeholder={tEditor("body.inputPlaceholder")}
                  showPlaceholder
                  onSelect={onSelect}
                  onCommentThreadSelect={onCommentThreadSelect}
                  onChange={handleSectionChange}
                  materials={materials}
                  onMaterialInsert={onMaterialInsert}
                  enableSelectionFormatMenu={false}
                  enableBoxCommands
                  enableHeadingCommands={!isProblemAreaSection}
                  onHeadingCommand={onHeadingCommand}
                  inlineContentByTargetId={inlineContentByTargetId}
                  changeDecorationState={changeDecorationState}
                  textRunGroupId={textRunAssignment?.groupId}
                  textRunOrder={textRunAssignment ? textRunAssignment.order + columnIndex / columnCount : undefined}
                  textRunUnitId={`${unit.id}:column:${columnIndex}`}
                  textRunScopeId={`layout:${unit.section.id}`}
                  textRunScopeContainer={scopeContainer}
                  textRunPreserveEmpty
                />
              </div>
              {columnIndex < columnBlocks.length - 1 && (
                <LayoutColumnResizeHandle
                  sectionId={unit.section.id}
                  dividerIndex={columnIndex}
                  left={columnPresentation.dividers[columnIndex].left}
                  label={tEditor("pageCanvas.resizeColumns", {
                    replace: { left: columnIndex + 1, right: columnIndex + 2 },
                  })}
                  onCommit={(leftWidth, rightWidth) => {
                    if (onResizeColumns) {
                      onResizeColumns(unit.section.id, columnIndex, leftWidth, rightWidth);
                      return;
                    }
                    onLayoutChange(unit.section.id, (block) => {
                      if (block.type !== "layoutSection") return block;
                      const columns = getLayoutSectionColumns(block);
                      const widths = getLayoutSectionColumnWidths(block, columns.length);
                      if (!columns[columnIndex] || !columns[columnIndex + 1]) return block;
                      if (leftWidth <= 0 || rightWidth <= 0) {
                        const merged = [...columns[columnIndex], ...columns[columnIndex + 1]];
                        const nextColumns = [...columns.slice(0, columnIndex), merged, ...columns.slice(columnIndex + 2)];
                        const nextWidths = [...widths.slice(0, columnIndex), widths[columnIndex] + widths[columnIndex + 1], ...widths.slice(columnIndex + 2)];
                        return setLayoutSectionColumns(block, nextColumns, nextWidths);
                      }
                      const pairTotal = widths[columnIndex] + widths[columnIndex + 1];
                      const pixelTotal = leftWidth + rightWidth;
                      const nextWidths = [...widths];
                      nextWidths[columnIndex] = Math.round(pairTotal * leftWidth / pixelTotal);
                      nextWidths[columnIndex + 1] = pairTotal - nextWidths[columnIndex];
                      return setLayoutSectionColumns(block, columns, nextWidths);
                    });
                  }}
                />
              )}
            </Fragment>
          ))}
        </div>
      </div>
    </section>
  );
}

function ProblemAreaFlowUnit({
  unit,
  textRunAssignment,
  selectedId,
  mathFractionSizing,
  historyRevision,
  isColumnFlow,
  gaps,
  boxFragmentSourceLayouts,
  columnFlowBlockLayouts,
  frameFragments,
  layoutStyle,
  spaceAfterFollowerClass,
  sideNoteOffsetPx,
  draftMinHeightMm,
  pageContentHeightPx,
  onSelect,
  onChange,
  onRemoveBreak,
  onResizeStart,
  onActionMenuOpen,
  inlineContentByTargetId,
  afterInlineContent,
  commentThreads,
  activeCommentThreadId,
  highlightedCommentThreadId,
  onCommentThreadSelect,
  materials,
  onMaterialInsert,
  changeDecorationState,
}: {
  unit: Extract<RenderUnit, { type: "problemArea" }>;
  textRunAssignment?: TextRunGroupAssignment;
  selectedId: string | null;
  mathFractionSizing: "uniform" | "texDefault";
  historyRevision: number;
  isColumnFlow: boolean;
  gaps: Record<string, number>;
  boxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout>;
  columnFlowBlockLayouts: Record<string, TextFlowColumnBlockLayout> | undefined;
  frameFragments: ProblemAreaFrameFragmentLayout[] | undefined;
  layoutStyle: CSSProperties | undefined;
  /** 下端つまみのドラッグ中、このユニットを殻ごと平行移動させる印 (該当しなければ空文字)。 */
  spaceAfterFollowerClass: string;
  sideNoteOffsetPx: number | undefined;
  draftMinHeightMm: number | undefined;
  pageContentHeightPx: number;
  onSelect: (blockId: string | null) => void;
  onChange: (
    problemId: string,
    area: ProblemAreaKind,
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => void;
  onRemoveBreak?: (blockId: string) => void;
  onResizeStart: (
    problem: ProblemNode,
    area: ProblemAreaKind,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  onActionMenuOpen: (problemId: string, area: ProblemAreaKind, anchor: HTMLElement) => void;
  inlineContentByTargetId: ReadonlyMap<string, readonly PageCanvasInlineContent[]>;
  afterInlineContent: readonly PageCanvasInlineContent[];
  commentThreads: SigmaCommentThread[];
  activeCommentThreadId: string | null;
  highlightedCommentThreadId: string | null;
  onCommentThreadSelect?: (threadId: string) => void;
  materials: MaterialItem[];
  onMaterialInsert?: (request: TextFlowMaterialInsertRequest) => void;
  changeDecorationState?: TextFlowChangeDecorationState;
}) {
  const tEditor = useT("editor");
  const { problem, area } = unit;
  const selected = selectedId === problem.id || unit.blocks.some((block) => block.id === selectedId);
  const columnBlockFlowed = isColumnFlow
    && unit.blocks.length > 0
    && unit.blocks.some((block) => columnFlowBlockLayouts?.[block.id] !== undefined);
  const minHeightPx = getSafeProblemAreaMinHeightPx(
    draftMinHeightMm ?? problem.areaLayout?.[area]?.minHeightMm ?? 0,
    pageContentHeightPx,
  );
  const sectionGapPx = !isColumnFlow
    ? gaps[getProblemAreaUnitGapKey(unit)]
    : undefined;
  const gapStyle = sectionGapPx ? { marginTop: `${sectionGapPx}px` } : undefined;
  const style = {
    ...(layoutStyle ?? gapStyle),
    minHeight: !columnBlockFlowed && minHeightPx > 0 ? `${minHeightPx}px` : undefined,
    ...(isColumnFlow && typeof sideNoteOffsetPx === "number" ? { "--problem-area-page-x": `${sideNoteOffsetPx}px` } : {}),
    ...(columnBlockFlowed && unit.blocks[0] && columnFlowBlockLayouts?.[unit.blocks[0].id]
      ? { "--problem-area-side-note-y": `${columnFlowBlockLayouts[unit.blocks[0].id].y + 16}px` }
      : {}),
  } as CSSProperties;
  const problemNumber = unit.problemNumber;
  const isFirstArea = unit.isFirstProblemArea;
  const showNumber = area === "lead" && typeof problemNumber === "number";
  const problemNumberStyle = showNumber ? { fontSize: `${getProblemNumberFontSize(problem)}pt` } : undefined;
  const hasFrame = problem.frame?.enabled === true && isProblemFrameArea(area);
  const frameStyleId = hasFrame ? getProblemFrameStyleId(problem) : undefined;
  const frameClasses = hasFrame ? problemFrameClassName("with-frame", frameStyleId) : "";
  // A manual break can split a framed area into several page/column segments (see
  // isProblemAreaColumnBlockFlowEligible). When that happens, the border can no
  // longer be a single CSS box around the whole (now multi-segment) section — it
  // is drawn instead as one open-ended overlay piece per segment, reusing the
  // exact same with-frame/first-frame-area/last-frame-area CSS that already draws
  // a frame spanning multiple problem areas today.
  const splitFrameFragments = hasFrame && frameFragments && frameFragments.length > 1
    ? frameFragments
    : undefined;
  const outerFirstFrameClass = hasFrame && unit.isFirstProblemFrameArea ? "first-frame-area" : "";
  const outerLastFrameClass = hasFrame && unit.isLastProblemFrameArea ? "last-frame-area" : "";
  const outerFrameClasses = splitFrameFragments ? `${frameClasses} frame-split` : frameClasses;
  // memo 済みの本文エディタへ渡るので、エリアごとのハンドラは identity を固定する。
  const handleAreaChange = useCallback((
    previousIds: string[],
    nextBlocks: TextFlowBlock[],
    activeBlockId?: string | null,
    context?: TextFlowChangeContext,
  ) => {
    onChange(problem.id, area, previousIds, nextBlocks, activeBlockId, context);
  }, [area, onChange, problem.id]);
  // 問題エリアのユニットはそのエリアの中身しか doc に持たない。跨ぎコピーが問題ごと運ぶ
  // には、どの問題のどのエリアの中身かをここから渡すしかない。
  const scopeContainer = useMemo<TextRunScopeContainer>(
    () => [{ kind: "problemArea" as const, id: problem.id, area, template: problem }],
    [area, problem],
  );

  return (
    <section
      id={isFirstArea ? problem.id : undefined}
      data-page-block={isFirstArea ? "" : undefined}
      data-problem-area={area}
      data-problem-id={problem.id}
      data-flow-unit-id={unit.id}
      data-problem-frame-style={frameStyleId}
      className={`problem-area-flow-unit ${selected ? "selected" : ""} ${isColumnFlow ? "page-flow-unit" : ""} ${columnBlockFlowed ? "column-block-flowed" : ""} ${outerFrameClasses} ${outerFirstFrameClass} ${outerLastFrameClass} ${spaceAfterFollowerClass}`}
      style={style}
      onClick={(event) => {
        event.stopPropagation();
        onSelect(problem.id);
      }}
    >
      {splitFrameFragments && (
        <ProblemAreaFrameFragmentPieces
          fragments={splitFrameFragments}
          frameClasses={frameClasses}
          frameStyleId={frameStyleId}
          isFirstProblemFrameArea={unit.isFirstProblemFrameArea}
          isLastProblemFrameArea={unit.isLastProblemFrameArea}
        />
      )}
      {isFirstArea && (
        <BlockCommentBackground
          threads={getCommentThreadsForBlock(commentThreads, problem.id)}
          activeThreadId={highlightedCommentThreadId}
        />
      )}
      <button
        type="button"
        className="problem-action-button"
        aria-label={tEditor("pageCanvas.problemActions")}
        title={tEditor("pageCanvas.problemActions")}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          onActionMenuOpen(problem.id, area, event.currentTarget);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {area !== "lead" && (
        <div className="problem-area-side-note">
          <span>{problemAreaSideLabel(area, unit.problemNumber, tEditor)}</span>
        </div>
      )}
      {!isColumnFlow && isFirstArea && hasBreakBefore(problem) && (
        <PageBreakMarker blockId={problem.id} onRemove={onRemoveBreak} />
      )}
      <div className={`problem-area-paper-content ${showNumber ? "with-number" : ""}`}>
        {showNumber && (
          <span className="problem-number-marker" aria-label={tEditor("pageCanvas.problemNumber", { replace: { number: problemNumber } })} style={problemNumberStyle}>
            {formatProblemNumber(problemNumber)}
          </span>
        )}
        <div
          className="problem-area-paper-body"
        >
          <TextFlowWithInlineContent
            blocks={unit.blocks}
            selectedId={selectedId}
            mathFractionSizing={mathFractionSizing}
            historyRevision={historyRevision}
            breakGaps={isColumnFlow ? undefined : gaps}
            paginationBeforeIds={[
                      ...(isColumnFlow ? [] : getPageBreakBeforeIds(unit.blocks)),
                      ...getNestedPageBreakBeforeIds(unit.blocks),
                    ]}
            paginationMarkerKind={resolvePageBreakMarkerKind(isColumnFlow)}
            paginationMarkerKinds={getNestedPageBreakBeforeKinds(unit.blocks, resolvePageBreakMarkerKind(isColumnFlow))}
            columnFlowBlockLayouts={columnFlowBlockLayouts}
            boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(unit.blocks, boxFragmentSourceLayouts)}
            commentThreads={commentThreads}
            activeCommentThreadId={activeCommentThreadId}
            highlightedCommentThreadId={highlightedCommentThreadId}
            placeholder={area === "lead" ? "" : tEditor("body.inputPlaceholder")}
            showPlaceholder
            onSelect={onSelect}
            onCommentThreadSelect={onCommentThreadSelect}
            materials={materials}
            onMaterialInsert={onMaterialInsert}
            enableSelectionFormatMenu={false}
            enableBoxCommands
            onChange={handleAreaChange}
            inlineContentByTargetId={inlineContentByTargetId}
            changeDecorationState={changeDecorationState}
            textRunGroupId={textRunAssignment?.groupId}
            textRunOrder={textRunAssignment?.order}
            textRunUnitId={unit.id}
            textRunScopeId={`problem:${problem.id}:${area}`}
            textRunScopeContainer={scopeContainer}
            textRunPreserveEmpty
          />
        </div>
      </div>
      {afterInlineContent.length > 0 && (
        <InlineContentStack items={afterInlineContent} />
      )}
      {area !== "lead" && (
        <button
          type="button"
          className="problem-area-resize-handle"
          aria-label={tEditor("pageCanvas.areaHeight")}
          title={tEditor("pageCanvas.areaHeight")}
          onPointerDown={(event) => onResizeStart(problem, area, event)}
          onClick={(event) => event.stopPropagation()}
        />
      )}
    </section>
  );
}

/**
 * Decorative frame-border pieces for a framed problem area split by a manual
 * break: one open-ended piece per page/column segment the area's blocks landed
 * in. The real content is placed at bare (unpadded) coordinates by the
 * block-flow path (see `column-block-flowed` in globals.css), so these pieces
 * carry the usual with-frame padding themselves — outset from the tight content
 * rect they are given — to reproduce the same visual inset the CSS box model
 * gives the non-split case.
 */
function ProblemAreaFrameFragmentPieces({
  fragments,
  frameClasses,
  frameStyleId,
  isFirstProblemFrameArea,
  isLastProblemFrameArea,
}: {
  fragments: ProblemAreaFrameFragmentLayout[];
  frameClasses: string;
  frameStyleId: string | undefined;
  isFirstProblemFrameArea: boolean;
  isLastProblemFrameArea: boolean;
}) {
  const chromePadding = getProblemFrameChromePaddingPx(frameStyleId);
  return (
    <>
      {fragments.map((fragment, index) => {
        const isFirstPiece = index === 0 && isFirstProblemFrameArea;
        const isLastPiece = index === fragments.length - 1 && isLastProblemFrameArea;
        // Mirrors the CSS: only the top edge is ever removed for a continuation
        // piece (`:not(.first-frame-area) { padding-top: 0 }`) — the bottom
        // padding is always kept, giving each piece breathing room before its
        // open (or closed) bottom edge.
        const topOutset = isFirstPiece ? chromePadding.y : 0;
        const bottomOutset = chromePadding.y;
        return (
          <div
            key={`frame-piece-${index}`}
            aria-hidden="true"
            className={`problem-area-flow-unit ${frameClasses} ${isFirstPiece ? "first-frame-area" : ""} ${isLastPiece ? "last-frame-area" : ""}`}
            style={{
              position: "absolute",
              left: `${fragment.x - chromePadding.x}px`,
              top: `${fragment.y - topOutset}px`,
              width: `${fragment.width + chromePadding.x * 2}px`,
              height: `${fragment.height + topOutset + bottomOutset}px`,
              margin: 0,
              pointerEvents: "none",
            }}
          />
        );
      })}
    </>
  );
}

/** 区分の呼び名は `editor.block.problem*` が唯一の出典。ここはそれを引くだけ。 */
function problemAreaLabel(area: ProblemAreaKind, t: Translate<"editor">): string {
  if (area === "lead") {
    return t("block.problemLead");
  }

  if (area === "hints") {
    return t("block.problemHints");
  }

  if (area === "solution") {
    return t("block.problemSolution");
  }

  return t("block.problemPrompt");
}

function problemAreaSideLabel(
  area: ProblemAreaKind,
  problemNumber: number | undefined,
  t: Translate<"editor">,
): string {
  if (area === "prompt" && typeof problemNumber === "number") {
    return t("pageCanvas.areaPrompt", { replace: { number: problemNumber } });
  }

  return problemAreaLabel(area, t);
}

/**
 * Whether a manual break at this spot is a column break (改段) rather than a page break
 * (改ページ): either the whole page uses multi-column flow, or the block sits inside a local
 * (段組) layoutSection with more than one column. Shared by the body and problem context menus
 * so their item labels always agree with what `getColumnBreakBeforeBlockIdForContextMenu` /
 * the on-canvas marker actually do.
 */
function resolveContextMenuBreaksToColumn(isColumnFlow: boolean, layoutSection: LayoutSectionNode | null): boolean {
  return isColumnFlow || (!!layoutSection && getLayoutSectionColumnCount(layoutSection) > 1);
}

/** 段組の中かどうかで区切りの**種別**を決める (表示文言は描画側が作る)。 */
function resolvePageBreakMarkerKind(isColumnBreak: boolean): PageBreakMarkerKind {
  return isColumnBreak ? "columnBreak" : "pageBreak";
}

/**
 * Block-scoped menu items shared by the body ("本文操作") and problem ("問題操作") context
 * menus: "ここを段組にする" / "段組を変更"+"段組を解除" / block-scoped "素材に追加" / the
 * 改ページ・改段 挿入・解除 pair. The problem menu renders this only when its target is a
 * concrete block inside prompt/hints/solution (not `lead`, and not the problem-wide actions
 * like copying the whole problem or saving it as a material).
 */
function BlockContextMenuItems({
  targetBlockId,
  selectionBlockIds,
  layoutSection,
  canWrapInColumns,
  canEditColumns,
  breakKind,
  showInsertBreak,
  showRemoveBreak,
  onWrapBlockInColumns,
  onUnwrapColumns,
  onColumnCountChange,
  onColumnRuleSettings,
  onMaterialSaveRequest,
  onSelectionMaterialSaveRequest,
  boxId,
  onBoxTitleEditRequest,
  onBoxSettingsRequest,
  onBoxCopy,
  onBoxDelete,
  onInsertBreak,
  onRemoveBreak,
  onClose,
}: {
  targetBlockId: string;
  selectionBlockIds: string[];
  layoutSection: LayoutSectionNode | null;
  canWrapInColumns: boolean;
  canEditColumns: boolean;
  /**
   * 区切りの**種別**。表示文言を型の判別子にすると、訳した瞬間に型が変わって
   * 分岐が壊れる (`page-break-gap-extension.ts` で実際に起きていた形)。
   * 文言はメニュー側が種別から作る。
   */
  breakKind: PageBreakMarkerKind;
  showInsertBreak: boolean;
  showRemoveBreak: boolean;
  onWrapBlockInColumns?: (blockIds: string[], columnCount: number) => void;
  onUnwrapColumns?: (sectionId: string) => void;
  onColumnCountChange: (sectionId: string, columnCount: number) => void;
  onColumnRuleSettings: (sectionId: string, blockId: string) => void;
  onMaterialSaveRequest?: (targetBlockId?: string | null) => void;
  onSelectionMaterialSaveRequest?: (blockIds: string[]) => void;
  boxId?: string | null;
  onBoxTitleEditRequest?: (boxId: string) => void;
  onBoxSettingsRequest?: (boxId: string) => void;
  onBoxCopy?: (boxId: string) => void;
  onBoxDelete?: (boxId: string) => void;
  onInsertBreak: () => void;
  onRemoveBreak: () => void;
  onClose: () => void;
}) {
  const tEditor = useT("editor");
  const tSettings = useT("settings");
  // 「改ページ」「改段」は本文編集面の語彙 (`editor` namespace)。
  const breakLabel = breakKind === "columnBreak"
    ? tEditor("pagination.columnBreak")
    : tEditor("pagination.pageBreak");
  const layoutSectionColumnCount = layoutSection ? getLayoutSectionColumnCount(layoutSection) : 1;

  return (
    <>
      {canWrapInColumns && (
        <div className="page-context-menu-submenu">
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            onClick={(event) => event.preventDefault()}
          >
            <Columns3 size={15} />
            <span>{tEditor(selectionBlockIds.length > 1 ? "pageMenu.wrapSelectionInColumns" : "pageMenu.wrapInColumns")}</span>
            <ChevronRight size={14} className="page-context-menu-caret" aria-hidden="true" />
          </button>
          <div className="page-context-menu-submenu-panel" role="menu" aria-label={tEditor("pageMenu.columns")}>
            {[2, 3, 4].map((columnCount) => (
              <button
                key={columnCount}
                type="button"
                role="menuitem"
                onClick={() => {
                  onWrapBlockInColumns?.(
                    selectionBlockIds.length > 0 ? selectionBlockIds : [targetBlockId],
                    columnCount,
                  );
                  onClose();
                }}
              >
                <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
              </button>
            ))}
          </div>
        </div>
      )}
      {canEditColumns && layoutSection && (
        <>
          <button type="button" role="menuitem" onClick={() => { onColumnRuleSettings(layoutSection.id, targetBlockId); onClose(); }}>
            <Settings2 size={15} />
            <span>{tSettings("columnRule.title")}</span>
          </button>
          <div className="page-context-menu-submenu">
            <button
              type="button"
              role="menuitem"
              aria-haspopup="menu"
              onClick={(event) => event.preventDefault()}
            >
              <Columns3 size={15} />
              <span>{tEditor("pageMenu.changeColumns")}</span>
              <ChevronRight size={14} className="page-context-menu-caret" aria-hidden="true" />
            </button>
            <div className="page-context-menu-submenu-panel" role="menu" aria-label={tEditor("pageMenu.changeColumns")}>
              {[2, 3, 4].map((columnCount) => (
                <button
                  key={columnCount}
                  type="button"
                  role="menuitemradio"
                  aria-checked={layoutSectionColumnCount === columnCount}
                  className={layoutSectionColumnCount === columnCount ? "selected" : ""}
                  onClick={() => {
                    onColumnCountChange(layoutSection.id, columnCount);
                    onClose();
                  }}
                >
                  <span>{tEditor("block.columns", { replace: { columns: columnCount } })}</span>
                </button>
              ))}
            </div>
          </div>
          {onUnwrapColumns && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onUnwrapColumns(layoutSection.id);
                onClose();
              }}
            >
              <Columns3 size={15} />
              <span>{tEditor("pageMenu.unwrapColumns")}</span>
            </button>
          )}
        </>
      )}
      {boxId && onBoxTitleEditRequest && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxTitleEditRequest(boxId);
            onClose();
          }}
        >
          <Heading size={15} />
          <span>{tEditor("pageMenu.boxEditTitle")}</span>
        </button>
      )}
      {boxId && onBoxSettingsRequest && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxSettingsRequest(boxId);
            onClose();
          }}
        >
          <Settings2 size={15} />
          <span>{tEditor("pageMenu.boxSettings")}</span>
        </button>
      )}
      {boxId && onBoxCopy && (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            onBoxCopy(boxId);
            onClose();
          }}
        >
          <Copy size={15} />
          <span>{tEditor("pageMenu.boxCopy")}</span>
        </button>
      )}
      {boxId && onBoxDelete && (
        <button
          type="button"
          role="menuitem"
          className="danger"
          onClick={() => {
            onBoxDelete(boxId);
            onClose();
          }}
        >
          <Trash2 size={15} />
          <span>{tEditor("pageMenu.boxDelete")}</span>
        </button>
      )}
      {(selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest) || onMaterialSaveRequest ? (
        <button
          type="button"
          role="menuitem"
          onClick={() => {
            if (selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest) {
              onSelectionMaterialSaveRequest(selectionBlockIds);
            } else {
              onMaterialSaveRequest?.(targetBlockId);
            }
            onClose();
          }}
        >
          <PackagePlus size={15} />
          <span>{tEditor(selectionBlockIds.length > 1 && onSelectionMaterialSaveRequest ? "pageMenu.saveSelectionAsMaterial" : "pageMenu.saveAsMaterial")}</span>
        </button>
      ) : null}
      {showInsertBreak && (
        <button type="button" role="menuitem" onClick={onInsertBreak}>
          <CornerDownRight size={15} />
          <span>{tEditor("pagination.insertBreak", { kind: breakLabel })}</span>
        </button>
      )}
      {showRemoveBreak && (
        <button type="button" role="menuitem" onClick={onRemoveBreak}>
          <CornerDownRight size={15} />
          <span>{tEditor("pagination.removeBreak", { kind: breakLabel })}</span>
        </button>
      )}
    </>
  );
}

function RunningRegionBand({
  kind,
  label,
  region,
  metrics,
  layout,
  pageNumber,
  editing,
  focusRequest,
  historyRevision,
  onEdit,
  onBlocksChange,
  onContentHeightChange,
  onEdgePointerDown,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  overlayEditing,
  onOverlayEditingChange,
  onOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  kind: RunningRegionKind;
  label: string;
  region?: PageRunningRegion;
  metrics: PageMetrics;
  layout: PageLayout;
  pageNumber: number;
  editing: boolean;
  focusRequest: number;
  historyRevision: number;
  onEdit: (kind: RunningRegionKind | null, pageNumber?: number) => void;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  onEdgePointerDown: (
    kind: RunningRegionKind,
    edge: RunningRegionEdge,
    event: ReactPointerEvent<HTMLElement>,
  ) => void;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  overlayEditing: boolean;
  onOverlayEditingChange: (editing: boolean) => void;
  onOverlayChange: (kind: RunningRegionKind, overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditor = useT("editor");
  if (!region?.enabled) {
    return null;
  }

  const bounds = getRunningRegionBoundsMm(layout, kind);
  const top = mmToPx(bounds.topMm);
  // Shared with `PageRunningRegionView`: the band used to subtract the page sheet's 2px border
  // while the displayed region did not. An SVG `viewBox` hid the difference; React places shapes at
  // absolute px, so the two surfaces have to agree on the overlay's coordinate space.
  const { heightPx: height, widthPx: width } = getRunningRegionOverlaySize(
    metrics.content.widthPx,
    region,
  );

  return (
    <div
      className={`page-running-editor-band ${kind} ${editing ? "editing" : ""}`}
      style={{
        top: `${top}px`,
        left: `${metrics.margins.leftPx}px`,
        width: `${width}px`,
        height: `${height}px`,
      }}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
      }}
      onDoubleClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onEdit(kind, pageNumber);
      }}
    >
      {editing && <span className="page-running-editor-label">{label}</span>}
      {editing && (
        <RunningRegionDirectEditor
          kind={kind}
          label={label}
          region={region}
          focusRequest={focusRequest}
          historyRevision={historyRevision}
          onBlocksChange={onBlocksChange}
          onContentHeightChange={onContentHeightChange}
          overlayEditing={overlayEditing}
          overlayCommandRequest={overlayCommandRequest}
          overlayImageRequest={overlayImageRequest}
          overlayActionRequest={overlayActionRequest}
          overlayArrangeShortcutLabels={overlayArrangeShortcutLabels}
          overlayWidth={width}
          overlayHeight={height}
          onOverlayEditingChange={onOverlayEditingChange}
          onOverlayChange={onOverlayChange}
          onOverlayCommandHandled={onOverlayCommandHandled}
          onOverlayImageHandled={onOverlayImageHandled}
          onOverlayActionHandled={onOverlayActionHandled}
          onOverlayModeStatusChange={onOverlayModeStatusChange}
          onOverlaySelectionSummaryChange={onOverlaySelectionSummaryChange}
          onOverlayActiveToolChange={onOverlayActiveToolChange}
        />
      )}
      {editing && (
        <>
          <button
            type="button"
            className="page-running-edge start"
            aria-label={tEditor("running.startEdge", { replace: { region: label } })}
            title={tEditor("running.startEdge", { replace: { region: label } })}
            onPointerDown={(event) => onEdgePointerDown(kind, "start", event)}
            onClick={(event) => event.stopPropagation()}
          />
          <button
            type="button"
            className="page-running-edge end"
            aria-label={tEditor("running.endEdge", { replace: { region: label } })}
            title={tEditor("running.endEdge", { replace: { region: label } })}
            onPointerDown={(event) => onEdgePointerDown(kind, "end", event)}
            onClick={(event) => event.stopPropagation()}
          />
        </>
      )}
    </div>
  );
}

function RunningRegionDirectEditor({
  kind,
  label,
  region,
  focusRequest,
  historyRevision,
  onBlocksChange,
  onContentHeightChange,
  overlayEditing,
  overlayCommandRequest,
  overlayImageRequest,
  overlayActionRequest,
  overlayArrangeShortcutLabels,
  overlayWidth,
  overlayHeight,
  onOverlayEditingChange,
  onOverlayChange,
  onOverlayCommandHandled,
  onOverlayImageHandled,
  onOverlayActionHandled,
  onOverlayModeStatusChange,
  onOverlaySelectionSummaryChange,
  onOverlayActiveToolChange,
}: {
  kind: RunningRegionKind;
  label: string;
  region: PageRunningRegion;
  focusRequest: number;
  historyRevision: number;
  onBlocksChange: (kind: RunningRegionKind, nextBlocks: TextFlowBlock[]) => void;
  onContentHeightChange: (kind: RunningRegionKind, contentHeightPx: number) => void;
  overlayEditing: boolean;
  overlayCommandRequest: OverlayCommandRequest | null;
  overlayImageRequest: OverlayImageRequest | null;
  overlayActionRequest: OverlayActionRequest | null;
  overlayArrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  overlayWidth: number;
  overlayHeight: number;
  onOverlayEditingChange: (editing: boolean) => void;
  onOverlayChange: (kind: RunningRegionKind, overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  onOverlayCommandHandled: (requestId: number) => void;
  onOverlayImageHandled: (requestId: number) => void;
  onOverlayActionHandled: (requestId: number) => void;
  onOverlayModeStatusChange?: (status: OverlayModeStatus) => void;
  onOverlaySelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  onOverlayActiveToolChange?: (tool: OverlayTool) => void;
}) {
  const tEditor = useT("editor");
  const { auxiliarySurfaceExtensions } = useEditorExtensions();
  const {
    overlayEditPolicy,
    overlayShapeDecorations,
    textFlowEditPolicy,
  } = auxiliarySurfaceExtensions ?? {};
  const editorRef = useRef<HTMLDivElement | null>(null);
  const [selectedRunningBlockId, setSelectedRunningBlockId] = useState<string | null>(null);
  const [runningSelectPointRequest, setRunningSelectPointRequest] = useState<OverlaySelectPointRequest | null>(null);
  const runningSelectPointRequestIdRef = useRef(0);
  const runningOverlayPreviewPointerHandoffRef = useRef<OverlayPreviewPointerHandoff | null>(null);
  const blocks = useMemo(() => pageRunningRegionToTextFlowBlocks(region, kind), [kind, region]);
  // The interactive layer sits above the running text at `z-index: 3` with `pointer-events: auto`,
  // so mounting it for a shapeless header would swallow every click meant for the text editor. The
  // removed SVG ghost returned null in exactly this case (the serializer bailed on an empty shape
  // list); the display surface has no such constraint because it is never interactive.
  const runningOverlayHasShapes = useMemo(
    () => (region.overlay?.overlaySnapshot?.shapes?.length ?? 0) > 0,
    [region.overlay?.overlaySnapshot],
  );

  const focusRunningRegionTextEditor = useCallback(() => {
    window.setTimeout(() => {
      const editable = editorRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus({ preventScroll: true });
    }, 0);
  }, []);

  useEffect(() => {
    if (overlayEditing) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const editable = editorRef.current?.querySelector<HTMLElement>("[contenteditable='true']");
      editable?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusRequest, overlayEditing]);

  useEffect(() => () => {
    runningOverlayPreviewPointerHandoffRef.current?.cleanup();
    runningOverlayPreviewPointerHandoffRef.current = null;
  }, []);

  useLayoutEffect(() => {
    if (overlayEditing) {
      return;
    }

    const shell = editorRef.current?.querySelector<HTMLElement>(".text-flow-shell");
    if (!shell) {
      return;
    }

    const measuredHeight = Math.max(shell.scrollHeight, shell.getBoundingClientRect().height);
    onContentHeightChange(kind, measuredHeight);
  }, [blocks, kind, onContentHeightChange, overlayEditing, overlayWidth]);

  const nextRunningSelectPointRequestId = useCallback(() => {
    runningSelectPointRequestIdRef.current += 1;
    return Date.now() * 1000 + runningSelectPointRequestIdRef.current;
  }, []);

  const requestRunningRegionOverlaySelection = useCallback((
    bounds: DOMRect,
    clientX: number,
    clientY: number,
    startCrop: boolean,
    dragEndScreenPoint?: ClientPoint,
  ) => {
    if (bounds.width <= 0 || bounds.height <= 0 || overlayWidth <= 0 || overlayHeight <= 0) {
      return;
    }

    onOverlayEditingChange(true);
    setRunningSelectPointRequest({
      id: nextRunningSelectPointRequestId(),
      point: {
        x: ((clientX - bounds.left) / bounds.width) * overlayWidth,
        y: ((clientY - bounds.top) / bounds.height) * overlayHeight,
      },
      screenPoint: {
        x: clientX,
        y: clientY,
      },
      dragEndPoint: dragEndScreenPoint
        ? {
            x: ((dragEndScreenPoint.x - bounds.left) / bounds.width) * overlayWidth,
            y: ((dragEndScreenPoint.y - bounds.top) / bounds.height) * overlayHeight,
          }
        : undefined,
      startCrop,
      focusTextOnMiss: false,
    });
  }, [nextRunningSelectPointRequestId, onOverlayEditingChange, overlayHeight, overlayWidth]);

  const startRunningRegionOverlayPreviewPointerHandoff = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    bounds: DOMRect,
  ) => {
    event.preventDefault();
    event.stopPropagation();
    const start = { x: event.clientX, y: event.clientY };
    const handoff: OverlayPreviewPointerHandoff = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      start,
      latest: start,
      cleanup: () => undefined,
    };

    const finish = () => {
      window.removeEventListener("pointermove", handleWindowPointerMove, true);
      window.removeEventListener("pointerup", handleWindowPointerUp, true);
      window.removeEventListener("pointercancel", handleWindowPointerUp, true);
      if (runningOverlayPreviewPointerHandoffRef.current === handoff) {
        runningOverlayPreviewPointerHandoffRef.current = null;
      }
    };
    const forwardPointerUp = (nativeEvent: PointerEvent) => {
      handoff.latest = { x: nativeEvent.clientX, y: nativeEvent.clientY };
      requestRunningRegionOverlaySelection(bounds, handoff.start.x, handoff.start.y, false, handoff.latest);
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
      finish();
    };
    const isHandoffPointerEvent = (nativeEvent: PointerEvent) => (
      nativeEvent.pointerId === handoff.pointerId ||
      (nativeEvent.pointerType === "mouse" && handoff.pointerType === "mouse")
    );
    function handleWindowPointerMove(nativeEvent: PointerEvent) {
      if (!isHandoffPointerEvent(nativeEvent)) {
        return;
      }

      handoff.latest = { x: nativeEvent.clientX, y: nativeEvent.clientY };
      nativeEvent.preventDefault();
      nativeEvent.stopPropagation();
    }
    function handleWindowPointerUp(nativeEvent: PointerEvent) {
      if (!isHandoffPointerEvent(nativeEvent)) {
        return;
      }

      forwardPointerUp(nativeEvent);
    }

    handoff.cleanup = finish;
    runningOverlayPreviewPointerHandoffRef.current?.cleanup();
    runningOverlayPreviewPointerHandoffRef.current = handoff;
    window.addEventListener("pointermove", handleWindowPointerMove, true);
    window.addEventListener("pointerup", handleWindowPointerUp, true);
    window.addEventListener("pointercancel", handleWindowPointerUp, true);

    flushSync(() => {
      onOverlayEditingChange(true);
    });
  }, [onOverlayEditingChange, requestRunningRegionOverlaySelection]);

  const handleRunningRegionOverlayPreviewPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    startRunningRegionOverlayPreviewPointerHandoff(event, event.currentTarget.getBoundingClientRect());
  }, [startRunningRegionOverlayPreviewPointerHandoff]);

  const handleRunningRegionOverlayPreviewDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();

    requestRunningRegionOverlaySelection(
      event.currentTarget.getBoundingClientRect(),
      event.clientX,
      event.clientY,
      true,
    );
  }, [requestRunningRegionOverlaySelection]);

  const handleRunningRegionSelectPointHandled = useCallback((requestId: number, hitShape: boolean) => {
    setRunningSelectPointRequest((current) => current?.id === requestId ? null : current);
    if (!hitShape) {
      onOverlayEditingChange(false);
      focusRunningRegionTextEditor();
    }
  }, [focusRunningRegionTextEditor, onOverlayEditingChange]);

  return (
    <div
      className={`page-running-direct-editor ${kind}`}
      role="group"
      aria-label={tEditor("running.edit", { replace: { region: label } })}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      <div className="page-running-direct-flow" ref={editorRef}>
        <TextFlowEditor
          blocks={blocks}
          selectedId={selectedRunningBlockId}
          placeholder={tEditor("running.placeholder", { replace: { region: label } })}
          historyRevision={historyRevision}
          showPlaceholder
          onSelect={setSelectedRunningBlockId}
          onChange={(_previousIds, nextBlocks) => onBlocksChange(kind, nextBlocks)}
          onFocusChange={(focused, blockIds) => {
            if (focused && !selectedRunningBlockId) {
              setSelectedRunningBlockId(blockIds[0] ?? null);
            }
          }}
          editPolicy={textFlowEditPolicy}
        />
      </div>
      {overlayEditing ? (
        <div className="page-running-direct-overlay editing">
          <OverlayCanvasEditor
            key={`${kind}-running-overlay`}
            externalRevision={historyRevision}
            overlay={region.overlay ?? {}}
            canvasWidth={overlayWidth}
            canvasHeight={overlayHeight}
            bleedValues={{ x: 0, top: 0 }}
            imageInsertAreaWidth={overlayWidth}
            imageInsertAreaHeight={overlayHeight}
            commandRequest={overlayCommandRequest}
            imageRequest={overlayImageRequest}
            actionRequest={overlayActionRequest}
            arrangeShortcutLabels={overlayArrangeShortcutLabels}
            selectPointRequest={runningSelectPointRequest}
            editPolicy={overlayEditPolicy}
            shapeDecorations={overlayShapeDecorations}
            onCommandHandled={onOverlayCommandHandled}
            onImageHandled={onOverlayImageHandled}
            onActionHandled={onOverlayActionHandled}
            onSelectPointHandled={handleRunningRegionSelectPointHandled}
            onRequestTextMode={() => {
              setRunningSelectPointRequest(null);
              onOverlayEditingChange(false);
              focusRunningRegionTextEditor();
            }}
            onModeStatusChange={onOverlayModeStatusChange}
            onSelectionSummaryChange={onOverlaySelectionSummaryChange}
            onActiveToolChange={onOverlayActiveToolChange}
            onChange={(nextOverlay, options) => onOverlayChange(kind, nextOverlay, options)}
          />
        </div>
      ) : (
        runningOverlayHasShapes ? (
          <PageRunningRegionOverlay
            overlay={region.overlay}
            widthPx={overlayWidth}
            heightPx={overlayHeight}
            className="page-running-direct-overlay preview"
            interactive
            onPointerDown={handleRunningRegionOverlayPreviewPointerDown}
            onDoubleClick={handleRunningRegionOverlayPreviewDoubleClick}
          />
        ) : null
      )}
    </div>
  );
}

export function PageBreakMarker({
  blockId,
  kind = "pageBreak",
  onRemove,
}: {
  blockId: string;
  kind?: PageBreakMarkerKind;
  onRemove?: (blockId: string) => void;
}) {
  // 区切り印の文言は本文編集面の語彙 (`editor` namespace)。
  const t = useT("editor");
  const label = kind === "columnBreak" ? t("pagination.columnBreak") : t("pagination.pageBreak");
  const removeLabel = t("pagination.removeBreak", { replace: { kind: label } });
  return (
    <div className="page-break-marker" data-page-break-marker="" data-page-break-block-id={blockId}>
      <span />
      <strong>{label}</strong>
      <span />
      {onRemove && (
        <button
          type="button"
          className="page-break-marker-remove"
          aria-label={removeLabel}
          onMouseDown={(event) => {
            activatePageBreakMarkerOnMouseDown(event, () => onRemove(blockId));
          }}
          onClick={(event) => {
            activatePageBreakMarkerOnClick(event, () => onRemove(blockId));
          }}
        >
          {t("pagination.removeBreakButton")}
        </button>
      )}
    </div>
  );
}

interface EmptyProblemAreaOverlayAnchorAddition {
  problemId: string;
  area: ProblemAreaKind;
  block: RichBlock;
}

interface EmptyProblemAreaOverlayAnchorTarget {
  problemId: string;
  area: ProblemAreaKind;
  hitBounds: OverlayRect;
  anchorBounds: OverlayRect;
}

interface OverlayRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function materializeEmptyProblemAreaOverlayAnchors(
  overlay: PageOverlay,
  document: SigmaDocument,
  overlayLayerElement: HTMLElement | null,
  canvasWidth: number,
  canvasHeight: number,
  blockAnchorScopeElement: HTMLElement | null = null,
): { overlay: PageOverlay; additions: EmptyProblemAreaOverlayAnchorAddition[] } {
  if (!overlay.overlaySnapshot || !overlayLayerElement) {
    return { overlay, additions: [] };
  }

  const layerRect = overlayLayerElement.getBoundingClientRect();
  if (layerRect.width <= 0 || layerRect.height <= 0) {
    return { overlay, additions: [] };
  }

  const targets = collectEmptyProblemAreaOverlayAnchorTargets(
    document,
    overlayLayerElement,
    layerRect,
    canvasWidth,
    canvasHeight,
    blockAnchorScopeElement,
  );
  if (targets.length === 0) {
    return { overlay, additions: [] };
  }

  const knownBlockIds = collectDocumentBlockIds(document);
  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  const pageCanvas = overlayLayerElement.closest(".page-canvas");
  const scope = blockAnchorScopeElement && overlayLayerElement.ownerDocument.contains(blockAnchorScopeElement)
    ? blockAnchorScopeElement
    : pageCanvas?.querySelector<HTMLElement>(".page-flow") ?? pageCanvas ?? overlayLayerElement.ownerDocument;
  const { rects } = measureBlockTops(overlayLayerElement, scope, canvasHeight, canvasWidth);
  const resolvedShapes = rects.size > 0
    ? resolveShapesPosition(snapshot.shapes, rects, calculateReserveSpaceGaps(snapshot.shapes))
    : resolveShapeAnchorPositions(snapshot.shapes);
  const resolvedShapeById = new Map(resolvedShapes.map((shape) => [shape.id, shape]));
  const createdBlocksByTarget = new Map<string, RichBlock>();
  const additions: EmptyProblemAreaOverlayAnchorAddition[] = [];
  let changed = false;

  const shapes = snapshot.shapes.map((shape): OverlayShape => {
    if (shape.anchor?.type === "page" || shape.anchor?.type === "shape") {
      return shape;
    }

    const displayShape = resolvedShapeById.get(shape.id) ?? shape;
    const bounds = getShapeBounds(displayShape);
    const target = targets.find((item) => pointInsideOverlayRect({
      x: bounds.x + bounds.w / 2,
      y: bounds.y + bounds.h / 2,
    }, item.hitBounds));
    if (!target) {
      return shape;
    }
    if (
      shape.anchor?.type === "block" &&
      !knownBlockIds.has(shape.anchor.blockId) &&
      shape.anchor.blockId !== emptyProblemAreaEditorBlockId(target.problemId, target.area)
    ) {
      return shape;
    }

    const targetKey = `${target.problemId}:${target.area}`;
    let block = createdBlocksByTarget.get(targetKey);
    if (!block) {
      block = createEmptyProblemAreaAnchorBlock(target.area);
      createdBlocksByTarget.set(targetKey, block);
      knownBlockIds.add(block.id);
      additions.push({ problemId: target.problemId, area: target.area, block });
    }

    changed = true;
    return {
      ...shape,
      anchor: {
        type: "block",
        blockId: block.id,
        dx: displayShape.x - target.anchorBounds.x,
        dy: displayShape.y - target.anchorBounds.y,
      },
    };
  });
  return {
    overlay: changed
      ? {
          ...overlay,
          overlaySnapshot: {
            ...snapshot,
            shapes,
          },
        }
      : overlay,
    additions,
  };
}

function collectEmptyProblemAreaOverlayAnchorTargets(
  document: SigmaDocument,
  overlayLayerElement: HTMLElement,
  layerRect: DOMRect,
  canvasWidth: number,
  canvasHeight: number,
  blockAnchorScopeElement: HTMLElement | null = null,
): EmptyProblemAreaOverlayAnchorTarget[] {
  const problemById = new Map(document.content
    .filter((block): block is ProblemNode => block.type === "problem")
    .map((problem) => [problem.id, problem]));
  const targets: EmptyProblemAreaOverlayAnchorTarget[] = [];

  const searchRoot: ParentNode = blockAnchorScopeElement && overlayLayerElement.ownerDocument.contains(blockAnchorScopeElement)
    ? blockAnchorScopeElement
    : overlayLayerElement.ownerDocument;

  searchRoot
    .querySelectorAll<HTMLElement>("[data-problem-area][data-problem-id]")
    .forEach((areaElement) => {
      const problemId = areaElement.getAttribute("data-problem-id");
      const areaValue = areaElement.getAttribute("data-problem-area");
      const problem = problemId ? problemById.get(problemId) : null;
      const area = isProblemAreaKind(areaValue) ? areaValue : null;
      if (!problemId || !problem || !area || problem[area].length > 0) {
        return;
      }

      const hitBounds = elementRectToOverlayRect(areaElement, layerRect, canvasWidth, canvasHeight);
      const bodyElement = areaElement.querySelector<HTMLElement>(".problem-area-paper-body") ?? areaElement;
      const emptyBlockId = emptyProblemAreaEditorBlockId(problemId, area);
      const placeholderBlock = areaElement.querySelector<HTMLElement>(`[data-sigma-doc-id="${CSS.escape(emptyBlockId)}"]`);
      const anchorElement = placeholderBlock ?? bodyElement;
      targets.push({
        problemId,
        area,
        hitBounds,
        anchorBounds: elementRectToOverlayRect(anchorElement, layerRect, canvasWidth, canvasHeight),
      });
    });

  return targets;
}

function collectDocumentBlockIds(document: SigmaDocument): Set<string> {
  const ids = new Set<string>();
  for (const block of document.content) {
    ids.add(block.id);
    if (block.type === "layoutSection") {
      block.children.forEach((child) => ids.add(child.id));
    }
    if (block.type !== "problem") {
      continue;
    }
    for (const area of PROBLEM_AREA_ORDER) {
      block[area].forEach((richBlock) => ids.add(richBlock.id));
    }
  }
  return ids;
}

function elementRectToOverlayRect(
  element: HTMLElement,
  layerRect: DOMRect,
  canvasWidth: number,
  canvasHeight: number,
): OverlayRect {
  const rect = element.getBoundingClientRect();
  const scaleX = canvasWidth / layerRect.width;
  const scaleY = canvasHeight / layerRect.height;
  return {
    x: (rect.left - layerRect.left) * scaleX,
    y: (rect.top - layerRect.top) * scaleY,
    w: rect.width * scaleX,
    h: rect.height * scaleY,
  };
}

function pointInsideOverlayRect(point: OverlayPoint, rect: OverlayRect): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w &&
    point.y >= rect.y && point.y <= rect.y + rect.h;
}

function getTopmostBodyModeOverlayHit(shapes: OverlayShape[], point: OverlayPoint): OverlayShape | null {
  for (let index = shapes.length - 1; index >= 0; index -= 1) {
    const shape = shapes[index];
    const margin = isBodyModeOpenStrokeShape(shape)
      ? BODY_MODE_OPEN_STROKE_HIT_MARGIN
      : BODY_MODE_OVERLAY_HIT_MARGIN;
    if (hitTestShape(shape, point, margin)) {
      return shape;
    }
  }

  return null;
}

function isBodyModeOpenStrokeShape(shape: OverlayShape): boolean {
  return shape.type === "arrow" || shape.type === "line" || shape.type === "arc";
}

function getMathTexFromRange(range: Range): string[] {
  const fragment = range.cloneContents();
  const values = Array.from(fragment.querySelectorAll<HTMLElement>("[data-sigma-doc-math-inline], .inline-math-node"))
    .map((element) => element.getAttribute("data-tex") ?? "")
    .filter(Boolean);
  return Array.from(new Set(values));
}

function findBlockElement(root: HTMLElement, blockId: string): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    `#${CSS.escape(blockId)}, [data-sigma-doc-id="${CSS.escape(blockId)}"]`,
  );
}

function measureCommentThreadTop(canvas: HTMLElement, thread: SigmaCommentThread, zoom: number): number | null {
  const threadElement = findCommentThreadElement(canvas, thread.id);
  if (threadElement) {
    return measureElementTopInCanvas(canvas, threadElement, zoom);
  }
  return measureCommentAnchorTop(canvas, thread.anchor, zoom);
}

function measureCommentAnchorTop(canvas: HTMLElement, anchor: SigmaCommentAnchor, zoom: number): number | null {
  if (anchor.type === "textRange") {
    return measureElementTopInCanvas(canvas, findBlockElement(canvas, anchor.start.blockId), zoom);
  }

  if (anchor.type === "inlineMath") {
    const mathElement = canvas.querySelector<HTMLElement>(
      `.inline-math-node[data-id="${CSS.escape(anchor.mathInlineId)}"]`,
    );
    return measureElementTopInCanvas(canvas, mathElement ?? findBlockElement(canvas, anchor.blockId), zoom);
  }

  if (anchor.type === "block") {
    return measureElementTopInCanvas(canvas, findBlockElement(canvas, anchor.blockId), zoom);
  }

  if (anchor.type === "overlayShape") {
    const shapeElement = anchor.shapeIds
      .map((shapeId) => findOverlayShapeElement(canvas, shapeId))
      .find((element): element is HTMLElement => Boolean(element)) ?? null;
    return measureElementTopInCanvas(canvas, shapeElement, zoom);
  }

  if (anchor.type === "overlayMath" && anchor.shapeId) {
    return measureElementTopInCanvas(canvas, findOverlayShapeElement(canvas, anchor.shapeId), zoom);
  }

  return null;
}

function findCommentThreadElement(canvas: HTMLElement, threadId: string): HTMLElement | null {
  const escaped = CSS.escape(threadId);
  return canvas.querySelector<HTMLElement>(
    `[data-comment-thread-id="${escaped}"], [data-comment-thread-ids~="${escaped}"]`,
  );
}

function findOverlayShapeElement(canvas: HTMLElement, shapeId: string): HTMLElement | null {
  return canvas.querySelector<HTMLElement>(`[data-overlay-shape-id="${CSS.escape(shapeId)}"]`);
}

function measureElementTopInCanvas(canvas: HTMLElement, element: HTMLElement | null, zoom: number): number | null {
  if (!element) {
    return null;
  }
  const zoomScale = Math.max(0.01, zoom / 100);
  const canvasRect = canvas.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  return Math.max(0, (elementRect.top - canvasRect.top) / zoomScale);
}

function OverlayPreview({
  resolvedView,
  visiblePageRange,
  stackLayer = "foreground",
  renderShapes = true,
  pinnedShapeIds = [],
  commentThreads = [],
  highlightedCommentThreadId = null,
  diffShapeClassNames,
  shapeDecorations,
  ghostShapes,
  onPointerDown,
  onDoubleClick,
}: {
  resolvedView: ResolvedOverlayView;
  visiblePageRange: VisiblePageRange;
  stackLayer?: OverlayPreviewStackLayer;
  renderShapes?: boolean;
  pinnedShapeIds?: readonly string[];
  commentThreads?: SigmaCommentThread[];
  highlightedCommentThreadId?: string | null;
  /** shapeId -> feature-owned presentation class for an existing shape. */
  diffShapeClassNames?: ReadonlyMap<string, string>;
  /** Feature-owned visual decorations shared with the interactive canvas. */
  shapeDecorations?: ReadonlyMap<string, OverlayShapeDecoration>;
  /** Feature-owned read-only shape states, never part of `resolvedView`. */
  ghostShapes?: readonly { key: string; shape: OverlayShape; assets: Record<string, OverlayAsset>; className: string }[];
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}) {
  countPerformanceEvent("OverlayPreview.render");
  const pinnedKey = pinnedShapeIds.join("\u0000");
  const visibleShapes = useMemo(
    () => getVisibleOverlayShapes(resolvedView, stackLayer, visiblePageRange, pinnedShapeIds),
    // `pinnedKey` intentionally collapses the selection array to primitive deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pinnedKey, resolvedView, stackLayer, visiblePageRange],
  );
  /**
   * The table each chart reads. Built from `resolvedView.shapes` — every shape, not the visible
   * window — because a chart on one page routinely references a table on another.
   *
   * This is the ordinary reading view (it mounts whenever overlay editing is off), so omitting it
   * would leave the on-screen chart frozen on its snapshot while print, PDF and the SVG export drew
   * the live table: exactly the screen-vs-print divergence this feature exists to avoid.
   */
  const chartSourceTables = useMemo(() => {
    const byChart = new Map<string, SigmaTableSpec>();
    for (const shape of resolvedView.shapes) {
      if (shape.type !== "chartShape" || !shape.props.sourceTableShapeId) {
        continue;
      }
      const table = resolvedView.shapeById.get(shape.props.sourceTableShapeId);
      if (table?.type === "tableShape") {
        byChart.set(shape.id, table.props.table);
      }
    }
    return byChart;
  }, [resolvedView]);

  // Ghosts are a separate, non-interactive presentation layer and remain
  // visible while the interactive canvas owns the persisted shapes.
  const visibleGhostShapes = ghostShapes ?? [];

  if (resolvedView.shapes.length === 0 && visibleGhostShapes.length === 0) {
    return null;
  }

  return (
    <div
      className="page-overlay-preview"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {renderShapes && visibleShapes.map((shape) => (
        <OverlayShapeReadOnlyView
          key={shape.id}
          shape={shape}
          assets={resolvedView.assets}
          chartSourceTable={chartSourceTables.get(shape.id) ?? null}
          diffClassName={diffShapeClassNames?.get(shape.id)}
          decoration={shapeDecorations?.get(shape.id) ?? null}
        />
      ))}
      {visibleShapes.map((shape) => (
        <OverlayCommentMarker
          key={`comment-${shape.id}`}
          shape={shape}
          threads={getCommentThreadsForOverlayShape(commentThreads, shape.id)}
          activeThreadId={highlightedCommentThreadId}
        />
      ))}
      {visibleGhostShapes.map(({ key, shape, assets, className }) => (
        <OverlayShapeReadOnlyView
          key={key}
          shape={shape}
          assets={assets}
          chartSourceTable={chartSourceTables.get(shape.id) ?? null}
          diffClassName={className}
        />
      ))}
    </div>
  );
}

function OverlayCommentMarker({
  shape,
  threads,
  activeThreadId,
}: {
  shape: OverlayShape;
  threads: SigmaCommentThread[];
  activeThreadId: string | null;
}) {
  if (threads.length === 0) {
    return null;
  }

  const bounds = getShapeBounds(shape);
  const active = activeThreadId ? threads.some((thread) => thread.id === activeThreadId) : false;
  return (
    <div
      className={`overlay-comment-marker ${active ? "active" : ""}`}
      style={{
        left: `${bounds.x}px`,
        top: `${bounds.y}px`,
        width: `${Math.max(1, bounds.w)}px`,
        height: `${Math.max(1, bounds.h)}px`,
      }}
      data-comment-thread-id={active && activeThreadId ? activeThreadId : threads[0].id}
      data-comment-count={threads.length}
    />
  );
}

function BlockCommentBackground({
  threads,
  activeThreadId,
}: {
  threads: SigmaCommentThread[];
  activeThreadId: string | null;
}) {
  if (threads.length === 0) {
    return null;
  }

  const active = activeThreadId ? threads.some((thread) => thread.id === activeThreadId) : false;
  const threadId = active && activeThreadId ? activeThreadId : threads[0].id;
  return (
    <div
      className={`block-comment-marker ${active ? "active" : ""}`}
      data-comment-thread-id={threadId}
      data-comment-count={threads.length}
    />
  );
}

/**
 * Measure every top-level flow block (paragraphs/headings inside text editors +
 * standalone block units) in unzoomed canvas coordinates (top includes the page
 * top margin, matching `measureBlockTops` / shape anchor resolution).
 */
/**
 * Per-block cache of intrinsic line boxes, keyed by block id. Line-box
 * measurement (`range.getClientRects()` in `measureElementLineBoxes`) is the
 * dominant per-keystroke cost on large documents — it runs for every top-level
 * block on every recompute. But a block's line layout only depends on its own
 * content, width, and zoom; typing in a sibling merely shifts its position. So
 * we store each block's line boxes RELATIVE to its own top/left and reuse them
 * whenever size and zoom are unchanged, re-offsetting by the current position
 * (which we read cheaply from `getBoundingClientRect` regardless).
 */

interface ProblemContextMenuState {
  problemId: string;
  area: ProblemAreaKind;
  left: number;
  top: number;
  /** The clicked (or marker-owning) block id inside `area`; null in `lead` (a single block, so a manual break is meaningless there). */
  breakBlockId: string | null;
  /** Selection-aware sibling block ids for range operations, scoped to `breakBlockId`; empty when `breakBlockId` is null. */
  selectionBlockIds: string[];
  breakTargetBlockId: string | null;
  nextBreakBefore: boolean;
}

interface BodyContextMenuState {
  blockId: string;
  /** Selection-aware sibling block ids used by range operations; always includes `blockId`. */
  selectionBlockIds: string[];
  breakTargetBlockId: string | null;
  nextBreakBefore: boolean;
  left: number;
  top: number;
}

interface ProblemAreaResizeState {
  problemId: string;
  area: ProblemAreaKind;
  startClientY: number;
  startHeightMm: number;
}

/**
 * そのフローユニットの面が **自分で描く** ブロックの id。
 *
 * 定義は下端つまみが `resolveHoverDragUnitAt` で拾う編集単位と同じ。ここが食い違うと、
 * 掴めるのに追従しないブロックが出る。
 */
const EMPTY_SPACE_AFTER_FOLLOWER_UNITS: ReadonlySet<string> = new Set();


function getFlowUnitBlockIds(unit: RenderUnit): string[] {
  return unit.type === "block" ? [unit.block.id] : unit.blocks.map((block) => block.id);
}

function createInitialPageLayoutSnapshot(pageHeightPx: number): PageLayoutSnapshot {
  return {
    input: null,
    fontRevision: 0,
    blockAnchorable: [],
    blockExtents: new Map(),
    blockRects: new Map(),
    boxLayoutSectionSideNoteLayouts: {},
    boxBlockFragmentLayouts: {},
    boxFragmentSourceLayouts: {},
    frameFragmentLayouts: {},
    gaps: {},
    paginationMarkerLayouts: {},
    pageCount: 1,
    problemAreaColumnLayouts: {},
    revision: 0,
    textFlowBlockLayouts: {},
    totalHeight: pageHeightPx,
    unitLayouts: {},
  };
}

function shouldHandlePageImagePaste(
  target: EventTarget | null,
  canvas: HTMLDivElement | null,
  point: OverlayPoint | null,
): boolean {
  if (!canvas) {
    return false;
  }

  if (target instanceof Node && canvas.contains(target)) {
    return true;
  }

  const document = canvas.ownerDocument;
  if (target instanceof Element && target !== document.body && !canvas.contains(target)) {
    return false;
  }

  const activeElement = document.activeElement;
  if (activeElement instanceof Node && canvas.contains(activeElement)) {
    return true;
  }

  if (activeElement instanceof Element && activeElement !== document.body && !canvas.contains(activeElement)) {
    return false;
  }

  return point !== null;
}

/** ポインタの画面座標を、アフォーダンス層と同じ座標系へ移す。 */
function toCanvasPoint(
  canvas: HTMLElement,
  clientX: number,
  clientY: number,
): { x: number; y: number } {
  const canvasRect = canvas.getBoundingClientRect();
  const scale = canvasLayoutScale(canvas);
  return {
    x: (clientX - canvasRect.left) / scale,
    y: (clientY - canvasRect.top) / scale,
  };
}

/**
 * Names the block in the delete item so the menu says what is about to disappear. A problem
 * normally reaches its own menu instead, but the label must still name it rather than fall
 * back to the generic wording.
 */
function bodyBlockDeleteLabel(block: EditableBlock | null, t: Translate<"editor">): string {
  switch (block?.type) {
    case "problem":
      return t("pageMenu.deleteProblemBlock");
    case "paragraph":
      return t("pageMenu.deleteParagraph");
    case "heading":
    case "section":
      return t("pageMenu.deleteHeading");
    case "list":
      return t("pageMenu.deleteList");
    case "boxBlock":
      return t("pageMenu.deleteBox");
    case "layoutSection":
      return t("pageMenu.deleteColumns");
    default:
      return t("pageMenu.deleteBlock");
  }
}

/**
 * ブロックの端へキャレットを戻す。
 *
 * 以前は `document.querySelector` で**最初に見つかった**要素を掴んでいたので、ページを跨ぐ
 * ブロックでは常に見えない正本を掴み、そこへ `scrollIntoView` して紙面が飛んでいた。
 * 論理位置だけ決めてルーターに配らせる (見せている面はルーターが選ぶ)。
 */
function scheduleTextBlockFocus(
  content: readonly SigmaBlock[],
  blockId: string,
  position: "start" | "end",
) {
  // `content` は**この結合/分割が反映される前**の並び。`position` はその並びに対する指定
  // なので、ここで住所に変換しておく (rAF の中で作り直すと、結合後の長さで末尾を取って
  // しまう)。
  const target = findTopLevelBlock(content, blockId);
  const address = target && isTextFlowBlock(target)
    ? caretAddressAtBlockEdge(target, position)
    : null;
  window.requestAnimationFrame(() => {
    window.requestAnimationFrame(() => {
      if (address && focusCaretAddress(address)) {
        return;
      }
      // 問題エリアの中など、トップレベルに無いブロック。住所を組み立てられないので
      // DOM から辿る (ページを跨ぐブロックはトップレベルにしか無いので、ここで
      // 見えない複製を掴む心配は無い)。
      focusBlockElementEdge(blockId, position);
    });
  });
}

function focusBlockElementEdge(blockId: string, position: "start" | "end"): void {
  const selector = `[data-sigma-doc-id="${CSS.escape(blockId)}"]`;
  const blockElement = window.document.querySelector<HTMLElement>(selector);
  const editorElement = blockElement?.closest<HTMLElement>("[contenteditable='true']");
  const selection = window.getSelection();
  if (!blockElement || !editorElement || !selection) {
    return;
  }
  editorElement.focus({ preventScroll: true });
  const range = window.document.createRange();
  range.selectNodeContents(blockElement);
  range.collapse(position === "start");
  selection.removeAllRanges();
  selection.addRange(range);
  scrollElementIntoCanvasView(blockElement);
}

export {
computeProblemAreaColumnFlow,
simulateBalancedColumnHeightPx,
type ProblemAreaColumnFlowBlock,
type ProblemAreaColumnFlowResult
} from "@/features/rendering/core";
export {
cloneTextFlowBlock,
hasBreakBefore,
isProblemFrameArea,
PROBLEM_AREA_ORDER,
problemAreaBlocksForEditor,
problemAreaDraftKey,
shouldShowProblemArea,
TEXT_FLOW_BLOCKS_PER_RENDER_UNIT_TARGET
} from "./page-canvas/block-ops";
export { computeColumnUnitLayouts,getColumnBreakBeforeBlockIdForContextMenu } from "./page-canvas/column-layout";
export { getSelectionActionPopoverPosition,viewportToCanvasAnchor } from "./page-canvas/popover-anchors";
export { buildRenderUnits } from "./page-canvas/render-units";
export type { FlowUnitLayout,ProblemAreaColumnLayout,RenderUnit } from "./page-canvas/types";
export { calculateVisiblePageRange,getVisiblePageIndexes } from "./page-canvas/virtualization";

/**
 * 紙面の描画は文書 1 つ分をまとめて抱えるので、親が別の理由で描画されただけで巻き込まれると重い。
 *
 * ここで効くのは主に「AI ストアの更新で `AiEnabledPageCanvasEditor` だけが描画された」場合で、
 * 文書が変わったときは当然 bail out しない。EditorShell から渡るハンドラの一部はまだ毎レンダー
 * 作り直されるため、その経路での取りこぼしは follow-up。
 */
export const PageCanvasEditor = memo(PageCanvasEditorImpl);
