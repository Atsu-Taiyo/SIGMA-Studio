/**
 * The arrow drawn over `\vv{…}`: Sigma Studio's own design, built here from the
 * parameters in `VV_ARROW_DESIGN`. No font or outline data from elsewhere.
 *
 * The head is two tapered barb strokes with round ends. Their outer edges meet
 * in a sharp tip and their inner edges run into the shaft, a rule with a round
 * start. Units: 1 = 0.001em of the vector's size. The head is built with its
 * tip at the origin pointing +x and y up, then written in SVG coordinates
 * (y down from the ink top) as the two halves that `vv-vector.ts` stretches
 * across the operand.
 */
export const VV_ARROW_DESIGN = {
  /** Shaft thickness: the fraction-rule thickness of both math engines. */
  shaft: 40,
  /** The barb's end (its centreline), from the tip: back along the shaft and out from it. */
  barbBack: 230,
  barbOut: 100,
  /** The barb centreline's angle to the shaft at the tip and at its end (degrees): it sweeps back. */
  angleAtTip: 34,
  angleAtEnd: 20,
  /** Half of the barb's stroke width at the tip and at its round end. */
  halfWidthAtTip: 26,
  halfWidthAtEnd: 15,
  /** Where the shaft's round start begins, from the vector's left edge. */
  inset: 60,
  /** The narrowest vector (a single narrow operand is centred under it). */
  minWidth: 800,
  /** The shaft's centre above the operand's top. */
  clearance: 235,
} as const;

type Point = readonly [number, number];
type Cubic = readonly [Point, Point, Point, Point];

const rad = (deg: number) => (deg * Math.PI) / 180;
const add = (a: Point, b: Point): Point => [a[0] + b[0], a[1] + b[1]];
const sub = (a: Point, b: Point): Point => [a[0] - b[0], a[1] - b[1]];
const scale = (a: Point, k: number): Point => [a[0] * k, a[1] * k];
const unit = (a: Point): Point => scale(a, 1 / Math.hypot(a[0], a[1]));
const lerp = (a: Point, b: Point, t: number) => add(a, scale(sub(b, a), t));
/** The normal on the right of a direction of travel (y up). */
const right = (d: Point): Point => [d[1], -d[0]];

function splitCubic([p0, p1, p2, p3]: Cubic, t: number): [Cubic, Cubic] {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), m = lerp(d, e, t);
  return [[p0, a, d, m], [m, e, c, p3]];
}

const pointAt = (curve: Cubic, t: number) => splitCubic(curve, t)[0][3];

function intersect(p: Point, d: Point, q: Point, e: Point): Point | null {
  const cross = d[0] * e[1] - d[1] * e[0];
  if (Math.abs(cross) < 1e-9) return null;
  return add(p, scale(d, ((q[0] - p[0]) * e[1] - (q[1] - p[1]) * e[0]) / cross));
}

/**
 * One side of a stroke along `curve` whose half-width goes linearly from `w0`
 * to `w1`: the control polygon's legs moved out by the width at their ends and
 * re-intersected. Close enough for the gentle curves of the barbs.
 */
function offsetCubic(curve: Cubic, w0: number, w1: number, side: 1 | -1): Cubic {
  const width = (i: number) => w0 + ((w1 - w0) * i) / 3;
  const legs = [0, 1, 2].map((i) => unit(sub(curve[i + 1], curve[i])));
  const normals = legs.map((leg) => scale(right(leg), side));
  const corner = (i: 1 | 2) => intersect(
    add(curve[i], scale(normals[i - 1], width(i))), legs[i - 1],
    add(curve[i], scale(normals[i], width(i))), legs[i],
  ) ?? add(curve[i], scale(normals[i], width(i)));
  return [add(curve[0], scale(normals[0], w0)), corner(1), corner(2), add(curve[3], scale(normals[2], w1))];
}

/** The parameter where `curve` crosses height `y` (it rises monotonically there). */
function crossing(curve: Cubic, y: number): number {
  let low = 0, high = 1;
  for (let step = 0; step < 50; step += 1) {
    const middle = (low + high) / 2;
    if (pointAt(curve, middle)[1] < y) low = middle;
    else high = middle;
  }
  return (low + high) / 2;
}

interface Barb {
  /** Tip side (outer edge) and shaft side (inner edge), both running from the shaft out to the barb's end. */
  outer: Cubic;
  inner: Cubic;
  end: Point;
}

/** The upper barb, tip at the origin. */
function upperBarb(): Barb {
  const { shaft, barbBack, barbOut, angleAtTip, angleAtEnd, halfWidthAtTip: w0, halfWidthAtEnd: w1 } = VV_ARROW_DESIGN;
  const leave: Point = [-Math.cos(rad(angleAtTip)), Math.sin(rad(angleAtTip))];
  const arrive: Point = [-Math.cos(rad(angleAtEnd)), Math.sin(rad(angleAtEnd))];
  // Start the centreline behind the tip so that its outer edge, run on along
  // the starting direction, meets the shaft's axis exactly at the tip.
  const start: Point = [-w0 / Math.sin(rad(angleAtTip)), 0];
  const end: Point = [-barbBack, barbOut];
  const reach = Math.hypot(end[0] - start[0], end[1] - start[1]) * 0.36;
  const centre: Cubic = [start, add(start, scale(leave, reach)), sub(end, scale(arrive, reach)), end];
  const inner = offsetCubic(centre, w0, w1, -1);
  return { outer: offsetCubic(centre, w0, w1, 1), inner: splitCubic(inner, crossing(inner, shaft / 2))[1], end };
}

const BARB = upperBarb();
const round = (value: number) => Number(value.toFixed(2));

/** The ink's half height around the shaft's axis: the barb's round end is outermost. */
const HALF_HEIGHT = Math.ceil(Math.max(
  BARB.end[1] + VV_ARROW_DESIGN.halfWidthAtEnd,
  ...Array.from({ length: 17 }, (_, i) => pointAt(BARB.outer, i / 16)[1]),
));

/** The arrow's ink height (font units; it is also the slices' viewBox height). */
export const VV_ARROW_HEIGHT = 2 * HALF_HEIGHT;
/** The ink top above the operand's top. */
export const VV_ARROW_RISE = VV_ARROW_DESIGN.clearance + HALF_HEIGHT;
/** The slices' viewBox width, as MathLive's own stretchy SVGs. */
export const VV_ARROW_SLICE_WIDTH = 400000;

/** The head with its tip at `[tipX, axis]` in SVG coordinates. */
function headPath(tipX: number, axis: number): string {
  const { halfWidthAtEnd: radius } = VV_ARROW_DESIGN;
  const at = (point: Point, side: 1 | -1) => `${round(tipX + point[0])} ${round(axis - side * point[1])}`;
  const { outer, inner } = BARB;
  const r = round(radius);
  const tip = at([0, 0], 1);
  return [
    `M${at(inner[0], 1)}C${at(inner[1], 1)} ${at(inner[2], 1)} ${at(inner[3], 1)}`,
    `A${r} ${r} 0 0 1 ${at(outer[3], 1)}`,
    `C${at(outer[2], 1)} ${at(outer[1], 1)} ${at(outer[0], 1)}L${tip}`,
    `L${at(outer[0], -1)}C${at(outer[1], -1)} ${at(outer[2], -1)} ${at(outer[3], -1)}`,
    `A${r} ${r} 0 0 1 ${at(inner[3], -1)}`,
    `C${at(inner[2], -1)} ${at(inner[1], -1)} ${at(inner[0], -1)}Z`,
  ].join("");
}

const AXIS = HALF_HEIGHT;
const SHAFT_TOP = round(AXIS - VV_ARROW_DESIGN.shaft / 2);
const SHAFT_BOTTOM = round(AXIS + VV_ARROW_DESIGN.shaft / 2);

/** Left half (xMinYMin): the shaft's round start at the inset, then the shaft to the far right. */
export const VV_ARROW_LEFT_SLICE_PATHS: readonly string[] = (() => {
  const r = VV_ARROW_DESIGN.shaft / 2;
  const x = VV_ARROW_DESIGN.inset + r;
  return [`M${x} ${SHAFT_TOP}H${VV_ARROW_SLICE_WIDTH}V${SHAFT_BOTTOM}H${x}A${r} ${r} 0 0 1 ${x} ${SHAFT_TOP}Z`];
})();

/** Right half (xMaxYMin): the shaft from the far left into the head, whose tip is flush right. */
export const VV_ARROW_RIGHT_SLICE_PATHS: readonly string[] = (() => {
  const shaftEnd = round(VV_ARROW_SLICE_WIDTH + BARB.inner[0][0] + 10); // into the head's solid core
  return [`M0 ${SHAFT_TOP}H${shaftEnd}V${SHAFT_BOTTOM}H0Z`, headPath(VV_ARROW_SLICE_WIDTH, AXIS)];
})();
