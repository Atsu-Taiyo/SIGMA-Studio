"use client";
import {
  type BoxedVariant
} from "@/features/document";
import { getCurveDrawingHint, getShapeBounds, getTablePlacementBounds, pickStyleDefaultsForInsert, type ClickPointDrawingCommand, type OverlayShapeStyleDefaults } from "@/features/drawing";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import {
  useEffect,
  useState
} from "react";
import {
  getOverlayTool,
  type InsertTool,
  type OverlayInteractionMode
} from "./interaction-mode";
import { getShapeAdjustmentReadout, isShapeAdjustmentHandle } from "./shape-adjustment";
import {
  ShapeBody,
  noopGraphCropEnd,
  noopGraphSpecChange
} from "./shape-renderer";
import { getArcDragReadoutText } from "./shapes/arc-readout";
import {
  buildInsertShape,
  isArcInsertTool,
  isClickPointDrawingTool
} from "./shapes/create-shape";
import {
  GRAPH_SHAPE_TYPE
} from "./shapes/graph";
import {
  TABLE_SHAPE_TYPE
} from "./shapes/table";
import type {
  OverlayAsset,
  OverlayBounds,
  OverlayPoint,
  OverlayShape
} from "./types";

export const PREVIEW_SHAPE_ID = "__overlay_insert_preview__";

/** Pointer motion updates this small preview only, without rerendering the document canvas. */
export function TablePlacementPreview({ tool, surfaceRef, pointFromClient, assets, styleDefaults }: {
  tool: InsertTool;
  surfaceRef: { current: HTMLDivElement | null };
  pointFromClient: (x: number, y: number) => OverlayPoint;
  assets: Record<string, OverlayAsset>;
  styleDefaults: Partial<OverlayShapeStyleDefaults>;
}) {
  const [point, setPoint] = useState<OverlayPoint | null>(null);
  useEffect(() => {
    let frame = 0;
    const move = (event: PointerEvent) => {
      cancelAnimationFrame(frame);
      const inside = event.target instanceof Node && surfaceRef.current?.contains(event.target);
      frame = requestAnimationFrame(() => {
        setPoint(inside ? pointFromClient(event.clientX, event.clientY) : null);
      });
    };
    const hide = () => { cancelAnimationFrame(frame); setPoint(null); };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerleave", hide);
    window.addEventListener("blur", hide);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerleave", hide);
      window.removeEventListener("blur", hide);
    };
  }, [pointFromClient, surfaceRef]);
  if (!point) return null;
  return (
    <div data-table-placement-preview="" aria-hidden="true" style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
      <InsertDragPreview tool={tool} start={point} current={point}
        bounds={{ ...point, w: 0, h: 0 }} assets={assets} styleDefaults={styleDefaults} />
    </div>
  );
}

export function getDrawingHint(
  mode: OverlayInteractionMode,
  curveDrawing: Extract<OverlayInteractionMode, { id: "overlay.curveDrawing" }> | null,
  canClose: boolean,
  t: Translate<"shape">,
): string | null {
  const tool = getOverlayTool(mode);
  if (tool.kind === "insert" && tool.command === "table") return t("table.placeHint");
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
export function CurveDrawingMarkers({
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

export function InsertDragPreview({
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
  if (tool.command === "table" && tool.tableCellSize) {
    return <TableGridPlacementPreview start={start} current={current} cellSize={tool.tableCellSize} />;
  }
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
  if (previewShape.type === TABLE_SHAPE_TYPE) {
    // Only the temporary view is dashed; the canonical table retains its solid grid.
    previewShape.props.table.grid = {
      ...previewShape.props.table.grid,
      borderStyle: "dashed",
      borderColor: "#9ca3af",
    };
  }
  return (
    <>
      <div
        className={`overlay-insert-preview-frame${tool.command === "table" ? " table-placement" : ""}`}
        style={{
          left: tool.command === "table" ? shapeBounds.x : bounds.x,
          top: tool.command === "table" ? shapeBounds.y : bounds.y,
          width: tool.command === "table" ? shapeBounds.w : bounds.w,
          height: tool.command === "table" ? shapeBounds.h : bounds.h,
        }}
      />
      <div
        className={`overlay-insert-preview-shape overlay-shape${tool.command === "table" ? " table-placement" : ""}`}
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

/** Preview only: no cell IDs, rich-text documents, or table editors are allocated during motion. */
export function TableGridPlacementPreview({ start, current, cellSize }: {
  start: OverlayPoint;
  current: OverlayPoint;
  cellSize: { w: number; h: number };
}) {
  const t = useT("shape");
  const grid = getTablePlacementBounds(start, current, cellSize);
  const lines = [
    ...Array.from({ length: grid.columns - 1 }, (_, i) => `M${(i + 1) * grid.cellW} 0V${grid.h}`),
    ...Array.from({ length: grid.rows - 1 }, (_, i) => `M0 ${(i + 1) * grid.cellH}H${grid.w}`),
  ].join(" ");
  return (
    <div className="overlay-insert-preview-shape overlay-shape table-grid-placement"
      data-table-preview-rows={grid.rows} data-table-preview-columns={grid.columns}
      style={{ left: grid.x, top: grid.y, width: grid.w, height: grid.h }}>
      <svg width="100%" height="100%" aria-hidden="true" className="table-grid-placement-lines">
        <rect x="0.5" y="0.5" width={grid.w - 1} height={grid.h - 1} />
        <path d={lines} />
      </svg>
      <div className="table-placement-hint">{t("table.dragHint")}</div>
    </div>
  );
}

export function normalizeBoxedVariant(value: unknown): BoxedVariant | undefined {
  return value === "frame" || value === "thick" || value === "double" || value === "oval" || value === "shade"
    ? value
    : undefined;
}

export function getAdjustmentDragReadout(
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

export function OverlayDragReadout({ text, position }: { text: string; position: OverlayPoint }) {
  return (
    <div
      className="overlay-drag-readout"
      style={{ left: position.x + 16, top: position.y + 16 }}
    >
      {text}
    </div>
  );
}