import type {
  OverlayArcShape,
  OverlayArrowShape,
  OverlayBounds,
  OverlayLineShape,
  OverlayPoint,
  OverlayShape,
} from "@/features/document";
import {
  getArrowheadExtentInStrokes,
  overlayStrokeWidth,
  WIDEST_ARROWHEAD_EXTENT_IN_STROKES,
} from "@/features/rendering/core";

import { getGraphOwnedLabelShapeIds } from "./graph-label-layout";
import {
  angleInSweep,
  boundsFromPoints,
  getAxisAlignedRotatedBounds,
  getBoundsCenter,
  getBoundsUnion,
  rotatedBoundsIntersectBounds,
} from "./math";
import { getArcRadii, getShapeBounds, getShapeRotation } from "./shape-bounds";
import { getShapeLabelBounds } from "./shape-label-geometry";

/**
 * Where a shape is actually drawn, as opposed to the box that transforms it.
 *
 * `getShapeBounds` is the *reference* box: resize, align, snap, group normalization and export
 * ranges all read it, and an arc stores `x = centre - r` so that box is the whole ellipse. Changing
 * it would move existing figures. This module answers the other question — "what does the ink
 * cover?" — and is used only for what the author sees: the selection rectangle.
 *
 * The curve/arc extreme-point approach is modeled after the interaction pattern used by external canvas editors
 * (`Arc2d` / `Group2d`); the code here is written against this project's own shape model.
 *
 * A line's or arrow's caption belongs to the visible box but *not* to the ink box, for the same
 * reason the stroke padding does not: its size comes from a `size` token and does not scale when
 * the figure is resized. See {@link getShapeInkBounds}.
 */

/** Quadrant angles: an arc that crosses one reaches the ellipse's extreme on that axis. */
const QUADRANT_ANGLES = [0, Math.PI / 2, Math.PI, Math.PI * 1.5];

export function getShapeVisualBounds(shape: OverlayShape): OverlayBounds {
  const inked = inflate(getShapeInkBounds(shape), getStrokeInflation(shape));
  const label = getShapeLabelBounds(shape);
  return label ? getBoundsUnion([inked, label]) ?? inked : inked;
}

/**
 * The drawn shape without the stroke and arrow-head padding around it.
 *
 * Resizing maps this box, not {@link getShapeVisualBounds}: the padding is a fixed number of
 * pixels (half a stroke, a head measured in stroke widths, and a caption measured in a fixed font
 * size) that does not scale with the figure, so leaving it inside the mapping would drag the
 * fixed edge away from the pointer by
 * `padding × (scale - 1)`. Everything the ink box does cover scales exactly — arc sweep angles
 * are unchanged by an axis-aligned scale and Bézier extremes map affinely — so removing the
 * padding, mapping, and adding it back reproduces the visible box exactly.
 */
export function getShapeInkBounds(shape: OverlayShape): OverlayBounds {
  if (shape.type === "arc") {
    return getArcSweepBounds(shape);
  }
  if (shape.type === "line" || shape.type === "arrow") {
    return getStrokedPathBounds(shape);
  }
  // geo / image / text / table / graph / callout already describe what they draw.
  return getShapeBounds(shape);
}

/**
 * The visible box around a selection.
 *
 * Groups are expanded to their leaves rather than trusting `props.w/h`: that stored box came from
 * the reference bounds, so a single arc inside it inflates the group to a whole circle — and the
 * inflated value is what got persisted. Reading the members instead makes repeated
 * group/ungroup rounds idempotent by construction.
 */
export function getShapesVisualBounds(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): OverlayBounds | null {
  return getShapesUnionBounds(shapes, allShapes, getShapeVisualBounds);
}

/**
 * One shape's visible box with its own rotation baked into an axis-aligned rectangle.
 *
 * The same thing {@link getShapesVisualBounds} produces for a single leaf, without building an
 * index of the whole document — which matters on the paths that ask this per shape.
 */
export function getRotatedShapeVisualBounds(shape: OverlayShape): OverlayBounds {
  return rotateBounds(getShapeVisualBounds(shape), shape);
}

/**
 * Does `bounds` reach the shape as it is drawn — the turned rectangle, not the box around it?
 *
 * {@link getRotatedShapeVisualBounds} flattens the rotation away, which adds four empty triangles
 * at odd angles. Anything that asks "did the author's drag touch this figure?" wants this instead.
 * Assembling the turned rectangle lives here so the visible box, its rotation and its pivot are
 * only ever put together in one place.
 */
export function shapeVisualBoundsIntersect(shape: OverlayShape, bounds: OverlayBounds): boolean {
  const rotation = getShapeRotation(shape);
  const pivot = rotation === 0 ? undefined : getShapeRotationPivot(shape);
  return rotatedBoundsIntersectBounds(getShapeVisualBounds(shape), rotation, pivot, bounds);
}

/**
 * The point a shape turns around: the centre of the ink it draws.
 *
 * The single definition. The `transform-origin` the shape is drawn with, the point the selection
 * rectangle rotates around, the one hit testing and snapping un-rotate by, and the one the boxes
 * in this module are turned about all read it, so they cannot drift apart.
 *
 * It used to be the centre of the *reference* box. That box is the whole ellipse for an arc, which
 * stores `x = centre - r`, so a default 90° arc turned around a point 25px away from the quarter
 * circle the author sees — the figure swung rather than spun, and the selection rectangle, the hit
 * area and the exported SVG each had to compensate for it. Reading the ink instead makes the rule
 * one sentence and fixes smooth curves and freehand strokes for the same reason. Shapes that draw
 * their own box (`geo` / `image` / `text` / `tableShape` / `graph2dShape` / `callout`) have
 * ink = reference box, so for them this is bit-for-bit the previous pivot.
 *
 * Deliberately the *ink* centre and not the visible one: a caption belongs to the visible box
 * (see {@link getShapeVisualBounds}), and pivoting on that would let renaming a label move the
 * axis a figure turns around.
 */
export function getShapeRotationPivot(shape: OverlayShape): OverlayPoint {
  return getBoundsCenter(getShapeInkBounds(shape));
}

/** {@link getShapesVisualBounds} without the stroke padding — see {@link getShapeInkBounds}. */
export function getShapesInkBounds(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): OverlayBounds | null {
  return getShapesUnionBounds(shapes, allShapes, getShapeInkBounds);
}

function getShapesUnionBounds(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
  boundsOf: (shape: OverlayShape) => OverlayBounds,
): OverlayBounds | null {
  const leaves = expandToDrawnShapes(shapes, allShapes);
  return getBoundsUnion(leaves.map((shape) => rotateBounds(boundsOf(shape), shape)));
}

/** The end points of the sweep plus every quadrant extreme it crosses (and the centre for a sector). */
export function getArcSweepBounds(shape: OverlayArcShape): OverlayBounds {
  const { rx, ry } = getArcRadii(shape);
  const centre = { x: shape.x + rx, y: shape.y + ry };
  const pointAt = (angle: number): OverlayPoint => ({
    x: centre.x + Math.cos(angle) * rx,
    y: centre.y + Math.sin(angle) * ry,
  });

  const points = [pointAt(shape.props.startAngle), pointAt(shape.props.endAngle)];
  for (const angle of QUADRANT_ANGLES) {
    if (angleInSweep(angle, shape.props.startAngle, shape.props.endAngle)) {
      points.push(pointAt(angle));
    }
  }
  if (shape.props.kind === "sector") {
    // A sector also draws the two radii, so the centre is part of the ink.
    points.push(centre);
  }

  return boundsFromPoints(points);
}

/** What a line/arrow's path covers, before the stroke is thickened. */
export function getLineVisualBounds(shape: OverlayLineShape | OverlayArrowShape): OverlayBounds {
  return getStrokedPathBounds(shape);
}

function getStrokedPathBounds(shape: OverlayLineShape | OverlayArrowShape): OverlayBounds {
  const local = shape.type === "arrow"
    ? [shape.props.start, shape.props.end]
    : shape.props.points;
  const points = local.map((point) => ({ x: shape.x + point.x, y: shape.y + point.y }));
  if (points.length === 0) {
    return { x: shape.x, y: shape.y, w: 1, h: 1 };
  }

  // `getLineSvgPath` smooths everything that is not an explicit polyline, freehand included.
  if (shape.type === "line" && shape.props.kind !== "polyline") {
    return boundsFromPoints(getSmoothPathPoints(points));
  }

  return boundsFromPoints(points);
}

/**
 * Sample points that bound the smooth path `line-geometry.ts` draws.
 *
 * That path is quadratic: with three points one `Q`, with more a `Q` per interior point ending at
 * the midpoint of the next segment, then a final `L`. The control points themselves sit outside the
 * curve, so the drawn extent is the on-curve endpoints plus each segment's own extreme.
 */
function getSmoothPathPoints(points: readonly OverlayPoint[]): OverlayPoint[] {
  if (points.length < 3) {
    return [...points];
  }

  if (points.length === 3) {
    return [points[0], points[2], ...quadraticExtremes(points[0], points[1], points[2])];
  }

  const sampled: OverlayPoint[] = [points[0], points[points.length - 1]];
  let from = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index];
    const next = points[index + 1];
    const to = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
    sampled.push(to, ...quadraticExtremes(from, control, to));
    from = to;
  }
  return sampled;
}

/** Where a quadratic Bézier turns around on each axis, if it does so within the segment. */
function quadraticExtremes(from: OverlayPoint, control: OverlayPoint, to: OverlayPoint): OverlayPoint[] {
  const extremes: OverlayPoint[] = [];
  for (const axis of ["x", "y"] as const) {
    const denominator = from[axis] - 2 * control[axis] + to[axis];
    if (Math.abs(denominator) < 1e-9) {
      continue;
    }
    const t = (from[axis] - control[axis]) / denominator;
    if (t <= 0 || t >= 1) {
      continue;
    }
    extremes.push(quadraticAt(from, control, to, t));
  }
  return extremes;
}

function quadraticAt(from: OverlayPoint, control: OverlayPoint, to: OverlayPoint, t: number): OverlayPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

/** Half the stroke, plus the arrow head when the shape draws one. */
export function getStrokeInflation(shape: OverlayShape): number {
  if (shape.type !== "line" && shape.type !== "arrow" && shape.type !== "arc") {
    return 0;
  }

  const strokeWidth = overlayStrokeWidth(shape.props.size);
  const heads = [shape.props.arrowheadStart, shape.props.arrowheadEnd]
    .filter((head) => typeof head === "string" && head !== "none")
    .map((head) => String(head));
  if (heads.length === 0) {
    return strokeWidth / 2;
  }

  // The head is measured in stroke widths, so it scales with the line — a flat padding cannot.
  // An unrecognised head falls back to the widest one rather than to nothing: a box that is too
  // small hides ink, a box that is slightly too large only looks loose.
  const extent = Math.max(...heads.map((head) => (
    getArrowheadExtentInStrokes(head) || WIDEST_ARROWHEAD_EXTENT_IN_STROKES
  )));
  return (strokeWidth * extent) / 2;
}

/**
 * Every shape whose ink the given selection covers.
 *
 * Groups become their members. A graph owns its axis/point/annotation labels as sibling text
 * shapes referenced by id rather than by `parentId`; inside a group those belong to the group's
 * ink, so they are pulled in too — that ownership is exactly what goes missing when a graph is
 * handled by `parentId` alone.
 *
 * A graph selected on its own keeps its own box (as it always has): its labels are separate
 * shapes the author did not select, and folding them in would make the box jump when a label
 * happens to sit far away.
 */
function expandToDrawnShapes(
  shapes: readonly OverlayShape[],
  allShapes: readonly OverlayShape[],
): OverlayShape[] {
  const byId = new Map(allShapes.map((shape) => [shape.id, shape]));
  const collected = new Map<string, OverlayShape>();
  // Separate from `collected`: a group is removed from it once it turns out to have members, so
  // it cannot double as the cycle guard. Broken documents really do contain `parentId` cycles.
  const visited = new Set<string>();

  const visit = (shape: OverlayShape, viaGroup: boolean): void => {
    if (visited.has(shape.id)) {
      return;
    }
    visited.add(shape.id);

    if (shape.type === "group") {
      const members = allShapes.filter((member) => member.parentId === shape.id);
      if (members.length === 0) {
        // An empty group keeps its stored box: there is nothing else to describe it.
        collected.set(shape.id, shape);
        return;
      }
      for (const member of members) {
        visit(member, true);
      }
      return;
    }

    collected.set(shape.id, shape);
    if (viaGroup && shape.type === "graph2dShape") {
      for (const labelId of getGraphOwnedLabelShapeIds(shape)) {
        const label = byId.get(labelId);
        if (label) {
          visit(label, true);
        }
      }
    }
  };

  for (const shape of shapes) {
    visit(shape, false);
  }
  return [...collected.values()];
}

function rotateBounds(bounds: OverlayBounds, shape: OverlayShape): OverlayBounds {
  const rotation = getShapeRotation(shape);
  return rotation === 0
    ? bounds
    : getAxisAlignedRotatedBounds(bounds, rotation, getShapeRotationPivot(shape));
}

function inflate(bounds: OverlayBounds, amount: number): OverlayBounds {
  if (!Number.isFinite(amount) || amount <= 0) {
    return bounds;
  }
  return {
    x: bounds.x - amount,
    y: bounds.y - amount,
    w: bounds.w + amount * 2,
    h: bounds.h + amount * 2,
  };
}
