import type { OverlayLineKind, OverlayPoint } from "@/features/document";

export function normalizeLineKind(kind: OverlayLineKind | undefined): OverlayLineKind {
  return kind ?? "polyline";
}

export function isEditableLineKind(kind: OverlayLineKind | undefined): boolean {
  return normalizeLineKind(kind) !== "freehand";
}

export function isClosedPolyline(
  kind: OverlayLineKind | undefined,
  points: OverlayPoint[],
  closed: boolean,
): boolean {
  return normalizeLineKind(kind) === "polyline" && closed === true && points.length >= 3;
}

/**
 * How much of the drawn path each end gives up, in px.
 *
 * Zero at both ends means "draw the path exactly as it was drawn before this existed": the emitted
 * string is byte-for-byte what the untrimmed builder produced, which is what keeps a shape with no
 * arrow head — and a closed one, and a sector — untouched by this feature.
 */
export interface LinePathTrim {
  readonly start: number;
  readonly end: number;
}

export function getLineSvgPath(
  points: OverlayPoint[],
  kind: OverlayLineKind | undefined,
  trim?: LinePathTrim,
): string {
  if (points.length === 0) {
    return "";
  }

  const segments = trimPathSegments(
    getLinePathSegments(points, kind),
    trim,
    normalizeLineKind(kind) !== "polyline",
  );
  if (segments.length === 0) {
    return `M ${formatPoint(points[0])}`;
  }
  return segmentsToPath(segments);
}

/**
 * The total drawn length, used to keep a short line from being trimmed out of existence.
 *
 * Curved segments are measured by their chord, which under-reports. That is the safe direction —
 * the number is a budget, and a smaller budget trims less — and it keeps a freehand stroke of a
 * few hundred points from re-sampling every curve on every render.
 */
export function getLinePathLength(points: OverlayPoint[], kind: OverlayLineKind | undefined): number {
  return getLinePathSegments(points, kind)
    .reduce((total, segment) => total + Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y), 0);
}

/**
 * The budget a trim at each end may not exhaust.
 *
 * `orient="auto"` points a head along the segment the path ends on, so on a **polyline** this is
 * that segment: consume it and the head swings to the direction of the corner before it. A smooth
 * path has no corners — its segments meet tangentially — so a trim may cross a join without moving
 * the head at all, and the budget is the whole path (which the total clamp already bounds). Giving
 * a curve the terminal-segment budget would be wrong twice over, because a four-point curve's last
 * command is only half of its last control leg and would be clamped at half a polyline's budget.
 */
export function getLineTerminalSegmentLengths(
  points: OverlayPoint[],
  kind: OverlayLineKind | undefined,
): { start: number; end: number } {
  const segments = getLinePathSegments(points, kind);
  if (segments.length === 0) {
    return { start: 0, end: 0 };
  }
  if (normalizeLineKind(kind) !== "polyline") {
    const total = getLinePathLength(points, kind);
    return { start: total, end: total };
  }
  return {
    start: segmentLength(segments[0]),
    end: segmentLength(segments[segments.length - 1]),
  };
}

/**
 * The same path, pulled back from each end, still as a point list.
 *
 * Straight paths keep their `<polyline>` form this way, and no vertex is ever dropped: each end is
 * clamped against the segment it sits on, and the end trim is measured after the start trim so the
 * two cannot cross on a two-point line.
 */
export function trimPolylinePoints(
  points: OverlayPoint[],
  startTrim: number,
  endTrim: number,
): OverlayPoint[] {
  if (points.length < 2) {
    return [...points];
  }

  const result = [...points];
  const last = result.length - 1;
  result[0] = advanceTowards(result[0], result[1], startTrim);
  result[last] = advanceTowards(result[last], result[last - 1], endTrim);
  return result;
}

/** Move `from` towards `towards` by `distance`, never past the clamp that protects the vertex. */
function advanceTowards(from: OverlayPoint, towards: OverlayPoint, distance: number): OverlayPoint {
  if (!Number.isFinite(distance) || distance <= 0) {
    return from;
  }
  const dx = towards.x - from.x;
  const dy = towards.y - from.y;
  const length = Math.hypot(dx, dy);
  if (!Number.isFinite(length) || length <= 0) {
    // Two finite but enormous coordinates still produce a non-finite difference; a NaN here would
    // reach the document as `null` and the material would no longer open.
    return from;
  }
  const travel = Math.min(distance, length * MAX_TERMINAL_TRIM_RATIO);
  return { x: from.x + (dx / length) * travel, y: from.y + (dy / length) * travel };
}

/**
 * Never take a whole terminal segment.
 *
 * Kept here as well as in the planner: these helpers are called with numbers the planner produced,
 * but they are exported and total functions have to stay total.
 */
const MAX_TERMINAL_TRIM_RATIO = 0.9;

export function getLinePolylinePoints(points: OverlayPoint[]): string {
  return points.map((point) => `${point.x},${point.y}`).join(" ");
}

export function getLineMidpoint(points: OverlayPoint[]): OverlayPoint | null {
  if (points.length === 0) {
    return null;
  }

  return points[Math.floor(points.length / 2)];
}

export function getDefaultCurvePoints(start: OverlayPoint, end: OverlayPoint): OverlayPoint[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const bend = Math.min(72, Math.max(28, length * 0.24));
  const normal = {
    x: -dy / length,
    y: dx / length,
  };

  return [
    { x: 0, y: 0 },
    {
      x: dx / 2 + normal.x * bend,
      y: dy / 2 + normal.y * bend,
    },
    { x: dx, y: dy },
  ];
}

/**
 * Where the "add a point here" handles sit, and which index each one would insert at.
 *
 * One per segment, at the midpoint of the control polygon — not of the drawn ink. For a polyline
 * the two are the same thing. For a curve they coincide only on the interior segments, where
 * `pointsToSmoothPath` joins its quadratics at exactly that midpoint; the first and last segments
 * bow away from it. That is the same trade external canvas editors makes, and the alternative (solving for a point
 * on the curve) would put the handle somewhere the author did not click.
 *
 * Modeled after the interaction pattern used by external canvas editors, whose line tool offers a create-handle
 * between every pair of vertices and hides the ones that sit too close to a real vertex; the code
 * here is written against this project's own point model.
 *
 * Never returns index 0. `points[0]` is the shape's origin — `shape.x/y` are stored relative to it
 * — so inserting there would move the whole figure.
 */
export function getLineInsertHandlePoints(
  points: OverlayPoint[],
  kind: OverlayLineKind | undefined,
  closed: boolean,
): Array<{ index: number; point: OverlayPoint }> {
  if (!isEditableLineKind(kind) || points.length < 2) {
    return [];
  }

  const segments: Array<{ index: number; from: OverlayPoint; to: OverlayPoint }> = [];
  for (let index = 1; index < points.length; index += 1) {
    segments.push({ index, from: points[index - 1], to: points[index] });
  }
  if (isClosedPolyline(kind, points, closed)) {
    // The closing edge is a segment too, and its new point belongs at the end of the list.
    segments.push({ index: points.length, from: points[points.length - 1], to: points[0] });
  }

  const handles: Array<{ index: number; point: OverlayPoint }> = [];
  for (const segment of segments) {
    if (Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y) < INSERT_HANDLE_MIN_SEGMENT) {
      // Too short: the midpoint handle would sit under the vertex handles and neither would be
      // grabbable. Better to offer nothing than to offer something that cannot be hit.
      continue;
    }
    const point = {
      x: (segment.from.x + segment.to.x) / 2,
      y: (segment.from.y + segment.to.y) / 2,
    };
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      // Two finite but enormous coordinates still sum to Infinity. Such a point would be written to
      // the document as `null` and the material would no longer open.
      continue;
    }
    handles.push({ index: segment.index, point });
  }
  return handles;
}

export function insertLinePointAt(
  points: OverlayPoint[],
  index: number,
  point: OverlayPoint,
): OverlayPoint[] {
  const safeIndex = Math.min(points.length, Math.max(1, index));
  return [...points.slice(0, safeIndex), point, ...points.slice(safeIndex)];
}

export function canRemoveLinePointAt(
  points: OverlayPoint[],
  index: number,
  closed: boolean,
): boolean {
  if (index <= 0 || index >= points.length) {
    // Index 0 is the shape's origin; removing it would re-base every other point.
    return false;
  }
  const minimum = closed && points.length >= 3 ? MIN_CLOSED_POINTS : MIN_OPEN_POINTS;
  return points.length - 1 >= minimum;
}

export function removeLinePointAt(points: OverlayPoint[], index: number): OverlayPoint[] {
  return points.filter((_, current) => current !== index);
}

/**
 * The shortest segment that still gets a midpoint handle.
 *
 * A vertex handle grabs within ±10px of its centre (8px wide, plus `::after { inset: -6px }`), and
 * this handle within ±9px of its own. The midpoint of a 40px segment therefore sits 20px from each
 * vertex and keeps a band it can actually be grabbed by; at 24px the vertices — which are drawn
 * above it — would leave only a few pixels. Also far above both duplicate-point filters
 * (`normalizeCurvePoints` drops points within 0.5px, the drawing commit within 2px), so a point
 * added here can never be dropped again on save.
 */
const INSERT_HANDLE_MIN_SEGMENT = 40;
const MIN_OPEN_POINTS = 2;
const MIN_CLOSED_POINTS = 3;

export function normalizeCurvePoints(
  points: OverlayPoint[],
  start: OverlayPoint,
  end: OverlayPoint,
): OverlayPoint[] {
  const source = points.length >= 2 ? points : [start, end];
  const origin = source[0] ?? start;
  return removeNearDuplicatePoints(source.map((point) => ({
    x: point.x - origin.x,
    y: point.y - origin.y,
  })), 0.5);
}

export function normalizeFreehandPoints(
  points: OverlayPoint[],
  start: OverlayPoint,
  end: OverlayPoint,
): OverlayPoint[] {
  const source = points.length >= 2 ? points : [start, end];
  const origin = source[0] ?? start;
  const localPoints = source.map((point) => ({
    x: point.x - origin.x,
    y: point.y - origin.y,
  }));

  return removeNearDuplicatePoints(localPoints, 1.5);
}

/**
 * The drawn path as segments.
 *
 * The single description of what a line draws. A polyline is its own segments; everything else is
 * smoothed — with three points one quadratic, with more a quadratic per interior point ending at
 * the midpoint of the next control leg, then a straight run into the last point. Emitting from
 * this list reproduces the strings the two hand-written builders used to produce, character for
 * character, and it is also what makes the ends trimmable.
 */
type LinePathSegment =
  | { readonly kind: "line"; readonly from: OverlayPoint; readonly to: OverlayPoint }
  | { readonly kind: "quad"; readonly from: OverlayPoint; readonly control: OverlayPoint; readonly to: OverlayPoint };

function getLinePathSegments(points: OverlayPoint[], kind: OverlayLineKind | undefined): LinePathSegment[] {
  if (points.length < 2) {
    return [];
  }

  if (normalizeLineKind(kind) === "polyline" || points.length < 3) {
    const segments: LinePathSegment[] = [];
    for (let index = 1; index < points.length; index += 1) {
      segments.push({ kind: "line", from: points[index - 1], to: points[index] });
    }
    return segments;
  }

  if (points.length === 3) {
    return [{ kind: "quad", from: points[0], control: points[1], to: points[2] }];
  }

  const segments: LinePathSegment[] = [];
  let from = points[0];
  for (let index = 1; index < points.length - 1; index += 1) {
    const control = points[index];
    const next = points[index + 1];
    const to = { x: (control.x + next.x) / 2, y: (control.y + next.y) / 2 };
    segments.push({ kind: "quad", from, control, to });
    from = to;
  }
  segments.push({ kind: "line", from, to: points[points.length - 1] });
  return segments;
}

function segmentsToPath(segments: LinePathSegment[]): string {
  const commands = [`M ${formatPoint(segments[0].from)}`];
  for (const segment of segments) {
    commands.push(segment.kind === "quad"
      ? `Q ${formatPoint(segment.control)} ${formatPoint(segment.to)}`
      : `L ${formatPoint(segment.to)}`);
  }
  return commands.join(" ");
}

function trimPathSegments(
  segments: LinePathSegment[],
  trim: LinePathTrim | undefined,
  crossJoins: boolean,
): LinePathSegment[] {
  if (!trim || segments.length === 0) {
    return segments;
  }
  // The end trim is measured on what the start trim left, so the two can never cross.
  return trimSegmentsFromEnd(trimSegmentsFromStart(segments, trim.start, crossJoins), trim.end, crossJoins);
}

function trimSegmentsFromStart(
  segments: LinePathSegment[],
  distance: number,
  crossJoins: boolean,
): LinePathSegment[] {
  let remaining = distance;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return segments;
  }

  let index = 0;
  while (index < segments.length) {
    const segment = segments[index];
    const length = segmentLength(segment);
    const isLast = index === segments.length - 1;
    if (!crossJoins || isLast || remaining < length) {
      // Crossing a join costs nothing on a smooth path, so the 0.9 guard is only needed where a cut
      // would leave nothing behind. Applying it to a landing segment too would take less than the
      // plan asked for, and `refX` — already moved by the full amount — would push the head past
      // the endpoint.
      const travel = crossJoins && !isLast ? remaining : clampTravel(remaining, length);
      if (travel <= 0) {
        return segments.slice(index);
      }
      const tail = splitSegment(segment, parameterAtLength(segment, travel)).tail;
      return [tail, ...segments.slice(index + 1)];
    }
    remaining -= length;
    index += 1;
  }
  return segments;
}

function trimSegmentsFromEnd(
  segments: LinePathSegment[],
  distance: number,
  crossJoins: boolean,
): LinePathSegment[] {
  let remaining = distance;
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return segments;
  }

  let index = segments.length - 1;
  while (index >= 0) {
    const segment = segments[index];
    const length = segmentLength(segment);
    const isLast = index === 0;
    if (!crossJoins || isLast || remaining < length) {
      const travel = crossJoins && !isLast ? remaining : clampTravel(remaining, length);
      if (travel <= 0) {
        return segments.slice(0, index + 1);
      }
      const head = splitSegment(segment, parameterAtLength(segment, length - travel)).head;
      return [...segments.slice(0, index), head];
    }
    remaining -= length;
    index -= 1;
  }
  return segments;
}

function clampTravel(distance: number, length: number): number {
  if (!Number.isFinite(distance) || distance <= 0 || !Number.isFinite(length) || length <= 0) {
    return 0;
  }
  return Math.min(distance, length * MAX_TERMINAL_TRIM_RATIO);
}

function segmentLength(segment: LinePathSegment): number {
  if (segment.kind === "line") {
    return Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  }
  return quadraticSamples(segment)[QUADRATIC_SAMPLES];
}

/** Cumulative chord lengths at `QUADRATIC_SAMPLES + 1` evenly spaced parameters. */
function quadraticSamples(segment: Extract<LinePathSegment, { kind: "quad" }>): number[] {
  const cumulative = [0];
  let previous = segment.from;
  for (let step = 1; step <= QUADRATIC_SAMPLES; step += 1) {
    const point = quadraticAt(segment, step / QUADRATIC_SAMPLES);
    cumulative.push(cumulative[step - 1] + Math.hypot(point.x - previous.x, point.y - previous.y));
    previous = point;
  }
  return cumulative;
}

function parameterAtLength(segment: LinePathSegment, length: number): number {
  const total = segmentLength(segment);
  if (!Number.isFinite(total) || total <= 0) {
    return 0;
  }
  if (segment.kind === "line") {
    return Math.min(1, Math.max(0, length / total));
  }

  const cumulative = quadraticSamples(segment);
  for (let step = 1; step <= QUADRATIC_SAMPLES; step += 1) {
    if (cumulative[step] >= length) {
      const span = cumulative[step] - cumulative[step - 1];
      const within = span > 0 ? (length - cumulative[step - 1]) / span : 0;
      return (step - 1 + within) / QUADRATIC_SAMPLES;
    }
  }
  return 1;
}

function splitSegment(segment: LinePathSegment, t: number): { head: LinePathSegment; tail: LinePathSegment } {
  if (segment.kind === "line") {
    const at = lerp(segment.from, segment.to, t);
    return {
      head: { kind: "line", from: segment.from, to: at },
      tail: { kind: "line", from: at, to: segment.to },
    };
  }

  // de Casteljau: the two halves of a quadratic are quadratics, so a trimmed curve is still drawn
  // by the same `Q` command and stays exactly on the original curve.
  const left = lerp(segment.from, segment.control, t);
  const right = lerp(segment.control, segment.to, t);
  const at = lerp(left, right, t);
  return {
    head: { kind: "quad", from: segment.from, control: left, to: at },
    tail: { kind: "quad", from: at, control: right, to: segment.to },
  };
}

function quadraticAt(segment: Extract<LinePathSegment, { kind: "quad" }>, t: number): OverlayPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * segment.from.x + 2 * inverse * t * segment.control.x + t * t * segment.to.x,
    y: inverse * inverse * segment.from.y + 2 * inverse * t * segment.control.y + t * t * segment.to.y,
  };
}

function lerp(from: OverlayPoint, to: OverlayPoint, t: number): OverlayPoint {
  return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
}

/** Enough to keep the arc-length error of a trim under a tenth of a pixel at editor scale. */
const QUADRATIC_SAMPLES = 64;

function removeNearDuplicatePoints(points: OverlayPoint[], minDistance: number): OverlayPoint[] {
  const simplified: OverlayPoint[] = [];
  for (const point of points) {
    const previous = simplified[simplified.length - 1];
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) >= minDistance) {
      simplified.push(point);
    }
  }

  const lastSource = points[points.length - 1];
  const lastSimplified = simplified[simplified.length - 1];
  if (lastSource && lastSimplified && (lastSource.x !== lastSimplified.x || lastSource.y !== lastSimplified.y)) {
    simplified.push(lastSource);
  }

  return simplified.length >= 2 ? simplified : points;
}

function formatPoint(point: OverlayPoint): string {
  return `${formatNumber(point.x)} ${formatNumber(point.y)}`;
}

function formatNumber(value: number): string {
  return Number(value.toFixed(2)).toString();
}
