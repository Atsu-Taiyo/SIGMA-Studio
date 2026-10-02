"use client";
import { type SigmaCommentThread,type SigmaTableSpec } from "@/features/document";
import { getShapeBounds } from "@/features/drawing";
import { getVisibleOverlayShapes,type OverlayPreviewStackLayer } from "@/features/rendering/core";
import { getCommentThreadsForOverlayShape } from "@/lib/comments";
import { countPerformanceEvent } from "@/lib/performance";
import type { MouseEvent as ReactMouseEvent,PointerEvent as ReactPointerEvent } from "react";
import { useMemo } from "react";
import type { OverlayShapeDecoration } from "../overlay-canvas/editor-extension";
import type { OverlayAsset,OverlayShape } from "../overlay-canvas/types";
import { type ResolvedOverlayView } from "../overlay-canvas/view-cache";
import { OverlayShapeReadOnlyView } from "../OverlayCanvasEditorClient";
import { type VisiblePageRange } from "./virtualization";

export function OverlayPreview({
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

  const regionThreads = stackLayer !== "background"
    ? commentThreads.filter((thread) => thread.anchor.type === "canvasRegion") : [];
  if (resolvedView.shapes.length === 0 && visibleGhostShapes.length === 0 && regionThreads.length === 0) {
    return null;
  }

  return (
    <div
      className="page-overlay-preview"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onDoubleClick={onDoubleClick}
    >
      {regionThreads.map((thread) => thread.anchor.type === "canvasRegion" && (
        <div
          key={thread.id}
          className={`overlay-comment-marker ${thread.id === highlightedCommentThreadId ? "active" : ""}`}
          data-comment-thread-id={thread.id}
          data-comment-count={1}
          style={{ left: thread.anchor.bounds.x, top: thread.anchor.bounds.y,
            width: thread.anchor.bounds.w, height: thread.anchor.bounds.h }}
        />
      ))}
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

export function OverlayCommentMarker({
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

export function BlockCommentBackground({
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
