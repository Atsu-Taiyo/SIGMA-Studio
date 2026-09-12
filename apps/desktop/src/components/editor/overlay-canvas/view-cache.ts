import {
  type PageOverlay,
  normalizeOverlaySnapshot,
} from "@/features/document";
import { getShapeBounds } from "@/features/drawing";
import {
  createOverlayPageSlices,
  getRenderableShapes,
  getShapesForStackLayer,
  type OverlayPageSlice,
  type OverlayPageWindow,
  type OverlayPreviewStackLayer,
} from "@/features/rendering/core";

import { resolveShapeAnchorPositions, resolveShapesPosition, type MeasuredBlock } from "./anchor";
import type { OverlayAsset, OverlayBounds, OverlayShape, OverlayShapeId } from "./types";

export {
  createOverlayPageSlices,
  getVisibleOverlayShapes,
} from "@/features/rendering/core";
export type {
  OverlayPageSlice,
  OverlayPageWindow,
  OverlayPreviewStackLayer,
  VisiblePageRange,
} from "@/features/rendering/core";

export interface ResolvedOverlayView extends OverlayPageWindow {
  assets: Record<string, OverlayAsset>;
  boundsById: Map<OverlayShapeId, OverlayBounds>;
  pageSlicesByLayer: Record<OverlayPreviewStackLayer, OverlayPageSlice[]>;
  revision: number;
  shapeById: Map<OverlayShapeId, OverlayShape>;
  shapes: OverlayShape[];
  visibleShapesByLayer: Record<OverlayPreviewStackLayer, OverlayShape[]>;
}

export interface OverlayViewCache {
  view: ResolvedOverlayView;
}

const EMPTY_LAYER_SHAPES: Record<OverlayPreviewStackLayer, OverlayShape[]> = {
  all: [],
  background: [],
  foreground: [],
};

const EMPTY_LAYER_SLICES: Record<OverlayPreviewStackLayer, OverlayPageSlice[]> = {
  all: [],
  background: [],
  foreground: [],
};

// Two resolved shapes render identically when every top-level field matches by
// reference/value. `props`/`anchor` are stable references while only body text
// is edited (the normalized snapshot is cached), so this shallow check is exact.
function resolvedShapesEqual(a: OverlayShape, b: OverlayShape): boolean {
  const keys = Object.keys(a) as Array<keyof OverlayShape>;
  if (keys.length !== Object.keys(b).length) {
    return false;
  }
  for (const key of keys) {
    if (a[key] !== b[key]) {
      return false;
    }
  }
  return true;
}

// A persistent id→shape map carried across renders. Reuses the previous render's
// shape object whenever the freshly-resolved shape is identical. Anchored shapes
// are re-resolved every keystroke (their stored vs. anchored position differs, so
// resolution always allocates), which would change object identity and defeat the
// memoized shape views — re-running katex / graph SVG for hundreds of unchanged
// figures. Reusing identity keeps unchanged figures from re-rendering when typing
// does not move them. The cache is updated in place to hold this render's shapes.
export type OverlayIdentityCache = Map<OverlayShapeId, OverlayShape>;

function reconcileResolvedIdentities(
  next: OverlayShape[],
  identityCache: OverlayIdentityCache | undefined,
): OverlayShape[] {
  if (!identityCache) {
    return next;
  }
  const result = next.map((shape) => {
    const previous = identityCache.get(shape.id);
    return previous && previous !== shape && resolvedShapesEqual(previous, shape) ? previous : shape;
  });
  identityCache.clear();
  for (const shape of result) {
    identityCache.set(shape.id, shape);
  }
  return result;
}

export function createResolvedOverlayView(
  overlay: PageOverlay,
  blockRects: Map<string, MeasuredBlock>,
  options: {
    canvasHeight: number;
    canvasWidth: number;
    pageGapPx: number;
    pageHeightPx: number;
    revision: number;
    reserveSpaceGaps?: Readonly<Record<string, number>>;
  },
  identityCache?: OverlayIdentityCache,
): ResolvedOverlayView {
  if (!overlay.overlaySnapshot) {
    return {
      assets: {},
      boundsById: new Map(),
      // Without a snapshot there is nothing to draw: the snapshot is the overlay's only
      // source (`page-layout.ts` drops overlays that carry no snapshot), so no SVG
      // serializer takes part in this path either.
      pageSlicesByLayer: EMPTY_LAYER_SLICES,
      revision: options.revision,
      shapeById: new Map(),
      shapes: [],
      visibleShapesByLayer: EMPTY_LAYER_SHAPES,
    };
  }

  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  const resolvedShapes = reconcileResolvedIdentities(
    blockRects.size > 0
      ? resolveShapesPosition(snapshot.shapes, blockRects, options.reserveSpaceGaps)
      : resolveShapeAnchorPositions(snapshot.shapes),
    identityCache,
  );
  const allShapes = getRenderableShapes(resolvedShapes);
  const backgroundShapes = getRenderableShapes(getShapesForStackLayer(resolvedShapes, "background"));
  const foregroundShapes = getRenderableShapes(getShapesForStackLayer(resolvedShapes, "foreground"));
  const boundsById = new Map<OverlayShapeId, OverlayBounds>();
  for (const shape of allShapes) {
    boundsById.set(shape.id, getShapeBounds(shape));
  }

  const visibleShapesByLayer = {
    all: allShapes,
    background: backgroundShapes,
    foreground: foregroundShapes,
  } satisfies Record<OverlayPreviewStackLayer, OverlayShape[]>;

  return {
    assets: snapshot.assets,
    boundsById,
    pageSlicesByLayer: {
      all: createOverlayPageSlices(allShapes, boundsById, options),
      background: createOverlayPageSlices(backgroundShapes, boundsById, options),
      foreground: createOverlayPageSlices(foregroundShapes, boundsById, options),
    },
    revision: options.revision,
    shapeById: new Map(allShapes.map((shape) => [shape.id, shape])),
    shapes: allShapes,
    visibleShapesByLayer,
  };
}
