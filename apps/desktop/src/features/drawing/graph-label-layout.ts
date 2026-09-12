import { resolveGraph2DParameters } from "@/features/rendering/core";
import type  {
  Graph2DSpec,
  GraphAnnotation,
  GraphCurve,
  GraphCurveMode,
  GraphPoint,
  GraphPointLabelPlacement,
  GraphViewBox,
  OverlayGraphAxisLabelKey,
  OverlayGraphShape,
  OverlayPoint,
  OverlayShape,
  OverlayShapeId,
  OverlayTextBlock,
  OverlayTextShape,
} from "@/features/document";
import  {
  axisX,
  axisY,
  formatGraphCurveLabel,
  intersectGraphRanges,
  mapGraphPoint,
} from "./graph-coordinate-label";

import { getGraphDisplaySpec, getGraphPlotBox, getGraphRenderLayout, type GraphPlotBox } from "./graph-layout";

const DEFAULT_GRAPH_ORIGIN_LABEL_TEX = "\\mathrm{O}";
const GRAPH_LABEL_GAP = 10;
const GRAPH_LABEL_STACK_GAP = 4;
const GRAPH_AXIS_LABEL_COLOR = "#1f2937";
const GRAPH_COORDINATE_LABEL_FONT_SIZE_PT = 10;
const GRAPH_FORMULA_LABEL_FONT_SIZE_PT = 12;
const GRAPH_COLOR_FALLBACK = "#0d0d0d";
const GRAPH_COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

type GraphExpressionVariableName = "x" | "y";

export interface GraphLabelLayoutPort {
  measureMathLabel(tex: string, fontSizePt: number): { width: number; height: number };
  evaluateExpression(
    expression: string,
    value: number,
    variableName: GraphExpressionVariableName,
  ): number;
  createInlineMathId(): string;
  createBlockId(): string;
}

interface GraphNumericRange {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
}

interface GraphClipBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

function measureGraphLabelTex(
  tex: string,
  fontSizePt: number,
  port: GraphLabelLayoutPort,
): { width: number; height: number } {
  const measurement = port.measureMathLabel(tex, fontSizePt);
  return {
    width: Math.max(8, measurement.width),
    height: measurement.height,
  };
}

function evaluateOptionalScalar(
  input: string | undefined,
  fallback: number | null,
  port: GraphLabelLayoutPort,
): number | null {
  if (input === undefined || input.trim() === "") {
    return fallback;
  }

  try {
    return port.evaluateExpression(input, 0, "x");
  } catch {
    return null;
  }
}

function getGraphNumericRange(spec: Graph2DSpec, port: GraphLabelLayoutPort): GraphNumericRange {
  return parseGraphViewBox(spec.viewBox, port);
}

function getGraphDisplayRange(spec: Graph2DSpec, port: GraphLabelLayoutPort): GraphNumericRange {
  return parseGraphViewBox(spec.graphViewBox ?? spec.viewBox, port);
}

function parseGraphViewBox(viewBox: GraphViewBox, port: GraphLabelLayoutPort): GraphNumericRange {
  const xMin = port.evaluateExpression(viewBox.xMin, 0, "x");
  const xMax = port.evaluateExpression(viewBox.xMax, 0, "x");
  const yMin = port.evaluateExpression(viewBox.yMin, 0, "x");
  const yMax = port.evaluateExpression(viewBox.yMax, 0, "x");

  if (xMin >= xMax) {
    throw new Error("xMin must be smaller than xMax");
  }
  if (yMin >= yMax) {
    throw new Error("yMin must be smaller than yMax");
  }

  return { xMin, xMax, yMin, yMax };
}

function getGraphDisplayClipBox(
  spec: Graph2DSpec,
  plotBox: GraphPlotBox,
  port: GraphLabelLayoutPort,
): GraphClipBox {
  const axisRange = getGraphNumericRange(spec, port);
  const displayRange = getGraphDisplayRange(spec, port);
  const clipRange = intersectGraphRanges(axisRange, displayRange);
  if (!clipRange) {
    return { x: plotBox.left, y: plotBox.top, width: 0, height: 0 };
  }

  const topLeft = mapGraphPoint(clipRange.xMin, clipRange.yMax, axisRange, spec, plotBox);
  const bottomRight = mapGraphPoint(clipRange.xMax, clipRange.yMin, axisRange, spec, plotBox);
  return {
    x: topLeft.x,
    y: topLeft.y,
    width: Math.max(0, bottomRight.x - topLeft.x),
    height: Math.max(0, bottomRight.y - topLeft.y),
  };
}


function normalizeGraphColor(color: string | undefined, fallback = GRAPH_COLOR_FALLBACK): string {
  return color && GRAPH_COLOR_PATTERN.test(color) ? color : fallback;
}

function normalizeGraphPaletteColor(color: string | undefined): string {
  return color && GRAPH_COLOR_PATTERN.test(color) ? color.toLowerCase() : GRAPH_COLOR_FALLBACK;
}

function normalizeGraphCurveMode(mode: GraphCurveMode | undefined): GraphCurveMode {
  if (mode === "xOfY" || mode === "parametric" || mode === "implicit") {
    return mode;
  }

  return "yOfX";
}


function parseGraphPoint(
  point: GraphPoint | GraphAnnotation,
  port: GraphLabelLayoutPort,
): { x: number; y: number } | null {
  const x = evaluateOptionalScalar(point.x, null, port);
  const y = evaluateOptionalScalar(point.y, null, port);
  return x === null || y === null ? null : { x, y };
}

export interface GraphFormulaLabelEntry {
  curveId: string;
  tex: string;
  color: string;
  width: number;
  height: number;
}

export interface GraphFormulaLabelShapeEntry {
  curveId: string;
  shape: OverlayTextShape;
}

export interface GraphPointLabelShapeEntry {
  pointId: string;
  shape: OverlayTextShape;
}

export interface GraphAnnotationLabelShapeEntry {
  annotationId: string;
  shape: OverlayTextShape;
}

export interface GraphAxisLabelShapeEntry {
  key: OverlayGraphAxisLabelKey;
  shape: OverlayTextShape;
}

export interface GraphFormulaLabelOptions {
  curveIds?: readonly string[];
}

export interface GraphPointLabelOptions {
  pointIds?: readonly string[];
}

export interface GraphAnnotationLabelOptions {
  annotationIds?: readonly string[];
}

export function getGraphFormulaLabelEntries(
  spec: Graph2DSpec,
  port: GraphLabelLayoutPort,
  options?: GraphFormulaLabelOptions,
): GraphFormulaLabelEntry[] {
  const curveIdSet = options?.curveIds ? new Set(options.curveIds) : null;
  return spec.curves
    .filter((curve) => !curveIdSet || curveIdSet.has(curve.id))
    .map((curve) => {
      const tex = formatGraphCurveLabel(curve).trim();
      const measured = measureGraphLabelTex(tex, GRAPH_FORMULA_LABEL_FONT_SIZE_PT, port);
      return {
        curveId: curve.id,
        tex,
        color: normalizeGraphPaletteColor(curve.color),
        width: measured.width,
        height: measured.height,
      };
    })
    .filter((entry) => entry.tex.length > 0);
}

export function createGraphFormulaLabelShapes(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  canvasSize: { width: number; height: number },
  port: GraphLabelLayoutPort,
  options?: GraphFormulaLabelOptions,
): OverlayTextShape[] {
  return createGraphFormulaLabelShapeEntries(graphShape, createShapeId, canvasSize, port, options)
    .map((entry) => entry.shape);
}

export function createGraphFormulaLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  canvasSize: { width: number; height: number },
  port: GraphLabelLayoutPort,
  options?: GraphFormulaLabelOptions,
): GraphFormulaLabelShapeEntry[] {
  const entries = getGraphFormulaLabelEntries(graphShape.props.spec, port, options);
  if (entries.length === 0) {
    return [];
  }

  const origin = getFormulaLabelOrigin(graphShape, entries, canvasSize);
  let offsetY = 0;
  return entries.map((entry) => {
    const shape: OverlayTextShape = {
      id: createShapeId(),
      type: "text",
      x: origin.x,
      y: origin.y + offsetY,
      rotation: 0,
      anchor: {
        type: "shape",
        shapeId: graphShape.id,
        dx: origin.x - graphShape.x,
        dy: origin.y + offsetY - graphShape.y,
      },
      props: {
        w: entry.width,
        h: entry.height,
        blocks: graphMathLabelBlocks(entry.tex, port),
        color: entry.color,
        fontSize: GRAPH_FORMULA_LABEL_FONT_SIZE_PT,
        size: "m",
      },
    };
    offsetY += entry.height + GRAPH_LABEL_STACK_GAP;
    return { curveId: entry.curveId, shape };
  });
}

export function isGraphLabelTextShape(shape: OverlayShape, shapes: readonly OverlayShape[]): shape is OverlayTextShape {
  if (shape.type !== "text") {
    return false;
  }

  return shapes.some((candidate) => (
    candidate.type === "graph2dShape" &&
    isGraphLabelTextShapeId(shape.id, candidate)
  ));
}

/**
 * Every text shape a graph owns: axis, point, annotation and formula labels.
 *
 * These live as ordinary sibling shapes (not children of the graph) so they can
 * be nudged individually, which means anything that treats a graph as one unit
 * -- deletion, AI edit locks -- has to expand through this ownership edge
 * itself. Ids are reported as stored, without checking that the shape still
 * exists; callers that need existing shapes only should filter.
 */
export function getGraphOwnedLabelShapeIds(graphShape: OverlayGraphShape): OverlayShapeId[] {
  return [...new Set([
    ...Object.values(graphShape.props.axisLabelTextShapeIds ?? {}),
    ...Object.values(graphShape.props.pointLabelTextShapeIdsByPointId ?? {}),
    ...Object.values(graphShape.props.annotationTextShapeIdsByAnnotationId ?? {}),
    ...Object.values(graphShape.props.labelTextShapeIdsByCurveId ?? {}),
    ...(graphShape.props.labelTextShapeIds ?? []),
  ])];
}

/**
 * `ids` plus the label shapes owned by every graph among them, so a caller that
 * reserved a graph reserves its labels in the same breath.
 */
export function expandShapeIdsWithGraphOwnedLabels(
  shapes: readonly OverlayShape[],
  ids: Iterable<OverlayShapeId>,
): OverlayShapeId[] {
  const expanded = new Set(ids);
  if (expanded.size === 0) {
    return [];
  }
  for (const shape of shapes) {
    if (shape.type !== "graph2dShape" || !expanded.has(shape.id)) {
      continue;
    }
    for (const labelId of getGraphOwnedLabelShapeIds(shape)) {
      expanded.add(labelId);
    }
  }
  return [...expanded];
}

function isGraphLabelTextShapeId(shapeId: OverlayShapeId, graphShape: OverlayGraphShape): boolean {
  return getGraphOwnedLabelShapeIds(graphShape).includes(shapeId);
}

export interface GraphAxisLabelOptions {
  keys?: readonly OverlayGraphAxisLabelKey[];
  labelsByKey?: Partial<Record<OverlayGraphAxisLabelKey, string>>;
}

export function createGraphAxisLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  port: GraphLabelLayoutPort,
  options?: GraphAxisLabelOptions,
): GraphAxisLabelShapeEntry[] {
  const keySet = options?.keys ? new Set(options.keys) : null;
  return getGraphAxisLabelEntries(graphShape, port, options?.labelsByKey)
    .filter((entry) => !keySet || keySet.has(entry.key))
    .map((entry) => ({
      key: entry.key,
      shape: createGraphOwnedTextLabelShape(graphShape, entry, createShapeId(), port),
    }));
}

export function createGraphPointLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  port: GraphLabelLayoutPort,
  options?: GraphPointLabelOptions,
): GraphPointLabelShapeEntry[] {
  const pointIdSet = options?.pointIds ? new Set(options.pointIds) : null;
  return getGraphPointLabelEntries(graphShape, port)
    .filter((entry) => !pointIdSet || pointIdSet.has(entry.pointId))
    .map((entry) => ({
      pointId: entry.pointId,
      shape: createGraphOwnedTextLabelShape(graphShape, entry, createShapeId(), port),
    }));
}

export function createGraphAnnotationLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  port: GraphLabelLayoutPort,
  options?: GraphAnnotationLabelOptions,
): GraphAnnotationLabelShapeEntry[] {
  const annotationIdSet = options?.annotationIds ? new Set(options.annotationIds) : null;
  return getGraphAnnotationLabelEntries(graphShape, port)
    .filter((entry) => !annotationIdSet || annotationIdSet.has(entry.annotationId))
    .map((entry) => ({
      annotationId: entry.annotationId,
      shape: createGraphOwnedTextLabelShape(graphShape, entry, createShapeId(), port),
    }));
}

interface GraphAxisLabelEntry {
  key: OverlayGraphAxisLabelKey;
  text: string;
  localX: number;
  localY: number;
  width: number;
  height: number;
  align?: "left" | "center" | "right";
  color?: string;
  fontSize?: number;
}

interface GraphPointLabelEntry {
  pointId: string;
  text: string;
  localX: number;
  localY: number;
  width: number;
  height: number;
  align?: "left" | "center" | "right";
  color?: string;
  fontSize?: number;
}

interface GraphAnnotationLabelEntry {
  annotationId: string;
  text: string;
  localX: number;
  localY: number;
  width: number;
  height: number;
  align?: "left" | "center" | "right";
  color?: string;
  fontSize?: number;
}

function getGraphAxisLabelEntries(
  shape: OverlayGraphShape,
  port: GraphLabelLayoutPort,
  labelsByKey?: Partial<Record<OverlayGraphAxisLabelKey, string>>,
): GraphAxisLabelEntry[] {
  const spec = resolveGraph2DParameters(getGraphDisplaySpec(shape));
  const plotBox = getGraphPlotBox(spec);
  let range: ReturnType<typeof getGraphNumericRange>;
  let graphRange: ReturnType<typeof getGraphDisplayRange>;
  try {
    range = getGraphNumericRange(spec, port);
    graphRange = getGraphDisplayRange(spec, port);
  } catch {
    return [];
  }

  const visibleRange = intersectGraphRanges(range, graphRange);
  if (!visibleRange) {
    return [];
  }

  const showX = spec.axes.showX !== false;
  const showY = spec.kind === "cartesian" && spec.axes.showY !== false;
  const xAxisWithinRange = visibleRange.yMin <= 0 && visibleRange.yMax >= 0;
  const yAxisWithinRange = visibleRange.xMin <= 0 && visibleRange.xMax >= 0;
  const showXAxis = showX && xAxisWithinRange;
  const showYAxis = showY && yAxisWithinRange;
  const originWithinRange = xAxisWithinRange && yAxisWithinRange;
  const graphClipBox = getGraphDisplayClipBox(spec, plotBox, port);
  const xAxisY = axisY(range, spec, plotBox);
  const yAxisX = showY ? axisX(range, spec, plotBox) : null;
  const entries: GraphAxisLabelEntry[] = [];

  if (showXAxis) {
    const text = labelsByKey?.x?.trim() || spec.axes.xLabel?.trim() || "x";
    const measured = measureGraphLabelTex(text, GRAPH_COORDINATE_LABEL_FONT_SIZE_PT, port);
    entries.push({
      key: "x",
      text,
      localX: graphClipBox.x + graphClipBox.width - 4 - measured.width,
      localY: xAxisY - 14 - measured.height / 2,
      width: measured.width,
      height: measured.height,
      fontSize: GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
    });
  }

  if (showYAxis && yAxisX !== null) {
    const text = labelsByKey?.y?.trim() || spec.axes.yLabel?.trim() || "y";
    const measured = measureGraphLabelTex(text, GRAPH_COORDINATE_LABEL_FONT_SIZE_PT, port);
    entries.push({
      key: "y",
      text,
      localX: yAxisX + 6,
      localY: graphClipBox.y + 4 - measured.height / 2,
      width: measured.width,
      height: measured.height,
      fontSize: GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
    });
  }

  if (originWithinRange && showXAxis && (spec.kind === "numberLine" || showYAxis)) {
    const origin = mapGraphPoint(0, 0, range, spec, plotBox);
    const text = labelsByKey?.origin?.trim() || spec.axes.originLabel?.trim() || DEFAULT_GRAPH_ORIGIN_LABEL_TEX;
    const measured = measureGraphLabelTex(text, GRAPH_COORDINATE_LABEL_FONT_SIZE_PT, port);
    entries.push({
      key: "origin",
      text,
      localX: origin.x + 6,
      localY: (spec.kind === "numberLine" ? xAxisY - 14 : xAxisY + 14) - measured.height / 2,
      width: measured.width,
      height: measured.height,
      fontSize: GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
    });
  }

  return entries;
}

// 点ラベルの自動配置候補 (8方位)。"ne" (右上) を既定候補の先頭に置き、
// スコアが同点の場合は既存の見た目に近い "ne" を優先する。
const GRAPH_POINT_LABEL_PLACEMENT_ORDER: readonly GraphPointLabelPlacement[] = [
  "ne", "n", "e", "se", "s", "sw", "w", "nw",
];

// 点の近くで曲線をサンプリングする範囲・分解能。重すぎない程度に軽量にする。
const GRAPH_POINT_LABEL_CURVE_SAMPLE_WINDOW_PX = 40;
const GRAPH_POINT_LABEL_CURVE_SAMPLE_STEPS = 8;

// 各要素から離すべきおおよその距離 (px)。これより近いほど減点する。
const GRAPH_POINT_LABEL_CURVE_AVOID_RADIUS = 14;
const GRAPH_POINT_LABEL_AXIS_AVOID_RADIUS = 10;
const GRAPH_POINT_LABEL_POINT_AVOID_RADIUS = 12;

interface GraphPointLabelRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

function isGraphPointLabelPlacement(value: unknown): value is GraphPointLabelPlacement {
  return (GRAPH_POINT_LABEL_PLACEMENT_ORDER as readonly unknown[]).includes(value);
}

/**
 * 方位からラベル矩形の左上オフセット (点からの dx/dy) を求める。
 * ラベルは指定した方位側に、gap だけ離して置かれる。
 */
function getGraphPointLabelOffset(
  placement: GraphPointLabelPlacement,
  width: number,
  height: number,
  gap: number = GRAPH_LABEL_GAP,
): { dx: number; dy: number } {
  switch (placement) {
    case "n":
      return { dx: -width / 2, dy: -gap - height };
    case "ne":
      return { dx: gap, dy: -gap - height };
    case "e":
      return { dx: gap, dy: -height / 2 };
    case "se":
      return { dx: gap, dy: gap };
    case "s":
      return { dx: -width / 2, dy: gap };
    case "sw":
      return { dx: -gap - width, dy: gap };
    case "w":
      return { dx: -gap - width, dy: -height / 2 };
    case "nw":
      return { dx: -gap - width, dy: -gap - height };
  }
}

function distanceFromRectToPoint(rect: GraphPointLabelRect, point: { x: number; y: number }): number {
  const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
  const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
  return Math.sqrt(dx * dx + dy * dy);
}

function horizontalLineGapFromRect(rect: GraphPointLabelRect, lineY: number): number {
  if (lineY >= rect.y && lineY <= rect.y + rect.height) {
    return 0;
  }
  return Math.min(Math.abs(rect.y - lineY), Math.abs(rect.y + rect.height - lineY));
}

function verticalLineGapFromRect(rect: GraphPointLabelRect, lineX: number): number {
  if (lineX >= rect.x && lineX <= rect.x + rect.width) {
    return 0;
  }
  return Math.min(Math.abs(rect.x - lineX), Math.abs(rect.x + rect.width - lineX));
}

function rectOverlapArea(a: GraphPointLabelRect, b: GraphPointLabelRect): number {
  const overlapWidth = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const overlapHeight = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return overlapWidth * overlapHeight;
}

function rectOverflowOutside(rect: GraphPointLabelRect, bounds: GraphPointLabelRect): number {
  const left = Math.max(0, bounds.x - rect.x);
  const top = Math.max(0, bounds.y - rect.y);
  const right = Math.max(0, (rect.x + rect.width) - (bounds.x + bounds.width));
  const bottom = Math.max(0, (rect.y + rect.height) - (bounds.y + bounds.height));
  return left + top + right + bottom;
}

/**
 * 点の近く (x/y ± ウィンドウ) で曲線 (yOfX / xOfY) を軽くサンプリングし、
 * ラベル配置のスコアリングで避けるべきピクセル位置を集める。
 * 媒介変数・陰関数はコストが高いためスキップする (近似で十分)。
 */
function collectGraphCurveSamplePixelsNearPoint(
  spec: Graph2DSpec,
  point: { x: number; y: number },
  range: GraphNumericRange,
  plotBox: GraphPlotBox,
  port: GraphLabelLayoutPort,
): { x: number; y: number }[] {
  const innerWidth = spec.width - plotBox.left - plotBox.right;
  const innerHeight = spec.height - plotBox.top - plotBox.bottom;
  if (innerWidth <= 0 || innerHeight <= 0) {
    return [];
  }

  const xUnitsPerPixel = (range.xMax - range.xMin) / innerWidth;
  const yUnitsPerPixel = (range.yMax - range.yMin) / innerHeight;
  const pixels: { x: number; y: number }[] = [];

  for (const curve of spec.curves) {
    const mode = normalizeGraphCurveMode(curve.mode);
    if (mode === "yOfX") {
      const windowX = GRAPH_POINT_LABEL_CURVE_SAMPLE_WINDOW_PX * xUnitsPerPixel;
      const bounds = resolveGraphCurveSampleBounds(curve, point.x - windowX, point.x + windowX, port);
      if (!bounds) {
        continue;
      }
      for (let step = 0; step <= GRAPH_POINT_LABEL_CURVE_SAMPLE_STEPS; step += 1) {
        const x = bounds.min + ((bounds.max - bounds.min) * step) / GRAPH_POINT_LABEL_CURVE_SAMPLE_STEPS;
        try {
          const y = port.evaluateExpression(curve.expr, x, "x");
          if (Number.isFinite(y)) {
            pixels.push(mapGraphPoint(x, y, range, spec, plotBox));
          }
        } catch {
          // 評価できないサンプルは無視する。
        }
      }
    } else if (mode === "xOfY") {
      const windowY = GRAPH_POINT_LABEL_CURVE_SAMPLE_WINDOW_PX * yUnitsPerPixel;
      const bounds = resolveGraphCurveSampleBounds(curve, point.y - windowY, point.y + windowY, port);
      if (!bounds) {
        continue;
      }
      for (let step = 0; step <= GRAPH_POINT_LABEL_CURVE_SAMPLE_STEPS; step += 1) {
        const y = bounds.min + ((bounds.max - bounds.min) * step) / GRAPH_POINT_LABEL_CURVE_SAMPLE_STEPS;
        try {
          const x = port.evaluateExpression(curve.expr, y, "y");
          if (Number.isFinite(x)) {
            pixels.push(mapGraphPoint(x, y, range, spec, plotBox));
          }
        } catch {
          // 評価できないサンプルは無視する。
        }
      }
    }
    // parametric / implicit は軽量化のためサンプリング対象から除外する。
  }

  return pixels;
}

/**
 * サンプリングウィンドウ [windowMin, windowMax] を曲線の domain (指定があれば) と交差させる。
 * domain の外にしか曲線が存在しない場合は null (この点周辺では未描画とみなしサンプルなし)。
 */
function resolveGraphCurveSampleBounds(
  curve: GraphCurve,
  windowMin: number,
  windowMax: number,
  port: GraphLabelLayoutPort,
): { min: number; max: number } | null {
  const domainMin = evaluateOptionalScalar(curve.domain?.min, null, port);
  const domainMax = evaluateOptionalScalar(curve.domain?.max, null, port);
  const min = domainMin === null ? windowMin : Math.max(windowMin, domainMin);
  const max = domainMax === null ? windowMax : Math.min(windowMax, domainMax);
  if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
    return null;
  }
  return { min, max };
}

interface GraphPointLabelPlacementContext {
  mapped: { x: number; y: number };
  width: number;
  height: number;
  canvasBounds: GraphPointLabelRect;
  clipBox: GraphPointLabelRect;
  xAxisPixelY: number | null;
  yAxisPixelX: number | null;
  curveSamplePixels: { x: number; y: number }[];
  otherPointPixels: { x: number; y: number }[];
  placedLabelRects: GraphPointLabelRect[];
}

function scoreGraphPointLabelCandidate(rect: GraphPointLabelRect, context: GraphPointLabelPlacementContext): number {
  let cost = 0;

  // (i) グラフ図形のキャンバス外にはみ出すと大きく減点、描画範囲 (軸まわり) の外は軽く減点する。
  cost += rectOverflowOutside(rect, context.canvasBounds) * 80;
  cost += rectOverflowOutside(rect, context.clipBox) * 12;

  // (ii) 曲線のサンプル点に近いほど減点する。
  for (const sample of context.curveSamplePixels) {
    const gap = distanceFromRectToPoint(rect, sample);
    if (gap < GRAPH_POINT_LABEL_CURVE_AVOID_RADIUS) {
      cost += (GRAPH_POINT_LABEL_CURVE_AVOID_RADIUS - gap) * 3;
    }
  }

  // (iii) 軸線に近いほど減点する。
  if (context.xAxisPixelY !== null) {
    const gap = horizontalLineGapFromRect(rect, context.xAxisPixelY);
    if (gap < GRAPH_POINT_LABEL_AXIS_AVOID_RADIUS) {
      cost += (GRAPH_POINT_LABEL_AXIS_AVOID_RADIUS - gap) * 2;
    }
  }
  if (context.yAxisPixelX !== null) {
    const gap = verticalLineGapFromRect(rect, context.yAxisPixelX);
    if (gap < GRAPH_POINT_LABEL_AXIS_AVOID_RADIUS) {
      cost += (GRAPH_POINT_LABEL_AXIS_AVOID_RADIUS - gap) * 2;
    }
  }

  // (iv) 他の点、既に配置したラベルに近い/重なるほど減点する。
  for (const otherPoint of context.otherPointPixels) {
    const gap = distanceFromRectToPoint(rect, otherPoint);
    if (gap < GRAPH_POINT_LABEL_POINT_AVOID_RADIUS) {
      cost += (GRAPH_POINT_LABEL_POINT_AVOID_RADIUS - gap) * 4;
    }
  }
  for (const placedRect of context.placedLabelRects) {
    cost += rectOverlapArea(rect, placedRect) * 6;
  }

  return cost;
}

function chooseGraphPointLabelPlacement(context: GraphPointLabelPlacementContext): GraphPointLabelPlacement {
  let bestPlacement: GraphPointLabelPlacement = GRAPH_POINT_LABEL_PLACEMENT_ORDER[0];
  let bestCost = Number.POSITIVE_INFINITY;

  for (const placement of GRAPH_POINT_LABEL_PLACEMENT_ORDER) {
    const offset = getGraphPointLabelOffset(placement, context.width, context.height);
    const rect: GraphPointLabelRect = {
      x: context.mapped.x + offset.dx,
      y: context.mapped.y + offset.dy,
      width: context.width,
      height: context.height,
    };
    const cost = scoreGraphPointLabelCandidate(rect, context);
    if (cost < bestCost) {
      bestCost = cost;
      bestPlacement = placement;
    }
  }

  return bestPlacement;
}

function getGraphPointLabelEntries(shape: OverlayGraphShape, port: GraphLabelLayoutPort): GraphPointLabelEntry[] {
  const spec = resolveGraph2DParameters(getGraphDisplaySpec(shape));
  const plotBox = getGraphPlotBox(spec);
  let range: ReturnType<typeof getGraphNumericRange>;
  let graphRange: ReturnType<typeof getGraphDisplayRange>;
  try {
    range = getGraphNumericRange(spec, port);
    graphRange = getGraphDisplayRange(spec, port);
  } catch {
    return [];
  }

  const visibleRange = intersectGraphRanges(range, graphRange);
  if (!visibleRange) {
    return [];
  }

  const points = spec.points ?? [];
  const canvasBounds: GraphPointLabelRect = { x: 0, y: 0, width: spec.width, height: spec.height };
  const clipBox = getGraphDisplayClipBox(spec, plotBox, port);
  const showXAxisLine = spec.axes.showX !== false && visibleRange.yMin <= 0 && visibleRange.yMax >= 0;
  const showYAxisLine = spec.kind === "cartesian" && spec.axes.showY !== false &&
    visibleRange.xMin <= 0 && visibleRange.xMax >= 0;
  const xAxisPixelY = showXAxisLine ? axisY(range, spec, plotBox) : null;
  const yAxisPixelX = showYAxisLine ? axisX(range, spec, plotBox) : null;

  // 点どうしの近接判定に使う、可視範囲内の点のマップ済みピクセル位置。
  const mappedPointPixelsById = new Map<string, { x: number; y: number }>();
  for (const point of points) {
    const parsed = parseGraphPoint(point, port);
    if (parsed && isGraphPointInRange(parsed, visibleRange)) {
      mappedPointPixelsById.set(point.id, mapGraphPoint(parsed.x, parsed.y, range, spec, plotBox));
    }
  }

  const placedLabelRects: GraphPointLabelRect[] = [];

  return points.flatMap((point): GraphPointLabelEntry[] => {
    const text = point.label?.trim();
    if (!text) {
      return [];
    }
    const parsed = parseGraphPoint(point, port);
    if (!parsed || !isGraphPointInRange(parsed, visibleRange)) {
      return [];
    }

    const mapped = mappedPointPixelsById.get(point.id) ?? mapGraphPoint(parsed.x, parsed.y, range, spec, plotBox);
    const measured = measureGraphLabelTex(text, GRAPH_COORDINATE_LABEL_FONT_SIZE_PT, port);
    const width = measured.width;
    const height = measured.height;

    const placement = isGraphPointLabelPlacement(point.labelPlacement)
      ? point.labelPlacement
      : chooseGraphPointLabelPlacement({
        mapped,
        width,
        height,
        canvasBounds,
        clipBox,
        xAxisPixelY,
        yAxisPixelX,
        curveSamplePixels: collectGraphCurveSamplePixelsNearPoint(spec, parsed, range, plotBox, port),
        otherPointPixels: points
          .filter((candidate) => candidate.id !== point.id)
          .map((candidate) => mappedPointPixelsById.get(candidate.id))
          .filter((value): value is { x: number; y: number } => value !== undefined),
        placedLabelRects,
      });

    const offset = getGraphPointLabelOffset(placement, width, height);
    const localX = mapped.x + offset.dx;
    const localY = mapped.y + offset.dy;
    placedLabelRects.push({ x: localX, y: localY, width, height });

    return [{
      pointId: point.id,
      text,
      localX,
      localY,
      width,
      height,
      color: normalizeGraphColor(point.color, "#4b5563"),
      fontSize: GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
    }];
  });
}

function getGraphAnnotationLabelEntries(shape: OverlayGraphShape, port: GraphLabelLayoutPort): GraphAnnotationLabelEntry[] {
  const spec = resolveGraph2DParameters(getGraphDisplaySpec(shape));
  const plotBox = getGraphPlotBox(spec);
  let range: ReturnType<typeof getGraphNumericRange>;
  let graphRange: ReturnType<typeof getGraphDisplayRange>;
  try {
    range = getGraphNumericRange(spec, port);
    graphRange = getGraphDisplayRange(spec, port);
  } catch {
    return [];
  }

  const visibleRange = intersectGraphRanges(range, graphRange);
  if (!visibleRange) {
    return [];
  }

  return (spec.annotations ?? []).flatMap((annotation): GraphAnnotationLabelEntry[] => {
    const text = annotation.text.trim();
    if (!text) {
      return [];
    }
    const parsed = parseGraphPoint(annotation, port);
    if (!parsed || !isGraphPointInRange(parsed, visibleRange)) {
      return [];
    }

    const mapped = mapGraphPoint(parsed.x, parsed.y, range, spec, plotBox);
    const measured = measureGraphLabelTex(text, GRAPH_COORDINATE_LABEL_FONT_SIZE_PT, port);
    return [{
      annotationId: annotation.id,
      text,
      localX: mapped.x,
      localY: mapped.y - measured.height / 2,
      width: measured.width,
      height: measured.height,
      color: GRAPH_AXIS_LABEL_COLOR,
      fontSize: GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
    }];
  });
}

function isGraphPointInRange(
  point: { x: number; y: number },
  range: { xMin: number; xMax: number; yMin: number; yMax: number },
): boolean {
  return point.x >= range.xMin &&
    point.x <= range.xMax &&
    point.y >= range.yMin &&
    point.y <= range.yMax;
}

function createGraphOwnedTextLabelShape(
  graphShape: OverlayGraphShape,
  entry: GraphAxisLabelEntry | GraphPointLabelEntry | GraphAnnotationLabelEntry,
  id: OverlayShapeId,
  port: GraphLabelLayoutPort,
): OverlayTextShape {
  const layout = getGraphRenderLayout(graphShape);
  const localX = layout.renderBounds.x - graphShape.x + entry.localX * layout.scaleX;
  const localY = layout.renderBounds.y - graphShape.y + entry.localY * layout.scaleY;
  const rx = graphShape.props.w > 0 ? localX / graphShape.props.w : 0;
  const ry = graphShape.props.h > 0 ? localY / graphShape.props.h : 0;
  return {
    id,
    type: "text",
    x: graphShape.x + localX,
    y: graphShape.y + localY,
    rotation: 0,
    anchor: {
      type: "shape",
      shapeId: graphShape.id,
      dx: 0,
      dy: 0,
      rx,
      ry,
    },
    props: {
      // ラベルは生成時に幅が確定する (`entry.width` は数式の実測幅)。高さは本文と同じ
      // DOM 計測が書き戻すまでの下限として、同じ実測値を初期キャッシュに置く。
      w: entry.width,
      h: entry.height,
      blocks: graphMathLabelBlocks(entry.text, port, entry.align),
      color: entry.color ?? GRAPH_AXIS_LABEL_COLOR,
      fontSize: entry.fontSize ?? GRAPH_COORDINATE_LABEL_FONT_SIZE_PT,
      size: "s",
    },
  };
}

function graphMathLabelBlocks(
  tex: string,
  port: GraphLabelLayoutPort,
  align?: "left" | "center" | "right",
): OverlayTextBlock[] {
  return [
    {
      type: "paragraph",
      id: port.createBlockId(),
      ...(align ? { align } : {}),
      children: [
        {
          type: "mathInline",
          id: port.createInlineMathId(),
          tex,
          display: "inline",
          semanticRole: "expression",
        },
      ],
    },
  ];
}


function getFormulaLabelOrigin(
  shape: OverlayGraphShape,
  entries: GraphFormulaLabelEntry[],
  canvasSize: { width: number; height: number },
): OverlayPoint {
  const maxWidth = Math.max(...entries.map((entry) => entry.width));
  const stackHeight = entries.reduce((sum, entry) => sum + entry.height, 0) +
    Math.max(0, entries.length - 1) * GRAPH_LABEL_STACK_GAP;
  const rightX = shape.x + shape.props.w + GRAPH_LABEL_GAP;
  const topY = shape.y + 8;

  if (rightX + maxWidth <= canvasSize.width) {
    return {
      x: rightX,
      y: clamp(topY, 0, Math.max(0, canvasSize.height - stackHeight)),
    };
  }

  const belowY = shape.y + shape.props.h + GRAPH_LABEL_GAP;
  if (belowY + stackHeight <= canvasSize.height) {
    return {
      x: clamp(shape.x, 0, Math.max(0, canvasSize.width - maxWidth)),
      y: belowY,
    };
  }

  return {
    x: clamp(shape.x + shape.props.w - maxWidth, 0, Math.max(0, canvasSize.width - maxWidth)),
    y: clamp(topY, 0, Math.max(0, canvasSize.height - stackHeight)),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
