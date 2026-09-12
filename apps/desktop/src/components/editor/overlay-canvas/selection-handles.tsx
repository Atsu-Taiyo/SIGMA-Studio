"use client";

import  {
  getLineInsertHandlePoints,
  getShapeBounds,
  getShapeSelectionBounds,
  isEditableLineKind,
} from "@/features/drawing";
import { useT } from "@/lib/i18n/react";
import type { CSSProperties, PointerEvent as ReactPointerEvent } from "react";
import  {
  getAnchorBoundaryForAnchor,
  pickAnchorBoundaryAtPoint,
  pickBlockAnchor,
  type AnchorBoundary,
  type MeasuredBlock,
} from "./anchor";
import { type PointHandle } from "./interaction-mode";
import { clamp, shapePointToSelectionLocal, shouldShowPointHandles } from "./math";
import { getAnchorProbeBounds } from "./reanchor-model";
import { getArcEndpoint } from "./render-attrs";
import { getBlockArrowHeadHandlePoint, getBlockArrowShaftHandlePoint } from "./shapes/block-arrow";
import { getCalloutCornerRadiusHandlePoint, getCalloutGeometry } from "./shapes/callout";
import { normalizeLineKind } from "./shapes/line";
import type { OverlayAnchor, OverlayBounds, OverlayPoint, OverlayShape } from "./types";


export const ANCHOR_RULE_MIN_WIDTH_PX = 48;

/** Half the grip pill's height: where the dashed leader leaves the rule. */
export const ANCHOR_GRIP_HALF_HEIGHT_PX = 9;

export const ANCHOR_GRIP_INSET_PX = 36;

export const ANCHOR_GRIP_HALF_WIDTH_PX = 42;

export const ANCHOR_GRIP_SHAPE_CLEARANCE_PX = 8;

/** Rotate handle sits above the selection frame; size readout below it. */
export const ANCHOR_GRIP_TOP_CHROME_PX = 36;

export const ANCHOR_GRIP_BOTTOM_CHROME_PX = 20;

/** Below this the figure already touches its rule, so a leader adds only noise. */
export const ANCHOR_LEADER_MIN_GAP_PX = 24;

export const ANCHOR_DETACHED_RULE_GAP_PX = 18;


export interface AnchorMeasurements {
  /**
   * 読み取り専用。`PageCanvasEditor` の `layoutViewState.blockRects` をそのまま指すことが
   * あり、あの Map は identity で「変わっていない」を判定する仕組み (`sameMeasuredBlockMap`・
   * `patchFlowMeasurement`) の土台なので、こちら側から書き換えてはいけない。
   */
  rects: ReadonlyMap<string, MeasuredBlock>;
  ordered: MeasuredBlock[];
}


export type AnchorIndicatorState = "block" | "page" | "shape" | "missing";


export interface AnchorIndicator {
  shape: OverlayShape;
  /** Horizontal rule marking the body position the figure hangs from. */
  rule: { left: number; width: number; y: number };
  /** Grip pill center, kept over the figure so the pairing is unmistakable. */
  gripX: number;
  /** Dashed leader from the rule to the figure; null when they nearly touch. */
  leader: AnchorLeader | null;
  /** Body block the rule binds to, highlighted while the rule is dragged. */
  targetRect: { left: number; top: number; width: number; height: number } | null;
  blockId?: string;
  state: AnchorIndicatorState;
  /** The figure sits below the rule (the normal case). */
  below: boolean;
  dragging: boolean;
}


export interface AnchorLeader {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}


export function hasPointOnlySelection(shape: OverlayShape): boolean {
  return shape.type === "line" || shape.type === "arrow";
}


/**
 * 選択枠が小さくても点ハンドルを隠さない図形。line/arrow は点ハンドルが唯一の編集手段。
 * callout も口の麓・頂点・角丸ハンドルが本体リサイズとは別の必須の編集手段なので同様に扱う
 * (でないと本文矩形を縮めていくと麓ハンドルごと消え、口の形を一切調整できなくなる)。
 */
export function alwaysShowsPointHandles(shape: OverlayShape): boolean {
  return hasPointOnlySelection(shape) || shape.type === "callout";
}


export function getAdaptiveSelectionHandleStyle(bounds: OverlayBounds, pointOnly: boolean): CSSProperties {
  const shortAxis = Math.max(1, Math.min(bounds.w, bounds.h));
  const cornerSize = Math.round(clamp(shortAxis * 0.22, 4, 9));
  // 水平/垂直の線は短辺が1pxに潰れるため、点ハンドルは長辺基準でサイズを決める。
  const pointAxis = pointOnly ? Math.max(1, Math.max(bounds.w, bounds.h)) : shortAxis;
  const pointSize = Math.round(clamp(pointAxis * 0.2, 4, 8));
  const cropCornerSize = Math.round(clamp(shortAxis * 0.24, 6, 15));
  const cropEdgeThickness = Math.round(clamp(shortAxis * 0.16, 5, 10));
  return {
    "--overlay-corner-handle-size": `${cornerSize}px`,
    "--overlay-corner-handle-offset": `${cornerSize / -2}px`,
    "--overlay-point-handle-size": `${pointSize}px`,
    "--overlay-crop-corner-handle-size": `${cropCornerSize}px`,
    "--overlay-crop-corner-handle-offset": `${cropCornerSize / -2}px`,
    "--overlay-crop-edge-handle-thickness": `${cropEdgeThickness}px`,
  } as CSSProperties;
}


export function PointHandles({
  shape,
  bounds,
  onPointPointerDown,
  onLineInsertPointerDown,
}: {
  shape: OverlayShape;
  bounds: OverlayBounds;
  onPointPointerDown: (event: ReactPointerEvent<HTMLDivElement>, shape: OverlayShape, handle: PointHandle) => void;
  onLineInsertPointerDown: (
    event: ReactPointerEvent<HTMLDivElement>,
    shape: Extract<OverlayShape, { type: "line" }>,
    index: number,
    point: OverlayPoint,
  ) => void;
}) {
  // 早期 return より前で引く (この下に「小さい図形では出さない」分岐がある)。
  const tShape = useT("shape");
  // 図形が小さいとリサイズハンドルと重なって掴めないため、一定より小さい間は点ハンドル自体を出さない。
  // ただし alwaysShowsPointHandles な図形(line/arrow/callout)は点ハンドルが唯一の編集手段なので対象外。
  //
  // 判定に使うのは選択枠ではなく図形の基準箱。選択枠は「実際に描かれている範囲」に縮んだので、
  // 弧を閉じ気味にすると枠が数 px になり、角度ハンドルが消えて二度と開けなくなる。
  if (!alwaysShowsPointHandles(shape) && !shouldShowPointHandles(getShapeSelectionBounds(shape))) {
    return null;
  }

  if (shape.type === "arc") {
    return (
      <>
        {([
          ["start", getArcEndpoint(shape, "start")],
          ["end", getArcEndpoint(shape, "end")],
        ] as const).map(([endpoint, point]) => {
          const position = shapePointToSelectionLocal(shape, bounds, point);
          return (
            <AdjustmentHandle
              key={endpoint}
              className={`overlay-arc-point-handle ${endpoint}`}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => onPointPointerDown(event, shape, { type: "arc", endpoint })}
            />
          );
        })}
      </>
    );
  }

  if (shape.type === "geo" && shape.props.geo === "triangle") {
    const position = shapePointToSelectionLocal(shape, bounds, {
      x: getTriangleApexX(shape),
      y: 0,
    });
    return (
      <AdjustmentHandle
        className="overlay-triangle-apex-handle"
        style={{ left: position.x, top: position.y }}
        onPointerDown={(event) => onPointPointerDown(event, shape, { type: "triangleApex" })}
      />
    );
  }

  if (shape.type === "geo" && shape.props.geo === "blockArrow") {
    const headPosition = shapePointToSelectionLocal(shape, bounds, getBlockArrowHeadHandlePoint(shape));
    const shaftPosition = shapePointToSelectionLocal(shape, bounds, getBlockArrowShaftHandlePoint(shape));
    return (
      <>
        <AdjustmentHandle
          className="overlay-block-arrow-head-handle"
          style={{ left: headPosition.x, top: headPosition.y }}
          onPointerDown={(event) => onPointPointerDown(event, shape, { type: "blockArrowHead" })}
        />
        <AdjustmentHandle
          className="overlay-block-arrow-shaft-handle"
          style={{ left: shaftPosition.x, top: shaftPosition.y }}
          onPointerDown={(event) => onPointPointerDown(event, shape, { type: "blockArrowShaft" })}
        />
      </>
    );
  }

  if (shape.type === "arrow") {
    return (
      <>
        {([
          ["start", shape.props.start],
          ["end", shape.props.end],
        ] as const).map(([endpoint, point]) => {
          const position = shapePointToSelectionLocal(shape, bounds, point);
          return (
            <div
              key={endpoint}
              className={`overlay-point-handle overlay-arrow-point-handle ${endpoint}`}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => onPointPointerDown(event, shape, { type: "arrow", endpoint })}
            />
          );
        })}
      </>
    );
  }

  if (shape.type === "callout") {
    const geometry = getCalloutGeometry(shape);
    const tipPosition = shapePointToSelectionLocal(shape, bounds, geometry.tip);
    const cornerRadiusPosition = shapePointToSelectionLocal(shape, bounds, getCalloutCornerRadiusHandlePoint(shape));
    return (
      <>
        <AdjustmentHandle
          className="overlay-callout-corner-radius-handle"
          style={{ left: cornerRadiusPosition.x, top: cornerRadiusPosition.y }}
          onPointerDown={(event) => onPointPointerDown(event, shape, { type: "calloutCornerRadius" })}
        />
        <AdjustmentHandle
          className="overlay-callout-tail-tip-handle"
          style={{ left: tipPosition.x, top: tipPosition.y }}
          onPointerDown={(event) => onPointPointerDown(event, shape, { type: "calloutTailTip" })}
        />
        {([
          ["start", geometry.baseStart],
          ["end", geometry.baseEnd],
        ] as const).map(([endpoint, point]) => {
          const position = shapePointToSelectionLocal(shape, bounds, point);
          return (
            <AdjustmentHandle
              key={endpoint}
              className={`overlay-callout-tail-base-handle ${endpoint}`}
              style={{ left: position.x, top: position.y }}
              onPointerDown={(event) => onPointPointerDown(event, shape, { type: "calloutTailBase", endpoint })}
            />
          );
        })}
      </>
    );
  }

  if (shape.type !== "line") {
    return null;
  }

  const kind = normalizeLineKind(shape.props.kind);
  const pointHandles = kind === "freehand" && shape.props.points.length > 1
    ? [
        [0, shape.props.points[0]],
        [shape.props.points.length - 1, shape.props.points[shape.props.points.length - 1]],
      ] as const
    : shape.props.points.map((point, index) => [index, point] as const);

  // Its own class, never the vertex handle's: the midpoint handle adds a point rather than moving
  // one, it reads a step quieter, and several tests count vertex handles by that class name.
  //
  // Not gated on the selection box: that box is the ink, and a horizontal line's ink is a few
  // pixels tall, so any size test against it would hide these handles on the most ordinary line
  // there is. `INSERT_HANDLE_MIN_SEGMENT` is what keeps them from crowding the vertices.
  const insertHandles = getLineInsertHandlePoints(shape.props.points, kind, shape.props.closed === true);

  return (
    <>
      {insertHandles.map(({ index, point }) => {
        const position = shapePointToSelectionLocal(shape, bounds, point);
        return (
          <div
            key={`insert-${index}`}
            className="overlay-line-insert-handle"
            title={tShape("point.add")}
            style={{ left: position.x, top: position.y }}
            onPointerDown={(event) => onLineInsertPointerDown(event, shape, index, point)}
          />
        );
      })}
      {pointHandles.map(([index, point]) => {
        const position = shapePointToSelectionLocal(shape, bounds, point);
        return (
          <div
            key={index}
            className="overlay-point-handle overlay-line-point-handle"
            title={index === 0 || !isEditableLineKind(kind) ? undefined : tShape("point.move")}
            style={{ left: position.x, top: position.y }}
            onPointerDown={(event) => onPointPointerDown(event, shape, { type: "line", index })}
          />
        );
      })}
    </>
  );
}


export function AdjustmentHandle({
  className,
  style,
  onPointerDown,
}: {
  className: string;
  style: CSSProperties;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  return (
    <div
      className={`overlay-point-handle overlay-adjust-handle ${className}`}
      style={style}
      onPointerDown={onPointerDown}
    />
  );
}


export function getAnchorIndicator(
  shape: OverlayShape,
  allShapes: OverlayShape[],
  measurements: AnchorMeasurements,
  canvasWidth: number,
  canvasHeight: number,
  draggingPosition: OverlayPoint | null,
  forceAutoAnchor: boolean,
  bleed?: { x: number; top: number },
): AnchorIndicator | null {
  const bounds = getShapeBounds(shape);
  const dragging = draggingPosition !== null;
  const canvas = { width: canvasWidth, height: canvasHeight, bleed };

  // While the rule is dragged it snaps to the boundary it would bind to, so the
  // preview and the committed anchor are always the same position.
  if (draggingPosition) {
    const boundary = pickAnchorBoundaryAtPoint(draggingPosition, measurements.ordered, bounds.y);
    const block = boundary ? measurements.rects.get(boundary.blockId) : undefined;
    if (boundary && block) {
      return buildBoundaryAnchorIndicator(shape, bounds, boundary, block, canvas, true);
    }
    return buildDetachedAnchorIndicator(shape, bounds, "page", undefined, draggingPosition, canvas, true);
  }

  // The preview must be chosen from the same box the commit uses (`reanchorShapesByPosition`),
  // otherwise the rule shown while dragging an arc names one block and the drop stores another.
  const anchor = getDisplayAnchor(
    shape,
    getAnchorProbeBounds(shape, allShapes),
    measurements.ordered,
    forceAutoAnchor,
  );
  if (anchor.type === "block") {
    const block = measurements.rects.get(anchor.blockId);
    if (!block) {
      return buildDetachedAnchorIndicator(shape, bounds, "missing", anchor.blockId, null, canvas, dragging);
    }

    return buildBoundaryAnchorIndicator(
      shape,
      bounds,
      getAnchorBoundaryForAnchor(anchor, block),
      block,
      canvas,
      dragging,
    );
  }

  return buildDetachedAnchorIndicator(
    shape,
    bounds,
    anchor.type === "shape" ? "shape" : "page",
    undefined,
    null,
    canvas,
    dragging,
  );
}


export interface AnchorCanvasMetrics {
  width: number;
  height: number;
  bleed?: { x: number; top: number };
}


export function buildBoundaryAnchorIndicator(
  shape: OverlayShape,
  bounds: OverlayBounds,
  boundary: AnchorBoundary,
  block: MeasuredBlock,
  canvas: AnchorCanvasMetrics,
  dragging: boolean,
): AnchorIndicator {
  const rule = clampAnchorRule(boundary.left, boundary.width, boundary.y, canvas);
  return {
    shape,
    rule,
    gripX: getAnchorGripX(bounds, rule, canvas),
    leader: getAnchorLeader(bounds, rule, canvas),
    // Selecting a figure names the paragraph it hangs from, not just the boundary line: the rule
    // alone is ambiguous where paragraphs are a line apart, and for a group — whose rule always
    // runs level with its own box — it was the only cue there was. The drag keeps the stronger
    // wash (see `.overlay-anchor-target.dragging`), because there the block is a live target.
    targetRect: { left: boundary.left, top: block.top, width: boundary.width, height: block.height ?? 0 },
    blockId: boundary.blockId,
    state: "block",
    below: bounds.y >= rule.y,
    dragging,
  };
}


/** Rule for a figure that is not tied to a measurable body position. */
export function buildDetachedAnchorIndicator(
  shape: OverlayShape,
  bounds: OverlayBounds,
  state: Exclude<AnchorIndicatorState, "block">,
  blockId: string | undefined,
  draggingPosition: OverlayPoint | null,
  canvas: AnchorCanvasMetrics,
  dragging: boolean,
): AnchorIndicator {
  const width = clamp(bounds.w, ANCHOR_RULE_MIN_WIDTH_PX, Math.max(ANCHOR_RULE_MIN_WIDTH_PX, canvas.width - 24));
  const centerX = draggingPosition?.x ?? bounds.x + bounds.w / 2;
  const y = draggingPosition?.y ?? bounds.y - ANCHOR_DETACHED_RULE_GAP_PX;
  const rule = clampAnchorRule(centerX - width / 2, width, y, canvas);
  return {
    shape,
    rule,
    gripX: getAnchorGripX(bounds, rule, canvas),
    leader: getAnchorLeader(bounds, rule, canvas),
    targetRect: null,
    blockId,
    state,
    below: bounds.y >= rule.y,
    dragging,
  };
}


export function getAnchorGripX(
  bounds: OverlayBounds,
  rule: { left: number; width: number; y: number },
  canvas: AnchorCanvasMetrics,
): number {
  const inset = Math.min(ANCHOR_GRIP_INSET_PX, rule.width / 2);
  const overFigure = clamp(bounds.x + bounds.w / 2, rule.left + inset, rule.left + rule.width - inset);
  const crossesShapeChrome = rule.y >= bounds.y - ANCHOR_GRIP_TOP_CHROME_PX &&
    rule.y <= bounds.y + bounds.h + ANCHOR_GRIP_BOTTOM_CHROME_PX;
  if (!crossesShapeChrome) {
    return overFigure;
  }

  // The rule runs level with the figure's own chrome, so park the grip beside
  // the figure: resize, rotate and vertex handles must stay grabbable.
  const bleedX = canvas.bleed?.x ?? 0;
  const offset = ANCHOR_GRIP_SHAPE_CLEARANCE_PX + ANCHOR_GRIP_HALF_WIDTH_PX;
  if (bounds.x - offset - ANCHOR_GRIP_HALF_WIDTH_PX >= -bleedX) {
    return bounds.x - offset;
  }
  if (bounds.x + bounds.w + offset + ANCHOR_GRIP_HALF_WIDTH_PX <= canvas.width + bleedX) {
    return bounds.x + bounds.w + offset;
  }
  return overFigure;
}


/**
 * The dashed elbow from the grip to the figure. It is dropped only when the grip already sits on
 * the figure and the rule runs right along its edge — there the two read as one thing and a
 * connector would be pure ink.
 *
 * A short vertical gap is *not* enough to drop it: `getAnchorGripX` parks the grip beside the
 * figure whenever the rule runs level with its chrome, and a chip stranded at the far end of a
 * column-wide rule says nothing about which figure it holds. That is what a group hits every time —
 * it hangs from the block above its topmost member, so the rule is always level with the box —
 * while the same shapes ungrouped kept a leader on whichever of them sat further down.
 */
export function getAnchorLeader(
  bounds: OverlayBounds,
  rule: { left: number; width: number; y: number },
  canvas: AnchorCanvasMetrics,
): AnchorLeader | null {
  const top = bounds.y;
  const bottom = bounds.y + bounds.h;
  // The edge the rule is nearest to: for a rule *inside* a tall figure, tying it to the far edge
  // would draw the connector straight through the drawing.
  const targetY = rule.y <= top || (rule.y < bottom && rule.y - top <= bottom - rule.y)
    ? top
    : bottom;
  const gap = Math.abs(targetY - rule.y);
  const gripX = getAnchorGripX(bounds, rule, canvas);
  const gripOverFigure = gripX >= bounds.x && gripX <= bounds.x + bounds.w;
  if (gap < ANCHOR_LEADER_MIN_GAP_PX && gripOverFigure) {
    return null;
  }

  return {
    x1: gripX,
    y1: targetY >= rule.y ? rule.y + ANCHOR_GRIP_HALF_HEIGHT_PX : rule.y - ANCHOR_GRIP_HALF_HEIGHT_PX,
    x2: bounds.x + bounds.w / 2,
    y2: targetY,
  };
}


export function getDisplayAnchor(
  shape: OverlayShape,
  bounds: OverlayBounds,
  orderedBlocks: MeasuredBlock[],
  forceAutoAnchor = false,
): OverlayAnchor {
  if (!forceAutoAnchor && (shape.anchor?.type === "block" || shape.anchor?.type === "page" || shape.anchor?.type === "shape")) {
    return shape.anchor;
  }

  return pickBlockAnchor(bounds.y, shape.y, orderedBlocks, bounds.x + bounds.w / 2, shape.x);
}


export function clampAnchorRule(
  left: number,
  width: number,
  y: number,
  canvas: AnchorCanvasMetrics,
): { left: number; width: number; y: number } {
  const bleedX = canvas.bleed?.x ?? 0;
  const bleedTop = canvas.bleed?.top ?? 0;
  const minLeft = 4 - bleedX;
  const maxRight = Math.max(minLeft + ANCHOR_RULE_MIN_WIDTH_PX, canvas.width + bleedX - 4);
  const clampedWidth = clamp(width, ANCHOR_RULE_MIN_WIDTH_PX, maxRight - minLeft);
  return {
    left: clamp(left, minLeft, maxRight - clampedWidth),
    width: clampedWidth,
    y: clamp(y, 12 - bleedTop, Math.max(12 - bleedTop, canvas.height - 12)),
  };
}


export function getTriangleApexX(shape: Extract<OverlayShape, { type: "geo" }>): number {
  return clamp(shape.props.apexX ?? shape.props.w / 2, 0, shape.props.w);
}