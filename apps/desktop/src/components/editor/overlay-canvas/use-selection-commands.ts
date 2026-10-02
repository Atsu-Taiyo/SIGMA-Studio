"use client";
import type { OverlayExtensions } from "@/features/document";
import {
  pruneUnusedOverlayAssets,
  removeShapes
} from "@/features/document";
import {
  alignShapes,
  distributeShapes,
  fitShapesWithinPage,
  flipShapesAround,
  getSelectionRotationPivot,
  isSolidShape,
  mergeShapesById,
  rotateShapesAround,
  sameOverlayShapeReferences,
  setSolidEdgeDash,
  setSolidEdgeSize,
  type OverlayAlignAction,
  type OverlayDistributeAxis,
  type OverlayFlipAxis
} from "@/features/drawing";
import {
  cloneOverlayShapesForPaste,
  collectClipboardSliceBlockIds,
  createOverlayClipboardPayload,
  type EditorClipboardPayload
} from "@/lib/editor-clipboard";
import type { Dispatch, RefObject, SetStateAction } from "react";
import {
  useCallback
} from "react";
import { calculateReserveSpaceGaps } from "../page-canvas/layout-measure";
import {
  type OverlayChangeOptions,
  type OverlaySelectionStylePatch,
  type OverlaySolidEdgeSelection
} from "../page-overlay-types";
import {
  measureBlockTops,
  resolveShapesPosition,
  type MeasuredBlock
} from "./anchor";
import { isOverlaySelectionBlockedByEditPolicy } from "./edit-policy";
import {
  getIdsWithDescendants,
  getSelectedShapesForClipboard,
  getSelectedShapesInStackOrder,
  getUnlockedTransformShapes,
  groupOverlayShapes,
  isShapeEditPolicyLockedInTree,
  isShapeLockedInTree,
  normalizeOverlayGroups,
  ungroupOverlayShapes
} from "./grouping";
import { createOverlayGroupId } from "./ids";
import {
  type OverlayInteractionAction
} from "./interaction-mode";
import { prepareOverlayShapesForPaste } from "./paste-shapes";
import {
  reanchorShapesByPosition
} from "./reanchor-model";
import { reorderShapes, type OverlayArrangeAction } from "./reorder-shapes";
import { applySelectionUnitTransforms, getStyleTargetIds, unlockVisibleShape, withoutPageAnchor } from "./selection-command-model";
import {
  AnchorMeasurements
} from "./selection-handles";
import {
  getExistingGraphLabelTextShapeIds
} from "./shapes/graph-labels";
import {
  applyStylePatchToShape
} from "./style-patch";
import type {
  OverlayAsset,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export interface Dependencies {
  shapesRef: RefObject<OverlayShape[]>;
  selectedIdsRef: RefObject<string[]>;
  editPolicyLockedShapeIdsRef: RefObject<ReadonlySet<string>>;
  notifyEditPolicyBlocked: () => void;
  assetsRef: RefObject<Record<string, OverlayAsset>>;
  canvasWidthRef: RefObject<number>;
  canvasHeightRef: RefObject<number>;
  setAssets: Dispatch<SetStateAction<Record<string, OverlayAsset>>>;
  setShapes: Dispatch<SetStateAction<OverlayShape[]>>;
  setSelectedShapeIds: (ids: OverlayShapeId[]) => void;
  transitionMode: (action: OverlayInteractionAction) => void;
  queueOverlaySave: (options?: OverlayChangeOptions) => void;
  extensionsRef: RefObject<OverlayExtensions | undefined>;
  explicitlySavedShapeStatesRef: RefObject<WeakSet<OverlayShape[]>>;
  pendingOverlaySaveHistoryGroupRef: RefObject<string | null>;
  commitOverlayChangeNow: (options?: OverlayChangeOptions) => void;
  refreshAnchorMeasurements: () => AnchorMeasurements;
  solidEdgeRef: RefObject<OverlaySolidEdgeSelection | null>;
  documentIdRef: RefObject<string | undefined>;
  canvasRef: RefObject<HTMLDivElement | null>;
  getBlockAnchorScope: () => ParentNode | null;
}

export function useOverlaySelectionCommands({
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
  getBlockAnchorScope,
}: Dependencies) {

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
  }, [assetsRef, canvasHeightRef, canvasWidthRef, editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, queueOverlaySave, selectedIdsRef, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

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
  }, [editPolicyLockedShapeIdsRef, selectedIdsRef, shapesRef]);

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
  }, [assetsRef, commitOverlayChangeNow, editPolicyLockedShapeIdsRef, explicitlySavedShapeStatesRef, extensionsRef, getRemovableSelectedShapeIds, notifyEditPolicyBlocked, pendingOverlaySaveHistoryGroupRef, selectedIdsRef, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, selectedIdsRef, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, selectedIdsRef, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, selectedIdsRef, setShapes, shapesRef]);

  const setSelectedShapesHidden = useCallback((hidden: boolean) => {
    const idSet = new Set(selectedIdsRef.current);
    setShapes((current) => {
      const next = normalizeOverlayGroups(current.map((shape) => (
        idSet.has(shape.id) ? { ...shape, hidden } as OverlayShape : shape
      )));
      shapesRef.current = next;
      return next;
    });
  }, [selectedIdsRef, setShapes, shapesRef]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, selectedIdsRef, setSelectedShapeIds, setShapes, shapesRef]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, refreshAnchorMeasurements, selectedIdsRef, setShapes, shapesRef]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, refreshAnchorMeasurements, selectedIdsRef, setShapes, shapesRef]);

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
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, refreshAnchorMeasurements, selectedIdsRef, setShapes, shapesRef]);

  const applyStyleToSelectedShapes = useCallback((style: OverlaySelectionStylePatch) => {
    if (isOverlaySelectionBlockedByEditPolicy(shapesRef.current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current)) {
      notifyEditPolicyBlocked();
    }
    // 立体の辺を選んでいる間の線種・線の太さは、その辺だけに効く。ほかの項目 (色など) は図形全体のまま。
    const selectedEdge = solidEdgeRef.current;
    const edgeDash = selectedEdge && style.dash !== undefined ? style.dash : undefined;
    const edgeSize = selectedEdge && style.size !== undefined ? style.size : undefined;
    const shapeStyle = edgeDash === undefined && edgeSize === undefined
      ? style
      : {
        ...style,
        ...(edgeDash === undefined ? {} : { dash: undefined }),
        ...(edgeSize === undefined ? {} : { size: undefined }),
      };
    // Anchor measurement and request completion can run before React evaluates a
    // queued updater. Publish the new snapshot first so they cannot restore old styles.
    const current = shapesRef.current;
    const idSet = getStyleTargetIds(current, selectedIdsRef.current, editPolicyLockedShapeIdsRef.current);
    const next = normalizeOverlayGroups(current.map((shape) => {
      if (!idSet.has(shape.id)) {
        return shape;
      }
      const styled = applyStylePatchToShape(shape, shapeStyle);
      if (selectedEdge?.shapeId !== shape.id || !isSolidShape(styled)) {
        return styled;
      }
      const dashed = edgeDash === undefined ? styled : setSolidEdgeDash(styled, selectedEdge.index, edgeDash);
      return edgeSize === undefined ? dashed : setSolidEdgeSize(dashed, selectedEdge.index, edgeSize);
    }));
    shapesRef.current = next;
    setShapes(next);
  }, [editPolicyLockedShapeIdsRef, notifyEditPolicyBlocked, selectedIdsRef, setShapes, shapesRef, solidEdgeRef]);

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
  }, [assetsRef, canvasHeightRef, canvasRef, canvasWidthRef, commitOverlayChangeNow, documentIdRef, explicitlySavedShapeStatesRef, getBlockAnchorScope, setAssets, setSelectedShapeIds, setShapes, shapesRef, transitionMode]);

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
  }, [refreshAnchorMeasurements, selectedIdsRef, shapesRef]);
  return {
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
  };
}
