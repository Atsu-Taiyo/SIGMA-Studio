import { resolveGraph2DParameters, resolveGraphParameterCurve, resolveGraphParameterExpression } from "@/features/rendering/core";
import {
  evaluateExpression,
  evaluateOptionalScalar,
  formatRangeValue,
  getGraphDisplayRange,
  getGraphNumericRange,
  getGraphPlotBox,
  mapGraphPoint,
  normalizeGraphCurveMode,
  refineCurveDomainEdge,
  resolveGraphCurveSamplingRange,
  type GraphNumericRange,
  type GraphPlotBox,
} from "@/lib/graph2d";
import type { Graph2DSpec, GraphCurve, GraphFillRegion } from "@/features/document";
export {
  DEFAULT_GRAPH_FILL_COLOR,
  DEFAULT_GRAPH_FILL_OPACITY,
  DEFAULT_GRAPH_FILL_PATTERN,
  GRAPH_FILL_PATTERN_OPTIONS,
  normalizeGraphFillOpacity,
  normalizeGraphFillPattern,
} from "@/lib/graph-fill-style";

export interface GraphFillPoint {
  x: number;
  y: number;
}

export interface ResolvedGraphFillRegion {
  path: string;
  polygon: GraphFillPoint[];
  area: number;
}

export interface Segment {
  a: GraphFillPoint;
  b: GraphFillPoint;
  kind: "axis" | "curve" | "frame";
}

export interface GraphSegment {
  a: GraphFillPoint;
  b: GraphFillPoint;
}

interface SplitParameter {
  t: number;
  point?: GraphFillPoint;
}

interface GraphVertex {
  key: string;
  point: GraphFillPoint;
}

interface GraphNeighbor {
  key: string;
  angle: number;
}

interface PlanarEdge extends GraphSegment {
  fromKey: string;
  toKey: string;
}

interface PlanarGraph {
  vertices: Map<string, GraphVertex>;
  adjacency: Map<string, GraphNeighbor[]>;
  /** 分割後の辺。事後条件検査では `collectSeparatingEdges` で 2-core に絞ってから使う。 */
  edges: PlanarEdge[];
  edgeCount: number;
}

const MIN_CURVE_SAMPLES = 32;
const MAX_CURVE_SAMPLES = 360;
const DEFAULT_CURVE_SAMPLES = 220;
const GEOMETRY_EPSILON = 1e-6;
// 許容誤差はすべて SVG px。順序不変条件:
// VERTEX_SNAP_TOLERANCE < CONTACT_TOLERANCE < STRICT_BOUNDARY_HIT_TOLERANCE < BOUNDARY_HIT_TOLERANCE
/** この距離未満の2点は arrangement 上「同一頂点」として統合する。 */
const VERTEX_SNAP_TOLERANCE = 0.08;
/**
 * 頂点が線分に「触れている」とみなす距離。接点でポリラインを分割するために使う。
 *
 * 上限は 0.827px — 既存テスト「does not invent a contact when a curve only passes near an axis」が
 * y = x^2 + 0.005 (viewBox y ∈ [-0.5, 1] → 165.33 px/unit) の 0.827px の隙間を
 * 「接触ではない」と判定することを要求している。0.25px はその 3.3 倍のマージンを残しつつ、
 * 2次接触の隙間 O(κh^2)（例: x^4 - x^2 の格子外接点で 0.0026px）を確実に拾える。
 */
const CONTACT_TOLERANCE = 0.25;
const MIN_FACE_AREA = 2;
const EXACT_BOUNDARY_HIT_TOLERANCE = 0.08;
const STRICT_BOUNDARY_HIT_TOLERANCE = 0.35;
const BOUNDARY_HIT_TOLERANCE = 2.4;
const INTERSECTION_PARAMETER_EPSILON = 1e-5;

export function createGraphFillId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `fill_${globalThis.crypto.randomUUID()}`;
  }

  return `fill_${Date.now()}`;
}

export function getGraphFillPath(
  spec: Graph2DSpec,
  fill: GraphFillRegion,
  plotBox = getGraphPlotBox(spec),
): string {
  const seed = parseFillSeed({ ...fill, x: resolveGraphParameterExpression(fill.x, spec.parameters ?? []), y: resolveGraphParameterExpression(fill.y, spec.parameters ?? []) });
  if (!seed) {
    return "";
  }

  return resolveGraphFillRegion(spec, seed, plotBox)?.path ?? "";
}

export function resolveGraphFillRegion(
  spec: Graph2DSpec,
  seed: GraphFillPoint,
  plotBox = getGraphPlotBox(spec),
): ResolvedGraphFillRegion | null {
  spec = resolveGraph2DParameters(spec);
  if (spec.kind !== "cartesian") {
    return null;
  }

  let axisRange: GraphNumericRange;
  let displayRange: GraphNumericRange;
  try {
    axisRange = getGraphNumericRange(spec);
    displayRange = getGraphDisplayRange(spec);
  } catch {
    return null;
  }

  const clipRange = intersectRanges(axisRange, displayRange);
  if (!clipRange) {
    return null;
  }

  if (!containsGraphPoint(clipRange, seed)) {
    return null;
  }

  const seedSvg = mapGraphPoint(seed.x, seed.y, axisRange, spec, plotBox);
  const segments = buildBoundarySegments(spec, axisRange, clipRange, plotBox);
  if (segments.length < 4) {
    return null;
  }

  const graph = buildPlanarGraph(segments);
  const faces = traceFaces(graph);
  const isFaceClosed = createFaceClosedPredicate(collectSeparatingEdges(graph));
  const simpleCurveBoundaryRegion = findSimpleCurveBoundaryRegion(spec, seed, axisRange, clipRange, plotBox);
  const boundaryHits = findNearSegments(seedSvg, segments, STRICT_BOUNDARY_HIT_TOLERANCE);
  if (boundaryHits.length > 0) {
    const exactBlockingHit =
      boundaryHits.length > 1 ||
      boundaryHits.some((segment) =>
        segment.kind !== "axis" &&
        distancePointToSegment(seedSvg, segment) <= EXACT_BOUNDARY_HIT_TOLERANCE,
      );
    if (exactBlockingHit) {
      return null;
    }

    const nearFace = findContainingFaceNearPoint(seedSvg, faces, BOUNDARY_HIT_TOLERANCE, isFaceClosed);
    if (nearFace.openFaceRejected) {
      return null;
    }

    return chooseSmallestRegion([nearFace.face, simpleCurveBoundaryRegion]);
  }

  const containingFace = findContainingFace(seedSvg, faces, isFaceClosed);
  // 面追跡が「seed を含む面は閉じていない」と判定したら、そこで打ち切る。
  // 解析経路は曲線1本と1本の直線境界しか見ないため、ここでフォールバックすると
  // 他の曲線や軸を跨いだ領域を返してしまう。
  if (containingFace.openFaceRejected) {
    return null;
  }

  const exactFace = chooseSmallestRegion([containingFace.face, simpleCurveBoundaryRegion]);
  if (exactFace) {
    return exactFace;
  }

  const nearbyAxisHits = findNearSegments(seedSvg, segments, BOUNDARY_HIT_TOLERANCE)
    .filter((segment) => segment.kind === "axis");
  if (nearbyAxisHits.length === 1) {
    const nearFace = findContainingFaceNearPoint(seedSvg, faces, BOUNDARY_HIT_TOLERANCE * 2, isFaceClosed);
    return chooseSmallestRegion([nearFace.face, simpleCurveBoundaryRegion]);
  }

  return null;
}

export function toggleGraphFillAtPoint(
  spec: Graph2DSpec,
  seed: GraphFillPoint,
  fillId = createGraphFillId(),
): Graph2DSpec {
  const plotBox = getGraphPlotBox(spec);
  const clickedRegion = resolveGraphFillRegion(spec, seed, plotBox);
  if (!clickedRegion) {
    return spec;
  }

  let axisRange: GraphNumericRange;
  try {
    axisRange = getGraphNumericRange(spec);
  } catch {
    return spec;
  }

  const fills = spec.fills ?? [];
  const matchingFill = fills.find((fill) => {
    const fillSeed = parseFillSeed(fill);
    if (!fillSeed) {
      return false;
    }

    const fillSeedSvg = mapGraphPoint(fillSeed.x, fillSeed.y, axisRange, spec, plotBox);
    return pointInPolygon(fillSeedSvg, clickedRegion.polygon);
  });

  if (matchingFill) {
    const nextFills = fills.filter((fill) => fill.id !== matchingFill.id);
    if (nextFills.length === 0) {
      const nextSpec = { ...spec };
      delete nextSpec.fills;
      return nextSpec;
    }

    return { ...spec, fills: nextFills };
  }

  return {
    ...spec,
    fills: [
      ...fills,
      {
        id: fillId,
        x: formatRangeValue(seed.x),
        y: formatRangeValue(seed.y),
      },
    ],
  };
}

function buildBoundarySegments(
  spec: Graph2DSpec,
  axisRange: GraphNumericRange,
  clipRange: GraphNumericRange,
  plotBox: GraphPlotBox,
): Segment[] {
  const topLeft = mapGraphPoint(clipRange.xMin, clipRange.yMax, axisRange, spec, plotBox);
  const topRight = mapGraphPoint(clipRange.xMax, clipRange.yMax, axisRange, spec, plotBox);
  const bottomRight = mapGraphPoint(clipRange.xMax, clipRange.yMin, axisRange, spec, plotBox);
  const bottomLeft = mapGraphPoint(clipRange.xMin, clipRange.yMin, axisRange, spec, plotBox);
  const segments: Segment[] = [
    { a: topLeft, b: topRight, kind: "frame" },
    { a: topRight, b: bottomRight, kind: "frame" },
    { a: bottomRight, b: bottomLeft, kind: "frame" },
    { a: bottomLeft, b: topLeft, kind: "frame" },
  ];

  if (spec.axes.showX !== false && clipRange.yMin < 0 && clipRange.yMax > 0) {
    segments.push({
      a: mapGraphPoint(clipRange.xMin, 0, axisRange, spec, plotBox),
      b: mapGraphPoint(clipRange.xMax, 0, axisRange, spec, plotBox),
      kind: "axis",
    });
  }

  if (spec.axes.showY !== false && clipRange.xMin < 0 && clipRange.xMax > 0) {
    segments.push({
      a: mapGraphPoint(0, clipRange.yMin, axisRange, spec, plotBox),
      b: mapGraphPoint(0, clipRange.yMax, axisRange, spec, plotBox),
      kind: "axis",
    });
  }

  for (const curve of spec.curves) {
    segments.push(...sampleCurveSegments(curve, spec, axisRange, clipRange, plotBox));
  }

  return segments;
}

export function sampleCurveSegments(
  curve: GraphCurve,
  spec: Graph2DSpec,
  axisRange: GraphNumericRange,
  clipRange: GraphNumericRange,
  plotBox: GraphPlotBox,
): Segment[] {
  curve = resolveGraphParameterCurve(curve, spec.parameters);
  spec = resolveGraph2DParameters(spec);
  const mode = normalizeGraphCurveMode(curve.mode);
  if (mode === "implicit") {
    return [];
  }

  const samplingRange = resolveGraphCurveSamplingRange(curve, mode, clipRange);
  if (!samplingRange) {
    return [];
  }

  const sampleCount = clampInteger(curve.samples ?? DEFAULT_CURVE_SAMPLES, MIN_CURVE_SAMPLES, MAX_CURVE_SAMPLES);
  const xSpan = clipRange.xMax - clipRange.xMin;
  const ySpan = clipRange.yMax - clipRange.yMin;
  const xLimitMin = clipRange.xMin - xSpan * 8;
  const xLimitMax = clipRange.xMax + xSpan * 8;
  const yLimitMin = clipRange.yMin - ySpan * 8;
  const yLimitMax = clipRange.yMax + ySpan * 8;
  const independentSpan = samplingRange.max - samplingRange.min;
  const segments: Segment[] = [];

  /** 評価に失敗した / 非有限になった場合は null（= その独立変数で曲線は定義されない）。 */
  const evaluatePoint = (independentValue: number): GraphFillPoint | null => {
    try {
      if (mode === "parametric") {
        const yExpr = curve.yExpr?.trim();
        if (!yExpr) {
          return null;
        }
        const point = {
          x: evaluateExpression(curve.expr, independentValue, "t"),
          y: evaluateExpression(yExpr, independentValue, "t"),
        };
        return Number.isFinite(point.x) && Number.isFinite(point.y) ? point : null;
      }

      const dependentValue = evaluateExpression(curve.expr, independentValue, samplingRange.variableName);
      if (!Number.isFinite(dependentValue)) {
        return null;
      }

      return mode === "xOfY"
        ? { x: dependentValue, y: independentValue }
        : { x: independentValue, y: dependentValue };
    } catch {
      return null;
    }
  };

  const isInsideSamplingWindow = (point: GraphFillPoint): boolean =>
    point.x >= xLimitMin && point.x <= xLimitMax && point.y >= yLimitMin && point.y <= yLimitMax;

  // 定義域端 (sqrt(4 - x^2) の x=±2、sqrt(x) の x=0) はサンプル格子に載らないため、
  // 定義域の内外を二分探索して最後の有効点を求め、そこまで線分を伸ばす。
  // これをしないと曲線が端点まで届かず、孤立した連結成分になって面追跡から抜け落ちる。
  // 補完ロジックは描画側 (buildFunctionPath) と共有する。
  const refineDomainEdge = (validValue: number, invalidValue: number): GraphFillPoint | null =>
    refineCurveDomainEdge(
      evaluatePoint,
      validValue,
      invalidValue,
      independentSpan,
      // 極では値が発散し続ける。窓の外まで届けば十分で、これ以上詰めると
      // clipGraphSegment の媒介変数が退化して線分ごと捨てられてしまう。
      (point) => !isInsideSamplingWindow(point),
    );

  const pushSegment = (a: GraphFillPoint, b: GraphFillPoint) => {
    // 両端とも窓 (±8スパン) の外にある線分だけを捨てる。1/x や tan x で
    // 漸近線をまたぐ偽の縦線を防ぎつつ、フレーム内から一気に窓外へ飛ぶ線分は
    // フレーム境界までクリップして残す（捨てるとフレーム内に開いた端点ができる）。
    if (!isInsideSamplingWindow(a) && !isInsideSamplingWindow(b)) {
      return;
    }

    const clipped = clipGraphSegment(a, b, clipRange);
    if (!clipped) {
      return;
    }

    segments.push({
      a: mapGraphPoint(clipped.a.x, clipped.a.y, axisRange, spec, plotBox),
      b: mapGraphPoint(clipped.b.x, clipped.b.y, axisRange, spec, plotBox),
      kind: "curve",
    });
  };

  let previous: { independentValue: number; point: GraphFillPoint } | null = null;

  for (let index = 0; index <= sampleCount; index += 1) {
    const independentValue = samplingRange.min + (independentSpan * index) / sampleCount;
    const current = evaluatePoint(independentValue);

    if (!current) {
      if (previous) {
        const refined = refineDomainEdge(previous.independentValue, independentValue);
        if (refined) {
          pushSegment(previous.point, refined);
        }
      }
      previous = null;
      continue;
    }

    if (previous) {
      pushSegment(previous.point, current);
    } else if (index > 0) {
      const previousValue = samplingRange.min + (independentSpan * (index - 1)) / sampleCount;
      const refined = refineDomainEdge(independentValue, previousValue);
      if (refined) {
        pushSegment(refined, current);
      }
    }

    previous = { independentValue, point: current };
  }

  return segments;
}

function findSimpleCurveBoundaryRegion(
  spec: Graph2DSpec,
  seed: GraphFillPoint,
  axisRange: GraphNumericRange,
  clipRange: GraphNumericRange,
  plotBox: GraphPlotBox,
): ResolvedGraphFillRegion | null {
  const candidates: ResolvedGraphFillRegion[] = [];

  for (const curve of spec.curves) {
    const mode = normalizeGraphCurveMode(curve.mode);
    if (mode === "parametric" || mode === "implicit") {
      continue;
    }

    if (mode === "xOfY") {
      const boundaries = [clipRange.xMin, clipRange.xMax];
      if (spec.axes.showY !== false && clipRange.xMin < 0 && clipRange.xMax > 0) {
        boundaries.push(0);
      }

      for (const boundary of boundaries) {
        const candidate = findCurveBoundaryRegionForMode(
          curve,
          mode,
          boundary,
          seed,
          axisRange,
          clipRange,
          spec,
          plotBox,
        );
        if (candidate) {
          candidates.push(candidate);
        }
      }
      continue;
    }

    const boundaries = [clipRange.yMin, clipRange.yMax];
    if (spec.axes.showX !== false && clipRange.yMin < 0 && clipRange.yMax > 0) {
      boundaries.push(0);
    }

    for (const boundary of boundaries) {
      const candidate = findCurveBoundaryRegionForMode(
        curve,
        mode,
        boundary,
        seed,
        axisRange,
        clipRange,
        spec,
        plotBox,
      );
      if (candidate) {
        candidates.push(candidate);
      }
    }
  }

  return chooseSmallestRegion(candidates);
}

function findCurveBoundaryRegionForMode(
  curve: GraphCurve,
  mode: "xOfY" | "yOfX",
  boundaryValue: number,
  seed: GraphFillPoint,
  axisRange: GraphNumericRange,
  clipRange: GraphNumericRange,
  spec: Graph2DSpec,
  plotBox: GraphPlotBox,
): ResolvedGraphFillRegion | null {
  const samplingRange = getCurveSamplingRange(curve, mode, clipRange);
  if (!samplingRange) {
    return null;
  }

  const seedIndependent = mode === "xOfY" ? seed.y : seed.x;
  if (seedIndependent <= samplingRange.min + GEOMETRY_EPSILON || seedIndependent >= samplingRange.max - GEOMETRY_EPSILON) {
    return null;
  }

  let seedDependent: number;
  try {
    seedDependent = evaluateExpression(curve.expr, seedIndependent, samplingRange.variableName);
  } catch {
    return null;
  }
  if (!Number.isFinite(seedDependent)) {
    return null;
  }
  if (
    mode === "xOfY" &&
    (seedDependent < clipRange.xMin - GEOMETRY_EPSILON || seedDependent > clipRange.xMax + GEOMETRY_EPSILON)
  ) {
    return null;
  }
  if (
    mode === "yOfX" &&
    (seedDependent < clipRange.yMin - GEOMETRY_EPSILON || seedDependent > clipRange.yMax + GEOMETRY_EPSILON)
  ) {
    return null;
  }
  if (!isStrictlyBetween(mode === "xOfY" ? seed.x : seed.y, boundaryValue, seedDependent)) {
    return null;
  }

  const intersections = findCurveBoundaryIntersections(
    curve,
    mode,
    boundaryValue,
    samplingRange,
    seedIndependent,
    resolveContactToleranceInGraphUnits(mode, spec, axisRange, plotBox),
  );
  for (let index = 0; index < intersections.length - 1; index += 1) {
    const start = intersections[index];
    const end = intersections[index + 1];
    if (seedIndependent <= start + INTERSECTION_PARAMETER_EPSILON || seedIndependent >= end - INTERSECTION_PARAMETER_EPSILON) {
      continue;
    }

    const polygon = buildCurveBoundaryPolygon(
      curve,
      mode,
      boundaryValue,
      start,
      end,
      samplingRange,
      axisRange,
      clipRange,
      spec,
      plotBox,
    );
    if (polygon.length < 3) {
      continue;
    }

    const area = Math.abs(signedPolygonArea(polygon));
    const seedSvg = mapGraphPoint(seed.x, seed.y, axisRange, spec, plotBox);
    if (area > MIN_FACE_AREA && pointInPolygon(seedSvg, polygon)) {
      return {
        polygon,
        area,
        path: polygonToPath(polygon),
      };
    }
  }

  return null;
}

/**
 * 溶接許容誤差 (SVG px) を、従属変数側のグラフ単位へ換算する。
 * スケールの基準は `mapGraphPoint` と同じ `axisRange` (spec.viewBox) でなければならない
 * — clipRange を使うと、表示範囲を絞ったグラフで解析経路と面追跡の許容誤差がずれる。
 */
function resolveContactToleranceInGraphUnits(
  mode: "xOfY" | "yOfX",
  spec: Graph2DSpec,
  axisRange: GraphNumericRange,
  plotBox: GraphPlotBox,
): number {
  const scale = mode === "xOfY"
    ? (spec.width - plotBox.left - plotBox.right) / Math.max(axisRange.xMax - axisRange.xMin, GEOMETRY_EPSILON)
    : (spec.height - plotBox.top - plotBox.bottom) / Math.max(axisRange.yMax - axisRange.yMin, GEOMETRY_EPSILON);

  return scale > GEOMETRY_EPSILON ? CONTACT_TOLERANCE / scale : 0;
}

function findCurveBoundaryIntersections(
  curve: GraphCurve,
  mode: "xOfY" | "yOfX",
  boundaryValue: number,
  samplingRange: CurveSamplingRange,
  seedIndependent: number,
  contactTolerance: number,
): number[] {
  const sampleCount = clampInteger(curve.samples ?? DEFAULT_CURVE_SAMPLES, MIN_CURVE_SAMPLES, MAX_CURVE_SAMPLES);
  const values = uniqueSortedNumbers([
    samplingRange.min,
    samplingRange.max,
    seedIndependent,
    ...Array.from({ length: sampleCount + 1 }, (_, index) =>
      samplingRange.min + ((samplingRange.max - samplingRange.min) * index) / sampleCount),
  ]);
  const intersections: number[] = [];
  let beforePrevious: { independent: number; delta: number } | null = null;
  let previous: { independent: number; delta: number } | null = null;

  for (const independent of values) {
    let dependent: number;
    try {
      dependent = evaluateExpression(curve.expr, independent, samplingRange.variableName);
    } catch {
      beforePrevious = null;
      previous = null;
      continue;
    }
    if (!Number.isFinite(dependent)) {
      beforePrevious = null;
      previous = null;
      continue;
    }

    const delta = dependent - boundaryValue;
    if (Math.abs(delta) <= GEOMETRY_EPSILON) {
      intersections.push(independent);
    }

    if (previous && previous.delta * delta < 0) {
      const t = previous.delta / (previous.delta - delta);
      intersections.push(previous.independent + (independent - previous.independent) * t);
    }

    // 接点: 符号が変わらないまま |delta| が局所極小になり、その値が溶接許容誤差以内なら
    // 曲線は境界に「触れている」。符号変化しか見ないと接点で領域が分割されない。
    if (
      beforePrevious &&
      previous &&
      beforePrevious.delta * delta > 0 &&
      Math.abs(previous.delta) <= contactTolerance &&
      Math.abs(previous.delta) <= Math.abs(beforePrevious.delta) &&
      Math.abs(previous.delta) <= Math.abs(delta)
    ) {
      intersections.push(previous.independent);
    }

    beforePrevious = previous;
    previous = { independent, delta };
  }

  return uniqueSortedNumbers(intersections)
    .filter((value) => value >= samplingRange.min - INTERSECTION_PARAMETER_EPSILON && value <= samplingRange.max + INTERSECTION_PARAMETER_EPSILON);
}

function buildCurveBoundaryPolygon(
  curve: GraphCurve,
  mode: "xOfY" | "yOfX",
  boundaryValue: number,
  start: number,
  end: number,
  samplingRange: CurveSamplingRange,
  axisRange: GraphNumericRange,
  clipRange: GraphNumericRange,
  spec: Graph2DSpec,
  plotBox: GraphPlotBox,
): GraphFillPoint[] {
  const sampleCount = clampInteger(curve.samples ?? DEFAULT_CURVE_SAMPLES, MIN_CURVE_SAMPLES, MAX_CURVE_SAMPLES);
  const intervalRatio = (end - start) / Math.max(samplingRange.max - samplingRange.min, GEOMETRY_EPSILON);
  const intervalSamples = clampInteger(Math.ceil(sampleCount * intervalRatio), 8, MAX_CURVE_SAMPLES);
  const graphPoints: GraphFillPoint[] = [];

  if (mode === "xOfY") {
    graphPoints.push({ x: boundaryValue, y: start }, { x: boundaryValue, y: end });
  } else {
    graphPoints.push({ x: start, y: boundaryValue }, { x: end, y: boundaryValue });
  }

  for (let index = intervalSamples; index >= 0; index -= 1) {
    const independent = start + ((end - start) * index) / intervalSamples;
    let dependent: number;
    try {
      dependent = evaluateExpression(curve.expr, independent, samplingRange.variableName);
    } catch {
      continue;
    }
    if (!Number.isFinite(dependent)) {
      continue;
    }

    const graphPoint = mode === "xOfY"
      ? { x: clamp(dependent, clipRange.xMin, clipRange.xMax), y: independent }
      : { x: independent, y: clamp(dependent, clipRange.yMin, clipRange.yMax) };

    if (index === intervalSamples || index === 0) {
      if (mode === "xOfY") {
        graphPoint.x = boundaryValue;
      } else {
        graphPoint.y = boundaryValue;
      }
    }

    graphPoints.push(graphPoint);
  }

  return graphPoints.map((point) => mapGraphPoint(point.x, point.y, axisRange, spec, plotBox));
}

interface CurveSamplingRange {
  min: number;
  max: number;
  variableName: "x" | "y";
}

function getCurveSamplingRange(
  curve: GraphCurve,
  mode: "xOfY" | "yOfX",
  clipRange: GraphNumericRange,
): CurveSamplingRange | null {
  const variableName = mode === "xOfY" ? "y" : "x";
  const independentRange = mode === "xOfY"
    ? { min: clipRange.yMin, max: clipRange.yMax }
    : { min: clipRange.xMin, max: clipRange.xMax };
  const rawDomainMin = evaluateOptionalScalar(curve.domain?.min, independentRange.min) ?? independentRange.min;
  const rawDomainMax = evaluateOptionalScalar(curve.domain?.max, independentRange.max) ?? independentRange.max;
  const min = Math.max(independentRange.min, rawDomainMin);
  const max = Math.min(independentRange.max, rawDomainMax);
  if (min >= max) {
    return null;
  }

  return { min, max, variableName };
}

export function clipGraphSegment(
  a: GraphFillPoint,
  b: GraphFillPoint,
  range: GraphNumericRange,
): GraphSegment | null {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;

  const clip = (p: number, q: number) => {
    if (Math.abs(p) < GEOMETRY_EPSILON) {
      return q >= -GEOMETRY_EPSILON;
    }

    const r = q / p;
    if (p < 0) {
      if (r > t1) return false;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return false;
      if (r < t1) t1 = r;
    }
    return true;
  };

  if (
    !clip(-dx, a.x - range.xMin) ||
    !clip(dx, range.xMax - a.x) ||
    !clip(-dy, a.y - range.yMin) ||
    !clip(dy, range.yMax - a.y)
  ) {
    return null;
  }

  if (t1 - t0 <= GEOMETRY_EPSILON) {
    return null;
  }

  return {
    a: { x: a.x + dx * t0, y: a.y + dy * t0 },
    b: { x: a.x + dx * t1, y: a.y + dy * t1 },
  };
}

function buildPlanarGraph(segments: Segment[]): PlanarGraph {
  // Build a polyline arrangement: split every boundary segment at crossings/touches
  // so the remaining edges are interior-disjoint, then trace faces as half-edges.
  const splitParameters = segments.map<SplitParameter[]>(() => [{ t: 0 }, { t: 1 }]);

  for (let i = 0; i < segments.length; i += 1) {
    for (let j = i + 1; j < segments.length; j += 1) {
      const first = segments[i];
      const second = segments[j];
      const intersection = intersectSegments(first, second);
      if (intersection) {
        splitParameters[i].push({ t: intersection.t, point: intersection.point });
        splitParameters[j].push({ t: intersection.u, point: intersection.point });
      }

      addEndpointSplitParameters(first, second, splitParameters[i], splitParameters[j]);
    }
  }

  const vertices = new Map<string, GraphVertex>();
  const adjacency = new Map<string, GraphNeighbor[]>();
  const undirectedEdges = new Set<string>();
  const edges: PlanarEdge[] = [];
  // 空間ハッシュ。バケット幅を VERTEX_SNAP_TOLERANCE にしてあるので、
  // 3x3 の近傍バケットだけ見れば許容誤差内の既存頂点を必ず拾える (探索は O(1))。
  const vertexBuckets = new Map<string, GraphVertex[]>();
  let vertexSerial = 0;

  const bucketKey = (bucketX: number, bucketY: number): string => `${bucketX}:${bucketY}`;

  // 許容誤差付きで頂点を統合する。座標は丸めずに原値のまま保持するので出力精度は落ちない。
  const getVertex = (point: GraphFillPoint): GraphVertex => {
    const bucketX = Math.floor(point.x / VERTEX_SNAP_TOLERANCE);
    const bucketY = Math.floor(point.y / VERTEX_SNAP_TOLERANCE);
    let nearest: GraphVertex | null = null;
    let nearestDistance = VERTEX_SNAP_TOLERANCE;

    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const bucket = vertexBuckets.get(bucketKey(bucketX + offsetX, bucketY + offsetY));
        if (!bucket) {
          continue;
        }

        for (const candidate of bucket) {
          const candidateDistance = distance(candidate.point, point);
          if (candidateDistance < nearestDistance) {
            nearest = candidate;
            nearestDistance = candidateDistance;
          }
        }
      }
    }

    if (nearest) {
      return nearest;
    }

    vertexSerial += 1;
    const vertex: GraphVertex = { key: `v${vertexSerial}`, point };
    vertices.set(vertex.key, vertex);
    adjacency.set(vertex.key, []);
    const ownBucketKey = bucketKey(bucketX, bucketY);
    let ownBucket = vertexBuckets.get(ownBucketKey);
    if (!ownBucket) {
      ownBucket = [];
      vertexBuckets.set(ownBucketKey, ownBucket);
    }
    ownBucket.push(vertex);

    return vertex;
  };

  const addEdge = (from: GraphVertex, to: GraphVertex) => {
    // 短い辺を破棄しない。破棄はポリラインの連結を黙って切る。頂点統合が同じ
    // VERTEX_SNAP_TOLERANCE で行われるため、残る辺長は必ずその値以上になり atan2 も安定する。
    if (from.key === to.key) {
      return;
    }

    const edgeKey = from.key < to.key ? `${from.key}|${to.key}` : `${to.key}|${from.key}`;
    if (undirectedEdges.has(edgeKey)) {
      return;
    }
    undirectedEdges.add(edgeKey);
    edges.push({ a: from.point, b: to.point, fromKey: from.key, toKey: to.key });

    adjacency.get(from.key)?.push({
      key: to.key,
      angle: Math.atan2(to.point.y - from.point.y, to.point.x - from.point.x),
    });
    adjacency.get(to.key)?.push({
      key: from.key,
      angle: Math.atan2(from.point.y - to.point.y, from.point.x - to.point.x),
    });
  };

  // 近傍探索の結果はセグメントの処理順に依存する。順序は決定的
  // (フレーム → x軸 → y軸 → spec.curves の順。buildBoundarySegments 参照)。
  segments.forEach((segment, index) => {
    const parameters = normalizeParameters(splitParameters[index]);
    for (let parameterIndex = 0; parameterIndex < parameters.length - 1; parameterIndex += 1) {
      const a = pointFromSplitParameter(segment, parameters[parameterIndex]);
      const b = pointFromSplitParameter(segment, parameters[parameterIndex + 1]);
      addEdge(getVertex(a), getVertex(b));
    }
  });

  for (const neighbors of adjacency.values()) {
    neighbors.sort((a, b) => a.angle - b.angle);
  }

  return { vertices, adjacency, edges, edgeCount: undirectedEdges.size };
}

function addEndpointSplitParameters(
  first: Segment,
  second: Segment,
  firstParameters: SplitParameter[],
  secondParameters: SplitParameter[],
) {
  const firstAOnSecond = parameterForPointOnSegment(first.a, second);
  const firstBOnSecond = parameterForPointOnSegment(first.b, second);
  const secondAOnFirst = parameterForPointOnSegment(second.a, first);
  const secondBOnFirst = parameterForPointOnSegment(second.b, first);

  if (firstAOnSecond !== null) secondParameters.push({ t: firstAOnSecond, point: first.a });
  if (firstBOnSecond !== null) secondParameters.push({ t: firstBOnSecond, point: first.b });
  if (secondAOnFirst !== null) firstParameters.push({ t: secondAOnFirst, point: second.a });
  if (secondBOnFirst !== null) firstParameters.push({ t: secondBOnFirst, point: second.b });
}

function traceFaces(graph: PlanarGraph): ResolvedGraphFillRegion[] {
  // Half-edge face walk: at each target vertex, take the next outgoing edge in
  // angular order so the face stays consistently on the same side of the walk.
  const faces: ResolvedGraphFillRegion[] = [];
  const visited = new Set<string>();
  const maxSteps = graph.edgeCount * 2 + 8;

  for (const [fromKey, neighbors] of graph.adjacency) {
    for (const neighbor of neighbors) {
      const startFrom = fromKey;
      const startTo = neighbor.key;
      const startEdgeKey = directedEdgeKey(startFrom, startTo);
      if (visited.has(startEdgeKey)) {
        continue;
      }

      const polygonKeys: string[] = [];
      let currentFrom = startFrom;
      let currentTo = startTo;
      let closed = false;

      for (let step = 0; step < maxSteps; step += 1) {
        const edgeKey = directedEdgeKey(currentFrom, currentTo);
        if (visited.has(edgeKey)) {
          break;
        }
        visited.add(edgeKey);
        polygonKeys.push(currentFrom);

        const nextNeighbors = graph.adjacency.get(currentTo);
        if (!nextNeighbors || nextNeighbors.length === 0) {
          break;
        }

        const incomingIndex = nextNeighbors.findIndex((candidate) => candidate.key === currentFrom);
        if (incomingIndex === -1) {
          break;
        }

        const nextIndex = (incomingIndex - 1 + nextNeighbors.length) % nextNeighbors.length;
        const nextTo = nextNeighbors[nextIndex].key;
        currentFrom = currentTo;
        currentTo = nextTo;

        if (currentFrom === startFrom && currentTo === startTo) {
          closed = true;
          break;
        }
      }

      if (!closed || polygonKeys.length < 3) {
        continue;
      }

      for (const cycleKeys of splitClosedWalkIntoSimpleCycles(polygonKeys)) {
        const polygon = cycleKeys
          .map((key) => graph.vertices.get(key)?.point)
          .filter((point): point is GraphFillPoint => Boolean(point));
        const area = Math.abs(signedPolygonArea(polygon));
        if (area <= MIN_FACE_AREA) {
          continue;
        }

        faces.push({
          polygon,
          area,
          path: polygonToPath(polygon),
        });
      }
    }
  }

  return faces;
}

function splitClosedWalkIntoSimpleCycles(keys: string[]): string[][] {
  const stack: string[] = [];
  const indexByKey = new Map<string, number>();
  const cycles: string[][] = [];

  for (const key of keys) {
    const existingIndex = indexByKey.get(key);
    if (existingIndex === undefined) {
      indexByKey.set(key, stack.length);
      stack.push(key);
      continue;
    }

    const cycle = stack.slice(existingIndex);
    if (cycle.length >= 3) {
      cycles.push(cycle);
    }

    const removed = stack.splice(existingIndex + 1);
    for (const removedKey of removed) {
      indexByKey.delete(removedKey);
    }
  }

  if (cycles.length === 0 && stack.length >= 3) {
    cycles.push(stack);
  }

  return cycles;
}

type FaceClosedPredicate = (face: ResolvedGraphFillRegion) => boolean;

/**
 * arrangement の 2-core（次数1の頂点が無くなるまで反復的に剪定した残り）を返す。
 *
 * 行き止まりの鎖（定義域つきの曲線・片端が宙に浮いた弧）は、面の内部に入っていても
 * **位相的に面を分割しない**（端を回り込める）。これを事後条件の判定材料にすると、
 * 「y = x (-2 ≤ x ≤ 2)」のような教材で頻出の注記線が1本あるだけでグラフ全体が塗れなくなる。
 * 剪定を免れるのは「閉路に参加している辺」と「閉路どうしを繋ぐ橋」で、
 * 頂点の次数ではなく閉路への到達性が判定基準になる
 *（次数3の頂点でも枝を2本失えば剪定されるし、曲線どうしが溶接された次数2の頂点は残る）。
 * 2-core は「面を分割しうる辺」の上位集合であり、閉ループを繋ぎ止める橋も残る点に注意。
 *
 * 剪定するのは事後条件の判定集合だけで、面追跡・頂点統合・接点分割・返却する多角形には
 * 一切影響しない（弧そのものは arrangement に残るので「曲線を無視して塗る」挙動には戻らない）。
 */
function collectSeparatingEdges(graph: PlanarGraph): PlanarEdge[] {
  const degrees = new Map<string, number>();
  for (const [key, neighbors] of graph.adjacency) {
    degrees.set(key, neighbors.length);
  }

  const pruned = new Set<string>();
  const queue: string[] = [];
  for (const [key, degree] of degrees) {
    if (degree <= 1) {
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const key = queue.pop() as string;
    if (pruned.has(key) || (degrees.get(key) ?? 0) > 1) {
      continue;
    }
    pruned.add(key);

    for (const neighbor of graph.adjacency.get(key) ?? []) {
      if (pruned.has(neighbor.key)) {
        continue;
      }
      const nextDegree = (degrees.get(neighbor.key) ?? 0) - 1;
      degrees.set(neighbor.key, nextDegree);
      if (nextDegree <= 1) {
        queue.push(neighbor.key);
      }
    }
  }

  return graph.edges.filter((edge) => !pruned.has(edge.fromKey) && !pruned.has(edge.toKey));
}

/**
 * 「面の内部に、領域を分割しうる辺が残っていないこと」を面の事後条件にする。
 *
 * 面追跡は行き止まりの往復を巻き戻して閉路を作るため、本来その面を割っている境界が
 * 内部に浮いたまま残ることがある。そのまま塗ると描かれている境界を越えて漏れるので棄却する。
 * 判定に使うのは `collectSeparatingEdges` が返す 2-core だけで、面を分割しない
 * 行き止まりの鎖は対象外。面の境界そのものである辺は中点が多角形境界上 (距離 ≈ 0) なので除外される。
 */
function createFaceClosedPredicate(edges: PlanarEdge[]): FaceClosedPredicate {
  const cache = new Map<string, boolean>();

  return (face: ResolvedGraphFillRegion): boolean => {
    const cached = cache.get(face.path);
    if (cached !== undefined) {
      return cached;
    }

    const closed = !faceHasInteriorBoundary(face, edges);
    cache.set(face.path, closed);
    return closed;
  };
}

function faceHasInteriorBoundary(face: ResolvedGraphFillRegion, edges: PlanarEdge[]): boolean {
  const bounds = polygonBounds(face.polygon);

  for (const edge of edges) {
    const midpoint = { x: (edge.a.x + edge.b.x) / 2, y: (edge.a.y + edge.b.y) / 2 };
    if (
      midpoint.x < bounds.minX ||
      midpoint.x > bounds.maxX ||
      midpoint.y < bounds.minY ||
      midpoint.y > bounds.maxY
    ) {
      continue;
    }

    if (!pointInPolygon(midpoint, face.polygon)) {
      continue;
    }

    if (distancePointToPolygonBoundary(midpoint, face.polygon) > CONTACT_TOLERANCE) {
      return true;
    }
  }

  return false;
}

/** 空の多角形では全成分が ±Infinity になり、以降の bbox 判定が全て skip される。 */
function polygonBounds(
  polygon: GraphFillPoint[],
): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const point of polygon) {
    minX = Math.min(minX, point.x);
    maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y);
    maxY = Math.max(maxY, point.y);
  }

  return { minX, maxX, minY, maxY };
}

function distancePointToPolygonBoundary(point: GraphFillPoint, polygon: GraphFillPoint[]): number {
  let nearest = Infinity;
  for (let index = 0, previousIndex = polygon.length - 1; index < polygon.length; previousIndex = index, index += 1) {
    nearest = Math.min(
      nearest,
      distancePointToSegment(point, { a: polygon[previousIndex], b: polygon[index], kind: "frame" }),
    );
    if (nearest <= CONTACT_TOLERANCE) {
      return nearest;
    }
  }

  return nearest;
}

interface ContainingFaceLookup {
  face: ResolvedGraphFillRegion | null;
  /** seed を含む面はあったが、いずれも内部に境界が残っていて閉じていなかった。 */
  openFaceRejected: boolean;
}

function findContainingFace(
  point: GraphFillPoint,
  faces: ResolvedGraphFillRegion[],
  isFaceClosed: FaceClosedPredicate,
): ContainingFaceLookup {
  // 面積の小さい順に見るので、閉じ判定は候補の先頭数件にしか走らない。
  const containingFaces = faces
    .filter((face) => face.area > MIN_FACE_AREA && pointInPolygon(point, face.polygon))
    .sort((a, b) => a.area - b.area);

  for (const face of containingFaces) {
    if (isFaceClosed(face)) {
      return { face, openFaceRejected: false };
    }
  }

  return { face: null, openFaceRejected: containingFaces.length > 0 };
}

function findContainingFaceNearPoint(
  point: GraphFillPoint,
  faces: ResolvedGraphFillRegion[],
  radius: number,
  isFaceClosed: FaceClosedPredicate,
): ContainingFaceLookup {
  const exact = findContainingFace(point, faces, isFaceClosed);
  if (exact.openFaceRejected) {
    return exact;
  }

  const exactFace = exact.face;
  const candidates = [
    point,
    { x: point.x + radius, y: point.y },
    { x: point.x - radius, y: point.y },
    { x: point.x, y: point.y + radius },
    { x: point.x, y: point.y - radius },
    { x: point.x + radius, y: point.y + radius },
    { x: point.x + radius, y: point.y - radius },
    { x: point.x - radius, y: point.y + radius },
    { x: point.x - radius, y: point.y - radius },
  ];
  const nearbyFaces = new Map<string, ResolvedGraphFillRegion>();
  if (exactFace) {
    nearbyFaces.set(exactFace.path, exactFace);
  }

  for (const candidate of candidates) {
    const face = findContainingFace(candidate, faces, isFaceClosed).face;
    if (face) {
      nearbyFaces.set(face.path, face);
    }
  }

  return {
    face: [...nearbyFaces.values()].sort((a, b) => a.area - b.area)[0] ?? null,
    openFaceRejected: false,
  };
}

function chooseSmallestRegion(
  regions: Array<ResolvedGraphFillRegion | null | undefined>,
): ResolvedGraphFillRegion | null {
  return regions
    .filter((region): region is ResolvedGraphFillRegion => region !== null && region !== undefined && region.area > MIN_FACE_AREA)
    .sort((a, b) => a.area - b.area)[0] ?? null;
}

function findNearSegments(point: GraphFillPoint, segments: Segment[], tolerance: number): Segment[] {
  return segments.filter((segment) => distancePointToSegment(point, segment) <= tolerance);
}

export function intersectSegments(
  first: Segment,
  second: Segment,
): { point: GraphFillPoint; t: number; u: number } | null {
  const rx = first.b.x - first.a.x;
  const ry = first.b.y - first.a.y;
  const sx = second.b.x - second.a.x;
  const sy = second.b.y - second.a.y;
  const denominator = cross({ x: rx, y: ry }, { x: sx, y: sy });
  if (Math.abs(denominator) < GEOMETRY_EPSILON) {
    return null;
  }

  const qpx = second.a.x - first.a.x;
  const qpy = second.a.y - first.a.y;
  const t = cross({ x: qpx, y: qpy }, { x: sx, y: sy }) / denominator;
  const u = cross({ x: qpx, y: qpy }, { x: rx, y: ry }) / denominator;
  if (!isUnitParameter(t) || !isUnitParameter(u)) {
    return null;
  }

  return {
    point: {
      x: first.a.x + rx * t,
      y: first.a.y + ry * t,
    },
    t,
    u,
  };
}

function parameterForPointOnSegment(point: GraphFillPoint, segment: Segment): number | null {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared < GEOMETRY_EPSILON) {
    return null;
  }

  const crossValue = cross(
    { x: dx, y: dy },
    { x: point.x - segment.a.x, y: point.y - segment.a.y },
  );
  if (Math.abs(crossValue) / Math.sqrt(lengthSquared) > CONTACT_TOLERANCE) {
    return null;
  }

  const t = ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared;
  return isUnitParameter(t) ? t : null;
}

function pointInPolygon(point: GraphFillPoint, polygon: GraphFillPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const current = polygon[i];
    const previous = polygon[j];
    const crosses = (current.y > point.y) !== (previous.y > point.y);
    if (!crosses) {
      continue;
    }

    const x = ((previous.x - current.x) * (point.y - current.y)) / (previous.y - current.y) + current.x;
    if (point.x < x) {
      inside = !inside;
    }
  }

  return inside;
}

function distancePointToSegment(point: GraphFillPoint, segment: Segment): number {
  const dx = segment.b.x - segment.a.x;
  const dy = segment.b.y - segment.a.y;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= GEOMETRY_EPSILON) {
    return distance(point, segment.a);
  }

  const t = Math.max(0, Math.min(1, ((point.x - segment.a.x) * dx + (point.y - segment.a.y) * dy) / lengthSquared));
  return distance(point, {
    x: segment.a.x + dx * t,
    y: segment.a.y + dy * t,
  });
}

function parseFillSeed(fill: GraphFillRegion): GraphFillPoint | null {
  const x = evaluateOptionalScalar(fill.x, null);
  const y = evaluateOptionalScalar(fill.y, null);
  return x === null || y === null ? null : { x, y };
}

function containsGraphPoint(range: GraphNumericRange, point: GraphFillPoint): boolean {
  return point.x > range.xMin + GEOMETRY_EPSILON &&
    point.x < range.xMax - GEOMETRY_EPSILON &&
    point.y > range.yMin + GEOMETRY_EPSILON &&
    point.y < range.yMax - GEOMETRY_EPSILON;
}

function intersectRanges(a: GraphNumericRange, b: GraphNumericRange): GraphNumericRange | null {
  const xMin = Math.max(a.xMin, b.xMin);
  const xMax = Math.min(a.xMax, b.xMax);
  const yMin = Math.max(a.yMin, b.yMin);
  const yMax = Math.min(a.yMax, b.yMax);
  return xMin < xMax && yMin < yMax ? { xMin, xMax, yMin, yMax } : null;
}

function normalizeParameters(parameters: SplitParameter[]): SplitParameter[] {
  const sorted = parameters
    .filter((parameter) => isUnitParameter(parameter.t))
    .map((parameter) => ({
      ...parameter,
      t: Math.min(1, Math.max(0, parameter.t)),
    }))
    .sort((a, b) => a.t - b.t);
  const normalized: SplitParameter[] = [];
  for (const parameter of sorted) {
    const previous = normalized[normalized.length - 1];
    if (!previous || Math.abs(parameter.t - previous.t) > GEOMETRY_EPSILON) {
      normalized.push(parameter);
    } else if (!previous.point && parameter.point) {
      previous.point = parameter.point;
    }
  }
  return normalized;
}

function isUnitParameter(value: number): boolean {
  return Number.isFinite(value) && value >= -GEOMETRY_EPSILON && value <= 1 + GEOMETRY_EPSILON;
}

function interpolate(a: GraphFillPoint, b: GraphFillPoint, t: number): GraphFillPoint {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function pointFromSplitParameter(segment: Segment, parameter: SplitParameter): GraphFillPoint {
  return parameter.point ?? interpolate(segment.a, segment.b, parameter.t);
}

function directedEdgeKey(from: string, to: string): string {
  return `${from}->${to}`;
}

function polygonToPath(points: GraphFillPoint[]): string {
  const [first, ...rest] = points;
  return [
    `M${roundSvgValue(first.x)} ${roundSvgValue(first.y)}`,
    ...rest.map((point) => `L${roundSvgValue(point.x)} ${roundSvgValue(point.y)}`),
    "Z",
  ].join(" ");
}

function signedPolygonArea(points: GraphFillPoint[]): number {
  let sum = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index];
    const next = points[(index + 1) % points.length];
    sum += current.x * next.y - next.x * current.y;
  }
  return sum / 2;
}

function cross(a: GraphFillPoint, b: GraphFillPoint): number {
  return a.x * b.y - a.y * b.x;
}

function distance(a: GraphFillPoint, b: GraphFillPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function isStrictlyBetween(value: number, first: number, second: number): boolean {
  return value > Math.min(first, second) + GEOMETRY_EPSILON &&
    value < Math.max(first, second) - GEOMETRY_EPSILON;
}

function uniqueSortedNumbers(values: number[]): number[] {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  const unique: number[] = [];

  for (const value of sorted) {
    const previous = unique[unique.length - 1];
    if (previous === undefined || Math.abs(value - previous) > INTERSECTION_PARAMETER_EPSILON) {
      unique.push(value);
    }
  }

  return unique;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function roundSvgValue(value: number): number {
  return Number(value.toFixed(3));
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.round(Math.max(min, Math.min(max, value)));
}
