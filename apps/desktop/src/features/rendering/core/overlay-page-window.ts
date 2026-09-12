import type {
  OverlayBounds,
  OverlayShape,
  OverlayShapeId,
  OverlayStackLayer,
} from "@/features/document";

export type OverlayPreviewStackLayer = OverlayStackLayer | "all";

export interface VisiblePageRange {
  start: number;
  end: number;
  overscan: number;
}

export interface OverlayPageSlice {
  pageIndex: number;
  shapeIds: OverlayShapeId[];
}

export interface OverlayPageWindow {
  pageSlicesByLayer: Record<
    OverlayPreviewStackLayer,
    OverlayPageSlice[]
  >;
  visibleShapesByLayer: Record<
    OverlayPreviewStackLayer,
    OverlayShape[]
  >;
}

export function getVisibleOverlayShapes(
  view: OverlayPageWindow,
  stackLayer: OverlayPreviewStackLayer,
  visiblePageRange: VisiblePageRange,
  pinnedShapeIds: readonly OverlayShapeId[] = [],
): OverlayShape[] {
  const pinned = new Set(pinnedShapeIds);
  const visibleIds = new Set<OverlayShapeId>();
  for (const slice of view.pageSlicesByLayer[stackLayer]) {
    if (
      slice.pageIndex < visiblePageRange.start
      || slice.pageIndex > visiblePageRange.end
    ) {
      continue;
    }
    for (const id of slice.shapeIds) {
      visibleIds.add(id);
    }
  }

  if (pinned.size === 0) {
    return view.visibleShapesByLayer[stackLayer]
      .filter((shape) => visibleIds.has(shape.id));
  }

  return view.visibleShapesByLayer[stackLayer]
    .filter((shape) => visibleIds.has(shape.id) || pinned.has(shape.id));
}

export function createOverlayPageSlices(
  shapes: OverlayShape[],
  boundsById: ReadonlyMap<OverlayShapeId, OverlayBounds>,
  options: {
    pageGapPx: number;
    pageHeightPx: number;
  },
): OverlayPageSlice[] {
  const pageShapeIds = new Map<number, OverlayShapeId[]>();
  for (const shape of shapes) {
    const bounds = boundsById.get(shape.id);
    if (!bounds) {
      continue;
    }
    const { start, end } = getShapePageSpan(
      bounds,
      options.pageHeightPx,
      options.pageGapPx,
    );
    for (let pageIndex = start; pageIndex <= end; pageIndex += 1) {
      const ids = pageShapeIds.get(pageIndex) ?? [];
      ids.push(shape.id);
      pageShapeIds.set(pageIndex, ids);
    }
  }

  return Array.from(pageShapeIds.entries())
    .sort(([a], [b]) => a - b)
    .map(([pageIndex, shapeIds]) => ({ pageIndex, shapeIds }));
}

/**
 * 図形がまたぐページ番号の範囲。編集モードの窓化も読み取り専用プレビューと同じ判定を使う
 * (別々に持つと「プレビューには出るが編集面には出ない」種類のズレができる)。
 */
export function getShapePageSpan(
  bounds: OverlayBounds,
  pageHeightPx: number,
  pageGapPx: number,
): { start: number; end: number } {
  const pageStride = pageHeightPx + pageGapPx;
  const top = Math.max(0, bounds.y);
  const bottom = Math.max(top, bounds.y + bounds.h);
  const start = Math.max(0, Math.floor(top / pageStride));
  const end = Math.max(
    start,
    Math.floor(Math.max(0, bottom - 1) / pageStride),
  );
  return { start, end };
}
