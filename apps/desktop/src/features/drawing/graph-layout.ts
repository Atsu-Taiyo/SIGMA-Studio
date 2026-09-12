import type {
  Graph2DSpec,
  OverlayBounds,
  OverlayGraphShape,
} from "@/features/document";

export const GRAPH_BOUNDS_MODE = "plot" as const;

export interface GraphPlotBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export const DEFAULT_GRAPH_PLOT_BOX: GraphPlotBox = {
  left: 46,
  top: 18,
  right: 18,
  bottom: 34,
};

export const NUMBER_LINE_GRAPH_PLOT_BOX: GraphPlotBox = {
  left: 34,
  top: 20,
  right: 28,
  bottom: 30,
};

export interface GraphRenderLayout {
  spec: Graph2DSpec;
  plotBox: GraphPlotBox;
  renderBounds: OverlayBounds;
  scaleX: number;
  scaleY: number;
}

export function getGraphPlotBox(spec: Graph2DSpec): GraphPlotBox {
  return spec.kind === "numberLine"
    ? NUMBER_LINE_GRAPH_PLOT_BOX
    : DEFAULT_GRAPH_PLOT_BOX;
}

/**
 * 同じ shape からは同じ spec オブジェクトを返す。
 *
 * 表示 spec は shape から導けるだけの値なので、shape が作り直されない限り変わらない。
 * それでも毎回新しいオブジェクトを返していたため `Graph2DPreview` に `memo()` を掛けても
 * 素通りし、`Graph2DPreview.tsx:296-299` のように「spec ではなくフィールドを deps にする」
 * 回避を書く羽目になっていた。鍵を shape にして identity を安定させる。
 *
 * 前提は overlay 図形が破壊的に変更されないこと (更新は新しい shape オブジェクトを作る)。
 */
const displaySpecByShape = new WeakMap<OverlayGraphShape, Graph2DSpec>();

export function getGraphDisplaySpec(shape: OverlayGraphShape): Graph2DSpec {
  const cached = displaySpecByShape.get(shape);
  if (cached) {
    return cached;
  }
  const spec = buildGraphDisplaySpec(shape);
  displaySpecByShape.set(shape, spec);
  return spec;
}

function buildGraphDisplaySpec(shape: OverlayGraphShape): Graph2DSpec {
  if (shape.props.boundsMode !== GRAPH_BOUNDS_MODE) {
    if (shape.props.preserveSpecSize === true) {
      return shape.props.spec;
    }
    return {
      ...shape.props.spec,
      width: shape.props.w,
      height: shape.props.h,
    };
  }

  if (shape.props.preserveSpecSize === true) {
    return shape.props.spec;
  }
  const plotBox = getGraphPlotBox(shape.props.spec);
  return {
    ...shape.props.spec,
    width: shape.props.w + plotBox.left + plotBox.right,
    height: shape.props.h + plotBox.top + plotBox.bottom,
  };
}

export function getGraphPlotSize(spec: Graph2DSpec): { w: number; h: number } {
  const plotBox = getGraphPlotBox(spec);
  return {
    w: Math.max(1, spec.width - plotBox.left - plotBox.right),
    h: Math.max(1, spec.height - plotBox.top - plotBox.bottom),
  };
}

export function getGraphShapeSizeForSpec(
  shape: OverlayGraphShape,
  spec: Graph2DSpec,
): { w: number; h: number } {
  const plotSize = getGraphPlotSize(spec);
  if (shape.props.preserveSpecSize !== true) {
    return plotSize;
  }
  const layout = getGraphRenderLayout(shape);
  return {
    w: plotSize.w * layout.scaleX,
    h: plotSize.h * layout.scaleY,
  };
}

/**
 * Keeps graph geometry (the plot rectangle) separate from the larger SVG used
 * to paint tick labels and arrowheads. Decorations therefore stay outside the
 * shape's selectable bounds.
 */
export function getGraphRenderLayout(shape: OverlayGraphShape): GraphRenderLayout {
  const spec = getGraphDisplaySpec(shape);
  const plotBox = getGraphPlotBox(spec);
  const svgPlotWidth = Math.max(1, spec.width - plotBox.left - plotBox.right);
  const svgPlotHeight = Math.max(1, spec.height - plotBox.top - plotBox.bottom);

  if (shape.props.boundsMode !== GRAPH_BOUNDS_MODE) {
    return {
      spec,
      plotBox,
      renderBounds: { x: shape.x, y: shape.y, w: shape.props.w, h: shape.props.h },
      scaleX: shape.props.w / Math.max(1, spec.width),
      scaleY: shape.props.h / Math.max(1, spec.height),
    };
  }

  const scaleX = shape.props.w / svgPlotWidth;
  const scaleY = shape.props.h / svgPlotHeight;
  return {
    spec,
    plotBox,
    renderBounds: {
      x: shape.x - plotBox.left * scaleX,
      y: shape.y - plotBox.top * scaleY,
      w: spec.width * scaleX,
      h: spec.height * scaleY,
    },
    scaleX,
    scaleY,
  };
}
