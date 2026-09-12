import {
  arrowheadMarkerId,
  arrowheadOrient,
  arrowheadPathData,
  getArrowheadMarkerRequests,
  getEffectiveShapeOpacity,
  getRenderableShapes,
  getShapesForStackLayer,
  getTableHorizontalLineKey,
  getTableVerticalLineKey,
  createGraph3DDisplayAnnotations,
  overlayLabelFontSize,
  overlayStrokeWidth,
  projectGraph3DLabel,
  resolveTableLineBorder,
  type ArrowheadEndpointPlan,
} from "@/features/rendering/core";
import {
  clamp,
  getArcDrawnAngles,
  getArcRadii,
  getArrowheadPathTrim,
  getBlockArrowPolygonPoints,
  getCalloutPath,
  getCalloutTextRect,
  buildGraph3DSceneGeometry,
  getCroppedImageLayout,
  getGraphRenderLayout,
  getImageCoverCrop,
  getLinePolylinePoints,
  getLineSvgPath,
  getRegularPolygonPoints,
  getShapeArrowheadPlan,
  getShapeBounds,
  getShapeLabelPlacement,
  getShapeRotation,
  getShapeRotationPivot,
  getTextShapeFontSizePt,
  getTextShapeRenderedFontSizePx,
  isClosedPolyline,
  normalizeLineKind,
  normalizePositiveAngle,
  normalizeRegularPolygonSides,
  resolveShapeAnchorPositions,
  TEXT_SHAPE_LINE_HEIGHT,
  trimPolylinePoints,
} from "@/features/drawing";
import {
  getGraph3DAxisColors,
  normalizeOverlaySnapshot,
  resolveChartData,
  type OverlayArrowhead,
  type OverlayAsset,
  type OverlayDash,
  type OverlayPoint,
  type OverlayRegularPolygonSides,
  type OverlayShape,
  type OverlayShapeId,
  type OverlaySnapshot,
  type OverlayTextBlock,
  type OverlayStackLayer,
  type Graph2DSpec,
  type SigmaChartData,
  type SigmaChartSpec,
  type SigmaTableSpec,
} from "@/features/document";
import { normalizeOverlayAssetSource } from "@/features/document/asset-source";
import { isSafeCssColor, SAFE_FALLBACK_COLOR } from "@/features/document/css-safety";

import {
  escapeHtml,
  escapeHtmlAttribute as escapeAttr,
} from "../rich-text-html";

const EXPORT_VIEWPORT_PADDING_PX = 64;
const SHARP_STROKE_ATTRS = 'stroke-linecap="butt" stroke-linejoin="miter"';

/**
 * `<foreignObject>` clips at its declared width/height: SVG's initial `overflow` for it is
 * `hidden`, and Chromium does not emit a clip path for it — it drops the overflowing glyphs
 * outright, so anything past the edge is simply absent from the PDF (verified against the
 * Skia PDF backend: a 60px-tall foreignObject holding five 20px lines emits only three text
 * runs without an explicit overflow, and all five with one).
 *
 * Two independent mechanisms keep text from being lost, because either alone has a gap:
 * - The rect is bled out by a fraction of the font size in every direction. This is the
 *   primary, *bounded* mechanism and matches the approach already proven for tableShape (see
 *   `getTableForeignObjectOverflow`/`renderTableHtml`). It absorbs the small overshoot from
 *   descenders, accents and estimator rounding.
 * - `overflow="visible"` is also set. The bleed is sized from an estimate, and an estimate
 *   that is badly wrong (tall math is the known case) would overshoot it; losing ink is
 *   unrecoverable, drawing slightly outside the box is not.
 */
const OVERLAY_TEXT_BLEED_EM = 0.6;

function getOverlayTextBleedPx(fontSizePx: number): number {
  return Math.ceil(fontSizePx * OVERLAY_TEXT_BLEED_EM);
}

export interface OverlayCanvasSize {
  width: number;
  height: number;
  /** Horizontal offset (in overlay coords) for the viewBox, used to crop a figure group. */
  offsetX?: number;
  /** Vertical offset (in overlay coords) for the viewBox, used to slice one page out of the continuous canvas. */
  offsetY?: number;
}

export interface OverlayPreviewSource {
  overlaySnapshot?: OverlaySnapshot;
}

export interface OverlaySvgRenderers {
  renderGraphHtml: (spec: Graph2DSpec, idSeed: string) => string;
  renderMathHtml: (tex: string) => string;
  /**
   * Static markup for a shape's text, for a `<foreignObject>`. Same port reasoning as the table
   * below: the React work stays outside this serializer, and the implementation renders the very
   * component the canvas draws, which is what keeps the exported page and the screen in step.
   */
  renderOverlayTextHtml: (blocks: readonly OverlayTextBlock[]) => string;
  /**
   * Static table markup for a `<foreignObject>`. React work stays behind this port so the
   * serializer itself remains headless (`architecture.test.ts`); the implementation renders the
   * very component the editor surface mounts, which is what keeps the two in step.
   */
  renderTableHtml: (table: SigmaTableSpec, width: number, height: number, overflow: number) => string;
  /**
   * Native SVG for a chart — no `<foreignObject>`. A chart is drawn with SVG primitives to begin
   * with, so wrapping it in HTML would introduce a CSS dependency the standalone export cannot
   * satisfy.
   */
  renderChartSvg: (data: SigmaChartData, spec: SigmaChartSpec, width: number, height: number) => string;
}

export interface OverlaySvgExportOptions {
  stackLayer?: OverlayStackLayer;
  viewportPaddingPx?: number;
}

export function serializeOverlaySvg(
  shapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  size: OverlayCanvasSize,
  renderers: OverlaySvgRenderers,
  options: OverlaySvgExportOptions = {},
): string | undefined {
  if (shapes.length === 0) {
    return undefined;
  }

  // 図形だけでなく **asset も正規化済みのものを使う**。図形を正規化しておきながら生の assets を
  // そのまま描画に渡していたので、許可外の `src` (`file:///…` 等) が正規化境界をすり抜けて
  // 書き出し SVG — つまり印刷面と PDF — に入っていた。
  const normalizedSnapshot = normalizeOverlaySnapshot({ version: 1, shapes, assets });
  const normalizedAssets = normalizedSnapshot.assets;
  const normalizedShapes = resolveShapeAnchorPositions(normalizedSnapshot.shapes);
  const stackShapes = options.stackLayer
    ? getShapesForStackLayer(normalizedShapes, options.stackLayer)
    : normalizedShapes;
  const visibleShapes = getRenderableShapes(stackShapes);
  const exportShapes = visibleShapes.filter((shape) => shapeIntersectsExportViewport(shape, size, options.viewportPaddingPx));
  if (exportShapes.length === 0) {
    return undefined;
  }

  const offsetX = size.offsetX ?? 0;
  const offsetY = size.offsetY ?? 0;
  // Built from `normalizedShapes` — before the stack-layer, visibility and viewport narrowing
  // below — because a chart must resolve its table wherever that table happens to be: on another
  // page, behind the body layer, or hidden. Building it from `exportShapes` would silently fall the
  // chart back to its snapshot whenever the two were separated.
  const tablesById = new Map<string, SigmaTableSpec>();
  for (const shape of normalizedShapes) {
    if (shape.type === "tableShape") {
      tablesById.set(shape.id, shape.props.table);
    }
  }

  const body = exportShapes
    .map((shape) => shapeToSvg(
      withEffectiveOpacity(shape, getEffectiveShapeOpacity(stackShapes, shape)),
      normalizedAssets,
      renderers,
      tablesById,
    ))
    .join("");
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${offsetX} ${offsetY} ${size.width} ${size.height}" width="${size.width}" height="${size.height}">`,
    "<defs>",
    "</defs>",
    body,
    "</svg>",
  ].join("");
}

function shapeIntersectsExportViewport(shape: OverlayShape, size: OverlayCanvasSize, paddingPx = EXPORT_VIEWPORT_PADDING_PX): boolean {
  const offsetX = size.offsetX ?? 0;
  const offsetY = size.offsetY ?? 0;
  const left = offsetX - paddingPx;
  const top = offsetY - paddingPx;
  const right = offsetX + size.width + paddingPx;
  const bottom = offsetY + size.height + paddingPx;
  const bounds = getShapeBounds(shape);
  return bounds.x + bounds.w >= left &&
    bounds.x <= right &&
    bounds.y + bounds.h >= top &&
    bounds.y <= bottom;
}

export function serializeOverlayPreviewSvg(
  overlay: OverlayPreviewSource | undefined,
  size: OverlayCanvasSize,
  renderers: OverlaySvgRenderers,
  options: OverlaySvgExportOptions = {},
): string | undefined {
  if (!overlay?.overlaySnapshot) {
    return undefined;
  }

  const snapshot = normalizeOverlaySnapshot(overlay.overlaySnapshot);
  return serializeOverlaySvg(
    snapshot.shapes,
    snapshot.assets,
    size,
    renderers,
    options,
  );
}

/**
 * `escapeAttr` guards the XML attribute, not the CSS declaration it contains — `;` and `:` pass
 * through untouched, so a color written straight into this hand-built `style` string could append
 * declarations of its own. `overlay-snapshot.ts` already rejects such a value on the way into the
 * document; this keeps the serializer correct on its own for callers that hand it a shape from
 * anywhere else.
 */
function safeTextColor(color: string): string {
  return isSafeCssColor(color) ? color : SAFE_FALLBACK_COLOR;
}

function shapeToSvg(
  shape: OverlayShape,
  assets: Record<string, OverlayAsset>,
  renderers: OverlaySvgRenderers,
  tablesById: ReadonlyMap<string, SigmaTableSpec>,
): string {
  let svg = "";

  if (shape.type === "group") {
    return "";
  }

  if (shape.type === "geo") {
    const stroke = escapeAttr(shape.props.color || "#111111");
    const strokeWidth = overlayStrokeWidth(shape.props.size);
    const dash = dashAttr(shape.props.dash);
    const fill = shape.props.fill === "solid" ? escapeAttr(shape.props.fillColor || shape.props.color || "#111111") : "transparent";
    const strokeOpacity = opacityAttr("stroke-opacity", shape.props.strokeOpacity);
    const fillOpacity = opacityAttr("fill-opacity", shape.props.fillOpacity);
    if (shape.props.geo === "ellipse") {
      svg = `<ellipse cx="${shape.x + shape.props.w / 2}" cy="${shape.y + shape.props.h / 2}" rx="${shape.props.w / 2}" ry="${shape.props.h / 2}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${SHARP_STROKE_ATTRS}${dash}${strokeOpacity}${fillOpacity} />`;
      return withShapeOpacity(shape, withShapeRotation(shape, withShapeLabel(shape, svg)));
    }

    if (shape.props.geo === "triangle" || shape.props.geo === "diamond" || shape.props.geo === "pentagon" || shape.props.geo === "regularPolygon" || shape.props.geo === "blockArrow") {
      svg = `<polygon points="${absolutePolygonPoints(getGeoPolygonPoints(
        shape.props.geo,
        shape.props.w,
        shape.props.h,
        shape.props.apexX,
        shape.props.headLengthRatio,
        shape.props.shaftRatio,
        shape.props.polygonSides,
      ), shape.x, shape.y)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${SHARP_STROKE_ATTRS}${dash}${strokeOpacity}${fillOpacity} />`;
      return withShapeOpacity(shape, withShapeRotation(shape, withShapeLabel(shape, svg)));
    }

    const cornerRadius = typeof shape.props.radius === "number" && shape.props.radius > 0
      ? Math.max(0, Math.min(shape.props.radius, shape.props.w / 2, shape.props.h / 2))
      : 0;
    const radiusAttr = cornerRadius > 0 ? ` rx="${cornerRadius}" ry="${cornerRadius}"` : "";
    svg = `<rect x="${shape.x}" y="${shape.y}" width="${shape.props.w}" height="${shape.props.h}"${radiusAttr} fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${SHARP_STROKE_ATTRS}${dash}${strokeOpacity}${fillOpacity} />`;
    return withShapeOpacity(shape, withShapeRotation(shape, withShapeLabel(shape, svg)));
  }

  if (shape.type === "arrow") {
    const start = { x: shape.x + shape.props.start.x, y: shape.y + shape.props.start.y };
    const end = { x: shape.x + shape.props.end.x, y: shape.y + shape.props.end.y };
    const plan = getShapeArrowheadPlan(shape);
    const [drawnStart, drawnEnd] = trimPolylinePoints([start, end], plan.start.trimPx, plan.end.trimPx);
    const markerDefs = getArrowMarkerDefs(shape.id, shape.props.color, shape.props.strokeOpacity, plan);
    const markerStart = markerAttr("marker-start", shape.id, "start", plan.start.spec?.kind);
    const markerEnd = markerAttr("marker-end", shape.id, "end", plan.end.spec?.kind);
    svg = `<defs>${markerDefs}</defs><line x1="${drawnStart.x}" y1="${drawnStart.y}" x2="${drawnEnd.x}" y2="${drawnEnd.y}" stroke="${escapeAttr(shape.props.color)}" stroke-width="${overlayStrokeWidth(shape.props.size)}" ${SHARP_STROKE_ATTRS}${dashAttr(shape.props.dash)}${opacityAttr("stroke-opacity", shape.props.strokeOpacity)}${markerStart}${markerEnd} />`;
    return withShapeOpacity(shape, withShapeRotation(shape, withLineLabel(shape, svg)));
  }

  if (shape.type === "line") {
    const kind = normalizeLineKind(shape.props.kind);
    const points = shape.props.points.map((point) => ({ x: shape.x + point.x, y: shape.y + point.y }));
    const closed = isClosedPolyline(kind, points, shape.props.closed);
    // The plan is the one place that knows a closed polyline draws no head, so it cannot be
    // shortened at an end that declares no marker.
    const plan = getShapeArrowheadPlan(shape);
    const drawnPoints = trimPolylinePoints(points, plan.start.trimPx, plan.end.trimPx);
    const markerDefs = getArrowMarkerDefs(shape.id, shape.props.color, shape.props.strokeOpacity, plan);
    const markerStart = markerAttr("marker-start", shape.id, "start", plan.start.spec?.kind);
    const markerEnd = markerAttr("marker-end", shape.id, "end", plan.end.spec?.kind);
    const fillPatternDefs = getLineFillPatternDefs(shape);
    const fill = closed && shape.props.fill === "solid"
      ? shape.props.fillPattern === "diagonalHatch"
        ? `url(#${escapeAttr(lineFillPatternId(shape.id))})`
        : escapeAttr(shape.props.fillColor || shape.props.color || "#111111")
      : "none";
    const fillOpacity = closed ? opacityAttr("fill-opacity", shape.props.fillOpacity) : "";
    const strokeAttrs = `fill="${fill}" stroke="${escapeAttr(shape.props.color)}" stroke-width="${overlayStrokeWidth(shape.props.size)}" ${SHARP_STROKE_ATTRS}${dashAttr(shape.props.dash)}${opacityAttr("stroke-opacity", shape.props.strokeOpacity)}${fillOpacity}${markerStart}${markerEnd}`;
    svg = closed
      ? `<defs>${markerDefs}${fillPatternDefs}</defs><polygon points="${getLinePolylinePoints(points)}" ${strokeAttrs} />`
      : kind === "polyline"
      ? `<defs>${markerDefs}${fillPatternDefs}</defs><polyline points="${getLinePolylinePoints(drawnPoints)}" ${strokeAttrs} />`
      : `<defs>${markerDefs}${fillPatternDefs}</defs><path d="${escapeAttr(getLineSvgPath(points, kind, getArrowheadPathTrim(plan)))}" ${strokeAttrs} />`;
    return withShapeOpacity(shape, withShapeRotation(shape, withLineLabel(shape, svg)));
  }

  if (shape.type === "arc") {
    const fill = getArcFill(shape);
    const fillOpacity = shape.props.kind === "sector" ? opacityAttr("fill-opacity", shape.props.fillOpacity) : "";
    const plan = getShapeArrowheadPlan(shape);
    const markerDefs = getArrowMarkerDefs(shape.id, shape.props.color, shape.props.strokeOpacity, plan);
    const markerStart = markerAttr("marker-start", shape.id, "start", plan.start.spec?.kind);
    const markerEnd = markerAttr("marker-end", shape.id, "end", plan.end.spec?.kind);
    svg = `<defs>${markerDefs}</defs><path d="${escapeAttr(getArcPath(shape))}" fill="${fill}" stroke="${escapeAttr(shape.props.color)}" stroke-width="${overlayStrokeWidth(shape.props.size)}" ${SHARP_STROKE_ATTRS}${dashAttr(shape.props.dash)}${opacityAttr("stroke-opacity", shape.props.strokeOpacity)}${fillOpacity}${markerStart}${markerEnd} />`;
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "image") {
    const asset = assets[shape.props.assetId];
    const href = asset ? getRenderableImageHref(asset) : null;
    if (!href) {
      return "";
    }

    const crop = getImageCoverCrop(shape, asset);
    const layout = getCroppedImageLayout(shape, asset, crop);
    const imageX = shape.x + layout.x;
    const imageY = shape.y + layout.y;
    const clipId = `clip-${escapeAttr(shape.id)}`;
    svg = [
      `<clipPath id="${clipId}"><rect x="${shape.x}" y="${shape.y}" width="${shape.props.w}" height="${shape.props.h}" /></clipPath>`,
      `<image x="${imageX}" y="${imageY}" width="${layout.width}" height="${layout.height}" href="${escapeAttr(href)}" preserveAspectRatio="none" clip-path="url(#${clipId})" />`,
    ].join("");
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "callout") {
    const rect = getCalloutTextRect(shape);
    const fontSize = getTextShapeFontSizePt(shape);
    const bleed = getOverlayTextBleedPx(getTextShapeRenderedFontSizePx(shape));
    const html = renderers.renderOverlayTextHtml(shape.props.blocks);
    const outline = `<path transform="translate(${shape.x} ${shape.y})" d="${escapeAttr(getCalloutPath(shape))}" fill="transparent" stroke="#111111" stroke-width="${overlayStrokeWidth(shape.props.strokeWidth)}" ${SHARP_STROKE_ATTRS}${dashAttr(shape.props.dash)} />`;
    // Same bleed technique as the `text` branch below: the outer foreignObject is padded by
    // `bleed` on every side so Chromium's PDF backend doesn't clip overflowing glyphs, but the
    // flex-centered inner div keeps the original `rect.w`x`rect.h` box (with a `bleed`-sized
    // margin standing in for the padding) so the centering math — and therefore the text's
    // vertical position — doesn't shift when the bleed is added.
    const text = foreignObject(
      shape.x + rect.x - bleed,
      shape.y + rect.y - bleed,
      rect.w + bleed * 2,
      rect.h + bleed * 2,
      [
        `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${rect.w}px;height:${rect.h}px;margin:${bleed}px;color:${escapeAttr(safeTextColor(shape.props.color))};font-size:${fontSize}pt;line-height:${TEXT_SHAPE_LINE_HEIGHT};overflow:visible;overflow-wrap:anywhere;white-space:pre-wrap;text-align:center;">`,
        `<div style="width:100%;min-width:0;">${html}</div>`,
        "</div>",
      ].join(""),
      { overflowVisible: true },
    );
    svg = `${outline}${text}`;
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "graph2dShape") {
    const layout = getGraphRenderLayout(shape);
    const html = renderers.renderGraphHtml(layout.spec, shape.id);
    svg = foreignObject(layout.renderBounds.x, layout.renderBounds.y, layout.renderBounds.w, layout.renderBounds.h, [
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${layout.renderBounds.w}px;height:${layout.renderBounds.h}px;overflow:hidden;background:transparent;">`,
      html,
      "</div>",
    ].join(""));
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "graph3dShape") {
    const previewAsset = shape.props.previewAssetId
      ? assets[shape.props.previewAssetId]
      : undefined;
    const href = previewAsset ? getRenderableImageHref(previewAsset) : null;
    const preview = href
      ? `<image x="${shape.x}" y="${shape.y}" width="${shape.props.w}" height="${shape.props.h}" href="${escapeAttr(href)}" preserveAspectRatio="xMidYMid meet" />`
      : [
          `<rect x="${shape.x}" y="${shape.y}" width="${shape.props.w}" height="${shape.props.h}" fill="#fafbfc" stroke="#d8dde2" />`,
          `<text x="${shape.x + shape.props.w / 2}" y="${shape.y + shape.props.h / 2}" fill="#52606d" text-anchor="middle" dominant-baseline="middle" font-size="24">3D</text>`,
        ].join("");
    const labels = graph3DLabelsToSvg(shape, renderers);
    svg = `${preview}${labels}`;
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "text") {
    const bounds = getShapeBounds(shape);
    const fontSize = getTextShapeFontSizePt(shape);
    const bleed = getOverlayTextBleedPx(getTextShapeRenderedFontSizePx(shape));
    const html = renderers.renderOverlayTextHtml(shape.props.blocks);
    svg = foreignObject(
      shape.x - bleed,
      shape.y - bleed,
      bounds.w + bleed * 2,
      bounds.h + bleed * 2,
      [
        `<div xmlns="http://www.w3.org/1999/xhtml" style="box-sizing:border-box;width:${bounds.w}px;min-height:${bounds.h}px;margin:${bleed}px;color:${escapeAttr(safeTextColor(shape.props.color))};font-size:${fontSize}pt;line-height:${TEXT_SHAPE_LINE_HEIGHT};overflow:visible;">`,
        html,
        "</div>",
      ].join(""),
      { overflowVisible: true },
    );
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  if (shape.type === "tableShape") {
    const overflow = getTableForeignObjectOverflow(shape.props.table);
    svg = foreignObject(
      shape.x - overflow,
      shape.y - overflow,
      shape.props.w + overflow * 2,
      shape.props.h + overflow * 2,
      renderers.renderTableHtml(
        shape.props.table,
        shape.props.w,
        shape.props.h,
        overflow,
      ),
    );
    return withShapeOpacity(shape, svg);
  }

  if (shape.type === "chartShape") {
    const sourceTable = shape.props.sourceTableShapeId
      ? tablesById.get(shape.props.sourceTableShapeId) ?? null
      : null;
    const data = resolveChartData(shape.props, sourceTable);
    svg = `<g transform="translate(${shape.x} ${shape.y})">${renderers.renderChartSvg(
      data,
      shape.props.spec,
      shape.props.w,
      shape.props.h,
    )}</g>`;
    return withShapeOpacity(shape, withShapeRotation(shape, svg));
  }

  return "";
}

function graph3DLabelsToSvg(
  shape: Extract<OverlayShape, { type: "graph3dShape" }>,
  renderers: OverlaySvgRenderers,
): string {
  const geometry = buildGraph3DSceneGeometry(shape.props.spec);
  const annotations = createGraph3DDisplayAnnotations(
    shape.props.spec,
    geometry.annotations,
    getGraph3DAxisColors(shape.props.spec.view),
  );
  const labelWidth = 112;
  const labelHeight = 40;
  return annotations.map((annotation) => {
    const point = projectGraph3DLabel(
      annotation.position,
      shape.props.spec.camera,
      shape.props.w,
      shape.props.h,
    );
    if (
      !point ||
      point.x < 0 || point.x > shape.props.w ||
      point.y < 0 || point.y > shape.props.h
    ) return "";
    const color = safeTextColor(annotation.color ?? "#1f2937");
    return foreignObject(
      shape.x + point.x - labelWidth / 2,
      shape.y + point.y - labelHeight / 2,
      labelWidth,
      labelHeight,
      [
        `<div xmlns="http://www.w3.org/1999/xhtml" data-graph3d-label="${escapeAttr(annotation.id)}" style="box-sizing:border-box;display:flex;align-items:center;justify-content:center;width:${labelWidth}px;height:${labelHeight}px;color:${escapeAttr(color)};font-size:13px;line-height:1.2;white-space:nowrap;">`,
        `<span style="padding:1px 4px;border-radius:3px;background:#ffffff;">${renderers.renderMathHtml(annotation.labelTex)}</span>`,
        "</div>",
      ].join(""),
      { overflowVisible: true },
    );
  }).join("");
}

function getRenderableImageHref(asset: OverlayAsset): string | null {
  if (asset.props.storage && asset.props.src.startsWith("sigma-doc-storage://")) {
    return null;
  }

  // 多層防御: 正規化境界を通らない asset を渡された場合でも、書き出した SVG (= 印刷 / PDF) に
  // ローカルファイルや外部 URL を書かない。**検証した文字列を返す** — 元の値を返すと、
  // `trim()` が落とす U+FEFF 等で「検証は data URL・ブラウザには相対 URL」のずれを作れる。
  return normalizeOverlayAssetSource(asset.props.src);
}

function withEffectiveOpacity(shape: OverlayShape, opacity: number | undefined): OverlayShape {
  if (opacity === undefined) {
    return shape;
  }
  return { ...shape, opacity } as OverlayShape;
}

function withShapeRotation(shape: OverlayShape, svg: string): string {
  const rotation = getShapeRotation(shape);
  if (!rotation && !shape.flipX && !shape.flipY) {
    return svg;
  }

  const pivot = getShapeRotationPivot(shape);
  const transforms = [
    rotation ? `rotate(${radiansToDegrees(rotation)} ${pivot.x} ${pivot.y})` : "",
    shape.flipX || shape.flipY
      ? `translate(${pivot.x} ${pivot.y}) scale(${shape.flipX ? -1 : 1} ${shape.flipY ? -1 : 1}) translate(${-pivot.x} ${-pivot.y})`
      : "",
  ].filter(Boolean).join(" ");
  return `<g transform="${transforms}">${svg}</g>`;
}

function withShapeOpacity(shape: OverlayShape, svg: string): string {
  if (shape.opacity === undefined || shape.opacity >= 1) {
    return svg;
  }

  return `<g opacity="${shape.opacity}">${svg}</g>`;
}

function withShapeLabel(shape: Extract<OverlayShape, { type: "geo" }>, svg: string): string {
  if (!shape.props.label) {
    return svg;
  }

  return [
    svg,
    `<text x="${shape.x + shape.props.w / 2}" y="${shape.y + shape.props.h / 2}" fill="${escapeAttr(shape.props.labelColor)}" stroke="none" text-anchor="middle" dominant-baseline="middle" font-size="${overlayLabelFontSize(shape.props.size)}">${escapeHtml(shape.props.label)}</text>`,
  ].join("");
}

/**
 * The caption reads the same anchor the editor canvas draws it at. This used to place an arrow's
 * caption with `getLineMidpoint([start, end])` — `points[1]`, so on the arrow's tip — which is not
 * where the canvas puts it; exported and printed arrows now match what the author saw.
 */
function withLineLabel(
  shape: Extract<OverlayShape, { type: "arrow" | "line" }>,
  svg: string,
): string {
  const placement = getShapeLabelPlacement(shape);
  if (!placement) {
    return svg;
  }

  return [
    svg,
    `<text x="${placement.anchor.x}" y="${placement.anchor.y}" fill="${escapeAttr(shape.props.labelColor ?? shape.props.color)}" stroke="none" text-anchor="middle" font-size="${placement.fontSizePx}">${escapeHtml(placement.text)}</text>`,
  ].join("");
}

/**
 * The `<marker>` declarations for one shape's endpoints, as a string.
 *
 * The geometry, the ids and the `orient` all come from `ARROWHEAD_MARKER_SPECS`, the same table the
 * editor canvas reads, so the exported SVG matches what the user sees.
 */
function getArrowMarkerDefs(
  shapeId: OverlayShapeId,
  color: string,
  opacity: number | undefined,
  plan: ArrowheadEndpointPlan,
): string {
  const escapedColor = escapeAttr(color);
  const paintOpacity = opacityAttr("opacity", opacity);
  return getArrowheadMarkerRequests(shapeId, plan).map(({ spec, endpoint, id, refX }) => {
    const content = spec.geometry.kind === "circle"
      ? `<circle cx="${spec.geometry.cx}" cy="${spec.geometry.cy}" r="${spec.geometry.r}" fill="${spec.geometry.filled ? escapedColor : "none"}"${paintOpacity} />`
      : spec.geometry.filled
        ? `<path d="${arrowheadPathData(spec.geometry)}" fill="${escapedColor}" stroke="none"${paintOpacity} />`
        : `<path d="${arrowheadPathData(spec.geometry)}" fill="none" stroke="${escapedColor}" stroke-width="${spec.geometry.strokeWidth}" ${SHARP_STROKE_ATTRS}${paintOpacity} />`;
    return `<marker id="${escapeAttr(id)}" markerWidth="${spec.markerWidth}" markerHeight="${spec.markerHeight}" refX="${refX}" refY="${spec.refY}" orient="${arrowheadOrient(spec, endpoint)}" markerUnits="strokeWidth">${content}</marker>`;
  }).join("");
}

function lineFillPatternId(shapeId: OverlayShapeId): string {
  return `fill-${shapeId}`;
}

function getLineFillPatternDefs(shape: Extract<OverlayShape, { type: "line" }>): string {
  if (shape.props.fillPattern !== "diagonalHatch") {
    return "";
  }
  const id = escapeAttr(lineFillPatternId(shape.id));
  const background = escapeAttr(shape.props.fillColor ?? "#ffffff");
  const stroke = escapeAttr(shape.props.color);
  return `<pattern id="${id}" patternUnits="userSpaceOnUse" width="6" height="6"><rect width="6" height="6" fill="${background}" /><path d="M -1 7 L 7 -1" stroke="${stroke}" stroke-width="1" /></pattern>`;
}

function markerAttr(name: string, shapeId: OverlayShapeId, endpoint: "start" | "end", head: OverlayArrowhead | undefined): string {
  const id = arrowheadMarkerId(head, shapeId, endpoint);
  if (!id) {
    return "";
  }

  return ` ${name}="url(#${escapeAttr(id)})"`;
}

function dashAttr(dash: OverlayDash): string {
  if (dash === "dashed") {
    return ' stroke-dasharray="8 6"';
  }
  if (dash === "dotted") {
    return ' stroke-dasharray="1 6"';
  }
  return "";
}

function opacityAttr(name: "fill-opacity" | "opacity" | "stroke-opacity", opacity: number | undefined): string {
  if (opacity === undefined || opacity >= 1) {
    return "";
  }
  return ` ${name}="${Math.max(0, opacity)}"`;
}

function getGeoPolygonPoints(
  geo: "triangle" | "diamond" | "pentagon" | "regularPolygon" | "blockArrow",
  width: number,
  height: number,
  apexX?: number,
  headLengthRatio?: number,
  shaftRatio?: number,
  polygonSides?: OverlayRegularPolygonSides,
): OverlayPoint[] {
  if (geo === "blockArrow") {
    return getBlockArrowPolygonPoints(width, height, headLengthRatio, shaftRatio);
  }

  if (geo === "triangle") {
    return [
      { x: clamp(apexX ?? width / 2, 0, width), y: 0 },
      { x: width, y: height },
      { x: 0, y: height },
    ];
  }

  if (geo === "diamond") {
    return [
      { x: width / 2, y: 0 },
      { x: width, y: height / 2 },
      { x: width / 2, y: height },
      { x: 0, y: height / 2 },
    ];
  }

  return getRegularPolygonPoints(
    width,
    height,
    geo === "pentagon" ? 5 : normalizeRegularPolygonSides(polygonSides),
  );
}

function getArcPath(shape: Extract<OverlayShape, { type: "arc" }>): string {
  const { rx, ry } = getArcRadii(shape);
  // Shared with the canvas renderer through `getArcDrawnAngles`: the two `getArcPath` copies have
  // drifted before, and the angles are the only part of them this feature changes.
  const drawn = getArcDrawnAngles(shape);
  const start = getArcEndpoint(shape, drawn.startAngle);
  const end = getArcEndpoint(shape, drawn.endAngle);
  const sweep = normalizePositiveAngle(drawn.endAngle - drawn.startAngle);
  const largeArcFlag = sweep > Math.PI ? 1 : 0;
  if (shape.props.kind === "sector") {
    return `M ${shape.x + rx} ${shape.y + ry} L ${shape.x + start.x} ${shape.y + start.y} A ${rx} ${ry} 0 ${largeArcFlag} 1 ${shape.x + end.x} ${shape.y + end.y} Z`;
  }
  return `M ${shape.x + start.x} ${shape.y + start.y} A ${rx} ${ry} 0 ${largeArcFlag} 1 ${shape.x + end.x} ${shape.y + end.y}`;
}

function getArcFill(shape: Extract<OverlayShape, { type: "arc" }>): string {
  if (shape.props.kind !== "sector" || shape.props.fill === "none") {
    return "none";
  }
  return escapeAttr(shape.props.fillColor ?? shape.props.color);
}

function getArcEndpoint(shape: Extract<OverlayShape, { type: "arc" }>, angle: number): OverlayPoint {
  const { rx, ry } = getArcRadii(shape);
  return {
    x: rx + Math.cos(angle) * rx,
    y: ry + Math.sin(angle) * ry,
  };
}

function absolutePolygonPoints(points: OverlayPoint[], x: number, y: number): string {
  return points.map((point) => `${x + point.x},${y + point.y}`).join(" ");
}

function radiansToDegrees(rotation: number): number {
  return Math.round((rotation * 180 / Math.PI) * 1_000_000) / 1_000_000;
}

function foreignObject(
  x: number,
  y: number,
  width: number,
  height: number,
  html: string,
  options: { overflowVisible?: boolean } = {},
): string {
  const overflow = options.overflowVisible ? ' overflow="visible"' : "";
  return `<foreignObject x="${x}" y="${y}" width="${width}" height="${height}"${overflow}>${html}</foreignObject>`;
}

function getTableForeignObjectOverflow(table: SigmaTableSpec): number {
  let maxBorderWidth = 0;

  for (let index = 0; index <= table.columns.length; index += 1) {
    const key = getTableVerticalLineKey(table, index);
    if (!key) {
      continue;
    }
    const border = resolveTableLineBorder(table, key);
    if (border.visible) {
      maxBorderWidth = Math.max(maxBorderWidth, border.borderWidth);
    }
  }

  for (let index = 0; index <= table.rows.length; index += 1) {
    const key = getTableHorizontalLineKey(table, index);
    if (!key) {
      continue;
    }
    const border = resolveTableLineBorder(table, key);
    if (border.visible) {
      maxBorderWidth = Math.max(maxBorderWidth, border.borderWidth);
    }
  }

  return Math.ceil(maxBorderWidth);
}
