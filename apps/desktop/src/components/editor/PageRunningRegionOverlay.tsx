import { useMemo } from "react";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { normalizeOverlaySnapshot, type OverlayShape, type PageRunningRegion } from "@/features/document";
import { resolveShapeAnchorPositions } from "@/features/drawing";
import { getEffectiveShapeOpacity, getRenderableShapes } from "@/features/rendering/core";

import { OverlayShapeReadOnlyView } from "./overlay-canvas/shape-renderer";

interface PageRunningRegionOverlayProps {
  overlay: PageRunningRegion["overlay"];
  widthPx: number;
  heightPx: number;
  /** Editing chrome only: the band hands the pointer off to the overlay editor. */
  interactive?: boolean;
  className?: string;
  onPointerDown?: (event: ReactPointerEvent<HTMLDivElement>) => void;
  onDoubleClick?: (event: ReactMouseEvent<HTMLDivElement>) => void;
}

/**
 * Read-only React rendering of the shapes in a header/footer.
 *
 * This replaces the `getOverlayPreviewSvg` string that used to be injected with
 * `dangerouslySetInnerHTML`, so the PDF surface draws running-region shapes with the same
 * components as the body — the last place the PDF path still went through the SVG serializer.
 *
 * Deliberately Tiptap-free: `PageRunningRegionView` reaches `packages/viewer` through
 * `components/print/PrintPreview.tsx`, whose bundle must not contain the editing runtime
 * (`packages/viewer/src/package-boundary.test.ts`). `OverlayShapeReadOnlyView` renders the static
 * shape bodies for exactly that reason.
 */
export function PageRunningRegionOverlay({
  overlay,
  widthPx,
  heightPx,
  interactive = false,
  className,
  onPointerDown,
  onDoubleClick,
}: PageRunningRegionOverlayProps) {
  // Memoized on the stored overlay identity: this layer is cloned once per page in the paged
  // surface, so re-deriving the shape list per render would multiply by the page count.
  const shapes = useMemo(() => {
    const snapshot = overlay?.overlaySnapshot;
    if (!snapshot) {
      return [];
    }
    // Anchors are resolved before the visibility filter, the same order `view-cache.ts` uses: a
    // graph label anchors to its parent graph, and dropping hidden shapes first would leave the
    // label resolving against nothing and falling back to its stale stored position.
    const resolved = resolveShapeAnchorPositions(normalizeOverlaySnapshot(snapshot).shapes);
    // Ancestor group opacity, which the SVG serializer applied and `OverlayShapeView` does not read.
    return getRenderableShapes(resolved).map((shape) => {
      const opacity = getEffectiveShapeOpacity(resolved, shape);
      return opacity === shape.opacity ? shape : { ...shape, opacity } as OverlayShape;
    });
  }, [overlay?.overlaySnapshot]);
  const assets = useMemo(
    () => normalizeOverlaySnapshot(overlay?.overlaySnapshot).assets,
    [overlay?.overlaySnapshot],
  );

  // Rendered unconditionally on the display surface so the paged DOM has the same shape on every
  // page. (`measurePageOwnership` only indexes elements that carry a `data-*` id, so an empty layer
  // is invisible to it — this is about a stable DOM, not about pagination.) The editing band passes
  // `interactive` and therefore only mounts this when there is something to hit.
  return (
    <div
      className={[className ?? "page-running-overlay-preview", interactive ? "interactive" : ""]
        .filter(Boolean)
        .join(" ")}
      aria-hidden="true"
      style={{ width: `${widthPx}px`, height: `${heightPx}px` }}
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {shapes.map((shape) => (
        <OverlayShapeReadOnlyView key={shape.id} shape={shape} assets={assets} />
      ))}
    </div>
  );
}
