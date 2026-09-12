import { resolveGraph2DParameters } from "@/features/rendering/core";
import type { Graph2DSpec, GraphCurve } from "@/features/document";
import {
  intersectSegments,
  sampleCurveSegments,
  type GraphFillPoint,
} from "@/lib/graph-fill";
import {
  evaluateExpression,
  getGraphDisplayRange,
  getGraphNumericRange,
  getGraphPlotBox,
  normalizeGraphCurveMode,
  parseGraphPoint,
  resolveGraphCurveSamplingRange,
  unmapGraphPoint,
  type GraphNumericRange,
} from "@/lib/graph2d";

const ROOT_EPSILON = 1e-6;
const ROOT_REFINEMENT_INTERVAL_TOLERANCE = 1e-10;
const POINT_KEY_SCALE = 1000;
const EXISTING_POINT_TOLERANCE = 1 / POINT_KEY_SCALE;
const ROOT_SAMPLE_COUNT = 512;
const DEFAULT_CURVE_SAMPLES = 220;
const MIN_CURVE_SAMPLES = 32;
const MAX_CURVE_SAMPLES = 360;
const NEWTON_ITERATIONS = 12;

interface NumericDomain {
  min: number;
  max: number;
}

/**
 * 表示範囲内にある、明示曲線同士の交点を GraphPoint 用の座標として返す。
 * implicit は v1 の対象外とし、式評価に失敗する区間だけを局所的に読み飛ばす。
 */
export function findGraphCurveIntersections(spec: Graph2DSpec): GraphFillPoint[] {
  spec = resolveGraph2DParameters(spec);
  const curves = spec.curves.filter((curve) => normalizeGraphCurveMode(curve.mode) !== "implicit");
  if (curves.length < 2) {
    return [];
  }

  let displayRange: GraphNumericRange;
  try {
    displayRange = getGraphDisplayRange(spec);
  } catch {
    return [];
  }

  const intersections: GraphFillPoint[] = [];
  for (let firstIndex = 0; firstIndex < curves.length - 1; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < curves.length; secondIndex += 1) {
      const first = curves[firstIndex];
      const second = curves[secondIndex];
      try {
        const firstMode = normalizeGraphCurveMode(first.mode);
        const secondMode = normalizeGraphCurveMode(second.mode);
        intersections.push(...(
          firstMode === "yOfX" && secondMode === "yOfX"
            ? findYOfXIntersections(first, second, displayRange)
            : findSampledCurveIntersections(first, second, spec, displayRange)
        ));
      } catch {
        // 1組の式や区間が評価不能でも、ほかの曲線ペアの探索は継続する。
      }
    }
  }

  const unique = dedupeIntersections(intersections, displayRange)
    .filter((point) => isPointInRange(point, displayRange));
  const existingPoints = (spec.points ?? [])
    .map((point) => parseGraphPoint(point))
    .filter((point): point is GraphFillPoint => point !== null);

  return unique
    .filter((point) => !existingPoints.some((existing) => (
      Math.hypot(point.x - existing.x, point.y - existing.y) <= EXISTING_POINT_TOLERANCE
    )))
    .sort((first, second) => first.x - second.x || first.y - second.y);
}

/**
 * 区間を等分し、有限値を返す連続区間の符号変化とゼロ値から根候補を求める。
 */
export function findSignChangeRoots(
  f: (value: number) => number,
  domain: NumericDomain,
  epsilon: number,
): number[] {
  if (!Number.isFinite(domain.min) || !Number.isFinite(domain.max) || domain.min > domain.max) {
    return [];
  }

  const roots: number[] = [];
  let previous: { value: number; delta: number } | null = null;
  let nearZeroCluster: { value: number; delta: number } | null = null;
  let minimumSample: { value: number; delta: number } | null = null;
  let finiteSampleCount = 0;
  let zeroSampleCount = 0;
  let hasSignChange = false;

  const flushNearZeroCluster = () => {
    if (!nearZeroCluster) {
      return;
    }
    roots.push(nearZeroCluster.value);
    nearZeroCluster = null;
  };

  for (let index = 0; index <= ROOT_SAMPLE_COUNT; index += 1) {
    const value = domain.min + ((domain.max - domain.min) * index) / ROOT_SAMPLE_COUNT;
    let delta: number;
    try {
      delta = f(value);
    } catch {
      flushNearZeroCluster();
      previous = null;
      continue;
    }
    if (!Number.isFinite(delta)) {
      flushNearZeroCluster();
      previous = null;
      continue;
    }

    finiteSampleCount += 1;
    if (!minimumSample || Math.abs(delta) < Math.abs(minimumSample.delta)) {
      minimumSample = { value, delta };
    }
    if (Math.abs(delta) <= epsilon) {
      zeroSampleCount += 1;
      if (!nearZeroCluster || Math.abs(delta) < Math.abs(nearZeroCluster.delta)) {
        nearZeroCluster = { value, delta };
      }
    } else if (previous && previous.delta * delta < 0) {
      flushNearZeroCluster();
      hasSignChange = true;
      try {
        roots.push(refineBisection(f, previous.value, value, epsilon));
      } catch {
        // この候補だけを無視し、次の走査点から探索を続ける。
      }
    } else {
      flushNearZeroCluster();
    }

    previous = { value, delta };
  }
  flushNearZeroCluster();

  // 完全に重なる2曲線には有限個の交点が定義できないため追加しない。
  if (finiteSampleCount > 0 && finiteSampleCount === zeroSampleCount) {
    return [];
  }

  // 符号が変化しない接点も、最小残差のサンプルを根候補として残す。
  if (
    !hasSignChange &&
    roots.length === 0 &&
    minimumSample &&
    Math.abs(minimumSample.delta) <= epsilon
  ) {
    roots.push(minimumSample.value);
  }

  return dedupeNumbers(roots, epsilon);
}

/**
 * 両端で符号が異なる区間を二分法で絞り込む。
 */
export function refineBisection(
  f: (value: number) => number,
  a: number,
  b: number,
  epsilon: number,
): number {
  let left = Math.min(a, b);
  let right = Math.max(a, b);
  let leftValue = f(left);
  let rightValue = f(right);
  const intervalTolerance = Math.min(
    Math.max(Math.abs(epsilon), Number.EPSILON),
    ROOT_REFINEMENT_INTERVAL_TOLERANCE,
  );
  if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
    throw new Error("Root interval produced a non-finite value");
  }
  if (leftValue === 0) {
    return left;
  }
  if (rightValue === 0) {
    return right;
  }
  if (leftValue * rightValue > 0) {
    throw new Error("Root interval does not contain a sign change");
  }

  for (let iteration = 0; iteration < 64; iteration += 1) {
    const midpoint = (left + right) / 2;
    const midpointValue = f(midpoint);
    if (!Number.isFinite(midpointValue)) {
      throw new Error("Root refinement produced a non-finite value");
    }
    if (midpointValue === 0) {
      return midpoint;
    }

    if (leftValue * midpointValue <= 0) {
      right = midpoint;
      rightValue = midpointValue;
    } else {
      left = midpoint;
      leftValue = midpointValue;
    }

    const precisionTolerance = Number.EPSILON * Math.max(1, Math.abs(left), Math.abs(right));
    if (right - left <= Math.max(intervalTolerance, precisionTolerance)) {
      break;
    }
  }

  return (left + right) / 2;
}

function findYOfXIntersections(
  first: GraphCurve,
  second: GraphCurve,
  displayRange: GraphNumericRange,
): GraphFillPoint[] {
  const firstRange = resolveGraphCurveSamplingRange(first, "yOfX", displayRange);
  const secondRange = resolveGraphCurveSamplingRange(second, "yOfX", displayRange);
  if (!firstRange || !secondRange) {
    return [];
  }

  const domain = {
    min: Math.max(firstRange.min, secondRange.min),
    max: Math.min(firstRange.max, secondRange.max),
  };
  if (domain.min > domain.max) {
    return [];
  }

  if (domain.min === domain.max) {
    try {
      const firstY = evaluateExpression(first.expr, domain.min, "x");
      const secondY = evaluateExpression(second.expr, domain.min, "x");
      if (Math.abs(firstY - secondY) > ROOT_EPSILON * 4) {
        return [];
      }

      const point = { x: domain.min, y: (firstY + secondY) / 2 };
      return isPointInRange(point, displayRange) ? [point] : [];
    } catch {
      return [];
    }
  }

  const delta = (x: number) => evaluateExpression(first.expr, x, "x") -
    evaluateExpression(second.expr, x, "x");

  return findSignChangeRoots(delta, domain, ROOT_EPSILON).flatMap((x) => {
    try {
      const firstY = evaluateExpression(first.expr, x, "x");
      const secondY = evaluateExpression(second.expr, x, "x");
      if (Math.abs(firstY - secondY) > ROOT_EPSILON * 4) {
        return [];
      }

      const point = { x, y: (firstY + secondY) / 2 };
      return isPointInRange(point, displayRange) ? [point] : [];
    } catch {
      return [];
    }
  });
}

function findSampledCurveIntersections(
  first: GraphCurve,
  second: GraphCurve,
  spec: Graph2DSpec,
  displayRange: GraphNumericRange,
): GraphFillPoint[] {
  let axisRange: GraphNumericRange;
  try {
    axisRange = getGraphNumericRange(spec);
  } catch {
    return [];
  }

  const plotBox = getGraphPlotBox(spec);
  const firstSegments = sampleCurveSegments(first, spec, axisRange, displayRange, plotBox);
  const secondSegments = sampleCurveSegments(second, spec, axisRange, displayRange, plotBox);
  const intersections: GraphFillPoint[] = [];

  for (const firstSegment of firstSegments) {
    for (const secondSegment of secondSegments) {
      try {
        const hit = intersectSegments(firstSegment, secondSegment);
        if (!hit) {
          continue;
        }

        const candidate = unmapGraphPoint(hit.point.x, hit.point.y, axisRange, spec, plotBox);
        if (!isPointInRange(candidate, displayRange)) {
          continue;
        }

        const refined = refineSampledIntersection(first, second, candidate, displayRange);
        if (refined) {
          intersections.push(refined);
        }
      } catch {
        // 評価不能な線分ペアだけを読み飛ばす。
      }
    }
  }

  return intersections;
}

function refineSampledIntersection(
  first: GraphCurve,
  second: GraphCurve,
  candidate: GraphFillPoint,
  displayRange: GraphNumericRange,
): GraphFillPoint | null {
  const firstParameter = findClosestCurveParameter(first, candidate, displayRange);
  const secondParameter = findClosestCurveParameter(second, candidate, displayRange);
  if (!firstParameter || !secondParameter) {
    return null;
  }

  let firstValue = firstParameter.value;
  let secondValue = secondParameter.value;
  for (let iteration = 0; iteration < NEWTON_ITERATIONS; iteration += 1) {
    const firstPoint = evaluateCurvePoint(first, firstValue);
    const secondPoint = evaluateCurvePoint(second, secondValue);
    const deltaX = firstPoint.x - secondPoint.x;
    const deltaY = firstPoint.y - secondPoint.y;
    if (Math.hypot(deltaX, deltaY) < ROOT_EPSILON) {
      return midpoint(firstPoint, secondPoint);
    }

    const firstDerivative = evaluateCurveDerivative(first, firstValue, firstParameter.range);
    const secondDerivative = evaluateCurveDerivative(second, secondValue, secondParameter.range);
    const a = firstDerivative.x;
    const b = -secondDerivative.x;
    const c = firstDerivative.y;
    const d = -secondDerivative.y;
    const determinant = a * d - b * c;
    if (Math.abs(determinant) < 1e-12) {
      break;
    }

    const firstStep = (-deltaX * d + b * deltaY) / determinant;
    const secondStep = (-a * deltaY + deltaX * c) / determinant;
    firstValue = clampParameter(
      firstValue + clampStep(firstStep, firstParameter.range),
      firstParameter.range,
    );
    secondValue = clampParameter(
      secondValue + clampStep(secondStep, secondParameter.range),
      secondParameter.range,
    );
  }

  const firstPoint = evaluateCurvePoint(first, firstValue);
  const secondPoint = evaluateCurvePoint(second, secondValue);
  return Math.hypot(firstPoint.x - secondPoint.x, firstPoint.y - secondPoint.y) < ROOT_EPSILON * 4
    ? midpoint(firstPoint, secondPoint)
    : null;
}

function findClosestCurveParameter(
  curve: GraphCurve,
  candidate: GraphFillPoint,
  displayRange: GraphNumericRange,
): { value: number; range: NumericDomain } | null {
  const mode = normalizeGraphCurveMode(curve.mode);
  const range = resolveGraphCurveSamplingRange(curve, mode, displayRange);
  if (!range) {
    return null;
  }

  const sampleCount = clampInteger(curve.samples ?? DEFAULT_CURVE_SAMPLES, MIN_CURVE_SAMPLES, MAX_CURVE_SAMPLES);
  const xSpan = Math.max(ROOT_EPSILON, displayRange.xMax - displayRange.xMin);
  const ySpan = Math.max(ROOT_EPSILON, displayRange.yMax - displayRange.yMin);
  let closest: { value: number; distance: number } | null = null;

  for (let index = 0; index <= sampleCount; index += 1) {
    const value = range.min + ((range.max - range.min) * index) / sampleCount;
    try {
      const point = evaluateCurvePoint(curve, value);
      const distance = ((point.x - candidate.x) / xSpan) ** 2 + ((point.y - candidate.y) / ySpan) ** 2;
      if (!closest || distance < closest.distance) {
        closest = { value, distance };
      }
    } catch {
      // このサンプルだけを無視する。
    }
  }

  return closest ? { value: closest.value, range } : null;
}

function evaluateCurvePoint(curve: GraphCurve, parameter: number): GraphFillPoint {
  const mode = normalizeGraphCurveMode(curve.mode);
  if (mode === "parametric") {
    const yExpr = curve.yExpr?.trim();
    if (!yExpr) {
      throw new Error("Parametric curve requires a y expression");
    }
    return {
      x: evaluateExpression(curve.expr, parameter, "t"),
      y: evaluateExpression(yExpr, parameter, "t"),
    };
  }

  const dependent = evaluateExpression(curve.expr, parameter, mode === "xOfY" ? "y" : "x");
  return mode === "xOfY"
    ? { x: dependent, y: parameter }
    : { x: parameter, y: dependent };
}

function evaluateCurveDerivative(
  curve: GraphCurve,
  parameter: number,
  range: NumericDomain,
): GraphFillPoint {
  const step = Math.max((range.max - range.min) * 1e-5, 1e-7);
  const before = Math.max(range.min, parameter - step);
  const after = Math.min(range.max, parameter + step);
  if (after <= before) {
    throw new Error("Curve derivative range is empty");
  }

  const first = evaluateCurvePoint(curve, before);
  const second = evaluateCurvePoint(curve, after);
  return {
    x: (second.x - first.x) / (after - before),
    y: (second.y - first.y) / (after - before),
  };
}

function clampStep(step: number, range: NumericDomain): number {
  const limit = (range.max - range.min) / 4;
  return Math.max(-limit, Math.min(limit, step));
}

function clampParameter(value: number, range: NumericDomain): number {
  return Math.max(range.min, Math.min(range.max, value));
}

function midpoint(first: GraphFillPoint, second: GraphFillPoint): GraphFillPoint {
  return {
    x: (first.x + second.x) / 2,
    y: (first.y + second.y) / 2,
  };
}

function isPointInRange(point: GraphFillPoint, range: GraphNumericRange): boolean {
  return point.x >= range.xMin - ROOT_EPSILON &&
    point.x <= range.xMax + ROOT_EPSILON &&
    point.y >= range.yMin - ROOT_EPSILON &&
    point.y <= range.yMax + ROOT_EPSILON;
}

function dedupeIntersections(points: GraphFillPoint[], displayRange: GraphNumericRange): GraphFillPoint[] {
  // Scale quantization based on display range to handle small-scale graphs
  const xSpan = displayRange.xMax - displayRange.xMin;
  const ySpan = displayRange.yMax - displayRange.yMin;
  const xScale = xSpan > 0 ? Math.max(1, 1 / xSpan) : POINT_KEY_SCALE;
  const yScale = ySpan > 0 ? Math.max(1, 1 / ySpan) : POINT_KEY_SCALE;

  const unique = new Map<string, GraphFillPoint>();
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
      continue;
    }
    const key = `${Math.round(point.x * xScale)}:${Math.round(point.y * yScale)}`;
    if (!unique.has(key)) {
      unique.set(key, point);
    }
  }
  return [...unique.values()];
}

function dedupeNumbers(values: number[], epsilon: number): number[] {
  return [...values]
    .sort((first, second) => first - second)
    .filter((value, index, sorted) => index === 0 || Math.abs(value - sorted[index - 1]) > epsilon);
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(value)));
}
