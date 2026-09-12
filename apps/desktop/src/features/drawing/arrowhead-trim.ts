import type { OverlayArcShape, OverlayShape } from "@/features/document";
import {
  getArrowheadTrimInStrokes,
  NO_ARROWHEAD_PLACEMENT,
  overlayStrokeWidth,
  planArrowheadEndpoints,
  type ArrowheadEndpointPlan,
} from "@/features/rendering/core";

import {
  getLinePathLength,
  getLineTerminalSegmentLengths,
  isClosedPolyline,
  normalizeLineKind,
  type LinePathTrim,
} from "./line-geometry";
import { normalizePositiveAngle } from "./math";
import { getArcRadii } from "./shape-bounds";

/**
 * How much of a shape's own ink belongs to its arrow heads.
 *
 * A head is drawn by a `<marker>`, and a marker is placed on the path's end point rather than in
 * front of it. Anchoring the head at its own tip therefore leaves the line's square end sticking
 * out of the point; anchoring it further back pushes the point past the endpoint the document
 * stores. The way out is to shorten the drawn path and move the marker's reference point back by
 * exactly the same amount — the stored coordinates never change, only the ink does.
 *
 * Everything that suppresses a head lives here too (a closed polyline, a sector), so a shape can
 * never end up trimmed at an end that draws no head.
 */

const NO_ARROWHEAD_PLAN: ArrowheadEndpointPlan = {
  start: NO_ARROWHEAD_PLACEMENT,
  end: NO_ARROWHEAD_PLACEMENT,
};

/** Enough steps for the arc length of an ellipse to settle well inside a tenth of a pixel. */
const ARC_LENGTH_STEPS = 128;

export function getShapeArrowheadPlan(shape: OverlayShape): ArrowheadEndpointPlan {
  if (!drawsAnyArrowhead(shape)) {
    // Most shapes on a page have no head. Answering here keeps the path measuring below off every
    // render of a headless freehand stroke or arc.
    return NO_ARROWHEAD_PLAN;
  }

  if (shape.type === "arrow") {
    const points = [shape.props.start, shape.props.end];
    const length = getLinePathLength(points, "polyline");
    return planArrowheadEndpoints(
      shape.props.arrowheadStart,
      shape.props.arrowheadEnd,
      overlayStrokeWidth(shape.props.size),
      length,
      { start: length, end: length },
    );
  }

  if (shape.type === "line") {
    const kind = normalizeLineKind(shape.props.kind);
    if (isClosedPolyline(kind, shape.props.points, shape.props.closed)) {
      // A closed polyline draws no head, so trimming it would only shorten the outline.
      return NO_ARROWHEAD_PLAN;
    }
    return planArrowheadEndpoints(
      shape.props.arrowheadStart,
      shape.props.arrowheadEnd,
      overlayStrokeWidth(shape.props.size),
      getLinePathLength(shape.props.points, kind),
      getLineTerminalSegmentLengths(shape.props.points, kind),
    );
  }

  if (shape.type === "arc") {
    const strokeWidth = overlayStrokeWidth(shape.props.size);
    const table = getArcLengthTable(shape);
    return planArrowheadEndpoints(
      shape.props.arrowheadStart,
      shape.props.arrowheadEnd,
      strokeWidth,
      table.total,
      { start: table.total, end: table.total },
      {
        start: getMaxArcTrim(table, "start", idealArcTrim(shape.props.arrowheadStart, strokeWidth), strokeWidth),
        end: getMaxArcTrim(table, "end", idealArcTrim(shape.props.arrowheadEnd, strokeWidth), strokeWidth),
      },
    );
  }

  return NO_ARROWHEAD_PLAN;
}

/**
 * Whether the shape declares a head at either end at all.
 *
 * The suppressions live here, so a closed polyline and a sector can never be shortened at an end
 * that declares no marker — the asymmetry that would put the two renderers back in disagreement.
 */
function drawsAnyArrowhead(shape: OverlayShape): boolean {
  if (shape.type === "arrow") {
    return hasHead(shape.props.arrowheadStart) || hasHead(shape.props.arrowheadEnd);
  }
  if (shape.type === "line") {
    if (isClosedPolyline(normalizeLineKind(shape.props.kind), shape.props.points, shape.props.closed)) {
      // A closed polyline draws no head, so trimming it would only shorten the outline.
      return false;
    }
    return hasHead(shape.props.arrowheadStart) || hasHead(shape.props.arrowheadEnd);
  }
  if (shape.type === "arc") {
    // A sector closes back through its centre; its two radii are not endpoints to decorate.
    return shape.props.kind !== "sector" &&
      (hasHead(shape.props.arrowheadStart) || hasHead(shape.props.arrowheadEnd));
  }
  return false;
}

function hasHead(head: string | undefined): boolean {
  return typeof head === "string" && head !== "none";
}

function idealArcTrim(head: string | undefined, strokeWidth: number): number {
  return getArrowheadTrimInStrokes(head) * Math.max(0, strokeWidth);
}

/**
 * How far an arc may give up before the head visibly leaves the curve.
 *
 * A `<marker>` is a straight stamp aimed along the tangent at the point the path ends, so its point
 * lands `trim` px away **in a straight line** while the arc it replaces was curved. The gap between
 * the two is about `trim × sin(trim / 2ρ)` at a curvature radius of ρ. Capping it at half a stroke
 * keeps the point inside the line's own width of the stored endpoint, which is as close as a rigid
 * head can be asked to come: `trim ≤ √(ρ × strokeWidth)`.
 *
 * ρ is the **smallest** curvature radius the trim would span, not the one at the endpoint: a
 * flattened ellipse curves many times more sharply a little way in, and reading only the end lets a
 * head sit tens of pixels off its own endpoint. The span is measured against the trim the head
 * would ask for unclamped, which is an upper bound for the answer, so the region sampled always
 * contains the region trimmed.
 *
 * A gentle arc never notices (a 100px circle at 2px keeps 14 of the 15px a diamond asks for); a
 * tight one is pulled back until the head sits on its end again. Pulled back far enough, an **open**
 * head (`arrow`, `openArrow`, `thinArrow`) stops covering the line's square end again — its ink
 * near the point is thinner than the stroke. That needs ρ below about twice the stroke width, i.e.
 * an arc several times smaller than the head drawn on it, and the alternative is a head that has
 * visibly left the curve. Filled heads keep covering the line at any clamp.
 */
function getMaxArcTrim(
  table: ArcLengthTable,
  endpoint: "start" | "end",
  idealTrimPx: number,
  strokeWidth: number,
): number {
  if (!(idealTrimPx > 0) || !(strokeWidth > 0) || table.total <= 0) {
    return 0;
  }

  const span = Math.min(idealTrimPx, table.total);
  const from = endpoint === "start" ? 0 : table.total - span;
  const to = endpoint === "start" ? span : table.total;

  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 0; index < table.cumulative.length; index += 1) {
    const at = table.cumulative[index];
    if (at < from || at > to) {
      continue;
    }
    smallest = Math.min(smallest, table.curvatureRadius[index]);
  }
  if (!Number.isFinite(smallest)) {
    return 0;
  }

  const limit = Math.sqrt(Math.max(0, smallest) * strokeWidth);
  return Number.isFinite(limit) ? limit : 0;
}

/** The plan expressed as the path builders want it. */
export function getArrowheadPathTrim(plan: ArrowheadEndpointPlan): LinePathTrim {
  return { start: plan.start.trimPx, end: plan.end.trimPx };
}

/**
 * The angles an arc is actually drawn between.
 *
 * `getArcEndpoint` deliberately keeps returning the stored angles: the angle handles sit on them,
 * and moving those would lift the handle off the end of the arc the author is dragging.
 */
export function getArcDrawnAngles(shape: OverlayArcShape): { startAngle: number; endAngle: number } {
  const { startAngle, endAngle } = shape.props;
  const plan = getShapeArrowheadPlan(shape);
  if (plan.start.trimPx <= 0 && plan.end.trimPx <= 0) {
    return { startAngle, endAngle };
  }

  const table = getArcLengthTable(shape);
  if (table.total <= 0) {
    return { startAngle, endAngle };
  }

  // No separate clamp on the angles: `planArrowheadEndpoints` already held the two trims to 80% of
  // this same total length, and two disjoint pieces of the sweep cannot overlap when their lengths
  // do not. A second clamp here would silently break `refX + trimPx / strokeWidth === tipX`.
  return {
    startAngle: angleAtLength(table, plan.start.trimPx),
    endAngle: angleAtLength(table, table.total - plan.end.trimPx),
  };
}

/**
 * Cumulative arc length at evenly spaced angles across the sweep.
 *
 * An ellipse has no closed form for either direction of this, and the obvious shortcut — divide the
 * length by the speed at the endpoint — is wrong by several times on an eccentric ellipse whose end
 * sits at a slow point. Sampling once and inverting the table is exact to the step size in both
 * directions, and the same table answers "how long is this arc".
 */
interface ArcLengthTable {
  readonly startAngle: number;
  readonly step: number;
  readonly cumulative: readonly number[];
  /** The curvature radius at each sample, so the trim ceiling can read the sharpest point it spans. */
  readonly curvatureRadius: readonly number[];
  readonly total: number;
}

/**
 * One table per shape object.
 *
 * A shape carrying a head is measured three times in a single render (the plan the renderer asks
 * for, the plan `getArcDrawnAngles` asks for, and the table it inverts), and shapes are replaced
 * rather than mutated here, so identity is a sound key.
 */
const ARC_LENGTH_TABLES = new WeakMap<OverlayArcShape, ArcLengthTable>();

function getArcLengthTable(shape: OverlayArcShape): ArcLengthTable {
  const cached = ARC_LENGTH_TABLES.get(shape);
  if (cached) {
    return cached;
  }
  const table = buildArcLengthTable(shape);
  ARC_LENGTH_TABLES.set(shape, table);
  return table;
}

function buildArcLengthTable(shape: OverlayArcShape): ArcLengthTable {
  const { rx, ry } = getArcRadii(shape);
  const { startAngle } = shape.props;
  const sweep = normalizePositiveAngle(shape.props.endAngle - startAngle);
  if (!Number.isFinite(sweep) || sweep <= 0) {
    return { startAngle, step: 0, cumulative: [0], curvatureRadius: [0], total: 0 };
  }

  const step = sweep / ARC_LENGTH_STEPS;
  const cumulative = [0];
  const curvatureRadius = [ellipseCurvatureRadius(rx, ry, startAngle)];
  for (let index = 0; index < ARC_LENGTH_STEPS; index += 1) {
    const from = ellipseSpeed(rx, ry, startAngle + step * index);
    const to = ellipseSpeed(rx, ry, startAngle + step * (index + 1));
    cumulative.push(cumulative[index] + ((from + to) / 2) * step);
    curvatureRadius.push(ellipseCurvatureRadius(rx, ry, startAngle + step * (index + 1)));
  }
  const total = cumulative[ARC_LENGTH_STEPS];
  return {
    startAngle,
    step,
    cumulative,
    curvatureRadius,
    total: Number.isFinite(total) && total > 0 ? total : 0,
  };
}

function ellipseCurvatureRadius(rx: number, ry: number, angle: number): number {
  const speed = ellipseSpeed(rx, ry, angle);
  const product = rx * ry;
  if (!(product > 0)) {
    return 0;
  }
  const radius = (speed * speed * speed) / product;
  return Number.isFinite(radius) ? radius : 0;
}

/** The angle `length` px along the sweep, by inverting the table. */
function angleAtLength(table: ArcLengthTable, length: number): number {
  const target = Math.min(Math.max(length, 0), table.total);
  for (let index = 1; index < table.cumulative.length; index += 1) {
    if (table.cumulative[index] >= target) {
      const span = table.cumulative[index] - table.cumulative[index - 1];
      const within = span > 0 ? (target - table.cumulative[index - 1]) / span : 0;
      return table.startAngle + table.step * (index - 1 + within);
    }
  }
  return table.startAngle + table.step * (table.cumulative.length - 1);
}

function ellipseSpeed(rx: number, ry: number, angle: number): number {
  const speed = Math.hypot(rx * Math.sin(angle), ry * Math.cos(angle));
  return Number.isFinite(speed) ? speed : 0;
}
