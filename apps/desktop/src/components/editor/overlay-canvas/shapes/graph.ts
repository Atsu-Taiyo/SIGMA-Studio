import {
  createGraphAnnotationLabelShapeEntries as createGraphAnnotationLabelShapeEntriesLayout,
  createGraphAxisLabelShapeEntries as createGraphAxisLabelShapeEntriesLayout,
  createGraphFormulaLabelShapeEntries as createGraphFormulaLabelShapeEntriesLayout,
  createGraphFormulaLabelShapes as createGraphFormulaLabelShapesLayout,
  createGraphPointLabelShapeEntries as createGraphPointLabelShapeEntriesLayout,
  getGraphFormulaLabelEntries as getGraphFormulaLabelEntriesLayout,
  getGraphRenderLayout,
  GRAPH_BOUNDS_MODE,
  type GraphAnnotationLabelOptions,
  type GraphAnnotationLabelShapeEntry,
  type GraphAxisLabelOptions,
  type GraphAxisLabelShapeEntry,
  type GraphFormulaLabelEntry,
  type GraphFormulaLabelOptions,
  type GraphFormulaLabelShapeEntry,
  type GraphPointLabelOptions,
  type GraphPointLabelShapeEntry,
} from "@/features/drawing";
import {
  createGraph2DSpecPreset,
  fitGraphViewBoxToSquareUnits,
  getGraphHeightForSquareUnits,
  getGraphPlotBox,
  normalizeGraphPaletteColor,
  type Graph2DPreset,
  type GraphSvgCropBox,
} from "@/lib/graph2d";
import { createGraphLabelLayoutPort } from "@/features/rendering/adapters";
import type { Graph2DSpec } from "@/features/document";

import type {
  OverlayAnchor,
  OverlayBounds,
  OverlayGraphShape,
  OverlayShapeId,
  OverlayTextShape,
} from "../types";

export const GRAPH_SHAPE_TYPE = "graph2dShape" as const;
export const GRAPH_SHAPE_EDIT_EVENT = "sigma-studio:edit-overlay-graph-shape";
export {
  getGraphDisplaySpec,
  getGraphPlotSize,
  getGraphRenderLayout,
  getGraphShapeSizeForSpec,
  GRAPH_BOUNDS_MODE,
} from "@/features/drawing";
export type { GraphRenderLayout } from "@/features/drawing";
const DEFAULT_GRAPH_WIDTH = 360;
const MIN_GRAPH_PLOT_WIDTH = 64;
const MIN_GRAPH_PLOT_HEIGHT = 48;

const graphLabelLayoutPort = createGraphLabelLayoutPort();

export interface GraphShapeEditEventDetail {
  shapeId: OverlayGraphShape["id"];
  spec: Graph2DSpec;
}

export function createGraphShapeProps(preset: Graph2DPreset = "blank"): OverlayGraphShape["props"] {
  const baseSpec = createGraph2DSpecPreset(preset);
  const renderWidth = DEFAULT_GRAPH_WIDTH;
  // 初期状態で x/y の単位長が一致する (1:1) 高さを既定にする。
  const squareUnitHeight = getGraphHeightForSquareUnits({ ...baseSpec, width: renderWidth }, renderWidth);
  const renderHeight = Math.max(
    preset === "numberLine" ? 128 : 190,
    squareUnitHeight ?? Math.round(renderWidth * (baseSpec.height / baseSpec.width)),
  );
  const spec = {
    ...baseSpec,
    title: "",
    width: renderWidth,
    height: renderHeight,
    axes: {
      ...baseSpec.axes,
      grid: false,
      showX: baseSpec.axes.showX ?? true,
      showY: baseSpec.kind === "cartesian" ? baseSpec.axes.showY ?? true : false,
      showTicks: false,
      xLabel: "",
      yLabel: "",
      originLabel: "",
    },
    curves: baseSpec.curves.map((curve) => ({
      ...curve,
      color: normalizeGraphPaletteColor(curve.color),
    })),
    showFormulaLabels: false,
  };

  const plotBox = getGraphPlotBox(spec);
  const w = Math.max(1, renderWidth - plotBox.left - plotBox.right);
  const h = Math.max(1, renderHeight - plotBox.top - plotBox.bottom);
  const fittedSpec = fitGraphViewBoxToSquareUnits(
    spec,
    w,
    h,
  );

  return {
    boundsMode: GRAPH_BOUNDS_MODE,
    w,
    h,
    spec: fittedSpec,
  };
}

export function createGraphShapeFromPlotBounds(
  id: OverlayShapeId,
  plotBounds: OverlayBounds,
  preset: Graph2DPreset = "blank",
): OverlayGraphShape {
  const baseProps = createGraphShapeProps(preset);
  const plotBox = getGraphPlotBox(baseProps.spec);
  const defaultPlotWidth = Math.max(1, baseProps.w);
  const defaultPlotHeight = Math.max(1, baseProps.h);
  const plotWidth = Math.max(MIN_GRAPH_PLOT_WIDTH, plotBounds.w);
  const plotHeight = Math.max(
    MIN_GRAPH_PLOT_HEIGHT,
    plotBounds.h < 16 ? Math.round(plotWidth * (defaultPlotHeight / defaultPlotWidth)) : plotBounds.h,
  );
  const renderWidth = plotWidth + plotBox.left + plotBox.right;
  const renderHeight = plotHeight + plotBox.top + plotBox.bottom;
  // ドラッグで決めた外枠サイズは尊重し、y 範囲の方を 1:1 に合わせて調整する。
  const sizedSpec: Graph2DSpec = fitGraphViewBoxToSquareUnits(
    {
      ...baseProps.spec,
      width: renderWidth,
      height: renderHeight,
    },
    plotWidth,
    plotHeight,
  );
  return {
    id,
    type: GRAPH_SHAPE_TYPE,
    x: plotBounds.x,
    y: plotBounds.y,
    rotation: 0,
    props: {
      boundsMode: GRAPH_BOUNDS_MODE,
      w: plotWidth,
      h: plotHeight,
      spec: sizedSpec,
    },
  };
}

export { migrateLegacyGraphShapeToPlotBounds } from "@/features/document";

export function getGraphCropPositionPatch(
  graphShape: OverlayGraphShape,
  cropBox: GraphSvgCropBox,
): Pick<OverlayGraphShape, "x" | "y"> {
  const layout = getGraphRenderLayout(graphShape);
  const dx = (cropBox.left - layout.plotBox.left) * layout.scaleX;
  const dy = (cropBox.top - layout.plotBox.top) * layout.scaleY;
  const rotation = typeof graphShape.rotation === "number" && Number.isFinite(graphShape.rotation)
    ? graphShape.rotation
    : 0;
  if (rotation === 0) {
    return {
      x: graphShape.x + dx,
      y: graphShape.y + dy,
    };
  }

  const cos = Math.cos(rotation);
  const sin = Math.sin(rotation);
  return {
    x: graphShape.x + dx * cos - dy * sin,
    y: graphShape.y + dx * sin + dy * cos,
  };
}

export interface GraphOwnedTextLabelCropSyncPatch {
  x?: number;
  y?: number;
  hidden?: boolean | undefined;
  anchor?: OverlayAnchor | undefined;
}

export function getGraphOwnedTextLabelCropSyncPatch(
  graphShape: OverlayGraphShape,
  labelShape: OverlayTextShape,
  templateShape: OverlayTextShape | null,
): GraphOwnedTextLabelCropSyncPatch {
  if (!templateShape) {
    return { hidden: true };
  }

  const templateAnchor = templateShape.anchor;
  if (!templateAnchor || templateAnchor.type !== "shape") {
    return {};
  }

  if (labelShape.hidden) {
    return {
      x: templateShape.x,
      y: templateShape.y,
      hidden: undefined,
      anchor: templateAnchor,
    };
  }

  return {
    x: labelShape.x,
    y: labelShape.y,
    hidden: undefined,
    anchor: getGraphOwnedTextLabelAnchorPreservingPosition(graphShape, labelShape, templateAnchor),
  };
}

export function getGraphOwnedTextLabelAnchorPreservingPosition(
  graphShape: OverlayGraphShape,
  labelShape: Pick<OverlayTextShape, "x" | "y">,
  templateAnchor: Extract<OverlayAnchor, { type: "shape" }>,
): Extract<OverlayAnchor, { type: "shape" }> {
  const baseX = typeof templateAnchor.rx === "number"
    ? graphShape.x + graphShape.props.w * templateAnchor.rx
    : graphShape.x;
  const baseY = typeof templateAnchor.ry === "number"
    ? graphShape.y + graphShape.props.h * templateAnchor.ry
    : graphShape.y;
  return {
    ...templateAnchor,
    dx: labelShape.x - baseX,
    dy: labelShape.y - baseY,
  };
}

export type GraphOwnedLabelTextSyncedProps = Pick<
  OverlayTextShape["props"],
  "w" | "h" | "blocks" | "color" | "size"
>;

/**
 * Fields to copy from a freshly-computed label shape entry (from `createGraph*LabelShapeEntries`)
 * onto an existing graph-owned label text shape when its content changes (axis/point/annotation
 * label edits). Point and annotation label sync already copied all of these; axis label sync used
 * to copy only the content, silently leaving `w`/`h` stale after editing an axis label's TeX (see
 * the graph shape editor's axis-label callback). Sharing this picker keeps the three call sites
 * from drifting again.
 */
export function getGraphOwnedLabelTextSyncedProps(
  labelShapeEntryProps: OverlayTextShape["props"],
): GraphOwnedLabelTextSyncedProps {
  return {
    w: labelShapeEntryProps.w,
    h: labelShapeEntryProps.h,
    blocks: labelShapeEntryProps.blocks,
    color: labelShapeEntryProps.color,
    size: labelShapeEntryProps.size,
  };
}

export type {
  GraphAnnotationLabelOptions,
  GraphAnnotationLabelShapeEntry,
  GraphAxisLabelOptions,
  GraphAxisLabelShapeEntry,
  GraphFormulaLabelEntry,
  GraphFormulaLabelOptions,
  GraphFormulaLabelShapeEntry,
  GraphPointLabelOptions,
  GraphPointLabelShapeEntry,
} from "@/features/drawing";

export { isGraphLabelTextShape } from "@/features/drawing";

export function getGraphFormulaLabelEntries(
  spec: Graph2DSpec,
  options?: GraphFormulaLabelOptions,
): GraphFormulaLabelEntry[] {
  return getGraphFormulaLabelEntriesLayout(spec, graphLabelLayoutPort, options);
}

export function createGraphFormulaLabelShapes(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  canvasSize: { width: number; height: number },
  options?: GraphFormulaLabelOptions,
): OverlayTextShape[] {
  return createGraphFormulaLabelShapesLayout(
    graphShape,
    createShapeId,
    canvasSize,
    graphLabelLayoutPort,
    options,
  );
}

export function createGraphFormulaLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  canvasSize: { width: number; height: number },
  options?: GraphFormulaLabelOptions,
): GraphFormulaLabelShapeEntry[] {
  return createGraphFormulaLabelShapeEntriesLayout(
    graphShape,
    createShapeId,
    canvasSize,
    graphLabelLayoutPort,
    options,
  );
}

export function createGraphAxisLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  options?: GraphAxisLabelOptions,
): GraphAxisLabelShapeEntry[] {
  return createGraphAxisLabelShapeEntriesLayout(
    graphShape,
    createShapeId,
    graphLabelLayoutPort,
    options,
  );
}

export function createGraphPointLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  options?: GraphPointLabelOptions,
): GraphPointLabelShapeEntry[] {
  return createGraphPointLabelShapeEntriesLayout(
    graphShape,
    createShapeId,
    graphLabelLayoutPort,
    options,
  );
}

export function createGraphAnnotationLabelShapeEntries(
  graphShape: OverlayGraphShape,
  createShapeId: () => OverlayShapeId,
  options?: GraphAnnotationLabelOptions,
): GraphAnnotationLabelShapeEntry[] {
  return createGraphAnnotationLabelShapeEntriesLayout(
    graphShape,
    createShapeId,
    graphLabelLayoutPort,
    options,
  );
}
