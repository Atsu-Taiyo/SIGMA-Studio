"use client";
import { useMemo } from "react";
import { OverlayShapeContextMenu } from "./overlay-canvas/context-menu";
import { CurveDrawingMarkers, InsertDragPreview, OverlayDragReadout, TablePlacementPreview } from "./overlay-canvas/insertion-preview";
import { getModeStatus } from "./overlay-canvas/mode-status";
import { readRememberedCalloutCornerRadius } from "./overlay-canvas/remembered-callout-radius";
import { AnchorIndicators, SelectionBox } from "./overlay-canvas/selection-chrome";
import {
  AnchorMeasurements
} from "./overlay-canvas/selection-handles";
import { anchorMeasurementKey } from "./overlay-canvas/snapshot-anchors";
import { hasTablePlacementFeedback } from "./overlay-canvas/table-placement-feedback";
import { useOverlayContextInteraction } from "./overlay-canvas/use-context-interaction";
import { useDocumentSnapshotSync } from "./overlay-canvas/use-document-snapshot-sync";
import { useOverlayExternalRequests } from "./overlay-canvas/use-external-requests";
import { useOverlayGraphLabelController } from "./overlay-canvas/use-graph-label-controller";
import { useOverlayGraphPicking } from "./overlay-canvas/use-graph-picking";
import { useOverlayGraph3DController } from "./overlay-canvas/use-graph3d-controller";
import { useOverlayImageController } from "./overlay-canvas/use-image-controller";
import { useOverlayImageImport } from "./overlay-canvas/use-image-import";
import { useOverlayInsertionController } from "./overlay-canvas/use-insertion-controller";
import { useOverlayKeyboardController } from "./overlay-canvas/use-keyboard-controller";
import { useOverlayClipboard } from "./overlay-canvas/use-overlay-clipboard";
import { useOverlayMutations } from "./overlay-canvas/use-overlay-mutations";
import { useOverlaySaveController } from "./overlay-canvas/use-overlay-save-controller";
import { useOverlaySaveEffects } from "./overlay-canvas/use-overlay-save-effects";
import { useOverlayPointerLifecycle } from "./overlay-canvas/use-pointer-lifecycle";
import { useOverlayPointerSession } from "./overlay-canvas/use-pointer-session";
import { useOverlayPointerStart } from "./overlay-canvas/use-pointer-start";
import { useOverlayPointerTransforms } from "./overlay-canvas/use-pointer-transforms";
import { useOverlaySelectionCommands } from "./overlay-canvas/use-selection-commands";
import { useOverlaySelectionPresentation } from "./overlay-canvas/use-selection-presentation";
import { useOverlayShapeEditorController } from "./overlay-canvas/use-shape-editor-controller";
import { useOverlaySnapshotState } from "./overlay-canvas/use-snapshot-state";
import { useOverlayTextCommands } from "./overlay-canvas/use-text-commands";
import { useOverlayVisibleShapes } from "./overlay-canvas/use-visible-shapes";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useReducer,
  useRef,
  useState
} from "react";
import { createPortal } from "react-dom";
import { useDocumentSession } from "./document-session-context";

import type { Editor as TiptapEditor } from "@tiptap/core";

import {
  OPEN_OVERLAY_CHART_SETTINGS_EVENT,
  OPEN_OVERLAY_GRAPH_SETTINGS_EVENT
} from "@/components/editor/EditorSettings";
import {
  OPEN_OVERLAY_GRAPH3D_SETTINGS_EVENT,
} from "@/components/editor/Graph3DSettingsPanel";
import {
  type PageOverlay
} from "@/features/document";
import {
  boundsIntersect,
  createOverlaySnapGeometry,
  getShapeSelectionBounds,
  hitTestShape,
  isOverlayRichTextShape,
  mergeShapesById,
  pickStyleDefaultsForInsert,
  type OverlayShapeStyleDefaults,
  type OverlaySnapGuide
} from "@/features/drawing";
import { type VisiblePageRange } from "@/features/rendering/core";
import { useT } from "@/lib/i18n/react";
import { SUPPORTED_OVERLAY_IMAGE_MIME_TYPES } from "@/lib/overlay-image-files";
import {
  type DragAutoScrollPanBy
} from "./drag-auto-scroll";
import {
  measureBlockTops,
  resolveShapesPosition,
  type MeasuredBlock
} from "./overlay-canvas/anchor";
import { isOverlayActionBlockedByEditPolicy, isOverlayShapeUnselectable, pruneUnselectableSelection } from "./overlay-canvas/edit-policy";
import { EMPTY_OVERLAY_EDIT_POLICY, type OverlayEditPolicy, type OverlayShapeDecoration } from "./overlay-canvas/editor-extension";
import { focusOverlaySurface } from "./overlay-canvas/focus-overlay-surface";
import {
  getGroupShape,
  getRenderableShapes,
  getRenderableShapesInReverseVisualStackOrder,
  isOverlayGroupShape,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups
} from "./overlay-canvas/grouping";
import {
  createInitialOverlayInteractionMode,
  getEditingShapeId,
  getGraphFillPickShapeId,
  getMoveOffset,
  getOriginPickShapeId,
  isInitialOriginPickMode,
  isInteractionMode,
  overlayInteractionModeReducer,
  type OverlayInteractionAction,
  type OverlayInteractionMode
} from "./overlay-canvas/interaction-mode";
import {
  clamp
} from "./overlay-canvas/math";
import {
  areOverlayAnchorsEqual,
  attachUnanchoredShapesToMeasuredBlocks
} from "./overlay-canvas/reanchor-model";
import { readRememberedShapeStyle, rememberShapeStyle, subscribeRememberedShapeStyle } from "./overlay-canvas/remembered-shape-style";
import { type OverlayArrangeAction } from "./overlay-canvas/reorder-shapes";
import type { OriginPickPreview } from "./overlay-canvas/shape-editors";
import { useOverlayShapeEditorRenderers } from "./overlay-canvas/shape-interactive-body";
import {
  OverlayShapeDimensionLabels,
  OverlayShapeHitTarget,
  OverlayShapeView,
  noopGraphCropEnd,
  noopGraphSpecChange,
  noopShapeDoubleClick,
  noopShapePointerDown
} from "./overlay-canvas/shape-renderer";
import {
  canChangeOverlayShapeType
} from "./overlay-canvas/shape-type-change";
import { DEFAULT_CALLOUT_CORNER_RADIUS } from "./overlay-canvas/shapes/callout";
import {
  GRAPH_SHAPE_EDIT_EVENT
} from "./overlay-canvas/shapes/graph";
import {
  DEFAULT_TABLE_COLUMN_WIDTH,
  DEFAULT_TABLE_ROW_HEIGHT
} from "./overlay-canvas/shapes/table";
import {
  isOpenStrokeShape
} from "./overlay-canvas/style-patch";
import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
  OverlayTool
} from "./overlay-canvas/types";
import { calculateReserveSpaceGaps } from "./page-canvas/layout-measure";
import {
  type OverlayActionRequest,
  type OverlayChangeOptions,
  type OverlayCommandRequest,
  type OverlayImageRequest,
  type OverlayModeStatus,
  type OverlaySelectPointRequest,
  type OverlaySelectionStylePatch,
  type OverlaySelectionSummary,
  type OverlaySolidEdgeSelection
} from "./page-overlay-types";
export {
  OverlayTableShapeEditor,
  OverlayTextShapeEditor,
  type OriginPickPreview,
  type TableShapeResizePatch
} from "./overlay-canvas/shape-editors";
export { OverlayShapeReadOnlyView } from "./overlay-canvas/shape-renderer";

const OPEN_STROKE_POINTER_HIT_MARGIN = 14;
const OVERLAY_SNAP_THRESHOLD_PX = 8;
const IMAGE_INSERT_GAP = 16;
const EMPTY_ANCHOR_MEASUREMENTS: AnchorMeasurements = { rects: new Map(), ordered: [] };
/** Pointer slop that keeps a click on the grip from rewriting the anchor. */
// 8px は押下位置の微小な揺れと本物のドラッグを分ける値。本文選択の
// DRAG_SELECTION_THRESHOLD_PX = 2 より大きいのは、誤爆時に 1px 動くのではなく紙面が飛ぶため。

interface OverlayContextMenuState {
  x: number;
  y: number;
  shapeId: OverlayShapeId;
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
  /** Keep an empty marquee as a coordinate selection for whiteboard hosts. */
  retainEmptySelection?: boolean;
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
  /** Publish this canvas's transient selection to the active document session. */
  publishesSessionPresence?: boolean;
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
  retainEmptySelection = false,
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
  publishesSessionPresence = false,
}: OverlayCanvasEditorClientProps) {
  const tShape = useT("shape");
  const documentSession = useDocumentSession();
  const {
    shapes,
    setShapes,
    assets,
    setAssets,
    canvasWidthRef,
    canvasHeightRef,
    documentIdRef,
    saveTimeoutRef,
    pendingOverlayHistoryRef,
    pendingOverlaySaveHistoryGroupRef,
    imageCropDirtyRef,
    mountedRef,
    suppressNextSaveRef,
    explicitlySavedShapeStatesRef,
    externalRevisionRef,
    lastEmittedSnapshotRef,
    seenDocumentSnapshotRef,
    reconciledDocumentSnapshotRef,
    onChangeRef,
    shapesRef,
    assetsRef,
    extensionsRef,
  } = useOverlaySnapshotState({ overlay, canvasWidth, canvasHeight, documentId, externalRevision, onChange });
  const [selectedIds, setSelectedIds] = useState<OverlayShapeId[]>([]);
  /**
   * 選んでいる立体の辺 (1 つの立体を選んでいるときだけ)。保存はしない一時の選択で、
   * 線種などのスタイル変更が図形全体ではなくこの辺に効く。
   */
  const [solidEdge, setSolidEdgeState] = useState<OverlaySolidEdgeSelection | null>(null);
  const solidEdgeRef = useRef<OverlaySolidEdgeSelection | null>(null);
  /** ポインタの下にある、立体の辺 (選んでいる立体のみ)。もう一度押すと選べることを示す。 */
  const [hoverSolidEdge, setHoverSolidEdge] = useState<OverlaySolidEdgeSelection | null>(null);
  const setSolidEdge = useCallback((next: OverlaySolidEdgeSelection | null) => {
    solidEdgeRef.current = next;
    setSolidEdgeState(next);
  }, []);
  useEffect(() => {
    // 辺は「その立体だけを選んでいる間」の選択。別の図形へ移ったら手放す。
    const current = solidEdgeRef.current;
    if (current && !(selectedIds.length === 1 && selectedIds[0] === current.shapeId)) {
      setSolidEdge(null);
    }
  }, [selectedIds, setSolidEdge]);
  const [regionSelection, setRegionSelection] = useState<{
    documentId: string | undefined;
    revision: number;
    bounds: OverlayBounds;
  } | null>(null);
  /**
   * A style being dragged in the toolbar: drawn, never persisted. See `previewedShapes`.
   *
   * The target ids are captured when the preview starts, so it stays on the figures it was started
   * on instead of following a selection that moves underneath it.
   */
  const [preview, setPreview] = useState<{ style: OverlaySelectionStylePatch; targetIds: Set<string> } | null>(null);
  const insertedTableFocusRef = useRef<OverlayShapeId | null>(null);
  const [contextMenu, setContextMenu] = useState<OverlayContextMenuState | null>(null);
  const [focusedGroupId, setFocusedGroupId] = useState<OverlayShapeId | null>(null);
  const [anchorMeasurements, setAnchorMeasurements] = useState<AnchorMeasurements>(EMPTY_ANCHOR_MEASUREMENTS);
  const [originPickPreview, setOriginPickPreview] = useState<OriginPickPreview | null>(null);
  const [snapGuides, setSnapGuides] = useState<OverlaySnapGuide[]>([]);
  const [appliedSnapshotRevision, setAppliedSnapshotRevision] = useState(0);
  const [mode, dispatchMode] = useReducer(overlayInteractionModeReducer, undefined, createInitialOverlayInteractionMode);
  const selectedRegion = retainEmptySelection && regionSelection && regionSelection.documentId === documentId &&
    regionSelection.revision === externalRevision && selectedIds.length === 0 && mode.id === "overlay.select"
    ? regionSelection.bounds : null;
  const dragOffset = getMoveOffset(mode);
  const editingShapeId = getEditingShapeId(mode);
  const originPickShapeId = getOriginPickShapeId(mode);
  const initialOriginPickShapeId = isInitialOriginPickMode(mode) ? originPickShapeId : null;
  const visibleOriginPickPreview = originPickPreview?.shapeId === originPickShapeId ? originPickPreview : null;
  const graphFillPickShapeId = getGraphFillPickShapeId(mode);
  const bleedSurfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!selectedRegion) return;
    const clearOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRegionSelection(null);
    };
    const clearOutside = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || event.button !== 0 ||
        bleedSurfaceRef.current?.contains(target) ||
        target.closest(".selection-action-popover, [data-preserve-canvas-selection]")) return;
      setRegionSelection(null);
    };
    window.addEventListener("keydown", clearOnEscape, true);
    window.addEventListener("pointerdown", clearOutside, true);
    return () => {
      window.removeEventListener("keydown", clearOnEscape, true);
      window.removeEventListener("pointerdown", clearOutside, true);
    };
  }, [selectedRegion]);
  const activeTextEditorRef = useRef<TiptapEditor | null>(null);
  const textCompositionRef = useRef(false);
  const modeRef = useRef(mode);
  const handledCommandRequestIdRef = useRef<number | null>(null);
  const handledActionRequestIdRef = useRef<number | null>(null);
  const handledSelectPointRequestIdRef = useRef<number | null>(null);
  const imageInsertAreaRef = useRef({ w: imageInsertAreaWidth, h: imageInsertAreaHeight });
  useLayoutEffect(() => {
    imageInsertAreaRef.current = { w: imageInsertAreaWidth, h: imageInsertAreaHeight };
  }, [imageInsertAreaHeight, imageInsertAreaWidth]);
  const selectedIdsRef = useRef(selectedIds);
  const focusedGroupIdRef = useRef(focusedGroupId);
  const anchorMeasurementsRef = useRef(anchorMeasurements);
  const anchorMeasurementKeyRef = useRef("");
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
  const editPolicyUnselectableShapeIds = editPolicy.unselectableShapeIds;
  const editPolicyUnselectableShapeIdsRef = useRef(editPolicyUnselectableShapeIds);
  useEffect(() => {
    editPolicyUnselectableShapeIdsRef.current = editPolicyUnselectableShapeIds;
  }, [editPolicyUnselectableShapeIds]);
  // 機能が人の編集から守っている図形。保存時の付け替え・固定の補修 (派生の書き換え) はこれを書き換えない。
  const editPolicyPreservedShapeIds = editPolicy.preservedShapeIds;
  const editPolicyPreservedShapeIdsRef = useRef(editPolicyPreservedShapeIds);
  useLayoutEffect(() => {
    editPolicyPreservedShapeIdsRef.current = editPolicyPreservedShapeIds;
  }, [editPolicyPreservedShapeIds]);
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
  }, [canvasHeightRef, canvasWidthRef]);

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
  }, [canvasHeightRef, canvasWidthRef, shapesRef, verticalSnapGuides]);

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
    if (!(action.type === "select" && modeRef.current.id === "overlay.marquee")) {
      setRegionSelection(null);
    }
    modeRef.current = overlayInteractionModeReducer(modeRef.current, action);
    dispatchMode(action);
  }, [notifyEditPolicyBlocked, shapesRef]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  const pointerSession = useOverlayPointerSession({ documentId, modeRef, transitionMode, bleedSurfaceRef });
  const {
    dragPointerRef,
    dragCanvasRectRef,
    suppressNextShapeDoubleClickRef,
    dragAutoScrollerRef,
  } = pointerSession;

  const { id: modeStatusId, labelId: modeStatusLabelId } = getModeStatus(mode, selectedIds.length);
  useEffect(() => {
    onModeStatusChange?.({ id: modeStatusId, labelId: modeStatusLabelId });
  }, [modeStatusId, modeStatusLabelId, onModeStatusChange]);

  useEffect(() => {
    onActiveToolChange?.(mode.tool);
  }, [mode.tool, onActiveToolChange]);
  // 最後の固定先の計測 (本文側の実測か自前の計測)。畳んだブロックが最後に描かれていた場所の出どころ。
  const getLastDrawnBlockRects = useCallback(() => anchorMeasurementsRef.current.rects, []);
  const getPreservedShapeIds = useCallback(() => editPolicyPreservedShapeIdsRef.current, []);
  const { queueOverlaySave, clearQueuedOverlaySave, commitOverlayChangeNow, flushOverlayChange, queueDirtyImageCropSave } = useOverlaySaveController({
    syncBlockAnchors,
    shapesRef,
    canvasRef,
    canvasHeightRef,
    canvasWidthRef,
    getBlockAnchorScope,
    getLastDrawnBlockRects,
    getPreservedShapeIds,
    suppressNextSaveRef,
    setShapes,
    assetsRef,
    extensionsRef,
    lastEmittedSnapshotRef,
    onChangeRef,
    imageCropDirtyRef,
    saveTimeoutRef,
    pendingOverlayHistoryRef,
    pendingOverlaySaveHistoryGroupRef
  });

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
      undefined,
      editPolicyPreservedShapeIdsRef.current,
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
  }, [explicitlySavedShapeStatesRef, queueOverlaySave, setShapes, shapesRef, suppressNextSaveRef]);
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
  useOverlaySaveEffects({ assets, shapes, assetsRef, shapesRef, mountedRef, pendingOverlaySaveHistoryGroupRef, explicitlySavedShapeStatesRef, suppressNextSaveRef, commitOverlayChangeNow, queueOverlaySave, flushOverlayChange, saveTimeoutRef, imageCropDirtyRef });

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
    const { rects, ordered } = measureBlockTops(
      el,
      scope,
      canvasHeightRef.current,
      canvasWidthRef.current,
      anchorMeasurementsRef.current.rects,
    );
    if (rects.size === 0) {
      return;
    }

    syncAnchoredShapesToRects(rects, ordered);
  }, [canvasHeightRef, canvasWidthRef, getBlockAnchorScope, syncAnchoredShapesToRects, syncBlockAnchors]);
  const {
    setSelectedShapeIds,
    replaceShape,
    updateShape,
    selectKnownShape,
    selectShape,
    updateGraphShapeSpec,
    toggleShapeSelection,
  } = useOverlayMutations({
    setRegionSelection,
    shapesRef,
    selectedIdsRef,
    setSelectedIds,
    onSelectedCountChange,
    unselectableShapeIdsRef: editPolicyUnselectableShapeIdsRef,
    focusedGroupIdRef,
    transitionMode,
    modeRef,
    activeTextEditorRef,
    explicitlySavedShapeStatesRef,
    setShapes,
    commitOverlayChangeNow,
    queueOverlaySave,
    anchorMeasurementsRef
  });
  // 図形が選べなくなったら (機能が見えなくした)、今の選択から外す。見えない図形に選択の枠と
  // ツールバーを残さない。選択は文書でも編集履歴でもないので、ここで外しても何も保存されない。
  useEffect(() => {
    const pruned = pruneUnselectableSelection(selectedIdsRef.current, shapesRef.current, editPolicyUnselectableShapeIds);
    if (pruned) {
      setSelectedShapeIds(pruned);
    }
  }, [editPolicyUnselectableShapeIds, selectedIdsRef, setSelectedShapeIds, shapesRef]);
  const {
    imageReplacementInputRef,
    startImageCrop,
    requestImageReplacement,
    resetImageCrop,
    restoreImageNaturalSize,
    handleImageReplacementChange,
    setImageOpacity,
  } = useOverlayImageController({
    shapesRef,
    editPolicyLockedShapeIdsRef,
    notifyEditPolicyBlocked,
    setSelectedShapeIds,
    transitionMode,
    documentId,
    assetsRef,
    setShapes,
    setAssets,
    queueOverlaySave,
    replaceShape,
    imageInsertAreaRef,
    updateShape
  });
  const { createShapeFromInsertDrag, finishCurveDrawing, createChartFromTable } = useOverlayInsertionController({
    lastCalloutCornerRadiusRef,
    focusedGroupIdRef,
    shapesRef,
    canvasWidthRef,
    canvasHeightRef,
    suppressNextSaveRef,
    insertedTableFocusRef,
    setShapes,
    selectKnownShape,
    commitOverlayChangeNow,
    queueOverlaySave,
    setSelectedShapeIds,
    transitionMode,
    clearSnapGuides
  });

  const cancelTablePlacement = useCallback(() => {
    insertedTableFocusRef.current = null;
    const pointerId = dragPointerRef.current?.pointerId;
    if (pointerId !== undefined && bleedSurfaceRef.current?.hasPointerCapture(pointerId)) {
      bleedSurfaceRef.current.releasePointerCapture(pointerId);
    }
    dragPointerRef.current = null;
    dragAutoScrollerRef.current?.stop();
    dragAutoScrollerRef.current = null;
    clearSnapGuides();
    transitionMode({ type: "setTool", tool: { kind: "select" } });
  }, [clearSnapGuides, dragAutoScrollerRef, dragPointerRef, transitionMode]);

  const restoreTransientInteraction = useCallback((interaction: OverlayInteractionMode) => {
    const originals = interaction.id === "overlay.resize" || interaction.id === "overlay.rotate"
      ? interaction.shapes
      : interaction.id === "overlay.point" || interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan"
        ? [interaction.shape]
        : [];
    if (originals.length > 0) {
      setShapes((current) => {
        const next = normalizeOverlayGroups(mergeShapesById(current, originals));
        shapesRef.current = next;
        return next;
      });
    }
    if (interaction.id === "overlay.imageCropResize" || interaction.id === "overlay.imageCropPan")
      imageCropDirtyRef.current = false;
    setAdjustmentDragReadoutPointerPosition(null);
    clearSnapGuides();
  }, [clearSnapGuides, imageCropDirtyRef, setShapes, shapesRef]);

  const handleCommandRequest = useCallback((request: OverlayCommandRequest) => {
    if (handledCommandRequestIdRef.current === request.id) {
      return;
    }

    if (request.command === "select") {
      transitionMode({ type: "setTool", tool: { kind: "select" } });
    } else if (request.command === "table") {
      const editor = activeTextEditorRef.current;
      // The cell editor may have been destroyed when toolbar focus ended table editing.
      if (editor && !editor.isDestroyed) editor.commands.blur();
      activeTextEditorRef.current = null;
      transitionMode({
        type: "setTool", tool: {
          kind: "insert",
          command: "table",
          tableCellSize: { w: DEFAULT_TABLE_COLUMN_WIDTH, h: Math.max(36, DEFAULT_TABLE_ROW_HEIGHT) },
        }
      });
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
  useOverlayImageImport({
    documentId,
    imageInsertAreaWidth,
    imageInsertAreaHeight,
    canvasWidthRef,
    canvasHeightRef,
    focusedGroupIdRef,
    shapesRef,
    setAssets,
    assetsRef,
    setShapes,
    setSelectedShapeIds,
    transitionMode,
    queueOverlaySave,
    onImageHandled,
    imageRequest
  });

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
  }, [canvasHeightRef, canvasWidthRef, dragCanvasRectRef]);

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
  }, [canvasHeightRef, canvasWidthRef]);

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
      : measureBlockTops(el, scope, canvasHeightRef.current, canvasWidthRef.current, anchorMeasurementsRef.current.rects);
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
  }, [bodyAnchorableBlocks, bodyBlockRects, canvasHeightRef, canvasWidthRef, getBlockAnchorScope, syncAnchoredShapesToRects]);

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
      if (isOverlayShapeUnselectable(shape.id, editPolicyUnselectableShapeIdsRef.current)) {
        continue;
      }
      if (hitTestShape(shape, point, margin)) {
        return shape;
      }
    }

    return undefined;
  }, [shapesRef]);

  const getOpenStrokeShapeAtPoint = useCallback((point: OverlayPoint): OverlayShape | undefined => {
    for (const shape of getRenderableShapesInReverseVisualStackOrder(shapesRef.current)) {
      if (!isOpenStrokeShape(shape) || isOverlayShapeUnselectable(shape.id, editPolicyUnselectableShapeIdsRef.current)) {
        continue;
      }
      if (hitTestShape(shape, point, OPEN_STROKE_POINTER_HIT_MARGIN)) {
        return shape;
      }
    }

    return undefined;
  }, [shapesRef]);
  const {
    duplicateSelectedShapes,
    deleteSelectedShapes,
    arrangeSelectedShapes,
    alignSelectedShapes,
    distributeSelectedShapes,
    groupSelectedShapes,
    ungroupSelectedShapes,
    setSelectedShapesLocked,
    setSelectedShapesHidden,
    applyStyleToSelectedShapes,
    applyPastedOverlayShapes,
    reanchorShapesToCopiedBlocks,
    getRemovableSelectedShapeIds,
    applyQuickTransformToSelectedShapes,
  } = useOverlaySelectionCommands({
    shapesRef,
    selectedIdsRef,
    editPolicyLockedShapeIdsRef,
    notifyEditPolicyBlocked,
    assetsRef,
    canvasWidthRef,
    canvasHeightRef,
    setAssets,
    setShapes,
    setSelectedShapeIds,
    transitionMode,
    queueOverlaySave,
    extensionsRef,
    explicitlySavedShapeStatesRef,
    pendingOverlaySaveHistoryGroupRef,
    commitOverlayChangeNow,
    refreshAnchorMeasurements,
    solidEdgeRef,
    documentIdRef,
    canvasRef,
    getBlockAnchorScope
  });

  /**
   * 種類固有の操作 (画像のトリミング・図形の種類変更など)。実装は右クリックメニューと同じ
   * 関数を使うが、それらは後ろで定義されるので、最新の実装を ref 越しに呼ぶ。
   */
  const extendedActionRunnerRef = useRef<((request: OverlayActionRequest) => void) | null>(null);
  useOverlayExternalRequests({
    handledActionRequestIdRef,
    duplicateSelectedShapes,
    deleteSelectedShapes,
    arrangeSelectedShapes,
    alignSelectedShapes,
    distributeSelectedShapes,
    groupSelectedShapes,
    ungroupSelectedShapes,
    shapesRef,
    selectedIdsRef,
    setSelectedShapesLocked,
    setSelectedShapesHidden,
    setPreview,
    editPolicyLockedShapeIdsRef,
    editPolicyUnselectableShapeIdsRef,
    solidEdgeRef,
    learnShapeStyleDefaults,
    applyStyleToSelectedShapes,
    applyPastedOverlayShapes,
    setFocusedGroupId,
    setSelectedShapeIds,
    refreshAnchorMeasurements,
    transitionMode,
    extendedActionRunnerRef,
    activeTextEditorRef,
    createShapeFromInsertDrag,
    onActionHandled,
    actionRequest,
    handledSelectPointRequestIdRef,
    focusOverlayCanvas,
    onSelectPointHandled,
    getShapeAtPoint,
    getOpenStrokeShapeAtPoint,
    focusedGroupIdRef,
    setShapes,
    queueOverlaySave,
    selectShape,
    documentId,
    selectPointRequest
  });
  useOverlayGraphLabelController({
    setShapes,
    canvasWidthRef,
    canvasHeightRef,
    shapesRef,
    queueOverlaySave,
    selectedIds,
    shapes,
    originPickShapeId,
    graphFillPickShapeId,
    setSelectedShapeIds,
    transitionMode
  });

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
  useOverlayTextCommands({
    shapesRef,
    selectedIdsRef,
    editingShapeId,
    updateShape,
    activeTextEditorRef,
    modeRef
  });
  const editingPort = useMemo(() => ({
    shapesRef,
    updateShape,
    editPolicyLockedShapeIdsRef,
    editPolicyUnselectableShapeIdsRef,
    notifyEditPolicyBlocked,
    setShapes,
    assetsRef,
    replaceShape,
  }), [
    shapesRef,
    updateShape,
    editPolicyLockedShapeIdsRef,
    notifyEditPolicyBlocked,
    setShapes,
    assetsRef,
    replaceShape,
  ]);
  const selectionPort = useMemo(() => ({
    selectedIdsRef,
    focusedGroupIdRef,
    setFocusedGroupId,
    setSelectedShapeIds,
    selectShape,
    toggleShapeSelection,
    setSolidEdge,
    duplicateSelectedShapes,
  }), [
    selectedIdsRef,
    focusedGroupIdRef,
    setFocusedGroupId,
    setSelectedShapeIds,
    selectShape,
    toggleShapeSelection,
    setSolidEdge,
    duplicateSelectedShapes,
  ]);
  const geometryPort = useMemo(() => ({
    pagePointFromClient,
    getOverlaySnapThreshold,
    getShapeAtPoint,
    getOpenStrokeShapeAtPoint,
    clientPointFromPage,
    refreshAnchorMeasurements,
    createSnapGeometry,
    anchorMeasurementsRef,
  }), [
    pagePointFromClient,
    getOverlaySnapThreshold,
    getShapeAtPoint,
    getOpenStrokeShapeAtPoint,
    clientPointFromPage,
    refreshAnchorMeasurements,
    createSnapGeometry,
    anchorMeasurementsRef,
  ]);
  const {
    updateModifierDrivenInteraction,
    getSnappedDrawingPoint,
    applyMoveInteractionAtPoint,
    applyResizeInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyImageCropInteractionAtPoint,
    getSnappedInsertDragPoint,
  } = useOverlayPointerTransforms({
    session: pointerSession,
    editing: editingPort,
    geometry: geometryPort,
    snapDisabledRef,
    setSnapGuides,
    clearSnapGuides,
    lastCalloutCornerRadiusRef,
    imageCropDirtyRef,
  });
  useOverlayKeyboardController({
    textCompositionRef,
    modeRef,
    cancelTablePlacement,
    snapDisabledRef,
    clearSnapGuides,
    updateModifierDrivenInteraction,
    activeTextEditorRef,
    transitionMode,
    queueDirtyImageCropSave,
    finishCurveDrawing,
    restoreTransientInteraction,
    solidEdgeRef,
    setSolidEdge,
    focusedGroupIdRef,
    setFocusedGroupId,
    setSelectedShapeIds,
    shapesRef,
    ungroupSelectedShapes,
    groupSelectedShapes,
    selectedIdsRef,
    duplicateSelectedShapes,
    editPolicyLockedShapeIdsRef,
    notifyEditPolicyBlocked,
    arrangeSelectedShapes,
    refreshAnchorMeasurements,
    setShapes,
    deleteSelectedShapes,
    mode
  });

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
  useOverlayClipboard({
    getBlockAnchorScope,
    activeTextEditorRef,
    shapesRef,
    selectedIdsRef,
    reanchorShapesToCopiedBlocks,
    assetsRef,
    documentIdRef,
    getRemovableSelectedShapeIds,
    pendingOverlaySaveHistoryGroupRef,
    deleteSelectedShapes,
    applyPastedOverlayShapes
  });
  const { updateOriginPickPreviewFromEvent, handleOriginPickPointerDown, handleGraphFillPickPointerDown } = useOverlayGraphPicking({
    shapesRef,
    pagePointFromClient,
    originPickShapeId,
    setOriginPickPreview,
    updateGraphShapeSpec,
    queueOverlaySave,
    transitionMode,
    graphFillPickShapeId
  });
  const drawingPort = useMemo(() => ({
    getSnappedDrawingPoint,
    finishCurveDrawing,
    getSnappedInsertDragPoint,
    createShapeFromInsertDrag,
  }), [
    getSnappedDrawingPoint,
    finishCurveDrawing,
    getSnappedInsertDragPoint,
    createShapeFromInsertDrag,
  ]);
  const transformsPort = useMemo(() => ({
    applyMoveInteractionAtPoint,
    applyResizeInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyImageCropInteractionAtPoint,
  }), [
    applyMoveInteractionAtPoint,
    applyResizeInteractionAtPoint,
    applyPointInteractionAtPoint,
    applyImageCropInteractionAtPoint,
  ]);
  const {
    handleCurveDrawingDoubleClick,
    handleCanvasPointerDown,
    handleShapePointerDown,
    handleResizePointerDown,
    handleImageCropResizePointerDown,
    handleRotatePointerDown,
    handlePointPointerDown,
    handleLineInsertPointerDown,
    handleAnchorPointerDown,
  } = useOverlayPointerStart({
    session: pointerSession,
    editing: editingPort,
    selection: selectionPort,
    geometry: geometryPort,
    drawing: drawingPort,
    focusOverlayCanvas,
    setAdjustmentDragReadoutPointerPosition,
    graphFillPickShapeId,
    selectedRegion,
  });
  const { handlePointerMove, handlePointerCancel, handlePointerUp } = useOverlayPointerLifecycle({
    session: pointerSession,
    editing: editingPort,
    selection: selectionPort,
    geometry: geometryPort,
    drawing: drawingPort,
    transforms: transformsPort,
    clearSnapGuides,
    setAdjustmentDragReadoutPointerPosition,
    canvasRef,
    autoScrollPanBy,
    autoScrollViewportElement,
    originPickShapeId,
    updateOriginPickPreviewFromEvent,
    setHoverSolidEdge,
    mode,
    cancelTablePlacement,
    restoreTransientInteraction,
    setRegionSelection,
    handledCommandRequestIdRef,
    queueOverlaySave,
    documentId,
    onRequestTextMode,
    retainEmptySelection,
    externalRevision,
    onRequestTextSelection,
    queueDirtyImageCropSave,
  });
  const {
    movingShapeIds,
    selectedShapes,
    currentTool,
    selectionChromeHidden,
    selectionImageCropShape,
    selectedDimensionShapes,
    selectionBounds,
    selectionCanResize,
    selectedLocked,
    selectionIsGraphCropping,
    selectionIsGraph3DEditing,
    selectionCanRotate,
    anchorIndicators,
    marqueeBounds,
    insertPreview,
    curveDrawing,
    curveDrawingClosed,
    adjustmentDragReadout,
    drawingHint,
  } = useOverlaySelectionPresentation({
    shapes,
    selectedIds,
    assets,
    editPolicyLockedShapeIds,
    mode,
    initialOriginPickShapeId,
    selectedRegion,
    dragOffset,
    publishesSessionPresence,
    documentSession,
    tShape,
    adjustmentDragReadoutPointerPosition,
    shapeStyleDefaults,
    showAnchorHandles,
    anchorMeasurements,
    canvasWidth,
    canvasHeight,
    bleedValues,
    onSelectionSummaryChange,
    solidEdge,
    acceptsStylePreview,
    setPreview,
    shapesRef,
    selectedIdsRef,
    editPolicyLockedShapeIdsRef
  });
  const { backgroundVisibleShapes, chartSourceTables, foregroundVisibleShapes, selectedIdSet } = useOverlayVisibleShapes({
    selectedIds,
    preview,
    shapes,
    visibleOriginPickPreview,
    movingShapeIds,
    editingShapeId,
    graphFillPickShapeId,
    initialOriginPickShapeId,
    visiblePageRange,
    pageHeightPx,
    pageGapPx
  });
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
  const { handleCanvasContextMenu, handleCanvasDoubleClick, handleShapeDoubleClick, runContextMenuAction, changeSelectedShapeType } = useOverlayContextInteraction({
    shapesRef,
    selectedIdsRef,
    editPolicyLockedShapeIdsRef,
    notifyEditPolicyBlocked,
    setShapes,
    transitionMode,
    queueOverlaySave,
    extendedActionRunnerRef,
    applyQuickTransformToSelectedShapes,
    startImageCrop,
    requestImageReplacement,
    resetImageCrop,
    restoreImageNaturalSize,
    createChartFromTable,
    handleCurveDrawingDoubleClick,
    suppressNextShapeDoubleClickRef,
    graphFillPickShapeId,
    pagePointFromClient,
    focusedGroupIdRef,
    setFocusedGroupId,
    setSelectedShapeIds,
    selectShape,
    modeRef,
    getShapeAtPoint,
    getOpenStrokeShapeAtPoint,
    setContextMenu,
    focusOverlayCanvas
  });
  const {
    handleTableChange,
    handleTableEditorFocus,
    handleTableFirstCellReady,
    handleTableResize,
    handleTextMeasuredHeight,
    handleTextChange,
    handleTextEditorCancel,
    handleTextEditorFocus,
    handleGraphSpecChange,
    handleGraphCropEnd,
  } = useOverlayShapeEditorController({
    activeTextEditorRef,
    selectShape,
    transitionMode,
    shapesRef,
    updateShape,
    updateGraphShapeSpec,
    insertedTableFocusRef
  });

  const shapeEditorRenderers = useOverlayShapeEditorRenderers({
    onCreateChartFromTable: createChartFromTable,
    onGraph3DCameraChange: handleGraph3DCameraChange,
    onGraph3DObjectRotationChange: handleGraph3DObjectRotationChange,
    onGraph3DObjectTransformChange: handleGraph3DObjectTransformChange,
    onGraph3DPreviewReady: handleGraph3DPreviewReady,
    onTableChange: handleTableChange,
    onTableEditorFocus: handleTableEditorFocus,
    onTableFirstCellReady: handleTableFirstCellReady,
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
        setHoverSolidEdge(null);
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
            solidEdge={solidEdge && selectedShapes.length === 1 && selectedShapes[0].id === solidEdge.shapeId ? solidEdge.index : null}
            solidHoverEdge={hoverSolidEdge && selectedShapes.length === 1 && selectedShapes[0].id === hoverSolidEdge.shapeId ? hoverSolidEdge.index : null}
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
            data-retained-region={selectedRegion ? "true" : undefined}
            style={{
              left: marqueeBounds.x,
              top: marqueeBounds.y,
              width: marqueeBounds.w,
              height: marqueeBounds.h,
            }}
          />
        )}

        {mode.id === "overlay.select" && currentTool.kind === "insert" && currentTool.command === "table" && !hasTablePlacementFeedback() && (
          <TablePlacementPreview
            tool={currentTool}
            surfaceRef={bleedSurfaceRef}
            pointFromClient={pagePointFromClient}
            assets={assets}
            styleDefaults={pickStyleDefaultsForInsert("table", shapeStyleDefaults)}
          />
        )}
        {insertPreview && !(insertPreview.tool.command === "table" && hasTablePlacementFeedback()) && (
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

      </div>
    </div>
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

export { mergeOverlayHistoryGroup } from "./overlay-canvas/pending-save";
export { RemoteOverlayPresenceLayer, getRemoteOverlayPresenceLabelBounds, resolveRemoteOverlayPresenceFrames } from "./overlay-canvas/remote-presence";

export { getRemoteOverlayPresenceFrameStyle } from "./overlay-canvas/remote-presence";
