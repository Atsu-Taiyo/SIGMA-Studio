/**
 * What a head actually puts on the page, and what that ink covers.
 *
 * The marker table describes a head as an outline. The page shows its **ink**: the outline widened
 * by the head's own pen, squared off at the ends by butt caps and run out to a point at the miter
 * joins. That difference decides the two numbers the table cannot state by hand —
 *
 * - how far forward a head reaches (its visible point is a miter, not a vertex it lists), and
 * - how far back the line has to stop so that its own square end is hidden underneath the head.
 *
 * The second one is what a hand-written constant kept getting wrong. A head is measured in stroke
 * widths, so a head drawn small, or drawn with a pen thinner than the line, is *narrower than the
 * line it ends*: the line then sticks out of the point as a blunt stub no matter where it stops.
 * Asking the ink where it is at least as wide as the line answers that for every head and every
 * size at once.
 *
 * Coordinates are marker units throughout, so one unit is one stroke width of the line being
 * terminated — which is what makes `ARROWHEAD_LINE_WIDTH` below a constant.
 */

/** Geometry drawn from straight segments. `closed` heads are filled outlines. */
export interface ArrowheadPolylineGeometry {
  readonly kind: "polyline";
  readonly points: readonly ArrowheadPoint[];
  readonly closed: boolean;
  readonly filled: boolean;
  readonly strokeWidth: number;
}

export interface ArrowheadCircleGeometry {
  readonly kind: "circle";
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly filled: boolean;
}

export interface ArrowheadPoint {
  readonly x: number;
  readonly y: number;
}

export type ArrowheadGeometry = ArrowheadPolylineGeometry | ArrowheadCircleGeometry;

export interface ArrowheadInkBounds {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** The line a head terminates is exactly one stroke width wide, and marker units are stroke widths. */
export const ARROWHEAD_LINE_WIDTH = 1;

/**
 * How much covered ink the line's end keeps behind it.
 *
 * Stopping the line on the exact point where the head becomes wide enough leaves two edges on the
 * same coordinate, which is a hairline waiting for the next rounding. Half a stroke width back from
 * there is still ink the head was going to draw anyway.
 */
const LINE_END_OVERLAP = 0.5;

/** SVG's default `stroke-miterlimit`: past this the join is beveled and there is no point to reach. */
const MITER_LIMIT = 4;

/**
 * The ink, as pieces that a vertical line can be intersected with one at a time.
 *
 * Every piece is a simple polygon — a segment's rectangle, a miter wedge, or a filled outline — so
 * the union of the pieces is the union of the ink.
 */
interface ArrowheadInk {
  readonly polygons: readonly (readonly ArrowheadPoint[])[];
  readonly circle: ArrowheadCircleGeometry | null;
}

export function getArrowheadInkBounds(geometry: ArrowheadGeometry): ArrowheadInkBounds {
  const { polygons, circle } = getArrowheadInk(geometry);
  let minX = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const polygon of polygons) {
    for (const point of polygon) {
      minX = Math.min(minX, point.x);
      maxX = Math.max(maxX, point.x);
      minY = Math.min(minY, point.y);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (circle) {
    minX = Math.min(minX, circle.cx - circle.r);
    maxX = Math.max(maxX, circle.cx + circle.r);
    minY = Math.min(minY, circle.cy - circle.r);
    maxY = Math.max(maxY, circle.cy + circle.r);
  }
  return Number.isFinite(minX)
    ? { minX, maxX, minY, maxY }
    : { minX: 0, maxX: 0, minY: 0, maxY: 0 };
}

/**
 * How far a head's own ink reaches forward, in marker units.
 *
 * Not the same as the front-most point in `points`: an open head is a stroked polyline whose miter
 * runs past its vertex, and a butt cap spreads half a stroke sideways. Where the head's point has
 * to land is derived from this rather than written down, because the overshoot moves the moment the
 * head's own stroke width does — and flooring that stroke at the line's width is exactly how a
 * small head stops being narrower than the line it ends.
 */
export function getArrowheadInkApexX(geometry: ArrowheadGeometry): number {
  return getArrowheadInkBounds(geometry).maxX;
}

export function translateArrowheadGeometry(
  geometry: ArrowheadGeometry,
  dx: number,
  dy: number,
): ArrowheadGeometry {
  if (dx === 0 && dy === 0) {
    return geometry;
  }
  return geometry.kind === "circle"
    ? { ...geometry, cx: geometry.cx + dx, cy: geometry.cy + dy }
    : { ...geometry, points: geometry.points.map((point) => ({ x: point.x + dx, y: point.y + dy })) };
}

/** Whether the head's ink covers the whole width of the line where the line ends at `x`. */
export function arrowheadInkCoversLineAtX(geometry: ArrowheadGeometry, x: number, axisY: number): boolean {
  return coversLine(getArrowheadInk(geometry), x, axisY);
}

/**
 * Where the line's own stroke has to stop.
 *
 * The rear-most place the head is already at least as wide as the line, plus half a stroke width so
 * the join is buried in ink rather than balanced on the edge of it — and never past the head's own
 * point, so the shaft cannot reach into the tip a head narrows to.
 *
 * Returning `frontX` is the honest failure: a head whose ink never covers the line (one drawn with
 * a pen thinner than the line, which is what `MIN_OPEN_HEAD_STROKE` exists to prevent) gets the
 * drawing it had before this existed, and `arrowhead-spec.test.ts` fails rather than the page
 * quietly showing a stub.
 */
export function findArrowheadLineStopX(
  geometry: ArrowheadGeometry,
  axisY: number,
  frontX: number,
): number {
  const ink = getArrowheadInk(geometry);
  const { minX } = getArrowheadInkBounds(geometry);
  if (!Number.isFinite(minX) || !(frontX > minX)) {
    return frontX;
  }

  // Fine enough to find the edge of the covered region, then bisected to a hundredth of that: the
  // head is only a handful of units long, so this is a few hundred interval tests per head.
  const step = (frontX - minX) / 256;
  let covered: number | null = null;
  for (let x = minX; x <= frontX; x += step) {
    if (coversLineFrom(ink, x, axisY)) {
      covered = x;
      break;
    }
  }
  if (covered === null) {
    return frontX;
  }

  let low = covered - step;
  let high = covered;
  for (let iteration = 0; iteration < 8; iteration += 1) {
    const middle = (low + high) / 2;
    if (coversLineFrom(ink, middle, axisY)) {
      high = middle;
    } else {
      low = middle;
    }
  }

  return Math.min(high + LINE_END_OVERLAP, frontX);
}

/** Covered at `x`, and still covered across the overlap the line's end is about to sit in. */
function coversLineFrom(ink: ArrowheadInk, x: number, axisY: number): boolean {
  for (let step = 0; step <= 4; step += 1) {
    if (!coversLine(ink, x + (LINE_END_OVERLAP * step) / 4, axisY)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether one connected piece of ink spans the line's full width at `x`.
 *
 * One piece, not several: two arms that have opened past each other cover both edges of the line
 * and leave the middle empty, which is a notch and not a join.
 */
function coversLine(ink: ArrowheadInk, x: number, axisY: number): boolean {
  const top = axisY - ARROWHEAD_LINE_WIDTH / 2;
  const bottom = axisY + ARROWHEAD_LINE_WIDTH / 2;
  const spans: { from: number; to: number }[] = [];
  for (const polygon of ink.polygons) {
    spans.push(...polygonSpansAtX(polygon, x));
  }
  if (ink.circle) {
    const dx = x - ink.circle.cx;
    if (Math.abs(dx) < ink.circle.r) {
      const half = Math.sqrt(ink.circle.r * ink.circle.r - dx * dx);
      spans.push({ from: ink.circle.cy - half, to: ink.circle.cy + half });
    }
  }

  spans.sort((left, right) => left.from - right.from);
  let merged: { from: number; to: number } | null = null;
  for (const span of spans) {
    if (merged && span.from <= merged.to) {
      merged = { from: merged.from, to: Math.max(merged.to, span.to) };
    } else {
      merged = span;
    }
    if (merged.from <= top && merged.to >= bottom) {
      return true;
    }
  }
  return false;
}

/** The y spans a vertical line at `x` covers inside a simple polygon. */
function polygonSpansAtX(polygon: readonly ArrowheadPoint[], x: number): { from: number; to: number }[] {
  const crossings: number[] = [];
  for (let index = 0; index < polygon.length; index += 1) {
    const from = polygon[index];
    const to = polygon[(index + 1) % polygon.length];
    // Half-open in x, the usual scanline rule: a vertex shared by two edges is counted once, and a
    // vertical edge (which contributes no crossing) drops out on its own.
    if ((from.x <= x && to.x > x) || (to.x <= x && from.x > x)) {
      crossings.push(from.y + ((x - from.x) / (to.x - from.x)) * (to.y - from.y));
    }
  }
  crossings.sort((left, right) => left - right);
  const spans: { from: number; to: number }[] = [];
  for (let index = 0; index + 1 < crossings.length; index += 2) {
    spans.push({ from: crossings[index], to: crossings[index + 1] });
  }
  return spans;
}

function getArrowheadInk(geometry: ArrowheadGeometry): ArrowheadInk {
  if (geometry.kind === "circle") {
    return { polygons: [], circle: geometry.filled ? geometry : null };
  }

  const { points, closed, filled, strokeWidth } = geometry;
  if (filled) {
    // A filled outline is its own ink; the table gives these heads `strokeWidth: 0`.
    return { polygons: [points], circle: null };
  }
  if (points.length < 2 || !(strokeWidth > 0)) {
    return { polygons: [], circle: null };
  }

  const half = strokeWidth / 2;
  const polygons: ArrowheadPoint[][] = [];
  const segments = closed ? points.length : points.length - 1;
  const directions: ArrowheadPoint[] = [];
  for (let index = 0; index < segments; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    const direction = normalize({ x: to.x - from.x, y: to.y - from.y });
    directions.push(direction);
    // Butt caps: the rectangle stops flat on the end points.
    const normal = { x: -direction.y * half, y: direction.x * half };
    polygons.push([
      { x: from.x + normal.x, y: from.y + normal.y },
      { x: to.x + normal.x, y: to.y + normal.y },
      { x: to.x - normal.x, y: to.y - normal.y },
      { x: from.x - normal.x, y: from.y - normal.y },
    ]);
  }

  const joints = closed ? points.length : points.length - 1;
  for (let index = closed ? 0 : 1; index < joints; index += 1) {
    const incoming = directions[(index - 1 + directions.length) % directions.length];
    const outgoing = directions[index];
    const wedge = miterWedge(points[index], incoming, outgoing, half);
    if (wedge) {
      polygons.push(wedge);
    }
  }

  return { polygons, circle: null };
}

/**
 * The ink a miter join adds outside the two rectangles.
 *
 * `null` once the join is beveled: SVG replaces the point with a flat edge past `stroke-miterlimit`,
 * and the two rectangles already describe that.
 */
function miterWedge(
  vertex: ArrowheadPoint,
  incoming: ArrowheadPoint,
  outgoing: ArrowheadPoint,
  half: number,
): ArrowheadPoint[] | null {
  // |u1 + u2| is 2·sin(half the angle between the two segments), so the miter runs `stroke/opening`
  // past the vertex and SVG bevels it once `2 / opening` passes the miter limit.
  const opening = Math.hypot(incoming.x + outgoing.x, incoming.y + outgoing.y);
  if (opening <= 1e-9 || 2 / opening > MITER_LIMIT) {
    return null;
  }

  const bisector = normalize({ x: incoming.x - outgoing.x, y: incoming.y - outgoing.y });
  const tip = {
    x: vertex.x + (bisector.x * half * 2) / opening,
    y: vertex.y + (bisector.y * half * 2) / opening,
  };
  return [
    vertex,
    outerCorner(vertex, incoming, bisector, half),
    tip,
    outerCorner(vertex, outgoing, bisector, half),
  ];
}

/** The corner of one segment's rectangle on the outside of the turn. */
function outerCorner(
  vertex: ArrowheadPoint,
  direction: ArrowheadPoint,
  bisector: ArrowheadPoint,
  half: number,
): ArrowheadPoint {
  const normal = { x: -direction.y, y: direction.x };
  const sign = normal.x * bisector.x + normal.y * bisector.y >= 0 ? 1 : -1;
  return { x: vertex.x + normal.x * half * sign, y: vertex.y + normal.y * half * sign };
}

function normalize(vector: ArrowheadPoint): ArrowheadPoint {
  const length = Math.hypot(vector.x, vector.y);
  if (!Number.isFinite(length) || length <= 0) {
    return { x: 0, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}
