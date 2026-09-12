import { getShapeBounds } from "@/features/drawing";
import {
  type OverlayBounds,
  type OverlayLineShape,
  type OverlayPoint,
  type OverlayShape,
  getPageMetrics,
  PAGE_GAP_PX,
  type SigmaDocument,
} from "@/features/document";
import { pageIndexForY } from "@/features/drawing";
import { findBlock } from "@/lib/document-tree";

// Thresholds for detecting circular polyline approximations (Kåsa method)
const CIRCULAR_POLYLINE_MIN_POINTS = 6;
const CIRCULAR_POLYLINE_RMSE_THRESHOLD_PERCENT = 3;  // 3% of radius
const CIRCULAR_POLYLINE_MIN_ARC_DEGREES = 90;

export function detectCircularPolyline(points: OverlayPoint[]): {
  isCircular: boolean;
  radius?: number;
  center?: { x: number; y: number };
  rmse?: number;
} {
  // If less than minimum points, cannot be circular
  if (points.length < CIRCULAR_POLYLINE_MIN_POINTS) {
    return { isCircular: false };
  }

  // Kåsa method: fit circle equation x² + y² + Dx + Ey + F = 0
  let sumX = 0, sumY = 0, sumX2 = 0, sumY2 = 0, sumXY = 0, sumX3 = 0, sumY3 = 0, sumX2Y = 0, sumXY2 = 0;

  for (const p of points) {
    const x = p.x;
    const y = p.y;
    sumX += x;
    sumY += y;
    sumX2 += x * x;
    sumY2 += y * y;
    sumXY += x * y;
    sumX3 += x * x * x;
    sumY3 += y * y * y;
    sumX2Y += x * x * y;
    sumXY2 += x * y * y;
  }

  const n = points.length;
  const A = n * sumX2 - sumX * sumX;
  const B = n * sumXY - sumX * sumY;
  const C = n * sumY2 - sumY * sumY;
  const D = 0.5 * (n * (sumX3 + sumXY2) - sumX * (sumX2 + sumY2));
  const E = 0.5 * (n * (sumX2Y + sumY3) - sumY * (sumX2 + sumY2));

  const denom = A * C - B * B;
  if (Math.abs(denom) < 1e-10) {
    return { isCircular: false };
  }

  const cx = (D * C - B * E) / denom;
  const cy = (A * E - B * D) / denom;

  // Calculate radius
  let radius = 0;
  const angles: number[] = [];

  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    radius += Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx);
    angles.push(angle);
  }
  radius /= n;

  // Calculate RMSE
  let sumSquaredDiff = 0;
  for (const p of points) {
    const dx = p.x - cx;
    const dy = p.y - cy;
    const r = Math.sqrt(dx * dx + dy * dy);
    sumSquaredDiff += (r - radius) ** 2;
  }
  const rmse = Math.sqrt(sumSquaredDiff / n);

  // Check if fit is good enough
  if (rmse > (radius * CIRCULAR_POLYLINE_RMSE_THRESHOLD_PERCENT) / 100) {
    return { isCircular: false };
  }

  // Check angle coverage
  const sorted = angles.slice().sort((a, b) => a - b);

  // Find the largest gap between consecutive angles
  // This includes the wrap-around gap from sorted[n-1] to sorted[0]
  let maxGap = 2 * Math.PI - (sorted[sorted.length - 1] - sorted[0]);
  for (let i = 0; i < sorted.length - 1; i++) {
    maxGap = Math.max(maxGap, sorted[i + 1] - sorted[i]);
  }

  // Coverage is 2π minus the largest gap
  const coverage = 2 * Math.PI - maxGap;
  const minAngleDiff = (CIRCULAR_POLYLINE_MIN_ARC_DEGREES * Math.PI) / 180;
  if (coverage < minAngleDiff) {
    return { isCircular: false };
  }

  return {
    isCircular: true,
    radius: Math.round(radius * 100) / 100,
    center: { x: Math.round(cx * 100) / 100, y: Math.round(cy * 100) / 100 },
    rmse: Math.round(rmse * 100) / 100,
  };
}

type VisualInspectionSeverity = "error" | "warning";

export interface VisualInspectionIssue {
  severity: VisualInspectionSeverity;
  code: string;
  message: string;
  shapeId?: string;
}

// exported for a focused unit test: the public visual-session MCP tools always validate
// anchor targetId against the document before a shape is created, so this defensive check
// cannot currently be triggered end-to-end through the tool surface.
// 図形寸法の常識的な上限。この値自体を強制するのではなく、超過時にwarningでclampを
// 促すためだけに使う(ロードマップ「幅、高さ...の最小/最大値を正規化する」の"最大"側)。
const MAX_REASONABLE_SHAPE_DIMENSION_PX = 4000;
const FONT_SIZE_MIN_PT = 6;
const FONT_SIZE_MAX_PT = 96;
/** opacity系propの中で最も外れ値になりやすいキー。図形propsは種類ごとに形が違うため、
 * ここでは共通で出てくる名前だけをduck-typeで見る(深いprops構造全体は正規化対象外)。 */
const OPACITY_LIKE_PROP_KEYS = ["fillOpacity", "strokeOpacity"] as const;

function axisOutsideFraction(min: number, size: number, pageMin: number, pageSize: number): number {
  if (size <= 0) {
    return 1;
  }
  const overlapStart = Math.max(min, pageMin);
  const overlapEnd = Math.min(min + size, pageMin + pageSize);
  const overlap = Math.max(0, overlapEnd - overlapStart);
  return 1 - overlap / size;
}

/**
 * page boundsから極端にはみ出した図形を「flagするだけ」ではなく確実にauto-failさせる
 * (docs/ai-edit-tool-roadmap.md の検証強化項目)。既存のoutside_page_x/outside_page_y
 * (ページ範囲に少しでもはみ出したらerror)は挙動を変えずに残し、これらに加えて、
 * 「ページに全く重ならない」「片軸で50%を超えてはみ出す」場合を明示的なerrorにする。
 * 縦方向はページ境界をまたぐ程度なら従来どおりwarning(crosses_page_boundary)のままにする。
 */
function inspectPageOverflow(
  shape: OverlayShape,
  bounds: OverlayBounds,
  pageY: number,
  pagePxSize: { width: number; height: number },
  issues: VisualInspectionIssue[],
): void {
  const xOutsideFraction = axisOutsideFraction(bounds.x, bounds.w, 0, pagePxSize.width);
  const yOutsideFraction = axisOutsideFraction(pageY, bounds.h, 0, pagePxSize.height);
  if (xOutsideFraction >= 1 || yOutsideFraction >= 1) {
    issues.push({
      severity: "error",
      code: "shape_outside_page",
      message: "図形がページ範囲に全く重なっていません。位置を修正してください。",
      shapeId: shape.id,
    });
    return;
  }
  if (xOutsideFraction > 0.5 || yOutsideFraction > 0.5) {
    issues.push({
      severity: "error",
      code: "shape_mostly_outside_page",
      message: "図形の半分を超える部分がページ範囲外にはみ出しています。位置またはサイズを修正してください。",
      shapeId: shape.id,
    });
  }
}

/**
 * 幅、高さ、opacity、font sizeの想定範囲外をwarningとして知らせる(ロードマップの
 * 正規化項目)。ツール側で無断でclampはしない — メッセージで修正を促すだけ。
 */
function inspectNormalizationRanges(shape: OverlayShape, bounds: OverlayBounds, issues: VisualInspectionIssue[]): void {
  if (bounds.w > MAX_REASONABLE_SHAPE_DIMENSION_PX || bounds.h > MAX_REASONABLE_SHAPE_DIMENSION_PX) {
    issues.push({
      severity: "warning",
      code: "oversized_dimension",
      message: `図形のサイズが大きすぎます(w:${Math.round(bounds.w)}px, h:${Math.round(bounds.h)}px)。width/heightを${MAX_REASONABLE_SHAPE_DIMENSION_PX}px以下に調整してください(自動補正はしません)。`,
      shapeId: shape.id,
    });
  }

  if (typeof shape.opacity === "number" && (shape.opacity < 0 || shape.opacity > 1)) {
    issues.push({
      severity: "warning",
      code: "opacity_out_of_range",
      message: `opacityが0〜1の範囲外です(${shape.opacity})。0〜1に調整してください(自動補正はしません)。`,
      shapeId: shape.id,
    });
  }

  const props = shape.props as Record<string, unknown> | undefined;
  for (const key of OPACITY_LIKE_PROP_KEYS) {
    const value = props?.[key];
    if (typeof value === "number" && (value < 0 || value > 1)) {
      issues.push({
        severity: "warning",
        code: "opacity_out_of_range",
        message: `${key}が0〜1の範囲外です(${value})。0〜1に調整してください(自動補正はしません)。`,
        shapeId: shape.id,
      });
    }
  }

  const fontSize = props?.fontSize;
  if (typeof fontSize === "number" && (fontSize < FONT_SIZE_MIN_PT || fontSize > FONT_SIZE_MAX_PT)) {
    issues.push({
      severity: "warning",
      code: "font_size_out_of_range",
      message: `fontSizeが妥当な範囲(${FONT_SIZE_MIN_PT}〜${FONT_SIZE_MAX_PT}pt)外です(${fontSize})。調整してください(自動補正はしません)。`,
      shapeId: shape.id,
    });
  }
}

export function inspectShapeBasics(shape: OverlayShape, issues: VisualInspectionIssue[], draftDocument: SigmaDocument): void {
  const bounds = getShapeBounds(shape);
  const pageMetrics = getPageMetrics(draftDocument.pageLayout);
  const pagePxSize = { width: pageMetrics.page.widthPx, height: pageMetrics.page.heightPx };
  const pageStridePx = pagePxSize.height + PAGE_GAP_PX;
  if (shape.anchor?.type === "block" && !findBlock(draftDocument, shape.anchor.blockId)) {
    issues.push({
      severity: "error",
      code: "anchor_missing_block",
      message: "図形のアンカー先ブロックがdraftDocument内に見つかりません。",
      shapeId: shape.id,
    });
  }
  if (shape.hidden) {
    issues.push({
      severity: "error",
      code: "hidden_shape",
      message: "図形がhiddenになっています。",
      shapeId: shape.id,
    });
  }
  if ((shape.opacity ?? 1) <= 0.03) {
    issues.push({
      severity: "error",
      code: "transparent_shape",
      message: "図形のopacityが低すぎて見えません。",
      shapeId: shape.id,
    });
  }
  if (bounds.w < 4 || bounds.h < 4) {
    issues.push({
      severity: "error",
      code: "too_small",
      message: "図形の表示サイズが小さすぎます。",
      shapeId: shape.id,
    });
  }
  if (bounds.x < 0 || bounds.x + bounds.w > pagePxSize.width) {
    issues.push({
      severity: "error",
      code: "outside_page_x",
      message: "図形がページの左右範囲からはみ出しています。",
      shapeId: shape.id,
    });
  }
  if (bounds.y < 0) {
    issues.push({
      severity: "error",
      code: "outside_page_y",
      message: "図形がページ上端より上にあります。",
      shapeId: shape.id,
    });
  }
  const { localY: pageY } = pageIndexForY(bounds.y, pageStridePx);
  if (pageY + bounds.h > pagePxSize.height) {
    issues.push({
      severity: "warning",
      code: "crosses_page_boundary",
      message: "図形がページ境界をまたいでいる可能性があります。",
      shapeId: shape.id,
    });
  }
  inspectPageOverflow(shape, bounds, pageY, pagePxSize, issues);
  inspectNormalizationRanges(shape, bounds, issues);

  // Check for circular polyline approximations
  if (shape.type === "line") {
    const lineShape = shape as OverlayLineShape;
    const props = lineShape.props;
    const isCurveOrPolyline =
      props.kind === "polyline" ||
      props.kind === "freehand" ||
      props.kind === "curve";

    if (isCurveOrPolyline && props.points && Array.isArray(props.points) && props.points.length > 0) {
      const circularDetection = detectCircularPolyline(props.points);
      if (circularDetection.isCircular) {
        issues.push({
          severity: "error",
          code: "circular_polyline_approximation",
          message: `この折れ線は円/円弧の近似です (中心(${circularDetection.center?.x},${circularDetection.center?.y}), 半径${circularDetection.radius})。kind:"arc" または "circle"/"sector" で表現し直してください`,
          shapeId: shape.id,
        });
      }
    }
  }
}

function areAdjacentSegments(first: number, second: number, segmentCount: number, closed: boolean): boolean {
  if (Math.abs(first - second) <= 1) {
    return true;
  }
  return closed && first === 0 && second === segmentCount - 1;
}

export function hasSelfIntersection(points: OverlayPoint[], closed: boolean): boolean {
  const segmentCount = closed ? points.length : points.length - 1;
  for (let i = 0; i < segmentCount; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % points.length];
    for (let j = i + 1; j < segmentCount; j += 1) {
      if (areAdjacentSegments(i, j, segmentCount, closed)) {
        continue;
      }
      const b1 = points[j];
      const b2 = points[(j + 1) % points.length];
      if (segmentsIntersect(a1, a2, b1, b2)) {
        return true;
      }
    }
  }
  return false;
}

export function segmentsIntersect(a1: OverlayPoint, a2: OverlayPoint, b1: OverlayPoint, b2: OverlayPoint): boolean {
  const d1 = orientation(a1, a2, b1);
  const d2 = orientation(a1, a2, b2);
  const d3 = orientation(b1, b2, a1);
  const d4 = orientation(b1, b2, a2);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function orientation(a: OverlayPoint, b: OverlayPoint, c: OverlayPoint): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}
