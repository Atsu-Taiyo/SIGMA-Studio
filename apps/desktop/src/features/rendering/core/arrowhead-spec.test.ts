import { describe, expect, it } from "vitest";

import {
  ARROWHEAD_LINE_WIDTH,
  arrowheadInkCoversLineAtX,
  ARROWHEAD_MARKER_SPECS,
  getArrowheadInkApexX,
  getArrowheadInkBounds,
  getArrowheadMarkerRequests,
  getArrowheadTrimInStrokes,
  NO_ARROWHEAD_PLACEMENT,
  overlayStrokeWidth,
  planArrowheadEndpoints,
} from ".";

/**
 * The head has to end where the document says the line ends.
 *
 * `refX` alone cannot do that: anchoring a head at its tip leaves the line's own butt cap sticking
 * out of the point, and anchoring it further back pushes the point past the stored endpoint. The
 * line is therefore pulled back by `trimPx` and the marker is pushed back by the same amount, so
 * the two numbers are only ever correct as a pair. These tests hold that pair together.
 */

const SIZES = ["s", "m", "l", "xl"] as const;
const LONG_ENOUGH = { start: 10_000, end: 10_000 };

describe("arrow head ink reach", () => {
  it.each(ARROWHEAD_MARKER_SPECS.filter((spec) => spec.reversibleOrient))(
    "puts the anchor of $kind on its own front-most ink",
    (spec) => {
      // Not a hand-written constant: an open head's visible point is the miter, which sits well
      // ahead of the vertex in `points` and moves whenever the head's stroke width does.
      expect(spec.tipX).toBeCloseTo(getArrowheadInkApexX(spec.geometry), 2);
    },
  );

  it.each(ARROWHEAD_MARKER_SPECS.filter((spec) => !spec.reversibleOrient))(
    "anchors $kind on its own centre, since it marks the endpoint rather than points at it",
    (spec) => {
      expect(spec.tipX).toBe(spec.geometry.kind === "circle" ? spec.geometry.cx : spec.markerWidth / 2);
      expect(spec.lineStopX).toBe(spec.tipX);
      expect(getArrowheadTrimInStrokes(spec.kind)).toBe(0);
    },
  );

  it.each(ARROWHEAD_MARKER_SPECS)("keeps all of $kind inside its marker box", (spec) => {
    // `<marker>` clips at its own box (the UA stylesheet gives it `overflow: hidden`, and
    // `.overlay-vector-svg { overflow: visible }` only reaches the `<svg>`). A head whose miter
    // overshoots `markerWidth` is silently cut, so the ink the user sees is not the ink this table
    // describes and the anchor lands in the wrong place. Both directions: flooring a small head's
    // pen widens it across the line as well as along it.
    const ink = getArrowheadInkBounds(spec.geometry);
    const inside = ink.minX >= 0 && ink.maxX <= spec.markerWidth &&
      ink.minY >= 0 && ink.maxY <= spec.markerHeight;

    expect(`${spec.kind}:${inside}`).toBe(`${spec.kind}:true`);
    expect(spec.markerWidth).toBeGreaterThanOrEqual(spec.tipX);
  });

  it("stops the line behind the head rather than at its point", () => {
    for (const spec of ARROWHEAD_MARKER_SPECS) {
      expect(spec.lineStopX).toBeLessThanOrEqual(spec.tipX);
    }
  });

  it.each(ARROWHEAD_MARKER_SPECS)("hides the line's square end under $kind", (spec) => {
    // The reported bug, pinned at its cause: a head drawn small, or drawn with a pen thinner than
    // the line, is narrower than the line it ends, and the line's butt cap then pokes out of the
    // point as a blunt stub. Marker units are stroke widths, so covering the line here covers it at
    // every size at once.
    const covered = arrowheadInkCoversLineAtX(spec.geometry, spec.lineStopX, spec.refY);

    expect(`${spec.kind}:${covered}`).toBe(`${spec.kind}:true`);
  });

  it.each(ARROWHEAD_MARKER_SPECS)("draws $kind with a pen at least as wide as the line", (spec) => {
    // A filled outline covers the line by its own area. A stroked one covers it only if its pen is
    // no thinner than the line — no distance back from the point can make two thin whiskers hide a
    // wider stub — so scaling a head down must stop scaling its pen.
    if (spec.geometry.kind !== "polyline" || spec.geometry.filled) {
      return;
    }

    expect(`${spec.kind}:${spec.geometry.strokeWidth >= ARROWHEAD_LINE_WIDTH}`).toBe(`${spec.kind}:true`);
  });

  it.each(ARROWHEAD_MARKER_SPECS.filter((spec) => spec.reversibleOrient))(
    "gives up no more line than $kind needs to hide it",
    (spec) => {
      // The other half of the same balance. The line pays for the cover with its own length, so the
      // stop belongs just inside the place the head becomes wide enough — not at the widest point of
      // the head, which would hide a dashed line's last dash and double the ink of a translucent one.
      // A whole overlap further back the head is narrower than the line again.
      const tooFar = arrowheadInkCoversLineAtX(spec.geometry, spec.lineStopX - 0.55, spec.refY);

      expect(`${spec.kind}:${tooFar}`).toBe(`${spec.kind}:false`);
    },
  );

  it("reads nothing off Object.prototype", () => {
    expect(getArrowheadTrimInStrokes("__proto__")).toBe(0);
    expect(getArrowheadTrimInStrokes(undefined)).toBe(0);
  });
});

describe("planArrowheadEndpoints", () => {
  it.each(ARROWHEAD_MARKER_SPECS)("lands the point of $kind on the stored endpoint at every size", (spec) => {
    for (const size of SIZES) {
      const strokeWidth = overlayStrokeWidth(size);
      const plan = planArrowheadEndpoints(spec.kind, spec.kind, strokeWidth, 10_000, LONG_ENOUGH);
      for (const [endpoint, placement] of [["start", plan.start], ["end", plan.end]] as const) {
        // The invariant: the marker is pushed back by exactly what the line gave up, so the head's
        // point sits on the endpoint the document stores. The label carries kind/size/endpoint so a
        // failure names the case that broke.
        const label = `${spec.kind}/${size}/${endpoint}`;
        const anchored = placement.refX + placement.trimPx / strokeWidth;
        expect(`${label}:${Math.abs(anchored - spec.tipX) < 1e-9}`).toBe(`${label}:true`);
      }
    }
  });

  it("scales the trim with the line, because marker units are stroke widths", () => {
    const thin = planArrowheadEndpoints("none", "diamond", overlayStrokeWidth("s"), 10_000, LONG_ENOUGH);
    const thick = planArrowheadEndpoints("none", "diamond", overlayStrokeWidth("xl"), 10_000, LONG_ENOUGH);
    const trim = getArrowheadTrimInStrokes("diamond");

    expect(thin.end.trimPx).toBeCloseTo(trim * 1.25, 6);
    expect(thick.end.trimPx).toBeCloseTo(trim * 5, 6);
  });

  it("declares nothing at an endpoint with no head", () => {
    const plan = planArrowheadEndpoints("none", undefined, 2, 100, LONG_ENOUGH);

    expect(plan.start).toEqual(NO_ARROWHEAD_PLACEMENT);
    expect(plan.end).toEqual(NO_ARROWHEAD_PLACEMENT);
    expect(plan.start.trimPx).toBe(0);
  });

  it("never eats the terminal segment, so the head keeps its own direction", () => {
    // `orient="auto"` reads the direction of the last segment. Trimming that segment away hands the
    // arrow the direction of the segment before it and the head flips to a different angle.
    const plan = planArrowheadEndpoints("none", "diamond", 5, 10_000, { start: 10_000, end: 10 });

    expect(plan.end.trimPx).toBeCloseTo(9, 6);
    expect(plan.end.refX + plan.end.trimPx / 5).toBeCloseTo(9, 9);
  });

  it("keeps a short line from collapsing when both ends carry a head", () => {
    const plan = planArrowheadEndpoints("diamond", "diamond", 5, 20, { start: 20, end: 20 });

    expect(plan.start.trimPx + plan.end.trimPx).toBeCloseTo(16, 6);
    expect(plan.start.trimPx).toBeGreaterThan(0);
    expect(plan.end.trimPx).toBeGreaterThan(0);
  });

  it("degrades to today's drawing rather than to nonsense on a degenerate path", () => {
    for (const [pathLength, terminal] of [[0, 0], [Number.NaN, Number.NaN], [-5, -5]] as const) {
      const plan = planArrowheadEndpoints("diamond", "triangle", 2, pathLength, { start: terminal, end: terminal });

      expect(plan.start.trimPx).toBe(0);
      expect(plan.end.trimPx).toBe(0);
      expect(plan.start.refX).toBe(9);
      expect(plan.end.refX).toBe(7);
    }
  });

  it("survives a stroke width of zero without dividing by it", () => {
    const plan = planArrowheadEndpoints("diamond", "diamond", 0, 100, LONG_ENOUGH);

    expect(plan.start.trimPx).toBe(0);
    expect(Number.isFinite(plan.start.refX)).toBe(true);
  });
});

describe("marker requests", () => {
  it("hands each renderer the reference point the plan computed, not the table's tip", () => {
    const plan = planArrowheadEndpoints("diamond", "triangle", 2, 10_000, LONG_ENOUGH);
    const requests = getArrowheadMarkerRequests("shape_1", plan);

    expect(requests.map((request) => request.id)).toEqual(["diamond-shape_1-start", "triangle-shape_1-end"]);
    expect(requests[0].refX).toBeCloseTo(9 - getArrowheadTrimInStrokes("diamond"), 6);
    expect(requests[1].refX).toBeCloseTo(7 - getArrowheadTrimInStrokes("triangle"), 6);
  });

  it("declares nothing for a suppressed endpoint", () => {
    expect(getArrowheadMarkerRequests("shape_1", {
      start: NO_ARROWHEAD_PLACEMENT,
      end: NO_ARROWHEAD_PLACEMENT,
    })).toEqual([]);
  });
});
