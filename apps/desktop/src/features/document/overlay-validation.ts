import { isGraphParameter } from "./graph-parameter-validation";
import { isGraphFillPattern } from "./graph-fill-style";
import { isGraph3DSpec } from "./graph3d-validation";
import { OVERLAY_ARROWHEADS } from "./overlay-model";
import type { InlineNode } from "./model";
import type {
  OverlayAnchor,
  OverlayArrowhead,
  OverlayAsset,
  OverlayDash,
  OverlayExtensions,
  SigmaTableCellStyle,
  OverlayShape,
  OverlaySnapshot,
  OverlayStackLayer,
  OverlayTextBlock,
  OverlayTextSize,
} from "./overlay-model";

export { isGraph3DSpec };

export function isValidOverlaySnapshot(snapshot: unknown): snapshot is OverlaySnapshot {
  if (!isBaseOverlaySnapshot(snapshot)) {
    return false;
  }

  return snapshot.shapes.every(isOverlayShape) &&
    Object.values(snapshot.assets).every(isOverlayAsset) &&
    (snapshot.extensions === undefined || isOverlayExtensions(snapshot.extensions));
}

export function isBaseOverlaySnapshot(value: unknown): value is {
  version: 1;
  shapes: unknown[];
  assets: Record<string, unknown>;
  extensions?: unknown;
} {
  return isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.shapes) &&
    isRecord(value.assets);
}

export function isOverlayExtensions(value: unknown): value is OverlayExtensions {
  return isRecord(value) &&
    Object.keys(value).every(isOverlayExtensionNamespace) &&
    Object.values(value).every(isOverlayExtensionValue);
}

export function isOverlayTextBlocks(value: unknown): value is OverlayTextBlock[] {
  return Array.isArray(value) && value.every(isOverlayTextBlock);
}

export function isOverlayShape(value: unknown): value is OverlayShape {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    !isFiniteNumber(value.x) ||
    !isFiniteNumber(value.y) ||
    (value.rotation !== undefined && !isFiniteNumber(value.rotation)) ||
    (value.flipX !== undefined && typeof value.flipX !== "boolean") ||
    (value.flipY !== undefined && typeof value.flipY !== "boolean") ||
    (value.parentId !== undefined && typeof value.parentId !== "string") ||
    (value.groupId !== undefined && typeof value.groupId !== "string") ||
    (value.stackLayer !== undefined && !isOverlayStackLayer(value.stackLayer)) ||
    (value.locked !== undefined && typeof value.locked !== "boolean") ||
    (value.hidden !== undefined && typeof value.hidden !== "boolean") ||
    (value.opacity !== undefined && (!isFiniteNumber(value.opacity) || value.opacity < 0 || value.opacity > 1)) ||
    (value.anchor !== undefined && !isOverlayAnchor(value.anchor)) ||
    !isRecord(value.props)
  ) {
    return false;
  }

  switch (value.type) {
    case "group":
      return hasBox(value.props) &&
        (value.props.name === undefined || typeof value.props.name === "string");
    case "geo":
      return hasBox(value.props) &&
        (
          value.props.geo === "rectangle" ||
          value.props.geo === "ellipse" ||
          value.props.geo === "triangle" ||
          value.props.geo === "diamond" ||
          value.props.geo === "pentagon" ||
          value.props.geo === "regularPolygon" ||
          value.props.geo === "blockArrow"
        ) &&
        (value.props.geo !== "regularPolygon" || (
          isFiniteNumber(value.props.polygonSides) &&
          Number.isInteger(value.props.polygonSides) &&
          value.props.polygonSides >= 5 &&
          value.props.polygonSides <= 12
        )) &&
        (value.props.apexX === undefined || isFiniteNumber(value.props.apexX)) &&
        (value.props.headLengthRatio === undefined || (isFiniteNumber(value.props.headLengthRatio) && value.props.headLengthRatio > 0 && value.props.headLengthRatio < 1)) &&
        (value.props.shaftRatio === undefined || (isFiniteNumber(value.props.shaftRatio) && value.props.shaftRatio > 0 && value.props.shaftRatio <= 1)) &&
        (value.props.radius === undefined || (isFiniteNumber(value.props.radius) && value.props.radius >= 0)) &&
        (value.props.fill === "none" || value.props.fill === "solid") &&
        typeof value.props.color === "string" &&
        (value.props.fillColor === undefined || typeof value.props.fillColor === "string") &&
        (value.props.strokeOpacity === undefined || (isFiniteNumber(value.props.strokeOpacity) && value.props.strokeOpacity >= 0 && value.props.strokeOpacity <= 1)) &&
        (value.props.fillOpacity === undefined || (isFiniteNumber(value.props.fillOpacity) && value.props.fillOpacity >= 0 && value.props.fillOpacity <= 1)) &&
        typeof value.props.labelColor === "string" &&
        isOverlayDash(value.props.dash) &&
        isOverlayTextSize(value.props.size) &&
        (value.props.label === undefined || typeof value.props.label === "string");
    case "arc":
      return (value.props.kind === undefined || value.props.kind === "arc" || value.props.kind === "sector") &&
        isFiniteNumber(value.props.r) &&
        value.props.r > 0 &&
        (value.props.rx === undefined || (isFiniteNumber(value.props.rx) && value.props.rx > 0)) &&
        (value.props.ry === undefined || (isFiniteNumber(value.props.ry) && value.props.ry > 0)) &&
        isFiniteNumber(value.props.startAngle) &&
        isFiniteNumber(value.props.endAngle) &&
        (value.props.arrowheadStart === undefined || isOverlayArrowhead(value.props.arrowheadStart)) &&
        (value.props.arrowheadEnd === undefined || isOverlayArrowhead(value.props.arrowheadEnd)) &&
        (value.props.fill === undefined || value.props.fill === "none" || value.props.fill === "solid") &&
        (value.props.fillColor === undefined || typeof value.props.fillColor === "string") &&
        (value.props.fillOpacity === undefined || (isFiniteNumber(value.props.fillOpacity) && value.props.fillOpacity >= 0 && value.props.fillOpacity <= 1)) &&
        (value.props.fillPattern === undefined || value.props.fillPattern === "diagonalHatch") &&
        typeof value.props.color === "string" &&
        (value.props.strokeOpacity === undefined || (isFiniteNumber(value.props.strokeOpacity) && value.props.strokeOpacity >= 0 && value.props.strokeOpacity <= 1)) &&
        isOverlayDash(value.props.dash) &&
        isOverlayTextSize(value.props.size);
    case "arrow":
      return isOverlayPoint(value.props.start) &&
        isOverlayPoint(value.props.end) &&
        (value.props.arrowheadStart === undefined || isOverlayArrowhead(value.props.arrowheadStart)) &&
        isOverlayArrowhead(value.props.arrowheadEnd) &&
        value.props.fill === "none" &&
        typeof value.props.color === "string" &&
        (value.props.strokeOpacity === undefined || (isFiniteNumber(value.props.strokeOpacity) && value.props.strokeOpacity >= 0 && value.props.strokeOpacity <= 1)) &&
        typeof value.props.labelColor === "string" &&
        isOverlayDash(value.props.dash) &&
        isOverlayTextSize(value.props.size) &&
        (value.props.label === undefined || typeof value.props.label === "string");
    case "line":
      return Array.isArray(value.props.points) &&
        value.props.points.length > 0 &&
        value.props.points.every(isOverlayPoint) &&
        (value.props.kind === undefined || isOverlayLineKind(value.props.kind)) &&
        typeof value.props.closed === "boolean" &&
        (value.props.arrowheadStart === undefined || isOverlayArrowhead(value.props.arrowheadStart)) &&
        (value.props.arrowheadEnd === undefined || isOverlayArrowhead(value.props.arrowheadEnd)) &&
        (value.props.fill === undefined || value.props.fill === "none" || value.props.fill === "solid") &&
        (value.props.fillColor === undefined || typeof value.props.fillColor === "string") &&
        (value.props.fillOpacity === undefined || (isFiniteNumber(value.props.fillOpacity) && value.props.fillOpacity >= 0 && value.props.fillOpacity <= 1)) &&
        typeof value.props.color === "string" &&
        (value.props.strokeOpacity === undefined || (isFiniteNumber(value.props.strokeOpacity) && value.props.strokeOpacity >= 0 && value.props.strokeOpacity <= 1)) &&
        isOverlayDash(value.props.dash) &&
        isOverlayTextSize(value.props.size) &&
        (value.props.labelColor === undefined || typeof value.props.labelColor === "string") &&
        (value.props.label === undefined || typeof value.props.label === "string");
    case "text":
      return isFiniteNumber(value.props.w) &&
        isFiniteNumber(value.props.h) &&
        value.props.h > 0 &&
        isOverlayTextBlocks(value.props.blocks) &&
        typeof value.props.color === "string" &&
        (value.props.fontSize === undefined || (isFiniteNumber(value.props.fontSize) && value.props.fontSize > 0)) &&
        isOverlayTextSize(value.props.size);
    case "image":
      return typeof value.props.assetId === "string" &&
        hasBox(value.props) &&
        (value.props.crop === undefined || isOverlayImageCrop(value.props.crop));
    case "callout":
      return hasBox(value.props) &&
        isFiniteNumber(value.props.radius) &&
        value.props.radius >= 0 &&
        isRecord(value.props.tail) &&
        isOverlayPoint(value.props.tail.baseStart) &&
        isOverlayPoint(value.props.tail.baseEnd) &&
        isOverlayPoint(value.props.tail.tip) &&
        isOverlayTextBlocks(value.props.blocks) &&
        typeof value.props.color === "string" &&
        (value.props.fontSize === undefined || (isFiniteNumber(value.props.fontSize) && value.props.fontSize > 0)) &&
        isOverlayTextSize(value.props.size) &&
        isOverlayDash(value.props.dash) &&
        isOverlayTextSize(value.props.strokeWidth);
    case "graph2dShape":
      return hasBox(value.props) &&
        isGraph2DSpec(value.props.spec) &&
        (value.props.boundsMode === undefined || value.props.boundsMode === "plot") &&
        (value.props.preserveSpecSize === undefined || typeof value.props.preserveSpecSize === "boolean") &&
        (value.props.axisLabelTextShapeIds === undefined || (
          isRecord(value.props.axisLabelTextShapeIds) &&
          Object.entries(value.props.axisLabelTextShapeIds).every(([key, id]) => isGraphAxisLabelKey(key) && typeof id === "string")
        )) &&
        (value.props.pointLabelTextShapeIdsByPointId === undefined || (
          isRecord(value.props.pointLabelTextShapeIdsByPointId) &&
          Object.values(value.props.pointLabelTextShapeIdsByPointId).every((id) => typeof id === "string")
        )) &&
        (value.props.annotationTextShapeIdsByAnnotationId === undefined || (
          isRecord(value.props.annotationTextShapeIdsByAnnotationId) &&
          Object.values(value.props.annotationTextShapeIdsByAnnotationId).every((id) => typeof id === "string")
        )) &&
        (value.props.labelTextShapeIds === undefined || (
          Array.isArray(value.props.labelTextShapeIds) &&
          value.props.labelTextShapeIds.every((id) => typeof id === "string")
        )) &&
        (value.props.labelTextShapeIdsByCurveId === undefined || (
          isRecord(value.props.labelTextShapeIdsByCurveId) &&
          Object.values(value.props.labelTextShapeIdsByCurveId).every((id) => typeof id === "string")
        ));
    case "graph3dShape":
      return hasBox(value.props) &&
        value.props.w > 0 &&
        value.props.h > 0 &&
        isGraph3DSpec(value.props.spec) &&
        (value.props.previewAssetId === undefined || typeof value.props.previewAssetId === "string") &&
        (value.props.previewSourceHash === undefined || typeof value.props.previewSourceHash === "string");
    case "tableShape":
      return hasBox(value.props) && isTableSpec(value.props.table);
    case "chartShape":
      return hasBox(value.props) &&
        isChartSpec(value.props.spec) &&
        isChartData(value.props.dataSnapshot) &&
        (value.props.sourceTableShapeId === undefined || typeof value.props.sourceTableShapeId === "string");
    default:
      return false;
  }
}

export function isOverlayAsset(value: unknown): value is OverlayAsset {
  return isRecord(value) &&
    typeof value.id === "string" &&
    value.type === "image" &&
    isRecord(value.props) &&
    isFiniteNumber(value.props.w) &&
    isFiniteNumber(value.props.h) &&
    typeof value.props.name === "string" &&
    typeof value.props.isAnimated === "boolean" &&
    (typeof value.props.mimeType === "string" || value.props.mimeType === null) &&
    typeof value.props.src === "string" &&
    isFiniteNumber(value.props.fileSize) &&
    (value.props.storage === undefined || isOverlayStorageAssetRef(value.props.storage));
}

function isOverlayExtensionNamespace(value: string): boolean {
  return /^[a-z][a-z0-9]*(?:[.-][a-z][a-z0-9]*)+$/.test(value);
}

function isOverlayExtensionValue(value: unknown): boolean {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return true;
  }
  if (typeof value === "number") {
    return Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.every(isOverlayExtensionValue);
  }
  return isRecord(value) && Object.values(value).every(isOverlayExtensionValue);
}

function isOverlayStorageAssetRef(value: unknown): boolean {
  return isRecord(value) &&
    value.kind === "remote-asset" &&
    typeof value.storageKey === "string" &&
    typeof value.assetId === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * One block of an overlay text shape. Structurally identical to the body's `RichBlock`, so a
 * paragraph copied out of the body is a valid shape block and vice versa — including the `id`
 * every body block carries (the Tiptap round trip keys block identity on it, and a list item
 * without one cannot be tracked across an edit).
 */
export function isOverlayTextBlock(value: unknown): value is OverlayTextBlock {
  if (
    !isRecord(value) ||
    !isBlockId(value.id) ||
    !isOptionalBlockSpaceAfterPx(value.spaceAfterPx)
  ) {
    return false;
  }

  if (value.type === "list") {
    return isOverlayTextListBody(value);
  }

  // A rule has nothing else to check; a quote is checked through what it holds, and a code block
  // holds one run of source with an optional language and theme.
  if (value.type === "divider") {
    return true;
  }

  if (value.type === "quote") {
    return Array.isArray(value.blocks) && value.blocks.every((child) => (
      isRecord(child) && child.type !== "quote" && isOverlayTextBlock(child)
    ));
  }

  if (value.type === "codeBlock") {
    // `language` and `theme` are colour hints, and every renderer re-reads them at draw time, so a
    // value nothing recognises is harmless there. It is not harmless *here*: this predicate is
    // what the persisted schema delegates to, and letting an arbitrary object through would put a
    // key in the file that the canonical form does not name.
    return Array.isArray(value.children) &&
      value.children.every(isInlineNode) &&
      (value.language === undefined || typeof value.language === "string") &&
      (value.theme === undefined || typeof value.theme === "string");
  }

  return isOverlayTextProseBody(value);
}

function isOverlayTextListBody(value: Record<string, unknown>): boolean {
  return (value.listType === "bullet" || value.listType === "ordered") &&
    (value.start === undefined || isPositiveInteger(value.start)) &&
    (value.markerStyle === undefined || value.markerStyle === "decimal" || value.markerStyle === "paren") &&
    Array.isArray(value.items) &&
    value.items.every(isOverlayTextListItem);
}

function isOverlayTextListItem(value: unknown): boolean {
  return isRecord(value) &&
    value.type === "listItem" &&
    isBlockId(value.id) &&
    Array.isArray(value.children) &&
    value.children.every(isInlineNode) &&
    (value.align === undefined || isTextAlign(value.align)) &&
    (value.continuations === undefined || (
      Array.isArray(value.continuations) &&
      value.continuations.every(isOverlayTextContinuation)
    )) &&
    (value.nested === undefined || (
      Array.isArray(value.nested) &&
      value.nested.every((nested) => isRecord(nested) && nested.type === "list" && isOverlayTextBlock(nested))
    ));
}

/** A block that stays under the same list marker: prose, or the one block with no prose at all. */
function isOverlayTextContinuation(value: unknown): boolean {
  if (!isRecord(value) || !isBlockId(value.id) || !isOptionalBlockSpaceAfterPx(value.spaceAfterPx)) {
    return false;
  }
  return value.type === "divider" || isOverlayTextProseBody(value);
}

function isOverlayTextProseBody(value: Record<string, unknown>): boolean {
  if (
    (value.type !== "paragraph" && value.type !== "heading") ||
    !Array.isArray(value.children) ||
    !value.children.every(isInlineNode) ||
    (value.align !== undefined && !isTextAlign(value.align)) ||
    (value.lineHeight !== undefined && !isLineHeight(value.lineHeight))
  ) {
    return false;
  }

  return value.type !== "heading" ||
    value.level === 1 ||
    value.level === 2 ||
    value.level === 3;
}

function isBlockId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * As lenient as the body's own schema, which takes any number and normalizes it
 * (`normalizeBlockSpaceAfterPx`) rather than refusing the block. This is a gate, not a
 * transformer — a block copied out of the body carrying `12.5` here must not make the whole
 * document unopenable; `canonicalizeOverlayTextBlock` rounds and clamps it on the way in.
 */
function isOptionalBlockSpaceAfterPx(value: unknown): boolean {
  return value === undefined || isFiniteNumber(value);
}

function isLineHeight(value: unknown): boolean {
  if (typeof value !== "string" || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/u.test(value)) {
    return false;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0.8 && numeric <= 3;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function hasBox(value: Record<string, unknown>): value is Record<string, unknown> & { w: number; h: number } {
  return isFiniteNumber(value.w) && isFiniteNumber(value.h);
}

function isOverlayPoint(value: unknown): value is { x: number; y: number } {
  return isRecord(value) && isFiniteNumber(value.x) && isFiniteNumber(value.y);
}

function isOverlayImageCrop(value: unknown): boolean {
  return isRecord(value) &&
    isOverlayPoint(value.topLeft) &&
    isOverlayPoint(value.bottomRight) &&
    value.topLeft.x >= 0 &&
    value.topLeft.x <= 1 &&
    value.topLeft.y >= 0 &&
    value.topLeft.y <= 1 &&
    value.bottomRight.x >= 0 &&
    value.bottomRight.x <= 1 &&
    value.bottomRight.y >= 0 &&
    value.bottomRight.y <= 1 &&
    value.bottomRight.x > value.topLeft.x &&
    value.bottomRight.y > value.topLeft.y;
}

function isOverlayTextSize(value: unknown): value is OverlayTextSize {
  return value === "s" || value === "m" || value === "l" || value === "xl";
}

function isOverlayStackLayer(value: unknown): value is OverlayStackLayer {
  return value === "foreground" || value === "background";
}

function isOverlayDash(value: unknown): value is OverlayDash {
  return value === "solid" || value === "dashed" || value === "dotted";
}

function isOverlayArrowhead(value: unknown): value is OverlayArrowhead {
  return typeof value === "string" && (OVERLAY_ARROWHEADS as readonly string[]).includes(value);
}

function isOverlayLineKind(value: unknown): boolean {
  return value === "polyline" || value === "curve" || value === "freehand";
}

function isOverlayAnchor(value: unknown): value is OverlayAnchor {
  if (!isRecord(value)) {
    return false;
  }
  if (value.type === "page") {
    return true;
  }
  if (value.type === "shape") {
    return typeof value.shapeId === "string" &&
      isFiniteNumber(value.dx) &&
      isFiniteNumber(value.dy) &&
      (value.rx === undefined || isFiniteNumber(value.rx)) &&
      (value.ry === undefined || isFiniteNumber(value.ry));
  }
  return value.type === "block" &&
    typeof value.blockId === "string" &&
    isFiniteNumber(value.dy) &&
    (value.dx === undefined || isFiniteNumber(value.dx)) &&
    (value.reserveSpace === undefined || typeof value.reserveSpace === "boolean") &&
    (value.line === undefined || isOverlayLineAnchor(value.line));
}

function isOverlayLineAnchor(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    isFiniteNumber(value.dy);
}

function isGraphAxisLabelKey(value: string): boolean {
  return value === "x" || value === "y" || value === "origin";
}

function isGraph2DSpec(value: unknown): boolean {
  if (!isRecord(value) || (value.kind !== "cartesian" && value.kind !== "numberLine")) {
    return false;
  }

  return typeof value.title === "string" &&
    isFiniteNumber(value.width) &&
    isFiniteNumber(value.height) &&
    isGraphViewBox(value.viewBox) &&
    (value.graphViewBox === undefined || isGraphViewBox(value.graphViewBox)) &&
    isRecord(value.axes) &&
    typeof value.axes.grid === "boolean" &&
    Array.isArray(value.curves) &&
    value.curves.every(isGraphCurve) &&
    (value.parameters === undefined || (Array.isArray(value.parameters) && value.parameters.every(isGraphParameter))) &&
    (value.points === undefined || (Array.isArray(value.points) && value.points.every(isGraphPoint))) &&
    (value.annotations === undefined || Array.isArray(value.annotations)) &&
    (value.fills === undefined || (Array.isArray(value.fills) && value.fills.every(isGraphFillRegion))) &&
    (value.showFormulaLabels === undefined || typeof value.showFormulaLabels === "boolean");
}

function isGraphCurve(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.expr === "string" &&
    (value.yExpr === undefined || typeof value.yExpr === "string") &&
    typeof value.color === "string" &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.mode === undefined ||
      value.mode === "yOfX" ||
      value.mode === "xOfY" ||
      value.mode === "parametric" ||
      value.mode === "implicit") &&
    (value.dash === undefined || value.dash === "solid" || value.dash === "dashed" || value.dash === "dotted") &&
    (value.strokeWidth === undefined || isFiniteNumber(value.strokeWidth)) &&
    (value.domain === undefined || (
      isRecord(value.domain) &&
      (value.domain.min === undefined || typeof value.domain.min === "string") &&
      (value.domain.max === undefined || typeof value.domain.max === "string")
    ));
}

function isGraphViewBox(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.xMin === "string" &&
    typeof value.xMax === "string" &&
    typeof value.yMin === "string" &&
    typeof value.yMax === "string";
}

function isGraphPoint(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.fill === undefined || value.fill === "solid" || value.fill === "none") &&
    (value.radius === undefined || isFiniteNumber(value.radius)) &&
    (value.label === undefined || typeof value.label === "string") &&
    (value.showXProjection === undefined || typeof value.showXProjection === "boolean") &&
    (value.showYProjection === undefined || typeof value.showYProjection === "boolean");
}

function isGraphFillRegion(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.x === "string" &&
    typeof value.y === "string" &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.pattern === undefined || isGraphFillPattern(value.pattern)) &&
    (value.opacity === undefined || (isFiniteNumber(value.opacity) && value.opacity >= 0 && value.opacity <= 1));
}

function isChartSpec(value: unknown): boolean {
  return isRecord(value) &&
    value.version === 1 &&
    (value.kind === "bar" || value.kind === "line" || value.kind === "pie" || value.kind === "scatter") &&
    (value.orientation === "columns" || value.orientation === "rows") &&
    typeof value.headerRow === "boolean" &&
    typeof value.labelColumn === "boolean" &&
    typeof value.legend === "boolean" &&
    (value.title === undefined || typeof value.title === "string") &&
    isRecord(value.seriesColors) &&
    !Array.isArray(value.seriesColors) &&
    Object.values(value.seriesColors).every((color) => typeof color === "string");
}

/**
 * The three arrays are indexed together by every renderer, so their lengths are part of the shape's
 * contract rather than a renderer concern. `deriveChartData` always emits them in step; a snapshot
 * that is not costs the reader `labels[i]` for a value it is drawing, which surfaces as an undefined
 * category or a silently truncated series instead of a rejected document.
 */
function isChartData(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !Array.isArray(value.labels) ||
    !value.labels.every((label) => typeof label === "string") ||
    !Array.isArray(value.series) ||
    !value.series.every(isChartSeries) ||
    (value.xValues !== undefined && !isChartValueList(value.xValues))
  ) {
    return false;
  }

  const length = value.labels.length;
  return value.series.every((series) => (series as { values: unknown[] }).values.length === length) &&
    (value.xValues === undefined || (value.xValues as unknown[]).length === length);
}

function isChartSeries(value: unknown): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isChartValueList(value.values);
}

/** A gap is `null`, never `NaN`: a chart draws a hole where a cell held no number. */
function isChartValueList(value: unknown): boolean {
  return Array.isArray(value) && value.every((entry) => entry === null || isFiniteNumber(entry));
}

function isTableSpec(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.kind !== "plain" && value.kind !== "variation") ||
    !Array.isArray(value.columns) ||
    !Array.isArray(value.rows) ||
    !Array.isArray(value.cells) ||
    !isRecord(value.grid) ||
    !isTableCellStyle(value.defaultCellStyle)
  ) {
    return false;
  }

  if (value.columns.length === 0 || value.rows.length === 0) {
    return false;
  }

  const columnIds = new Set<string>();
  for (const column of value.columns) {
    if (!isTableColumn(column) || columnIds.has(column.id)) {
      return false;
    }
    columnIds.add(column.id);
  }

  const rowIds = new Set<string>();
  for (const row of value.rows) {
    if (!isTableRow(row) || rowIds.has(row.id)) {
      return false;
    }
    rowIds.add(row.id);
  }

  if (!isTableGridStyle(value.grid, rowIds, columnIds)) {
    return false;
  }

  return value.cells.every((cell) => isTableCell(cell, rowIds, columnIds));
}

function isTableColumn(value: unknown): value is { id: string } {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isTableTrackSize(value.width) &&
    (
      value.role === undefined ||
      value.role === "label" ||
      value.role === "point" ||
      value.role === "interval" ||
      value.role === "value"
    );
}

function isTableRow(value: unknown): value is { id: string } {
  return isRecord(value) &&
    typeof value.id === "string" &&
    isTableTrackSize(value.height) &&
    (
      value.role === undefined ||
      value.role === "header" ||
      value.role === "body" ||
      value.role === "variable" ||
      value.role === "derivative" ||
      value.role === "variation" ||
      value.role === "note"
    );
}

function isTableTrackSize(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  if (value.mode === "fixed") {
    return isFiniteNumber(value.value) && value.value > 0;
  }

  if (value.mode === "auto") {
    return isOptionalPositiveNumber(value.min) && isOptionalPositiveNumber(value.max);
  }

  return value.mode === "fr" &&
    isFiniteNumber(value.value) &&
    value.value > 0 &&
    isOptionalPositiveNumber(value.min) &&
    isOptionalPositiveNumber(value.max);
}

function isTableCell(value: unknown, rowIds: Set<string>, columnIds: Set<string>): boolean {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.rowId === "string" &&
    typeof value.columnId === "string" &&
    rowIds.has(value.rowId) &&
    columnIds.has(value.columnId) &&
    (value.rowSpan === undefined || isPositiveInteger(value.rowSpan)) &&
    (value.colSpan === undefined || isPositiveInteger(value.colSpan)) &&
    Array.isArray(value.content) &&
    value.content.every(isTableCellContent) &&
    (value.style === undefined || isPartialTableCellStyle(value.style));
}

function isTableCellContent(value: unknown): boolean {
  if (!isRecord(value) || typeof value.id !== "string") {
    return false;
  }

  if (value.type === "paragraph") {
    return Array.isArray(value.children) &&
      value.children.every(isInlineNode) &&
      (value.align === undefined || isTextAlign(value.align));
  }

  return value.type === "trend" &&
    (
      value.direction === "up" ||
      value.direction === "down" ||
      value.direction === "flat"
    ) &&
    (value.label === undefined || (Array.isArray(value.label) && value.label.every(isInlineNode)));
}

function isInlineNode(value: unknown): value is InlineNode {
  if (!isRecord(value)) {
    return false;
  }

  if (value.type === "text") {
    return typeof value.text === "string" &&
      (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every(isTextMark))) &&
      (value.color === undefined || typeof value.color === "string") &&
      (value.backgroundColor === undefined || typeof value.backgroundColor === "string") &&
      (value.fontFamily === undefined || typeof value.fontFamily === "string") &&
      (value.fontSize === undefined || (isFiniteNumber(value.fontSize) && value.fontSize > 0)) &&
      (value.boxedPaddingY === undefined || (isFiniteNumber(value.boxedPaddingY) && value.boxedPaddingY >= 0)) &&
      isOptionalBoxStyle(value);
  }

  return value.type === "mathInline" &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    typeof value.tex === "string" &&
    value.display === "inline" &&
    (value.marks === undefined || (Array.isArray(value.marks) && value.marks.every(isMathInlineMark))) &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.backgroundColor === undefined || typeof value.backgroundColor === "string") &&
    (value.fontFamily === undefined || typeof value.fontFamily === "string") &&
    (value.fontSize === undefined || (isFiniteNumber(value.fontSize) && value.fontSize > 0)) &&
    (value.boxedPaddingY === undefined || (isFiniteNumber(value.boxedPaddingY) && value.boxedPaddingY >= 0)) &&
    (
      value.semanticRole === undefined ||
      value.semanticRole === "expression" ||
      value.semanticRole === "equation" ||
      value.semanticRole === "variable"
    ) &&
    (value.altText === undefined || typeof value.altText === "string") &&
    isOptionalBoxStyle(value);
}

function isTextMark(value: unknown): boolean {
  return value === "bold" || value === "italic" || value === "underline" || value === "boxed";
}

function isMathInlineMark(value: unknown): boolean {
  return value === "underline" || value === "boxed";
}

function isOptionalBoxStyle(value: Record<string, unknown>): boolean {
  return (value.boxedVariant === undefined ||
    value.boxedVariant === "frame" ||
    value.boxedVariant === "thick" ||
    value.boxedVariant === "double" ||
    value.boxedVariant === "oval" ||
    value.boxedVariant === "shade") &&
    (value.boxedTone === undefined ||
      value.boxedTone === "gray" ||
      value.boxedTone === "blue" ||
      value.boxedTone === "green" ||
      value.boxedTone === "red" ||
      value.boxedTone === "yellow");
}

function isTableGridStyle(value: unknown, rowIds: Set<string>, columnIds: Set<string>): boolean {
  return isRecord(value) &&
    typeof value.borderColor === "string" &&
    isFiniteNumber(value.borderWidth) &&
    value.borderWidth >= 0 &&
    (
      value.borderStyle === undefined ||
      value.borderStyle === "solid" ||
      value.borderStyle === "dashed" ||
      value.borderStyle === "dotted" ||
      value.borderStyle === "double"
    ) &&
    (value.showOuterBorder === undefined || typeof value.showOuterBorder === "boolean") &&
    (value.showInnerBorders === undefined || typeof value.showInnerBorders === "boolean") &&
    (
      value.lineOverrides === undefined ||
      (
        Array.isArray(value.lineOverrides) &&
        value.lineOverrides.every((override) => isTableGridLineOverride(override, rowIds, columnIds))
      )
    );
}

function isTableGridLineOverride(value: unknown, rowIds: Set<string>, columnIds: Set<string>): boolean {
  if (!isRecord(value) || !isTableGridLineStyle(value.style)) {
    return false;
  }

  if (value.axis === "vertical") {
    const hasEdge = "edge" in value;
    const hasBeforeColumnId = "beforeColumnId" in value;
    if (hasEdge === hasBeforeColumnId) {
      return false;
    }

    if (hasEdge) {
      return value.edge === "left" || value.edge === "right";
    }

    return typeof value.beforeColumnId === "string" && columnIds.has(value.beforeColumnId);
  }

  if (value.axis === "horizontal") {
    const hasEdge = "edge" in value;
    const hasBeforeRowId = "beforeRowId" in value;
    if (hasEdge === hasBeforeRowId) {
      return false;
    }

    if (hasEdge) {
      return value.edge === "top" || value.edge === "bottom";
    }

    return typeof value.beforeRowId === "string" && rowIds.has(value.beforeRowId);
  }

  return false;
}

function isTableGridLineStyle(value: unknown): boolean {
  return isRecord(value) &&
    (value.visible === undefined || typeof value.visible === "boolean") &&
    (value.borderColor === undefined || typeof value.borderColor === "string") &&
    (value.borderWidth === undefined || (isFiniteNumber(value.borderWidth) && value.borderWidth >= 0)) &&
    (
      value.borderStyle === undefined ||
      value.borderStyle === "solid" ||
      value.borderStyle === "dashed" ||
      value.borderStyle === "dotted" ||
      value.borderStyle === "double"
    );
}

function isTableCellStyle(value: unknown): value is SigmaTableCellStyle {
  return isRecord(value) &&
    (value.align === undefined || isTextAlign(value.align)) &&
    (value.verticalAlign === undefined || value.verticalAlign === "top" || value.verticalAlign === "middle" || value.verticalAlign === "bottom") &&
    isOptionalNonnegativeNumber(value.paddingX) &&
    isOptionalNonnegativeNumber(value.paddingY) &&
    (value.color === undefined || typeof value.color === "string") &&
    (value.backgroundColor === undefined || typeof value.backgroundColor === "string") &&
    (value.fontFamily === undefined || typeof value.fontFamily === "string") &&
    (value.fontSize === undefined || (isFiniteNumber(value.fontSize) && value.fontSize > 0)) &&
    (value.fontWeight === undefined || value.fontWeight === "normal" || value.fontWeight === "bold");
}

function isPartialTableCellStyle(value: unknown): boolean {
  return isTableCellStyle(value);
}

function isTextAlign(value: unknown): boolean {
  return value === "left" || value === "center" || value === "right" || value === "justify";
}

function isPositiveInteger(value: unknown): boolean {
  return Number.isInteger(value) && Number(value) > 0;
}

function isOptionalPositiveNumber(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && value > 0);
}

function isOptionalNonnegativeNumber(value: unknown): boolean {
  return value === undefined || (isFiniteNumber(value) && value >= 0);
}
