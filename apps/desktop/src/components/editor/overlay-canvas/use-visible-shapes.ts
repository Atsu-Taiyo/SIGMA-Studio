"use client";
import {
  getShapeSelectionBounds
} from "@/features/drawing";
import { getShapePageSpan, type VisiblePageRange } from "@/features/rendering/core";
import {
  useMemo
} from "react";
import {
  type OverlaySelectionStylePatch
} from "../page-overlay-types";
import {
  getEffectiveShapeOpacity,
  getIdsWithDescendants,
  getRenderableShapes,
  getShapesForStackLayer
} from "./grouping";
import type { OriginPickPreview } from "./shape-editors";
import {
  applyStylePatchToShape
} from "./style-patch";
import type {
  OverlayShape,
  OverlayShapeId,
  SigmaTableSpec
} from "./types";

interface Dependencies {
  selectedIds: string[];
  preview: { style: OverlaySelectionStylePatch; targetIds: Set<string>; } | null;
  shapes: OverlayShape[];
  visibleOriginPickPreview: OriginPickPreview | null;
  movingShapeIds: Set<string> | null;
  editingShapeId: string | null;
  graphFillPickShapeId: string | null;
  initialOriginPickShapeId: string | null;
  visiblePageRange: VisiblePageRange | null;
  pageHeightPx: number;
  pageGapPx: number;
}

export function useOverlayVisibleShapes({
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
  pageGapPx,
}: Dependencies) {

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
  return { backgroundVisibleShapes, chartSourceTables, foregroundVisibleShapes, selectedIdSet };
}
