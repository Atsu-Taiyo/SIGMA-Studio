import {
  type OverlayAsset,
  type OverlayBounds,
  type OverlayShape,
} from "@/features/document";
import {
  getShapeBounds,
  resolveShapeAnchorPositions,
} from "@/features/drawing";
import { exportOverlaySvg } from "@/features/rendering/adapters/svg";
import type { AiEditDraft } from "@/lib/ai/sigma-doc-edit-schema";

export const SHAPE_PREVIEW_PADDING_PX = 32;
const SHAPE_PREVIEW_MIN_WIDTH_PX = 96;
const SHAPE_PREVIEW_MIN_HEIGHT_PX = 72;

export interface AiEditShapeOnlyPreview {
  svg: string;
  width: number;
  height: number;
}

export interface BuildShapesSvgPreviewOptions {
  paddingPx?: number;
  minWidthPx?: number;
  minHeightPx?: number;
}

/**
 * Shared across sigma-doc-mcp-server-core.ts and sigma-doc-mcp-preview.ts: the
 * only operations that add a visible overlay shape are insertOverlayShape and
 * insertTableShape. Kept as the single implementation to avoid drift.
 */
export function getVisualShapesFromOperations(operations: AiEditDraft[]): OverlayShape[] {
  return operations.flatMap((operation): OverlayShape[] => {
    if (operation.operation === "insertOverlayShape") {
      return [operation.overlayShape];
    }
    if (operation.operation === "insertTableShape") {
      return [operation.tableShape];
    }
    return [];
  });
}

/**
 * 図形挿入ドラフトから、挿入される図形だけを切り抜いた自己完結SVGを生成する。
 *
 * チャットのプレビューは従来、本文へドラフトを再適用して描画していたため、
 * 適用後に同じドラフトを再適用すると図形IDの自己重複で失敗し、プレビューから
 * 図形が消えていた。ここではドラフトの図形からSVGを直接生成し、本文へ一切
 * 依存しないことで、適用前後で表示が変わらないようにする。
 *
 * 図形以外(テキスト編集など)の操作が混在する場合は null を返し、呼び出し側の
 * ページプレビューに委ねる。
 */
export function buildShapeOnlyPreview(operations: AiEditDraft[]): AiEditShapeOnlyPreview | null {
  if (operations.length === 0) {
    return null;
  }

  if (operations.some((operation) => operation.operation !== "insertOverlayShape" && operation.operation !== "insertTableShape")) {
    return null;
  }

  const shapes = getVisualShapesFromOperations(operations);
  let assets: Record<string, OverlayAsset> = {};
  for (const operation of operations) {
    if (operation.operation === "insertOverlayShape") {
      assets = { ...assets, ...(operation.assets ?? {}) };
    }
  }

  return buildShapesSvgPreview(shapes, assets);
}

/**
 * Renders an arbitrary set of overlay shapes (resolving any block/shape anchors first) into a
 * self-contained cropped SVG, sized to the shapes' union bounds plus padding. Shared by
 * `buildShapeOnlyPreview` (insert-shape drafts) and, for update/align mutation ops, by the
 * inline preview card via `resolveMutationOpShapeResults`'s after-state shapes — both need the
 * exact same "crop to what's actually drawn" behavior.
 */
export function buildShapesSvgPreview(
  inputShapes: OverlayShape[],
  assets: Record<string, OverlayAsset>,
  options: BuildShapesSvgPreviewOptions = {},
): AiEditShapeOnlyPreview | null {
  if (inputShapes.length === 0) {
    return null;
  }

  const shapes = inputShapes;
  const resolvedShapes = resolveShapeAnchorPositions(shapes);
  const crop = expandBounds(unionShapeBounds(resolvedShapes), options);
  const svg = exportOverlaySvg(shapes, assets, {
    width: crop.w,
    height: crop.h,
    offsetX: crop.x,
    offsetY: crop.y,
  });
  if (!svg) {
    return null;
  }

  return { svg, width: crop.w, height: crop.h };
}

export function unionShapeBounds(shapes: OverlayShape[]): OverlayBounds {
  return shapes
    .map((shape) => getShapeBounds(shape))
    .reduce((acc, bounds) => {
      const x = Math.min(acc.x, bounds.x);
      const y = Math.min(acc.y, bounds.y);
      const right = Math.max(acc.x + acc.w, bounds.x + bounds.w);
      const bottom = Math.max(acc.y + acc.h, bounds.y + bounds.h);
      return { x, y, w: right - x, h: bottom - y };
    });
}

export function expandBounds(
  bounds: OverlayBounds,
  options: BuildShapesSvgPreviewOptions = {},
): OverlayBounds {
  const paddingPx = options.paddingPx ?? SHAPE_PREVIEW_PADDING_PX;
  const minWidthPx = options.minWidthPx ?? SHAPE_PREVIEW_MIN_WIDTH_PX;
  const minHeightPx = options.minHeightPx ?? SHAPE_PREVIEW_MIN_HEIGHT_PX;
  return {
    x: bounds.x - paddingPx,
    y: bounds.y - paddingPx,
    w: Math.max(minWidthPx, bounds.w + paddingPx * 2),
    h: Math.max(minHeightPx, bounds.h + paddingPx * 2),
  };
}
