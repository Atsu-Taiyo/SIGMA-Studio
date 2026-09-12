import type {
  OverlayAsset,
  OverlayShape,
  OverlayShapeId,
  OverlayShapePatch,
  OverlaySnapshot,
  OverlayTextBlock,
} from "./overlay-model";
import type { InlineNode } from "./model";
import { normalizeBlockSpaceAfterPx } from "./application/block-space-after";
import { normalizeCodeBlockTheme } from "./model/blocks";
import { isAllowedOverlayAssetSource, normalizeOverlayAssetSource } from "./asset-source";
import { isSafeCssColor, isSafeCssFontFamily, SAFE_FALLBACK_COLOR } from "./css-safety";
import { normalizeOverlayGroups } from "./overlay-group-normalization";
import { migrateLegacyGraphShapeToPlotBounds } from "./overlay-graph-migration";
import {
  isBaseOverlaySnapshot,
  isOverlayAsset,
  isOverlayExtensions,
  isOverlayShape,
} from "./overlay-validation";

const LEGACY_OVERLAY_METADATA_EXTENSION = "sigma.legacy.metadata";
const SHAPE_KEYS = [
  "id", "type", "x", "y", "rotation", "flipX", "flipY", "parentId", "groupId", "stackLayer",
  "locked", "hidden", "opacity", "anchor", "props",
] as const;
const SHAPE_PROP_KEYS: Record<OverlayShape["type"], readonly string[]> = {
  group: ["w", "h", "name"],
  geo: ["w", "h", "geo", "polygonSides", "apexX", "headLengthRatio", "shaftRatio", "radius", "fill", "color", "fillColor", "strokeOpacity", "fillOpacity", "labelColor", "dash", "size", "label"],
  arc: ["kind", "r", "rx", "ry", "startAngle", "endAngle", "arrowheadStart", "arrowheadEnd", "fill", "fillColor", "fillOpacity", "fillPattern", "color", "strokeOpacity", "dash", "size"],
  arrow: ["start", "end", "arrowheadStart", "arrowheadEnd", "fill", "color", "strokeOpacity", "labelColor", "dash", "size", "label"],
  line: ["kind", "points", "closed", "arrowheadStart", "arrowheadEnd", "fill", "fillColor", "fillOpacity", "fillPattern", "color", "strokeOpacity", "labelColor", "dash", "size", "label"],
  text: ["w", "h", "blocks", "color", "fontSize", "size"],
  image: ["assetId", "w", "h", "crop"],
  callout: ["w", "h", "radius", "tail", "blocks", "color", "fontSize", "size", "dash", "strokeWidth"],
  graph2dShape: ["boundsMode", "w", "h", "spec", "preserveSpecSize", "axisLabelTextShapeIds", "pointLabelTextShapeIdsByPointId", "annotationTextShapeIdsByAnnotationId", "labelTextShapeIds", "labelTextShapeIdsByCurveId"],
  graph3dShape: ["w", "h", "spec", "previewAssetId", "previewSourceHash"],
  tableShape: ["w", "h", "table"],
  chartShape: ["w", "h", "spec", "sourceTableShapeId", "dataSnapshot"],
};

export function createEmptyOverlaySnapshot(): OverlaySnapshot {
  return {
    version: 1,
    shapes: [],
    assets: {},
  };
}

// SigmaDoc snapshots are immutable at the editor boundary. Preserve the
// normalized object for every repeated read of the same input reference.
const normalizedSnapshotCache = new WeakMap<object, OverlaySnapshot>();

export function normalizeOverlaySnapshot(snapshot: unknown): OverlaySnapshot {
  const cacheKey = typeof snapshot === "object" && snapshot !== null ? snapshot : null;
  const cached = cacheKey ? normalizedSnapshotCache.get(cacheKey) : undefined;
  if (cached) {
    return cached;
  }

  if (!isBaseOverlaySnapshot(snapshot)) {
    return createEmptyOverlaySnapshot();
  }

  const extensions = collectOverlayExtensions(snapshot);
  const validShapes = snapshot.shapes
    .filter(isOverlayShape)
    .map(canonicalizeOverlayShape);
  const normalized: OverlaySnapshot = {
    version: 1,
    shapes: normalizeOverlayGroups(normalizeGraphPlotBounds(validShapes)),
    assets: Object.fromEntries(
      Object.entries(snapshot.assets)
        .filter((entry): entry is [string, OverlayAsset] => isUsableOverlayAsset(entry[1]))
        .map(([key, asset]) => [key, canonicalizeOverlayAsset(asset)]),
    ),
    ...(extensions ? { extensions } : {}),
  };
  if (cacheKey) {
    normalizedSnapshotCache.set(cacheKey, normalized);
  }
  return normalized;
}

export interface OverlaySnapshotRecoveryIssue {
  kind: "shape" | "asset" | "snapshot";
  index?: number;
  key?: string;
  id?: string;
  type?: string;
}

/**
 * 読み込み専用の寛容な正規化。編集・保存時の厳格な型境界は維持したまま、
 * 壊れた図形や素材だけを除外して、ユーザーへ返す診断情報も生成する。
 */
export function recoverOverlaySnapshot(snapshot: unknown): {
  snapshot: OverlaySnapshot;
  issues: OverlaySnapshotRecoveryIssue[];
} {
  if (!isBaseOverlaySnapshot(snapshot)) {
    return {
      snapshot: createEmptyOverlaySnapshot(),
      issues: [{ kind: "snapshot" }],
    };
  }

  const issues: OverlaySnapshotRecoveryIssue[] = [];
  const validShapes = snapshot.shapes.flatMap((shape, index) => {
    if (isOverlayShape(shape)) {
      return [canonicalizeOverlayShape(shape)];
    }
    issues.push({
      kind: "shape",
      index,
      id: isRecord(shape) && typeof shape.id === "string" ? shape.id : undefined,
      type: isRecord(shape) && typeof shape.type === "string" ? shape.type : undefined,
    });
    return [];
  });
  const validAssets = Object.entries(snapshot.assets).flatMap(([key, asset]) => {
    if (isUsableOverlayAsset(asset)) {
      return [[key, canonicalizeOverlayAsset(asset)] as const];
    }
    issues.push({ kind: "asset", key });
    return [];
  });
  const extensions = collectOverlayExtensions(snapshot);

  return {
    snapshot: {
      version: 1,
      shapes: normalizeOverlayGroups(normalizeGraphPlotBounds(validShapes)),
      assets: Object.fromEntries(validAssets),
      ...(extensions ? { extensions } : {}),
    },
    issues,
  };
}

/**
 * Strict schema preprocessing: preserve validation failures, but canonicalize
 * valid snapshots so arbitrary metadata cannot cross the SigmaDoc boundary.
 */
export function prepareOverlaySnapshotForValidation(snapshot: unknown): unknown {
  if (
    !isBaseOverlaySnapshot(snapshot) ||
    !snapshot.shapes.every(isOverlayShape) ||
    // ここは「構造として読めるか」の門。許可外の `src` は下の再構築で **落とす** 対象なので、
    // ここで早期 return してしまうと素通しになる。
    !Object.values(snapshot.assets).every(isOverlayAsset) ||
    (snapshot.extensions !== undefined && !isOverlayExtensions(snapshot.extensions))
  ) {
    return snapshot;
  }
  const extensions = collectOverlayExtensions(snapshot);
  return {
    version: 1,
    shapes: snapshot.shapes.map(canonicalizeOverlayShape),
    assets: Object.fromEntries(
      Object.entries(snapshot.assets)
        .filter((entry): entry is [string, OverlayAsset] => isUsableOverlayAsset(entry[1]))
        .map(([key, asset]) => [key, canonicalizeOverlayAsset(asset)]),
    ),
    ...(extensions ? { extensions } : {}),
  } satisfies OverlaySnapshot;
}

export function upsertShape(
  shapes: OverlayShape[],
  shape: OverlayShape,
): OverlayShape[] {
  const index = shapes.findIndex((item) => item.id === shape.id);
  if (index === -1) {
    return [...shapes, shape];
  }

  const next = shapes.slice();
  next[index] = shape;
  return next;
}

export function patchShape(
  shapes: OverlayShape[],
  patch: OverlayShapePatch,
): OverlayShape[] {
  return shapes.map((shape) => {
    if (shape.id !== patch.id || shape.type !== patch.type) {
      return shape;
    }

    const next = {
      ...shape,
      ...patch,
      props: {
        ...shape.props,
        ...(patch.props ?? {}),
      },
    } as OverlayShape;

    return stripUndefinedShapeFields(next);
  });
}

export function removeShapes(
  shapes: OverlayShape[],
  ids: OverlayShapeId[],
): OverlayShape[] {
  const idSet = collectShapeAnchorRemovalIds(shapes, ids);
  return shapes.filter((shape) => !idSet.has(shape.id));
}

function collectShapeAnchorRemovalIds(
  shapes: OverlayShape[],
  ids: readonly OverlayShapeId[],
): Set<OverlayShapeId> {
  const idSet = new Set(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const shape of shapes) {
      if (
        idSet.has(shape.id) ||
        shape.anchor?.type !== "shape" ||
        !idSet.has(shape.anchor.shapeId)
      ) {
        continue;
      }

      idSet.add(shape.id);
      changed = true;
    }
  }
  return idSet;
}

function stripUndefinedShapeFields(shape: OverlayShape): OverlayShape {
  const next = { ...shape } as Record<string, unknown>;
  for (const key of [
    "parentId",
    "groupId",
    "stackLayer",
    "flipX",
    "flipY",
    "locked",
    "hidden",
    "opacity",
    "anchor",
  ]) {
    if (next[key] === undefined) {
      delete next[key];
    }
  }
  return next as unknown as OverlayShape;
}

/**
 * Colors and font families a shape carries, split by whether the model requires them.
 * Required props are replaced with {@link SAFE_FALLBACK_COLOR}; optional ones are deleted so the
 * renderers fall back to their own defaults, exactly as for a shape that never set them.
 */
const REQUIRED_SHAPE_COLOR_PROPS: Partial<Record<OverlayShape["type"], readonly string[]>> = {
  geo: ["color", "labelColor"],
  arc: ["color"],
  arrow: ["color", "labelColor"],
  line: ["color"],
  text: ["color"],
  callout: ["color"],
};

const OPTIONAL_SHAPE_COLOR_PROPS: Partial<Record<OverlayShape["type"], readonly string[]>> = {
  geo: ["fillColor"],
  arc: ["fillColor"],
  line: ["fillColor", "labelColor"],
};

/**
 * Rejected CSS scalars are neutralized here, at the document normalization boundary, rather than at
 * each serializer: `normalizeOverlaySnapshot` (drawing/export), `recoverOverlaySnapshot` (damaged
 * documents), and `prepareOverlaySnapshotForValidation` (the zod preprocess, so the cleaned value is
 * what gets persisted) all funnel through `canonicalizeOverlayShape`. Sitting inside it also places
 * this ahead of `normalizedSnapshotCache`, which is read and written around the call.
 *
 * An offending value costs its own attribute and nothing more — the shape itself, its geometry, and
 * every other prop survive. Dropping the shape (as a type-guard rejection in `overlay-validation.ts`
 * would) turns one bad string into a missing figure.
 */
function sanitizeShapeCssScalars(type: OverlayShape["type"], props: Record<string, unknown>): void {
  for (const key of REQUIRED_SHAPE_COLOR_PROPS[type] ?? []) {
    if (props[key] !== undefined && !isSafeCssColor(props[key])) {
      props[key] = SAFE_FALLBACK_COLOR;
    }
  }
  for (const key of OPTIONAL_SHAPE_COLOR_PROPS[type] ?? []) {
    if (props[key] !== undefined && !isSafeCssColor(props[key])) {
      delete props[key];
    }
  }
  if (type === "graph2dShape") {
    props.spec = sanitizeGraphSpecCssScalars(props.spec);
  } else if (type === "tableShape") {
    props.table = sanitizeTableCssScalars(props.table);
  } else if (type === "chartShape") {
    props.spec = sanitizeChartSpecCssScalars(props.spec);
  }
}

/**
 * A rejected series colour costs that one series its colour and nothing else — the renderer falls
 * back to the palette exactly as it does for a series nobody has recoloured.
 */
function sanitizeChartSpecCssScalars(spec: unknown): unknown {
  if (!isRecord(spec) || !isRecord(spec.seriesColors)) {
    return spec;
  }
  const seriesColors = withSanitizedColors(
    spec.seriesColors,
    Object.keys(spec.seriesColors),
  );
  return seriesColors === spec.seriesColors ? spec : { ...spec, seriesColors };
}

/** Copy-on-write: returns the same reference when no value had to change. */
function withSanitizedColors<T>(
  source: T,
  colorKeys: readonly string[],
  fontFamilyKeys: readonly string[] = [],
): T {
  if (!isRecord(source)) {
    return source;
  }
  let next: Record<string, unknown> | undefined;
  for (const key of colorKeys) {
    if (source[key] !== undefined && !isSafeCssColor(source[key])) {
      next ??= { ...source };
      delete next[key];
    }
  }
  for (const key of fontFamilyKeys) {
    if (source[key] !== undefined && !isSafeCssFontFamily(source[key])) {
      next ??= { ...source };
      delete next[key];
    }
  }
  return (next ?? source) as T;
}

/** Copy-on-write `map` that keeps the original array when every element is unchanged. */
function mapPreservingIdentity<T>(source: readonly T[], map: (item: T) => T): readonly T[] {
  let next: T[] | undefined;
  source.forEach((item, index) => {
    const mapped = map(item);
    if (mapped !== item) {
      next ??= [...source];
      next[index] = mapped;
    }
  });
  return next ?? source;
}

function sanitizeGraphSpecCssScalars(spec: unknown): unknown {
  if (!isRecord(spec)) {
    return spec;
  }
  const axes = withSanitizedColors(spec.axes, ["axisColor"]);
  const curves = Array.isArray(spec.curves)
    ? mapPreservingIdentity(spec.curves, (curve) => {
        if (!isRecord(curve) || curve.color === undefined || isSafeCssColor(curve.color)) {
          return curve;
        }
        // `color` is required on a curve, so it is replaced rather than deleted.
        return { ...curve, color: SAFE_FALLBACK_COLOR };
      })
    : spec.curves;
  const points = Array.isArray(spec.points)
    ? mapPreservingIdentity(spec.points, (point) => withSanitizedColors(point, ["color"]))
    : spec.points;
  const fills = Array.isArray(spec.fills)
    ? mapPreservingIdentity(spec.fills, (fill) => withSanitizedColors(fill, ["color"]))
    : spec.fills;
  return axes === spec.axes && curves === spec.curves && points === spec.points && fills === spec.fills
    ? spec
    : { ...spec, axes, curves, points, fills };
}

const TABLE_CELL_STYLE_COLOR_KEYS = ["color", "backgroundColor"] as const;
const TABLE_CELL_STYLE_FONT_KEYS = ["fontFamily"] as const;

function sanitizeTableCssScalars(table: unknown): unknown {
  if (!isRecord(table)) {
    return table;
  }
  const grid = sanitizeTableGridCssScalars(table.grid);
  const defaultCellStyle = withSanitizedColors(
    table.defaultCellStyle,
    TABLE_CELL_STYLE_COLOR_KEYS,
    TABLE_CELL_STYLE_FONT_KEYS,
  );
  const cells = Array.isArray(table.cells)
    ? mapPreservingIdentity(table.cells, sanitizeTableCellCssScalars)
    : table.cells;
  return grid === table.grid && defaultCellStyle === table.defaultCellStyle && cells === table.cells
    ? table
    : { ...table, grid, defaultCellStyle, cells };
}

function sanitizeTableGridCssScalars(grid: unknown): unknown {
  if (!isRecord(grid)) {
    return grid;
  }
  // `borderColor` is required on the grid, so it is replaced rather than deleted.
  const borderColor = grid.borderColor !== undefined && !isSafeCssColor(grid.borderColor)
    ? SAFE_FALLBACK_COLOR
    : grid.borderColor;
  const lineOverrides = Array.isArray(grid.lineOverrides)
    ? mapPreservingIdentity(grid.lineOverrides, (override) => {
        if (!isRecord(override)) {
          return override;
        }
        const style = withSanitizedColors(override.style, ["borderColor"]);
        return style === override.style ? override : { ...override, style };
      })
    : grid.lineOverrides;
  return borderColor === grid.borderColor && lineOverrides === grid.lineOverrides
    ? grid
    : { ...grid, borderColor, lineOverrides };
}

function sanitizeTableCellCssScalars(cell: unknown): unknown {
  if (!isRecord(cell)) {
    return cell;
  }
  const style = withSanitizedColors(
    cell.style,
    TABLE_CELL_STYLE_COLOR_KEYS,
    TABLE_CELL_STYLE_FONT_KEYS,
  );
  const content = Array.isArray(cell.content)
    ? mapPreservingIdentity(cell.content, sanitizeTableCellContentCssScalars)
    : cell.content;
  return style === cell.style && content === cell.content ? cell : { ...cell, style, content };
}

/**
 * A paragraph keeps its inline nodes in `children` and a trend keeps its label in `label`. Both are
 * walked rather than picking whichever exists, so a node carrying a decoy empty `children` beside a
 * poisoned `label` cannot skip the check — the structural type guard for a trend does not reject
 * unknown keys, and the trend label is rendered through the same inline pipeline.
 */
function sanitizeTableCellContentCssScalars(item: unknown): unknown {
  if (!isRecord(item)) {
    return item;
  }
  let next: Record<string, unknown> | undefined;
  for (const key of ["children", "label"]) {
    const nodes = item[key];
    if (!Array.isArray(nodes)) {
      continue;
    }
    const sanitized = mapPreservingIdentity(nodes, sanitizeInlineNodeCssScalars);
    if (sanitized !== nodes) {
      next ??= { ...item };
      next[key] = sanitized;
    }
  }
  return next ?? item;
}

/**
 * Inline styling is deleted rather than replaced: an absent `color` means "inherit", which is the
 * same rendering a node that never carried one gets.
 */
function sanitizeInlineNodeCssScalars<T>(node: T): T {
  return withSanitizedColors(node, ["color", "backgroundColor"], ["fontFamily"]);
}

function canonicalizeOverlayShape(shape: OverlayShape): OverlayShape {
  const source = shape as unknown as Record<string, unknown>;
  const canonical = pickDefined(source, SHAPE_KEYS);
  canonical.props = pickDefined(
    shape.props as unknown as Record<string, unknown>,
    SHAPE_PROP_KEYS[shape.type],
  );
  if (shape.anchor) {
    canonical.anchor = canonicalizeOverlayAnchor(shape.anchor);
  }
  const props = canonical.props as Record<string, unknown>;
  sanitizeShapeCssScalars(shape.type, props);
  if (shape.type === "text" || shape.type === "callout") {
    props.blocks = shape.props.blocks.map(canonicalizeOverlayTextBlock);
  }
  if (shape.type === "arrow") {
    props.start = canonicalizePoint(shape.props.start);
    props.end = canonicalizePoint(shape.props.end);
  } else if (shape.type === "line") {
    props.points = shape.props.points.map(canonicalizePoint);
  } else if (shape.type === "image" && shape.props.crop) {
    props.crop = {
      topLeft: canonicalizePoint(shape.props.crop.topLeft),
      bottomRight: canonicalizePoint(shape.props.crop.bottomRight),
    };
  } else if (shape.type === "callout") {
    props.tail = {
      baseStart: canonicalizePoint(shape.props.tail.baseStart),
      baseEnd: canonicalizePoint(shape.props.tail.baseEnd),
      tip: canonicalizePoint(shape.props.tail.tip),
    };
  }
  return stripUndefinedShapeFields(canonical as unknown as OverlayShape);
}

/**
 * 型として正しく、かつ **`src` が許可された出所** であること。
 *
 * 許可外の asset は **エントリごと落とす** — 図形は残るので、`shape-renderer` の
 * `assets[shape.props.assetId]` が undefined になり画像だけ描かれない (WI-2 と同じ粒度:
 * 図形は落とさず、その属性だけ効かなくする)。`src` を空文字へ書き換える案は採らない:
 * `<img src="">` はページ自身の URL を取りに行くので、別の要求を生んでしまう。
 */
function isUsableOverlayAsset(value: unknown): value is OverlayAsset {
  return isOverlayAsset(value) && isAllowedOverlayAssetSource(value.props.src);
}

function canonicalizeOverlayAsset(asset: OverlayAsset): OverlayAsset {
  // **検証した文字列そのもの**を保存する。元の値を保存すると、`trim()` が落とす U+FEFF などを
  // 使って「data URL として検証を通り、ブラウザには相対 URL として渡る」値を作れる。
  const props = pickDefined(asset.props as unknown as Record<string, unknown>, [
    "w", "h", "name", "isAnimated", "mimeType", "src", "fileSize", "storage",
  ]) as unknown as OverlayAsset["props"];
  if (asset.props.storage) {
    props.storage = {
      kind: "remote-asset",
      storageKey: asset.props.storage.storageKey,
      assetId: asset.props.storage.assetId,
    };
  }
  props.src = normalizeOverlayAssetSource(asset.props.src) ?? "";
  return {
    id: asset.id,
    type: "image",
    props,
  };
}

/**
 * Canonical form of one shape block. Every nesting level is walked — list items, the blocks that
 * continue an item under its marker, nested lists, and the blocks inside a quote — because the
 * whole point of dropping unknown keys is that no part of the tree carries anything the schema
 * does not name, and an unwalked branch is exactly where such a key survives a round trip.
 */
function canonicalizeOverlayTextBlock(block: OverlayTextBlock): OverlayTextBlock {
  if (block.type === "divider") {
    return pickDefined({
      ...(block as unknown as Record<string, unknown>),
      spaceAfterPx: normalizeBlockSpaceAfterPx(block.spaceAfterPx),
    }, ["type", "id", "spaceAfterPx"]) as unknown as OverlayTextBlock;
  }

  if (block.type === "quote") {
    return {
      ...pickDefined({
        ...(block as unknown as Record<string, unknown>),
        spaceAfterPx: normalizeBlockSpaceAfterPx(block.spaceAfterPx),
      }, ["type", "id", "spaceAfterPx"]),
      blocks: block.blocks.map((child) => canonicalizeOverlayTextBlock(child as OverlayTextBlock)),
    } as unknown as OverlayTextBlock;
  }

  if (block.type === "codeBlock") {
    return {
      ...pickDefined({
        ...(block as unknown as Record<string, unknown>),
        // Named keys are not enough for these two: an unreadable language or theme has to become
        // *absent*, not be carried through as a string nothing can draw. The body's schema
        // normalizes them on the way in and this is the shape's equivalent gate.
        theme: normalizeCodeBlockTheme(block.theme),
        spaceAfterPx: normalizeBlockSpaceAfterPx(block.spaceAfterPx),
      }, ["type", "id", "language", "theme", "spaceAfterPx"]),
      children: block.children.map(canonicalizeInlineNode),
    } as unknown as OverlayTextBlock;
  }

  if (block.type === "list") {
    return {
      ...pickDefined({
        ...(block as unknown as Record<string, unknown>),
        spaceAfterPx: normalizeBlockSpaceAfterPx(block.spaceAfterPx),
      }, [
        "type", "id", "listType", "start", "markerStyle", "spaceAfterPx",
      ]),
      items: block.items.map((item) => ({
        ...pickDefined(item as unknown as Record<string, unknown>, ["type", "id", "align"]),
        children: item.children.map(canonicalizeInlineNode),
        ...(item.continuations === undefined
          ? {}
          : { continuations: item.continuations.map(canonicalizeOverlayTextContinuation) }),
        ...(item.nested === undefined
          ? {}
          : { nested: item.nested.map(canonicalizeOverlayTextBlock) }),
      })),
    } as unknown as OverlayTextBlock;
  }

  return {
    ...pickDefined({
      ...(block as unknown as Record<string, unknown>),
      spaceAfterPx: normalizeBlockSpaceAfterPx(block.spaceAfterPx),
    }, [
      "type", "id", "level", "align", "lineHeight", "spaceAfterPx",
    ]),
    children: block.children.map(canonicalizeInlineNode),
  } as unknown as OverlayTextBlock;
}

function canonicalizeOverlayTextContinuation(
  block: NonNullable<Extract<OverlayTextBlock, { type: "list" }>["items"][number]["continuations"]>[number],
): typeof block {
  const spaceAfterPx = normalizeBlockSpaceAfterPx(block.spaceAfterPx);
  if (block.type === "divider") {
    return pickDefined({ ...(block as unknown as Record<string, unknown>), spaceAfterPx }, [
      "type", "id", "spaceAfterPx",
    ]) as unknown as typeof block;
  }
  return {
    ...pickDefined({ ...(block as unknown as Record<string, unknown>), spaceAfterPx }, [
      "type", "id", "level", "align", "lineHeight", "spaceAfterPx",
    ]),
    children: block.children.map(canonicalizeInlineNode),
  } as unknown as typeof block;
}

function canonicalizeInlineNode(node: InlineNode): InlineNode {
  const keys = node.type === "text"
    ? ["type", "text", "marks", "color", "backgroundColor", "fontFamily", "fontSize", "boxedPaddingY", "boxedVariant", "boxedTone"]
    : ["type", "id", "tex", "display", "marks", "color", "backgroundColor", "fontFamily", "fontSize", "boxedPaddingY", "boxedVariant", "boxedTone", "semanticRole", "altText"];
  return sanitizeInlineNodeCssScalars(
    pickDefined(node as unknown as Record<string, unknown>, keys),
  ) as unknown as InlineNode;
}

function canonicalizeOverlayAnchor(anchor: NonNullable<OverlayShape["anchor"]>): NonNullable<OverlayShape["anchor"]> {
  if (anchor.type === "block") {
    return {
      type: "block",
      blockId: anchor.blockId,
      dy: anchor.dy,
      ...(anchor.dx === undefined ? {} : { dx: anchor.dx }),
      ...(anchor.line === undefined ? {} : {
        line: {
          index: anchor.line.index,
          dy: anchor.line.dy,
        },
      }),
      ...(anchor.reserveSpace === undefined ? {} : { reserveSpace: anchor.reserveSpace }),
    };
  }
  if (anchor.type === "shape") {
    return {
      type: "shape",
      shapeId: anchor.shapeId,
      dx: anchor.dx,
      dy: anchor.dy,
      ...(anchor.rx === undefined ? {} : { rx: anchor.rx }),
      ...(anchor.ry === undefined ? {} : { ry: anchor.ry }),
    };
  }
  return { type: "page" };
}

function canonicalizePoint(point: { x: number; y: number }): { x: number; y: number } {
  return { x: point.x, y: point.y };
}

function collectOverlayExtensions(snapshot: {
  shapes: unknown[];
  assets: Record<string, unknown>;
  extensions?: unknown;
}): OverlaySnapshot["extensions"] | undefined {
  const extensions = isOverlayExtensions(snapshot.extensions)
    ? { ...snapshot.extensions }
    : {};
  const shapeMetadata = Object.fromEntries(snapshot.shapes.flatMap((shape) => (
    isRecord(shape) && isOverlayExtensionValue(shape.meta) && isNonEmptyMetadata(shape.meta)
      ? [[typeof shape.id === "string" ? shape.id : `index:${snapshot.shapes.indexOf(shape)}`, shape.meta]]
      : []
  )));
  const assetMetadata = Object.fromEntries(Object.entries(snapshot.assets).flatMap(([key, asset]) => (
    isRecord(asset) && isOverlayExtensionValue(asset.meta) && isNonEmptyMetadata(asset.meta)
      ? [[key, asset.meta]]
      : []
  )));
  if (Object.keys(shapeMetadata).length > 0 || Object.keys(assetMetadata).length > 0) {
    extensions[LEGACY_OVERLAY_METADATA_EXTENSION] = {
      ...(Object.keys(shapeMetadata).length > 0 ? { shapes: shapeMetadata } : {}),
      ...(Object.keys(assetMetadata).length > 0 ? { assets: assetMetadata } : {}),
    };
  }
  return Object.keys(extensions).length > 0 ? extensions : undefined;
}

function pickDefined(
  source: Record<string, unknown>,
  keys: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(keys.flatMap((key) => (
    source[key] === undefined ? [] : [[key, source[key]]]
  )));
}

function isOverlayExtensionValue(value: unknown): value is NonNullable<OverlaySnapshot["extensions"]>[string] {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
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

function isNonEmptyMetadata(value: unknown): boolean {
  return !isRecord(value) || Object.keys(value).length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeGraphPlotBounds(shapes: OverlayShape[]): OverlayShape[] {
  const migrations = new Map<OverlayShapeId, {
    previous: Extract<OverlayShape, { type: "graph2dShape" }>;
    next: Extract<OverlayShape, { type: "graph2dShape" }>;
    dx: number;
    dy: number;
  }>();

  const migrated = shapes.map((shape) => {
    if (shape.type !== "graph2dShape" || shape.props.boundsMode === "plot") {
      return shape;
    }
    const next = migrateLegacyGraphShapeToPlotBounds(shape);
    migrations.set(shape.id, {
      previous: shape,
      next,
      dx: next.x - shape.x,
      dy: next.y - shape.y,
    });
    return next;
  });

  if (migrations.size === 0) {
    return migrated;
  }

  return migrated.map((shape) => {
    const anchor = shape.anchor;
    if (anchor?.type !== "shape") {
      return shape;
    }

    const ownMigration = migrations.get(shape.id);
    const parentMigration = migrations.get(anchor.shapeId);
    if (!ownMigration && !parentMigration) {
      return shape;
    }

    if (!parentMigration) {
      return {
        ...shape,
        anchor: {
          ...anchor,
          dx: anchor.dx + (ownMigration?.dx ?? 0),
          dy: anchor.dy + (ownMigration?.dy ?? 0),
        },
      } as OverlayShape;
    }

    const previousParent = parentMigration.previous;
    const nextParent = parentMigration.next;
    const previousBaseX = anchor.rx === undefined
      ? previousParent.x
      : previousParent.x + previousParent.props.w * anchor.rx;
    const previousBaseY = anchor.ry === undefined
      ? previousParent.y
      : previousParent.y + previousParent.props.h * anchor.ry;
    const nextBaseX = anchor.rx === undefined
      ? nextParent.x
      : nextParent.x + nextParent.props.w * anchor.rx;
    const nextBaseY = anchor.ry === undefined
      ? nextParent.y
      : nextParent.y + nextParent.props.h * anchor.ry;

    return {
      ...shape,
      anchor: {
        ...anchor,
        dx: previousBaseX + anchor.dx + (ownMigration?.dx ?? 0) - nextBaseX,
        dy: previousBaseY + anchor.dy + (ownMigration?.dy ?? 0) - nextBaseY,
      },
    } as OverlayShape;
  });
}
