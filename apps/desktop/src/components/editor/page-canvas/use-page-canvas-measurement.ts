"use client";
import { type TextFlowBoxFragmentSourceLayout } from "@/components/editor/TextFlowEditor";
import type { PageMetrics,SigmaDocument } from "@/features/document";
import { normalizeOverlaySnapshot,PAGE_GAP_PX,type PageOverlay } from "@/features/document";
import { getShapeBounds } from "@/features/drawing";
import { EDITOR_ZOOM_CHANGE_EVENT } from "@/features/rendering/adapters/editor-zoom-event";
import {
  buildFlowModel,
  placeFlow,
  planFlowRender,
  type FlowColumnRulePiece,
  type FlowDisplacement,
  type TextFlowColumnBlockLayout,
} from "@/features/rendering/core";
import { collectManualBreakHostIds } from "@/features/text-editing";
import { collectBlocksById } from "@/lib/document-tree";
import { countPerformanceEvent,measurePerformance } from "@/lib/performance";
import type { Dispatch,RefObject,SetStateAction } from "react";
import { useCallback,useEffect,useLayoutEffect,useMemo,useRef,useState } from "react";
import {
  reanchorAfterDeletion,
  resolveShapeAnchorPositions,
  resolveShapesPosition,
  type BlockExtent,
} from "../overlay-canvas/anchor";
import { attachUnanchoredShapesToMeasuredBlocks } from "../overlay-canvas/reanchor-model";
import { endBlockSpaceAfterPreview } from "../text-flow/block-space-after-preview";
import { isTextFlowMeasurementReady,TEXT_FLOW_MEASUREMENT_READY } from "../text-flow/measurement-revision";
import { type BlockAffordanceHover,type BlockSpaceAfterTarget } from "./block-affordances";
import { hasBreakBefore } from "./block-ops";
import {
  createInitialPageLayoutSnapshot,
  getNodeDisplacementsKey,
  readFlowDisplacementSignature,
  sameColumnRulePieces,
  sameDisplacementMap,
} from "./flow-presentation";
import { createFlowProbeCache,probeFlow } from "./flow-probe";
import {
  canMeasureIncrementally,
  MAX_CONSECUTIVE_INCREMENTAL_MEASURES,
  resolveMeasureScope,
  type FlowMeasurement,
} from "./incremental-layout";
import {
  sameBlockExtentMap,
  sameEditorBoxBlockFragmentLayouts,
  sameGapMap,
  sameMeasuredBlockMap,
  sameNumberMap,
  samePageMetrics,
  sameProblemAreaColumnLayouts,
  sameProblemAreaFrameFragmentLayouts,
  sameTextFlowBlockLayouts,
  sameTextFlowBoxFragmentSourceLayouts,
  sameUnitLayouts,
} from "./layout-equality";
import {
  calculateReserveSpaceGaps,
  measureBoxLayoutSectionSideNotes,
  measureFlowBlocks,
  type LineMeasureCache,
} from "./layout-measure";
import { type PageLayoutSnapshot } from "./layout-snapshot";
import { resolveOverlayBleed } from "./overlay-bleed";
import { waitForSpaceAfterCommitPaint } from "./space-after-commit-paint";
import { SpaceAfterDragSession } from "./space-after-drag-session";
import type {
  EditorBoxBlockFragmentLayout,
  FlowUnitLayout,
  ProblemAreaColumnLayout,
  ProblemAreaFrameFragmentLayout,
  RenderUnit,
} from "./types";

interface MeasurementDocument {
  pageDocument: SigmaDocument;
  units: RenderUnit[];
  historyRevision: number;
  overlay: PageOverlay;
  overlaySource: PageOverlay | undefined;
  pendingDeletion: { revision: number; deletedIds: string[] } | null;
  onReanchorOverlay: (overlay: PageOverlay) => void;
  /**
   * フロー内の拡張ノードの並びと中身の版 (`PageCanvasInlineContent.measureRevision`)。拡張ノードは
   * 文書ではないので、中身が同じ高さで変わっても文書の変化・ResizeObserver のどちらも鳴らない。
   */
  extensionMeasureKey?: string;
}
interface MeasurementGeometry {
  metrics: PageMetrics;
  zoom: number;
  fontSize: number;
  isWhiteboard: boolean;
  isPagedRender: boolean;
}
interface MeasurementSurface {
  flowRef: RefObject<HTMLDivElement | null>;
  canvasRef: RefObject<HTMLDivElement | null>;
  flowElement: HTMLDivElement | null;
}
interface SpaceAfterMeasurementInteraction {
  spaceAfterSessionRef: RefObject<SpaceAfterDragSession>;
  setSpaceAfterDrag: Dispatch<SetStateAction<{ target: BlockSpaceAfterTarget; followerUnitIds: ReadonlySet<string> } | null>>;
  setBlockAffordance: Dispatch<SetStateAction<BlockAffordanceHover>>;
}
interface PageCanvasMeasurementInputs {
  content: MeasurementDocument;
  geometry: MeasurementGeometry;
  surface: MeasurementSurface;
  spaceAfter: SpaceAfterMeasurementInteraction;
}

/** Owns the one flow measurement/pagination session and all its asynchronous resources. */
export function usePageCanvasMeasurement({ content, geometry, surface, spaceAfter }: PageCanvasMeasurementInputs) {
  const { pageDocument, units, historyRevision, overlay, overlaySource, pendingDeletion, onReanchorOverlay, extensionMeasureKey = "" } = content;
  const { metrics, zoom, fontSize, isWhiteboard, isPagedRender } = geometry;
  const { flowRef, canvasRef, flowElement } = surface;
  const { spaceAfterSessionRef, setSpaceAfterDrag, setBlockAffordance } = spaceAfter;
  const pageHeightPx = metrics.page.heightPx;
  const pageWidthPx = metrics.page.widthPx;
  const marginTopPx = metrics.margins.topPx;
  const contentHeightPx = metrics.content.heightPx;
  const isColumnPage = metrics.flow.columnCount > 1;

  const layoutInput = useMemo(() => ({
    documentId: pageDocument.docId, content: pageDocument.content, geometry: metrics, zoom, fontSize,
  }), [pageDocument.docId, pageDocument.content, metrics, zoom, fontSize]);

  const [layoutViewState, setLayoutViewState] = useState<PageLayoutSnapshot>(() => createInitialPageLayoutSnapshot(pageHeightPx));

  /** 次のレイアウトフェーズで、遅延ではなく同期でページ割りを取り直す予約。 */
  const { nodeDisplacements, unitDisplacements } = layoutViewState;
  const paginateBeforePaintRef = useRef(false);

  const layoutViewStateRef = useRef(layoutViewState);

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

  const flowProbeCacheRef = useRef(createFlowProbeCache());

  /** 変位が変わったことだけを理由に予約した測り直しが、まだ走っていない。 */
  const displacementRemeasurePendingRef = useRef(false);

  /** 直前に走った測り直しが、変位の変化だけを理由にしたものだった。 */
  const lastRecomputeWasDisplacementRemeasureRef = useRef(false);

  const fontRevisionRef = useRef(0);

  // 手動改ページは紙面の印ではなく文書から読む (PDF の出力面には印が描かれない)。
  const breakBeforeIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, block] of collectBlocksById(pageDocument.content)) {
      if (block.type !== "listItem" && hasBreakBefore(block)) ids.add(id);
    }
    return ids;
  }, [pageDocument.content]);

  const breakBeforeIdsRef = useRef(breakBeforeIds);

  // 入れ子の区切りを探す最上位ブロックを文書から絞る (計測で引用・リスト・箱の中を毎回歩かない)。
  const breakHostIds = useMemo(() => collectManualBreakHostIds(pageDocument.content), [pageDocument.content]);

  const breakHostIdsRef = useRef(breakHostIds);

  useLayoutEffect(() => {
    breakBeforeIdsRef.current = breakBeforeIds;
    breakHostIdsRef.current = breakHostIds;
  }, [breakBeforeIds, breakHostIds]);

  const onReanchorOverlayRef = useRef(onReanchorOverlay);

  const lastHandledDeletionRef = useRef(0);

  const [bleed, setBleed] = useState({ x: 0, top: 0 });

  const previousBleedRef = useRef(bleed);

  const recomputeFrameRef = useRef<number | null>(null);

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
  }, [flowRef]);

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
    // 描かれていない本文 (display: none の中など、矩形がすべて 0) は測らない。0 の矩形から
    // 「表示位置 − 与えた変位」を読むと、変位を与えるたびに自然位置が同じだけずれて、
    // 測り直しが止まらない。描かれた時点で ResizeObserver が測り直しを起こす。
    const flowRect = flow.getBoundingClientRect();
    if (flowRect.width <= 0 || flowRect.height <= 0) {
      return "unavailable";
    }
    const selfTriggered = displacementRemeasurePendingRef.current;
    displacementRemeasurePendingRef.current = false;
    lastRecomputeWasDisplacementRemeasureRef.current = selfTriggered;

    const zoomFactor = zoom / 100;
    const pageStride = pageHeightPx + PAGE_GAP_PX;
    const incrementalEligible = canMeasureIncrementally(units, false);
    // 前回の計測を持ち越せるのは、描かれている変位が同じときだけ (変位が変われば表示位置が変わる)。
    const appliedSpacerSignature = readFlowDisplacementSignature(flow);

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
    const nextLayouts: Record<string, FlowUnitLayout> = {};
    const nextBlockLayouts: Record<string, TextFlowColumnBlockLayout> = {};
    let nextBoxBlockFragmentLayouts: Record<string, EditorBoxBlockFragmentLayout[]> = {};
    let nextBoxFragmentSourceLayouts: Record<string, TextFlowBoxFragmentSourceLayout> = {};
    let nextFrameFragmentLayouts: Record<string, ProblemAreaFrameFragmentLayout[]> = {};
    const nextMarkerLayouts: Record<string, FlowUnitLayout> = {};
    const nextAreaLayouts: Record<string, ProblemAreaColumnLayout> = {};
    let nextColumnRulePieces: Record<string, FlowColumnRulePiece[]> = {};
    let nextUnitDisplacements: Record<string, FlowDisplacement> = {};
    let nextNodeDisplacements: Record<string, FlowDisplacement> = {};
    let nextVisualEnds: Record<string, number> = {};
    let nextSideNoteLabelYs: Record<string, number> = {};
    let nextMarkerDisplacements: Record<string, FlowDisplacement> = {};

    {
      // 開ループのページ割り: 自然配置を読む → 行モデル → 配置 → 描画の指示。
      // 変位はレイアウトに影響しない translate なので、この計測は前回の答えに依存しない。
      const tree = measurePerformance("PageCanvasEditor.probeFlow", () => probeFlow(flow, {
        zoomFactor,
        breakIds: breakBeforeIdsRef.current,
        breakHostIds: breakHostIdsRef.current,
        cache: flowProbeCacheRef.current,
        cacheEpoch: fontRevisionRef.current,
      }));
      const built = buildFlowModel(tree, { breakTarget: isColumnPage ? "column" : "page" });
      const placement = placeFlow(built.model, {
        pageHeight: pageHeightPx,
        pageGap: PAGE_GAP_PX,
        contentTop: marginTopPx,
        contentHeight: contentHeightPx,
        contentLeft: metrics.margins.leftPx,
        contentWidth: metrics.content.widthPx,
        columnCount: metrics.flow.columnCount,
        columnWidth: isColumnPage ? metrics.flow.columnWidthPx : metrics.content.widthPx,
        columnGap: isColumnPage ? metrics.flow.columnGapPx : 0,
      });
      // 印刷・PDF の面は改ページの印を描かないので、印の場所で入れ物の片を切らない。
      const flowPlan = planFlowRender(built, placement, { hideManualBreakMarkers: isPagedRender });
      if (placement.diagnostics.tallLines.length > 0) {
        countPerformanceEvent("PageCanvasEditor.tallLineOverflow");
      }
      nextBoxBlockFragmentLayouts = flowPlan.fragmentReplicas;
      nextBoxFragmentSourceLayouts = flowPlan.fragmentSources;
      nextFrameFragmentLayouts = flowPlan.framePieces;
      nextColumnRulePieces = flowPlan.columnRulePieces;
      nextUnitDisplacements = flowPlan.unitDisplacements;
      nextNodeDisplacements = flowPlan.nodeDisplacements;
      nextVisualEnds = flowPlan.visualEnds;
      nextSideNoteLabelYs = flowPlan.sideNoteLabelYs;
      nextMarkerDisplacements = flowPlan.markerDisplacements;
      nextGaps = {};
      textPageCount = flowPlan.pageCount;
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
        sameBlockExtentMap(current.blockExtents, extents) &&
        sameDisplacementMap(current.unitDisplacements, nextUnitDisplacements) &&
        sameDisplacementMap(current.nodeDisplacements, nextNodeDisplacements) &&
        sameColumnRulePieces(current.columnRulePieces ?? {}, nextColumnRulePieces) &&
        sameNumberMap(current.visualEnds, nextVisualEnds) &&
        sameNumberMap(current.sideNoteLabelYs, nextSideNoteLabelYs) &&
        sameDisplacementMap(current.markerDisplacements, nextMarkerDisplacements)
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
        columnRulePieces: nextColumnRulePieces,
        unitDisplacements: nextUnitDisplacements,
        nodeDisplacements: nextNodeDisplacements,
        visualEnds: nextVisualEnds,
        sideNoteLabelYs: nextSideNoteLabelYs,
        markerDisplacements: nextMarkerDisplacements,
      };
      layoutViewStateRef.current = next;
      return next;
    });
    return "measured";
  }, [flowRef, zoom, pageHeightPx, units, pageDocument.docId, marginTopPx, isColumnPage, contentHeightPx, metrics.margins.leftPx, metrics.content.widthPx, metrics.flow.columnCount, metrics.flow.columnWidthPx, metrics.flow.columnGapPx, isPagedRender, pageWidthPx, layoutInput]);

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
  }, [bleed, canvasRef]);

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
    // ほかの理由の予約と同じ frame に畳まれたら、変位の変化だけが理由の測り直しではない。
    displacementRemeasurePendingRef.current = false;
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
  }, [spaceAfterSessionRef]);

  useLayoutEffect(() => {
    scheduleRecomputeRef.current = scheduleRecompute;
  }, [scheduleRecompute]);

  // 拡張ノードの中身が変わったら 1 回測り直す。行の計測キャッシュは要素の版 (`data-flow-measure-revision`)
  // で捨てるので、高さが同じでも行の位置を読み直す。
  const lastExtensionMeasureKeyRef = useRef(extensionMeasureKey);
  useLayoutEffect(() => {
    if (lastExtensionMeasureKeyRef.current === extensionMeasureKey) return;
    lastExtensionMeasureKeyRef.current = extensionMeasureKey;
    scheduleRecomputeRef.current();
  }, [extensionMeasureKey]);

  // 変位はレイアウトに影響しないので ResizeObserver は鳴らない。配置が変わったコミットの後に
  // 1 回測り直して、図形のアンカー・キャレット・つまみが使う表示位置を新しい配置に揃える
  // (自然配置は変わらないので、測り直しても配置は同じ答えになる)。
  const displacementSignature = useMemo(
    () => `${getNodeDisplacementsKey(unitDisplacements)}#${getNodeDisplacementsKey(nodeDisplacements)}`,
    [nodeDisplacements, unitDisplacements],
  );

  const lastDisplacementSignatureRef = useRef(displacementSignature);

  useLayoutEffect(() => {
    if (lastDisplacementSignatureRef.current === displacementSignature) return;
    lastDisplacementSignatureRef.current = displacementSignature;
    // この測り直し自体が変位を変えたなら追いかけない。正しく描かれていれば測り直しは同じ答えに
    // なるので、ここへ来るのは表示位置が変位に追従しない環境 (座標を持たない DOM 実装など) だけ。
    // 追いかけると「表示位置 − 変位」が毎回ずれて止まらない。編集・リサイズの測り直しは別に起きる。
    if (lastRecomputeWasDisplacementRemeasureRef.current) return;
    scheduleRecomputeRef.current();
    displacementRemeasurePendingRef.current = true;
  }, [displacementSignature]);

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
  }, [markFullMeasureDirty, spaceAfterSessionRef]);

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
  }, [setSpaceAfterDrag, spaceAfterSessionRef, thawSpaceAfterRecompute]);

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
  }, [canvasRef, flowRef, setBlockAffordance, setSpaceAfterDrag, spaceAfterSessionRef, thawSpaceAfterRecompute]);

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
      previous.overlay !== overlaySource;
    structuralRecomputeDepsRef.current = {
      metrics,
      zoom,
      fontSize,
      historyRevision,
      overlay: overlaySource,
    };

    if (structuralChanged) {
      // 掴んだままズーム・余白・用紙・フォント・undo が動いた。ドラッグの起点 (px と拡大率) は
      // pointerdown で固定しているので、続行すると換算が合わない値をコミットしてしまう。
      // 可逆な側 = 破棄に倒す。
      if (spaceAfterSessionRef.current.isFrozen) {
        cancelBlockSpaceAfterDragRef.current();
      }
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
  }, [overlaySource, fontSize, historyRevision, markFullMeasureDirty, metrics, recompute, scheduleRecompute, units, zoom, spaceAfterSessionRef]);

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
  return {
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
  };
}
