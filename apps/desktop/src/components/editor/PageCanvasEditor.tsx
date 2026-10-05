"use client";
import { BlockEditor } from "@/components/editor/BlockEditor";
import { CommentThreadsPanel } from "@/components/editor/CommentThreadsPanel";
import { EditorExtensionProvider } from "@/components/editor/editor-extension-context";
import { KEYBOARD_ZOOM_STEP } from "@/components/editor/editor-shell/constants";
import { PageRunningRegionView } from "@/components/editor/PageRunningRegionView";
import { ProblemSettingsDialog } from "@/components/editor/ProblemSettingsDialog";
import {
  cancelCaretKeeperWindow,
  finishCaretKeeperWindow,
  flushPendingCaret,
  requestCaret,
  requestCaretKeeperReanchor,
  setFragmentTables,
  startCaretKeeperWindow,
  subscribeCaretKeeperTarget,
} from "@/components/editor/text-flow/caret-router";
import { mergeLargePasteDeferredBlockIds } from "@/components/editor/text-flow/large-text-paste";
import { shouldRestoreTextFlowSelectionAfterChange } from "@/components/editor/text-flow/text-run-replacement";
import {
  clearTextRunSpanOnOutsidePointerDown,
  getFocusedTextRunUnitIds,
  isMultiEditorTextRunSpan,
} from "@/components/editor/text-flow/text-run-span";
import { TextRunSelectionOverlay } from "@/components/editor/text-flow/TextRunSelectionOverlay";
import {
  REQUEST_BOX_SETTINGS_EVENT,
  REQUEST_TEXT_PAGE_BREAK_EVENT,
  type TextFlowBoundaryDeleteOutcome,
  type TextFlowBoundaryDeleteRequest,
  type TextFlowChangeContext,
  type TextFlowMaterialInsertRequest,
  type TextPageBreakRequestDetail,
} from "@/components/editor/TextFlowEditor";
import { resolveVisibleBoundaryDelete } from "@/components/editor/page-canvas/boundary-delete-guard";
import {
  BLOCK_SPACE_AFTER_FOLLOWER_CLASS,
  blockSpaceAfterPx,
  ensurePageLayout,
  getPageMetrics,
  isWhiteboardPageLayout,
  MM_TO_PX,
  normalizeOverlaySnapshot,
  PAGE_GAP_PX,
  roundHalfMm,
  type PageOverlay,
  type ProblemAreaKind,
  type ProblemNode,
} from "@/features/document";
import { PageColumnRules } from "@/features/rendering/adapters/react";
import { getVisibleOverlayShapes } from "@/features/rendering/core";
import {
  bodyTextFlowBlockContainsId,
  canInsertManualPageBreakAfterBlock,
  canInsertManualPageBreakAt,
  collectBoxBlocksById,
  getNestedPageBreakBeforeIds,
  getNestedPageBreakBeforeKinds,
  getNextTopLevelTextFlowBlockId,
  getPageBreakBeforeIds,
  isBodyContextMenuBlock,
  isColumnWrapTargetBlock,
  isProblemAreaKind,
  isTextFlowBlock,
  resolveTextFlowBoundaryDelete,
  setBlockBreakBefore,
  setBlockSpaceAfter,
  setLayoutSectionColumnCount,
  type ManualTextPageBreakSelection,
  type TextFlowBlock,
} from "@/features/text-editing";
import { indexDragAnchors,indexDragUnits } from "@/lib/block-drag-move";
import { getCommentThreadsForBlock,visibleCommentThreads } from "@/lib/comments";
import {
  collectBlocksById,
  createParagraph,
  findBlock,
  findContainingBoxBlock,
  findContainingLayoutSection,
} from "@/lib/document-tree";
import { useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import { getSupportedOverlayImageFilesFromDataTransfer,hasSupportedOverlayImageData } from "@/lib/overlay-image-files";
import { countPerformanceEvent,measurePerformance } from "@/lib/performance";
import { getProblemNumberMap } from "@/lib/problem-numbering";
import { isInsertTextShapeAtCursorShortcut } from "@/shortcuts/editor-shortcuts";
import { ClipboardPaste,Copy,GripVertical,Maximize,Minus,PackagePlus,Plus,Settings2,Trash2 } from "lucide-react";
import type {
  CSSProperties,
  DragEvent as ReactDragEvent,
  MouseEvent as ReactMouseEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import { memo,useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import { ColumnRuleDialog } from "./ColumnRuleDialog";
import { createCameraDragAutoScrollPanBy } from "./drag-auto-scroll";
import type { OverlayBounds,OverlayPoint } from "./overlay-canvas/types";
import { createResolvedOverlayView,type OverlayIdentityCache } from "./overlay-canvas/view-cache";
import { RemoteOverlayPresenceLayer } from "./OverlayCanvasEditorClient";
import {
  blockHitProbeColumnLeftPx,
  EMPTY_BLOCK_AFFORDANCE_HOVER,
  isPointWithinColumnLaneAffordance,
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
import {
  BlockContextMenuItems,
  resolveContextMenuBreaksToColumn,
  resolvePageBreakMarkerKind,
} from "./page-canvas/block-context-menu";
import {
  layoutColumnDividerAdjoinsBlock,
  measureDragUnitPieces,
  pointHitsLayoutColumnResizeHandle,
  resolveLayoutColumnResizeHandleAt,
  type DragIndex,
} from "./page-canvas/block-drag-dom";
import { hasBreakBefore,PROBLEM_AREA_ORDER,problemAreaDraftKey,shouldShowProblemArea } from "./page-canvas/block-ops";
import { shouldHandleBlockSelectionDelete } from "./page-canvas/block-selection-keyboard-policy";
import { shouldKeepBlockSelectionOnPagePointerDown } from "./page-canvas/block-selection-pointer-policy";
import { resolveBodyPointerRoute } from "./page-canvas/body-pointer-routing";
import { resolveBodyTextFlowTransition } from "./page-canvas/body-text-flow-transition";
import {
  findEditableElementUnderPoint,
  focusUnderlyingEditorAtPoint,
  selectUnderlyingEditorRange,
  type ClientPoint,
} from "./page-canvas/caret-focus";
import { resolveColumnCommandState } from "./page-canvas/column-command-state";
import {
  getColumnBreakBeforeBlockIdForContextMenu,
  getPageIndexForY,
  measureLocalColumnContextMenuLayout,
  type LocalColumnContextMenuLayout,
} from "./page-canvas/column-layout";
import {
  BlockHandleSelection,
  BodyContextMenuState,
  PageCanvasEditorProps,
  ProblemAreaResizeState,
  ProblemContextMenuState,
} from "./page-canvas/editor-contracts";
import {
  bodyBlockDeleteLabel,
  scheduleCaretAddressFocus,
  scheduleTextBlockFocus,
  shouldHandlePageImagePaste,
  toCanvasPoint,
} from "./page-canvas/editor-dom-commands";
import type { PageCanvasInlineContent } from "./page-canvas/editor-extension";
import {
  EMPTY_SPACE_AFTER_FOLLOWER_UNITS,
  getFlowDisplacementProps,
  getFlowUnitBlockIds,
  getFlowUnitPlacementStyle,
  mergeFlowUnitStyle,
} from "./page-canvas/flow-presentation";
import { getFlowExtensionNodeId,getProblemAfterContentUnitIds,getProblemAfterInlineContent } from "./page-canvas/inline-content-composition";
import { calculateReserveSpaceGaps } from "./page-canvas/layout-measure";
import { LayoutSectionFlowUnit } from "./page-canvas/layout-section-view";
import { publishLayoutSnapshot } from "./page-canvas/layout-snapshot";
import { canInsertManualBreakAtBlock } from "./page-canvas/manual-break-context";
import {
  getTopmostBodyModeOverlayHit,
  materializeEmptyProblemAreaOverlayAnchors,
} from "./page-canvas/overlay-anchor-materialization";
import { OverlayCanvasEditor } from "./page-canvas/overlay-editor-surface";
import { BlockCommentBackground,OverlayPreview } from "./page-canvas/overlay-preview";
import { ColumnGuides,getBodyVerticalSnapGuides,PageBreakMarker } from "./page-canvas/page-chrome";
import {
  getCanvasPointerPoint,
  getPageDoubleTapHit,
  getWhiteboardPointerPoint,
  isPageBodyPoint,
  isPageDoubleTap,
  type PageDoubleTapCandidate,
} from "./page-canvas/pointer-model";
import {
  BLOCK_HIT_PROBE_INSET_PX,
  canvasLayoutScale,
  getClientOverlayPointOnCanvas,
  getClientOverlayPointOnPage,
  getPagePointerContext,
  getSelectionScopedBlockIds,
  hitTestTopLevelBlock,
} from "./page-canvas/pointer-targets";
import { getClosestBlockId,getContextMenuPosition } from "./page-canvas/popover-anchors";
import {
  getHiddenOptionalProblemAreas,
  getOptionalProblemAreaBlockIdPrefix,
  OPTIONAL_PROBLEM_AREAS,
  resolveProblemAreaTransition,
} from "./page-canvas/problem-area-model";
import { ProblemAreaFlowUnit,problemAreaLabel } from "./page-canvas/problem-area-view";
import {
  buildRenderUnits,
  getFlowLayoutStyle,
  getLayoutSectionColumnCount,
  getPageColumnSideNoteOffsetPx,
  getRenderUnitManualBreakEdges,
  pickTextFlowBoxFragmentSourceLayouts,
  reconcileRenderUnits,
} from "./page-canvas/render-units";
import { RunningRegionControls } from "./page-canvas/running-region-view";
import { mergeSelectionExtensions } from "./page-canvas/selection-extension-merge";
import { SelectionActionPopover } from "./page-canvas/SelectionActionPopover";
import { SpaceAfterDragSession } from "./page-canvas/space-after-drag-session";
import {
  resolveSpaceAfterDragPx,
  resolveSpaceAfterPreviewCohort,
  type SpaceAfterPreviewCohort,
} from "./page-canvas/space-after-preview";
import {
  changesTopLevelManualBreaks,
  DeferredLargePasteTextFlowUnit,
  EditorBoxBlockFragmentPreview,
  FlowExtensionFragmentPreview,
  FlowExtensionLayoutContext,
  hasNewTopLevelBlockIds,
  TextFlowWithInlineContent,
} from "./page-canvas/text-flow-view";
import {
  carryChunkBoundaryState,
  getChunkBoundaryState,
  type DocumentChunkBoundaryState,
} from "./page-canvas/text-run-chunking";
import { assignTextRunGroupIds } from "./page-canvas/text-run-groups";
import type { RenderUnit } from "./page-canvas/types";
import { useBlockDrag } from "./page-canvas/use-block-drag";
import { useOverlayPreviewHandoff } from "./page-canvas/use-overlay-preview-handoff";
import { usePageCanvasCommentGeometry } from "./page-canvas/use-page-canvas-comments";
import { usePageCanvasMeasurement } from "./page-canvas/use-page-canvas-measurement";
import { usePageCanvasRunningRegions } from "./page-canvas/use-page-canvas-regions";
import { usePageCanvasSelectionActions } from "./page-canvas/use-page-canvas-selection";
import { usePageCanvasViewport } from "./page-canvas/use-page-canvas-viewport";
import { getVisiblePageIndexes } from "./page-canvas/virtualization";
import { getWhiteboardBackgroundStyle } from "./page-canvas/whiteboard-background";
import { WhiteboardBackgroundControl } from "./page-canvas/WhiteboardBackgroundControl";
import type {
  OverlayActionRequest,
  OverlayActionRequestInput,
  OverlayChangeOptions,
  OverlayModeStatus,
  OverlaySelectionSummary,
  OverlaySelectPointRequest,
} from "./page-overlay-types";
import {
  beginBlockSpaceAfterPreview,
  endBlockSpaceAfterPreview,
  registerBlockSpaceAfterPreviewRoot,
  setBlockSpaceAfterPreviewDeltaPx,
} from "./text-flow/block-space-after-preview";
import { ProblemNumberingProvider } from "./text-flow/ProblemNumberingContext";

const PAGE_DOUBLE_TAP_MS = 450;

const PAGE_DOUBLE_TAP_DISTANCE_PX = 28;

/** Delay before resuming layout measurement after camera movement. */
const WHITEBOARD_ZOOM_SETTLE_MS = 160;

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

const EMPTY_BLOCK_SELECTION: BlockHandleSelection = { ids: [], boxes: [] };

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
  renderSelectionActions,
  onCommentAnchorCandidateChange,
  onCommentThreadSelect,
  suppressSelectionActions = false,
  selectionTools,
  presentation = "edit",
  publishesSessionPresence: publishesSessionPresenceProp,
}: PageCanvasEditorProps) {
  const tEditorText = useT("editor");
  const isPagedRender = presentation === "paged";
  const publishesSessionPresence = !isPagedRender && publishesSessionPresenceProp !== false;
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
const {
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
  } = usePageCanvasRunningRegions({ documentId: pageDocument.docId, onRunningRegionEditingChange, onSelect, onPageLayoutChange, layout, tEditorText, zoom });

  const visibleLayout = pageLayoutDraft ?? layout;
  const overlay = useMemo(() => layout.overlay ?? {}, [layout.overlay]);
  const metrics = useMemo(() => getPageMetrics(visibleLayout), [visibleLayout]);
  // 段組のページか。段組でも本文は段幅の自然フローとして置き、配置は変位で与える
  // (1 段組と同じ描画・同じ計測・同じページ割り)。手動改ページは改段になる。
  const isColumnPage = metrics.flow.columnCount > 1;
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
  const unitManualBreakEdges = useMemo(() => getRenderUnitManualBreakEdges(units), [units]);
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
  /**
   * フロー内の拡張ノード (差し込み) の id → 中身。ページの境目で切れた拡張ノードの続きを、同じ中身の
   * 複製として描くために引く。並びと版はページ割りの測り直しの合図にもなる (`extensionMeasureKey`)。
   */
  const { extensionContentByNodeId, extensionMeasureKey } = useMemo(() => {
    const byNodeId = new Map<string, PageCanvasInlineContent>();
    const keys: string[] = [];
    for (const items of inlineContentByTargetId.values()) {
      for (const item of items) {
        const nodeId = getFlowExtensionNodeId(item.key);
        byNodeId.set(nodeId, item);
        keys.push(`${nodeId}\u0000${item.measureRevision ?? ""}`);
      }
    }
    return { extensionContentByNodeId: byNodeId, extensionMeasureKey: keys.join("\u0001") };
  }, [inlineContentByTargetId]);
  const textFlowChangeDecorationState = pageExtension?.textFlowChangeDecorationState;
  // 畳んだブロック (`collapsedIds`) は境界の削除から読む。イベントの時点の値を ref で引く。
  const collapsedBlockIdsRef = useRef(textFlowChangeDecorationState?.collapsedIds);
  useLayoutEffect(() => {
    collapsedBlockIdsRef.current = textFlowChangeDecorationState?.collapsedIds;
  }, [textFlowChangeDecorationState]);
  const overlayShapeClassNames = pageExtension?.overlayShapeClassNames;
  const resolveOverlayPresentation = pageExtension?.resolveOverlayPresentation;
  const featureSelectionExtension = pageExtension?.selection;
  const selectionExtension = useMemo(
    () => mergeSelectionExtensions(selectionTools, featureSelectionExtension),
    [featureSelectionExtension, selectionTools],
  );
  const [overlayEditing, setOverlayEditing] = useState(false);
  const [bodyOverlayModeStatus, setBodyOverlayModeStatus] = useState<OverlayModeStatus | null>(null);
  const [overlayBackgroundLayerElement, setOverlayBackgroundLayerElement] = useState<HTMLDivElement | null>(null);
  const [shortcutOverlayActionRequest, setShortcutOverlayActionRequest] = useState<OverlayActionRequest | null>(null);
  const [selectPointRequest, setSelectPointRequest] = useState<OverlaySelectPointRequest | null>(null);
  const overlayDestructiveSelectionCountRef = useRef(overlaySelection.selectedCount);
  const [whiteboardTextRepaint, setWhiteboardTextRepaint] = useState<{
    revision: number;
    bounds: OverlayBounds;
  } | null>(null);
  const [blockAffordance, setBlockAffordance] = useState<BlockAffordanceHover>(EMPTY_BLOCK_AFFORDANCE_HOVER);
  // ホバー解決はイベント時に「いま表示中のもの」を読む (段間で右の段のつまみを保つ判定)。
  const blockAffordanceRef = useRef<BlockAffordanceHover>(EMPTY_BLOCK_AFFORDANCE_HOVER);
  useLayoutEffect(() => {
    blockAffordanceRef.current = blockAffordance;
  }, [blockAffordance]);
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
  const problemAreaResizeRef = useRef<ProblemAreaResizeState | null>(null);
  const problemAreaHeightDraftsRef = useRef<Record<string, number>>({});
  const pageDoubleTapRef = useRef<PageDoubleTapCandidate | null>(null);
  const selectPointRequestIdRef = useRef(0);
  const lastPagePointerPointRef = useRef<OverlayPoint | null>(null);
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
  const displayedCommentThreads = useMemo(
    () => showComments ? visibleCommentThreads(commentThreads, { activeThreadId: activeCommentThreadId }) : [],
    [activeCommentThreadId, commentThreads, showComments],
  );
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
  const contextMenuBreaksToColumn = resolveContextMenuBreaksToColumn(isColumnPage, contextMenuLayoutSection);
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
  const problemContextMenuBreaksToColumn = resolveContextMenuBreaksToColumn(isColumnPage, problemContextMenuLayoutSection);
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
  const {
    layoutViewState,
    layoutViewStateRef,
    cancelBlockSpaceAfterDragRef,
    thawSpaceAfterRecompute,
    releaseSpaceAfterPreviewWhenPaintedRef,
    markUnitMeasureDirty,
    breakBeforeIdsRef,
    paginateBeforePaintRef,
    markFullMeasureDirty,
    bleed
  } = usePageCanvasMeasurement({
    content: { pageDocument, units, historyRevision, overlay, overlaySource: document.pageLayout?.overlay, pendingDeletion, onReanchorOverlay, extensionMeasureKey, lockedShapeIds: editorExtensions?.overlayEditPolicy?.lockedShapeIds },
    geometry: { metrics, zoom, fontSize, isWhiteboard, isPagedRender },
    surface: { flowRef, canvasRef, flowElement },
    spaceAfter: { spaceAfterSessionRef, setSpaceAfterDrag, setBlockAffordance },
  });

  const {
    blockRects,
    boxLayoutSectionSideNoteLayouts,
    boxBlockFragmentLayouts,
    boxFragmentSourceLayouts,
    frameFragmentLayouts,
    pageCount,
    problemAreaColumnLayouts,
    totalHeight,
    columnRulePieces,
    unitDisplacements,
    nodeDisplacements,
    visualEnds,
    sideNoteLabelYs,
    markerDisplacements,
  } = layoutViewState;
  const { overlaySelectionKey, selectionActionPopover } = usePageCanvasSelectionActions({ overlaySelection, suppressSelectionActions, pageOverlayEditing, selectionExtension, selectedId, document, bodyOverlayModeStatus, overlayCommentAnchor, canvasRef, zoom, isWhiteboard, whiteboardPanX, whiteboardPanY, onCommentAnchorCandidateChange, isOverlayEditing, onCommentAnchorRequest, renderSelectionActions, selectedInlineMath, totalHeight });
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
  // 問題そのものを対象にした差し込みは、問題ごとに 1 つのユニットの後ろにだけ描く。
  const problemAfterContentUnitIds = useMemo(() => getProblemAfterContentUnitIds(units), [units]);
  // 拡張ノードが読むページ割りの答え。編集面は自分のブロックの分だけを props で受けるので、
  // この値が変わって描き直されるのは拡張ノードだけ。
  const flowExtensionLayout = useMemo(
    () => ({ nodeDisplacements, fragmentSources: boxFragmentSourceLayouts }),
    [boxFragmentSourceLayouts, nodeDisplacements],
  );
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
const { visiblePageRange } = usePageCanvasViewport({ isPagedRender, pageCount, canvasRef, zoom, pageHeightPx });

const { candidateCommentTop, pendingCommentTop, commentThreadPositions } = usePageCanvasCommentGeometry({ commentPanel, totalHeight, zoom, showComments, canvasRef });

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
  }, [hasOverlayRequest, runningRegionEditKind, setRunningRegionOverlayEditing]);

  const onOverlayEditingChangeRef = useRef(onOverlayEditingChange);

  useEffect(() => {
    onOverlayEditingChangeRef.current = onOverlayEditingChange;
  }, [onOverlayEditingChange]);

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
    const divider = canvas ? resolveLayoutColumnResizeHandleAt(canvas, clientX, clientY) : null;
    const shown = blockAffordanceRef.current;
    // 列境界をドラッグ中 (ポインタは境界ボタンに捕捉されている)。
    const resizingColumns = target instanceof Element
      && !!target.closest('.layout-section-column-resize-handle[data-dragging="true"]');
    const pointerOwner = resolveBlockAffordancePointerOwner({
      dragging: spaceAfterSessionRef.current.isDragging || blockDrag.isDragging(),
      resizingColumns,
      targetIsAffordance: target instanceof Element && !!target.closest(".page-block-affordance-layer"),
      hitsColumnDivider: !!divider,
      keepsColumnLaneAffordance: !!canvas && !!divider && !!shown.handle
        && isPointWithinColumnLaneAffordance(shown, toCanvasPoint(canvas, clientX, clientY))
        && layoutColumnDividerAdjoinsBlock(divider, shown.handle.blockId),
    });
    // 表示中のグリップ／つまみ自身が最前面なら、その上に居る間は現在の解決を保つ。
    // ドラッグ中も同じ: control が unmount されると pointer capture ごと消える。
    if (pointerOwner === "frozen") {
      return;
    }
    // 段間 (列境界の実 DOM 矩形) は列境界のもの。表示中の右の段のつまみはその行の間だけ保つ (上)。
    if (pointerOwner === "divider") {
      // 列幅のドラッグ中は、プレビューの再計測で走る「静止中の取り直し」に基準点を渡さない。
      // 渡すと、ドラッグで本文の上に来たポインタの位置でグリップが出し直される。
      lastAffordancePointRef.current = resizingColumns ? null : { x: clientX, y: clientY };
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
  ), [layoutViewStateRef, pageHeightPx, units]);

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
  }, [cancelBlockSpaceAfterDragRef, onBlockSpaceAfterChange, onChange, pageDocument.content, releaseSpaceAfterPreviewWhenPaintedRef, resolveBlockSpaceAfterCohort, thawSpaceAfterRecompute, zoom]);

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
  }, [cancelBlockSpaceAfterDragRef]);

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

  const completeOverlayPreviewHandoff = useCallback((bounds: DOMRect, start: ClientPoint, end: ClientPoint, targetShapeId?: string) => {
    requestOverlayPreviewSelection(bounds, start.x, start.y, false, true, false, end, targetShapeId);
  }, [requestOverlayPreviewSelection]);
  const activateBodyOverlayEditing = useCallback(() => setOverlayEditing(true), []);
  const startOverlayPreviewPointerHandoff = useOverlayPreviewHandoff(completeOverlayPreviewHandoff, activateBodyOverlayEditing);

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
      // 手動改ページの付け外しはユニットを切り直す。遅らせると、区切りの後ろへ移るブロックが
      // 1〜2 フレーム古い編集面に残り、そこへキャレットが落ちる。
      || changesTopLevelManualBreaks(breakBeforeIdsRef.current, nextBlocks)
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
  }, [breakBeforeIdsRef, editTouchesPageSplitBlock, layoutViewStateRef, markUnitMeasureDirty, onReplaceTextFlow, paginateBeforePaintRef]);

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
  }, [editTouchesPageSplitBlock, markFullMeasureDirty, onChange, paginateBeforePaintRef]);

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

  }, [horizontalMarginEditPageNumber, runningRegionEditKind, setHorizontalMarginEditPageNumber, setRunningRegionEditKind, setRunningRegionOverlayEditing]);

  const handleTextFlowBoundaryDelete = useCallback((request: TextFlowBoundaryDeleteRequest): TextFlowBoundaryDeleteOutcome => {
    // 面をまたぐ結合・削除は面のガードを通らない。畳んだ (描かれていない) ブロックを書き換える変更は
    // ここで断ってガードの案内を出し (文書の変更口も同じ集合で断る)、キャレットは見えるブロックへ置く。
    const outcome = resolveVisibleBoundaryDelete(
      request,
      (input) => resolveTextFlowBoundaryDelete(pageContentRef.current, input),
      collapsedBlockIdsRef.current,
    );
    if (!outcome) {
      return false;
    }
    if ("blockedBlockId" in outcome) {
      return outcome;
    }
    const { deletion } = outcome;

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

  /**
   * キャレットの位置に手動改ページ (改段) を入れる。右クリックメニュー・`/` コマンド・
   * ショートカットの共通の入口。区切りを実際に組み立てるのはキャレットを持つ本文エディタ
   * (`REQUEST_TEXT_PAGE_BREAK_EVENT`) で、ここは文書全体を見た可否 (独立段組みの中・空のページ)
   * と、どのエディタも受けなかったときの後始末だけを持つ。
   */
  const insertManualBreakAt = useCallback((
    blockId: string,
    selection?: ManualTextPageBreakSelection | null,
  ): boolean => {
    // 本文エディタへ渡る (memo の関門を越える) ので、文書は ref から読み、打鍵ごとに作り直さない。
    const document = pageDocumentRef.current;
    if (!canInsertManualBreakAtBlock(document, blockId)) {
      return false;
    }
    const content = document.content;
    const documentNextBlockId = getNextTopLevelTextFlowBlockId(content, blockId);
    const detail: TextPageBreakRequestDetail = {
      blockId,
      enabled: true,
      documentNextBlockId,
      selection: selection ?? null,
      canInsertAt: (point) => canInsertManualPageBreakAt(content, point),
    };
    window.dispatchEvent(new CustomEvent(REQUEST_TEXT_PAGE_BREAK_EVENT, { detail }));
    if (detail.handled) {
      if (detail.rejected) {
        return false;
      }
      // キャレットは区切りの後ろ (次のページの先頭)。本文エディタが変更と一緒に予約した位置は
      // 新しいユニットの登録時に配られるが、開発時の StrictMode の付け外しで焦点が落ちることが
      // あるので、描き直しが落ち着いた後にもう一度同じ住所へ配る。
      if (detail.focusBlockId) {
        onSelect(detail.focusBlockId);
      }
      if (detail.focusAddress) {
        scheduleCaretAddressFocus(detail.focusAddress);
      }
      return true;
    }

    // どのエディタも受けなかった: 最上位のユニットの末尾で区切った (次のユニットの先頭が持つ) か、
    // 本文エディタを持たないブロック (区切り線など) の後ろで区切る。
    const fallbackBlockId = documentNextBlockId ?? blockId;
    if (!canInsertManualPageBreakAt(content, { blockId: fallbackBlockId, offset: 0 })) {
      return false;
    }
    updateBreakBefore(fallbackBlockId, true);
    if (fallbackBlockId !== blockId) {
      onSelect(fallbackBlockId);
      scheduleTextBlockFocus(pageContentRef.current, fallbackBlockId, "start");
    }
    return true;
  }, [onSelect, updateBreakBefore]);

  // Shared by both the body and problem context menus (the latter reuses it for breaks placed
  // on blocks inside a problem's prompt/hints/solution area): flips the manual break on/off for
  // whichever block a menu's "改ページ/改段 を挿入・解除" item targets.
  const applyContextMenuBreak = useCallback((
    target: { blockId: string; breakTargetBlockId: string | null; nextBreakBefore: boolean },
    enabled: boolean | undefined,
    closeMenu: () => void,
  ) => {
    const nextBreakBefore = enabled ?? target.nextBreakBefore;
    if (!nextBreakBefore) {
      if (target.breakTargetBlockId) {
        updateBreakBefore(target.breakTargetBlockId, false);
        onSelect(target.breakTargetBlockId);
        scheduleTextBlockFocus(pageContentRef.current, target.breakTargetBlockId, "start");
      }
      closeMenu();
      return;
    }
    closeMenu();
    insertManualBreakAt(target.blockId);
  }, [insertManualBreakAt, onSelect, updateBreakBefore]);

  const handleManualBreakCommand = useCallback(
    (selection: ManualTextPageBreakSelection) => insertManualBreakAt(selection.blockId, selection),
    [insertManualBreakAt],
  );

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
        pageStridePx: pageHeightPx + PAGE_GAP_PX,
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
    onSelect,
    pageDocument,
    pageHeightPx,
    problemAreaColumnLayouts,
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
          pageStridePx: pageHeightPx + PAGE_GAP_PX,
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
    onSelect,
    openBodyContextMenu,
    pageDocument,
    pageHeightPx,
    problemAreaColumnLayouts,
    selectedId,
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
      // TikZ images are directly editable on tap, including when they overlap body text.
      pointerOverBodyText: hitShape && !(hitShape.type === "image" && hitShape.props.tikz)
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
  }, [isWhiteboard, isOverlayEditing, runningRegionEditKind, getOverflowOverlayPointFromClient, visibleBodyHitShapes, routableOverlayShapeIds, activeBlockSelection.ids.length, metrics, pageCount, pageHeightPx, visibleLayout, editRunningRegion, setHorizontalMarginEditPageNumber, beginPageMarginDrag, horizontalMarginEditPageNumber, startOverlayPreviewPointerHandoff, requestOverlayPreviewSelection, enableRunningRegion]);

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
                retainEmptySelection
                onModeStatusChange={handleBodyOverlayModeStatusChange}
                onSelectionSummaryChange={handleOverlaySelectionSummaryChange}
                onSelectedCountChange={handleOverlaySelectedCountChange}
                onActiveToolChange={onOverlayActiveToolChange}
                onMaterialSaveRequest={onMaterialSaveRequest ? () => onMaterialSaveRequest() : undefined}
                onChange={updateBodyOverlay}
                editPolicy={editorExtensions?.overlayEditPolicy}
                shapeDecorations={editorExtensions?.overlayShapeDecorations}
                diffShapeClassNames={overlayShapeClassNames}
                publishesSessionPresence={publishesSessionPresence}
              />
              {!isPagedRender && <RemoteOverlayPresenceLayer shapes={overlayView.shapes} />}
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
            <div className="whiteboard-zoom-controls" data-preserve-canvas-selection>
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
          <SelectionActionPopover
            popover={selectionActionPopover}
            onCommentAnchorRequest={onCommentAnchorRequest}
            renderSelectionActions={renderSelectionActions}
          />
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

          <FlowExtensionLayoutContext.Provider value={flowExtensionLayout}>
          <div
            className={`page-flow ${isColumnPage ? "page-columns" : ""}`}
            ref={setFlowRef}
          >
            {units.map((unit) =>
              unit.type === "textFlow" ? (
                <div
                  key={`text-flow-${unit.renderKey ?? unit.id}`}
                  className={spaceAfterFollowerUnitClass(unit.id) || undefined}
                  data-flow-unit-id={unit.id}
                  data-text-run-group={textRunGroupByUnitId.get(unit.id)?.groupId}
                  {...getFlowDisplacementProps(unitDisplacements[unit.id]).attributes}
                  style={mergeFlowUnitStyle(getFlowUnitPlacementStyle(unit, unitDisplacements[unit.id], metrics, isColumnPage), unitDisplacements[unit.id])}
                >
                  {largePasteHydration
                    && !largePasteHydration.hydratedUnitIds.has(unit.id)
                    && unit.blocks.every((block) => largePasteHydration.deferredBlockIds.has(block.id)) ? (
                      <DeferredLargePasteTextFlowUnit
                        blocks={unit.blocks}
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
                        nodeDisplacements={nodeDisplacements}
                        markerDisplacements={markerDisplacements}
                        paginationBeforeIds={[
                          ...getPageBreakBeforeIds(unit.blocks),
                          ...getNestedPageBreakBeforeIds(unit.blocks),
                        ]}
                        paginationMarkerKind={resolvePageBreakMarkerKind(isColumnPage)}
                        paginationMarkerKinds={getNestedPageBreakBeforeKinds(unit.blocks, isColumnPage ? "columnBreak" : "pageBreak")}
                        leadingManualBreak={unitManualBreakEdges.get(unit.id)?.leading}
                        trailingManualBreak={unitManualBreakEdges.get(unit.id)?.trailing}
                        onManualBreakCommand={isPagedRender ? undefined : handleManualBreakCommand}
                        boxFragmentSourceLayouts={pickTextFlowBoxFragmentSourceLayouts(unit.blocks, boxFragmentSourceLayouts)}
                        showPlaceholder={units[0]?.type === "textFlow" && unit.id === units[0].id}
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
                        inlineContentByTargetId={inlineContentByTargetId}
                        changeDecorationState={textFlowChangeDecorationState}
                      />
                    )}
                </div>
              ) : unit.type === "layoutSection" || unit.type === "problemLayoutSection" ? (
                <LayoutSectionFlowUnit
                  key={unit.id}
                  unit={unit}
                  manualBreakEdges={unitManualBreakEdges.get(unit.id)}
                  onManualBreakCommand={isPagedRender ? undefined : handleManualBreakCommand}
                  textRunAssignment={textRunGroupByUnitId.get(unit.id)}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  isColumnPage={isColumnPage}
                  displacement={unitDisplacements[unit.id]}
                  nodeDisplacements={nodeDisplacements}
                  markerDisplacements={markerDisplacements}
                  visualEnd={visualEnds[unit.id]}
                  sideNoteLabelY={sideNoteLabelYs[unit.id]}
                  columnRulePieces={columnRulePieces?.[unit.id]}
                  columnLayout={problemAreaColumnLayouts[unit.id]}
                  boxFragmentSourceLayouts={boxFragmentSourceLayouts}
                  layoutStyle={getFlowUnitPlacementStyle(unit, unitDisplacements[unit.id], metrics, isColumnPage)}
                  spaceAfterFollowerClass={spaceAfterFollowerUnitClass(unit.id)}
                  pageColumnGapPx={metrics.flow.columnGapPx}
                  pageColumnGapMm={metrics.flow.columnGapMm}
                  pageContentHeightPx={metrics.content.heightPx}
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
                  inlineContentByTargetId={inlineContentByTargetId}
                  changeDecorationState={textFlowChangeDecorationState}
                />
              ) : unit.type === "problemArea" ? (
                <ProblemAreaFlowUnit
                  key={unit.id}
                  unit={unit}
                  manualBreakEdges={unitManualBreakEdges.get(unit.id)}
                  onManualBreakCommand={isPagedRender ? undefined : handleManualBreakCommand}
                  textRunAssignment={textRunGroupByUnitId.get(unit.id)}
                  selectedId={selectedId}
                  mathFractionSizing={mathFractionSizing}
                  historyRevision={historyRevision}
                  isColumnPage={isColumnPage}
                  displacement={unitDisplacements[unit.id]}
                  nodeDisplacements={nodeDisplacements}
                  markerDisplacements={markerDisplacements}
                  visualEnd={visualEnds[unit.id]}
                  sideNoteLabelY={sideNoteLabelYs[unit.id]}
                  boxFragmentSourceLayouts={boxFragmentSourceLayouts}
                  frameFragments={frameFragmentLayouts[unit.id]}
                  layoutStyle={getFlowUnitPlacementStyle(unit, unitDisplacements[unit.id], metrics, isColumnPage)}
                  spaceAfterFollowerClass={spaceAfterFollowerUnitClass(unit.id)}
                  draftMinHeightMm={problemAreaHeightDrafts[problemAreaDraftKey(unit.problem.id, unit.area)]}
                  pageContentHeightPx={metrics.content.heightPx}
                  onSelect={onSelect}
                  onChange={updateProblemAreaBlocks}
                  onRemoveBreak={markerRemoveHandler}
                  onResizeStart={startProblemAreaResize}
                  onActionMenuOpen={openProblemActionMenu}
                  inlineContentByTargetId={inlineContentByTargetId}
                  afterInlineContent={getProblemAfterInlineContent(
                    unit.problem.id,
                    problemAfterContentUnitIds.has(unit.id),
                    inlineContentByTargetId,
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
                  className={spaceAfterFollowerUnitClass(unit.id) || undefined}
                  key={unit.block.id}
                  {...getFlowDisplacementProps(unitDisplacements[unit.id]).attributes}
                  style={mergeFlowUnitStyle(getFlowUnitPlacementStyle(unit, unitDisplacements[unit.id], metrics, isColumnPage), unitDisplacements[unit.id])}
                >
                  {hasBreakBefore(unit.block) && (
                    <PageBreakMarker blockId={unit.block.id} onRemove={markerRemoveHandler} displacement={markerDisplacements[unit.id]} />
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
          </FlowExtensionLayoutContext.Provider>

          {/*
            下端つまみのドラッグ中、この層に印は付かない。断片は「ページ (段) をまたいだ続き」
            なので、掴んだブロックと同じページ・同じ段には原理的に存在しない = 追従集合に
            入らない (`resolveSpaceAfterPreviewCohort`)。
          */}
          {editorBoxBlockFragments.length > 0 && (
            <div className="page-box-fragment-layer">
              {editorBoxBlockFragments.map((fragment) => {
                // フロー内の拡張ノードの続きは、同じ中身の操作できない複製で描く。
                const extensionContent = extensionContentByNodeId.get(fragment.blockId);
                if (extensionContent) {
                  return (
                    <FlowExtensionFragmentPreview
                      key={`${fragment.blockId}:${fragment.fragmentIndex}`}
                      item={extensionContent}
                      fragment={fragment}
                    />
                  );
                }
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
                    paginationMarkerKind={resolvePageBreakMarkerKind(isColumnPage)}
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
                  // 2 段目以降のガターは段間。段の本文に寄せた細いレーンへ出し、列境界と左の段から離す。
                  data-gutter-lane={handle.columnLaneWidthPx ? "column" : undefined}
                  data-block-id={handle.blockId}
                  style={{
                    top: `${handle.top}px`,
                    left: `${handle.left}px`,
                    height: `${Math.max(BLOCK_HANDLE_MIN_HEIGHT_PX, Math.min(handle.bottom - handle.top, BLOCK_HANDLE_MAX_HEIGHT_PX))}px`,
                    ...(handle.columnLaneWidthPx ? { "--column-lane-width": `${handle.columnLaneWidthPx}px` } : {}),
                  } as CSSProperties}
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
                  {/* 段間のレーンではアイコンもレーン幅に収める (はみ出すと列境界の線に当たる)。 */}
                  <GripVertical size={handle.columnLaneWidthPx ? Math.min(14, handle.columnLaneWidthPx) : 14} aria-hidden="true" />
                </button>
              ))}
              {blockAffordancesEnabled && visibleSpaceAfterHandles.map((handle) => (
                <button
                  key={`block-space-${handle.blockId}`}
                  type="button"
                  className="page-block-space-handle"
                  // 問題エリアの左ガターには問題番号・サイドノート・エリア高さハンドルが同居する。
                  // 1 レーン外へ寄せて重なりを構造的に避ける。
                  data-gutter-lane={handle.insideProblemArea ? "problem" : handle.columnLaneWidthPx ? "column" : undefined}
                  data-dragging={spaceAfterDrag ? "true" : undefined}
                  data-block-id={handle.blockId}
                  style={{
                    top: `${handle.bottom}px`,
                    left: `${handle.left}px`,
                    ...(handle.columnLaneWidthPx ? { "--column-lane-width": `${handle.columnLaneWidthPx}px` } : {}),
                  } as CSSProperties}
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
                  publishesSessionPresence={publishesSessionPresence}
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
            {!isPagedRender && <RemoteOverlayPresenceLayer shapes={overlayView.shapes} />}
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
        <SelectionActionPopover
          popover={selectionActionPopover}
          onCommentAnchorRequest={onCommentAnchorRequest}
            renderSelectionActions={renderSelectionActions}
        />
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

export { getColumnBreakBeforeBlockIdForContextMenu } from "./page-canvas/column-layout";

export { getSelectionActionPopoverPosition,viewportToCanvasAnchor } from "./page-canvas/popover-anchors";

export { buildRenderUnits } from "./page-canvas/render-units";

export type { FlowUnitLayout,ProblemAreaColumnLayout,RenderUnit } from "./page-canvas/types";

export type { PageCanvasEditorProps } from "./page-canvas/editor-contracts";
export { PageBreakMarker } from "./page-canvas/page-chrome";
export { calculateVisiblePageRange,getVisiblePageIndexes } from "./page-canvas/virtualization";

/**
 * 紙面の描画は文書 1 つ分をまとめて抱えるので、親が別の理由で描画されただけで巻き込まれると重い。
 *
 * ここで効くのは主に「AI ストアの更新で `AiEnabledPageCanvasEditor` だけが描画された」場合で、
 * 文書が変わったときは当然 bail out しない。EditorShell から渡るハンドラの一部はまだ毎レンダー
 * 作り直されるため、その経路での取りこぼしは follow-up。
 */
export const PageCanvasEditor = memo(PageCanvasEditorImpl);
