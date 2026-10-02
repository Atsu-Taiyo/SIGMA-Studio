"use client";
import {
  getShapeRotation,
  getShapeRotationPivot,
  getShapeVisualBounds,
  getShapesVisualBounds,
  isSolidShape
} from "@/features/drawing";
import type { Translate } from "@/lib/i18n";
import { useT } from "@/lib/i18n/react";
import {
  GripHorizontal,
  RotateCw
} from "lucide-react";
import type {
  CSSProperties,
  PointerEvent as ReactPointerEvent
} from "react";
import {
  Fragment,
  useState
} from "react";
import {
  type PointHandle,
  type ResizeHandle
} from "./interaction-mode";
import {
  clamp
} from "./math";
import {
  CORNER_RESIZE_HANDLES,
  EDGE_RESIZE_HANDLES,
  getResizeHandleSet,
  isCornerResizeHandle
} from "./resize";
import {
  AnchorIndicator,
  AnchorIndicatorState,
  AnchorLeader,
  PointHandles,
  SolidEdgeHighlight,
  getAdaptiveSelectionHandleStyle,
  hasPointOnlySelection
} from "./selection-handles";
import {
  composeShapeTransform
} from "./shape-renderer";
import type {
  OverlayBounds,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId
} from "./types";

export interface AnchorIndicatorCopy {
  title: string;
  body: string;
}

export function getAnchorIndicatorCopy(indicator: AnchorIndicator, t: Translate<"shape">): AnchorIndicatorCopy {
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

export function getAnchorIndicatorAriaLabel(state: AnchorIndicatorState, t: Translate<"shape">): string {
  if (state === "block") return t("anchor.moveBody");
  if (state === "shape") return t("anchor.connectShapeToBody");
  if (state === "missing") return t("anchor.relink");
  return t("anchor.connectToBody");
}

export function AnchorIndicators({
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
export function AnchorLeaderLine({ leader, state }: { leader: AnchorLeader; state: AnchorIndicatorState }) {
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

export function SelectionBox({
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
  solidEdge,
  solidHoverEdge,
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
  /** 選んでいる立体の辺の番号。選んでいなければ `null`。 */
  solidEdge: number | null;
  /** ポインタの下にある辺の番号。 */
  solidHoverEdge: number | null;
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
        {onlyShape && !cropShape && solidHoverEdge !== null && solidHoverEdge !== solidEdge && isSolidShape(onlyShape) && (
          <SolidEdgeHighlight shape={onlyShape} bounds={bounds} edge={solidHoverEdge} hover />
        )}
        {onlyShape && !cropShape && solidEdge !== null && isSolidShape(onlyShape) && (
          <SolidEdgeHighlight shape={onlyShape} bounds={bounds} edge={solidEdge} />
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

export function ImageCropHandles({
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

export function getEdgeResizeHandleStyle(handle: ResizeHandle, bounds: OverlayBounds): CSSProperties | undefined {
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
      "--overlay-resize-handle-length": `${Math.min(getAdaptiveEdgeHandleLength(bounds.h), Math.max(2, bounds.w * 0.4))}px`,
      "--overlay-resize-handle-thickness": `${Math.min(5, Math.max(1, bounds.w * 0.1))}px`,
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
export function getEdgeResizeHandleInsetPx(axisLength: number): number {
  const MIN_GRAB_LENGTH = 12;
  return Math.max(0, Math.min(12, (axisLength - MIN_GRAB_LENGTH) / 2));
}

export function getAdaptiveEdgeHandleLength(axisLength: number): number {
  const availableLength = Math.max(8, axisLength - 24);
  const maxLength = Math.min(48, availableLength);
  const minLength = Math.min(12, maxLength);
  return Math.round(clamp(axisLength * 0.24, minLength, maxLength));
}

export function getSelectionTransformOrigin(shape: OverlayShape, selectionBounds: OverlayBounds): string {
  return getSelectionTransformOriginFromPivot(getShapeRotationPivot(shape), selectionBounds);
}

export function getSelectionTransformOriginFromPivot(pivot: OverlayPoint, selectionBounds: OverlayBounds): string {
  return `${pivot.x - selectionBounds.x}px ${pivot.y - selectionBounds.y}px`;
}