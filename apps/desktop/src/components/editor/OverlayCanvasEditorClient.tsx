"use client";
import { TableInsertGridPicker } from "./TableInsertGridPicker";
import type { PendingOverlaySave } from "./overlay-canvas/pending-save";
import  {
  AnchorIndicator,
  AnchorIndicatorState,
  AnchorLeader,
  AnchorMeasurements,
  PointHandles,
  getAdaptiveSelectionHandleStyle,
  getAnchorIndicator,
  hasPointOnlySelection,
} from "./overlay-canvas/selection-handles";
import { useDocumentSnapshotSync } from "./overlay-canvas/use-document-snapshot-sync";
import { useOverlayGraph3DController } from "./overlay-canvas/use-graph3d-controller";


import type  {
  CSSProperties,
  ChangeEvent as ReactChangeEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
  PointerEvent as ReactPointerEvent,
} from "react";
import  {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";

import type { Editor as TiptapEditor } from "@tiptap/core";
import  {
  AlignHorizontalDistributeCenter,
  AlignHorizontalJustifyCenter,
  AlignHorizontalJustifyEnd,
  AlignHorizontalJustifyStart,
  AlignVerticalDistributeCenter,
  AlignVerticalJustifyCenter,
  AlignVerticalJustifyEnd,
  AlignVerticalJustifyStart,
  BringToFront,
  ChartColumnBig,
  ChevronRight,
  Copy,
  Crop,
  Crosshair,
  FlipHorizontal2,
  FlipVertical2,
  GripHorizontal,
  Group,
  Layers,
  Maximize2,
  MoveDown,
  MoveUp,
  PackagePlus,
  PaintBucket,
  RefreshCw,
  RotateCcw,
  RotateCw,
  SendToBack,
  Settings2,
  Shapes,
  Trash2,
  Ungroup,
} from "lucide-react";

import  {
  GRAPH_FILL_UNRESOLVED_EVENT,
  OPEN_OVERLAY_CHART_SETTINGS_EVENT,
  OPEN_OVERLAY_GRAPH_SETTINGS_EVENT,
  SELECT_OVERLAY_CHART_EVENT,
  SELECT_OVERLAY_GRAPH_EVENT,
  type SelectedOverlayChart,
  type SelectedOverlayGraph,
} from "@/components/editor/EditorSettings";
import  {
  OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT,
} from "@/components/editor/Graph3DSettingsPanel";
import { requestInlineMathEdit } from "@/components/tiptap/inline-math-extension";
import { applyTextFormatCommand } from "@/components/tiptap/text-format-controller";
import  {
  appendOverlayTextInline,
  fontSizeToOverlaySize,
  formatOverlayTextBlocks,
  normalizeLineHeight,
  normalizeOverlaySnapshot,
  pruneUnusedOverlayAssets,
  patchShape,
  removeShapes,
  resolveChartData,
  syncChartDataSnapshots,
  upsertShape,
  type BoxedVariant,
  type Graph2DSpec,
  type InlineNode,
  type OverlayTextBlock,
  type OverlayTextCommand,
  type PageOverlay,
  type SigmaChartSpec,
} from "@/features/document";
import  {
  ZERO_BOUNDS_PADDING,
  alignShapes,
  appendCurveDrawingPoint,
  boundsIntersect,
  canBoxResize,
  canRemoveLinePointAt,
  collectSelectedOverlayAssets,
  createOverlaySnapGeometry,
  distributeShapes,
  fitShapesWithinPage,
  flipShapesAround,
  getCurveDrawingHint,
  getCurveDrawingPreviewPoints,
  getOnlySelectedTextShape,
  getSelectionResizeFrame,
  getSelectionRotationPivot,
  getSelectionVisualFrame,
  getShapeBounds,
  getShapeRotation,
  getShapeRotationPivot,
  getShapeSelectionBounds,
  getShapeVisualBounds,
  getShapesSelectionBounds,
  getShapesVisualBounds,
  getSnappedArcInsertDragPoint,
  getTopmostSelectedShapes,
  hitTestShape,
  insertLinePointAt,
  isEditableLineKind,
  isOverlayRichTextShape,
  mergeShapesById,
  mergeStyleDefaults,
  moveShape,
  moveShapes,
  pickStyleDefaultsForInsert,
  preserveRotatedTextResizeTopLeft,
  removeLinePointAt,
  removeNearDuplicateDrawingPoints,
  resizeRotatedShapeToBounds,
  resizeRotatedShapeToVisualBounds,
  resizeShapesToVisualBounds,
  resolveResizePointer,
  resolveRotatePointerDelta,
  rotateShapesAround,
  sameOverlayShapeIds,
  sameOverlayShapeReferences,
  shouldClosePolylineDrawing,
  snapBoundsToGeometry,
  snapPointToGeometry,
  snapResizeBoundsToGeometry,
  toggleOverlayShapeSelectionIds,
  updateShapePoint,
  type ClickPointDrawingCommand,
  type OverlayAlignAction,
  type OverlayDistributeAxis,
  type OverlayFlipAxis,
  type OverlayShapeStyleDefaults,
  type OverlaySnapGuide,
} from "@/features/drawing";
import { getShapePageSpan, type VisiblePageRange } from "@/features/rendering/core";
import  {
  cloneOverlayShapesForPaste,
  collectClipboardSliceBlockIds,
  createOverlayClipboardPayload,
  createTextAndShapesClipboardPayload,
  extractVisibleEditorClipboardHtml,
  readEditorClipboardPayload,
  readTextSliceClipboardData,
  takeBodyTextCut,
  toOverlayShapesClipboardPayload,
  writeEditorClipboardData,
  type EditorClipboardPayload,
} from "@/lib/editor-clipboard";
import { createGraphFillId, toggleGraphFillAtPoint } from "@/lib/graph-fill";
import  {
  getGraphNumericRange,
  getGraphPlotBox,
  moveGraphOriginToRatios,
  unmapGraphPoint,
  type GraphSpecChangeMeta,
} from "@/lib/graph2d";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import { createId } from "@/lib/id";
import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES, getSupportedOverlayImageFiles } from "@/lib/overlay-image-files";
import  {
  createDragAutoScroller,
  findDragAutoScrollScroller,
  getDragAutoScrollViewportBounds,
  panDragAutoScrollElement,
  type DragAutoScrollPanBy,
  type DragAutoScroller,
} from "./drag-auto-scroll";
import  {
  buildBlockAnchorAtBoundary,
  measureBlockTops,
  pickAnchorBoundaryAtPoint,
  resolveShapesPosition,
  type MeasuredBlock,
} from "./overlay-canvas/anchor";
import { getAllSelectableShapeIds, getShapeIdsAnchoredToBlocks } from "./overlay-canvas/anchored-shape-selection";
import { snapPointAround } from "./overlay-canvas/angle";
import { getOverlayArrangeShortcutAction, overlayArrangeActionAllowsRepeat } from "./overlay-canvas/arrange-shortcuts";
import { isOverlayActionBlockedByEditPolicy, isOverlaySelectionBlockedByEditPolicy } from "./overlay-canvas/edit-policy";
import { EMPTY_OVERLAY_EDIT_POLICY, type OverlayEditPolicy, type OverlayShapeDecoration } from "./overlay-canvas/editor-extension";
import { focusOverlaySurface } from "./overlay-canvas/focus-overlay-surface";
import  {
  getEffectiveShapeOpacity,
  getGroupShape,
  getIdsWithDescendants,
  getMovingShapeIdsWithFullyMovingGroups,
  getRenderableShapes,
  getRenderableShapesInReverseVisualStackOrder,
  getSelectedShapesForClipboard,
  getSelectedShapesInStackOrder,
  getShapeIdsForCurrentScope,
  getShapeSelectionIds,
  getShapesForStackLayer,
  getUnlockedTransformShapes,
  groupOverlayShapes,
  isOverlayGroupShape,
  isShapeDescendantOf,
  isShapeEditPolicyLockedInTree,
  isShapeGroupMember,
  isShapeHiddenInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups,
  orderShapeIdsByVisualStackOrder,
  ungroupOverlayShapes,
} from "./overlay-canvas/grouping";
import { createOverlayGroupId, createOverlayShapeId } from "./overlay-canvas/ids";
import { replaceOverlayImageAsset, resetOverlayImageCrop, resizeOverlayImageToNaturalSize } from "./overlay-canvas/image-actions";
import { getImageCoverCrop, panImageCrop, resizeImageCropFrame } from "./overlay-canvas/image-crop";
import { createOverlayImageAsset, createOverlayImageEntry } from "./overlay-canvas/image-file";
import { createOverlayImageImportSession } from "./overlay-canvas/image-import-session";
import  {
  createInitialOverlayInteractionMode,
  getEditingShapeId,
  getGraphFillPickShapeId,
  getMoveOffset,
  getOriginPickShapeId,
  getOverlayTool,
  isInitialOriginPickMode,
  isInteractionMode,
  overlayInteractionModeReducer,
  resolveMovePointerUp,
  type InsertTool,
  type OverlayInteractionAction,
  type OverlayInteractionMode,
  type PointHandle,
  type ResizeHandle,
} from "./overlay-canvas/interaction-mode";
import { getMarqueeSelectionIds } from "./overlay-canvas/marquee-selection";
import  {
  angleFromCenter,
  boundsFromPoints,
  clamp,
  constrainPointToAspectFromStart,
  pagePointToUnrotatedShapePoint,
} from "./overlay-canvas/math";
import { prepareOverlayShapesForPaste } from "./overlay-canvas/paste-shapes";
import  {
  areOverlayAnchorsEqual,
  attachUnanchoredShapesToMeasuredBlocks,
  inheritGroupAnchorsForMembers,
  reanchorShapesAgainstMeasuredBlocks,
  reanchorShapesByPosition,
  syncMovedOverlayShapeAnchor,
} from "./overlay-canvas/reanchor-model";
import { readRememberedShapeStyle, rememberShapeStyle, subscribeRememberedShapeStyle } from "./overlay-canvas/remembered-shape-style";
import { reorderShapes, type OverlayArrangeAction } from "./overlay-canvas/reorder-shapes";
import  {
  CORNER_RESIZE_HANDLES,
  EDGE_RESIZE_HANDLES,
  getLocalResizeDelta,
  getResizeHandleSet,
  isCornerResizeHandle,
} from "./overlay-canvas/resize";
import { getShapeAdjustmentReadout, isShapeAdjustmentHandle } from "./overlay-canvas/shape-adjustment";
import type { OriginPickPreview, TableShapeResizePatch } from "./overlay-canvas/shape-editors";
import { buildShapeTypeChangeSections } from "./overlay-canvas/shape-gallery";
import { useOverlayShapeEditorRenderers } from "./overlay-canvas/shape-interactive-body";
import  {
  OverlayShapeDimensionLabels,
  OverlayShapeHitTarget,
  OverlayShapeView,
  ShapeBody,
  composeShapeTransform,
  noopGraphCropEnd,
  noopGraphSpecChange,
  noopShapeDoubleClick,
  noopShapePointerDown,
} from "./overlay-canvas/shape-renderer";
import  {
  canChangeOverlayShapeType,
  changeOverlayShapeType,
  isShapeTypeChangeCommand,
  type ShapeTypeChangeCommand,
} from "./overlay-canvas/shape-type-change";
import { getArcDragReadoutText } from "./overlay-canvas/shapes/arc-readout";
import { DEFAULT_CALLOUT_CORNER_RADIUS } from "./overlay-canvas/shapes/callout";
import { createChartShapeProps, getChartBoundsForTable } from "./overlay-canvas/shapes/chart";
import  {
  arrowKeyDelta,
  buildInsertShape,
  getRegularInsertAspect,
  isAngleSnappedInsertTool,
  isArcInsertTool,
  isArrowKey,
  isClickPointDrawingTool,
  isConstraintModifierKey,
  isPointSnappedClickDrawingTool,
  isPointSnappedInsertDragTool,
  isSnapDisableKey,
} from "./overlay-canvas/shapes/create-shape";
import  {
  GRAPH_SHAPE_EDIT_EVENT,
  GRAPH_SHAPE_TYPE,
  createGraphAnnotationLabelShapeEntries,
  createGraphAxisLabelShapeEntries,
  createGraphFormulaLabelShapeEntries,
  createGraphPointLabelShapeEntries,
  getGraphCropPositionPatch,
  getGraphDisplaySpec,
  getGraphOwnedLabelTextSyncedProps,
  getGraphRenderLayout,
  getGraphShapeSizeForSpec,
  isGraphLabelTextShape,
} from "./overlay-canvas/shapes/graph";
import  {
  clearGraphFixedAxisLabels,
  clearMaterializedGraphLabelTexts,
  getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId,
  getExistingGraphAxisLabelTextShapeIdsByKey,
  getExistingGraphLabelTextShapeIds,
  getExistingGraphLabelTextShapeIdsByCurveId,
  getExistingGraphPointLabelTextShapeIdsByPointId,
  getGraphAxisLabelTextsByKey,
  getOrderedGraphLabelTextShapeIds,
  getSelectedGraphShapeForSettings,
  hydrateGraphSpecWithOwnedLabelTexts,
  materializeMissingGraphOwnedTextLabels,
  syncGraphOwnedLabelTextShapePositions,
  withGraphAnnotationLabelTextShapeIds,
  withGraphAxisLabelTextShapeIds,
  withGraphLabelTextShapeIds,
  withGraphPointLabelTextShapeIds,
} from "./overlay-canvas/shapes/graph-labels";
import  {
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_HEIGHT,
  DEFAULT_TABLE_ROW_HEIGHT,
  TABLE_SHAPE_TYPE,
  createPlainTableSpec,
} from "./overlay-canvas/shapes/table";
import  {
  applyStylePatchToShape,
  canShapeStyleFill,
  canShapeStyleLine,
  canShapeStyleLineEndpoints,
  canShapeStyleStroke,
  isOpenStrokeShape,
  sharedArrowhead,
  sharedFill,
} from "./overlay-canvas/style-patch";
import type  {
  OverlayAnchor,
  OverlayAsset,
  OverlayBounds,
  OverlayGraphAxisLabelKey,
  OverlayGraphShape,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
  OverlayShapePatch,
  OverlaySnapshot,
  OverlayTool,
  SigmaTableSpec,
} from "./overlay-canvas/types";
import { calculateReserveSpaceGaps } from "./page-canvas/layout-measure";
import  {
  FLUSH_OVERLAY_CHANGES_EVENT,
  OVERLAY_STYLE_PREVIEW_EVENT,
  type OverlayActionRequest,
  type OverlayChangeHistory,
  type OverlayChangeOptions,
  type OverlayCommandRequest,
  type OverlayImageRequest,
  type OverlayModeStatus,
  type OverlaySelectPointRequest,
  type OverlaySelectionStylePatch,
  type OverlaySelectionSummary,
  type OverlayStylePreviewEvent,
} from "./page-overlay-types";
export {
OverlayTableShapeEditor,
OverlayTextShapeEditor,
type OriginPickPreview,
type TableShapeResizePatch
} from "./overlay-canvas/shape-editors";
export { OverlayShapeReadOnlyView } from "./overlay-canvas/shape-renderer";

const INSERT_INLINE_MATH_EVENT = "sigma-studio:insert-inline-math";
const FORMAT_TEXT_EVENT = "sigma-studio:format-text";
/**
 * キャンバスのキーボード操作から除外する「backdrop の無い浮遊 UI」。
 *
 * `data-non-modal-surface` はグラフ設定パネル本体に付くが、その中から開く色・線種・
 * 太さ・塗り方のポップオーバーは `document.body` 直下へ portal されるので DOM 上は
 * パネルの外側になる。属性だけを見ると、そこにフォーカスがある間の Delete が
 * キャンバスに届いて選択中の図形を消す。
 */
const NON_MODAL_KEYBOARD_SURFACE_SELECTOR = "[data-non-modal-surface], [data-toolbar-popover]";
const OPEN_STROKE_POINTER_HIT_MARGIN = 14;
const OVERLAY_SNAP_THRESHOLD_PX = 8;
const IMAGE_INSERT_GAP = 16;
const EMPTY_ANCHOR_MEASUREMENTS: AnchorMeasurements = { rects: new Map(), ordered: [] };
/** Pointer slop that keeps a click on the grip from rewriting the anchor. */
const ANCHOR_DRAG_SLOP_PX = 2;
// 8px は押下位置の微小な揺れと本物のドラッグを分ける値。本文選択の
// DRAG_SELECTION_THRESHOLD_PX = 2 より大きいのは、誤爆時に 1px 動くのではなく紙面が飛ぶため。
const DRAG_AUTO_SCROLL_SLOP_PX = 8;
const SHAPE_DRAG_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC = 1100;

interface TableInsertPickerState {
  requestId: number;
  anchorRect?: { x: number; y: number; width: number; height: number };
}

interface OverlayContextMenuState {
  x: number;
  y: number;
  shapeId: OverlayShapeId;
}

const CALLOUT_CORNER_RADIUS_STORAGE_KEY = "sigma-studio:overlay-callout-corner-radius";
let rememberedCalloutCornerRadius = DEFAULT_CALLOUT_CORNER_RADIUS;

function readRememberedCalloutCornerRadius(): number {
  if (typeof window === "undefined") {
    return rememberedCalloutCornerRadius;
  }
  try {
    const raw = window.localStorage.getItem(CALLOUT_CORNER_RADIUS_STORAGE_KEY);
    const stored = raw === null ? Number.NaN : Number(raw);
    if (Number.isFinite(stored) && stored >= 0) {
      rememberedCalloutCornerRadius = stored;
    }
  } catch {
    // 保存領域を利用できない環境ではメモリ上の値を使う。
  }
  return rememberedCalloutCornerRadius;
}

function rememberCalloutCornerRadius(radius: number): void {
  rememberedCalloutCornerRadius = radius;
  if (typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(CALLOUT_CORNER_RADIUS_STORAGE_KEY, String(radius));
  } catch {
    // 保存領域を利用できなくても、現在の編集セッションでは上の値を引き継げる。
  }
}

function getTextPaintRevision(
  shape: OverlayShape,
  repaint: { revision: number; bounds: OverlayBounds } | null,
): number | undefined {
  if (
    !repaint
    || !isOverlayRichTextShape(shape)
    || !boundsIntersect(getShapeSelectionBounds(shape), repaint.bounds)
  ) {
    return undefined;
  }
  return repaint.revision;
}


/**
 * 250ms の保存窓に積まれた変更をまとめる規則。`history` は今までどおり `record` が勝つ。
 *
 * `historyGroup` の合成は下の {@link mergeOverlayHistoryGroup}。
 */
function mergePendingOverlaySave(
  pending: PendingOverlaySave | null,
  options: OverlayChangeOptions,
): PendingOverlaySave {
  const requestedHistory = options.history ?? "record";
  const requestedGroup = options.historyGroup ?? null;
  if (!pending) {
    return { history: requestedHistory, historyGroup: requestedGroup };
  }
  return {
    history: pending.history === "record" || requestedHistory === "record" ? "record" : "coalesce",
    historyGroup: mergeOverlayHistoryGroup(pending.historyGroup, requestedGroup),
  };
}

/**
 * 同じ 250ms 窓に落ちた 2 つの保存要求のコアレスキーを合成する。
 *
 * - **片方だけがキーを持つ → そのキーを採る。** キー無しの保存 (オーバーレイ編集に入った
 *   ときの再アンカーなど) が窓に残っているのは普通のことで、実測でもペースト直前に 1 本
 *   積まれている。ここでキーを捨てると混在ペーストが畳めず、⌘Z が 2 回必要になる。
 *   採った場合の代償は「その無関係な変更も同じ undo エントリで一緒に戻る」ことだけで、
 *   **失われるものは無い** (エントリは操作前のスナップショットを持っている)。
 * - **両方がキーを持ち、違う → `null`。** 別々の混在操作が同じ窓で衝突したときは畳まず、
 *   独立した undo エントリにするのが安全側。
 */
export function mergeOverlayHistoryGroup(pending: string | null, requested: string | null): string | null {
  if (pending === requested) {
    return pending;
  }
  if (pending === null) {
    return requested;
  }
  if (requested === null) {
    return pending;
  }
  return null;
}

interface OverlayCanvasEditorClientProps {
  externalRevision: number;
  /**
   * Document this overlay belongs to. A pasted copy that came from another document cannot keep
   * its block anchors, because the anchored block only exists in the document it was copied from.
   */
  documentId?: string;
  overlay: PageOverlay;
  /** Width (unzoomed px) of one page in the overlay coordinate space. */
  canvasWidth: number;
  /** Height (unzoomed px) of the continuous overlay coordinate space (whole document). */
  canvasHeight: number;
  /** Extra overlay coordinate space rendered outside the page bounds. */
  bleedValues: { x: number; top: number };
  /** Width of the page content area used to fit newly inserted images. */
  imageInsertAreaWidth: number;
  /** Height of the page content area used to fit newly inserted images. */
  imageInsertAreaHeight: number;
  /** DOM scope used to measure text-flow blocks for body overlay anchors. */
  blockAnchorScopeElement?: HTMLElement | null;
  /**
   * 本文ブロックの計測結果 (`PageCanvasEditor` の `layoutViewState.blockRects`)。
   *
   * 中身は読まず identity だけを見る。保証されているのは**片側だけ**:
   * 本文の幾何が動けば identity は必ず変わる (`sameMeasuredBlockMap` が 0.5px 差で弾く)。
   * 逆は成り立たない — `layoutViewState` は隙間・ユニット配置・ページ数など十数項目の
   * どれが変わっても差し替わるので、幾何が動いていなくても identity が変わることはある。
   * 測り直しの合図としてはこの向きで十分 (取りこぼさない側に倒れている)。
   */
  bodyBlockRects?: ReadonlyMap<string, MeasuredBlock> | null;
  /**
   * アンカーが乗れるブロックの実測 (`PageCanvasEditor` の `layoutViewState.blockAnchorable`)。
   * `bodyBlockRects` と揃って渡された時だけ、overlay は自前の全件計測をやめてこれを使う。
   */
  bodyAnchorableBlocks?: readonly MeasuredBlock[] | null;
  /**
   * 表示中のページ範囲 (overscan 込み)。渡された時だけ編集モードの図形も窓化する。
   * 読み取り専用プレビューと同じ範囲・同じページ判定を使う。
   */
  visiblePageRange?: VisiblePageRange | null;
  /** Remounts only visible static text after a whiteboard camera movement settles. */
  textRepaint?: { revision: number; bounds: OverlayBounds } | null;
  /** 1 ページの高さ (unzoomed px)。窓化のページ判定に使う。 */
  pageHeightPx?: number;
  /** ページ間の隙間 (unzoomed px)。窓化のページ判定に使う。 */
  pageGapPx?: number;
  /** Whether selected shapes expose draggable page/body anchor handles. */
  showAnchorHandles?: boolean;
  /** ホワイトボードなど、DOM scroll 以外で viewport を流す場合の差し替え口。 */
  autoScrollPanBy?: DragAutoScrollPanBy;
  /** `autoScrollPanBy` と組で使う client 座標上の可視域。 */
  autoScrollViewportElement?: HTMLElement | null;
  /** Vertical guide x positions, such as body text column starts/ends, in overlay coordinates. */
  verticalSnapGuides?: number[];
  backgroundLayerElement?: HTMLElement | null;
  commandRequest: OverlayCommandRequest | null;
  imageRequest: OverlayImageRequest | null;
  actionRequest: OverlayActionRequest | null;
  arrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  /**
   * Whether this canvas answers style previews.
   *
   * Previews arrive as a window event, which reaches every mounted canvas; the host gates the
   * inactive one the same way it nulls the request channels above.
   */
  acceptsStylePreview?: boolean;
  selectPointRequest: OverlaySelectPointRequest | null;
  onCommandHandled: (requestId: number) => void;
  onImageHandled: (requestId: number) => void;
  onActionHandled: (requestId: number) => void;
  onSelectPointHandled: (requestId: number, hitShape: boolean) => void;
  onRequestTextMode: (screenPoint?: { x: number; y: number }) => void;
  /**
   * 図形を1つも掴まなかったマーキー。本文を持つ面だけが受け取り、本文の上で始まった
   * ドラッグだったときに範囲選択として引き継ぐ (本文の有無を確かめるのは受け手)。
   * 渡されない面では、空振りのマーキーは今までどおり図形モードに留まる。
   */
  onRequestTextSelection?: (screenStart: { x: number; y: number }, screenEnd: { x: number; y: number }) => void;
  onModeStatusChange?: (status: OverlayModeStatus) => void;
  onSelectionSummaryChange?: (summary: OverlaySelectionSummary) => void;
  /** Synchronous mirror of selection count for keyboard ownership before React re-renders. */
  onSelectedCountChange?: (count: number) => void;
  onActiveToolChange?: (tool: OverlayTool) => void;
  onMaterialSaveRequest?: () => void;
  syncBlockAnchors?: boolean;
  onChange: (overlay: PageOverlay, options?: OverlayChangeOptions) => void;
  /** Optional feature-owned policy; absent means every unlocked shape is editable. */
  editPolicy?: OverlayEditPolicy;
  /** Optional feature-owned in-bounds visuals keyed by shape id. */
  shapeDecorations?: ReadonlyMap<string, OverlayShapeDecoration>;
  /** Diff/apply classes for existing shapes, supplied by the host feature. */
  diffShapeClassNames?: ReadonlyMap<string, string>;
}

function isDragAutoScrollInteraction(mode: OverlayInteractionMode): boolean {
  return mode.id === "overlay.move" ||
    mode.id === "overlay.resize" ||
    mode.id === "overlay.point" ||
    mode.id === "overlay.marquee" ||
    mode.id === "overlay.insertDrag" ||
    mode.id === "overlay.anchor";
}

export default function OverlayCanvasEditorClient({
  externalRevision,
  documentId,
  overlay,
  canvasWidth,
  canvasHeight,
  bleedValues,
  imageInsertAreaWidth,
  imageInsertAreaHeight,
  blockAnchorScopeElement,
  bodyBlockRects = null,
  bodyAnchorableBlocks = null,
  visiblePageRange = null,
  textRepaint = null,
  pageHeightPx = 0,
  pageGapPx = 0,
  showAnchorHandles = true,
  autoScrollPanBy,
  autoScrollViewportElement = null,
  verticalSnapGuides = [],
  backgroundLayerElement,
  commandRequest,
  imageRequest,
  actionRequest,
  arrangeShortcutLabels,
  acceptsStylePreview = true,
  selectPointRequest,
  onCommandHandled,
  onImageHandled,
  onActionHandled,
  onSelectPointHandled,
  onRequestTextMode,
  onRequestTextSelection,
  onModeStatusChange,
  onSelectionSummaryChange,
  onSelectedCountChange,
  onActiveToolChange,
  onMaterialSaveRequest,
  syncBlockAnchors = true,
  onChange,
  editPolicy = EMPTY_OVERLAY_EDIT_POLICY,
  shapeDecorations,
  diffShapeClassNames,
}: OverlayCanvasEditorClientProps) {
  const tShape = useT("shape");
  const initialSnapshot = useMemo(() => normalizeOverlaySnapshot(overlay.overlaySnapshot), [overlay.overlaySnapshot]);
  const [shapes, setShapes] = useState<OverlayShape[]>(initialSnapshot.shapes);
  const [assets, setAssets] = useState<Record<string, OverlayAsset>>(initialSnapshot.assets);
  const [selectedIds, setSelectedIds] = useState<OverlayShapeId[]>([]);
  /**
   * A style being dragged in the toolbar: drawn, never persisted. See `previewedShapes`.
   *
   * The target ids are captured when the preview starts, so it stays on the figures it was started
   * on instead of following a selection that moves underneath it.
   */
  const [preview, setPreview] = useState<{ style: OverlaySelectionStylePatch; targetIds: Set<string> } | null>(null);
  const [tableInsertPicker, setTableInsertPicker] = useState<TableInsertPickerState | null>(null);
  const [contextMenu, setContextMenu] = useState<OverlayContextMenuState | null>(null);
  const [focusedGroupId, setFocusedGroupId] = useState<OverlayShapeId | null>(null);
  const [anchorMeasurements, setAnchorMeasurements] = useState<AnchorMeasurements>(EMPTY_ANCHOR_MEASUREMENTS);
  const [originPickPreview, setOriginPickPreview] = useState<OriginPickPreview | null>(null);
  const [snapGuides, setSnapGuides] = useState<OverlaySnapGuide[]>([]);
  const [appliedSnapshotRevision, setAppliedSnapshotRevision] = useState(0);
  const [mode, dispatchMode] = useReducer(overlayInteractionModeReducer, undefined, createInitialOverlayInteractionMode);
  const dragOffset = getMoveOffset(mode);
  const editingShapeId = getEditingShapeId(mode);
  const originPickShapeId = getOriginPickShapeId(mode);
  const initialOriginPickShapeId = isInitialOriginPickMode(mode) ? originPickShapeId : null;
  const visibleOriginPickPreview = originPickPreview?.shapeId === originPickShapeId ? originPickPreview : null;
  const graphFillPickShapeId = getGraphFillPickShapeId(mode);
  const bleedSurfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const canvasWidthRef = useRef(canvasWidth);
  const canvasHeightRef = useRef(canvasHeight);
  const documentIdRef = useRef(documentId);
  useEffect(() => {
    documentIdRef.current = documentId;
  }, [documentId]);
  useEffect(() => {
    canvasWidthRef.current = canvasWidth;
  }, [canvasWidth]);
  useEffect(() => {
    canvasHeightRef.current = canvasHeight;
  }, [canvasHeight]);
  const activeTextEditorRef = useRef<TiptapEditor | null>(null);
  const textCompositionRef = useRef(false);
  const modeRef = useRef(mode);
  const suppressNextShapeDoubleClickRef = useRef(0);
  const saveTimeoutRef = useRef<number | undefined>(undefined);
  const pendingOverlayHistoryRef = useRef<PendingOverlaySave | null>(null);
  /**
   * 次に積まれる図形変更へ付けるコアレスキー (混在ペースト / 混在カット)。
   *
   * `deleteSelectedShapes` / `setShapes` の**シグネチャを変えずに**キーを運ぶための ref。
   * `deleteSelectedShapes` は `runContextMenuAction(deleteSelectedShapes)` としてコールバック値
   * のまま渡されており、引数を足すとイベントオブジェクトが options として流れ込む。
   */
  const pendingOverlaySaveHistoryGroupRef = useRef<string | null>(null);
  const imageCropDirtyRef = useRef(false);
  const mountedRef = useRef(false);
  const suppressNextSaveRef = useRef(false);
  const explicitlySavedShapeStatesRef = useRef(new WeakSet<OverlayShape[]>());
  const externalRevisionRef = useRef(externalRevision);
  // 直近に自分が文書へ書いたスナップショットと、文書側で最後に見たスナップショット。
  // 文書の overlay が「自分の書き込みの反響」でも「同じ内容」でもなく変わったら、それは
  // 外から来た変更 (AI提案の適用など) なので、自分の状態を捨てて文書に合わせる。
  // ホワイトボードではこの編集面が常設なので、これが無いと外部適用が画面に出ない。
  const lastEmittedSnapshotRef = useRef<OverlaySnapshot | null>(null);
  const seenDocumentSnapshotRef = useRef(overlay.overlaySnapshot);
  // 反響・同内容・採用のいずれかで「見終えた」文書スナップショット。作業中で見送ったものは
  // ここに入らないので、select に戻ったときにそれだけをもう一度見る。
  const reconciledDocumentSnapshotRef = useRef(overlay.overlaySnapshot);
  const onChangeRef = useRef(onChange);
  const handledCommandRequestIdRef = useRef<number | null>(null);
  const imageImportSessionRef = useRef<ReturnType<typeof createOverlayImageImportSession> | null>(null);
  const handledActionRequestIdRef = useRef<number | null>(null);
  const handledSelectPointRequestIdRef = useRef<number | null>(null);
  const imageReplacementInputRef = useRef<HTMLInputElement | null>(null);
  const imageReplacementShapeIdRef = useRef<OverlayShapeId | null>(null);
  const imageInsertAreaRef = useRef({ w: imageInsertAreaWidth, h: imageInsertAreaHeight });
  useLayoutEffect(() => {
    imageInsertAreaRef.current = { w: imageInsertAreaWidth, h: imageInsertAreaHeight };
  }, [imageInsertAreaHeight, imageInsertAreaWidth]);
  const shapesRef = useRef(shapes);
  const assetsRef = useRef(assets);
  const extensionsRef = useRef(initialSnapshot.extensions);
  const selectedIdsRef = useRef(selectedIds);
  const focusedGroupIdRef = useRef(focusedGroupId);
  const anchorMeasurementsRef = useRef(anchorMeasurements);
  const anchorMeasurementKeyRef = useRef("");
  const lastInteractionPointRef = useRef<OverlayPoint | null>(null);
  const dragAutoScrollerRef = useRef<DragAutoScroller | null>(null);
  const dragPointerRef = useRef<{
    pointerId: number;
    startClientX: number;
    startClientY: number;
    autoScrollArmed: boolean;
  } | null>(null);
  const dragCanvasRectRef = useRef<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const lastPointerModifiersRef = useRef({ ctrlKey: false, shiftKey: false });
  const advanceInteractionFromClientRef = useRef<(
    clientX: number,
    clientY: number,
    modifiers: { ctrlKey: boolean; shiftKey: boolean },
    cachedCanvasRect?: { left: number; top: number; width: number; height: number } | null,
  ) => void>(() => undefined);
  // リサイズ中に写像から外しておく線幅・矢印ヘッド分の余白。ドラッグ開始時に 1 度だけ測る
  // (図形の大きさに依らない一定量なので、ドラッグ中に測り直す必要はない)。
  const resizePaddingRef = useRef(ZERO_BOUNDS_PADDING);
  // The callout's corner radius stays on its own key rather than joining the style defaults below:
  // it is a per-shape geometry number, not one of the axes every shape shares, and putting it in
  // the cross-shape matrix would mean a rectangle could "remember" a callout's roundness.
  const lastCalloutCornerRadiusRef = useRef(DEFAULT_CALLOUT_CORNER_RADIUS);
  useEffect(() => {
    lastCalloutCornerRadiusRef.current = readRememberedCalloutCornerRadius();
  }, []);
  /**
   * The style the next inserted shape starts from.
   *
   * Read from storage in the initialiser rather than in an effect: an insertion can be committed
   * before an effect has run, and the value has to outlive this canvas (tab switch, reload) rather
   * than the document — undo restores shapes, never this.
   *
   * State, so the drag preview can read it while rendering; kept current through the store's own
   * subscription rather than from a snapshot, because another canvas may be mounted beside this one.
   */
  const [shapeStyleDefaults, setShapeStyleDefaults] = useState(readRememberedShapeStyle);
  useEffect(() => subscribeRememberedShapeStyle(setShapeStyleDefaults), []);
  const learnShapeStyleDefaults = useCallback((next: OverlayShapeStyleDefaults) => {
    rememberShapeStyle(next);
  }, []);
  const snapDisabledRef = useRef(false);
  // 図形の黄色い調整ハンドルをドラッグ中にライブ数値表示を出すためのポインタ位置(ページ座標)。
  const [adjustmentDragReadoutPointerPosition, setAdjustmentDragReadoutPointerPosition] = useState<OverlayPoint | null>(null);

  // Read through a ref from pointer/keyboard handlers so feature policy
  // updates never require rebuilding the interaction callbacks.
  const editPolicyLockedShapeIds = editPolicy.lockedShapeIds;
  const editPolicyLockedShapeIdsRef = useRef(editPolicyLockedShapeIds);
  useEffect(() => {
    editPolicyLockedShapeIdsRef.current = editPolicyLockedShapeIds;
  }, [editPolicyLockedShapeIds]);
  const [editPolicyNotice, setEditPolicyNotice] = useState<string | null>(null);
  const editPolicyNoticeTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notifyEditPolicyBlocked = useCallback(() => {
    if (!editPolicy.blockedMessage) {
      return;
    }
    setEditPolicyNotice(editPolicy.blockedMessage);
    if (editPolicyNoticeTimeoutRef.current) {
      clearTimeout(editPolicyNoticeTimeoutRef.current);
    }
    editPolicyNoticeTimeoutRef.current = setTimeout(() => setEditPolicyNotice(null), 6000);
  }, [editPolicy.blockedMessage]);
  useEffect(() => () => {
    if (editPolicyNoticeTimeoutRef.current) {
      clearTimeout(editPolicyNoticeTimeoutRef.current);
    }
  }, []);

  const clearSnapGuides = useCallback(() => {
    setSnapGuides((current) => (current.length === 0 ? current : []));
  }, []);

  const getOverlaySnapThreshold = useCallback(() => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return OVERLAY_SNAP_THRESHOLD_PX;
    }

    const scaleX = canvasWidthRef.current / rect.width;
    const scaleY = canvasHeightRef.current / rect.height;
    return OVERLAY_SNAP_THRESHOLD_PX * Math.max(scaleX, scaleY);
  }, []);

  const getBlockAnchorScope = useCallback((): ParentNode | null => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return blockAnchorScopeElement ?? null;
    }

    if (blockAnchorScopeElement && canvas.ownerDocument.contains(blockAnchorScopeElement)) {
      return blockAnchorScopeElement;
    }

    return canvas.closest(".page-canvas") ?? canvas.ownerDocument;
  }, [blockAnchorScopeElement]);

  /**
   * スナップ先の幾何はドラッグ 1 回につき 1 度だけ組む。
   *
   * 移動・リサイズ中は図形の確定が pointerup までされない = `shapesRef.current` の identity が
   * 変わらないので、入力が同じなら前回の geometry をそのまま返せる。以前は pointermove ごとに
   * 全図形の枠を計算し直していた (図形 500 個の紙面ではこれが 1 フレームぶんの仕事になる)。
   *
   * 線の端点ドラッグだけは動かしている図形自体を毎回差し替えるので作り直しになるが、
   * その経路は対象が 1 図形なので元から軽い。
   */
  const snapGeometryCacheRef = useRef<{
    canvasHeight: number;
    canvasWidth: number;
    excludedKey: string;
    geometry: ReturnType<typeof createOverlaySnapGeometry>;
    guides: number[];
    shapes: OverlayShape[];
  } | null>(null);

  const createSnapGeometry = useCallback((excludedShapeIds: Iterable<OverlayShapeId> = []) => {
    // Iterable は 2 回舐められないので先に配列にする。
    const excludedIds = [...excludedShapeIds];
    // id は取り込み教材や AI 生成由来でカンマを含みうるので、区切り文字で繋ぐと
    // ["a,b"] と ["a","b"] が同じ鍵になる (自分自身にスナップしうる)。
    const excludedKey = JSON.stringify(excludedIds);
    const shapes = shapesRef.current;
    const canvasWidth = canvasWidthRef.current;
    const canvasHeight = canvasHeightRef.current;
    const cached = snapGeometryCacheRef.current;
    // guides は既定値が毎レンダー新しい配列になるので、identity ではなく値で比べる (要素数は数個)。
    const sameGuides = cached
      && cached.guides.length === verticalSnapGuides.length
      && cached.guides.every((value, index) => value === verticalSnapGuides[index]);
    if (
      cached
      && sameGuides
      && cached.shapes === shapes
      && cached.excludedKey === excludedKey
      && cached.canvasWidth === canvasWidth
      && cached.canvasHeight === canvasHeight
    ) {
      return cached.geometry;
    }

    const geometry = createOverlaySnapGeometry(getRenderableShapes(shapes), {
      excludedShapeIds: excludedIds,
      canvasWidth,
      canvasHeight,
      verticalGuideValues: verticalSnapGuides,
    });
    snapGeometryCacheRef.current = {
      canvasHeight,
      canvasWidth,
      excludedKey,
      geometry,
      guides: [...verticalSnapGuides],
      shapes,
    };
    return geometry;
  }, [verticalSnapGuides]);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    const handleCompositionStart = () => {
      textCompositionRef.current = true;
    };
    const handleCompositionEnd = () => {
      textCompositionRef.current = false;
    };

    window.addEventListener("compositionstart", handleCompositionStart);
    window.addEventListener("compositionend", handleCompositionEnd);
    return () => {
      window.removeEventListener("compositionstart", handleCompositionStart);
      window.removeEventListener("compositionend", handleCompositionEnd);
    };
  }, []);

  useEffect(() => {
    shapesRef.current = shapes;
  }, [shapes]);

  useEffect(() => {
    const next = materializeMissingGraphOwnedTextLabels(
      shapesRef.current,
      createOverlayShapeId,
      { width: canvasWidthRef.current, height: canvasHeightRef.current },
    );
    if (next === shapesRef.current) {
      return;
    }

    shapesRef.current = next;
    setShapes(next);
  }, [shapes]);

  useEffect(() => {
    assetsRef.current = assets;
  }, [assets]);

  useEffect(() => {
    selectedIdsRef.current = selectedIds;
  }, [selectedIds]);

  useEffect(() => {
    focusedGroupIdRef.current = focusedGroupId;
  }, [focusedGroupId]);

  useEffect(() => {
    if (!focusedGroupId || getGroupShape(shapes, focusedGroupId)) {
      return;
    }
    const timeoutId = window.setTimeout(() => setFocusedGroupId(null), 0);
    return () => window.clearTimeout(timeoutId);
  }, [focusedGroupId, shapes]);

  const transitionMode = useCallback((action: OverlayInteractionAction) => {
    // Single choke point: every interaction-mode transition that would start
    // editing a shape (move/resize/rotate/anchor-drag/point-edit/image-crop/
    // text-edit/graph-edit/table-edit/origin-or-fill-pick) goes through here,
    // so gating it here is enough to
    // reject all of them for a policy-locked shape at once. This is a UX layer
    // only; the existing conflict machinery remains the safety net.
    if (isOverlayActionBlockedByEditPolicy(action, shapesRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }
    modeRef.current = overlayInteractionModeReducer(modeRef.current, action);
    dispatchMode(action);
  }, [notifyEditPolicyBlocked]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const { id: modeStatusId, labelId: modeStatusLabelId } = getModeStatus(mode, selectedIds.length);
  useEffect(() => {
    onModeStatusChange?.({ id: modeStatusId, labelId: modeStatusLabelId });
  }, [modeStatusId, modeStatusLabelId, onModeStatusChange]);

  useEffect(() => {
    onActiveToolChange?.(mode.tool);
  }, [mode.tool, onActiveToolChange]);

  const emitOverlayChange = useCallback((options: OverlayChangeOptions = {}) => {
    const reanchored = syncBlockAnchors
      ? normalizeOverlayGroups(reanchorShapesAgainstCanvas(
          shapesRef.current,
          canvasRef.current,
          canvasHeightRef.current,
          canvasWidthRef.current,
          getBlockAnchorScope(),
        ))
      : normalizeOverlayGroups(shapesRef.current);
    // Refresh chart snapshots at the single point every edit funnels through, rather than hooking
    // each path that can change or delete a table. Copy-on-write: an unchanged document keeps its
    // array identity and no save is queued.
    const synced = syncChartDataSnapshots(reanchored);
    if (synced !== shapesRef.current) {
      shapesRef.current = synced;
      suppressNextSaveRef.current = true;
      setShapes(synced);
    }

    const snapshot: OverlaySnapshot = {
      version: 1,
      shapes: shapesRef.current,
      assets: assetsRef.current,
      ...(extensionsRef.current ? { extensions: extensionsRef.current } : {}),
    };
    lastEmittedSnapshotRef.current = snapshot;
    onChangeRef.current(
      {
        overlaySnapshot: snapshot,
        // Preview/print SVG is derived from the snapshot on demand. Generating it
        // during every canvas edit makes shape insertion feel sticky on larger docs.
        updatedAt: new Date().toISOString(),
      },
      {
        history: options.history ?? "record",
        ...(options.historyGroup ? { historyGroup: options.historyGroup } : {}),
      },
    );
    imageCropDirtyRef.current = false;
  }, [getBlockAnchorScope, syncBlockAnchors]);

  const clearQueuedOverlaySave = useCallback(() => {
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = undefined;
    }
    pendingOverlayHistoryRef.current = null;
    pendingOverlaySaveHistoryGroupRef.current = null;
  }, []);

  const flushOverlayChange = useCallback(() => {
    // Nothing queued means the document already holds this overlay. Emitting anyway would stamp a
    // fresh `updatedAt` onto an unchanged snapshot, which the shell cannot tell from a real edit:
    // it would record an undo step and mark the document dirty for a flush that changed nothing.
    if (saveTimeoutRef.current === undefined && !imageCropDirtyRef.current) {
      return;
    }
    const pending = pendingOverlayHistoryRef.current;
    clearQueuedOverlaySave();
    emitOverlayChange({
      history: pending?.history ?? "record",
      ...(pending?.historyGroup ? { historyGroup: pending.historyGroup } : {}),
    });
  }, [clearQueuedOverlaySave, emitOverlayChange]);

  const commitOverlayChangeNow = useCallback((options: OverlayChangeOptions = {}) => {
    const merged = mergePendingOverlaySave(pendingOverlayHistoryRef.current, options);
    clearQueuedOverlaySave();
    emitOverlayChange({
      history: merged.history,
      ...(merged.historyGroup ? { historyGroup: merged.historyGroup } : {}),
    });
  }, [clearQueuedOverlaySave, emitOverlayChange]);

  const queueOverlaySave = useCallback((options: OverlayChangeOptions = {}) => {
    pendingOverlayHistoryRef.current = mergePendingOverlaySave(pendingOverlayHistoryRef.current, options);
    if (saveTimeoutRef.current) {
      window.clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = window.setTimeout(() => {
      saveTimeoutRef.current = undefined;
      const pending = pendingOverlayHistoryRef.current;
      pendingOverlayHistoryRef.current = null;
      emitOverlayChange({
        history: pending?.history ?? "record",
        ...(pending?.historyGroup ? { historyGroup: pending.historyGroup } : {}),
      });
    }, 250);
  }, [emitOverlayChange]);

  const queueDirtyImageCropSave = useCallback(() => {
    if (imageCropDirtyRef.current) {
      queueOverlaySave();
    }
  }, [queueOverlaySave]);

  const syncAnchoredShapesToRects = useCallback((
    rects: ReadonlyMap<string, MeasuredBlock>,
    orderedBlocks: MeasuredBlock[] = Array.from(rects.values()),
  ): boolean => {
    if (rects.size === 0 || isInteractionMode(modeRef.current)) {
      return false;
    }

    const currentShapes = shapesRef.current;
    const anchored = normalizeOverlayGroups(attachUnanchoredShapesToMeasuredBlocks(
      currentShapes,
      orderedBlocks,
    ));
    const currentShapeById = new Map(currentShapes.map((shape) => [shape.id, shape]));
    const anchorsChanged = anchored.some((shape) => (
      !areOverlayAnchorsEqual(currentShapeById.get(shape.id)?.anchor, shape.anchor)
    ));
    const resolved = normalizeOverlayGroups(resolveShapesPosition(
      anchored,
      rects,
      calculateReserveSpaceGaps(anchored),
    ));
    let changed = resolved.length !== currentShapes.length;
    for (let index = 0; !changed && index < resolved.length; index += 1) {
      if (resolved[index] !== currentShapes[index]) {
        changed = true;
      }
    }
    if (!changed) {
      return false;
    }

    shapesRef.current = resolved;
    if (anchorsChanged) {
      // An AI/imported shape may arrive without an anchor. Once body blocks are
      // measurable, persist the inferred block anchor without adding a separate
      // undo step. The shape coordinates remain unchanged.
      explicitlySavedShapeStatesRef.current.add(resolved);
      queueOverlaySave({ history: "coalesce" });
    } else {
      suppressNextSaveRef.current = true;
    }
    setShapes(resolved);
    return true;
  }, [queueOverlaySave]);
  useDocumentSnapshotSync({
    setPreview,
    clearQueuedOverlaySave,
    imageCropDirtyRef,
    suppressNextSaveRef,
    modeRef,
    selectedIdsRef,
    shapesRef,
    assetsRef,
    extensionsRef,
    setShapes,
    setAssets,
    setSelectedIds,
    setAppliedSnapshotRevision,
    transitionMode,
    activeTextEditorRef,
    overlay,
    reconciledDocumentSnapshotRef,
    lastEmittedSnapshotRef,
    saveTimeoutRef,
    pendingOverlayHistoryRef,
    externalRevisionRef,
    externalRevision,
    seenDocumentSnapshotRef,
    mode,
  });


  useEffect(() => {
    if (!mountedRef.current) {
      mountedRef.current = true;
      return;
    }

    // 混在ペースト / 混在カットが置いていったコアレスキーを読み切る。**ガードより先に**
    // 読んで必ず消す — 下の早期 return に取り残すと、次の無関係な図形編集がそのキーを
    // 継承し、その編集だけを戻せなくなる。
    const historyGroup = pendingOverlaySaveHistoryGroupRef.current;
    pendingOverlaySaveHistoryGroupRef.current = null;

    if (explicitlySavedShapeStatesRef.current.delete(shapes)) {
      return;
    }

    if (suppressNextSaveRef.current) {
      suppressNextSaveRef.current = false;
      return;
    }

    if (historyGroup) {
      // 混在クリップボード操作は離散イベントなので 250ms 待つ理由が無い。むしろ待つと
      // **窓の後ろ側を縛るものが無く**、続けて起きた無関係な図形編集まで同じ undo
      // エントリへ畳まれてしまう。ここで確定させれば窓が操作そのものに閉じる
      // (直前から pending だったキー無しの保存は一緒に畳まれる — それは意図どおり)。
      commitOverlayChangeNow({ historyGroup });
      return;
    }

    queueOverlaySave();
  }, [assets, commitOverlayChangeNow, queueOverlaySave, shapes]);

  // On entering overlay editing, re-derive anchored shapes' y from the current
  // block layout so figures sit where the text now flows (text may have reflowed
  // while the overlay was shown as a preview). Existing anchors are only a
  // display refresh; omitted anchors are persisted as a coalesced repair.
  useLayoutEffect(() => {
    if (!syncBlockAnchors) {
      return;
    }
    const el = canvasRef.current;
    if (!el) {
      return;
    }
    const scope = getBlockAnchorScope();
    if (!scope) {
      return;
    }
    const { rects, ordered } = measureBlockTops(el, scope, canvasHeightRef.current, canvasWidthRef.current);
    if (rects.size === 0) {
      return;
    }

    syncAnchoredShapesToRects(rects, ordered);
  }, [getBlockAnchorScope, syncAnchoredShapesToRects, syncBlockAnchors]);

  useEffect(() => {
    window.addEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flushOverlayChange);
    return () => window.removeEventListener(FLUSH_OVERLAY_CHANGES_EVENT, flushOverlayChange);
  }, [flushOverlayChange]);

  useEffect(() => () => {
    if (saveTimeoutRef.current !== undefined || imageCropDirtyRef.current) {
      flushOverlayChange();
    }
  }, [flushOverlayChange]);

  const setSelectedShapeIds = useCallback((ids: OverlayShapeId[]) => {
    const uniqueIds = orderShapeIdsByVisualStackOrder(shapesRef.current, [...new Set(ids)]);
    if (sameOverlayShapeIds(selectedIdsRef.current, uniqueIds)) {
      return;
    }
    selectedIdsRef.current = uniqueIds;
    setSelectedIds(uniqueIds);
    onSelectedCountChange?.(uniqueIds.length);
  }, [onSelectedCountChange]);

  const selectKnownShape = useCallback((shape: OverlayShape, options: { editing?: boolean } = {}) => {
    const nextIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
    setSelectedShapeIds(nextIds);
    if (options.editing && isOverlayRichTextShape(shape) && nextIds.length === 1 && nextIds[0] === shape.id) {
      transitionMode({ type: "editText", shapeId: shape.id });
    } else if (
      (
        modeRef.current.id !== "overlay.originPicking" &&
        modeRef.current.id !== "overlay.graphFillPicking"
      ) ||
      shape.type !== "graph2dShape"
    ) {
      transitionMode({ type: "select" });
    }
  }, [setSelectedShapeIds, transitionMode]);

  const selectShape = useCallback((id: OverlayShapeId) => {
    const shape = shapesRef.current.find((item) => item.id === id);
    if (shape) {
      selectKnownShape(shape);
      return;
    }

    setSelectedShapeIds([id]);
    transitionMode({ type: "select" });
  }, [selectKnownShape, setSelectedShapeIds, transitionMode]);

  const toggleShapeSelection = useCallback((ids: OverlayShapeId[]) => {
    activeTextEditorRef.current?.commands.blur();
    transitionMode({ type: "select" });
    setSelectedShapeIds(toggleOverlayShapeSelectionIds(selectedIdsRef.current, ids));
  }, [setSelectedShapeIds, transitionMode]);

  const updateShape = useCallback((
    patch: OverlayShapePatch,
    options?: { commit?: boolean; history?: OverlayChangeHistory },
  ) => {
    const previousShape = shapesRef.current.find((shape) => (
      shape.id === patch.id && shape.type === patch.type
    ));
    let next = normalizeOverlayGroups(patchShape(shapesRef.current, patch));
    const patchedShape = next.find((shape) => (
      shape.id === patch.id && shape.type === patch.type
    ));
    if (
      previousShape &&
      patchedShape &&
      (previousShape.type === "text" || previousShape.type === "callout") &&
      patchedShape.type === previousShape.type &&
      getShapeRotation(patchedShape) !== 0 &&
      patch.x === undefined &&
      patch.y === undefined
    ) {
      const previousBounds = getShapeBounds(previousShape);
      const patchedBounds = getShapeBounds(patchedShape);
      if (previousBounds.w !== patchedBounds.w || previousBounds.h !== patchedBounds.h) {
        // Typing, the measured-height write-back, font size and size presets all reach this funnel.
        // Correcting here keeps one resize rule for every content-derived box change, while
        // explicit drag/handle patches stay authoritative because they carry x/y themselves.
        next = normalizeOverlayGroups(upsertShape(
          next,
          preserveRotatedTextResizeTopLeft(previousShape, patchedShape),
        ));
      }
    }
    if (sameOverlayShapeReferences(shapesRef.current, next)) {
      return;
    }

    if (options?.commit) {
      shapesRef.current = next;
      explicitlySavedShapeStatesRef.current.add(next);
      setShapes(next);
      commitOverlayChangeNow({ history: options.history });
      return;
    }

    shapesRef.current = next;
    if (options?.history) {
      explicitlySavedShapeStatesRef.current.add(next);
    }
    setShapes(next);
    if (options?.history) {
      queueOverlaySave({ history: options.history });
    }
  }, [commitOverlayChangeNow, queueOverlaySave]);

  const updateGraphShapeSpec = useCallback((
    shapeId: OverlayShapeId,
    spec: Graph2DSpec,
    patch: Partial<Pick<OverlayGraphShape, "x" | "y">> = {},
    options: { preserveGraphOwnedLabelPositions?: boolean } = {},
  ) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === GRAPH_SHAPE_TYPE
      ));
      if (!graphShape) {
        return current;
      }

      const nextSize = getGraphShapeSizeForSpec(graphShape, spec);
      const nextGraph: OverlayGraphShape = {
        ...graphShape,
        ...patch,
        props: {
          ...graphShape.props,
          spec,
          boundsMode: "plot",
          w: nextSize.w,
          h: nextSize.h,
        },
      };
      const anchoredNextGraph =
        patch.x !== undefined || patch.y !== undefined
          ? syncMovedOverlayShapeAnchor(nextGraph, graphShape, current, anchorMeasurementsRef.current.rects)
          : nextGraph;
      const nextBeforeAxisSync = current.map((shape) => (shape.id === shapeId ? anchoredNextGraph : shape));
      const next = syncGraphOwnedLabelTextShapePositions(nextBeforeAxisSync, anchoredNextGraph, {
        preserveExistingPositions: options.preserveGraphOwnedLabelPositions === true,
      });
      shapesRef.current = next;
      return next;
    });
  }, []);

  const replaceShape = useCallback((shape: OverlayShape) => {
    setShapes((current) => {
      const next = normalizeOverlayGroups(upsertShape(current, shape));
      shapesRef.current = next;
      return next;
    });
  }, []);

  const getEditableImageShape = useCallback((shapeId: OverlayShapeId) => {
    const shape = shapesRef.current.find((item): item is Extract<OverlayShape, { type: "image" }> => (
      item.id === shapeId && item.type === "image"
    ));
    if (!shape || isShapeLockedInTree(shapesRef.current, shape)) {
      return null;
    }
    if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return null;
    }
    return shape;
  }, [notifyEditPolicyBlocked]);

  const startImageCrop = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    setSelectedShapeIds([shape.id]);
    transitionMode({ type: "editImageCrop", shapeId: shape.id });
  }, [getEditableImageShape, setSelectedShapeIds, transitionMode]);

  const requestImageReplacement = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    imageReplacementShapeIdRef.current = shape.id;
    if (imageReplacementInputRef.current) {
      imageReplacementInputRef.current.value = "";
      imageReplacementInputRef.current.click();
    }
  }, [getEditableImageShape]);

  const handleImageReplacementChange = useCallback(async (event: ReactChangeEvent<HTMLInputElement>) => {
    const shapeId = imageReplacementShapeIdRef.current;
    const file = getSupportedOverlayImageFiles(event.currentTarget.files)[0];
    event.currentTarget.value = "";
    imageReplacementShapeIdRef.current = null;
    if (!shapeId || !file) {
      return;
    }

    try {
      const asset = await createOverlayImageAsset(file);
      const shape = getEditableImageShape(shapeId);
      if (!shape) {
        return;
      }
      const next = replaceOverlayImageAsset(shapesRef.current, assetsRef.current, shape.id, asset);
      shapesRef.current = normalizeOverlayGroups(next.shapes);
      assetsRef.current = next.assets;
      setShapes(shapesRef.current);
      setAssets(next.assets);
      setSelectedShapeIds([shape.id]);
      transitionMode({ type: "select" });
      queueOverlaySave();
    } catch {
      return;
    }
  }, [getEditableImageShape, queueOverlaySave, setSelectedShapeIds, transitionMode]);

  const resetImageCrop = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    const nextShape = resetOverlayImageCrop(shape);
    if (nextShape === shape) {
      return;
    }
    replaceShape(nextShape);
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [getEditableImageShape, queueOverlaySave, replaceShape, transitionMode]);

  const restoreImageNaturalSize = useCallback((shapeId: OverlayShapeId) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    const nextShape = resizeOverlayImageToNaturalSize(
      shape,
      assetsRef.current[shape.props.assetId],
      imageInsertAreaRef.current,
    );
    if (nextShape === shape) {
      return;
    }
    replaceShape(nextShape);
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [getEditableImageShape, queueOverlaySave, replaceShape, transitionMode]);

  const setImageOpacity = useCallback((shapeId: OverlayShapeId, opacity: number) => {
    const shape = getEditableImageShape(shapeId);
    if (!shape) {
      return;
    }
    updateShape({
      id: shape.id,
      type: "image",
      opacity: clamp(opacity, 0, 1),
    });
  }, [getEditableImageShape, updateShape]);

  const createShapeFromInsertDrag = useCallback((
    tool: InsertTool,
    start: OverlayPoint,
    end: OverlayPoint,
    points?: OverlayPoint[],
    closed = false,
  ): OverlayShapeId | null => {
    const resolvedTool = tool.command === "callout" && tool.calloutRadius === undefined
      ? { ...tool, calloutRadius: lastCalloutCornerRadiusRef.current }
      : tool;
    const baseShape = buildInsertShape(
      resolvedTool,
      start,
      end,
      createOverlayShapeId(),
      points,
      closed,
      pickStyleDefaultsForInsert(resolvedTool.command, readRememberedShapeStyle()),
    );
    if (!baseShape) {
      return null;
    }
    // Nothing is learned here on purpose. The shape that comes back also carries the builder's own
    // fallbacks (a sector's shading, an arrow's head), and storing those would turn one shape's
    // design into every later shape's default. Only a toolbar change is a choice.
    if (baseShape.type === "callout") {
      lastCalloutCornerRadiusRef.current = baseShape.props.radius;
      rememberCalloutCornerRadius(baseShape.props.radius);
    }
    const activeGroupId = focusedGroupIdRef.current && getGroupShape(shapesRef.current, focusedGroupIdRef.current)
      ? focusedGroupIdRef.current
      : null;
    const withActiveParent = <T extends OverlayShape>(nextShape: T): T => (
      activeGroupId ? { ...nextShape, parentId: activeGroupId } as T : nextShape
    );
    const shape = withActiveParent(baseShape);

    const labelShapeEntries = shape.type === "graph2dShape"
      ? createGraphFormulaLabelShapeEntries(shape, createOverlayShapeId, {
        width: canvasWidthRef.current,
        height: canvasHeightRef.current,
      })
      : [];
    const pointLabelShapeEntries = shape.type === "graph2dShape"
      ? createGraphPointLabelShapeEntries(shape, createOverlayShapeId)
      : [];
    const annotationLabelShapeEntries = shape.type === "graph2dShape"
      ? createGraphAnnotationLabelShapeEntries(shape, createOverlayShapeId)
      : [];
    const labelShapes = [
      ...labelShapeEntries,
      ...pointLabelShapeEntries,
      ...annotationLabelShapeEntries,
    ].map((entry) => withActiveParent(entry.shape));
    let insertedShape = shape;
    if (insertedShape.type === "graph2dShape" && labelShapeEntries.length > 0) {
      insertedShape = withGraphLabelTextShapeIds(insertedShape, Object.fromEntries(
        labelShapeEntries.map((entry) => [entry.curveId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape" && pointLabelShapeEntries.length > 0) {
      insertedShape = withGraphPointLabelTextShapeIds(insertedShape, Object.fromEntries(
        pointLabelShapeEntries.map((entry) => [entry.pointId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape" && annotationLabelShapeEntries.length > 0) {
      insertedShape = withGraphAnnotationLabelTextShapeIds(insertedShape, Object.fromEntries(
        annotationLabelShapeEntries.map((entry) => [entry.annotationId, entry.shape.id]),
      ));
    }
    if (insertedShape.type === "graph2dShape") {
      insertedShape = clearMaterializedGraphLabelTexts(insertedShape);
    }

    let nextShapes = upsertShape(shapesRef.current, insertedShape);
    for (const labelShape of labelShapes) {
      nextShapes = upsertShape(nextShapes, labelShape);
    }
    nextShapes = normalizeOverlayGroups(nextShapes);
    shapesRef.current = nextShapes;
    if (isOverlayRichTextShape(insertedShape)) {
      suppressNextSaveRef.current = true;
    }
    setShapes(nextShapes);
    selectKnownShape(insertedShape, { editing: isOverlayRichTextShape(insertedShape) });
    if (isOverlayRichTextShape(insertedShape)) {
      commitOverlayChangeNow();
    } else {
      queueOverlaySave();
    }
    return insertedShape.id;
  }, [commitOverlayChangeNow, queueOverlaySave, selectKnownShape]);

  const insertedTableFocusRef = useRef<string | null>(null);

  const insertTableAtViewportCenter = useCallback((columnCount: number, rowCount: number) => {
    const table = createPlainTableSpec(rowCount, columnCount);
    const tableWidth = Math.max(120, columnCount * DEFAULT_TABLE_COLUMN_WIDTH);
    const tableHeight = Math.max(72, rowCount * DEFAULT_TABLE_ROW_HEIGHT);
    const canvasRect = canvasRef.current?.getBoundingClientRect();
    const fallbackPoint = {
      x: canvasWidthRef.current * 0.5,
      y: Math.min(canvasHeightRef.current * 0.5, DEFAULT_TABLE_HEIGHT * 2),
    };
    const viewportRect = canvasRef.current?.closest<HTMLElement>(".whiteboard-page-canvas")?.getBoundingClientRect();
    const visibleCenter = viewportRect
      ? { x: viewportRect.left + viewportRect.width * 0.5, y: viewportRect.top + viewportRect.height * 0.5 }
      : { x: window.innerWidth * 0.5, y: window.innerHeight * 0.5 };
    const centerPoint = canvasRect && canvasRect.width > 0 && canvasRect.height > 0
      ? {
          x: ((clamp(visibleCenter.x, canvasRect.left, canvasRect.right) - canvasRect.left) / canvasRect.width) * canvasWidthRef.current,
          y: ((clamp(visibleCenter.y, canvasRect.top, canvasRect.bottom) - canvasRect.top) / canvasRect.height) * canvasHeightRef.current,
        }
      : fallbackPoint;
    const x = clamp(centerPoint.x - tableWidth * 0.5, 0, Math.max(0, canvasWidthRef.current - tableWidth));
    const y = clamp(centerPoint.y - tableHeight * 0.5, 0, Math.max(0, canvasHeightRef.current - tableHeight));

    const shapeId = createShapeFromInsertDrag(
      {
        kind: "insert",
        command: "table",
        table,
        tableSize: { w: tableWidth, h: tableHeight },
      },
      { x, y },
      { x: x + tableWidth, y: y + tableHeight },
    );
    if (shapeId) {
      insertedTableFocusRef.current = shapeId;
      transitionMode({ type: "editTable", shapeId });
    }
    setTableInsertPicker(null);
  }, [createShapeFromInsertDrag, transitionMode]);

  useEffect(() => {
    const shapeId = insertedTableFocusRef.current;
    if (!shapeId || tableInsertPicker || mode.id !== "overlay.tableEditing" || mode.shapeId !== shapeId) return;
    const frame = requestAnimationFrame(() => {
      const cell = canvasRef.current?.querySelector<HTMLElement>(
        `[data-overlay-shape-id="${CSS.escape(shapeId)}"] [contenteditable="true"]`,
      );
      cell?.focus({ preventScroll: true });
      insertedTableFocusRef.current = null;
    });
    return () => cancelAnimationFrame(frame);
  }, [mode, tableInsertPicker]);

  /**
   * Creates a chart from an existing table and selects it.
   *
   * The chart is placed directly beneath the table and clamped into the canvas. It carries **no
   * anchor of its own** — only x/y — because `emitOverlayChange` re-anchors against the canvas on
   * the way out. Writing an anchor here as well is the "x/y and anchor offset held twice" trap:
   * one of the two silently wins on the next save and the shape jumps back.
   */
  const createChartFromTable = useCallback((tableShapeId: OverlayShapeId) => {
    const tableShape = shapesRef.current.find((shape) => shape.id === tableShapeId);
    if (tableShape?.type !== "tableShape") {
      return;
    }
    const bounds = getChartBoundsForTable({
      x: tableShape.x,
      y: tableShape.y,
      w: tableShape.props.w,
      h: tableShape.props.h,
    });
    const x = clamp(bounds.x, 0, Math.max(0, canvasWidthRef.current - bounds.w));
    const y = clamp(bounds.y, 0, Math.max(0, canvasHeightRef.current - bounds.h));
    const props = createChartShapeProps(
      tableShape.props.table,
      tableShapeId,
      bounds.w,
      bounds.h,
    );

    const shapeId = createShapeFromInsertDrag(
      {
        kind: "insert",
        command: "chart",
        chart: {
          sourceTableShapeId: tableShapeId,
          spec: props.spec,
          dataSnapshot: props.dataSnapshot,
        },
      },
      { x, y },
      { x: x + bounds.w, y: y + bounds.h },
    );
    if (shapeId) {
      // Selected, not opened for editing: a chart is configured from its floating panel, and the
      // author's next move is normally to place it rather than to change its settings.
      setSelectedShapeIds([shapeId]);
    }
  }, [createShapeFromInsertDrag, setSelectedShapeIds]);

  const finishCurveDrawing = useCallback((tool: InsertTool, points: OverlayPoint[], closed = false) => {
    const finalPoints = removeNearDuplicateDrawingPoints(points, 2);
    if (finalPoints.length < (tool.command === "threePointArc" ? 3 : 2)) {
      return false;
    }

    const start = finalPoints[0];
    const end = finalPoints[finalPoints.length - 1];
    const shapeId = createShapeFromInsertDrag(tool, start, end, finalPoints, closed);
    if (!shapeId) {
      return false;
    }
    transitionMode({ type: "setTool", tool: { kind: "select" } });
    clearSnapGuides();
    return true;
  }, [clearSnapGuides, createShapeFromInsertDrag, transitionMode]);

  const handleCommandRequest = useCallback((request: OverlayCommandRequest) => {
    if (handledCommandRequestIdRef.current === request.id) {
      return;
    }

    if (request.command === "select") {
      transitionMode({ type: "setTool", tool: { kind: "select" } });
    } else if (request.command === "table") {
      activeTextEditorRef.current?.commands.blur();
      transitionMode({ type: "setTool", tool: { kind: "select" } });
      setTableInsertPicker({ requestId: request.id, anchorRect: request.anchorRect });
    } else {
      transitionMode({
        type: "setTool",
        tool: {
          kind: "insert",
          command: request.command,
          graphPreset: request.graphPreset,
          graph3dPreset: request.graph3dPreset,
          ...(request.command === "callout" ? { calloutRadius: lastCalloutCornerRadiusRef.current } : {}),
        },
      });
    }

    handledCommandRequestIdRef.current = request.id;
    onCommandHandled(request.id);
  }, [onCommandHandled, transitionMode]);

  useEffect(() => {
    if (commandRequest) {
      const timeoutId = window.setTimeout(() => handleCommandRequest(commandRequest), 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [commandRequest, handleCommandRequest]);

  const handleImageRequest = useCallback((request: OverlayImageRequest) => {
    imageImportSessionRef.current ??= createOverlayImageImportSession();
    return imageImportSessionRef.current.handle(request, {
      areaSize: { w: imageInsertAreaWidth, h: imageInsertAreaHeight },
      gap: IMAGE_INSERT_GAP,
      decodeFile: createOverlayImageEntry,
      getPlacement: () => ({
        canvasWidth: canvasWidthRef.current,
        canvasHeight: canvasHeightRef.current,
        parentId: focusedGroupIdRef.current && getGroupShape(shapesRef.current, focusedGroupIdRef.current)
          ? focusedGroupIdRef.current
          : undefined,
      }),
      insert: (nextShapes, nextAssets) => {
        setAssets((current) => {
          const next = { ...current, ...nextAssets };
          assetsRef.current = next;
          return next;
        });
        setShapes((current) => {
          const next = normalizeOverlayGroups([...current, ...nextShapes]);
          shapesRef.current = next;
          return next;
        });
        setSelectedShapeIds(nextShapes.map((shape) => shape.id));
        transitionMode({ type: "select" });
        queueOverlaySave();
      },
      onHandled: onImageHandled,
    });
  }, [imageInsertAreaHeight, imageInsertAreaWidth, onImageHandled, queueOverlaySave, setSelectedShapeIds, transitionMode]);

  useEffect(() => {
    if (imageRequest) {
      void handleImageRequest(imageRequest);
    }
  }, [handleImageRequest, imageRequest]);

  const pagePointFromClient = useCallback((
    clientX: number,
    clientY: number,
    cachedRect?: { left: number; top: number; width: number; height: number } | null,
  ): OverlayPoint => {
    const rect = cachedRect ?? canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) {
      return { x: clientX, y: clientY };
    }
    if (!cachedRect) {
      dragCanvasRectRef.current = {
        left: rect.left,
        top: rect.top,
        width: rect.width,
        height: rect.height,
      };
    }

    return {
      x: ((clientX - rect.left) / rect.width) * canvasWidthRef.current,
      y: ((clientY - rect.top) / rect.height) * canvasHeightRef.current,
    };
  }, []);

  /** `pagePointFromClient` の逆。押下位置を覚えたまま本文へ渡すときに使う。 */
  const clientPointFromPage = useCallback((point: OverlayPoint): { x: number; y: number } => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || canvasWidthRef.current <= 0 || canvasHeightRef.current <= 0) {
      return { x: point.x, y: point.y };
    }

    return {
      x: rect.left + (point.x / canvasWidthRef.current) * rect.width,
      y: rect.top + (point.y / canvasHeightRef.current) * rect.height,
    };
  }, []);

  const focusOverlayCanvas = useCallback(() => {
    focusOverlaySurface(bleedSurfaceRef.current);
  }, []);

  const refreshAnchorMeasurements = useCallback((): AnchorMeasurements => {
    const el = canvasRef.current;
    if (!el) {
      return anchorMeasurementsRef.current;
    }

    const scope = getBlockAnchorScope();
    if (!scope) {
      return anchorMeasurementsRef.current;
    }
    // 操作中は `syncAnchoredShapesToRects` が同じ条件で何もせずに降りる。ここで降りずに
    // `anchorMeasurementKeyRef` だけ進めてしまうと、その世代は「もう反映済み」と見なされて
    // **二度と適用されない** (resize リスナーはこの関数を直接呼ぶので、ドラッグ中のリサイズで
    // 実際に起きる)。鍵を進めるのは、実際に反映するときだけにする。
    if (isInteractionMode(modeRef.current)) {
      return anchorMeasurementsRef.current;
    }
    // 本文側が測った結果が渡っていれば、それをそのまま使う。
    //
    // 以前はここで `measureBlockTops` を呼び、`PageCanvasEditor` が既に歩いた本文を
    // もう一度全件歩いていた (打鍵のたびに 2 周)。座標系は
    // `page-canvas/anchor-measure-parity.test.ts` で一致を固定してある:
    // `.page-flow` と `.overlay-canvas-editor` は同じ配置先の左上に載るので原点が同じで、
    // 倍率もどちらも「実寸 / ズーム」に戻す。
    //
    // 並びは `anchorable` (入れ子を含む) を使うこと。ページ送りの `ordered` とは集合が
    // 違い、混ぜるとリスト項目や枠の中のブロックに付いた図形が無言で追従しなくなる。
    const measured = bodyBlockRects && bodyAnchorableBlocks
      ? { rects: bodyBlockRects, ordered: [...bodyAnchorableBlocks] }
      : measureBlockTops(el, scope, canvasHeightRef.current, canvasWidthRef.current);
    const { rects, ordered } = measured;
    const key = anchorMeasurementKey(ordered);
    if (key === anchorMeasurementKeyRef.current) {
      return anchorMeasurementsRef.current;
    }

    const next = { rects, ordered };
    anchorMeasurementKeyRef.current = key;
    anchorMeasurementsRef.current = next;
    setAnchorMeasurements(next);
    // 並びは Map の挿入順に頼らず明示的に渡す。`measureBlockTops` は querySelectorAll の
    // 文書順で入れるが、`measureFlowBlocks` はユニット単位で入れる (ユニット外は最後) ため、
    // 既定値の `Array.from(rects.values())` では順序が変わる。
    syncAnchoredShapesToRects(rects, ordered);
    return next;
  }, [bodyAnchorableBlocks, bodyBlockRects, getBlockAnchorScope, syncAnchoredShapesToRects]);

  // 以前は deps 無し = 毎レンダーで本文を全件計測していた。実際に測り直す必要があるのは
  // 「本文の幾何が動いた」「オーバーレイ座標系の寸法が変わった」「計測範囲が差し替わった」時だけ。
  // `bodyBlockRects` の identity が本文側の変化を過不足なく表す (props のコメント参照)。
  // `interacting` を deps に入れるのが要点。これが無いと、操作中に届いた本文の新しい幾何は
  // 「effect は走ったが中で降りた」で終わり、操作が終わっても props が再び変わるまで
  // 二度と適用されない (deps 無しだった頃は次のレンダーが必ず拾い直していた)。
  const interacting = isInteractionMode(mode);
  useLayoutEffect(() => {
    if (interacting) {
      return;
    }
    refreshAnchorMeasurements();
  }, [
    interacting,
    bodyBlockRects,
    canvasHeight,
    canvasWidth,
    blockAnchorScopeElement,
    refreshAnchorMeasurements,
  ]);

  // 計測結果が渡らない面 (running region の overlay・素材編集) は従来どおり毎レンダー測る。
  //
  // 上の effect は `bodyBlockRects` の identity を「本文が動いた」の合図に使っているが、
  // その props を渡さない呼び出し元では合図が永久に null のままになる。そこだけ以前の
  // 「毎レンダー」に戻さないと、フォント読み込みや画像読み込みでレイアウトが動いた時に
  // アンカーが無言で追従しなくなる。`anchorMeasurementKey` の早期 return があるので、
  // 何も動いていなければ計測しても state は差し替わらない。
  useLayoutEffect(() => {
    if (bodyBlockRects || isInteractionMode(modeRef.current)) {
      return;
    }
    refreshAnchorMeasurements();
  });

  useEffect(() => {
    window.addEventListener("resize", refreshAnchorMeasurements);
    return () => window.removeEventListener("resize", refreshAnchorMeasurements);
  }, [refreshAnchorMeasurements]);

  const getShapeAtPoint = useCallback((point: OverlayPoint, margin = 8): OverlayShape | undefined => {
    for (const shape of getRenderableShapesInReverseVisualStackOrder(shapesRef.current)) {
      if (hitTestShape(shape, point, margin)) {
        return shape;
      }
    }

    return undefined;
  }, []);

  const getOpenStrokeShapeAtPoint = useCallback((point: OverlayPoint): OverlayShape | undefined => {
    for (const shape of getRenderableShapesInReverseVisualStackOrder(shapesRef.current)) {
      if (!isOpenStrokeShape(shape)) {
        continue;
      }
      if (hitTestShape(shape, point, OPEN_STROKE_POINTER_HIT_MARGIN)) {
        return shape;
      }
    }

    return undefined;
  }, []);

  const duplicateSelectedShapes = useCallback((offset: OverlayPoint = { x: 20, y: 20 }): OverlayShape[] => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      // Whole-block guard (not a partial filter, unlike delete/align/
      // distribute/style below): duplicating "everything except the shape
      // another feature reserved" is a confusing partial outcome, so this rejects
      // the whole action instead, mirroring the text-flow lock's
      // filterTransaction semantics.
      notifyEditPolicyBlocked();
      return [];
    }
    const selectedShapes = getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current);
    if (selectedShapes.length === 0) {
      return [];
    }

    const pasted = cloneOverlayShapesForPaste(
      createOverlayClipboardPayload(selectedShapes, assetsRef.current),
      offset,
    );
    const nextShapes = normalizeOverlayGroups(fitShapesWithinPage(
      pasted.shapes.map(unlockVisibleShape),
      canvasWidthRef.current,
      canvasHeightRef.current,
    ));
    const nextShapeIdSet = new Set(nextShapes.map((shape) => shape.id));
    const nextSelectedIds = nextShapes
      .filter((shape) => !shape.parentId || !nextShapeIdSet.has(shape.parentId))
      .map((shape) => shape.id);

    setAssets((current) => {
      const next = { ...current, ...pasted.assets };
      assetsRef.current = next;
      return next;
    });
    setShapes((current) => {
      const next = normalizeOverlayGroups([...current, ...nextShapes]);
      shapesRef.current = next;
      return next;
    });
    setSelectedShapeIds(nextSelectedIds);
    transitionMode({ type: "select" });
    queueOverlaySave();
    return nextShapes;
  }, [notifyEditPolicyBlocked, queueOverlaySave, setSelectedShapeIds, transitionMode]);

  /**
   * いま削除される図形 id。`deleteSelectedShapes` と、その前に「本当に消えるのか」を
   * 知りたい呼び出し側 (混在カットのコアレスキー配り) で**同じ算出を共有する**。
   * 別々に書くと、ロック条件が変わったときに片方だけ古くなる。
   */
  const getRemovableSelectedShapeIds = useCallback((): string[] => {
    const selectedIdSet = new Set(getIdsWithDescendants(shapesRef.current, selectedIdsRef.current, { includeGroups: true }));
    const removableIdSet = new Set(shapesRef.current
      .filter((shape) => selectedIdSet.has(shape.id)
        && !isShapeLockedInTree(shapesRef.current, shape)
        && !isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current))
      .map((shape) => shape.id));
    for (const shape of shapesRef.current) {
      if (
        shape.type !== "graph2dShape" ||
        !selectedIdSet.has(shape.id) ||
        shape.locked ||
        isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)
      ) {
        continue;
      }

      for (const labelId of getExistingGraphLabelTextShapeIds(shape, shapesRef.current)) {
        const labelShape = shapesRef.current.find((item) => item.id === labelId);
        if (
          labelShape &&
          !labelShape.locked &&
          !isShapeEditPolicyLockedInTree(shapesRef.current, labelShape, editPolicyLockedShapeIdsRef.current)
        ) {
          removableIdSet.add(labelId);
        }
      }
    }

    return [...removableIdSet];
  }, []);

  const deleteSelectedShapes = useCallback(() => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
    }
    const removableIds = getRemovableSelectedShapeIds();
    if (removableIds.length === 0) {
      return;
    }

    const removableIdSet = new Set(removableIds);
    const next = pruneUnusedOverlayAssets({
      version: 1,
      shapes: normalizeOverlayGroups(removeShapes(shapesRef.current, removableIds)),
      assets: assetsRef.current,
      ...(extensionsRef.current ? { extensions: extensionsRef.current } : {}),
    });
    shapesRef.current = next.shapes;
    assetsRef.current = next.assets;
    explicitlySavedShapeStatesRef.current.add(next.shapes);
    setShapes(next.shapes);
    setAssets(next.assets);
    // Deletion is complete before deselection can unmount this canvas, and
    // before export/tab navigation can read the canonical document.
    const historyGroup = pendingOverlaySaveHistoryGroupRef.current;
    pendingOverlaySaveHistoryGroupRef.current = null;
    commitOverlayChangeNow(historyGroup ? { historyGroup } : {});
    setSelectedShapeIds(selectedIdsRef.current.filter((id) => !removableIdSet.has(id)));
    transitionMode({ type: "select" });
  }, [commitOverlayChangeNow, getRemovableSelectedShapeIds, notifyEditPolicyBlocked, setSelectedShapeIds, transitionMode]);

  const groupSelectedShapes = useCallback(() => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }
    const result = groupOverlayShapes(shapesRef.current, selectedIdsRef.current, createOverlayGroupId);
    shapesRef.current = result.shapes;
    setShapes(result.shapes);
    setSelectedShapeIds(result.selectedIds);
    transitionMode({ type: "select" });
  }, [notifyEditPolicyBlocked, setSelectedShapeIds, transitionMode]);

  const ungroupSelectedShapes = useCallback(() => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }
    const result = ungroupOverlayShapes(shapesRef.current, selectedIdsRef.current);
    shapesRef.current = result.shapes;
    setShapes(result.shapes);
    setSelectedShapeIds(result.selectedIds);
    transitionMode({ type: "select" });
  }, [notifyEditPolicyBlocked, setSelectedShapeIds, transitionMode]);

  const setSelectedShapesLocked = useCallback((locked: boolean) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }
    const idSet = new Set(selectedIdsRef.current);
    setShapes((current) => {
      const next = normalizeOverlayGroups(current.map((shape) => (
        idSet.has(shape.id) ? { ...shape, locked } as OverlayShape : shape
      )));
      shapesRef.current = next;
      return next;
    });
  }, [notifyEditPolicyBlocked]);

  const setSelectedShapesHidden = useCallback((hidden: boolean) => {
    const idSet = new Set(selectedIdsRef.current);
    setShapes((current) => {
      const next = normalizeOverlayGroups(current.map((shape) => (
        idSet.has(shape.id) ? { ...shape, hidden } as OverlayShape : shape
      )));
      shapesRef.current = next;
      return next;
    });
  }, []);

  const arrangeSelectedShapes = useCallback((action: OverlayArrangeAction) => {
    const selectedIds = selectedIdsRef.current;
    if (selectedIds.length === 0) {
      return;
    }
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIds, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }

    const ids = getUnlockedTransformShapes(
      shapesRef.current,
      selectedIds,
      editPolicyLockedShapeIdsRef.current,
    ).map((shape) => shape.id);
    if (ids.length === 0) {
      return;
    }

    const next = reorderShapes(shapesRef.current, ids, action);
    if (sameOverlayShapeReferences(shapesRef.current, next)) {
      return;
    }
    shapesRef.current = next;
    setShapes(next);
    setSelectedShapeIds(selectedIds);
  }, [notifyEditPolicyBlocked, setSelectedShapeIds]);

  const alignSelectedShapes = useCallback((action: OverlayAlignAction) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
    }
    const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current)
      .filter((shape) => !isShapeLockedInTree(shapesRef.current, shape)
        && !isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current));
    if (selectedShapes.length < 2) {
      return;
    }

    const transformed = alignShapes(selectedShapes, action);
    const movedIdSet = new Set(getIdsWithDescendants(
      shapesRef.current,
      selectedShapes.map((shape) => shape.id),
      { includeGroups: true },
    ));
    const { ordered } = refreshAnchorMeasurements();
    setShapes((current) => {
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        applySelectionUnitTransforms(current, selectedShapes, transformed),
        movedIdSet,
        ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [notifyEditPolicyBlocked, refreshAnchorMeasurements]);

  const distributeSelectedShapes = useCallback((axis: OverlayDistributeAxis) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
    }
    const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current)
      .filter((shape) => !isShapeLockedInTree(shapesRef.current, shape)
        && !isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current));
    if (selectedShapes.length < 3) {
      return;
    }

    const transformed = distributeShapes(selectedShapes, axis);
    const movedIdSet = new Set(getIdsWithDescendants(
      shapesRef.current,
      selectedShapes.map((shape) => shape.id),
      { includeGroups: true },
    ));
    const { ordered } = refreshAnchorMeasurements();
    setShapes((current) => {
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        applySelectionUnitTransforms(current, selectedShapes, transformed),
        movedIdSet,
        ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [notifyEditPolicyBlocked, refreshAnchorMeasurements]);

  const applyQuickTransformToSelectedShapes = useCallback((
    action: "rotateClockwise" | "rotateCounterclockwise" | OverlayFlipAxis,
  ) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
      return;
    }
    const selectedShapes = getUnlockedTransformShapes(
      shapesRef.current,
      selectedIdsRef.current,
      editPolicyLockedShapeIdsRef.current,
    );
    const center = getSelectionRotationPivot(selectedShapes, shapesRef.current);
    if (!center) {
      return;
    }

    const transformed = action === "rotateClockwise"
      ? rotateShapesAround(selectedShapes, center, Math.PI / 2)
      : action === "rotateCounterclockwise"
        ? rotateShapesAround(selectedShapes, center, -Math.PI / 2)
        : flipShapesAround(selectedShapes, center, action);
    const movedIdSet = new Set(transformed.map((shape) => shape.id));
    const { ordered } = refreshAnchorMeasurements();
    setShapes((current) => {
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        mergeShapesById(current, transformed),
        movedIdSet,
        ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [notifyEditPolicyBlocked, refreshAnchorMeasurements]);

  const applyStyleToSelectedShapes = useCallback((style: OverlaySelectionStylePatch) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
    }
    setShapes((current) => {
      const idSet = getStyleTargetIds(current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
      const next = normalizeOverlayGroups(current.map((shape) => (
        idSet.has(shape.id) ? applyStylePatchToShape(shape, style) : shape
      )));
      shapesRef.current = next;
      return next;
    });
  }, [notifyEditPolicyBlocked]);

  /**
   * Put a clipboard payload of shapes onto this canvas.
   *
   * Shared by the window `paste` listener (overlay already open) and the `pasteShapes` action the
   * shell fires when it is not (paste into another material tab), so both land identically.
   *
   * @returns whether anything was pasted.
   */
  const applyPastedOverlayShapes = useCallback((
    payload: Extract<EditorClipboardPayload, { kind: "overlayShapes" }>,
    options: { anchorBlockIdMap?: Record<string, string>; historyGroup?: string } = {},
  ): boolean => {
    const prepared = prepareOverlayShapesForPaste({
      payload,
      canvasWidth: canvasWidthRef.current,
      canvasHeight: canvasHeightRef.current,
      targetDocId: documentIdRef.current,
      anchorBlockIdMap: options.anchorBlockIdMap,
    });
    if (prepared.shapes.length === 0) {
      return false;
    }

    // 本文と一緒に貼り付けた図形は、付け替えた anchor (貼り付け先ブロック) の実測位置から x/y を
    // 導く。保存時の再アンカーは「位置が正、dy は位置から逆算」の向きなので、blockId だけ
    // 書き換えて元の座標のまま渡すと dy が逆算されて図形が元の場所に留まる。付け替えていない
    // 図形は通常の貼り付けオフセットのままにしたいので、rects は付け替え先ブロックに絞る。
    const remappedBlockIds = new Set(Object.values(options.anchorBlockIdMap ?? {}));
    let pastedShapes = prepared.shapes;
    if (remappedBlockIds.size > 0 && canvasRef.current) {
      const scope = getBlockAnchorScope();
      const { rects } = scope
        ? measureBlockTops(canvasRef.current, scope, canvasHeightRef.current, canvasWidthRef.current)
        : { rects: new Map<string, MeasuredBlock>() };
      const targetRects = new Map([...rects].filter(([blockId]) => remappedBlockIds.has(blockId)));
      if (targetRects.size > 0) {
        pastedShapes = normalizeOverlayGroups(resolveShapesPosition(
          pastedShapes,
          targetRects,
          calculateReserveSpaceGaps(pastedShapes),
        ));
      }
    }

    const nextAssets = { ...assetsRef.current, ...prepared.assets };
    const nextShapes = normalizeOverlayGroups([...shapesRef.current, ...pastedShapes]);
    assetsRef.current = nextAssets;
    shapesRef.current = nextShapes;
    explicitlySavedShapeStatesRef.current.add(nextShapes);
    setAssets(nextAssets);
    setShapes(nextShapes);
    // Selection reads shapesRef synchronously. A React updater may run after this
    // event, so updating that ref inside setShapes can discard the pasted ids.
    // Commit before selection/request completion can return to the static canvas.
    commitOverlayChangeNow(options.historyGroup ? { historyGroup: options.historyGroup } : {});
    setSelectedShapeIds(prepared.selectedIds);
    transitionMode({ type: "select" });
    return true;
  }, [commitOverlayChangeNow, getBlockAnchorScope, setSelectedShapeIds, transitionMode]);

  /**
   * 混在コピーの図形を「コピーした本文」を基準に付け替える。
   *
   * 貼り付け側が図形を貼り付け先へ置き直せるのは、図形のアンカーがコピー範囲のブロックを
   * 指しているときだけ (`anchorBlockIdMap` はコピーした slice のブロックしか持たない)。
   * 範囲の外のブロックにぶら下がった図形をそのまま渡すと、本文は貼り付け先に入るのに図形は
   * 元の段落の隣に出る — 「同じ相対位置で貼りたい」が崩れる典型がこれ。
   *
   * 範囲の中のブロックを指している図形も含めて全部引き直す。アンカーの dy と行アンカーは
   * 実測から作り直されるので、貼り付け先で解決したときの位置が「いま見えている位置」と
   * 一致する。指し先だけ差し替えて古い dy/行を持ち回すと、行アンカーの取り方の差だけ
   * (実測で 2〜3px) 貼り付け側がずれる。
   *
   * ここで渡すのは **コピー範囲のブロックだけ** に絞った計測なので、`pickBlockAnchor` は
   * その中から読み順で直前のブロックを選び、dy は実測から出す。位置 (x/y) は動かさない:
   * 貼り付け側が付け替え先ブロックの実測から x/y を導く (`applyPastedOverlayShapes`)。
   */
  const reanchorShapesToCopiedBlocks = useCallback((
    selectedShapes: OverlayShape[],
    slice: unknown,
  ): OverlayShape[] => {
    const copiedBlockIds = new Set(collectClipboardSliceBlockIds(slice));
    if (copiedBlockIds.size === 0) {
      return selectedShapes;
    }

    const { ordered } = refreshAnchorMeasurements();
    const copiedBlocks = ordered.filter((block) => copiedBlockIds.has(block.id));
    if (copiedBlocks.length === 0) {
      return selectedShapes;
    }

    // ページ固定 (絶対座標) の図形は `reanchorShapesByPosition` が意図的に触らない。
    // 文書の中ではそれが正しい (本文が動いても動かさない) が、クリップボードの中だけは話が
    // 別で、貼り付け先の本文を基準に置き直したい。アンカーを外して「行き先未定」にしてから
    // 引き直させる — 元の文書側は書き換えない (渡すのは複製した配列)。
    const selectedIds = new Set(selectedShapes.map((shape) => shape.id));
    const unpinned = shapesRef.current.map((shape) => (
      selectedIds.has(shape.id) ? withoutPageAnchor(shape) : shape
    ));

    return getSelectedShapesForClipboard(
      reanchorShapesByPosition(unpinned, selectedIds, copiedBlocks),
      selectedIdsRef.current,
    );
  }, [refreshAnchorMeasurements]);

  const handleActionRequest = useCallback((request: OverlayActionRequest) => {
    if (handledActionRequestIdRef.current === request.id) {
      return;
    }

    handledActionRequestIdRef.current = request.id;
    if (request.type === "duplicate") {
      duplicateSelectedShapes();
    } else if (request.type === "delete") {
      deleteSelectedShapes();
    } else if (request.type === "arrange") {
      arrangeSelectedShapes(request.action);
    } else if (request.type === "align") {
      alignSelectedShapes(request.action);
    } else if (request.type === "distribute") {
      distributeSelectedShapes(request.axis);
    } else if (request.type === "group") {
      groupSelectedShapes();
    } else if (request.type === "ungroup") {
      ungroupSelectedShapes();
    } else if (request.type === "toggleLock") {
      const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current);
      const locked = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeLockedInTree(shapesRef.current, shape));
      setSelectedShapesLocked(!locked);
    } else if (request.type === "toggleHidden") {
      const selectedShapes = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current);
      const hidden = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeHiddenInTree(shapesRef.current, shape));
      setSelectedShapesHidden(!hidden);
    } else if (request.type === "style") {
      setPreview(null);
      // Only when the change actually lands: with a locked selection the patch is dropped, and
      // reprogramming the next insertion from a click that visibly did nothing would be a surprise.
      if (getStyleTargetIds(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current).size > 0) {
        learnShapeStyleDefaults(mergeStyleDefaults(readRememberedShapeStyle(), request.style));
      }
      applyStyleToSelectedShapes(request.style);
    } else if (request.type === "pasteShapes") {
      applyPastedOverlayShapes(request.payload, {
        anchorBlockIdMap: request.anchorBlockIdMap,
        historyGroup: request.historyGroup,
      });
    } else if (request.type === "selectShapesForBlocks") {
      // フォーカスは本文に残したまま選択だけ立てる。`focusOverlayCanvas` を呼ぶと本文の
      // DOM 選択が消えて、混在選択が「図形だけ」に痩せる。
      setFocusedGroupId(null);
      // 矩形は「見た目が本文の選択に重なっている図形」を拾うため。計測が無い面
      // (running region など) では渡らず、アンカーだけの判定に落ちる。
      // 本文の全選択から来た要求だけは、アンカーも重なりも持たない図形 (余白の注記など) まで
      // 含めて「全部」にする。
      setSelectedShapeIds(request.allShapes
        ? getAllSelectableShapeIds(shapesRef.current)
        : getShapeIdsAnchoredToBlocks(
            shapesRef.current,
            request.blockIds,
            refreshAnchorMeasurements().rects,
          ));
      transitionMode({ type: "select" });
    } else if (request.type === "insertTextAtPoint") {
      activeTextEditorRef.current?.commands.blur();
      // No drag, so no width was asked for: an empty rect at the point lets the builder apply the
      // one default width. A box made this way and a box made by a click have to come out the same
      // size — a second size spelled out here would be a different answer to the same question.
      createShapeFromInsertDrag(
        { kind: "insert", command: "text" },
        request.point,
        request.point,
      );
    }

    onActionHandled(request.id);
  }, [
    alignSelectedShapes,
    applyPastedOverlayShapes,
    applyStyleToSelectedShapes,
    learnShapeStyleDefaults,
    refreshAnchorMeasurements,
    arrangeSelectedShapes,
    createShapeFromInsertDrag,
    deleteSelectedShapes,
    distributeSelectedShapes,
    duplicateSelectedShapes,
    groupSelectedShapes,
    onActionHandled,
    setSelectedShapeIds,
    setSelectedShapesHidden,
    setSelectedShapesLocked,
    transitionMode,
    ungroupSelectedShapes,
  ]);

  useEffect(() => {
    if (actionRequest) {
      const timeoutId = window.setTimeout(() => handleActionRequest(actionRequest), 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [actionRequest, handleActionRequest]);

  const handleSelectPointRequest = useCallback((request: OverlaySelectPointRequest) => {
    if (handledSelectPointRequestIdRef.current === request.id) {
      return;
    }

    handledSelectPointRequestIdRef.current = request.id;

    if (request.startMarquee) {
      focusOverlayCanvas();
      transitionMode({
        type: "startMarquee",
        start: request.point,
        additive: true,
        selectOnClick: true,
      });
      onSelectPointHandled(request.id, true);
      return;
    }

    const requestedShape = request.targetShapeId
      ? shapesRef.current.find((item) => (
          item.id === request.targetShapeId &&
          !isOverlayGroupShape(item) &&
          !isShapeHiddenInTree(shapesRef.current, item)
        ))
      : undefined;
    const shape = requestedShape ?? getShapeAtPoint(request.point, 8) ?? getOpenStrokeShapeAtPoint(request.point);

    if (shape) {
      activeTextEditorRef.current?.commands.blur();
      activeTextEditorRef.current = null;
      focusOverlayCanvas();

      if (request.dragEndPoint) {
        const dx = request.dragEndPoint.x - request.point.x;
        const dy = request.dragEndPoint.y - request.point.y;
        if (Math.hypot(dx, dy) >= 3) {
          const selectionIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
          const movingShapes = getUnlockedTransformShapes(shapesRef.current, selectionIds, editPolicyLockedShapeIdsRef.current);
          if (movingShapes.length > 0) {
            const movedIdSet = new Set(movingShapes.map((movingShape) => movingShape.id));
            const movedShapes = moveShapes(movingShapes, dx, dy);
            const { ordered } = refreshAnchorMeasurements();
            setSelectedShapeIds(selectionIds);
            setShapes((current) => {
              const next = normalizeOverlayGroups(reanchorShapesByPosition(mergeShapesById(current, movedShapes), movedIdSet, ordered));
              shapesRef.current = next;
              return next;
            });
            transitionMode({ type: "select" });
            onSelectPointHandled(request.id, true);
            queueOverlaySave();
            return;
          }
        }
      }

      transitionMode({ type: "select" });
      selectShape(shape.id);
      if (request.startCrop && shape.type === "graph2dShape") {
        transitionMode({ type: "editGraph", shapeId: shape.id });
      } else if (request.startCrop && isOverlayRichTextShape(shape)) {
        transitionMode({ type: "editText", shapeId: shape.id });
      } else if (request.startCrop && shape.type === "tableShape") {
        transitionMode({ type: "editTable", shapeId: shape.id });
      }
      onSelectPointHandled(request.id, true);
    } else {
      setSelectedShapeIds([]);
      transitionMode({ type: "select" });
      onSelectPointHandled(request.id, false);
    }
  }, [
    focusOverlayCanvas,
    getOpenStrokeShapeAtPoint,
    getShapeAtPoint,
    onSelectPointHandled,
    queueOverlaySave,
    refreshAnchorMeasurements,
    selectShape,
    setSelectedShapeIds,
    transitionMode,
  ]);

  useEffect(() => {
    if (selectPointRequest) {
      const timeoutId = window.setTimeout(() => handleSelectPointRequest(selectPointRequest), 0);
      return () => window.clearTimeout(timeoutId);
    }
  }, [handleSelectPointRequest, selectPointRequest]);

  const setGraphCurveFormulaLabelTextVisible = useCallback((shapeId: OverlayShapeId, curveId: string, visible: boolean) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(graphShape, current);
      const currentLabelId = currentLabelIdsByCurveId[curveId];
      if (visible) {
        if (currentLabelId) {
          return current;
        }

        const nextVisibleCurveIds = graphShape.props.spec.curves
          .map((curve) => curve.id)
          .filter((id) => id === curveId || Boolean(currentLabelIdsByCurveId[id]));
        const labelShapeEntries = createGraphFormulaLabelShapeEntries(graphShape, createOverlayShapeId, {
          width: canvasWidthRef.current,
          height: canvasHeightRef.current,
        }, { curveIds: nextVisibleCurveIds });
        const nextLabelShapeEntry = labelShapeEntries.find((entry) => entry.curveId === curveId);
        if (!nextLabelShapeEntry) {
          return current;
        }

        const nextLabelIdsByCurveId = {
          ...currentLabelIdsByCurveId,
          [curveId]: nextLabelShapeEntry.shape.id,
        };
        const nextGraph = withGraphLabelTextShapeIds(graphShape, nextLabelIdsByCurveId);
        const next = current.map((shape) => (shape.id === shapeId ? nextGraph : shape)).concat(nextLabelShapeEntry.shape);
        shapesRef.current = next;
        return next;
      }

      if (!currentLabelId) {
        return current;
      }

      const nextLabelIdsByCurveId = { ...currentLabelIdsByCurveId };
      delete nextLabelIdsByCurveId[curveId];
      const removeIdSet = new Set([currentLabelId]);
      const next = current
        .filter((shape) => !removeIdSet.has(shape.id))
        .map((shape) => {
          if (shape.id !== shapeId || shape.type !== "graph2dShape") {
            return shape;
          }

          return withGraphLabelTextShapeIds(shape, nextLabelIdsByCurveId);
        });
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave]);

  const setGraphAxisLabelTextVisible = useCallback((shapeId: OverlayShapeId, key: OverlayGraphAxisLabelKey, visible: boolean) => {
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(graphShape, current);
      const currentLabelId = currentLabelIdsByKey[key];
      if (visible) {
        if (currentLabelId) {
          return current;
        }

        const labelShapeEntry = createGraphAxisLabelShapeEntries(graphShape, createOverlayShapeId, { keys: [key] })[0];
        if (!labelShapeEntry) {
          return current;
        }

        const nextLabelIdsByKey = {
          ...currentLabelIdsByKey,
          [key]: labelShapeEntry.shape.id,
        };
        const nextGraph = withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(graphShape), nextLabelIdsByKey);
        const next = current.map((shape) => (shape.id === shapeId ? nextGraph : shape)).concat(labelShapeEntry.shape);
        shapesRef.current = next;
        return next;
      }

      const nextLabelIdsByKey = { ...currentLabelIdsByKey };
      delete nextLabelIdsByKey[key];
      const removeIdSet = new Set(currentLabelId ? [currentLabelId] : []);
      const next = current
        .filter((shape) => !removeIdSet.has(shape.id))
        .map((shape) => {
          if (shape.id !== shapeId || shape.type !== "graph2dShape") {
            return shape;
          }

          return withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(shape), nextLabelIdsByKey);
        });
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave]);

  const setGraphAxisLabelText = useCallback((shapeId: OverlayShapeId, key: OverlayGraphAxisLabelKey, text: string) => {
    const nextText = text.trim();
    setShapes((current) => {
      const graphShape = current.find((shape): shape is OverlayGraphShape => (
        shape.id === shapeId && shape.type === "graph2dShape"
      ));
      if (!graphShape) {
        return current;
      }

      const currentLabelIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(graphShape, current);
      const currentLabelId = currentLabelIdsByKey[key];
      if (!nextText) {
        const nextLabelIdsByKey = { ...currentLabelIdsByKey };
        delete nextLabelIdsByKey[key];
        const removeIdSet = new Set(currentLabelId ? [currentLabelId] : []);
        const next = current
          .filter((shape) => !removeIdSet.has(shape.id))
          .map((shape) => {
            if (shape.id !== shapeId || shape.type !== "graph2dShape") {
              return shape;
            }

            return withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(shape), nextLabelIdsByKey);
          });
        shapesRef.current = next;
        return next;
      }

      const labelShapeEntry = createGraphAxisLabelShapeEntries(graphShape, () => currentLabelId ?? createOverlayShapeId(), {
        keys: [key],
        labelsByKey: { [key]: nextText },
      })[0];
      if (!labelShapeEntry) {
        return current;
      }

      const nextLabelIdsByKey = {
        ...currentLabelIdsByKey,
        [key]: labelShapeEntry.shape.id,
      };
      const nextGraph = withGraphAxisLabelTextShapeIds(clearGraphFixedAxisLabels(graphShape), nextLabelIdsByKey);
      const nextBeforeSync = current
        .map((shape) => {
          if (shape.id === shapeId) {
            return nextGraph;
          }
          // Graph axis/point/annotation label shapes are always created as "text" (see
          // createGraphAxisLabelShapeEntries etc.); callout is never a graph-owned label, so
          // this stays text-only intentionally.
          if (shape.id !== currentLabelId || shape.type !== "text") {
            return shape;
          }
          return {
            ...shape,
            props: {
              ...shape.props,
              ...getGraphOwnedLabelTextSyncedProps(labelShapeEntry.shape.props),
            },
          } as OverlayShape;
        })
        .concat(currentLabelId ? [] : [labelShapeEntry.shape]);
      const next = syncGraphOwnedLabelTextShapePositions(nextBeforeSync, nextGraph);
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave]);

  /**
   * Announces the selected chart to the shell, which owns the floating settings panel.
   *
   * The shell bails on an equal payload (`areSelectedOverlayChartsEqual`). Without that guard this
   * effect — which depends on `shapes` — dispatches on every commit, the shell calls `setState`, and
   * the two re-render each other indefinitely.
   */
  const handleChartSpecChange = useCallback((shapeId: OverlayShapeId, spec: SigmaChartSpec) => {
    setShapes((current) => {
      const next = current.map((shape) => (
        shape.id === shapeId && shape.type === "chartShape"
          ? { ...shape, props: { ...shape.props, spec } }
          : shape
      ));
      shapesRef.current = next;
      return next;
    });
    queueOverlaySave();
  }, [queueOverlaySave]);

  useEffect(() => {
    const selected = selectedIds.length === 1
      ? shapes.find((shape) => shape.id === selectedIds[0])
      : undefined;
    if (selected?.type !== "chartShape") {
      window.dispatchEvent(new CustomEvent<SelectedOverlayChart | null>(SELECT_OVERLAY_CHART_EVENT, { detail: null }));
      return;
    }
    const sourceTable = selected.props.sourceTableShapeId
      ? shapes.find((shape) => shape.id === selected.props.sourceTableShapeId)
      : undefined;
    const table = sourceTable?.type === "tableShape" ? sourceTable.props.table : null;
    window.dispatchEvent(new CustomEvent<SelectedOverlayChart | null>(SELECT_OVERLAY_CHART_EVENT, {
      detail: {
        shapeId: selected.id,
        spec: selected.props.spec,
        data: resolveChartData(selected.props, table),
        linked: table !== null,
        onSpecChange: (spec) => handleChartSpecChange(selected.id, spec),
      },
    }));
  }, [handleChartSpecChange, selectedIds, shapes]);

  useEffect(() => {
    const selectedShape = getSelectedGraphShapeForSettings(shapes, selectedIds);
    if (!selectedShape) {
      window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail: null }));
      return;
    }

    const shapeId = selectedShape.id;
    const axisLabelShapeIdsByKey = getExistingGraphAxisLabelTextShapeIdsByKey(selectedShape, shapes);
    const axisLabelTextsByKey = getGraphAxisLabelTextsByKey(selectedShape, shapes);
    const formulaLabelShapeIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(selectedShape, shapes);
    const inspectorSpec = hydrateGraphSpecWithOwnedLabelTexts(selectedShape, shapes);
    const detail: SelectedOverlayGraph = {
      shapeId,
      spec: inspectorSpec,
      axisLabelShapeIdsByKey,
      axisLabelTextsByKey,
      formulaLabelShapeIds: getOrderedGraphLabelTextShapeIds(selectedShape.props.spec, formulaLabelShapeIdsByCurveId),
      formulaLabelShapeIdsByCurveId,
      pickingOrigin: originPickShapeId === shapeId,
      pickingFill: graphFillPickShapeId === shapeId,
      onSpecChange: (nextSpec) => {
        setShapes((current) => {
          const graphShape = current.find((shape): shape is OverlayGraphShape => (
            shape.id === shapeId && shape.type === "graph2dShape"
          ));
          if (!graphShape) {
            return current;
          }
          const currentSpecWithOwnedLabels = hydrateGraphSpecWithOwnedLabelTexts(graphShape, current);

          const nextCurveIds = new Set(nextSpec.curves.map((curve) => curve.id));
          const currentLabelIdsByCurveId = getExistingGraphLabelTextShapeIdsByCurveId(graphShape, current);
          const nextLabelIdsByCurveId: Record<string, OverlayShapeId> = {};
          const removedLabelIds: OverlayShapeId[] = [];
          for (const [curveId, labelId] of Object.entries(currentLabelIdsByCurveId)) {
            if (nextCurveIds.has(curveId)) {
              nextLabelIdsByCurveId[curveId] = labelId;
            } else {
              removedLabelIds.push(labelId);
            }
          }

          const previousPointLabelsByPointId = new Map(
            (currentSpecWithOwnedLabels.points ?? []).map((point) => [point.id, point.label?.trim() ?? ""]),
          );
          const nextPointLabelsByPointId = new Map(
            (nextSpec.points ?? []).map((point) => [point.id, point.label?.trim() ?? ""]),
          );
          const nextPointIdsWithLabels = new Set((nextSpec.points ?? [])
            .filter((point) => Boolean(point.label?.trim()))
            .map((point) => point.id));
          const currentPointLabelIdsByPointId = getExistingGraphPointLabelTextShapeIdsByPointId(graphShape, current);
          const nextPointLabelIdsByPointId: Record<string, OverlayShapeId> = {};
          const missingPointLabelIds: string[] = [];
          for (const pointId of nextPointIdsWithLabels) {
            const labelId = currentPointLabelIdsByPointId[pointId];
            if (labelId) {
              nextPointLabelIdsByPointId[pointId] = labelId;
            } else {
              missingPointLabelIds.push(pointId);
            }
          }
          for (const [pointId, labelId] of Object.entries(currentPointLabelIdsByPointId)) {
            if (!nextPointIdsWithLabels.has(pointId)) {
              removedLabelIds.push(labelId);
            }
          }

          const previousAnnotationLabelsByAnnotationId = new Map(
            (currentSpecWithOwnedLabels.annotations ?? []).map((annotation) => [annotation.id, annotation.text.trim()]),
          );
          const nextAnnotationLabelsByAnnotationId = new Map(
            (nextSpec.annotations ?? []).map((annotation) => [annotation.id, annotation.text.trim()]),
          );
          const nextAnnotationIdsWithText = new Set((nextSpec.annotations ?? [])
            .filter((annotation) => Boolean(annotation.text.trim()))
            .map((annotation) => annotation.id));
          const currentAnnotationLabelIdsByAnnotationId = getExistingGraphAnnotationLabelTextShapeIdsByAnnotationId(graphShape, current);
          const nextAnnotationLabelIdsByAnnotationId: Record<string, OverlayShapeId> = {};
          const missingAnnotationLabelIds: string[] = [];
          for (const annotationId of nextAnnotationIdsWithText) {
            const labelId = currentAnnotationLabelIdsByAnnotationId[annotationId];
            if (labelId) {
              nextAnnotationLabelIdsByAnnotationId[annotationId] = labelId;
            } else {
              missingAnnotationLabelIds.push(annotationId);
            }
          }
          for (const [annotationId, labelId] of Object.entries(currentAnnotationLabelIdsByAnnotationId)) {
            if (!nextAnnotationIdsWithText.has(annotationId)) {
              removedLabelIds.push(labelId);
            }
          }

          const nextGraphSize = getGraphShapeSizeForSpec(graphShape, nextSpec);
          let nextGraph = withGraphLabelTextShapeIds({
            ...graphShape,
            props: {
              ...graphShape.props,
              spec: nextSpec,
              boundsMode: "plot",
              w: nextGraphSize.w,
              h: nextGraphSize.h,
            },
          }, nextLabelIdsByCurveId);
          const pointLabelShapeEntries = createGraphPointLabelShapeEntries(nextGraph, createOverlayShapeId, {
            pointIds: missingPointLabelIds,
          });
          for (const entry of pointLabelShapeEntries) {
            nextPointLabelIdsByPointId[entry.pointId] = entry.shape.id;
          }
          nextGraph = withGraphPointLabelTextShapeIds(nextGraph, nextPointLabelIdsByPointId);
          const annotationLabelShapeEntries = createGraphAnnotationLabelShapeEntries(nextGraph, createOverlayShapeId, {
            annotationIds: missingAnnotationLabelIds,
          });
          for (const entry of annotationLabelShapeEntries) {
            nextAnnotationLabelIdsByAnnotationId[entry.annotationId] = entry.shape.id;
          }
          nextGraph = withGraphAnnotationLabelTextShapeIds(nextGraph, nextAnnotationLabelIdsByAnnotationId);
          nextGraph = clearMaterializedGraphLabelTexts(nextGraph);
          const changedPointLabelIds = [...nextPointIdsWithLabels].filter((pointId) => (
            previousPointLabelsByPointId.get(pointId) !== nextPointLabelsByPointId.get(pointId) &&
            Boolean(nextPointLabelIdsByPointId[pointId])
          ));
          const pointLabelPropsByShapeId = new Map(
            createGraphPointLabelShapeEntries(nextGraph, () => "", { pointIds: changedPointLabelIds })
              .map((entry) => [nextPointLabelIdsByPointId[entry.pointId], entry.shape.props]),
          );
          const changedAnnotationLabelIds = [...nextAnnotationIdsWithText].filter((annotationId) => (
            previousAnnotationLabelsByAnnotationId.get(annotationId) !== nextAnnotationLabelsByAnnotationId.get(annotationId) &&
            Boolean(nextAnnotationLabelIdsByAnnotationId[annotationId])
          ));
          const annotationLabelPropsByShapeId = new Map(
            createGraphAnnotationLabelShapeEntries(nextGraph, () => "", { annotationIds: changedAnnotationLabelIds })
              .map((entry) => [nextAnnotationLabelIdsByAnnotationId[entry.annotationId], entry.shape.props]),
          );
          const removeIdSet = new Set(removedLabelIds);
          const nextBeforeAxisSync = current
            .filter((shape) => !removeIdSet.has(shape.id))
            .map((shape) => {
              if (shape.id === shapeId) {
                return nextGraph;
              }
              // Same as above: graph-owned point/annotation labels are always "text" shapes,
              // never callout, so this text-only check is intentional.
              if (shape.type !== "text") {
                return shape;
              }
              const syncedProps = pointLabelPropsByShapeId.get(shape.id) ?? annotationLabelPropsByShapeId.get(shape.id);
              if (!syncedProps) {
                return shape;
              }
              return {
                ...shape,
                props: {
                  ...shape.props,
                  ...getGraphOwnedLabelTextSyncedProps(syncedProps),
                },
              } as OverlayShape;
            })
            .concat(pointLabelShapeEntries.map((entry) => entry.shape))
            .concat(annotationLabelShapeEntries.map((entry) => entry.shape));
          const next = syncGraphOwnedLabelTextShapePositions(nextBeforeAxisSync, nextGraph);
          shapesRef.current = next;
          return next;
        });
      },
      onStartOriginPick: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode({ type: "pickOrigin", shapeId });
      },
      onStartFillPick: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode(graphFillPickShapeId === shapeId ? { type: "select" } : { type: "pickGraphFill", shapeId });
      },
      onAxisLabelChange: (key, visible) => setGraphAxisLabelTextVisible(shapeId, key, visible),
      onAxisLabelTextChange: (key, text) => setGraphAxisLabelText(shapeId, key, text),
      onFormulaLabelChange: (curveId, visible) => setGraphCurveFormulaLabelTextVisible(shapeId, curveId, visible),
      onStartCrop: () => {
        setSelectedShapeIds([shapeId]);
        transitionMode({ type: "editGraph", shapeId });
      },
      onClose: () => setSelectedShapeIds([]),
    };

    window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail }));
  }, [
    graphFillPickShapeId,
    originPickShapeId,
    selectedIds,
    setGraphAxisLabelText,
    setGraphAxisLabelTextVisible,
    setGraphCurveFormulaLabelTextVisible,
    setSelectedShapeIds,
    shapes,
    transitionMode,
  ]);

  useEffect(() => {
    return () => {
      window.dispatchEvent(new CustomEvent<SelectedOverlayGraph | null>(SELECT_OVERLAY_GRAPH_EVENT, { detail: null }));
    };
  }, []);

  const {
    handleGraph3DCameraChange,
    handleGraph3DObjectRotationChange,
    handleGraph3DObjectTransformChange,
    handleGraph3DPreviewReady,
  } = useOverlayGraph3DController({
    shapes,
    selectedIds,
    shapesRef,
    assetsRef,
    setShapes,
    setAssets,
    explicitlySavedShapeStatesRef,
    canvasWidthRef,
    canvasHeightRef,
    imageInsertGap: IMAGE_INSERT_GAP,
    queueOverlaySave,
    setSelectedShapeIds,
    transitionMode,
    tShape,
  });

  useEffect(() => {
    const handleGraphEdit = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail as { shapeId?: string } | undefined : undefined;
      if (detail?.shapeId) {
        selectShape(detail.shapeId);
      }
    };

    window.addEventListener(GRAPH_SHAPE_EDIT_EVENT, handleGraphEdit);
    return () => window.removeEventListener(GRAPH_SHAPE_EDIT_EVENT, handleGraphEdit);
  }, [selectShape]);

  const insertContentIntoSelectedTextShape = useCallback((content: InlineNode): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        blocks: appendOverlayTextInline(shape.props.blocks, content, () => createId("p")),
      },
    }, { commit: true });
  }, [editingShapeId, updateShape]);

  const formatSelectedTextShape = useCallback((command: OverlayTextCommand, value?: string): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        blocks: formatOverlayTextBlocks(shape.props.blocks, command, value),
      },
    }, { commit: true });
  }, [editingShapeId, updateShape]);

  const resizeSelectedTextShapeFont = useCallback((fontSize: number): void => {
    const shape = getOnlySelectedTextShape(shapesRef.current, selectedIdsRef.current, editingShapeId);
    if (!shape || !Number.isFinite(fontSize)) {
      return;
    }

    updateShape({
      id: shape.id,
      type: shape.type,
      props: {
        fontSize,
        size: fontSizeToOverlaySize(fontSize),
      },
    }, { commit: true });
  }, [editingShapeId, updateShape]);

  useEffect(() => {
    const insertInlineMath = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      const tex = typeof detail?.tex === "string" ? detail.tex : "";
      const shouldEdit = detail?.edit === true;
      if (detail?.target !== "overlay" || (!tex && !shouldEdit)) {
        return;
      }

      const textEditor = activeTextEditorRef.current;
      if (textEditor?.isFocused) {
        const id = `overlay_math_${Date.now()}`;
        textEditor
          .chain()
          .focus()
          .insertMathInline({
            id,
            tex,
          })
          .run();
        if (shouldEdit) {
          requestInlineMathEdit(id);
        }
        return;
      }

      const id = `overlay_math_${Date.now()}`;
      insertContentIntoSelectedTextShape({
        type: "mathInline",
        id,
        tex,
        display: "inline",
        semanticRole: "expression",
      });
      if (shouldEdit) {
        requestInlineMathEdit(id);
      }
    };

    window.addEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
    return () => window.removeEventListener(INSERT_INLINE_MATH_EVENT, insertInlineMath);
  }, [insertContentIntoSelectedTextShape]);

  useEffect(() => {
    const formatText = (event: Event) => {
      const detail = event instanceof CustomEvent ? event.detail : null;
      if (detail?.target !== "overlay" || !detail?.command) {
        return;
      }

      const command = detail.command as OverlayTextCommand | "blockStyle" | "fontSize";
      const value = typeof detail.value === "string" ? detail.value : undefined;
      const textEditor = activeTextEditorRef.current;

      const textSession = modeRef.current.id === "overlay.textEditing" || modeRef.current.id === "overlay.tableEditing";
      if (textSession && textEditor && !textEditor.isDestroyed) {
        if (command === "fontSize" && value) {
          textEditor.chain().focus().setFontSize(Number(value)).run();
        } else if (command === "bold") {
          textEditor.chain().focus().toggleBold().run();
        } else if (command === "italic") {
          textEditor.chain().focus().toggleItalic().run();
        } else if (command === "underline") {
          textEditor.chain().focus().toggleUnderline().run();
        } else if (command === "boxed") {
          textEditor.chain().focus().toggleBoxedText().run();
        } else if (command === "boxedPaddingY" && value) {
          const paddingY = Number.parseFloat(value);
          if (Number.isFinite(paddingY) && paddingY >= 0) {
            textEditor.chain().focus().setBoxedTextPaddingY(paddingY).run();
          }
        } else if (command === "boxedVariant" && value) {
          const variant = normalizeBoxedVariant(value);
          if (variant) {
            textEditor.chain().focus().setBoxedTextVariant(variant).run();
          }
        } else if (command === "color" && value) {
          textEditor.chain().focus().setTextColor(value).run();
        } else if (command === "backgroundColor") {
          const chain = textEditor.chain().focus();
          if (value) {
            chain.setTextBackgroundColor(value).run();
          } else {
            chain.unsetTextBackgroundColor().run();
          }
        } else if (command === "fontFamily") {
          const chain = textEditor.chain().focus();
          if (value) {
            chain.setFontFamily(value).run();
          } else {
            chain.unsetFontFamily().run();
          }
        } else if (command === "lineHeight" && value) {
          const lineHeight = normalizeLineHeight(value);
          if (lineHeight) {
            textEditor.chain().focus().updateAttributes("paragraph", { lineHeight }).run();
          }
        } else if (command === "textAlign" && value) {
          textEditor.chain().focus().updateAttributes("paragraph", { textAlign: value }).run();
        } else if (command === "blockStyle" && value) {
          applyTextFormatCommand(textEditor, { command, value }, {
            selection: null,
            blockNodeType: "paragraph",
            allowBlockStyle: true,
          });
        }
      } else if (command !== "fontSize" && command !== "blockStyle") {
        formatSelectedTextShape(command, value);
      }

      if (!textSession && command === "fontSize" && value) {
        resizeSelectedTextShapeFont(Number(value));
      }
    };

    window.addEventListener(FORMAT_TEXT_EVENT, formatText);
    return () => window.removeEventListener(FORMAT_TEXT_EVENT, formatText);
  }, [formatSelectedTextShape, resizeSelectedTextShapeFont]);

  const applyMoveInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.move" }>,
    point: OverlayPoint,
  ) => {
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const movedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
    const startBounds = getShapesSelectionBounds(interaction.shapes);
    let finalDx = dx;
    let finalDy = dy;

    if (startBounds) {
      const snap = snapBoundsToGeometry(
        { ...startBounds, x: startBounds.x + dx, y: startBounds.y + dy },
        createSnapGeometry(getIdsWithDescendants(shapesRef.current, [...movedIdSet], { includeGroups: true })),
        {
          threshold: getOverlaySnapThreshold(),
          disabled: snapDisabledRef.current,
        },
      );
      finalDx += snap.nudge.x;
      finalDy += snap.nudge.y;
      setSnapGuides(snap.guides);
    } else {
      clearSnapGuides();
    }

    transitionMode({ type: "updateMove", offset: { x: finalDx, y: finalDy } });
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, transitionMode]);

  const applyResizeInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.resize" }>,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ) => {
    const {
      bounds: resizedBounds,
      isRotated: rotated,
      preserveAspect,
      targetAspect: regularAspect,
    } = resolveResizePointer(interaction, point, modifiers);
    const resizedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
    let finalBounds = resizedBounds;
    if (rotated) {
      clearSnapGuides();
    } else {
      const snap = snapResizeBoundsToGeometry(
        resizedBounds,
        interaction.handle,
        createSnapGeometry(getIdsWithDescendants(shapesRef.current, [...resizedIdSet], { includeGroups: true })),
        {
          threshold: getOverlaySnapThreshold(),
          disabled: snapDisabledRef.current,
          preserveAspect,
          targetAspect: regularAspect,
        },
      );
      finalBounds = snap.bounds;
      setSnapGuides(snap.guides);
    }
    // 掴んだ辺・スナップ・アスペクト維持はすべて「見えている箱」の上で行い、図形へ渡す直前に
    // 線幅と矢印ヘッド分のパディングを外す (`resize-frame.ts`)。
    const frame = { visual: interaction.bounds, padding: resizePaddingRef.current };
    setShapes((current) => {
      const resizedShapes = rotated
        ? [resizeRotatedShapeToVisualBounds(interaction.shapes[0], frame, finalBounds, interaction.handle)]
        : resizeShapesToVisualBounds(interaction.shapes, frame, finalBounds, interaction.handle);
      const nextResizedIdSet = new Set(resizedShapes.map((shape) => shape.id));
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        mergeShapesById(current, resizedShapes),
        nextResizedIdSet,
        anchorMeasurementsRef.current.ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold]);

  const applyPointInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.point" }>,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "shiftKey">,
  ) => {
    const constrainedShape = updateShapePoint(
      interaction.shape,
      interaction.handle,
      pagePointToUnrotatedShapePoint(
        point,
        interaction.pivot,
        interaction.rotation,
        interaction.shape.flipX,
        interaction.shape.flipY,
      ),
      modifiers.shiftKey,
    );
    if (constrainedShape.type === "callout" && interaction.handle.type === "calloutCornerRadius") {
      lastCalloutCornerRadiusRef.current = constrainedShape.props.radius;
      rememberCalloutCornerRadius(constrainedShape.props.radius);
    }
    const handlePoint = getSnappablePointHandlePagePoint(constrainedShape, interaction.handle);
    if (!handlePoint) {
      clearSnapGuides();
      replaceShape(constrainedShape);
      return;
    }

    const snap = snapPointToGeometry(
      handlePoint,
      createSnapGeometry(getIdsWithDescendants(shapesRef.current, [interaction.shape.id], { includeGroups: true })),
      {
        threshold: getOverlaySnapThreshold(),
        disabled: snapDisabledRef.current,
      },
    );
    setSnapGuides(snap.guides);

    const nextShape = snap.snapped
      ? updateShapePoint(
          interaction.shape,
          interaction.handle,
          pagePointToUnrotatedShapePoint(
            snap.point,
            interaction.pivot,
            interaction.rotation,
            interaction.shape.flipX,
            interaction.shape.flipY,
          ),
          modifiers.shiftKey,
        )
      : constrainedShape;
    replaceShape(nextShape);
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold, replaceShape]);

  const applyImageCropInteractionAtPoint = useCallback((
    interaction: Extract<OverlayInteractionMode, { id: "overlay.imageCropResize" | "overlay.imageCropPan" }>,
    point: OverlayPoint,
  ) => {
    clearSnapGuides();
    const currentShape = shapesRef.current.find((shape): shape is Extract<OverlayShape, { type: "image" }> =>
      shape.id === interaction.shape.id && shape.type === "image",
    );
    if (!currentShape) {
      return;
    }
    const asset = assetsRef.current[currentShape.props.assetId];
    const dx = point.x - interaction.start.x;
    const dy = point.y - interaction.start.y;
    const unflippedDelta = getLocalResizeDelta(dx, dy, getShapeRotation(interaction.shape));
    const localDelta = {
      x: interaction.shape.flipX ? -unflippedDelta.x : unflippedDelta.x,
      y: interaction.shape.flipY ? -unflippedDelta.y : unflippedDelta.y,
    };
    if (interaction.id === "overlay.imageCropPan") {
      const nextShape = panImageCrop(interaction.shape, asset, localDelta.x, localDelta.y);
      const positionedNextShape: Extract<OverlayShape, { type: "image" }> = {
        ...nextShape,
        x: currentShape.x,
        y: currentShape.y,
        rotation: currentShape.rotation,
        anchor: currentShape.anchor,
      };
      if (areImageCropStatesEqual(currentShape, positionedNextShape, asset)) {
        return;
      }
      imageCropDirtyRef.current = true;
      replaceShape(positionedNextShape);
      return;
    }

    const startBounds = getShapeBounds(interaction.shape);
    const resizedCropFrame = resizeImageCropFrame(
      startBounds,
      getImageCoverCrop(interaction.shape, asset),
      {
        w: asset?.props.w || interaction.shape.props.w,
        h: asset?.props.h || interaction.shape.props.h,
      },
      interaction.handle,
      localDelta,
    );
    const resizedShape = resizeRotatedShapeToBounds(
      interaction.shape,
      startBounds,
      resizedCropFrame.bounds,
      interaction.handle,
    ) as Extract<OverlayShape, { type: "image" }>;
    const nextShape: Extract<OverlayShape, { type: "image" }> = {
      ...currentShape,
      x: resizedShape.x,
      y: resizedShape.y,
      props: {
        ...currentShape.props,
        w: resizedShape.props.w,
        h: resizedShape.props.h,
        crop: resizedCropFrame.crop,
      },
    };
    if (areImageCropStatesEqual(currentShape, nextShape, asset)) {
      return;
    }
    imageCropDirtyRef.current = true;
    setShapes((current) => {
      const next = normalizeOverlayGroups(reanchorShapesByPosition(
        upsertShape(current, nextShape),
        new Set([nextShape.id]),
        anchorMeasurementsRef.current.ordered,
      ));
      shapesRef.current = next;
      return next;
    });
  }, [clearSnapGuides, replaceShape]);

  const getSnappedDrawingPoint = useCallback((
    rawPoint: OverlayPoint,
    options: {
      previousPoint?: OverlayPoint;
      shiftKey?: boolean;
      enabled?: boolean;
    } = {},
  ): OverlayPoint => {
    const constrainedPoint = options.shiftKey && options.previousPoint
      ? snapPointAround(options.previousPoint, rawPoint)
      : rawPoint;
    if (options.enabled === false) {
      clearSnapGuides();
      return constrainedPoint;
    }

    const snap = snapPointToGeometry(constrainedPoint, createSnapGeometry(), {
      threshold: getOverlaySnapThreshold(),
      disabled: snapDisabledRef.current,
    });
    setSnapGuides(snap.guides);
    return snap.point;
  }, [clearSnapGuides, createSnapGeometry, getOverlaySnapThreshold]);

  const getSnappedInsertDragPoint = useCallback((
    tool: InsertTool,
    start: OverlayPoint,
    point: OverlayPoint,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ): OverlayPoint => {
    const constrained = getConstrainedInsertDragPoint(tool, start, point, modifiers);
    if (!isPointSnappedInsertDragTool(tool)) {
      clearSnapGuides();
      return constrained;
    }

    return getSnappedDrawingPoint(constrained, { enabled: true });
  }, [clearSnapGuides, getSnappedDrawingPoint]);

  const updateModifierDrivenInteraction = useCallback((
    interaction: OverlayInteractionMode,
    modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
  ): boolean => {
    const point = lastInteractionPointRef.current;
    if (!point) {
      return false;
    }

    if (interaction.id === "overlay.move") {
      applyMoveInteractionAtPoint(interaction, point);
      return true;
    }

    if (interaction.id === "overlay.resize") {
      applyResizeInteractionAtPoint(interaction, point, modifiers);
      return true;
    }

    if (interaction.id === "overlay.point") {
      applyPointInteractionAtPoint(interaction, point, modifiers);
      return true;
    }

    if (interaction.id === "overlay.insertDrag") {
      transitionMode({
        type: "updateInsertDrag",
        current: getSnappedInsertDragPoint(interaction.tool, interaction.start, point, modifiers),
      });
      return true;
    }

    if (interaction.id === "overlay.curveDrawing") {
      const previousPoint = interaction.points[interaction.points.length - 1];
      transitionMode({
        type: "updateCurveDrawing",
        current: getSnappedDrawingPoint(point, {
          previousPoint,
          shiftKey: modifiers.shiftKey,
          enabled: isPointSnappedClickDrawingTool(interaction.tool),
        }),
      });
      return true;
    }

    return false;
  }, [
    applyMoveInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyResizeInteractionAtPoint,
    getSnappedDrawingPoint,
    getSnappedInsertDragPoint,
    transitionMode,
  ]);

  useEffect(() => {
    const handleOverlayKeyboard = (event: KeyboardEvent) => {
      if (document.querySelector("[data-modal-backdrop]")) {
        return;
      }

      // 非モーダルの浮遊サーフェス (グラフ設定パネル) には backdrop が無いので、
      // フォーカスがその中にある間のキー操作をここで止める。止めないと、パネルを
      // 見ているユーザーの Delete で図形が消え、矢印キーで図形が動く。
      // 判定はイベントの発生元で行う — サーフェスの存在だけで一律に止めると、
      // パネルを開いたまま別の図形をキーボードで編集できなくなる。
      // 発生元で分けることで Escape も決定的になる (パネル内なら閉じる、
      // キャンバス上ならトリミング等の解除)。エディタのショートカット (Undo/ズーム) は
      // EditorShell 側の別ハンドラが担当し、そちらもパネルを除外している。
      const keyboardTarget = event.target instanceof Element ? event.target : document.activeElement;
      if (keyboardTarget?.closest(NON_MODAL_KEYBOARD_SURFACE_SELECTOR)) {
        return;
      }

      if (textCompositionRef.current || isComposingKeyboardEvent(event)) {
        return;
      }

      const currentMode = modeRef.current;

      if (isSnapDisableKey(event.key)) {
        snapDisabledRef.current = true;
        if (isInteractionMode(currentMode)) {
          event.preventDefault();
          clearSnapGuides();
          updateModifierDrivenInteraction(currentMode, event);
          return;
        }
      }

      if (activeTextEditorRef.current?.isFocused) {
        return;
      }

      if (
        (event.key === "Enter" || event.key === "Escape") &&
        getImageCropModeShapeId(currentMode) !== null &&
        !isTextInputTarget(event.target)
      ) {
        event.preventDefault();
        transitionMode({ type: "select" });
        queueDirtyImageCropSave();
        return;
      }

      if (currentMode.id === "overlay.curveDrawing" && !isTextInputTarget(event.target)) {
        if (event.key === "Escape") {
          event.preventDefault();
          transitionMode({ type: "setTool", tool: { kind: "select" } });
          return;
        }

        if (event.key === "Enter") {
          event.preventDefault();
          const previewPoints = getCurveDrawingPreviewPoints(currentMode.points, currentMode.current);
          if (previewPoints) {
            finishCurveDrawing(currentMode.tool, previewPoints);
          }
          return;
        }

        if (event.key === "Backspace" || event.key === "Delete") {
          event.preventDefault();
          transitionMode({ type: "removeLastCurvePoint" });
          return;
        }
      }

      if (event.key === "Escape" && currentMode.id !== "overlay.select") {
        event.preventDefault();
        const activeTextEditor = activeTextEditorRef.current;
        if (activeTextEditor && !activeTextEditor.isDestroyed) {
          activeTextEditor.commands.blur();
        }
        transitionMode({ type: "select" });
        return;
      }

      if (event.key === "Escape" && focusedGroupIdRef.current && currentMode.id === "overlay.select") {
        event.preventDefault();
        setFocusedGroupId(null);
        setSelectedShapeIds([]);
        return;
      }

      if (isConstraintModifierKey(event.key) && updateModifierDrivenInteraction(currentMode, event)) {
        event.preventDefault();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "a" && !isTextInputTarget(event.target)) {
        const ids = getShapeIdsForCurrentScope(shapesRef.current, focusedGroupIdRef.current);
        if (ids.length === 0) {
          return;
        }

        event.preventDefault();
        activeTextEditorRef.current?.commands.blur();
        setSelectedShapeIds(ids);
        transitionMode({ type: "select" });
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "g" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        ungroupSelectedShapes();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "g" && !isTextInputTarget(event.target)) {
        event.preventDefault();
        groupSelectedShapes();
        return;
      }

      if (event.key === "Enter" && currentMode.id === "overlay.select" && !isTextInputTarget(event.target)) {
        const selectedGroup = selectedIdsRef.current.length === 1
          ? getGroupShape(shapesRef.current, selectedIdsRef.current[0])
          : null;
        if (selectedGroup) {
          event.preventDefault();
          setFocusedGroupId(selectedGroup.id);
          setSelectedShapeIds(getShapeIdsForCurrentScope(shapesRef.current, selectedGroup.id));
          return;
        }
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "d" && !isTextInputTarget(event.target)) {
        if (selectedIdsRef.current.length === 0) {
          return;
        }

        event.preventDefault();
        duplicateSelectedShapes();
        return;
      }

      const arrangeAction = getOverlayArrangeShortcutAction(event);
      const editingOverlayTextOrTable = currentMode.id === "overlay.textEditing"
        || currentMode.id === "overlay.tableEditing";
      if (arrangeAction && !isTextInputTarget(event.target) && !editingOverlayTextOrTable) {
        const selectedIds = selectedIdsRef.current;
        if (selectedIds.length === 0) {
          return;
        }
        if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIds, editPolicyLockedShapeIdsRef.current)) {
          notifyEditPolicyBlocked();
          return;
        }
        const hasUnlockedSelection = getUnlockedTransformShapes(
          shapesRef.current,
          selectedIds,
          editPolicyLockedShapeIdsRef.current,
        ).length > 0;
        if (!hasUnlockedSelection || (event.repeat && !overlayArrangeActionAllowsRepeat(arrangeAction))) {
          return;
        }

        event.preventDefault();
        event.stopPropagation();
        arrangeSelectedShapes(arrangeAction);
        return;
      }

      if (!event.metaKey && !event.ctrlKey && isArrowKey(event.key) && !isTextInputTarget(event.target)) {
        const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
        if (selectedShapes.length === 0) {
          if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
            notifyEditPolicyBlocked();
          }
          return;
        }

        event.preventDefault();
        const distance = event.shiftKey ? 10 : 1;
        const delta = arrowKeyDelta(event.key, distance);
        const movedIdSet = new Set(selectedShapes.map((shape) => shape.id));
        const { ordered } = refreshAnchorMeasurements();
        const movedShapes = moveShapes(selectedShapes, delta.x, delta.y);
        setShapes((current) => {
          const next = normalizeOverlayGroups(reanchorShapesByPosition(mergeShapesById(current, movedShapes), movedIdSet, ordered));
          shapesRef.current = next;
          return next;
        });
        return;
      }

      if (event.key !== "Backspace" && event.key !== "Delete") {
        return;
      }

      if (isTextInputTarget(event.target)) {
        return;
      }

      const ids = selectedIdsRef.current;
      if (ids.length === 0) {
        return;
      }

      event.preventDefault();
      deleteSelectedShapes();
    };

    window.addEventListener("keydown", handleOverlayKeyboard);
    return () => window.removeEventListener("keydown", handleOverlayKeyboard);
  }, [
    arrangeSelectedShapes,
    deleteSelectedShapes,
    duplicateSelectedShapes,
    finishCurveDrawing,
    groupSelectedShapes,
    clearSnapGuides,
    notifyEditPolicyBlocked,
    queueDirtyImageCropSave,
    refreshAnchorMeasurements,
    setSelectedShapeIds,
    transitionMode,
    ungroupSelectedShapes,
    updateModifierDrivenInteraction,
  ]);

  useEffect(() => {
    const cropShapeId = getImageCropModeShapeId(mode);
    if (!cropShapeId) {
      return;
    }

    const handleOutsideImagePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const targetShape = target?.closest("[data-overlay-shape-id]");
      if (
        target?.closest(".overlay-crop-handle") ||
        targetShape?.getAttribute("data-overlay-shape-id") === cropShapeId
      ) {
        return;
      }
      transitionMode({ type: "select" });
      queueDirtyImageCropSave();
    };

    window.addEventListener("pointerdown", handleOutsideImagePointerDown, true);
    return () => window.removeEventListener("pointerdown", handleOutsideImagePointerDown, true);
  }, [mode, queueDirtyImageCropSave, transitionMode]);

  useEffect(() => {
    const handleOverlayKeyUp = (event: KeyboardEvent) => {
      if (isSnapDisableKey(event.key)) {
        snapDisabledRef.current = false;
        if (
          !textCompositionRef.current &&
          !isComposingKeyboardEvent(event) &&
          !activeTextEditorRef.current?.isFocused &&
          updateModifierDrivenInteraction(modeRef.current, event)
        ) {
          event.preventDefault();
        }
        return;
      }

      if (
        !isConstraintModifierKey(event.key) ||
        textCompositionRef.current ||
        isComposingKeyboardEvent(event) ||
        activeTextEditorRef.current?.isFocused
      ) {
        return;
      }

      if (updateModifierDrivenInteraction(modeRef.current, event)) {
        event.preventDefault();
      }
    };

    window.addEventListener("keyup", handleOverlayKeyUp);
    return () => window.removeEventListener("keyup", handleOverlayKeyUp);
  }, [updateModifierDrivenInteraction]);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest(".overlay-shape-context-menu, .overlay-shape-context-submenu-panel")) {
        return;
      }
      setContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };

    window.addEventListener("pointerdown", handlePointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu]);

  useEffect(() => {
    const readBodyTextClipboardSelection = (event: ClipboardEvent): {
      text: { slice: unknown; text: string };
      html: string;
    } | null => {
      const target = event.target instanceof Element ? event.target : null;
      const scope = getBlockAnchorScope();
      if (
        !target
        || !target.closest(".text-flow-editor")
        // 数式エディタ内のコピーは数式側の選択が正で、本文の slice ではない。
        || target.closest("math-field")
        || !(scope instanceof Node)
        || !scope.contains(target)
      ) {
        return null;
      }
      const text = event.clipboardData ? readTextSliceClipboardData(event.clipboardData) : null;
      if (!text || !event.clipboardData) {
        return null;
      }
      // 跨ぎ選択のコピーは text/html を payload div で書く。textAndShapes へ包み直すとき
      // payload div を入れ子にしないよう、可視部分の HTML だけを取り出す (PM が書いた
      // 素の HTML はそのまま通る)。
      const html = event.clipboardData.getData("text/html");
      return { text, html: extractVisibleEditorClipboardHtml(html) };
    };

    /**
     * この cut / copy で、このインスタンスが図形を書き出す**見込みがあるか**。
     *
     * `handleCut` が本文側の印を食う前に、`writeShapeClipboard` が中断する条件を先に問う。
     * ここを揃えないと、**掴んでいないインスタンスが印を食って**、実際に図形を切り取る側へ
     * 本文もコアレスキーも届かない —— 「切り取りの undo が 2 手に割れる」が戻る。
     * `handleCut` が選択の有無しか見ていなかったのが元の穴。
     */
    const canWriteShapeClipboard = (event: ClipboardEvent): boolean => {
      if (activeTextEditorRef.current?.isFocused || !event.clipboardData) {
        return false;
      }
      return getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current).length > 0;
    };

    /**
     * 選択中の図形をクリップボードへ。本文の範囲も生きていれば 1 つの payload にまとめる。
     * 図形が乗ったときだけ true (呼び出し側が切り取りの削除まで進めてよい合図)。
     */
    const writeShapeClipboard = (
      event: ClipboardEvent,
      bodyText: { text: { slice: unknown; text: string }; html: string } | null,
    ): boolean => {
      // 2 つ目の条件は型の絞り込みのため (中身は `canWriteShapeClipboard` が既に見ている)。
      if (!canWriteShapeClipboard(event) || !event.clipboardData) {
        return false;
      }
      const clipboardData = event.clipboardData;

      const selectedShapes = getSelectedShapesForClipboard(shapesRef.current, selectedIdsRef.current);
      if (!bodyText && isTextInputTarget(event.target)) {
        return false;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (bodyText) {
        writeEditorClipboardData(clipboardData, createTextAndShapesClipboardPayload(
          bodyText.text,
          reanchorShapesToCopiedBlocks(selectedShapes, bodyText.text.slice),
          assetsRef.current,
          documentIdRef.current,
        ), { html: bodyText.html });
      } else {
        writeEditorClipboardData(
          clipboardData,
          createOverlayClipboardPayload(selectedShapes, assetsRef.current, documentIdRef.current),
        );
      }
      return true;
    };

    const handleCopy = (event: ClipboardEvent) => {
      // PM の copy 処理は本文 DOM に付いていて window bubble より先に走るため、
      // この時点で clipboardData に本文側の HTML/plain text/private slice が揃っている。
      writeShapeClipboard(event, readBodyTextClipboardSelection(event));
    };

    /**
     * 切り取り。本文は PM (または跨ぎ選択の置換) が自分で消すので、ここは図形の分だけ。
     *
     * 本文側の slice を `event.clipboardData` からではなくモジュールの印から読むのは、
     * PM の cut ハンドラがこの前に `clearData()` を呼ぶため (`markBodyTextCut` の注記)。
     * 印は必ず取り切る — 図形が選ばれていない切り取りで持ち越すと、次の切り取りに混ざる。
     */
    const handleCut = (event: ClipboardEvent) => {
      // `takeBodyTextCut` の印は 1 回しか取れない。`handleCut` はマウント済みの
      // オーバーレイごとに登録されている (本文 / running region で複数) ので、
      // **書き出さないインスタンスが先に食う**と、切り取った図形を持つ側に本文も
      // コアレスキーも届かない。書き出す見込みが無いインスタンスは何も取らずに降りる。
      //
      // **判定は `writeShapeClipboard` と 1 箇所で共有する。** 「選択が空でない」だけでは
      // 足りない: テキスト編集中・`clipboardData` が無い・選択が全てクリップボード対象外、の
      // どれでも書き出しは中断するのに、印だけ食われる。
      if (!canWriteShapeClipboard(event)) {
        return;
      }
      const cutText = takeBodyTextCut(event);
      const bodyText = cutText
        ? { text: cutText, html: extractVisibleEditorClipboardHtml(event.clipboardData?.getData("text/html") ?? "") }
        : null;
      if (writeShapeClipboard(event, bodyText)) {
        // 本文側が鋳造したキーを、この削除が起こす保存へ載せる (undo 1 回で両方戻す)。
        // `deleteSelectedShapes` の引数では渡さない — `runContextMenuAction` にコールバック値
        // のまま渡されており、引数を足すとイベントオブジェクトが options として流れ込む。
        //
        // **本当に消えるときだけ置く。** 選択が全てロック / 編集ポリシー禁止だと
        // `deleteSelectedShapes` は何もせずに戻り、`setShapes` が走らないのでキーが
        // 取り残される (次の無関係な編集がそれを継承して戻せなくなる)。
        const willDeleteShapes = getRemovableSelectedShapeIds().length > 0;
        pendingOverlaySaveHistoryGroupRef.current = willDeleteShapes
          ? cutText?.historyGroup ?? null
          : null;
        deleteSelectedShapes();
      }
    };

    const handlePaste = (event: ClipboardEvent) => {
      // 本文が既に処理したペーストには乗らない。
      //
      // `isTextInputTarget` だけでは足りない: 本文の PM がペーストを処理すると、選択範囲の DOM は
      // そこで作り直される。target がその中の要素 (混在選択の装飾 span など) だと、window まで
      // バブルしてくる頃には DOM から外れていて `closest` が null を返し、「入力欄ではない」と
      // 誤判定して図形をもう一度貼ってしまう (図形が 2 個増える)。
      if (event.defaultPrevented) {
        return;
      }
      if (isTextInputTarget(event.target) || activeTextEditorRef.current?.isFocused || !event.clipboardData) {
        return;
      }

      const payload = readEditorClipboardPayload(event.clipboardData);
      if (payload?.kind !== "overlayShapes" && payload?.kind !== "textAndShapes") {
        return;
      }

      const shapesPayload = payload.kind === "textAndShapes" ? toOverlayShapesClipboardPayload(payload) : payload;
      if (!applyPastedOverlayShapes(shapesPayload)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
    };

    window.addEventListener("copy", handleCopy);
    window.addEventListener("cut", handleCut);
    window.addEventListener("paste", handlePaste);
    return () => {
      window.removeEventListener("copy", handleCopy);
      window.removeEventListener("cut", handleCut);
      window.removeEventListener("paste", handlePaste);
    };
  }, [applyPastedOverlayShapes, deleteSelectedShapes, getBlockAnchorScope, getRemovableSelectedShapeIds, reanchorShapesToCopiedBlocks]);

  const getOriginPickPreviewFromClientPoint = useCallback((
    shapeId: OverlayShapeId,
    clientX: number,
    clientY: number,
  ): OriginPickPreview | null => {
    const shape = shapesRef.current.find((item): item is OverlayGraphShape => item.id === shapeId && item.type === "graph2dShape");
    if (!shape) {
      return null;
    }

    const spec = getGraphDisplaySpec(shape);
    const plotBox = getGraphPlotBox(spec);
    const plotWidth = spec.width - plotBox.left - plotBox.right;
    const plotHeight = spec.height - plotBox.top - plotBox.bottom;
    const svgPoint = graphSvgPointFromClient(shape, clientX, clientY, pagePointFromClient);
    if (!svgPoint || plotWidth <= 0 || plotHeight <= 0) {
      return null;
    }

    if (
      svgPoint.x < plotBox.left ||
      svgPoint.x > spec.width - plotBox.right ||
      svgPoint.y < plotBox.top ||
      svgPoint.y > spec.height - plotBox.bottom
    ) {
      return null;
    }

    return {
      shapeId,
      spec: moveGraphOriginToRatios(
        spec,
        (svgPoint.x - plotBox.left) / plotWidth,
        (svgPoint.y - plotBox.top) / plotHeight,
      ),
      point: svgPoint,
    };
  }, [pagePointFromClient]);

  const updateOriginPickPreviewFromEvent = useCallback((event: Pick<ReactPointerEvent<HTMLDivElement>, "clientX" | "clientY">) => {
    if (!originPickShapeId) {
      setOriginPickPreview(null);
      return;
    }

    const nextPreview = getOriginPickPreviewFromClientPoint(originPickShapeId, event.clientX, event.clientY);
    setOriginPickPreview((current) => (
      areOriginPickPreviewsEqual(current, nextPreview) ? current : nextPreview
    ));
  }, [getOriginPickPreviewFromClientPoint, originPickShapeId]);

  const handleOriginPickPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!originPickShapeId) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const graphElement = target?.closest(".graph-shape");
    if (!(graphElement instanceof HTMLElement) || graphElement.id !== originPickShapeId) {
      return;
    }

    const preview = getOriginPickPreviewFromClientPoint(originPickShapeId, event.clientX, event.clientY);
    if (!preview) {
      setOriginPickPreview(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    updateGraphShapeSpec(originPickShapeId, preview.spec);
    setOriginPickPreview(null);
    transitionMode({ type: "setTool", tool: { kind: "select" } });
  }, [getOriginPickPreviewFromClientPoint, originPickShapeId, transitionMode, updateGraphShapeSpec]);

  const handleGraphFillPickPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!graphFillPickShapeId || event.defaultPrevented) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const graphElement = target?.closest(".graph-shape");
    if (!(graphElement instanceof HTMLElement) || graphElement.id !== graphFillPickShapeId) {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "select" });
      return;
    }

    const shape = shapesRef.current.find((item): item is OverlayGraphShape => item.id === graphFillPickShapeId && item.type === "graph2dShape");
    if (!shape) {
      return;
    }

    const spec = getGraphDisplaySpec(shape);
    if (spec.kind !== "cartesian") {
      return;
    }

    const reportUnresolvedFill = () => {
      window.dispatchEvent(new CustomEvent(GRAPH_FILL_UNRESOLVED_EVENT, {
        detail: { shapeId: graphFillPickShapeId },
      }));
    };

    const svgPoint = graphSvgPointFromClient(shape, event.clientX, event.clientY, pagePointFromClient);
    if (!svgPoint) {
      reportUnresolvedFill();
      return;
    }

    const plotBox = getGraphPlotBox(spec);
    let range: ReturnType<typeof getGraphNumericRange>;
    try {
      range = getGraphNumericRange(spec);
    } catch {
      reportUnresolvedFill();
      return;
    }

    event.preventDefault();
    event.stopPropagation();

    const graphPoint = unmapGraphPoint(svgPoint.x, svgPoint.y, range, spec, plotBox);
    const nextSpec = toggleGraphFillAtPoint(spec, graphPoint, createGraphFillId());
    if (nextSpec === spec) {
      // 閉じた領域を解決できなかった。無反応に見えないよう設定パネルへ理由を渡す。
      reportUnresolvedFill();
      return;
    }

    updateGraphShapeSpec(graphFillPickShapeId, nextSpec);
  }, [graphFillPickShapeId, pagePointFromClient, transitionMode, updateGraphShapeSpec]);

  const captureDragPointer = useCallback((event: ReactPointerEvent<Element>) => {
    dragPointerRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      autoScrollArmed: false,
    };
    bleedSurfaceRef.current?.setPointerCapture(event.pointerId);
  }, []);

  const startInsertDragFromEvent = useCallback((event: ReactPointerEvent<HTMLDivElement>, tool: InsertTool) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    setSelectedShapeIds([]);
    const point = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = point;
    if (isArcInsertTool(tool)) {
      setAdjustmentDragReadoutPointerPosition(point);
    }
    transitionMode({
      type: "startInsertDrag",
      tool,
      start: point,
      points: tool.command === "freehand" ? [point] : undefined,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, pagePointFromClient, setSelectedShapeIds, transitionMode]);

  const handleCurveInsertPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, tool: InsertTool) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const interaction = modeRef.current;
    const rawPoint = pagePointFromClient(event.clientX, event.clientY);
    const previousPoint = interaction.id === "overlay.curveDrawing"
      ? interaction.points[interaction.points.length - 1]
      : undefined;
    const point = getSnappedDrawingPoint(rawPoint, {
      previousPoint,
      shiftKey: event.shiftKey,
      enabled: isPointSnappedClickDrawingTool(tool),
    });

    if (interaction.id === "overlay.curveDrawing") {
      if (shouldClosePolylineDrawing(interaction.tool, interaction.points, rawPoint)) {
        finishCurveDrawing(interaction.tool, interaction.points, true);
        return;
      }

      const nextPoints = appendCurveDrawingPoint(interaction.points, point);
      if (interaction.tool.command === "threePointArc") {
        if (nextPoints.length >= 3) {
          finishCurveDrawing(interaction.tool, nextPoints.slice(0, 3));
          return;
        }

        transitionMode({ type: "addCurvePoint", point });
        return;
      }

      if (event.detail >= 2) {
        suppressNextShapeDoubleClickRef.current = window.performance.now();
        finishCurveDrawing(interaction.tool, nextPoints);
        return;
      }

      transitionMode({ type: "addCurvePoint", point });
      return;
    }

    setSelectedShapeIds([]);
    transitionMode({ type: "startCurveDrawing", tool, point });
  }, [finishCurveDrawing, focusOverlayCanvas, getSnappedDrawingPoint, pagePointFromClient, setSelectedShapeIds, transitionMode]);

  const handleCurveDrawingDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const interaction = modeRef.current;
    if (interaction.id !== "overlay.curveDrawing") {
      return false;
    }
    if (interaction.tool.command === "threePointArc") {
      return false;
    }

    event.preventDefault();
    event.stopPropagation();
    suppressNextShapeDoubleClickRef.current = window.performance.now();
    const rawPoint = pagePointFromClient(event.clientX, event.clientY);
    const previousPoint = interaction.points[interaction.points.length - 1];
    const point = getSnappedDrawingPoint(rawPoint, {
      previousPoint,
      shiftKey: event.shiftKey,
      enabled: isPointSnappedClickDrawingTool(interaction.tool),
    });
    finishCurveDrawing(interaction.tool, appendCurveDrawingPoint(interaction.points, point));
    return true;
  }, [finishCurveDrawing, getSnappedDrawingPoint, pagePointFromClient]);

  const startShapePointerInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, point: OverlayPoint) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const focusedGroup = focusedGroupIdRef.current;
    if (
      focusedGroup &&
      shape.id !== focusedGroup &&
      !isShapeDescendantOf(shapesRef.current, shape.id, focusedGroup)
    ) {
      focusedGroupIdRef.current = null;
      setFocusedGroupId(null);
    }
    const shapeSelectionIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
    const modifierSelection = event.shiftKey || event.metaKey || event.ctrlKey;
    if (modifierSelection) {
      toggleShapeSelection(shapeSelectionIds);
      return;
    }

    const wasOnlySelected = selectedIdsRef.current.length === 1 && selectedIdsRef.current[0] === shape.id;
    const clickedSelectionSelected = shapeSelectionIds.every((id) => selectedIdsRef.current.includes(id));
    if (!clickedSelectionSelected) {
      setSelectedShapeIds(shapeSelectionIds);
    }
    if (event.altKey) {
      const duplicatedShapes = duplicateSelectedShapes({ x: 0, y: 0 });
      if (duplicatedShapes.length === 0) {
        return;
      }
      transitionMode({
        type: "startMove",
        shapes: duplicatedShapes,
        start: point,
      });
      captureDragPointer(event);
      return;
    }

    const moveCandidateIds = clickedSelectionSelected ? selectedIdsRef.current : shapeSelectionIds;
    const moveShapesSnapshot = getUnlockedTransformShapes(shapesRef.current, moveCandidateIds, editPolicyLockedShapeIdsRef.current);
    if (moveShapesSnapshot.length === 0) {
      // Note: this silently absorbs the single-shape click-drag case (the
      // pre-filter above already excludes the policy-locked shape before a
      // "startMove" action is even built, so the central `transitionMode`
      // guard below never gets a chance to run) -- surface the same notice
      // here so the user still learns why nothing happened.
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, moveCandidateIds, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }

    transitionMode({
      type: "startMove",
      shapes: moveShapesSnapshot,
      start: point,
      editOnPointerUp: isOverlayRichTextShape(shape) && wasOnlySelected
        ? "text"
        : shape.type === "tableShape" && wasOnlySelected
          ? "table"
        : undefined,
    });
    captureDragPointer(event);
  }, [captureDragPointer, duplicateSelectedShapes, focusOverlayCanvas, notifyEditPolicyBlocked, setSelectedShapeIds, toggleShapeSelection, transitionMode]);

  /**
   * インクに当たらなかった押下の共通処理 (選択を落としてマーキーを始める)。
   *
   * 図形の DIV は `getShapeBounds` の箱、つまり「変形の基準箱」であってインクの範囲ではない。
   * 円弧は `x = 中心 - r` で元の円まるごとを箱に持つので、90°の弧でも円ひとつ分の DIV が
   * 本文の上に乗る。当たり判定は幾何 (`hitTestShape`) だけが決め、外したらここへ来て
   * 空白面と同じ扱いにする。
   */
  const beginEmptySpacePointerInteraction = useCallback((event: ReactPointerEvent<HTMLDivElement>, point: OverlayPoint) => {
    focusOverlayCanvas();
    if (focusedGroupIdRef.current) {
      focusedGroupIdRef.current = null;
      setFocusedGroupId(null);
    }
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    if (!additive) {
      setSelectedShapeIds([]);
    }
    transitionMode({ type: "startMarquee", start: point, additive });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, setSelectedShapeIds, transitionMode]);

  const handleCanvasPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".overlay-text-shape-content, .graph2d-container.cropping")) {
      return;
    }

    // portal されたポップオーバー (3点メニュー等) の合成イベントは React ツリーを
    // 遡ってここへ届く。掴むと pointer capture を取って click が成立しなくなる。
    if (target?.closest("[data-toolbar-popover]")) {
      return;
    }

    const currentTool = getOverlayTool(modeRef.current);
    if (currentTool.kind === "insert") {
      if (isClickPointDrawingTool(currentTool)) {
        handleCurveInsertPointerDown(event, currentTool);
        return;
      }
      startInsertDragFromEvent(event, currentTool);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    if (!target?.closest("[data-overlay-shape-id]")) {
      focusOverlayCanvas();
      const hitOpenStrokeShape = getOpenStrokeShapeAtPoint(point);
      if (hitOpenStrokeShape) {
        startShapePointerInteraction(event, hitOpenStrokeShape, point);
        return;
      }
      beginEmptySpacePointerInteraction(event, point);
    }
  }, [
    beginEmptySpacePointerInteraction,
    getOpenStrokeShapeAtPoint,
    focusOverlayCanvas,
    graphFillPickShapeId,
    handleCurveInsertPointerDown,
    pagePointFromClient,
    startInsertDragFromEvent,
    startShapePointerInteraction,
  ]);

  /**
   * 図形の DIV が受け取った押下。押された DIV が持ち主だとは決めつけず、必ず幾何で選び直す
   * (DIV は外接矩形なので、円弧のように箱の大半が空白の図形ではインクを外していても当たる)。
   */
  const handleShapePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || event.defaultPrevented) {
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    if (event.target instanceof Element && event.target.closest(".overlay-text-shape-content, .overlay-table-shape-content, .graph2d-container.cropping")) {
      return;
    }

    const currentTool = getOverlayTool(modeRef.current);
    if (currentTool.kind === "insert") {
      if (isClickPointDrawingTool(currentTool)) {
        handleCurveInsertPointerDown(event, currentTool);
        return;
      }
      startInsertDragFromEvent(event, currentTool);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const targetShape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!targetShape) {
      // DIV には当たったがインクには当たっていない (円弧の内側など)。図形の中に置かれた
      // 操作系 — AI ロックの停止ボタンのような — だけは素通しし、それ以外は空白面と同じに扱う。
      // ここで `shape` へ流すと、描かれていないところを押しただけで選択されてしまう。
      if (event.target instanceof Element && event.target.closest("button, a, input, textarea, [contenteditable='true'], [data-toolbar-popover]")) {
        return;
      }
      beginEmptySpacePointerInteraction(event, point);
      return;
    }
    if (targetShape.type === "graph2dShape" && !hitTestShape(targetShape, point, 0)) {
      return;
    }

    const currentMode = modeRef.current;
    if (currentMode.id === "overlay.imageCropping" && currentMode.shapeId === targetShape.id && targetShape.type === "image") {
      event.preventDefault();
      event.stopPropagation();
      focusOverlayCanvas();
      selectShape(targetShape.id);
      transitionMode({ type: "startImageCropPan", shape: targetShape, start: point });
      captureDragPointer(event);
      return;
    }

    startShapePointerInteraction(event, targetShape, point);
  }, [
    beginEmptySpacePointerInteraction,
    captureDragPointer,
    focusOverlayCanvas,
    getOpenStrokeShapeAtPoint,
    getShapeAtPoint,
    graphFillPickShapeId,
    handleCurveInsertPointerDown,
    pagePointFromClient,
    selectShape,
    startInsertDragFromEvent,
    startShapePointerInteraction,
    transitionMode,
  ]);

  const handleResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, handle: ResizeHandle) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
    // 変形する集合 (グループはメンバーへ展開、ロック済みは除外) の見えている箱を掴む。
    // 描画側の枠は `selectedShapes` で作るので、ロックされたメンバーがいる選択では両者が
    // ずれるが、それは WI-15 以前と同じ — ロックの意味論を変えないためこちらを出典にする。
    const frame = getSelectionResizeFrame(selectedShapes, shapesRef.current);
    if (!frame) {
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }
    const start = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = start;
    resizePaddingRef.current = frame.padding;

    transitionMode({
      type: "startResize",
      shapes: selectedShapes,
      handle,
      start,
      bounds: frame.visual,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, notifyEditPolicyBlocked, pagePointFromClient, transitionMode]);

  const handleImageCropResizePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: Extract<OverlayShape, { type: "image" }>, handle: ResizeHandle) => {
    if (shape.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);
    const start = pagePointFromClient(event.clientX, event.clientY);
    lastInteractionPointRef.current = start;
    transitionMode({
      type: "startImageCropResize",
      shape,
      handle,
      start,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, pagePointFromClient, selectShape, transitionMode]);

  const handleRotatePointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    const selectedShapes = getUnlockedTransformShapes(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
    // The gesture turns the selection around the same point it is drawn turning about, so the
    // figure follows the pointer instead of swinging away from it.
    const center = getSelectionRotationPivot(selectedShapes, shapesRef.current);
    if (!center) {
      if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    transitionMode({
      type: "startRotate",
      shapes: selectedShapes,
      center,
      startAngle: angleFromCenter(center, point),
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, notifyEditPolicyBlocked, pagePointFromClient, transitionMode]);

  const handleAnchorPointerDown = useCallback((event: ReactPointerEvent<HTMLButtonElement>, shape: OverlayShape, origin: OverlayPoint) => {
    if (event.button !== 0 || shape.locked) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);
    transitionMode({
      type: "startAnchorDrag",
      shape,
      start: pagePointFromClient(event.clientX, event.clientY),
      origin,
    });
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, pagePointFromClient, selectShape, transitionMode]);

  const handlePointPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, handle: PointHandle) => {
    if (shape.locked || event.button !== 0) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);

    // Alt+click removes the point instead of dragging it. Refused rather than clamped when the line
    // would stop being a line (or when it is the origin point every other point is measured from),
    // so the shape can never jump as a side effect of an edit.
    //
    // `isEditableLineKind` matters: a freehand stroke shows handles only at its two ends and offers
    // no way to put a point back, so removal there would be one-way damage.
    if (event.altKey && shape.type === "line" && handle.type === "line" && isEditableLineKind(shape.props.kind)) {
      // `InTree`, not `shape.locked`: a line inside a locked group is locked too, and this deletes
      // rather than moves — the one place where getting that wrong is not undoable by dragging back.
      if (isShapeLockedInTree(shapesRef.current, shape)) {
        return;
      }
      if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
        return;
      }
      if (canRemoveLinePointAt(shape.props.points, handle.index, shape.props.closed === true)) {
        updateShape({
          ...shape,
          props: { ...shape.props, points: removeLinePointAt(shape.props.points, handle.index) },
        });
      }
      return;
    }
    if (isShapeAdjustmentHandle(handle)) {
      setAdjustmentDragReadoutPointerPosition(pagePointFromClient(event.clientX, event.clientY));
    }
    transitionMode({
      type: "startPoint",
      shape,
      handle,
      pivot: getShapeRotationPivot(shape),
      rotation: getShapeRotation(shape),
    });
    captureDragPointer(event);
  }, [
    captureDragPointer,
    focusOverlayCanvas,
    notifyEditPolicyBlocked,
    pagePointFromClient,
    selectShape,
    transitionMode,
    updateShape,
  ]);

  /**
   * Grabbing a midpoint handle.
   *
   * The point is inserted first and the ordinary vertex drag takes over from there, so nothing in
   * the point-editing code has to learn about "insert". Modeled after the interaction pattern used
   * by external canvas editors, whose create-handles promote themselves on drag start.
   *
   * The drag is handed the *new* shape: `applyPointInteractionAtPoint` works from the snapshot it
   * was given, so passing the pre-insert one would roll the point back the moment the pointer moves.
   */
  const handleLineInsertPointerDown = useCallback((
    event: ReactPointerEvent<HTMLDivElement>,
    shape: Extract<OverlayShape, { type: "line" }>,
    index: number,
    point: OverlayPoint,
  ) => {
    if (event.button !== 0 || isShapeLockedInTree(shapesRef.current, shape)) {
      return;
    }
    if (isShapeEditPolicyLockedInTree(shapesRef.current, shape, editPolicyLockedShapeIdsRef.current)) {
      // Say so rather than leaving a handle that does nothing, the way every other refusal here does.
      notifyEditPolicyBlocked();
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();
    selectShape(shape.id);

    const nextShape: OverlayShape = {
      ...shape,
      props: {
        ...shape.props,
        points: insertLinePointAt(shape.props.points, index, point),
      },
    };
    // Coalesced: the drag that follows records the step, and a press held past the save debounce
    // would otherwise leave a bare insert behind for one extra undo.
    updateShape(nextShape, { history: "coalesce" });
    transitionMode({
      type: "startPoint",
      shape: nextShape,
      handle: { type: "line", index },
      pivot: getShapeRotationPivot(nextShape),
      rotation: getShapeRotation(nextShape),
    });
    // Never `event.currentTarget.setPointerCapture`: a per-shape capture swallows the canvas's own
    // double-click handling. The bleed surface is the one element allowed to capture.
    captureDragPointer(event);
  }, [captureDragPointer, focusOverlayCanvas, notifyEditPolicyBlocked, selectShape, transitionMode, updateShape]);

  const advanceInteractionFromClient = useCallback((
    clientX: number,
    clientY: number,
    modifiers: { ctrlKey: boolean; shiftKey: boolean },
    cachedCanvasRect?: { left: number; top: number; width: number; height: number } | null,
  ) => {
    const interaction = modeRef.current;
    if (!isInteractionMode(interaction)) {
      return;
    }

    const point = pagePointFromClient(clientX, clientY, cachedCanvasRect);
    lastInteractionPointRef.current = point;
    if (interaction.id === "overlay.move") {
      applyMoveInteractionAtPoint(interaction, point);
      return;
    }

    if (interaction.id === "overlay.resize") {
      applyResizeInteractionAtPoint(interaction, point, modifiers);
      return;
    }

    if (interaction.id === "overlay.rotate") {
      clearSnapGuides();
      const nextDelta = resolveRotatePointerDelta(interaction, point, modifiers.shiftKey);
      setShapes((current) => {
        const next = normalizeOverlayGroups(mergeShapesById(current, rotateShapesAround(interaction.shapes, interaction.center, nextDelta)));
        shapesRef.current = next;
        return next;
      });
      return;
    }

    if (interaction.id === "overlay.anchor") {
      clearSnapGuides();
      transitionMode({ type: "updateAnchorDrag", current: point });
      return;
    }

    if (interaction.id === "overlay.marquee") {
      clearSnapGuides();
      transitionMode({ type: "updateMarquee", current: point });
      return;
    }

    if (interaction.id === "overlay.point") {
      applyPointInteractionAtPoint(interaction, point, modifiers);
      if (isShapeAdjustmentHandle(interaction.handle)) {
        setAdjustmentDragReadoutPointerPosition(point);
      }
      return;
    }

    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      applyImageCropInteractionAtPoint(interaction, point);
      return;
    }

    if (interaction.id === "overlay.curveDrawing") {
      const previousPoint = interaction.points[interaction.points.length - 1];
      transitionMode({
        type: "updateCurveDrawing",
        current: getSnappedDrawingPoint(point, {
          previousPoint,
          shiftKey: modifiers.shiftKey,
          enabled: isPointSnappedClickDrawingTool(interaction.tool),
        }),
      });
      return;
    }

    if (interaction.id === "overlay.insertDrag") {
      const current = getSnappedInsertDragPoint(interaction.tool, interaction.start, point, modifiers);
      transitionMode({
        type: "updateInsertDrag",
        current,
        point: interaction.tool.command === "freehand" ? current : undefined,
      });
      if (isArcInsertTool(interaction.tool)) {
        setAdjustmentDragReadoutPointerPosition(point);
      }
      return;
    }
  }, [
    clearSnapGuides,
    applyMoveInteractionAtPoint,
    applyImageCropInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyResizeInteractionAtPoint,
    getSnappedDrawingPoint,
    getSnappedInsertDragPoint,
    pagePointFromClient,
    transitionMode,
  ]);

  useLayoutEffect(() => {
    advanceInteractionFromClientRef.current = advanceInteractionFromClient;
  }, [advanceInteractionFromClient]);

  const stopDragAutoScroll = useCallback(() => {
    dragAutoScrollerRef.current?.stop();
    dragAutoScrollerRef.current = null;
  }, []);

  const updateDragAutoScroll = useCallback((clientX: number, clientY: number) => {
    if (!isDragAutoScrollInteraction(modeRef.current)) {
      stopDragAutoScroll();
      return;
    }

    if (!dragAutoScrollerRef.current) {
      const startElement = canvasRef.current ?? bleedSurfaceRef.current;
      const scrollContainer = startElement && !autoScrollPanBy
        ? findDragAutoScrollScroller(startElement)
        : null;
      const viewportElement = autoScrollViewportElement ?? scrollContainer;
      if (!viewportElement) {
        return;
      }
      const ownerWindow = viewportElement.ownerDocument.defaultView;
      if (!ownerWindow) {
        return;
      }
      const panBy = autoScrollPanBy ?? (
        scrollContainer
          ? (dx: number, dy: number) => panDragAutoScrollElement(scrollContainer, dx, dy)
          : null
      );
      if (!panBy) {
        return;
      }
      dragAutoScrollerRef.current = createDragAutoScroller({
        ownerWindow,
        getViewportBounds: () => getDragAutoScrollViewportBounds(viewportElement, ownerWindow),
        panBy,
        onPan: (lastClientX, lastClientY, layout) => {
          if (!isDragAutoScrollInteraction(modeRef.current)) {
            stopDragAutoScroll();
            return;
          }
          advanceInteractionFromClientRef.current(
            lastClientX,
            lastClientY,
            lastPointerModifiersRef.current,
            layout.rectSettled ? null : dragCanvasRectRef.current,
          );
        },
        maxSpeedPxPerSec: SHAPE_DRAG_AUTO_SCROLL_MAX_SPEED_PX_PER_SEC,
      });
    }
    dragAutoScrollerRef.current.update(clientX, clientY);
  }, [autoScrollPanBy, autoScrollViewportElement, stopDragAutoScroll]);

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (originPickShapeId) {
      updateOriginPickPreviewFromEvent(event);
    }

    lastPointerModifiersRef.current = {
      ctrlKey: event.ctrlKey,
      shiftKey: event.shiftKey,
    };
    advanceInteractionFromClient(event.clientX, event.clientY, lastPointerModifiersRef.current);
    const dragPointer = dragPointerRef.current;
    if (event.buttons !== 0 && dragPointer?.pointerId === event.pointerId) {
      if (!dragPointer.autoScrollArmed) {
        dragPointer.autoScrollArmed = Math.hypot(
          event.clientX - dragPointer.startClientX,
          event.clientY - dragPointer.startClientY,
        ) > DRAG_AUTO_SCROLL_SLOP_PX;
      }
      if (dragPointer.autoScrollArmed) {
        updateDragAutoScroll(event.clientX, event.clientY);
      } else {
        stopDragAutoScroll();
      }
    } else {
      stopDragAutoScroll();
    }
  }, [advanceInteractionFromClient, originPickShapeId, stopDragAutoScroll, updateDragAutoScroll, updateOriginPickPreviewFromEvent]);

  useEffect(() => {
    if (!isDragAutoScrollInteraction(mode)) {
      stopDragAutoScroll();
    }
  }, [mode, stopDragAutoScroll]);

  useEffect(() => stopDragAutoScroll, [stopDragAutoScroll]);

  const handlePointerCancel = useCallback(() => {
    dragPointerRef.current = null;
    stopDragAutoScroll();
  }, [stopDragAutoScroll]);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    dragPointerRef.current = null;
    stopDragAutoScroll();
    const interaction = modeRef.current;
    if (!isInteractionMode(interaction)) {
      return;
    }
    let shouldSaveOverlay = interaction.id === "overlay.resize" ||
      interaction.id === "overlay.point" ||
      interaction.id === "overlay.imageCropResize" ||
      interaction.id === "overlay.imageCropPan";

    const moveResolution = interaction.id === "overlay.move"
      ? resolveMovePointerUp(
          interaction,
          pagePointFromClient(event.clientX, event.clientY),
        )
      : null;
    if (moveResolution?.kind === "edit") {
      if (moveResolution.editor === "table") {
        transitionMode({ type: "editTable", shapeId: moveResolution.shapeId });
      } else {
        transitionMode({ type: "editText", shapeId: moveResolution.shapeId });
      }
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      clearSnapGuides();
      return;
    }

    if (interaction.id === "overlay.anchor") {
      const point = pagePointFromClient(event.clientX, event.clientY);
      const dropPoint = getAnchorDragPosition({ ...interaction, current: point });
      // A click that never moved is not a rebind: the rule snaps to boundaries,
      // so re-picking one from the resting position could shift it by a line.
      const moved = Math.abs(point.x - interaction.start.x) > ANCHOR_DRAG_SLOP_PX ||
        Math.abs(point.y - interaction.start.y) > ANCHOR_DRAG_SLOP_PX;
      const measurements = refreshAnchorMeasurements();
      const currentShape = shapesRef.current.find((shape) => shape.id === interaction.shape.id);
      const anchor = moved && currentShape && !currentShape.locked
        ? pickAnchorForHandleDrop(currentShape, dropPoint, measurements)
        : null;
      const anchorChanged = Boolean(anchor && !areOverlayAnchorsEqual(currentShape?.anchor, anchor));
      if (anchor && anchorChanged) {
        setShapes((current) => {
          const rebound = current.map((shape) => {
            if (shape.id !== interaction.shape.id || areOverlayAnchorsEqual(shape.anchor, anchor)) {
              return shape;
            }

            return { ...shape, anchor } as OverlayShape;
          });
          // Dropping a group's rule rebinds the whole unit: its members hang from the block the
          // user chose, not from wherever each of them was picked before.
          const next = inheritGroupAnchorsForMembers(rebound, measurements.ordered);
          shapesRef.current = next;
          return next;
        });
      }

      transitionMode({ type: "select" });
      clearSnapGuides();
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      if (anchorChanged) {
        queueOverlaySave();
      }
      return;
    }

    if (interaction.id === "overlay.move") {
      if (moveResolution?.kind === "commit") {
        const { offset } = moveResolution;
        shouldSaveOverlay = true;
        const movedIdSet = new Set(interaction.shapes.map((shape) => shape.id));
        const movedShapes = moveShapes(interaction.shapes, offset.x, offset.y);
        const { ordered } = refreshAnchorMeasurements();
        setShapes((current) => {
          const next = normalizeOverlayGroups(reanchorShapesByPosition(
            mergeShapesById(current, movedShapes),
            movedIdSet,
            ordered,
          ));
          shapesRef.current = next;
          return next;
        });
      }
    }

    if (interaction.id === "overlay.curveDrawing") {
      return;
    }

    if (interaction.id === "overlay.marquee") {
      const marqueeBounds = boundsFromPoints([interaction.start, interaction.current]);
      if (Math.hypot(marqueeBounds.w, marqueeBounds.h) < 3) {
        if (interaction.selectOnClick) {
          const clickPoint = pagePointFromClient(event.clientX, event.clientY);
          const hitShape = getShapeAtPoint(clickPoint, 8) ?? getOpenStrokeShapeAtPoint(clickPoint);
          if (hitShape) {
            selectShape(hitShape.id);
          } else {
            setSelectedShapeIds([]);
          }
        } else if (!interaction.additive) {
          setSelectedShapeIds([]);
          onRequestTextMode({ x: event.clientX, y: event.clientY });
        }
      } else {
        const marqueeIds = getMarqueeSelectionIds({
          shapes: shapesRef.current,
          marquee: marqueeBounds,
          focusedGroupId: focusedGroupIdRef.current,
          currentIds: selectedIdsRef.current,
          additive: interaction.additive,
        });
        setSelectedShapeIds(marqueeIds);
        // 図形を1つも囲まなかったドラッグは、図形選択ではなく本文の範囲選択だった。
        // 空振りのクリックが本文へ抜けるのと同じ規約で、掴んだ範囲ごと本文へ渡す
        // (本文の上で始まったドラッグかどうかは受け手が確かめる — 余白での空振りマーキーで
        //  図形モードを降りてしまわないように)。
        if (marqueeIds.length === 0 && !interaction.additive && !interaction.selectOnClick) {
          onRequestTextSelection?.(
            clientPointFromPage(interaction.start),
            { x: event.clientX, y: event.clientY },
          );
        }
      }
    }

    if (interaction.id === "overlay.insertDrag") {
      const rawPoint = pagePointFromClient(event.clientX, event.clientY);
      const point = getSnappedInsertDragPoint(interaction.tool, interaction.start, rawPoint, event);
      const dragDistance = Math.hypot(point.x - interaction.start.x, point.y - interaction.start.y);
      if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
        bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
      }
      if (dragDistance < 4) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        onRequestTextMode({ x: event.clientX, y: event.clientY });
        clearSnapGuides();
        return;
      }
      const insertedShapeId = createShapeFromInsertDrag(
        interaction.tool,
        interaction.start,
        point,
        interaction.tool.command === "freehand"
          ? [...(interaction.points ?? [interaction.start]), point]
          : interaction.points,
      );
      if (interaction.tool.command === "graph" && insertedShapeId) {
        transitionMode({ type: "pickOrigin", shapeId: insertedShapeId, initial: true });
      } else if (interaction.tool.command === "graph3d" && insertedShapeId) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        transitionMode({ type: "editGraph3D", shapeId: insertedShapeId });
        window.setTimeout(() => {
          window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, {
            detail: { shapeId: insertedShapeId },
          }));
        }, 0);
      } else if (interaction.tool.command === "text" && insertedShapeId) {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
        transitionMode({ type: "editText", shapeId: insertedShapeId });
      } else {
        transitionMode({ type: "setTool", tool: { kind: "select" } });
      }
      clearSnapGuides();
      return;
    }

    clearSnapGuides();
    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      transitionMode({ type: "editImageCrop", shapeId: interaction.shape.id });
    } else {
      transitionMode({ type: "select" });
    }
    if (bleedSurfaceRef.current?.hasPointerCapture(event.pointerId)) {
      bleedSurfaceRef.current.releasePointerCapture(event.pointerId);
    }
    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan") {
      queueDirtyImageCropSave();
    } else if (shouldSaveOverlay) {
      queueOverlaySave();
    }
  }, [
    createShapeFromInsertDrag,
    clearSnapGuides,
    clientPointFromPage,
    getOpenStrokeShapeAtPoint,
    getShapeAtPoint,
    getSnappedInsertDragPoint,
    onRequestTextMode,
    onRequestTextSelection,
    pagePointFromClient,
    queueDirtyImageCropSave,
    queueOverlaySave,
    refreshAnchorMeasurements,
    selectShape,
    setSelectedShapeIds,
    stopDragAutoScroll,
    transitionMode,
  ]);

  const selectedShapes = useMemo(
    () => getSelectedShapesInStackOrder(shapes, selectedIds),
    [selectedIds, shapes],
  );
  const selectedDimensionShapes = useMemo(
    () => getTopmostSelectedShapes(selectedShapes),
    [selectedShapes],
  );
  const selectedContextShapes = useMemo(
    () => getSelectedShapesForClipboard(shapes, selectedIds),
    [selectedIds, shapes],
  );
  const selectedContextAssets = useMemo(
    () => collectSelectedOverlayAssets(selectedContextShapes, assets),
    [assets, selectedContextShapes],
  );
  const transformSelectedShapes = useMemo(
    () => getUnlockedTransformShapes(shapes, selectedIds, editPolicyLockedShapeIds),
    [editPolicyLockedShapeIds, selectedIds, shapes],
  );
  /**
   * The rectangle the author sees — and, through `getSelectionResizeFrame`, the one a resize drag
   * moves. Rotation and alignment still read `getShapesSelectionBounds` themselves, so the
   * transform box and everything persisted from it are untouched.
   */
  const selectionBounds = useMemo(
    () => getSelectionVisualFrame(selectedShapes, shapes),
    [selectedShapes, shapes],
  );
  const selectedLocked = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeLockedInTree(shapes, shape));
  const selectedHidden = selectedShapes.length > 0 && selectedShapes.every((shape) => isShapeHiddenInTree(shapes, shape));
  const selectionCanResize = selectedShapes.length === 1
    ? canBoxResize(selectedShapes[0])
    : selectedShapes.some((shape) => !isShapeLockedInTree(shapes, shape));
  const selectionCanRotate = !transformSelectedShapes.some((shape) => shape.type === "tableShape");
  const selectionIsGraphCropping =
    mode.id === "overlay.graphEditing" &&
    selectedShapes.length === 1 &&
    selectedShapes[0]?.id === mode.shapeId;
  const selectionIsGraph3DEditing =
    mode.id === "overlay.graph3dEditing" &&
    selectedShapes.length === 1 &&
    selectedShapes[0]?.id === mode.shapeId;
  const selectionImageCropShape =
    (mode.id === "overlay.imageCropping" || mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") &&
    selectedShapes.length === 1 &&
    selectedShapes[0]?.id === (mode.id === "overlay.imageCropping" ? mode.shapeId : mode.shape.id) &&
    selectedShapes[0]?.type === "image"
      ? selectedShapes[0]
      : null;
  const selectionChromeHidden = initialOriginPickShapeId !== null;
  const marqueeBounds = mode.id === "overlay.marquee" ? boundsFromPoints([mode.start, mode.current]) : null;
  const currentTool = mode.tool;
  const movingShapes = mode.id === "overlay.move" ? mode.shapes : null;
  const movingShapeIds = useMemo(() => {
    if (!movingShapes) {
      return null;
    }
    const ids = new Set<OverlayShapeId>(movingShapes.map((shape) => shape.id));
    // グラフ本体をドラッグ中は、グラフが所有するラベル(点・軸・注釈・式ラベル)も
    // 同じ dragOffset で一緒に動かす。ラベルはグラフの子ではなくアンカー(rx/ry)で
    // 紐づくため移動セットには入らず、従来はドラッグ中だけ取り残されていた。
    // 確定時は reanchorShapesByPosition → resolveShapeAnchorPositions が
    // アンカーからラベル位置を再計算するので、ここは描画上の追従のみで二重移動はしない。
    for (const moving of movingShapes) {
      if (moving.type === GRAPH_SHAPE_TYPE) {
        for (const labelId of getExistingGraphLabelTextShapeIds(moving, shapes)) {
          ids.add(labelId);
        }
      }
    }
    return getMovingShapeIdsWithFullyMovingGroups(shapes, ids);
  }, [movingShapes, shapes]);
  const anchorDrag = mode.id === "overlay.anchor" ? mode : null;
  const insertDrag = mode.id === "overlay.insertDrag" ? mode : null;
  const curveDrawing = mode.id === "overlay.curveDrawing" ? mode : null;
  const curveDrawingClosed = curveDrawing ? shouldClosePolylineDrawing(curveDrawing.tool, curveDrawing.points, curveDrawing.current) : false;
  const curveDrawingPreviewPoints = curveDrawing ? getCurveDrawingPreviewPoints(curveDrawing.points, curveDrawing.current, curveDrawingClosed) : null;
  /**
   * The one line of guidance shown while a click-to-place tool is active.
   *
   * Derived, never stored: following the pointer would need a `setState` per move, which is how this
   * editor has produced idle re-render loops before. A fixed pill at the bottom needs no new state,
   * and the computation is a couple of comparisons — cheap enough to leave to the compiler rather
   * than hand-memoizing it (a `useMemo` here makes React Compiler skip this component entirely).
   */
  const drawingHint = getDrawingHint(mode, curveDrawing, curveDrawingClosed, tShape);
  const insertPreview = insertDrag
    ? {
        tool: insertDrag.tool,
        start: insertDrag.start,
        current: insertDrag.current,
        points: insertDrag.points,
        closed: false,
        bounds: boundsFromPoints([insertDrag.start, insertDrag.current]),
      }
    : curveDrawing && curveDrawingPreviewPoints
      ? {
          tool: curveDrawing.tool,
          start: curveDrawingPreviewPoints[0],
          current: curveDrawingPreviewPoints[curveDrawingPreviewPoints.length - 1],
          points: curveDrawingPreviewPoints,
          closed: curveDrawingClosed,
          bounds: boundsFromPoints(curveDrawingPreviewPoints),
        }
      : null;
  // 調整ハンドル、または arc/sector 挿入のドラッグ中にポインタ近傍へライブ数値を出す。
  const adjustmentDragReadout = getAdjustmentDragReadout(
    mode,
    shapes,
    adjustmentDragReadoutPointerPosition,
    shapeStyleDefaults,
    tShape,
  );
  const anchorIndicators = useMemo(() => {
    if (!showAnchorHandles) {
      return [];
    }
    const draggingPosition = anchorDrag ? getAnchorDragPosition(anchorDrag) : null;
    return selectedShapes
      .filter((shape) => (
        // A group hangs from body text like any other figure — it is the *unit* that does, so it
        // owns the rule and its members never show one of their own (their anchor is inherited,
        // so a grip on a member would rewrite something the next re-anchor pass overwrites).
        !isShapeGroupMember(shapes, shape) &&
        !isShapeHiddenInTree(shapes, shape) &&
        !isGraphLabelTextShape(shape, shapes)
      ))
      .map((shape) => getAnchorIndicator(
        shape,
        shapes,
        anchorMeasurements,
        canvasWidth,
        canvasHeight,
        anchorDrag?.shape.id === shape.id ? draggingPosition : null,
        movingShapeIds?.has(shape.id) ?? false,
        bleedValues,
      ))
      .filter((indicator): indicator is AnchorIndicator => indicator !== null);
  }, [anchorDrag, anchorMeasurements, bleedValues, canvasHeight, canvasWidth, movingShapeIds, selectedShapes, shapes, showAnchorHandles]);

  useEffect(() => {
    const canStyleStroke = selectedShapes.some(canShapeStyleStroke);
    const canStyleFill = selectedShapes.some(canShapeStyleFill);
    const canStyleLine = selectedShapes.some(canShapeStyleLine);
    const canStyleLineEndpoints = selectedShapes.some(canShapeStyleLineEndpoints);
    const arrowheadStart = sharedArrowhead(selectedShapes, "start");
    const arrowheadEnd = sharedArrowhead(selectedShapes, "end");
    // Computed inside the effect on purpose: the summary object is rebuilt on every selection
    // change already, and adding a memo to the dependency list is how the known re-render loop
    // starts (a new array each render feeding an effect that sets state).
    // The expanded set, not the raw selection: confirming writes through groups
    // (`getStyleTargetIds`), so reading only the top level would report a single value for a
    // genuinely mixed selection and then overwrite the members.
    const fill = sharedFill(selectedContextShapes);

    onSelectionSummaryChange?.({
      ...(mode.id === "overlay.textEditing" || mode.id === "overlay.tableEditing" ? {
        textEditing: { shapeId: mode.shapeId, kind: mode.id === "overlay.tableEditing" ? "table" as const : "text" as const },
      } : {}),
      selectedCount: selectedShapes.length,
      selectedShapeIds: selectedIds,
      selectedShapes: selectedContextShapes,
      selectedAssets: selectedContextAssets,
      locked: selectedLocked,
      hidden: selectedHidden,
      grouped: selectedShapes.some((shape) => isOverlayGroupShape(shape) || Boolean(shape.parentId)),
      canAlign: selectedShapes.length >= 2,
      canDistribute: selectedShapes.length >= 3,
      canStyleStroke,
      canStyleFill,
      canStyleLine,
      canStyleLineEndpoints,
      arrowheadStart,
      arrowheadEnd,
      fill,
    });
  }, [
    mode,
    onSelectionSummaryChange,
    selectedContextAssets,
    selectedContextShapes,
    selectedHidden,
    selectedIds,
    selectedLocked,
    selectedShapes,
  ]);

  useEffect(() => () => {
    onSelectionSummaryChange?.({
      selectedCount: 0,
      selectedShapeIds: [],
      selectedShapes: [],
      selectedAssets: {},
      locked: false,
      hidden: false,
      grouped: false,
      canAlign: false,
      canDistribute: false,
      canStyleStroke: false,
      canStyleFill: false,
      canStyleLine: false,
      canStyleLineEndpoints: false,
      arrowheadStart: null,
      arrowheadEnd: null,
      fill: { kind: "unavailable" },
    });
  }, [onSelectionSummaryChange]);

  useEffect(() => {
    // Two canvases can be mounted at once (the body, and a header/footer being edited), and a
    // window event reaches both. The host nulls the other request channels for the inactive one;
    // this flag is the same gate for previews, so a slider cannot repaint the other canvas's
    // selection.
    if (!acceptsStylePreview) {
      return;
    }

    const handlePreview = (event: Event) => {
      const style = (event as OverlayStylePreviewEvent).detail?.style ?? null;
      setPreview(style === null ? null : {
        style,
        targetIds: getStyleTargetIds(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current),
      });
    };

    window.addEventListener(OVERLAY_STYLE_PREVIEW_EVENT, handlePreview);
    return () => window.removeEventListener(OVERLAY_STYLE_PREVIEW_EVENT, handlePreview);
  }, [acceptsStylePreview]);

  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  /**
   * A style the author is still dragging.
   *
   * Applied when the shapes are drawn and nowhere else: it never reaches `shapes`, so it never
   * reaches the document, the autosave or the undo stack. Only the value the author settles on is
   * applied for real.
   */
  const previewedShapes = useMemo(() => {
    if (preview === null) {
      return shapes;
    }
    return shapes.map((shape) => (
      preview.targetIds.has(shape.id) ? applyStylePatchToShape(shape, preview.style) : shape
    ));
  }, [preview, shapes]);
  const visibleShapes = useMemo(() => getRenderableShapes(previewedShapes).map((shape) => {
    const effectiveOpacity = getEffectiveShapeOpacity(previewedShapes, shape);
    return effectiveOpacity === undefined ? shape : { ...shape, opacity: effectiveOpacity } as OverlayShape;
  }), [previewedShapes]);
  const backgroundShapeIds = useMemo(
    () => new Set(getRenderableShapes(getShapesForStackLayer(shapes, "background")).map((shape) => shape.id)),
    [shapes],
  );

  /**
   * 窓の外でも必ずマウントし続ける図形。
   *
   * 触っている最中の図形が消えると操作そのものが壊れる (選択ハンドル・テキスト編集・
   * ドラッグ・原点ピック・グラフの塗りピック)。判断がつかないものはピン留め側に倒す。
   * グループは子まで広げる — 親だけ残しても中身が消える。
   */
  // オブジェクトではなく id を見る。`visibleOriginPickPreview` は原点ピック中の pointermove
  // ごとに作り直されるので、そのまま deps に入れると窓化の絞り込みが毎回やり直しになる。
  const originPickPreviewShapeId = visibleOriginPickPreview?.shapeId ?? null;

  const pinnedShapeIds = useMemo(() => {
    const ids = new Set<OverlayShapeId>();
    for (const id of getIdsWithDescendants(shapes, [...selectedIds], { includeGroups: true })) {
      ids.add(id);
    }
    for (const id of movingShapeIds ?? []) {
      ids.add(id);
    }
    for (const id of [
      editingShapeId,
      graphFillPickShapeId,
      initialOriginPickShapeId,
      originPickPreviewShapeId,
    ]) {
      if (id) {
        ids.add(id);
      }
    }
    return ids;
  }, [
    editingShapeId,
    graphFillPickShapeId,
    initialOriginPickShapeId,
    movingShapeIds,
    originPickPreviewShapeId,
    selectedIds,
    shapes,
  ]);

  /**
   * 可視ページ範囲の外にある図形はビューを作らない。
   *
   * 当たり判定・選択・コピーは `shapesRef.current` (全図形) を見ているので、窓化しても
   * 「見えていない図形が操作できなくなる」ことはない。落とすのは DOM のビューだけ。
   * ページ寸法が渡らない構成 (running region の overlay など) では窓化しない。
   */
  const windowedVisibleShapes = useMemo(() => {
    if (!visiblePageRange || pageHeightPx <= 0) {
      return visibleShapes;
    }
    return visibleShapes.filter((shape) => {
      if (pinnedShapeIds.has(shape.id)) {
        return true;
      }
      const span = getShapePageSpan(getShapeSelectionBounds(shape), pageHeightPx, pageGapPx);
      return span.end >= visiblePageRange.start && span.start <= visiblePageRange.end;
    });
  }, [pageGapPx, pageHeightPx, pinnedShapeIds, visiblePageRange, visibleShapes]);

  /**
   * The table each chart reads, keyed by chart id.
   *
   * Built from **`shapes`**, not `windowedVisibleShapes`: a chart on page 3 may reference a table on
   * page 1, and the window drops the table long before the chart. The same reason the SVG export
   * builds its map before narrowing. The value is `props.table` **by reference** so that
   * `OverlayShapeView`'s `memo` sees a new identity only when that table actually changed —
   * deriving the chart data here instead would re-render every chart on every keystroke.
   */
  const chartSourceTables = useMemo(() => {
    const charts = shapes.filter((shape) => shape.type === "chartShape");
    if (charts.length === 0) {
      return new Map<OverlayShapeId, SigmaTableSpec>();
    }
    const tables = new Map<OverlayShapeId, SigmaTableSpec>();
    for (const shape of shapes) {
      if (shape.type === "tableShape") {
        tables.set(shape.id, shape.props.table);
      }
    }
    const byChart = new Map<OverlayShapeId, SigmaTableSpec>();
    for (const chart of charts) {
      const sourceId = chart.type === "chartShape" ? chart.props.sourceTableShapeId : undefined;
      const table = sourceId ? tables.get(sourceId) : undefined;
      if (table) {
        byChart.set(chart.id, table);
      }
    }
    return byChart;
  }, [shapes]);

  const backgroundVisibleShapes = useMemo(
    () => windowedVisibleShapes.filter((shape) => backgroundShapeIds.has(shape.id) && editingShapeId !== shape.id),
    [backgroundShapeIds, editingShapeId, windowedVisibleShapes],
  );
  const foregroundVisibleShapes = useMemo(
    () => windowedVisibleShapes.filter((shape) => !backgroundShapeIds.has(shape.id) || editingShapeId === shape.id),
    [backgroundShapeIds, editingShapeId, windowedVisibleShapes],
  );
  const contextMenuSelectionCount = contextMenu ? selectedShapes.length : 0;
  const contextCanGroup = contextMenuSelectionCount >= 2;
  const contextCanUngroup = contextMenuSelectionCount > 0 && selectedShapes.some(isOverlayGroupShape);
  const contextCanAlign = contextMenuSelectionCount >= 2;
  const contextCanDistribute = contextMenuSelectionCount >= 3;
  const contextCanChangeShapeType = contextMenuSelectionCount === 1 && canChangeOverlayShapeType(selectedShapes[0]);
  const contextImageShape = contextMenuSelectionCount === 1 && selectedShapes[0]?.type === "image"
    ? selectedShapes[0]
    : null;
  const contextGraphShape = contextMenuSelectionCount === 1 && selectedShapes[0]?.type === "graph2dShape"
    ? selectedShapes[0]
    : null;
  const contextGraph3DShape = contextMenuSelectionCount === 1 && selectedShapes[0]?.type === "graph3dShape"
    ? selectedShapes[0]
    : null;
  // The table's own menu only exists while the table is being edited, so selecting a table and
  // right-clicking has to offer this too — otherwise the feature is unreachable without first
  // double-clicking into the table.
  const contextTableShape = contextMenuSelectionCount === 1 && selectedShapes[0]?.type === "tableShape"
    ? selectedShapes[0]
    : null;
  const contextChartShape = contextMenuSelectionCount === 1 && selectedShapes[0]?.type === "chartShape"
    ? selectedShapes[0]
    : null;
  const contextImageEditable = Boolean(
    contextImageShape &&
    !isShapeLockedInTree(shapes, contextImageShape) &&
    !isShapeEditPolicyLockedInTree(shapes, contextImageShape, editPolicyLockedShapeIds),
  );
  const contextGraphEditable = Boolean(
    contextGraphShape &&
    !isShapeLockedInTree(shapes, contextGraphShape) &&
    !isShapeEditPolicyLockedInTree(shapes, contextGraphShape, editPolicyLockedShapeIds),
  );
  const contextGraph3DEditable = Boolean(
    contextGraph3DShape &&
    !isShapeLockedInTree(shapes, contextGraph3DShape) &&
    !isShapeEditPolicyLockedInTree(shapes, contextGraph3DShape, editPolicyLockedShapeIds),
  );

  const changeSelectedShapeType = useCallback((command: ShapeTypeChangeCommand) => {
    const source = getSelectedShapesInStackOrder(shapesRef.current, selectedIdsRef.current)[0];
    if (!source || selectedIdsRef.current.length !== 1 || !canChangeOverlayShapeType(source)) {
      return;
    }
    if (
      isShapeLockedInTree(shapesRef.current, source) ||
      isShapeEditPolicyLockedInTree(shapesRef.current, source, editPolicyLockedShapeIdsRef.current)
    ) {
      if (isShapeEditPolicyLockedInTree(shapesRef.current, source, editPolicyLockedShapeIdsRef.current)) {
        notifyEditPolicyBlocked();
      }
      return;
    }
    const changed = changeOverlayShapeType(source, command);
    if (!changed) {
      return;
    }
    setShapes((current) => {
      const next = normalizeOverlayGroups(current.map((shape) => shape.id === source.id ? changed : shape));
      shapesRef.current = next;
      return next;
    });
    transitionMode({ type: "select" });
    queueOverlaySave();
  }, [notifyEditPolicyBlocked, queueOverlaySave, transitionMode]);

  const handleShapeDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>, targetShape: OverlayShape) => {
    if (handleCurveDrawingDoubleClick(event)) {
      return;
    }

    if (window.performance.now() - suppressNextShapeDoubleClickRef.current < 500) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }

    if (graphFillPickShapeId) {
      return;
    }

    // 押下と同じ規約: DIV に当たっただけでは足りず、インクに当たっていること。
    // `handleCanvasDoubleClick` は幾何で解決した図形を渡してくるので、そちらは素通りする。
    const doubleClickPoint = pagePointFromClient(event.clientX, event.clientY);
    const doubleClickMargin = targetShape.type === "graph2dShape"
      ? 0
      : isOpenStrokeShape(targetShape)
        ? OPEN_STROKE_POINTER_HIT_MARGIN
        : 8;
    if (!hitTestShape(targetShape, doubleClickPoint, doubleClickMargin)) {
      return;
    }

    const selectionIds = getShapeSelectionIds(shapesRef.current, targetShape.id, focusedGroupIdRef.current);
    const selectedShape = selectionIds.length === 1
      ? shapesRef.current.find((shape) => shape.id === selectionIds[0])
      : null;
    if (selectedShape && isOverlayGroupShape(selectedShape) && focusedGroupIdRef.current !== selectedShape.id) {
      setFocusedGroupId(selectedShape.id);
      setSelectedShapeIds(getShapeSelectionIds(shapesRef.current, targetShape.id, selectedShape.id));
      transitionMode({ type: "select" });
      return;
    }

    selectShape(targetShape.id);
    if (isShapeLockedInTree(shapesRef.current, targetShape)) {
      return;
    }
    if (isOverlayRichTextShape(targetShape)) {
      transitionMode({ type: "editText", shapeId: targetShape.id });
    } else if (targetShape.type === "image") {
      transitionMode({ type: "editImageCrop", shapeId: targetShape.id });
    } else if (targetShape.type === "graph2dShape") {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "editGraph", shapeId: targetShape.id });
    } else if (targetShape.type === "graph3dShape") {
      event.preventDefault();
      event.stopPropagation();
      transitionMode({ type: "editGraph3D", shapeId: targetShape.id });
      window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, {
        detail: { shapeId: targetShape.id },
      }));
    } else if (targetShape.type === "tableShape") {
      transitionMode({ type: "editTable", shapeId: targetShape.id });
    } else if (targetShape.type === "chartShape") {
      // A chart has no in-place editing mode — its settings live in the floating panel — so this
      // opens the panel instead of transitioning. `graph2d`/`graph3d` are handled at the capture
      // stage upstream; a chart is neither, so it arrives here in the ordinary stage.
      event.preventDefault();
      event.stopPropagation();
      window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_CHART_SETTINGS_EVENT, {
        detail: { shapeId: targetShape.id },
      }));
    }
  }, [graphFillPickShapeId, handleCurveDrawingDoubleClick, pagePointFromClient, selectShape, setSelectedShapeIds, transitionMode]);

  const handleCanvasDoubleClick = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    if (event.defaultPrevented) {
      return;
    }

    if (modeRef.current.id === "overlay.curveDrawing") {
      handleCurveDrawingDoubleClick(event);
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const shape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!shape) {
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    handleShapeDoubleClick(event, shape);
  }, [getOpenStrokeShapeAtPoint, getShapeAtPoint, handleCurveDrawingDoubleClick, handleShapeDoubleClick, pagePointFromClient]);

  const handleCanvasContextMenu = useCallback((event: ReactMouseEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    // OrbitControls blocks the browser's native context menu on its canvas. Keep that prevention,
    // but still route the event into Sigma Studio's own shape menu.
    if (event.defaultPrevented && !target?.closest(".overlay-graph3d-live-window")) {
      return;
    }

    if (target?.closest(".overlay-table-context-menu")) {
      return;
    }

    const point = pagePointFromClient(event.clientX, event.clientY);
    const shape = getShapeAtPoint(point, 8) ?? getOpenStrokeShapeAtPoint(point);
    if (!shape) {
      setContextMenu(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusOverlayCanvas();

    const focusedGroup = focusedGroupIdRef.current;
    if (
      focusedGroup &&
      shape.id !== focusedGroup &&
      !isShapeDescendantOf(shapesRef.current, shape.id, focusedGroup)
    ) {
      focusedGroupIdRef.current = null;
      setFocusedGroupId(null);
    }

    const shapeSelectionIds = getShapeSelectionIds(shapesRef.current, shape.id, focusedGroupIdRef.current);
    const currentSelection = new Set(selectedIdsRef.current);
    if (!shapeSelectionIds.some((id) => currentSelection.has(id))) {
      setSelectedShapeIds(shapeSelectionIds);
    }
    transitionMode({ type: "select" });
    setContextMenu({
      x: clamp(event.clientX, 8, Math.max(8, window.innerWidth - 232)),
      y: clamp(event.clientY, 8, Math.max(8, window.innerHeight - 360)),
      shapeId: shapeSelectionIds[0] ?? shape.id,
    });
  }, [
    focusOverlayCanvas,
    getOpenStrokeShapeAtPoint,
    getShapeAtPoint,
    pagePointFromClient,
    setSelectedShapeIds,
    transitionMode,
  ]);

  const runContextMenuAction = useCallback((action: () => void) => {
    action();
    setContextMenu(null);
    focusOverlayCanvas();
  }, [focusOverlayCanvas]);

  const handleTextEditorFocus = useCallback((editor: TiptapEditor, shapeId: OverlayShapeId) => {
    activeTextEditorRef.current = editor;
    selectShape(shapeId);
    transitionMode({ type: "editText", shapeId });
  }, [selectShape, transitionMode]);

  const handleTextEditorCancel = useCallback((shapeId: OverlayShapeId) => {
    activeTextEditorRef.current?.commands.blur();
    activeTextEditorRef.current = null;
    selectShape(shapeId);
  }, [selectShape]);

  /**
   * The box height a shape's text turned out to need, reported by whichever surface drew it (the
   * static view on this canvas, or the Tiptap editor while the shape is focused).
   *
   * Height is a derived value now, so a text shape takes the measurement as-is — deleting a line
   * has to make the box shorter, or the selection outline keeps the old size. A callout still only
   * grows: its height is also the bubble the user can drag, and silently shrinking that would undo
   * a deliberate size. Coalesced into one history entry so a re-measure never costs an undo step.
   */
  const handleTextMeasuredHeight = useCallback((shapeId: OverlayShapeId, height: number) => {
    const shape = shapesRef.current.find((item) => item.id === shapeId);
    if (!shape || !isOverlayRichTextShape(shape)) {
      return;
    }

    const nextHeight = shape.type === "callout" ? Math.max(shape.props.h, height) : height;
    if (Math.abs(shape.props.h - nextHeight) < 1) {
      return;
    }

    updateShape({
      id: shapeId,
      type: shape.type,
      props: { h: nextHeight },
    }, { history: "coalesce" });
  }, [updateShape]);

  const handleTextChange = useCallback((shapeId: OverlayShapeId, blocks: OverlayTextBlock[]) => {
    const shape = shapesRef.current.find((item) => item.id === shapeId);
    // onTextChange fires from both text and callout OverlayTextShapeEditor instances
    // (shape-renderer.tsx), so this must accept callout too or its edits are silently dropped.
    if (!shape || !isOverlayRichTextShape(shape) || areOverlayTextBlocksEqual(shape.props.blocks, blocks)) {
      return;
    }

    // ここは打鍵ごとに同期で確定させる (`commit: true`)。
    //
    // デバウンス保存 (`queueOverlaySave`) へ移すと打鍵が 1 エントリにまとまってしまい、
    // 「図形テキストの undo は 1 文字ずつ」「その都度、保存済みの教材も同じ内容になる」という
    // 契約が壊れる (overlay-canvas.spec.ts「undoes text shape edits one step at a time with ctrl z」)。
    // 速くするなら履歴の粒度と書き込みの頻度を分離する必要があり、それは host 側
    // (`commitDocumentChange`) まで含めた設計変更になるので、ここでの付け替えでは扱わない。
    updateShape({
      id: shapeId,
      type: shape.type,
      props: { blocks },
    }, { commit: true });
  }, [updateShape]);

  const handleGraphSpecChange = useCallback((shapeId: OverlayShapeId, spec: Graph2DSpec, meta?: GraphSpecChangeMeta) => {
    const cropPatch = meta?.source === "crop" && meta.resizeToCrop ? meta.cropBox : undefined;
    const graphShape = cropPatch
      ? shapesRef.current.find((item): item is OverlayGraphShape => item.id === shapeId && item.type === GRAPH_SHAPE_TYPE)
      : null;
    const positionPatch = graphShape && cropPatch
      ? getGraphCropPositionPatch(graphShape, cropPatch)
      : {};
    updateGraphShapeSpec(
      shapeId,
      spec,
      positionPatch,
      { preserveGraphOwnedLabelPositions: meta?.source === "crop" },
    );
  }, [updateGraphShapeSpec]);

  const handleTableEditorFocus = useCallback((editor: TiptapEditor, shapeId: OverlayShapeId) => {
    activeTextEditorRef.current = editor;
    selectShape(shapeId);
    transitionMode({ type: "editTable", shapeId });
  }, [selectShape, transitionMode]);

  const handleTableChange = useCallback((shapeId: OverlayShapeId, table: SigmaTableSpec) => {
    updateShape({
      id: shapeId,
      type: TABLE_SHAPE_TYPE,
      props: { table },
    });
  }, [updateShape]);

  const handleTableResize = useCallback((shapeId: OverlayShapeId, patch: TableShapeResizePatch) => {
    updateShape({
      id: shapeId,
      type: TABLE_SHAPE_TYPE,
      ...(patch.x === undefined ? {} : { x: patch.x }),
      ...(patch.y === undefined ? {} : { y: patch.y }),
      props: {
        w: patch.w,
        h: patch.h,
        table: patch.table,
      },
    });
  }, [updateShape]);

  const handleGraphCropEnd = useCallback(() => {
    transitionMode({ type: "select" });
  }, [transitionMode]);

  const shapeEditorRenderers = useOverlayShapeEditorRenderers({
    onCreateChartFromTable: createChartFromTable,
    onGraph3DCameraChange: handleGraph3DCameraChange,
    onGraph3DObjectRotationChange: handleGraph3DObjectRotationChange,
    onGraph3DObjectTransformChange: handleGraph3DObjectTransformChange,
    onGraph3DPreviewReady: handleGraph3DPreviewReady,
    onTableChange: handleTableChange,
    onTableEditorFocus: handleTableEditorFocus,
    onTableResize: handleTableResize,
    onTextMeasuredHeight: handleTextMeasuredHeight,
    onTextChange: handleTextChange,
    onTextEditorCancel: handleTextEditorCancel,
    onTextEditorFocus: handleTextEditorFocus,
  });

  return (
    <div
      ref={bleedSurfaceRef}
      className="overlay-canvas-bleed-surface"
      onPointerDownCapture={(event) => {
        handleOriginPickPointerDown(event);
        handleGraphFillPickPointerDown(event);
      }}
      onPointerDown={handleCanvasPointerDown}
      onPointerMove={handlePointerMove}
      onPointerCancel={handlePointerCancel}
      onPointerLeave={() => {
        if (originPickShapeId) {
          setOriginPickPreview(null);
        }
      }}
      onPointerUp={handlePointerUp}
      onContextMenu={handleCanvasContextMenu}
      onDoubleClick={handleCanvasDoubleClick}
      tabIndex={-1}
    >
      <div
        ref={canvasRef}
        className={[
          "overlay-canvas-editor",
          originPickShapeId ? "origin-picking" : "",
          initialOriginPickShapeId ? "initial-origin-picking" : "",
          graphFillPickShapeId ? "graph-fill-picking" : "",
          currentTool.kind === "insert" ? "inserting" : "",
        ].filter(Boolean).join(" ")}
        data-overlay-insert-command={currentTool.kind === "insert" ? currentTool.command : undefined}
      >
      <input
        ref={imageReplacementInputRef}
        type="file"
        accept={SUPPORTED_OVERLAY_IMAGE_MIME_TYPES.join(", ")}
        hidden
        data-testid="overlay-image-replacement-input"
        onChange={(event) => void handleImageReplacementChange(event)}
      />
      {backgroundLayerElement && backgroundVisibleShapes.length > 0 && createPortal((
        <div className="overlay-canvas-bleed-surface background" aria-hidden="true">
          <div className="overlay-canvas-editor background">
            {backgroundVisibleShapes.map((shape) => (
              <OverlayShapeView
                key={shape.id}
                shape={shape}
                assets={assets}
                chartSourceTable={chartSourceTables.get(shape.id) ?? null}
                externalRevision={appliedSnapshotRevision}
                selected={false}
                editing={false}
                disableGraphCrop
                hideGraphAxes={false}
                originPickPreview={null}
                dragTranslate={movingShapeIds?.has(shape.id) ? dragOffset : null}
                onPointerDown={noopShapePointerDown}
                onDoubleClick={noopShapeDoubleClick}
                onGraphSpecChange={noopGraphSpecChange}
                onGraphCropEnd={noopGraphCropEnd}
                diffClassName={diffShapeClassNames?.get(shape.id)}
                decoration={shapeDecorations?.get(shape.id) ?? null}
                textPaintRevision={getTextPaintRevision(shape, textRepaint)}
              />
            ))}
          </div>
        </div>
      ), backgroundLayerElement)}

      {foregroundVisibleShapes.map((shape) => (
        <OverlayShapeView
          key={shape.id}
          shape={shape}
          assets={assets}
          chartSourceTable={chartSourceTables.get(shape.id) ?? null}
          externalRevision={appliedSnapshotRevision}
          selected={selectedIdSet.has(shape.id)}
          editing={editingShapeId === shape.id}
          disableGraphCrop={Boolean(graphFillPickShapeId)}
          hideGraphAxes={initialOriginPickShapeId === shape.id}
          originPickPreview={visibleOriginPickPreview?.shapeId === shape.id ? visibleOriginPickPreview : null}
          dragTranslate={movingShapeIds?.has(shape.id) ? dragOffset : null}
          onPointerDown={handleShapePointerDown}
          onDoubleClick={handleShapeDoubleClick}
          onGraphSpecChange={handleGraphSpecChange}
          onGraphCropEnd={handleGraphCropEnd}
          diffClassName={diffShapeClassNames?.get(shape.id)}
          decoration={shapeDecorations?.get(shape.id) ?? null}
          editorRenderers={shapeEditorRenderers}
          onTextMeasuredHeight={handleTextMeasuredHeight}
          textPaintRevision={getTextPaintRevision(shape, textRepaint)}
        />
      ))}
      <OverlayShapeDimensionLabels
        shapes={selectionChromeHidden || selectionImageCropShape ? [] : selectedDimensionShapes}
        dragTranslate={dragOffset}
        movingShapeIds={movingShapeIds}
      />

      {backgroundVisibleShapes.map((shape) => (
        <OverlayShapeHitTarget
          key={`${shape.id}-hit-target`}
          shape={shape}
          selected={selectedIdSet.has(shape.id)}
          dragTranslate={movingShapeIds?.has(shape.id) ? dragOffset : null}
          onPointerDown={handleShapePointerDown}
          onDoubleClick={handleShapeDoubleClick}
        />
      ))}

      {selectionBounds && selectedShapes.length > 0 && !selectionChromeHidden && (
        <SelectionBox
          shapes={selectedShapes}
          allShapes={shapes}
          bounds={selectionBounds}
          resizable={selectionCanResize && !selectedLocked && !selectionIsGraphCropping && !selectionIsGraph3DEditing}
          rotatable={selectionCanRotate && !selectedLocked && !selectionIsGraphCropping && !selectionIsGraph3DEditing}
          cropShape={selectionImageCropShape}
          dragTranslate={dragOffset}
          movingShapeIds={movingShapeIds}
          onResizePointerDown={handleResizePointerDown}
          onImageCropResizePointerDown={handleImageCropResizePointerDown}
          onRotatePointerDown={handleRotatePointerDown}
          onPointPointerDown={handlePointPointerDown}
          onLineInsertPointerDown={handleLineInsertPointerDown}
        />
      )}

      {anchorIndicators.length > 0 && !selectionChromeHidden && !selectionImageCropShape && (
        <AnchorIndicators
          indicators={anchorIndicators}
          onAnchorPointerDown={handleAnchorPointerDown}
        />
      )}

      {marqueeBounds && (
        <div
          className="overlay-marquee-box"
          style={{
            left: marqueeBounds.x,
            top: marqueeBounds.y,
            width: marqueeBounds.w,
            height: marqueeBounds.h,
          }}
        />
      )}

      {insertPreview && (
        <InsertDragPreview
          tool={insertPreview.tool}
          start={insertPreview.start}
          current={insertPreview.current}
          points={insertPreview.points}
          closed={insertPreview.closed}
          bounds={insertPreview.bounds}
          assets={assets}
          styleDefaults={pickStyleDefaultsForInsert(insertPreview.tool.command, shapeStyleDefaults)}
        />
      )}

      {curveDrawing && (
        <CurveDrawingMarkers
          points={curveDrawing.points}
          current={curveDrawing.current}
          closeArmed={curveDrawingClosed}
        />
      )}

      {adjustmentDragReadout && <OverlayDragReadout {...adjustmentDragReadout} />}

      {snapGuides.length > 0 && <SnapGuides guides={snapGuides} />}

      {editPolicyNotice && (
        <p className={editPolicy.blockedNoticeClassName} role="status" aria-live="polite">
          {editPolicyNotice}
        </p>
      )}

      {drawingHint !== null && typeof document !== "undefined" && createPortal((
        <div className="overlay-drawing-hint" role="status" data-testid="overlay-drawing-hint">
          {drawingHint}
        </div>
      ), document.body)}

      {contextMenu && contextMenuSelectionCount > 0 && typeof document !== "undefined" && createPortal((
        <OverlayShapeContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          canGroup={contextCanGroup}
          canUngroup={contextCanUngroup}
          canAlign={contextCanAlign}
          canDistribute={contextCanDistribute}
          canChangeShapeType={contextCanChangeShapeType}
          imageHasCrop={Boolean(contextImageShape?.props.crop)}
          imageEditable={contextImageEditable}
          imageOpacity={clamp(contextImageShape?.opacity ?? 1, 0, 1)}
          graphEditable={contextGraphEditable}
          graphCanFill={contextGraphShape?.props.spec.kind === "cartesian"}
          graph3dEditable={contextGraph3DEditable}
          onCreateChartFromTable={contextTableShape ? () => runContextMenuAction(() => {
            createChartFromTable(contextTableShape.id);
          }) : undefined}
          onChartSettings={contextChartShape ? () => runContextMenuAction(() => {
            setSelectedShapeIds([contextChartShape.id]);
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_CHART_SETTINGS_EVENT, {
              detail: { shapeId: contextChartShape.id },
            }));
          }) : undefined}
          onGraph3DSettings={contextGraph3DShape ? () => runContextMenuAction(() => {
            setSelectedShapeIds([contextGraph3DShape.id]);
            transitionMode({ type: "editGraph3D", shapeId: contextGraph3DShape.id });
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT, {
              detail: { shapeId: contextGraph3DShape.id },
            }));
          }) : undefined}
          onGraphSettings={contextGraphShape ? () => runContextMenuAction(() => {
            window.dispatchEvent(new CustomEvent(OPEN_OVERLAY_GRAPH_SETTINGS_EVENT, {
              detail: { shapeId: contextGraphShape.id },
            }));
          }) : undefined}
          onGraphCrop={contextGraphShape ? () => runContextMenuAction(() => {
            setSelectedShapeIds([contextGraphShape.id]);
            transitionMode({ type: "editGraph", shapeId: contextGraphShape.id });
          }) : undefined}
          onGraphOriginPick={contextGraphShape ? () => runContextMenuAction(() => {
            setSelectedShapeIds([contextGraphShape.id]);
            transitionMode({ type: "pickOrigin", shapeId: contextGraphShape.id });
          }) : undefined}
          onGraphFillPick={contextGraphShape ? () => runContextMenuAction(() => {
            setSelectedShapeIds([contextGraphShape.id]);
            transitionMode({ type: "pickGraphFill", shapeId: contextGraphShape.id });
          }) : undefined}
          onImageCrop={contextImageShape ? () => runContextMenuAction(() => startImageCrop(contextImageShape.id)) : undefined}
          onImageReplace={contextImageShape ? () => runContextMenuAction(() => requestImageReplacement(contextImageShape.id)) : undefined}
          onImageResetCrop={contextImageShape ? () => runContextMenuAction(() => resetImageCrop(contextImageShape.id)) : undefined}
          onImageNaturalSize={contextImageShape ? () => runContextMenuAction(() => restoreImageNaturalSize(contextImageShape.id)) : undefined}
          onImageOpacityChange={contextImageShape ? (opacity) => setImageOpacity(contextImageShape.id, opacity) : undefined}
          onDuplicate={() => runContextMenuAction(() => duplicateSelectedShapes())}
          onDelete={() => runContextMenuAction(deleteSelectedShapes)}
          onGroup={() => runContextMenuAction(groupSelectedShapes)}
          onUngroup={() => runContextMenuAction(ungroupSelectedShapes)}
          arrangeShortcutLabels={arrangeShortcutLabels}
          onArrange={(action) => runContextMenuAction(() => arrangeSelectedShapes(action))}
          onTransform={(action) => runContextMenuAction(() => applyQuickTransformToSelectedShapes(action))}
          onAlign={(action) => runContextMenuAction(() => alignSelectedShapes(action))}
          onDistribute={(axis) => runContextMenuAction(() => distributeSelectedShapes(axis))}
          onChangeShapeType={(command) => runContextMenuAction(() => changeSelectedShapeType(command))}
          onSaveAsMaterial={onMaterialSaveRequest ? () => runContextMenuAction(onMaterialSaveRequest) : undefined}
        />
      ), document.body)}

      {tableInsertPicker && (
        <TableInsertGridPicker
          anchorRect={tableInsertPicker.anchorRect}
          onPick={insertTableAtViewportCenter}
          onClose={() => setTableInsertPicker(null)}
        />
      )}
      </div>
    </div>
  );
}

function OverlayShapeContextMenu({
  x,
  y,
  canGroup,
  canUngroup,
  canAlign,
  canDistribute,
  canChangeShapeType,
  imageHasCrop,
  imageEditable,
  imageOpacity,
  graphEditable,
  graphCanFill,
  graph3dEditable,
  onChartSettings,
  onCreateChartFromTable,
  onGraphSettings,
  onGraph3DSettings,
  onGraphCrop,
  onGraphOriginPick,
  onGraphFillPick,
  onImageCrop,
  onImageReplace,
  onImageResetCrop,
  onImageNaturalSize,
  onImageOpacityChange,
  onDuplicate,
  onDelete,
  onGroup,
  onUngroup,
  arrangeShortcutLabels,
  onArrange,
  onTransform,
  onAlign,
  onDistribute,
  onChangeShapeType,
  onSaveAsMaterial,
}: {
  x: number;
  y: number;
  canGroup: boolean;
  canUngroup: boolean;
  canAlign: boolean;
  canDistribute: boolean;
  canChangeShapeType: boolean;
  imageHasCrop: boolean;
  imageEditable: boolean;
  imageOpacity: number;
  graphEditable: boolean;
  graphCanFill: boolean;
  graph3dEditable: boolean;
  onChartSettings?: () => void;
  onCreateChartFromTable?: () => void;
  onGraphSettings?: () => void;
  onGraph3DSettings?: () => void;
  onGraphCrop?: () => void;
  onGraphOriginPick?: () => void;
  onGraphFillPick?: () => void;
  onImageCrop?: () => void;
  onImageReplace?: () => void;
  onImageResetCrop?: () => void;
  onImageNaturalSize?: () => void;
  onImageOpacityChange?: (opacity: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onGroup: () => void;
  onUngroup: () => void;
  arrangeShortcutLabels?: Partial<Record<OverlayArrangeAction, string>>;
  onArrange: (action: OverlayArrangeAction) => void;
  onTransform: (action: "rotateClockwise" | "rotateCounterclockwise" | OverlayFlipAxis) => void;
  onAlign: (action: OverlayAlignAction) => void;
  onDistribute: (axis: OverlayDistributeAxis) => void;
  onChangeShapeType: (command: ShapeTypeChangeCommand) => void;
  onSaveAsMaterial?: () => void;
}) {
  const tShape = useT("shape");
  // 並び替えの4語だけリボンと共有する (`chrome.shapeStyle.arrange.*` が唯一の出典)。
  const tChrome = useT("chrome");
  const [shapeTypePickerOpen, setShapeTypePickerOpen] = useState(false);
  const [openSubmenu, setOpenSubmenu] = useState<"order" | "rotation" | null>(null);
  const submenuSide = typeof window !== "undefined" && x + 456 > window.innerWidth ? "left" : "right";
  return (
    <div
      className="overlay-shape-context-menu"
      role="menu"
      style={{ left: x, top: y }}
      onPointerDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      {onCreateChartFromTable && (
        <>
          <ContextMenuButton icon={<ChartColumnBig size={14} />} onClick={onCreateChartFromTable}>
            {tShape("table.createChart")}
          </ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onChartSettings && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} onClick={onChartSettings}>
            {tShape("chartPanel.title")}
          </ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onGraphSettings && onGraphCrop && onGraphOriginPick && onGraphFillPick && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} disabled={!graphEditable} onClick={onGraphSettings}>{tShape("menu.graphSettings")}</ContextMenuButton>
          <ContextMenuButton icon={<Crop size={14} />} disabled={!graphEditable} onClick={onGraphCrop}>{tShape("graph.trim")}</ContextMenuButton>
          <ContextMenuButton icon={<Crosshair size={14} />} disabled={!graphEditable} onClick={onGraphOriginPick}>{tShape("graph.pickOrigin")}</ContextMenuButton>
          <ContextMenuButton icon={<PaintBucket size={14} />} disabled={!graphEditable || !graphCanFill} onClick={onGraphFillPick}>{tShape("graph.fillArea")}</ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onGraph3DSettings && (
        <>
          <ContextMenuButton icon={<Settings2 size={14} />} disabled={!graph3dEditable} onClick={onGraph3DSettings}>{tShape("graph3d.menuSettings")}</ContextMenuButton>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {onImageCrop && onImageReplace && onImageResetCrop && onImageNaturalSize && onImageOpacityChange && (
        <>
          <ContextMenuButton icon={<Crop size={14} />} disabled={!imageEditable} onClick={onImageCrop}>{tShape("menu.imageCrop")}</ContextMenuButton>
          <ContextMenuButton icon={<RefreshCw size={14} />} disabled={!imageEditable} onClick={onImageReplace}>{tShape("menu.imageReplace")}</ContextMenuButton>
          <ContextMenuButton icon={<RotateCcw size={14} />} disabled={!imageEditable || !imageHasCrop} onClick={onImageResetCrop}>{tShape("menu.imageResetCrop")}</ContextMenuButton>
          <ContextMenuButton icon={<Maximize2 size={14} />} disabled={!imageEditable} onClick={onImageNaturalSize}>{tShape("menu.imageNaturalSize")}</ContextMenuButton>
          <label className="overlay-shape-context-menu-opacity">
            <span>{tShape("menu.opacity")}</span>
            <input
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={imageOpacity}
              disabled={!imageEditable}
              aria-label={tShape("menu.imageOpacityAria")}
              data-testid="overlay-image-opacity-slider"
              onChange={(event) => onImageOpacityChange(Number(event.target.value))}
            />
            <output>{Math.round(imageOpacity * 100)}%</output>
          </label>
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}
      {canGroup && <ContextMenuButton icon={<Group size={14} />} onClick={onGroup}>{tShape("menu.group")}</ContextMenuButton>}
      {canUngroup && <ContextMenuButton icon={<Ungroup size={14} />} onClick={onUngroup}>{tShape("menu.ungroup")}</ContextMenuButton>}
      {(canGroup || canUngroup) && <div className="overlay-shape-context-menu-separator" role="separator" />}

      {canChangeShapeType && (
        <>
          <ContextMenuButton icon={<Shapes size={14} />} onClick={() => setShapeTypePickerOpen((open) => !open)}>
            {tShape("menu.changeShapeType")}
          </ContextMenuButton>
          {shapeTypePickerOpen && (
            <div className="overlay-shape-type-picker">
              {buildShapeTypeChangeSections(tShape).map((section) => (
                <div key={section.id} className="overlay-shape-type-section">
                  <div className="overlay-shape-type-section-label">{section.label}</div>
                  <div className="overlay-shape-type-grid">
                    {section.items.map((item) => {
                      if (!item.command || !isShapeTypeChangeCommand(item.command)) {
                        return null;
                      }
                      const Icon = item.icon;
                      return (
                        <button
                          key={item.command}
                          type="button"
                          role="menuitem"
                          title={item.label}
                          aria-label={item.label}
                          onClick={() => onChangeShapeType(item.command as ShapeTypeChangeCommand)}
                        >
                          <Icon size={16} />
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div className="overlay-shape-context-menu-separator" role="separator" />
        </>
      )}

      <ContextMenuSubmenu
        icon={<Layers size={14} />}
        label={tShape("menu.order")}
        open={openSubmenu === "order"}
        side={submenuSide}
        onOpen={() => setOpenSubmenu("order")}
        onClose={() => setOpenSubmenu((current) => current === "order" ? null : current)}
      >
        <ContextMenuButton icon={<BringToFront size={14} />} shortcut={arrangeShortcutLabels?.front} onClick={() => onArrange("front")}>{tChrome("shapeStyle.arrange.front")}</ContextMenuButton>
        <ContextMenuButton icon={<MoveUp size={14} />} shortcut={arrangeShortcutLabels?.forward} onClick={() => onArrange("forward")}>{tChrome("shapeStyle.arrange.forward")}</ContextMenuButton>
        <ContextMenuButton icon={<MoveDown size={14} />} shortcut={arrangeShortcutLabels?.backward} onClick={() => onArrange("backward")}>{tChrome("shapeStyle.arrange.backward")}</ContextMenuButton>
        <ContextMenuButton icon={<SendToBack size={14} />} shortcut={arrangeShortcutLabels?.back} onClick={() => onArrange("back")}>{tChrome("shapeStyle.arrange.back")}</ContextMenuButton>
      </ContextMenuSubmenu>
      <ContextMenuSubmenu
        icon={<RotateCw size={14} />}
        label={tShape("menu.rotate")}
        open={openSubmenu === "rotation"}
        side={submenuSide}
        onOpen={() => setOpenSubmenu("rotation")}
        onClose={() => setOpenSubmenu((current) => current === "rotation" ? null : current)}
      >
        <ContextMenuButton icon={<RotateCw size={14} />} onClick={() => onTransform("rotateClockwise")}>{tShape("menu.rotateRight")}</ContextMenuButton>
        <ContextMenuButton icon={<RotateCcw size={14} />} onClick={() => onTransform("rotateCounterclockwise")}>{tShape("menu.rotateLeft")}</ContextMenuButton>
        <ContextMenuButton icon={<FlipHorizontal2 size={14} />} onClick={() => onTransform("horizontal")}>{tShape("menu.flipHorizontal")}</ContextMenuButton>
        <ContextMenuButton icon={<FlipVertical2 size={14} />} onClick={() => onTransform("vertical")}>{tShape("menu.flipVertical")}</ContextMenuButton>
      </ContextMenuSubmenu>

      {canAlign && (
        <>
          <div className="overlay-shape-context-menu-separator" role="separator" />
          <div className="overlay-shape-context-menu-grid" role="group" aria-label={tShape("menu.align")}>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyStart size={14} />} onClick={() => onAlign("left")}>{tShape("menu.alignLeft")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyCenter size={14} />} onClick={() => onAlign("center")}>{tShape("menu.alignCenter")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignHorizontalJustifyEnd size={14} />} onClick={() => onAlign("right")}>{tShape("menu.alignRight")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyStart size={14} />} onClick={() => onAlign("top")}>{tShape("menu.alignTop")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyCenter size={14} />} onClick={() => onAlign("middle")}>{tShape("menu.alignMiddle")}</ContextMenuButton>
            <ContextMenuButton compact icon={<AlignVerticalJustifyEnd size={14} />} onClick={() => onAlign("bottom")}>{tShape("menu.alignBottom")}</ContextMenuButton>
          </div>
        </>
      )}

      {canDistribute && (
        <>
          <div className="overlay-shape-context-menu-separator" role="separator" />
          <ContextMenuButton icon={<AlignHorizontalDistributeCenter size={14} />} onClick={() => onDistribute("horizontal")}>{tShape("menu.distributeHorizontal")}</ContextMenuButton>
          <ContextMenuButton icon={<AlignVerticalDistributeCenter size={14} />} onClick={() => onDistribute("vertical")}>{tShape("menu.distributeVertical")}</ContextMenuButton>
        </>
      )}

      <div className="overlay-shape-context-menu-separator" role="separator" />
      {onSaveAsMaterial && <ContextMenuButton icon={<PackagePlus size={14} />} onClick={onSaveAsMaterial}>{tShape("menu.saveAsMaterial")}</ContextMenuButton>}
      <ContextMenuButton icon={<Copy size={14} />} onClick={onDuplicate}>{tShape("menu.duplicate")}</ContextMenuButton>
      <ContextMenuButton icon={<Trash2 size={14} />} onClick={onDelete} danger>{tShape("menu.delete")}</ContextMenuButton>
    </div>
  );
}

function ContextMenuSubmenu({
  icon,
  label,
  open,
  side,
  onOpen,
  onClose,
  children,
}: {
  icon: ReactNode;
  label: string;
  open: boolean;
  side: "left" | "right";
  onOpen: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [panelPosition, setPanelPosition] = useState<{ left: number; top: number } | null>(null);
  const cancelScheduledClose = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);
  const openAndKeepOpen = useCallback(() => {
    cancelScheduledClose();
    onOpen();
  }, [cancelScheduledClose, onOpen]);
  const scheduleCloseIfPointerLeft = useCallback(() => {
    cancelScheduledClose();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      if (!rootRef.current?.matches(":hover") && !panelRef.current?.matches(":hover")) {
        onClose();
      }
    }, 300);
  }, [cancelScheduledClose, onClose]);
  const focusFirstItem = () => {
    requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>("[role='menuitem']")?.focus());
  };

  useLayoutEffect(() => {
    if (!open) {
      return;
    }

    const positionPanel = () => {
      const trigger = triggerRef.current?.getBoundingClientRect();
      const panel = panelRef.current?.getBoundingClientRect();
      if (!trigger || !panel) {
        return;
      }
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth);
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const margin = 8;
      const preferredLeft = side === "right"
        ? trigger.right - 3
        : trigger.left - panel.width + 3;
      const preferredTop = trigger.top - 5;
      setPanelPosition({
        left: Math.min(Math.max(preferredLeft, viewportLeft + margin), viewportRight - panel.width - margin),
        top: Math.min(Math.max(preferredTop, viewportTop + margin), viewportBottom - panel.height - margin),
      });
    };

    positionPanel();
    window.addEventListener("resize", positionPanel);
    window.visualViewport?.addEventListener("resize", positionPanel);
    return () => {
      window.removeEventListener("resize", positionPanel);
      window.visualViewport?.removeEventListener("resize", positionPanel);
    };
  }, [open, side]);

  useEffect(() => () => cancelScheduledClose(), [cancelScheduledClose]);

  return (
    <div
      ref={rootRef}
      className="overlay-shape-context-submenu"
      onMouseEnter={openAndKeepOpen}
      onMouseLeave={scheduleCloseIfPointerLeft}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget) && !panelRef.current?.contains(event.relatedTarget)) {
          onClose();
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        onFocus={openAndKeepOpen}
        onClick={() => open ? onClose() : openAndKeepOpen()}
        onKeyDown={(event) => {
          if (event.key === "ArrowRight" || event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openAndKeepOpen();
            focusFirstItem();
          }
        }}
      >
        <span aria-hidden="true">{icon}</span>
        <span>{label}</span>
        <ChevronRight size={14} className="overlay-shape-context-menu-caret" aria-hidden="true" />
      </button>
      {open && typeof document !== "undefined" && createPortal((
        <div
          ref={panelRef}
          className="overlay-shape-context-submenu-panel"
          role="menu"
          aria-label={label}
          style={{
            left: panelPosition?.left ?? 0,
            top: panelPosition?.top ?? 0,
            visibility: panelPosition ? "visible" : "hidden",
          }}
          onMouseEnter={cancelScheduledClose}
          onMouseLeave={scheduleCloseIfPointerLeft}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget) && !rootRef.current?.contains(event.relatedTarget)) {
              onClose();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" || event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              onClose();
              triggerRef.current?.focus();
            }
          }}
        >
          {children}
        </div>
      ), document.body)}
    </div>
  );
}

function ContextMenuButton({
  icon,
  children,
  danger = false,
  compact = false,
  disabled = false,
  shortcut,
  onClick,
}: {
  icon: ReactNode;
  children: ReactNode;
  danger?: boolean;
  compact?: boolean;
  disabled?: boolean;
  shortcut?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-label={typeof children === "string" ? children : undefined}
      className={`${danger ? "danger" : ""} ${compact ? "compact" : ""}`.trim()}
      disabled={disabled}
      onClick={onClick}
    >
      <span aria-hidden="true">{icon}</span>
      <span>{children}</span>
      {shortcut && <kbd>{shortcut}</kbd>}
    </button>
  );
}

function SnapGuides({ guides }: { guides: OverlaySnapGuide[] }) {
  const lineGuides = guides.filter((guide): guide is Extract<OverlaySnapGuide, { type: "line" }> => guide.type === "line");
  if (lineGuides.length === 0) {
    return null;
  }

  return (
    <svg className="overlay-snap-guides" aria-hidden="true">
      {lineGuides.map((guide, index) => (
        <line
          key={`line-${guide.axis}-${guide.value}-${index}`}
          className="overlay-snap-guide-line"
          x1={guide.axis === "x" ? guide.value : guide.start}
          y1={guide.axis === "x" ? guide.start : guide.value}
          x2={guide.axis === "x" ? guide.value : guide.end}
          y2={guide.axis === "x" ? guide.end : guide.value}
        />
      ))}
    </svg>
  );
}

function reanchorShapesAgainstCanvas(
  shapes: OverlayShape[],
  canvasEl: HTMLDivElement | null,
  coordHeight: number,
  coordWidth: number,
  blockAnchorScope: ParentNode | null = null,
): OverlayShape[] {
  if (!canvasEl) {
    return shapes;
  }

  const scope = blockAnchorScope ?? canvasEl.closest(".page-canvas") ?? canvasEl.ownerDocument;
  const { ordered } = measureBlockTops(canvasEl, scope, coordHeight, coordWidth);
  if (ordered.length === 0) {
    return shapes;
  }

  return reanchorShapesAgainstMeasuredBlocks(
    shapes,
    ordered,
    calculateReserveSpaceGaps(shapes),
  );
}

const PREVIEW_SHAPE_ID = "__overlay_insert_preview__";
function getDrawingHint(
  mode: OverlayInteractionMode,
  curveDrawing: Extract<OverlayInteractionMode, { id: "overlay.curveDrawing" }> | null,
  canClose: boolean,
  t: Translate<"shape">,
): string | null {
  const tool = getOverlayTool(mode);
  if (tool.kind !== "insert" || !isClickPointDrawingTool(tool)) {
    return null;
  }
  const command = tool.command as ClickPointDrawingCommand;
  // `features/drawing` は記述子しか返さない (`@/lib/*` を import できない層なので)。
  // 文言に直すのはここ。
  const hint = getCurveDrawingHint(curveDrawing
    ? { kind: "drawing", command, pointCount: curveDrawing.points.length, canClose }
    : { kind: "armed", command });
  return t(
    `drawingHint.${hint.id}` as never,
    ("values" in hint ? hint.values : {}) as never,
  ) as unknown as string;
}

/**
 * The vertices placed so far, while a click-to-place tool is running.
 *
 * Display only — `pointer-events: none` — because the hit testing for these tools lives in
 * `handleCanvasPointerDown` and must stay there. The enlarged first marker is the only thing that
 * makes the 10px "click here to close the shape" target visible at all.
 */
function CurveDrawingMarkers({
  points,
  current,
  closeArmed,
}: {
  points: OverlayPoint[];
  current: OverlayPoint;
  closeArmed: boolean;
}) {
  return (
    <div className="overlay-drawing-markers" aria-hidden="true">
      {points.map((point, index) => (
        <div
          key={index}
          className={`overlay-drawing-vertex-marker ${index === 0 && closeArmed ? "close-target" : ""}`}
          style={{ left: point.x, top: point.y }}
        />
      ))}
      {!closeArmed && (
        <div className="overlay-drawing-vertex-marker pending" style={{ left: current.x, top: current.y }} />
      )}
    </div>
  );
}

function InsertDragPreview({
  tool,
  start,
  current,
  points,
  closed,
  bounds,
  assets,
  styleDefaults,
}: {
  tool: InsertTool;
  start: OverlayPoint;
  current: OverlayPoint;
  points?: OverlayPoint[];
  closed?: boolean;
  bounds: OverlayBounds;
  assets: Record<string, OverlayAsset>;
  /** The remembered style, already filtered for this tool, so the preview looks like the result. */
  styleDefaults: Partial<OverlayShapeStyleDefaults>;
}) {
  const previewShape = buildInsertShape(
    tool,
    start,
    current,
    PREVIEW_SHAPE_ID,
    points,
    closed,
    styleDefaults,
  );
  if (!previewShape) {
    return null;
  }

  const shapeBounds = getShapeBounds(previewShape);
  return (
    <>
      <div
        className="overlay-insert-preview-frame"
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.w,
          height: bounds.h,
        }}
      />
      <div
        className="overlay-insert-preview-shape overlay-shape"
        style={{
          left: shapeBounds.x,
          top: shapeBounds.y,
          width: shapeBounds.w,
          height: shapeBounds.h,
        }}
      >
        <ShapeBody
          shape={previewShape}
          assets={assets}
          bounds={shapeBounds}
          externalRevision={0}
          editing={false}
          disableGraphCrop
          hideGraphAxes={previewShape.type === GRAPH_SHAPE_TYPE}
          originPickPreview={null}
          onGraphSpecChange={noopGraphSpecChange}
          onGraphCropEnd={noopGraphCropEnd}
        />
      </div>
    </>
  );
}



function normalizeBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : undefined;
}

interface AnchorIndicatorCopy {
  title: string;
  body: string;
}

function getAnchorIndicatorCopy(indicator: AnchorIndicator, t: Translate<"shape">): AnchorIndicatorCopy {
  if (indicator.state === "page") {
    return { title: t("anchor.noneTitle"), body: t("anchor.noneBody") };
  }
  if (indicator.state === "shape") {
    return { title: t("anchor.shapeTitle"), body: t("anchor.shapeBody") };
  }
  if (indicator.state === "missing") {
    return { title: t("anchor.missingTitle"), body: t("anchor.missingBody") };
  }
  return {
    title: indicator.below ? t("anchor.belowTitle") : t("anchor.aboveTitle"),
    body: t("anchor.belowBody"),
  };
}

function getAnchorIndicatorAriaLabel(state: AnchorIndicatorState, t: Translate<"shape">): string {
  if (state === "block") return t("anchor.moveBody");
  if (state === "shape") return t("anchor.connectShapeToBody");
  if (state === "missing") return t("anchor.relink");
  return t("anchor.connectToBody");
}

function AnchorIndicators({
  indicators,
  onAnchorPointerDown,
}: {
  indicators: AnchorIndicator[];
  onAnchorPointerDown: (event: ReactPointerEvent<HTMLButtonElement>, shape: OverlayShape, origin: OverlayPoint) => void;
}) {
  const tShape = useT("shape");
  const [revealedShapeId, setRevealedShapeId] = useState<OverlayShapeId | null>(null);

  return (
    <>
      {indicators.map((indicator) => {
        const revealed = indicator.dragging || revealedShapeId === indicator.shape.id;
        const copy = getAnchorIndicatorCopy(indicator, tShape);
        const tooltipId = `overlay-anchor-tip-${indicator.shape.id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
        const className = [
          "overlay-anchor-handle",
          `state-${indicator.state}`,
          indicator.dragging ? "dragging" : "",
          indicator.below ? "" : "above",
        ].filter(Boolean).join(" ");
        return (
          <Fragment key={`anchor-handle-${indicator.shape.id}`}>
            {revealed && indicator.targetRect && indicator.targetRect.height > 0 && (
              <div
                className={`overlay-anchor-target${indicator.dragging ? " dragging" : ""}`}
                style={{
                  left: indicator.targetRect.left,
                  top: indicator.targetRect.top,
                  width: indicator.targetRect.width,
                  height: indicator.targetRect.height,
                }}
              />
            )}
            {indicator.leader && revealed && (
              <AnchorLeaderLine leader={indicator.leader} state={indicator.state} />
            )}
            <button
              type="button"
              className={className}
              style={{
                left: indicator.rule.left,
                top: indicator.rule.y,
                width: indicator.rule.width,
                ["--overlay-anchor-grip-x" as string]: `${indicator.gripX - indicator.rule.left}px`,
              }}
              data-overlay-anchor-handle=""
              data-overlay-shape-id={indicator.shape.id}
              data-anchor-block-id={indicator.blockId}
              data-anchor-state={indicator.state}
              aria-label={getAnchorIndicatorAriaLabel(indicator.state, tShape)}
              aria-describedby={tooltipId}
              onBlur={() => setRevealedShapeId((current) => current === indicator.shape.id ? null : current)}
              onFocus={() => setRevealedShapeId(indicator.shape.id)}
              onMouseEnter={() => setRevealedShapeId(indicator.shape.id)}
              onMouseLeave={() => setRevealedShapeId((current) => current === indicator.shape.id ? null : current)}
              onPointerDown={(event) => onAnchorPointerDown(
                event,
                indicator.shape,
                { x: indicator.gripX, y: indicator.rule.y },
              )}
            >
              <span className="overlay-anchor-rule" aria-hidden="true" />
              <span className="overlay-anchor-grip" aria-hidden="true">
                <GripHorizontal size={12} strokeWidth={2.4} />
              </span>
              <span id={tooltipId} className="overlay-anchor-tip" role="tooltip">
                <span className="overlay-anchor-tip-title">{copy.title}</span>
                <span className="overlay-anchor-tip-body">{copy.body}</span>
              </span>
            </button>
          </Fragment>
        );
      })}
    </>
  );
}

/** Dashed elbow tying the anchor rule to the figure it holds. */
function AnchorLeaderLine({ leader, state }: { leader: AnchorLeader; state: AnchorIndicatorState }) {
  const left = Math.min(leader.x1, leader.x2) - 4;
  // Padded on both axes: a rule that runs level with the figure makes the elbow almost flat, and a
  // viewBox of zero height stops an SVG from rendering at all.
  const top = Math.min(leader.y1, leader.y2) - 4;
  const width = Math.abs(leader.x2 - leader.x1) + 8;
  const height = Math.abs(leader.y2 - leader.y1) + 8;
  const x1 = leader.x1 - left;
  const x2 = leader.x2 - left;
  const y1 = leader.y1 - top;
  const y2 = leader.y2 - top;
  const midY = (y1 + y2) / 2;
  return (
    <svg
      className={`overlay-anchor-leader state-${state}`}
      style={{ left, top, width, height }}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
    >
      <path d={`M ${x1} ${y1} V ${midY} H ${x2} V ${y2}`} />
      <circle cx={x2} cy={y2} r={2.5} />
    </svg>
  );
}

function SelectionBox({
  shapes,
  allShapes,
  bounds,
  resizable,
  rotatable,
  cropShape,
  dragTranslate,
  movingShapeIds,
  onResizePointerDown,
  onImageCropResizePointerDown,
  onRotatePointerDown,
  onPointPointerDown,
  onLineInsertPointerDown,
}: {
  shapes: OverlayShape[];
  /** Every shape on the canvas, so a selected group can be expanded to the members it draws. */
  allShapes: OverlayShape[];
  bounds: OverlayBounds;
  resizable: boolean;
  rotatable: boolean;
  cropShape: Extract<OverlayShape, { type: "image" }> | null;
  dragTranslate: OverlayPoint | null;
  movingShapeIds: ReadonlySet<OverlayShapeId> | null;
  onResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>, handle: ResizeHandle) => void;
  onImageCropResizePointerDown: (event: ReactPointerEvent<HTMLDivElement>, shape: Extract<OverlayShape, { type: "image" }>, handle: ResizeHandle) => void;
  onRotatePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onPointPointerDown: (event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, handle: PointHandle) => void;
  onLineInsertPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    shape: Extract<OverlayShape, { type: "line" }>,
    index: number,
    point: OverlayPoint,
  ) => void;
}) {
  const onlyShape = shapes.length === 1 ? shapes[0] : null;
  const rotation = onlyShape ? getShapeRotation(onlyShape) : 0;
  const transformOrigin = onlyShape && rotation ? getSelectionTransformOrigin(onlyShape, bounds) : undefined;
  const pointOnly = onlyShape ? hasPointOnlySelection(onlyShape) : false;
  // どの持ち手を出すかは「その図形が動かせる軸」で決まる (`getResizeHandleSet`)。
  // 図中テキストは幅だけなので左右のみ — 高さは内容から決まるので、上下や角をドラッグしても
  // 次の計測で戻ってしまう。
  const resizeHandles = getResizeHandleSet(shapes);
  const multi = shapes.length > 1;
  const outerTranslate = dragTranslate && shapes.every((shape) => movingShapeIds?.has(shape.id)) ? dragTranslate : null;
  const handleStyle = getAdaptiveSelectionHandleStyle(bounds, pointOnly);
  return (
    <>
      {multi && shapes.map((shape) => {
        // 個別の枠も見えている範囲に合わせる。回転は下の transformOrigin + CSS が担うので、
        // ここでは回転前の実描画範囲を渡す。グループは自分では何も描かないので、メンバーまで
        // 展開しないと保存済みの箱 (= 肥大した円全体) に落ちてしまう。
        const shapeBounds = shape.type === "group"
          ? getShapesVisualBounds([shape], allShapes) ?? getShapeVisualBounds(shape)
          : getShapeVisualBounds(shape);
        const shapeRotation = getShapeRotation(shape);
        const shapeTransformOrigin = shapeRotation
          ? getSelectionTransformOrigin(shape, shapeBounds)
          : undefined;
        const shapeTranslate = movingShapeIds?.has(shape.id) ? dragTranslate : null;
        return (
          <div
            key={`item-${shape.id}`}
            className={`overlay-selection-box ${hasPointOnlySelection(shape) ? "point-only" : ""}`}
            style={{
              left: shapeBounds.x,
              top: shapeBounds.y,
              width: shapeBounds.w,
              height: shapeBounds.h,
              transform: composeShapeTransform(shapeRotation, shapeTranslate),
              transformOrigin: shapeTransformOrigin,
            }}
            aria-hidden="true"
          />
        );
      })}
      <div
        className={`overlay-selection-box ${pointOnly ? "point-only" : ""} ${multi ? "multi" : ""} ${cropShape ? "image-cropping" : ""}`}
        style={{
          left: bounds.x,
          top: bounds.y,
          width: bounds.w,
          height: bounds.h,
          transform: composeShapeTransform(rotation, outerTranslate),
          transformOrigin,
          ...handleStyle,
        }}
        aria-hidden="true"
      >
        {!cropShape && !pointOnly && rotatable && (
          <div
            className="overlay-rotate-handle"
            onPointerDown={onRotatePointerDown}
          >
            <RotateCw size={12} strokeWidth={2.2} />
          </div>
        )}
        {onlyShape && !cropShape && (
          <PointHandles
            shape={onlyShape}
            bounds={bounds}
            onPointPointerDown={onPointPointerDown}
            onLineInsertPointerDown={onLineInsertPointerDown}
          />
        )}
        {cropShape && (
          <ImageCropHandles
            shape={cropShape}
            bounds={bounds}
            onPointerDown={onImageCropResizePointerDown}
          />
        )}
        {!cropShape && !pointOnly && resizable && (
          <>
            {[
              ...resizeHandles.visible.map((handle) => ({ handle, hitOnly: false })),
              ...resizeHandles.hitOnly.map((handle) => ({ handle, hitOnly: true })),
            ].map(({ handle, hitOnly }) => (
              <div
                key={handle}
                className={`overlay-resize-handle ${handle} ${hitOnly ? "hit-only" : ""}`}
                // Corners are placed by CSS; edges have to be sized to the box.
                style={isCornerResizeHandle(handle) ? undefined : getEdgeResizeHandleStyle(handle, bounds)}
                onPointerDown={(event) => onResizePointerDown(event, handle)}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function ImageCropHandles({
  shape,
  bounds,
  onPointerDown,
}: {
  shape: Extract<OverlayShape, { type: "image" }>;
  bounds: OverlayBounds;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>, shape: Extract<OverlayShape, { type: "image" }>, handle: ResizeHandle) => void;
}) {
  return (
    <>
      {EDGE_RESIZE_HANDLES.map((handle) => (
        <div
          key={`crop-${handle}`}
          className={`overlay-crop-handle ${handle}`}
          style={getEdgeResizeHandleStyle(handle, bounds)}
          onPointerDown={(event) => onPointerDown(event, shape, handle)}
        />
      ))}
      {CORNER_RESIZE_HANDLES.map((handle) => (
        <div
          key={`crop-${handle}`}
          className={`overlay-crop-handle ${handle}`}
          onPointerDown={(event) => onPointerDown(event, shape, handle)}
        />
      ))}
    </>
  );
}

function getEdgeResizeHandleStyle(handle: ResizeHandle, bounds: OverlayBounds): CSSProperties | undefined {
  if (handle === "n" || handle === "s") {
    return {
      "--overlay-resize-handle-length": `${getAdaptiveEdgeHandleLength(bounds.w)}px`,
      // Physical sides on purpose: the stylesheet places these with `left`/`right`, and a logical
      // property would swap axes under a vertical writing mode and move the strip off its edge.
      left: `${getEdgeResizeHandleInsetPx(bounds.w)}px`,
      right: `${getEdgeResizeHandleInsetPx(bounds.w)}px`,
    } as CSSProperties;
  }
  if (handle === "e" || handle === "w") {
    return {
      "--overlay-resize-handle-length": `${getAdaptiveEdgeHandleLength(bounds.h)}px`,
      top: `${getEdgeResizeHandleInsetPx(bounds.h)}px`,
      bottom: `${getEdgeResizeHandleInsetPx(bounds.h)}px`,
    } as CSSProperties;
  }
  return undefined;
}

/**
 * How far an edge handle's grab strip is held back from the two corners it runs between.
 *
 * The stylesheet's 12px keeps the strip clear of the corner handles on a normal box, but it is a
 * subtraction: on a short box it takes the whole strip and leaves only the drawn pill to grab. A
 * one-line text shape is exactly that box, and since a text shape has no corner handles to fall
 * back on, the strip is the only way to resize it. So the inset yields once the box is short
 * enough that it would eat the strip. Where the two do overlap the corner still wins — corners are
 * drawn on the layer above (`.overlay-resize-handle` vs the edges' `z-index: 1`).
 */
function getEdgeResizeHandleInsetPx(axisLength: number): number {
  const MIN_GRAB_LENGTH = 12;
  return Math.max(0, Math.min(12, (axisLength - MIN_GRAB_LENGTH) / 2));
}

function getAdaptiveEdgeHandleLength(axisLength: number): number {
  const availableLength = Math.max(8, axisLength - 24);
  const maxLength = Math.min(48, availableLength);
  const minLength = Math.min(12, maxLength);
  return Math.round(clamp(axisLength * 0.24, minLength, maxLength));
}

function getSelectionTransformOrigin(shape: OverlayShape, selectionBounds: OverlayBounds): string {
  const pivot = getShapeRotationPivot(shape);
  return `${pivot.x - selectionBounds.x}px ${pivot.y - selectionBounds.y}px`;
}

function getAnchorDragPosition(mode: Extract<OverlayInteractionMode, { id: "overlay.anchor" }>): OverlayPoint {
  return {
    x: mode.origin.x + mode.current.x - mode.start.x,
    y: mode.origin.y + mode.current.y - mode.start.y,
  };
}

/** Anchor a dropped rule snaps to; null when there is no measurable body text. */
function pickAnchorForHandleDrop(
  shape: OverlayShape,
  dropPoint: OverlayPoint,
  measurements: AnchorMeasurements,
): OverlayAnchor | null {
  const boundary = pickAnchorBoundaryAtPoint(dropPoint, measurements.ordered, getShapeBounds(shape).y);
  const block = boundary ? measurements.rects.get(boundary.blockId) : undefined;
  if (!boundary || !block) {
    return null;
  }

  const anchor = buildBlockAnchorAtBoundary(boundary, block, shape.y, shape.x);
  return shape.anchor?.type === "block" && shape.anchor.reserveSpace !== undefined
    ? { ...anchor, reserveSpace: shape.anchor.reserveSpace }
    : anchor;
}

function anchorMeasurementKey(blocks: MeasuredBlock[]): string {
  return blocks
    .map((block) => [
      block.id,
      Math.round(block.top * 10) / 10,
      block.left === undefined ? "" : Math.round(block.left * 10) / 10,
      block.width === undefined ? "" : Math.round(block.width * 10) / 10,
      block.height === undefined ? "" : Math.round(block.height * 10) / 10,
      block.lines?.map((line) => [
        line.index,
        Math.round(line.top * 10) / 10,
        Math.round(line.height * 10) / 10,
      ].join("/")).join(",") ?? "",
    ].join(":"))
    .join("|");
}

function graphSvgPointFromClient(
  shape: OverlayGraphShape,
  clientX: number,
  clientY: number,
  pagePointFromClient: (clientX: number, clientY: number) => OverlayPoint,
): OverlayPoint | null {
  const pagePoint = pagePointFromClient(clientX, clientY);
  const unrotatedPoint = pagePointToUnrotatedShapePoint(
    pagePoint,
    getShapeRotationPivot(shape),
    getShapeRotation(shape),
    shape.flipX,
    shape.flipY,
  );
  const plotPoint = {
    x: unrotatedPoint.x - shape.x,
    y: unrotatedPoint.y - shape.y,
  };

  if (
    plotPoint.x < 0 ||
    plotPoint.x > shape.props.w ||
    plotPoint.y < 0 ||
    plotPoint.y > shape.props.h
  ) {
    return null;
  }

  const layout = getGraphRenderLayout(shape);
  return {
    x: layout.plotBox.left + plotPoint.x / layout.scaleX,
    y: layout.plotBox.top + plotPoint.y / layout.scaleY,
  };
}

function areOriginPickPreviewsEqual(a: OriginPickPreview | null, b: OriginPickPreview | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }

  return a.shapeId === b.shapeId &&
    a.point.x === b.point.x &&
    a.point.y === b.point.y &&
    areGraphViewBoxesEqual(a.spec.viewBox, b.spec.viewBox);
}

function areGraphViewBoxesEqual(a: Graph2DSpec["viewBox"], b: Graph2DSpec["viewBox"]): boolean {
  return a.xMin === b.xMin &&
    a.xMax === b.xMax &&
    a.yMin === b.yMin &&
    a.yMax === b.yMax;
}

function getSnappablePointHandlePagePoint(shape: OverlayShape, handle: PointHandle): OverlayPoint | null {
  if (shape.type === "line" && handle.type === "line") {
    const point = shape.props.points[handle.index];
    return point ? { x: shape.x + point.x, y: shape.y + point.y } : null;
  }

  if (shape.type === "arrow" && handle.type === "arrow") {
    const point = shape.props[handle.endpoint];
    return { x: shape.x + point.x, y: shape.y + point.y };
  }

  return null;
}

function getConstrainedInsertDragPoint(
  tool: InsertTool,
  start: OverlayPoint,
  point: OverlayPoint,
  modifiers: Pick<KeyboardEvent | ReactPointerEvent<HTMLDivElement>, "ctrlKey" | "shiftKey">,
): OverlayPoint {
  const regularAspect = modifiers.ctrlKey ? getRegularInsertAspect(tool) : null;
  if (regularAspect !== null) {
    return constrainPointToAspectFromStart(start, point, regularAspect);
  }

  if (modifiers.shiftKey && isAngleSnappedInsertTool(tool)) {
    return snapPointAround(start, point);
  }

  // arc/sector も、Shiftを押している間だけドラッグ方向を15°刻みにスナップする。
  if (isArcInsertTool(tool)) {
    return getSnappedArcInsertDragPoint(start, point, modifiers.shiftKey);
  }

  return point;
}

function getAdjustmentDragReadout(
  mode: OverlayInteractionMode,
  shapes: OverlayShape[],
  pointerPosition: OverlayPoint | null,
  styleDefaults: OverlayShapeStyleDefaults,
  t: Translate<"shape">,
): { text: string; position: OverlayPoint } | null {
  if (!pointerPosition) {
    return null;
  }

  if (mode.id === "overlay.point" && isShapeAdjustmentHandle(mode.handle)) {
    const shapeId = mode.shape.id;
    const liveShape = shapes.find((shape) => shape.id === shapeId);
    if (!liveShape) {
      return null;
    }
    // 記述子で受けて、ここで表示言語に直す。
    const readout = getShapeAdjustmentReadout(liveShape, mode.handle);
    if (!readout) {
      return null;
    }
    return {
      text: t(`adjustment.${readout.id}` as never, { replace: readout.values } as never) as unknown as string,
      position: pointerPosition,
    };
  }

  if (mode.id === "overlay.insertDrag" && isArcInsertTool(mode.tool)) {
    const previewShape = buildInsertShape(
      mode.tool,
      mode.start,
      mode.current,
      PREVIEW_SHAPE_ID,
      undefined,
      false,
      pickStyleDefaultsForInsert(mode.tool.command, styleDefaults),
    );
    if (previewShape?.type !== "arc") {
      return null;
    }
    return {
      text: getArcDragReadoutText(previewShape, "both"),
      position: pointerPosition,
    };
  }

  return null;
}

function OverlayDragReadout({ text, position }: { text: string; position: OverlayPoint }) {
  return (
    <div
      className="overlay-drag-readout"
      style={{ left: position.x + 16, top: position.y + 16 }}
    >
      {text}
    </div>
  );
}

function isComposingKeyboardEvent(event: KeyboardEvent): boolean {
  return event.isComposing || event.key === "Process" || event.keyCode === 229;
}

function applySelectionUnitTransforms(
  allShapes: OverlayShape[],
  fromUnits: OverlayShape[],
  toUnits: OverlayShape[],
): OverlayShape[] {
  const nextById = new Map(allShapes.map((shape) => [shape.id, shape]));
  for (let index = 0; index < fromUnits.length; index += 1) {
    const from = fromUnits[index];
    const to = toUnits[index];
    if (!from || !to) {
      continue;
    }
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (dx === 0 && dy === 0) {
      continue;
    }
    const ids = isOverlayGroupShape(from)
      ? getIdsWithDescendants(allShapes, [from.id], { includeGroups: true })
      : [from.id];
    for (const id of ids) {
      const shape = nextById.get(id);
      if (shape && !isShapeLockedInTree(allShapes, shape)) {
        nextById.set(id, moveShape(shape, dx, dy));
      }
    }
  }
  return allShapes.map((shape) => nextById.get(shape.id) ?? shape);
}

function unlockVisibleShape(shape: OverlayShape): OverlayShape {
  const next = { ...shape };
  delete next.locked;
  delete next.hidden;
  return next;
}

/** ページ固定を「行き先未定」に戻した複製。`anchor` のキーごと落とす。 */
function withoutPageAnchor(shape: OverlayShape): OverlayShape {
  if (shape.anchor?.type !== "page") {
    return shape;
  }
  const next = { ...shape };
  delete next.anchor;
  return next;
}

function isTextInputTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) {
    return false;
  }

  const tagName = target.tagName.toLowerCase();
  if (target instanceof HTMLInputElement && (target.type === "file" || target.type === "hidden")) {
    return false;
  }
  return (
    tagName === "input" ||
    tagName === "textarea" ||
    target.closest("[contenteditable='true'], math-field") !== null
  );
}

function areOverlayTextBlocksEqual(
  left: readonly OverlayTextBlock[],
  right: readonly OverlayTextBlock[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function areImageCropStatesEqual(
  left: Extract<OverlayShape, { type: "image" }>,
  right: Extract<OverlayShape, { type: "image" }>,
  asset: OverlayAsset | undefined,
): boolean {
  if (
    left.x !== right.x ||
    left.y !== right.y ||
    left.props.w !== right.props.w ||
    left.props.h !== right.props.h
  ) {
    return false;
  }

  const leftCrop = getImageCoverCrop(left, asset);
  const rightCrop = getImageCoverCrop(right, asset);
  return leftCrop.topLeft.x === rightCrop.topLeft.x &&
    leftCrop.topLeft.y === rightCrop.topLeft.y &&
    leftCrop.bottomRight.x === rightCrop.bottomRight.x &&
    leftCrop.bottomRight.y === rightCrop.bottomRight.y;
}

function getModeStatus(mode: OverlayInteractionMode, selectedCount: number): OverlayModeStatus {
  if (mode.id === "overlay.move") {
    return { id: "overlay.move", labelId: "moving" };
  }

  if (mode.id === "overlay.resize") {
    return { id: "overlay.resize", labelId: "resizing" };
  }

  if (mode.id === "overlay.rotate") {
    return { id: "overlay.rotate", labelId: "rotating" };
  }

  if (mode.id === "overlay.anchor") {
    return { id: "overlay.anchor", labelId: "anchoring" };
  }

  if (mode.id === "overlay.marquee") {
    return { id: "overlay.marquee", labelId: "marquee" };
  }

  if (mode.id === "overlay.textEditing") {
    return { id: "overlay.textEditing", labelId: "textEditing" };
  }

  if (mode.id === "overlay.imageCropping" || mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") {
    return { id: "overlay.imageCropping", labelId: "imageCropping" };
  }

  if (mode.id === "overlay.graphEditing") {
    return { id: "overlay.graphEditing", labelId: "graphEditing" };
  }

  if (mode.id === "overlay.graph3dEditing") {
    return { id: "overlay.graph3dEditing", labelId: "graph3dEditing" };
  }

  if (mode.id === "overlay.tableEditing") {
    return { id: "overlay.tableEditing", labelId: "tableEditing" };
  }

  if (mode.id === "overlay.originPicking") {
    return { id: "overlay.originPicking", labelId: "originPicking" };
  }

  if (mode.id === "overlay.graphFillPicking") {
    return { id: "overlay.graphFillPicking", labelId: "fillPicking" };
  }

  if (mode.id === "overlay.curveDrawing") {
    if (mode.tool.command === "threePointArc") {
      return { id: "overlay.curveDrawing", labelId: "threePointArc" };
    }
    return { id: "overlay.curveDrawing", labelId: mode.tool.command === "polyline" ? "polyline" : "curve" };
  }

  if (mode.id === "overlay.insertDrag") {
    return {
      id: "overlay.insertDrag",
      labelId: mode.tool.command === "graph" || mode.tool.command === "graph3d" ? "pickViewport" : "placeShape",
    };
  }

  if (mode.tool.kind === "insert") {
    return { id: "overlay.select", labelId: "insert" };
  }

  return { id: "overlay.select", labelId: selectedCount > 0 ? "select" : "shape" };
}

function getImageCropModeShapeId(mode: OverlayInteractionMode): OverlayShapeId | null {
  if (mode.id === "overlay.imageCropping") {
    return mode.shapeId;
  }
  if (mode.id === "overlay.imageCropResize" || mode.id === "overlay.imageCropPan") {
    return mode.shape.id;
  }
  return null;
}

/** Which shapes a style request may touch: the selection minus anything locked. */
function getStyleTargetIds(
  shapes: OverlayShape[],
  selectedIds: OverlayShapeId[],
  editPolicyLockedShapeIds: ReadonlySet<OverlayShapeId>,
): Set<string> {
  const selected = new Set(getIdsWithDescendants(shapes, selectedIds, { includeGroups: false }));
  const targets = new Set<string>();
  for (const shape of shapes) {
    if (selected.has(shape.id)
      && !isShapeLockedInTree(shapes, shape)
      && !isShapeEditPolicyLockedInTree(shapes, shape, editPolicyLockedShapeIds)) {
      targets.add(shape.id);
    }
  }
  return targets;
}
