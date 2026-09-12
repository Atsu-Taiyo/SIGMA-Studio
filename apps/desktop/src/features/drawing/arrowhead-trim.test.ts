import { describe, expect, it } from "vitest";

import type {
  OverlayArcShape,
  OverlayArrowShape,
  OverlayLineShape,
  OverlayPoint,
} from "@/features/document";
import {
  ARROWHEAD_MARKER_SPECS,
  getArrowheadTrimInStrokes,
  overlayStrokeWidth,
} from "@/features/rendering/core";

import { getArcDrawnAngles, getArrowheadPathTrim, getShapeArrowheadPlan } from "./arrowhead-trim";
import { getLineSvgPath, trimPolylinePoints } from "./line-geometry";

/**
 * The reported bug: a line drawn all the way to the endpoint pokes out of the arrow head, because
 * `stroke-linecap: butt` squares the line off where the head is still a point. The fix shortens the
 * drawn path and pushes the marker's reference point back by the same amount, so the head's point
 * — not the line's stub — is what sits on the coordinate the document stores.
 */

function arrow(props: Partial<OverlayArrowShape["props"]> = {}): OverlayArrowShape {
  return {
    id: "overlay_shape_arrow",
    type: "arrow",
    x: 40,
    y: 60,
    props: {
      start: { x: 0, y: 0 },
      end: { x: 200, y: 0 },
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayArrowShape;
}

function line(props: Partial<OverlayLineShape["props"]> = {}): OverlayLineShape {
  return {
    id: "overlay_shape_line",
    type: "line",
    x: 0,
    y: 0,
    props: {
      points: [{ x: 0, y: 0 }, { x: 120, y: 0 }],
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayLineShape;
}

function arc(props: Partial<OverlayArcShape["props"]> = {}): OverlayArcShape {
  return {
    id: "overlay_shape_arc",
    type: "arc",
    x: 0,
    y: 0,
    props: {
      r: 100,
      startAngle: 0,
      endAngle: Math.PI / 2,
      kind: "arc",
      fill: "none",
      color: "#111827",
      labelColor: "#111827",
      dash: "solid",
      size: "m",
      ...props,
    },
  } as OverlayArcShape;
}

function drawnPoints(shape: OverlayLineShape | OverlayArrowShape): OverlayPoint[] {
  const plan = getShapeArrowheadPlan(shape);
  const points = shape.type === "arrow" ? [shape.props.start, shape.props.end] : shape.props.points;
  return trimPolylinePoints(points, plan.start.trimPx, plan.end.trimPx);
}

describe("how far the drawn path is pulled back", () => {
  it("stops a diamond-tipped line short of the endpoint by the head's own length", () => {
    // The diamond's point is at 9 and the line has to stop where the diamond is already wider than
    // the line, which `arrowhead-spec.ts` measures off the outline. At `m` that is 2px per unit.
    const points = drawnPoints(arrow({ arrowheadEnd: "diamond" }));

    expect(points[1].x).toBeCloseTo(200 - getArrowheadTrimInStrokes("diamond") * 2, 6);
    expect(points[0].x).toBe(0);
  });

  it("leaves a headless line exactly where it was", () => {
    const shape = arrow();

    expect(drawnPoints(shape)).toEqual([{ x: 0, y: 0 }, { x: 200, y: 0 }]);
    expect(getArrowheadPathTrim(getShapeArrowheadPlan(shape))).toEqual({ start: 0, end: 0 });
  });

  it.each(ARROWHEAD_MARKER_SPECS)(
    "puts the point of $kind on the stored endpoint for every line width",
    (spec) => {
      for (const size of ["s", "m", "l", "xl"] as const) {
        const strokeWidth = overlayStrokeWidth(size);
        const plan = getShapeArrowheadPlan(arrow({ arrowheadEnd: spec.kind, size }));
        // The invariant this whole feature rests on. If the two numbers ever drift apart, the head
        // stops sitting on the endpoint the author placed. Asserted through a label so a failure
        // names the size that broke.
        const label = `${spec.kind}/${size}`;
        const anchored = plan.end.refX + plan.end.trimPx / strokeWidth;
        expect(`${label}:${Math.abs(anchored - spec.tipX) < 1e-9}`).toBe(`${label}:true`);
      }
    },
  );

  it("scales the trim with the line width, not with a fixed number of pixels", () => {
    const thin = getShapeArrowheadPlan(arrow({ arrowheadEnd: "diamond", size: "s" }));
    const thick = getShapeArrowheadPlan(arrow({ arrowheadEnd: "diamond", size: "xl" }));

    expect(thick.end.trimPx / thin.end.trimPx).toBeCloseTo(5 / 1.25, 6);
  });
});

describe("shapes that draw no head", () => {
  it("does not shorten a closed polyline", () => {
    const shape = line({
      points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 50, y: 80 }],
      closed: true,
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
    });

    expect(getShapeArrowheadPlan(shape)).toEqual({
      start: { spec: null, trimPx: 0, refX: 0 },
      end: { spec: null, trimPx: 0, refX: 0 },
    });
    expect(drawnPoints(shape)).toEqual(shape.props.points);
  });

  it("does not shorten a sector", () => {
    const shape = arc({ kind: "sector", arrowheadStart: "triangle", arrowheadEnd: "triangle" });

    expect(getArcDrawnAngles(shape)).toEqual({ startAngle: 0, endAngle: Math.PI / 2 });
  });

  it("leaves the path string byte-for-byte identical when nothing is trimmed", () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: -30 }, { x: 90, y: 20 }, { x: 140, y: 0 }];

    expect(getLineSvgPath(points, "curve", { start: 0, end: 0 })).toBe(getLineSvgPath(points, "curve"));
    expect(getLineSvgPath(points, "polyline", { start: 0, end: 0 })).toBe(getLineSvgPath(points, "polyline"));
  });
});

describe("clamping", () => {
  it("never eats the terminal segment, so the head keeps pointing along it", () => {
    // A diamond at `xl` asks for far more than this last segment is long. Consuming it would hand
    // `orient="auto"` the direction of the segment before it and swing the head sideways.
    const shape = line({
      points: [{ x: 0, y: 0 }, { x: 200, y: 0 }, { x: 200, y: 20 }],
      arrowheadEnd: "diamond",
      size: "xl",
    });
    const points = drawnPoints(shape);

    expect(points[2].y).toBeGreaterThan(points[1].y);
    expect(points[2].y).toBeCloseTo(2, 6);
    expect(points[1]).toEqual({ x: 200, y: 0 });
  });

  it("keeps a very short two-headed line from collapsing or turning inside out", () => {
    const shape = arrow({
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
      size: "xl",
    });
    const points = drawnPoints(shape);

    expect(points[1].x).toBeGreaterThan(points[0].x);
    expect(points[0].x).toBeGreaterThanOrEqual(0);
    expect(points[1].x).toBeLessThanOrEqual(20);
  });

  it("still lands the head on the endpoint after a clamp", () => {
    const shape = arrow({
      start: { x: 0, y: 0 },
      end: { x: 20, y: 0 },
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
      size: "xl",
    });
    const plan = getShapeArrowheadPlan(shape);

    for (const placement of [plan.start, plan.end]) {
      expect(placement.refX + placement.trimPx / 5).toBeCloseTo(9, 9);
    }
  });

  it("produces no NaN from coordinates a broken document may hold", () => {
    const shape = line({
      points: [{ x: 0, y: 0 }, { x: Number.NaN, y: 0 }],
      arrowheadEnd: "diamond",
    });
    const points = drawnPoints(shape);

    expect(Number.isFinite(points[0].x)).toBe(true);
    expect(getShapeArrowheadPlan(shape).end.trimPx).toBe(0);
  });
});

describe("curves", () => {
  it("cuts a three-point curve along the curve itself", () => {
    const points = [{ x: 0, y: 0 }, { x: 100, y: 100 }, { x: 200, y: 0 }];
    const trimmed = getLineSvgPath(points, "curve", { start: 0, end: 20 });
    const [, x, y] = /Q [-\d.]+ [-\d.]+ ([-\d.]+) ([-\d.]+)$/.exec(trimmed) ?? [];

    // The new end has to sit on the original quadratic, not on the chord between its points.
    const end = { x: Number(x), y: Number(y) };
    const onCurve = closestQuadraticPoint(points[0], points[1], points[2], end);
    expect(Math.hypot(end.x - onCurve.x, end.y - onCurve.y)).toBeLessThan(0.05);
    expect(arcLengthFromEnd(points, end)).toBeCloseTo(20, 0);
  });

  it("cuts the straight tail of a four-point curve linearly", () => {
    const points = [{ x: 0, y: 0 }, { x: 40, y: -40 }, { x: 120, y: -40 }, { x: 200, y: 0 }];
    const trimmed = getLineSvgPath(points, "curve", { start: 0, end: 10 });
    const [, x, y] = /L ([-\d.]+) ([-\d.]+)$/.exec(trimmed) ?? [];

    // The last command of a four-point curve is a straight run from the midpoint of the last
    // control leg into the final point, so the trimmed end is a plain interpolation on it.
    const tailLength = Math.hypot(points[3].x - points[2].x, points[3].y - points[2].y) / 2;
    const ratio = (tailLength - 10) / tailLength;
    const from = { x: (points[2].x + points[3].x) / 2, y: (points[2].y + points[3].y) / 2 };
    expect(Number(x)).toBeCloseTo(from.x + (points[3].x - from.x) * ratio, 1);
    expect(Number(y)).toBeCloseTo(from.y + (points[3].y - from.y) * ratio, 1);
  });

  it("gives a curve's two ends the same budget", () => {
    // A four-point curve's last command is only half of its last control leg, so measuring the
    // budget per drawn segment would clamp the end at half of what the start gets — the head would
    // be seated correctly at one end of the same shape and poke out at the other. A smooth path has
    // no corners, so a trim may cross a join and the budget is the whole path.
    const shape = line({
      kind: "curve",
      points: [{ x: 0, y: 0 }, { x: 40, y: -60 }, { x: 120, y: -60 }, { x: 180, y: 0 }],
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
      size: "xl",
    });
    const plan = getShapeArrowheadPlan(shape);

    expect(plan.start.trimPx).toBeCloseTo(getArrowheadTrimInStrokes("diamond") * 5, 6);
    expect(plan.end.trimPx).toBeCloseTo(plan.start.trimPx, 6);
  });

  it("takes exactly what the plan asked for when the cut lands mid-curve", () => {
    // The per-segment 0.9 guard exists to keep a polyline's terminal vertex. On a smooth path it
    // would take less than planned, and `refX` — already moved by the full amount — would push the
    // head that far past the endpoint.
    const points = [{ x: 0, y: 0 }, { x: 60, y: -50 }, { x: 140, y: -50 }, { x: 220, y: -50 }];
    const shape = line({ kind: "curve", points, arrowheadEnd: "diamond", size: "xl" });
    const plan = getShapeArrowheadPlan(shape);
    const trimmed = getLineSvgPath(points, "curve", getArrowheadPathTrim(plan));

    expect(plan.end.trimPx).toBeCloseTo(getArrowheadTrimInStrokes("diamond") * 5, 6);
    expect(pathLengthOf(trimmed)).toBeCloseTo(pathLengthOf(getLineSvgPath(points, "curve")) - plan.end.trimPx, 1);
  });

  it("keeps a freehand stroke's own head trimmed too", () => {
    const shape = line({
      kind: "freehand",
      points: [{ x: 0, y: 0 }, { x: 30, y: 10 }, { x: 60, y: 0 }, { x: 90, y: 10 }, { x: 120, y: 0 }],
      arrowheadEnd: "triangle",
    });

    expect(getShapeArrowheadPlan(shape).end.trimPx).toBeCloseTo(5.5 * 2, 6);
  });
});

describe("arcs", () => {
  it("walks the trim along the arc rather than across its chord", () => {
    const shape = arc({ r: 100, arrowheadEnd: "diamond", size: "m" });
    const plan = getShapeArrowheadPlan(shape);
    const drawn = getArcDrawnAngles(shape);

    // Whatever the plan gave up is what the sweep gives up — measured as arc length, not as a
    // chord and not as "length ÷ the speed at the end point".
    expect(ellipseArcLength(100, 100, drawn.endAngle, Math.PI / 2)).toBeCloseTo(plan.end.trimPx, 2);
    expect(drawn.startAngle).toBe(0);
  });

  it("measures an eccentric ellipse by its own arc length, even at a slow end", () => {
    // The end point sits where `|dP/dθ|` is at its smallest, which is exactly where dividing the
    // length by the local speed is wrong by several times.
    const shape = arc({ rx: 20, ry: 200, startAngle: 0, endAngle: Math.PI / 2, arrowheadEnd: "diamond", size: "xl" });
    const plan = getShapeArrowheadPlan(shape);
    const drawn = getArcDrawnAngles(shape);

    expect(plan.end.trimPx).toBeGreaterThan(0);
    expect(ellipseArcLength(20, 200, drawn.endAngle, Math.PI / 2)).toBeCloseTo(plan.end.trimPx, 1);
  });

  it.each([15, 25, 60, 100, 400])(
    "keeps the head's point within a line width of the stored endpoint on a radius of %i",
    (radius) => {
      // A `<marker>` is a rigid straight stamp aimed along the tangent, so on a curve its point
      // leaves the arc. The trim is capped until that gap is smaller than the line itself — without
      // the cap a tight arc with a thick line puts the head tens of pixels off its own endpoint.
      for (const size of ["s", "m", "l", "xl"] as const) {
        for (const head of ["diamond", "triangle", "arrow"] as const) {
          const shape = arc({ r: radius, startAngle: 0, endAngle: Math.PI / 2, arrowheadEnd: head, size });
          const plan = getShapeArrowheadPlan(shape);
          const drawn = getArcDrawnAngles(shape);
          const strokeWidth = overlayStrokeWidth(size);
          const label = `${radius}/${size}/${head}`;

          const drift = arcTipDrift(shape, drawn.endAngle, plan.end.trimPx);

          expect(`${label}:${drift <= strokeWidth}`).toBe(`${label}:true`);
        }
      }
    },
  );

  it("keeps a small arc from being trimmed away entirely", () => {
    const shape = arc({
      r: 200,
      startAngle: 0,
      endAngle: 0.06,
      arrowheadStart: "diamond",
      arrowheadEnd: "diamond",
      size: "xl",
    });
    const drawn = getArcDrawnAngles(shape);
    const total = ellipseArcLength(200, 200, 0, 0.06);

    // The angle clamp was removed on purpose: the length clamp is the only one, so the residual has
    // to be exactly the fifth of the sweep it promises. Without this the ratio could drift to any
    // value and nothing would notice.
    expect(drawn.endAngle).toBeGreaterThan(drawn.startAngle);
    expect(ellipseArcLength(200, 200, drawn.startAngle, drawn.endAngle) / total).toBeCloseTo(0.2, 3);
  });

  it("reads the sharpest curve the trim spans, not only the one at the end point", () => {
    // A flattened ellipse bends many times harder a little way in than it does at the end of the
    // sweep. Sizing the ceiling from the end alone leaves the head tens of pixels off its own
    // endpoint on exactly the shapes an author makes by squashing an arc's handles.
    const shape = arc({
      rx: 90,
      ry: 15,
      startAngle: 0,
      endAngle: 3.85,
      arrowheadEnd: "triangle",
      size: "xl",
    });
    const plan = getShapeArrowheadPlan(shape);
    const drawn = getArcDrawnAngles(shape);

    expect(arcTipDrift(shape, drawn.endAngle, plan.end.trimPx)).toBeLessThanOrEqual(overlayStrokeWidth("xl"));
  });
});

/** How far the head's point ends up from the arc's stored end, given the tangent it is aimed along. */
function arcTipDrift(shape: OverlayArcShape, drawnEndAngle: number, trimPx: number): number {
  const rx = shape.props.rx ?? shape.props.r;
  const ry = shape.props.ry ?? shape.props.r;
  const at = (angle: number) => ({
    x: rx + Math.cos(angle) * rx,
    y: ry + Math.sin(angle) * ry,
  });
  const speed = Math.hypot(rx * Math.sin(drawnEndAngle), ry * Math.cos(drawnEndAngle));
  const tangent = {
    x: (-rx * Math.sin(drawnEndAngle)) / speed,
    y: (ry * Math.cos(drawnEndAngle)) / speed,
  };
  const pathEnd = at(drawnEndAngle);
  const stored = at(shape.props.endAngle);
  return Math.hypot(
    pathEnd.x + tangent.x * trimPx - stored.x,
    pathEnd.y + tangent.y * trimPx - stored.y,
  );
}

/** The drawn length of an `M`/`Q`/`L` path string, by sampling. */
function pathLengthOf(path: string): number {
  const numbers = (chunk: string) => chunk.trim().split(/[\s,]+/).map(Number);
  let cursor: OverlayPoint | null = null;
  let total = 0;
  for (const [, command, body] of path.matchAll(/([MQL])([^MQL]*)/g)) {
    const values = numbers(body);
    if (command === "M") {
      cursor = { x: values[0], y: values[1] };
      continue;
    }
    if (!cursor) {
      continue;
    }
    if (command === "L") {
      const to = { x: values[0], y: values[1] };
      total += Math.hypot(to.x - cursor.x, to.y - cursor.y);
      cursor = to;
      continue;
    }
    const control = { x: values[0], y: values[1] };
    const to = { x: values[2], y: values[3] };
    let previous = cursor;
    for (let step = 1; step <= 2000; step += 1) {
      const point = quadraticAt(cursor, control, to, step / 2000);
      total += Math.hypot(point.x - previous.x, point.y - previous.y);
      previous = point;
    }
    cursor = to;
  }
  return total;
}

function quadraticAt(from: OverlayPoint, control: OverlayPoint, to: OverlayPoint, t: number): OverlayPoint {
  const inverse = 1 - t;
  return {
    x: inverse * inverse * from.x + 2 * inverse * t * control.x + t * t * to.x,
    y: inverse * inverse * from.y + 2 * inverse * t * control.y + t * t * to.y,
  };
}

function closestQuadraticPoint(
  from: OverlayPoint,
  control: OverlayPoint,
  to: OverlayPoint,
  target: OverlayPoint,
): OverlayPoint {
  let best = from;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 2000; step += 1) {
    const point = quadraticAt(from, control, to, step / 2000);
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best;
}

function arcLengthFromEnd(points: OverlayPoint[], from: OverlayPoint): number {
  const target = closestQuadraticParameter(points[0], points[1], points[2], from);
  let total = 0;
  let previous = quadraticAt(points[0], points[1], points[2], target);
  for (let step = 1; step <= 500; step += 1) {
    const t = target + ((1 - target) * step) / 500;
    const point = quadraticAt(points[0], points[1], points[2], t);
    total += Math.hypot(point.x - previous.x, point.y - previous.y);
    previous = point;
  }
  return total;
}

function closestQuadraticParameter(
  from: OverlayPoint,
  control: OverlayPoint,
  to: OverlayPoint,
  target: OverlayPoint,
): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let step = 0; step <= 2000; step += 1) {
    const t = step / 2000;
    const point = quadraticAt(from, control, to, t);
    const distance = Math.hypot(point.x - target.x, point.y - target.y);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = t;
    }
  }
  return best;
}

function ellipseArcLength(rx: number, ry: number, from: number, to: number): number {
  const steps = 2000;
  const step = (to - from) / steps;
  let total = 0;
  for (let index = 0; index < steps; index += 1) {
    const angle = from + step * (index + 0.5);
    total += Math.hypot(rx * Math.sin(angle), ry * Math.cos(angle)) * Math.abs(step);
  }
  return total;
}
